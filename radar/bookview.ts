import { buyQuote, sellProceeds, FEE_RATES, feeCategory } from './cost.ts';
import { summarizeBook, type BookSummary } from './marketinfo.ts';
import { NotFoundError, type Book, type PolymarketClient } from './polymarket.ts';
import type { TradeRow } from './store.ts';

/** Live order book of one market: the ladder, the spread, depth, and what $50 / $500 would cost right now. Refreshed every few seconds while the tab is open. */

export interface BookView {
  slug: string;
  cid: string;
  question: string;
  outcomes: [string, string];
  book: Book | null;
  summary: BookSummary | null;
  feeRate: number;
  fetchedAt: number | null;
  error: string | null;
  /** Latest fills of the market, newest first (the tape). */
  trades: TradeRow[];
}

export async function loadBook(client: PolymarketClient, slug: string, cid: string, now: () => number = Date.now): Promise<BookView> {
  const view: BookView = { slug, cid, question: '', outcomes: ['Yes', 'No'], book: null, summary: null, feeRate: FEE_RATES.other, fetchedAt: null, error: null, trades: [] };
  try {
    const ev = await client.eventBySlug(slug);
    const m = ev?.markets.find((x) => x.cid === cid) ?? ev?.markets[0];
    if (!ev || !m) throw new Error(`market not found: ${slug}`);
    view.question = m.question;
    view.outcomes = [m.outcomes[0] ?? 'Yes', m.outcomes[1] ?? 'No'];
    view.feeRate = FEE_RATES[feeCategory(ev.tags ?? [])];
    if (!m.tokenIds[0]) throw new Error('market has no order book');
    return { ...view, ...(await refreshBook(client, m.tokenIds[0], view, now)) };
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
    return view;
  }
}

export async function refreshBook(client: PolymarketClient, token: string, prev: BookView, now: () => number = Date.now): Promise<Partial<BookView>> {
  try {
    const [book, trades] = await Promise.all([client.book(token), client.tradesPage(prev.cid, { limit: 40 }).catch(() => null)]);
    return { book, summary: summarizeBook(book), fetchedAt: now(), error: null, ...(trades ? { trades: [...trades].sort((a, b) => b.ts - a.ts) } : {}) };
  } catch (error) {
    return { error: error instanceof NotFoundError ? 'no order book: this market has closed or is not trading' : error instanceof Error ? error.message : String(error) };
  }
}

