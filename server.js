
import express from "express";
import pg from "pg";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = "https://v3.football.api-sports.io";

app.use(express.static("public"));

const { Pool } = pg;

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

async function initDatabase() {
  if (!pool) return false;

  if (!dbReady) {
    dbReady = pool.query(`
      CREATE TABLE IF NOT EXISTS match_stat_snapshots (
        id BIGSERIAL PRIMARY KEY,
        fixture_id BIGINT NOT NULL,
        captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        teams JSONB NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_match_snapshots_fixture_time
      ON match_stat_snapshots (fixture_id, captured_at DESC);
    `).then(() => true).catch(error => {
      dbReady = null;
      console.error("Database initialization error:", error.message);
      throw error;
    });
  }

  return dbReady;
}

async function apiGet(path) {
  if (!API_KEY) {
    throw new Error("API_FOOTBALL_KEY ayarlanmamış.");
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-apisports-key": API_KEY },
    signal: AbortSignal.timeout(12000)
  });

  const payload = await response.json();

  if (!response.ok ||
      Object.keys(payload.errors || {}).length > 0) {
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
    console.error("Live API error:", error.message);
    res.status(502).json({
      error: "Canlı maçlar alınamadı."
    });
  }
});

// İstatistikleri getir ve veritabanına kaydet
app.get("/api/match/:id/stats", async (req, res) => {
  const fixtureId = req.params.id;

  if (!/^\d+$/.test(fixtureId)) {
    return res.status(400).json({
      error: "Geçersiz fikstür ID."
    });
  }

  try {
    const rows = await apiGet(
      `/fixtures/statistics?fixture=${fixtureId}`
    );

    const teams = rows.map(row => ({
      team: row.team?.name || "Bilinmiyor",
      statistics: Object.fromEntries(
        (row.statistics || []).map(stat => [
          stat.type,
          stat.value
        ])
      )
    }));

    let saved = false;

    if (pool && teams.length > 0) {
      try {
        await initDatabase();

        await pool.query(
          `INSERT INTO match_stat_snapshots
             (fixture_id, teams)
           VALUES ($1, $2::jsonb)`,
          [fixtureId, JSON.stringify(teams)]
        );

        saved = true;
      } catch (dbError) {
        // Kayıt hatası, canlı istatistik yanıtını engellemez.
        console.error("Snapshot save error:", dbError.message);
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
    console.error("Stats API error:", error.message);
    res.status(502).json({
      error: "Maç istatistikleri alınamadı."
    });
  }
});

// Son 10 dakikadaki kayıtları getir
app.get("/api/match/:id/history", async (req, res) => {
  const fixtureId = req.params.id;

  if (!/^\d+$/.test(fixtureId)) {
    return res.status(400).json({
      error: "Geçersiz fikstür ID."
    });
  }

  if (!pool) {
    return res.status(503).json({
      error: "DATABASE_URL ayarlanmamış."
    });
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
    console.error("History query error:", error.message);
    res.status(503).json({
      error: "İstatistik geçmişi şu anda alınamıyor."
    });
  }
});

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

    res.json({
      connected: true,
      database: "PostgreSQL"
    });
  } catch {
    res.status(503).json({
      connected: false,
      error: "Veritabanına bağlanılamadı."
    });
  }
});

app.listen(PORT, () => {
  console.log(`WinScope Live running on port ${PORT}`);
});
