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
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORICAL_CSV = path.join(
  __dirname,
  "data",
  "winscope_historical_odds.csv"
);
const { Pool } = pg;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 3
    })
  : null;

let dbReady = null;

function toNumber(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseDate(value) {
  const parts = String(value || "").split("/");
  if (parts.length !== 3) return null;

  const [day, month, year] = parts;
  if (!day || !month || !year) return null;

  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

// Geçmiş CSV verisini yalnızca tablo boşken bir kez aktarır.
async function importHistoricalCsvOnce() {
  if (!pool) {
    return { imported: false, reason: "database_not_configured" };
  }

  if (!existsSync(HISTORICAL_CSV)) {
    console.log("Geçmiş CSV bulunamadı; aktarım atlandı.");
    return { imported: false, reason: "csv_not_found" };
  }

  const existing = await pool.query(
    "SELECT COUNT(*)::int AS total FROM historical_matches"
  );

  if (existing.rows[0].total > 0) {
    console.log(`Geçmiş veri zaten mevcut: ${existing.rows[0].total} maç.`);
    return {
      imported: false,
      reason: "already_imported",
      rows: existing.rows[0].total
    };
  }

  const csvText = await readFile(HISTORICAL_CSV, "utf8");
  const records = parse(csvText, {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true
  });

  const client = await pool.connect();
  let inserted = 0;

  try {
    await client.query("BEGIN");

    for (let start = 0; start < records.length; start += 200) {
      const batch = records.slice(start, start + 200);
      const values = [];

      const placeholders = batch.map((row, index) => {
        const offset = index * 24;

        values.push(
          row.Div || null,
          parseDate(row.Date),
          row.Time || null,
          row.HomeTeam || "Bilinmiyor",
          row.AwayTeam || "Bilinmiyor",
          toNumber(row.HTHG),
          toNumber(row.HTAG),
          toNumber(row.FTHG),
          toNumber(row.FTAG),
          row.FTR || null,
          toNumber(row.B365H),
          toNumber(row.B365D),
          toNumber(row.B365A),
          toNumber(row.AvgH),
          toNumber(row.AvgD),
          toNumber(row.AvgA),
          toNumber(row["B365>2.5"]),
          toNumber(row["B365<2.5"]),
          toNumber(row["Avg>2.5"]),
          toNumber(row["Avg<2.5"]),
          toNumber(row["B365C>2.5"]),
          toNumber(row["B365C<2.5"]),
          toNumber(row.TotalGoals),
          toNumber(row.Over25Result)
        );

        return `(${Array.from(
          { length: 24 },
          (_, i) => `$${offset + i + 1}`
        ).join(",")})`;
      });

      await client.query(
        `INSERT INTO historical_matches (
          league_code, match_date, match_time, home_team, away_team,
          ht_home_goals, ht_away_goals, ft_home_goals, ft_away_goals,
          full_time_result, b365_home, b365_draw, b365_away,
          avg_home, avg_draw, avg_away, b365_over25, b365_under25,
          avg_over25, avg_under25, b365_close_over25,
          b365_close_under25, total_goals, over25_result
        ) VALUES ${placeholders.join(",")}`,
        values
      );

      inserted += batch.length;
    }

    await client.query("COMMIT");
    console.log(`Geçmiş veri aktarıldı: ${inserted} maç.`);

    return { imported: true, rows: inserted };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

// Tabloları oluştur ve geçmiş veriyi gerektiğinde aktar.
async function initDatabase() {
  if (!pool) return false;

  if (!dbReady) {
    dbReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS match_stat_snapshots (
          id BIGSERIAL PRIMARY KEY,
          fixture_id BIGINT NOT NULL,
          captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          teams JSONB NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_match_snapshots_fixture_time
        ON match_stat_snapshots (fixture_id, captured_at DESC);

        CREATE TABLE IF NOT EXISTS tracked_matches (
          fixture_id BIGINT PRIMARY KEY,
          home_team TEXT NOT NULL,
          away_team TEXT NOT NULL,
          enabled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS historical_matches (
          id BIGSERIAL PRIMARY KEY,
          league_code TEXT,
          match_date DATE,
          match_time TEXT,
          home_team TEXT NOT NULL,
          away_team TEXT NOT NULL,
          ht_home_goals INTEGER,
          ht_away_goals INTEGER,
          ft_home_goals INTEGER,
          ft_away_goals INTEGER,
          full_time_result TEXT,
          b365_home NUMERIC,
          b365_draw NUMERIC,
          b365_away NUMERIC,
          avg_home NUMERIC,
          avg_draw NUMERIC,
          avg_away NUMERIC,
          b365_over25 NUMERIC,
          b365_under25 NUMERIC,
          avg_over25 NUMERIC,
          avg_under25 NUMERIC,
          b365_close_over25 NUMERIC,
          b365_close_under25 NUMERIC,
          total_goals INTEGER,
          over25_result INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_historical_league_date
        ON historical_matches (league_code, match_date DESC);

        CREATE INDEX IF NOT EXISTS idx_historical_teams
        ON historical_matches (home_team, away_team);
      `);

      await importHistoricalCsvOnce();
      return true;
    })().catch(error => {
      dbReady = null;
      console.error("Veritabanı başlatma hatası:", error.message);
      throw error;
    });
  }

  return dbReady;
}

// API-Football isteği
async function apiGet(pathname) {
  if (!API_KEY) {
    throw new Error("API_FOOTBALL_KEY ayarlanmamış.");
  }

  const response = await fetch(`${BASE_URL}${pathname}`, {
    headers: { "x-apisports-key": API_KEY },
    signal: AbortSignal.timeout(12000)
  });

  const payload = await response.json();

  if (!response.ok || Object.keys(payload.errors || {}).length > 0) {
    console.error("API-Football hatası:", payload.errors);
    throw new Error("API-Football isteği başarısız.");
  }

  return payload.response || [];
}

// Canlı maç listesi
app.get("/api/live", async (_req, res) => {
  try {
    const fixtures = await apiGet("/fixtures?live=all");

    const matches = fixtures.map(item => ({
      id: item.fixture.id,
      league: item.league.name,
      country: item.league.country,
      minute: item.fixture.status.elapsed,
      status: item.fixture.status.short,
      home: item.teams.home.name,
      away: item.teams.away.name,
      homeScore: item.goals.home,
      awayScore: item.goals.away,
      homeId: item.teams.home.id,
      awayId: item.teams.away.id,
      fixtureDate: item.fixture.date
    }));

    res.json({
      source: "API-Football",
      fetchedAt: new Date().toISOString(),
      results: matches.length,
      matches
    });
  } catch (error) {
    console.error("Canlı maç hatası:", error.message);
    res.status(502).json({ error: "Canlı maçlar alınamadı." });
  }
});

// Maç istatistiklerini getir ve kaydet
app.get("/api/match/:id/stats", async (req, res) => {
  const fixtureId = req.params.id;

  if (!/^\d+$/.test(fixtureId)) {
    return res.status(400).json({ error: "Geçersiz fikstür ID." });
  }

  try {
    const rows = await apiGet(
      `/fixtures/statistics?fixture=${fixtureId}`
    );

    const teams = rows.map(row => ({
      team: row.team?.name || "Bilinmiyor",
      statistics: Object.fromEntries(
        (row.statistics || []).map(stat => [stat.type, stat.value])
      )
    }));

    let saved = false;

    if (pool && teams.length > 0) {
      try {
        await initDatabase();

        await pool.query(
          `INSERT INTO match_stat_snapshots (fixture_id, teams)
           VALUES ($1, $2::jsonb)`,
          [fixtureId, JSON.stringify(teams)]
        );

        saved = true;
      } catch (dbError) {
        console.error("İstatistik kayıt hatası:", dbError.message);
      }
    }

    res.json({
      source: "API-Football",
      fixtureId: Number(fixtureId),
      available: teams.length > 0,
      saved,
      teams
    });
  } catch (error) {
    console.error("Maç istatistik hatası:", error.message);
    res.status(502).json({ error: "Maç istatistikleri alınamadı." });
  }
});

// Son 10 dakikanın kaydedilmiş istatistikleri
app.get("/api/match/:id/history", async (req, res) => {
  const fixtureId = req.params.id;

  if (!/^\d+$/.test(fixtureId)) {
    return res.status(400).json({ error: "Geçersiz fikstür ID." });
  }

  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  try {
    await initDatabase();

    const result = await pool.query(
      `SELECT captured_at, teams
       FROM match_stat_snapshots
       WHERE fixture_id = $1
         AND captured_at >= NOW() - INTERVAL '10 minutes'
       ORDER BY captured_at ASC`,
      [fixtureId]
    );

    res.json({
      fixtureId: Number(fixtureId),
      periodMinutes: 10,
      snapshots: result.rows.length,
      enoughData: result.rows.length >= 2,
      history: result.rows
    });
  } catch (error) {
    console.error("İstatistik geçmişi hatası:", error.message);
    res.status(503).json({
      error: "İstatistik geçmişi şu anda alınamıyor."
    });
  }
});

// Takip edilen maçlar
app.get("/api/tracked", async (_req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  try {
    await initDatabase();

    const result = await pool.query(
      `SELECT fixture_id, home_team, away_team, enabled_at
       FROM tracked_matches
       ORDER BY enabled_at DESC`
    );

    res.json({
      matches: result.rows.map(row => ({
        id: String(row.fixture_id),
        home: row.home_team,
        away: row.away_team,
        enabledAt: row.enabled_at
      }))
    });
  } catch (error) {
    console.error("Takip listesi hatası:", error.message);
    res.status(503).json({ error: "Takip listesi alınamadı." });
  }
});

// Bir maçı takibe al (en fazla 2 maç)
app.post("/api/match/:id/track", async (req, res) => {
  const fixtureId = req.params.id;
  const home = req.body?.home;
  const away = req.body?.away;

  if (!/^\d+$/.test(fixtureId)) {
    return res.status(400).json({ error: "Geçersiz fikstür ID." });
  }

  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  if (
    typeof home !== "string" || !home.trim() ||
    typeof away !== "string" || !away.trim()
  ) {
    return res.status(400).json({
      error: "Ev sahibi ve deplasman takım adları gerekli."
    });
  }

  let client;

  try {
    await initDatabase();
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [735219]);

    const existing = await client.query(
      "SELECT fixture_id FROM tracked_matches WHERE fixture_id = $1",
      [fixtureId]
    );

    if (existing.rowCount > 0) {
      await client.query("COMMIT");
      return res.json({
        success: true,
        tracked: true,
        message: "Bu maç zaten takipte."
      });
    }

    const count = await client.query(
      "SELECT COUNT(*)::int AS total FROM tracked_matches"
    );

    if (count.rows[0].total >= 2) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "En fazla 2 maç takip edilebilir."
      });
    }

    await client.query(
      `INSERT INTO tracked_matches (fixture_id, home_team, away_team)
       VALUES ($1, $2, $3)`,
      [fixtureId, home.trim(), away.trim()]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      tracked: true,
      message: "Maç takip listesine eklendi."
    });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }

    console.error("Maç takip hatası:", error.message);
    res.status(503).json({ error: "Maç takibe alınamadı." });
  } finally {
    client?.release();
  }
});

// Maçı takipten çıkar
app.delete("/api/match/:id/track", async (req, res) => {
  const fixtureId = req.params.id;

  if (!/^\d+$/.test(fixtureId)) {
    return res.status(400).json({ error: "Geçersiz fikstür ID." });
  }

  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  try {
    await initDatabase();

    await pool.query(
      "DELETE FROM tracked_matches WHERE fixture_id = $1",
      [fixtureId]
    );

    res.json({
      success: true,
      tracked: false,
      message: "Maç takipten çıkarıldı."
    });
  } catch (error) {
    console.error("Takipten çıkarma hatası:", error.message);
    res.status(503).json({ error: "Maç takipten çıkarılamadı." });
  }
});

// Geçmiş veri aktarım durumu
app.get("/api/historical/status", async (_req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  try {
    await initDatabase();

    const result = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE over25_result = 1)::int AS over25,
             COUNT(*) FILTER (WHERE over25_result = 0)::int AS under25,
             MIN(match_date) AS earliest_date,
             MAX(match_date) AS latest_date
      FROM historical_matches
    `);

    const row = result.rows[0];

    res.json({
      ready: row.total > 0,
      totalMatches: row.total,
      over25: row.over25,
      under25: row.under25,
      earliestDate: row.earliest_date,
      latestDate: row.latest_date,
      sourceFile: "data/winscope_historical_odds.csv"
    });
  } catch (error) {
    console.error("Geçmiş veri durumu hatası:", error.message);
    res.status(503).json({ error: "Geçmiş veri durumu alınamadı." });
  }
});

// Geçmiş oran özeti; örnek: /api/historical/summary?league=EC
app.get("/api/historical/summary", async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  const league = typeof req.query.league === "string"
    ? req.query.league.trim().slice(0, 12)
    : "";

  try {
    await initDatabase();

    const result = await pool.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE over25_result = 1)::int AS over25,
             COUNT(*) FILTER (WHERE over25_result = 0)::int AS under25,
             ROUND(
               100.0 * COUNT(*) FILTER (WHERE over25_result = 1)
               / NULLIF(COUNT(*) FILTER (WHERE over25_result IN (0,1)), 0),
               2
             ) AS over25_percent,
             ROUND(AVG(b365_over25)::numeric, 3) AS avg_open_over25_odds,
             ROUND(AVG(b365_under25)::numeric, 3) AS avg_open_under25_odds,
             ROUND(AVG(b365_close_over25)::numeric, 3) AS avg_close_over25_odds,
             ROUND(AVG(b365_close_under25)::numeric, 3) AS avg_close_under25_odds
      FROM historical_matches
      WHERE ($1 = '' OR league_code = $1)
    `, [league]);

    res.json({
      source: "Imported historical dataset",
      league: league || null,
      note: "Geçmiş örneklem oranları canlı maç olasılığı garantisi değildir.",
      summary: result.rows[0]
    });
  } catch (error) {
    console.error("Geçmiş oran özeti hatası:", error.message);
    res.status(503).json({ error: "Geçmiş oran özeti alınamadı." });
  }
});

// Geçmiş maç örnekleri
app.get("/api/historical/matches", async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  const league = typeof req.query.league === "string"
    ? req.query.league.trim().slice(0, 12)
    : "";

  const requestedLimit = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 100))
    : 20;

  try {
    await initDatabase();

    const result = await pool.query(`
      SELECT league_code AS league, match_date AS date,
             home_team AS home, away_team AS away,
             ht_home_goals, ht_away_goals,
             ft_home_goals, ft_away_goals, full_time_result,
             b365_home, b365_draw, b365_away,
             b365_over25, b365_under25,
             b365_close_over25, b365_close_under25,
             total_goals, over25_result
      FROM historical_matches
      WHERE ($1 = '' OR league_code = $1)
      ORDER BY match_date DESC NULLS LAST, id DESC
      LIMIT $2
    `, [league, limit]);

    res.json({
      count: result.rows.length,
      league: league || null,
      matches: result.rows
    });
  } catch (error) {
    console.error("Geçmiş maç sorgusu hatası:", error.message);
    res.status(503).json({ error: "Geçmiş maçlar alınamadı." });
  }
});

// Veritabanı bağlantı kontrolü
app.get("/api/db-status", async (_req, res) => {
  if (!pool) {
    return res.status(503).json({
      connected: false,
      error: "DATABASE_URL ayarlanmamış."
    });
  }

  try {
    await initDatabase();
    await pool.query("SELECT 1");

    res.json({ connected: true, database: "PostgreSQL" });
  } catch (error) {
    console.error("Veritabanı kontrol hatası:", error.message);
    res.status(503).json({
      connected: false,
      error: "Veritabanına bağlanılamadı."
    });
  }
});

app.listen(PORT, () => {
  console.log(`WinScope Live running on port ${PORT}`);
});
