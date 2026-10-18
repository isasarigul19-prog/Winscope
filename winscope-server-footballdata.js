import express from "express";
import pg from "pg";
import { parse } from "csv-parse/sync";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = "https://api.football-data.org/v4";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HISTORICAL_CSV = path.join(ROOT, "winscope_historical_odds.csv");
const { Pool } = pg;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(ROOT, "public")));

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 3
}) : null;

let dbReady = null;
let autoCaptureRunning = false;
// API cache: live odds are cached for 60 seconds; pre-match odds for 3 hours.
const oddsCache = new Map();
const oddsInFlight = new Map();
const CACHE_MS = { live: 60_000, prematch: 3 * 60 * 60 * 1000 };

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
  const existing = await pool.query("SELECT COUNT(*)::int AS total FROM historical_matches");
  if (existing.rows[0].total > 0) {
    console.log(`Geçmiş veri zaten yüklü: ${existing.rows[0].total}`);
    return { imported: false, reason: "already_imported", rows: existing.rows[0].total };
  }
  const csvText = await readFile(HISTORICAL_CSV, "utf8");
  const records = parse(csvText, { columns: true, bom: true, skip_empty_lines: true, trim: true });
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
          ? `${dateParts[2]}-${dateParts[1].padStart(2, "0")}-${dateParts[0].padStart(2, "0")}` : null;
        values.push(
          row.Div || null, isoDate, row.Time || null, row.HomeTeam || null, row.AwayTeam || null,
          toNumber(row.HTHG), toNumber(row.HTAG), toNumber(row.FTHG), toNumber(row.FTAG), row.FTR || null,
          toNumber(row.B365H), toNumber(row.B365D), toNumber(row.B365A), toNumber(row.AvgH), toNumber(row.AvgD), toNumber(row.AvgA),
          toNumber(row["B365>2.5"]), toNumber(row["B365<2.5"]), toNumber(row["Avg>2.5"]), toNumber(row["Avg<2.5"]),
          toNumber(row["B365C>2.5"]), toNumber(row["B365C<2.5"]), toNumber(row.TotalGoals), toNumber(row.Over25Result)
        );
        return `(${Array.from({ length: 24 }, (_, i) => `$${offset + i + 1}`).join(",")})`;
      });
      await client.query(`INSERT INTO historical_matches (
        league_code, match_date, match_time, home_team, away_team, ht_home_goals, ht_away_goals,
        ft_home_goals, ft_away_goals, full_time_result, b365_home, b365_draw, b365_away,
        avg_home, avg_draw, avg_away, b365_over25, b365_under25, avg_over25, avg_under25,
        b365_close_over25, b365_close_under25, total_goals, over25_result
      ) VALUES ${placeholders.join(",")}`, values);
      inserted += batch.length;
    }
    await client.query("COMMIT");
    console.log(`Tarihsel maçlar içe aktarıldı: ${inserted}`);
    return { imported: true, rows: inserted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function initDatabase() {
  if (!pool) throw new Error("DATABASE_URL ayarlanmamış.");
  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS match_stat_snapshots (
          id BIGSERIAL PRIMARY KEY, fixture_id BIGINT NOT NULL,
          captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), teams JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_match_snapshots_fixture_time ON match_stat_snapshots (fixture_id, captured_at DESC);
        CREATE TABLE IF NOT EXISTS tracked_matches (
          fixture_id BIGINT PRIMARY KEY, home_team TEXT NOT NULL, away_team TEXT NOT NULL,
          enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS historical_matches (
          id BIGSERIAL PRIMARY KEY, league_code TEXT, match_date DATE, match_time TEXT,
          home_team TEXT NOT NULL, away_team TEXT NOT NULL, ht_home_goals INTEGER, ht_away_goals INTEGER,
          ft_home_goals INTEGER, ft_away_goals INTEGER, full_time_result TEXT,
          b365_home NUMERIC, b365_draw NUMERIC, b365_away NUMERIC, avg_home NUMERIC, avg_draw NUMERIC, avg_away NUMERIC,
          b365_over25 NUMERIC, b365_under25 NUMERIC, avg_over25 NUMERIC, avg_under25 NUMERIC,
          b365_close_over25 NUMERIC, b365_close_under25 NUMERIC, total_goals INTEGER, over25_result INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_historical_league_date ON historical_matches (league_code, match_date DESC);
        CREATE INDEX IF NOT EXISTS idx_historical_teams ON historical_matches (home_team, away_team);
        CREATE TABLE IF NOT EXISTS odds_snapshots (
          id BIGSERIAL PRIMARY KEY, fixture_id BIGINT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('live','prematch')),
          bookmaker TEXT NOT NULL, market_name TEXT NOT NULL, selection TEXT NOT NULL, odd NUMERIC NOT NULL,
          captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), raw JSONB
        );
        CREATE INDEX IF NOT EXISTS idx_odds_snapshots_lookup ON odds_snapshots (fixture_id, mode, bookmaker, market_name, selection, captured_at DESC);
        CREATE TABLE IF NOT EXISTS sent_match_alarms (
          id BIGSERIAL PRIMARY KEY, fixture_id BIGINT NOT NULL, alarm_key TEXT NOT NULL,
          sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (fixture_id, alarm_key)
        );
      `);
      await importHistoricalCsvOnce();
      return true;
    })().catch(error => { dbReady = null; console.error("Database initialization error:", error.message); throw error; });
  }
  return dbReady;
}

function mapFootballDataStatus(status) {
  const value = String(status || "").toUpperCase();
  if (value === "FINISHED") return "FT";
  if (value === "PAUSED") return "HT";
  if (value === "IN_PLAY" || value === "LIVE") return "LIVE";
  if (["SCHEDULED", "TIMED"].includes(value)) return "NS";
  if (value === "POSTPONED") return "PST";
  if (value === "CANCELLED") return "CANC";
  return value || "NS";
}

function normalizeFootballDataMatch(match) {
  return {
    id: Number(match.id),
    league: match.competition?.name || "Bilinmeyen lig",
    country: match.area?.name || "",
    minute: null, // football-data.org free API does not reliably expose the live minute.
    status: mapFootballDataStatus(match.status),
    home: match.homeTeam?.name || "Ev sahibi",
    away: match.awayTeam?.name || "Deplasman",
    homeScore: match.score?.fullTime?.home ?? match.score?.regularTime?.home ?? null,
    awayScore: match.score?.fullTime?.away ?? match.score?.regularTime?.away ?? null,
    homeId: match.homeTeam?.id ?? null,
    awayId: match.awayTeam?.id ?? null,
    fixtureDate: match.utcDate || null
  };
}

async function footballDataRequest(pathname) {
  if (!API_KEY) throw new Error("FOOTBALL_DATA_API_KEY ayarlanmamış.");
  const response = await fetch(`${BASE_URL}${pathname}`, {
    headers: { "X-Auth-Token": API_KEY, "Accept": "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`football-data.org geçerli JSON döndürmedi (HTTP ${response.status}).`); }
  if (!response.ok) {
    const detail = payload.message || payload.error || `HTTP ${response.status}`;
    throw new Error(`football-data.org isteği başarısız: ${detail}`);
  }
  return payload;
}

// Compatibility adapter: preserve the existing WinScope frontend response shape.
async function apiGet(pathname) {
  if (pathname.startsWith("/fixtures/statistics")) return [];
  if (pathname.startsWith("/odds")) return [];
  if (pathname.startsWith("/fixtures?live=all")) {
    const payload = await footballDataRequest("/matches?status=LIVE");
    return (payload.matches || []).map(match => ({
      fixture: { id: Number(match.id), date: match.utcDate, status: { short: mapFootballDataStatus(match.status), elapsed: null } },
      league: { name: match.competition?.name || "Bilinmeyen lig", country: match.area?.name || "" },
      teams: { home: { id: match.homeTeam?.id ?? null, name: match.homeTeam?.name || "Ev sahibi" }, away: { id: match.awayTeam?.id ?? null, name: match.awayTeam?.name || "Deplasman" } },
      goals: { home: match.score?.fullTime?.home ?? match.score?.regularTime?.home ?? null, away: match.score?.fullTime?.away ?? match.score?.regularTime?.away ?? null }
    }));
  }
  const idMatch = pathname.match(/^\/fixtures\?id=(\d+)/);
  if (idMatch) {
    const payload = await footballDataRequest(`/matches/${idMatch[1]}`);
    const match = payload.match || payload;
    if (!match?.id) return [];
    return [{
      fixture: { id: Number(match.id), date: match.utcDate, status: { short: mapFootballDataStatus(match.status), elapsed: null } },
      league: { name: match.competition?.name || "Bilinmeyen lig", country: match.area?.name || "" },
      teams: { home: { id: match.homeTeam?.id ?? null, name: match.homeTeam?.name || "Ev sahibi" }, away: { id: match.awayTeam?.id ?? null, name: match.awayTeam?.name || "Deplasman" } },
      goals: { home: match.score?.fullTime?.home ?? match.score?.regularTime?.home ?? null, away: match.score?.fullTime?.away ?? match.score?.regularTime?.away ?? null }
    }];
  }
  throw new Error("Bu veri kaynağında istenen uç nokta desteklenmiyor.");
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
  if (cached && now - cached.at < CACHE_MS[mode]) return { ...cached.data, cached: true };
  if (oddsInFlight.has(key)) return oddsInFlight.get(key);
  const task = (async () => {
    // football-data.org does not provide bookmaker odds in this plan.
    const markets = [];
    const data = {
      fixtureId: Number(fixtureId), mode, source: "football-data.org", fetchedAt: new Date().toISOString(),
      available: false, markets,
      note: "football-data.org bu bağlantıda bahis oranı sağlamıyor; oran uydurulmadı."
    };
    if (pool && markets.length) {
      try {
        await initDatabase();
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          for (const market of markets) {
            await client.query(`INSERT INTO odds_snapshots
              (fixture_id, mode, bookmaker, market_name, selection, odd, raw)
              VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [
              fixtureId, mode, market.bookmaker, market.market, market.selection, market.odd, JSON.stringify(market)
            ]);
          }
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
      } catch (error) { console.error("Odds snapshot save error:", error.message); data.saveWarning = "Oran geldi ancak geçmiş kaydı yapılamadı."; }
      // Compare each current selection with the immediately previous stored snapshot.
      for (const market of markets) {
        try {
          const prev = await pool.query(`SELECT odd, captured_at FROM odds_snapshots
            WHERE fixture_id=$1 AND mode=$2 AND bookmaker=$3 AND market_name=$4 AND selection=$5
              AND captured_at < $6::timestamptz
            ORDER BY captured_at DESC LIMIT 1`, [fixtureId, mode, market.bookmaker, market.market, market.selection, data.fetchedAt]);
          if (prev.rows.length) {
            market.previousOdd = Number(prev.rows[0].odd);
            market.change = Number((market.odd - market.previousOdd).toFixed(3));
            market.direction = market.change < 0 ? "DÜŞTÜ" : market.change > 0 ? "YÜKSELDİ" : "SABİT";
            market.previousCapturedAt = prev.rows[0].captured_at;
          } else { market.previousOdd = null; market.change = null; market.direction = "İLK KAYIT"; }
        } catch (error) { console.error("Odds movement query error:", error.message); }
      }
    } else {
      for (const market of markets) { market.previousOdd = null; market.change = null; market.direction = "GEÇMİŞ HAREKET YOK"; }
    }
    oddsCache.set(key, { at: now, data });
    return data;
  })();
  oddsInFlight.set(key, task);
  try { return await task; } finally { oddsInFlight.delete(key); }
}

