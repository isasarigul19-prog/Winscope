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
    homeId: Number(match.teams?.home?.id ?? match.homeId) || null,
    awayId: Number(match.teams?.away?.id ?? match.awayId) || null,
    homeScore: match.goals?.home ?? 0, awayScore: match.goals?.away ?? 0,
    htHomeScore: match.score?.halftime?.home ?? null, htAwayScore: match.score?.halftime?.away ?? null,
    fixtureDate: match.fixture?.date || match.kickoff_utc || null
  };
}

function parseStatNumber(value) {
  if (value == null) return null;
  const n = Number(String(value).replace('%','').replace(',','.').trim());
  return Number.isFinite(n) ? n : null;
}

function collectLiveStats(statsPayload) {
  const teams = statsPayload?.response || [];
  const normalized = teams.map(team => {
    const stats = {};
    for (const item of (team.statistics || [])) {
      const key = String(item.type || '').toLowerCase();
      stats[key] = parseStatNumber(item.value);
    }
    return { name: team.team?.name || '', stats };
  });
  const sum = (pattern) => normalized.reduce((total, team) => {
    const item = Object.entries(team.stats).find(([key]) => pattern.test(key));
    return total + (item && item[1] != null ? item[1] : 0);
  }, 0);
  const home = normalized[0]?.stats || {};
  const away = normalized[1]?.stats || {};
  const shotsOnTarget = sum(/shots on goal|shots on target/);
  const totalShots = sum(/^total shots$/);
  const dangerousAttacks = sum(/dangerous attacks/);
  const corners = sum(/corner kicks|corners/);
  const useful = [shotsOnTarget, totalShots, dangerousAttacks, corners].some(v => v > 0);
  return { teams: normalized, shotsOnTarget, totalShots, dangerousAttacks, corners, useful,
    homeShotsOnTarget: Object.entries(home).find(([k]) => /shots on goal|shots on target/.test(k))?.[1] ?? 0,
    awayShotsOnTarget: Object.entries(away).find(([k]) => /shots on goal|shots on target/.test(k))?.[1] ?? 0 };
}

