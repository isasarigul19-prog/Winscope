import express from "express";
import path from "node:path";
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

const providerCache = new Map();
const archives = { analyses: [], coupons: [] };
const drafts = new Map();

async function cachedProviderRequest(cacheKey, pathname, ttlMs = 30000) {
  const now = Date.now();
  const cached = providerCache.get(cacheKey);
  if (cached && now - cached.at < ttlMs) return cached.payload;
  if (!API_KEY) throw new Error("Render Environment Variables içinde API_FOOTBALL_KEY eksik.");
  const response = await fetch(`${BASE_URL}${pathname}`, {
    headers: { "x-apisports-key": API_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(15000)
  });
  const raw = await response.text();
  let payload;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { throw new Error("API-Football geçerli JSON döndürmedi."); }
  if (!response.ok || (payload.errors && Object.keys(payload.errors).length)) {
    const detail = payload.errors ? JSON.stringify(payload.errors) : `HTTP ${response.status}`;
    throw new Error(`API-Football hatası: ${detail}`);
  }
  providerCache.set(cacheKey, { at: now, payload });
  return payload;
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
  else if (["NS", "TBD", "PST", "CANC", "ABD", "AWD", "WO"].includes(status)) status = status === "NS" ? "NS" : status;
  return {
    id: idNum, league: String(leagueName), country: String(countryName),
    minute: match.fixture?.status?.elapsed ?? match.minute ?? null, status,
    home: String(homeName), away: String(awayName),
    homeScore: match.goals?.home ?? 0, awayScore: match.goals?.away ?? 0,
    htHomeScore: match.score?.halftime?.home ?? null, htAwayScore: match.score?.halftime?.away ?? null,
    fixtureDate: match.fixture?.date || match.kickoff_utc || null
  };
}

function computeAnalysis(match) {
  const minute = Number(match.minute || 0);
  const home = Number(match.homeScore || 0), away = Number(match.awayScore || 0);
  const total = home + away, live = match.status === "LIVE", finished = match.status === "FT";
  let ht = "Tahmin: veri yetersiz", ft = "Tahmin: veri yetersiz", mainPick = "UZAK DUR", alternative = "UZAK DUR";
  if (finished) {
    ht = `${match.htHomeScore ?? "?"}-${match.htAwayScore ?? "?"}`;
    ft = `${home}-${away}`;
  } else if (live) {
    if (minute >= 45 && match.htHomeScore != null && match.htAwayScore != null) ht = `${match.htHomeScore}-${match.htAwayScore} (İY Gerçek)`;
    else if (minute < 45 && total > 0) ht = `Tahmin: ${home}-${away}`;
    else if (minute <= 30) ht = "Tahmin: 1-0";
    else ht = "Tahmin: 0-0";
    ft = minute >= 75 ? `Tahmin: ${home}-${away}` : `Tahmin: ${home + 1}-${away}`;
    if (minute < 33 && total === 0) { mainPick = "İY 0.5 ÜST"; alternative = "MS 1.5 ÜST"; }
    else if (minute >= 33 && minute < 45 && total === 0) { mainPick = "MS 1.5 ÜST"; alternative = "UZAK DUR"; }
    else if (minute >= 45 && total < 2) { mainPick = "MS 1.5 ÜST"; alternative = "UZAK DUR"; }
    else { mainPick = "UZAK DUR"; alternative = "UZAK DUR"; }
  } else {
    ht = "Tahmin: oran/veri analizi gerekli";
    ft = "Tahmin: oran/veri analizi gerekli";
    mainPick = "UZAK DUR"; alternative = "UZAK DUR";
  }
  return { halfTimeScore: ht, fullTimeScore: ft, mainPick, alternative, surprise: "Veri desteklemediği için sürpriz tahmin üretilmedi" };
}

function oddsForFixture(oddsRow) {
  const candidates = [];
  const preferred = [
    { names: ["Goals Over/Under", "Over/Under"], value: "Over 1.5", market: "MS 1.5 ÜST", rank: 1 },
    { names: ["Goals Over/Under", "Over/Under"], value: "Over 2.5", market: "MS 2.5 ÜST", rank: 2 },
    { names: ["Both Teams Score", "Both Teams to Score"], value: "Yes", market: "KG VAR", rank: 3 },
    { names: ["First Half Goals Over/Under", "1st Half Goals Over/Under", "Half Time Over/Under"], value: "Over 0.5", market: "İY 0.5 ÜST", rank: 4 }
  ];
  for (const bookmaker of (oddsRow.bookmakers || [])) {
    for (const bet of (bookmaker.bets || [])) {
      const betName = String(bet.name || "").toLowerCase();
      for (const rule of preferred) {
        if (!rule.names.some(n => betName.includes(n.toLowerCase()))) continue;
        for (const value of (bet.values || [])) {
          const label = String(value.value || "").trim().toLowerCase();
          if (label !== rule.value.toLowerCase()) continue;
          const odd = Number(value.odd);
          if (Number.isFinite(odd) && odd > 1.01) candidates.push({ market: rule.market, odd, rank: rule.rank, bookmaker: bookmaker.name || "Kaynak belirtilmedi" });
        }
      }
    }
  }
  return candidates.sort((a, b) => a.rank - b.rank || a.odd - b.odd);
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { sent: false, reason: "TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID tanımlı değil." };
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(12000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) throw new Error(result.description || `Telegram HTTP ${response.status}`);
  return { sent: true };
}

function couponMessage(coupon) {
  const heading = coupon.type === "surprise" ? "🎲 WINSCOPE SÜRPRİZ KUPON" : coupon.type === "live" ? "⚡ WINSCOPE CANLI KOMBİN" : "🎯 WINSCOPE MAÇ ÖNÜ KUPON";
  const lines = [heading, `Tarih: ${coupon.date || "Bugün"}`, ""];
  coupon.picks.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.home} - ${p.away}`, `Tercih: ${p.market}`, `Lig: ${p.league}`, "");
  });
  lines.push("Not: Oranlar arka planda değerlendirilmiştir; mesajda gösterilmez.", "WinScope otomatik analizidir; kesin sonuç garantisi değildir.");
  return lines.join("\n");
}

async function createPrematchCoupon(type, date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Geçerli bir maç tarihi seç.");
  const fixturesPayload = await cachedProviderRequest(`fixtures:${date}`, `/fixtures?date=${date}&timezone=Europe/Istanbul`, 60000);
  const fixtures = (fixturesPayload.response || []).map(normalizeProviderMatch).filter(m => m.id && m.status === "NS");
  if (!fixtures.length) return { draftId: `coupon-${Date.now()}`, date, type, status: "NO_MATCHES", picks: [], message: "Bu tarihte başlamamış maç bulunamadı." };

  // API-Football tarih bazlı oran uç noktası: tek çağrıyla mümkün olan oranları alır.
  const oddsPayload = await cachedProviderRequest(`odds-date:${date}`, `/odds?date=${date}`, 90000);
  const oddsRows = oddsPayload.response || [];
  const oddsByFixture = new Map(oddsRows.map(row => [Number(row.fixture?.id), row]));
  const maxPicks = type === "surprise" ? 10 : 5;
  const maxOdd = type === "surprise" ? 2.50 : 1.85;
  const candidates = [];
  for (const fixture of fixtures) {
    const row = oddsByFixture.get(fixture.id);
    if (!row) continue;
    const choices = oddsForFixture(row).filter(x => x.odd <= maxOdd && (type === "surprise" || x.odd >= 1.20));
    if (!choices.length) continue;
    const chosen = type === "surprise"
      ? [...choices].sort((a, b) => b.odd - a.odd || a.rank - b.rank)[0]
      : choices[0];
    candidates.push({
      fixtureId: fixture.id, league: fixture.league, home: fixture.home, away: fixture.away,
      fixtureDate: fixture.fixtureDate, market: chosen.market, source: chosen.bookmaker,
      internalOdd: chosen.odd, minute: null, currentScore: "0-0"
    });
  }
  // En uygun oran aralığındakiler önce gelir; aynı maçtan tek seçim.
  candidates.sort((a, b) => Math.abs(a.internalOdd - (type === "surprise" ? 2.0 : 1.55)) - Math.abs(b.internalOdd - (type === "surprise" ? 2.0 : 1.55)));
  const picks = candidates.slice(0, maxPicks);
  const coupon = {
    draftId: `${type}-${Date.now()}`, date, type, isLive: false,
    status: picks.length ? "READY" : "NO_MATCHES", picks,
    message: picks.length ? "" : "API-Football bu tarihte uygun maç önü oranı döndürmedi. Oran veya istatistik uydurulmadı."
  };
  drafts.set(coupon.draftId, coupon);
  if (picks.length) {
    archives.coupons.unshift({ date, isLive: false, type, picks: picks.map(({ internalOdd, ...p }) => p), createdAt: new Date().toISOString() });
    archives.coupons = archives.coupons.slice(0, 50);
  }
  return { ...coupon, picks: picks.map(({ internalOdd, ...p }) => p) };
}

app.get("/api/health", (_req, res) => res.json({
  ok: true, apiKeyConfigured: Boolean(API_KEY),
  telegramConfigured: Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID)
}));

app.get("/api/match/:id/analyze", async (req, res) => {
  try {
    const payload = await cachedProviderRequest(`fixture:${req.params.id}`, `/fixtures?id=${encodeURIComponent(req.params.id)}`, 15000);
    const row = payload.response?.[0];
    if (!row) return res.status(404).json({ error: "Maç verisi bulunamadı." });
    const match = normalizeProviderMatch(row);
    const a = computeAnalysis(match);
    res.json({
      fixtureId: match.id, matchStatus: match.status, ...a,
      marketPercentages: {
        ht05: { percent: null, sampleSize: 0 }, ht15: { percent: null, sampleSize: 0 },
        ms05: { percent: null, sampleSize: 0 }, ms15: { percent: null, sampleSize: 0 },
        ms25: { percent: null, sampleSize: 0 }, btts: { percent: null, sampleSize: 0 }
      },
      note: "Gerçek örneklem verisi bu sürümde doğrulanmadığından yüzde üretilmedi."
    });
  } catch (e) { res.status(502).json({ error: "Analiz üretilemedi.", detail: e.message }); }
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Tarih YYYY-MM-DD biçiminde olmalı." });
  try {
    const payload = await cachedProviderRequest(`fixtures:${date}`, `/fixtures?date=${date}&timezone=Europe/Istanbul`, 60000);
    const matches = (payload.response || []).map(normalizeProviderMatch);
    res.json({ source: "API-Football", results: matches.length, matches });
  } catch (e) { res.status(502).json({ error: "Bülten alınamadı", detail: e.message, matches: [] }); }
});

app.get("/api/coupon/daily", async (req, res) => {
  try { res.json(await createPrematchCoupon("daily", String(req.query.date || ""))); }
  catch (e) { res.status(502).json({ status: "ERROR", picks: [], error: "Maç önü kuponu oluşturulamadı.", detail: e.message }); }
});
app.get("/api/coupon/surprise", async (req, res) => {
  try { res.json(await createPrematchCoupon("surprise", String(req.query.date || ""))); }
  catch (e) { res.status(502).json({ status: "ERROR", picks: [], error: "Sürpriz kupon oluşturulamadı.", detail: e.message }); }
});

app.get("/api/coupon/live", async (_req, res) => {
  // Canlı oran kullanımı istenmediği için canlı kupon, gerçek canlı oran bulunmadıkça üretilmez.
  res.json({ draftId: `live-${Date.now()}`, isLive: true, type: "live", status: "NO_MATCHES", picks: [], message: "Canlı oranlar kullanılmıyor. Maç önü oranlarından canlı kombin üretilmedi." });
});

app.post("/api/coupon/approve", async (req, res) => {
  const coupon = drafts.get(String(req.body?.draftId || ""));
  if (!coupon || !coupon.picks?.length) return res.status(404).json({ success: false, error: "Kupon taslağı bulunamadı veya boş." });
  try {
    const result = await sendTelegram("✅ WINSCOPE KUPON ONAYLANDI\n\n" + couponMessage(coupon));
    res.json({ success: true, telegram: result });
  } catch (e) {
    res.status(502).json({ success: false, error: "Kupon kaydedildi ancak Telegram gönderilemedi.", detail: e.message });
  }
});

app.post("/api/analyses/approve", (req, res) => {
  const body = req.body || {};
  if (!body.fixtureId || !body.home || !body.away) return res.status(400).json({ success: false, error: "Maç bilgileri eksik." });
  archives.analyses.unshift({
    fixture_id: Number(body.fixtureId), home_team: String(body.home), away_team: String(body.away),
    analysis: body.analysis || {}, created_at: new Date().toISOString()
  });
  archives.analyses = archives.analyses.slice(0, 100);
  res.json({ success: true });
});

app.get("/api/archives", (_req, res) => res.json({ analyses: archives.analyses, coupons: archives.coupons }));

app.get("/api/match/:id/stats", async (req, res) => {
  try {
    const payload = await cachedProviderRequest(`stats:${req.params.id}`, `/fixtures/statistics?fixture=${encodeURIComponent(req.params.id)}`, 30000);
    res.json({ success: true, stats: payload.response || [] });
  } catch (e) { res.status(502).json({ success: false, error: "İstatistik alınamadı.", detail: e.message, stats: [] }); }
});

app.listen(PORT, () => console.log(`WinScope server running on port ${PORT}`));
