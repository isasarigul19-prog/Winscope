import test from "node:test";
import assert from "node:assert/strict";
import { predictScore } from "../score-engine-v2.js";

const homeForm = {
  available: true,
  recentSampleSize: 5,
  avgGoalsFor: 1.8,
  avgGoalsAgainst: 0.8,
  htAvgGoalsFor: 0.6,
  htSampleSize: 5
};
const awayForm = {
  available: true,
  recentSampleSize: 5,
  avgGoalsFor: 1.2,
  avgGoalsAgainst: 1.4,
  htAvgGoalsFor: 0.4,
  htSampleSize: 5
};
const markets = {
  "MS 1.5 ÜST": 0.78,
  "MS 2.5 ÜST": 0.57,
  "MS 3.5 ÜST": 0.32,
  "MS 4.5 ÜST": 0.16,
  "KG VAR": 0.55,
  "EV 1.5 ÜST": 0.51,
  "DEP 1.5 ÜST": 0.30,
  "İY 0.5 ÜST": 0.68,
  "İY 1.5 ÜST": 0.28
};
const outcome = { home: 0.52, draw: 0.26, away: 0.22 };

test("V2 produces valid HT/FT scores and bounded probabilities", () => {
  const result = predictScore({ fixture: { id: 101 }, homeForm, awayForm, markets, outcome });
  assert.match(result.fullTimeScore, /^\d+-\d+ \(tahmin\)$/);
  assert.match(result.halfTimeScore, /^\d+-\d+ \(tahmin\)$/);
  assert.ok(result.scoreProbability >= 0 && result.scoreProbability <= 1);
  assert.ok(result.sixPlusProbability >= 0 && result.sixPlusProbability <= 1);
  assert.equal(result.modelVersion, "V2_ODDS_PROFILE_NEIGHBORS");
  assert.equal(result.historicalNeighborsUsed, false);
});

test("V2 uses only sufficiently large historical-neighbor samples", () => {
  const small = Array.from({ length: 24 }, () => ({ homeGoals: 2, awayGoals: 1, similarity: 1 }));
  const result = predictScore({ homeForm, awayForm, markets, outcome, historicalSamples: small });
  assert.equal(result.historicalNeighborsUsed, false);
  assert.equal(result.historicalNeighborSampleSize, 0);
});

test("V2 can blend 25 or more supplied historical neighbors", () => {
  const samples = Array.from({ length: 25 }, (_, i) => ({
    homeGoals: i % 3,
    awayGoals: (i + 1) % 2,
    similarity: 0.8
  }));
  const result = predictScore({ homeForm, awayForm, markets, outcome, historicalSamples: samples });
  assert.equal(result.historicalNeighborsUsed, true);
  assert.equal(result.historicalNeighborSampleSize, 25);
});
