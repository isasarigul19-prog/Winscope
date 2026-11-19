import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTwoWay, extractBookmakerMarkets, extractMarketOdds, choosePreMatchSnapshot, analyzePreMatch } from '../src/index.js';

const apiFixturePayload = { bookmakers: [{ id: 8, name: 'Bet365', bets: [
  { id: 5, name: 'Goals Over/Under', values: [{ value: 'Over 2.5', odd: '1.62' }, { value: 'Under 2.5', odd: '2.20' }] },
  { id: 6, name: 'Goals Over/Under First Half', values: [{ value: 'Over 0.5', odd: '1.30' }, { value: 'Under 0.5', odd: '3.20' }] },
  { id: 8, name: 'Both Teams Score', values: [{ value: 'Yes', odd: '1.65' }, { value: 'No', odd: '2.10' }] },
  { id: 16, name: 'Total - Home', values: [{ value: 'Over 1.5', odd: '1.60' }, { value: 'Under 1.5', odd: '2.20' }] },
  { id: 17, name: 'Total - Away', values: [{ value: 'Over 1.5', odd: '1.70' }, { value: 'Under 1.5', odd: '2.00' }] }
]}] };

test('two-way market probabilities are normalized', () => {
  const p = normalizeTwoWay(1.60, 2.30);
  assert.ok(p.over > 0 && p.under > 0);
  assert.ok(Math.abs(p.over + p.under - 1) < 1e-10);
});

test('Bet365 is preferred when present', () => {
  const payload = { response: [{ bookmakers: [
    { name: 'OtherBook', bets: [{ name: 'Goals Over/Under', id: 5, values: [{ value: 'Over 2.5', odd: '1.55' }, { value: 'Under 2.5', odd: '2.4' }] }] },
    { name: 'Bet365', bets: [{ name: 'Goals Over/Under', id: 5, values: [{ value: 'Over 2.5', odd: '1.62' }, { value: 'Under 2.5', odd: '2.2' }] }] }
  ] }] };
  assert.equal(extractBookmakerMarkets(payload)[0].bookmaker, 'Bet365');
  assert.equal(extractMarketOdds(payload).over25.over, 1.62);
});

test('extracts all four requested markets from actual API-Football market IDs', () => {
  const odds = extractMarketOdds(apiFixturePayload);
  assert.equal(odds.over25.over, 1.62);
  assert.equal(odds.btts.yes, 1.65);
  assert.equal(odds.homeOver15.over, 1.60);
  assert.equal(odds.awayOver15.over, 1.70);
  assert.equal(odds.htOver05.over, 1.30);
});

test('pre-match snapshot excludes captures at or after kickoff', () => {
  const rows = [
    { captured_at: '2026-11-01T10:00:00Z', payload: { id: 1 } },
    { captured_at: '2026-11-01T12:00:00Z', payload: { id: 2 } }
  ];
  assert.equal(choosePreMatchSnapshot(rows, '2026-11-01T12:00:00Z').payload.id, 1);
});

test('odds outside requested value range are not recommended', () => {
  const result = analyzePreMatch({ fixture: { id: 1, home: 'A', away: 'B' }, kickoffAt: '2026-11-01T12:00:00Z', capturedAt: '2026-11-01T10:00:00Z', odds: { over25: { over: 1.42, under: 3.0, bookmaker: 'Bet365' } } });
  assert.equal(result.status, 'UZAK_DUR');
  assert.equal(result.mainPick, null);
});

test('missing or post-kickoff prematch proof returns UZAK_DUR', () => {
  const result = analyzePreMatch({ fixture: { id: 1, home: 'A', away: 'B' }, kickoffAt: '2026-11-01T12:00:00Z', capturedAt: '2026-11-01T13:00:00Z', odds: {} });
  assert.equal(result.status, 'UZAK_DUR');
});

test('odds are not exposed in user-facing candidates and score is withheld without team markets', () => {
  const result = analyzePreMatch({ fixture: { id: 1, home: 'A', away: 'B' }, kickoffAt: '2026-11-01T12:00:00Z', capturedAt: '2026-11-01T10:00:00Z', odds: { over25: { over: 1.62, under: 2.2, bookmaker: 'Bet365' } } });
  assert.equal(result.status, 'ADAY');
  assert.equal('oddsInternal' in result.candidates[0], false);
  assert.equal(result.scores.fulltime, null);
});

test('score estimate is produced only when both team-goal markets are available', () => {
  const odds = extractMarketOdds(apiFixturePayload);
  const result = analyzePreMatch({ fixture: { id: 2, home: 'Home', away: 'Away' }, kickoffAt: '2026-11-01T12:00:00Z', capturedAt: '2026-11-01T10:00:00Z', odds });
  assert.ok(result.scores.fulltime);
  assert.equal(result.modelInputs.preMatchOddsOnly, true);
});

test('accepts Neon JSONB payload serialized as a string', () => {
  const odds = extractMarketOdds(JSON.stringify(apiFixturePayload));
  assert.equal(odds.over25.over, 1.62);
  assert.equal(odds.awayOver15.over, 1.70);
});
