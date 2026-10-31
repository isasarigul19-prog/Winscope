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
app.use(express.static(path.join(ROOT, "public")));

app.get("/", async (_req, res) => {
  for (const candidate of [path.join(ROOT, "public", "index.html"), path.join(ROOT, "index.html")]) {
    try { return res.type("html").send(await fs.readFile(candidate, "utf8")); } catch {}
  }
  return res.status(500).send("public/index.html bulunamadı.");
});

const providerCache = new Map();
const providerInFlight = new Map();
const archives = { analyses: [], coupons: [] };
const { Pool } = pg;
const databasePool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL) ? false : { rejectUnauthorized: false } })
  : null;
const telegramSentFixtureIds = new Set();
const goalTrackedFixtures = new Map();
const goalScoreCache = new Map();
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
        fixture_id BIGINT PRIMARY KEY, match_date DATE, coupon_type TEXT, sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      await databasePool.query(`CREATE TABLE IF NOT EXISTS winscope_goal_tracking (
        fixture_id BIGINT PRIMARY KEY, home_team TEXT NOT NULL DEFAULT '', away_team TEXT NOT NULL DEFAULT '',
        league_name TEXT NOT NULL DEFAULT '', source_label TEXT NOT NULL DEFAULT 'Telegram maç takibi',
        last_score TEXT NOT NULL DEFAULT '0-0', active BOOLEAN NOT NULL DEFAULT TRUE, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )`);
      const [a, c, s, t] = await Promise.all([
        databasePool.query("SELECT payload FROM winscope_archive WHERE category='analysis' ORDER BY id DESC LIMIT 100"),
        databasePool.query("SELECT payload FROM winscope_archive WHERE category='coupon' ORDER BY id DESC LIMIT 50"),
        databasePool.query("SELECT fixture_id FROM winscope_telegram_fixture_sent"),
        databasePool.query("SELECT fixture_id,home_team,away_team,league_name,source_label,last_score FROM winscope_goal_tracking WHERE active=TRUE")
      ]);
      archives.analyses = a.rows.map(x => x.payload);
      archives.coupons = c.rows.map(x => x.payload);
      for (const r of s.rows) telegramSentFixtureIds.add(Number(r.fixture_id));
      for (const r of t.rows) {
        const id = Number(r.fixture_id);
        goalTrackedFixtures.set(id, { home: r.home_team, away: r.away_team, league: r.league_name, sourceLabel: r.source_label, baselineScore: r.last_score });
        goalScoreCache.set(id, r.last_score);
      }
      console.log("[Archive] PostgreSQL arşivi yüklendi.");
    } catch (e) { console.error("[Archive] PostgreSQL başlatılamadı:", e.message); }
  })();
}

async function saveArchiveItem(category, payload) {
  if (!databasePool) return { persisted: false };
  try {
    await archiveDatabaseReady;
    await databasePool.query("INSERT INTO winscope_archive(category,payload) VALUES($1,$2::jsonb)", [category, JSON.stringify(payload)]);
    return { persisted: true };
  } catch (e) { return { persisted: false, error: e.message }; }
}

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
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY eksik. Render Environment Variables bölümünü kontrol et.");

  const task = providerQueue.then(async () => {
    const again = providerCache.get(cacheKey);
    if (again && Date.now() - again.at < ttlMs) return again.payload;
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
    if (response.status === 429) {
      providerCooldownUntil = Date.now() + 60000;
      throw new Error("API-Football istek sınırına ulaşıldı; bir dakika sonra tekrar dene.");
    }
    if (!response.ok) throw new Error(`API hatası: ${response.status}`);
    if (payload.errors && Object.keys(payload.errors).length) {
      const message = Object.values(payload.errors).flat().join("; ");
      throw new Error(`API-Football: ${message}`);
    }
    providerCache.set(cacheKey, { at: Date.now(), payload });
    return payload;
  });
  providerQueue = task.catch(() => undefined);
  providerInFlight.set(cacheKey, task);
  try { return await task; } finally { providerInFlight.delete(cacheKey); }
}

