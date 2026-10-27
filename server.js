import express from "express";
import pg from "pg";
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

async function initDatabase() {
  if (!pool) return;
  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
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
    homeId: Number(match.teams?.home?.id ?? match.homeId) || null,
    awayId: Number(match.teams?.away?.id ?? match.awayId) || null,
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

// Son tamamlanmış takım maçlarını API-Football'dan alır ve gerçek skorlarla yüzdeleri hesaplar.
// İstekler önbelleğe alınır; geçmiş maç verisi canlı taramada her iki dakikada bir yeniden çekilmez.
async function fetchTeamRecentForm(teamId, currentFixtureId, season) {
  const id = Number(teamId);
  if (!Number.isFinite(id) || id <= 0) {
    return { teamId: id || null, available: false, sampleSize: 0, error: "Takım ID'si yok" };
  }
  const seasonPart = Number.isFinite(Number(season)) && Number(season) > 1900
    ? `&season=${encodeURIComponent(Number(season))}` : "";
  const pathname = `/fixtures?team=${id}&last=10${seasonPart}`;
  try {
    const payload = await cachedProviderRequest(`team-form:${id}:${season || "any"}`, pathname, 6 * 60 * 60 * 1000);
    const rows = Array.isArray(payload.response) ? payload.response : (Array.isArray(payload.data) ? payload.data : []);
    const finished = rows
      .filter(row => Number(row.fixture?.id ?? row.id) !== Number(currentFixtureId))
      .filter(row => ["FT", "AET", "PEN"].includes(String(row.fixture?.status?.short ?? row.status ?? "").toUpperCase()))
      .filter(row => Number.isFinite(Number(row.goals?.home)) && Number.isFinite(Number(row.goals?.away)))
      .sort((a, b) => new Date(b.fixture?.date || b.kickoff_utc || 0) - new Date(a.fixture?.date || a.kickoff_utc || 0))
      .slice(0, 5);
    if (!finished.length) {
      console.warn(`[Team Form] team=${id} sample=0 raw=${rows.length} season=${season || "none"}`);
      return { teamId: id, available: false, sampleSize: 0, error: "API yanıtında tamamlanmış maç bulunamadı" };
    }
    const pct = count => Math.round((count / finished.length) * 100);
    const scored = [], teamOver15 = [], conceded = [], over15 = [], over25 = [], btts = [], htOver05 = [], htOver15 = [];
    for (const row of finished) {
      const homeId = Number(row.teams?.home?.id);
      const isHome = homeId === id;
      const gf = Number(isHome ? row.goals.home : row.goals.away);
      const ga = Number(isHome ? row.goals.away : row.goals.home);
      const total = Number(row.goals.home) + Number(row.goals.away);
      const htH = row.score?.halftime?.home;
      const htA = row.score?.halftime?.away;
      scored.push(gf > 0); teamOver15.push(gf >= 2); conceded.push(ga > 0);
      over15.push(total >= 2); over25.push(total >= 3);
      btts.push(Number(row.goals.home) > 0 && Number(row.goals.away) > 0);
      if (htH != null && htA != null) {
        const htTotal = Number(htH) + Number(htA);
        htOver05.push(htTotal >= 1); htOver15.push(htTotal >= 2);
      }
    }
    const result = {
      teamId: id, available: true, sampleSize: finished.length,
      goalsScoredPct: pct(scored.filter(Boolean).length),
      teamGoalsOver15Pct: pct(teamOver15.filter(Boolean).length),
      teamGoalsOver15Count: teamOver15.filter(Boolean).length,
      goalsConcededPct: pct(conceded.filter(Boolean).length),
      over15Pct: pct(over15.filter(Boolean).length),
      over25Pct: pct(over25.filter(Boolean).length),
      over25Count: over25.filter(Boolean).length,
      bttsPct: pct(btts.filter(Boolean).length),
      bttsCount: btts.filter(Boolean).length,
      htOver05Pct: htOver05.length ? pct(htOver05.filter(Boolean).length) : null,
      htOver05Count: htOver05.length ? htOver05.filter(Boolean).length : null,
      htOver15Pct: htOver15.length ? pct(htOver15.filter(Boolean).length) : null,
      htOver15Count: htOver15.length ? htOver15.filter(Boolean).length : null,
      halftimeSampleSize: htOver05.length,
      matches: finished.map(row => ({
        date: row.fixture?.date || row.kickoff_utc || null,
        home: row.teams?.home?.name || "Ev sahibi", away: row.teams?.away?.name || "Deplasman",
        score: `${row.goals.home}-${row.goals.away}`,
        halftimeScore: row.score?.halftime?.home != null && row.score?.halftime?.away != null
          ? `${row.score.halftime.home}-${row.score.halftime.away}` : null
      }))
    };
    console.log(`[Team Form] team=${id} sample=${result.sampleSize}/5 HT=${result.halftimeSampleSize} source=API-Football cache=6h`);
    return result;
  } catch (error) {
    console.warn(`[Team Form Error] team=${id}: ${error.message}`);
    return { teamId: id, available: false, sampleSize: 0, error: error.message };
  }
}

async function fetchMatchRecentForm(fRaw, fixtureId) {
  const homeId = Number(fRaw?.teams?.home?.id);
  const awayId = Number(fRaw?.teams?.away?.id);
  const season = fRaw?.league?.season;
  const [home, away] = await Promise.all([
    fetchTeamRecentForm(homeId, fixtureId, season),
    fetchTeamRecentForm(awayId, fixtureId, season)
  ]);
  const available = home.available && away.available;
  const mean = key => home[key] != null && away[key] != null
    ? Math.round((home[key] + away[key]) / 2) : null;
  return {
    available, sampleSize: Math.min(home.sampleSize || 0, away.sampleSize || 0),
    sampleBasis: "API-Football son 5 tamamlanmış maç; yüzdeler gerçek skorlarla hesaplandı",
    home, away,
    matchPercentages: {
      over15Pct: mean("over15Pct"), over25Pct: mean("over25Pct"), bttsPct: mean("bttsPct"),
      htOver05Pct: mean("htOver05Pct"), htOver15Pct: mean("htOver15Pct")
    }
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
    const details = payload.errors && Object.keys(payload.errors).length
      ? Object.entries(payload.errors).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : String(v)}`).join("; ")
      : `HTTP ${response.status}`;
    throw new Error(`API-Football: ${details}`);
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
  // WinScope rule: use only pre-match odds. Never request live odds.
  try {
    const payload = await apiGet(`/odds?fixture=${encodeURIComponent(fixtureId)}`);
    const preMatchOdds = parseOddsBookmakers(payload);
    return preMatchOdds ? { ...preMatchOdds, liveOdds: null, isLive: false } : {
      source: null, sources: {}, homeWin: null, draw: null, awayWin: null,
      over05: null, under05: null, over15: null, under15: null, over25: null, under25: null,
      over35: null, under35: null, htOver05: null, htUnder05: null, htOver15: null, htUnder15: null,
      htOver25: null, htUnder25: null, homeOver05: null, homeUnder05: null, awayOver05: null,
      awayUnder05: null, homeOver15: null, homeUnder15: null, awayOver15: null, awayUnder15: null,
      bttsYes: null, bttsNo: null, handicapHome: null, handicapAway: null, handicapLine: null,
      liveOdds: null, isLive: false
    };
  } catch (error) {
    console.warn(`[Pre-match odds unavailable] fixture=${fixtureId}: ${error.message}`);
    return { source: null, sources: {}, liveOdds: null, isLive: false };
  }
}

function isActionableMarket(marketText) {
  const market = String(marketText || "").toLocaleUpperCase("tr-TR");
  if (!market || market === "—") return false;
  if (/GERÇEKLEŞTİ|ÇİZGİ GERÇEKLEŞTİ|TAKİP:|ANALİZ:|VERİ YETERSİZ|TERCİH YOK|MAÇ TAMAMLANDI/.test(market)) return false;
  return /(?:MS\s*)?\d+(?:[.,]\d+)?\s*(?:ÜST|ALT)|KG\s*(?:VAR|YOK)|(?:EV|EV SAHİBİ|DEP|DEPLASMAN)\s*\d+(?:[.,]\d+)?\s*ÜST|MS\s*[1X2]\b|BERABERLİK/.test(market);
}

function decideSmartMarket(_historyData, odds, currentTotalGoals, liveStats, matchInfo) {
  const o = odds || {};
  const live = Array.isArray(liveStats) ? liveStats : [];
  const minute = Number(matchInfo?.minute || 0);
  const isLive = !!matchInfo && (matchInfo.status === "LIVE" || matchInfo.status === "HT" || (minute > 0 && matchInfo.status !== "FT"));
  const goals = Number(currentTotalGoals || 0);
  let shotsOnTarget = 0, totalShots = 0, corners = 0;
  for (const team of live) for (const st of (Array.isArray(team.statistics) ? team.statistics : [])) {
    const n = toNumber(st.value) || 0, type = String(st.type || "").toLowerCase();
    if (type === "shots on goal" || type === "shots on target") shotsOnTarget += n;
    if (type === "total shots") totalShots += n;
    if (type.includes("corner")) corners += n;
  }
  const paired = (over, under) => {
    const a=toNumber(o[over]), b=toNumber(o[under]);
    return a>1 && b>1 ? 100*(1/a)/((1/a)+(1/b)) : null;
  };
  const yes=toNumber(o.bttsYes), no=toNumber(o.bttsNo);
  const probs = {
    "MS 0.5 ÜST": paired("over05","under05"), "MS 1.5 ÜST": paired("over15","under15"),
    "MS 2.5 ÜST": paired("over25","under25"), "MS 3.5 ÜST": paired("over35","under35"),
    "İY 0.5 ÜST": paired("htOver05","htUnder05"), "İY 1.5 ÜST": paired("htOver15","htUnder15"),
    "İY 2.5 ÜST": paired("htOver25","htUnder25"), "EV 0.5 ÜST": paired("homeOver05","homeUnder05"),
    "DEP 0.5 ÜST": paired("awayOver05","awayUnder05"), "EV 1.5 ÜST": paired("homeOver15","homeUnder15"),
    "DEP 1.5 ÜST": paired("awayOver15","awayUnder15"),
    "KG VAR": yes>1 && no>1 ? 100*(1/yes)/((1/yes)+(1/no)) : null
  };
  const prematchAllowed = ["EV 1.5 ÜST","DEP 1.5 ÜST","MS 2.5 ÜST","MS 3.5 ÜST","KG VAR"];
  const liveAllowed = ["İY 0.5 ÜST","İY 1.5 ÜST","İY 2.5 ÜST","MS 0.5 ÜST","MS 1.5 ÜST","MS 2.5 ÜST","MS 3.5 ÜST","KG VAR","EV 0.5 ÜST","DEP 0.5 ÜST"];
  const allowed = isLive ? liveAllowed : prematchAllowed;
  const currentHome = Number(matchInfo?.homeScore || 0), currentAway = Number(matchInfo?.awayScore || 0);
  const candidates = allowed.map(label => ({label, pct:probs[label]})).filter(x => x.pct != null).filter(x => {
    if (!isLive) return true;
    // Do not recommend a market whose goal line has already been reached.
    if (x.label.startsWith("İY ")) {
      if (minute >= 45) return false;
      const htLine = Number((x.label.match(/İY\s*(0[.,]5|1[.,]5|2[.,]5)/i) || [])[1]?.replace(',', '.') || 0.5);
      if (goals > htLine) return false;
    }
    if (x.label === "MS 0.5 ÜST" && goals >= 1) return false;
    if (x.label === "MS 1.5 ÜST" && goals >= 2) return false;
    if (x.label === "MS 2.5 ÜST" && goals >= 3) return false;
    if (x.label === "MS 3.5 ÜST" && goals >= 4) return false;
    if (x.label === "EV 0.5 ÜST" && currentHome > 0) return false;
    if (x.label === "DEP 0.5 ÜST" && currentAway > 0) return false;
    // Late-game guardrail: avoid aggressive overs requiring several new goals.
    // At 65'+, 3.5 needs at least three more goals when total is 1; do not surface it.
    if (minute >= 65 && x.label === "MS 3.5 ÜST" && goals < 3) return false;
    // At 65'+, prefer the reachable 1.5 line over 2.5 when only one goal has been scored.
    if (minute >= 65 && goals === 1 && x.label === "MS 2.5 ÜST") return false;
    // At 75'+, only keep 2.5 if two goals have already been scored (one more needed).
    if (minute >= 75 && x.label === "MS 2.5 ÜST" && goals < 2) return false;
    return live.length >= 2;
  });
  candidates.forEach(x => {
    const line = Number((x.label.match(/MS\s*(0[.,]5|1[.,]5|2[.,]5|3[.,]5)\s*ÜST/i) || [])[1]?.replace(',', '.') || 0);
    const goalsNeeded = line ? Math.max(0, Math.floor(line) + 1 - goals) : 0;
    // Penalize high goal lines late in the match; market probability alone must not dominate.
    const latePenalty = isLive && line ? Math.max(0, minute - 45) * Math.max(0, goalsNeeded - 1) * 0.22 : 0;
    x.rank = x.pct + (isLive ? Math.min(8, shotsOnTarget*.8 + totalShots*.12 + corners*.2) : 0) - latePenalty;
  });
  candidates.sort((a,b)=>b.rank-a.rank);
  const top=candidates[0], next=candidates.find(x=>x.label!==top?.label);
  const scoreText = top ? `${top.label} maç önü oranlarından hesaplanan piyasa göstergesi %${top.pct.toFixed(1)}${isLive ? `; canlı skor ${currentHome}-${currentAway}, dakika ${minute}; canlı istatistik: ${shotsOnTarget} isabetli şut, ${totalShots} şut, ${corners} korner; kalan süre ve gereken gol sayısı için geç maç filtresi uygulandı` : ""}.` : "İzin verilen pazarlarda kullanılabilir maç önü oranı bulunamadı.";
  return { mainPick:top?.label || "PİYASA ORANI YETERSİZ", alternative:next?.label || "—",
    confidence:top ? Math.round(top.pct) : null, rationale:scoreText,
    marketProbabilities:{}, marketImpliedProbabilities:probs, surprise:"Ayrı skor olasılık modelinden hesaplanır",
    oddsSource:o.source || null, oddsDirection:"Oran hareketi kullanılmıyor" };
}

function poissonPmf(k, lambda) {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}
function scorePredictionFromPrematchOdds(odds, matchInfo, liveStats = [], preferredMarket = "") {
  const o = odds || {};
  const hw = toNumber(o.homeWin), aw = toNumber(o.awayWin);
  const o25 = toNumber(o.over25);

  // Approximate expected goals from available real pre-match odds. This is a
  // heuristic model, not a calibrated probability claim.
  let lh = 1.35, la = 1.10;
  if (hw != null && aw != null) {
    if (hw < aw) { lh = 1.65; la = 1.00; }
    else if (aw < hw) { lh = 1.00; la = 1.55; }
  }
  if (o25 != null && o25 > 1 && o25 < 1.85) { lh += 0.25; la += 0.25; }
  else if (o25 != null && o25 > 2.20) { lh -= 0.15; la -= 0.15; }
  lh = Math.max(0.25, Math.min(2.8, lh));
  la = Math.max(0.25, Math.min(2.8, la));

  const status = String(matchInfo?.status || "NS").toUpperCase();
  const minute = Math.max(0, Math.min(90, Number(matchInfo?.minute) || 0));
  const isFinished = ["FT", "AET", "PEN"].includes(status);
  const isLive = !isFinished && (["LIVE", "HT", "1H", "2H"].includes(status) || minute > 0);
  const hs = Math.max(0, Number(matchInfo?.homeScore) || 0);
  const as = Math.max(0, Number(matchInfo?.awayScore) || 0);
  const baseH = isLive ? hs : 0;
  const baseA = isLive ? as : 0;

  // Scale the pre-match expectation to the time remaining. At half-time, the
  // remaining fraction is 45/90; at minute 80 it is 10/90.
  const remainingFraction = isLive ? Math.max(0, (90 - minute) / 90) : 1;
  const futureLH = isLive ? lh * remainingFraction : lh;
  const futureLA = isLive ? la * remainingFraction : la;
  const pmf = (k, lambda) => poissonPmf(k, Math.max(0, lambda));

  const scores = [];
  for (let addH = 0; addH <= 6; addH++) {
    for (let addA = 0; addA <= 6; addA++) {
      const h = baseH + addH, a = baseA + addA;
      const probability = pmf(addH, futureLH) * pmf(addA, futureLA);
      scores.push({ home: h, away: a, score: `${h}-${a}`, p: probability });
    }
  }
  scores.sort((a, b) => b.p - a.p);

  const marketSatisfiedByScore = (marketText, h, a) => {
    const market = String(marketText || "").toLocaleUpperCase("tr-TR");
    const total = h + a;
    if (/KG\s*VAR/.test(market)) return h > 0 && a > 0;
    if (/EV\s*1[.,]5\s*ÜST/.test(market)) return h >= 2;
    if (/DEP\s*1[.,]5\s*ÜST/.test(market)) return a >= 2;
    const line = market.match(/MS\s*(0[.,]5|1[.,]5|2[.,]5|3[.,]5)\s*ÜST/);
    if (line) return total > Number(line[1].replace(",", "."));
    return true;
  };
  const marketIsKnown = /KG\s*VAR|EV\s*1[.,]5\s*ÜST|DEP\s*1[.,]5\s*ÜST|MS\s*(?:0[.,]5|1[.,]5|2[.,]5|3[.,]5)\s*ÜST/i.test(String(preferredMarket || ""));
  const compatible = marketIsKnown
    ? scores.filter(x => marketSatisfiedByScore(preferredMarket, x.home, x.away))
    : scores;
  const selected = compatible.length ? compatible : scores;

  // Keep the half-time prediction internally consistent with the current score
  // during the first half; after half-time, use the actual half-time score.
  let ht;
  if (isLive && minute >= 45) {
    ht = `${matchInfo?.htHomeScore ?? hs}-${matchInfo?.htAwayScore ?? as}`;
  } else {
    const htBaseH = isLive ? hs : 0;
    const htBaseA = isLive ? as : 0;
    const firstHalfRemaining = isLive ? Math.max(0, (45 - minute) / 90) : 0.5;
    let htLH = isLive ? lh * firstHalfRemaining : lh * 0.5;
    let htLA = isLive ? la * firstHalfRemaining : la * 0.5;
    // If real first-half totals are available, adjust the first-half goal expectation
    // instead of using the same generic 0-0-biased baseline for every fixture.
    const htOver05 = toNumber(o.htOver05), htUnder05 = toNumber(o.htUnder05);
    const htOver15 = toNumber(o.htOver15), htUnder15 = toNumber(o.htUnder15);
    const htOver05Pct = htOver05 > 1 && htUnder05 > 1
      ? (1 / htOver05) / ((1 / htOver05) + (1 / htUnder05)) : null;
    const htOver15Pct = htOver15 > 1 && htUnder15 > 1
      ? (1 / htOver15) / ((1 / htOver15) + (1 / htUnder15)) : null;
    if (htOver05Pct != null || htOver15Pct != null) {
      const marketGoalIndex = (htOver05Pct != null ? htOver05Pct : 0.5) + (htOver15Pct != null ? htOver15Pct : 0.25);
      const baselineIndex = 0.5 + 0.25;
      const scale = Math.max(0.65, Math.min(1.45, marketGoalIndex / baselineIndex));
      htLH *= scale;
      htLA *= scale;
    }
    const htScores = [];
    for (let addH = 0; addH <= 4; addH++) {
      for (let addA = 0; addA <= 4; addA++) {
        htScores.push({
          score: `${htBaseH + addH}-${htBaseA + addA}`,
          p: pmf(addH, htLH) * pmf(addA, htLA)
        });
      }
    }
    htScores.sort((a, b) => b.p - a.p);
    ht = htScores[0]?.score || "0-0";
  }

  const best = selected[0] || scores[0];
  const alternative = selected.find(x => x.score !== best?.score) || scores.find(x => x.score !== best?.score);
  return {
    main: best?.score || `${baseH}-${baseA}`,
    alternative: alternative?.score || best?.score || `${baseH}-${baseA}`,
    ht,
    confidence: best ? Math.round(best.p * 1000) / 10 : null,
    basis: "WinScope Skor Olasılık Modeli · yaklaşık tahmin; garanti değildir"
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

  // Son 5 tamamlanmış maç: yüzdeler gerçek skorlarla hesaplanır ve analiz yanıtında doğrulanabilir.
  const history = await fetchMatchRecentForm(fRaw, fixtureId);

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

  const teamForm = null;
  const smartPick = decideSmartMarket(null, odds, currentTotalGoals, liveStats, matchInfo);
  const scorePrediction = scorePredictionFromPrematchOdds(odds, matchInfo, liveStats, smartPick.mainPick);
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
    halfTimeDisplayScore = `Tahmin: ${scorePrediction.ht}`;
  }
  const confidenceScore = smartPick.confidence != null ? Math.round(smartPick.confidence) : 0;

  return {
    matchInfo, isLive, isFinished, odds, liveStats, history,
    halfTimeDisplayScore, surpriseDisplay, mainPickDisplay, isSecondHalf, smartPick,
    scorePrediction, confidenceScore
  };
}

app.get("/api/match/:id/analyze", async (req, res) => {
  const fixtureId = req.params.id;
  try {
    const resEval = await evaluateMatchAdvanced(fixtureId);
    const { matchInfo, isLive, isFinished, odds, liveStats, history, halfTimeDisplayScore, surpriseDisplay, mainPickDisplay, isSecondHalf, smartPick, scorePrediction, confidenceScore } = resEval;

    res.json({
      fixtureId: Number(fixtureId),
      iddaaCode: matchInfo.iddaaCode,
      matchStatus: isFinished ? "FT" : (isLive ? "LIVE" : "NS"),
      mainPick: mainPickDisplay,
      alternative: smartPick.alternative,
      halfTimeScore: isFinished || (isLive && Number(matchInfo.minute) >= 45)
        ? `${matchInfo.htHomeScore ?? "?"}-${matchInfo.htAwayScore ?? "?"} (İY)`
        : `Tahmin: ${scorePrediction.ht}`,
      fullTimeScore: isFinished ? `${matchInfo.homeScore}-${matchInfo.awayScore}` : `Tahmin: ${scorePrediction.main}`,
      alternativeFullTimeScore: isFinished ? `${matchInfo.homeScore}-${matchInfo.awayScore}` : `Tahmin: ${scorePrediction.alternative}`,
      scorePredictionBasis: scorePrediction.basis || "Maç önü oranlarından kalibre edilen olasılık modeli",
      scoreConfidence: scorePrediction.confidence,
      surprise: isFinished ? surpriseDisplay : (smartPick.surprise || surpriseDisplay),
      marketDirection: isLive
        ? (odds.liveOdds?.source
            ? `Canlı oran kaynağı: ${odds.liveOdds.source} · ${odds.liveOdds.movement?.trend || "hareket ölçülmedi"} · ${odds.liveOdds.movement?.state || "ilk ölçüm bekleniyor"}`
            : (odds.source ? `Maç önü oran kaynağı: ${odds.source}; canlı oran bulunamadı` : "Canlı ve maç önü oranı bulunamadı"))
        : (odds.source ? `Oran kaynağı: ${odds.source} · ${odds.movement?.trend || "hareket ölçülmedi"} · ${odds.movement?.state || "ilk ölçüm bekleniyor"}` : "Piyasa oranı bulunamadı"),
      confidence: confidenceScore > 0 ? `Maç önü oran modeli · %${confidenceScore}` : "Güven puanı hesaplanamadı",
      statsAvailable: liveStats.length > 0,
      stats: liveStats,
      history,
      reasons: [
        smartPick.rationale,
        history.available
          ? `Son 5 maç verisi doğrulandı: ${matchInfo.home} gol attı %${history.home.goalsScoredPct}, MS 2.5 üst %${history.home.over25Pct}; ${matchInfo.away} gol attı %${history.away.goalsScoredPct}, MS 2.5 üst %${history.away.over25Pct}. İY yüzdeleri ${history.home.halftimeSampleSize}/${history.away.halftimeSampleSize} maçta mevcut.`
          : `Geçmiş maç verisi doğrulanamadı: ev ${history.home.sampleSize}/5, dep ${history.away.sampleSize}/5. Yüzdeler tahmin edilmedi.`,
        confidenceScore > 0 ? `Maç önü oran modeli: %${confidenceScore}` : "Yeterli doğrulanmış veri yok; kupon adayı olarak seçilmemeli"
      ],
      oddsMovement: isLive ? (odds.liveOdds?.movement || null) : null
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

function normalizeCouponMarket(marketText) {
  return String(marketText || "")
    .toLocaleUpperCase("tr-TR")
    .replace(/İ/g, "İ")
    .replace(/Ü/g, "Ü")
    .replace(/\\s+/g, " ")
    .trim();
}

function isPreMatchCouponMarketAllowed(marketText) {
  const market = normalizeCouponMarket(marketText);
  // Maç önü: yalnızca EV/DEP 1.5+, MS 2.5/3.5 üst ve KG Var.
  return /^(?:EV\s*1[.,]5\s*ÜST|DEP\s*1[.,]5\s*ÜST|MS\s*2[.,]5\s*ÜST|MS\s*3[.,]5\s*ÜST|KG\s*VAR)$/.test(market);
}

function isLiveCouponMarketAllowed(marketText) {
  const market = normalizeCouponMarket(marketText);
  // Canlı: İY 0.5/1.5/2.5 üst; MS 0.5/1.5/2.5/3.5 üst;
  // KG Var; EV/DEP 0.5 üst. Maç önü kuralları canlıya uygulanmaz.
  return /^(?:İY\s*(?:0[.,]5|1[.,]5|2[.,]5)\s*ÜST|MS\s*(?:0[.,]5|1[.,]5|2[.,]5|3[.,]5)\s*ÜST|KG\s*VAR|EV\s*0[.,]5\s*ÜST|DEP\s*0[.,]5\s*ÜST)$/.test(market);
}

function hasMeaningfulLivePressure(evalData, fixture) {
  const minute = Number(fixture?.minute || 0);
  const stats = Array.isArray(evalData?.liveStats) ? evalData.liveStats : [];
  if (minute < 20 || minute > 80 || stats.length < 2) return false;
  let shotsOnTarget = 0, totalShots = 0, corners = 0, dangerousAttacks = 0;
  for (const team of stats) for (const st of (Array.isArray(team.statistics) ? team.statistics : [])) {
    const n = toNumber(st.value) || 0;
    const type = String(st.type || "").toLowerCase();
    if (type === "shots on goal" || type === "shots on target") shotsOnTarget += n;
    if (type === "total shots") totalShots += n;
    if (type.includes("corner")) corners += n;
    if (type.includes("dangerous attack")) dangerousAttacks += n;
  }
  // Maç önü yüzde tek başına canlı fırsat değildir; canlı baskı kanıtı gerekir.
  return shotsOnTarget >= 2 || totalShots >= 8 || corners >= 5 || dangerousAttacks >= 18;
}

function isLateZeroZeroMarketSupported(evalData, fixture) {
  const market = String(evalData?.smartPick?.mainPick || "").toLocaleUpperCase("tr-TR").trim();
  if (!/^MS\s*0[.,]5\s*ÜST$/.test(market)) return false;
  const minute = Number(fixture?.minute || 0);
  const goals = Number(fixture?.homeScore || 0) + Number(fixture?.awayScore || 0);
  const stats = Array.isArray(evalData?.liveStats) ? evalData.liveStats : [];
  let shotsOnTarget = 0, totalShots = 0, dangerousAttacks = 0;
  for (const team of stats) for (const st of (Array.isArray(team.statistics) ? team.statistics : [])) {
    const n = toNumber(st.value) || 0;
    const type = String(st.type || "").toLowerCase();
    if (type === "shots on goal" || type === "shots on target") shotsOnTarget += n;
    if (type === "total shots") totalShots += n;
    if (type.includes("dangerous attack")) dangerousAttacks += n;
  }
  return minute >= 70 && minute <= 76 && goals === 0 && stats.length >= 2 &&
    (shotsOnTarget >= 2 || totalShots >= 8 || dangerousAttacks >= 18);
}

async function generateLiveCouponLogic() {
  const diagnostics = {
    liveFixtures: 0, supportedLeague: 0, evaluated: 0, withLiveStats: 0,
    withRealOdds: 0, withOddsMovement: 0, strongCandidates: 0, evaluationErrors: 0
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
    const batchSize = Math.min(12, liveCandidates.length);
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

        // Keep a visible analysis for each evaluated fixture, even when it is not a coupon pick.
        analyzedMatches.push({
          fixtureId: f.id, iddaaCode: f.iddaaCode, home: f.home, away: f.away,
          league: f.league, minute: f.minute, currentScore: `${f.homeScore}-${f.awayScore}`,
          market: evalData.smartPick?.mainPick || "ANALİZ: NET TERCİH YOK",
          alternative: evalData.smartPick?.alternative || "—",
          marketConfidence: evalData.smartPick?.confidence ?? null,
          rationale: evalData.smartPick?.rationale || "Analiz gerekçesi oluşturulamadı.",
          marketDirection: evalData.odds?.liveOdds?.movement?.trend || "Hareket ölçümü bekleniyor",
          hasLiveStats: (evalData.liveStats?.length || 0) >= 2,
          hasLiveOdds: Boolean(evalData.odds?.liveOdds?.isLive && [evalData.odds.liveOdds.over05, evalData.odds.liveOdds.over15, evalData.odds.liveOdds.over25, evalData.odds.liveOdds.over35, evalData.odds.liveOdds.homeOver05, evalData.odds.liveOdds.awayOver05, evalData.odds.liveOdds.homeOver15, evalData.odds.liveOdds.awayOver15, evalData.odds.liveOdds.bttsYes].some(v => v != null)),
        });

        const hasPrematchMarketOdds = Boolean(evalData.odds?.source && [
          evalData.odds.over05, evalData.odds.over15, evalData.odds.over25, evalData.odds.over35,
          evalData.odds.homeOver05, evalData.odds.awayOver05, evalData.odds.homeOver15,
          evalData.odds.awayOver15, evalData.odds.bttsYes, evalData.odds.htOver05,
          evalData.odds.htOver15, evalData.odds.homeWin, evalData.odds.draw, evalData.odds.awayWin
        ].some(v => v != null));
        const qualifies = isLiveCouponMarketAllowed(evalData.smartPick?.mainPick) &&
          evalData.smartPick?.confidence >= 55 && evalData.liveStats?.length >= 2 && hasPrematchMarketOdds &&
          hasMeaningfulLivePressure(evalData, f) &&
          (!/^MS\s*0[.,]5\s*ÜST$/i.test(String(evalData.smartPick?.mainPick || "")) || isLateZeroZeroMarketSupported(evalData, f));

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
      marketConfidence: evalData.smartPick.confidence,
      oddsDirection: evalData.odds?.liveOdds?.movement?.trend || "ölçüm bekleniyor",
      source: "WinScope Akıllı Canlı Analiz"
    }));

    if (!picks.length) {
      const note = `Canlı ${diagnostics.liveFixtures} maç · uygun lig/dakika ${diagnostics.supportedLeague} · analiz edilen ${diagnostics.evaluated} · canlı istatistik bulunan ${diagnostics.withLiveStats} · gerçek canlı oran bulunan ${diagnostics.withRealOdds} · önceki oran ölçümü bulunan ${diagnostics.withOddsMovement} · eşikleri geçen ${diagnostics.strongCandidates}. İlk tarama oran hareketini ölçemez; sonraki taramalarda önceki ölçümle kıyaslanır. Veriler yetersizse kupon zorlanmaz.`;
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
      note: "Canlı istatistik ve doğrulanmış maç önü piyasa oranlarıyla filtrelendi. Yüzde, piyasa oranlarından türetilmiş yaklaşık göstergedir; garanti değildir."
    };

    let tgMsg = `🎯 <b>WINSCOPE CANLI FIRSAT KOMBİNİ</b> 🎯
🕒 Saat: ${new Date().toLocaleTimeString('tr-TR')}

`;
    coupon.picks.forEach(p => {
      tgMsg += `🏆 <b>${p.league}</b>

⚽ ${p.home} vs ${p.away}

⏱️ Dk: ${p.minute}' | Skor: ${p.currentScore}

🎯 Tercih: <b>${p.market}</b>

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
        if (evalData.confidenceScore >= 55 &&
            isPreMatchCouponMarketAllowed(evalData.smartPick?.mainPick) &&
            Boolean(evalData.odds?.source)) {
          picks.push({
            fixtureId: f.id,
            iddaaCode: f.iddaaCode,
            home: f.home,
            away: f.away,
            league: f.league,
            kickoff: f.fixtureDate,
            market: evalData.smartPick.mainPick,
            odd: evalData.smartPick.odd,
            marketConfidence: evalData.confidenceScore,
            oddsDirection: "Canlı oran hareketi kullanılmıyor",
            source: "Veri Odaklı Maç Önü"
          });
        }
      } catch (e) { continue; }
    }

    picks.sort((a, b) => (Number(b.marketConfidence) || 0) - (Number(a.marketConfidence) || 0));
    picks.splice(2);

    if (!picks.length) {
      return {
        draftId: `iddaa-empty-${Date.now()}`,
        date: dateStr,
        status: "NO_MATCHES",
        picks: [],
        note: "Belirlenen maç önü pazarlarında yeterli gerçek oran ve destek bulunamadı."
      };
    }

    const coupon = {
      draftId: `iddaa-smart-coupon-${dateStr}-${Date.now()}`,
      date: dateStr,
      status: "PENDING_APPROVAL",
      picks,
      note: "Veri Odaklı Maç Önü Kombin"
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
    console.error("[Bulletin Error]", error.message);
    res.status(502).json({ error: "Maç bülteni alınamadı.", detail: error.message, matches: [], results: 0 });
  }
});

