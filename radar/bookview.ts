import { buyQuote, sellProceeds, FEE_RATES, feeCategory } from './cost.ts';
import { viewOf } from './dom.ts';
import { MILLS, type LiveState } from './livebook.ts';
import { mapEvent, type Book, type PolymarketClient } from './polymarket.ts';

/** The order-book tab's state: which market and token, how the ladder is displayed, and the live feed's data. */

export const GROUPS = [1, 2, 5, 10] as const;
export const PERIODS = [30, 60, 300] as const;
export const TAPE_MINS = [0, 10, 50, 250, 1_000] as const;

export interface BookUi {
  group: number;
  unit: 'SH' | 'USD';
  /** Viewing the second outcome. */
  flip: boolean;
  periodSecs: number;
  scroll: number;
  manualCenter: number | null;
  tapeMin: number;
}

export const defaultUi = (): BookUi => ({ group: 1, unit: 'SH', flip: false, periodSecs: 60, scroll: 0, manualCenter: null, tapeMin: 0 });

export interface BookView {
  slug: string;
  cid: string;
  question: string;
  outcomes: [string, string];
  /** Token ids of the two outcomes; the feed follows the first. */
  tokenIds: string[];
  tickMills: number;
  feeRate: number;
  error: string | null;
  live: LiveState | null;
  ui: BookUi;
}

export const emptyBook = (slug: string, cid: string): BookView => ({ slug, cid, question: 'loading…', outcomes: ['Yes', 'No'], tokenIds: [], tickMills: 10, feeRate: FEE_RATES.other, error: null, live: null, ui: defaultUi() });

const parseList = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  try {
    const p = JSON.parse(String(v));
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
};

/** Looks up the market's tokens, outcome names, tick size and fee category. Never throws: a failure lands in `error`. */
export async function loadBookMeta(client: PolymarketClient, slug: string, cid: string): Promise<BookView> {
  const view = emptyBook(slug, cid);
  try {
    const raw = await client.eventRaw(slug);
    if (!raw) throw new Error(`market not found: ${slug}`);
    const ev = mapEvent(raw);
    const m = ev.markets.find((x) => x.cid === cid) ?? ev.markets[0];
    if (!m) throw new Error(`market not found: ${slug}`);
    const rawM = ((raw.markets ?? []) as Array<Record<string, any>>).find((x) => x.conditionId === m.cid);
    view.cid = m.cid;
    view.question = m.question;
    view.outcomes = [m.outcomes[0] ?? 'Yes', m.outcomes[1] ?? 'No'];
    view.tokenIds = m.tokenIds.length ? m.tokenIds : parseList(rawM?.clobTokenIds);
    const tick = Number.parseFloat(String(rawM?.orderPriceMinTickSize ?? ''));
    view.tickMills = Number.isFinite(tick) && tick > 0 ? Math.max(1, Math.round(tick * MILLS)) : 10;
    view.feeRate = FEE_RATES[feeCategory(ev.tags ?? [])];
    if (!view.tokenIds[0]) throw new Error('market has no order book');
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
  }
  return view;
}

/** The live state as a plain book (best first) from one outcome's point of view, for the cost calculation. */
export function toBook(s: Pick<LiveState, 'bids' | 'asks' | 'trades'>, flip: boolean): Book {
  const v = viewOf(s, flip);
  const lv = (m: Map<number, number>) => [...m].map(([p, z]) => ({ price: p / MILLS, size: z }));
  return { bids: lv(v.bids).sort((a, b) => b.price - a.price), asks: lv(v.asks).sort((a, b) => a.price - b.price) };
}

const c1 = (p: number): string => (p * 100).toFixed(1);

/** One line per size and outcome: average fill, slippage, break-even probability and the loss of leaving at once. */
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

export const cycle = <T,>(list: readonly T[], cur: T, dir: 1 | -1 = 1): T => list[(list.indexOf(cur) + dir + list.length) % list.length] ?? list[0];
