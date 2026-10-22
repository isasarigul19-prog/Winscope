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
const BASE_URL = "https://v3.football.api-sports.io";
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HISTORICAL_CSV = path.join(ROOT, "winscope_historical_odds.csv");
const { Pool } = pg;

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(ROOT, "public")));
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    if (/^\/api\/(coupon|live-combo|match|fixtures|live)/.test(req.path)) {
      console.log(`[HTTP] ${req.method} ${req.path} -> ${res.statusCode} ${Date.now()-started}ms`);
    }
  });
  next();
});

const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 3
}) : null;

let dbReady = null;
let autoCaptureRunning = false;
// Quota-aware cache: reuse recent data and retain stale successful responses during provider outages.
const oddsCache = new Map();
const oddsInFlight = new Map();
const CACHE_MS = { live: 5 * 60_000, prematch: 30 * 60_000 };
const providerCache = new Map();
// Keep list/fixture/stat data longer to stay below the provider's 60 requests/hour limit.
const PROVIDER_CACHE_MS = { liveList: 5 * 60_000, fixture: 10 * 60_000, stats: 5 * 60_000 };
const providerInFlight = new Map();
let providerRateLimitedUntil = 0;

async function cachedProviderRequest(cacheKey, pathname, ttlMs) {
  const now = Date.now();
  const cached = providerCache.get(cacheKey);
  if (cached && now - cached.at < ttlMs) return cached.payload;
  // If the provider has rate-limited us, do not keep spending requests; serve last known data.
  if (now < providerRateLimitedUntil) {
    if (cached) return cached.payload;
    throw new Error(`API-Football hız limiti nedeniyle geçici olarak beklemede. Yaklaşık ${Math.ceil((providerRateLimitedUntil - now) / 60000)} dakika sonra tekrar denenecek.`);
  }
  if (providerInFlight.has(cacheKey)) return providerInFlight.get(cacheKey);
  const task = footballDataRequest(pathname).then(payload => {
    providerCache.set(cacheKey, { at: Date.now(), payload });
    return payload;
  }).catch(error => {
    if (/HTTP 429|rate.limit|too_many_requests|60 requests per hour/i.test(String(error.message))) {
      // Provider quota is hourly. Pause calls for 55 minutes and use stale cache where possible.
      providerRateLimitedUntil = Date.now() + 55 * 60_000;
      if (cached) {
        console.warn(`API limit aşıldı; eski önbellek kullanılıyor (${cacheKey}).`);
        return cached.payload;
      }
    }
    throw error;
  }).finally(() => providerInFlight.delete(cacheKey));
  providerInFlight.set(cacheKey, task);
  return task;
}