function normalizeProviderMatch(match) {
  const statusRaw = String(match.fixture?.status?.short || match.status || "NS").toUpperCase();
  let status = "NS";
  if (["FT", "AET", "PEN"].includes(statusRaw)) status = "FT";
  else if (["1H", "2H", "HT", "LIVE", "IN_PLAY", "ET", "BT", "P"].includes(statusRaw)) status = "LIVE";
  return {
    id: Number(match.fixture?.id ?? match.id) || 0,
    homeId: Number(match.teams?.home?.id) || null, awayId: Number(match.teams?.away?.id) || null,
    league: String(match.league?.name || match.league || "Lig"),
    country: String(match.league?.country || match.country || ""),
    minute: match.fixture?.status?.elapsed ?? match.minute ?? null, status,
    home: String(match.teams?.home?.name || match.home || "Ev sahibi"),
    away: String(match.teams?.away?.name || match.away || "Deplasman"),
    homeScore: Number(match.goals?.home ?? 0), awayScore: Number(match.goals?.away ?? 0),
    htHomeScore: match.score?.halftime?.home ?? null, htAwayScore: match.score?.halftime?.away ?? null,
    fixtureDate: match.fixture?.date || match.kickoff_utc || null
  };
}

const norm = value => String(value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’']/g, "'").trim();
function parseOdd(value) {
  const n = Number(String(value ?? "").replace(",", "."));
  return Number.isFinite(n) && n > 1.01 && n < 1000 ? n : null;
}
function marketKey(name) {
  const n = norm(name);
  const half = /first half|1st half|half time|half-time|1st half result|first half result/.test(n);
  if (/both teams to score|btts/.test(n)) return half ? "İY KG" : "KG VAR";
  if (/asian handicap|handicap/.test(n)) return "AH";
  if (/match winner|1x2|full time result|regular time result|match result/.test(n)) return half ? "İY 1X2" : "MS 1X2";
  if (/over\/under|goals over\/under|total goals|goals/.test(n)) return half ? "İY OU" : "MS OU";
  return null;
}
function parseLabel(label) {
  const n = norm(label);
  const line = n.match(/(?:over|under|o|u)\s*([0-9]+(?:[.,][0-9]+)?)/) || n.match(/^([0-9]+(?:[.,][0-9]+)?)$/);
  const total = line ? Number(line[1].replace(",", ".")) : null;
  const side = /\b(over|o)\b/.test(n) ? "over" : /\b(under|u)\b/.test(n) ? "under" : null;
  if (/^(home|1|1 \(home\))$/.test(n)) return { side: "home" };
  if (/^(draw|x|tie)$/.test(n)) return { side: "draw" };
  if (/^(away|2|2 \(away\))$/.test(n)) return { side: "away" };
  if (/^(yes|y)$/.test(n)) return { side: "yes" };
  if (/^(no|n)$/.test(n)) return { side: "no" };
  if (total !== null && side) return { total, side };
  if (/-0[.,]5/.test(n) || /home -0[.,]5/.test(n)) return { side: "home" };
  return null;
}

/* Oranlar yalnızca motor içinde tutulur; API yanıtına ham oran gönderilmez.
   Her market için önce Bet365, yoksa o marketi sunan başka büro seçilir. */
function oddsForFixture(oddsRow) {
  const bookmakers = Array.isArray(oddsRow?.bookmakers) ? oddsRow.bookmakers : [];
  if (!bookmakers.length) return {};
  const sorted = [...bookmakers].sort((a, b) => Number(/bet365/i.test(b.name || "")) - Number(/bet365/i.test(a.name || "")));
  const result = {};
  const wantedLines = new Set([0.5, 1.5, 2.5, 3.5, 5.5]);

  for (const bookmaker of sorted) {
    for (const bet of (bookmaker.bets || [])) {
      const name = String(bet.name || "");
      const base = marketKey(name);
      if (!base) continue;
      for (const value of (bet.values || [])) {
        const parsed = parseLabel(value.value ?? value.name);
        const odd = parseOdd(value.odd);
        if (!parsed || !odd) continue;
        let key = null;
        if (base === "MS OU" || base === "İY OU") {
          if (parsed.total !== undefined && wantedLines.has(parsed.total)) key = `${base === "İY OU" ? "İY" : "MS"} ${parsed.total} ${parsed.side === "over" ? "ÜST" : "ALT"}`;
        } else if (base === "KG VAR" || base === "İY KG") {
          key = `${base}:${parsed.side}`;
        } else if (base === "MS 1X2" || base === "İY 1X2") {
          key = `${base}:${parsed.side}`;
        } else if (base === "AH" && (parsed.side === "home") && /-0[.,]5/.test(norm(value.value ?? value.name))) {
          key = "AH -0.5";
        }
        if (key && result[key] === undefined) result[key] = { odd, bookmaker: String(bookmaker.name || "Bilinmeyen büro") };
      }
    }
  }
  return result;
}

function marketProbability(odds, key) {
  const over = odds[`${key} ÜST`]?.odd;
  const under = odds[`${key} ALT`]?.odd;
  if (over && under) {
    const a = 1 / over, b = 1 / under;
    return a / (a + b);
  }
  return null;
}
function resultProbabilities(odds, key) {
  const h = odds[`${key}:home`]?.odd, d = odds[`${key}:draw`]?.odd, a = odds[`${key}:away`]?.odd;
  if (!h || !d || !a) return null;
  const vals = [1 / h, 1 / d, 1 / a], sum = vals.reduce((x, y) => x + y, 0);
  return { home: vals[0] / sum, draw: vals[1] / sum, away: vals[2] / sum };
}
function bttsProbability(odds) {
  const y = odds["KG VAR:yes"]?.odd, n = odds["KG VAR:no"]?.odd;
  return y && n ? (1 / y) / ((1 / y) + (1 / n)) : null;
}

async function fetchTeamRecentForm(teamId, fixtureId) {
  if (!teamId) return { available: false };
  try {
    const payload = await cachedProviderRequest(`form:${teamId}`, `/fixtures?team=${teamId}&last=10`, 6 * 60 * 60 * 1000);
    const rows = (payload.response || []).filter(row =>
      Number(row.fixture?.id) !== Number(fixtureId) &&
      ["FT", "AET", "PEN"].includes(String(row.fixture?.status?.short || "").toUpperCase()) &&
      Number.isFinite(Number(row.goals?.home)) && Number.isFinite(Number(row.goals?.away))
    ).slice(0, 5);
    if (!rows.length) return { available: false };
    let gf = 0, ga = 0, points = 0;
    for (const r of rows) {
      const isHome = Number(r.teams?.home?.id) === Number(teamId);
      const scored = Number(isHome ? r.goals.home : r.goals.away);
      const conceded = Number(isHome ? r.goals.away : r.goals.home);
      gf += scored; ga += conceded;
      points += scored > conceded ? 3 : scored === conceded ? 1 : 0;
    }
    return { available: true, avgGoalsFor: gf / rows.length, avgGoalsAgainst: ga / rows.length, pointsPerMatch: points / rows.length, sampleSize: rows.length };
  } catch { return { available: false }; }
}

async function fetchLiveStatistics(fixtureId) {
  if (!fixtureId) return null;
  try {
    const payload = await cachedProviderRequest(`stats:${fixtureId}`, `/fixtures/statistics?fixture=${fixtureId}`, 15000);
    const stats = payload.response || [];
    if (!stats.length) return null;
    const parseStat = teamStats => {
      const list = teamStats.statistics || [];
      const raw = type => list.find(s => norm(s.type).includes(norm(type)))?.value;
      const number = type => {
        const v = raw(type);
        if (v === null || v === undefined || v === "") return null;
        const n = Number(String(v).replace("%", "").replace(",", "."));
        return Number.isFinite(n) ? n : null;
      };
      return { shotsTotal: number("Total Shots") ?? 0, shotsOn: number("Shots on Goal") ?? 0,
        possession: number("Ball Possession"), corners: number("Corner Kicks") ?? 0, dangerousAttacks: number("Dangerous Attacks") };
    };
    if (stats.length < 2) return null;
    return { home: parseStat(stats[0]), away: parseStat(stats[1]) };
  } catch { return null; }
}

function factorial(n) { let out = 1; for (let i = 2; i <= n; i++) out *= i; return out; }
const poisson = (k, lambda) => Math.exp(-lambda) * Math.pow(lambda, k) / factorial(k);

function scorePrediction(match, homeForm, awayForm, odds, liveStats) {
  const hNow = Number(match.homeScore || 0), aNow = Number(match.awayScore || 0);
  const live = match.status === "LIVE";
  if (match.status === "FT") {
    return { halfTimeScore: `${match.htHomeScore ?? "?"}-${match.htAwayScore ?? "?"}`, fullTimeScore: `${hNow}-${aNow}`, mainPick: "Maç Bitti", alternative: "Maç Bitti", livePick: "Maç Bitti" };
  }

  const homeFor = homeForm?.available ? homeForm.avgGoalsFor : 1.25;
  const homeAgainst = homeForm?.available ? homeForm.avgGoalsAgainst : 1.15;
  const awayFor = awayForm?.available ? awayForm.avgGoalsFor : 1.05;
  const awayAgainst = awayForm?.available ? awayForm.avgGoalsAgainst : 1.25;
  let lambdaHome = Math.max(0.15, Math.min(3.0, (homeFor + awayAgainst) / 2));
  let lambdaAway = Math.max(0.15, Math.min(3.0, (awayFor + homeAgainst) / 2));

  // Maç önü 1X2 oranları takım gol beklentisini yumuşak biçimde etkiler.
  const ft1x2 = resultProbabilities(odds, "MS 1X2");
  if (ft1x2) {
    const balance = Math.max(0.78, Math.min(1.22, 1 + (ft1x2.home - ft1x2.away) * 0.35));
    const scale = Math.sqrt(balance);
    lambdaHome *= scale;
    lambdaAway /= scale;
  }
  const over25 = marketProbability(odds, "MS 2.5");
  if (over25 !== null) {
    const currentExpected = lambdaHome + lambdaAway;
    const target = Math.max(1.0, Math.min(4.0, 1.0 + over25 * 3.0));
    const scale = Math.max(0.75, Math.min(1.25, target / Math.max(0.5, currentExpected)));
    lambdaHome *= scale; lambdaAway *= scale;
  }
  const btts = bttsProbability(odds);
  if (btts !== null) {
    if (btts > 0.58) { lambdaHome = Math.max(lambdaHome, 0.95); lambdaAway = Math.max(lambdaAway, 0.85); }
    if (btts < 0.42) lambdaAway = Math.min(lambdaAway, 0.95);
  }

  let remHome = lambdaHome, remAway = lambdaAway;
  if (live) {
    const minute = Math.max(0, Math.min(95, Number(match.minute || 0)));
    const remaining = Math.max(0, 90 - minute);
    const timeFactor = Math.max(0.04, remaining / 90);
    remHome *= timeFactor; remAway *= timeFactor;
    if (liveStats) {
      const homePressure = liveStats.home.shotsOn * 0.12 + liveStats.home.corners * 0.025;
      const awayPressure = liveStats.away.shotsOn * 0.12 + liveStats.away.corners * 0.025;
      remHome *= Math.max(0.7, Math.min(1.35, 1 + homePressure - awayPressure * 0.35));
      remAway *= Math.max(0.7, Math.min(1.35, 1 + awayPressure - homePressure * 0.35));
    }
  }

  // En yüksek olasılıklı skor; oranlar gol toplamı beklentisini etkiler, skoru zorla belirlemez.
  let best = { p: -1, h: 0, a: 0 };
  for (let h = 0; h <= 5; h++) for (let a = 0; a <= 5; a++) {
    const p = poisson(h, remHome) * poisson(a, remAway);
    if (p > best.p) best = { p, h, a };
  }
  const ftH = live ? hNow + best.h : best.h;
  const ftA = live ? aNow + best.a : best.a;
  const currentMinute = Number(match.minute || 0);
  let htH, htA;
  if (live && currentMinute >= 45) {
    htH = match.htHomeScore ?? hNow;
    htA = match.htAwayScore ?? aNow;
  } else if (live) {
    // Devre öncesi skor tahmini, kalan ilk yarı golleri için düşük beklentiyle hesaplanır.
    const elapsed = Math.max(0, Math.min(45, currentMinute));
    const fraction = Math.max(0, (45 - elapsed) / 90);
    htH = hNow + Math.round(Math.min(remHome, lambdaHome * fraction) * 0.45);
    htA = aNow + Math.round(Math.min(remAway, lambdaAway * fraction) * 0.45);
  } else {
    htH = Math.min(ftH, Math.round(ftH * 0.42));
    htA = Math.min(ftA, Math.round(ftA * 0.42));
  }

  const total = ftH + ftA, both = ftH > 0 && ftA > 0;
  let mainPick, alternative;
  if (total >= 4) {
    mainPick = "MS 2.5 ÜST";
    alternative = both ? "KG VAR" : "MS 3.5 ÜST";
  } else if (total === 3) {
    mainPick = "MS 2.5 ÜST";
    alternative = both ? "KG VAR" : "MS 3.5 ALT";
  } else if (total === 2) {
    mainPick = "MS 1.5 ÜST";
    alternative = both ? "KG VAR" : "MS 2.5 ALT";
  } else {
    mainPick = "MS 2.5 ALT";
    alternative = total === 1 ? "MS 0.5 ÜST" : "MS 1.5 ALT";
  }

  let livePick = "Maç önü analizi";
  if (live) {
    const currentTotal = hNow + aNow;
    const remainingGoals = best.h + best.a;
    if (remainingGoals >= 2) livePick = currentTotal + remainingGoals >= 3 ? "MS 2.5 ÜST" : "MS 1.5 ÜST";
    else if (remainingGoals === 1) livePick = currentTotal === 0 ? "MS 0.5 ÜST" : `MS ${currentTotal + 0.5} ÜST`;
    else livePick = currentTotal >= 2 ? "MS 2.5 ALT" : "Gol beklentisi düşük — pas geç";
    // Skor zaten 1-0/0-1 ise ilk yarı 0.5 üst önerisi verme.
    if (currentMinute < 45 && currentTotal > 0 && livePick === "MS 0.5 ÜST") livePick = "İY 1.5 ÜST";
  }

  return {
    halfTimeScore: `${htH}-${htA}${live && currentMinute < 45 ? " (Tahmin)" : ""}`,
    fullTimeScore: `${ftH}-${ftA}${live ? " (Mevcut + kalan tahmin)" : ""}`,
    mainPick, alternative, livePick
  };
}

function oddsSummary(odds) {
  const has = key => Boolean(odds[key]);
  return {
    iy1x2: ["İY 1X2:home", "İY 1X2:draw", "İY 1X2:away"].every(has),
    ms1x2: ["MS 1X2:home", "MS 1X2:draw", "MS 1X2:away"].every(has),
    iy05: has("İY 0.5 ÜST"), iy15: has("İY 1.5 ÜST"),
    btts: has("KG VAR:yes") && has("KG VAR:no"),
    ms15: has("MS 1.5 ÜST"), ms25: has("MS 2.5 ÜST"),
    ms35: has("MS 3.5 ÜST"), ms55: has("MS 5.5 ÜST"), ah05: has("AH -0.5")
  };
}
function oddsSourceLabel(odds) {
  const names = [...new Set(Object.values(odds).map(x => x.bookmaker).filter(Boolean))];
  return names.length ? `Oran analizi: ${names.length > 1 ? "birden fazla bahis şirketi" : names[0]}; ham oranlar gizli.` : "Oran verisi bulunamadı; tahmin takım formu ve mevcut maç verileriyle üretildi.";
}

async function getOdds(match) {
  // API-Football canlı oran endpoint'i her hesap/ligde bulunmayabilir.
  // Canlı maçta yalnızca canlı oran endpoint'i denenir; maç önü oranına sessizce geri dönülmez.
  const endpoint = match.status === "LIVE"
    ? `/odds/live?fixture=${match.id}`
    : `/odds?fixture=${match.id}`;
  const key = `${match.status === "LIVE" ? "live-odds" : "prematch-odds"}:${match.id}`;
  try {
    const payload = await cachedProviderRequest(key, endpoint, match.status === "LIVE" ? 15000 : 90000);
    const row = (payload.response || []).find(x => Number(x.fixture?.id) === match.id) || payload.response?.[0] || null;
    return oddsForFixture(row);
  } catch (e) {
    console.warn(`[Odds] ${match.id}: ${e.message}`);
    return {};
  }
}

async function sendTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { sent: false, reason: "Telegram yapılandırılmamış." };
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }), signal: AbortSignal.timeout(10000)
    });
    const data = await response.json();
    return { sent: Boolean(data.ok), reason: data.ok ? undefined : (data.description || "Telegram mesajı gönderilemedi.") };
  } catch (e) { return { sent: false, reason: e.message }; }
}

