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
    "htOver05","htUnder05","htOver15","htUnder15","htOver25","htUnder25",
    "homeOver05","homeUnder05","homeOver15","homeUnder15","awayOver05","awayUnder05","awayOver15","awayUnder15",
    "bttsYes","bttsNo","handicapHome","handicapAway"];
  const combined = Object.fromEntries(keys.map(k => [k, null]));
  combined.source = null; combined.sources = {}; combined.handicapLine = null;
  for (const book of ordered) {
    const one = Object.fromEntries(keys.map(k => [k, null]));
    let handicapHomeLine = null, handicapAwayLine = null;
    for (const bet of book.bets) {
      const name = String(bet.name || "").toLowerCase();
      for (const v of (bet.values || [])) {
        const label = String(v.value ?? v.name ?? "").toLowerCase().trim();
        const n = toNumber(v.odd);
        if (n == null || n <= 1) continue;
        if (/match winner|1x2|fulltime result|winner|match result/.test(name)) {
          if (["home", "1", "team 1"].includes(label)) one.homeWin = n;
          else if (["draw", "x"].includes(label)) one.draw = n;
          else if (["away", "2", "team 2"].includes(label)) one.awayWin = n;
        } else if (/home team|home goals|team 1 total|team 1 goals/.test(name) ||
                   /away team|away goals|team 2 total|team 2 goals/.test(name)) {
          const side = /home team|home goals|team 1/.test(name) ? "home" : "away";
          for (const line of ["0.5", "1.5"]) if (label.includes(line)) {
            if (label.includes("over")) one[`${side}Over${line.replace(".", "")}`] = n;
            if (label.includes("under")) one[`${side}Under${line.replace(".", "")}`] = n;
          }
        } else if (/over\/under|goals over\/under|total goals|total/.test(name) &&
                   !/home team|away team|team total|team goals|home goals|away goals/.test(name)) {
          const isHalfTimeMarket = /first half|1st half|half time|half-time|1st period|first period/.test(name);
          for (const line of ["0.5", "1.5", "2.5", "3.5"]) if (label.includes(line)) {
            const prefix = isHalfTimeMarket ? "htOver" : "over";
            const underPrefix = isHalfTimeMarket ? "htUnder" : "under";
            if (label.includes("over")) one[`${prefix}${line.replace(".", "")}`] = n;
            if (label.includes("under")) one[`${underPrefix}${line.replace(".", "")}`] = n;
          }
        } else if (/both teams to score|both teams score|both teams/.test(name)) {
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
  // WinScope policy: only pre-match odds are used. Never fetch/use live odds.
  let preMatchOdds = null;
  try {
    const payload = await apiGet(`/odds?fixture=${encodeURIComponent(fixtureId)}`);
    preMatchOdds = parseOddsBookmakers(payload);
    if (preMatchOdds) preMatchOdds.movement = await recordLiveOddsSnapshot(fixtureId, preMatchOdds, "prematch");
  } catch (error) {
    console.warn(`[Pre-match odds unavailable] fixture=${fixtureId}: ${error.message}`);
  }
  const base = preMatchOdds || {
    source: null, sources: {}, homeWin: null, draw: null, awayWin: null,
    over05: null, under05: null, over15: null, under15: null, over25: null, under25: null,
    over35: null, under35: null, htOver05: null, htUnder05: null, htOver15: null, htUnder15: null,
    htOver25: null, htUnder25: null, homeOver05: null, homeUnder05: null, homeOver15: null,
    homeUnder15: null, awayOver05: null, awayUnder05: null, awayOver15: null, awayUnder15: null,
    bttsYes: null, bttsNo: null, handicapHome: null, handicapAway: null, handicapLine: null
  };
  return { ...base, liveOdds: null, isLive: false };
}

function isActionableMarket(marketText) {
  const market = String(marketText || "").toLocaleUpperCase("tr-TR");
  if (!market || market === "—") return false;
  if (/GERÇEKLEŞTİ|ÇİZGİ GERÇEKLEŞTİ|TAKİP:|ANALİZ:|VERİ YETERSİZ|TERCİH YOK|MAÇ TAMAMLANDI/.test(market)) return false;
  return /(?:MS\s*)?\d+(?:[.,]\d+)?\s*(?:ÜST|ALT)|KG\s*(?:VAR|YOK)|(?:EV|EV SAHİBİ|DEP|DEPLASMAN)\s*\d+(?:[.,]\d+)?\s*ÜST|MS\s*[1X2]\b|BERABERLİK/.test(market);
}

async function fetchRecentTeamForm(teamId, currentFixtureId) {
  const empty = { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, over15: 0, over25: 0, btts: 0, matches: [] };
  if (!teamId) return empty;
  try {
    const rows = await apiGet(`/fixtures?team=${encodeURIComponent(teamId)}&last=10`);
    const completed = (Array.isArray(rows) ? rows : [])
      .filter(x => Number(x.fixture?.id ?? x.id) !== Number(currentFixtureId))
      .filter(x => ['FT', 'AET', 'PEN'].includes(String(x.fixture?.status?.short || x.status || '').toUpperCase()))
      .filter(x => x.goals?.home != null && x.goals?.away != null)
      .slice(0, 5);
    const form = { ...empty, played: completed.length, matches: completed };
    for (const m of completed) {
      const isHome = Number(m.teams?.home?.id) === Number(teamId);
      const gf = Number(isHome ? m.goals.home : m.goals.away);
      const ga = Number(isHome ? m.goals.away : m.goals.home);
      form.goalsFor += gf; form.goalsAgainst += ga;
      if (gf > ga) form.wins++; else if (gf === ga) form.draws++; else form.losses++;
      if (gf + ga >= 2) form.over15++;
      if (gf + ga >= 3) form.over25++;
      if (gf > 0 && ga > 0) form.btts++;
    }
    form.avgGoalsFor = form.played ? Number((form.goalsFor / form.played).toFixed(2)) : null;
    form.avgGoalsAgainst = form.played ? Number((form.goalsAgainst / form.played).toFixed(2)) : null;
    form.over15Pct = form.played ? 100 * form.over15 / form.played : null;
    form.over25Pct = form.played ? 100 * form.over25 / form.played : null;
    form.bttsPct = form.played ? 100 * form.btts / form.played : null;
    return form;
  } catch (error) {
    console.warn(`[Team form unavailable] team=${teamId}: ${error.message}`);
    return empty;
  }
}

function formMarketSignal(label, form) {
  const home = form?.home || {}, away = form?.away || {};
  const avg = (a, b) => Number.isFinite(a) && Number.isFinite(b) ? (a + b) / 2 : (Number.isFinite(a) ? a : (Number.isFinite(b) ? b : null));
  const homeTotal = home.avgGoalsFor != null && home.avgGoalsAgainst != null ? home.avgGoalsFor + home.avgGoalsAgainst : null;
  const awayTotal = away.avgGoalsFor != null && away.avgGoalsAgainst != null ? away.avgGoalsFor + away.avgGoalsAgainst : null;
  const totalAvg = avg(homeTotal, awayTotal);
  if (/MS 0\.5 ÜST/.test(label)) return totalAvg == null ? 0 : Math.max(-4, Math.min(4, (totalAvg - 1.2) * 2));
  if (/MS 1\.5 ÜST/.test(label)) return totalAvg == null ? 0 : Math.max(-4, Math.min(4, (totalAvg - 2.0) * 2));
  if (/MS 2\.5 ÜST/.test(label)) { const v=avg(home.over25Pct,away.over25Pct); return v == null ? 0 : (v-50)*0.08; }
  if (/MS 3\.5 ÜST/.test(label)) return totalAvg == null ? 0 : Math.max(-4, Math.min(4, (totalAvg - 2.8) * 2));
  if (/KG VAR/.test(label)) { const v=avg(home.bttsPct,away.bttsPct); return v == null ? 0 : (v-50)*0.08; }
  if (/EV 0\.5 ÜST/.test(label)) return home.avgGoalsFor == null ? 0 : Math.max(-4, Math.min(4, (home.avgGoalsFor-0.8)*3));
  if (/DEP 0\.5 ÜST/.test(label)) return away.avgGoalsFor == null ? 0 : Math.max(-4, Math.min(4, (away.avgGoalsFor-0.8)*3));
  if (/EV 1\.5 ÜST/.test(label)) return home.avgGoalsFor == null ? 0 : Math.max(-4, Math.min(4, (home.avgGoalsFor-1.3)*3));
  if (/DEP 1\.5 ÜST/.test(label)) return away.avgGoalsFor == null ? 0 : Math.max(-4, Math.min(4, (away.avgGoalsFor-1.3)*3));
  if (label === 'MS 1') return home.played ? (home.wins-home.losses)*0.6 : 0;
  if (label === 'MS 2') return away.played ? (away.wins-away.losses)*0.6 : 0;
  return 0;
}

function decideSmartMarket(historyData, odds, currentTotalGoals, liveStats, matchInfo, teamForm = null) {
  const o = odds || {};
  const live = Array.isArray(liveStats) ? liveStats : [];
  const minute = Number(matchInfo?.minute || 0);
  const isLive = !!matchInfo && (matchInfo.status === "LIVE" || matchInfo.status === "HT" || (minute > 0 && matchInfo.status !== "FT" && matchInfo.status !== "NS"));
  const goals = Number(currentTotalGoals || 0);
  const homeScoreNow = Number(matchInfo?.homeScore || 0), awayScoreNow = Number(matchInfo?.awayScore || 0);
  let shotsOnTarget = 0, totalShots = 0, corners = 0, dangerousAttacks = 0;
  for (const team of live) for (const st of (Array.isArray(team.statistics) ? team.statistics : [])) {
    const n = toNumber(st.value) || 0;
    const type = String(st.type || "").toLowerCase();
    if (type === "shots on goal" || type === "shots on target") shotsOnTarget += n;
    if (type === "total shots") totalShots += n;
    if (type.includes("corner")) corners += n;
    if (type.includes("dangerous attack")) dangerousAttacks += n;
  }
  // The odds reference is always pre-match odds (o); never use live odds or historical frequencies.
  const paired = (over, under) => {
    const a = toNumber(o[over]), b = toNumber(o[under]);
    if (a == null || b == null || a <= 1 || b <= 1) return null;
    const pa = 1 / a, pb = 1 / b;
    return 100 * pa / (pa + pb);
  };
  const implied = {
    over05Pct: paired("over05", "under05"), over15Pct: paired("over15", "under15"),
    over25Pct: paired("over25", "under25"), over35Pct: paired("over35", "under35"),
    ht05Pct: paired("htOver05", "htUnder05"), ht15Pct: paired("htOver15", "htUnder15"),
    ht25Pct: paired("htOver25", "htUnder25"), home05Pct: paired("homeOver05", "homeUnder05"),
    away05Pct: paired("awayOver05", "awayUnder05"), home15Pct: paired("homeOver15", "homeUnder15"),
    away15Pct: paired("awayOver15", "awayUnder15"), bttsPct: null
  };
  const yes = toNumber(o.bttsYes), no = toNumber(o.bttsNo);
  if (yes != null && no != null && yes > 1 && no > 1) implied.bttsPct = 100 * (1 / yes) / ((1 / yes) + (1 / no));

  const prematchMarkets = [
    { label: "EV 1.5 ÜST", key: "home15Pct", homeTeam: true },
    { label: "DEP 1.5 ÜST", key: "away15Pct", awayTeam: true },
    { label: "MS 2.5 ÜST", key: "over25Pct", totalLine: 2.5 },
    { label: "MS 3.5 ÜST", key: "over35Pct", totalLine: 3.5 },
    { label: "KG VAR", key: "bttsPct" }
  ];
  const liveMarkets = [
    { label: "İY 0.5 ÜST", key: "ht05Pct", half: true, line: 0.5 },
    { label: "İY 1.5 ÜST", key: "ht15Pct", half: true, line: 1.5 },
    { label: "İY 2.5 ÜST", key: "ht25Pct", half: true, line: 2.5 },
    { label: "MS 0.5 ÜST", key: "over05Pct", totalLine: 0.5 },
    { label: "MS 1.5 ÜST", key: "over15Pct", totalLine: 1.5 },
    { label: "MS 2.5 ÜST", key: "over25Pct", totalLine: 2.5 },
    { label: "MS 3.5 ÜST", key: "over35Pct", totalLine: 3.5 },
    { label: "KG VAR", key: "bttsPct" },
    { label: "EV 0.5 ÜST", key: "home05Pct", homeTeam: true },
    { label: "DEP 0.5 ÜST", key: "away05Pct", awayTeam: true }
  ];
  let candidates = (isLive ? liveMarkets : prematchMarkets).map(m => ({ ...m, marketPct: implied[m.key] }));
  candidates = candidates.filter(c => c.marketPct != null);
  if (isLive) {
    // Live statistics are useful context; live prices are never requested or consulted.
    candidates = candidates.filter(c => {
      if (c.half && minute >= 45) return false;
      if (c.totalLine != null && goals > c.totalLine) return false; // line already cleared
      if (c.homeTeam && homeScoreNow >= (c.label.includes("1.5") ? 2 : 1)) return false;
      if (c.awayTeam && awayScoreNow >= (c.label.includes("1.5") ? 2 : 1)) return false;
      if (c.label === "KG VAR" && homeScoreNow > 0 && awayScoreNow > 0) return false; // already settled
      return true;
    });
  }
  const liveSupport = live.length >= 2 ? Math.min(12, shotsOnTarget * 1.1 + totalShots * 0.25 + corners * 0.3 + dangerousAttacks * 0.08) : 0;
  const movement = o.movement || {};
  const ahHome = toNumber(o.handicapHome), ahAway = toNumber(o.handicapAway), ahLine = toNumber(o.handicapLine);
  let ahFavoredSide = null;
  if (ahHome != null && ahAway != null && ahHome > 1 && ahAway > 1) {
    if (ahLine != null && ahLine < 0) ahFavoredSide = "home";
    else if (ahLine != null && ahLine > 0) ahFavoredSide = "away";
    else if (ahHome < ahAway) ahFavoredSide = "home";
    else if (ahAway < ahHome) ahFavoredSide = "away";
  }
  for (const c of candidates) {
    // Odds-only baseline. Live stats may support a live pick; no historical percentages/form are used.
    c.rankScore = c.marketPct;
    if (isLive) {
      if (live.length < 2) c.rankScore -= 12;
      else c.rankScore += liveSupport;
    }
    // A.H. -0.5 / handicap prices are supporting direction only, never a standalone pick.
    if (ahFavoredSide === "home" && (c.label.startsWith("EV ") || c.label === "KG VAR")) c.rankScore += 2;
    if (ahFavoredSide === "away" && (c.label.startsWith("DEP ") || c.label === "KG VAR")) c.rankScore += 2;
    if (movement?.changed && movement?.trend === "oran düşüyor" && c.marketPct != null) c.rankScore += 1;
  }
  candidates.sort((a, b) => b.rankScore - a.rankScore);
  const top = candidates[0] || null;
  const next = candidates.find(c => c.label !== top?.label) || null;
  const statsAvailable = live.length >= 2;
  const mainPick = top ? top.label : "PİYASA VERİSİ YETERSİZ";
  const rationale = top
    ? `${isLive ? "Canlı maç istatistikleri" : "Maç önü piyasa oranları"} ve maç önü oran referansı değerlendirildi. İlgili pazarın normalize edilmiş piyasa göstergesi %${top.marketPct.toFixed(1)}. ${isLive ? (statsAvailable ? `Canlı istatistik desteği: ${shotsOnTarget} isabetli şut, ${totalShots} toplam şut, ${corners} korner.` : "Canlı istatistikler henüz yeterli değil.") : "Geçmiş maç verisi kullanılmadı."} A.H. yalnızca destekleyici yön sinyalidir. Oran kaynağı: ${o.source || "bulunamadı"}.`
    : `Uygun tercih üretilemedi: gerekli maç önü oranları bulunamadı${isLive ? " veya canlı maç istatistikleri yetersiz" : ""}. Geçmiş maç verisi ve canlı oran kullanılmadı.`;
  const confidence = top ? Math.round(Math.max(0, Math.min(95, top.marketPct + (isLive ? (statsAvailable ? Math.min(8, liveSupport / 2) : -10) : 0)))) : null;
  return {
    mainPick, alternative: next ? next.label : "—", confidence, rationale,
    marketProbabilities: {}, marketImpliedProbabilities: implied,
    surprise: "Geçmiş veri kullanılmadığı için sürpriz skor üretilmedi",
    oddsSource: o.source || null,
    oddsDirection: movement?.trend || "Maç önü oran hareketi ölçülemedi"
  };
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

  // Historical results/frequencies are intentionally disabled by current WinScope rules.
  const historyData = { total: 0, ft05Pct: null, over15Pct: null, over25Pct: null, over35Pct: null, bttsPct: null,
    ht00Pct: null, ht05Pct: null, ht15Pct: null, ht25Pct: null, home05Pct: null, away05Pct: null, home15Pct: null, away15Pct: null,
    htHome05Pct: null, htAway05Pct: null, ms1Pct: null, ms2Pct: null, msXPct: null, ftScores: [], htScores: [], source: "disabled-by-policy" };

  let liveStats = [];
  try {
    const statsRes = await apiGet(`/fixtures/statistics?fixture=${fixtureId}`);
    if (Array.isArray(statsRes) && statsRes.length > 0) liveStats = statsRes;
  } catch (e) {}

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

  // No past-match form: use only current fixture data and pre-match odds.
  const teamForm = null;
  const smartPick = decideSmartMarket(historyData, odds, currentTotalGoals, liveStats, matchInfo, teamForm);
  let halfTimeDisplayScore = "";
  let surpriseDisplay = "Veri yetersiz";
  let mainPickDisplay = smartPick.mainPick;
  if (isFinished) {
    halfTimeDisplayScore = `${matchInfo.htHomeScore ?? "?"}-${matchInfo.htAwayScore ?? "?"} (İY)`;
    surpriseDisplay = "Maç Bitti";
    mainPickDisplay = "Maç tamamlandı — sonuç analizi";
  } else if (isLive) {
    halfTimeDisplayScore = `${matchInfo.htHomeScore ?? "?"}-${matchInfo.htAwayScore ?? "?"} (Canlı ${liveMin}')`;
    if (currentTotalGoals >= 3) mainPickDisplay = "MS 2.5 ÜST (çizgi gerçekleşti)";
  } else {
    halfTimeDisplayScore = "İY skor tahmini için yeterli veri yok";
  }
  const confidenceScore = smartPick.confidence != null ? Math.round(smartPick.confidence) : 0;

  return {
    matchInfo, isLive, isFinished, odds, historyData, liveStats, teamForm,
    halfTimeDisplayScore, surpriseDisplay, mainPickDisplay, isSecondHalf, smartPick,
    confidenceScore
  };
}

app.get("/api/match/:id/analyze", async (req, res) => {
  const fixtureId = req.params.id;
  try {
    const resEval = await evaluateMatchAdvanced(fixtureId);
    const { matchInfo, isLive, isFinished, odds, historyData, liveStats, halfTimeDisplayScore, surpriseDisplay, mainPickDisplay, isSecondHalf, smartPick, confidenceScore } = resEval;

    res.json({
      fixtureId: Number(fixtureId),
      iddaaCode: matchInfo.iddaaCode,
      matchStatus: isFinished ? "FT" : (isLive ? "LIVE" : "NS"),
      mainPick: mainPickDisplay,
      alternative: smartPick.alternative,
      halfTimeScore: halfTimeDisplayScore,
      fullTimeScore: isFinished ? `${matchInfo.homeScore}-${matchInfo.awayScore}` : "Tahmin: yeterli doğrulanmış veri yok",
      alternativeFullTimeScore: isFinished ? `${matchInfo.homeScore}-${matchInfo.awayScore}` : "—",
      surprise: isFinished ? surpriseDisplay : (smartPick.surprise || surpriseDisplay),
      marketDirection: odds.source
        ? `Maç önü oran kaynağı: ${odds.source} · ${odds.movement?.trend || "hareket ölçülmedi"} · ${odds.movement?.state || "ilk ölçüm bekleniyor"}`
        : "Maç önü piyasa oranı bulunamadı",
      confidence: confidenceScore > 0 ? `Piyasa ve maç verisi göstergesi · %${confidenceScore}` : "Güven puanı hesaplanamadı",
      statsAvailable: liveStats.length > 0,
      stats: liveStats,
      history: {
        available: false,
        sampleSize: 0,
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
        sampleBasis: "disabled-by-policy",
        marketProbabilities: smartPick.marketProbabilities || {},
        resultDistribution: { "MS 1": { percent: historyData.ms1Pct }, "MS X": { percent: historyData.msXPct }, "MS 2": { percent: historyData.ms2Pct } }
      },
      oddsMovement: odds.movement || null,
      reasons: [smartPick.rationale, confidenceScore > 0 ? `Piyasa ve maç verisi göstergesi: %${confidenceScore}` : "Piyasa verisi yetersiz; tercih üretilmedi"]
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
      market: String(p.market), league: p.league || "", resultSent: false, won: null, summaryReported: false
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
      if (row.payload && Array.isArray(row.payload.picks)) activeSentCoupons.set(String(row.id), row.payload);
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
  const isHalf = /(^|\b)(İY|İLK YARI|1\. YARI|HALF TIME)(\b|\s)/.test(market);
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
  return /^(EV\s*1[.,]5\s*ÜST|DEP\s*1[.,]5\s*ÜST|MS\s*2[.,]5\s*ÜST|MS\s*3[.,]5\s*ÜST|KG\s*VAR)$/.test(market);
}

function isLateZeroZeroMarketSupported(evalData, fixture) {
  const market = String(evalData?.smartPick?.mainPick || "").toLocaleUpperCase("tr-TR").trim();
  if (!/^MS\s*0[.,]5\s*ÜST$/.test(market)) return false;
  const minute = Number(fixture?.minute || 0);
  const goals = Number(fixture?.homeScore || 0) + Number(fixture?.awayScore || 0);
  const stats = Array.isArray(evalData?.liveStats) ? evalData.liveStats : [];
  let shotsOnTarget = 0, totalShots = 0;
  for (const team of stats) for (const st of (Array.isArray(team.statistics) ? team.statistics : [])) {
    const n = toNumber(st.value) || 0;
    const type = String(st.type || "").toLowerCase();
    if (type === "shots on goal" || type === "shots on target") shotsOnTarget += n;
    if (type === "total shots") totalShots += n;
  }
  const o = evalData?.odds || {};
  return minute >= 70 && minute <= 76 && goals === 0 &&
    stats.length >= 2 && (shotsOnTarget >= 1 || totalShots >= 5) &&
    Boolean(o.source && [o.over05, o.over15, o.over25, o.bttsYes].some(v => v != null));
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
        if (evalData.odds?.source && [evalData.odds.over05, evalData.odds.over15, evalData.odds.over25, evalData.odds.over35, evalData.odds.homeOver05, evalData.odds.awayOver05, evalData.odds.homeOver15, evalData.odds.awayOver15, evalData.odds.bttsYes].some(v => v != null)) diagnostics.withRealOdds++;
        if (evalData.odds?.movement?.previousObservedAt) diagnostics.withOddsMovement++;

        // Keep a visible analysis for each evaluated fixture, even when it is not a coupon pick.
        analyzedMatches.push({
          fixtureId: f.id, iddaaCode: f.iddaaCode, home: f.home, away: f.away,
          league: f.league, minute: f.minute, currentScore: `${f.homeScore}-${f.awayScore}`,
          market: evalData.smartPick?.mainPick || "ANALİZ: NET TERCİH YOK",
          alternative: evalData.smartPick?.alternative || "—",
          historicalFrequency: null,
          sampleSize: 0,
          rationale: evalData.smartPick?.rationale || "Analiz gerekçesi oluşturulamadı.",
          marketDirection: evalData.odds?.movement?.trend || "Maç önü oran hareketi ölçülmedi",
          hasLiveStats: (evalData.liveStats?.length || 0) >= 2,
          hasPrematchOdds: Boolean(evalData.odds?.source),
          markets: {},
          topHalfTimeScores: [],
          topFullTimeScores: []
        });

        const specialLateZeroZero = isLateZeroZeroMarketSupported(evalData, f);
        const hasPrematchReferenceOdds = Boolean(evalData.odds?.source &&
          [evalData.odds.over05, evalData.odds.over15, evalData.odds.over25, evalData.odds.over35, evalData.odds.homeOver05, evalData.odds.awayOver05, evalData.odds.homeOver15, evalData.odds.awayOver15, evalData.odds.bttsYes, evalData.odds.htOver05, evalData.odds.htOver15, evalData.odds.htOver25].some(v => v != null));
        const allowedLivePick = /^(İY\s*(?:0[.,]5|1[.,]5|2[.,]5)\s*ÜST|MS\s*(?:0[.,]5|1[.,]5|2[.,]5|3[.,]5)\s*ÜST|KG\s*VAR|EV\s*0[.,]5\s*ÜST|DEP\s*0[.,]5\s*ÜST)$/i.test(String(evalData.smartPick?.mainPick || ""));
        const qualifies = allowedLivePick && evalData.smartPick?.confidence >= 60 &&
          evalData.liveStats?.length >= 2 && hasPrematchReferenceOdds;

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
    const picks = validMatches.slice(0, 2).map(({ f, evalData }) => ({
      fixtureId: f.id,
      iddaaCode: f.iddaaCode,
      home: f.home,
      away: f.away,
      league: f.league,
      minute: f.minute,
      currentScore: `${f.homeScore}-${f.awayScore}`,
      market: evalData.smartPick.mainPick,
      odd: evalData.smartPick.odd ?? null,
      historicalProbability: null,
      historicalFrequency: null,
      oddsDirection: evalData.odds?.movement?.trend || "maç önü oran hareketi ölçülmedi",
      source: "WinScope Akıllı Canlı Analiz"
    }));

    if (!picks.length) {
      const note = `Canlı ${diagnostics.liveFixtures} maç · uygun lig/dakika ${diagnostics.supportedLeague} · analiz edilen ${diagnostics.evaluated} · canlı istatistik bulunan ${diagnostics.withLiveStats} · maç önü oranı bulunan ${diagnostics.withRealOdds} · önceki maç önü oran ölçümü bulunan ${diagnostics.withOddsMovement} · eşikleri geçen ${diagnostics.strongCandidates}. Geçmiş maç verisi ve canlı oran kullanılmaz.`;
      return {
        draftId: `live-empty-${Date.now()}`,
        date: new Date().toISOString().split("T")[0],
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
      date: new Date().toISOString().split("T")[0],
      isLive: true,
      status: "PENDING_APPROVAL",
      picks,
      diagnostics,
      analysisRows: analyzedMatches,
      note: "Canlı istatistikler ve yalnızca maç önü oran referansı kullanıldı. Geçmiş maç verisi ve canlı oran kullanılmadı."
    };

    let tgMsg = `🎯 <b>WINSCOPE CANLI FIRSAT KOMBİNİ</b> 🎯
🕒 Saat: ${new Date().toLocaleTimeString('tr-TR')}

`;
    coupon.picks.forEach(p => {
      tgMsg += `🏆 <b>${p.league}</b>
⚽ ${p.home} vs ${p.away}
⏱️ Dk: ${p.minute}' | Skor: ${p.currentScore}
🎯 Tercih: <b>${p.market}</b>
📊 Analiz: Maç önü oranı + canlı maç istatistikleri
📉 Maç önü oran yönü: ${p.oddsDirection || "ölçüm bekleniyor"}
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
      date: new Date().toISOString().split("T")[0],
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
  try {
    const payload = await cachedProviderRequest(`fixtures:${dateStr}`, `/fixtures?date=${dateStr}&timezone=Europe/Istanbul`, 5 * 60_000);
    const rawMatches = payload.response || [];
    let fixtures = rawMatches.map(m => normalizeProviderMatch(m)).filter(m => m.status === "NS" && isStrictIddaaMatch(m));

    fixtures.sort((a, b) => String(a.fixtureDate || "").localeCompare(String(b.fixtureDate || "")));
    const picks = [];
    for (const f of fixtures) {
      try {
        const evalData = await evaluateMatchAdvanced(f.id);
        if (evalData.confidenceScore >= 60 && isPreMatchCouponMarketAllowed(evalData.smartPick?.mainPick) && evalData.odds?.source) {
          picks.push({
            fixtureId: f.id,
            iddaaCode: f.iddaaCode,
            home: f.home,
            away: f.away,
            league: f.league,
            kickoff: f.fixtureDate,
            market: evalData.smartPick.mainPick,
            odd: evalData.smartPick.odd,
            marketProbability: evalData.smartPick?.marketImpliedProbabilities?.[({"EV 1.5 ÜST":"home15Pct","DEP 1.5 ÜST":"away15Pct","MS 2.5 ÜST":"over25Pct","MS 3.5 ÜST":"over35Pct","KG VAR":"bttsPct"})[evalData.smartPick?.mainPick]] ?? null,
            historicalProbability: null,
            oddsDirection: evalData.odds?.movement?.trend || "maç önü oran hareketi ölçülmedi",
            source: "Maç önü oranları"
          });
        }
      } catch (e) { continue; }
    }

    picks.sort((a, b) => (Number(b.marketProbability) || 0) - (Number(a.marketProbability) || 0));
    picks.splice(2);
    if (!picks.length) {
      return {
        draftId: `iddaa-empty-${Date.now()}`,
        date: dateStr,
        status: "NO_MATCHES",
        picks: [],
        note: "Maç önü oranlarıyla belirlenen izinli pazarlarda yeterli doğrulanmış aday bulunamadı."
      };
    }

    const coupon = {
      draftId: `iddaa-smart-coupon-${dateStr}-${Date.now()}`,
      date: dateStr,
      status: "PENDING_APPROVAL",
      picks,
      note: "Yalnızca maç önü oranları; geçmiş maç verisi kullanılmadı."
    };

    let tgMsg = `🎟️ <b>WINSCOPE GÜNÜN KUPONU</b> 🎟️
📅 Tarih: ${coupon.date}

`;
    coupon.picks.forEach(p => {
      tgMsg += `🏆 <b>${p.league}</b>
⚽ ${p.home} vs ${p.away}
🔑 İddaa Kod: ${p.iddaaCode}
🎯 Tercih: <b>${p.market}</b>
-------------------
`;
    });
    const telegramSent = await sendTelegramMessage(tgMsg);
    if (telegramSent) await registerTelegramPicks(coupon.draftId, coupon.picks, "Günün kuponu");

    return coupon;
  } catch (error) {
    return {
      draftId: `iddaa-error-${Date.now()}`,
      date: dateStr,
      status: "ERROR",
      picks: [],
      note: "Bülten taranırken hata oluştu."
    };
  }
}

app.get("/api/coupon/daily", async (req, res) => {
  const date = String(req.query.date || new Date().toISOString().split("T")[0]);
  const couponData = await generateCouponLogic(date);
  savedCoupons.set(couponData.draftId, couponData);
  res.json(couponData);
});
app.post("/api/coupon/daily", async (req, res) => {
  const date = String(req.body?.date || req.query.date || new Date().toISOString().split("T")[0]);
  const couponData = await generateCouponLogic(date);
  savedCoupons.set(couponData.draftId, couponData);
  res.json(couponData);
});

app.post("/api/coupon/approve", async (req, res) => {
  const { draftId } = req.body || {};
  let coupon = savedCoupons.get(draftId);
  if (!coupon) {
    coupon = { draftId: draftId || `approved-${Date.now()}`, date: new Date().toISOString().split("T")[0], status: "APPROVED", picks: [] };
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
    match_date: data.matchDate || new Date().toISOString().split("T")[0],
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
const BATCH_SUMMARY_INTERVAL_MS = 12 * 60 * 60 * 1000;
let lastBatchSummaryAt = Date.now();

setInterval(async () => {
  try {
    console.log("[Auto-Scan Alarm Fix] Canlı maçlar ve Telegram alarmları taranıyor...");
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 30_000);
    const rawMatches = payload.response || [];
    await restoreTrackedPicks();
    
    // 1. SONUÇ TAKİBİ: sonuçları sessizce kaydet; maç başına Telegram mesajı gönderme.
    for (const [draftId, couponInfo] of activeSentCoupons.entries()) {
      for (const pick of couponInfo.picks) {
        if (pick.resultSent) continue;
        try {
          const result = await fetchFixtureResult(pick.fixtureId);
          if (!result || result.status !== "FT") continue;
          const rawScore = result.raw?.score || {};
          const rawGoals = result.raw?.goals || {};
          if (rawGoals.home == null || rawGoals.away == null) continue;
          const ht = rawScore.halftime || {};
          const won = gradePick(pick.market, rawGoals.home, rawGoals.away, ht.home, ht.away);
          // Maç tamamlandı ve değerlendirildi; sadece true/false sonuçlar özete girer.
          pick.won = won == null ? null : won;
          pick.resultSent = true;
          pick.summaryReported = false;
          pick.finalScore = `${result.homeScore}-${result.awayScore}`;
          await persistTrackedPick(draftId, couponInfo);
        } catch (e) {
          console.warn(`[Result tracker] ${pick.fixtureId}: ${e.message}`);
        }
      }
    }

    // 2. Her 12 saatte bir, birikmiş ve daha önce özetlenmemiş sonuçları tek mesajda gönder.
    const now = Date.now();
    if (now - lastBatchSummaryAt >= BATCH_SUMMARY_INTERVAL_MS) {
      const pendingResults = [];
      for (const [draftId, couponInfo] of activeSentCoupons.entries()) {
        for (const pick of couponInfo.picks) {
          if (pick.resultSent && pick.summaryReported !== true && typeof pick.won === "boolean") {
            pendingResults.push({ draftId, couponInfo, pick });
          }
        }
      }

      if (pendingResults.length) {
        const wonCount = pendingResults.filter(x => x.pick.won === true).length;
        const lostCount = pendingResults.filter(x => x.pick.won === false).length;
        const total = wonCount + lostCount;
        const pct = total ? Math.round(wonCount / total * 100) : 0;
        const summarySent = await sendTelegramMessage(`📊 <b>WINSCOPE TOPLU KUPON ÖZETİ</b>
🕒 Dönem: Son 12 saat
🎯 Sonuçlanan tercih: <b>${total}</b>
✅ Kazandı: <b>${wonCount}</b>
❌ Kaybetti: <b>${lostCount}</b>
📈 Başarı oranı: <b>%${pct}</b>`);

        if (summarySent) {
          for (const item of pendingResults) {
            item.pick.summaryReported = true;
            await persistTrackedPick(item.draftId, item.couponInfo);
          }
        }
      }
      // Zaman penceresini ilerlet; boş pencerelerde de aynı aralık korunur.
      lastBatchSummaryAt = now;
    }

    // Tamamlanan ve özete aktarılmış takip kayıtlarını temizle.
    for (const [draftId, couponInfo] of activeSentCoupons.entries()) {
      if (couponInfo.picks.length && couponInfo.picks.every(p =>
        p.resultSent && (p.summaryReported === true || typeof p.won !== "boolean"))) {
        activeSentCoupons.delete(draftId);
        await deleteTrackedPick(draftId);
      }
    }

    // 2. YENİ 2 MAÇLIK OTOMATİK KOMBİN VE TELEGRAM ALARMI (10 - 80 DAKİKA ARASI)
    const validMatches = [];
    const scanCandidates = rawMatches.map(raw => ({ raw, f: normalizeProviderMatch(raw) }))
      .filter(({ f }) => ["LIVE", "HT"].includes(f.status) && f.minute != null &&
        f.minute >= 10 && f.minute <= 80 && isStrictIddaaMatch(f) && !notifiedLiveFixtures.has(f.id))
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
        const hasPrematchReferenceOdds = Boolean(evalData.odds?.source &&
          [evalData.odds.over05, evalData.odds.over15, evalData.odds.over25, evalData.odds.over35, evalData.odds.homeOver05, evalData.odds.awayOver05, evalData.odds.homeOver15, evalData.odds.awayOver15, evalData.odds.bttsYes, evalData.odds.htOver05, evalData.odds.htOver15, evalData.odds.htOver25].some(v => v != null));
        const allowedLivePick = /^(İY\s*(?:0[.,]5|1[.,]5|2[.,]5)\s*ÜST|MS\s*(?:0[.,]5|1[.,]5|2[.,]5|3[.,]5)\s*ÜST|KG\s*VAR|EV\s*0[.,]5\s*ÜST|DEP\s*0[.,]5\s*ÜST)$/i.test(String(evalData.smartPick?.mainPick || ""));
        const qualifies = allowedLivePick && evalData.smartPick?.confidence >= 60 &&
          evalData.liveStats?.length >= 2 && hasPrematchReferenceOdds;
        if (qualifies) validMatches.push({ f, evalData });
      } catch (e) {
        console.warn(`[Auto scan evaluation] fixture=${f.id}: ${e.message}`);
      }
    }

    validMatches.sort((a, b) => b.evalData.confidenceScore - a.evalData.confidenceScore);

    if (validMatches.length >= 2) {
      const selectedPicks = validMatches.slice(0, 2);
      const draftId = `auto-alarm-coupon-${Date.now()}`;
      
      let autoMsg = `🎯 <b>WINSCOPE CANLI FIRSAT KOMBİNİ</b> 🎯
🕒 Saat: ${new Date().toLocaleTimeString('tr-TR')}

`;
      const couponPicksArray = [];
      
      for (const item of selectedPicks) {
        notifiedLiveFixtures.add(item.f.id);
        
        couponPicksArray.push({
          fixtureId: item.f.id,
          home: item.f.home,
          away: item.f.away,
          market: item.evalData.smartPick.mainPick
        });

        autoMsg += `🏆 <b>${item.f.league}</b>
⚽ ${item.f.home} vs ${item.f.away}
⏱️ Dk: ${item.f.minute}' | Skor: ${item.f.homeScore}-${item.f.awayScore}
🎯 Tercih: <b>${item.evalData.mainPickDisplay}</b>
-------------------
`;
      }

      const autoTelegramSent = await sendTelegramMessage(autoMsg);
      if (autoTelegramSent) {
        await registerTelegramPicks(draftId, couponPicksArray, "Otomatik canlı fırsat kombini");
        console.log("[Auto-Scan OK] Telegram'a yeni 2'li kombin alarmı başarıyla gönderildi.");
      } else {
        for (const item of selectedPicks) notifiedLiveFixtures.delete(item.f.id);
        console.warn("[Auto-Scan] Telegram gönderimi başarısız; seçimler sonraki taramada yeniden denenebilir.");
      }
    }
  } catch (err) {
    console.error("[Auto-Scan Error]", err.message);
  }
}, AUTO_SCAN_INTERVAL_MS);

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "WinScope Alarm & Dynamic Goals Master", databaseConfigured: Boolean(pool) }));

app.listen(PORT, () => {
  console.log(`WinScope Alarm & Dynamic Goals Master running on port ${PORT}`);
});
