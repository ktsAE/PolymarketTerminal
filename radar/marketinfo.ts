import type { Book } from './polymarket.ts';

/**
 * The state of one market in a few lines: where the book is, how deep it is, when it ends, and whether the UMA oracle has started to resolve it.
 * A resolution that has been proposed or disputed is information a price alone does not show.
 */

export interface BookSummary {
  bid: number | null;
  ask: number | null;
  /** In cents. */
  spreadCents: number | null;
  /** Dollars resting within 5 cents of the best price, on each side. */
  bidDepthUsd: number;
  askDepthUsd: number;
}

export function summarizeBook(book: Book): BookSummary {
  const bids = book.bids.filter((l) => l.price > 0 && l.price < 1 && l.size > 0);
  const asks = book.asks.filter((l) => l.price > 0 && l.price < 1 && l.size > 0);
  const bid = bids.length ? Math.max(...bids.map((l) => l.price)) : null;
  const ask = asks.length ? Math.min(...asks.map((l) => l.price)) : null;
  const depth = (ls: typeof bids, best: number | null, sign: 1 | -1) => (best === null ? 0 : ls.filter((l) => (l.price - best) * sign <= 0.05 + 1e-9).reduce((a, l) => a + l.size * l.price, 0));
  return {
    bid, ask, spreadCents: bid !== null && ask !== null ? (ask - bid) * 100 : null,
    bidDepthUsd: depth(bids, bid, -1), askDepthUsd: depth(asks, ask, 1),
  };
}

export interface MarketInfo {
  book: BookSummary | null;
  /** Epoch seconds the market is scheduled to end, if any. */
  endsAt: number | null;
  acceptingOrders: boolean | null;
  /** UMA statuses reported so far (proposed, disputed, resolved...). Empty = resolution has not started. */
  uma: string[];
  rules: string;
}

export function parseInfo(raw: Record<string, any> | undefined, book: Book | null): MarketInfo {
  const end = typeof raw?.endDate === 'string' ? Date.parse(raw.endDate) : NaN;
  let uma: unknown = raw?.umaResolutionStatuses;
  if (typeof uma === 'string') {
    try {
      uma = JSON.parse(uma);
    } catch {
      uma = [];
    }
  }
  const single = typeof raw?.umaResolutionStatus === 'string' && raw.umaResolutionStatus ? [raw.umaResolutionStatus as string] : [];
  return {
    book: book ? summarizeBook(book) : null,
    endsAt: Number.isFinite(end) ? Math.floor(end / 1000) : null,
    acceptingOrders: typeof raw?.acceptingOrders === 'boolean' ? raw.acceptingOrders : null,
    uma: Array.isArray(uma) && uma.length ? uma.map(String) : single,
    rules: String(raw?.description ?? '').replace(/\s+/g, ' ').trim(),
  };
}

const usd = (x: number): string => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${Math.round(x)}`);

export function timeLeft(endsAt: number, nowSecs: number): string {
  const d = endsAt - nowSecs;
  const a = Math.abs(d);
  const t = a >= 86_400 ? `${Math.floor(a / 86_400)}d ${Math.floor((a % 86_400) / 3_600)}h` : a >= 3_600 ? `${Math.floor(a / 3_600)}h ${Math.floor((a % 3_600) / 60)}m` : `${Math.floor(a / 60)}m`;
  return d >= 0 ? `ends in ${t}` : `end date passed ${t} ago`;
}

/** One status line, and the rules line (cut to `rulesWidth`). */
export function formatInfo(i: MarketInfo, yesLabel: string, nowSecs: number, rulesWidth = 140): string[] {
  const parts: string[] = [];
  if (i.book) {
    const b = i.book;
    parts.push(b.bid === null && b.ask === null ? 'book empty' : `${yesLabel} ${b.bid === null ? '-' : (b.bid * 100).toFixed(1)}/${b.ask === null ? '-' : (b.ask * 100).toFixed(1)}c${b.spreadCents === null ? '' : `, spread ${b.spreadCents.toFixed(1)}c`}`);
    parts.push(`within 5c: ${usd(b.bidDepthUsd)} bids / ${usd(b.askDepthUsd)} asks`);
  }
  if (i.endsAt !== null) parts.push(timeLeft(i.endsAt, nowSecs));
  parts.push(i.uma.length ? `UMA oracle: ${i.uma.join(' → ')}` : 'UMA: no resolution proposed');
  if (i.acceptingOrders === false) parts.push('NOT accepting orders');
  const out = [parts.join('  ·  ')];
  if (i.rules) out.push(`rules: ${i.rules.length > rulesWidth ? `${i.rules.slice(0, rulesWidth - 1)}…` : i.rules}`);
  return out;
}
