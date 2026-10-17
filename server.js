
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

app.use(express.json());
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
    return { imported: false, reason: "already_imported", rows: existing.rows[0].total };
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

        const isoDate = dateParts.length === 3
          ? `${dateParts[2]}-${dateParts[1].padStart(2, "0")}-${dateParts[0].padStart(2, "0")}`
          : null;

        values.push(
          row.Div || null, isoDate, row.Time || null,
          row.HomeTeam || null, row.AwayTeam || null,
          toNumber(row.HTHG), toNumber(row.HTAG),
          toNumber(row.FTHG), toNumber(row.FTAG), row.FTR || null,
          toNumber(row.B365H), toNumber(row.B365D), toNumber(row.B365A),
          toNumber(row.AvgH), toNumber(row.AvgD), toNumber(row.AvgA),
          toNumber(row["B365>2.5"]), toNumber(row["B365<2.5"]),
          toNumber(row["Avg>2.5"]), toNumber(row["Avg<2.5"]),
          toNumber(row["B365C>2.5"]), toNumber(row["B365C<2.5"]),
          toNumber(row.TotalGoals), toNumber(row.Over25Result)
        );

        return `(${Array.from({ length: 24 }, (_, i) => `$${offset + i + 1}`).join(",")})`;
      });

      await client.query(`
        INSERT INTO historical_matches (
          league_code, match_date, match_time, home_team, away_team,
          ht_home_goals, ht_away_goals, ft_home_goals, ft_away_goals,
          full_time_result, b365_home, b365_draw, b365_away,
          avg_home, avg_draw, avg_away, b365_over25, b365_under25,
          avg_over25, avg_under25, b365_close_over25,
          b365_close_under25, total_goals, over25_result
        ) VALUES ${placeholders.join(",")}
      `, values);

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
  if (!pool) throw new Error("DATABASE_URL ayarlanmamış.");

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
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY ayarlanmamış.");

  const response = await fetch(`${BASE_URL}${pathname}`, {
    headers: { "x-apisports-key": API_KEY },
    signal: AbortSignal.timeout(12000)
  });

  const payload = await response.json();

  if (!response.ok || Object.keys(payload.errors || {}).length > 0) {
    console.error("API-Football response error:", payload.errors);
    throw new Error("API-Football isteği başarısız.");
  }

  return payload.response || [];
}

// Bir maçın istatistiklerini getirir ve kayıt eder.
async function captureOneMatch(fixtureId) {
  const rows = await apiGet(
    `/fixtures/statistics?fixture=${encodeURIComponent(String(fixtureId))}`
  );

  if (!rows.length) {
    console.log(`İstatistik henüz yok: ${fixtureId}`);
    return { saved: false, reason: "no_statistics" };
  }

  const teams = rows.map(row => ({
    team: row.team?.name || "Bilinmiyor",
    statistics: Object.fromEntries(
      (row.statistics || []).map(stat => [stat.type, stat.value])
    )
  }));

  await pool.query(
    `INSERT INTO match_stat_snapshots (fixture_id, teams)
     VALUES ($1, $2::jsonb)`,
    [fixtureId, JSON.stringify(teams)]
  );

  return { saved: true, teams };
}

// Takip edilen en fazla 2 maçın istatistiklerini her 60 saniyede kaydeder.
async function captureTrackedMatches() {
  if (!pool || autoCaptureRunning) return;

  autoCaptureRunning = true;

  try {
    await initDatabase();

    const result = await pool.query(`
      SELECT fixture_id, home_team, away_team
      FROM tracked_matches
      ORDER BY enabled_at ASC
      LIMIT 2
    `);

    for (const match of result.rows) {
      try {
        const saved = await captureOneMatch(match.fixture_id);
        if (saved.saved) {
          console.log(
            `Otomatik kayıt başarılı: ${match.home_team} - ${match.away_team}`
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
      away: item.teams.away.name,
      homeScore: item.goals.home,
      awayScore: item.goals.away,
      homeId: item.teams.home.id,
      awayId: item.teams.away.id,
      fixtureDate: item.fixture.date
    }));

    res.json({
      source: "API-Football",
      fetchedAt: new Date().toISOString(),
      results: matches.length,
      matches
    });
  } catch (error) {
    console.error("Live API error:", error.message);
    res.status(502).json({ error: "Canlı maçlar alınamadı." });
  }
});

