
import express from "express";

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;

app.use(express.static("public"));

app.get("/api/live", async (_req, res) => {
  if (!API_KEY) {
    return res.status(503).json({
      error: "API_FOOTBALL_KEY is not configured."
    });
  }

  try {
    const response = await fetch(
      "https://v3.football.api-sports.io/fixtures?live=all",
      {
        headers: {
          "x-apisports-key": API_KEY
        }
      }
    );

    const payload = await response.json();

    if (!response.ok || Object.keys(payload.errors || {}).length) {
      return res.status(502).json({
        error: "Provider API error",
        details: payload.errors
      });
    }

    const matches = (payload.response || []).map((item) => ({
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
      results: payload.results,
      matches
    });
  } catch (error) {
    console.error("Live API error:", error.message);

    res.status(502).json({
      error: "Could not reach football data provider."
    });
  }
});

app.listen(PORT, () => {
  console.log(`WinScore Live running on port ${PORT}`);
});

