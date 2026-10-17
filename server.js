
import express from "express";
import pg from "pg";
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
const CSV_FILE = path.join(ROOT, "winscope_historical_odds.csv");
const { Pool } = pg;

app.use(express.json());
app.use(express.static(path.join(ROOT, "public")));

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
let importResult = { status: "not_started", rows: 0 };

// CSV satırlarını virgül ve tırnakları koruyarak ayrıştırır.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"' && field.length === 0) {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);

      if (row.some(value => value.trim() !== "")) rows.push(row);

      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (row.some(value => value.trim() !== "")) rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map(value =>
    value.replace(/^\uFEFF/, "").trim()
  );

  return rows.slice(1).map(values => {
    const record = {};
    headers.forEach((header, index) => {
      record[header] = (values[index] ?? "").trim();
    });
    return record;
  });
}

function num(value) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }

  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function dateValue(value) {
  const s = String(value || "").trim();
  if (!s) return null;

  // YYYY-MM-DD biçimi
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);

  // DD/MM/YYYY biçimi
  const match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    return `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  }

  return null;
}

// Veritabanını kur, tabloları hazırla ve geçmiş veriyi gerekiyorsa aktar.
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

        CREATE INDEX IF NOT EXISTS idx_historical_date
        ON historical_matches (match_date DESC);

        CREATE INDEX IF NOT EXISTS idx_historical_league
        ON historical_matches (league_code);
      `);

      await importHistoricalOnce();
      return true;
    })().catch(error => {
      dbReady = null;
      console.error("Database initialization error:", error.message);
      throw error;
    });
  }

  return dbReady;
}

// Geçmiş CSV dosyasını sadece tarihsel tablo boşsa aktarır.
async function importHistoricalOnce() {
  if (!pool) return;

  const count = await pool.query(
    "SELECT COUNT(*)::int AS total FROM historical_matches"
  );

  if (count.rows[0].total > 0) {
    importResult = {
      status: "already_imported",
      rows: count.rows[0].total
    };
    console.log("Geçmiş veri zaten yüklü:", importResult.rows);
    return;
  }

  if (!existsSync(CSV_FILE)) {
    importResult = { status: "csv_not_found", rows: 0 };
    console.log("CSV dosyası bulunamadı:", CSV_FILE);
    return;
  }

  const text = await readFile(CSV_FILE, "utf8");
  const records = parseCSV(text);

  if (!records.length) {
    importResult = { status: "empty_csv", rows: 0 };
    return;
  }

  const client = await pool.connect();
  let inserted = 0;

  try {
    await client.query("BEGIN");

    for (let start = 0; start < records.length; start += 100) {
      const batch = records.slice(start, start + 100);
      const params = [];
      const placeholders = [];

      for (let i = 0; i < batch.length; i++) {
        const r = batch[i];
        const offset = i * 24;

        params.push(
          r.Div || null,
          dateValue(r.Date),
          r.Time || null,
          r.HomeTeam || "Bilinmiyor",
          r.AwayTeam || "Bilinmiyor",
          num(r.HTHG),
          num(r.HTAG),
          num(r.FTHG),
          num(r.FTAG),
          r.FTR || null,
          num(r.B365H),
          num(r.B365D),
          num(r.B365A),
          num(r.AvgH),
          num(r.AvgD),
          num(r.AvgA),
          num(r["B365>2.5"]),
          num(r["B365<2.5"]),
          num(r["Avg>2.5"]),
          num(r["Avg<2.5"]),
          num(r["B365C>2.5"]),
          num(r["B365C<2.5"]),
          num(r.TotalGoals),
          num(r.Over25Result)
        );

        const marks = Array.from(
          { length: 24 },
          (_, j) => `$${offset + j + 1}`
        );

        placeholders.push(`(${marks.join(",")})`);
      }

      await client.query(
        `INSERT INTO historical_matches (
          league_code, match_date, match_time, home_team, away_team,
          ht_home_goals, ht_away_goals, ft_home_goals, ft_away_goals,
          full_time_result, b365_home, b365_draw, b365_away,
          avg_home, avg_draw, avg_away, b365_over25, b365_under25,
          avg_over25, avg_under25, b365_close_over25,
          b365_close_under25, total_goals, over25_result
        ) VALUES ${placeholders.join(",")}`,
        params
      );

      inserted += batch.length;
    }

    await client.query("COMMIT");
    importResult = { status: "imported", rows: inserted };
    console.log("Geçmiş maçlar aktarıldı:", inserted);
  } catch (error) {
    await client.query("ROLLBACK");
    importResult = { status: "error", rows: 0 };
    throw error;
  } finally {
    client.release();
  }
}