app.get("/api/match/:id/stats", async (req, res) => {
  const fixtureId = req.params.id;
  if (!/^\d+$/.test(fixtureId)) {
    return res.status(400).json({ error: "Geçersiz fikstür ID." });
  }

  try {
    const rows = await apiGet(`/fixtures/statistics?fixture=${fixtureId}`);
    const teams = rows.map(row => ({
      team: row.team?.name || "Bilinmiyor",
      statistics: Object.fromEntries(
        (row.statistics || []).map(stat => [stat.type, stat.value])
      )
    }));

    let saved = false;
    if (pool && teams.length > 0) {
      try {
        await initDatabase();
        await pool.query(
          `INSERT INTO match_stat_snapshots (fixture_id, teams)
           VALUES ($1, $2::jsonb)`,
          [fixtureId, JSON.stringify(teams)]
        );
        saved = true;
      } catch (error) {
        console.error("Snapshot save error:", error.message);
      }
    }

    res.json({
      source: "API-Football",
      fixtureId: Number(fixtureId),
      available: teams.length > 0,
      saved,
      teams
    });
  } catch (error) {
    console.error("Stats API error:", error.message);
    res.status(502).json({ error: "Maç istatistikleri alınamadı." });
  }
});

app.get("/api/match/:id/history", async (req, res) => {
  const fixtureId = req.params.id;
  if (!/^\d+$/.test(fixtureId)) {
    return res.status(400).json({ error: "Geçersiz fikstür ID." });
  }
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  try {
    await initDatabase();
    const result = await pool.query(`
      SELECT captured_at, teams
      FROM match_stat_snapshots
      WHERE fixture_id = $1
        AND captured_at >= NOW() - INTERVAL '10 minutes'
      ORDER BY captured_at ASC
    `, [fixtureId]);

    res.json({
      fixtureId: Number(fixtureId),
      periodMinutes: 10,
      snapshots: result.rows.length,
      enoughData: result.rows.length >= 2,
      history: result.rows
    });
  } catch (error) {
    console.error("History query error:", error.message);
    res.status(503).json({ error: "İstatistik geçmişi alınamıyor." });
  }
});

app.get("/api/tracked", async (_req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  try {
    await initDatabase();
    const result = await pool.query(`
      SELECT fixture_id, home_team, away_team, enabled_at
      FROM tracked_matches ORDER BY enabled_at DESC
    `);

    res.json({
      matches: result.rows.map(row => ({
        id: String(row.fixture_id),
        home: row.home_team,
        away: row.away_team,
        enabledAt: row.enabled_at
      }))
    });
  } catch (error) {
    console.error("Tracked matches error:", error.message);
    res.status(503).json({ error: "Takip listesi alınamadı." });
  }
});

app.post("/api/match/:id/track", async (req, res) => {
  const fixtureId = req.params.id;
  const home = req.body?.home;
  const away = req.body?.away;

  if (!/^\d+$/.test(fixtureId)) {
    return res.status(400).json({ error: "Geçersiz fikstür ID." });
  }
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }
  if (
    typeof home !== "string" || !home.trim() ||
    typeof away !== "string" || !away.trim()
  ) {
    return res.status(400).json({
      error: "Ev sahibi ve deplasman takım adları gerekli."
    });
  }

  let client;
  try {
    await initDatabase();
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [735219]);

    const existing = await client.query(
      "SELECT fixture_id FROM tracked_matches WHERE fixture_id = $1",
      [fixtureId]
    );

    if (existing.rowCount > 0) {
      await client.query("COMMIT");
      return res.json({ success: true, tracked: true, message: "Bu maç zaten takipte." });
    }

    const count = await client.query(
      "SELECT COUNT(*)::int AS total FROM tracked_matches"
    );

    if (count.rows[0].total >= 2) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "En fazla 2 maç takip edilebilir. Önce bir maçın takibini bırak."
      });
    }

    await client.query(
      `INSERT INTO tracked_matches (fixture_id, home_team, away_team)
       VALUES ($1, $2, $3)`,
      [fixtureId, home.trim(), away.trim()]
    );
    await client.query("COMMIT");

    res.json({ success: true, tracked: true, message: "Maç takip listesine eklendi." });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }
    console.error("Track match error:", error.message);
    res.status(503).json({ error: "Maç takibe alınamadı." });
  } finally {
    client?.release();
  }
});

