import express from "express";
import pg from "pg";
import { parse } from "csv-parse/sync";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = "https://v3.football.api-sports.io";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HISTORICAL_CSV = path.join(ROOT, "winscope_historical_odds.csv");
const { Pool } = pg;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(ROOT, "public")));

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 3
    })
  : null;

let dbReady = null;
let autoCaptureRunning = false;
let alarmScanRunning = false;

const oddsCache = new Map();
const oddsInFlight = new Map();
const CACHE_MS = {
  live: 60_000,
  prematch: 3 * 60 * 60 * 1000
};

const ALARM_INTERVAL_MS = 60_000;

function toNumber(value) {
  if (value == null || String(value).trim() === "") return null;

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function importHistoricalCsvOnce() {
  if (!pool || !existsSync(HISTORICAL_CSV)) {
    console.log("Historical CSV bulunamadı; aktarım atlandı.");
    return { imported: false, reason: "csv_not_found" };
  }

  const existing = await pool.query(
    "SELECT COUNT(*)::int AS total FROM historical_matches"
  );

  if (existing.rows[0].total > 0) {
    console.log(`Geçmiş veri zaten yüklü: ${existing.rows[0].total}`);

    return {
      imported: false,
      reason: "already_imported",
      rows: existing.rows[0].total
    };
  }

  const csvText = await readFile(HISTORICAL_CSV, "utf8");

  const records = parse(csvText, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true
  });

  const client = await pool.connect();
  let inserted = 0;

  try {
    await client.query("BEGIN");

    for (let start = 0; start < records.length; start += 300) {
      const batch = records.slice(start, start + 300);
      const values = [];

      const placeholders = batch.map((row, index) => {
        const offset = index * 24;
        const dateParts = String(row.Date || "").split("/");

        const isoDate =
          dateParts.length === 3
            ? `${dateParts[2]}-${dateParts[1].padStart(2, "0")}-${dateParts[0].padStart(2, "0")}`
            : null;

        values.push(
          row.Div || null,
          isoDate,
          row.Time || null,
          row.HomeTeam || null,
          row.AwayTeam || null,
          toNumber(row.HTHG),
          toNumber(row.HTAG),
          toNumber(row.FTHG),
          toNumber(row.FTAG),
          row.FTR || null,
          toNumber(row.B365H),
          toNumber(row.B365D),
          toNumber(row.B365A),
          toNumber(row.AvgH),
          toNumber(row.AvgD),
          toNumber(row.AvgA),
          toNumber(row["B365>2.5"]),
          toNumber(row["B365<2.5"]),
          toNumber(row["Avg>2.5"]),
          toNumber(row["Avg<2.5"]),
          toNumber(row["B365C>2.5"]),
          toNumber(row["B365C<2.5"]),
          toNumber(row.TotalGoals),
          toNumber(row.Over25Result)
        );

        return `(${Array.from(
          { length: 24 },
          (_, i) => `$${offset + i + 1}`
        ).join(",")})`;
      });

      await client.query(
        `INSERT INTO historical_matches (
          league_code, match_date, match_time, home_team, away_team,
          ht_home_goals, ht_away_goals, ft_home_goals, ft_away_goals,
          full_time_result, b365_home, b365_draw, b365_away,
          avg_home, avg_draw, avg_away, b365_over25, b365_under25,
          avg_over25, avg_under25, b365_close_over25,
          b365_close_under25, total_goals, over25_result
        ) VALUES ${placeholders.join(",")}`,
        values
      );

      inserted += batch.length;
    }

    await client.query("COMMIT");

    console.log(`Tarihsel maçlar içe aktarıldı: ${inserted}`);

    return { imported: true, rows: inserted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function initDatabase() {
  if (!pool) {
    throw new Error("DATABASE_URL ayarlanmamış.");
  }

  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS match_stat_snapshots (
          id BIGSERIAL PRIMARY KEY,
          fixture_id BIGINT NOT NULL,
          captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          teams JSONB NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_match_snapshots_fixture_time
        ON match_stat_snapshots (fixture_id, captured_at DESC);

        CREATE TABLE IF NOT EXISTS tracked_matches (
          fixture_id BIGINT PRIMARY KEY,
          home_team TEXT NOT NULL,
          away_team TEXT NOT NULL,
          enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS historical_matches (
          id BIGSERIAL PRIMARY KEY,
          league_code TEXT,
          match_date DATE,
          match_time TEXT,
          home_team TEXT NOT NULL,
          away_team TEXT NOT NULL,
          ht_home_goals INTEGER,
          ht_away_goals INTEGER,
          ft_home_goals INTEGER,
          ft_away_goals INTEGER,
          full_time_result TEXT,
          b365_home NUMERIC,
          b365_draw NUMERIC,
          b365_away NUMERIC,
          avg_home NUMERIC,
          avg_draw NUMERIC,
          avg_away NUMERIC,
          b365_over25 NUMERIC,
          b365_under25 NUMERIC,
          avg_over25 NUMERIC,
          avg_under25 NUMERIC,
          b365_close_over25 NUMERIC,
          b365_close_under25 NUMERIC,
          total_goals INTEGER,
          over25_result INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_historical_league_date
        ON historical_matches (league_code, match_date DESC);

        CREATE INDEX IF NOT EXISTS idx_historical_teams
        ON historical_matches (home_team, away_team);

        CREATE TABLE IF NOT EXISTS odds_snapshots (
          id BIGSERIAL PRIMARY KEY,
          fixture_id BIGINT NOT NULL,
          mode TEXT NOT NULL CHECK (mode IN ('live','prematch')),
          bookmaker TEXT NOT NULL,
          market_name TEXT NOT NULL,
          selection TEXT NOT NULL,
          odd NUMERIC NOT NULL,
          captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          raw JSONB
        );

        CREATE INDEX IF NOT EXISTS idx_odds_snapshots_lookup
        ON odds_snapshots (
          fixture_id, mode, bookmaker, market_name,
          selection, captured_at DESC
        );
      `);

      await importHistoricalCsvOnce();
      return true;
    })().catch(error => {
      dbReady = null;
      console.error("Database initialization error:", error.message);
      throw error;
    });
  }

  return dbReady;
}

async function apiGet(pathname) {
  if (!API_KEY) {
    throw new Error("API_FOOTBALL_KEY ayarlanmamış.");
  }

  const response = await fetch(`${BASE_URL}${pathname}`, {
    headers: { "x-apisports-key": API_KEY },
    signal: AbortSignal.timeout(12000)
  });

  let payload;

  try {
    payload = await response.json();
  } catch {
    throw new Error("API-Football geçerli JSON döndürmedi.");
  }

  if (!response.ok || Object.keys(payload.errors || {}).length > 0) {
    console.error(
      "API-Football response error:",
      payload.errors || response.status
    );

    const detail = payload.errors
      ? JSON.stringify(payload.errors)
      : `HTTP ${response.status}`;

    throw new Error(`API-Football isteği başarısız: ${detail}`);
  }

  return payload.response || [];
}

function normalizeOdds(rows) {
  const normalized = [];

  for (const fixture of rows || []) {
    for (const bookmaker of fixture.bookmakers || []) {
      for (const bet of bookmaker.bets || []) {
        for (const value of bet.values || []) {
          const odd = toNumber(value.odd);

          if (odd == null || odd <= 1) continue;

          normalized.push({
            bookmaker: bookmaker.name || "Bilinmeyen sağlayıcı",
            market: bet.name || `Market ${bet.id ?? "?"}`,
            selection: String(value.value ?? value.name ?? "Seçim"),
            odd,
            suspended: Boolean(value.suspended),
            betId: bet.id ?? null
          });
        }
      }
    }
  }

  return normalized;
}

async function getOdds(fixtureId, mode) {
  const key = `${mode}:${fixtureId}`;
  const now = Date.now();
  const cached = oddsCache.get(key);

  if (cached && now - cached.at < CACHE_MS[mode]) {
    return { ...cached.data, cached: true };
  }

  if (oddsInFlight.has(key)) {
    return oddsInFlight.get(key);
  }

  const task = (async () => {
    const endpoint =
      mode === "live"
        ? `/odds/live?fixture=${fixtureId}`
        : `/odds?fixture=${fixtureId}`;

    const rows = await apiGet(endpoint);
    const markets = normalizeOdds(rows);

    const data = {
      fixtureId: Number(fixtureId),
      mode,
      source: "API-Football",
      fetchedAt: new Date().toISOString(),
      available: markets.length > 0,
      markets,
      note: markets.length
        ? "Oranlar sağlayıcının döndürdüğü mevcut marketlerdir."
        : "Bu maç/mod için oran dönmedi. Market kapsamı veya sağlayıcı verisi yetersiz olabilir."
    };

    if (pool && markets.length) {
      try {
        await initDatabase();

        const client = await pool.connect();

        try {
          await client.query("BEGIN");

          for (const market of markets) {
            await client.query(
              `INSERT INTO odds_snapshots
                (fixture_id, mode, bookmaker, market_name, selection, odd, raw)
               VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
              [
                fixtureId,
                mode,
                market.bookmaker,
                market.market,
                market.selection,
                market.odd,
                JSON.stringify(market)
              ]
            );
          }

          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      } catch (error) {
        console.error("Odds snapshot save error:", error.message);
        data.saveWarning = "Oran geldi ancak geçmiş kaydı yapılamadı.";
      }

      for (const market of markets) {
        try {
          const prev = await pool.query(
            `SELECT odd, captured_at
             FROM odds_snapshots
             WHERE fixture_id=$1 AND mode=$2 AND bookmaker=$3
               AND market_name=$4 AND selection=$5
               AND captured_at < $6::timestamptz
             ORDER BY captured_at DESC
             LIMIT 1`,
            [
              fixtureId,
              mode,
              market.bookmaker,
              market.market,
              market.selection,
              data.fetchedAt
            ]
          );

          if (prev.rows.length) {
            market.previousOdd = Number(prev.rows[0].odd);
            market.change = Number(
              (market.odd - market.previousOdd).toFixed(3)
            );
            market.direction =
              market.change < 0
                ? "DÜŞTÜ"
                : market.change > 0
                  ? "YÜKSELDİ"
                  : "SABİT";
            market.previousCapturedAt = prev.rows[0].captured_at;
          } else {
            market.previousOdd = null;
            market.change = null;
            market.direction = "İLK KAYIT";
          }
        } catch (error) {
          console.error("Odds movement query error:", error.message);
        }
      }
    } else {
      for (const market of markets) {
        market.previousOdd = null;
        market.change = null;
        market.direction = "GEÇMİŞ HAREKET YOK";
      }
    }

    oddsCache.set(key, { at: now, data });
    return data;
  })();

  oddsInFlight.set(key, task);

  try {
    return await task;
  } finally {
    oddsInFlight.delete(key);
  }
}