function toNumber(value) {
  if (value == null || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function importHistoricalCsvOnce() {
  if (!pool || !existsSync(HISTORICAL_CSV)) {
    console.log("Historical CSV bulunamadı; aktarım atlandı.");
    return { imported: false, reason: "csv_not_found" };
  }
  const existing = await pool.query("SELECT COUNT(*)::int AS total FROM historical_matches");
  if (existing.rows[0].total > 0) {
    console.log(`Geçmiş veri zaten yüklü: ${existing.rows[0].total}`);
    return { imported: false, reason: "already_imported", rows: existing.rows[0].total };
  }
  const csvText = await readFile(HISTORICAL_CSV, "utf8");
  const records = parse(csvText, { columns: true, bom: true, skip_empty_lines: true, trim: true });
  const client = await pool.connect();
  let inserted = 0;
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
          // Historical odds CSVs commonly use DD/MM/YY as well as DD/MM/YYYY.
          // Preserve ISO YYYY-MM-DD input; otherwise normalize day-first dates.
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
      inserted += batch.length;
    }
    await client.query("COMMIT");
    console.log(`Tarihsel maçlar içe aktarıldı: ${inserted}`);
    return { imported: true, rows: inserted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

async function initDatabase() {
  if (!pool) throw new Error("DATABASE_URL ayarlanmamış.");
  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS match_stat_snapshots (
          id BIGSERIAL PRIMARY KEY, fixture_id BIGINT NOT NULL,
          captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), teams JSONB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_match_snapshots_fixture_time ON match_stat_snapshots (fixture_id, captured_at DESC);
        CREATE TABLE IF NOT EXISTS tracked_matches (
          fixture_id BIGINT PRIMARY KEY, home_team TEXT NOT NULL, away_team TEXT NOT NULL,
          enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS historical_matches (
          id BIGSERIAL PRIMARY KEY, league_code TEXT, match_date DATE, match_time TEXT,
          home_team TEXT NOT NULL, away_team TEXT NOT NULL, ht_home_goals INTEGER, ht_away_goals INTEGER,
          ft_home_goals INTEGER, ft_away_goals INTEGER, full_time_result TEXT,
          b365_home NUMERIC, b365_draw NUMERIC, b365_away NUMERIC, avg_home NUMERIC, avg_draw NUMERIC, avg_away NUMERIC,
          b365_over25 NUMERIC, b365_under25 NUMERIC, avg_over25 NUMERIC, avg_under25 NUMERIC,
          b365_close_over25 NUMERIC, b365_close_under25 NUMERIC, total_goals INTEGER, over25_result INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_historical_league_date ON historical_matches (league_code, match_date DESC);
        CREATE INDEX IF NOT EXISTS idx_historical_teams ON historical_matches (home_team, away_team);
        CREATE TABLE IF NOT EXISTS odds_snapshots (
          id BIGSERIAL PRIMARY KEY, fixture_id BIGINT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('live','prematch')),
          bookmaker TEXT NOT NULL, market_name TEXT NOT NULL, selection TEXT NOT NULL, odd NUMERIC NOT NULL,
          captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), raw JSONB
        );
        CREATE INDEX IF NOT EXISTS idx_odds_snapshots_lookup ON odds_snapshots (fixture_id, mode, bookmaker, market_name, selection, captured_at DESC);
        CREATE TABLE IF NOT EXISTS sent_match_alarms (
          id BIGSERIAL PRIMARY KEY, fixture_id BIGINT NOT NULL, alarm_key TEXT NOT NULL,
          sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE (fixture_id, alarm_key)
        );
      `);
      await importHistoricalCsvOnce();
      return true;
    })().catch(error => { dbReady = null; console.error("Database initialization error:", error.message); throw error; });
  }
  return dbReady;
}

function mapProviderStatus(status) {
  const value = String(status || "").toLowerCase();
  if (/^\d{1,3}$/.test(value)) {
    const numericStatus = Number(value);
    if (numericStatus === 0) return "NS";
    return numericStatus >= 1 && numericStatus <= 150 ? "LIVE" : "NS";
  }
  if (["finished", "full", "ft", "after_extra_time", "after_penalties"].includes(value)) return "FT";
  if (["half", "halftime", "ht", "paused"].includes(value)) return "HT";
  if (["live", "in_play", "1h", "2h", "extra_time", "penalties"].includes(value)) return "LIVE";
  if (["scheduled", "not_started", "ns", "upcoming"].includes(value)) return "NS";
  if (value.includes("postpon")) return "PST";
  if (value.includes("cancel")) return "CANC";
  return String(status || "NS").toUpperCase();
}

function providerMinute(match) {
  // API-Football status_code is usually a string such as "1H" or "2H".
  // Check numeric elapsed/minute fields first; otherwise Number("1H") becomes NaN
  // and hides the real elapsed minute returned by the provider.
  const candidates = [
    match?.fixture?.status?.elapsed,
    match?.minute,
    match?.elapsed,
    match?.status?.elapsed
  ];
  for (const value of candidates) {
    if (value == null || String(value).trim() === "") continue;
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0 && n <= 150) return n;
  }
  const status = String(match?.status_code ?? match?.status?.short ?? match?.status ?? "").toLowerCase();
  if (["half", "halftime", "ht"].includes(status)) return 45;
  return null;
}

function normalizeProviderMatch(match) {
  return {
    id: Number(match.id ?? match.fixture?.id),
    league: match.league?.name || "Bilinmeyen lig",
    country: match.country?.name || match.league?.country || "",
    minute: providerMinute(match) ?? match.fixture?.status?.elapsed ?? null,
    status: mapProviderStatus(match.status_code ?? match.status ?? match.fixture?.status?.short),
    home: match.teams?.home?.name || "Ev sahibi",
    away: match.teams?.away?.name || "Deplasman",
    homeScore: match.goals?.home ?? null,
    awayScore: match.goals?.away ?? null,
    homeId: match.teams?.home?.id ?? null,
    awayId: match.teams?.away?.id ?? null,
    fixtureDate: match.kickoff_utc || match.fixture?.date || null
  };
}

function apiFootballFixtureToLegacy(item) {
  const f = item?.fixture || {};
  return {
    id: f.id ?? item?.id ?? null,
    kickoff_utc: f.date ?? item?.date ?? null,
    status_code: f.status?.short ?? item?.status ?? "NS",
    minute: f.status?.elapsed ?? null,
    league: { name: item?.league?.name || "Bilinmeyen lig", country: item?.league?.country || "" },
    teams: {
      home: { id: item?.teams?.home?.id ?? null, name: item?.teams?.home?.name || "Ev sahibi" },
      away: { id: item?.teams?.away?.id ?? null, name: item?.teams?.away?.name || "Deplasman" }
    },
    goals: { home: item?.goals?.home ?? null, away: item?.goals?.away ?? null },
    corners: null,
    raw: item
  };
}

function apiFootballStatsToLegacy(rows) {
  const stats = {};
  const keyMap = {
    "Total Shots": "total_shots", "Shots on Goal": "shots_on_target", "Shots off Goal": "shots_off_target",
    "Corner Kicks": "corners", "Ball Possession": "possession", "Dangerous Attacks": "dangerous_attacks"
  };
  for (const row of rows || []) {
    const side = row?.team?.id == null ? null : String(row.team.id);
    for (const stat of row?.statistics || []) {
      const key = keyMap[stat.type];
      if (!key) continue;
      if (!stats[key]) stats[key] = {};
      const value = typeof stat.value === "string" && stat.value.endsWith("%") ? Number(stat.value.replace("%", "")) : stat.value;
      if (side) stats[key][side] = value;
      stats[key][row.team?.name || ""] = value;
    }
  }
  // Normalize by home/away ordering, since API-Football returns team IDs, not home/away keys.
  return stats;
}

async function footballDataRequest(pathname) {
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY ayarlanmamış.");
  let endpoint = pathname;
  let responseKind = "fixtures";
  const liveList = pathname.startsWith("/fixtures?status=live") || pathname.startsWith("/fixtures?live=all");
  const dateMatch = pathname.match(/^\/fixtures\?start_time=(\d+)&end_time=(\d+)(?:&[^#]*)?$/);
  const statsMatch = pathname.match(/^\/fixtures\/(\d+)\/statistics/);
  const oddsMatch = pathname.match(/^\/fixtures\/(\d+)\/odds/);
  const fixtureMatch = pathname.match(/^\/fixtures\/(\d+)(?:\?|$)/);
  const statsLegacyMatch = pathname.match(/^\/fixtures\/statistics\?fixture=(\d+)/);
  const fixtureQueryMatch = pathname.match(/^\/fixtures\?id=(\d+)/);

  if (liveList) {
    endpoint = "/fixtures?live=all";
  } else if (dateMatch) {
    const startMs = Number(dateMatch[1]) * 1000;
    // The legacy window is a Turkish calendar day beginning at 00:00 UTC+03:00.
    const date = new Date(startMs + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
    endpoint = `/fixtures?date=${date}&timezone=Europe/Istanbul`;
  } else if (statsMatch || statsLegacyMatch) {
    const id = (statsMatch || statsLegacyMatch)[1];
    endpoint = `/fixtures/statistics?fixture=${id}`;
    responseKind = "statistics";
  } else if (oddsMatch) {
    const id = oddsMatch[1];
    endpoint = `/odds?fixture=${id}&bookmaker=8`;
    responseKind = "odds";
  } else if (fixtureMatch || fixtureQueryMatch) {
    const id = (fixtureMatch || fixtureQueryMatch)[1];
    endpoint = `/fixtures?id=${id}`;
  } else if (pathname.startsWith("/odds/live?")) {
    endpoint = pathname;
    responseKind = "odds";
  }

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { "x-apisports-key": API_KEY, Accept: "application/json" },
    signal: AbortSignal.timeout(7000)
  });
  const text = await response.text();
  let payload;
  try { payload = text ? JSON.parse(text) : {}; }
  catch { throw new Error(`API-Football geçerli JSON döndürmedi (HTTP ${response.status}).`); }
  if (!response.ok || (payload.errors && Object.keys(payload.errors).length)) {
    const detail = payload.errors && Object.keys(payload.errors).length ? JSON.stringify(payload.errors) : `HTTP ${response.status}`;
    throw new Error(`API-Football isteği başarısız (${response.status}): ${detail}`);
  }

  const rows = Array.isArray(payload.response) ? payload.response : [];
  if (responseKind === "statistics") {
    const first = rows;
    const fixtureResponse = first.length ? first : [];
    const homeId = null;
    const awayId = null;
    const stats = {};
    const aliases = { "Total Shots": "total_shots", "Shots on Goal": "shots_on_target", "Shots off Goal": "shots_off_target", "Corner Kicks": "corners", "Ball Possession": "possession", "Dangerous Attacks": "dangerous_attacks" };
    for (const teamRow of fixtureResponse) {
      const side = teamRow?.team?.name || "";
      for (const stat of teamRow?.statistics || []) {
        const key = aliases[stat.type]; if (!key) continue;
        if (!stats[key]) stats[key] = {};
        let val = stat.value;
        if (typeof val === "string" && val.endsWith("%")) val = Number(val.slice(0, -1));
        stats[key][side] = val;
        if (stat.type === "Total Shots") stats.total_shots = { ...(stats.total_shots || {}), [side]: val };
      }
    }
    // Existing normalizer expects home/away values; preserve team-name keyed values as fallback.
    const normalizedStats = {};
    for (const [key, vals] of Object.entries(stats)) {
      const names = Object.keys(vals);
      normalizedStats[key] = { home: vals[names[0]] ?? null, away: vals[names[1]] ?? null, ...vals };
    }
    return { data: { statistics: normalizedStats, teams: rows } };
  }
  if (responseKind === "odds") {
    const bookmakerRows = [];
    for (const row of rows) {
      // Prematch /odds responses use bookmakers[].bets[].values[].
      for (const bookmaker of row?.bookmakers || []) {
        const odds = {};
        for (const bet of bookmaker?.bets || []) {
          const quote = {};
          for (const value of bet?.values || []) {
            const key = String(value.value ?? value.name ?? "Seçim");
            quote[key] = value.odd;
          }
          odds[bet.name || `Market ${bet.id ?? "?"}`] = { closing: quote, inplay: quote };
        }
        bookmakerRows.push({ name: bookmaker.name || "Bilinmeyen sağlayıcı", odds });
      }
      // Live /odds/live responses instead use odds[].values[] and may not include a bookmaker.
      // Normalize that documented shape too, so live markets are not silently discarded.
      if (Array.isArray(row?.odds) && row.odds.length) {
        const odds = {};
        for (const bet of row.odds) {
          const quote = {};
          for (const value of bet?.values || []) {
            const key = String(value.value ?? value.name ?? "Seçim");
            quote[key] = value.odd;
          }
          odds[bet.name || `Market ${bet.id ?? "?"}`] = { closing: quote, inplay: quote };
        }
        if (Object.keys(odds).length) bookmakerRows.push({ name: "API-Football canlı oranları", odds });
      }
    }
    return { data: { bookmakers: bookmakerRows }, results: bookmakerRows.length };
  }
  const legacyRows = rows.map(apiFootballFixtureToLegacy);
  const paging = payload.paging || {};
  return {
    data: legacyRows,
    pagination: { page: paging.current || 1, per_page: 100, count: legacyRows.length, has_more: (paging.current || 1) < (paging.total || 1) },
    results: legacyRows.length,
    errors: payload.errors || {}
  };
}

function toLegacyFixture(match) {
  return {
    fixture: { id: Number(match.id), date: match.kickoff_utc || null,
      status: { short: mapProviderStatus(match.status_code ?? match.status), elapsed: providerMinute(match) } },
    league: { name: match.league?.name || "Bilinmeyen lig", country: match.country?.name || match.league?.country || "" },
    teams: { home: { id: match.teams?.home?.id ?? null, name: match.teams?.home?.name || "Ev sahibi" },
      away: { id: match.teams?.away?.id ?? null, name: match.teams?.away?.name || "Deplasman" } },
    goals: { home: match.goals?.home ?? null, away: match.goals?.away ?? null },
    corners: match.corners || null,
    raw: match
  };
}

function normalizeProviderStats(payload, fixture) {
  const root = payload?.data || payload;
  // Prefer the provider's original team rows. They preserve the exact team/statistic mapping
  // returned by API-Football and avoid inventing home/away values when the response is empty.
  if (Array.isArray(root?.teams)) {
    const rows = root.teams.map(teamRow => ({
      team: teamRow?.team?.name || "Bilinmiyor",
      statistics: Object.fromEntries((teamRow?.statistics || []).map(stat => {
        let value = stat?.value ?? null;
        if (typeof value === "string" && value.endsWith("%")) value = Number(value.slice(0, -1));
        return [stat?.type || "Bilinmeyen istatistik", value];
      }))
    }));
    const hasRealValue = rows.some(row => Object.values(row.statistics).some(value => value !== null && value !== undefined));
    return hasRealValue ? rows : [];
  }
  const stats = root?.statistics || root?.stats || {};
  const homeName = fixture?.teams?.home?.name || "Ev sahibi";
  const awayName = fixture?.teams?.away?.name || "Deplasman";
  const pick = (key, side) => stats?.[key]?.[side] ?? stats?.[key === "shots_on_target" ? "shotsOnTarget" : key]?.[side] ?? null;
  const homeCorners = fixture?.corners?.home ?? stats?.corners?.home ?? null;
  const awayCorners = fixture?.corners?.away ?? stats?.corners?.away ?? null;
  const homeShotsOn = pick("shots_on_target", "home");
  const awayShotsOn = pick("shots_on_target", "away");
  const homeShotsOff = pick("shots_off_target", "home");
  const awayShotsOff = pick("shots_off_target", "away");
  const homeStats = { "Total Shots": homeShotsOn != null && homeShotsOff != null ? Number(homeShotsOn) + Number(homeShotsOff) : null,
    "Shots on Goal": homeShotsOn, "Corner Kicks": homeCorners,
    "Dangerous Attacks": stats?.dangerous_attacks?.home ?? null,
    "Shots off Goal": homeShotsOff, "Ball Possession": stats?.possession?.home ?? null };
  const awayStats = { "Total Shots": awayShotsOn != null && awayShotsOff != null ? Number(awayShotsOn) + Number(awayShotsOff) : null,
    "Shots on Goal": awayShotsOn, "Corner Kicks": awayCorners,
    "Dangerous Attacks": stats?.dangerous_attacks?.away ?? null,
    "Shots off Goal": awayShotsOff, "Ball Possession": stats?.possession?.away ?? null };
  return [ { team: homeName, statistics: homeStats }, { team: awayName, statistics: awayStats } ];
}

// Keep the legacy internal shape so existing WinScope routes and frontend remain compatible.
async function apiGet(pathname) {
  if (pathname.startsWith("/odds")) return [];
  if (pathname.startsWith("/fixtures/statistics")) {
    const id = new URLSearchParams(pathname.split("?")[1] || "").get("fixture");
    if (!id) return [];
    const fixturePayload = await cachedProviderRequest(`fixture:${id}`, `/fixtures/${encodeURIComponent(id)}`, PROVIDER_CACHE_MS.fixture);
    const fixtureValue = Array.isArray(fixturePayload?.data) ? fixturePayload.data[0] : (fixturePayload?.data || fixturePayload);
    const fixture = fixtureValue?.fixture ? fixtureValue : toLegacyFixture(fixtureValue || {});
    const statPayload = await cachedProviderRequest(`stats:${id}`, `/fixtures/${encodeURIComponent(id)}/statistics`, PROVIDER_CACHE_MS.stats);
    return normalizeProviderStats(statPayload, fixture);
  }
  if (pathname.startsWith("/fixtures?live=all")) {
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", PROVIDER_CACHE_MS.liveList);
    return (payload.data || []).map(toLegacyFixture);
  }
  const idMatch = pathname.match(/^\/fixtures\?id=(\d+)/);
  if (idMatch) {
    const payload = await cachedProviderRequest(`fixture:${idMatch[1]}`, `/fixtures/${idMatch[1]}`, PROVIDER_CACHE_MS.fixture);
    const candidates = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : payload?.data ? [payload.data] : [payload]);
    const match = candidates.find(item => Number(item?.id ?? item?.fixture?.id) === Number(idMatch[1]));
    return match ? [toLegacyFixture(match)] : [];
  }
  throw new Error("Bu veri kaynağında istenen uç nokta desteklenmiyor.");
}

function normalizeOdds(rows) {
  const normalized = [];
  for (const fixture of rows || []) {
    for (const bookmaker of fixture.bookmakers || []) {
      for (const bet of bookmaker.bets || []) {
        for (const value of bet.values || []) {
          const odd = toNumber(value.odd);
          if (odd == null || odd <= 1) continue;
          normalized.push({
            bookmaker: bookmaker.name || "Bilinmeyen sağlayıcı",
            market: bet.name || `Market ${bet.id ?? "?"}`,
            selection: String(value.value ?? value.name ?? "Seçim"),
            odd,
            suspended: Boolean(value.suspended),
            betId: bet.id ?? null
          });
        }
      }
    }
  }
  return normalized;
}

async function getOdds(fixtureId, mode) {
  const key = `${mode}:${fixtureId}`;
  const now = Date.now();
  const cached = oddsCache.get(key);
  if (cached && now - cached.at < CACHE_MS[mode]) return { ...cached.data, cached: true };
  if (oddsInFlight.has(key)) return oddsInFlight.get(key);

  const task = (async () => {
    // Free keys can request Bet365 odds per fixture. Do not request the paid-only
    // include=odds fixture-list expansion.
    const oddsPath = mode === "live" ? `/odds/live?fixture=${encodeURIComponent(String(fixtureId))}` : `/fixtures/${encodeURIComponent(String(fixtureId))}/odds?bookmakers=bet365`;
    const payload = await cachedProviderRequest(`odds:${mode}:${fixtureId}`, oddsPath, CACHE_MS[mode]);
    const dataBlock = payload.data || {};
    const bookmakers = Array.isArray(dataBlock.bookmakers) ? dataBlock.bookmakers
      : Array.isArray(dataBlock) ? dataBlock.flatMap(item => Array.isArray(item.bookmakers) ? item.bookmakers : [])
      : [];
    const markets = [];
    const stage = mode === "live" ? "inplay" : "closing";

    function addValues(bookmaker, marketName, quote, stageName) {
      if (!quote || typeof quote !== "object" || Array.isArray(quote)) return;
      const line = quote.line;
      for (const [selection, rawOdd] of Object.entries(quote)) {
        if (selection === "line") continue;
        const odd = toNumber(rawOdd);
        if (odd == null || odd <= 1) continue;
        markets.push({
          bookmaker: bookmaker.name || "Bet365",
          market: `${marketName}${line != null ? ` (${line})` : ""} · ${stageName}`,
          selection: selection === "yes" ? "KG Var" : selection === "no" ? "KG Yok" : selection,
          odd, suspended: false, betId: marketName, stage: stageName, line: line ?? null
        });
      }
    }

    for (const bookmaker of bookmakers) {
      const odds = bookmaker.odds && typeof bookmaker.odds === "object" ? bookmaker.odds : {};
      for (const [marketName, marketValue] of Object.entries(odds)) {
        if (Array.isArray(marketValue)) {
          for (const item of marketValue) {
            const quote = item?.[stage] || (mode === "prematch" ? item?.opening : null);
            addValues(bookmaker, `${marketName} ${item?.line ?? ""}`.trim(), quote, quote === item?.opening ? "Açılış" : stage === "inplay" ? "Canlı" : "Kapanış");
          }
          continue;
        }
        if (!marketValue || typeof marketValue !== "object") continue;
        let quote = marketValue[stage];
        let stageName = stage === "inplay" ? "Canlı" : "Kapanış";
        if (!quote && mode === "prematch") {
          quote = marketValue.closing || marketValue.opening;
          stageName = marketValue.closing ? "Kapanış" : "Açılış";
        }
        // Some simple line markets are represented as a number at each stage.
        if (typeof quote === "number") {
          markets.push({ bookmaker: bookmaker.name || "Bet365", market: marketName, selection: "Çizgi", odd: quote, suspended: false, betId: marketName, stage: stageName });
        } else addValues(bookmaker, marketName, quote, stageName);
      }
    }

    const fetchedAt = new Date().toISOString();
    const data = {
      fixtureId: Number(fixtureId), mode, source: "API-Football · Bet365", fetchedAt,
      available: markets.length > 0, markets,
      note: markets.length ? "Oranlar Bet365 verisinden alındı; çizgi ve fiyatlar mevcut veri kapsamına bağlıdır." : "Bu maç/market için seçilen aşamada oran bulunamadı."
    };

    if (pool && markets.length) {
      try {
        await initDatabase();

        // Store all markets in one database query. A fixture may return hundreds
        // of markets; sequential INSERTs were making coupon generation very slow.
        const snapshotRows = markets.map(market => ({
          bookmaker: market.bookmaker,
          market_name: market.market,
          selection: market.selection,
          odd: market.odd,
          raw: market
        }));
        await pool.query(
          `INSERT INTO odds_snapshots
            (fixture_id, mode, bookmaker, market_name, selection, odd, raw)
           SELECT $1, $2, x.bookmaker, x.market_name, x.selection, x.odd, x.raw
           FROM jsonb_to_recordset($3::jsonb) AS x(
             bookmaker text, market_name text, selection text, odd numeric, raw jsonb
           )`,
          [fixtureId, mode, JSON.stringify(snapshotRows)]
        );

        // Retrieve prior observations together rather than issuing one query
        // per market. The current capture is excluded by captured_at < fetchedAt.
        const previous = await pool.query(
          `SELECT x.bookmaker, x.market_name, x.selection, prev.odd, prev.captured_at
           FROM jsonb_to_recordset($1::jsonb) AS x(
             bookmaker text, market_name text, selection text
           )
           LEFT JOIN LATERAL (
             SELECT s.odd, s.captured_at
             FROM odds_snapshots s
             WHERE s.fixture_id = $2 AND s.mode = $3
               AND s.bookmaker = x.bookmaker
               AND s.market_name = x.market_name
               AND s.selection = x.selection
               AND s.captured_at < $4::timestamptz
             ORDER BY s.captured_at DESC
             LIMIT 1
           ) prev ON TRUE`,
          [JSON.stringify(snapshotRows.map(({ bookmaker, market_name, selection }) => ({ bookmaker, market_name, selection }))),
           fixtureId, mode, fetchedAt]
        );
        const previousByKey = new Map();
        for (const row of previous.rows) {
          if (row.odd != null) {
            previousByKey.set(`${row.bookmaker}\u0000${row.market_name}\u0000${row.selection}`, row);
          }
        }
        for (const market of markets) {
          const previousRow = previousByKey.get(`${market.bookmaker}\u0000${market.market}\u0000${market.selection}`);
          if (previousRow) {
            market.previousOdd = Number(previousRow.odd);
            market.change = Number((market.odd - market.previousOdd).toFixed(3));
            market.direction = market.change < 0 ? "DÜŞTÜ" : market.change > 0 ? "YÜKSELDİ" : "SABİT";
            market.previousCapturedAt = previousRow.captured_at;
          } else {
            market.previousOdd = null;
            market.change = null;
            market.direction = "İLK KAYIT";
          }
        }
      } catch (error) {
        console.error("Odds snapshot save error:", error.message);
        data.saveWarning = "Oran geldi ancak geçmiş kaydı yapılamadı.";
      }
    }
    oddsCache.set(key, { at: now, data });
    return data;
  })();
  oddsInFlight.set(key, task);
  try { return await task; } finally { oddsInFlight.delete(key); }
}

async function captureOneMatch(fixtureId) {
  const rows = await apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(String(fixtureId))}`);
  if (!rows.length) return { saved: false, reason: "no_statistics" };
  const teams = rows.map(row => ({ team: typeof row.team === "string" ? row.team : (row.team?.name || "Bilinmiyor"), statistics: Array.isArray(row.statistics) ? Object.fromEntries(row.statistics.map(stat => [stat.type, stat.value])) : (row.statistics && typeof row.statistics === "object" ? row.statistics : {}) }));
  await pool.query("INSERT INTO match_stat_snapshots (fixture_id, teams) VALUES ($1, $2::jsonb)", [fixtureId, JSON.stringify(teams)]);
  return { saved: true, teams };
}

async function captureTrackedMatches() {
  if (!pool || autoCaptureRunning) return;
  autoCaptureRunning = true;
  try {
    await initDatabase();
    const result = await pool.query("SELECT fixture_id, home_team, away_team FROM tracked_matches ORDER BY enabled_at ASC LIMIT 2");
    for (const match of result.rows) {
      try {
        const saved = await captureOneMatch(match.fixture_id);
        if (saved.saved) console.log(`Otomatik istatistik kaydı: ${match.home_team} - ${match.away_team}`);
      } catch (error) { console.error(`Otomatik kayıt hatası (${match.fixture_id}):`, error.message); }
    }
  } catch (error) { console.error("Otomatik kayıt döngüsü hatası:", error.message); }
  finally { autoCaptureRunning = false; }
}

// Telegram alarm system: only two tracked matches are scanned to protect free API quota.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
let alarmScanRunning = false;

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error("TELEGRAM_BOT_TOKEN veya TELEGRAM_CHAT_ID ayarlanmamış.");
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(7000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) throw new Error(payload.description || `Telegram HTTP ${response.status}`);
  return payload.result;
}

function statNumber(team, names) {
  const stats = team?.statistics || {};
  for (const name of names) {
    const raw = stats[name];
    if (raw == null || raw === "-") continue;
    const n = Number(String(raw).replace("%", "").trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function assessGoalPressure(teams) {
  if (!Array.isArray(teams) || teams.length < 2) return { ok: false, reason: "İstatistikler eksik." };
  const home = teams[0], away = teams[1];
  const homeShots = statNumber(home, ["Total Shots"]);
  const awayShots = statNumber(away, ["Total Shots"]);
  const homeOnTarget = statNumber(home, ["Shots on Goal"]);
  const awayOnTarget = statNumber(away, ["Shots on Goal"]);
  const homeCorners = statNumber(home, ["Corner Kicks"]);
  const awayCorners = statNumber(away, ["Corner Kicks"]);
  if ([homeShots, awayShots, homeOnTarget, awayOnTarget, homeCorners, awayCorners].some(v => v == null)) {
    return { ok: false, reason: "Gerekli şut/kaleyi bulan şut/korner verisi eksik." };
  }
  const totalShots = homeShots + awayShots;
  const totalOnTarget = homeOnTarget + awayOnTarget;
  const totalCorners = homeCorners + awayCorners;
  // Conservative signal: enough overall activity plus at least one direct threat indicator.
  const ok = totalShots >= 8 && (totalOnTarget >= 3 || totalCorners >= 4);
  return { ok, totalShots, totalOnTarget, totalCorners,
    reason: ok ? "Şut ve tehlike göstergeleri yeterli." : "İstatistik baskısı eşik altında." };
}

async function evaluateMatchAlarms(match, fixture, teams) {
  const minute = Number(fixture.fixture?.status?.elapsed);
  const homeScore = Number(fixture.goals?.home);
  const awayScore = Number(fixture.goals?.away);
  if (!Number.isFinite(minute) || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)) return;
  const totalGoals = homeScore + awayScore;
  const pressure = assessGoalPressure(teams);
  if (!pressure.ok) return; // Missing or conflicting signal: silently skip.

  const candidates = [];
  if (minute >= 20 && minute <= 22 && ((homeScore === 1 && awayScore === 0) || (homeScore === 0 && awayScore === 1))) {
    candidates.push({ key: "ht_over15_20", title: "İLK YARI 1.5 ÜST ADAYI", rationale: "20. dakika civarında tek gol var; istatistik baskısı devam golü sinyali veriyor." });
  }
  if (minute >= 65 && minute <= 67 && ((homeScore === 1 && awayScore === 0) || (homeScore === 0 && awayScore === 1))) {
    candidates.push({ key: "ft_over15_65", title: "MAÇ SONU 1.5 ÜST ADAYI", rationale: "65. dakika civarında tek gol var; istatistik baskısı bir gol daha ihtimalini destekliyor." });
  }
  if (minute >= 70 && minute <= 72 && ((homeScore === 1 && awayScore === 1) || (homeScore === 2 && awayScore === 0) || (homeScore === 0 && awayScore === 2))) {
    candidates.push({ key: "ft_over25_70", title: "MAÇ SONU 2.5 ÜST ADAYI", rationale: "70. dakika civarında toplam iki gol var; istatistik baskısı üçüncü gol ihtimalini destekliyor." });
  }

  for (const alarm of candidates) {
    const client = await pool.connect();
    let claimed = false;
    try {
      await client.query("BEGIN");
      const claim = await client.query(`INSERT INTO sent_match_alarms (fixture_id, alarm_key) VALUES ($1,$2) ON CONFLICT (fixture_id, alarm_key) DO NOTHING RETURNING id`, [match.fixture_id, alarm.key]);
      claimed = claim.rowCount > 0;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("Alarm deduplication error:", error.message);
    } finally { client.release(); }
    if (!claimed) continue;

    const text = `⚽ WinScope ALARM\n${fixture.teams?.home?.name || match.home_team} - ${fixture.teams?.away?.name || match.away_team}\nDakika: ${minute}' | Skor: ${homeScore}-${awayScore}\nAlarm: ${alarm.title}\nSinyal: ${alarm.rationale}\nİstatistik: Şut ${pressure.totalShots}, kaleyi bulan ${pressure.totalOnTarget}, korner ${pressure.totalCorners}\nNot: Bu bir istatistik alarmıdır, bahis garantisi değildir.`;
    try {
      await sendTelegramMessage(text);
      console.log(`Telegram alarmı gönderildi: ${match.fixture_id} / ${alarm.key}`);
    } catch (error) {
      // Allow retry on next scan if Telegram delivery failed.
      await pool.query("DELETE FROM sent_match_alarms WHERE fixture_id=$1 AND alarm_key=$2", [match.fixture_id, alarm.key]).catch(() => {});
      console.error("Telegram alarm gönderilemedi:", error.message);
    }
  }
}

async function scanTrackedMatchAlarms() {
  if (!pool || alarmScanRunning || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  alarmScanRunning = true;
  try {
    await initDatabase();
    const tracked = await pool.query("SELECT fixture_id, home_team, away_team FROM tracked_matches ORDER BY enabled_at ASC LIMIT 2");
    for (const match of tracked.rows) {
      try {
        const fixtures = await apiGet(`/fixtures?id=${encodeURIComponent(String(match.fixture_id))}`);
        if (!fixtures.length) continue;
        const fixture = fixtures[0];
        const minute = Number(fixture.fixture?.status?.elapsed);
        if (!Number.isFinite(minute) || minute < 20 || minute > 72) continue;
        const statRows = await apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(String(match.fixture_id))}`);
        const teams = statRows.map(row => ({ team: typeof row.team === "string" ? row.team : (row.team?.name || "Bilinmiyor"), statistics: Array.isArray(row.statistics) ? Object.fromEntries(row.statistics.map(stat => [stat.type, stat.value])) : (row.statistics && typeof row.statistics === "object" ? row.statistics : {}) }));
        await evaluateMatchAlarms(match, fixture, teams);
      } catch (error) { console.error(`Alarm tarama hatası (${match.fixture_id}):`, error.message); }
    }
  } catch (error) { console.error("Alarm tarama döngüsü hatası:", error.message); }
  finally { alarmScanRunning = false; }
}

app.get("/api/telegram-test", async (_req, res) => {
  try {
    await sendTelegramMessage("✅ WinScope Telegram bağlantı testi başarılı.");
    res.json({ success: true, message: "Test mesajı Telegram'a gönderildi." });
  } catch (error) {
    console.error("Telegram test error:", error.message);
    res.status(503).json({ success: false, error: error.message });
  }
});

app.get("/api/health", (_req, res) => res.json({
  ok: true, service: "WinScope Live", databaseConfigured: Boolean(pool), apiKeyConfigured: Boolean(API_KEY),
  dataSource: "API-Football", flashscoreDirectFeed: false,
  note: "Flashscore için doğrulanmış, kararlı bir herkese açık oran API'si bu dosyada yapılandırılmadı. Sağlayıcıdan gelmeyen oran/istatistikler uydurulmaz."
}));

app.get("/api/fixtures", async (req, res) => {
  const date = String(req.query.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Geçerli bir tarih gerekli: YYYY-MM-DD." });
  try {
    // WinScope dates are Turkish calendar dates (UTC+03:00), not UTC dates.
    // The provider accepts a maximum 24-hour UTC window with an exclusive end.
    const payload = await cachedProviderRequest(
      `fixtures:${date}`,
      `/fixtures?start_time=${Math.floor(new Date(`${date}T00:00:00+03:00`).getTime() / 1000)}&end_time=${Math.floor(new Date(`${date}T00:00:00+03:00`).getTime() / 1000) + 86400}`,
      5 * 60_000
    );
    const allRows = Array.isArray(payload.data) ? payload.data : [];
    const matches = allRows.map(normalizeProviderMatch)
      .sort((a, b) => new Date(a.fixtureDate || 0) - new Date(b.fixtureDate || 0));
    const providerPagination = payload.pagination || null;
    const hasMore = false;
    res.json({
      source: "API-Football",
      fetchedAt: new Date().toISOString(),
      requestedDate: date,
      timezone: "Europe/Istanbul (UTC+03:00)",
      results: matches.length,
      // Compatibility aliases for frontend versions that read fixtures/data instead of matches.
      fixtures: matches,
      data: matches,
      pagesFetched: 1,
      providerPagination,
      hasMore,
      matches,
      note: "Türkiye takvim gününe göre tek API-Football tarih sorgusu yapıldı; bu uç nokta için desteklenmeyen page/per_page parametreleri gönderilmez. Maç kapsamı sağlayıcı/abonelik verisine bağlıdır."
    });
  } catch (error) {
    console.error("Fixture API error:", error.message);
    res.status(502).json({ error: "Maç bülteni alınamadı.", detail: error.message });
  }
});

app.get("/api/live", async (_req, res) => {
  try {
    // API-Football uses status=live; do not call the old API-Football helper here.
    const payload = await cachedProviderRequest("liveList", "/fixtures?live=all", PROVIDER_CACHE_MS.liveList);
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const matches = rows.map(normalizeProviderMatch);
    console.log(`[CANLI] API kayıt=${rows.length} has_more=${Boolean(payload.pagination?.has_more)}`);
    res.json({
      source: "API-Football",
      fetchedAt: new Date().toISOString(),
      results: matches.length,
      fixtures: matches,
      data: matches,
      providerReturned: rows.length,
      providerPagination: payload.pagination || null,
      matches,
      note: "Canlı maçlar API-Football /fixtures?live=all üzerinden alındı; desteklenmeyen page/per_page parametreleri gönderilmez. Sonuç sayısı sağlayıcı/abonelik kapsamına ve o an gerçekten canlı olan maçlara bağlıdır."
    });
  } catch (error) {
    console.error("Live API error:", error.stack || error.message || error);
    res.status(502).json({ error: "Canlı maçlar alınamadı.", detail: error.message || String(error) });
  }
});

app.get("/api/match/:id/odds", async (req, res) => {
  const fixtureId = req.params.id;
  const mode = req.query.mode === "live" ? "live" : req.query.mode === "prematch" || !req.query.mode ? "prematch" : null;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  if (!mode) return res.status(400).json({ error: "mode=live veya mode=prematch kullan." });
  try { res.json(await getOdds(fixtureId, mode)); }
  catch (error) {
    console.error(`Odds API error (${mode}, ${fixtureId}):`, error.message);
    const status = error.message.includes("ayarlanmamış") ? 503 : 502;
    res.status(status).json({ error: mode === "live" ? "Canlı oranlar alınamadı." : "Maç önü oranları alınamadı.", detail: error.message, fixtureId: Number(fixtureId), mode });
  }
});

app.get("/api/match/:id/odds-history", async (req, res) => {
  const fixtureId = req.params.id;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  const mode = req.query.mode === "live" ? "live" : "prematch";
  try {
    await initDatabase();
    const result = await pool.query(`SELECT bookmaker, market_name AS market, selection, odd, captured_at
      FROM odds_snapshots WHERE fixture_id=$1 AND mode=$2 AND captured_at >= NOW() - INTERVAL '7 days'
      ORDER BY captured_at DESC LIMIT 500`, [fixtureId, mode]);
    res.json({ fixtureId: Number(fixtureId), mode, count: result.rows.length, history: result.rows, note: "Hareket yalnızca WinScope'un kaydettiği gözlemler arasında hesaplanır." });
  } catch (error) { console.error("Odds history error:", error.message); res.status(503).json({ error: "Oran geçmişi alınamadı." }); }
});

app.get("/api/match/:id/stats", async (req, res) => {
  const fixtureId = req.params.id;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  try {
    const rows = await apiGet(`/fixtures/statistics?fixture=${fixtureId}`);
    const teams = rows.map(row => ({ team: typeof row.team === "string" ? row.team : (row.team?.name || "Bilinmiyor"), statistics: Array.isArray(row.statistics) ? Object.fromEntries(row.statistics.map(stat => [stat.type, stat.value])) : (row.statistics && typeof row.statistics === "object" ? row.statistics : {}) }));
    const hasUsableStats = teams.some(team => Object.values(team.statistics || {}).some(value => value !== null && value !== undefined));
    let saved = false;
    if (pool && hasUsableStats) {
      try { await initDatabase(); await pool.query("INSERT INTO match_stat_snapshots (fixture_id, teams) VALUES ($1, $2::jsonb)", [fixtureId, JSON.stringify(teams)]); saved = true; }
      catch (error) { console.error("Snapshot save error:", error.message); }
    }
    res.json({ source: "API-Football", fixtureId: Number(fixtureId), available: hasUsableStats, saved, teams: hasUsableStats ? teams : [], note: hasUsableStats ? "Sağlayıcıdan istatistik alındı." : "API-Football bu maç için kullanılabilir istatistik döndürmedi. Lig kapsamı veya maçın veri durumu buna neden olabilir; null değerler sıfır sayılmaz." });
  } catch (error) { console.error("Stats API error:", error.message); res.status(502).json({ error: "Maç istatistikleri alınamadı.", detail: error.message }); }
});

app.get("/api/match/:id/history", async (req, res) => {
  const fixtureId = req.params.id;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  try {
    await initDatabase();
    const result = await pool.query("SELECT captured_at, teams FROM match_stat_snapshots WHERE fixture_id=$1 AND captured_at >= NOW() - INTERVAL '10 minutes' ORDER BY captured_at ASC", [fixtureId]);
    res.json({ fixtureId: Number(fixtureId), periodMinutes: 10, snapshots: result.rows.length, enoughData: result.rows.length >= 2, history: result.rows });
  } catch (error) { console.error("History query error:", error.message); res.status(503).json({ error: "İstatistik geçmişi alınamıyor." }); }
});

app.get("/api/tracked", async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  try {
    await initDatabase();
    const result = await pool.query("SELECT fixture_id, home_team, away_team, enabled_at FROM tracked_matches ORDER BY enabled_at DESC");
    res.json({ matches: result.rows.map(row => ({ id: String(row.fixture_id), home: row.home_team, away: row.away_team, enabledAt: row.enabled_at })) });
  } catch (error) { console.error("Tracked matches error:", error.message); res.status(503).json({ error: "Takip listesi alınamadı." }); }
});

app.post("/api/match/:id/track", async (req, res) => {
  const fixtureId = req.params.id, home = req.body?.home, away = req.body?.away;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  if (typeof home !== "string" || !home.trim() || typeof away !== "string" || !away.trim()) return res.status(400).json({ error: "Ev sahibi ve deplasman takım adları gerekli." });
  let client;
  try {
    await initDatabase(); client = await pool.connect(); await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock($1)", [735219]);
    const existing = await client.query("SELECT fixture_id FROM tracked_matches WHERE fixture_id=$1", [fixtureId]);
    if (existing.rowCount) { await client.query("COMMIT"); return res.json({ success: true, tracked: true, message: "Bu maç zaten takipte." }); }
    const count = await client.query("SELECT COUNT(*)::int AS total FROM tracked_matches");
    if (count.rows[0].total >= 2) { await client.query("ROLLBACK"); return res.status(409).json({ error: "En fazla 2 maç takip edilebilir. Önce bir maçın takibini bırak." }); }
    await client.query("INSERT INTO tracked_matches (fixture_id, home_team, away_team) VALUES ($1,$2,$3)", [fixtureId, home.trim(), away.trim()]);
    await client.query("COMMIT"); res.json({ success: true, tracked: true, message: "Maç takip listesine eklendi." });
  } catch (error) {
    if (client) try { await client.query("ROLLBACK"); } catch {}
    console.error("Track match error:", error.message); res.status(503).json({ error: "Maç takibe alınamadı." });
  } finally { client?.release(); }
});

app.delete("/api/match/:id/track", async (req, res) => {
  const fixtureId = req.params.id;
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  try { await initDatabase(); await pool.query("DELETE FROM tracked_matches WHERE fixture_id=$1", [fixtureId]); res.json({ success: true, tracked: false, message: "Maç takipten çıkarıldı." }); }
  catch (error) { console.error("Untrack match error:", error.message); res.status(503).json({ error: "Maç takipten çıkarılamadı." }); }
});

app.get("/api/historical/status", async (_req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  try {
    await initDatabase();
    const result = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE over25_result=1)::int AS over25,
      COUNT(*) FILTER (WHERE over25_result=0)::int AS under25, MIN(match_date) AS earliest_date, MAX(match_date) AS latest_date FROM historical_matches`);
    const row = result.rows[0];
    res.json({ ready: row.total > 0, totalMatches: row.total, over25: row.over25, under25: row.under25, earliestDate: row.earliest_date, latestDate: row.latest_date, sourceFile: "winscope_historical_odds.csv" });
  } catch (error) { console.error("Historical status error:", error.message); res.status(503).json({ error: "Geçmiş veri durumu alınamadı." }); }
});

app.get("/api/historical/summary", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  const league = typeof req.query.league === "string" ? req.query.league.trim().slice(0, 12) : "";
  try {
    await initDatabase();
    const result = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE over25_result=1)::int AS over25,
      COUNT(*) FILTER (WHERE over25_result=0)::int AS under25,
      ROUND(100.0*COUNT(*) FILTER (WHERE over25_result=1)/NULLIF(COUNT(*) FILTER (WHERE over25_result IN (0,1)),0),2) AS over25_percent,
      ROUND(AVG(b365_over25)::numeric,3) AS avg_open_over25_odds, ROUND(AVG(b365_under25)::numeric,3) AS avg_open_under25_odds,
      ROUND(AVG(b365_close_over25)::numeric,3) AS avg_close_over25_odds, ROUND(AVG(b365_close_under25)::numeric,3) AS avg_close_under25_odds
      FROM historical_matches WHERE ($1='' OR league_code=$1)`, [league]);
    res.json({ source: "Imported historical dataset", league: league || null, note: "Geçmiş örneklem oranlarıdır; canlı maç olasılığı veya garanti değildir.", summary: result.rows[0] });
  } catch (error) { console.error("Historical summary error:", error.message); res.status(503).json({ error: "Geçmiş oran özeti alınamadı." }); }
});

app.get("/api/historical/matches", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  const league = typeof req.query.league === "string" ? req.query.league.trim().slice(0, 12) : "";
  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 100)) : 20;
  try {
    await initDatabase();
    const result = await pool.query(`SELECT league_code AS league, match_date AS date, home_team AS home, away_team AS away,
      ht_home_goals, ht_away_goals, ft_home_goals, ft_away_goals, full_time_result, b365_home, b365_draw, b365_away,
      b365_over25, b365_under25, b365_close_over25, b365_close_under25, total_goals, over25_result
      FROM historical_matches WHERE ($1='' OR league_code=$1) ORDER BY match_date DESC NULLS LAST,id DESC LIMIT $2`, [league, limit]);
    res.json({ count: result.rows.length, league: league || null, matches: result.rows });
  } catch (error) { console.error("Historical matches error:", error.message); res.status(503).json({ error: "Geçmiş maçlar alınamadı." }); }
});

// WinScope match-analysis endpoint: evidence-based, conservative, no invented scorelines.
app.get("/api/match/:id/analyze", async (req, res) => {
  const requestStartedAt = Date.now();
  res.on("finish", () => console.log(`[ANALYZE] fixture=${req.params.id} status=${res.statusCode} duration=${Date.now()-requestStartedAt}ms`));
  const fixtureId = req.params.id;
  const mode = req.query.mode === "live" ? "live" : "prematch";
  if (!/^\d+$/.test(fixtureId)) return res.status(400).json({ error: "Geçersiz fikstür ID." });
  try {
    const fixtures = await apiGet(`/fixtures?id=${encodeURIComponent(fixtureId)}`);
    if (!fixtures.length) return res.status(404).json({ error: "Maç sağlayıcıda bulunamadı; analiz üretilmedi." });
    const fixture = fixtures[0];
    const home = fixture.teams?.home?.name || "Ev sahibi";
    const away = fixture.teams?.away?.name || "Deplasman";
    // Fetch statistics and odds concurrently after the fixture is known.
    // This avoids waiting for the stats request to finish before starting odds.
    const [statsResult, oddsResult] = await Promise.allSettled([
      apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(fixtureId)}`),
      getOdds(fixtureId, mode)
    ]);
    let statRows = [], statsWarning = null;
    if (statsResult.status === "fulfilled") statRows = statsResult.value || [];
    else statsWarning = statsResult.reason?.message || "İstatistik isteği başarısız.";
    const teams = statRows.map(row => ({
      team: typeof row.team === "string" ? row.team : (row.team?.name || "Bilinmiyor"),
      statistics: Array.isArray(row.statistics) ? Object.fromEntries(row.statistics.map(s => [s.type, s.value])) : (row.statistics || {})
    }));
    let oddsData = { markets: [], note: "Oran verisi alınamadı." };
    if (oddsResult.status === "fulfilled") oddsData = oddsResult.value;
    else oddsData.note = oddsResult.reason?.message || "Oran isteği başarısız.";
    const markets = Array.isArray(oddsData.markets) ? oddsData.markets : [];
    const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[._-]+/g, " ");
    // Provider market labels vary: the goal line may be in the market name OR selection.
    // Match the combined text so Home/Away team totals and first-half lines are not missed.
    const find = (marketRe, selectionRe) => markets.find(m =>
      marketRe.test(norm(`${m.market || ""} ${m.selection || ""}`)) &&
      selectionRe.test(norm(m.selection)) && Number(m.odd) > 1
    );
    // Match the requested goal line explicitly; "Total Goals" alone is too broad and
    // could incorrectly select Over/Under 1.5 or 3.5 as the 2.5 market.
    const line25 = m => /(?:^|\D)2[.,]5(?:\D|$)/.test(norm(`${m.market || ""} ${m.selection || ""}`));
    const over25 = markets.find(m => line25(m) && /over|ust/.test(norm(m.selection)) && Number(m.odd) > 1);
    const under25 = markets.find(m => line25(m) && /under|alt/.test(norm(m.selection)) && Number(m.odd) > 1);
    const kgYes = find(/both teams|btts|kg/, /yes|var/);
    const kgNo = find(/both teams|btts|kg/, /no|yok/);
    const homeWin = find(/1x2|match result|full time result|winner/, /^home$|^1$|home win|ev sahibi/);
    const draw = find(/1x2|match result|full time result|winner/, /^draw$|^x$|beraberlik|tie/);
    const awayWin = find(/1x2|match result|full time result|winner/, /^away$|^2$|away win|deplasman/);
    const home15 = find(/home.*1\.?\s*5|team.*1\.?\s*5|ev sahibi.*1\.?\s*5/, /over|ust/);
    const away15 = find(/away.*1\.?\s*5|team.*1\.?\s*5|deplasman.*1\.?\s*5/, /over|ust/);
    const htOver05 = find(/half.*over.*0\.?\s*5|1st half.*0\.?\s*5|first half.*0\.?\s*5/, /over|ust/);
    const scoreHome = fixture.goals?.home, scoreAway = fixture.goals?.away;
    const status = String(fixture.fixture?.status?.short || "").toUpperCase();
    const elapsed = fixture.fixture?.status?.elapsed;
    const finishedStatuses = ["FT", "AET", "PEN", "FINISHED", "FULL"];
    const isLive = !finishedStatuses.includes(status) && (["LIVE", "HT", "1H", "2H"].includes(status) || (elapsed != null && Number(elapsed) > 0));
    const reasons = [];
    let history = { available: false, scannedMatches: 0, sampleSize: 0, matchedMarkets: [], resultDistribution: {}, over25Percent: null, under25Percent: null, bttsYesPercent: null, bttsNoPercent: null, home15Percent: null, away15Percent: null, htOver05Percent: null, sixPlusPercent: null, note: "Tarihsel veri henüz hesaplanmadı." };
    let mainPick = "—", alternative = "", halfTimeScore = "Veri desteği yok", fullTimeScore = "Veri desteği yok", alternativeFullTimeScore = "Yeterli veri yok", surprise = "Veri desteği yok", confidence = "Düşük", marketDirection = "Oran hareketi verisi yok";
    if (pool) {
      try {
        await initDatabase();
        const q = await pool.query(`SELECT id, ht_home_goals, ht_away_goals, ft_home_goals, ft_away_goals, full_time_result,
          b365_home,b365_draw,b365_away,b365_over25,b365_under25
          FROM historical_matches WHERE (b365_home IS NOT NULL OR b365_draw IS NOT NULL OR b365_away IS NOT NULL OR b365_over25 IS NOT NULL OR b365_under25 IS NOT NULL)
          AND (ft_home_goals IS NOT NULL AND ft_away_goals IS NOT NULL)
          ORDER BY id DESC LIMIT 5000`);
        const rows = q.rows;
        const dims = [
          {key:"MS 1",now:homeWin?.odd,field:"b365_home"},{key:"MS X",now:draw?.odd,field:"b365_draw"},{key:"MS 2",now:awayWin?.odd,field:"b365_away"},
          {key:"MS 2.5 ÜST",now:over25?.odd,field:"b365_over25"},{key:"MS 2.5 ALT",now:under25?.odd,field:"b365_under25"}
        ].filter(d => Number(d.now)>1);
        const ranked = rows.map(r => { const ds=dims.filter(d=>r[d.field]!=null&&Number(r[d.field])>1).map(d=>Math.abs(Number(d.now)-Number(r[d.field]))/Math.max(.2,Number(d.now)*.12)); return {r,n:ds.length,d:ds.length?ds.reduce((a,b)=>a+b,0)/ds.length:Infinity}; }).filter(x=>x.n>=Math.min(2,dims.length)&&Number.isFinite(x.d)).sort((a,b)=>a.d-b.d);
        let near=ranked.filter(x=>x.d<=2.5).slice(0,100); const expanded=near.length<10; if(expanded) near=ranked.slice(0,100);
        let sample=near.map(x=>x.r);
        let generalHistoricalFallback=false;
        // A live fixture may not have live odds available from the provider. Do not let that
        // erase all historical percentages: use a transparent recent-results sample instead.
        if (!sample.length && dims.length === 0) {
          sample = rows.slice(0,100);
          generalHistoricalFallback = sample.length > 0;
        }
        const valid=sample.filter(r=>r.ft_home_goals!=null&&r.ft_away_goals!=null), n=valid.length;
        const pct=(count,total)=>total?Number((100*count/total).toFixed(1)):null;
        const overN=valid.filter(r=>Number(r.ft_home_goals)+Number(r.ft_away_goals)>=3).length;
        const kgN=valid.filter(r=>Number(r.ft_home_goals)>0&&Number(r.ft_away_goals)>0).length;
        const home15N=valid.filter(r=>Number(r.ft_home_goals)>=2).length, away15N=valid.filter(r=>Number(r.ft_away_goals)>=2).length;
        const sixN=valid.filter(r=>Number(r.ft_home_goals)+Number(r.ft_away_goals)>=6).length;
        const htValid=sample.filter(r=>r.ht_home_goals!=null&&r.ht_away_goals!=null);
        const ht05N=htValid.filter(r=>Number(r.ht_home_goals)+Number(r.ht_away_goals)>=1).length;
        const freq=(arr)=>{const m=new Map();for(const x of arr){if(x)m.set(x,(m.get(x)||0)+1);}return [...m.entries()].sort((a,b)=>b[1]-a[1]);};
        const resKeys=valid.map(r=>Number(r.ft_home_goals)>Number(r.ft_away_goals)?"MS 1":Number(r.ft_home_goals)<Number(r.ft_away_goals)?"MS 2":"MS X");
        const resFreq=freq(resKeys);
        const htFreq=freq(htValid.map(r=>`${r.ht_home_goals}-${r.ht_away_goals}`));
        const ftFreq=freq(valid.map(r=>`${r.ft_home_goals}-${r.ft_away_goals}`));
        const htftRows=sample.filter(r=>[r.ht_home_goals,r.ht_away_goals,r.ft_home_goals,r.ft_away_goals].every(v=>v!=null));
        const htftFreq=freq(htftRows.map(r=>`${Number(r.ht_home_goals)>Number(r.ht_away_goals)?"1":Number(r.ht_home_goals)<Number(r.ht_away_goals)?"2":"X"}/${Number(r.ft_home_goals)>Number(r.ft_away_goals)?"1":Number(r.ft_home_goals)<Number(r.ft_away_goals)?"2":"X"}`));
        const htUnder05N=htValid.length-ht05N;
        // Keep a wider score pool so filtering by the selected market still finds
        // compatible observed scores even when the globally top five are incompatible.
        const scoreDistribution=(items,total)=>items.slice(0,20).map(([score,count])=>({score,count,percent:pct(count,total)}));
        const htftDistribution=scoreDistribution(htftFreq,htftRows.length).map(x=>({result:x.score,count:x.count,percent:x.percent}));
        history={available:sample.length>0,scannedMatches:rows.length,sampleSize:sample.length,matchedMarkets:dims.map(d=>d.key),resultDistribution:Object.fromEntries(resFreq.map(([k,v])=>[k,{count:v,percent:pct(v,n)}])),over25Percent:pct(overN,n),under25Percent:pct(n-overN,n),bttsYesPercent:pct(kgN,n),bttsNoPercent:pct(n-kgN,n),home15Percent:pct(home15N,n),away15Percent:pct(away15N,n),htOver05Percent:pct(ht05N,htValid.length),htUnder05Percent:pct(htUnder05N,htValid.length),ht05OverPercent:pct(ht05N,htValid.length),ht05UnderPercent:pct(htUnder05N,htValid.length),halfTimeScoreDistribution:scoreDistribution(htFreq,htValid.length),fullTimeScoreDistribution:scoreDistribution(ftFreq,n),halfTimeFullTimeDistribution:htftDistribution,sixPlusPercent:pct(sixN,n),mostCommonHalfTimeScore:htFreq[0]?{score:htFreq[0][0],count:htFreq[0][1],percent:pct(htFreq[0][1],htValid.length)}:null,mostCommonFullTimeScore:ftFreq[0]?{score:ftFreq[0][0],count:ftFreq[0][1],percent:pct(ftFreq[0][1],n)}:null,alternativeFullTimeScore:ftFreq[1]?{score:ftFreq[1][0],count:ftFreq[1][1],percent:pct(ftFreq[1][1],n)}:null,mostCommonHalfTimeFullTime:htftFreq[0]?{result:htftFreq[0][0],count:htftFreq[0][1],percent:pct(htftFreq[0][1],htftRows.length)}:null,note:generalHistoricalFallback?"Güncel oranla benzerlik kurulamadı; son tarihsel sonuçlardan genel 100 maçlık örneklem kullanıldı.":expanded?"Yakın oran eşleşmesi az; en yakın 100 kayıt kullanıldı.":"Oran benzerliğine göre seçilmiş tarihsel örneklem."};
        if(history.sampleSize) reasons.push(`${rows.length} tarihsel maç tarandı; en yakın ${sample.length} maç hesaplandı.`);
      } catch(e) { history.note=`Tarihsel analiz yapılamadı: ${e.message}`; }
    } else history.note="DATABASE_URL yapılandırılmadığı için tarihsel analiz yapılamadı.";
    const p = v => Number.isFinite(Number(v)) ? Number(v) : null;
    // Risk-first selection: only preferred goal/BTTS markets are candidates. A real
    // current quote and a positive historical-vs-implied edge are required; no 1/X/2 picks.
    const candidates=[];
    const addCandidate=(pick,pct,market,kind)=>{
      const odd=Number(market?.odd);
      if (history.sampleSize>=20 && pct!=null && Number.isFinite(odd) && odd>1) {
        const implied=100/odd;
        const edge=Number((Number(pct)-implied).toFixed(1));
        if (Number(pct)>=52 && edge>=3) candidates.push({pick,pct:Number(pct),kind,odd,edge});
      }
    };
    addCandidate("EV 1.5 ÜST",history.home15Percent,home15,"home-goals");
    addCandidate("DEP 1.5 ÜST",history.away15Percent,away15,"away-goals");
    addCandidate("KG VAR",history.bttsYesPercent,kgYes,"btts-yes");
    addCandidate("KG YOK",history.bttsNoPercent,kgNo,"btts-no");
    addCandidate("MS 2.5 ÜST",history.over25Percent,over25,"over25");
    addCandidate("MS 2.5 ALT",history.under25Percent,under25,"under25");
    candidates.sort((a,b)=>b.edge-a.edge || b.pct-a.pct);
    let selected=null;
    if(candidates.length){
      selected=candidates[0];
      mainPick=selected.pick;
      confidence=`Tarihsel örneklem ${history.sampleSize} maç · değer farkı +${selected.edge} puan`;
      const alt=candidates.find(c=>c.pick!==selected.pick && c.kind!==selected.kind) || candidates.find(c=>c.pick!==selected.pick);
      alternative=alt ? alt.pick : "İkinci uygun tercih yok";
      reasons.push(`Ana tercih gerçek oranla karşılaştırıldı; tarihsel olasılık ile oran olasılığı arasındaki fark +${selected.edge} puan.`);
    } else {
      // User-facing preference: do not display the phrase “UZAK DUR”.
      // If strict value criteria fail, show the highest historical-probability market
      // only when the relevant real quote and a usable sample exist; label confidence honestly.
      // Güncel oran yoksa tarihsel eğilim yine gösterilebilir; fakat oran/değer avantajı varmış gibi sunulmaz.
      const fallback = [
        {pick:"EV 1.5 ÜST",pct:history.home15Percent,market:home15,kind:"home-goals"},
        {pick:"DEP 1.5 ÜST",pct:history.away15Percent,market:away15,kind:"away-goals"},
        {pick:"KG VAR",pct:history.bttsYesPercent,market:kgYes,kind:"btts-yes"},
        {pick:"KG YOK",pct:history.bttsNoPercent,market:kgNo,kind:"btts-no"},
        {pick:"MS 2.5 ÜST",pct:history.over25Percent,market:over25,kind:"over25"},
        {pick:"MS 2.5 ALT",pct:history.under25Percent,market:under25,kind:"under25"}
      ].filter(x=>history.sampleSize>=20 && x.pct!=null)
       .sort((a,b)=>Number(b.pct)-Number(a.pct));
      if(fallback.length){
        selected=fallback[0];
        const quoteAvailable=Number.isFinite(Number(selected.market?.odd)) && Number(selected.market.odd)>1;
        mainPick=`${selected.pick} (${selected.pct}%)${quoteAvailable?"":" · tarihsel eğilim; güncel oran yok"}`;
        const alt=fallback.find(x=>x.pick!==selected.pick);
        alternative=alt?`${alt.pick} (${alt.pct}%)${Number.isFinite(Number(alt.market?.odd))&&Number(alt.market.odd)>1?"":" · tarihsel eğilim"}`:"Yeterli alternatif verisi yok";
        confidence=quoteAvailable
          ? `Düşük güven · ${history.sampleSize} benzer maç; değer avantajı doğrulanmadı`
          : `Yalnızca tarihsel eğilim · ${history.sampleSize} benzer maç; güncel oran doğrulanamadı`;
        reasons.push(quoteAvailable
          ? "Pozitif değer avantajı doğrulanmadığı için seçim yalnızca tarihsel eğilimdir."
          : "Güncel market oranı sağlayıcıdan alınamadı; tercih yalnızca tarihsel benzer maç yüzdesine dayanır ve oran/değer avantajı iddiası taşımaz.");
      } else {
        mainPick="Yeterli tarihsel örneklem yok";
        alternative="Yeterli alternatif verisi yok";
        confidence="Tarihsel örneklem 20 maçın altında veya uygun market yüzdesi hesaplanamadı";
        reasons.push("Tercih üretmek için en az 20 benzer maçlık kullanılabilir tarihsel örneklem gerekli.");
      }
    }
    if(history.mostCommonHalfTimeScore && history.mostCommonHalfTimeScore.percent>=15 && selected) halfTimeScore=`${history.mostCommonHalfTimeScore.score} (${history.mostCommonHalfTimeScore.percent}%)`;
    else halfTimeScore="Yeterli veri yok";
    // Only choose a full-time score from observed historical scores that fit the main market.
    const scoreFits=(score,kind)=>{
      const bits=String(score||"").split("-").map(Number); if(bits.length!==2 || bits.some(v=>!Number.isFinite(v))) return false;
      const [h,a]=bits, total=h+a;
      if(kind==="btts-yes") return h>0&&a>0;
      if(kind==="btts-no") return h===0||a===0;
      if(kind==="over25") return total>=3;
      if(kind==="under25") return total<=2;
      if(kind==="home-goals") return h>=2;
      if(kind==="away-goals") return a>=2;
      return false;
    };
    const compatibleScores=(history.fullTimeScoreDistribution||[]).filter(x=>selected&&scoreFits(x.score,selected.kind));
    if(compatibleScores.length && history.sampleSize>=20){
      fullTimeScore=`${compatibleScores[0].score} (${compatibleScores[0].percent}%)`;
      if(compatibleScores[1]) alternativeFullTimeScore=`${compatibleScores[1].score} (${compatibleScores[1].percent}%)`;
      else alternativeFullTimeScore="İkinci uyumlu skor için yeterli veri yok";
    } else { fullTimeScore="Yeterli veri yok"; alternativeFullTimeScore="Yeterli veri yok"; }
    const surpriseBits=[];
    // Sürpriz, seçili marketle tutarlı ve yeterli örneklem destekliyorsa gösterilir.
    if(selected && history.sampleSize>=30 && history.mostCommonHalfTimeFullTime && history.mostCommonHalfTimeFullTime.percent>=15) {
      const htft=history.mostCommonHalfTimeFullTime.result;
      const fullResult=String(htft).split("/")[1];
      const compatible = selected.kind==="home-goals" ? fullResult==="1"
        : selected.kind==="away-goals" ? fullResult==="2" : true;
      if(compatible) surpriseBits.push(`${htft} İY/MS (${history.mostCommonHalfTimeFullTime.percent}%)`);
    }
    if(selected && history.sixPlusPercent!=null && history.sampleSize>=30 && history.sixPlusPercent>=15 && ["over25","home-goals","away-goals","btts-yes"].includes(selected.kind)) surpriseBits.push(`6+ GOL (${history.sixPlusPercent}%)`);
    if(selected && history.mostCommonFullTimeScore && history.sampleSize>=30 && history.mostCommonFullTimeScore.percent>=12 && Number(history.mostCommonFullTimeScore.score.split("-")[0])+Number(history.mostCommonFullTimeScore.score.split("-")[1])>=4 && scoreFits(history.mostCommonFullTimeScore.score,selected.kind)) surpriseBits.push(`Yüksek skor ${history.mostCommonFullTimeScore.score}`);
    surprise=surpriseBits.join(" · ") || "Yeterli destek yok";
    const moves=[homeWin,draw,awayWin,over25,under25,kgYes,kgNo].filter(x=>x?.direction).map(x=>`${x.selection}: ${x.direction}`);
    marketDirection=moves.length?moves.join(" · "):markets.length?"İlk kayıt / hareket ölçülemiyor":"Oran hareketi verisi yok";
    if(!markets.length) reasons.push("Mevcut sağlayıcı oran döndürmedi; oran gerektiren seçimler zorlanmadı.");
    if(teams.length) reasons.push("Maç istatistikleri mevcut."); else reasons.push("Maç istatistikleri mevcut değil.");
    res.json({fixtureId:Number(fixtureId),match:`${home} VS ${away}`,home,away,mode,matchStatus:status,isLive,source:"API-Football · mevcut oranlar ve tarihsel örneklem",fetchedAt:new Date().toISOString(),currentScore:scoreHome==null||scoreAway==null?null:`${scoreHome}-${scoreAway}`,minute:elapsed??null,mainPick,alternative,halfTimeScore,fullTimeScore,alternativeFullTimeScore,surprise,marketDirection,confidence,statsAvailable:teams.length>0,stats:teams,oddsCount:markets.length,history,reasons,providerNote:oddsData.note||null,statsWarning,note:"Yüzdeler seçilmiş tarihsel örneklemin sonuçlarıdır; garanti veya kesin skor tahmini değildir."});
  } catch(error) { console.error("Match analysis error:",error.stack||error.message); res.status(502).json({error:"Maç analiz edilemedi; veri alınamadı.",detail:error.message}); }
});

