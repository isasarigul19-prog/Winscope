// Minimal Node/Express backend starter. Keep API key on server, never in browser.
import express from "express";
const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_FOOTBALL_KEY;
app.use(express.static("public"));

app.get("/api/live", async (_req, res) => {
  if (!API_KEY) return res.status(503).json({ error: "Set API_FOOTBALL_KEY on the server first." });
  try {
    const r = await fetch("https://v3.football.api-sports.io/fixtures?live=all", {
      headers: { "x-apisports-key": API_KEY }
    });
    const payload = await r.json();
    if (!r.ok || payload.errors && Object.keys(payload.errors).length) {
      return res.status(502).json({ error: "Provider API error", details: payload.errors });
    }
    // First integration milestone: return raw fixtures to validate API connectivity.
    // Next: normalize fixture IDs, scores, elapsed minutes, statistics and odds into UI schema.
    res.json({ source: "API-Football", fetchedAt: new Date().toISOString(), results: payload.results, matches: [] });
  } catch (e) {
    res.status(502).json({ error: "Could not reach football data provider." });
  }
});
app.listen(PORT, () => console.log(`WinScore Live prototype running at http://localhost:${PORT}`));
