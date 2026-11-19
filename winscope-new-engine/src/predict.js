import { normalizeTwoWay, toDecimal } from './odds.js';

const MIN_ODDS = 1.50;
const MAX_ODDS = 1.73;
const MARKET_ORDER = ['awayOver15', 'homeOver15', 'over25', 'btts'];
const LABELS = { awayOver15: 'DEP 1.5 ÜST', homeOver15: 'EV 1.5 ÜST', over25: 'MS 2.5 ÜST', btts: 'KG VAR' };

function poisson(lambda, k) {
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}
function overProbability(lambda, line) {
  let under = 0;
  for (let k = 0; k <= Math.floor(line); k++) under += poisson(lambda, k);
  return 1 - under;
}
function estimateLambda(over, under, line) {
  const market = normalizeTwoWay(over, under);
  if (!market) return null;
  let best = { lambda: null, error: Infinity };
  for (let l = 0.10; l <= 5; l += 0.002) {
    const error = Math.abs(overProbability(l, line) - market.over);
    if (error < best.error) best = { lambda: l, error };
  }
  return best.error <= 0.025 ? best.lambda : null;
}
function topScore(homeLambda, awayLambda) {
  let best = null;
  for (let h = 0; h <= 8; h++) for (let a = 0; a <= 8; a++) {
    const probability = poisson(homeLambda, h) * poisson(awayLambda, a);
    if (!best || probability > best.probability) best = { home: h, away: a, probability };
  }
  return best;
}
function getTwoWay(market, key) {
  if (!market) return null;
  return key === 'btts' ? normalizeTwoWay(market.yes, market.no) : normalizeTwoWay(market.over, market.under);
}

export function analyzePreMatch({ fixture, odds, kickoffAt, capturedAt, form = null }) {
  const reasons = [];
  const invalid = reason => ({ status: 'UZAK_DUR', reason, candidates: [], mainPick: null, alternative: null, scores: { halftime: null, fulltime: null }, analysisScore: 0 });
  if (!fixture?.id || !fixture?.home || !fixture?.away) return invalid('Maç kimliği veya takım bilgisi eksik.');
  const kick = new Date(kickoffAt).getTime(), capture = new Date(capturedAt).getTime();
  if (!Number.isFinite(kick) || !Number.isFinite(capture) || capture >= kick) return invalid('Maç öncesi olduğu doğrulanmış oran görüntüsü yok.');

  const candidates = [];
  for (const key of MARKET_ORDER) {
    const market = odds?.[key];
    const price = toDecimal(key === 'btts' ? market?.yes : market?.over);
    const normalized = getTwoWay(market, key);
    if (!price || price < MIN_ODDS || price > MAX_ODDS || !normalized) continue;
    candidates.push({ key, label: LABELS[key], oddsInternal: price, probability: normalized.over, bookmaker: market.bookmaker ?? 'Bilinmeyen kaynak' });
  }
  candidates.sort((a, b) => b.probability - a.probability);
  if (!candidates.length) reasons.push('1.50–1.73 aralığında, iki tarafı da doğrulanmış uygun pazar bulunamadı.');

  // Correct-score estimate is emitted only when both team-goal markets exist.
  const home = odds?.homeOver15, away = odds?.awayOver15;
  const homeLambda = home ? estimateLambda(home.over, home.under, 1.5) : null;
  const awayLambda = away ? estimateLambda(away.over, away.under, 1.5) : null;
  const ft = homeLambda != null && awayLambda != null ? topScore(homeLambda, awayLambda) : null;
  const htLambda = odds?.htOver05 ? estimateLambda(odds.htOver05.over, odds.htOver05.under, 0.5) : null;
  const ht = htLambda == null ? null : { totalGoalsMostLikely: overProbability(htLambda, 0.5) >= 0.5 ? 1 : 0, home: null, away: null, method: 'İY toplam gol piyasası; takım dağılımı bilinmiyor' };

  if (!ft) reasons.push('İY/MS takım skorunu destekleyecek yeterli takım gol oranı yok; skor tahmini üretilmedi.');
  if (!form) reasons.push('Son 5 maç formu sağlanmadı; form etkisi puana katılmadı.');
  const best = candidates[0] ?? null;
  // Score is deliberately a market-implied indicator, not a calibrated confidence rating.
  const analysisScore = best ? Math.round(best.probability * 1000) / 10 : 0;
  return {
    status: best ? 'ADAY' : 'UZAK_DUR', fixture,
    mainPick: best ? { market: best.label, probability: best.probability, bookmaker: best.bookmaker } : null,
    alternative: candidates[1] ? { market: candidates[1].label, probability: candidates[1].probability, bookmaker: candidates[1].bookmaker } : null,
    candidates: candidates.map(({ oddsInternal, ...safe }) => safe),
    analysisScore,
    scores: { halftime: ht, fulltime: ft ? { home: ft.home, away: ft.away, probability: ft.probability, method: 'Poisson market-implied; experimental, not calibrated' } : null },
    modelInputs: { preMatchOddsOnly: true, formProvided: Boolean(form), formUsed: false, homeGoalMarket: homeLambda != null, awayGoalMarket: awayLambda != null },
    reasons
  };
}