function computeAnalysis(match, oddsRow = null, statsPayload = null) {
  const minute = Number(match.minute || 0);
  const home = Number(match.homeScore || 0), away = Number(match.awayScore || 0);
  const total = home + away;
  const live = match.status === "LIVE";
  const finished = match.status === "FT";
  const stats = collectLiveStats(statsPayload);
  let ht = "Tahmin: oran/veri doğrulaması gerekli";
  let ft = "Tahmin: oran/veri doğrulaması gerekli";
  let mainPick = "UZAK DUR", alternative = "UZAK DUR";
  let reason = "Tahmin üretmek için doğrulanabilir oran ve gerekli veriler bulunamadı.";

  if (finished) {
    ht = `${match.htHomeScore ?? "?"}-${match.htAwayScore ?? "?"} (gerçek)`;
    ft = `${home}-${away} (gerçek)`;
    reason = "Maç tamamlandı; skor tahmini yerine gerçekleşen skor gösteriliyor.";
  } else if (live) {
    if (minute >= 45 && match.htHomeScore != null && match.htAwayScore != null) {
      ht = `${match.htHomeScore}-${match.htAwayScore} (gerçek İY skoru)`;
    } else if (minute < 45) {
      ht = "Tahmin: canlı oran/istatistik yeterli değil";
    } else {
      ht = "İlk yarı tamamlandı; gerçek İY skoru API'de yok";
    }

    ft = "Tahmin: canlı oran/istatistik yeterli değil";
    const odds = oddsForFixture(oddsRow || {});
    const hasLiveOdds = odds.length > 0;
    if (!hasLiveOdds || !stats.useful) {
      reason = !hasLiveOdds
        ? "Canlı oran bulunamadı; tercih üretilmedi."
        : "Yeterli canlı istatistik bulunamadı; tercih üretilmedi.";
    } else {
      const pressure = stats.shotsOnTarget >= 3 || stats.totalShots >= 8 ||
        (stats.dangerousAttacks >= 20 && stats.corners >= 3);
      const htPressure = liveStats.shotsOnTarget >= 2 || liveStats.totalShots >= 6;
      let eligible = [];
      if (minute < 33 && total === 0 && htPressure) {
        eligible = odds.filter(x => x.market === "İY 0.5 ÜST" && x.odd >= 1.25 && x.odd <= 1.85);
      } else if (minute >= 33 && minute < 70 && total <= 1 && pressure) {
        eligible = odds.filter(x => x.market === "MS 1.5 ÜST" && x.odd >= 1.20 && x.odd <= 1.85);
      } else if (minute >= 45 && minute < 75 && total === 0 && pressure) {
        eligible = odds.filter(x => x.market === "MS 0.5 ÜST" && x.odd >= 1.15 && x.odd <= 1.75);
      }
      eligible.sort((a,b) => a.odd - b.odd);
      if (eligible.length) {
        mainPick = eligible[0].market;
        alternative = "UZAK DUR";
        reason = `Canlı oran ve istatistik eşleşti. Şut isabeti: ${stats.shotsOnTarget}, toplam şut: ${stats.totalShots}, korner: ${stats.corners}.`;
        ft = "Skor tahmini üretilmedi; mevcut veriler kesin skor belirlemeye yetmez.";
      } else {
        reason = "Canlı oran, dakika, skor ve istatistikler birlikte değerlendirildi; güvenilir eşleşme bulunamadı.";
      }
    }
  } else {
    const odds = oddsForFixture(oddsRow || {});
    const eligible = rankSingleMatchChoices(odds, "prematch");
    if (eligible.length) {
      mainPick = eligible[0].market;
      alternative = eligible[1]?.market || "UZAK DUR";
      reason = "Maç önü oranı bulundu. Skor tahmini için yeterli doğrulanmış veri olmadığı için skor uydurulmadı.";
    }
  }
  return { halfTimeScore: ht, fullTimeScore: ft, mainPick, alternative,
    surprise: "Veri desteklemediği için sürpriz skor üretilmedi", reason };
}

