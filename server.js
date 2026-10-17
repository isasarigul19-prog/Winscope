
import express from "express";
import pg from "pg";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const BASE_URL = "https://v3.football.api-sports.io";

const { Pool } = pg;

app.use(express.json());
app.use(express.static("public"));

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

// Veritabanı tablolarını oluştur
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
      `);

      return true;
    })().catch(error => {
      dbReady = null;
      console.error("Database initialization error:", error.message);
      throw error;
    });
  }

  return dbReady;
}

// API-Football isteği
async function apiGet(path) {
  if (!API_KEY) {
    throw new Error("API_FOOTBALL_KEY ayarlanmamış.");
  }

  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { "x-apisports-key": API_KEY },
    signal: AbortSignal.timeout(12000)
  });

  const payload = await response.json();

  if (
    !response.ok ||
    Object.keys(payload.errors || {}).length > 0
  ) {
    console.error("API-Football response error:", payload.errors);
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

// Maç istatistiklerini getir ve veritabanına kaydet
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

// Son 10 dakikadaki istatistik kayıtları
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

// Takip edilen maçları listele
app.get("/api/tracked", async (_req, res) => {
  if (!pool) {
    return res.status(503).json({
      error: "DATABASE_URL ayarlanmamış."
    });
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
    console.error("Tracked matches error:", error.message);
    res.status(503).json({
      error: "Takip listesi alınamadı."
    });
  }
});

// Bir maçı takibe al
app.post("/api/match/:id/track", async (req, res) => {
  const fixtureId = req.params.id;
  const home = req.body?.home;
  const away = req.body?.away;

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

    // Aynı anda gelen isteklerin 2 maç sınırını aşmasını önle
    await client.query(
      "SELECT pg_advisory_xact_lock($1)",
      [735219]
    );

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
        error: "En fazla 2 maç takip edilebilir. Önce bir maçın takibini bırak."
      });
    }

    await client.query(
      `INSERT INTO tracked_matches
         (fixture_id, home_team, away_team)
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
      try {
        await client.query("ROLLBACK");
      } catch {}
    }

    console.error("Track match error:", error.message);
    res.status(503).json({
      error: "Maç takibe alınamadı."
    });
  } finally {
    client?.release();
  }
});

// Takipten çıkar
app.delete("/api/match/:id/track", async (req, res) => {
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

    await pool.query(
      "DELETE FROM tracked_matches WHERE fixture_id = $1",
      [fixtureId]
    );

    res.json({
      success: true,
      tracked: false,
      message: "Maç takip listesinden çıkarıldı."
    });
  } catch (error) {
    console.error("Untrack match error:", error.message);
    res.status(503).json({
      error: "Maç takipten çıkarılamadı."
    });
  }
});

// Veritabanı bağlantısını kontrol et
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
  } catch (error) {
    console.error("Database status error:", error.message);

    res.status(503).json({
      connected: false,
      error: "Veritabanına bağlanılamadı."
    });
  }
});

app.listen(PORT, () => {
  console.log(`WinScope Live running on port ${PORT}`);
});