function resFreqSafe(distribution) { return distribution && Object.keys(distribution).length > 0; }

// Live combination: inspect a small number of genuinely live fixtures and never invent odds.
app.get("/api/live-combo", async (_req, res) => {
  try {
    const fixtures = await apiGet("/fixtures?live=all");
    const liveRows = (fixtures || []).filter(f => {
      const status = String(f.fixture?.status?.short || "").toUpperCase();
      const minute = Number(f.fixture?.status?.elapsed);
      return !["FT","AET","PEN","NS","PST","CANC"].includes(status) && Number.isFinite(minute) && minute >= 20 && minute <= 82;
    }).slice(0, 8);
    const candidates = [];
    for (const fixture of liveRows) {
      const id = fixture.fixture?.id;
      if (!id) continue;
      try {
        const minute = Number(fixture.fixture.status.elapsed);
        const homeScore = Number(fixture.goals?.home), awayScore = Number(fixture.goals?.away);
        if (!Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
        const stats = await apiGet(`/fixtures/statistics?fixture=${encodeURIComponent(String(id))}`);
        const val = (teamIndex, keys) => {
          const obj = stats?.[teamIndex]?.statistics || {};
          for (const key of keys) {
            const raw = obj[key];
            const n = raw == null ? null : Number(String(raw).replace("%", ""));
            if (Number.isFinite(n)) return n;
          }
          return null;
        };
        const shotsOn = (val(0,["Shots on Goal","Shots on Target"])||0) + (val(1,["Shots on Goal","Shots on Target"])||0);
        const shots = (val(0,["Total Shots"])||0) + (val(1,["Total Shots"])||0);
        const corners = (val(0,["Corner Kicks","Corners"])||0) + (val(1,["Corner Kicks","Corners"])||0);
        // Require real activity signals; missing stats do not count as a positive signal.
        const knownSignals = [val(0,["Shots on Goal","Shots on Target"]),val(1,["Shots on Goal","Shots on Target"]),val(0,["Total Shots"]),val(1,["Total Shots"])].filter(v=>v!=null).length;
        if (knownSignals < 2 || shotsOn < 3 || shots < 8 || corners < 2) continue;
        let market = null, reason = `Dakika ${minute} · toplam şut ${shots} · isabetli şut ${shotsOn} · korner ${corners}`;
        if (homeScore > 0 && awayScore > 0) market = "MS 2.5 ÜST";
        else if (homeScore + awayScore <= 2 && shotsOn >= 4) market = "KG VAR";
        if (!market) continue;
        let odds = {markets:[]};
        try { odds = await getOdds(id, "live"); } catch {}
        const normalize = v => String(v||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
        const target = (odds.markets||[]).find(o => {
          const marketText=normalize(o.market), selection=normalize(o.selection);
          if (market === "KG VAR") return /(both teams|btts|kg)/.test(marketText) && /(yes|var)/.test(selection);
          return /(?:^|\D)2[.,]5(?:\D|$)/.test(`${marketText} ${selection}`) && /(over|ust)/.test(selection);
        });
        if (!target || !Number.isFinite(Number(target.odd)) || Number(target.odd) <= 1) continue;
        candidates.push({id:Number(id),league:fixture.league?.name||"Bilinmeyen lig",home:fixture.teams?.home?.name||"Ev sahibi",away:fixture.teams?.away?.name||"Deplasman",minute,score:`${homeScore}-${awayScore}`,market,odd:Number(target.odd),activity:reason,source:odds.source||"API-Football"});
      } catch (e) { console.warn(`Canlı kombin maç atlandı (${id}):`, e.message); }
    }
    candidates.sort((a,b)=>((b.minute>=55&&b.minute<=75)?1:0)-((a.minute>=55&&a.minute<=75)?1:0) || b.odd-a.odd);
    const picks=candidates.slice(0,3);
    res.json({source:"API-Football",fetchedAt:new Date().toISOString(),inspected:liveRows.length,picks,available:picks.length>=2,note:picks.length>=2?"Seçimler canlı skor, mevcut istatistik ve gerçek canlı oranla filtrelendi; garanti değildir.":"En az iki uygun maç bulunamadı. Eksik seçim uydurulmadı."});
  } catch (error) {
    console.error("Live combo error:", error.stack || error.message);
    res.status(502).json({error:"Canlı kombin oluşturulamadı.",detail:error.message||String(error)});
  }
});

// Daily coupon drafts are generated only from real provider odds and the historical DB.
const dailyCouponDrafts = new Map();
app.get("/api/coupon/daily", async (req, res) => {
  const requestStartedAt = Date.now();
  const turkeyToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const date = String(req.query.date || turkeyToday);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Geçerli tarih gerekli: YYYY-MM-DD." });
  if (!pool) return res.status(503).json({ error: "Kupon için DATABASE_URL ve tarihsel veri gerekli." });
  const stageStartedAt = Date.now();
  const markStage = (stage) => console.log(`[COUPON_STAGE] ${stage} +${Date.now() - requestStartedAt}ms`);
  try {
    await initDatabase();
    markStage("database_ready");
    const start = Math.floor(new Date(`${date}T00:00:00+03:00`).getTime() / 1000);
    const fixturesStartedAt = Date.now();
    const payload = await cachedProviderRequest(`fixtures:${date}`, `/fixtures?start_time=${start}&end_time=${start + 86400}`, 5 * 60_000);
    console.log(`[COUPON_STAGE] fixtures_fetch ${Date.now() - fixturesStartedAt}ms`);
    const fixtures = (payload.data || []).map(normalizeProviderMatch)
      .filter(m => m.status === "NS" && m.fixtureDate && new Date(m.fixtureDate).getTime() > Date.now())
      .sort((a,b) => new Date(a.fixtureDate) - new Date(b.fixtureDate));
    markStage(`fixtures_normalized total=${fixtures.length}`);
    if (!fixtures.length) return res.json({ date, draftId: null, picks: [], inspected: [], inspectedCount: 0, candidateFixtureCount: 0, durationMs: Date.now()-requestStartedAt, message: "Bu tarihte başlamamış maç bulunamadı.", source: "API-Football + historical_matches" });

    const historyStartedAt = Date.now();
    const historyQuery = await pool.query(`SELECT ft_home_goals, ft_away_goals, b365_home, b365_draw, b365_away, b365_over25, b365_under25
      FROM historical_matches WHERE ft_home_goals IS NOT NULL AND ft_away_goals IS NOT NULL
      AND (b365_home IS NOT NULL OR b365_draw IS NOT NULL OR b365_away IS NOT NULL OR b365_over25 IS NOT NULL OR b365_under25 IS NOT NULL)
      ORDER BY id DESC LIMIT 10000`);
    const historyRows = historyQuery.rows;
    console.log(`[COUPON_STAGE] history_query rows=${historyRows.length} ${Date.now() - historyStartedAt}ms`);
    const pct = (n,d) => d ? Number((100*n/d).toFixed(1)) : null;
    const picks = [];
    const inspected = [];
    // Keep the candidate count bounded, but fetch odds concurrently so eight slow
    // provider calls do not run one after another and exceed the browser's 30s timeout.
    const candidatesToCheck = fixtures.slice(0, 8);
    const oddsStartedAt = Date.now();
    const COUPON_ODDS_TIMEOUT_MS = 9000;
    const oddsResults = await Promise.all(candidatesToCheck.map(async fixture => {
      const oneStartedAt = Date.now();
      let timeoutId;
      try {
        // Bound each provider wait independently. Some provider responses can stall
        // beyond the fetch timeout while the response body is being read.
        const timeout = new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`Oran isteği ${COUPON_ODDS_TIMEOUT_MS} ms içinde yanıt vermedi.`)), COUPON_ODDS_TIMEOUT_MS);
        });
        const data = await Promise.race([getOdds(fixture.id, "prematch"), timeout]);
        clearTimeout(timeoutId);
        console.log(`[COUPON_ODDS] fixture=${fixture.id} ms=${Date.now() - oneStartedAt} markets=${Array.isArray(data.markets) ? data.markets.length : 0}`);
        return [fixture.id, { data }];
      } catch (error) {
        clearTimeout(timeoutId);
        console.error(`[COUPON_ODDS_ERROR] fixture=${fixture.id} ms=${Date.now() - oneStartedAt} error=${error?.message || error}`);
        return [fixture.id, { error }];
      }
    }));
    console.log(`[COUPON_STAGE] odds_all count=${oddsResults.length} ${Date.now() - oddsStartedAt}ms`);
    const oddsByFixture = new Map(oddsResults);
    for (const fixture of candidatesToCheck) {
      const oddsResult = oddsByFixture.get(fixture.id);
      if (!oddsResult || oddsResult.error) {
        const detail = oddsResult?.error?.message || "Bilinmeyen oran hatası";
        console.error(`[COUPON_ODDS_ERROR] fixture=${fixture.id} error=${detail}`);
        inspected.push({ fixtureId: fixture.id, reason: `Oran verisi alınamadı: ${detail}`.slice(0, 220) });
        continue;
      }
      const oddsData = oddsResult.data;
      const markets = Array.isArray(oddsData.markets) ? oddsData.markets : [];
      const norm = v => String(v ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[._-]+/g, " ");
      // Providers often put the 2.5 line in the selection (e.g. "Over 2.5"),
      // not in the market name (e.g. "Goals Over/Under"). Match both together.
      const marketPick = (marketRe, selectionRe) => markets.find(m => marketRe.test(norm(`${m.market || ""} ${m.selection || ""}`)) && selectionRe.test(norm(m.selection)) && Number(m.odd) >= 1.25 && Number(m.odd) <= 2.10);
      const available = [
        { label: "MS 2.5 ÜST", field: "b365_over25", market: marketPick(/over.*2\.?\s*5|2\.?\s*5.*over|goal line fixed.*2\.?\s*5|goal line.*2\.?\s*5/, /over|ust/) },
        { label: "MS 2.5 ALT", field: "b365_under25", market: marketPick(/under.*2\.?\s*5|2\.?\s*5.*under|goal line fixed.*2\.?\s*5|goal line.*2\.?\s*5/, /under|alt/) },
        { label: "KG VAR", field: null, market: marketPick(/both teams|btts|kg/, /yes|var/), result: r => Number(r.ft_home_goals)>0 && Number(r.ft_away_goals)>0 },
        { label: "KG YOK", field: null, market: marketPick(/both teams|btts|kg/, /no|yok/), result: r => Number(r.ft_home_goals)===0 || Number(r.ft_away_goals)===0 }
      ].filter(x => x.market && Number(x.market.odd) > 1);
      for (const item of available) {
        const odd = Number(item.market.odd);
        const field = item.field;
        if (field) {
          const ranked = historyRows.map(r => ({ r, d: r[field] != null && Number(r[field]) > 1 ? Math.abs(odd - Number(r[field])) / Math.max(.2, odd * .12) : Infinity }))
            .filter(x => Number.isFinite(x.d)).sort((a,b) => a.d-b.d);
          let sample = ranked.filter(x => x.d <= 2.5).slice(0,100).map(x=>x.r);
          if (sample.length < 10) sample = ranked.slice(0,100).map(x=>x.r);
          if (sample.length < 20) continue;
          const wins = sample.filter(r => item.label === "MS 2.5 ÜST" ? Number(r.ft_home_goals)+Number(r.ft_away_goals)>=3 : Number(r.ft_home_goals)+Number(r.ft_away_goals)<=2).length;
          item.probability = pct(wins,sample.length); item.sampleSize = sample.length;
        } else {
          // The imported historical file has Over/Under 2.5 odds, not historical
          // BTTS odds. Do not pretend those are comparable to a KG price. Use a
          // clearly unpriced recent 100-match outcome sample for BTTS frequency.
          const sample = historyRows.slice(0, 100);
          if (sample.length < 20) continue;
          item.probability = pct(sample.filter(item.result).length, sample.length);
          item.sampleSize = sample.length;
          item.probabilityBasis = "Son 100 tarihsel maçın KG gerçekleşme oranı; KG geçmiş oran eşleştirmesi mevcut değil.";
        }
        const implied = 100 / odd;
        const edge = Number((item.probability - implied).toFixed(1));
        // Cautious gates: >=62% historical frequency, >=20 matches, and positive value edge.
        if (item.probability >= 62 && edge >= 2) picks.push({ fixtureId: fixture.id, home: fixture.home, away: fixture.away, league: fixture.league, kickoff: fixture.fixtureDate, market: item.label, odd, historicalProbability: item.probability, impliedProbability: Number(implied.toFixed(1)), edge, sampleSize: item.sampleSize, source: item.probabilityBasis ? `API-Football Bet365 gerçek oranı + historical_matches; ${item.probabilityBasis}` : "Bet365 odds from API-Football + historical_matches" });
      }
      inspected.push({
        fixtureId: fixture.id,
        reason: available.length
          ? "Gerçek oranlar tarihsel örneklemle karşılaştırıldı; eşik koşulları karşılanmadıysa seçim oluşturulmadı."
          : `Gerçek oran verisi geldi (${markets.length} market); desteklenen MS 2.5 Üst/Alt veya KG Var/Yok marketi uygun oran aralığında eşleşmedi.`
      });
    }
    picks.sort((a,b) => b.edge-a.edge || b.historicalProbability-a.historicalProbability);
    const chosen = [];
    const usedFixtures = new Set();
    for (const pick of picks) {
      if (usedFixtures.has(pick.fixtureId)) continue;
      chosen.push(pick); usedFixtures.add(pick.fixtureId);
      if (chosen.length === 3) break;
    }
    const draftId = `${date}-${Date.now()}`;
    const draft = { draftId, date, status: "PENDING_APPROVAL", picks: chosen, generatedAt: new Date().toISOString(), inspected, inspectedCount: inspected.length, candidateFixtureCount: Math.min(fixtures.length, 8), durationMs: Date.now()-requestStartedAt, note: chosen.length ? "Taslak kupondur. Kullanıcı onayı olmadan yayımlanmaz. Seçim üretilemeyen maçlar atlanır; oran veya istatistik uydurulmaz." : "Uygun seçim bulunamadı. inspected alanı, oran/örneklem/filtre nedeniyle atlanan maçları gösterir; veri uydurulmaz." };
    dailyCouponDrafts.set(draftId, draft);
    // Keep the in-memory draft map bounded.
    if (dailyCouponDrafts.size > 20) dailyCouponDrafts.delete(dailyCouponDrafts.keys().next().value);
    markStage(`response_ready picks=${chosen.length} inspected=${inspected.length} processing=${Date.now() - stageStartedAt}ms`);
    res.json(draft);
  } catch (error) {
    console.error(`Daily coupon error after ${Date.now()-requestStartedAt}ms:`, error.stack || error.message);
    res.status(502).json({ error: "Günün kuponu gerçek verilerle oluşturulamadı.", detail: error.message });
  }
});