async function createCouponByMode(date, mode = "prematch") {
  const isLive = mode === "live";
  const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Istanbul" });
  const url = isLive ? "/fixtures?live=all" : `/fixtures?date=${encodeURIComponent(targetDate)}&timezone=Europe/Istanbul`;
  const payload = await cachedProviderRequest(`coupon-${mode}-${targetDate}`, url, isLive ? 15000 : 60000);
  const matches = (payload.response || []).map(normalizeProviderMatch).filter(m => isLive ? m.status === "LIVE" : m.status === "NS");
  if (!matches.length) return { status: "NO_MATCHES", picks: [], message: "Uygun maç bulunamadı." };

  const limit = mode === "surprise" ? 10 : mode === "prematch" ? 2 : 1;
  const analyzed = [];
  for (const m of matches.slice(0, mode === "surprise" ? 30 : 12)) {
    const [hForm, aForm, liveStats, odds] = await Promise.all([
      fetchTeamRecentForm(m.homeId, m.id), fetchTeamRecentForm(m.awayId, m.id),
      isLive ? fetchLiveStatistics(m.id) : Promise.resolve(null), getOdds(m)
    ]);
    const scores = scorePrediction(m, hForm, aForm, odds, liveStats);
    const market = isLive ? scores.livePick : scores.mainPick;
    const confidence = (hForm.available ? 1 : 0) + (aForm.available ? 1 : 0) +
      (Object.keys(odds).length ? 1 : 0) + (isLive && liveStats ? 1 : 0);
    analyzed.push({ fixtureId: m.id, league: m.league, home: m.home, away: m.away, market, currentScore: `${m.homeScore}-${m.awayScore}`, minute: m.minute, _confidence: confidence });
  }
  analyzed.sort((a, b) => b._confidence - a._confidence);
  const picks = analyzed.slice(0, limit).map(({ _confidence, ...p }) => p);
  const coupon = { draftId: `coupon-${Date.now()}`, date: targetDate, type: mode, status: "READY", picks };
  const tg = await sendTelegram(`🎯 WINSCOPE KUPON (${mode.toUpperCase()})\n${picks.map(p => `${p.home} vs ${p.away} — Tercih: ${p.market}`).join("\n")}`);
  coupon.telegramSent = tg.sent;
  archives.coupons.unshift(coupon);
  archives.coupons = archives.coupons.slice(0, 50);
  await saveArchiveItem("coupon", coupon);
  return coupon;
}

