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
    // Pre-match feeds may expose bookmakers[].bets[].
    for (const book of (Array.isArray(row.bookmakers) ? row.bookmakers : [])) {
      books.push({ source: String(book.name || defaultSource), bets: Array.isArray(book.bets) ? book.bets : [] });
    }
    // The live feed may expose odds[] directly; normalize it to the same bet shape.
    if (Array.isArray(row.odds) && row.odds.length) {
      books.push({
        source: String(row.bookmaker?.name || row.bookmaker || row.source || defaultSource),
        bets: row.odds.map(item => ({
          name: item.name || item.bet || '',
          values: Array.isArray(item.values) ? item.values : []
        }))
      });
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

// --- Günün kuponu / canlı kombine endpoints ---
// index.html calls these two routes. Without them Express serves index.html
// as a fallback, and the browser tries to parse <!doctype html> as JSON.
const COUPON_SCAN_LIMIT = 24;
const LIVE_COUPON_SCAN_LIMIT = 16;
const COUPON_MAX_PICKS = 3;

function impliedProbabilityFromOdds(odd, oppositeOdd) {
  const a = toNumber(odd);
  const b = toNumber(oppositeOdd);
  if (a == null || a <= 1) return null;
  if (b != null && b > 1) return 100 * (1 / a) / ((1 / a) + (1 / b));
  // Single-sided quote: raw implied probability used only as a ranking signal.
  return 100 / a;
}

function couponCandidatesForMatch(match, odds, isLive) {
  if (!match || !odds) return [];
  const homeGoals = Number(match.homeScore || 0);
  const awayGoals = Number(match.awayScore || 0);
  const totalGoals = homeGoals + awayGoals;
  const candidates = [];
  const goalMarkets = [
    { key: 'over15', under: 'under15', label: 'MS 1.5 ÜST', target: 2 },
    { key: 'over25', under: 'under25', label: 'MS 2.5 ÜST', target: 3 },
    { key: 'over35', under: 'under35', label: 'MS 3.5 ÜST', target: 4 },
    { key: 'over45', under: 'under45', label: 'MS 4.5 ÜST', target: 5 }
  ];

  for (const market of goalMarkets) {
    const odd = toNumber(odds[market.key]);
    if (odd == null || odd < 1.15 || odd > 2.25) continue;
    if (isLive && totalGoals >= market.target) continue; // Market already settled.
    const probability = impliedProbabilityFromOdds(odd, odds[market.under]);
    if (probability != null && probability >= 54 && probability <= 92) {
      candidates.push({ market: market.label, rank: probability + 1, id: match.id });
    }
  }

  const bttsOdd = toNumber(odds.bttsYes);
  if (bttsOdd != null && bttsOdd >= 1.15 && bttsOdd <= 2.25 && !(isLive && homeGoals > 0 && awayGoals > 0)) {
    const probability = impliedProbabilityFromOdds(bttsOdd, odds.bttsNo);
    if (probability != null && probability >= 54 && probability <= 92) {
      candidates.push({ market: 'KG VAR', rank: probability, id: match.id });
    }
  }

  // Only compare 1X2 when all three real outcomes are present; remove margin.
  const oneXtwo = [toNumber(odds.homeWin), toNumber(odds.draw), toNumber(odds.awayWin)];
  if (oneXtwo.every(value => value != null && value > 1)) {
    const inverse = oneXtwo.map(value => 1 / value);
    const sum = inverse.reduce((a, b) => a + b, 0);
    const choices = [
      { market: 'MS 1', probability: inverse[0] / sum * 100 },
      { market: 'MS X', probability: inverse[1] / sum * 100 },
      { market: 'MS 2', probability: inverse[2] / sum * 100 }
    ];
    for (let i = 0; i < choices.length; i++) {
      if (oneXtwo[i] >= 1.15 && oneXtwo[i] <= 2.25 && choices[i].probability >= 54 && choices[i].probability <= 92) {
        candidates.push({ market: choices[i].market, rank: choices[i].probability - 0.5, id: match.id });
      }
    }
  }
  return candidates;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const output = new Array(items.length);
  let cursor = 0;
  async function runWorker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try { output[index] = await worker(items[index], index); }
      catch (error) {
        console.warn(`[Coupon scan] ${error.message}`);
        output[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runWorker()));
  return output;
}

async function getCouponOdds(match, isLive) {
  const path = isLive
    ? `/odds/live?fixture=${encodeURIComponent(match.id)}`
    : `/odds?fixture=${encodeURIComponent(match.id)}`;
  const rows = await apiGet(path);
  return parseOddsBookmakers(rows, isLive ? 'API-Football canlı oran' : 'API-Football maç önü oran');
}

async function makeCouponResponse(fixtures, isLive, dateLabel) {
  const limit = isLive ? LIVE_COUPON_SCAN_LIMIT : COUPON_SCAN_LIMIT;
  const eligible = fixtures.filter(match => match && Number(match.id) > 0).filter(match => {
    if (isLive) return ['LIVE', 'HT'].includes(match.status) || (Number(match.minute) > 0 && !['FT', 'AET', 'PEN', 'NS'].includes(match.status));
    return !['LIVE', 'HT', 'FT', 'AET', 'PEN'].includes(match.status) && !(Number(match.minute) > 0);
  }).slice(0, limit);

  if (!eligible.length) {
    return { status: 'NO_MATCHES', isLive, date: dateLabel, picks: [], note: isLive
      ? 'Şu anda taranabilecek canlı maç bulunamadı.'
      : 'Bu tarihte maç önü kuponu için henüz başlamamış maç bulunamadı.' };
  }

  const scanned = await mapWithConcurrency(eligible, 3, async match => {
    const odds = await getCouponOdds(match, isLive);
    const candidates = couponCandidatesForMatch(match, odds, isLive).sort((a, b) => b.rank - a.rank);
    if (!candidates.length) return null;
    return { match, candidate: candidates[0] };
  });

  const picks = scanned.filter(Boolean).sort((a, b) => b.candidate.rank - a.candidate.rank)
    .filter((item, index, arr) => arr.findIndex(other => other.match.id === item.match.id) === index)
    .slice(0, COUPON_MAX_PICKS).map(item => ({
      id: item.match.id,
      iddaaCode: item.match.iddaaCode,
      league: item.match.league,
      home: item.match.home,
      away: item.match.away,
      market: item.candidate.market,
      minute: isLive ? item.match.minute : null,
      currentScore: `${item.match.homeScore ?? 0}-${item.match.awayScore ?? 0}`
    }));

  return {
    status: picks.length ? 'OK' : 'NO_MATCHES', isLive, date: dateLabel,
    scannedFixtures: eligible.length, picks,
    note: picks.length
      ? `${eligible.length} maç tarandı; yalnızca gerçek API-Football oranıyla desteklenen seçimler eklendi.`
      : 'Taranan maçlarda ölçütleri karşılayan gerçek oran pazarı bulunamadı. Tahmin uydurulmadı.'
  };
}

app.get('/api/coupon/daily', async (req, res) => {
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    return res.status(400).json({ status: 'NO_MATCHES', isLive: false, date, picks: [], note: 'Geçerli tarih YYYY-AA-GG biçiminde gönderilmeli.' });
  }
  try {
    const fixtures = await apiGet(`/fixtures?date=${encodeURIComponent(date)}&timezone=Europe/Istanbul`);
    return res.json(await makeCouponResponse(fixtures.map(normalizeProviderMatch), false, date));
  } catch (error) {
    console.error(`[Daily coupon error] ${error.message}`);
    return res.status(502).json({ status: 'NO_MATCHES', isLive: false, date, picks: [], note: 'Günün kuponu verisi API-Football’dan alınamadı. Render loglarını kontrol et.', error: error.message });
  }
});

app.get('/api/coupon/live', async (_req, res) => {
  const date = new Date().toISOString().slice(0, 10);
  try {
    const payload = await cachedProviderRequest('liveList', '/fixtures?live=all', 30_000);
    const fixtures = (payload.response || payload.data || []).map(normalizeProviderMatch);
    return res.json(await makeCouponResponse(fixtures, true, date));
  } catch (error) {
    console.error(`[Live coupon error] ${error.message}`);
    return res.status(502).json({ status: 'NO_MATCHES', isLive: true, date, picks: [], note: 'Canlı kombine verisi API-Football’dan alınamadı. Render loglarını kontrol et.', error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`WinScope Running on Port ${PORT}`);
});