app.delete("/api/match/:id/track", async (req, res) => {
  const fixtureId = req.params.id;
  if (!/^\d+$/.test(fixtureId)) {
    return res.status(400).json({ error: "Geçersiz fikstür ID." });
  }
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  try {
    await initDatabase();
    await pool.query(
      "DELETE FROM tracked_matches WHERE fixture_id = $1",
      [fixtureId]
    );
    res.json({ success: true, tracked: false, message: "Maç takipten çıkarıldı." });
  } catch (error) {
    console.error("Untrack match error:", error.message);
    res.status(503).json({ error: "Maç takipten çıkarılamadı." });
  }
});

app.get("/api/historical/status", async (_req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  try {
    await initDatabase();
    const result = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE over25_result = 1)::int AS over25,
             COUNT(*) FILTER (WHERE over25_result = 0)::int AS under25,
             MIN(match_date) AS earliest_date,
             MAX(match_date) AS latest_date
      FROM historical_matches
    `);
    const row = result.rows[0];

    res.json({
      ready: row.total > 0,
      totalMatches: row.total,
      over25: row.over25,
      under25: row.under25,
      earliestDate: row.earliest_date,
      latestDate: row.latest_date,
      sourceFile: "winscope_historical_odds.csv"
    });
  } catch (error) {
    console.error("Historical status error:", error.message);
    res.status(503).json({ error: "Geçmiş veri durumu alınamadı." });
  }
});

app.get("/api/historical/summary", async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }
  const league = typeof req.query.league === "string"
    ? req.query.league.trim().slice(0, 12)
    : "";

  try {
    await initDatabase();
    const result = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE over25_result = 1)::int AS over25,
             COUNT(*) FILTER (WHERE over25_result = 0)::int AS under25,
             ROUND(
               100.0 * COUNT(*) FILTER (WHERE over25_result = 1)
               / NULLIF(COUNT(*) FILTER (WHERE over25_result IN (0,1)), 0),
               2
             ) AS over25_percent,
             ROUND(AVG(b365_over25)::numeric, 3) AS avg_open_over25_odds,
             ROUND(AVG(b365_under25)::numeric, 3) AS avg_open_under25_odds,
             ROUND(AVG(b365_close_over25)::numeric, 3) AS avg_close_over25_odds,
             ROUND(AVG(b365_close_under25)::numeric, 3) AS avg_close_under25_odds
      FROM historical_matches
      WHERE ($1 = '' OR league_code = $1)
    `, [league]);

    res.json({
      source: "Imported historical dataset",
      league: league || null,
      note: "Geçmiş örneklem oranlarıdır; canlı maç olasılığı veya garanti değildir.",
      summary: result.rows[0]
    });
  } catch (error) {
    console.error("Historical summary error:", error.message);
    res.status(503).json({ error: "Geçmiş oran özeti alınamadı." });
  }
});

app.get("/api/historical/matches", async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }
  const league = typeof req.query.league === "string"
    ? req.query.league.trim().slice(0, 12)
    : "";
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 100))
    : 20;

  try {
    await initDatabase();
    const result = await pool.query(`
      SELECT league_code AS league, match_date AS date,
             home_team AS home, away_team AS away,
             ht_home_goals, ht_away_goals, ft_home_goals, ft_away_goals,
             full_time_result, b365_home, b365_draw, b365_away,
             b365_over25, b365_under25, b365_close_over25,
             b365_close_under25, total_goals, over25_result
      FROM historical_matches
      WHERE ($1 = '' OR league_code = $1)
      ORDER BY match_date DESC NULLS LAST, id DESC
      LIMIT $2
    `, [league, limit]);

    res.json({ count: result.rows.length, league: league || null, matches: result.rows });
  } catch (error) {
    console.error("Historical matches error:", error.message);
    res.status(503).json({ error: "Geçmiş maçlar alınamadı." });
  }
});

