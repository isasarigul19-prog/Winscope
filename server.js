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

async function importHistoricalCsvOnce() {
  if (!pool || !existsSync(HISTORICAL_CSV)) return;
  const existing = await pool.query("SELECT COUNT(*)::int AS total FROM historical_matches");
  if (existing.rows[0].total > 0) return;
  const csvText = await readFile(HISTORICAL_CSV, "utf8");
  const records = parse(csvText, { columns: true, bom: true, skip_empty_lines: true, trim: true });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let start = 0; start < records.length; start += 300) {
      const batch = records.slice(start, start + 300);
      const values = [];
      const placeholders = batch.map((row, index) => {
        const offset = index * 24;
        const rawDate = String(row.Date || "").trim();
        const dateParts = rawDate.includes("/") ? rawDate.split("/") : rawDate.split("-");
        let isoDate = null;
        if (dateParts.length === 3) {
          if (/^\d{4}$/.test(dateParts[0])) {
            isoDate = `${dateParts[0]}-${dateParts[1].padStart(2, "0")}-${dateParts[2].padStart(2, "0")}`;
          } else {
            let year = dateParts[2];
            if (/^\d{2}$/.test(year)) year = Number(year) < 50 ? `20${year}` : `19${year}`;
            isoDate = `${year}-${dateParts[1].padStart(2, "0")}-${dateParts[0].padStart(2, "0")}`;
          }
        }
        values.push(
          row.Div || null, isoDate, row.Time || null, row.HomeTeam || null, row.AwayTeam || null,
          toNumber(row.HTHG), toNumber(row.HTAG), toNumber(row.FTHG), toNumber(row.FTAG), row.FTR || null,
          toNumber(row.B365H), toNumber(row.B365D), toNumber(row.B365A), toNumber(row.AvgH), toNumber(row.AvgD), toNumber(row.AvgA),
          toNumber(row["B365>2.5"]), toNumber(row["B365<2.5"]), toNumber(row["Avg>2.5"]), toNumber(row["Avg<2.5"]),
          toNumber(row["B365C>2.5"]), toNumber(row["B365C<2.5"]), toNumber(row.TotalGoals), toNumber(row.Over25Result)
        );
        return `(${Array.from({ length: 24 }, (_, i) => `$${offset + i + 1}`).join(",")})`;
      });
      await client.query(`INSERT INTO historical_matches (
        league_code, match_date, match_time, home_team, away_team, ht_home_goals, ht_away_goals,
        ft_home_goals, ft_away_goals, full_time_result, b365_home, b365_draw, b365_away,
        avg_home, avg_draw, avg_away, b365_over25, b365_under25, avg_over25, avg_under25,
        b365_close_over25, b365_close_under25, total_goals, over25_result
      ) VALUES ${placeholders.join(",")}`, values);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
  } finally { client.release(); }
}

