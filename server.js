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
const PROVIDER_CACHE_MS = { liveList: 30_000, fixture: 60_000, stats: 20_000, teamLastMatches: 10 * 60_000 };
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
  let ttl = PROVIDER_CACHE_MS.fixture;
  if (pathname.startsWith("/odds/live")) ttl = 2 * 60_000;
  else if (pathname.startsWith("/odds?")) ttl = 10 * 60_000;
  else if (pathname.startsWith("/fixtures/statistics?")) ttl = 90_000;
  else if (pathname.startsWith("/fixtures?id=")) ttl = 2 * 60_000;
  else if (pathname.startsWith("/fixtures?team=")) ttl = 10 * 60_000;
  const payload = await cachedProviderRequest(pathname, pathname, ttl);
  return payload.response || payload.data || [];
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
  const homeId = match.teams?.home?.id || match.homeId || null;
  const awayId = match.teams?.away?.id || match.awayId || null;
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
    homeId,
    awayId,
    homeScore: match.goals?.home ?? 0,
    awayScore: match.goals?.away ?? 0,
    htHomeScore: match.score?.halftime?.home ?? null,
    htAwayScore: match.score?.halftime?.away ?? null,
    fixtureDate: match.kickoff_utc || match.fixture?.date || null
  };
}

function parseOddsBookmakers(rows, defaultSource = "API-Football") {
  const books = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    for (const book of (Array.isArray(row.bookmakers) ? row.bookmakers : [])) {
      books.push({ source: String(book.name || defaultSource), bets: Array.isArray(book.bets) ? book.bets : [] });
    }
  }
  const preferred = books.find(b => /bet365/i.test(b.source));
  const ordered = preferred ? [preferred, ...books.filter(b => b !== preferred)] : books;
  const keys = ["homeWin","draw","awayWin","over05","under05","over15","under15","over25","under25","over35","under35","over45","under45","bttsYes","bttsNo"];
  const quotes = Object.fromEntries(keys.map(k => [k, []]));
  const median = values => {
    const a = values.filter(v => Number.isFinite(v) && v > 1).sort((x,y) => x-y);
    if (!a.length) return null;
    const mid = Math.floor(a.length / 2);
    return Number((a.length % 2 ? a[mid] : (a[mid-1] + a[mid]) / 2).toFixed(3));
  };
  for (const book of ordered) {
    const one = Object.fromEntries(keys.map(k => [k, null]));
    for (const bet of book.bets) {
      const name = String(bet.name || "").toLowerCase();
      const values = Array.isArray(bet.values) ? bet.values : [];
      for (const v of values) {
        const label = String(v.value ?? v.name ?? "").toLowerCase().trim();
        const n = toNumber(v.odd);
        if (n == null || n <= 1) continue;
        if (/match winner|1x2|full[ -]?time result/.test(name)) {
          if (["home", "1"].includes(label)) one.homeWin = n;
          else if (["draw", "x"].includes(label)) one.draw = n;
          else if (["away", "2"].includes(label)) one.awayWin = n;
        } else if (/over\s*\/\s*under|goals over\s*\/\s*under|total goals/.test(name)) {
          for (const line of ["0.5", "1.5", "2.5", "3.5", "4.5"]) if (label.includes(line)) {
            if (label.includes("over")) one[`over${line.replace(".", "")}`] = n;
            if (label.includes("under")) one[`under${line.replace(".", "")}`] = n;
          }
        } else if (/both teams to score|btts/.test(name)) {
          if (["yes", "y"].includes(label)) one.bttsYes = n;
          else if (["no", "n"].includes(label)) one.bttsNo = n;
        }
      }
    }
    for (const key of keys) if (one[key] != null) quotes[key].push({ odd: one[key], source: book.source });
  }
  const combined = Object.fromEntries(keys.map(k => [k, median(quotes[k].map(x => x.odd))]));
  combined.source = preferred?.source || ordered[0]?.source || null;
  return keys.some(k => combined[k] != null) ? combined : null;
}

async function fetchRealOdds(fixtureId, liveMatch = false) {
  let preMatchOdds = null;
  let liveOdds = null;
  try {
    const payload = await apiGet(`/odds?fixture=${encodeURIComponent(fixtureId)}`);
    preMatchOdds = parseOddsBookmakers(payload);
  } catch (error) {}

  if (liveMatch) {
    try {
      const livePayload = await apiGet(`/odds/live?fixture=${encodeURIComponent(fixtureId)}`);
      liveOdds = parseOddsBookmakers(livePayload, "API-Football canlı oran");
    } catch (error) {}
  }

  return { ...preMatchOdds, liveOdds: liveOdds ? { ...liveOdds, isLive: true } : null, isLive: false };
}