app.post("/api/coupon/approve", express.json(), (req, res) => {
  const draftId = String(req.body?.draftId || "");
  const draft = dailyCouponDrafts.get(draftId);
  if (!draft) return res.status(404).json({ error: "Kupon taslağı bulunamadı veya sunucu yeniden başladı. Lütfen yeniden oluştur." });
  if (!Array.isArray(draft.picks) || draft.picks.length < 2 || draft.picks.length > 3) return res.status(422).json({ error: "Onay için 2 veya 3 uygun seçim bulunmalı. Veri yetersizse kupon zorlanmaz." });
  draft.status = "APPROVED";
  draft.approvedAt = new Date().toISOString();
  res.json({ ...draft, approved: true, message: "Kupon kullanıcı tarafından onaylandı. Uygulama dışında otomatik paylaşım yapılmadı." });
});

app.get("/api/historical/similar", async (req, res) => {
  if (!pool) return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  const over = Number(req.query.over), under = Number(req.query.under);
  if (!Number.isFinite(over) || !Number.isFinite(under) || over <= 1 || under <= 1 || over > 100 || under > 100) return res.status(400).json({ error: "Geçerli oranlar gir. Örnek: ?over=1.80&under=2.00" });
  try {
    await initDatabase();
    const result = await pool.query(`WITH matched_rows AS (
      SELECT id,match_date,home_team,away_team,b365_over25,b365_under25,total_goals,over25_result,
      ABS(b365_over25-$1::numeric)+ABS(b365_under25-$2::numeric) AS odds_distance
      FROM historical_matches WHERE b365_over25 IS NOT NULL AND b365_under25 IS NOT NULL AND over25_result IN (0,1)
        AND ABS(b365_over25-$1::numeric)<=0.20 AND ABS(b365_under25-$2::numeric)<=0.20
      ORDER BY odds_distance ASC,match_date DESC NULLS LAST LIMIT 100)
      SELECT COUNT(*)::int AS sample_size, COUNT(*) FILTER (WHERE over25_result=1)::int AS over25,
      COUNT(*) FILTER (WHERE over25_result=0)::int AS under25,
      ROUND(100.0*COUNT(*) FILTER (WHERE over25_result=1)/NULLIF(COUNT(*),0),2) AS over25_percent,
      ROUND(100.0*COUNT(*) FILTER (WHERE over25_result=0)/NULLIF(COUNT(*),0),2) AS under25_percent,
      ROUND(AVG(odds_distance)::numeric,3) AS average_odds_distance FROM matched_rows`, [over, under]);
    const row = result.rows[0], sampleSize = row.sample_size || 0;
    let assessment = "—";
    if (sampleSize >= 30) {
      const overPercent = Number(row.over25_percent || 0), underPercent = Number(row.under25_percent || 0);
      if (overPercent >= 60) assessment = "TARİHSEL EĞİLİM: 2.5 ÜST";
      else if (underPercent >= 60) assessment = "TARİHSEL EĞİLİM: 2.5 ALT";
      else assessment = "TUTARSIZ SİNYAL";
    }
    res.json({ source: "historical_matches", requestedOdds: { over25: over, under25: under }, oddsTolerance: 0.20, maxSample: 100,
      sampleSize, over25: row.over25, under25: row.under25, over25Percent: row.over25_percent, under25Percent: row.under25_percent,
      averageOddsDistance: row.average_odds_distance, assessment,
      note: "Geçmiş benzer açılış oranlarının sonucudur; canlı oran veya garanti değildir." });
  } catch (error) { console.error("Similar historical matches error:", error); res.status(503).json({ error: "Benzer geçmiş maçlar sorgulanamadı.", detail: error.message }); }
});

