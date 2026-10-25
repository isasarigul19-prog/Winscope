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
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BASE_URL = "https://v3.football.api-sports.io";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HISTORICAL_CSV = path.join(ROOT, "winscope_historical_odds.csv");
const { Pool } = pg;

app.use(express.json({ limit: "500kb" }));
app.use(express.static(path.join(ROOT, "public")));

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
  idleTimeoutMillis: 30000,
  max: 5
}) : null;

let dbReady = null;
const providerCache = new Map();
const PROVIDER_CACHE_MS = { liveList: 30_000, fixture: 60_000, stats: 20_000 };
const providerInFlight = new Map();
let providerRateLimitedUntil = 0;

const savedAnalyses = new Map();
const savedCoupons = new Map();
let liveCouponScanCursor = 0;
let autoAlarmScanCursor = 0;
let latestAutomaticLiveCoupon = null;

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("[Telegram Skip] Bot Token veya Chat ID eksik.");
    return false;
  }
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: "HTML"
      }),
      signal: AbortSignal.timeout(8000)
    });
    const resData = await res.json();
    if (!res.ok || !resData.ok) {
      console.error("[Telegram Error]", resData.description || "Bilinmeyen hata");
      return false;
    }
    console.log("[Telegram OK] Mesaj başarıyla gönderildi.");
    return true;
  } catch (error) {
    console.error("[Telegram Exception]", error.message);
    return false;
  }
}

const OFFICIAL_IDDAA_LEAGUES_REGEX = /süper lig|1\. lig|premier league|la liga|serie a|bundesliga|ligue 1|eredivisie|pro league|championship|primeira liga|champions league|europa league|conference league|liga profesional|mls|liga mx|superliga|ekstraklasa|allsvenskan|eliteserien|2\. bundesliga|segunda division|serie b|ligue 2/i;

const STRICT_UNWANTED_REGEX = /third league|fourth league|3\. lig|4\. lig|5\. lig|oberliga|regionalliga|regional|southwest|northeast|northwest|southeast| ii| ii$| b$| b |reserve|youth|u19|u21|u23|women|damallsvenskan|frauen|feminine|femenil|w-league|amateur|syria|congo|kosovo|kenya|ethiopia|rwanda|uganda|tanzania|zambia|zimbabwe|malawi|ghana|nigeria|senegal|cameroon|ivory coast|vietnam|thailand|indonesia|myanmar|bangladesh|nepal|malaysia|mongolia|fiji|tahiti|papua|guatemala|honduras|el salvador|nicaragua|panama|jamaica|barbados|belarus|latvia|lithuania|estonia/i;

function isStrictIddaaMatch(match) {
  const country = String(match.country || "").toLowerCase();
  const league = String(match.league || "").toLowerCase();
  const home = String(match.home || "").toLowerCase();
  const away = String(match.away || "").toLowerCase();
  const fullText = `${country} ${league} ${home} ${away}`;

  if (STRICT_UNWANTED_REGEX.test(fullText)) return false;
  if (OFFICIAL_IDDAA_LEAGUES_REGEX.test(league) || OFFICIAL_IDDAA_LEAGUES_REGEX.test(fullText)) {
    return true;
  }
  return false;
}

async function cachedProviderRequest(cacheKey, pathname, ttlMs) {
  const now = Date.now();
  const cached = providerCache.get(cacheKey);
  if (cached && now - cached.at < ttlMs) return cached.payload;
  if (now < providerRateLimitedUntil) {
    if (cached) return cached.payload;
    throw new Error("API limit koruması.");
  }
  if (providerInFlight.has(cacheKey)) return providerInFlight.get(cacheKey);
  const task = footballDataRequest(pathname).then(payload => {
    providerCache.set(cacheKey, { at: Date.now(), payload });
    return payload;
  }).catch(error => {
    if (/429|rate.limit/i.test(String(error.message))) {
      providerRateLimitedUntil = Date.now() + 30_000;
      if (cached) return cached.payload;
    }
    throw error;
  }).finally(() => providerInFlight.delete(cacheKey));
  providerInFlight.set(cacheKey, task);
  return task;
}