function oddsForFixture(oddsRow) {
  const candidates = [];
  const rules = [
    { names: ["Goals Over/Under", "Match Goals Over/Under", "Over/Under"], values: ["Over 1.5", "1.5"], market: "MS 1.5 ÜST", rank: 1 },
    { names: ["Goals Over/Under", "Match Goals Over/Under", "Over/Under"], values: ["Over 2.5", "2.5"], market: "MS 2.5 ÜST", rank: 2 },
    { names: ["Both Teams Score", "Both Teams to Score", "Both Teams Scored"], values: ["Yes"], market: "KG VAR", rank: 3 },
    { names: ["First Half Goals Over/Under", "1st Half Goals Over/Under", "Half Time Over/Under", "1st Half Over/Under"], values: ["Over 0.5"], market: "İY 0.5 ÜST", rank: 4 },
    { names: ["First Half Goals Over/Under", "1st Half Goals Over/Under", "Half Time Over/Under", "1st Half Over/Under"], values: ["Over 1.5"], market: "İY 1.5 ÜST", rank: 5 },
    { names: ["Home Team Goals", "Team Goals", "Home Goals Over/Under"], values: ["Over 1.5"], market: "EV 1.5 ÜST", rank: 6 },
    { names: ["Away Team Goals", "Team Goals", "Away Goals Over/Under"], values: ["Over 1.5"], market: "DEP 1.5 ÜST", rank: 7 },
    { names: ["Goals Over/Under", "Match Goals Over/Under", "Over/Under"], values: ["Over 0.5", "0.5"], market: "MS 0.5 ÜST", rank: 8 }
  ];
  for (const bookmaker of (oddsRow?.bookmakers || [])) {
    for (const bet of (bookmaker.bets || [])) {
      const betName = String(bet.name || "").toLowerCase();
      for (const rule of rules) {
        if (!rule.names.some(n => betName.includes(n.toLowerCase()))) continue;
        const isHalfMarket = /first half|1st half|half time|half-time|1st half goals/.test(betName);
        if (rule.market.startsWith("İY ") && !isHalfMarket) continue;
        if (rule.market.startsWith("MS ") && isHalfMarket) continue;
        if (rule.market === "EV 1.5 ÜST" && !/home/.test(betName)) continue;
        if (rule.market === "DEP 1.5 ÜST" && !/away/.test(betName)) continue;
        for (const value of (bet.values || [])) {
          const label = String(value.value || "").trim().toLowerCase();
          if (!rule.values.some(v => label === v.toLowerCase())) continue;
          const odd = Number(value.odd);
          if (Number.isFinite(odd) && odd > 1.01) {
            candidates.push({ market: rule.market, odd, rank: rule.rank, bookmaker: bookmaker.name || "Kaynak belirtilmedi" });
          }
        }
      }
    }
  }
  // Remove duplicates from broad market-name matches; retain the best available bookmaker price.
  const best = new Map();
  for (const c of candidates) {
    const prev = best.get(c.market);
    if (!prev || c.odd < prev.odd) best.set(c.market, c);
  }
  return [...best.values()];
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
  const ranges = {
    "MS 1.5 ÜST": [1.20, 1.72, 1],
    "MS 2.5 ÜST": [1.50, 2.05, 2],
    "KG VAR": [1.50, 2.05, 3],
    "İY 0.5 ÜST": [1.20, 1.72, 4],
    "İY 1.5 ÜST": [1.55, 2.10, 5],
    "EV 1.5 ÜST": [1.35, 2.05, 6],
    "DEP 1.5 ÜST": [1.35, 2.05, 7],
    "MS 0.5 ÜST": [1.15, 1.70, 8]
  };
  return choices.filter(x => {
    const r = ranges[x.market];
    if (!r) return false;
    if (mode !== "live" && x.market === "MS 0.5 ÜST") return false;
    return x.odd >= r[0] && x.odd <= r[1];
  }).sort((a, b) => {
    const ra = ranges[a.market], rb = ranges[b.market];
    // Score each market against its own target odds band; don't automatically favor the shortest line.
    const targetA = (ra[0] + ra[1]) / 2;
    const targetB = (rb[0] + rb[1]) / 2;
    const scoreA = Math.abs(a.odd - targetA) + ra[2] * 0.015;
    const scoreB = Math.abs(b.odd - targetB) + rb[2] * 0.015;
    return scoreA - scoreB;
  });
}


async function getRecentTeamForm(teamId) {
  if (!teamId) return [];
  const payload = await cachedProviderRequest(
    `team-last5:${teamId}`,
    `/fixtures?team=${encodeURIComponent(teamId)}&last=5&status=FT`,
    10 * 60 * 1000
  );
  return (payload.response || []).filter(row =>
    row.fixture?.status?.short === "FT" ||
    ["FT", "AET", "PEN"].includes(String(row.fixture?.status?.short || "").toUpperCase())
  ).slice(0, 5);
}

