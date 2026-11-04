import type { BookLevel } from './polymarket.ts';

/**
 * What a trade really costs: walking the book for slippage, the taker fee, the break-even win probability, and the loss of leaving at once.
 * Fee schedule (docs.polymarket.com/trading/fees, checked 2026-11-03): fee = shares x rate x p x (1 - p), paid by the taker only; resting orders pay nothing.
 * The category of a market comes from its tags, so the rate is an ESTIMATE when tags are missing or mixed: check the market's page before trading size.
 */

export type FeeCategory = 'crypto' | 'sports' | 'geopolitics' | 'mentions' | 'politics' | 'finance' | 'tech' | 'economics' | 'culture' | 'weather' | 'other';

export const FEE_RATES: Record<FeeCategory, number> = {
  crypto: 0.07, sports: 0.05, economics: 0.05, culture: 0.05, weather: 0.05, other: 0.05, finance: 0.04, politics: 0.04, mentions: 0.04, tech: 0.04, geopolitics: 0,
};

/** First match wins; a tag list that fits no category is 'other'. */
const TAG_TO_CATEGORY: Array<[FeeCategory, readonly string[]]> = [
  ['crypto', ['crypto', 'bitcoin', 'ethereum', 'solana', 'crypto-prices', 'up-or-down']],
  ['sports', ['sports', 'esports', 'games', 'soccer', 'nba', 'nfl', 'nhl', 'mlb', 'tennis', 'cricket', 'ufc', 'f1', 'counter-strike-2', 'league-of-legends', 'dota-2', 'valorant']],
  ['geopolitics', ['geopolitics', 'world', 'middle-east', 'ukraine', 'russia', 'israel', 'iran', 'china', 'foreign-policy']],
  ['mentions', ['mentions', 'tweet-markets', 'earnings-mentions']],
  ['politics', ['politics', 'elections', 'us-politics', 'trump', 'midterms', 'global-elections']],
  ['finance', ['finance', 'stocks', 'earnings', 'ipos', 'commodities', 'indicies', 'indices']],
  ['tech', ['tech', 'ai', 'big-tech']],
  ['economics', ['economy', 'economics', 'fed', 'inflation', 'jobs', 'fed-rates', 'economic-policy']],
  ['culture', ['culture', 'pop-culture', 'movies', 'music', 'awards', 'celebrities']],
  ['weather', ['weather', 'daily-temperature', 'highest-temperature', 'climate-science']],
];

export function feeCategory(tags: readonly string[]): FeeCategory {
  const set = new Set(tags.map((t) => t.toLowerCase()));
  for (const [cat, keys] of TAG_TO_CATEGORY) if (keys.some((k) => set.has(k))) return cat;
  return 'other';
}

export const takerFee = (shares: number, price: number, rate: number): number => shares * rate * price * (1 - price);

export interface Quote {
  /** Dollars of shares actually bought (before fees); less than asked when the book is too thin. */
  spent: number;
  shares: number;
  avgPrice: number;
  bestPrice: number;
  /** Average price minus the best price, in cents per share. */
  slippageCents: number;
  fee: number;
  /** spent + fee. */
  paid: number;
  /** Probability the outcome must have for this trade to break even (paid / shares). */
  breakEven: number;
  thin: boolean;
}

/** Spends up to `usd` on the levels (best first), fee included in the result. Levels are priced per share. */
export function buyQuote(levels: readonly BookLevel[], usd: number, rate: number): Quote | null {
  let left = usd;
  let shares = 0;
  let spent = 0;
  let fee = 0;
  for (const l of levels) {
    if (left <= 1e-9) break;
    if (!(l.price > 0 && l.price < 1) || !(l.size > 0)) continue;
    const take = Math.min(l.size, left / l.price);
    shares += take;
    spent += take * l.price;
    fee += takerFee(take, l.price, rate);
    left -= take * l.price;
  }
  if (shares <= 0) return null;
  const best = levels.find((l) => l.price > 0 && l.price < 1 && l.size > 0)!.price;
  const avg = spent / shares;
  return { spent, shares, avgPrice: avg, bestPrice: best, slippageCents: (avg - best) * 100, fee, paid: spent + fee, breakEven: (spent + fee) / shares, thin: left > usd * 0.05 };
}

/** Selling `shares` into the bids (best first) as a taker: proceeds after fees. */
export function sellProceeds(levels: readonly BookLevel[], shares: number, rate: number): { proceeds: number; sold: number } {
  let left = shares;
  let proceeds = 0;
  for (const l of levels) {
    if (left <= 1e-9) break;
    if (!(l.price > 0 && l.price < 1) || !(l.size > 0)) continue;
    const take = Math.min(l.size, left);
    proceeds += take * l.price - takerFee(take, l.price, rate);
    left -= take;
  }
  return { proceeds, sold: shares - left };
}

/** The other side of a binary market as a book: buying NO means selling into the YES bids at (1 - price). */
export const invert = (levels: readonly BookLevel[]): BookLevel[] => levels.map((l) => ({ price: 1 - l.price, size: l.size })).sort((a, b) => a.price - b.price);

export interface CostLine {
  side: 'YES' | 'NO';
  usd: number;
  quote: Quote | null;
  /** Fraction of `paid` lost if the shares were sold straight back into the bids as a taker; null when nothing could be bought. */
  exitLoss: number | null;
}

/** Cost of buying `usd` of YES and of NO from the YES book (bids best-first, asks best-first). */
export function costLines(book: { bids: readonly BookLevel[]; asks: readonly BookLevel[] }, usd: number, rate: number): CostLine[] {
  const noAsks = invert(book.bids);
  const noBids = invert(book.asks).sort((a, b) => b.price - a.price);
  const mk = (side: 'YES' | 'NO', asks: readonly BookLevel[], bids: readonly BookLevel[]): CostLine => {
    const quote = buyQuote(asks, usd, rate);
    if (!quote) return { side, usd, quote: null, exitLoss: null };
    const out = sellProceeds(bids, quote.shares, rate);
    return { side, usd, quote, exitLoss: out.sold < quote.shares * 0.999 ? null : 1 - out.proceeds / quote.paid };
  };
  return [mk('YES', book.asks, book.bids), mk('NO', noAsks, noBids)];
}

const c2 = (x: number): string => `${(x * 100).toFixed(1)}`;
export function formatCost(line: CostLine): string {
  if (!line.quote) return `${line.side}: nothing to buy at this size`;
  const q = line.quote;
  const thin = q.thin ? ` (book holds only $${Math.round(q.spent)} of the $${line.usd})` : '';
  const exit = line.exitLoss === null ? 'selling straight back is not possible at this size' : `selling straight back would lose ${(line.exitLoss * 100).toFixed(1)}%`;
  return `${line.side} $${line.usd}: ${Math.round(q.shares).toLocaleString('en-US')} shares at avg ${c2(q.avgPrice)}c (best ${c2(q.bestPrice)}c, slippage ${q.slippageCents.toFixed(1)}c), fee ${((q.fee / q.shares) * 100).toFixed(2)}c a share, needs a ${c2(q.breakEven)}% chance to break even; ${exit}${thin}`;
}