function toNumber(value) {
  if (value == null || String(value).trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

async function importHistoricalCsvOnce() {
  if (!pool || !existsSync(HISTORICAL_CSV)) return;
  const existing = await pool.query("SELECT COUNT(*)::int AS total FROM historical_matches");
  if (existing.rows[0].total > 0) return;
  const csvText = await readFile(HISTORICAL_CSV, "utf8");
  const records = parse(csvText, { columns: true, bom: true, skip_empty_lines: true, trim: true });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let start = 0; start < records.length; start += 300) {
      const batch = records.slice(start, start + 300);
      const values = [];
      const placeholders = batch.map((row, index) => {
        const offset = index * 27;
        const rawDate = String(row.Date || "").trim();
        const dateParts = rawDate.includes("/") ? rawDate.split("/") : rawDate.split("-");
        let isoDate = null;
        if (dateParts.length === 3) {
          if (/^\d{4}$/.test(dateParts[0])) {
            isoDate = `${dateParts[0]}-${dateParts[1].padStart(2, "0")}-${dateParts[2].padStart(2, "0")}`;
          } else {
            let year = dateParts[2];
            if (/^\d{2}$/.test(year)) year = Number(year) < 50 ? `20${year}` : `19${year}`;
            isoDate = `${year}-${dateParts[1].padStart(2, "0")}-${dateParts[0].padStart(2, "0")}`;
          }
        }
        values.push(
          row.Div || null, isoDate, row.Time || null, row.HomeTeam || null, row.AwayTeam || null,
          toNumber(row.HTHG), toNumber(row.HTAG), toNumber(row.FTHG), toNumber(row.FTAG), row.FTR || null,
          toNumber(row.B365H), toNumber(row.B365D), toNumber(row.B365A), toNumber(row.AvgH), toNumber(row.AvgD), toNumber(row.AvgA),
          toNumber(row["B365>2.5"]), toNumber(row["B365<2.5"]), toNumber(row["Avg>2.5"]), toNumber(row["Avg<2.5"]),
          toNumber(row["B365C>2.5"]), toNumber(row["B365C<2.5"]), toNumber(row.TotalGoals), toNumber(row.Over25Result),
          toNumber(row.B365AHH), toNumber(row.B365AHA), toNumber(row.AHh)
        );
        return `(${Array.from({ length: 27 }, (_, i) => `$${offset + i + 1}`).join(",")})`;
      });
      await client.query(`INSERT INTO historical_matches (
        league_code, match_date, match_time, home_team, away_team, ht_home_goals, ht_away_goals,
        ft_home_goals, ft_away_goals, full_time_result, b365_home, b365_draw, b365_away,
        avg_home, avg_draw, avg_away, b365_over25, b365_under25, avg_over25, avg_under25,
        b365_close_over25, b365_close_under25, total_goals, over25_result, b365_ah_home, b365_ah_away, ah_line
      ) VALUES ${placeholders.join(",")}`, values);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
  } finally { client.release(); }
}

async function initDatabase() {
  if (!pool) return;
  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS historical_matches (
          id BIGSERIAL PRIMARY KEY, league_code TEXT, match_date DATE, match_time TEXT,
          home_team TEXT NOT NULL, away_team TEXT NOT NULL, ht_home_goals INTEGER, ht_away_goals INTEGER,
          ft_home_goals INTEGER, ft_away_goals INTEGER, full_time_result TEXT,
          b365_home NUMERIC, b365_draw NUMERIC, b365_away NUMERIC, avg_home NUMERIC, avg_draw NUMERIC, avg_away NUMERIC,
          b365_over25 NUMERIC, b365_under25 NUMERIC, avg_over25 NUMERIC, avg_under25 NUMERIC,
          b365_close_over25 NUMERIC, b365_close_under25 NUMERIC, b365_ah_home NUMERIC, b365_ah_away NUMERIC, ah_line NUMERIC,
          total_goals INTEGER, over25_result INTEGER
        );
        ALTER TABLE historical_matches ADD COLUMN IF NOT EXISTS b365_ah_home NUMERIC;
        ALTER TABLE historical_matches ADD COLUMN IF NOT EXISTS b365_ah_away NUMERIC;
        ALTER TABLE historical_matches ADD COLUMN IF NOT EXISTS ah_line NUMERIC;
        CREATE TABLE IF NOT EXISTS user_saved_analyses (
          id TEXT PRIMARY KEY, fixture_id NUMERIC, payload JSONB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS user_saved_coupons (
          id TEXT PRIMARY KEY, payload JSONB, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS telegram_result_tracking (
          id TEXT PRIMARY KEY, payload JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS live_odds_snapshots (
          id BIGSERIAL PRIMARY KEY, fixture_id BIGINT NOT NULL, source TEXT NOT NULL,
          market_type TEXT NOT NULL DEFAULT 'live',
          over05 NUMERIC, under05 NUMERIC, over15 NUMERIC, under15 NUMERIC,
          over25 NUMERIC, under25 NUMERIC, over35 NUMERIC, under35 NUMERIC,
          home_win NUMERIC, draw_odd NUMERIC, away_win NUMERIC, btts_yes NUMERIC, btts_no NUMERIC,
          handicap_home NUMERIC, handicap_away NUMERIC, handicap_line NUMERIC,
          observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS market_type TEXT NOT NULL DEFAULT 'live';
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS over05 NUMERIC;
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS under05 NUMERIC;
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS under15 NUMERIC;
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS over35 NUMERIC;
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS under35 NUMERIC;
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS home_win NUMERIC;
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS draw_odd NUMERIC;
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS away_win NUMERIC;
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS handicap_home NUMERIC;
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS handicap_away NUMERIC;
        ALTER TABLE live_odds_snapshots ADD COLUMN IF NOT EXISTS handicap_line NUMERIC;
        CREATE INDEX IF NOT EXISTS live_odds_snapshots_fixture_time_idx
          ON live_odds_snapshots (fixture_id, observed_at DESC);
      `);
      await importHistoricalCsvOnce();
      return true;
    })().catch(e => { dbReady = null; });
  }
  return dbReady;
}

function mapProviderStatus(status) {
  const value = String(status || "").toLowerCase();
  if (["finished", "full", "ft", "aet", "pen"].includes(value)) return "FT";
  if (/^\d{1,3}$/.test(value) || ["live", "in_play", "1h", "2h", "ht", "halftime"].includes(value)) {
    if (["half", "halftime", "ht"].includes(value)) return "HT";
    return "LIVE";
  }
  return String(status || "NS").toUpperCase();
}

function normalizeProviderMatch(match) {
  const homeName = typeof match.teams?.home === "object" ? match.teams?.home?.name : (match.home || match.teams?.home || "Ev sahibi");
  const awayName = typeof match.teams?.away === "object" ? match.teams?.away?.name : (match.away || match.teams?.away || "Deplasman");
  const leagueName = typeof match.league === "object" ? match.league?.name : (match.league || "Bilinmeyen lig");
  const countryName = typeof match.country === "object" ? match.country?.name : (match.country || match.league?.country || "");
  const idNum = Number(match.id ?? match.fixture?.id) || 100000;
  const iddaaCode = String(10000 + (idNum % 89999));

  return {
    id: idNum,
    iddaaCode,
    league: String(leagueName),
    country: String(countryName),
    minute: match.fixture?.status?.elapsed ?? match.minute ?? null,
    status: mapProviderStatus(match.status_code ?? match.status ?? match.fixture?.status?.short),
    home: String(homeName),
    away: String(awayName),
    homeScore: match.goals?.home ?? 0,
    awayScore: match.goals?.away ?? 0,
    htHomeScore: match.score?.halftime?.home ?? null,
    htAwayScore: match.score?.halftime?.away ?? null,
    fixtureDate: match.kickoff_utc || match.fixture?.date || null
  };
}

async function footballDataRequest(pathname) {
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY yok.");
  const response = await fetch(`${BASE_URL}${pathname}`, {
    headers: { "x-apisports-key": API_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(7000)
  });
  const text = await response.text();
  let payload = text ? JSON.parse(text) : {};
  if (!response.ok || (payload.errors && Object.keys(payload.errors).length)) {
    throw new Error("API isteği başarısız.");
  }
  return payload;
}

async function apiGet(pathname) {
  // Endpoint-specific cache reduces repeated requests to the paid football API.
  let ttl = PROVIDER_CACHE_MS.fixture;
  if (pathname.startsWith("/odds/live")) ttl = 2 * 60_000;
  else if (pathname.startsWith("/odds?")) ttl = 10 * 60_000;
  else if (pathname.startsWith("/fixtures/statistics?")) ttl = 90_000;
  else if (pathname.startsWith("/fixtures?id=")) ttl = 2 * 60_000;
  const payload = await cachedProviderRequest(pathname, pathname, ttl);
  return payload.response || payload.data || [];
}

function parseOddsBookmakers(rows, defaultSource = "API-Football") {
  const books = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    for (const book of (Array.isArray(row.bookmakers) ? row.bookmakers : [])) {
      books.push({ source: String(book.name || defaultSource), bets: Array.isArray(book.bets) ? book.bets : [] });
    }
    if (Array.isArray(row.odds) && row.odds.length) {
      books.push({ source: String(row.bookmaker?.name || row.bookmaker || row.source || defaultSource),
        bets: row.odds.map(item => ({ name: item.name || item.bet || "", values: Array.isArray(item.values) ? item.values : [] })) });
    }
  }
  const preferred = books.find(b => /bet365/i.test(b.source));
  const ordered = preferred ? [preferred, ...books.filter(b => b !== preferred)] : books;
  const keys = ["homeWin","draw","awayWin","over05","under05","over15","under15","over25","under25","over35","under35",
    "htOver05","htUnder05","htOver15","htUnder15","htOver25","htUnder25","htHomeOver05","htHomeUnder05","htAwayOver05","htAwayUnder05",
    "homeOver05","homeUnder05","homeOver15","homeUnder15","awayOver05","awayUnder05","awayOver15","awayUnder15",
    "bttsYes","bttsNo","handicapHome","handicapAway"];
  const combined = Object.fromEntries(keys.map(k => [k, null]));
  combined.source = null; combined.sources = {}; combined.handicapLine = null; combined.bookmakerCount = ordered.length; combined.bookmakers = ordered.map(b => b.source);
  for (const book of ordered) {
    const one = Object.fromEntries(keys.map(k => [k, null]));
    let handicapHomeLine = null, handicapAwayLine = null;
    for (const bet of book.bets) {
      const name = String(bet.name || "").toLowerCase();
      for (const v of (bet.values || [])) {
        const label = String(v.value ?? v.name ?? "").toLowerCase().trim();
        const n = toNumber(v.odd);
        if (n == null || n <= 1) continue;
        if (/match winner|1x2|full[ -]?time result|winner|match result|1x2 \(including/.test(name)) {
          if (["home", "1", "team 1"].includes(label)) one.homeWin = n;
          else if (["draw", "x"].includes(label)) one.draw = n;
          else if (["away", "2", "team 2"].includes(label)) one.awayWin = n;
        } else if (/home team|home goals|team 1 total|team 1 goals|home total goals|team total goals \(home\)/.test(name) ||
                   /away team|away goals|team 2 total|team 2 goals|away total goals|team total goals \(away\)/.test(name)) {
          const side = /home team|home goals|team 1|home total goals|team total goals \(home\)/.test(name) ? "home" : "away";
          const isFirstHalfTeamMarket = /first half|1st half|half time|half-time|1st period|first period|1st half team/.test(name);
          const prefix = isFirstHalfTeamMarket ? `ht${side === "home" ? "Home" : "Away"}` : side;
          for (const line of ["0.5", "1.5"]) if (label.includes(line)) {
            if (label.includes("over")) one[`${prefix}Over${line.replace(".", "")}`] = n;
            if (label.includes("under")) one[`${prefix}Under${line.replace(".", "")}`] = n;
          }
        } else if (/over\s*\/\s*under|goals over\s*\/\s*under|total goals|total|match goals|goal line/.test(name) &&
                   !/home team|away team|team total|team goals|home goals|away goals|home total goals|away total goals/.test(name)) {
          const isHalfTimeMarket = /first half|1st half|half time|half-time|1st period|first period|1st half goals|half-time goals/.test(name);
          for (const line of ["0.5", "1.5", "2.5", "3.5"]) if (label.includes(line)) {
            const prefix = isHalfTimeMarket ? "htOver" : "over";
            const underPrefix = isHalfTimeMarket ? "htUnder" : "under";
            if (label.includes("over")) one[`${prefix}${line.replace(".", "")}`] = n;
            if (label.includes("under")) one[`${underPrefix}${line.replace(".", "")}`] = n;
          }
        } else if (/both teams to score|both teams score|both teams|btts/.test(name)) {
          if (["yes", "y"].includes(label)) one.bttsYes = n;
          else if (["no", "n"].includes(label)) one.bttsNo = n;
        } else if (/asian handicap|handicap/.test(name)) {
          const match = label.match(/(home|away|team\s*1|team\s*2|^1\b|^2\b)\s*([+-]?\d+(?:\.\d+)?)/i);
          if (match) {
            const side = /home|team\s*1|^1\b/i.test(match[1]) ? "home" : "away";
            const lineValue = Number(match[2]);
            if (side === "home") { one.handicapHome = n; handicapHomeLine = lineValue; }
            else { one.handicapAway = n; handicapAwayLine = lineValue; }
          }
        }
      }
    }
    if (one.handicapHome != null && one.handicapAway != null && handicapHomeLine != null && handicapAwayLine != null && Math.abs(handicapHomeLine + handicapAwayLine) < 0.26) {
      combined.handicapLine ??= handicapHomeLine;
    } else if (one.handicapHome == null || one.handicapAway == null) {
      one.handicapHome = null; one.handicapAway = null;
    }
    for (const key of keys) {
      if (combined[key] == null && one[key] != null) {
        combined[key] = one[key];
        combined.sources[key] = book.source;
        combined.source ??= book.source;
      }
    }
  }
  return keys.some(k => combined[k] != null) ? combined : null;
}

async function recordLiveOddsSnapshot(fixtureId, liveOdds, marketType = "live") {
  const current = {
    over05: toNumber(liveOdds?.over05), under05: toNumber(liveOdds?.under05),
    over15: toNumber(liveOdds?.over15), under15: toNumber(liveOdds?.under15),
    over25: toNumber(liveOdds?.over25), under25: toNumber(liveOdds?.under25),
    over35: toNumber(liveOdds?.over35), under35: toNumber(liveOdds?.under35),
    homeWin: toNumber(liveOdds?.homeWin), draw: toNumber(liveOdds?.draw), awayWin: toNumber(liveOdds?.awayWin),
    handicapHome: toNumber(liveOdds?.handicapHome), handicapAway: toNumber(liveOdds?.handicapAway), handicapLine: toNumber(liveOdds?.handicapLine),
    bttsYes: toNumber(liveOdds?.bttsYes), bttsNo: toNumber(liveOdds?.bttsNo)
  };
  if (!Object.values(current).some(v => v != null)) return { state: "CANLI ORAN YOK", trend: "ölçülemedi", changed: false };
  if (!pool) return { state: "DB bağlantısı yok; ölçüm saklanamadı", trend: "ölçülemedi", changed: false };
  try {
    await initDatabase();
    const prevQ = await pool.query(
      `SELECT * FROM live_odds_snapshots WHERE fixture_id=$1 AND market_type=$2 ORDER BY observed_at DESC LIMIT 1`, [Number(fixtureId), marketType]
    );
    const prev = prevQ.rows[0] || null;
    const prevAt = prev ? new Date(prev.observed_at).getTime() : 0;
    const ageMs = prevAt ? Date.now() - prevAt : Infinity;
    const fieldMap = { over05:"over05", under05:"under05", over15:"over15", under15:"under15", over25:"over25", under25:"under25", over35:"over35", under35:"under35", homeWin:"home_win", draw:"draw_odd", awayWin:"away_win", handicapHome:"handicap_home", handicapAway:"handicap_away", bttsYes:"btts_yes", bttsNo:"btts_no" };
    const deltas = {};
    for (const [key, dbKey] of Object.entries(fieldMap)) {
      const old = prev ? toNumber(prev[dbKey]) : null;
      deltas[key] = current[key] != null && old != null ? Number((current[key] - old).toFixed(3)) : null;
    }
    // Persist no more than once per 90 seconds to avoid comparing identical cached responses.
    if (!prev || ageMs >= 90_000) {
      await pool.query(
        `INSERT INTO live_odds_snapshots
         (fixture_id,source,market_type,over05,under05,over15,under15,over25,under25,over35,under35,home_win,draw_odd,away_win,btts_yes,btts_no,handicap_home,handicap_away,handicap_line)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [Number(fixtureId), String(liveOdds.source || "API-Football oran"), marketType, current.over05,current.under05,current.over15,current.under15,current.over25,current.under25,current.over35,current.under35,current.homeWin,current.draw,current.awayWin,current.bttsYes,current.bttsNo,current.handicapHome,current.handicapAway,current.handicapLine]
      );
    }
    const movementKeys = ["over05","over15","over25","over35","bttsYes","handicapHome","handicapAway","homeWin","draw","awayWin"];
    const trendKey = movementKeys.find(k => deltas[k] != null && Math.abs(deltas[k]) >= 0.05) || movementKeys.find(k => deltas[k] != null);
    const relevant = trendKey ? deltas[trendKey] : null;
    let trend = "sabit";
    if (!prev || relevant == null) trend = "ikinci ölçüm bekleniyor";
    else if (relevant <= -0.05) trend = "oran düşüyor";
    else if (relevant >= 0.05) trend = "oran yükseliyor";
    return { state: prev ? (ageMs < 90_000 ? "önceki ölçümle karşılaştırıldı" : "yeni ölçüm kaydedildi") : "ilk ölçüm kaydedildi", trend,
      changed: Boolean(prev && relevant != null && Math.abs(relevant) >= 0.05), deltas,
      previousObservedAt: prev?.observed_at || null, comparedMarket: trendKey || "uygun oran pazarı bulunamadı" };
  } catch (error) {
    console.warn(`[Odds movement unavailable] fixture=${fixtureId}: ${error.message}`);
    return { state: "hareket geçmişi kaydedilemedi", trend: "ölçülemedi", changed: false };
  }
}

async function fetchRealOdds(fixtureId, liveMatch = false) {
  // Never invent prices. For a live fixture, keep pre-match prices for historical matching
  // and fetch live prices separately; a pre-match price is not treated as a live market.
  let preMatchOdds = null;
  let liveOdds = null;
  try {
    const payload = await apiGet(`/odds?fixture=${encodeURIComponent(fixtureId)}`);
    preMatchOdds = parseOddsBookmakers(payload);
    if (preMatchOdds) preMatchOdds.movement = await recordLiveOddsSnapshot(fixtureId, preMatchOdds, "prematch");
  } catch (error) {
    console.warn(`[Pre-match odds unavailable] fixture=${fixtureId}: ${error.message}`);
  }

  if (liveMatch) {
    try {
      const livePayload = await apiGet(`/odds/live?fixture=${encodeURIComponent(fixtureId)}`);
      liveOdds = parseOddsBookmakers(livePayload, "API-Football canlı oran");
      if (liveOdds) liveOdds.movement = await recordLiveOddsSnapshot(fixtureId, liveOdds);
      if (!liveOdds) {
        const first = Array.isArray(livePayload) ? livePayload[0] : null;
        console.warn(`[Live odds unavailable/empty response] fixture=${fixtureId}; rows=${Array.isArray(livePayload) ? livePayload.length : 0}; rowKeys=${first && typeof first === "object" ? Object.keys(first).join(",") : "none"}; oddsRows=${Array.isArray(first?.odds) ? first.odds.length : 0}; bookmakerRows=${Array.isArray(first?.bookmakers) ? first.bookmakers.length : 0}; preMatchFallback=${Boolean(preMatchOdds && hasUsableGoalMarketOdds(preMatchOdds))}`);
      }
    } catch (error) {
      console.warn(`[Live odds unavailable] fixture=${fixtureId}: ${error.message}`);
    }
  }

  const base = preMatchOdds || {
    source: null, homeWin: null, draw: null, awayWin: null,
    over05: null, under05: null, over15: null, under15: null, over25: null, under25: null, over35: null, under35: null, bttsYes: null, bttsNo: null, handicapHome: null, handicapAway: null, handicapLine: null
  };
  return { ...base, liveOdds: liveOdds ? { ...liveOdds, isLive: true } : null, isLive: false };
}

function isActionableMarket(marketText) {
  const market = String(marketText || "").toLocaleUpperCase("tr-TR");
  if (!market || market === "—") return false;
  if (/GERÇEKLEŞTİ|ÇİZGİ GERÇEKLEŞTİ|TAKİP:|ANALİZ:|VERİ YETERSİZ|TERCİH YOK|MAÇ TAMAMLANDI/.test(market)) return false;
  return /(?:MS\s*)?\d+(?:[.,]\d+)?\s*(?:ÜST|ALT)|KG\s*(?:VAR|YOK)|(?:EV|EV SAHİBİ|DEP|DEPLASMAN)\s*\d+(?:[.,]\d+)?\s*ÜST|MS\s*[1X2]\b|BERABERLİK/.test(market);
}

function hasUsableGoalMarketOdds(odds = {}) {
  const fields = [
    "over05", "over15", "over25", "over35",
    "homeOver05", "awayOver05", "homeOver15", "awayOver15",
    "bttsYes"
  ];
  return fields.some(key => toNumber(odds?.[key]) != null && Number(odds[key]) > 1);
}

function getOddsBasis(odds, isLive) {
  if (!isLive) return odds?.source && hasUsableGoalMarketOdds(odds) ? "maç önü oranı" : "oran yok";
  if (odds?.liveOdds?.isLive && hasUsableGoalMarketOdds(odds.liveOdds)) return "canlı oran";
  if (hasUsableGoalMarketOdds(odds)) return "maç önü referans oranı (canlı gol pazarı yok)";
  return "oran yok";
}

function decideSmartMarket(historyData, odds, currentTotalGoals, liveStats, matchInfo) {
  const h = historyData || {};
  const o = odds || {};
  const live = Array.isArray(liveStats) ? liveStats : [];
  const minute = Number(matchInfo?.minute || 0);
  const isLive = !!matchInfo && (matchInfo.status === "LIVE" || matchInfo.status === "HT" || (minute > 0 && matchInfo.status !== "FT" && matchInfo.status !== "NS"));
  const homeGoals = Number(matchInfo?.homeScore || 0);
  const awayGoals = Number(matchInfo?.awayScore || 0);
  const goals = Number(currentTotalGoals ?? (homeGoals + awayGoals));
  const homeName = String(matchInfo?.home || "").toLocaleLowerCase("tr-TR");
  const awayName = String(matchInfo?.away || "").toLocaleLowerCase("tr-TR");
  let shotsOnTarget = 0, totalShots = 0, corners = 0, dangerousAttacks = 0, totalXg = 0;
  const teamLive = { home: { shots: 0, sot: 0, corners: 0, xg: 0 }, away: { shots: 0, sot: 0, corners: 0, xg: 0 } };
  for (const team of live) {
    const teamName = String(team.team?.name || team.team || "").toLocaleLowerCase("tr-TR");
    const side = teamName && (teamName === homeName || homeName.includes(teamName) || teamName.includes(homeName)) ? "home"
      : teamName && (teamName === awayName || awayName.includes(teamName) || teamName.includes(awayName)) ? "away" : null;
    for (const st of (Array.isArray(team.statistics) ? team.statistics : [])) {
      const n = toNumber(st.value);
      if (n == null) continue;
      const type = String(st.type || "").toLowerCase();
      if (type === "shots on goal" || type === "shots on target") { shotsOnTarget += n; if (side) teamLive[side].sot += n; }
      if (type === "total shots") { totalShots += n; if (side) teamLive[side].shots += n; }
      if (type.includes("corner")) { corners += n; if (side) teamLive[side].corners += n; }
      if (type.includes("dangerous attack")) dangerousAttacks += n;
      if (type === "expected_goals" || type === "expected goals" || type === "xg") { totalXg += n; if (side) teamLive[side].xg += n; }
    }
  }

  const markets = [
    { key: "ft05Pct", label: "MS 0.5 ÜST", threshold: 1, oddsKey: "over05", underKey: "under05" },
    { key: "over15Pct", label: "MS 1.5 ÜST", threshold: 2, oddsKey: "over15", underKey: "under15" },
    { key: "over25Pct", label: "MS 2.5 ÜST", threshold: 3, oddsKey: "over25", underKey: "under25" },
    { key: "over35Pct", label: "MS 3.5 ÜST", threshold: 4, oddsKey: "over35", underKey: "under35" },
    { key: "ht05Pct", label: "İY 0.5 ÜST", threshold: 1, half: true, oddsKey: "htOver05", underKey: "htUnder05" },
    { key: "ht15Pct", label: "İY 1.5 ÜST", threshold: 2, half: true, oddsKey: "htOver15", underKey: "htUnder15" },
    { key: "ht25Pct", label: "İY 2.5 ÜST", threshold: 3, half: true, oddsKey: "htOver25", underKey: "htUnder25" },
    { key: "home05Pct", label: "EV 0.5 ÜST", threshold: 1, team: "home", oddsKey: "homeOver05", underKey: "homeUnder05" },
    { key: "away05Pct", label: "DEP 0.5 ÜST", threshold: 1, team: "away", oddsKey: "awayOver05", underKey: "awayUnder05" },
    { key: "home15Pct", label: "EV 1.5 ÜST", threshold: 2, team: "home", oddsKey: "homeOver15", underKey: "homeUnder15" },
    { key: "away15Pct", label: "DEP 1.5 ÜST", threshold: 2, team: "away", oddsKey: "awayOver15", underKey: "awayUnder15" },
    { key: "htHome05Pct", label: "İY EV 0.5 ÜST", threshold: 1, half: true, team: "home", oddsKey: "htHomeOver05", underKey: "htHomeUnder05" },
    { key: "htAway05Pct", label: "İY DEP 0.5 ÜST", threshold: 1, half: true, team: "away", oddsKey: "htAwayOver05", underKey: "htAwayUnder05" },
    { key: "bttsPct", label: "KG VAR", oddsKey: "bttsYes", underKey: "bttsNo", btts: true },
    { key: "ms1Pct", label: "MS 1", oneXtwo: "homeWin" },
    { key: "msXPct", label: "MS X", oneXtwo: "draw" },
    { key: "ms2Pct", label: "MS 2", oneXtwo: "awayWin" }
  ];
  const liveOdds = o.liveOdds?.isLive ? o.liveOdds : null;
  // If the provider has no live market for this fixture, real pre-match odds may
  // be used as a clearly labelled reference only. They are never presented as live prices.
  const priceSource = isLive
    ? (liveOdds && hasUsableGoalMarketOdds(liveOdds) ? liveOdds : o)
    : o;
  const oddsBasis = getOddsBasis(o, isLive);
  const implied = {};
  const paired = (over, under) => {
    const a = toNumber(priceSource[over]), b = toNumber(priceSource[under]);
    if (a != null && a > 1 && b != null && b > 1) {
      const pa = 1 / a, pb = 1 / b;
      return 100 * pa / (pa + pb);
    }
    // Some API-Football live feeds return only one side of a market. Use that
    // real quoted price as a rough implied-probability signal, never as a fabricated price.
    if (a != null && a > 1) return 100 / a;
    return null;
  };
  implied.over05Pct = paired("over05", "under05");
  implied.over15Pct = paired("over15", "under15");
  implied.over25Pct = paired("over25", "under25");
  implied.over35Pct = paired("over35", "under35");
  implied.ht05Pct = paired("htOver05", "htUnder05");
  implied.ht15Pct = paired("htOver15", "htUnder15");
  implied.ht25Pct = paired("htOver25", "htUnder25");
  implied.home05Pct = paired("homeOver05", "homeUnder05");
  implied.away05Pct = paired("awayOver05", "awayUnder05");
  implied.home15Pct = paired("homeOver15", "homeUnder15");
  implied.away15Pct = paired("awayOver15", "awayUnder15");
  implied.htHome05Pct = paired("htHomeOver05", "htHomeUnder05");
  implied.htAway05Pct = paired("htAwayOver05", "htAwayUnder05");
  const yes = toNumber(priceSource.bttsYes), no = toNumber(priceSource.bttsNo);
  implied.bttsPct = yes != null && no != null && yes > 1 && no > 1 ? 100 * (1 / yes) / ((1 / yes) + (1 / no)) : null;
  const oneXtwo = [toNumber(priceSource.homeWin), toNumber(priceSource.draw), toNumber(priceSource.awayWin)];
  if (oneXtwo.every(v => v != null && v > 1)) {
    const inv = oneXtwo.map(v => 1 / v), sum = inv.reduce((a, b) => a + b, 0);
    implied.ms1Pct = inv[0] / sum * 100; implied.msXPct = inv[1] / sum * 100; implied.ms2Pct = inv[2] / sum * 100;
  }
  const keyForLabel = {
    "MS 0.5 ÜST": "over05Pct", "MS 1.5 ÜST": "over15Pct", "MS 2.5 ÜST": "over25Pct", "MS 3.5 ÜST": "over35Pct",
    "İY 0.5 ÜST": "ht05Pct", "İY 1.5 ÜST": "ht15Pct", "İY 2.5 ÜST": "ht25Pct",
    "EV 0.5 ÜST": "home05Pct", "DEP 0.5 ÜST": "away05Pct", "EV 1.5 ÜST": "home15Pct", "DEP 1.5 ÜST": "away15Pct",
    "İY EV 0.5 ÜST": "htHome05Pct", "İY DEP 0.5 ÜST": "htAway05Pct", "KG VAR": "bttsPct", "MS 1": "ms1Pct", "MS X": "msXPct", "MS 2": "ms2Pct"
  };
  const lateZeroZeroWindow = isLive && goals === 0 && minute >= 70 && minute <= 76;
  const lateZeroZeroSupported = lateZeroZeroWindow && h.total >= 30 && Number(h.ft05Pct) >= 70 && live.length >= 2 &&
    (shotsOnTarget >= 1 || totalShots >= 5) && Boolean(liveOdds?.over05 != null || liveOdds?.over15 != null || liveOdds?.over25 != null);
  const liveStatsAvailable = live.length >= 2;
  const liveTempoSupported = liveStatsAvailable && (shotsOnTarget >= 2 || totalShots >= 8 || totalXg >= 0.8 || corners >= 4);
  // Score each candidate using its own real market price. Prefer live odds for that
  // exact market; if unavailable, use only an actual pre-match quote from this fixture.
  // Never borrow an unrelated market's price or invent a price.
  const exactMarketProbability = (m) => {
    if (m.oneXtwo) return implied[keyForLabel[m.label]] ?? null;
    const livePrice = liveOdds;
    const sources = [livePrice, o].filter(Boolean);
    for (const src of sources) {
      const over = toNumber(src[m.oddsKey]);
      const under = m.underKey ? toNumber(src[m.underKey]) : null;
      if (over != null && over > 1 && under != null && under > 1) {
        return 100 * (1 / over) / ((1 / over) + (1 / under));
      }
      if (over != null && over > 1) return 100 / over;
    }
    return null;
  };
  let candidates = markets.map(m => ({ ...m, pct: h[m.key], marketPct: exactMarketProbability(m) }))
    .filter(m => m.marketPct != null && Number.isFinite(Number(m.marketPct)))
    .filter(m => isLive ? !m.oneXtwo : !/^MS\s*[1X2]$/.test(m.label))
    .filter(m => !isLive || (liveStatsAvailable && liveTempoSupported))
    .filter(m => !isLive || !m.half || (minute >= 10 && minute < 45))
    .filter(m => !isLive || !m.threshold || (m.half ? goals < m.threshold : (m.team === "home" ? homeGoals : m.team === "away" ? awayGoals : goals) < m.threshold))
    .filter(m => !isLive || !m.btts || !(homeGoals > 0 && awayGoals > 0))
    .filter(m => !isLive || !m.team || (m.team === "home" ? homeGoals : awayGoals) < m.threshold)
    .filter(m => !isLive || m.label !== "MS 0.5 ÜST" || lateZeroZeroSupported)
    .filter(m => isLive || !["MS 0.5 ÜST", "MS 1.5 ÜST", "EV 0.5 ÜST", "DEP 0.5 ÜST"].includes(m.label));

  // Dynamic market selection by match state: half-time markets early, remaining-goal
  // markets after the break, and team-goal markets when one side is clearly dominant.
  const phaseBonus = (c) => {
    if (!isLive) return 0;
    let b = 0;
    const total = homeGoals + awayGoals;
    if (minute < 45) {
      if (total === 0 && c.label === "İY 0.5 ÜST") b += 9;
      if (total === 0 && minute >= 25 && c.label === "İY 1.5 ÜST") b += 2;
      if (total === 1 && c.label === "İY 1.5 ÜST") b += 10;
      if (c.label === "İY EV 0.5 ÜST" && teamLive.home.sot >= teamLive.away.sot + 2) b += 4;
      if (c.label === "İY DEP 0.5 ÜST" && teamLive.away.sot >= teamLive.home.sot + 2) b += 4;
      if (minute >= 40 && c.half) b -= 2;
    } else {
      if (total === 0 && minute >= 70 && c.label === "MS 0.5 ÜST" && lateZeroZeroSupported) b += 12;
      if (total === 1 && c.label === "MS 1.5 ÜST") b += 8;
      if (c.label === "EV 1.5 ÜST" && homeGoals < 2 && teamLive.home.sot >= teamLive.away.sot + 2) b += 7;
      if (c.label === "DEP 1.5 ÜST" && awayGoals < 2 && teamLive.away.sot >= teamLive.home.sot + 2) b += 7;
      if (c.label === "EV 0.5 ÜST" && homeGoals === 0 && teamLive.home.sot > teamLive.away.sot) b += 4;
      if (c.label === "DEP 0.5 ÜST" && awayGoals === 0 && teamLive.away.sot > teamLive.home.sot) b += 4;
    }
    return b;
  };

  const scoreLive = (c) => {
    if (!isLive) return 0;
    let bonus = Math.min(6, shotsOnTarget * 0.8 + totalShots * 0.12 + corners * 0.2 + totalXg * 2 + dangerousAttacks * 0.03);
    if (c.team) {
      const t = teamLive[c.team];
      bonus = Math.min(7, t.sot * 1.2 + t.shots * 0.18 + t.corners * 0.25 + t.xg * 2.5);
    }
    if (c.half && minute > 35) bonus *= 0.65;
    if (c.label === "KG VAR" && (homeGoals === 0 || awayGoals === 0)) bonus *= 0.8;
    if (c.label === "MS 0.5 ÜST" && lateZeroZeroSupported) bonus += 1.5;
    return bonus;
  };
  for (const c of candidates) {
    // Exact market odds are mandatory: no pick is manufactured from historical frequency alone.
    c.rankScore = c.marketPct + scoreLive(c) + phaseBonus(c);
    // Never let pre-match movement masquerade as live movement.
    const movement = isLive ? liveOdds?.movement : o.movement;
    if (movement?.changed && movement?.trend === "oran düşüyor") c.rankScore += 1.5;
    if (movement?.changed && movement?.trend === "oran yükseliyor") c.rankScore -= 1.5;
  }
  candidates.sort((a, b) => b.rankScore - a.rankScore);
  const top = candidates[0] || null;
  const next = candidates.find(c => c.label !== top?.label) || null;
  const scoreSurprise = (h.ftScores || []).find(([score, pct]) => Number(pct) >= 5 && ![top?.label, next?.label].includes(score));
  const mainPick = top ? top.label : "TERCİH YOK";
  const rationale = top
    ? `Piyasa ima olasılığı %${top.marketPct.toFixed(1)} · ${isLive ? `canlı istatistik: ${shotsOnTarget} isabetli şut, ${totalShots} toplam şut, ${corners} korner${totalXg ? `, xG ${totalXg.toFixed(2)}` : ""} · ` : ""}${oddsBasis}: ${(isLive && liveOdds && hasUsableGoalMarketOdds(liveOdds) ? liveOdds.source : o.source) || "kaynak belirtilmedi"}${(isLive ? (liveOdds && hasUsableGoalMarketOdds(liveOdds) ? liveOdds.movement : null) : o.movement)?.trend ? ` · ${(isLive ? (liveOdds && hasUsableGoalMarketOdds(liveOdds) ? liveOdds.movement : null) : o.movement).trend}` : isLive && !(liveOdds && hasUsableGoalMarketOdds(liveOdds)) ? " · canlı oran hareketi ölçülemedi" : ""}.`
    : `Gerçek oranı bulunan uygun bir pazar tespit edilemedi.`;
  return {
    mainPick,
    alternative: next ? next.label : "—",
    confidence: top ? Number(top.marketPct) : null,
    rationale,
    marketProbabilities: Object.fromEntries(markets.map(m => [m.key, implied[m.key] ?? null])),
    marketAnalysis: markets.map(m => ({ label: m.label, impliedProbability: implied[keyForLabel[m.label]] ?? null, available: implied[keyForLabel[m.label]] != null })),
    marketImpliedProbabilities: implied,
    surprise: "Doğru skor pazarı verisi mevcutsa ayrıca değerlendirilecek; veri yoksa skor üretilmedi.",
    oddsSource: (isLive && liveOdds && hasUsableGoalMarketOdds(liveOdds) ? liveOdds.source : o.source) || null,
    oddsBasis,
    oddsDirection: (isLive ? (liveOdds && hasUsableGoalMarketOdds(liveOdds) ? liveOdds.movement : null) : o.movement)?.trend || (isLive && !(liveOdds && hasUsableGoalMarketOdds(liveOdds)) ? "Canlı oran hareketi ölçülemedi" : "İlk ölçüm bekleniyor")
  };
}

function mostLikelyHistoricalScore(scoreRows, minHome = 0, minAway = 0) {
  const rows = Array.isArray(scoreRows) ? scoreRows : [];
  const parsed = rows.map(([score, pct]) => {
    const m = String(score || "").match(/^(\d+)\s*[-:]\s*(\d+)$/);
    return m ? { score: `${Number(m[1])}-${Number(m[2])}`, home: Number(m[1]), away: Number(m[2]), pct: toNumber(pct) } : null;
  }).filter(x => x && x.home >= minHome && x.away >= minAway)
    .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
  return parsed[0] || null;
}

function formatScoreForecast(row, kind = "tarihsel örneklem") {
  if (!row) return "Skor tahmini: tarihsel skor dağılımı bulunamadı";
  return `${row.score} (${kind}${row.pct != null ? ` · %${row.pct}` : ""})`;
}

async function evaluateMatchAdvanced(fixtureId, prefetchedFixture = null) {
  // Reuse the fixture already returned by /fixtures?live=all when possible.
  let fRaw = prefetchedFixture || null;
  if (!fRaw) {
    const fixtures = await apiGet(`/fixtures?id=${fixtureId}`);
    fRaw = fixtures[0] || {};
  }
  const matchInfo = normalizeProviderMatch({
    id: fixtureId,
    league: fRaw.league?.name,
    country: fRaw.league?.country,
    status: fRaw.fixture?.status?.short,
    minute: fRaw.fixture?.status?.elapsed,
    teams: fRaw.teams,
    goals: fRaw.goals,
    score: fRaw.score,
    kickoff_utc: fRaw.fixture?.date
  });

  const isFinished = matchInfo.status === "FT";
  const isLive = !isFinished && (matchInfo.status === "LIVE" || matchInfo.status === "HT" || (matchInfo.minute != null && matchInfo.minute > 0));
  const odds = await fetchRealOdds(fixtureId, isLive);

  let historyData = null;
  if (pool) {
    try {
      await initDatabase();
      const q = await pool.query(`
        SELECT ft_home_goals, ft_away_goals, ht_home_goals, ht_away_goals,
               b365_home, b365_draw, b365_away, b365_over25, avg_home, avg_draw, avg_away, avg_over25,
               b365_ah_home, b365_ah_away, ah_line
        FROM historical_matches
        WHERE ft_home_goals IS NOT NULL AND ft_away_goals IS NOT NULL
          AND ht_home_goals IS NOT NULL AND ht_away_goals IS NOT NULL
        ORDER BY match_date DESC NULLS LAST
      `);
      const rows = q.rows;
      let ranked = [];
      if (rows.length) {
        const homeOddsField = /bet365/i.test(String(odds.sources?.homeWin || odds.source || "")) ? "b365_home" : "avg_home";
        const drawOddsField = /bet365/i.test(String(odds.sources?.draw || odds.source || "")) ? "b365_draw" : "avg_draw";
        const awayOddsField = /bet365/i.test(String(odds.sources?.awayWin || odds.source || "")) ? "b365_away" : "avg_away";
        const overOddsField = /bet365/i.test(String(odds.sources?.over25 || odds.source || "")) ? "b365_over25" : "avg_over25";
        ranked = rows.map(r => {
          let d = 0, terms = 0;
          if (odds.homeWin != null && r[homeOddsField] != null) {
            d += Math.abs(Number(r[homeOddsField]) - odds.homeWin); terms++;
          }
          if (odds.over25 != null && r[overOddsField] != null) {
            d += Math.abs(Number(r[overOddsField]) - odds.over25); terms++;
          }
          if (/bet365/i.test(String(odds.sources?.handicapHome || odds.source || "")) && odds.handicapHome != null && r.b365_ah_home != null) {
            d += Math.abs(Number(r.b365_ah_home) - odds.handicapHome); terms++;
          }
          if (odds.handicapLine != null && r.ah_line != null) { d += Math.abs(Number(r.ah_line) - odds.handicapLine); terms++; }
          return { r, d: terms ? d / terms : Infinity };
        }).filter(x => Number.isFinite(x.d)).sort((a, b) => a.d - b.d).slice(0, 100).map(x => x.r);
        // If the current fixture has no comparable odds, still provide honest descriptive frequencies
        // from the most recent complete historical matches; label these as a fallback sample.
        if (!ranked.length) ranked = rows.slice(0, 100);
      }
      if (ranked.length) {
        const total = ranked.length;
        const pct = fn => Number((100 * ranked.filter(fn).length / total).toFixed(1));
        historyData = {
          total,
          ft05Pct: pct(r => Number(r.ft_home_goals) + Number(r.ft_away_goals) >= 1),
          over15Pct: pct(r => Number(r.ft_home_goals) + Number(r.ft_away_goals) >= 2),
          over25Pct: pct(r => Number(r.ft_home_goals) + Number(r.ft_away_goals) >= 3),
          over35Pct: pct(r => Number(r.ft_home_goals) + Number(r.ft_away_goals) >= 4),
          bttsPct: pct(r => Number(r.ft_home_goals) > 0 && Number(r.ft_away_goals) > 0),
          ht00Pct: pct(r => Number(r.ht_home_goals) === 0 && Number(r.ht_away_goals) === 0),
          ht05Pct: pct(r => Number(r.ht_home_goals) + Number(r.ht_away_goals) >= 1),
          ht15Pct: pct(r => Number(r.ht_home_goals) + Number(r.ht_away_goals) >= 2),
          ht25Pct: pct(r => Number(r.ht_home_goals) + Number(r.ht_away_goals) >= 3),
          home05Pct: pct(r => Number(r.ft_home_goals) >= 1),
          away05Pct: pct(r => Number(r.ft_away_goals) >= 1),
          home15Pct: pct(r => Number(r.ft_home_goals) >= 2),
          away15Pct: pct(r => Number(r.ft_away_goals) >= 2),
          htHome05Pct: pct(r => Number(r.ht_home_goals) >= 1),
          htAway05Pct: pct(r => Number(r.ht_away_goals) >= 1),
          ms1Pct: pct(r => Number(r.ft_home_goals) > Number(r.ft_away_goals)),
          ms2Pct: pct(r => Number(r.ft_home_goals) < Number(r.ft_away_goals)),
          msXPct: pct(r => Number(r.ft_home_goals) === Number(r.ft_away_goals)),
          ftScores: Object.entries(ranked.reduce((acc, r) => {
            const score = `${r.ft_home_goals}-${r.ft_away_goals}`;
            acc[score] = (acc[score] || 0) + 1;
            return acc;
          }, {})).sort((a, b) => b[1] - a[1]).slice(0, 50)
            .map(([score, count]) => [score, Number((100 * count / total).toFixed(1))]),
          htScores: Object.entries(ranked.filter(r => r.ht_home_goals != null && r.ht_away_goals != null).reduce((acc, r) => {
            const score = `${r.ht_home_goals}-${r.ht_away_goals}`;
            acc[score] = (acc[score] || 0) + 1;
            return acc;
          }, {})).sort((a, b) => b[1] - a[1]).slice(0, 50)
            .map(([score, count]) => [score, Number((100 * count / total).toFixed(1))]),
          source: (odds.homeWin != null || odds.over25 != null) ? "odds-nearest-historical-matches" : "recent-historical-fallback"
        };
      }
    } catch (e) {
      console.error("[Historical analysis unavailable]", e.message);
    }
  }
  if (!historyData) {
    historyData = { total: 0, ft05Pct: null, over15Pct: null, over25Pct: null, over35Pct: null, bttsPct: null,
      ht00Pct: null, ht05Pct: null, ht15Pct: null, ht25Pct: null, home05Pct: null, away05Pct: null, home15Pct: null, away15Pct: null, htHome05Pct: null, htAway05Pct: null,
      ms1Pct: null, ms2Pct: null, msXPct: null, ftScores: [], htScores: [], source: "unavailable" };
  }

  // Pre-match fixtures have no live statistics. Do not spend API quota requesting them.
  let liveStats = [];
  if (isLive) {
    try {
      const statsRes = await apiGet(`/fixtures/statistics?fixture=${fixtureId}`);
      if (Array.isArray(statsRes) && statsRes.length > 0) liveStats = statsRes;
    } catch (e) {}
  }

  if (liveStats && liveStats.length >= 2) {
    const getShotVal = (teamObj) => {
      const statsArr = Array.isArray(teamObj.statistics) ? teamObj.statistics : [];
      const shotItem = statsArr.find(s => s.type === "Shots on Goal");
      return Number(shotItem?.value || 0);
    };
  }

  let liveMin = matchInfo.minute || 0;
  let isSecondHalf = liveMin >= 45 || matchInfo.status === "2H" || matchInfo.status === "HT";
  let currentHomeScore = matchInfo.homeScore || 0;
  let currentAwayScore = matchInfo.awayScore || 0;
  let currentTotalGoals = currentHomeScore + currentAwayScore;

  const smartPick = decideSmartMarket(historyData, odds, currentTotalGoals, liveStats, matchInfo);
  let halfTimeDisplayScore = "";
  let fullTimeForecast = "";
  let surpriseDisplay = "Doğru skor pazarı verisi yoksa sürpriz skor üretilmedi";
  let mainPickDisplay = smartPick.mainPick;
  const currentHome = Number(matchInfo.homeScore || 0);
  const currentAway = Number(matchInfo.awayScore || 0);
  const htHistorical = null;
  const ftHistorical = null;
  if (isFinished) {
    halfTimeDisplayScore = `${matchInfo.htHomeScore ?? htHistorical?.score.split("-")[0] ?? "0"}-${matchInfo.htAwayScore ?? htHistorical?.score.split("-")[1] ?? "0"} (gerçek İY skoru)`;
    fullTimeForecast = `${matchInfo.homeScore}-${matchInfo.awayScore} (gerçek MS skoru)`;
    surpriseDisplay = "Maç tamamlandı";
    mainPickDisplay = "Maç tamamlandı — sonuç analizi";
  } else {
    if (isLive && liveMin >= 45 && matchInfo.htHomeScore != null && matchInfo.htAwayScore != null) {
      halfTimeDisplayScore = `${matchInfo.htHomeScore}-${matchInfo.htAwayScore} (gerçek İY skoru)`;
    } else {
      halfTimeDisplayScore = "Doğru skor pazarı verisi bulunmadı; skor uydurulmadı";
    }
    fullTimeForecast = "Doğru skor pazarı verisi bulunmadı; skor uydurulmadı";
    if (isLive && currentTotalGoals >= 3) mainPickDisplay = "MS 2.5 ÜST (çizgi gerçekleşti)";
  }
  const confidenceScore = smartPick.confidence != null ? Math.round(smartPick.confidence) : 0;

  return {
    matchInfo, isLive, isFinished, odds, historyData, liveStats,
    halfTimeDisplayScore, fullTimeForecast, surpriseDisplay, mainPickDisplay, isSecondHalf, smartPick,
    confidenceScore
  };
}

app.get("/api/match/:id/analyze", async (req, res) => {
  const fixtureId = req.params.id;
  try {
    const resEval = await evaluateMatchAdvanced(fixtureId);
    const { matchInfo, isLive, isFinished, odds, historyData, liveStats, halfTimeDisplayScore, fullTimeForecast, surpriseDisplay, mainPickDisplay, isSecondHalf, smartPick, confidenceScore } = resEval;

    res.json({
      fixtureId: Number(fixtureId),
      iddaaCode: matchInfo.iddaaCode,
      matchStatus: isFinished ? "FT" : (isLive ? "LIVE" : "NS"),
      mainPick: mainPickDisplay,
      alternative: smartPick.alternative,
      halfTimeScore: halfTimeDisplayScore,
      fullTimeScore: fullTimeForecast,
      alternativeFullTimeScore: isFinished ? `${matchInfo.homeScore}-${matchInfo.awayScore}` : "Doğru skor oranı verisi bulunmadı; ikinci skor uydurulmadı",
      surprise: isFinished ? surpriseDisplay : (smartPick.surprise || surpriseDisplay),
      marketDirection: isLive
        ? (odds.liveOdds?.source && hasUsableGoalMarketOdds(odds.liveOdds)
            ? `Canlı oran kaynağı: ${odds.liveOdds.source} · ${odds.liveOdds.movement?.trend || "hareket ölçülmedi"} · ${odds.liveOdds.movement?.state || "ilk ölçüm bekleniyor"}`
            : (odds.source && hasUsableGoalMarketOdds(odds) ? `Maç önü referans oranı: ${odds.source}; canlı gol oranı/hareketi bulunamadı` : "Canlı ve maç önü gol oranı bulunamadı"))
        : (odds.source ? `Oran kaynağı: ${odds.source} · ${odds.movement?.trend || "hareket ölçülmedi"} · ${odds.movement?.state || "ilk ölçüm bekleniyor"}` : "Piyasa oranı bulunamadı"),
      confidence: confidenceScore > 0 ? `Piyasa ima olasılığı · %${confidenceScore} (başarı garantisi değildir)` : "Gerçek pazar oranı yok; güven yüzdesi hesaplanamadı",
      statsAvailable: liveStats.length > 0,
      stats: liveStats,
      history: {
        available: historyData.total > 0,
        sampleSize: historyData.total,
        over05Percent: historyData.ft05Pct,
        over15Percent: historyData.over15Pct,
        over25Percent: historyData.over25Pct,
        over35Percent: historyData.over35Pct,
        bttsPercent: historyData.bttsPct,
        ht00Percent: historyData.ht00Pct,
        ht05Percent: historyData.ht05Pct,
        ht15Percent: historyData.ht15Pct,
        ht25Percent: historyData.ht25Pct,
        home05Percent: historyData.home05Pct,
        away05Percent: historyData.away05Pct,
        home15Percent: historyData.home15Pct,
        away15Percent: historyData.away15Pct,
        htHome05Percent: historyData.htHome05Pct,
        htAway05Percent: historyData.htAway05Pct,
        topFullTimeScores: historyData.ftScores || [],
        topHalfTimeScores: historyData.htScores || [],
        sampleBasis: historyData.source || "unavailable",
        marketProbabilities: smartPick.marketProbabilities || {},
        resultDistribution: { "MS 1": { percent: historyData.ms1Pct }, "MS X": { percent: historyData.msXPct }, "MS 2": { percent: historyData.ms2Pct } }
      },
      oddsMovement: isLive ? (odds.liveOdds?.movement || null) : null,
      marketAnalysis: smartPick.marketAnalysis || [],
      reasons: [smartPick.rationale, confidenceScore > 0 ? `Piyasa ima olasılığı: %${confidenceScore}; doğrulanmış başarı oranı değildir.` : "Gerçek pazar oranı yok; güven yüzdesi hesaplanmadı."]
    });
  } catch (error) {
    res.status(502).json({ error: "Analiz üretilemedi.", detail: error.message });
  }
});


async function persistTrackedPick(draftId, entry) {
  if (!pool) return;
  try {
    await initDatabase();
    await pool.query(`INSERT INTO telegram_result_tracking (id, payload, updated_at)
      VALUES ($1, $2::jsonb, CURRENT_TIMESTAMP)
      ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = CURRENT_TIMESTAMP`,
      [String(draftId), JSON.stringify(entry)]);
  } catch (error) {
    console.warn(`[Result tracker DB save] ${draftId}: ${error.message}`);
  }
}

async function registerTelegramPicks(draftId, picks, sourceLabel = "WinScope Telegram") {
  const valid = (Array.isArray(picks) ? picks : []).filter(p => p && Number(p.fixtureId) > 0 && p.market);
  if (!valid.length) return;
  const entry = {
    sourceLabel,
    picks: valid.map(p => ({
      fixtureId: Number(p.fixtureId), home: p.home || "Ev sahibi", away: p.away || "Deplasman",
      market: String(p.market), league: p.league || "", resultSent: false, won: null
    })),
    checked: false
  };
  activeSentCoupons.set(String(draftId), entry);
  await persistTrackedPick(draftId, entry);
}

async function restoreTrackedPicks() {
  if (!pool) return;
  try {
    await initDatabase();
    const result = await pool.query("SELECT id, payload FROM telegram_result_tracking");
    for (const row of result.rows) {
      if (row.payload && Array.isArray(row.payload.picks)) { activeSentCoupons.set(String(row.id), row.payload); for (const pick of row.payload.picks) if (pick.resultSent !== true) notifiedLiveFixtures.add(Number(pick.fixtureId)); }
    }
    if (result.rows.length) console.log(`[Result tracker] ${result.rows.length} takip kaydı veritabanından geri yüklendi.`);
  } catch (error) {
    console.warn(`[Result tracker restore] ${error.message}`);
  }
}

async function deleteTrackedPick(draftId) {
  if (!pool) return;
  try {
    await initDatabase();
    await pool.query("DELETE FROM telegram_result_tracking WHERE id = $1", [String(draftId)]);
  } catch (error) {
    console.warn(`[Result tracker DB delete] ${draftId}: ${error.message}`);
  }
}

function gradePick(marketText, homeScore, awayScore, halfHome = null, halfAway = null) {
  const market = String(marketText || "").toLocaleUpperCase("tr-TR").replace(/\s+/g, " ").trim();
  const h = Number(homeScore), a = Number(awayScore);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  const isHalf = /^(?:İY\b|İLK YARI\b|1\. YARI\b|HALF TIME\b)/.test(market);
  if (isHalf && (halfHome == null || halfAway == null || !Number.isFinite(Number(halfHome)) || !Number.isFinite(Number(halfAway)))) return null;
  const gh = isHalf ? Number(halfHome) : h;
  const ga = isHalf ? Number(halfAway) : a;
  const total = gh + ga;

  if (/KG VAR|BTTS YES/.test(market)) return gh > 0 && ga > 0;
  if (/KG YOK|BTTS NO/.test(market)) return gh === 0 || ga === 0;

  // Team goal markets must grade the selected team's goals, not the match total.
  const homeOver = market.match(/(?:EV|EV SAHİBİ|HOME)\s*(\d+(?:\.\d+)?)\s*\+?\s*ÜST/);
  if (homeOver) return gh > Number(homeOver[1]);
  const awayOver = market.match(/(?:DEP|DEPLASMAN|AWAY)\s*(\d+(?:\.\d+)?)\s*\+?\s*ÜST/);
  if (awayOver) return ga > Number(awayOver[1]);
  const homeUnder = market.match(/(?:EV|EV SAHİBİ|HOME)\s*(\d+(?:\.\d+)?)\s*ALT/);
  if (homeUnder) return gh < Number(homeUnder[1]);
  const awayUnder = market.match(/(?:DEP|DEPLASMAN|AWAY)\s*(\d+(?:\.\d+)?)\s*ALT/);
  if (awayUnder) return ga < Number(awayUnder[1]);

  const over = market.match(/(?:MS\s*)?(\d+(?:\.\d+)?)\s*ÜST/);
  if (over) return total > Number(over[1]);
  const under = market.match(/(?:MS\s*)?(\d+(?:\.\d+)?)\s*ALT/);
  if (under) return total < Number(under[1]);
  if (/MS 1(?:\s|$)/.test(market)) return h > a;
  if (/MS X(?:\s|$)|BERABERLİK/.test(market)) return h === a;
  if (/MS 2(?:\s|$)/.test(market)) return h < a;
  return null;
}

async function fetchFixtureResult(fixtureId) {
  const payload = await cachedProviderRequest(`result:${fixtureId}`, `/fixtures?id=${encodeURIComponent(fixtureId)}`, 60_000);
  const rows = payload.response || payload.data || [];
  if (!rows.length) return null;
  const normalized = normalizeProviderMatch(rows[0]);
  return { ...normalized, raw: rows[0] };
}

function isPreMatchCouponMarketAllowed(marketText) {
  const market = String(marketText || "").toLocaleUpperCase("tr-TR").replace(/\s+/g, " ").trim();
  // Günün maç önü kuponunda İY/MS 0.5 ve 1.5 toplam gol çizgileri YASAK.
  // Yalnızca daha anlamlı veri desteği varsa takım golü 1.5+, MS 2.5/3.5 ÜST
  // veya KG VAR kullanılabilir. İY pazarları günlük kupona alınmaz; canlıda ayrı değerlendirilir.
  return /^(EV\s*1[.,]5\s*ÜST|DEP\s*1[.,]5\s*ÜST|MS\s*2[.,]5\s*ÜST|MS\s*3[.,]5\s*ÜST|KG\s*VAR)$/.test(market);
}

function selectPreMatchCouponMarket(evalData) {
  const history = evalData?.historyData || {};
  const odds = evalData?.odds || {};
  const markets = [
    { label: "MS 2.5 ÜST", historyKey: "over25Pct", overKey: "over25", underKey: "under25" },
    { label: "MS 3.5 ÜST", historyKey: "over35Pct", overKey: "over35", underKey: "under35" },
    { label: "EV 1.5 ÜST", historyKey: "home15Pct", overKey: "homeOver15", underKey: "homeUnder15" },
    { label: "DEP 1.5 ÜST", historyKey: "away15Pct", overKey: "awayOver15", underKey: "awayUnder15" },
    { label: "KG VAR", historyKey: "bttsPct", overKey: "bttsYes", underKey: "bttsNo" }
  ];

  const candidates = markets.map(m => {
    const historicalFrequency = toNumber(history[m.historyKey]);
    const over = toNumber(odds[m.overKey]);
    const under = toNumber(odds[m.underKey]);
    if (historicalFrequency == null || over == null || over <= 1) return null;
    const marketProbability = under != null && under > 1
      ? (100 * (1 / over) / ((1 / over) + (1 / under)))
      : (100 / over);
    const source = odds.sources?.[m.overKey] || odds.source || null;
    if (!source) return null;
    return {
      label: m.label,
      historicalFrequency,
      marketProbability: Number(marketProbability.toFixed(1)),
      source,
      rankScore: historicalFrequency * 0.55 + marketProbability * 0.45
    };
  }).filter(Boolean)
    .filter(m => m.historicalFrequency >= 70)
    .sort((a, b) => b.rankScore - a.rankScore);

  return candidates[0] || null;
}

function isLateZeroZeroMarketSupported(evalData, fixture) {
  const market = String(evalData?.smartPick?.mainPick || "").toLocaleUpperCase("tr-TR").trim();
  if (!/^MS\s*0[.,]5\s*ÜST$/.test(market)) return false;
  const minute = Number(fixture?.minute || 0);
  const goals = Number(fixture?.homeScore || 0) + Number(fixture?.awayScore || 0);
  const h = evalData?.historyData || {};
  const stats = Array.isArray(evalData?.liveStats) ? evalData.liveStats : [];
  let shotsOnTarget = 0, totalShots = 0;
  for (const team of stats) for (const st of (Array.isArray(team.statistics) ? team.statistics : [])) {
    const n = toNumber(st.value) || 0;
    const type = String(st.type || "").toLowerCase();
    if (type === "shots on goal" || type === "shots on target") shotsOnTarget += n;
    if (type === "total shots") totalShots += n;
  }
  const o = evalData?.odds?.liveOdds;
  return minute >= 70 && minute <= 76 && goals === 0 && h.total >= 30 && Number(h.ft05Pct) >= 70 &&
    stats.length >= 2 && (shotsOnTarget >= 1 || totalShots >= 5) &&
    Boolean(o?.isLive && [o.over05, o.over15, o.over25, o.bttsYes].some(v => v != null));
}

async function generateLiveCouponLogic() {
  const diagnostics = {
    liveFixtures: 0, supportedLeague: 0, evaluated: 0, withLiveStats: 0,
    withRealOdds: 0, withHistory30: 0, withOddsMovement: 0, strongCandidates: 0, evaluationErrors: 0
  };
  try {
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 30_000);
    const rawMatches = payload.response || [];
    diagnostics.liveFixtures = rawMatches.length;

    const liveCandidates = rawMatches.map(raw => ({ raw, f: normalizeProviderMatch(raw) }))
      .filter(({ f }) => ["LIVE", "HT"].includes(f.status) &&
        f.minute != null && f.minute >= 10 && f.minute <= 80)
      .filter(({ f }) => isStrictIddaaMatch(f));
    diagnostics.supportedLeague = liveCandidates.length;

    liveCandidates.sort((a, b) => {
      const aScore = (a.f.minute >= 20 && a.f.minute <= 75 ? 2 : 0) + (a.f.homeScore + a.f.awayScore <= 2 ? 1 : 0);
      const bScore = (b.f.minute >= 20 && b.f.minute <= 75 ? 2 : 0) + (b.f.homeScore + b.f.awayScore <= 2 ? 1 : 0);
      return bScore - aScore || Number(a.f.minute) - Number(b.f.minute);
    });

    // Bounded round-robin batch: limits API use without permanently ignoring later fixtures.
    const batchSize = Math.min(8, liveCandidates.length);
    const startAt = liveCandidates.length ? liveCouponScanCursor % liveCandidates.length : 0;
    const batch = liveCandidates.length
      ? Array.from({ length: batchSize }, (_, i) => liveCandidates[(startAt + i) % liveCandidates.length])
      : [];
    if (liveCandidates.length) liveCouponScanCursor = (startAt + batch.length) % liveCandidates.length;
    const validMatches = [];
    const analyzedMatches = [];
    for (const { raw, f } of batch) {
      try {
        diagnostics.evaluated++;
        const evalData = await evaluateMatchAdvanced(f.id, raw);
        if (evalData.liveStats?.length >= 2) diagnostics.withLiveStats++;
        if (evalData.odds?.liveOdds?.isLive && [evalData.odds.liveOdds.over05, evalData.odds.liveOdds.over15, evalData.odds.liveOdds.over25, evalData.odds.liveOdds.over35, evalData.odds.liveOdds.homeOver05, evalData.odds.liveOdds.awayOver05, evalData.odds.liveOdds.homeOver15, evalData.odds.liveOdds.awayOver15, evalData.odds.liveOdds.bttsYes].some(v => v != null)) diagnostics.withRealOdds++;
        if (evalData.odds?.liveOdds?.movement?.previousObservedAt) diagnostics.withOddsMovement++;
        if (evalData.historyData?.total >= 30) diagnostics.withHistory30++;

        // Keep a visible analysis for each evaluated fixture, even when it is not a coupon pick.
        analyzedMatches.push({
          fixtureId: f.id, iddaaCode: f.iddaaCode, home: f.home, away: f.away,
          league: f.league, minute: f.minute, currentScore: `${f.homeScore}-${f.awayScore}`,
          market: evalData.smartPick?.mainPick || "ANALİZ: NET TERCİH YOK",
          alternative: evalData.smartPick?.alternative || "—",
          historicalFrequency: evalData.smartPick?.confidence ?? null,
          sampleSize: evalData.historyData?.total || 0,
          rationale: evalData.smartPick?.rationale || "Analiz gerekçesi oluşturulamadı.",
          marketDirection: evalData.odds?.liveOdds?.movement?.trend || (hasUsableGoalMarketOdds(evalData.odds) ? "Canlı hareket yok; maç önü referans oranı" : "Hareket ölçümü bekleniyor"),
          oddsBasis: evalData.smartPick?.oddsBasis || getOddsBasis(evalData.odds, true),
          hasLiveStats: (evalData.liveStats?.length || 0) >= 2,
          hasLiveOdds: Boolean(evalData.odds?.liveOdds?.isLive && hasUsableGoalMarketOdds(evalData.odds.liveOdds)),
          hasReferenceOdds: hasUsableGoalMarketOdds(evalData.odds),
          markets: { ht00: evalData.historyData?.ht00Pct, ht05: evalData.historyData?.ht05Pct, ht15: evalData.historyData?.ht15Pct, ht25: evalData.historyData?.ht25Pct, htHome05: evalData.historyData?.htHome05Pct, htAway05: evalData.historyData?.htAway05Pct, ft05: evalData.historyData?.ft05Pct, ft15: evalData.historyData?.over15Pct, ft25: evalData.historyData?.over25Pct, ft35: evalData.historyData?.over35Pct, home05: evalData.historyData?.home05Pct, away05: evalData.historyData?.away05Pct, btts: evalData.historyData?.bttsPct, ms1: evalData.historyData?.ms1Pct, msx: evalData.historyData?.msXPct, ms2: evalData.historyData?.ms2Pct },
          topHalfTimeScores: evalData.historyData?.htScores || [],
          topFullTimeScores: evalData.historyData?.ftScores || []
        });

        const specialLateZeroZero = isLateZeroZeroMarketSupported(evalData, f);
        const hasMarketReferenceOdds = hasUsableGoalMarketOdds(evalData.odds?.liveOdds) || hasUsableGoalMarketOdds(evalData.odds);
        const qualifies = isActionableMarket(evalData.smartPick?.mainPick) &&
          evalData.historyData?.total >= 30 && evalData.smartPick?.confidence >= 65 &&
          evalData.liveStats?.length >= 2 && hasMarketReferenceOdds &&
          (!/^MS\s*0[.,]5\s*ÜST$/i.test(String(evalData.smartPick?.mainPick || "")) || specialLateZeroZero);

        if (qualifies) {
          diagnostics.strongCandidates++;
          validMatches.push({ f, evalData });
        }
      } catch (e) {
        diagnostics.evaluationErrors++;
        console.warn(`[Live coupon evaluation] fixture=${f.id}: ${e.message}`);
      }
    }

    validMatches.sort((a, b) => (b.evalData.smartPick.confidence || 0) - (a.evalData.smartPick.confidence || 0));
    const picks = validMatches.slice(0, 3).map(({ f, evalData }) => ({
      fixtureId: f.id,
      iddaaCode: f.iddaaCode,
      home: f.home,
      away: f.away,
      league: f.league,
      minute: f.minute,
      currentScore: `${f.homeScore}-${f.awayScore}`,
      market: evalData.smartPick.mainPick,
      odd: evalData.smartPick.odd ?? null,
      historicalProbability: evalData.confidenceScore,
      historicalFrequency: evalData.smartPick.confidence,
      oddsDirection: evalData.odds?.liveOdds?.movement?.trend || "ölçüm bekleniyor",
      source: "WinScope Akıllı Canlı Analiz"
    }));

    if (!picks.length) {
      const note = `Canlı ${diagnostics.liveFixtures} maç · uygun lig/dakika ${diagnostics.supportedLeague} · analiz edilen ${diagnostics.evaluated} · canlı istatistik bulunan ${diagnostics.withLiveStats} · gerçek canlı oran bulunan ${diagnostics.withRealOdds} · önceki oran ölçümü bulunan ${diagnostics.withOddsMovement} · 30+ benzer geçmiş maç bulunan ${diagnostics.withHistory30} · eşikleri geçen ${diagnostics.strongCandidates}. İlk tarama oran hareketini ölçemez; sonraki taramalarda önceki ölçümle kıyaslanır. Veriler yetersizse kupon zorlanmaz.`;
      return {
        draftId: `live-empty-${Date.now()}`,
        date: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().split("T")[0],
        isLive: true,
        status: analyzedMatches.length ? "ANALYZED_NO_PICKS" : "NO_MATCHES",
        picks: [],
        analysisRows: analyzedMatches,
        diagnostics,
        note
      };
    }

    const coupon = {
      draftId: `live-smart-coupon-${Date.now()}`,
      date: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().split("T")[0],
      isLive: true,
      status: "PENDING_APPROVAL",
      picks,
      diagnostics,
      analysisRows: analyzedMatches,
      note: "Canlı istatistik, gerçek piyasa oranı ve en az 30 benzer tarihsel maçla filtrelendi. Yüzde, canlı kazanma olasılığı değil tarihsel gerçekleşme sıklığıdır."
    };

    let tgMsg = `🎯 <b>WINSCOPE CANLI FIRSAT KOMBİNİ</b> 🎯
🕒 Saat: ${new Date().toLocaleTimeString('tr-TR')}

`;
    coupon.picks.forEach(p => {
      tgMsg += `🏆 <b>${p.league}</b>
⚽ ${p.home} vs ${p.away}
⏱️ Dk: ${p.minute}' | Skor: ${p.currentScore}
🎯 Tercih: <b>${p.market}</b> (Benzer oranlı geçmiş maçlarda gerçekleşme sıklığı: %${p.historicalFrequency})
📉 Oran yönü: ${p.oddsDirection || "ölçüm bekleniyor"}
-------------------
`;
    });
    const telegramSent = await sendTelegramMessage(tgMsg);
    if (telegramSent) await registerTelegramPicks(coupon.draftId, coupon.picks, "Günün canlı kuponu");
    return coupon;
  } catch (error) {
    console.error("[Live coupon error]", error.message);
    return {
      draftId: `live-error-${Date.now()}`,
      date: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().split("T")[0],
      isLive: true,
      status: "ERROR",
      picks: [],
      note: `Canlı maç taraması başarısız: ${error.message}`
    };
  }
}

app.get("/api/coupon/live", async (_req, res) => {
  const couponData = await generateLiveCouponLogic();
  savedCoupons.set(couponData.draftId, couponData);
  res.json(couponData);
});
app.post("/api/coupon/live", async (_req, res) => {
  const couponData = await generateLiveCouponLogic();
  savedCoupons.set(couponData.draftId, couponData);
  res.json(couponData);
});

async function generateCouponLogic(dateStr) {
  const diagnostics = {
    apiFixtures: 0, prematchFixtures: 0, analyzed: 0, evaluationErrors: 0,
    history30Plus: 0, allowedMarket: 0, realOddsSource: 0, confidence70Plus: 0, qualified: 0
  };
  try {
    const payload = await cachedProviderRequest(`fixtures:${dateStr}`, `/fixtures?date=${dateStr}&timezone=Europe/Istanbul`, 5 * 60_000);
    const rawMatches = payload.response || [];
    diagnostics.apiFixtures = rawMatches.length;

    // Keep each provider fixture beside its normalized form. This avoids an extra API
    // request per match when evaluating the full bulletin.
    const fixtures = rawMatches
      .map(raw => ({ raw, match: normalizeProviderMatch(raw) }))
      .filter(({ match }) => match.status === "NS")
      .filter(({ match }) => isStrictIddaaMatch(match));
    diagnostics.prematchFixtures = fixtures.length;
    fixtures.sort((a, b) => String(a.match.fixtureDate || "").localeCompare(String(b.match.fixtureDate || "")));

    const candidates = [];
    for (const { raw, match: f } of fixtures) {
      try {
        const evalData = await evaluateMatchAdvanced(f.id, raw);
        diagnostics.analyzed++;
        const historyOk = Number(evalData.historyData?.total || 0) >= 30;
        // Evaluate each permitted coupon market independently. Previously the daily
        // coupon only tested smartPick.mainPick; if that top pick was a disallowed
        // market, a valid alternative market on the same match was silently discarded.
        const selectedMarket = historyOk ? selectPreMatchCouponMarket(evalData) : null;
        const marketOk = Boolean(selectedMarket && isPreMatchCouponMarketAllowed(selectedMarket.label));
        const oddsOk = Boolean(selectedMarket?.source);
        const confidenceOk = Number(selectedMarket?.historicalFrequency || 0) >= 70;
        if (historyOk) diagnostics.history30Plus++;
        if (marketOk) diagnostics.allowedMarket++;
        if (oddsOk) diagnostics.realOddsSource++;
        if (confidenceOk) diagnostics.confidence70Plus++;

        if (confidenceOk && historyOk && marketOk && oddsOk) {
          candidates.push({
            fixtureId: f.id,
            iddaaCode: f.iddaaCode,
            home: f.home,
            away: f.away,
            league: f.league,
            kickoff: f.fixtureDate,
            market: selectedMarket.label,
            historicalProbability: selectedMarket.historicalFrequency,
            historicalFrequency: selectedMarket.historicalFrequency,
            marketProbability: selectedMarket.marketProbability,
            sampleSize: evalData.historyData.total,
            oddsDirection: evalData.odds?.movement?.trend || "ilk ölçüm bekleniyor",
            source: selectedMarket.source
          });
        }
      } catch (e) {
        diagnostics.evaluationErrors++;
        console.warn(`[Daily coupon evaluation] fixture=${f.id}: ${e.message}`);
      }
    }

    // Scan the complete eligible bulletin before ranking; do not stop at the first two
    // matches that happen to pass. Select the strongest two by score, then sample size.
    candidates.sort((a, b) => Number(b.historicalProbability || 0) - Number(a.historicalProbability || 0) || Number(b.sampleSize || 0) - Number(a.sampleSize || 0));
    diagnostics.qualified = candidates.length;
    const picks = candidates.slice(0, 2);
    const scanNote = `Bülten: ${diagnostics.apiFixtures} maç · maç önü uygun lig: ${diagnostics.prematchFixtures} · analiz edilen: ${diagnostics.analyzed} · 30+ geçmiş örneklem: ${diagnostics.history30Plus} · izinli ve gerçek oranı bulunan pazar: ${diagnostics.allowedMarket} · gerçek oran kaynağı: ${diagnostics.realOddsSource} · seçilen pazar geçmiş sıklığı %70+: ${diagnostics.confidence70Plus} · tüm şartları geçen: ${diagnostics.qualified} · analiz hatası: ${diagnostics.evaluationErrors}. İzinli pazarlar ana tercihten bağımsız kontrol edildi; oranlar arayüzde gösterilmez.`;

    if (!picks.length) {
      return {
        draftId: `iddaa-empty-${Date.now()}`,
        date: dateStr,
        status: "NO_MATCHES",
        picks: [],
        diagnostics,
        note: `${scanNote} Kupon eşiğini geçen maç yok; seçim zorlanmadı.`
      };
    }

    const coupon = {
      draftId: `iddaa-smart-coupon-${dateStr}-${Date.now()}`,
      date: dateStr,
      status: "PENDING_APPROVAL",
      picks,
      diagnostics,
      note: scanNote
    };

    let tgMsg = `🎟️ <b>WINSCOPE GÜNÜN KUPONU</b> 🎟️
📅 Tarih: ${coupon.date}

`;
    coupon.picks.forEach(p => {
      tgMsg += `🏆 <b>${p.league}</b>
⚽ ${p.home} vs ${p.away}
🔑 İddaa Kod: ${p.iddaaCode}
🎯 Tercih: <b>${p.market}</b> (Benzer maç geçmişi: %${p.historicalProbability})
📉 Oran yönü: ${p.oddsDirection || "ölçüm bekleniyor"}
-------------------
`;
    });
    const telegramSent = await sendTelegramMessage(tgMsg);
    if (telegramSent) await registerTelegramPicks(coupon.draftId, coupon.picks, "Günün kuponu");
    return coupon;
  } catch (error) {
    console.error("[Daily coupon error]", error.message);
    return {
      draftId: `iddaa-error-${Date.now()}`,
      date: dateStr,
      status: "ERROR",
      picks: [],
      diagnostics,
      note: `Bülten taraması başarısız: ${error.message}`
    };
  }
}

app.get("/api/coupon/daily", async (req, res) => {
  const date = String(req.query.date || new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().split("T")[0]);
  const couponData = await generateCouponLogic(date);
  savedCoupons.set(couponData.draftId, couponData);
  res.json(couponData);
});
app.post("/api/coupon/daily", async (req, res) => {
  const date = String(req.body?.date || req.query.date || new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().split("T")[0]);
  const couponData = await generateCouponLogic(date);
  savedCoupons.set(couponData.draftId, couponData);
  res.json(couponData);
});

app.post("/api/coupon/approve", async (req, res) => {
  const { draftId } = req.body || {};
  let coupon = savedCoupons.get(draftId);
  if (!coupon) {
    coupon = { draftId: draftId || `approved-${Date.now()}`, date: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().split("T")[0], status: "APPROVED", picks: [] };
  }
  coupon.status = "APPROVED";
  coupon.approvedAt = new Date().toISOString();
  savedCoupons.set(coupon.draftId || draftId, coupon);

  if (pool) {
    try {
      await initDatabase();
      await pool.query("INSERT INTO user_saved_coupons (id, payload) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET payload = $2", [
        coupon.draftId || draftId, JSON.stringify(coupon)
      ]);
    } catch(e) {}
  }

  sendTelegramMessage(`✅ <b>KUPON ONAYLANDI VE KAYDEDİLDİ!</b>
🆔 Taslak: ${draftId}`);
  res.json(coupon);
});

async function getAllArchives() {
  let analyses = Array.from(savedAnalyses.values());
  let coupons = Array.from(savedCoupons.values()).filter(c => c.status === "APPROVED" || c.approvedAt);

  if (pool) {
    try {
      await initDatabase();
      const qa = await pool.query("SELECT payload FROM user_saved_analyses ORDER BY created_at DESC LIMIT 50");
      if (qa.rows.length) analyses = qa.rows.map(r => r.payload);

      const qc = await pool.query("SELECT payload FROM user_saved_coupons ORDER BY created_at DESC LIMIT 50");
      if (qc.rows.length) coupons = qc.rows.map(r => r.payload);
    } catch(e) {}
  }
  return { analyses, coupons };
}

app.get("/api/archives", async (_req, res) => {
  const data = await getAllArchives();
  res.json({ success: true, ...data });
});

app.get("/api/coupon/archive", async (req, res) => {
  const data = await getAllArchives();
  res.json({ success: true, coupons: data.coupons });
});

app.get("/api/analysis/daily", async (req, res) => {
  const data = await getAllArchives();
  res.json({ success: true, analyses: data.analyses });
});

app.post("/api/analyses/approve", async (req, res) => {
  const data = req.body || {};
  const id = `analysis-${data.fixtureId || Date.now()}`;
  const record = {
    id: Number(data.fixtureId || Date.now()),
    fixture_id: Number(data.fixtureId || 0),
    home_team: data.home || "Ev Sahibi",
    away_team: data.away || "Deplasman",
    match_date: data.matchDate || new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().split("T")[0],
    analysis: data.analysis || {},
    created_at: new Date().toISOString()
  };
  savedAnalyses.set(id, record);

  if (pool) {
    try {
      await initDatabase();
      await pool.query("INSERT INTO user_saved_analyses (id, fixture_id, payload) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET payload = $3", [
        id, record.fixture_id, JSON.stringify(record)
      ]);
    } catch(e) {}
  }

  const analysisTelegramSent = await sendTelegramMessage(`📋 <b>ANALİZ ONAYLANDI VE KAYDEDİLDİ</b>
⚽ ${record.home_team} vs ${record.away_team}
🎯 Tercih: <b>${record.analysis?.mainPick || '—'}</b>`);
  if (analysisTelegramSent && record.fixture_id && record.analysis?.mainPick && !/VERİ YETERSİZ|TERCİH YOK|Maç tamamlandı|TAKİP:|ANALİZ:/i.test(record.analysis.mainPick)) {
    await registerTelegramPicks(`analysis-${record.fixture_id}-${Date.now()}`, [{
      fixtureId: record.fixture_id, home: record.home_team, away: record.away_team,
      market: record.analysis.mainPick, league: record.league || ""
    }], "Onaylanan maç analizi");
  }
  res.json({ success: true, message: "Analiz başarıyla kaydedildi.", record });
});

app.delete("/api/archives/:type/:id", async (req, res) => {
  const { type, id } = req.params;
  if (type === 'analysis') {
    savedAnalyses.delete(`analysis-${id}`);
    if (pool) {
      try { await initDatabase(); await pool.query("DELETE FROM user_saved_analyses WHERE fixture_id = $1 OR id = $2", [Number(id), `analysis-${id}`]); } catch(e){}
    }
  } else {
    savedCoupons.delete(id);
    if (pool) {
      try { await initDatabase(); await pool.query("DELETE FROM user_saved_coupons WHERE id = $1", [id]); } catch(e){}
    }
  }
  res.json({ success: true, message: "Kayıt silindi." });
});

app.get("/api/match/:id/stats", async (req, res) => {
  const fixtureId = req.params.id;
  try {
    const data = await apiGet(`/fixtures/statistics?fixture=${fixtureId}`);
    res.json({ success: true, stats: Array.isArray(data) && data.length ? data : [] });
  } catch (e) {
    res.json({ success: true, stats: [] });
  }
});

app.get("/api/fixtures", async (req, res) => {
  const date = String(req.query.date || "");
  try {
    const payload = await cachedProviderRequest(`fixtures:${date}`, `/fixtures?date=${date}&timezone=Europe/Istanbul`, 5 * 60_000);
    const rawMatches = payload.response || [];
    const matches = rawMatches.map(m => normalizeProviderMatch(m));
    res.json({ source: "API-Football", results: matches.length, fixtures: matches, data: matches, matches });
  } catch (error) {
    res.status(502).json({ error: "Maç bülteni alınamadı." });
  }
});

app.get("/api/live", async (_req, res) => {
  try {
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 30_000);
    const rawMatches = payload.response || [];
    const matches = rawMatches.map(m => normalizeProviderMatch(m));
    res.json({ source: "API-Football", results: matches.length, fixtures: matches, data: matches, matches });
  } catch (error) {
    res.status(502).json({ error: "Canlı maçlar alınamadı." });
  }
});

