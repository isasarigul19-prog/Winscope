import express from "express";
import pg from "pg";
import { parse } from "csv-parse/sync";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.FIVE_DOLLAR_FOOTBALL_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = "https://api.5dollarfootballapi.com/v1";
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
// Cache provider reads so page refreshes and background tasks share the same API call.
const providerCache = new Map();
const PROVIDER_CACHE_MS = { liveList: 30_000, fixture: 60_000, stats: 90_000 };
const providerInFlight = new Map();

async function cachedProviderRequest(cacheKey, pathname, ttlMs) {
  const now = Date.now();
  const cached = providerCache.get(cacheKey);
  if (cached && now - cached.at < ttlMs) return cached.payload;
  if (providerInFlight.has(cacheKey)) return providerInFlight.get(cacheKey);
  const task = footballDataRequest(pathname).then(payload => {
    providerCache.set(cacheKey, { at: Date.now(), payload });
    return payload;
  }).finally(() => providerInFlight.delete(cacheKey));
  providerInFlight.set(cacheKey, task);
  return task;
}

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

function mapProviderStatus(status) {
  const value = String(status || "").toLowerCase();
  if (/^\d{1,3}$/.test(value)) {
    const numericStatus = Number(value);
    if (numericStatus === 0) return "NS";
    return numericStatus >= 1 && numericStatus <= 150 ? "LIVE" : "NS";
  }
  if (["finished", "full", "ft", "after_extra_time", "after_penalties"].includes(value)) return "FT";
  if (["half", "halftime", "ht", "paused"].includes(value)) return "HT";
  if (["live", "in_play", "1h", "2h", "extra_time", "penalties"].includes(value)) return "LIVE";
  if (["scheduled", "not_started", "ns", "upcoming"].includes(value)) return "NS";
  if (value.includes("postpon")) return "PST";
  if (value.includes("cancel")) return "CANC";
  return String(status || "NS").toUpperCase();
}

function providerMinute(match) {
  const raw = match?.status_code ?? match?.minute ?? match?.elapsed ?? null;
  const n = Number(raw);
  if (raw != null && String(raw).trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 150) return n;
  const status = String(raw || match?.status || "").toLowerCase();
  if (["half", "halftime", "ht"].includes(status)) return 45;
  return null;
}

function normalizeProviderMatch(match) {
  return {
    id: Number(match.id),
    league: match.league?.name || "Bilinmeyen lig",
    country: match.country?.name || match.league?.country || "",
    minute: providerMinute(match),
    status: mapProviderStatus(match.status_code ?? match.status),
    home: match.teams?.home?.name || "Ev sahibi",
    away: match.teams?.away?.name || "Deplasman",
    homeScore: match.goals?.home ?? null,
    awayScore: match.goals?.away ?? null,
    homeId: match.teams?.home?.id ?? null,
    awayId: match.teams?.away?.id ?? null,
    fixtureDate: match.kickoff_utc || null
  };
}