async function captureOneMatch(fixtureId) {
  const rows = await apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(String(fixtureId))}`);
  if (!rows.length) return { saved: false, reason: "no_statistics" };
  const teams = rows.map(row => ({ team: row.team?.name || "Bilinmiyor", statistics: Object.fromEntries((row.statistics || []).map(stat => [stat.type, stat.value])) }));
  await pool.query("INSERT INTO match_stat_snapshots (fixture_id, teams) VALUES ($1, $2::jsonb)", [fixtureId, JSON.stringify(teams)]);
  return { saved: true, teams };
}

async function captureTrackedMatches() {
  if (!pool || autoCaptureRunning) return;
  autoCaptureRunning = true;
  try {
    await initDatabase();
    const result = await pool.query("SELECT fixture_id, home_team, away_team FROM tracked_matches ORDER BY enabled_at ASC LIMIT 2");
    for (const match of result.rows) {
      try {
        const saved = await captureOneMatch(match.fixture_id);
        if (saved.saved) console.log(`Otomatik istatistik kaydı: ${match.home_team} - ${match.away_team}`);
      } catch (error) { console.error(`Otomatik kayıt hatası (${match.fixture_id}):`, error.message); }
    }
  } catch (error) { console.error("Otomatik kayıt döngüsü hatası:", error.message); }
  finally { autoCaptureRunning = false; }
}

// Telegram alarm system: only two tracked matches are scanned to protect free API quota.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let alarmScanRunning = false;

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID ayarlanmamış.");
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram HTTP ${response.status}`);
  return payload.result;
}