async function initDatabase() {
  if (!pool) return;
  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS historical_matches (
          id BIGSERIAL PRIMARY KEY, league_code TEXT, match_date DATE, match_time TEXT,
          home_team TEXT NOT NULL, away_team TEXT NOT NULL, ht_home_goals INTEGER, ht_away_goals INTEGER,
          ft_home_goals INTEGER, ft_away_goals INTEGER, full_time_result TEXT,
          b365_home NUMERIC, b365_draw NUMERIC, b365_away NUMERIC, avg_home NUMERIC, avg_draw NUMERIC, avg_away NUMERIC,
          b365_over25 NUMERIC, b365_under25 NUMERIC, avg_over25 NUMERIC, avg_under25 NUMERIC,
          b365_close_over25 NUMERIC, b365_close_under25 NUMERIC, total_goals INTEGER, over25_result INTEGER
        );
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
          over15 NUMERIC, over25 NUMERIC, under25 NUMERIC, btts_yes NUMERIC, btts_no NUMERIC,
          observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS live_odds_snapshots_fixture_time_idx
          ON live_odds_snapshots (fixture_id, observed_at DESC);
      `);
      await importHistoricalCsvOnce();
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
  const normalized = [];
  for (const row of (Array.isArray(rows) ? rows : [])) {
    // Pre-match /odds returns bookmakers[].bets[].values[].
    for (const book of (Array.isArray(row.bookmakers) ? row.bookmakers : [])) {
      normalized.push({
        source: String(book.name || defaultSource),
        bets: Array.isArray(book.bets) ? book.bets : []
      });
    }

    // API-Football /odds/live uses odds[].values[] directly on the fixture row
    // (without the pre-match bookmakers[].bets[] nesting).
    if (Array.isArray(row.odds) && row.odds.length) {
      normalized.push({
        source: String(row.bookmaker?.name || row.bookmaker || row.source || defaultSource),
        bets: row.odds.map(item => ({
          name: item.name || item.bet || "",
          values: Array.isArray(item.values) ? item.values : []
        }))
      });
    }
  }

  // Bet365 is preferred only when a bookmaker is explicitly identified.
  const preferred = normalized.find(b => /bet365/i.test(b.source));
  const ordered = preferred ? [preferred, ...normalized.filter(b => b !== preferred)] : normalized;

  for (const book of ordered) {
    const result = {
      source: book.source,
      homeWin: null, draw: null, awayWin: null,
      over15: null, under15: null, over25: null, under25: null,
      bttsYes: null, bttsNo: null
    };
    for (const bet of book.bets) {
      const name = String(bet.name || "").toLowerCase();
      for (const v of (bet.values || [])) {
        const label = String(v.value ?? v.name ?? "").toLowerCase();
        const n = toNumber(v.odd);
        if (n == null) continue;

        if (/match winner|1x2|fulltime result|winner|match result/.test(name)) {
          if (["home", "1", "team 1"].includes(label)) result.homeWin = n;
          else if (["draw", "x"].includes(label)) result.draw = n;
          else if (["away", "2", "team 2"].includes(label)) result.awayWin = n;
        } else if (/over\/under|goals over\/under|total goals|total goals|total/.test(name)) {
          if (/1\.5/.test(label)) {
            if (label.includes("over")) result.over15 = n;
            if (label.includes("under")) result.under15 = n;
          }
          if (/2\.5/.test(label)) {
            if (label.includes("over")) result.over25 = n;
            if (label.includes("under")) result.under25 = n;
          }
        } else if (/both teams to score|both teams score|both teams/.test(name)) {
          if (["yes", "y"].includes(label)) result.bttsYes = n;
          else if (["no", "n"].includes(label)) result.bttsNo = n;
        }
      }
    }
    if (result.homeWin != null || result.over15 != null || result.over25 != null || result.bttsYes != null) return result;
  }
  return null;
}

async function recordLiveOddsSnapshot(fixtureId, liveOdds) {
  const current = {
    over15: toNumber(liveOdds?.over15), over25: toNumber(liveOdds?.over25),
    under25: toNumber(liveOdds?.under25), bttsYes: toNumber(liveOdds?.bttsYes),
    bttsNo: toNumber(liveOdds?.bttsNo)
  };
  const hasMarket = Object.values(current).some(v => v != null);
  if (!hasMarket) return { state: "CANLI ORAN YOK", trend: "ölçülemedi", changed: false };
  if (!pool) return { state: "İLK ÖLÇÜM", trend: "ikinci ölçüm bekleniyor", changed: false };
  try {
    await initDatabase();
    const prevQ = await pool.query(
      `SELECT source, over15, over25, under25, btts_yes, btts_no, observed_at
       FROM live_odds_snapshots WHERE fixture_id=$1 ORDER BY observed_at DESC LIMIT 1`, [Number(fixtureId)]
    );
    const prev = prevQ.rows[0] || null;
    const prevAt = prev ? new Date(prev.observed_at).getTime() : 0;
    const ageMs = prevAt ? Date.now() - prevAt : Infinity;
    const keys = ["over15", "over25", "under25", "bttsYes", "bttsNo"];
    const dbKeys = { over15: "over15", over25: "over25", under25: "under25", bttsYes: "btts_yes", bttsNo: "btts_no" };
    const deltas = {};
    for (const k of keys) {
      const old = prev ? toNumber(prev[dbKeys[k]]) : null;
      deltas[k] = current[k] != null && old != null ? Number((current[k] - old).toFixed(3)) : null;
    }
    // Do not create fake movement from the same cached response; persist at most once per 90 seconds.
    if (!prev || ageMs >= 90_000) {
      await pool.query(
        `INSERT INTO live_odds_snapshots (fixture_id, source, over15, over25, under25, btts_yes, btts_no)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [Number(fixtureId), String(liveOdds.source || "API-Football canlı oran"), current.over15, current.over25, current.under25, current.bttsYes, current.bttsNo]
      );
    }
    const relevant = deltas.over25 != null ? deltas.over25 : deltas.bttsYes;
    let trend = "sabit";
    if (!prev || relevant == null) trend = "ikinci ölçüm bekleniyor";
    else if (relevant <= -0.05) trend = "oran düşüyor";
    else if (relevant >= 0.05) trend = "oran yükseliyor";
    return {
      state: prev ? (ageMs < 90_000 ? "önceki ölçümle karşılaştırıldı" : "yeni ölçüm kaydedildi") : "ilk ölçüm kaydedildi",
      trend, changed: Boolean(prev && relevant != null && Math.abs(relevant) >= 0.05),
      deltas, previousObservedAt: prev?.observed_at || null,
      comparedMarket: deltas.over25 != null ? "MS 2.5 Üst" : (deltas.bttsYes != null ? "KG Var" : "mevcut oran pazarı")
    };
  } catch (error) {
    console.warn(`[Odds movement unavailable] fixture=${fixtureId}: ${error.message}`);
    return { state: "hareket geçmişi kaydedilemedi", trend: "ölçülemedi", changed: false };
  }
}

