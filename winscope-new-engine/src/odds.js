const BET365 = /bet\s*365|bet365/i;

export function toDecimal(value) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 1 && n < 1000 ? n : null;
}

export function impliedProbability(odds) {
  const n = toDecimal(odds);
  return n ? 1 / n : null;
}

export function normalizeTwoWay(overOdds, underOdds) {
  const over = impliedProbability(overOdds);
  const under = impliedProbability(underOdds);
  if (!over || !under) return null;
  const sum = over + under;
  return { over: over / sum, under: under / sum, overround: sum - 1 };
}

function getBookmakers(payload) {
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return []; }
  }
  if (Array.isArray(payload)) return payload.flatMap(x => x?.bookmakers ?? []);
  if (Array.isArray(payload?.response)) return payload.response.flatMap(x => x?.bookmakers ?? []);
  if (Array.isArray(payload?.bookmakers)) return payload.bookmakers;
  if (Array.isArray(payload?.payload?.bookmakers)) return payload.payload.bookmakers;
  if (payload?.response?.bookmakers) return payload.response.bookmakers;
  return [];
}

export function extractBookmakerMarkets(payload, preferred = 'Bet365') {
  const books = getBookmakers(payload);
  const sorted = [...books].sort((a, b) => Number(BET365.test(b?.name)) - Number(BET365.test(a?.name)));
  const out = [];
  for (const book of sorted) {
    for (const bet of book?.bets ?? []) {
      const values = (bet?.values ?? []).map(v => ({ label: String(v?.value ?? '').trim(), odds: toDecimal(v?.odd) })).filter(v => v.label && v.odds);
      if (values.length) out.push({ bookmaker: book?.name ?? 'Unknown', betName: bet?.name ?? '', betId: Number(bet?.id) || null, values });
    }
  }
  if (preferred && out.some(x => BET365.test(x.bookmaker))) return out.filter(x => BET365.test(x.bookmaker));
  return out;
}

const norm = s => String(s ?? '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
function findMarket(markets, { ids, names }) {
  return markets.find(m => ids.includes(m.betId) || names.some(re => re.test(norm(m.betName))));
}
function findValue(bet, re) { return bet?.values.find(v => re.test(norm(v.label))); }
function pair(bet, overRe, underRe) {
  const over = findValue(bet, overRe), under = findValue(bet, underRe);
  return over && under ? { over: over.odds, under: under.odds, bookmaker: bet.bookmaker, market: bet.betName } : null;
}

export function extractMarketOdds(payload) {
  const markets = extractBookmakerMarkets(payload);
  const defs = [
    ['over25', { ids: [5], names: [/goals? over\/under/, /total goals/] }, /^over\s*2\.5$/, /^under\s*2\.5$/],
    ['btts', { ids: [8], names: [/both teams score/, /both teams to score/, /gg\/ng/] }, /^(yes|gg)$/, /^(no|ng)$/],
    ['homeOver15', { ids: [16], names: [/total\s*-\s*home/, /home team goals?/, /team goals.*home/] }, /^over\s*1\.5$/, /^under\s*1\.5$/],
    ['awayOver15', { ids: [17], names: [/total\s*-\s*away/, /away team goals?/, /team goals.*away/] }, /^over\s*1\.5$/, /^under\s*1\.5$/],
    ['htOver05', { ids: [6], names: [/goals over\/under.*first half/, /first half.*goals over\/under/] }, /^over\s*0\.5$/, /^under\s*0\.5$/]
  ];
  const result = {};
  for (const [key, selector, overRe, underRe] of defs) {
    const bet = findMarket(markets, selector);
    const value = pair(bet, overRe, underRe);
    if (value) result[key] = key === 'btts'
      ? { yes: value.over, no: value.under, bookmaker: value.bookmaker, market: value.market }
      : value;
  }
  return result;
}

export function choosePreMatchSnapshot(rows, kickoffAt) {
  const kickoff = new Date(kickoffAt).getTime();
  if (!Number.isFinite(kickoff)) return null;
  const valid = (rows ?? []).map(row => ({ ...row, capturedMs: new Date(row.captured_at ?? row.capturedAt ?? row.timestamp).getTime() }))
    .filter(row => Number.isFinite(row.capturedMs) && row.capturedMs < kickoff && row.payload);
  valid.sort((a, b) => b.capturedMs - a.capturedMs);
  return valid[0] ?? null;
}
