
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE_URL = "https://v3.football.api-sports.io";

app.use(express.static("public"));

async function apiGet(path) {
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

app.get("/api/live", async (_req, res) => {
  if (!API_KEY) {
    return res.status(503).json({
      error: "API_FOOTBALL_KEY ayarlanmamış."
    });
  }

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

// İstatistikleri yalnızca istenen maç için getir.
app.get("/api/match/:id/stats", async (req, res) => {
  if (!API_KEY) {
    return res.status(503).json({
      error: "API anahtarı eksik."
    });
  }

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

    res.json({
      source: "API-Football",
      fixtureId: Number(fixtureId),
      available: teams.length > 0,
      teams
    });
  } catch (error) {
    console.error("Stats API error:", error.message);
    res.status(502).json({
      error: "Maç istatistikleri alınamadı."
    });
  }
});

app.listen(PORT, () => {
  console.log(`WinScore Live running on port ${PORT}`);
});