async function captureOneMatch(fixtureId) {
  const rows = await apiGet(
    `/fixtures/statistics?fixture=${encodeURIComponent(String(fixtureId))}`
  );

  if (!rows.length) {
    return { saved: false, reason: "no_statistics" };
  }

  const teams = rows.map(row => ({
    team: row.team?.name || "Bilinmiyor",
    statistics: Object.fromEntries(
      (row.statistics || []).map(stat => [stat.type, stat.value])
    )
  }));

  await pool.query(
    "INSERT INTO match_stat_snapshots (fixture_id, teams) VALUES ($1, $2::jsonb)",
    [fixtureId, JSON.stringify(teams)]
  );

  return { saved: true, teams };
}

async function captureTrackedMatches() {
  if (!pool || autoCaptureRunning) return;

  autoCaptureRunning = true;

  try {
    await initDatabase();

    const result = await pool.query(
      "SELECT fixture_id, home_team, away_team FROM tracked_matches ORDER BY enabled_at ASC LIMIT 2"
    );

    for (const match of result.rows) {
      try {
        const saved = await captureOneMatch(match.fixture_id);

        if (saved.saved) {
          console.log(
            `Otomatik istatistik kaydı: ${match.home_team} - ${match.away_team}`
          );
        }
      } catch (error) {
        console.error(
          `Otomatik kayıt hatası (${match.fixture_id}):`,
          error.message
        );
      }
    }
  } catch (error) {
    console.error("Otomatik kayıt döngüsü hatası:", error.message);
  } finally {
    autoCaptureRunning = false;
  }
}