app.get("/api/historical/similar", async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  const over = Number(req.query.over);
  const under = Number(req.query.under);

  if (
    !Number.isFinite(over) || !Number.isFinite(under) ||
    over <= 1 || under <= 1 || over > 100 || under > 100
  ) {
    return res.status(400).json({
      error: "Geçerli oranlar gir. Örnek: ?over=1.80&under=2.00"
    });
  }

  try {
    await initDatabase();
    const result = await pool.query(`
      WITH matched_rows AS (
        SELECT id, match_date, home_team, away_team,
               b365_over25, b365_under25, total_goals, over25_result,
               ABS(b365_over25 - $1::numeric)
                 + ABS(b365_under25 - $2::numeric) AS odds_distance
        FROM historical_matches
        WHERE b365_over25 IS NOT NULL
          AND b365_under25 IS NOT NULL
          AND over25_result IN (0, 1)
          AND ABS(b365_over25 - $1::numeric) <= 0.20
          AND ABS(b365_under25 - $2::numeric) <= 0.20
        ORDER BY odds_distance ASC, match_date DESC NULLS LAST
        LIMIT 100
      )
      SELECT COUNT(*)::int AS sample_size,
             COUNT(*) FILTER (WHERE over25_result = 1)::int AS over25,
             COUNT(*) FILTER (WHERE over25_result = 0)::int AS under25,
             ROUND(
               100.0 * COUNT(*) FILTER (WHERE over25_result = 1)
               / NULLIF(COUNT(*), 0), 2
             ) AS over25_percent,
             ROUND(
               100.0 * COUNT(*) FILTER (WHERE over25_result = 0)
               / NULLIF(COUNT(*), 0), 2
             ) AS under25_percent,
             ROUND(AVG(odds_distance)::numeric, 3) AS average_odds_distance
      FROM matched_rows
    `, [over, under]);

    const row = result.rows[0];
    const sampleSize = row.sample_size || 0;
    let assessment = "UZAK DUR";

    if (sampleSize >= 30) {
      const overPercent = Number(row.over25_percent || 0);
      const underPercent = Number(row.under25_percent || 0);

      if (overPercent >= 60) assessment = "TARİHSEL EĞİLİM: 2.5 ÜST";
      else if (underPercent >= 60) assessment = "TARİHSEL EĞİLİM: 2.5 ALT";
      else assessment = "TUTARSIZ SİNYAL";
    }

    res.json({
      source: "historical_matches",
      requestedOdds: { over25: over, under25: under },
      oddsTolerance: 0.20,
      maxSample: 100,
      sampleSize,
      over25: row.over25,
      under25: row.under25,
      over25Percent: row.over25_percent,
      under25Percent: row.under25_percent,
      averageOddsDistance: row.average_odds_distance,
      assessment,
      note: "Geçmiş benzer açılış oranlarının sonucudur; canlı oran veya garanti değildir."
    });
  } catch (error) {
    console.error("Similar historical matches error:", error.message);
    res.status(503).json({ error: "Benzer geçmiş maçlar sorgulanamadı." });
  }
});

app.get("/api/db-status", async (_req, res) => {
  if (!pool) {
    return res.status(503).json({
      connected: false,
      error: "DATABASE_URL ayarlanmamış."
    });
  }

  try {
    await initDatabase();
    await pool.query("SELECT 1");
    res.json({ connected: true, database: "PostgreSQL" });
  } catch (error) {
    console.error("Database status error:", error.message);
    res.status(503).json({
      connected: false,
      error: "Veritabanına bağlanılamadı."
    });
  }
});

app.get("/api/auto-capture/status", async (_req, res) => {
  if (!pool) {
    return res.status(503).json({ enabled: false, error: "DATABASE_URL ayarlanmamış." });
  }

  try {
    await initDatabase();
    const result = await pool.query(`
      SELECT COUNT(*)::int AS tracked_matches
      FROM tracked_matches
    `);

    res.json({
      enabled: true,
      intervalSeconds: 60,
      running: autoCaptureRunning,
      trackedMatches: result.rows[0].tracked_matches,
      maxTrackedMatches: 2,
      note: "Otomatik kayıt, sunucu çalışırken yaklaşık 60 saniyede bir denenir."
    });
  } catch (error) {
    console.error("Auto-capture status error:", error.message);
    res.status(503).json({ enabled: false, error: "Otomatik kayıt durumu alınamadı." });
  }
});

app.listen(PORT, () => {
  console.log(`WinScope Live running on port ${PORT}`);
  console.log("Otomatik istatistik kaydı: 60 saniyelik aralık.");

  // Başlangıçta ilk kayıt denemesi, sonra 60 saniyede bir.
  captureTrackedMatches().catch(error => {
    console.error("İlk otomatik kayıt denemesi başarısız:", error.message);
  });

  const timer = setInterval(() => {
    captureTrackedMatches().catch(error => {
      console.error("Otomatik kayıt döngüsü başarısız:", error.message);
    });
  }, 60 * 1000);

  timer.unref();
});
