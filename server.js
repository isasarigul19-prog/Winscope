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
// Quota-aware cache: reuse recent data and retain stale successful responses during provider outages.
const oddsCache = new Map();
const oddsInFlight = new Map();
const CACHE_MS = { live: 5 * 60_000, prematch: 3 * 60 * 60 * 1000 };
const providerCache = new Map();
// Keep list/fixture/stat data longer to stay below the provider's 60 requests/hour limit.
const PROVIDER_CACHE_MS = { liveList: 5 * 60_000, fixture: 10 * 60_000, stats: 5 * 60_000 };
const providerInFlight = new Map();
let providerRateLimitedUntil = 0;

async function cachedProviderRequest(cacheKey, pathname, ttlMs) {
  const now = Date.now();
  const cached = providerCache.get(cacheKey);
  if (cached && now - cached.at < ttlMs) return cached.payload;
  // If the provider has rate-limited us, do not keep spending requests; serve last known data.
  if (now < providerRateLimitedUntil) {
    if (cached) return cached.payload;
    throw new Error(`5DollarFootballAPI hız limiti nedeniyle geçici olarak beklemede. Yaklaşık ${Math.ceil((providerRateLimitedUntil - now) / 60000)} dakika sonra tekrar denenecek.`);
  }
  if (providerInFlight.has(cacheKey)) return providerInFlight.get(cacheKey);
  const task = footballDataRequest(pathname).then(payload => {
    providerCache.set(cacheKey, { at: Date.now(), payload });
    return payload;
  }).catch(error => {
    if (/HTTP 429|rate.limit|too_many_requests|60 requests per hour/i.test(String(error.message))) {
      // Provider quota is hourly. Pause calls for 55 minutes and use stale cache where possible.
      providerRateLimitedUntil = Date.now() + 55 * 60_000;
      if (cached) {
        console.warn(`API limit aşıldı; eski önbellek kullanılıyor (${cacheKey}).`);
        return cached.payload;
      }
    }
    throw error;
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
    if (!fixtures.length) return res.status(404).json({ error: "Maç sağlayıcıda bulunamadı; analiz üretilmedi." });
    const fixture = fixtures[0];
    const home = fixture.teams?.home?.name || "Ev sahibi";
    const away = fixture.teams?.away?.name || "Deplasman";
    let statRows = [], statsWarning = null;
    try { statRows = await apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(fixtureId)}`); }
    catch (e) { statsWarning = e.message; }
    const teams = (statRows || []).map(row => ({
      team: typeof row.team === "string" ? row.team : (row.team?.name || "Bilinmiyor"),
      statistics: Array.isArray(row.statistics) ? Object.fromEntries(row.statistics.map(s => [s.type, s.value])) : (row.statistics || {})
    }));
    let oddsData = { markets: [], note: "Oran verisi alınamadı." };
    try { oddsData = await getOdds(fixtureId, mode); } catch (e) { oddsData.note = e.message; }
    const markets = Array.isArray(oddsData.markets) ? oddsData.markets : [];
    const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[._-]+/g, " ");
    const find = (marketRe, selectionRe) => markets.find(m => marketRe.test(norm(m.market)) && selectionRe.test(norm(m.selection)) && Number(m.odd) > 1);
    const over25 = find(/over.*2\.?\s*5|2\.?\s*5.*over|goals over|total goals/, /over|ust/);
    const under25 = find(/under.*2\.?\s*5|2\.?\s*5.*under|goals under|total goals/, /under|alt/);
    const kgYes = find(/both teams|btts|kg/, /yes|var/);
    const kgNo = find(/both teams|btts|kg/, /no|yok/);
    const homeWin = find(/1x2|match result|full time result|winner/, /^home$|^1$|home win|ev sahibi/);
    const draw = find(/1x2|match result|full time result|winner/, /^draw$|^x$|beraberlik|tie/);
    const awayWin = find(/1x2|match result|full time result|winner/, /^away$|^2$|away win|deplasman/);
    const home15 = find(/home.*1\.?\s*5|team.*1\.?\s*5|ev sahibi.*1\.?\s*5/, /over|ust/);
    const away15 = find(/away.*1\.?\s*5|team.*1\.?\s*5|deplasman.*1\.?\s*5/, /over|ust/);
    const htOver05 = find(/half.*over.*0\.?\s*5|1st half.*0\.?\s*5|first half.*0\.?\s*5/, /over|ust/);
    const scoreHome = fixture.goals?.home, scoreAway = fixture.goals?.away;
    const status = String(fixture.fixture?.status?.short || "").toUpperCase();
    const elapsed = fixture.fixture?.status?.elapsed;
    const isLive = ["LIVE", "HT", "1H", "2H"].includes(status) || (elapsed != null && Number(elapsed) > 0);
    const reasons = [];
    let history = { available: false, scannedMatches: 0, sampleSize: 0, matchedMarkets: [], resultDistribution: {}, over25Percent: null, under25Percent: null, bttsYesPercent: null, bttsNoPercent: null, home15Percent: null, away15Percent: null, htOver05Percent: null, sixPlusPercent: null, note: "Tarihsel veri henüz hesaplanmadı." };
    let mainPick = "—", alternative = "", halfTimeScore = "Veri desteği yok", fullTimeScore = "Veri desteği yok", surprise = "Veri desteği yok", confidence = "Düşük", marketDirection = "Oran hareketi verisi yok";
    if (pool) {
      try {
        await initDatabase();
        const q = await pool.query(`SELECT id, ht_home_goals, ht_away_goals, ft_home_goals, ft_away_goals, full_time_result,
          b365_home,b365_draw,b365_away,b365_over25,b365_under25
          FROM historical_matches WHERE (b365_home IS NOT NULL OR b365_draw IS NOT NULL OR b365_away IS NOT NULL OR b365_over25 IS NOT NULL OR b365_under25 IS NOT NULL)
          AND (ft_home_goals IS NOT NULL AND ft_away_goals IS NOT NULL)`);
        const rows = q.rows;
        const dims = [
          {key:"MS 1",now:homeWin?.odd,field:"b365_home"},{key:"MS X",now:draw?.odd,field:"b365_draw"},{key:"MS 2",now:awayWin?.odd,field:"b365_away"},
          {key:"MS 2.5 ÜST",now:over25?.odd,field:"b365_over25"},{key:"MS 2.5 ALT",now:under25?.odd,field:"b365_under25"}
        ].filter(d => Number(d.now)>1);
        const ranked = rows.map(r => { const ds=dims.filter(d=>r[d.field]!=null&&Number(r[d.field])>1).map(d=>Math.abs(Number(d.now)-Number(r[d.field]))/Math.max(.2,Number(d.now)*.12)); return {r,n:ds.length,d:ds.length?ds.reduce((a,b)=>a+b,0)/ds.length:Infinity}; }).filter(x=>x.n>=Math.min(2,dims.length)&&Number.isFinite(x.d)).sort((a,b)=>a.d-b.d);
        let near=ranked.filter(x=>x.d<=2.5).slice(0,100); const expanded=near.length<10; if(expanded) near=ranked.slice(0,100);
        const sample=near.map(x=>x.r), valid=sample.filter(r=>r.ft_home_goals!=null&&r.ft_away_goals!=null), n=valid.length;
        const pct=(count,total)=>total?Number((100*count/total).toFixed(1)):null;
        const overN=valid.filter(r=>Number(r.ft_home_goals)+Number(r.ft_away_goals)>=3).length;
        const kgN=valid.filter(r=>Number(r.ft_home_goals)>0&&Number(r.ft_away_goals)>0).length;
        const home15N=valid.filter(r=>Number(r.ft_home_goals)>=2).length, away15N=valid.filter(r=>Number(r.ft_away_goals)>=2).length;
        const sixN=valid.filter(r=>Number(r.ft_home_goals)+Number(r.ft_away_goals)>=6).length;
        const htValid=sample.filter(r=>r.ht_home_goals!=null&&r.ht_away_goals!=null);
        const ht05N=htValid.filter(r=>Number(r.ht_home_goals)+Number(r.ht_away_goals)>=1).length;
        const freq=(arr)=>{const m=new Map();for(const x of arr){if(x)m.set(x,(m.get(x)||0)+1);}return [...m.entries()].sort((a,b)=>b[1]-a[1]);};
        const resKeys=valid.map(r=>Number(r.ft_home_goals)>Number(r.ft_away_goals)?"MS 1":Number(r.ft_home_goals)<Number(r.ft_away_goals)?"MS 2":"MS X");
        const resFreq=freq(resKeys);
        const htFreq=freq(htValid.map(r=>`${r.ht_home_goals}-${r.ht_away_goals}`));
        const ftFreq=freq(valid.map(r=>`${r.ft_home_goals}-${r.ft_away_goals}`));
        const htftFreq=freq(sample.filter(r=>[r.ht_home_goals,r.ht_away_goals,r.ft_home_goals,r.ft_away_goals].every(v=>v!=null)).map(r=>`${Number(r.ht_home_goals)>Number(r.ht_away_goals)?"1":Number(r.ht_home_goals)<Number(r.ht_away_goals)?"2":"X"}/${Number(r.ft_home_goals)>Number(r.ft_away_goals)?"1":Number(r.ft_home_goals)<Number(r.ft_away_goals)?"2":"X"}`));
        history={available:sample.length>0,scannedMatches:rows.length,sampleSize:sample.length,matchedMarkets:dims.map(d=>d.key),resultDistribution:Object.fromEntries(resFreq.map(([k,v])=>[k,{count:v,percent:pct(v,n)}])),over25Percent:pct(overN,n),under25Percent:pct(n-overN,n),bttsYesPercent:pct(kgN,n),bttsNoPercent:pct(n-kgN,n),home15Percent:pct(home15N,n),away15Percent:pct(away15N,n),htOver05Percent:pct(ht05N,htValid.length),sixPlusPercent:pct(sixN,n),mostCommonHalfTimeScore:htFreq[0]?{score:htFreq[0][0],count:htFreq[0][1],percent:pct(htFreq[0][1],htValid.length)}:null,mostCommonFullTimeScore:ftFreq[0]?{score:ftFreq[0][0],count:ftFreq[0][1],percent:pct(ftFreq[0][1],n)}:null,mostCommonHalfTimeFullTime:htftFreq[0]?{result:htftFreq[0][0],count:htftFreq[0][1],percent:pct(htftFreq[0][1],sample.length)}:null,note:expanded?"Yakın oran eşleşmesi az; en yakın 100 kayıt kullanıldı.":"Oran benzerliğine göre seçilmiş tarihsel örneklem."};
        if(history.sampleSize) reasons.push(`${rows.length} tarihsel maç tarandı; en yakın ${sample.length} maç hesaplandı.`);
      } catch(e) { history.note=`Tarihsel analiz yapılamadı: ${e.message}`; }
    } else history.note="DATABASE_URL yapılandırılmadığı için tarihsel analiz yapılamadı.";
    const p = v => Number.isFinite(Number(v)) ? Number(v) : null;
    const supported = history.sampleSize >= 20;
    const candidates=[];
    if (supported) {
      if(history.home15Percent>=65 && home15) candidates.push({pick:"EV 1.5 ÜST",pct:history.home15Percent,kind:"goals"});
      if(history.away15Percent>=65 && away15) candidates.push({pick:"DEP 1.5 ÜST",pct:history.away15Percent,kind:"goals"});
      if(history.bttsYesPercent>=65 && kgYes) candidates.push({pick:"KG VAR",pct:history.bttsYesPercent,kind:"btts"});
      if(history.bttsNoPercent>=65 && kgNo) candidates.push({pick:"KG YOK",pct:history.bttsNoPercent,kind:"btts"});
      if(history.over25Percent>=65 && over25) candidates.push({pick:"MS 2.5 ÜST",pct:history.over25Percent,kind:"goals"});
      if(history.under25Percent>=65 && under25) candidates.push({pick:"MS 2.5 ALT",pct:history.under25Percent,kind:"goals"});
    }
    candidates.sort((a,b)=>b.pct-a.pct);
    if(candidates.length){mainPick=candidates[0].pick;confidence=`${history.sampleSize>=50?"Orta":"Düşük-Orta"} — tarihsel yüzde ${candidates[0].pct}%`;}
    else if(history.sampleSize>=20 && resFreqSafe(history.resultDistribution)) { mainPick="—"; reasons.push("Tarihsel yüzdeler ile mevcut marketler birlikte yeterli destek vermiyor."); }
    const outcome=[{key:"MS 1",odd:p(homeWin?.odd)},{key:"MS X",odd:p(draw?.odd)},{key:"MS 2",odd:p(awayWin?.odd)}].filter(x=>x.odd&&x.odd>1).sort((a,b)=>a.odd-b.odd);
    const sideByScore = history.mostCommonFullTimeScore?.score || "";
    const scoreParts=sideByScore.split("-").map(Number);
    if(scoreParts.length===2 && scoreParts.every(Number.isFinite)) {
      if(scoreParts[0]===scoreParts[1] && kgYes && history.bttsYesPercent>=60) { if(mainPick==="—" && candidates.some(c=>c.pick==="KG VAR")) mainPick="KG VAR"; if(outcome.some(x=>x.key==="MS X")&&outcome[0]?.key==="MS X") alternative="MS X"; }
      else if(scoreParts[0]>0&&scoreParts[1]===0&&outcome.some(x=>x.key==="MS 1")) alternative="MS 1";
      else if(scoreParts[1]>0&&scoreParts[0]===0&&outcome.some(x=>x.key==="MS 2")) alternative="MS 2";
      else if(scoreParts[0]>scoreParts[1]&&outcome.some(x=>x.key==="MS 1")) alternative="MS 1";
      else if(scoreParts[1]>scoreParts[0]&&outcome.some(x=>x.key==="MS 2")) alternative="MS 2";
    }
    if(alternative===mainPick) alternative="";
    if(history.mostCommonHalfTimeScore && history.mostCommonHalfTimeScore.percent>=15) halfTimeScore=`${history.mostCommonHalfTimeScore.score} (${history.mostCommonHalfTimeScore.percent}%)`;
    if(history.mostCommonFullTimeScore && history.mostCommonFullTimeScore.percent>=10) fullTimeScore=`${history.mostCommonFullTimeScore.score} (${history.mostCommonFullTimeScore.percent}%)`;
    const surpriseBits=[];
    if(history.mostCommonHalfTimeFullTime && history.mostCommonHalfTimeFullTime.percent>=12) surpriseBits.push(`${history.mostCommonHalfTimeFullTime.result} İY/MS (${history.mostCommonHalfTimeFullTime.percent}%)`);
    if(history.sixPlusPercent!=null && history.sampleSize>=30 && history.sixPlusPercent>=12) surpriseBits.push(`6+ GOL (${history.sixPlusPercent}%)`);
    if(history.mostCommonFullTimeScore && history.sampleSize>=20 && history.mostCommonFullTimeScore.percent>=10 && Number(history.mostCommonFullTimeScore.score.split("-")[0])+Number(history.mostCommonFullTimeScore.score.split("-")[1])>=4) surpriseBits.push(`Yüksek skor ${history.mostCommonFullTimeScore.score}`);
    surprise=surpriseBits.join(" · ") || "Yeterli sürpriz desteği yok";
    const moves=[homeWin,draw,awayWin,over25,under25,kgYes,kgNo].filter(x=>x?.direction).map(x=>`${x.selection}: ${x.direction}`);
    marketDirection=moves.length?moves.join(" · "):markets.length?"İlk kayıt / hareket ölçülemiyor":"Oran hareketi verisi yok";
    if(!markets.length) reasons.push("Mevcut sağlayıcı oran döndürmedi; oran gerektiren seçimler zorlanmadı.");
    if(teams.length) reasons.push("Maç istatistikleri mevcut."); else reasons.push("Maç istatistikleri mevcut değil.");
    res.json({fixtureId:Number(fixtureId),match:`${home} VS ${away}`,home,away,mode,source:"5DollarFootballAPI · mevcut oranlar ve tarihsel örneklem",fetchedAt:new Date().toISOString(),currentScore:scoreHome==null||scoreAway==null?null:`${scoreHome}-${scoreAway}`,minute:elapsed??null,mainPick,alternative,halfTimeScore,fullTimeScore,surprise,marketDirection,confidence,statsAvailable:teams.length>0,stats:teams,oddsCount:markets.length,history,reasons,providerNote:oddsData.note||null,statsWarning,note:"Yüzdeler seçilmiş tarihsel örneklemin sonuçlarıdır; garanti veya kesin skor tahmini değildir."});
  } catch(error) { console.error("Match analysis error:",error.stack||error.message); res.status(502).json({error:"Maç analiz edilemedi; veri alınamadı.",detail:error.message}); }
});

function resFreqSafe(distribution) { return distribution && Object.keys(distribution).length > 0; }

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
    let assessment = "—";
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
    res.json({ enabled: true, intervalSeconds: 1800, running: autoCaptureRunning, trackedMatches: result.rows[0].tracked_matches, maxTrackedMatches: 2,
      note: "İstatistikler sunucu çalışırken yaklaşık 10 dakikada bir denenir. Sağlayıcı cevapları önbelleğe alınır; oranlar yalnızca istendiğinde yenilenir." });
  } catch (error) { console.error("Auto-capture status error:", error.message); res.status(503).json({ enabled: false, error: "Otomatik kayıt durumu alınamadı." }); }
});

app.listen(PORT, () => {
  console.log(`WinScope Live running on port ${PORT}`);
  console.log("Veri kaynağı: 5DollarFootballAPI. Canlı oranlar ve istatistikler sağlayıcının bu maç/market için gerçekten döndürdüğü alanlarla sınırlıdır; eksik veriler tahmin edilmez.");
  captureTrackedMatches().catch(error => console.error("İlk otomatik kayıt başarısız:", error.message));
  scanTrackedMatchAlarms().catch(error => console.error("İlk alarm taraması başarısız:", error.message));
  // Quota protection: background tasks run less frequently; cached requests are shared with the UI.
  const captureTimer = setInterval(() => captureTrackedMatches().catch(error => console.error("Otomatik kayıt döngüsü başarısız:", error.message)), 30 * 60_000);
  const alarmTimer = setInterval(() => scanTrackedMatchAlarms().catch(error => console.error("Alarm tarama döngüsü başarısız:", error.message)), 15 * 60_000);
  captureTimer.unref();
  alarmTimer.unref();
});
