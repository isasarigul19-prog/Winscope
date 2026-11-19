
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
  if (Array.isArray(payload)) return payload.flatMap(x => x?.bookmakers ?? []);
  if (Array.isArray(payload?.response)) return payload.response.flatMap(x => x?.bookmakers ?? []);
  if (Array.isArray(payload?.bookmakers)) return payload.bookmakers;
  if (payload?.response?.bookmakers) return payload.response.bookmakers;
  return [];
}

export function extractBookmakerMarkets(payload, preferred = 'Bet365') {
  const books = getBookmakers(payload);
  const sorted = [...books].sort((a, b) =>
    Number(BET365.test(b?.name)) - Number(BET365.test(a?.name))
  );
  const out = [];

  for (const book of sorted) {
    for (const bet of book?.bets ?? []) {
      const values = (bet?.values ?? [])
        .map(v => ({
          label: String(v?.value ?? '').trim(),
          odds: toDecimal(v?.odd)
        }))
        .filter(v => v.label && v.odds);

      if (values.length) {
        out.push({
          bookmaker: book?.name ?? 'Unknown',
          betName: bet?.name ?? '',
          betId: bet?.id ?? null,
          values
        });
      }
    }
  }

  if (preferred && out.some(x => BET365.test(x.bookmaker))) {
    return out.filter(x => BET365.test(x.bookmaker));
  }
  return out;
}

function findBet(markets, regex) {
  return markets.find(m => regex.test(m.betName));
}

function findValue(bet, regex) {
  return bet?.values.find(v => regex.test(v.label));
}

export function extractMarketOdds(payload) {
  const markets = extractBookmakerMarkets(payload);
  const result = {};

  const definitions = [
    ['over25', /over\/under\s*2\.5|goals? over\/under\s*2\.5|total goals/i, /^(over(?:\s*2\.5)?|2\.5\s*\+|yes)$/i, /^(under(?:\s*2\.5)?|2\.5\s*-|no)$/i],
    ['btts', /both teams score|both teams to score|gg\/ng/i, /^(yes|gg)$/i, /^(no|ng)$/i],
    ['homeOver15', /home team goals|team goals.*home|home.*over\/under/i, /^(over\s*1\.5|1\.5\s*\+)$/i, /^(under\s*1\.5|1\.5\s*-)$/i],
    ['awayOver15', /away team goals|team goals.*away|away.*over\/under/i, /^(over\s*1\.5|1\.5\s*\+)$/i, /^(under\s*1\.5|1\.5\s*-)$/i],
    ['htOver05', /1st half.*over\/under|first half.*over\/under|half time.*over\/under/i, /^(over\s*0\.5|0\.5\s*\+)$/i, /^(under\s*0\.5|0\.5\s*-)$/i]
  ];

  for (const [key, betRegex, overRegex, underRegex] of definitions) {
    const bet = findBet(markets, betRegex);
    const over = findValue(bet, overRegex);
    const under = findValue(bet, underRegex);

    if (over && under) {
      result[key] = {
        over: over.odds,
        under: under.odds,
        bookmaker: bet.bookmaker,
        market: bet.betName
      };
    }
  }

  if (result.btts?.over) {
    result.btts = {
      yes: result.btts.over,
      no: result.btts.under,
      bookmaker: result.btts.bookmaker,
      market: result.btts.market
    };
  }

  return result;
}

export function choosePreMatchSnapshot(rows, kickoffAt) {
  const kickoff = new Date(kickoffAt).getTime();
  if (!Number.isFinite(kickoff)) return null;

  const valid = (rows ?? [])
    .map(row => ({
      ...row,
      capturedMs: new Date(
        row.captured_at ?? row.capturedAt ?? row.timestamp
      ).getTime()
    }))
    .filter(row =>
      Number.isFinite(row.capturedMs) &&
      row.capturedMs < kickoff &&
      row.payload
    );

  valid.sort((a, b) => b.capturedMs - a.capturedMs);
  return valid[0] ?? null;
}