// API-Football isteği
async function apiGet(endpoint) {
  if (!API_KEY) throw new Error("API_FOOTBALL_KEY ayarlanmamış.");

  const response = await fetch(`${BASE_URL}${endpoint}`, {
    headers: { "x-apisports-key": API_KEY },
    signal: AbortSignal.timeout(12000)
  });

  const payload = await response.json();

  if (!response.ok || Object.keys(payload.errors || {}).length > 0) {
    console.error("API-Football error:", payload.errors);
    throw new Error("API-Football isteği başarısız.");
  }

  return payload.response || [];
}

// Canlı maçlar
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
    console.error("Live API error:", error.message);
    res.status(502).json({ error: "Canlı maçlar alınamadı." });
  }
});

// Maç istatistiklerini getir ve snapshot kaydet
app.get("/api/match/:id/stats", async (req, res) => {
  const id = req.params.id;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Geçersiz fikstür ID." });
  }

  try {
    const rows = await apiGet(`/fixtures/statistics?fixture=${id}`);

    const teams = rows.map(row => ({
      team: row.team?.name || "Bilinmiyor",
      statistics: Object.fromEntries(
        (row.statistics || []).map(stat => [stat.type, stat.value])
      )
    }));

    let saved = false;

    if (pool && teams.length) {
      try {
        await initDatabase();
        await pool.query(
          `INSERT INTO match_stat_snapshots (fixture_id, teams)
           VALUES ($1, $2::jsonb)`,
          [id, JSON.stringify(teams)]
        );
        saved = true;
      } catch (error) {
        console.error("Snapshot save error:", error.message);
      }
    }

    res.json({
      source: "API-Football",
      fixtureId: Number(id),
      available: teams.length > 0,
      saved,
      teams
    });
  } catch (error) {
    console.error("Stats API error:", error.message);
    res.status(502).json({ error: "Maç istatistikleri alınamadı." });
  }
});

// Son 10 dakikanın istatistik kayıtları
app.get("/api/match/:id/history", async (req, res) => {
  const id = req.params.id;

  if (!/^\d+$/.test(id)) {
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
      [id]
    );

    res.json({
      fixtureId: Number(id),
      periodMinutes: 10,
      snapshots: result.rows.length,
      enoughData: result.rows.length >= 2,
      history: result.rows
    });
  } catch (error) {
    console.error("History error:", error.message);
    res.status(503).json({ error: "İstatistik geçmişi alınamadı." });
  }
});

// Takip edilen maçları listele
app.get("/api/tracked", async (_req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  try {
    await initDatabase();
    const result = await pool.query(
      `SELECT fixture_id, home_team, away_team, enabled_at
       FROM tracked_matches ORDER BY enabled_at DESC`
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
    console.error("Tracked matches error:", error.message);
    res.status(503).json({ error: "Takip listesi alınamadı." });
  }
});

// Bir maçı takibe al (en fazla 2 maç)
app.post("/api/match/:id/track", async (req, res) => {
  const id = req.params.id;
  const home = req.body?.home;
  const away = req.body?.away;

  if (!/^\d+$/.test(id)) {
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
      [id]
    );

    if (existing.rowCount) {
      await client.query("COMMIT");
      return res.json({ success: true, tracked: true });
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
      [id, home.trim(), away.trim()]
    );

    await client.query("COMMIT");
    res.json({ success: true, tracked: true });
  } catch (error) {
    if (client) {
      try { await client.query("ROLLBACK"); } catch {}
    }

    console.error("Track error:", error.message);
    res.status(503).json({ error: "Maç takibe alınamadı." });
  } finally {
    client?.release();
  }
});

// Maçı takipten çıkar
app.delete("/api/match/:id/track", async (req, res) => {
  const id = req.params.id;

  if (!/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Geçersiz fikstür ID." });
  }

  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  try {
    await initDatabase();
    await pool.query("DELETE FROM tracked_matches WHERE fixture_id = $1", [id]);
    res.json({ success: true, tracked: false });
  } catch (error) {
    console.error("Untrack error:", error.message);
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

    res.json({
      ready: result.rows[0].total > 0,
      totalMatches: result.rows[0].total,
      over25: result.rows[0].over25,
      under25: result.rows[0].under25,
      earliestDate: result.rows[0].earliest_date,
      latestDate: result.rows[0].latest_date,
      import: importResult
    });
  } catch (error) {
    console.error("Historical status error:", error.message);
    res.status(503).json({ error: "Geçmiş veri durumu alınamadı." });
  }
});