function recentFormSupport(market, homeRows, awayRows, homeTeamId, awayTeamId) {
  const all = [...homeRows, ...awayRows];
  if (!all.length) return null;
  const values = [];
  const totalGoals = row => Number(row.goals?.home ?? 0) + Number(row.goals?.away ?? 0);
  const btts = row => Number(row.goals?.home ?? 0) > 0 && Number(row.goals?.away ?? 0) > 0;
  const halfGoals = row => {
    const h = row.score?.halftime?.home;
    const a = row.score?.halftime?.away;
    if (h == null || a == null) return null;
    return Number(h) + Number(a);
  };

  if (market === "MS 1.5 ÜST") {
    for (const r of all) values.push(totalGoals(r) >= 2);
  } else if (market === "MS 2.5 ÜST") {
    for (const r of all) values.push(totalGoals(r) >= 3);
  } else if (market === "KG VAR") {
    for (const r of all) values.push(btts(r));
  } else if (market === "İY 0.5 ÜST" || market === "İY 1.5 ÜST") {
    for (const r of all) {
      const g = halfGoals(r);
      if (g != null) values.push(market === "İY 0.5 ÜST" ? g >= 1 : g >= 2);
    }
  } else if (market === "EV 1.5 ÜST") {
    for (const r of homeRows) {
      const teamWasHome = Number(r.teams?.home?.id) === Number(homeTeamId);
      const scored = teamWasHome ? r.goals?.home : r.goals?.away;
      values.push(Number(scored ?? 0) >= 2);
    }
  } else if (market === "DEP 1.5 ÜST") {
    for (const r of awayRows) {
      const teamWasHome = Number(r.teams?.home?.id) === Number(awayTeamId);
      const scored = teamWasHome ? r.goals?.home : r.goals?.away;
      values.push(Number(scored ?? 0) >= 2);
    }
  } else {
    return null;
  }
  if (!values.length) return null;
  return { percent: Math.round(values.filter(Boolean).length / values.length * 100), sampleSize: values.length };
}

function minimumSupportForMarket(market) {
  return ({
    "MS 1.5 ÜST": 70,
    "MS 2.5 ÜST": 50,
    "KG VAR": 50,
    "İY 0.5 ÜST": 60,
    "İY 1.5 ÜST": 40,
    "EV 1.5 ÜST": 40,
    "DEP 1.5 ÜST": 40
  })[market] ?? 101;
}

