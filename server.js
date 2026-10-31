import express from "express";
import pg from "pg";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BASE_URL = "https://v3.football.api-sports.io";
const ROOT = path.dirname(fileURLToPath(import.meta.url));

app.use(express.json({ limit: "500kb" }));

app.get("/", async (_req, res) => {
  try {
    const html = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
    return res.type("html").send(html);
  } catch {
    return res.status(500).send("index.html bulunamadı.");
  }
});
app.use(express.static(path.join(ROOT, "public")));

const providerCache = new Map();
const providerInFlight = new Map();
const archives = { analyses: [], coupons: [] };
const { Pool } = pg;
const databasePool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } })
  : null;
let archiveDatabaseReady = Promise.resolve();

if (databasePool) {
  archiveDatabaseReady = (async () => {
    try {
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_archive (
        id BIGSERIAL PRIMARY KEY,
        category TEXT NOT NULL CHECK (category IN ('analysis','coupon')),
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await databasePool.query("CREATE INDEX IF NOT EXISTS winscope_archive_category_id_idx ON winscope_archive(category, id DESC)");
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_telegram_fixture_sent (
        fixture_id BIGINT PRIMARY KEY,
        match_date DATE,
        coupon_type TEXT,
        sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_goal_tracking (
        fixture_id BIGINT PRIMARY KEY,
        home_team TEXT NOT NULL DEFAULT '',
        away_team TEXT NOT NULL DEFAULT '',
        league_name TEXT NOT NULL DEFAULT '',
        source_label TEXT NOT NULL DEFAULT 'Telegram maç takibi',
        last_score TEXT NOT NULL DEFAULT '0-0',
        active BOOLEAN NOT NULL DEFAULT TRUE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      const [analysisRows, couponRows, sentRows, trackingRows] = await Promise.all([
        databasePool.query("SELECT payload FROM winscope_archive WHERE category = 'analysis' ORDER BY id DESC LIMIT 100"),
        databasePool.query("SELECT payload FROM winscope_archive WHERE category = 'coupon' ORDER BY id DESC LIMIT 50"),
        databasePool.query("SELECT fixture_id FROM winscope_telegram_fixture_sent"),
        databasePool.query("SELECT fixture_id, home_team, away_team, league_name, source_label, last_score, active FROM winscope_goal_tracking WHERE active = TRUE")
      ]);
      archives.analyses = analysisRows.rows.map(row => row.payload);
      archives.coupons = couponRows.rows.map(row => row.payload);
      for (const row of sentRows.rows) telegramSentFixtureIds.add(Number(row.fixture_id));
      for (const row of trackingRows.rows) {
        const id = Number(row.fixture_id);
        goalTrackedFixtures.set(id, { home: row.home_team, away: row.away_team, league: row.league_name, sourceLabel: row.source_label, baselineScore: row.last_score });
        goalScoreCache.set(id, row.last_score);
      }
      console.log(`[Archive] PostgreSQL arşivi yüklendi: analyses=${archives.analyses.length}, coupons=${archives.coupons.length}`);
    } catch (error) {
      console.error(`[Archive] PostgreSQL başlatılamadı: ${error.message}`);
    }
  })();
}

async function saveArchiveItem(category, payload) {
  if (!databasePool) return { persisted: false };
  try {
    await archiveDatabaseReady;
    await databasePool.query("INSERT INTO winscope_archive(category, payload) VALUES ($1, $2::jsonb)", [category, JSON.stringify(payload)]);
    return { persisted: true };
  } catch (error) {
    return { persisted: false, error: error.message };
  }
}

const telegramDeliveryCache = new Map();
const autoSentFixtureKeys = new Set();
const telegramSentFixtureIds = new Set();
let autoLiveTaskInFlight = false;
let autoPrematchTaskInFlight = false;
const goalTrackedFixtures = new Map();
const goalScoreCache = new Map();
let goalScanInFlight = false;
let providerQueue = Promise.resolve();
let lastProviderRequestAt = 0;
let providerCooldownUntil = 0;
const PROVIDER_MIN_INTERVAL_MS = 260;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function cachedProviderRequest(cacheKey, pathname, ttlMs = 30000) {
  const now = Date.now();
  const cached = providerCache.get(cacheKey);
  if (cached && now - cached.at < ttlMs) return cached.payload;
  if (providerInFlight.has(cacheKey)) return providerInFlight.get(cacheKey);
  if (!API_KEY) throw new Error("Render Environment Variables içinde API_FOOTBALL_KEY eksik.");

  const task = providerQueue.then(async () => {
    const secondCheck = providerCache.get(cacheKey);
    if (secondCheck && Date.now() - secondCheck.at < ttlMs) return secondCheck.payload;
    const allowedAt = Math.max(lastProviderRequestAt + PROVIDER_MIN_INTERVAL_MS, providerCooldownUntil);
    if (allowedAt > Date.now()) await delay(allowedAt - Date.now());
    lastProviderRequestAt = Date.now();
    const response = await fetch(`${BASE_URL}${pathname}`, {
      headers: { "x-apisports-key": API_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(15000)
    });
    const raw = await response.text();
    let payload;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { throw new Error("API-Football geçerli JSON döndürmedi."); }
    if (!response.ok || payload.errors?.length) {
      throw new Error(`API-Football hatası: ${response.status}`);
    }
    providerCache.set(cacheKey, { at: Date.now(), payload });
    return payload;
  });
  providerQueue = task.catch(() => undefined);
  providerInFlight.set(cacheKey, task);
  try { return await task; }
  finally { providerInFlight.delete(cacheKey); }
}

function normalizeProviderMatch(match) {
  const homeName = match.teams?.home?.name || match.home || "Ev sahibi";
  const awayName = match.teams?.away?.name || match.away || "Deplasman";
  const leagueName = match.league?.name || match.league || "Lig";
  const countryName = match.league?.country || match.country || "";
  const idNum = Number(match.fixture?.id ?? match.id) || 0;
  let status = String(match.fixture?.status?.short || match.status || "NS").toUpperCase();
  if (["FT", "AET", "PEN"].includes(status)) status = "FT";
  else if (["1H", "2H", "HT", "LIVE", "IN_PLAY", "ET", "BT", "P"].includes(status)) status = "LIVE";
  return {
    id: idNum, homeId: Number(match.teams?.home?.id) || null, awayId: Number(match.teams?.away?.id) || null,
    league: String(leagueName), country: String(countryName),
    minute: match.fixture?.status?.elapsed ?? match.minute ?? null, status,
    home: String(homeName), away: String(awayName),
    homeScore: match.goals?.home ?? 0, awayScore: match.goals?.away ?? 0,
    htHomeScore: match.score?.halftime?.home ?? null, htAwayScore: match.score?.halftime?.away ?? null,
    fixtureDate: match.fixture?.date || match.kickoff_utc || null
  };
}

function bookmakerRows(oddsRow) {
  if (!oddsRow) return [];
  if (Array.isArray(oddsRow.bookmakers) && oddsRow.bookmakers.length) return oddsRow.bookmakers;
  return [];
}

function oddsForFixture(oddsRow) {
  const markets = new Map();
  const add = (book, key, side, odd) => {
    if (!Number.isFinite(odd) || odd <= 1.01) return;
    const mapKey = `${book}|${key}`;
    if (!markets.has(mapKey)) markets.set(mapKey, { market: key, bookmaker: book, over: null, under: null, yes: null, no: null, home: null, draw: null, away: null });
    markets.get(mapKey)[side] = odd;
  };
  for (const bookmaker of bookmakerRows(oddsRow)) {
    const book = String(bookmaker.name || "API-Football");
    for (const bet of (bookmaker.bets || [])) {
      const name = String(bet.name || "").toLowerCase();
      const isHalf = /first half|1st half|half time/.test(name);
      const isBtts = /both teams to score|btts/.test(name);
      const isHandicap = /asian handicap|handicap/.test(name);
      const isWinner = /match winner|1x2|full time result|1st half result/.test(name) && !isHandicap;
      
      for (const value of (bet.values || [])) {
        const label = String(value.value ?? value.name ?? "").toLowerCase();
        const odd = Number(value.odd);
        if (!Number.isFinite(odd) || odd <= 1.01) continue;

        if (isHandicap && label.includes("-0.5")) {
          if (/home|1/.test(label)) add(book, "AH -0.5", "home", odd);
          else if (/away|2/.test(label)) add(book, "AH -0.5", "away", odd);
          continue;
        }
        if (isWinner) {
          const key = isHalf ? "İY 1X2" : "MS 1X2";
          if (/^home|1$/.test(label)) add(book, key, "home", odd);
          else if (/^draw|x$/.test(label)) add(book, key, "draw", odd);
          else if (/^away|2$/.test(label)) add(book, key, "away", odd);
          continue;
        }
        if (isBtts) {
          if (/yes/.test(label)) add(book, "KG VAR", "yes", odd);
          else if (/no/.test(label)) add(book, "KG VAR", "no", odd);
          continue;
        }
        const lineMatch = label.match(/over\s*([0-9]+[.,][0-9]+)/) || label.match(/([0-9]+[.,][0-9]+)/);
        if (lineMatch) {
          const n = Number(lineMatch[1].replace(',', '.'));
          const side = label.includes("over") ? "over" : label.includes("under") ? "under" : null;
          if (side) {
            let key = isHalf ? `İY ${n} ÜST` : `MS ${n} ÜST`;
            add(book, key, side, odd);
          }
        }
      }
    }
  }
  const candidates = [];
  for (const item of markets.values()) {
    let pct = null;
    if (item.over && item.under) pct = 100 * (1 / item.over) / ((1 / item.over) + (1 / item.under));
    else if (item.yes && item.no) pct = 100 * (1 / item.yes) / ((1 / item.yes) + (1 / item.no));
    else if (item.home && item.draw && item.away) {
      const inv = [1 / item.home, 1 / item.draw, 1 / item.away], sum = inv.reduce((a,b)=>a+b,0);
      pct = 100 * (1 / item.home) / sum;
    }
    const odd = item.over || item.yes || item.home;
    candidates.push({ market: item.market, odd, probability: pct, bookmaker: item.bookmaker, homeOdd: item.home, drawOdd: item.draw, awayOdd: item.away });
  }
  return candidates;
}

async function fetchTeamRecentForm(teamId, fixtureId) {
  if (!teamId) return { available: false };
  try {
    const payload = await cachedProviderRequest(`form:${teamId}`, `/fixtures?team=${teamId}&last=10`, 6 * 60 * 60 * 1000);
    const rows = (payload.response || []).filter(row => Number(row.fixture?.id) !== Number(fixtureId) && ["FT", "AET", "PEN"].includes(String(row.fixture?.status?.short || "").toUpperCase())).slice(0,5);
    if (!rows.length) return { available: false };
    const gf = rows.reduce((acc, r) => acc + (r.teams?.home?.id === teamId ? r.goals.home : r.goals.away), 0) / rows.length;
    const ga = rows.reduce((acc, r) => acc + (r.teams?.home?.id === teamId ? r.goals.away : r.goals.home), 0) / rows.length;
    return { available: true, avgGoalsFor: gf, avgGoalsAgainst: ga, sampleSize: rows.length };
  } catch {
    return { available: false };
  }
}

function factorial(n) { let out = 1; for (let i = 2; i <= n; i++) out *= i; return out; }
function scorePrediction(match, homeForm, awayForm, oddsRow) {
  const hNow = Number(match.homeScore || 0), aNow = Number(match.awayScore || 0);
  const live = match.status === "LIVE";
  if (match.status === "FT") return { halfTimeScore: `${match.htHomeScore ?? "?"}-${match.htAwayScore ?? "?"}`, fullTimeScore: `${hNow}-${aNow}` };

  let lambdaHome = homeForm?.available ? (homeForm.avgGoalsFor + (awayForm?.avgGoalsAgainst || 1)) / 2 : 1.35;
  let lambdaAway = awayForm?.available ? (awayForm.avgGoalsFor + (homeForm?.avgGoalsAgainst || 1)) / 2 : 1.05;

  if (live) {
    const minute = Math.max(1, Math.min(90, Number(match.minute || 0)));
    const remainRatio = (90 - minute) / 90;
    lambdaHome *= remainRatio;
    lambdaAway *= remainRatio;
  }

  const pmf = (k, l) => Math.exp(-l) * Math.pow(l, k) / factorial(k);
  let bestProb = -1, bestH = 0, bestA = 0;
  for (let h = 0; h <= 5; h++) {
    for (let a = 0; a <= 5; a++) {
      const p = pmf(h, lambdaHome) * pmf(a, lambdaAway);
      if (p > bestProb) { bestProb = p; bestH = h; bestA = a; }
    }
  }

  const ftH = live ? hNow + bestH : bestH;
  const ftA = live ? aNow + bestA : bestA;
  const htH = live && match.minute >= 45 ? (match.htHomeScore ?? hNow) : Math.min(ftH, Math.round(ftH * 0.45));
  const htA = live && match.minute >= 45 ? (match.htAwayScore ?? aNow) : Math.min(ftA, Math.round(ftA * 0.45));

  return {
    halfTimeScore: `${htH}-${htA}${live && match.minute < 45 ? ' (Tahmin)' : ''}`,
    fullTimeScore: `${ftH}-${ftA}${live ? ' (Tahmin)' : ''}`
  };
}

app.get("/api/match/:id/analyze", async (req, res) => {
  try {
    const payload = await cachedProviderRequest(`fixture:${req.params.id}`, `/fixtures?id=${encodeURIComponent(req.params.id)}`, 15000);
    const row = payload.response?.[0];
    if (!row) return res.status(404).json({ error: "Maç verisi bulunamadı." });
    const match = normalizeProviderMatch(row);
    const isLive = match.status === "LIVE";

    const [prematchOddsPayload, homeForm, awayForm] = await Promise.all([
      cachedProviderRequest(`odds-fixture:${match.id}`, `/odds?fixture=${match.id}`, 90000).catch(() => ({ response: [] })),
      fetchTeamRecentForm(match.homeId, match.id),
      fetchTeamRecentForm(match.awayId, match.id)
    ]);

    const prematchRow = (prematchOddsPayload.response || []).find(x => Number(x.fixture?.id) === match.id) || null;
    const oddsList = oddsForFixture(prematchRow);
    const scores = scorePrediction(match, homeForm, awayForm, prematchRow);

    const getMarket = (key) => oddsList.find(o => o.market === key);
    const formatOdds = (item) => item ? `Oran: ${item.odd || '—'} (%${item.probability ? item.probability.toFixed(0) : '—'})` : "Veri Yok";
    const format1X2 = (item) => item && item.homeOdd ? `1: ${item.homeOdd} | X: ${item.drawOdd} | 2: ${item.awayOdd}` : "Veri Yok";

    res.json({
      fixtureId: match.id,
      matchStatus: match.status,
      halfTimeScore: scores.halfTimeScore,
      fullTimeScore: scores.fullTimeScore,
      iy1x2: format1X2(getMarket("İY 1X2")),
      ms1x2: format1X2(getMarket("MS 1X2")),
      iy05: formatOdds(getMarket("İY 0.5 ÜST")),
      iy15: formatOdds(getMarket("İY 1.5 ÜST")),
      btts: formatOdds(getMarket("KG VAR")),
      ms15: formatOdds(getMarket("MS 1.5 ÜST")),
      ms25: formatOdds(getMarket("MS 2.5 ÜST")),
      ms35: formatOdds(getMarket("MS 3.5 ÜST")),
      ah05: formatOdds(getMarket("AH -0.5")),
      mainPick: getMarket("MS 2.5 ÜST")?.probability > 55 ? "MS 2.5 ÜST" : "KG VAR",
      alternative: getMarket("MS 1.5 ÜST")?.probability > 70 ? "MS 1.5 ÜST" : "İY 0.5 ÜST",
      livePick: isLive ? (match.homeScore + match.awayScore >= 2 ? "MS 3.5 ÜST" : "MS 2.5 ÜST") : "Maç canlı değil",
      note: `Analiz tamamlandı. Ev Sahibi Form: ${homeForm.available ? homeForm.avgGoalsFor.toFixed(1) + ' Gol/Maç' : 'Veri Yok'}, Deplasman Form: ${awayForm.available ? awayForm.avgGoalsFor.toFixed(1) + ' Gol/Maç' : 'Veri Yok'}`
    });
  } catch (e) {
    res.status(502).json({ error: "Analiz üretilemedi.", detail: e.message });
  }
});

app.get("/api/live", async (_req, res) => {
  try {
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 20000);
    const matches = (payload.response || []).map(normalizeProviderMatch);
    res.json({ source: "API-Football", results: matches.length, matches, fetchedAt: new Date().toISOString() });
  } catch (e) { res.status(502).json({ error: "Canlı maçlar alınamadı", detail: e.message, matches: [] }); }
});

app.get("/api/fixtures", async (req, res) => {
  const date = String(req.query.date || "");
  try {
    const payload = await cachedProviderRequest(`fixtures:${date}`, `/fixtures?date=${date}&timezone=Europe/Istanbul`, 60000);
    const matches = (payload.response || []).map(normalizeProviderMatch);
    res.json({ source: "API-Football", results: matches.length, matches });
  } catch (e) { res.status(502).json({ error: "Bülten alınamadı", detail: e.message, matches: [] }); }
});

app.listen(PORT, () => console.log(`WinScope server running on port ${PORT}`));