app.get("/api/db-status", async (_req, res) => {
  if (!pool) return res.status(503).json({ connected: false, error: "DATABASE_URL ayarlanmamış." });
  try { await initDatabase(); await pool.query("SELECT 1"); res.json({ connected: true, database: "PostgreSQL" }); }
  catch (error) { console.error("Database status error:", error.message); res.status(503).json({ connected: false, error: "Veritabanına bağlanılamadı.", detail: error.message }); }
});

app.get("/api/auto-capture/status", async (_req, res) => {
  if (!pool) return res.status(503).json({ enabled: false, error: "DATABASE_URL ayarlanmamış." });
  try { await initDatabase(); const result = await pool.query("SELECT COUNT(*)::int AS tracked_matches FROM tracked_matches");
    res.json({ enabled: true, intervalSeconds: 1800, running: autoCaptureRunning, trackedMatches: result.rows[0].tracked_matches, maxTrackedMatches: 2,
      note: "İstatistikler sunucu çalışırken yaklaşık 10 dakikada bir denenir. Sağlayıcı cevapları önbelleğe alınır; oranlar yalnızca istendiğinde yenilenir." });
  } catch (error) { console.error("Auto-capture status error:", error.message); res.status(503).json({ enabled: false, error: "Otomatik kayıt durumu alınamadı." }); }
});

app.listen(PORT, () => {
  console.log(`WinScope Live running on port ${PORT}`);
  console.log("Veri kaynağı: API-Football. Canlı oranlar ve istatistikler sağlayıcının bu maç/market için gerçekten döndürdüğü alanlarla sınırlıdır; eksik veriler tahmin edilmez.");
  captureTrackedMatches().catch(error => console.error("İlk otomatik kayıt başarısız:", error.message));
  scanTrackedMatchAlarms().catch(error => console.error("İlk alarm taraması başarısız:", error.message));
  // Quota protection: background tasks run less frequently; cached requests are shared with the UI.
  const captureTimer = setInterval(() => captureTrackedMatches().catch(error => console.error("Otomatik kayıt döngüsü başarısız:", error.message)), 30 * 60_000);
  const alarmTimer = setInterval(() => scanTrackedMatchAlarms().catch(error => console.error("Alarm tarama döngüsü başarısız:", error.message)), 15 * 60_000);
  captureTimer.unref();
  alarmTimer.unref();
});