// ---------------- Telegram ve canlı maç alarmları ----------------

async function sendTelegramMessage(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("Telegram ayarları eksik.");
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message
      }),
      signal: AbortSignal.timeout(15000)
    }
  );

  const result = await response.json().catch(() => null);

  if (!response.ok || !result?.ok) {
    throw new Error("Telegram mesajı gönderilemedi.");
  }

  return result;
}

function statNumber(statistics, type) {
  const item = statistics.find(item => item.type === type);

  if (!item || item.value == null || item.value === "") {
    return null;
  }

  const value = Number(
    String(item.value).replace("%", "").replace(",", ".")
  );

  return Number.isFinite(value) ? value : null;
}

function evaluateMatchAlarms(match, stats) {
  const minute = Number(match?.fixture?.status?.elapsed);
  const homeGoals = match?.goals?.home;
  const awayGoals = match?.goals?.away;

  if (
    !Number.isFinite(minute) ||
    homeGoals == null ||
    awayGoals == null
  ) {
    return [];
  }

  const homeStats = stats.find(
    row => Number(row.team?.id) === Number(match.teams.home.id)
  );

  const awayStats = stats.find(
    row => Number(row.team?.id) === Number(match.teams.away.id)
  );

  if (!homeStats || !awayStats) return [];

  const hs = homeStats.statistics || [];
  const as = awayStats.statistics || [];

  const shotsHome = statNumber(hs, "Total Shots");
  const shotsAway = statNumber(as, "Total Shots");
  const targetHome = statNumber(hs, "Shots on Goal");
  const targetAway = statNumber(as, "Shots on Goal");
  const cornersHome = statNumber(hs, "Corner Kicks");
  const cornersAway = statNumber(as, "Corner Kicks");

  if (
    [shotsHome, shotsAway, targetHome, targetAway].some(
      value => value == null
    )
  ) {
    return [];
  }

  const shots = shotsHome + shotsAway;
  const shotsOnTarget = targetHome + targetAway;

  const corners =
    cornersHome == null || cornersAway == null
      ? null
      : cornersHome + cornersAway;

  // İstatistik sinyali: bir garanti veya kesin olasılık değildir.
  const pressure =
    shots >= 8 &&
    shotsOnTarget >= 3 &&
    (corners == null || corners >= 2);

  if (!pressure) return [];

  const score = `${homeGoals}-${awayGoals}`;
  const alerts = [];

  // 20. dakika civarı: İlk yarı 1.5 üst
  if (
    minute >= 20 &&
    minute <= 22 &&
    (score === "1-0" || score === "0-1")
  ) {
    alerts.push({
      key: "iy15",
      market: "İY 1.5 ÜST",
      reason:
        "20–22. dakika aralığında tek gollü skor ve şut baskısı var."
    });
  }

  // 65. dakika civarı: Maç sonu 1.5 üst
  if (
    minute >= 65 &&
    minute <= 67 &&
    (score === "1-0" || score === "0-1")
  ) {
    alerts.push({
      key: "ms15",
      market: "MS 1.5 ÜST",
      reason:
        "65–67. dakika aralığında tek gollü skor ve şut baskısı var."
    });
  }

  // 70. dakika civarı: Maç sonu 2.5 üst
  if (
    minute >= 70 &&
    minute <= 72 &&
    (score === "1-1" || score === "2-0" || score === "0-2")
  ) {
    alerts.push({
      key: "ms25",
      market: "MS 2.5 ÜST",
      reason:
        "70–72. dakika aralığında üçüncü gol için şut baskısı var."
    });
  }

  // Favori baskısı alarmı, maç önü favori bilgisi güvenilir şekilde
  // karşılaştırılmadığı için şimdilik devre dışıdır.

  return alerts;
}

