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
      console.log(`[Archive] PostgreSQL arşivi yüklendi.`);
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

const telegramSentFixtureIds = new Set();
const goalTrackedFixtures = new Map();
const goalScoreCache = new Map();
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
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY eksik.");

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
    try { payload = raw ? JSON.parse(raw) : {}; } catch { throw new Error("API geçerli JSON döndürmedi."); }
    if (!response.ok) throw new Error(`API hatası: ${response.status}`);
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

function oddsForFixture(oddsRow) {
  if (!oddsRow || !Array.isArray(oddsRow.bookmakers)) return [];
  let selectedBookmaker = oddsRow.bookmakers.find(b => /bet365/i.test(b.name || ""));
  if (!selectedBookmaker && oddsRow.bookmakers.length > 0) {
    selectedBookmaker = oddsRow.bookmakers[0];
  }
  if (!selectedBookmaker) return [];

  const markets = new Map();
  const add = (key, side, odd) => {
    if (!Number.isFinite(odd) || odd <= 1.01) return;
    if (!markets.has(key)) markets.set(key, { market: key, over: null, under: null, yes: null, no: null, home: null, draw: null, away: null });
    markets.get(key)[side] = odd;
  };

  for (const bet of (selectedBookmaker.bets || [])) {
    const name = String(bet.name || "").toLowerCase();
    const isHalf = /first half|1st half|half time|1st half result|half-time/.test(name);
    const isBtts = /both teams to score|btts/.test(name);
    const isHandicap = /asian handicap|handicap/.test(name);
    const isWinner = /match winner|1x2|full time result|regular time result/.test(name) && !isHandicap;

    for (const value of (bet.values || [])) {
      const label = String(value.value ?? value.name ?? "").toLowerCase();
      const odd = Number(value.odd);
      if (!Number.isFinite(odd) || odd <= 1.01) continue;

      if (isHandicap && (label.includes("-0.5") || label.includes("home"))) {
        if (/home|1|-0[.,]5/.test(label)) add("AH -0.5", "home", odd);
        continue;
      }
      if (isWinner) {
        const key = isHalf ? "İY 1X2" : "MS 1X2";
        if (/^home|1|1 \(home\)$/.test(label)) add(key, "home", odd);
        else if (/^draw|x|tie$/.test(label)) add(key, "draw", odd);
        else if (/^away|2|2 \(away\)$/.test(label)) add(key, "away", odd);
        continue;
      }
      if (isBtts) {
        if (/yes|y/.test(label)) add("KG VAR", "yes", odd);
        else if (/no|n/.test(label)) add("KG VAR", "no", odd);
        continue;
      }
      const lineMatch = label.match(/over\s*([0-9]+[.,][0-9]+)/) || label.match(/([0-9]+[.,][0-9]+)/);
      if (lineMatch) {
        const n = Number(lineMatch[1].replace(',', '.'));
        const side = label.includes("over") ? "over" : label.includes("under") ? "under" : "over";
        if ([0.5, 1.5, 2.5, 3.5].includes(n)) {
          let key = isHalf ? `İY ${n} ÜST` : `MS ${n} ÜST`;
          add(key, side, odd);
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
    candidates.push({ market: item.market, odd, probability: pct, bookmaker: selectedBookmaker.name, homeOdd: item.home, drawOdd: item.draw, awayOdd: item.away });
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

function scorePrediction(match, homeForm, awayForm) {
  const hNow = Number(match.homeScore || 0), aNow = Number(match.awayScore || 0);
  const live = match.status === "LIVE";
  if (match.status === "FT") return { halfTimeScore: `${match.htHomeScore ?? "?"}-${match.htAwayScore ?? "?"}`, fullTimeScore: `${hNow}-${aNow}`, mainPick: "Maç Bitti", alternative: "Maç Bitti", livePick: "Maç Bitti" };

  let lambdaHome = homeForm?.available ? (homeForm.avgGoalsFor + (awayForm?.avgGoalsAgainst || 1)) / 2 : 1.35;
  let lambdaAway = awayForm?.available ? (awayForm.avgGoalsFor + (homeForm?.avgGoalsAgainst || 1)) / 2 : 1.05;

  if (live) {
    const minute = Math.max(1, Math.min(90, Number(match.minute || 0)));
    const remainRatio = Math.max(0.15, (90 - minute) / 90);
    lambdaHome *= remainRatio;
    lambdaAway *= remainRatio;
  }

  const pmf = (k, l) => Math.exp(-l) * Math.pow(l, k) / factorial(k);
  let bestProb = -1, bestH = 0, bestA = 0;
  for (let h = 0; h <= 3; h++) {
    for (let a = 0; a <= 3; a++) {
      const p = pmf(h, lambdaHome) * pmf(a, lambdaAway);
      if (p > bestProb) { bestProb = p; bestH = h; bestA = a; }
    }
  }

  const ftH = live ? hNow + bestH : bestH;
  const ftA = live ? aNow + bestA : bestA;
  const htH = live && match.minute >= 45 ? (match.htHomeScore ?? hNow) : Math.min(ftH, Math.round(ftH * 0.45));
  const htA = live && match.minute >= 45 ? (match.htAwayScore ?? aNow) : Math.min(ftA, Math.round(ftA * 0.45));

  const totalGoalsForecast = ftH + ftA;
  const isBtts = ftH > 0 && ftA > 0;

  let mainPick, alternative, livePick;

  if (totalGoalsForecast >= 3) {
    mainPick = "MS 2.5 ÜST";
    alternative = isBtts ? "KG VAR" : "MS 3.5 ÜST";
  } else if (totalGoalsForecast === 2) {
    mainPick = "MS 1.5 ÜST";
    alternative = isBtts ? "KG VAR" : "MS 2.5 ÜST (Sınır)";
  } else {
    mainPick = "MS 1.5 ÜST";
    alternative = "MS 0.5 ÜST";
  }

  if (live) {
    const currentTotal = hNow + aNow;
    if (totalGoalsForecast > currentTotal) {
      livePick = `MS ${currentTotal + 1}.5 ÜST`;
    } else {
      livePick = currentTotal === 0 ? "İY 0.5 ÜST" : "MS " + currentTotal + ".5 ÜST";
    }
  } else {
    livePick = "Maç Önü Oran Analizi";
  }

  return {
    halfTimeScore: `${htH}-${htA}${live && match.minute < 45 ? ' (Tahmin)' : ''}`,
    fullTimeScore: `${ftH}-${ftA}${live ? ' (Mevcut + Kalan)' : ''}`,
    mainPick,
    alternative,
    livePick
  };
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { sent: false };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
    });
    const data = await res.json();
    return { sent: data.ok };
  } catch { return { sent: false }; }
}

async function createCouponByMode(date, mode = "prematch") {
  const isLive = mode === "live";
  const url = isLive ? "/fixtures?live=all" : `/fixtures?date=${encodeURIComponent(date)}&timezone=Europe/Istanbul`;
  const payload = await cachedProviderRequest(`coupon-${mode}-${date}`, url, isLive ? 15000 : 60000);
  const matches = (payload.response || []).map(normalizeProviderMatch).filter(m => isLive ? m.status === "LIVE" : m.status === "NS");

  if (!matches.length) return { status: "NO_MATCHES", picks: [], message: "Uygun maç bulunamadı." };

  const picks = [];
  const limit = mode === "surprise" ? 10 : mode === "prematch" ? 2 : 1;
  for (const m of matches.slice(0, limit)) {
    const [hForm, aForm] = await Promise.all([
      fetchTeamRecentForm(m.homeId, m.id),
      fetchTeamRecentForm(m.awayId, m.id)
    ]);
    const dynamicScores = scorePrediction(m, hForm, aForm);
    const chosenMarket = mode === "live" ? dynamicScores.livePick : dynamicScores.mainPick;

    picks.push({
      fixtureId: m.id,
      league: m.league,
      home: m.home,
      away: m.away,
      market: chosenMarket || "MS 1.5 ÜST",
      currentScore: `${m.homeScore}-${m.awayScore}`,
      minute: m.minute
    });
  }

  const coupon = { draftId: `coupon-${Date.now()}`, date: date || new Date().toISOString().slice(0,10), type: mode, status: "READY", picks };
  await sendTelegram(`🎯 WINSCOPE KUPON (${mode.toUpperCase()})\n` + picks.map(p => `${p.home} vs ${p.away} — Tercih: ${p.market}`).join('\n'));
  archives.coupons.unshift(coupon);
  await saveArchiveItem("coupon", coupon);
  return coupon;
}

app.get("/api/coupon/best", async (req, res) => { res.json(await createCouponByMode(String(req.query.date || ""), "prematch")); });
app.get("/api/coupon/surprise", async (req, res) => { res.json(await createCouponByMode(String(req.query.date || ""), "surprise")); });
app.get("/api/coupon/live-best", async (req, res) => { res.json(await createCouponByMode(String(req.query.date || ""), "live")); });

app.get("/api/match/:id/analyze", async (req, res) => {
  try {
    const payload = await cachedProviderRequest(`fixture:${req.params.id}`, `/fixtures?id=${encodeURIComponent(req.params.id)}`, 15000);
    const row = payload.response?.[0];
    if (!row) return res.status(404).json({ error: "Maç verisi bulunamadı." });
    const match = normalizeProviderMatch(row);

    const [prematchOddsPayload, homeForm, awayForm] = await Promise.all([
      cachedProviderRequest(`odds-fixture:${match.id}`, `/odds?fixture=${match.id}`, 90000).catch(() => ({ response: [] })),
      fetchTeamRecentForm(match.homeId, match.id),
      fetchTeamRecentForm(match.awayId, match.id)
    ]);

    const prematchRow = (prematchOddsPayload.response || []).find(x => Number(x.fixture?.id) === match.id) || null;
    const oddsList = oddsForFixture(prematchRow);
    const scores = scorePrediction(match, homeForm, awayForm);

    const getMarket = (key) => oddsList.find(o => o.market === key);
    const formatOdds = (item) => item ? `Oran: ${item.odd || '—'} (%${item.probability ? item.probability.toFixed(0) : '—'}) [${item.bookmaker}]` : "Veri Yok";
    const format1X2 = (item) => item && item.homeOdd ? `1: ${item.homeOdd} | X: ${item.drawOdd} | 2: ${item.awayOdd} [${item.bookmaker}]` : "Veri Yok";

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
      mainPick: scores.mainPick,
      alternative: scores.alternative,
      livePick: scores.livePick,
      note: `Bet365 / Bürolar taranmıştır. Form Ortalaması: Ev ${homeForm.avgGoalsFor?.toFixed(1) || 0} - Dep ${awayForm.avgGoalsFor?.toFixed(1) || 0}`
    });
  } catch (e) {
    res.status(502).json({ error: "Analiz üretilemedi.", detail: e.message });
  }
});

app.get("/api/live", async (_req, res) => {
  try {
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 20000);
    res.json({ matches: (payload.response || []).map(normalizeProviderMatch) });
  } catch { res.json({ matches: [] }); }
});

app.get("/api/fixtures", async (req, res) => {
  const date = String(req.query.date || "");
  try {
    const payload = await cachedProviderRequest(`fixtures:${date}`, `/fixtures?date=${date}&timezone=Europe/Istanbul`, 60000);
    res.json({ matches: (payload.response || []).map(normalizeProviderMatch) });
  } catch { res.json({ matches: [] }); }
});

app.listen(PORT, () => console.log(`WinScope running on port ${PORT}`));