async function fetchRealOdds(fixtureId, liveMatch = false) {
  // Never invent prices. For a live fixture, keep pre-match prices for historical matching
  // and fetch live prices separately; a pre-match price is not treated as a live market.
  let preMatchOdds = null;
  let liveOdds = null;
  try {
    const payload = await apiGet(`/odds?fixture=${encodeURIComponent(fixtureId)}`);
    preMatchOdds = parseOddsBookmakers(payload);
  } catch (error) {
    console.warn(`[Pre-match odds unavailable] fixture=${fixtureId}: ${error.message}`);
  }

  if (liveMatch) {
    try {
      const livePayload = await apiGet(`/odds/live?fixture=${encodeURIComponent(fixtureId)}`);
      liveOdds = parseOddsBookmakers(livePayload, "API-Football canlı oran");
      if (liveOdds) liveOdds.movement = await recordLiveOddsSnapshot(fixtureId, liveOdds);
      if (!liveOdds) {
        const first = Array.isArray(livePayload) ? livePayload[0] : null;
        console.warn(`[Live odds parse empty] fixture=${fixtureId}; rows=${Array.isArray(livePayload) ? livePayload.length : 0}; rowKeys=${first && typeof first === "object" ? Object.keys(first).join(",") : "none"}; oddsRows=${Array.isArray(first?.odds) ? first.odds.length : 0}; bookmakerRows=${Array.isArray(first?.bookmakers) ? first.bookmakers.length : 0}`);
      }
    } catch (error) {
      console.warn(`[Live odds unavailable] fixture=${fixtureId}: ${error.message}`);
    }
  }

  const base = preMatchOdds || {
    source: null, homeWin: null, draw: null, awayWin: null,
    over15: null, under15: null, over25: null, under25: null, bttsYes: null, bttsNo: null
  };
  return { ...base, liveOdds: liveOdds ? { ...liveOdds, isLive: true } : null, isLive: false };
}

function isActionableMarket(marketText) {
  const market = String(marketText || "").toLocaleUpperCase("tr-TR");
  if (!market || market === "—") return false;
  if (/GERÇEKLEŞTİ|ÇİZGİ GERÇEKLEŞTİ|TAKİP:|ANALİZ:|VERİ YETERSİZ|TERCİH YOK|MAÇ TAMAMLANDI/.test(market)) return false;
  return /(?:MS\s*)?\d+(?:\.\d+)?\s*(?:ÜST|ALT)|KG\s*(?:VAR|YOK)|(?:EV|EV SAHİBİ|DEP|DEPLASMAN)\s*\d+(?:\.\d+)?\s*ÜST|MS\s*[1X2]\b|BERABERLİK/.test(market);
}