function statNumber(team, names) {
  const stats = team?.statistics || {};
  for (const name of names) {
    const raw = stats[name];
    if (raw == null || raw === "-") continue;
    const n = Number(String(raw).replace("%", "").trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function assessGoalPressure(teams) {
  if (!Array.isArray(teams) || teams.length < 2) return { ok: false, reason: "İstatistikler eksik." };
  const home = teams[0], away = teams[1];
  const homeShots = statNumber(home, ["Total Shots"]);
  const awayShots = statNumber(away, ["Total Shots"]);
  const homeOnTarget = statNumber(home, ["Shots on Goal"]);
  const awayOnTarget = statNumber(away, ["Shots on Goal"]);
  const homeCorners = statNumber(home, ["Corner Kicks"]);
  const awayCorners = statNumber(away, ["Corner Kicks"]);
  if ([homeShots, awayShots, homeOnTarget, awayOnTarget, homeCorners, awayCorners].some(v => v == null)) {
    return { ok: false, reason: "Gerekli şut/kaleyi bulan şut/korner verisi eksik." };
  }
  const totalShots = homeShots + awayShots;
  const totalOnTarget = homeOnTarget + awayOnTarget;
  const totalCorners = homeCorners + awayCorners;
  // Conservative signal: enough overall activity plus at least one direct threat indicator.
  const ok = totalShots >= 8 && (totalOnTarget >= 3 || totalCorners >= 4);
  return { ok, totalShots, totalOnTarget, totalCorners,
    reason: ok ? "Şut ve tehlike göstergeleri yeterli." : "İstatistik baskısı eşik altında." };
}

async function evaluateMatchAlarms(match, fixture, teams) {
  const minute = Number(fixture.fixture?.status?.elapsed);
  const homeScore = Number(fixture.goals?.home);
  const awayScore = Number(fixture.goals?.away);
  if (!Number.isFinite(minute) || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return;
  const totalGoals = homeScore + awayScore;
  const pressure = assessGoalPressure(teams);
  if (!pressure.ok) return; // Missing or conflicting signal: silently skip.

  const candidates = [];
  if (minute >= 20 && minute <= 22 && ((homeScore === 1 && awayScore === 0) || (homeScore === 0 && awayScore === 1))) {
    candidates.push({ key: "ht_over15_20", title: "İLK YARI 1.5 ÜST ADAYI", rationale: "20. dakika civarında tek gol var; istatistik baskısı devam golü sinyali veriyor." });
  }
  if (minute >= 65 && minute <= 67 && ((homeScore === 1 && awayScore === 0) || (homeScore === 0 && awayScore === 1))) {
    candidates.push({ key: "ft_over15_65", title: "MAÇ SONU 1.5 ÜST ADAYI", rationale: "65. dakika civarında tek gol var; istatistik baskısı bir gol daha ihtimalini destekliyor." });
  }
  if (minute >= 70 && minute <= 72 && ((homeScore === 1 && awayScore === 1) || (homeScore === 2 && awayScore === 0) || (homeScore === 0 && awayScore === 2))) {
    candidates.push({ key: "ft_over25_70", title: "MAÇ SONU 2.5 ÜST ADAYI", rationale: "70. dakika civarında toplam iki gol var; istatistik baskısı üçüncü gol ihtimalini destekliyor." });
  }

  for (const alarm of candidates) {
    const client = await pool.connect();
    let claimed = false;
    try {
      await client.query("BEGIN");
      const claim = await client.query(`INSERT INTO sent_match_alarms (fixture_id, alarm_key) VALUES ($1,$2) ON CONFLICT (fixture_id, alarm_key) DO NOTHING RETURNING id`, [match.fixture_id, alarm.key]);
      claimed = claim.rowCount > 0;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Alarm deduplication error:", error.message);
    } finally { client.release(); }
    if (!claimed) continue;

    const text = `⚽ WinScope ALARM\n${fixture.teams?.home?.name || match.home_team} - ${fixture.teams?.away?.name || match.away_team}\nDakika: ${minute}' | Skor: ${homeScore}-${awayScore}\nAlarm: ${alarm.title}\nSinyal: ${alarm.rationale}\nİstatistik: Şut ${pressure.totalShots}, kaleyi bulan ${pressure.totalOnTarget}, korner ${pressure.totalCorners}\nNot: Bu bir istatistik alarmıdır, bahis garantisi değildir.`;
    try {
      await sendTelegramMessage(text);
      console.log(`Telegram alarmı gönderildi: ${match.fixture_id} / ${alarm.key}`);
    } catch (error) {
      // Allow retry on next scan if Telegram delivery failed.
      await pool.query("DELETE FROM sent_match_alarms WHERE fixture_id=$1 AND alarm_key=$2", [match.fixture_id, alarm.key]).catch(() => {});
      console.error("Telegram alarm gönderilemedi:", error.message);
    }
  }
}

async function scanTrackedMatchAlarms() {
  if (!pool || alarmScanRunning || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  alarmScanRunning = true;
  try {
    await initDatabase();
    const tracked = await pool.query("SELECT fixture_id, home_team, away_team FROM tracked_matches ORDER BY enabled_at ASC LIMIT 2");
    for (const match of tracked.rows) {
      try {
        const fixtures = await apiGet(`/fixtures?id=${encodeURIComponent(String(match.fixture_id))}`);
        if (!fixtures.length) continue;
        const fixture = fixtures[0];
        const minute = Number(fixture.fixture?.status?.elapsed);
        if (!Number.isFinite(minute) || minute < 20 || minute > 72) continue;
        const statRows = await apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(String(match.fixture_id))}`);
        const teams = statRows.map(row => ({ team: row.team?.name || "Bilinmiyor", statistics: Object.fromEntries((row.statistics || []).map(stat => [stat.type, stat.value])) }));
        await evaluateMatchAlarms(match, fixture, teams);
      } catch (error) { console.error(`Alarm tarama hatası (${match.fixture_id}):`, error.message); }
    }
  } catch (error) { console.error("Alarm tarama döngüsü hatası:", error.message); }
  finally { alarmScanRunning = false; }
}

app.get("/api/telegram-test", async (_req, res) => {
  try {
    await sendTelegramMessage("✅ WinScope Telegram bağlantı testi başarılı.");
    res.json({ success: true, message: "Test mesajı Telegram'a gönderildi." });
  } catch (error) {
    console.error("Telegram test error:", error.message);
    res.status(503).json({ success: false, error: error.message });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "WinScope Live", odds: false, databaseConfigured: Boolean(pool), apiKeyConfigured: Boolean(API_KEY), dataSource: "football-data.org" }));

app.get("/api/fixtures", async (req, res) => {
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Geçerli bir tarih gerekli: YYYY-MM-DD." });
  try {
    const payload = await footballDataRequest(`/matches?dateFrom=${encodeURIComponent(date)}&dateTo=${encodeURIComponent(date)}`);
    const matches = (payload.matches || []).map(normalizeFootballDataMatch);
    res.json({ source: "football-data.org", fetchedAt: new Date().toISOString(), results: matches.length, matches,
      note: "Ücretsiz planda yalnızca sağlayıcının desteklediği organizasyonlar görünür. Bahis oranları, canlı dakika ve şut/korner istatistikleri bu API yanıtında garanti edilmez." });
  } catch (error) {
    console.error("Fixture API error:", error.message);
    res.status(502).json({ error: "Maç bülteni alınamadı.", detail: error.message });
  }
});

app.get("/api/live", async (_req, res) => {
  try {
    const fixtures = await apiGet("/fixtures?live=all");
    const matches = fixtures.map(item => ({
      id: item.fixture.id, league: item.league.name, country: item.league.country,
      minute: item.fixture.status.elapsed, status: item.fixture.status.short,
      home: item.teams.home.name, away: item.teams.away.name,
      homeScore: item.goals.home, awayScore: item.goals.away,
      homeId: item.teams.home.id, awayId: item.teams.away.id, fixtureDate: item.fixture.date
    }));
    res.json({ source: "football-data.org", fetchedAt: new Date().toISOString(), results: matches.length, matches, note: "Ücretsiz kaynak canlı dakika ve şut/korner istatistiklerini sağlamayabilir; bu nedenle istatistik tabanlı dakika alarmları doğrulanamaz." });
  } catch (error) {
    console.error("Live API error:", error.message);
    res.status(502).json({ error: "Canlı maçlar alınamadı.", detail: error.message });
  }
});

app.get("/api/match/:id/odds", async (req, res) => {
  const fixtureId = req.params.id;
  const mode = req.query.mode === "live" ? "live" : req.query.mode === "prematch" || !req.query.mode ? "prematch" : null;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  if (!mode) return res.status(400).json({ error: "mode=live veya mode=prematch kullan." });
  try { res.json(await getOdds(fixtureId, mode)); }
  catch (error) {
    console.error(`Odds API error (${mode}, ${fixtureId}):`, error.message);
    const status = error.message.includes("ayarlanmamış") ? 503 : 502;
    res.status(status).json({ error: mode === "live" ? "Canlı oranlar alınamadı." : "Maç önü oranları alınamadı.", detail: error.message, fixtureId: Number(fixtureId), mode });
  }
});

app.get("/api/match/:id/odds-history", async (req, res) => {
  const fixtureId = req.params.id;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  const mode = req.query.mode === "live" ? "live" : "prematch";
  try {
    await initDatabase();
    const result = await pool.query(`SELECT bookmaker, market_name AS market, selection, odd, captured_at
      FROM odds_snapshots WHERE fixture_id=$1 AND mode=$2 AND captured_at >= NOW() - INTERVAL '7 days'
      ORDER BY captured_at DESC LIMIT 500`, [fixtureId, mode]);
    res.json({ fixtureId: Number(fixtureId), mode, count: result.rows.length, history: result.rows, note: "Hareket yalnızca WinScope'un kaydettiği gözlemler arasında hesaplanır." });
  } catch (error) { console.error("Odds history error:", error.message); res.status(503).json({ error: "Oran geçmişi alınamadı." }); }
});

app.get("/api/match/:id/stats", async (req, res) => {
  const fixtureId = req.params.id;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  try {
    const rows = await apiGet(`/fixtures/statistics?fixture=${fixtureId}`);
    const teams = rows.map(row => ({ team: row.team?.name || "Bilinmiyor", statistics: Object.fromEntries((row.statistics || []).map(stat => [stat.type, stat.value])) }));
    let saved = false;
    if (pool && teams.length) {
      try { await initDatabase(); await pool.query("INSERT INTO match_stat_snapshots (fixture_id, teams) VALUES ($1, $2::jsonb)", [fixtureId, JSON.stringify(teams)]); saved = true; }
      catch (error) { console.error("Snapshot save error:", error.message); }
    }
    res.json({ source: "football-data.org", fixtureId: Number(fixtureId), available: teams.length > 0, saved, teams });
  } catch (error) { console.error("Stats API error:", error.message); res.status(502).json({ error: "Maç istatistikleri alınamadı.", detail: error.message }); }
});

app.get("/api/match/:id/history", async (req, res) => {
  const fixtureId = req.params.id;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  try {
    await initDatabase();
    const result = await pool.query("SELECT captured_at, teams FROM match_stat_snapshots WHERE fixture_id=$1 AND captured_at >= NOW() - INTERVAL '10 minutes' ORDER BY captured_at ASC", [fixtureId]);
    res.json({ fixtureId: Number(fixtureId), periodMinutes: 10, snapshots: result.rows.length, enoughData: result.rows.length >= 2, history: result.rows });
  } catch (error) { console.error("History query error:", error.message); res.status(503).json({ error: "İstatistik geçmişi alınamıyor." }); }
});

app.get("/api/tracked", async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  try {
    await initDatabase();
    const result = await pool.query("SELECT fixture_id, home_team, away_team, enabled_at FROM tracked_matches ORDER BY enabled_at DESC");
    res.json({ matches: result.rows.map(row => ({ id: String(row.fixture_id), home: row.home_team, away: row.away_team, enabledAt: row.enabled_at })) });
  } catch (error) { console.error("Tracked matches error:", error.message); res.status(503).json({ error: "Takip listesi alınamadı." }); }
});

app.post("/api/match/:id/track", async (req, res) => {
  const fixtureId = req.params.id, home = req.body?.home, away = req.body?.away;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  if (typeof home !== "string" || !home.trim() || typeof away !== "string" || !away.trim()) return res.status(400).json({ error: "Ev sahibi ve deplasman takım adları gerekli." });
  let client;
  try {
    await initDatabase(); client = await pool.connect(); await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock($1)", [735219]);
    const existing = await client.query("SELECT fixture_id FROM tracked_matches WHERE fixture_id=$1", [fixtureId]);
    if (existing.rowCount) { await client.query("COMMIT"); return res.json({ success: true, tracked: true, message: "Bu maç zaten takipte." }); }
    const count = await client.query("SELECT COUNT(*)::int AS total FROM tracked_matches");
    if (count.rows[0].total >= 2) { await client.query("ROLLBACK"); return res.status(409).json({ error: "En fazla 2 maç takip edilebilir. Önce bir maçın takibini bırak." }); }
    await client.query("INSERT INTO tracked_matches (fixture_id, home_team, away_team) VALUES ($1,$2,$3)", [fixtureId, home.trim(), away.trim()]);
    await client.query("COMMIT"); res.json({ success: true, tracked: true, message: "Maç takip listesine eklendi." });
  } catch (error) {
    if (client) try { await client.query("ROLLBACK"); } catch {}
    console.error("Track match error:", error.message); res.status(503).json({ error: "Maç takibe alınamadı." });
  } finally { client?.release(); }
});

app.delete("/api/match/:id/track", async (req, res) => {
  const fixtureId = req.params.id;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  try { await initDatabase(); await pool.query("DELETE FROM tracked_matches WHERE fixture_id=$1", [fixtureId]); res.json({ success: true, tracked: false, message: "Maç takipten çıkarıldı." }); }
  catch (error) { console.error("Untrack match error:", error.message); res.status(503).json({ error: "Maç takipten çıkarılamadı." }); }
});

app.get("/api/historical/status", async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  try {
    await initDatabase();
    const result = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE over25_result=1)::int AS over25,
      COUNT(*) FILTER (WHERE over25_result=0)::int AS under25, MIN(match_date) AS earliest_date, MAX(match_date) AS latest_date FROM historical_matches`);
    const row = result.rows[0];
    res.json({ ready: row.total > 0, totalMatches: row.total, over25: row.over25, under25: row.under25, earliestDate: row.earliest_date, latestDate: row.latest_date, sourceFile: "winscope_historical_odds.csv" });
  } catch (error) { console.error("Historical status error:", error.message); res.status(503).json({ error: "Geçmiş veri durumu alınamadı." }); }
});

app.get("/api/historical/summary", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  const league = typeof req.query.league === "string" ? req.query.league.trim().slice(0, 12) : "";
  try {
    await initDatabase();
    const result = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE over25_result=1)::int AS over25,
      COUNT(*) FILTER (WHERE over25_result=0)::int AS under25,
      ROUND(100.0*COUNT(*) FILTER (WHERE over25_result=1)/NULLIF(COUNT(*) FILTER (WHERE over25_result IN (0,1)),0),2) AS over25_percent,
      ROUND(AVG(b365_over25)::numeric,3) AS avg_open_over25_odds, ROUND(AVG(b365_under25)::numeric,3) AS avg_open_under25_odds,
      ROUND(AVG(b365_close_over25)::numeric,3) AS avg_close_over25_odds, ROUND(AVG(b365_close_under25)::numeric,3) AS avg_close_under25_odds
      FROM historical_matches WHERE ($1='' OR league_code=$1)`, [league]);
    res.json({ source: "Imported historical dataset", league: league || null, note: "Geçmiş örneklem oranlarıdır; canlı maç olasılığı veya garanti değildir.", summary: result.rows[0] });
  } catch (error) { console.error("Historical summary error:", error.message); res.status(503).json({ error: "Geçmiş oran özeti alınamadı." }); }
});

app.get("/api/historical/matches", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  const league = typeof req.query.league === "string" ? req.query.league.trim().slice(0, 12) : "";
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
  try {
    await initDatabase();
    const result = await pool.query(`SELECT league_code AS league, match_date AS date, home_team AS home, away_team AS away,
      ht_home_goals, ht_away_goals, ft_home_goals, ft_away_goals, full_time_result, b365_home, b365_draw, b365_away,
      b365_over25, b365_under25, b365_close_over25, b365_close_under25, total_goals, over25_result
      FROM historical_matches WHERE ($1='' OR league_code=$1) ORDER BY match_date DESC NULLS LAST,id DESC LIMIT $2`, [league, limit]);
    res.json({ count: result.rows.length, league: league || null, matches: result.rows });
  } catch (error) { console.error("Historical matches error:", error.message); res.status(503).json({ error: "Geçmiş maçlar alınamadı." }); }
});

app.get("/api/historical/similar", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  const over = Number(req.query.over), under = Number(req.query.under);
  if (!Number.isFinite(over) || !Number.isFinite(under) || over <= 1 || under <= 1 || over > 100 || under > 100) return res.status(400).json({ error: "Geçerli oranlar gir. Örnek: ?over=1.80&under=2.00" });
  try {
    await initDatabase();
    const result = await pool.query(`WITH matched_rows AS (
      SELECT id,match_date,home_team,away_team,b365_over25,b365_under25,total_goals,over25_result,
      ABS(b365_over25-$1::numeric)+ABS(b365_under25-$2::numeric) AS odds_distance
      FROM historical_matches WHERE b365_over25 IS NOT NULL AND b365_under25 IS NOT NULL AND over25_result IN (0,1)
        AND ABS(b365_over25-$1::numeric)<=0.20 AND ABS(b365_under25-$2::numeric)<=0.20
      ORDER BY odds_distance ASC,match_date DESC NULLS LAST LIMIT 100)
      SELECT COUNT(*)::int AS sample_size, COUNT(*) FILTER (WHERE over25_result=1)::int AS over25,
      COUNT(*) FILTER (WHERE over25_result=0)::int AS under25,
      ROUND(100.0*COUNT(*) FILTER (WHERE over25_result=1)/NULLIF(COUNT(*),0),2) AS over25_percent,
      ROUND(100.0*COUNT(*) FILTER (WHERE over25_result=0)/NULLIF(COUNT(*),0),2) AS under25_percent,
      ROUND(AVG(odds_distance)::numeric,3) AS average_odds_distance FROM matched_rows`, [over, under]);
    const row = result.rows[0], sampleSize = row.sample_size || 0;
    let assessment = "UZAK DUR";
    if (sampleSize >= 30) {
      const overPercent = Number(row.over25_percent || 0), underPercent = Number(row.under25_percent || 0);
      if (overPercent >= 60) assessment = "TARİHSEL EĞİLİM: 2.5 ÜST";
      else if (underPercent >= 60) assessment = "TARİHSEL EĞİLİM: 2.5 ALT";
      else assessment = "TUTARSIZ SİNYAL";
    }
    res.json({ source: "historical_matches", requestedOdds: { over25: over, under25: under }, oddsTolerance: 0.20, maxSample: 100,
      sampleSize, over25: row.over25, under25: row.under25, over25Percent: row.over25_percent, under25Percent: row.under25_percent,
      averageOddsDistance: row.average_odds_distance, assessment,
      note: "Geçmiş benzer açılış oranlarının sonucudur; canlı oran veya garanti değildir." });
  } catch (error) { console.error("Similar historical matches error:", error); res.status(503).json({ error: "Benzer geçmiş maçlar sorgulanamadı.", detail: error.message }); }
});

app.get("/api/db-status", async (_req, res) => {
  if (!pool) return res.status(503).json({ connected: false, error: "DATABASE_URL ayarlanmamış." });
  try { await initDatabase(); await pool.query("SELECT 1"); res.json({ connected: true, database: "PostgreSQL" }); }
  catch (error) { console.error("Database status error:", error.message); res.status(503).json({ connected: false, error: "Veritabanına bağlanılamadı.", detail: error.message }); }
});

app.get("/api/auto-capture/status", async (_req, res) => {
  if (!pool) return res.status(503).json({ enabled: false, error: "DATABASE_URL ayarlanmamış." });
  try { await initDatabase(); const result = await pool.query("SELECT COUNT(*)::int AS tracked_matches FROM tracked_matches");
    res.json({ enabled: true, intervalSeconds: 60, running: autoCaptureRunning, trackedMatches: result.rows[0].tracked_matches, maxTrackedMatches: 2,
      note: "İstatistikler sunucu çalışırken yaklaşık 60 saniyede bir denenir. Oranlar ise API kotasını korumak için yalnızca istendiğinde yenilenir." });
  } catch (error) { console.error("Auto-capture status error:", error.message); res.status(503).json({ enabled: false, error: "Otomatik kayıt durumu alınamadı." }); }
});

app.listen(PORT, () => {
  console.log(`WinScope Live running on port ${PORT}`);
  console.log("football-data.org bağlantısı: canlı skor/fikstür. Oran ve şut/korner istatistikleri desteklenmediği için bu kaynakla dakika bazlı alarmlar devre dışı kalır.");
  captureTrackedMatches().catch(error => console.error("İlk otomatik kayıt başarısız:", error.message));
  scanTrackedMatchAlarms().catch(error => console.error("İlk alarm taraması başarısız:", error.message));
  const captureTimer = setInterval(() => captureTrackedMatches().catch(error => console.error("Otomatik kayıt döngüsü başarısız:", error.message)), 60_000);
  const alarmTimer = setInterval(() => scanTrackedMatchAlarms().catch(error => console.error("Alarm tarama döngüsü başarısız:", error.message)), 60_000);
  captureTimer.unref();
  alarmTimer.unref();
});