// OTOMATİK TARAMA (Gerçek Zamanlı Telegram Alarm Tetikleyicisi + Sonuç Takipçisi)
const AUTO_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const notifiedLiveFixtures = new Set();
const activeSentCoupons = new Map();

async function runAutoScan() {
  try {
    console.log("[Auto-Scan Alarm Fix] Canlı maçlar ve Telegram alarmları taranıyor...");
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 30_000);
    const rawMatches = payload.response || [];
    await restoreTrackedPicks();
    
    // 1. SONUÇ TAKİBİ: fixture ID ile doğrudan sorgula; biten maç canlı listesinden çıkmış olsa da bulunur.
    for (const [draftId, couponInfo] of activeSentCoupons.entries()) {
      let allFinished = true;
      for (const pick of couponInfo.picks) {
        if (pick.resultSent) continue;
        try {
          const result = await fetchFixtureResult(pick.fixtureId);
          if (!result || result.status !== "FT") {
            allFinished = false;
            continue;
          }
          const rawScore = result.raw?.score || {};
          const rawGoals = result.raw?.goals || {};
          if (rawGoals.home == null || rawGoals.away == null) {
            allFinished = false;
            continue;
          }
          const ht = rawScore.halftime || {};
          const won = gradePick(pick.market, rawGoals.home, rawGoals.away, ht.home, ht.away);
          pick.won = won == null ? null : won;
          let sent = false;
          if (won == null) {
            sent = await sendTelegramMessage(`📊 <b>WINSCOPE MAÇ SONUCU</b>
🏆 ${pick.league || couponInfo.sourceLabel || "Maç analizi"}
⚽ ${pick.home} ${result.homeScore}-${result.awayScore} ${pick.away}
🎯 Tercih: ${pick.market}
⚠️ Sonuç otomatik değerlendirilemedi; manuel kontrol gerekli.`);
          } else {
            sent = await sendTelegramMessage(`${won ? "✅ <b>TERCİH KAZANDI</b>" : "❌ <b>TERCİH KAYBETTİ</b>"}
🏆 ${pick.league || couponInfo.sourceLabel || "Maç analizi"}
⚽ ${pick.home} ${result.homeScore}-${result.awayScore} ${pick.away}
🎯 Tercih: ${pick.market}
📌 Sonuç: ${won ? "KAZANDI" : "KAYBETTİ"}`);
          }
          if (sent) {
            pick.resultSent = true;
            await persistTrackedPick(draftId, couponInfo);
          } else {
            allFinished = false;
          }
        } catch (e) {
          allFinished = false;
          console.warn(`[Result tracker] ${pick.fixtureId}: ${e.message}`);
        }
      }
      if (couponInfo.picks.every(p => p.resultSent)) {
        const won = couponInfo.picks.filter(p => {
          // The result marker is set only after a result was sent; result state is attached below where available.
          return p.won === true;
        }).length;
        const lost = couponInfo.picks.filter(p => p.won === false).length;
        const unresolved = couponInfo.picks.filter(p => p.won == null).length;
        const summarySent = await sendTelegramMessage(`📋 <b>WINSCOPE KUPON ÖZETİ</b>
📦 ${couponInfo.sourceLabel || "Telegram kuponu"}
✅ Kazanan: ${won}
❌ Kaybeden: ${lost}
⚠️ Otomatik değerlendirilemeyen: ${unresolved}
📊 Takip edilen seçim: ${couponInfo.picks.length}`);
        if (summarySent) {
          activeSentCoupons.delete(draftId);
          await deleteTrackedPick(draftId);
        }
      }
    }

    // 2. TEK MAÇLIK DİNAMİK CANLI ANALİZ VE TELEGRAM ALARMI (10 - 80 DAKİKA ARASI)
    const validMatches = [];
    // Re-evaluate live fixtures every scan, even if an earlier alert was sent.
    // We suppress duplicate unresolved markets per fixture, not the entire fixture,
    // so a genuinely different live recommendation can be sent later in the match.
    const scanCandidates = rawMatches.map(raw => ({ raw, f: normalizeProviderMatch(raw) }))
      .filter(({ f }) => ["LIVE", "HT"].includes(f.status) && f.minute != null &&
        f.minute >= 10 && f.minute <= 80 && isStrictIddaaMatch(f))
      .sort((a, b) => {
        const aScore = (a.f.minute >= 20 && a.f.minute <= 75 ? 2 : 0) + (a.f.homeScore + a.f.awayScore <= 2 ? 1 : 0);
        const bScore = (b.f.minute >= 20 && b.f.minute <= 75 ? 2 : 0) + (b.f.homeScore + b.f.awayScore <= 2 ? 1 : 0);
        return bScore - aScore || Number(a.f.minute) - Number(b.f.minute);
      });

    const autoBatchSize = Math.min(4, scanCandidates.length);
    const autoStartAt = scanCandidates.length ? autoAlarmScanCursor % scanCandidates.length : 0;
    const autoBatch = scanCandidates.length
      ? Array.from({ length: autoBatchSize }, (_, i) => scanCandidates[(autoStartAt + i) % scanCandidates.length])
      : [];
    if (scanCandidates.length) autoAlarmScanCursor = (autoStartAt + autoBatch.length) % scanCandidates.length;

    for (const { raw: mRaw, f } of autoBatch) {
      try {
        const evalData = await evaluateMatchAdvanced(f.id, mRaw);
        const specialLateZeroZero = isLateZeroZeroMarketSupported(evalData, f);
        const hasMarketReferenceOdds = hasUsableGoalMarketOdds(evalData.odds?.liveOdds) || hasUsableGoalMarketOdds(evalData.odds);
        const qualifies = isActionableMarket(evalData.smartPick?.mainPick) &&
          evalData.historyData?.total >= 30 && evalData.smartPick?.confidence >= 65 &&
          evalData.liveStats?.length >= 2 && hasMarketReferenceOdds &&
          (!/^MS\s*0[.,]5\s*ÜST$/i.test(String(evalData.smartPick?.mainPick || "")) || specialLateZeroZero);
        if (qualifies) validMatches.push({ f, evalData });
      } catch (e) {
        console.warn(`[Auto scan evaluation] fixture=${f.id}: ${e.message}`);
      }
    }

    validMatches.sort((a, b) => b.evalData.confidenceScore - a.evalData.confidenceScore);

    // Publish the same evidence-filtered automatic scan to the UI without making
    // the browser trigger a second set of paid API requests.
    latestAutomaticLiveCoupon = {
      draftId: `auto-live-board-${Date.now()}`,
      date: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().split("T")[0],
      isLive: true,
      status: validMatches.length ? "PENDING_APPROVAL" : "ANALYZED_NO_PICKS",
      picks: validMatches.slice(0, 3).map(({ f, evalData }) => ({
        fixtureId: f.id, iddaaCode: f.iddaaCode, home: f.home, away: f.away,
        league: f.league, minute: f.minute, currentScore: `${f.homeScore}-${f.awayScore}`,
        market: evalData.smartPick.mainPick,
        historicalFrequency: evalData.smartPick.confidence,
        historicalProbability: evalData.confidenceScore,
        oddsDirection: evalData.odds?.liveOdds?.movement?.trend || "ölçüm bekleniyor",
        source: "Otomatik canlı analiz"
      })),
      analysisRows: [],
      note: validMatches.length
        ? "Otomatik canlı tarama · canlı istatistik, gerçek canlı oran veya açıkça etiketlenmiş maç önü referans oranı ve geçmiş örneklem eşiğini geçen adaylar."
        : "Otomatik tarama tamamlandı; bu turda tüm veri eşiklerini geçen canlı tercih bulunmadı."
    };

    if (validMatches.length >= 1) {
      for (const item of validMatches) {
        const proposedMarket = String(item.evalData.smartPick?.mainPick || "").toLocaleUpperCase("tr-TR").replace(/\s+/g, " ").trim();
        const sameUnresolvedMarketAlreadySent = [...activeSentCoupons.values()].some(coupon =>
          (coupon.picks || []).some(existing => Number(existing.fixtureId) === Number(item.f.id) &&
            existing.resultSent !== true &&
            String(existing.market || "").toLocaleUpperCase("tr-TR").replace(/\s+/g, " ").trim() === proposedMarket)
        );
        // Do not repeat the same still-pending pick every five minutes. But allow
        // a new market for this fixture if the live score, time, stats and odds
        // make a different selection the strongest supported candidate.
        if (sameUnresolvedMarketAlreadySent) continue;
        const draftId = `auto-live-pick-${item.f.id}-${Date.now()}`;
        const pick = {
          fixtureId: item.f.id, iddaaCode: item.f.iddaaCode,
          home: item.f.home, away: item.f.away, league: item.f.league,
          minute: item.f.minute, currentScore: `${item.f.homeScore}-${item.f.awayScore}`,
          market: item.evalData.smartPick.mainPick
        };
        const msg = `🎯 <b>WINSCOPE CANLI MAÇ ANALİZİ</b>
🏆 <b>${pick.league}</b>
⚽ ${pick.home} ${pick.currentScore} ${pick.away}
⏱️ Dakika: ${pick.minute}'
🎯 Ana tercih: <b>${pick.market}</b>
↪️ Alternatif: ${item.evalData.smartPick.alternative || "—"}
📚 Benzer geçmiş maç sıklığı: %${item.evalData.smartPick.confidence ?? "—"}
📉 Piyasa bilgisi: ${item.evalData.smartPick?.oddsBasis || getOddsBasis(item.evalData.odds, true)}
📉 Canlı oran hareketi: ${item.evalData.odds?.liveOdds?.movement?.trend || "ölçülemedi"}`;
        const sent = await sendTelegramMessage(msg);
        if (sent) {
          notifiedLiveFixtures.add(item.f.id); // informational only; no longer blocks later re-analysis
          await registerTelegramPicks(draftId, [pick], "Tekli otomatik canlı analiz");
          console.log(`[Auto-Scan OK] Tekli canlı bildirimi gönderildi: ${item.f.id}`);
        } else {
          console.warn(`[Auto-Scan] Telegram gönderimi başarısız; fixture=${item.f.id} sonraki taramada tekrar denenecek.`);
        }
      }
    }
  } catch (err) {
    console.error("[Auto-Scan Error]", err.message);
  }
}
setInterval(runAutoScan, AUTO_SCAN_INTERVAL_MS);
setTimeout(runAutoScan, 15_000);

app.get("/api/coupon/live/latest", (_req, res) => {
  res.json(latestAutomaticLiveCoupon || {
    isLive: true, status: "SCANNING", picks: [], analysisRows: [],
    note: "İlk otomatik canlı tarama hazırlanıyor."
  });
});

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "WinScope Alarm & Dynamic Goals Master", databaseConfigured: Boolean(pool) }));

app.listen(PORT, () => {
  console.log(`WinScope Alarm & Dynamic Goals Master running on port ${PORT}`);
});