app.get("/api/coupon/best", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || ""), "prematch")); }
  catch (e) { res.status(502).json({ status: "ERROR", error: e.message }); }
});
app.get("/api/coupon/surprise", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || ""), "surprise")); }
  catch (e) { res.status(502).json({ status: "ERROR", error: e.message }); }
});
app.get("/api/coupon/live-best", async (_req, res) => {
  try { res.json(await createCouponByMode("", "live")); }
  catch (e) { res.status(502).json({ status: "ERROR", error: e.message }); }
});

app.get("/api/match/:id/analyze", async (req, res) => {
  try {
    const fixtureId = Number(req.params.id);
    if (!Number.isInteger(fixtureId) || fixtureId <= 0) return res.status(400).json({ error: "Geçersiz maç numarası." });
    const payload = await cachedProviderRequest(`fixture:${fixtureId}`, `/fixtures?id=${fixtureId}`, 15000);
    const row = payload.response?.[0];
    if (!row) return res.status(404).json({ error: "Maç verisi bulunamadı." });
    const match = normalizeProviderMatch(row);
    const [odds, homeForm, awayForm, liveStats] = await Promise.all([
      getOdds(match), fetchTeamRecentForm(match.homeId, match.id), fetchTeamRecentForm(match.awayId, match.id),
      match.status === "LIVE" ? fetchLiveStatistics(match.id) : Promise.resolve(null)
    ]);
    const scores = scorePrediction(match, homeForm, awayForm, odds, liveStats);
    const markets = oddsSummary(odds);
    const result = {
      fixtureId: match.id, matchStatus: match.status,
      halfTimeScore: scores.halfTimeScore, fullTimeScore: scores.fullTimeScore,
      mainPick: scores.mainPick, alternative: scores.alternative, livePick: scores.livePick,
      markets, note: oddsSourceLabel(odds),
      form: { homeAvailable: Boolean(homeForm.available), awayAvailable: Boolean(awayForm.available), sampleSize: Math.min(homeForm.sampleSize || 0, awayForm.sampleSize || 0) },
      liveStatsAvailable: Boolean(liveStats)
    };
    archives.analyses.unshift({ ...result, home: match.home, away: match.away, createdAt: new Date().toISOString() });
    archives.analyses = archives.analyses.slice(0, 100);
    await saveArchiveItem("analysis", { ...result, home: match.home, away: match.away, createdAt: new Date().toISOString() });
    res.json(result);
  } catch (e) { res.status(502).json({ error: "Analiz üretilemedi.", detail: e.message }); }
});

app.get("/api/live", async (_req, res) => {
  try {
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 20000);
    res.json({ matches: (payload.response || []).map(normalizeProviderMatch) });
  } catch (e) { res.status(502).json({ matches: [], error: e.message }); }
});
app.get("/api/fixtures", async (req, res) => {
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ matches: [], error: "Tarih YYYY-AA-GG biçiminde olmalı." });
  try {
    const payload = await cachedProviderRequest(`fixtures:${date}`, `/fixtures?date=${encodeURIComponent(date)}&timezone=Europe/Istanbul`, 60000);
    res.json({ matches: (payload.response || []).map(normalizeProviderMatch) });
  } catch (e) { res.status(502).json({ matches: [], error: e.message }); }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, apiKeyConfigured: Boolean(API_KEY), databaseConfigured: Boolean(databasePool), telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) }));
app.listen(PORT, () => console.log(`WinScope running on port ${PORT}`));