function scorePrematchChoice(choice, support) {
  // Form support is primary; odds are a secondary consistency check, not the sole selector.
  const impliedProbability = 100 / choice.odd;
  return support.percent * 0.72 + impliedProbability * 0.28;
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
      let liveStats = null;
      if (isLiveMode) {
        const statsPayload = await cachedProviderRequest(`stats:${fixture.id}`, `/fixtures/statistics?fixture=${fixture.id}`, 15000);
        const rawStats = statsPayload.response || [];
        const values = rawStats.flatMap(team => (team.statistics || []).map(st => ({
          type: String(st.type || "").toLowerCase(), value: st.value
        })));
        const hasUsefulStats = values.some(v => /shots on goal|total shots|dangerous attacks|shots off goal|corner kicks|ball possession/.test(v.type) && v.value != null);
        if (!hasUsefulStats) continue;
        const liveStatObject = collectLiveStats(statsPayload);
        statsSummary = values.filter(v => /shots on goal|total shots|dangerous attacks|corner kicks/.test(v.type) && v.value != null)
          .slice(0, 8).map(v => `${v.type}: ${v.value}`);
        // Store normalized numeric stats for the live signal checks below.
        liveStats = liveStatObject;
      }

      let choices = rankSingleMatchChoices(oddsForFixture(oddsRow), mode);
      if (isLiveMode) {
        const minute = Number(fixture.minute || 0);
        const goals = Number(fixture.homeScore || 0) + Number(fixture.awayScore || 0);
        const pressure = statsSummary && statsSummary.length > 0;
        if (minute >= 45 || fixture.status === "HT") {
          choices = choices.filter(c => !c.market.startsWith("İY "));
        }
        if (minute < 33) {
          const hasEarlyPressure = Boolean(liveStats) && (liveStats.shotsOnTarget >= 2 || liveStats.totalShots >= 6);
          choices = choices.filter(c => c.market === "İY 0.5 ÜST" && goals === 0 && hasEarlyPressure);
        } else if (minute < 70) {
          const hasPressure = Boolean(liveStats) && (liveStats.shotsOnTarget >= 3 || liveStats.totalShots >= 8 ||
            (liveStats.dangerousAttacks >= 20 && liveStats.corners >= 3));
          choices = choices.filter(c => c.market === "MS 1.5 ÜST" && goals <= 1 && hasPressure);
        } else {
          choices = [];
        }
        if (!pressure) choices = [];
      } else {
        // Do not select a market from odds alone. Require last-five team-form data for both teams.
        if (!fixture.homeId || !fixture.awayId) continue;
        let homeRows = [], awayRows = [];
        try {
          [homeRows, awayRows] = await Promise.all([
            getRecentTeamForm(fixture.homeId),
            getRecentTeamForm(fixture.awayId)
          ]);
        } catch (formError) {
          errors.push(`${fixture.home} - ${fixture.away}: son 5 maç verisi alınamadı`);
          continue;
        }
        if (homeRows.length < 3 || awayRows.length < 3) continue;

        choices = choices.map(c => {
          const support = recentFormSupport(c.market, homeRows, awayRows, fixture.homeId, fixture.awayId);
          const minimumSample = ["EV 1.5 ÜST", "DEP 1.5 ÜST"].includes(c.market) ? 3 : 6;
          return support && support.sampleSize >= minimumSample
            ? { ...c, supportPercent: support.percent, supportSample: support.sampleSize,
                modelScore: scorePrematchChoice(c, support) }
            : null;
        }).filter(c => c && c.supportPercent >= minimumSupportForMarket(c.market));
        choices.sort((a, b) => b.modelScore - a.modelScore);
      }
      if (!choices.length) continue;

      const chosen = choices[0];
      candidates.push({
        fixtureId: fixture.id, league: fixture.league, country: fixture.country,
        home: fixture.home, away: fixture.away, fixtureDate: fixture.fixtureDate,
        market: chosen.market, source: chosen.bookmaker, internalOdd: chosen.odd,
        supportPercent: chosen.supportPercent ?? null,
        supportSample: chosen.supportSample ?? null,
        modelScore: chosen.modelScore ?? null,
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
    if (!isLiveMode) {
      return (b.modelScore ?? -1) - (a.modelScore ?? -1) ||
        (b.supportPercent ?? -1) - (a.supportPercent ?? -1) ||
        a.internalOdd - b.internalOdd;
    }
    // Live choices remain based on live odds plus live-stat eligibility.
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

  const publicPicks = chosen.map(({ internalOdd, rank, scoreTotal, modelScore, supportPercent, supportSample, ...p }) => p);
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
    let oddsRow = null, statsPayload = null;
    try {
      const oddsPath = match.status === "LIVE"
        ? `/odds/live?fixture=${match.id}`
        : `/odds?fixture=${match.id}`;
      const oddsPayload = await cachedProviderRequest(`analysis-odds:${match.id}:${match.status}`, oddsPath, 15000);
      oddsRow = oddsPayload.response?.find(x => Number(x.fixture?.id) === match.id) || oddsPayload.response?.[0] || null;
    } catch (e) { console.warn("Analysis odds unavailable:", e.message); }
    if (match.status === "LIVE") {
      try {
        statsPayload = await cachedProviderRequest(`stats:${match.id}`, `/fixtures/statistics?fixture=${match.id}`, 15000);
      } catch (e) { console.warn("Analysis stats unavailable:", e.message); }
    }
    const a = computeAnalysis(match, oddsRow, statsPayload);
    res.json({
      fixtureId: match.id, matchStatus: match.status, ...a,
      marketPercentages: {
        ht05: { percent: null, sampleSize: 0 }, ht15: { percent: null, sampleSize: 0 },
        ms05: { percent: null, sampleSize: 0 }, ms15: { percent: null, sampleSize: 0 },
        ms25: { percent: null, sampleSize: 0 }, btts: { percent: null, sampleSize: 0 }
      },
      note: a.reason || "Yüzde verisi yalnızca doğrulanmış örneklemle gösterilir."
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