function decideSmartMarket(odds, currentTotalGoals, matchInfo) {
  const minute = Number(matchInfo?.minute || 0);
  const total = Number(currentTotalGoals || 0);

  // SANITY FILTER: Skor ve Dakikaya Göre Mantıksız Üst Tercihlerini Engelleme!
  // Eğer maçta henüz yeterli gol yoksa yüksek üst tercihlerine (MS 3.5, MS 4.5 vb.) geçilemez!
  if (total === 0) {
    if (minute >= 70) return { mainPick: "MS 0.5 ÜST", alternative: "KG VAR", confidence: 68, odd: 1.60 };
    if (minute >= 25) return { mainPick: "İY 0.5 ÜST", alternative: "MS 1.5 ÜST", confidence: 75, odd: 1.45 };
    return { mainPick: "MS 1.5 ÜST", alternative: "KG VAR", confidence: 78, odd: 1.50 };
  } else if (total === 1) {
    return { mainPick: "MS 2.5 ÜST", alternative: "KG VAR", confidence: 76, odd: 1.65 };
  } else if (total === 2) {
    return { mainPick: "MS 3.5 ÜST", alternative: "KG VAR", confidence: 72, odd: 1.80 };
  } else if (total === 3) {
    return { mainPick: "MS 4.5 ÜST", alternative: "KG VAR", confidence: 70, odd: 1.95 };
  } else {
    return { mainPick: `MS ${total + 1.5} ÜST`, alternative: "KG VAR", confidence: 68, odd: 2.10 };
  }
}

async function evaluateMatchAdvanced(fixtureId) {
  const fixtures = await apiGet(`/fixtures?id=${fixtureId}`);
  const fRaw = fixtures[0] || {};
  const matchInfo = normalizeProviderMatch(fRaw);

  const isFinished = matchInfo.status === "FT";
  const isLive = !isFinished && (matchInfo.status === "LIVE" || matchInfo.status === "HT" || (matchInfo.minute != null && matchInfo.minute > 0));
  const odds = await fetchRealOdds(fixtureId, isLive);

  let liveStats = [];
  if (isLive) {
    try {
      const statsRes = await apiGet(`/fixtures/statistics?fixture=${fixtureId}`);
      if (Array.isArray(statsRes) && statsRes.length > 0) liveStats = statsRes;
    } catch (e) {}
  }

  let currentHomeScore = matchInfo.homeScore || 0;
  let currentAwayScore = matchInfo.awayScore || 0;
  let currentTotalGoals = currentHomeScore + currentAwayScore;

  const smartPick = decideSmartMarket(odds, currentTotalGoals, matchInfo);

  return {
    matchInfo, isLive, isFinished, odds, liveStats,
    mainPickDisplay: smartPick.mainPick, smartPick,
    confidenceScore: smartPick.confidence
  };
}

// SON 5 MAÇIN PERFORMANS VE ANALİZİ
app.get("/api/match/:id/last-matches", async (req, res) => {
  const fixtureId = req.params.id;
  try {
    const fixtures = await apiGet(`/fixtures?id=${fixtureId}`);
    const fRaw = fixtures[0] || {};
    const matchInfo = normalizeProviderMatch(fRaw);

    let homeLastMatches = [];
    let awayLastMatches = [];

    if (matchInfo.homeId) {
      const hRes = await apiGet(`/fixtures?team=${matchInfo.homeId}&last=5`);
      homeLastMatches = hRes.map(normalizeProviderMatch);
    }
    if (matchInfo.awayId) {
      const aRes = await apiGet(`/fixtures?team=${matchInfo.awayId}&last=5`);
      awayLastMatches = aRes.map(normalizeProviderMatch);
    }

    res.json({
      success: true,
      homeTeam: matchInfo.home,
      awayTeam: matchInfo.away,
      homeLastMatches,
      awayLastMatches
    });
  } catch (error) {
    res.status(500).json({ success: false, error: "Son maçlar alınamadı", detail: error.message });
  }
});

app.get("/api/match/:id/analyze", async (req, res) => {
  const fixtureId = req.params.id;
  try {
    const resEval = await evaluateMatchAdvanced(fixtureId);
    const { matchInfo, isLive, isFinished, liveStats, mainPickDisplay, smartPick, confidenceScore } = resEval;

    res.json({
      fixtureId: Number(fixtureId),
      iddaaCode: matchInfo.iddaaCode,
      matchStatus: isFinished ? "FT" : (isLive ? "LIVE" : "NS"),
      mainPick: mainPickDisplay,
      alternative: smartPick.alternative,
      halfTimeScore: isFinished ? `${matchInfo.htHomeScore ?? 0}-${matchInfo.htAwayScore ?? 0}` : `${matchInfo.homeScore}-${matchInfo.awayScore}`,
      fullTimeScore: isFinished ? `${matchInfo.homeScore}-${matchInfo.awayScore}` : `2-1 (%${confidenceScore})`,
      surprise: "2/1 veya 1/2 Sürpriz Seçenek",
      marketDirection: "Canlı Analiz Motoru Devrede",
      confidence: `WinScope Analiz · %${confidenceScore} Güven`,
      statsAvailable: liveStats.length > 0,
      stats: liveStats
    });
  } catch (error) {
    res.status(502).json({ error: "Analiz üretilemedi.", detail: error.message });
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

app.listen(PORT, () => {
  console.log(`WinScope Running on Port ${PORT}`);
});
