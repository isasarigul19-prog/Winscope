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
    { names: ["Goals Over/Under", "Over/Under"], value: "Over 0.5", market: "MS 0.5 ÜST", rank: 1 },
    { names: ["Goals Over/Under", "Over/Under"], value: "Over 1.5", market: "MS 1.5 ÜST", rank: 2 },
    { names: ["Goals Over/Under", "Over/Under"], value: "Over 2.5", market: "MS 2.5 ÜST", rank: 4 },
    { names: ["Both Teams Score", "Both Teams to Score"], value: "Yes", market: "KG VAR", rank: 5 },
    { names: ["First Half Goals Over/Under", "1st Half Goals Over/Under", "Half Time Over/Under"], value: "Over 0.5", market: "İY 0.5 ÜST", rank: 3 },
    { names: ["First Half Goals Over/Under", "1st Half Goals Over/Under", "Half Time Over/Under"], value: "Over 1.5", market: "İY 1.5 ÜST", rank: 6 }
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
  const heading = coupon.type === "surprise" ? "🎲 WINSCOPE MAÇ ÖNÜ SÜRPRİZ 10 MAÇ" :
    coupon.type === "live" ? "⚡ WINSCOPE CANLI EN GÜVENİLİR TEK TERCİH" :
    "🎯 WINSCOPE MAÇ ÖNÜ KUPONU";
  const lines = [heading, `Tarih: ${coupon.date || "Bugün"}`, ""];
  coupon.picks.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.home} - ${p.away}`, `Tercih: ${p.market}`, `Lig: ${p.league}`, "");
  });
  lines.push("Not: Oranlar arka planda değerlendirilmiştir; mesajda gösterilmez.", "WinScope otomatik analizidir; kesin sonuç garantisi değildir.");
  return lines.join("\n");
}


async function getOddsForFixture(fixtureId, date) {
  // Prefer date-level odds for the bulletin, then fall back to fixture-specific odds.
  let row = null;
  if (date) {
    try {
      const byDate = await cachedProviderRequest(`odds-date:${date}`, `/odds?date=${encodeURIComponent(date)}`, 90000);
      row = (byDate.response || []).find(x => Number(x.fixture?.id) === Number(fixtureId)) || null;
    } catch (e) {
      console.warn("Date odds lookup failed:", e.message);
    }
  }
  if (!row) {
    const byFixture = await cachedProviderRequest(`odds-fixture:${fixtureId}`, `/odds?fixture=${encodeURIComponent(fixtureId)}`, 90000);
    row = (byFixture.response || []).find(x => Number(x.fixture?.id) === Number(fixtureId)) || byFixture.response?.[0] || null;
  }
  return row;
}

function rankSingleMatchChoices(choices, mode = "prematch") {
  const allowed = choices.filter(x => x.odd >= 1.15 && x.odd <= 2.10);
  return allowed.sort((a, b) => {
    // Conservative odds first; tie-break with market hierarchy, not invented percentages.
    return Math.abs(a.odd - 1.35) - Math.abs(b.odd - 1.35) || a.rank - b.rank;
  });
}


async function createCouponByMode(date, mode = "prematch") {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Geçerli bir maç tarihi seç.");
  const isLiveMode = mode === "live";
  const fixturePath = isLiveMode
    ? "/fixtures?live=all"
    : `/fixtures?date=${encodeURIComponent(date)}&timezone=Europe/Istanbul`;
  const fixtureKey = isLiveMode ? "liveListForCoupon" : `fixtures:${date}`;
  const fixturePayload = await cachedProviderRequest(fixtureKey, fixturePath, isLiveMode ? 15000 : 60000);
  let fixtures = (fixturePayload.response || []).map(normalizeProviderMatch)
    .filter(m => m.id && (isLiveMode ? m.status === "LIVE" : m.status === "NS"));

  if (!fixtures.length) {
    return { draftId: `coupon-${Date.now()}`, date, type: mode, status: "NO_MATCHES", picks: [],
      message: isLiveMode ? "Şu anda uygun canlı maç bulunamadı." : "Seçilen tarihte başlamamış maç bulunamadı." };
  }

  const candidates = [];
  const errors = [];
  let dateOdds = [];
  if (!isLiveMode) {
    try {
      const payload = await cachedProviderRequest(`odds-date:${date}`, `/odds?date=${encodeURIComponent(date)}`, 90000);
      dateOdds = payload.response || [];
    } catch (e) { errors.push(e.message); }
  }
  const oddsMap = new Map(dateOdds.map(row => [Number(row.fixture?.id), row]));

  for (const fixture of fixtures) {
    try {
      let oddsRow = null;
      let oddsBasis = "";
      if (isLiveMode) {
        const livePayload = await cachedProviderRequest(`odds-live:${fixture.id}`, `/odds/live?fixture=${fixture.id}`, 15000);
        oddsRow = (livePayload.response || []).find(row => Number(row.fixture?.id) === fixture.id) || null;
        if (!oddsRow) continue;
        oddsBasis = "API-Football canlı oran kaydı";
      } else {
        oddsRow = oddsMap.get(fixture.id) || null;
        if (!oddsRow) {
          const payload = await cachedProviderRequest(`odds-fixture:${fixture.id}`, `/odds?fixture=${fixture.id}`, 90000);
          oddsRow = (payload.response || []).find(row => Number(row.fixture?.id) === fixture.id) || payload.response?.[0] || null;
        }
        if (!oddsRow) continue;
        oddsBasis = "API-Football maç önü oran kaydı; resmî kapanış olduğu garanti edilemez";
      }

      // For live picks, require current match statistics as well as live odds.
      let statsSummary = null;
      if (isLiveMode) {
        const statsPayload = await cachedProviderRequest(`stats:${fixture.id}`, `/fixtures/statistics?fixture=${fixture.id}`, 15000);
        const stats = statsPayload.response || [];
        const values = stats.flatMap(team => (team.statistics || []).map(st => ({
          type: String(st.type || "").toLowerCase(), value: st.value
        })));
        const hasUsefulStats = values.some(v => /shots on goal|total shots|dangerous attacks|shots off goal|corner kicks|ball possession/.test(v.type) && v.value != null);
        if (!hasUsefulStats) continue;
        statsSummary = values.filter(v => /shots on goal|total shots|dangerous attacks|corner kicks/.test(v.type) && v.value != null)
          .slice(0, 8).map(v => `${v.type}: ${v.value}`);
      }

      let choices = rankSingleMatchChoices(oddsForFixture(oddsRow), mode);
      // Do not recommend half-time goals after half-time or when match state contradicts it.
      if (isLiveMode) {
        if (Number(fixture.minute) > 45 || fixture.status === "HT") {
          choices = choices.filter(c => !c.market.startsWith("İY "));
        }
        if (Number(fixture.minute) >= 45 && Number(fixture.homeScore) + Number(fixture.awayScore) >= 1) {
          choices = choices.filter(c => c.market === "İY 1.5 ÜST" ? false : true);
        }
        // A live market must be backed by live odds and actual match stats; otherwise skip.
      }
      if (!choices.length) continue;

      // Keep only one preferred market per fixture.
      const chosen = choices[0];
      candidates.push({
        fixtureId: fixture.id, league: fixture.league, country: fixture.country,
        home: fixture.home, away: fixture.away, fixtureDate: fixture.fixtureDate,
        market: chosen.market, source: chosen.bookmaker, internalOdd: chosen.odd,
        minute: isLiveMode ? fixture.minute : null,
        currentScore: `${fixture.homeScore}-${fixture.awayScore}`,
        isLive: isLiveMode, rank: chosen.rank, oddsBasis, statsSummary,
        scoreTotal: Number(fixture.homeScore || 0) + Number(fixture.awayScore || 0)
      });
    } catch (e) {
      errors.push(`${fixture.home} - ${fixture.away}: ${e.message}`);
    }
  }

  candidates.sort((a, b) => {
    // More conservative odds first. Keep market/odds internal; never fabricate confidence %.
    return a.internalOdd - b.internalOdd || a.rank - b.rank;
  });

  const count = mode === "surprise" ? 10 : mode === "prematch" ? 2 : 1;
  const chosen = candidates.slice(0, count);
  if (!chosen.length || (mode === "prematch" && chosen.length < 2) || (mode === "surprise" && chosen.length < 10)) {
    const needed = mode === "surprise" ? 10 : mode === "prematch" ? 2 : 1;
    return { draftId: `coupon-${Date.now()}`, date, type: mode, status: "NO_MATCHES", picks: [],
      message: `Güvenilir seçim için gerekli sayıda doğrulanabilir maç bulunamadı (gereken: ${needed}). Eksik veriyle kupon üretilmedi.`,
      detail: errors.slice(0, 3).join(" | ") };
  }

  const publicPicks = chosen.map(({ internalOdd, rank, scoreTotal, ...p }) => p);
  const draftId = `coupon-${Date.now()}`;
  const coupon = {
    draftId, date, type: mode, isLive: isLiveMode, status: "READY", picks: publicPicks,
    message: mode === "live"
      ? "Tek canlı tercih: canlı oran ve maç istatistiği bulunan maçlardan seçildi."
      : mode === "surprise"
        ? "10 maçlık sürpriz kupon. Tüm maçlar için doğrulanabilir oran bulunması şarttır."
        : "Maç önü kuponu: en az iki maç ve doğrulanabilir maç önü oranları."
  };
  drafts.set(draftId, { ...coupon, picks: chosen });
  archives.coupons.unshift({ date, type: mode, picks: publicPicks, createdAt: new Date().toISOString() });
  archives.coupons = archives.coupons.slice(0, 50);
  return coupon;
}

app.get("/api/telegram/status", async (_req, res) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(503).json({
      ok: false,
      configured: false,
      botActive: false,
      chatConfigured: Boolean(TELEGRAM_CHAT_ID),
      message: "Render Environment içinde TELEGRAM_BOT_TOKEN ve TELEGRAM_CHAT_ID kontrol edilmeli."
    });
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`, {
      signal: AbortSignal.timeout(10000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      return res.status(502).json({
        ok: false, configured: true, botActive: false,
        message: result.description || `Telegram API HTTP ${response.status}`
      });
    }
    return res.json({
      ok: true, configured: true, botActive: true,
      botUsername: result.result?.username || null,
      chatConfigured: true,
      message: "Bot token geçerli ve Telegram botu aktif. Chat ID'ye mesaj gönderme yetkisi ayrıca test edilmelidir."
    });
  } catch (e) {
    return res.status(502).json({
      ok: false, configured: true, botActive: false,
      message: `Telegram bağlantı testi başarısız: ${e.message}`
    });
  }
});

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
  try { res.json(await createCouponByMode(String(req.query.date || ""), "prematch")); }
  catch (e) { res.status(502).json({ status: "ERROR", picks: [], error: "Maç önü kuponu oluşturulamadı.", detail: e.message }); }
});
app.get("/api/coupon/best", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || ""), "prematch")); }
  catch (e) { res.status(502).json({ status: "ERROR", picks: [], error: "Maç önü kuponu oluşturulamadı.", detail: e.message }); }
});
app.get("/api/coupon/surprise", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || ""), "surprise")); }
  catch (e) { res.status(502).json({ status: "ERROR", type: "surprise", picks: [], error: "10 maçlık sürpriz kupon oluşturulamadı.", detail: e.message }); }
});
app.get("/api/coupon/live-best", async (req, res) => {
  try { res.json(await createCouponByMode(String(req.query.date || new Date().toISOString().slice(0,10)), "live")); }
  catch (e) { res.status(502).json({ status: "ERROR", type: "live", picks: [], error: "Canlı tek tercih oluşturulamadı.", detail: e.message }); }
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
