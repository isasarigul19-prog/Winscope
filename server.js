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
// Aynı kuponun art arda tıklama/yenilemelerde tekrar Telegram'a gitmesini önler.
const telegramDeliveryCache = new Map();

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
    id: idNum, homeId: Number(match.teams?.home?.id) || null, awayId: Number(match.teams?.away?.id) || null,
    league: String(leagueName), country: String(countryName),
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

function bookmakerRows(oddsRow) {
  if (!oddsRow) return [];
  if (Array.isArray(oddsRow.bookmakers) && oddsRow.bookmakers.length) return oddsRow.bookmakers;
  if (Array.isArray(oddsRow.odds) && oddsRow.odds.length) {
    return [{
      name: oddsRow.bookmaker?.name || oddsRow.bookmaker || oddsRow.source || "API-Football",
      bets: oddsRow.odds.map(item => ({ name: item.name || item.bet || "", values: item.values || [] }))
    }];
  }
  return [];
}

function oddsForFixture(oddsRow) {
  const markets = new Map();
  const add = (book, key, side, odd) => {
    if (!Number.isFinite(odd) || odd <= 1.01) return;
    const mapKey = `${book}|${key}`;
    if (!markets.has(mapKey)) markets.set(mapKey, { market: key, bookmaker: book, over: null, under: null, yes: null, no: null, home: null, draw: null, away: null });
    const item = markets.get(mapKey);
    item[side] = odd;
  };
  for (const bookmaker of bookmakerRows(oddsRow)) {
    const book = String(bookmaker.name || "Kaynak belirtilmedi");
    for (const bet of (bookmaker.bets || [])) {
      const name = String(bet.name || "").toLowerCase().replace(/[–—]/g, "-");
      const isHalf = /first half|1st half|half.?time|1st period|first period/.test(name);
      const isHomeTeam = /home team|home goals|team 1 total|team 1 goals|team total - home/.test(name);
      const isAwayTeam = /away team|away goals|team 2 total|team 2 goals|team total - away/.test(name);
      const isBtts = /both teams to score|both teams score|btts/.test(name);
      const isTotal = /over.?under|total goals|match goals|goal line|goals total|total/.test(name) && !isHomeTeam && !isAwayTeam;
      const isWinner = /match winner|1x2|full.?time result|match result|regular time result|winner/.test(name);
      for (const value of (bet.values || [])) {
        const label = String(value.value ?? value.name ?? "").toLowerCase().trim();
        const odd = Number(value.odd);
        if (!Number.isFinite(odd) || odd <= 1.01) continue;
        if (isWinner) {
          if (/^(home|1|team 1|1 \(home\))$/.test(label)) add(book, "MS 1", "home", odd);
          else if (/^(draw|x|tie)$/.test(label)) add(book, "MS 1", "draw", odd);
          else if (/^(away|2|team 2|2 \(away\))$/.test(label)) add(book, "MS 1", "away", odd);
          continue;
        }
        if (isBtts) {
          if (/^(yes|y|both teams to score - yes)$/.test(label)) add(book, "KG VAR", "yes", odd);
          else if (/^(no|n|both teams to score - no)$/.test(label)) add(book, "KG VAR", "no", odd);
          continue;
        }
        const overMatch = label.match(/over\s*([0-9]+[.,][0-9]+)/);
        const underMatch = label.match(/under\s*([0-9]+[.,][0-9]+)/);
        const lineMatch = label.match(/([0-9]+[.,][0-9]+)/);
        const line = (overMatch || underMatch || lineMatch)?.[1]?.replace(',', '.');
        if (!line) continue;
        const side = overMatch ? "over" : underMatch ? "under" : null;
        if (!side) continue;
        let key = null;
        if (isHomeTeam && Number(line) === 1.5) key = "EV 1.5 ÜST";
        else if (isAwayTeam && Number(line) === 1.5) key = "DEP 1.5 ÜST";
        else if (isHalf && [0.5, 1.5, 2.5].includes(Number(line))) key = `İY ${line} ÜST`;
        else if (isTotal && [0.5, 1.5, 2.5, 3.5].includes(Number(line))) key = `MS ${line} ÜST`;
        if (key) add(book, key, side, odd);
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
      pct = 100 * inv[0] / sum;
    }
    const odd = item.over || item.yes || item.home;
    if (pct == null || !Number.isFinite(pct)) continue;
    const ranks = { "EV 1.5 ÜST": 1, "DEP 1.5 ÜST": 1, "İY 0.5 ÜST": 2, "MS 0.5 ÜST": 2, "İY 1.5 ÜST": 3, "MS 1.5 ÜST": 3, "MS 2.5 ÜST": 4, "KG VAR": 5, "MS 3.5 ÜST": 6 };
    candidates.push({ market: item.market, odd, probability: pct, rank: ranks[item.market] ?? 9, bookmaker: item.bookmaker,
      homeOdd: item.market === "MS 1" ? item.home : null, drawOdd: item.market === "MS 1" ? item.draw : null,
      awayOdd: item.market === "MS 1" ? item.away : null });
  }
  // If API-Football has multiple bookmakers, keep each book's pair intact and prefer Bet365 only as a tie-break.
  return candidates.sort((a,b) => b.probability-a.probability || (/bet365/i.test(b.bookmaker)-/bet365/i.test(a.bookmaker)) || a.rank-b.rank);
}

function marketSupport(market, homeForm, awayForm) {
  if (!homeForm?.available || !awayForm?.available) return null;
  const avg = (a,b) => a == null || b == null ? null : (Number(a)+Number(b))/2;
  if (market === "EV 1.5 ÜST") return 0.65*Number(homeForm.teamGoalsOver15Pct ?? 0) + 0.35*Number(awayForm.goalsConcededPct ?? 0);
  if (market === "DEP 1.5 ÜST") return 0.65*Number(awayForm.teamGoalsOver15Pct ?? 0) + 0.35*Number(homeForm.goalsConcededPct ?? 0);
  if (market === "MS 2.5 ÜST") return avg(homeForm.over25Pct, awayForm.over25Pct);
  if (market === "MS 3.5 ÜST") return avg(homeForm.over35Pct, awayForm.over35Pct);
  if (market === "MS 1.5 ÜST") return avg(homeForm.over15Pct, awayForm.over15Pct);
  if (market === "MS 0.5 ÜST") return avg(homeForm.over05Pct, awayForm.over05Pct);
  if (market === "KG VAR") return avg(homeForm.bttsPct, awayForm.bttsPct);
  if (market === "İY 0.5 ÜST") return avg(homeForm.htOver05Pct, awayForm.htOver05Pct);
  if (market === "İY 1.5 ÜST") return avg(homeForm.htOver15Pct, awayForm.htOver15Pct);
  return null;
}

async function fetchTeamRecentForm(teamId, fixtureId) {
  if (!teamId) return { available: false, sampleSize: 0 };
  try {
    const payload = await cachedProviderRequest(`form:${teamId}`, `/fixtures?team=${teamId}&last=10`, 6 * 60 * 60 * 1000);
    const rows = (payload.response || []).filter(row => Number(row.fixture?.id) !== Number(fixtureId) &&
      ["FT", "AET", "PEN"].includes(String(row.fixture?.status?.short || "").toUpperCase()) &&
      row.goals?.home != null && row.goals?.away != null)
      .sort((a,b) => new Date(b.fixture?.date || 0) - new Date(a.fixture?.date || 0)).slice(0,5);
    if (rows.length < 5) return { available: false, sampleSize: rows.length };
    const pct = fn => Math.round(100*rows.filter(fn).length/rows.length);
    const vals = rows.map(r => {
      const isHome = Number(r.teams?.home?.id) === Number(teamId);
      const gf = Number(isHome ? r.goals.home : r.goals.away);
      const ga = Number(isHome ? r.goals.away : r.goals.home);
      const total = Number(r.goals.home) + Number(r.goals.away);
      const hth = r.score?.halftime?.home, hta = r.score?.halftime?.away;
      return { gf, ga, total, btts: Number(r.goals.home)>0 && Number(r.goals.away)>0,
        htTotal: hth == null || hta == null ? null : Number(hth)+Number(hta) };
    });
    return {
      available: true, sampleSize: rows.length,
      teamGoalsOver15Pct: pct(x => { const r=vals[rows.indexOf(x)]; return r.gf>=2; }),
      goalsConcededPct: pct(x => { const r=vals[rows.indexOf(x)]; return r.ga>0; }),
      over05Pct: pct(x => { const r=vals[rows.indexOf(x)]; return r.total>=1; }),
      over15Pct: pct(x => { const r=vals[rows.indexOf(x)]; return r.total>=2; }),
      over25Pct: pct(x => { const r=vals[rows.indexOf(x)]; return r.total>=3; }),
      over35Pct: pct(x => { const r=vals[rows.indexOf(x)]; return r.total>=4; }),
      bttsPct: pct(x => vals[rows.indexOf(x)].btts),
      htOver05Pct: vals.some(x=>x.htTotal!=null) ? Math.round(100*vals.filter(x=>x.htTotal!=null&&x.htTotal>=1).length/vals.filter(x=>x.htTotal!=null).length) : null,
      htOver15Pct: vals.some(x=>x.htTotal!=null) ? Math.round(100*vals.filter(x=>x.htTotal!=null&&x.htTotal>=2).length/vals.filter(x=>x.htTotal!=null).length) : null,
      matches: rows.map((r,i)=>({score:`${r.goals.home}-${r.goals.away}`, halftimeScore:r.score?.halftime?.home==null?null:`${r.score.halftime.home}-${r.score.halftime.away}`}))
    };
  } catch (e) {
    console.warn(`[Team form] team=${teamId}: ${e.message}`);
    return { available: false, sampleSize: 0 };
  }
}

function liveStatsMetrics(stats, fixture) {
  const out = { available: Array.isArray(stats) && stats.length >= 2, shotsOnTarget: 0, totalShots: 0, corners: 0,
    home: { shotsOnTarget: 0, totalShots: 0, corners: 0 }, away: { shotsOnTarget: 0, totalShots: 0, corners: 0 } };
  for (const team of (stats || [])) {
    const side = Number(team.team?.id) === Number(fixture.homeId) ? "home" : "away";
    for (const st of (team.statistics || [])) {
      const type = String(st.type || "").toLowerCase();
      const value = Number(String(st.value ?? "0").replace('%','')) || 0;
      if (/shots on goal|shots on target/.test(type)) { out.shotsOnTarget += value; out[side].shotsOnTarget += value; }
      if (/total shots|goal attempts/.test(type)) { out.totalShots += value; out[side].totalShots += value; }
      if (/corner kicks|corners/.test(type)) { out.corners += value; out[side].corners += value; }
    }
  }
  out.pressure = out.shotsOnTarget*2.5 + out.totalShots*0.45 + out.corners*0.8;
  return out;
}

function chooseSupportedMarket(oddsRow, mode, fixture, forms, stats, prematchOddsRow) {
  const live = mode === "live";
  const total = Number(fixture.homeScore || 0) + Number(fixture.awayScore || 0);
  const minute = Number(fixture.minute || 0);
  let allowed;
  if (!live) allowed = ["EV 1.5 ÜST", "DEP 1.5 ÜST", "MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR"];
  else if (minute >= 20 && minute <= 30 && total === 0) allowed = ["İY 0.5 ÜST"];
  else if (minute >= 18 && minute <= 30 && total === 1) allowed = ["İY 1.5 ÜST"];
  else if (minute >= 55 && minute <= 65 && total === 0) allowed = ["MS 0.5 ÜST"];
  else if (minute >= 55 && minute <= 65 && total === 1) allowed = ["MS 1.5 ÜST", "KG VAR"];
  else if (minute >= 66 && total === 0) allowed = ["MS 2.5 ÜST", "MS 3.5 ÜST"];
  else if (minute >= 66 && total >= 1) allowed = ["MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR"];
  else allowed = ["İY 0.5 ÜST", "İY 1.5 ÜST", "MS 0.5 ÜST", "MS 1.5 ÜST", "MS 2.5 ÜST", "MS 3.5 ÜST", "KG VAR"];

  const choices = oddsForFixture(oddsRow).filter(x => allowed.includes(x.market));
  const h = forms.home, a = forms.away;
  const statsM = stats || { available: false, pressure: 0, home: {}, away: {} };
  const preMarkets = oddsForFixture(prematchOddsRow || null);
  const favorite = (() => {
    const winners = preMarkets.filter(x=>x.market==="MS 1");
    const home = winners.find(x=>x.bookmaker && x.market==="MS 1" && x.homeOdd)?.homeOdd;
    const away = winners.find(x=>x.bookmaker && x.market==="MS 1" && x.awayOdd)?.awayOdd;
    return home && away ? (home < away ? "home" : "away") : null;
  })();
  const leader = Number(fixture.homeScore||0) > Number(fixture.awayScore||0) ? "home" : Number(fixture.awayScore||0) > Number(fixture.homeScore||0) ? "away" : null;

  const minMarketPct = { "EV 1.5 ÜST": 48, "DEP 1.5 ÜST": 48, "MS 2.5 ÜST": 49, "MS 3.5 ÜST": 28,
    "KG VAR": 48, "İY 0.5 ÜST": 52, "İY 1.5 ÜST": 32, "MS 0.5 ÜST": 58, "MS 1.5 ÜST": 52 };
  const minFormPct = { "EV 1.5 ÜST": 45, "DEP 1.5 ÜST": 45, "MS 2.5 ÜST": 48, "MS 3.5 ÜST": 32,
    "KG VAR": 48, "İY 0.5 ÜST": 52, "İY 1.5 ÜST": 32, "MS 0.5 ÜST": 52, "MS 1.5 ÜST": 48 };
  return choices.map(choice => {
    const formPct = marketSupport(choice.market, h, a);
    let liveBonus = 0;
    if (live) {
      if (!statsM.available) return null;
      if (choice.market.startsWith("İY ") && minute >= 45) return null;
      if (choice.market.startsWith("İY ")) {
        const currentHalfGoals = Number(fixture.htHomeScore ?? fixture.homeScore ?? 0) + Number(fixture.htAwayScore ?? fixture.awayScore ?? 0);
        const line = Number(choice.market.match(/(\d)[.,](\d)/)?.[1] || 0) + 0.5;
        if (currentHalfGoals >= Math.ceil(line)) return null;
      }
      if (choice.market === "MS 0.5 ÜST" && total >= 1) return null;
      if (choice.market === "MS 1.5 ÜST" && total >= 2) return null;
      if (choice.market === "MS 2.5 ÜST" && total >= 3) return null;
      if (choice.market === "MS 3.5 ÜST" && total >= 4) return null;
      const needed = choice.market.startsWith("MS ") ? Math.max(0, Number(choice.market.match(/(\d)[.,](\d)/)?.[1] || 0) + 1 - total) : 1;
      if (minute >= 66 && /MS [23][.,][05] ÜST/.test(choice.market) && needed > 1 && statsM.pressure < 18) return null;
      if (minute >= 75 && choice.market === "MS 3.5 ÜST" && (needed > 1 || statsM.pressure < 27)) return null;
      if (choice.market === "KG VAR" && leader && favorite && leader !== favorite) {
        const trailing = leader === "home" ? "away" : "home";
        const p = statsM[trailing] || {};
        const trailingPressure = Number(p.shotsOnTarget||0)*2.5 + Number(p.totalShots||0)*0.45 + Number(p.corners||0)*0.8;
        if (trailingPressure < 6 || Number(formPct||0) < 52) return null;
        liveBonus += Math.min(12, trailingPressure*0.5);
      }
      if (minute <= 30 && total === 0 && choice.market === "İY 0.5 ÜST" && statsM.pressure < 3.5) return null;
      if (minute >= 55 && minute <= 65 && total === 0 && choice.market === "MS 0.5 ÜST" && statsM.pressure < 6) return null;
      liveBonus += Math.min(14, statsM.pressure*0.25);
    }
    if (formPct == null || choice.probability < minMarketPct[choice.market] || formPct < minFormPct[choice.market]) return null;
    const score = choice.probability*0.55 + formPct*0.45 + liveBonus - (live && choice.market === "MS 3.5 ÜST" ? Math.max(0,minute-65)*0.35 : 0);
    return { ...choice, formPct, score, statsSummary: live ? statsM : null };
  }).filter(Boolean).sort((a,b)=>b.score-a.score)[0] || null;
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


async function sendCouponAutomatically(coupon, chosen) {
  const signature = `${coupon.date}|${coupon.type}|${chosen.map(p => `${p.fixtureId}:${p.market}`).sort().join(",")}`;
  const now = Date.now();
  for (const [key, at] of telegramDeliveryCache) if (now - at > 24 * 60 * 60 * 1000) telegramDeliveryCache.delete(key);
  if (telegramDeliveryCache.has(signature)) {
    return { sent: true, duplicateSuppressed: true, message: "Bu kupon daha önce Telegram'a gönderildi; tekrar gönderilmedi." };
  }
  try {
    const result = await sendTelegram(couponMessage(coupon));
    if (result.sent) {
      telegramDeliveryCache.set(signature, now);
      if (telegramDeliveryCache.size > 500) telegramDeliveryCache.delete(telegramDeliveryCache.keys().next().value);
    }
    return result;
  } catch (error) {
    console.error(`[Telegram] Otomatik kupon gönderimi başarısız (${coupon.type}):`, error.message);
    return { sent: false, error: error.message };
  }
}

async function createCouponByMode(date, mode = "prematch") {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Geçerli bir maç tarihi seç.");
  const isLiveMode = mode === "live";
  const fixturePath = isLiveMode ? "/fixtures?live=all" : `/fixtures?date=${encodeURIComponent(date)}&timezone=Europe/Istanbul`;
  const fixtureKey = isLiveMode ? "liveListForCoupon" : `fixtures:${date}`;
  const fixturePayload = await cachedProviderRequest(fixtureKey, fixturePath, isLiveMode ? 15000 : 60000);
  const fixtures = (fixturePayload.response || []).map(normalizeProviderMatch)
    .filter(m => m.id && (isLiveMode ? m.status === "LIVE" && Number(m.minute || 0) >= 18 && Number(m.minute || 0) <= 80 : m.status === "NS"));
  if (!fixtures.length) return { draftId:`coupon-${Date.now()}`, date, type:mode, status:"NO_MATCHES", picks:[], message:isLiveMode ? "Şu anda uygun dakika aralığında canlı maç bulunamadı." : "Seçilen tarihte başlamamış maç bulunamadı." };

  const dateOdds = new Map();
  if (!isLiveMode) {
    try {
      const payload = await cachedProviderRequest(`odds-date:${date}`, `/odds?date=${encodeURIComponent(date)}`, 90000);
      for (const row of (payload.response || [])) dateOdds.set(Number(row.fixture?.id), row);
    } catch (e) { console.warn(`[Coupon] date odds: ${e.message}`); }
  }
  const candidates = [], errors = [];
  for (const fixture of fixtures) {
    try {
      let marketOddsRow = null, prematchOddsRow = null, oddsBasis = "";
      if (isLiveMode) {
        const [livePayload, prePayload, statsPayload, homeForm, awayForm] = await Promise.all([
          cachedProviderRequest(`odds-live:${fixture.id}`, `/odds/live?fixture=${fixture.id}`, 15000),
          cachedProviderRequest(`odds-fixture:${fixture.id}`, `/odds?fixture=${fixture.id}`, 90000).catch(()=>({response:[]})),
          cachedProviderRequest(`stats:${fixture.id}`, `/fixtures/statistics?fixture=${fixture.id}`, 15000),
          fetchTeamRecentForm(fixture.homeId, fixture.id),
          fetchTeamRecentForm(fixture.awayId, fixture.id)
        ]);
        marketOddsRow = (livePayload.response || []).find(row=>Number(row.fixture?.id)===fixture.id) || null;
        const liveMarketStatus = marketOddsRow?.status || {};
        if (liveMarketStatus.blocked || liveMarketStatus.stopped || liveMarketStatus.finished) continue;
        prematchOddsRow = (prePayload.response || []).find(row=>Number(row.fixture?.id)===fixture.id) || prePayload.response?.[0] || null;
        const statsRows = statsPayload.response || [];
        const stats = liveStatsMetrics(statsRows, fixture);
        if (!marketOddsRow || !stats.available || !homeForm.available || !awayForm.available) continue;
        const chosen = chooseSupportedMarket(marketOddsRow, mode, fixture, {home:homeForm,away:awayForm}, stats, prematchOddsRow);
        if (!chosen) continue;
        oddsBasis = `Canlı oran: ${chosen.bookmaker}; maç önü referansı: ${prematchOddsRow ? "mevcut son kayıt" : "yok"}`;
        candidates.push({fixtureId:fixture.id,league:fixture.league,country:fixture.country,home:fixture.home,away:fixture.away,
          fixtureDate:fixture.fixtureDate,market:chosen.market,source:chosen.bookmaker,internalOdd:chosen.odd,marketProbability:chosen.probability,
          formSupport:chosen.formPct,score:chosen.score,minute:fixture.minute,currentScore:`${fixture.homeScore}-${fixture.awayScore}`,
          isLive:true,oddsBasis,statsSummary:[`İsabetli şut: ${stats.shotsOnTarget}`,`Toplam şut: ${stats.totalShots}`,`Korner: ${stats.corners}`]});
      } else {
        marketOddsRow = dateOdds.get(fixture.id) || null;
        if (!marketOddsRow) {
          const payload = await cachedProviderRequest(`odds-fixture:${fixture.id}`, `/odds?fixture=${fixture.id}`, 90000);
          marketOddsRow = (payload.response || []).find(row=>Number(row.fixture?.id)===fixture.id) || payload.response?.[0] || null;
        }
        if (!marketOddsRow || !fixture.homeId || !fixture.awayId) continue;
        const [homeForm, awayForm] = await Promise.all([fetchTeamRecentForm(fixture.homeId,fixture.id),fetchTeamRecentForm(fixture.awayId,fixture.id)]);
        if (!homeForm.available || !awayForm.available) continue;
        const chosen = chooseSupportedMarket(marketOddsRow, mode, fixture, {home:homeForm,away:awayForm}, null, marketOddsRow);
        if (!chosen) continue;
        oddsBasis = "API-Football maç önü son mevcut oran kaydı; resmî kapanış olduğu garanti edilemez";
        candidates.push({fixtureId:fixture.id,league:fixture.league,country:fixture.country,home:fixture.home,away:fixture.away,
          fixtureDate:fixture.fixtureDate,market:chosen.market,source:chosen.bookmaker,internalOdd:chosen.odd,marketProbability:chosen.probability,
          formSupport:chosen.formPct,score:chosen.score,minute:null,currentScore:"0-0",isLive:false,oddsBasis,statsSummary:null});
      }
    } catch(e) { errors.push(`${fixture.home} - ${fixture.away}: ${e.message}`); }
  }
  candidates.sort((a,b)=>b.score-a.score || b.formSupport-a.formSupport || a.internalOdd-b.internalOdd);
  const count = mode === "surprise" ? 10 : mode === "prematch" ? 2 : 1;
  const chosen = candidates.slice(0,count);
  if (!chosen.length || (mode === "prematch" && chosen.length < 2) || (mode === "surprise" && chosen.length < 10)) {
    const needed = mode === "surprise" ? 10 : mode === "prematch" ? 2 : 1;
    return {draftId:`coupon-${Date.now()}`,date,type:mode,status:"NO_MATCHES",picks:[],
      message:`Oran + son 5 maç formu${isLiveMode ? " + canlı oran + canlı istatistik" : ""} eşiklerini geçen yeterli maç yok (gereken: ${needed}). Kupon zorlanmadı.`,
      detail:errors.slice(0,3).join(" | ")};
  }
  const publicPicks = chosen.map(({internalOdd,marketProbability,formSupport,score,...p})=>p);
  const draftId = `coupon-${Date.now()}`;
  const coupon = {draftId,date,type:mode,isLive:isLiveMode,status:"READY",picks:publicPicks,
    message:mode==="live" ? "Tek canlı tercih: canlı oran, maç önü referansı, son 5 form ve canlı istatistik eşiklerini geçen maç." :
      mode==="surprise" ? "10 maçlık sürpriz kupon: her maç oran ve son 5 gerçek skor formu ile doğrulandı." :
      "Maç önü kuponu: en az iki maç, maç önü son mevcut oran ve son 5 gerçek skor formu birlikte değerlendirildi."};
  archives.coupons.unshift({date,type:mode,picks:publicPicks,createdAt:new Date().toISOString()});
  archives.coupons=archives.coupons.slice(0,50);
  // Onay butonu olmadan, kupon başarıyla üretildiğinde Telegram'a otomatik gönder.
  coupon.telegram = await sendCouponAutomatically(coupon, chosen);
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
    if (!row) return res.status(404).json({error:"Maç verisi bulunamadı."});
    const match = normalizeProviderMatch(row);
    const isLive = match.status === "LIVE";
    const [prematchOddsPayload, liveOddsPayload, statsPayload, homeForm, awayForm] = await Promise.all([
      cachedProviderRequest(`odds-fixture:${match.id}`, `/odds?fixture=${match.id}`, 90000).catch(()=>({response:[]})),
      isLive ? cachedProviderRequest(`odds-live:${match.id}`, `/odds/live?fixture=${match.id}`, 15000).catch(()=>({response:[]})) : Promise.resolve({response:[]}),
      isLive ? cachedProviderRequest(`stats:${match.id}`, `/fixtures/statistics?fixture=${match.id}`, 15000).catch(()=>({response:[]})) : Promise.resolve({response:[]}),
      fetchTeamRecentForm(match.homeId,match.id), fetchTeamRecentForm(match.awayId,match.id)
    ]);
    const prematchRow = (prematchOddsPayload.response||[]).find(x=>Number(x.fixture?.id)===match.id)||prematchOddsPayload.response?.[0]||null;
    const liveRow = (liveOddsPayload.response||[]).find(x=>Number(x.fixture?.id)===match.id)||null;
    const stats = liveStatsMetrics(statsPayload.response||[],match);
    const oddsRow = isLive ? liveRow : prematchRow;
    const chosen = oddsRow && homeForm.available && awayForm.available
      ? chooseSupportedMarket(oddsRow,isLive?"live":"prematch",match,{home:homeForm,away:awayForm},isLive?stats:null,prematchRow)
      : null;
    const total=Number(match.homeScore||0)+Number(match.awayScore||0);
    const htGoals = Number(match.htHomeScore||0)+Number(match.htAwayScore||0);
    const htMarketAlreadyHit = match.minute < 45 ? total >= 1 : htGoals >= 1;
    res.json({
      fixtureId:match.id,matchStatus:match.status,
      halfTimeScore:match.status==="FT"?`${match.htHomeScore??"?"}-${match.htAwayScore??"?"}`:isLive&&match.minute<45&&total>0?`Canlı İY: ${match.homeScore}-${match.awayScore}`:"Tahmin için oran + form gerekli",
      fullTimeScore:match.status==="FT"?`${match.homeScore}-${match.awayScore}`:"Tahmin için oran + form gerekli",
      mainPick:chosen?.market||"UZAK DUR",alternative:"UZAK DUR",surprise:"Yalnızca veriler desteklerse değerlendirilir",
      marketPercentages:{},
      note:chosen?`${chosen.bookmaker}; piyasa olasılığı ve son 5 maç formu birlikte değerlendirildi${isLive?`; canlı baskı: ${stats.shotsOnTarget} isabetli şut, ${stats.totalShots} toplam şut, ${stats.corners} korner`:""}.`:
        `Yeterli oran + son 5 maç formu${isLive?" + canlı oran/istatistik":""} aynı anda doğrulanmadı. UZAK DUR.`,
      oddsBasis:isLive?"Canlı oran + maç önü referans oranı":"Maç önü son mevcut oran kaydı; resmî kapanış garantisi yok",
      htMarketAlreadyHit
    });
  } catch(e) { res.status(502).json({error:"Analiz üretilemedi.",detail:e.message}); }
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
