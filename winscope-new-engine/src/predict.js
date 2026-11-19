
import { extractMarketOdds, choosePreMatchSnapshot, normalizeTwoWay } from './odds.js';

const MIN_ODDS = 1.50;
const MAX_ODDS = 1.73;

const MARKETS = [
  { key: 'over25', label: 'MS 2.5 ÜST', oddsKey: 'over', priority: 1 },
  { key: 'btts', label: 'KG VAR', oddsKey: 'yes', priority: 2 },
  { key: 'homeOver15', label: 'EV 1.5 ÜST', oddsKey: 'over', priority: 3 },
  { key: 'awayOver15', label: 'DEP 1.5 ÜST', oddsKey: 'over', priority: 4 }
];

function validOdds(value) {
  return Number.isFinite(value) && value >= MIN_ODDS && value <= MAX_ODDS;
}

function getProbability(market, key) {
  if (key === 'yes') {
    const normalized = normalizeTwoWay(market.yes, market.no);
    return normalized?.over ?? null;
  }

  const normalized = normalizeTwoWay(market.over, market.under);
  return normalized?.over ?? null;
}

function poisson(lambda, goals) {
  if (!Number.isFinite(lambda) || lambda < 0) return 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= goals; i++) p *= lambda / i;
  return p;
}

function estimateGoals(totalOver25, homeOver15, awayOver15) {
  if (!totalOver25 || !homeOver15 || !awayOver15) return null;

  const target = totalOver25.over;
  const candidates = [];

  for (let home = 0.2; home <= 4.5; home += 0.05) {
    for (let away = 0.2; away <= 4.5; away += 0.05) {
      const total = home + away;
      let under25 = 0;

      for (let h = 0; h <= 2; h++) {
        for (let a = 0; a <= 2 - h; a++) {
          under25 += poisson(home, h) * poisson(away, a);
        }
      }

      const over25Probability = 1 - under25;
      const home15Probability = 1 - poisson(home, 0) - poisson(home, 1);
      const away15Probability = 1 - poisson(away, 0) - poisson(away, 1);

      const score =
        Math.abs(over25Probability - target) +
        Math.abs(home15Probability - homeOver15.over) +
        Math.abs(away15Probability - awayOver15.over);

      candidates.push({ home, away, total, score });
    }
  }

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];

  if (!best || best.score > 0.25) return null;

  return {
    expectedHomeGoals: Number(best.home.toFixed(2)),
    expectedAwayGoals: Number(best.away.toFixed(2)),
    expectedTotalGoals: Number(best.total.toFixed(2)),
    fitError: Number(best.score.toFixed(4))
  };
}

export function analyzeMatch({
  oddsRows,
  kickoffAt,
  form = null
}) {
  const snapshot = choosePreMatchSnapshot(oddsRows, kickoffAt);

  if (!snapshot) {
    return {
      status: 'UZAK_DUR',
      reason: 'Doğrulanmış maç önü oran kaydı bulunamadı.',
      picks: [],
      scorePrediction: null
    };
  }

  const markets = extractMarketOdds(snapshot.payload);
  const candidates = [];

  for (const definition of MARKETS) {
    const market = markets[definition.key];
    if (!market) continue;

    const odds = definition.oddsKey === 'yes'
      ? market.yes
      : market.over;

    if (!validOdds(odds)) continue;

    const probability = getProbability(market, definition.oddsKey);
    if (!Number.isFinite(probability)) continue;

    candidates.push({
      market: definition.label,
      probability,
      bookmaker: market.bookmaker,
      internalOdds: odds,
      priority: definition.priority
    });
  }

  candidates.sort((a, b) =>
    b.probability - a.probability ||
    a.priority - b.priority
  );

  const best = candidates[0];

  if (!best) {
    return {
      status: 'UZAK_DUR',
      reason: 'Uygun oran aralığında doğrulanmış tercih bulunamadı.',
      picks: [],
      scorePrediction: null
    };
  }

  const scorePrediction = estimateGoals(
    markets.over25,
    markets.homeOver15,
    markets.awayOver15
  );

  return {
    status: 'ADAY',
    mainPick: best.market,
    analysisScore: Number((best.probability * 100).toFixed(1)),
    confidence: 'KALİBRE EDİLMEDİ',
    picks: candidates.map(({ market, probability, bookmaker }) => ({
      market,
      probability: Number((probability * 100).toFixed(1)),
      bookmaker
    })),
    scorePrediction,
    halfTimeDataAvailable: Boolean(markets.htOver05),
    data: {
      snapshotTime: snapshot.captured_at ?? snapshot.capturedAt ?? null,
      bookmaker: best.bookmaker,
      formProvided: Boolean(form)
    },
    warnings: [
      'Olasılıklar piyasa oranlarından türetilmiştir; bağımsız başarı oranı değildir.',
      'Motor henüz geçmiş sonuçlarla kalibre edilmemiştir.',
      'Form verisi bu sürümde tahmin hesabına katılmamaktadır.'
    ]
  };
}