const c1 = (p: number): string => (p * 100).toFixed(1);
const usd = (x: number): string => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${Math.round(x)}`);

export interface LadderLine {
  side: 'ask' | 'bid' | 'spread';
  /** Plain text without colour; `frac` is the cumulative-depth share for drawing a bar. */
  text: string;
  frac: number;
}

/** `depth` levels each side. Asks are listed top-down from the highest to the best; bids from the best down. Cumulative dollars grow away from the spread. */
export function ladder(b: Book, o: [string, string], depth: number): LadderLine[] {
  const asks = b.asks.filter((l) => l.price > 0 && l.price < 1 && l.size > 0).slice(0, depth);
  const bids = b.bids.filter((l) => l.price > 0 && l.price < 1 && l.size > 0).slice(0, depth);
  const cum = (ls: typeof asks) => ls.reduce<number[]>((a, l) => [...a, (a.at(-1) ?? 0) + l.size * l.price], []);
  const ca = cum(asks);
  const cb = cum(bids);
  const max = Math.max(1, ca.at(-1) ?? 0, cb.at(-1) ?? 0);
  const row = (side: 'ask' | 'bid', l: { price: number; size: number }, total: number): LadderLine => ({
    side, frac: total / max, text: `${c1(l.price).padStart(5)}c ${c1(1 - l.price).padStart(5)}c  ${Math.round(l.size).toLocaleString('en-US').padStart(10)}  ${usd(total).padStart(7)}`,
  });
  const out: LadderLine[] = [];
  for (let i = asks.length - 1; i >= 0; i--) out.push(row('ask', asks[i], ca[i]));
  const sp = asks[0] && bids[0] ? (asks[0].price - bids[0].price) * 100 : null;
  out.push({ side: 'spread', frac: 0, text: sp === null ? `one-sided book (${o[0]} price / ${o[1]} price)` : `spread ${sp.toFixed(1)}c  (${o[0]} price / ${o[1]} price, shares, cumulative $)` });
  for (let i = 0; i < bids.length; i++) out.push(row('bid', bids[i], cb[i]));
  return out;
}

/** One-line costs for the book: buying `usd` of the first outcome and of the second. */
export function costSummary(b: Book, o: [string, string], rate: number, sizes: number[] = [50, 500]): string[] {
  const inv = (ls: Book['bids']) => ls.map((l) => ({ price: 1 - l.price, size: l.size })).sort((x, y) => x.price - y.price);
  const lines: string[] = [];
  for (const s of sizes)
    for (const [name, asks, bids] of [[o[0], b.asks, b.bids], [o[1], inv(b.bids), inv(b.asks).sort((x, y) => y.price - x.price)]] as const) {
      const q = buyQuote(asks, s, rate);
      if (!q) {
        lines.push(`buy $${s} ${name}: nothing to buy`);
        continue;
      }
      const back = sellProceeds(bids, q.shares, rate);
      const exit = back.sold < q.shares * 0.999 ? 'no exit depth' : `exit now ${(((q.paid - back.proceeds) / q.paid) * 100).toFixed(1)}% loss`;
      lines.push(`buy $${s} ${name}: avg ${c1(q.avgPrice)}c, slip ${q.slippageCents.toFixed(1)}c, needs ${c1(q.breakEven)}% to break even, ${exit}${q.thin ? ', THIN book' : ''}`);
    }
  return lines;
}

export interface DomSide {
  price: number;
  size: number;
  /** Cumulative dollars from the best price out to this level. */
  cum: number;
}
export interface DomRow {
  bid: DomSide | null;
  ask: DomSide | null;
}

/** Terminal-style ladder: row i holds the i-th best bid and the i-th best ask side by side. `max` is the largest cumulative dollars, for scaling the bars. */
export function dom(b: Book, depth: number): { rows: DomRow[]; max: number } {
  const side = (ls: Book['bids']): DomSide[] => {
    let cum = 0;
    return ls.filter((l) => l.price > 0 && l.price < 1 && l.size > 0).slice(0, depth).map((l) => ({ price: l.price, size: l.size, cum: (cum += l.size * l.price) }));
  };
  const bids = side(b.bids);
  const asks = side(b.asks);
  const n = Math.max(bids.length, asks.length);
  const rows: DomRow[] = Array.from({ length: n }, (_, i) => ({ bid: bids[i] ?? null, ask: asks[i] ?? null }));
  return { rows, max: Math.max(1, bids.at(-1)?.cum ?? 0, asks.at(-1)?.cum ?? 0) };
}

export interface TapeLine {
  ts: number;
  side: 'BUY' | 'SELL';
  outcome: string;
  price: number;
  usd: number;
  wallet: string;
  big: boolean;
}

export function tape(trades: readonly TradeRow[], outcomes: [string, string], bigUsd = 1_000): TapeLine[] {
  return trades.map((t) => ({ ts: t.ts, side: t.side, outcome: outcomes[t.outcomeIndex] ?? `#${t.outcomeIndex}`, price: t.price, usd: t.size * t.price, wallet: t.wallet, big: t.size * t.price >= bigUsd }));
}

/** Share of the dollars resting within 5 cents that sit on the bid side (0..1), or null for an empty book. */
export const bidShare = (s: BookSummary): number | null => (s.bidDepthUsd + s.askDepthUsd > 0 ? s.bidDepthUsd / (s.bidDepthUsd + s.askDepthUsd) : null);