app.get("/api/live", async (_req, res) => {
  try {
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 30_000);
    const rawMatches = payload.response || [];
    const matches = rawMatches.map(m => normalizeProviderMatch(m));
    res.json({ source: "API-Football", results: matches.length, fixtures: matches, data: matches, matches });
  } catch (error) {
    console.error("[Live List Error]", error.message);
    res.status(502).json({ error: "Canlı maçlar alınamadı.", detail: error.message, matches: [], results: 0 });
  }
});

// OTOMATİK TARAMA (Gerçek Zamanlı Telegram Alarm Tetikleyicisi + Sonuç Takipçisi)
const AUTO_SCAN_INTERVAL_MS = 2 * 60 * 1000;
const notifiedLiveFixtures = new Set();
const activeSentCoupons = new Map();
// Score baseline is held per tracked fixture; only selected/predicted matches are monitored.
const trackedFixtureScores = new Map();
let lastDailyEvaluationDate = "";

setInterval(async () => {
  try {
    console.log("[Auto-Scan Alarm Fix] Canlı maçlar ve Telegram alarmları taranıyor...");
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 30_000);
    const rawMatches = payload.response || [];
    await restoreTrackedPicks();

    // 0. GOL ALARMI: yalnızca Günün Kuponu / canlı sistem tahminlerine kaydedilmiş maçlar.
    // İlk görülen skor başlangıç kabul edilir; sonraki skor değişikliği Telegram'a bildirilir.
    const liveById = new Map(rawMatches.map(raw => {
      const f = normalizeProviderMatch(raw);
      return [Number(f.id), { raw, f }];
    }));
    const trackedPicks = new Map();
    for (const [draftId, couponInfo] of activeSentCoupons.entries()) {
      for (const pick of (couponInfo.picks || [])) {
        if (pick.resultSent || !Number(pick.fixtureId)) continue;
        const id = Number(pick.fixtureId);
        if (!trackedPicks.has(id)) trackedPicks.set(id, { pick, sourceLabel: couponInfo.sourceLabel || "WinScope tahmini" });
      }
    }
    for (const [fixtureId, tracked] of trackedPicks.entries()) {
      const liveEntry = liveById.get(fixtureId);
      if (!liveEntry) continue;
      const { f } = liveEntry;
      if (!["LIVE", "HT"].includes(f.status)) continue;
      const score = `${f.homeScore}-${f.awayScore}`;
      const previous = trackedFixtureScores.get(fixtureId);
      if (previous == null) {
        trackedFixtureScores.set(fixtureId, score);
        continue;
      }
      if (previous !== score) {
        const goalMsg = `⚽ <b>WINSCOPE GOOOOOL!</b>
🏆 ${f.league}
⚽ ${f.home} - ${f.away}
📣 Skor değişti: <b>${previous} → ${score}</b>
⏱️ Dakika: ${f.minute ?? "?"}'
🎯 Takip nedeni: ${tracked.sourceLabel}`;
        const sent = await sendTelegramMessage(goalMsg);
        if (sent) {
          trackedFixtureScores.set(fixtureId, score);
          console.log(`[Goal Alert] ${fixtureId} ${previous} -> ${score}`);
        } else {
          console.warn(`[Goal Alert] Telegram gönderilemedi; ${fixtureId} sonraki taramada yeniden denenecek.`);
        }
      }
    }
    // Takibi biten maçların skor önbelleğini temizle.
    for (const fixtureId of trackedFixtureScores.keys()) {
      if (!trackedPicks.has(fixtureId)) trackedFixtureScores.delete(fixtureId);
    }
    
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

    // 2. Günlük değerlendirme: Türkiye saatiyle her gün 01:00'da bir kez gönder.
    const turkeyParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date());
    const part = key => turkeyParts.find(x => x.type === key)?.value || "";
    const turkeyDate = `${part("year")}-${part("month")}-${part("day")}`;
    const turkeyHour = Number(part("hour"));
    const turkeyMinute = Number(part("minute"));
    if (turkeyHour === 1 && turkeyMinute < 5 && lastDailyEvaluationDate !== turkeyDate) {
      const pendingResults = [];
      for (const [draftId, couponInfo] of activeSentCoupons.entries()) {
        for (const pick of couponInfo.picks || []) {
          if (pick.resultSent && pick.summaryReported !== true && typeof pick.won === "boolean") {
            pendingResults.push({ draftId, couponInfo, pick });
          }
        }
      }
      const wonCount = pendingResults.filter(x => x.pick.won === true).length;
      const lostCount = pendingResults.filter(x => x.pick.won === false).length;
      const total = wonCount + lostCount;
      const pct = total ? Math.round(wonCount / total * 100) : 0;
      const dailyMessage = `📊 <b>WINSCOPE GÜNÜN DEĞERLENDİRMESİ</b>

📅 Tarih: ${turkeyDate}

🎯 Sonuçlanan tercih: <b>${total}</b>
✅ Kazandı: <b>${wonCount}</b>
❌ Kaybetti: <b>${lostCount}</b>
📈 Başarı oranı: <b>%${pct}</b>

${total ? "Değerlendirme, sonucu doğrulanmış WinScope Telegram tahminlerinden oluşturuldu." : "Bugün için sonucu doğrulanmış ve raporlanmamış tahmin bulunamadı. Veri yokken başarı oranı uydurulmadı."}`;
      const summarySent = await sendTelegramMessage(dailyMessage);
      if (summarySent) {
        lastDailyEvaluationDate = turkeyDate;
        for (const item of pendingResults) {
          item.pick.summaryReported = true;
          await persistTrackedPick(item.draftId, item.couponInfo);
        }
        console.log(`[Daily evaluation] ${turkeyDate} günlük değerlendirmesi Telegram'a gönderildi.`);
      } else {
        console.warn("[Daily evaluation] Telegram gönderilemedi; aynı gün sonraki taramada yeniden denenecek.");
      }
    }

    // Tamamlanan ve özete aktarılmış takip kayıtlarını temizle.
    for (const [draftId, couponInfo] of activeSentCoupons.entries()) {
      if (couponInfo.picks.length && couponInfo.picks.every(p =>
        p.resultSent && (p.summaryReported === true || typeof p.won !== "boolean"))) {
        activeSentCoupons.delete(draftId);
        await deleteTrackedPick(draftId);
      }
    }

    // 2. Sistem tahminlerinden otomatik bildirim (1-3 uygun maç; zorunlu ikili yok)
    const validMatches = [];
    const scanCandidates = rawMatches.map(raw => ({ raw, f: normalizeProviderMatch(raw) }))
      .filter(({ f }) => ["LIVE", "HT"].includes(f.status) && f.minute != null &&
        f.minute >= 10 && f.minute <= 80 && isStrictIddaaMatch(f) && !notifiedLiveFixtures.has(f.id))
      .sort((a, b) => {
        const aScore = (a.f.minute >= 20 && a.f.minute <= 75 ? 2 : 0) + (a.f.homeScore + a.f.awayScore <= 2 ? 1 : 0);
        const bScore = (b.f.minute >= 20 && b.f.minute <= 75 ? 2 : 0) + (b.f.homeScore + b.f.awayScore <= 2 ? 1 : 0);
        return bScore - aScore || Number(a.f.minute) - Number(b.f.minute);
      });

    const autoBatchSize = Math.min(8, scanCandidates.length);
    const autoStartAt = scanCandidates.length ? autoAlarmScanCursor % scanCandidates.length : 0;
    const autoBatch = scanCandidates.length
      ? Array.from({ length: autoBatchSize }, (_, i) => scanCandidates[(autoStartAt + i) % scanCandidates.length])
      : [];
    if (scanCandidates.length) autoAlarmScanCursor = (autoStartAt + autoBatch.length) % scanCandidates.length;

    for (const { raw: mRaw, f } of autoBatch) {
      try {
        const evalData = await evaluateMatchAdvanced(f.id, mRaw);
        const specialLateZeroZero = isLateZeroZeroMarketSupported(evalData, f);
        const hasPrematchMarketOdds = Boolean(evalData.odds?.source && [evalData.odds.over05, evalData.odds.over15, evalData.odds.over25, evalData.odds.over35, evalData.odds.homeOver05, evalData.odds.awayOver05, evalData.odds.homeOver15, evalData.odds.awayOver15, evalData.odds.bttsYes, evalData.odds.htOver05, evalData.odds.htOver15].some(v => v != null));
        const qualifies = isActionableMarket(evalData.smartPick?.mainPick) &&
          evalData.smartPick?.confidence >= 55 && evalData.liveStats?.length >= 2 && hasPrematchMarketOdds &&
          hasMeaningfulLivePressure(evalData, f) &&
          (!/^MS\s*0[.,]5\s*ÜST$/i.test(String(evalData.smartPick?.mainPick || "")) || specialLateZeroZero);
        if (qualifies) validMatches.push({ f, evalData });
      } catch (e) {
        console.warn(`[Auto scan evaluation] fixture=${f.id}: ${e.message}`);
      }
    }

    validMatches.sort((a, b) => b.evalData.confidenceScore - a.evalData.confidenceScore);

    if (validMatches.length >= 1) {
      const selectedPicks = validMatches.slice(0, 3);
      const draftId = `auto-alarm-coupon-${Date.now()}`;
      
      let autoMsg = `🎯 <b>WINSCOPE CANLI SİSTEM TAHMİNİ</b> 🎯
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
        console.log(`[Auto-Scan OK] Telegram'a ${selectedPicks.length} uygun canlı tahmin gönderildi.`);
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