function decideSmartMarket(historyData, odds, currentTotalGoals, liveStats, matchInfo) {
  const h = historyData || {};
  const o = odds || {};
  const live = Array.isArray(liveStats) ? liveStats : [];
  let shotsOnTarget = 0, totalShots = 0, dangerousAttacks = 0, corners = 0;
  const perTeam = [];
  for (const team of live) {
    const stats = Array.isArray(team.statistics) ? team.statistics : [];
    const item = {};
    for (const stat of stats) {
      const name = String(stat.type || "").toLowerCase();
      const value = toNumber(stat.value) || 0;
      if (name === "shots on goal" || name === "shots on target") { shotsOnTarget += value; item.sot = value; }
      if (name === "total shots") { totalShots += value; item.shots = value; }
      if (name === "dangerous attacks") { dangerousAttacks += value; item.dangerous = value; }
      if (name === "corner kicks" || name === "corners") { corners += value; item.corners = value; }
    }
    perTeam.push(item);
  }
  const isLive = Boolean(matchInfo && ["LIVE", "HT"].includes(matchInfo.status));
  const minute = Number(matchInfo?.minute || 0);
  const goals = Number(currentTotalGoals || 0);
  const liveOdds = o.liveOdds || null;
  const movement = liveOdds?.movement || null;
  const hasLiveMarket = Boolean(liveOdds?.isLive && [liveOdds.over15, liveOdds.over25, liveOdds.bttsYes].some(v => toNumber(v) != null));
  const statsAvailable = live.length >= 2;
  const tempoScore = (totalShots >= 10 ? 1 : 0) + (shotsOnTarget >= 3 ? 1 : 0) + (dangerousAttacks >= 25 ? 1 : 0) + (corners >= 5 ? 1 : 0);
  const historicalEnough = Number(h.total || 0) >= 30;
  const candidates = [];
  const add = (market, pct, oddsAvailable, condition, reasons, scoreBonus = 0) => {
    if (!condition || !oddsAvailable || !historicalEnough || !Number.isFinite(Number(pct))) return;
    const histPct = Number(pct);
    // Rank by historical frequency plus observed market movement and live tempo; this is a ranking score, not a win probability.
    const movementBonus = movement?.trend === "oran düşüyor" ? 8 : movement?.trend === "oran yükseliyor" ? -4 : 0;
    const rankScore = histPct + scoreBonus + movementBonus;
    candidates.push({ market, pct: histPct, rankScore, rationale: reasons });
  };

  if (isLive) {
    if (goals >= 3) return {
      mainPick: "ANALİZ: MS 2.5 ÜST ÇİZGİSİ GERÇEKLEŞTİ", alternative: "—", confidence: null,
      rationale: `Canlı skor ${matchInfo.homeScore}-${matchInfo.awayScore}, dakika ${minute}. 2.5 üst çizgisi gerçekleşti; bu, yeni bahis önerisi değildir. Tarihsel örneklem ${h.total || 0} maç.`
    };

    const movementText = movement
      ? `Canlı oran hareketi: ${movement.trend} (${movement.state}).`
      : "Canlı oran hareketi henüz ölçülemedi.";
    const statsText = statsAvailable
      ? `Canlı tempo: ${totalShots} şut, ${shotsOnTarget} isabetli şut, ${dangerousAttacks} tehlikeli atak, ${corners} korner.`
      : "Canlı takım istatistikleri eksik.";
    const marketText = hasLiveMarket
      ? `Canlı piyasa kaynağı: ${liveOdds.source || "API-Football"}.`
      : "Bu maç için kullanılabilir canlı gol/KG oranı bulunamadı.";

    // MS 1.5 Üst: especially useful for 0-0/1-0 states when enough time remains.
    add("MS 1.5 ÜST", h.over15Pct,
      toNumber(liveOdds?.over15) != null,
      minute >= 8 && minute <= 70 && goals <= 1 && statsAvailable && tempoScore >= 1 && Number(h.over15Pct) >= 60,
      `${statsText} ${marketText} ${movementText} Benzer oranlı geçmiş maçlarda MS 1.5 üst gerçekleşme sıklığı %${h.over15Pct}.`, tempoScore * 2);

    // MS 2.5 Üst: don't force if score line has already landed or match is too late.
    add("MS 2.5 ÜST", h.over25Pct,
      toNumber(liveOdds?.over25) != null,
      minute >= 10 && minute <= 72 && goals >= 1 && goals <= 2 && statsAvailable && tempoScore >= 2 && Number(h.over25Pct) >= 55,
      `${statsText} ${marketText} ${movementText} Benzer oranlı geçmiş maçlarda MS 2.5 üst gerçekleşme sıklığı %${h.over25Pct}.`, tempoScore * 2);

    // KG Var only when one side is still scoreless and there is evidence of pressure.
    const oneSideScoreless = Number(matchInfo.homeScore || 0) === 0 || Number(matchInfo.awayScore || 0) === 0;
    add("KG VAR", h.bttsPct,
      toNumber(liveOdds?.bttsYes) != null,
      minute >= 12 && minute <= 72 && oneSideScoreless && statsAvailable && tempoScore >= 2 && Number(h.bttsPct) >= 55,
      `${statsText} ${marketText} ${movementText} Benzer oranlı geçmiş maçlarda KG Var gerçekleşme sıklığı %${h.bttsPct}.`, tempoScore * 2);

    if (!candidates.length) {
      let mainPick = "ANALİZ: NET TERCİH YOK";
      if (!historicalEnough) mainPick = "ANALİZ: TARİHSEL ÖRNEKLEM YETERSİZ";
      else if (!hasLiveMarket) mainPick = "TAKİP: CANLI GOL ORANI BEKLENİYOR";
      else if (!statsAvailable) mainPick = "TAKİP: CANLI İSTATİSTİK BEKLENİYOR";
      else if (!movement || movement.trend === "ikinci ölçüm bekleniyor") mainPick = "TAKİP: ORAN HAREKETİ İÇİN İKİNCİ ÖLÇÜM BEKLENİYOR";
      return {
        mainPick, alternative: "—", confidence: null,
        rationale: `Canlı skor ${matchInfo.homeScore}-${matchInfo.awayScore}, dakika ${minute}. ${statsText} ${marketText} ${movementText} Tarihsel benzer örneklem: ${h.total || 0} maç. Sinyaller birlikte yeterli seviyeye ulaşmadığı için kupon tercihi zorlanmadı.`
      };
    }
  } else {
    const prematchSource = o.source || "oran kaynağı belirsiz";
    add("MS 2.5 ÜST", h.over25Pct, toNumber(o.over25) != null,
      Number(h.over25Pct) >= 60,
      `Maç önü oran kaynağı: ${prematchSource}. Benzer oranlı geçmiş maçlarda MS 2.5 üst gerçekleşme sıklığı %${h.over25Pct}. Bu oran tek maçın kazanma olasılığı değildir.`);
    add("KG VAR", h.bttsPct, toNumber(o.bttsYes) != null,
      Number(h.bttsPct) >= 60,
      `Maç önü oran kaynağı: ${prematchSource}. Benzer oranlı geçmiş maçlarda KG Var gerçekleşme sıklığı %${h.bttsPct}.`);
  }

  candidates.sort((a, b) => b.rankScore - a.rankScore);
  if (!candidates.length) return {
    mainPick: isLive ? "ANALİZ: NET TERCİH YOK" : "ANALİZ: PİYASA VE TARİHSEL VERİ YETERSİZ",
    alternative: "—", confidence: null,
    rationale: `Tarihsel örneklem ${Number(h.total || 0)} maç. Oran, ilgili market ve tarihsel sinyaller aynı anda yeterli seviyeye ulaşmadı; otomatik tercih üretilmedi.`
  };
  const best = candidates[0];
  const next = candidates.find(c => c.market !== best.market);
  return { mainPick: best.market, alternative: next?.market || "—", confidence: best.pct, rationale: best.rationale };
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

  let historyData = null;
  if (pool) {
    try {
      await initDatabase();
      const q = await pool.query(`
        SELECT ft_home_goals, ft_away_goals, ht_home_goals, ht_away_goals,
               b365_home, b365_over25, avg_home, avg_over25
        FROM historical_matches
        WHERE ft_home_goals IS NOT NULL AND ft_away_goals IS NOT NULL
          AND (b365_over25 IS NOT NULL OR b365_home IS NOT NULL
               OR avg_over25 IS NOT NULL OR avg_home IS NOT NULL)
        ORDER BY match_date DESC NULLS LAST
      `);
      const rows = q.rows;
      let ranked = [];
      if (rows.length && (odds.homeWin != null || odds.over25 != null)) {
        const isBet365 = /bet365/i.test(String(odds.source || ""));
        const homeOddsField = isBet365 ? "b365_home" : "avg_home";
        const overOddsField = isBet365 ? "b365_over25" : "avg_over25";
        ranked = rows.map(r => {
          let d = 0, terms = 0;
          if (odds.homeWin != null && r[homeOddsField] != null) {
            d += Math.abs(Number(r[homeOddsField]) - odds.homeWin); terms++;
          }
          if (odds.over25 != null && r[overOddsField] != null) {
            d += Math.abs(Number(r[overOddsField]) - odds.over25); terms++;
          }
          return { r, d: terms ? d / terms : Infinity };
        }).filter(x => Number.isFinite(x.d)).sort((a, b) => a.d - b.d).slice(0, 100).map(x => x.r);
      }
      if (ranked.length) {
        const total = ranked.length;
        const pct = fn => Number((100 * ranked.filter(fn).length / total).toFixed(1));
        historyData = {
          total,
          over25Pct: pct(r => Number(r.ft_home_goals) + Number(r.ft_away_goals) >= 3),
          over15Pct: pct(r => Number(r.ft_home_goals) + Number(r.ft_away_goals) >= 2),
          bttsPct: pct(r => Number(r.ft_home_goals) > 0 && Number(r.ft_away_goals) > 0),
          ht05Pct: pct(r => Number(r.ht_home_goals || 0) + Number(r.ht_away_goals || 0) >= 1),
          home15Pct: pct(r => Number(r.ft_home_goals) >= 2),
          away15Pct: pct(r => Number(r.ft_away_goals) >= 2),
          ms1Pct: pct(r => Number(r.ft_home_goals) > Number(r.ft_away_goals)),
          ms2Pct: pct(r => Number(r.ft_home_goals) < Number(r.ft_away_goals)),
          msXPct: pct(r => Number(r.ft_home_goals) === Number(r.ft_away_goals)),
          ftScores: Object.entries(ranked.reduce((acc, r) => {
            const score = `${r.ft_home_goals}-${r.ft_away_goals}`;
            acc[score] = (acc[score] || 0) + 1;
            return acc;
          }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([score, count]) => [score, Number((100 * count / total).toFixed(1))]),
          htScores: Object.entries(ranked.filter(r => r.ht_home_goals != null && r.ht_away_goals != null).reduce((acc, r) => {
            const score = `${r.ht_home_goals}-${r.ht_away_goals}`;
            acc[score] = (acc[score] || 0) + 1;
            return acc;
          }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3)
            .map(([score, count]) => [score, Number((100 * count / total).toFixed(1))]),
          source: "historical_matches"
        };
      }
    } catch (e) {
      console.error("[Historical analysis unavailable]", e.message);
    }
  }
  if (!historyData) {
    historyData = { total: 0, over25Pct: null, over15Pct: null, bttsPct: null, ht05Pct: null,
      home15Pct: null, away15Pct: null, ms1Pct: null, ms2Pct: null, msXPct: null,
      ftScores: [], htScores: [], source: "unavailable" };
  }

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

  const smartPick = decideSmartMarket(historyData, odds, currentTotalGoals, liveStats, matchInfo);
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
    halfTimeDisplayScore = "İY skor tahmini için yeterli veri yok";
  }
  const confidenceScore = smartPick.confidence != null && historyData.total >= 30
    ? Math.round(smartPick.confidence) : 0;

  return {
    matchInfo, isLive, isFinished, odds, historyData, liveStats,
    halfTimeDisplayScore, surpriseDisplay, mainPickDisplay, isSecondHalf, smartPick,
    confidenceScore
  };
}

app.get("/api/match/:id/analyze", async (req, res) => {
  const fixtureId = req.params.id;
  try {
    const resEval = await evaluateMatchAdvanced(fixtureId);
    const { matchInfo, isLive, isFinished, odds, historyData, liveStats, halfTimeDisplayScore, surpriseDisplay, mainPickDisplay, isSecondHalf, smartPick, confidenceScore } = resEval;

    res.json({
      fixtureId: Number(fixtureId),
      iddaaCode: matchInfo.iddaaCode,
      matchStatus: isFinished ? "FT" : (isLive ? "LIVE" : "NS"),
      mainPick: mainPickDisplay,
      alternative: smartPick.alternative,
      halfTimeScore: halfTimeDisplayScore,
      fullTimeScore: isFinished ? `${matchInfo.homeScore}-${matchInfo.awayScore}` : "Tahmin: yeterli doğrulanmış veri yok",
      alternativeFullTimeScore: isFinished ? `${matchInfo.homeScore}-${matchInfo.awayScore}` : "—",
      surprise: surpriseDisplay,
      marketDirection: isLive
        ? (odds.liveOdds?.source
            ? `Canlı oran kaynağı: ${odds.liveOdds.source} · ${odds.liveOdds.movement?.trend || "hareket ölçülmedi"} · ${odds.liveOdds.movement?.state || "ilk ölçüm bekleniyor"}`
            : (odds.source ? `Maç önü oran kaynağı: ${odds.source}; canlı oran bulunamadı` : "Canlı ve maç önü oranı bulunamadı"))
        : (odds.source ? `Oran kaynağı: ${odds.source}` : "Piyasa oranı bulunamadı"),
      confidence: confidenceScore > 0 ? `Tarihsel eşleşme göstergesi · %${confidenceScore}` : "Güven puanı hesaplanamadı",
      statsAvailable: liveStats.length > 0,
      stats: liveStats,
      history: {
        available: historyData.total > 0,
        sampleSize: historyData.total,
        over25Percent: historyData.over25Pct,
        home15Percent: historyData.home15Pct,
        away15Percent: historyData.away15Pct,
        topFullTimeScores: historyData.ftScores || [],
        topHalfTimeScores: historyData.htScores || [],
        resultDistribution: { "MS 1": { percent: historyData.ms1Pct }, "MS X": { percent: historyData.msXPct }, "MS 2": { percent: historyData.ms2Pct } }
      },
      reasons: [smartPick.rationale, confidenceScore > 0 ? `Tarihsel eşleşme göstergesi: %${confidenceScore}` : "Yeterli doğrulanmış veri yok; kupon adayı olarak seçilmemeli"]
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
      market: String(p.market), league: p.league || "", resultSent: false, won: null
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

async function generateLiveCouponLogic() {
  const diagnostics = {
    liveFixtures: 0, supportedLeague: 0, evaluated: 0, withLiveStats: 0,
    withRealOdds: 0, withHistory30: 0, withOddsMovement: 0, strongCandidates: 0, evaluationErrors: 0
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
    const batchSize = Math.min(8, liveCandidates.length);
    const startAt = liveCandidates.length ? liveCouponScanCursor % liveCandidates.length : 0;
    const batch = liveCandidates.length
      ? Array.from({ length: batchSize }, (_, i) => liveCandidates[(startAt + i) % liveCandidates.length])
      : [];
    if (liveCandidates.length) liveCouponScanCursor = (startAt + batch.length) % liveCandidates.length;
    const validMatches = [];
    for (const { raw, f } of batch) {
      try {
        diagnostics.evaluated++;
        const evalData = await evaluateMatchAdvanced(f.id, raw);
        if (evalData.liveStats?.length >= 2) diagnostics.withLiveStats++;
        if (evalData.odds?.liveOdds?.isLive && (evalData.odds.liveOdds.over15 != null || evalData.odds.liveOdds.over25 != null || evalData.odds.liveOdds.bttsYes != null)) diagnostics.withRealOdds++;
        if (evalData.odds?.liveOdds?.movement?.previousObservedAt) diagnostics.withOddsMovement++;
        if (evalData.historyData?.total >= 30) diagnostics.withHistory30++;

        const qualifies =
          isActionableMarket(evalData.smartPick?.mainPick) &&
          evalData.historyData?.total >= 30 &&
          evalData.smartPick?.confidence >= 65 &&
          evalData.liveStats?.length >= 2 &&
          Boolean(evalData.odds?.liveOdds?.isLive) &&
          (evalData.odds.liveOdds.over15 != null || evalData.odds.liveOdds.over25 != null || evalData.odds.liveOdds.bttsYes != null);

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
    const picks = validMatches.slice(0, 2).map(({ f, evalData }) => ({
      fixtureId: f.id,
      iddaaCode: f.iddaaCode,
      home: f.home,
      away: f.away,
      league: f.league,
      minute: f.minute,
      currentScore: `${f.homeScore}-${f.awayScore}`,
      market: evalData.smartPick.mainPick,
      odd: evalData.smartPick.odd ?? null,
      historicalProbability: evalData.confidenceScore,
      historicalFrequency: evalData.smartPick.confidence,
      source: "WinScope Akıllı Canlı Analiz"
    }));

    if (!picks.length) {
      const note = `Canlı ${diagnostics.liveFixtures} maç · uygun lig/dakika ${diagnostics.supportedLeague} · analiz edilen ${diagnostics.evaluated} · canlı istatistik bulunan ${diagnostics.withLiveStats} · gerçek canlı oran bulunan ${diagnostics.withRealOdds} · önceki oran ölçümü bulunan ${diagnostics.withOddsMovement} · 30+ benzer geçmiş maç bulunan ${diagnostics.withHistory30} · eşikleri geçen ${diagnostics.strongCandidates}. İlk tarama oran hareketini ölçemez; sonraki taramalarda önceki ölçümle kıyaslanır. Veriler yetersizse kupon zorlanmaz.`;
      return {
        draftId: `live-empty-${Date.now()}`,
        date: new Date().toISOString().split("T")[0],
        isLive: true,
        status: "NO_MATCHES",
        picks: [],
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
      note: "Canlı istatistik, gerçek piyasa oranı ve en az 30 benzer tarihsel maçla filtrelendi. Yüzde, canlı kazanma olasılığı değil tarihsel gerçekleşme sıklığıdır."
    };

    let tgMsg = `🎯 <b>WINSCOPE CANLI FIRSAT KOMBİNİ</b> 🎯
🕒 Saat: ${new Date().toLocaleTimeString('tr-TR')}

`;
    coupon.picks.forEach(p => {
      tgMsg += `🏆 <b>${p.league}</b>
⚽ ${p.home} vs ${p.away}
⏱️ Dk: ${p.minute}' | Skor: ${p.currentScore}
🎯 Tercih: <b>${p.market}</b> (Benzer oranlı geçmiş maçlarda gerçekleşme sıklığı: %${p.historicalFrequency})
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
        if (evalData.confidenceScore >= 75 && evalData.historyData.total >= 30 && isActionableMarket(evalData.mainPickDisplay)) {
          picks.push({
            fixtureId: f.id,
            iddaaCode: f.iddaaCode,
            home: f.home,
            away: f.away,
            league: f.league,
            kickoff: f.fixtureDate,
            market: evalData.smartPick.mainPick,
            odd: evalData.smartPick.odd,
            historicalProbability: evalData.confidenceScore,
            source: "Veri Odaklı Maç Önü"
          });
          if (picks.length >= 2) break;
        }
      } catch (e) { continue; }
    }

    if (!picks.length) {
      return {
        draftId: `iddaa-empty-${Date.now()}`,
        date: dateStr,
        status: "NO_MATCHES",
        picks: [],
        note: "Bu tarihte %75+ kritere uyan maç bulunamadı."
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
🎯 Tercih: <b>${p.market}</b> (Benzer maç geçmişi: %${p.historicalProbability})
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
    res.status(502).json({ error: "Maç bülteni alınamadı." });
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

// OTOMATİK TARAMA (Gerçek Zamanlı Telegram Alarm Tetikleyicisi + Sonuç Takipçisi)
const AUTO_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const notifiedLiveFixtures = new Set();
const activeSentCoupons = new Map();

setInterval(async () => {
  try {
    console.log("[Auto-Scan Alarm Fix] Canlı maçlar ve Telegram alarmları taranıyor...");
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", 30_000);
    const rawMatches = payload.response || [];
    await restoreTrackedPicks();
    
    // 1. SONUÇ TAKİBİ: fixture ID ile doğrudan sorgula; biten maç canlı listesinden çıkmış olsa da bulunur.
    for (const [draftId, couponInfo] of activeSentCoupons.entries()) {
      let allFinished = true;
      for (const pick of couponInfo.picks) {
        if (pick.resultSent) continue;
        try {
          const result = await fetchFixtureResult(pick.fixtureId);
          if (!result || result.status !== "FT") {
            allFinished = false;
            continue;
          }
          const rawScore = result.raw?.score || {};
          const rawGoals = result.raw?.goals || {};
          if (rawGoals.home == null || rawGoals.away == null) {
            allFinished = false;
            continue;
          }
          const ht = rawScore.halftime || {};
          const won = gradePick(pick.market, rawGoals.home, rawGoals.away, ht.home, ht.away);
          pick.won = won == null ? null : won;
          let sent = false;
          if (won == null) {
            sent = await sendTelegramMessage(`📊 <b>WINSCOPE MAÇ SONUCU</b>
🏆 ${pick.league || couponInfo.sourceLabel || "Maç analizi"}
⚽ ${pick.home} ${result.homeScore}-${result.awayScore} ${pick.away}
🎯 Tercih: ${pick.market}
⚠️ Sonuç otomatik değerlendirilemedi; manuel kontrol gerekli.`);
          } else {
            sent = await sendTelegramMessage(`${won ? "✅ <b>TERCİH KAZANDI</b>" : "❌ <b>TERCİH KAYBETTİ</b>"}
🏆 ${pick.league || couponInfo.sourceLabel || "Maç analizi"}
⚽ ${pick.home} ${result.homeScore}-${result.awayScore} ${pick.away}
🎯 Tercih: ${pick.market}
📌 Sonuç: ${won ? "KAZANDI" : "KAYBETTİ"}`);
          }
          if (sent) {
            pick.resultSent = true;
            await persistTrackedPick(draftId, couponInfo);
          } else {
            allFinished = false;
          }
        } catch (e) {
          allFinished = false;
          console.warn(`[Result tracker] ${pick.fixtureId}: ${e.message}`);
        }
      }
      if (couponInfo.picks.every(p => p.resultSent)) {
        const won = couponInfo.picks.filter(p => {
          // The result marker is set only after a result was sent; result state is attached below where available.
          return p.won === true;
        }).length;
        const lost = couponInfo.picks.filter(p => p.won === false).length;
        const unresolved = couponInfo.picks.filter(p => p.won == null).length;
        const summarySent = await sendTelegramMessage(`📋 <b>WINSCOPE KUPON ÖZETİ</b>
📦 ${couponInfo.sourceLabel || "Telegram kuponu"}
✅ Kazanan: ${won}
❌ Kaybeden: ${lost}
⚠️ Otomatik değerlendirilemeyen: ${unresolved}
📊 Takip edilen seçim: ${couponInfo.picks.length}`);
        if (summarySent) {
          activeSentCoupons.delete(draftId);
          await deleteTrackedPick(draftId);
        }
      }
    }

    // 2. YENİ 2 MAÇLIK OTOMATİK KOMBİN VE TELEGRAM ALARMI (10 - 80 DAKİKA ARASI)
    const validMatches = [];
    const scanCandidates = rawMatches.map(raw => ({ raw, f: normalizeProviderMatch(raw) }))
      .filter(({ f }) => ["LIVE", "HT"].includes(f.status) && f.minute != null &&
        f.minute >= 10 && f.minute <= 80 && isStrictIddaaMatch(f) && !notifiedLiveFixtures.has(f.id))
      .sort((a, b) => {
        const aScore = (a.f.minute >= 20 && a.f.minute <= 75 ? 2 : 0) + (a.f.homeScore + a.f.awayScore <= 2 ? 1 : 0);
        const bScore = (b.f.minute >= 20 && b.f.minute <= 75 ? 2 : 0) + (b.f.homeScore + b.f.awayScore <= 2 ? 1 : 0);
        return bScore - aScore || Number(a.f.minute) - Number(b.f.minute);
      });

    const autoBatchSize = Math.min(4, scanCandidates.length);
    const autoStartAt = scanCandidates.length ? autoAlarmScanCursor % scanCandidates.length : 0;
    const autoBatch = scanCandidates.length
      ? Array.from({ length: autoBatchSize }, (_, i) => scanCandidates[(autoStartAt + i) % scanCandidates.length])
      : [];
    if (scanCandidates.length) autoAlarmScanCursor = (autoStartAt + autoBatch.length) % scanCandidates.length;

    for (const { raw: mRaw, f } of autoBatch) {
      try {
        const evalData = await evaluateMatchAdvanced(f.id, mRaw);
        const qualifies =
          isActionableMarket(evalData.smartPick?.mainPick) &&
          evalData.historyData?.total >= 30 &&
          evalData.smartPick?.confidence >= 65 &&
          evalData.liveStats?.length >= 2 &&
          Boolean(evalData.odds?.liveOdds?.isLive) &&
          (evalData.odds.liveOdds.over15 != null || evalData.odds.liveOdds.over25 != null || evalData.odds.liveOdds.bttsYes != null);
        if (qualifies) validMatches.push({ f, evalData });
      } catch (e) {
        console.warn(`[Auto scan evaluation] fixture=${f.id}: ${e.message}`);
      }
    }

    validMatches.sort((a, b) => b.evalData.confidenceScore - a.evalData.confidenceScore);

    if (validMatches.length >= 2) {
      const selectedPicks = validMatches.slice(0, 2);
      const draftId = `auto-alarm-coupon-${Date.now()}`;
      
      let autoMsg = `🎯 <b>WINSCOPE CANLI FIRSAT KOMBİNİ</b> 🎯
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
🎯 Tercih: <b>${item.evalData.mainPickDisplay}</b> (Benzer maç geçmişi: %${item.evalData.confidenceScore})
-------------------
`;
      }

      const autoTelegramSent = await sendTelegramMessage(autoMsg);
      if (autoTelegramSent) {
        await registerTelegramPicks(draftId, couponPicksArray, "Otomatik canlı fırsat kombini");
        console.log("[Auto-Scan OK] Telegram'a yeni 2'li kombin alarmı başarıyla gönderildi.");
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