async function footballDataRequest(pathname) {
  if (!API_KEY) throw new Error("FIVE_DOLLAR_FOOTBALL_API_KEY ayarlanmamış.");
  const response = await fetch(`${BASE_URL}${pathname}`, {
    headers: { Authorization: `Bearer ${API_KEY}`, Accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`5DollarFootballAPI geçerli JSON döndürmedi (HTTP ${response.status}).`); }
  if (!response.ok || payload.success === 0) {
    const rawDetail = payload.message ?? payload.error ?? payload.detail ?? payload.errors ?? `HTTP ${response.status}`;
    const detail = typeof rawDetail === "string" ? rawDetail : JSON.stringify(rawDetail);
    throw new Error(`5DollarFootballAPI isteği başarısız (HTTP ${response.status}): ${detail}`);
  }
  return payload;
}

function toLegacyFixture(match) {
  return {
    fixture: { id: Number(match.id), date: match.kickoff_utc || null,
      status: { short: mapProviderStatus(match.status_code ?? match.status), elapsed: providerMinute(match) } },
    league: { name: match.league?.name || "Bilinmeyen lig", country: match.country?.name || match.league?.country || "" },
    teams: { home: { id: match.teams?.home?.id ?? null, name: match.teams?.home?.name || "Ev sahibi" },
      away: { id: match.teams?.away?.id ?? null, name: match.teams?.away?.name || "Deplasman" } },
    goals: { home: match.goals?.home ?? null, away: match.goals?.away ?? null },
    corners: match.corners || null,
    raw: match
  };
}

function normalizeProviderStats(payload, fixture) {
  const root = payload?.data || payload;
  const stats = root?.statistics || root?.stats || {};
  const homeName = fixture?.teams?.home?.name || "Ev sahibi";
  const awayName = fixture?.teams?.away?.name || "Deplasman";
  const pick = (key, side) => stats?.[key]?.[side] ?? stats?.[key === "shots_on_target" ? "shotsOnTarget" : key]?.[side] ?? null;
  const homeCorners = fixture?.corners?.home ?? stats?.corners?.home ?? null;
  const awayCorners = fixture?.corners?.away ?? stats?.corners?.away ?? null;
  const homeShotsOn = pick("shots_on_target", "home");
  const awayShotsOn = pick("shots_on_target", "away");
  const homeShotsOff = pick("shots_off_target", "home");
  const awayShotsOff = pick("shots_off_target", "away");
  const homeStats = { "Total Shots": homeShotsOn != null && homeShotsOff != null ? Number(homeShotsOn) + Number(homeShotsOff) : null,
    "Shots on Goal": homeShotsOn, "Corner Kicks": homeCorners,
    "Dangerous Attacks": stats?.dangerous_attacks?.home ?? null,
    "Shots off Goal": homeShotsOff, "Ball Possession": stats?.possession?.home ?? null };
  const awayStats = { "Total Shots": awayShotsOn != null && awayShotsOff != null ? Number(awayShotsOn) + Number(awayShotsOff) : null,
    "Shots on Goal": awayShotsOn, "Corner Kicks": awayCorners,
    "Dangerous Attacks": stats?.dangerous_attacks?.away ?? null,
    "Shots off Goal": awayShotsOff, "Ball Possession": stats?.possession?.away ?? null };
  return [ { team: homeName, statistics: homeStats }, { team: awayName, statistics: awayStats } ];
}

// Keep the legacy internal shape so existing WinScope routes and frontend remain compatible.
async function apiGet(pathname) {
  if (pathname.startsWith("/odds")) return [];
  if (pathname.startsWith("/fixtures/statistics")) {
    const id = new URLSearchParams(pathname.split("?")[1] || "").get("fixture");
    if (!id) return [];
    const fixturePayload = await cachedProviderRequest(`fixture:${id}`, `/fixtures/${encodeURIComponent(id)}`, PROVIDER_CACHE_MS.fixture);
    const fixture = toLegacyFixture(fixturePayload.data || fixturePayload);
    const statPayload = await cachedProviderRequest(`stats:${id}`, `/fixtures/${encodeURIComponent(id)}/statistics`, PROVIDER_CACHE_MS.stats);
    return normalizeProviderStats(statPayload, fixture);
  }
  if (pathname.startsWith("/fixtures?live=all")) {
    const payload = await cachedProviderRequest("liveList", "/fixtures?status=live&per_page=100", PROVIDER_CACHE_MS.liveList);
    return (payload.data || []).map(toLegacyFixture);
  }
  const idMatch = pathname.match(/^\/fixtures\?id=(\d+)/);
  if (idMatch) {
    const payload = await cachedProviderRequest(`fixture:${idMatch[1]}`, `/fixtures/${idMatch[1]}`, PROVIDER_CACHE_MS.fixture);
    const match = payload.data || payload;
    return match?.id ? [toLegacyFixture(match)] : [];
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
    // Free keys can request Bet365 odds per fixture. Do not request the paid-only
    // include=odds fixture-list expansion.
    const payload = await cachedProviderRequest(`odds:${mode}:${fixtureId}`, `/fixtures/${encodeURIComponent(String(fixtureId))}/odds?bookmakers=bet365`, CACHE_MS[mode]);
    const dataBlock = payload.data || {};
    const bookmakers = Array.isArray(dataBlock.bookmakers) ? dataBlock.bookmakers
      : Array.isArray(dataBlock) ? dataBlock.flatMap(item => Array.isArray(item.bookmakers) ? item.bookmakers : [])
      : [];
    const markets = [];
    const stage = mode === "live" ? "inplay" : "closing";

    function addValues(bookmaker, marketName, quote, stageName) {
      if (!quote || typeof quote !== "object" || Array.isArray(quote)) return;
      const line = quote.line;
      for (const [selection, rawOdd] of Object.entries(quote)) {
        if (selection === "line") continue;
        const odd = toNumber(rawOdd);
        if (odd == null || odd <= 1) continue;
        markets.push({
          bookmaker: bookmaker.name || "Bet365",
          market: `${marketName}${line != null ? ` (${line})` : ""} · ${stageName}`,
          selection: selection === "yes" ? "KG Var" : selection === "no" ? "KG Yok" : selection,
          odd, suspended: false, betId: marketName, stage: stageName, line: line ?? null
        });
      }
    }

    for (const bookmaker of bookmakers) {
      const odds = bookmaker.odds && typeof bookmaker.odds === "object" ? bookmaker.odds : {};
      for (const [marketName, marketValue] of Object.entries(odds)) {
        if (Array.isArray(marketValue)) {
          for (const item of marketValue) {
            const quote = item?.[stage] || (mode === "prematch" ? item?.opening : null);
            addValues(bookmaker, `${marketName} ${item?.line ?? ""}`.trim(), quote, quote === item?.opening ? "Açılış" : stage === "inplay" ? "Canlı" : "Kapanış");
          }
          continue;
        }
        if (!marketValue || typeof marketValue !== "object") continue;
        let quote = marketValue[stage];
        let stageName = stage === "inplay" ? "Canlı" : "Kapanış";
        if (!quote && mode === "prematch") {
          quote = marketValue.closing || marketValue.opening;
          stageName = marketValue.closing ? "Kapanış" : "Açılış";
        }
        // Some simple line markets are represented as a number at each stage.
        if (typeof quote === "number") {
          markets.push({ bookmaker: bookmaker.name || "Bet365", market: marketName, selection: "Çizgi", odd: quote, suspended: false, betId: marketName, stage: stageName });
        } else addValues(bookmaker, marketName, quote, stageName);
      }
    }

    const fetchedAt = new Date().toISOString();
    const data = {
      fixtureId: Number(fixtureId), mode, source: "5DollarFootballAPI · Bet365", fetchedAt,
      available: markets.length > 0, markets,
      note: markets.length ? "Oranlar Bet365 verisinden alındı; çizgi ve fiyatlar mevcut veri kapsamına bağlıdır." : "Bu maç/market için seçilen aşamada oran bulunamadı."
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
        for (const market of markets) {
          try {
            const prev = await pool.query(`SELECT odd, captured_at FROM odds_snapshots
              WHERE fixture_id=$1 AND mode=$2 AND bookmaker=$3 AND market_name=$4 AND selection=$5
                AND captured_at < $6::timestamptz ORDER BY captured_at DESC LIMIT 1`,
              [fixtureId, mode, market.bookmaker, market.market, market.selection, fetchedAt]);
            if (prev.rows.length) {
              market.previousOdd = Number(prev.rows[0].odd);
              market.change = Number((market.odd - market.previousOdd).toFixed(3));
              market.direction = market.change < 0 ? "DÜŞTÜ" : market.change > 0 ? "YÜKSELDİ" : "SABİT";
              market.previousCapturedAt = prev.rows[0].captured_at;
            } else { market.previousOdd = null; market.change = null; market.direction = "İLK KAYIT"; }
          } catch (error) { console.error("Odds movement query error:", error.message); }
        }
      } catch (error) { console.error("Odds snapshot save error:", error.message); data.saveWarning = "Oran geldi ancak geçmiş kaydı yapılamadı."; }
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
  const teams = rows.map(row => ({ team: typeof row.team === "string" ? row.team : (row.team?.name || "Bilinmiyor"), statistics: Array.isArray(row.statistics) ? Object.fromEntries(row.statistics.map(stat => [stat.type, stat.value])) : (row.statistics && typeof row.statistics === "object" ? row.statistics : {}) }));
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
        const teams = statRows.map(row => ({ team: typeof row.team === "string" ? row.team : (row.team?.name || "Bilinmiyor"), statistics: Array.isArray(row.statistics) ? Object.fromEntries(row.statistics.map(stat => [stat.type, stat.value])) : (row.statistics && typeof row.statistics === "object" ? row.statistics : {}) }));
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

app.get("/api/health", (_req, res) => res.json({
  ok: true, service: "WinScope Live", databaseConfigured: Boolean(pool), apiKeyConfigured: Boolean(API_KEY),
  dataSource: "5DollarFootballAPI", flashscoreDirectFeed: false,
  note: "Flashscore için doğrulanmış, kararlı bir herkese açık oran API'si bu dosyada yapılandırılmadı. Sağlayıcıdan gelmeyen oran/istatistikler uydurulmaz."
}));

app.get("/api/fixtures", async (req, res) => {
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Geçerli bir tarih gerekli: YYYY-MM-DD." });
  try {
    const start = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
    const end = start + 86400;
    const payload = await cachedProviderRequest(`fixtures:${date}`, `/fixtures?start_time=${start}&end_time=${end}&per_page=100`, 5 * 60_000);
    const matches = (payload.data || []).map(normalizeProviderMatch);
    res.json({ source: "5DollarFootballAPI", fetchedAt: new Date().toISOString(), results: matches.length, matches,
      note: "Fikstürler 5DollarFootballAPI üzerinden alınır. Oranlar yalnızca desteklenen endpoint ve kapsamda sunulur." });
  } catch (error) {
    console.error("Fixture API error:", error.message);
    res.status(502).json({ error: "Maç bülteni alınamadı.", detail: error.message });
  }
});

app.get("/api/live", async (_req, res) => {
  try {
    // 5DollarFootballAPI uses status=live; do not call the old API-Football helper here.
    const payload = await cachedProviderRequest("liveList", "/fixtures?status=live&per_page=100", PROVIDER_CACHE_MS.liveList);
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const matches = rows.map(normalizeProviderMatch);
    res.json({
      source: "5DollarFootballAPI",
      fetchedAt: new Date().toISOString(),
      results: matches.length,
      matches,
      note: "Canlı maçlar 5DollarFootballAPI üzerinden alındı. İstatistikler ve oranlar sağlayıcının maç kapsamına bağlıdır."
    });
  } catch (error) {
    console.error("Live API error:", error.stack || error.message || error);
    res.status(502).json({ error: "Canlı maçlar alınamadı.", detail: error.message || String(error) });
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
    const teams = rows.map(row => ({ team: typeof row.team === "string" ? row.team : (row.team?.name || "Bilinmiyor"), statistics: Array.isArray(row.statistics) ? Object.fromEntries(row.statistics.map(stat => [stat.type, stat.value])) : (row.statistics && typeof row.statistics === "object" ? row.statistics : {}) }));
    let saved = false;
    if (pool && teams.length) {
      try { await initDatabase(); await pool.query("INSERT INTO match_stat_snapshots (fixture_id, teams) VALUES ($1, $2::jsonb)", [fixtureId, JSON.stringify(teams)]); saved = true; }
      catch (error) { console.error("Snapshot save error:", error.message); }
    }
    res.json({ source: "5DollarFootballAPI", fixtureId: Number(fixtureId), available: teams.length > 0, saved, teams });
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

// WinScope match-analysis endpoint: evidence-based, conservative, no invented scorelines.
app.get("/api/match/:id/analyze", async (req, res) => {
  const fixtureId = req.params.id;
  const mode = req.query.mode === "live" ? "live" : "prematch";
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  try {
    const fixtures = await apiGet(`/fixtures?id=${encodeURIComponent(fixtureId)}`);
    if (!fixtures.length) return res.status(404).json({ error: "Maç sağlayıcıda bulunamadı; tahmin üretilmedi." });
    const fixture = fixtures[0];
    const home = fixture.teams?.home?.name || "Ev sahibi";
    const away = fixture.teams?.away?.name || "Deplasman";
    let statRows = [];
    let statsError = null;
    try { statRows = await apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(fixtureId)}`); }
    catch (error) { statsError = error.message; }
    const teams = (statRows || []).map(row => ({
      team: typeof row.team === "string" ? row.team : (row.team?.name || "Bilinmiyor"),
      statistics: Array.isArray(row.statistics) ? Object.fromEntries(row.statistics.map(stat => [stat.type, stat.value])) : (row.statistics && typeof row.statistics === "object" ? row.statistics : {})
    }));
    let oddsData = { markets: [], note: "Oran verisi alınamadı." };
    try { oddsData = await getOdds(fixtureId, mode); }
    catch (error) { oddsData = { markets: [], note: error.message }; }

    const markets = Array.isArray(oddsData.markets) ? oddsData.markets : [];
    const norm = value => String(value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[._-]+/g, " ");
    const findOdd = (marketPatterns, selectionPatterns) => markets.find(m => {
      const market = norm(m.market), selection = norm(m.selection);
      const marketOk = marketPatterns.some(pattern => pattern.test(market));
      const selectionOk = !selectionPatterns || selectionPatterns.some(pattern => pattern.test(selection));
      return marketOk && selectionOk && Number(m.odd) > 1;
    });
    const over25 = findOdd([/over.*2\.?\s*5|2\.?\s*5.*over|total goals.*2\.?\s*5|goals over/], [/over|ust/]);
    const under25 = findOdd([/under.*2\.?\s*5|2\.?\s*5.*under|total goals.*2\.?\s*5|goals under/], [/under|alt/]);
    const bttsYes = findOdd([/both teams to score|both.*score|btts|kg/], [/yes|var/]);
    const bttsNo = findOdd([/both teams to score|both.*score|btts|kg/], [/no|yok/]);
    const homeWin = findOdd([/^1x2|match result|full time result|winner|1 x 2/], [/^home$|^1$|home win|ev sahibi/]);
    const drawWin = findOdd([/^1x2|match result|full time result|winner|1 x 2/], [/^draw$|^x$|beraberlik|tie/]);
    const awayWin = findOdd([/^1x2|match result|full time result|winner|1 x 2/], [/^away$|^2$|away win|deplasman/]);
    const htHome = findOdd([/half time result|half time 1x2|1st half result|1st half 1x2|ht result/], [/^home$|^1$|home win|ev sahibi/]);
    const htDraw = findOdd([/half time result|half time 1x2|1st half result|1st half 1x2|ht result/], [/^draw$|^x$|beraberlik|tie/]);
    const htAway = findOdd([/half time result|half time 1x2|1st half result|1st half 1x2|ht result/], [/^away$|^2$|away win|deplasman/]);
    const exactScoreMarkets = markets.filter(m => /correct score|exact score|doğru skor/.test(norm(m.market)));
    const pressure = teams.length >= 2 ? assessGoalPressure(teams) : { ok: false, reason: "Maç istatistikleri henüz mevcut değil." };
    const scoreHome = fixture.goals?.home, scoreAway = fixture.goals?.away;
    const status = fixture.fixture?.status?.short || "";
    const elapsedValue = fixture.fixture?.status?.elapsed;
    const isLive = ["LIVE", "HT", "1H", "2H"].includes(String(status).toUpperCase()) || (elapsedValue != null && Number.isFinite(Number(elapsedValue)));
    const reasons = [];
    if (pressure.ok) reasons.push(`Şut ${pressure.totalShots}, kaleyi bulan şut ${pressure.totalOnTarget}, korner ${pressure.totalCorners}.`);
    else reasons.push(pressure.reason);
    if (markets.length) reasons.push(`Sağlayıcıdan ${markets.length} oran kaydı bulundu (${mode === "live" ? "canlı" : "maç önü"}).`);
    else reasons.push("İstenen piyasa için kullanılabilir oran bulunamadı.");

    let mainPick = "";
    let alternative = "";
    let marketDirection = "Belirsiz / veri yetersiz";
    let confidence = "Düşük";
    let halfTimeScore = "";
    let fullTimeScore = "";
    let surprise = "";
    const overP = over25 && Number(over25.odd);
    const underP = under25 && Number(under25.odd);
    const bttsP = bttsYes && Number(bttsYes.odd);
    const bttsNoP = bttsNo && Number(bttsNo.odd);
    if (over25?.direction || under25?.direction || homeWin?.direction || drawWin?.direction || awayWin?.direction) {
      marketDirection = [homeWin, drawWin, awayWin, over25, under25].filter(x => x?.direction).map(x => x.direction).join(" · ");
    } else if (markets.length) marketDirection = "İlk kayıt / hareket henüz ölçülemedi";

    // Choose the strongest available 1X2 market when all three outcomes are present.
    // Never invent a pick if the provider has not supplied the required market.
    const outcomeQuotes = [
      { key: "home", odd: homeWin && Number(homeWin.odd), label: "MS 1" },
      { key: "draw", odd: drawWin && Number(drawWin.odd), label: "MS X" },
      { key: "away", odd: awayWin && Number(awayWin.odd), label: "MS 2" }
    ].filter(x => Number.isFinite(x.odd) && x.odd > 1);
    const hasAllOutcomes = outcomeQuotes.length === 3;
    const favoriteOutcome = hasAllOutcomes ? [...outcomeQuotes].sort((a,b)=>a.odd-b.odd)[0] : null;
    const totalGoalsNow = Number(scoreHome ?? 0) + Number(scoreAway ?? 0);
    const drawMarketSupported = Boolean(favoriteOutcome?.key === "draw");
    const lowGoalLean = Boolean(underP && overP && underP < overP);
    const highGoalLean = Boolean(overP && underP && overP < underP);

    if (favoriteOutcome && (isLive ? pressure.ok || totalGoalsNow > 0 : true)) {
      mainPick = favoriteOutcome.label;
      confidence = "Orta — oran sinyali, garanti değil";
      if (favoriteOutcome.key === "draw") {
        fullTimeScore = lowGoalLean ? "0-0 (skor senaryosu)" : "1-1 (skor senaryosu)";
        surprise = htDraw && drawWin && Number(htDraw.odd) < 3.2 ? "X/X" : "";
        reasons.push("1X2 piyasasında beraberlik en düşük oranlı sonuç; bu tek başına kesin skor kanıtı değildir.");
      } else if (favoriteOutcome.key === "home") {
        fullTimeScore = lowGoalLean ? "1-0 (skor senaryosu)" : highGoalLean ? "2-1 (skor senaryosu)" : "1-0 (temkinli skor senaryosu)";
        surprise = htHome && homeWin && Number(htHome.odd) < 3.2 ? "1/1" : "";
        reasons.push("1X2 piyasasında ev sahibi sonucu öne çıkıyor; skor yalnızca senaryo tahminidir.");
      } else {
        fullTimeScore = lowGoalLean ? "0-1 (skor senaryosu)" : highGoalLean ? "1-2 (skor senaryosu)" : "0-1 (temkinli skor senaryosu)";
        surprise = htAway && awayWin && Number(htAway.odd) < 3.2 ? "2/2" : "";
        reasons.push("1X2 piyasasında deplasman sonucu öne çıkıyor; skor yalnızca senaryo tahminidir.");
      }
      if (htDraw && Number(htDraw.odd) < 2.5) {
        halfTimeScore = "0-0 (İY beraberlik sinyali; skor senaryosu)";
        if (!alternative) alternative = "İY X";
      } else if (htHome && htAway && Number(htHome.odd) < Number(htAway.odd)) {
        halfTimeScore = "1-0 (İY ev sahibi senaryosu)";
        if (Number(htHome.odd) < 2.0) alternative = "İY 1";
      } else if (htHome && htAway && Number(htAway.odd) < Number(htHome.odd)) {
        halfTimeScore = "0-1 (İY deplasman senaryosu)";
        if (Number(htAway.odd) < 2.0) alternative = "İY 2";
      }
      if (drawMarketSupported && lowGoalLean && htDraw && Number(htDraw.odd) < 2.5) {
        fullTimeScore = "0-0 (skor senaryosu)";
        surprise = "X/X";
      }
    } else if (isLive && pressure.ok && overP && overP <= 2.05 && totalGoalsNow < 3) {
      mainPick = "MS 2.5 ÜST";
      confidence = "Düşük-Orta — canlı baskı ve oran sinyali";
      if (bttsP && bttsP <= 1.85) alternative = "KG VAR";
      fullTimeScore = "Skor senaryosu için yeterli piyasa doğrulaması yok";
      reasons.push("Canlı baskı ve mevcut 2.5 Üst oranı aynı yönde.");
    } else if (!isLive && overP && underP && Math.abs(overP - underP) >= 0.35) {
      if (overP < underP && overP <= 1.75) { mainPick = "MS 2.5 ÜST"; alternative = bttsP && bttsP <= 1.85 ? "KG VAR" : ""; confidence = "Düşük-Orta"; }
      else if (underP < overP && underP <= 1.75) { mainPick = "MS 2.5 ALT"; alternative = bttsNoP && bttsNoP <= 1.85 ? "KG YOK" : ""; confidence = "Düşük-Orta"; }
      reasons.push("2.5 gol piyasası değerlendirildi; skor seçimi için ek sinyal gerekir.");
    } else {
      mainPick = "Yeterli veri yok";
      reasons.push("1X2 veya gol piyasasında güvenilir, uyumlu bir yön belirlenemedi; tahmin uydurulmadı.");
    }

    // If exact-score markets exist, only report a score actually present in the provider data.
    if (exactScoreMarkets.length) {
      const bestExact = [...exactScoreMarkets].sort((a,b)=>Number(a.odd)-Number(b.odd))[0];
      if (bestExact?.selection) fullTimeScore = `${bestExact.selection} (sağlayıcı doğru skor marketi)`;
    }
    if (!halfTimeScore) halfTimeScore = htDraw && Number(htDraw.odd) < 2.5 ? "0-0 (İY skor senaryosu)" : "Veri destekli İY skor senaryosu yok";
    if (!fullTimeScore) fullTimeScore = "Veri destekli MS skor senaryosu yok";
    if (!alternative) alternative = "";
    if (!surprise) surprise = "";
    if (bttsP && bttsNoP && Math.abs(bttsP - bttsNoP) < 0.25 && mainPick && mainPick !== "Yeterli veri yok" && !["MS X","MS 1","MS 2"].includes(mainPick)) {
      alternative = "";
      reasons.push("KG Var/Yok sinyali ayrışmıyor; alternatif verilmedi.");
    }
    const exactScore = exactScoreMarkets.length > 0;

    // Historical similarity engine: scan every imported historical row, rank by the
    // odds markets available for BOTH the current fixture and the historical row,
    // then derive result/score tendencies from the nearest comparable matches.
    let historicalAnalysis = {
      available: false, scannedMatches: 0, sampleSize: 0, matchedMarkets: [],
      mainPick: null, alternative: null, halfTimeScore: null, fullTimeScore: null,
      surprise: null, note: "Tarihsel veri tabanı henüz taranamadı."
    };
    if (pool) {
      try {
        await initDatabase();
        const histResult = await pool.query(`SELECT id, league_code, match_date, home_team, away_team,
          ht_home_goals, ht_away_goals, ft_home_goals, ft_away_goals, full_time_result,
          b365_home, b365_draw, b365_away, b365_over25, b365_under25, total_goals, over25_result
          FROM historical_matches
          WHERE (b365_home IS NOT NULL OR b365_draw IS NOT NULL OR b365_away IS NOT NULL
            OR b365_over25 IS NOT NULL OR b365_under25 IS NOT NULL)
            AND (full_time_result IS NOT NULL OR (ft_home_goals IS NOT NULL AND ft_away_goals IS NOT NULL))`);
        const allRows = histResult.rows;
        const dimensions = [
          { key: "MS 1", current: homeWin ? Number(homeWin.odd) : null, field: "b365_home" },
          { key: "MS X", current: drawWin ? Number(drawWin.odd) : null, field: "b365_draw" },
          { key: "MS 2", current: awayWin ? Number(awayWin.odd) : null, field: "b365_away" },
          { key: "MS 2.5 ÜST", current: over25 ? Number(over25.odd) : null, field: "b365_over25" },
          { key: "MS 2.5 ALT", current: under25 ? Number(under25.odd) : null, field: "b365_under25" }
        ].filter(d => Number.isFinite(d.current) && d.current > 1);
        const ranked = allRows.map(row => {
          const distances = dimensions.filter(d => row[d.field] != null && Number(row[d.field]) > 1).map(d => {
            const historicalOdd = Number(row[d.field]);
            // Relative distance prevents the same absolute error being treated equally at every price.
            return Math.abs(d.current - historicalOdd) / Math.max(0.15, d.current * 0.12);
          });
          return { row, dimensionsMatched: distances.length, distance: distances.length ? distances.reduce((a,b)=>a+b,0)/distances.length : Infinity };
        }).filter(x => x.dimensionsMatched >= Math.min(2, dimensions.length) && Number.isFinite(x.distance))
          .sort((a,b) => a.distance-b.distance || (new Date(b.row.match_date||0)-new Date(a.row.match_date||0)));
        // A close-match threshold first; if too few exist, use the closest rows but label that fact.
        let closeRows = ranked.filter(x => x.distance <= 2.5).slice(0, 100);
        const expanded = closeRows.length < 10;
        if (expanded) closeRows = ranked.slice(0, Math.min(100, ranked.length));
        const sample = closeRows.map(x => x.row);
        const countBy = (items, getKey) => {
          const counts = new Map();
          for (const item of items) { const key=getKey(item); if (key) counts.set(key,(counts.get(key)||0)+1); }
          return [...counts.entries()].sort((a,b)=>b[1]-a[1]);
        };
        const resultCounts = countBy(sample, r => {
          const raw = String(r.full_time_result||"").toUpperCase();
          if (["H","1","HOME"].includes(raw)) return "MS 1";
          if (["D","X","DRAW"].includes(raw)) return "MS X";
          if (["A","2","AWAY"].includes(raw)) return "MS 2";
          if (r.ft_home_goals != null && r.ft_away_goals != null) return Number(r.ft_home_goals)>Number(r.ft_away_goals)?"MS 1":Number(r.ft_home_goals)<Number(r.ft_away_goals)?"MS 2":"MS X";
          return null;
        });
        const htScores = countBy(sample, r => r.ht_home_goals != null && r.ht_away_goals != null ? `${r.ht_home_goals}-${r.ht_away_goals}` : null);
        const ftScores = countBy(sample, r => r.ft_home_goals != null && r.ft_away_goals != null ? `${r.ft_home_goals}-${r.ft_away_goals}` : null);
        const htft = countBy(sample, r => {
          if ([r.ht_home_goals,r.ht_away_goals,r.ft_home_goals,r.ft_away_goals].some(v=>v==null)) return null;
          const ht=Number(r.ht_home_goals)>Number(r.ht_away_goals)?"1":Number(r.ht_home_goals)<Number(r.ht_away_goals)?"2":"X";
          const ft=Number(r.ft_home_goals)>Number(r.ft_away_goals)?"1":Number(r.ft_home_goals)<Number(r.ft_away_goals)?"2":"X";
          return `${ht}/${ft}`;
        });
        const goalsRows = sample.filter(r=>r.ft_home_goals!=null && r.ft_away_goals!=null);
        const overCount = goalsRows.filter(r=>Number(r.ft_home_goals)+Number(r.ft_away_goals)>=3).length;
        const underCount = goalsRows.length-overCount;
        const yesCount = goalsRows.filter(r=>Number(r.ft_home_goals)>0 && Number(r.ft_away_goals)>0).length;
        const noCount = goalsRows.length-yesCount;
        const topResult = resultCounts[0], secondResult = resultCounts[1];
        const topPct = topResult && sample.length ? topResult[1]/sample.length*100 : 0;
        const secondPct = secondResult && sample.length ? secondResult[1]/sample.length*100 : 0;
        let historicalMain = null, historicalAlt = null;
        if (sample.length >= 20 && topResult && topPct >= 40 && topPct-secondPct >= 8) {
          historicalMain = topResult[0];
          if (secondResult && secondPct >= 25) historicalAlt = secondResult[0];
        } else if (sample.length >= 20 && goalsRows.length >= 20) {
          const overPct = overCount/goalsRows.length*100, underPct=underCount/goalsRows.length*100;
          if (Math.max(overPct,underPct) >= 62) historicalMain = overPct>underPct ? "MS 2.5 ÜST" : "MS 2.5 ALT";
          const yesPct=yesCount/goalsRows.length*100, noPct=noCount/goalsRows.length*100;
          if (!historicalMain && Math.max(yesPct,noPct) >= 65) historicalMain = yesPct>noPct ? "KG VAR" : "KG YOK";
        }
        const validHt = sample.filter(r=>r.ht_home_goals!=null && r.ht_away_goals!=null).length;
        const validFt = sample.filter(r=>r.ft_home_goals!=null && r.ft_away_goals!=null).length;
        const htTop = htScores[0], ftTop = ftScores[0], htftTop = htft[0];
        historicalAnalysis = {
          available: sample.length > 0, scannedMatches: allRows.length, sampleSize: sample.length,
          closeMatches: expanded ? "Yakın eşleşme az olduğu için en yakın kayıtlar kullanıldı" : "Oran benzerliği eşiğini karşılayan kayıtlar",
          matchedMarkets: dimensions.map(d=>d.key), averageDistance: sample.length ? Number((sample.reduce((sum,r)=>sum+(ranked.find(x=>x.row.id===r.id)?.distance||0),0)/sample.length).toFixed(3)) : null,
          resultDistribution: Object.fromEntries(resultCounts.map(([k,v])=>[k,{count:v,percent:Number((v/sample.length*100).toFixed(1))}])),
          over25Percent: goalsRows.length ? Number((overCount/goalsRows.length*100).toFixed(1)) : null,
          under25Percent: goalsRows.length ? Number((underCount/goalsRows.length*100).toFixed(1)) : null,
          bttsYesPercent: goalsRows.length ? Number((yesCount/goalsRows.length*100).toFixed(1)) : null,
          bttsNoPercent: goalsRows.length ? Number((noCount/goalsRows.length*100).toFixed(1)) : null,
          mostCommonHalfTimeScore: htTop ? {score:htTop[0],count:htTop[1],percent:Number((htTop[1]/validHt*100).toFixed(1))} : null,
          mostCommonFullTimeScore: ftTop ? {score:ftTop[0],count:ftTop[1],percent:Number((ftTop[1]/validFt*100).toFixed(1))} : null,
          mostCommonHalfTimeFullTime: htftTop ? {result:htftTop[0],count:htftTop[1],percent:Number((htftTop[1]/sample.length*100).toFixed(1))} : null,
          mainPick: historicalMain, alternative: historicalAlt,
          note: expanded ? "Yeterince yakın oran eşleşmesi bulunamadı; gösterilen sonuçlar en yakın geçmiş kayıtların keşif amaçlı dağılımıdır." : "Sonuçlar güncel oranlarla en yakın tarihsel oran kayıtlarının karşılaştırılmasından hesaplandı. Garanti değildir."
        };
        reasons.push(`Tarihsel motor ${allRows.length} maçın tamamını taradı; ${sample.length} en yakın eşleşmeyi analiz etti.`);
        if (historicalMain) {
          mainPick = historicalMain;
          alternative = historicalAlt || "";
          confidence = sample.length >= 50 && topPct >= 50 ? "Orta — tarihsel benzerlik" : "Düşük-Orta — tarihsel benzerlik";
        } else {
          mainPick = "Yeterli tarihsel sinyal yok";
          alternative = "";
          confidence = "Düşük — eşleşme dağılımı net değil";
        }
        if (htTop && validHt >= 20 && htTop[1]/validHt >= 0.18) halfTimeScore = `${htTop[0]} (geçmiş en sık İY skoru)`;
        else halfTimeScore = "Yeterli tarihsel İY skor desteği yok";
        if (ftTop && validFt >= 20 && ftTop[1]/validFt >= 0.12) fullTimeScore = `${ftTop[0]} (geçmiş en sık MS skoru)`;
        else fullTimeScore = "Yeterli tarihsel MS skor desteği yok";
        surprise = htftTop && sample.length >= 30 && htftTop[1]/sample.length >= 0.12 ? `${htftTop[0]} (tarihsel örneklem)` : "Veri desteği yok";
        marketDirection = [homeWin,drawWin,awayWin,over25,under25].filter(x=>x?.direction).map(x=>x.direction).join(" · ") || (markets.length ? "İlk kayıt / hareket henüz ölçülemedi" : "Oran hareketi verisi yok");
      } catch (historyError) {
        console.error("Historical similarity engine error:", historyError.message);
        historicalAnalysis.note = "Tarihsel tarama yapılamadı: " + historyError.message;
        mainPick = "Tarihsel veri okunamadı";
        alternative = "";
        halfTimeScore = "Tarihsel veri yok";
        fullTimeScore = "Tarihsel veri yok";
        surprise = "Veri desteği yok";
        confidence = "Düşük — geçmiş veri okunamadı";
      }
    } else {
      mainPick = "Tarihsel veri tabanı bağlı değil";
      alternative = "";
      halfTimeScore = "Tarihsel veri yok";
      fullTimeScore = "Tarihsel veri yok";
      surprise = "Veri desteği yok";
      confidence = "Düşük — geçmiş veri tabanı bağlı değil";
      historicalAnalysis.note = "DATABASE_URL yapılandırılmadığı için tarihsel karşılaştırma yapılamadı.";
    }
    res.json({
      fixtureId: Number(fixtureId), match: `${home} VS ${away}`, home, away, mode,
      source: "5DollarFootballAPI · mevcut oranlar ve istatistikler", fetchedAt: new Date().toISOString(),
      currentScore: scoreHome == null || scoreAway == null ? null : `${scoreHome}-${scoreAway}`,
      minute: fixture.fixture?.status?.elapsed ?? null, mainPick, alternative,
      halfTimeScore, fullTimeScore, surprise,
      marketDirection, confidence, statsAvailable: teams.length > 0, stats: teams,
      oddsCount: markets.length, history: historicalAnalysis,
      reasons, providerNote: oddsData.note || null, statsWarning: statsError,
      note: "Analiz güncel oranlarla eşleşen tarihsel sonuç dağılımından oluşturulur. Skor senaryoları geçmiş örneklem özetidir; garanti değildir."
    });
  } catch (error) {
    console.error("Match analysis error:", error.stack || error.message);
    res.status(502).json({ error: "Maç analiz edilemedi; veri alınamadı.", detail: error.message });
  }
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
    res.json({ enabled: true, intervalSeconds: 600, running: autoCaptureRunning, trackedMatches: result.rows[0].tracked_matches, maxTrackedMatches: 2,
      note: "İstatistikler sunucu çalışırken yaklaşık 10 dakikada bir denenir. Sağlayıcı cevapları önbelleğe alınır; oranlar yalnızca istendiğinde yenilenir." });
  } catch (error) { console.error("Auto-capture status error:", error.message); res.status(503).json({ enabled: false, error: "Otomatik kayıt durumu alınamadı." }); }
});

app.listen(PORT, () => {
  console.log(`WinScope Live running on port ${PORT}`);
  console.log("Veri kaynağı: 5DollarFootballAPI. Canlı oranlar ve istatistikler sağlayıcının bu maç/market için gerçekten döndürdüğü alanlarla sınırlıdır; eksik veriler tahmin edilmez.");
  captureTrackedMatches().catch(error => console.error("İlk otomatik kayıt başarısız:", error.message));
  scanTrackedMatchAlarms().catch(error => console.error("İlk alarm taraması başarısız:", error.message));
  // The free provider quota is limited. Poll background jobs every 10 minutes rather than every minute.
  const captureTimer = setInterval(() => captureTrackedMatches().catch(error => console.error("Otomatik kayıt döngüsü başarısız:", error.message)), 10 * 60_000);
  const alarmTimer = setInterval(() => scanTrackedMatchAlarms().catch(error => console.error("Alarm tarama döngüsü başarısız:", error.message)), 10 * 60_000);
  captureTimer.unref();
  alarmTimer.unref();
});