// Geçmiş oran özeti
app.get("/api/historical/summary", async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  const league = typeof req.query.league === "string"
    ? req.query.league.trim().slice(0, 20)
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
      source: "Historical CSV",
      league: league || null,
      note: "Geçmiş istatistikler canlı maç olasılığı garantisi değildir.",
      summary: result.rows[0]
    });
  } catch (error) {
    console.error("Historical summary error:", error.message);
    res.status(503).json({ error: "Geçmiş oran özeti alınamadı." });
  }
});

// Geçmiş maç kayıtları
app.get("/api/historical/matches", async (req, res) => {
  if (!pool) {
    return res.status(503).json({ error: "DATABASE_URL ayarlanmamış." });
  }

  const league = typeof req.query.league === "string"
    ? req.query.league.trim().slice(0, 20)
    : "";

  const requested = Number.parseInt(req.query.limit, 10);
  const limit = Number.isFinite(requested)
    ? Math.max(1, Math.min(requested, 100))
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
    console.error("Historical matches error:", error.message);
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
    console.error("Database status error:", error.message);
    res.status(503).json({
      connected: false,
      error: "Veritabanına bağlanılamadı."
    });
  }
});


app.get("/api/historical/similar", async (req, res) => {
  if (!pool) {
    return res.status(503).json({
      error: "DATABASE_URL ayarlanmamış."
    });
  }

  const over = Number(req.query.over);
  const under = Number(req.query.under);

  if (
    !Number.isFinite(over) ||
    !Number.isFinite(under) ||
    over <= 1 ||
    under <= 1 ||
    over > 20 ||
    under > 20
  ) {
    return res.status(400).json({
      error: "Geçerli over ve under oranları gir. Örnek: ?over=1.80&under=2.00"
    });
  }

  try {
    await initDatabase();

    const result = await pool.query(`
      WITH similar AS (
        SELECT
          id,
          match_date,
          home_team,
          away_team,
          b365_over25,
          b365_under25,
          total_goals,
          over25_result,
          ABS(b365_over25 - $1)
            + ABS(b365_under25 - $2) AS distance
        FROM historical_matches
        WHERE b365_over25 IS NOT NULL
          AND b365_under25 IS NOT NULL
          AND over25_result IN (0, 1)
          AND ABS(b365_over25 - $1) <= 0.20
          AND ABS(b365_under25 - $2) <= 0.20
        ORDER BY distance ASC
        LIMIT 100
      )
      SELECT
        COUNT(*)::int AS sample_size,
        COUNT(*) FILTER (WHERE over25_result = 1)::int AS over25,
        COUNT(*) FILTER (WHERE over25_result = 0)::int AS under25,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE over25_result = 1)
          / NULLIF(COUNT(*), 0),
          2
        ) AS over25_percent,
        ROUND(
          100.0 * COUNT(*) FILTER (WHERE over25_result = 0)
          / NULLIF(COUNT(*), 0),
          2
        ) AS under25_percent,
        ROUND(AVG(distance)::numeric, 3) AS average_odds_distance
      FROM similar
    `, [over, under]);

    const stats = result.rows[0];
    const sampleSize = stats.sample_size || 0;

    res.json({
      source: "WinScope historical database",
      market: "MS 2.5 Alt/Üst",
      inputOdds: { over, under },
      matchingRule: "İki açılış oranı için en fazla 0.20 fark",
      sampleSize,
      over25: stats.over25 || 0,
      under25: stats.under25 || 0,
      over25Percent: stats.over25_percent,
      under25Percent: stats.under25_percent,
      averageOddsDistance: stats.average_odds_distance,
      decision: sampleSize < 30
        ? "UZAK DUR - Yeterli benzer maç yok"
        : "Geçmiş örneklem mevcut; canlı istatistik ve diğer sinyaller ayrıca kontrol edilmeli",
      warning: "Geçmiş sonuçlar gelecekteki maç için garanti veya tek başına bahis önerisi değildir."
    });
  } catch (error) {
    console.error("Similar historical matches error:", error.message);
    res.status(503).json({
      error: "Benzer geçmiş maçlar sorgulanamadı."
    });
  }
});

app.listen(PORT, () => {
  console.log(`WinScope Live running on port ${PORT}`);
});