async function scanTrackedMatchAlarms() {
  if (!pool || alarmScanRunning) return;

  alarmScanRunning = true;

  try {
    await initDatabase();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sent_match_alarms (
        fixture_id BIGINT NOT NULL,
        alert_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (fixture_id, alert_key)
      )
    `);

    const tracked = await pool.query(
      "SELECT fixture_id, home_team, away_team FROM tracked_matches ORDER BY enabled_at ASC LIMIT 2"
    );

    if (!tracked.rows.length) return;

    const fixtures = await apiGet("/fixtures?live=all");

    for (const item of tracked.rows) {
      const match = fixtures.find(
        fixture => Number(fixture.fixture.id) === Number(item.fixture_id)
      );

      if (!match) continue;

      const minute = Number(match.fixture.status.elapsed);

      if (!Number.isFinite(minute)) continue;

      const stats = await apiGet(
        `/fixtures/statistics?fixture=${encodeURIComponent(String(item.fixture_id))}`
      );

      const alerts = evaluateMatchAlarms(match, stats);

      for (const alert of alerts) {
        const inserted = await pool.query(
          `INSERT INTO sent_match_alarms (fixture_id, alert_key)
           VALUES ($1,$2)
           ON CONFLICT DO NOTHING
           RETURNING fixture_id`,
          [item.fixture_id, alert.key]
        );

        if (!inserted.rowCount) continue;

        const message =
          `⚽ WINSCOPE ALARM\n\n` +
          `${match.teams.home.name} - ${match.teams.away.name}\n` +
          `Dakika: ${minute}\n` +
          `Skor: ${match.goals.home}-${match.goals.away}\n` +
          `Alarm: ${alert.market}\n` +
          `Gerekçe: ${alert.reason}\n\n` +
          `Not: İstatistik tabanlı uyarıdır; garanti değildir.`;

        try {
          await sendTelegramMessage(message);

          console.log(
            `Telegram alarmı gönderildi: ${item.fixture_id} / ${alert.key}`
          );
        } catch (error) {
          await pool.query(
            "DELETE FROM sent_match_alarms WHERE fixture_id=$1 AND alert_key=$2",
            [item.fixture_id, alert.key]
          );

          console.error(
            "Telegram alarm gönderilemedi:",
            error.message
          );
        }
      }
    }
  } catch (error) {
    console.error("Alarm taraması başarısız:", error.message);
  } finally {
    alarmScanRunning = false;
  }
}

app.get("/api/telegram-test", async (_req, res) => {
  try {
    await sendTelegramMessage(
      "⚽ WinScope Telegram bağlantısı başarılı! Test mesajı."
    );

    res.json({
      success: true,
      message: "Telegram test mesajı gönderildi."
    });
  } catch (error) {
    console.error("Telegram test error:", error.message);

    res.status(503).json({
      success: false,
      error: "Telegram test mesajı gönderilemedi. Ayarları kontrol edin."
    });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "WinScope Live",
    odds: true,
    databaseConfigured: Boolean(pool),
    apiKeyConfigured: Boolean(API_KEY)
  });
});

app.get("/api/live", async (_req, res) => {
  try {
    const fixtures = await apiGet("/fixtures?live=all");

    const matches = fixtures.map(item => ({
      id: item.fixture.id,
      league: item.league.name,
      country: item.league.country,
      minute: item.fixture.status.elapsed,
      status: item.fixture.status.short,
      home: item.teams.home.name,
