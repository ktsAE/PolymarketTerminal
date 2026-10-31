import { createHash } from 'node:crypto';
import type { MarketRow, PrintRow, SnapRow, TradeRow, WalletRow } from './store.ts';
import { clusteredZ, type Unit } from './features.ts';

export type FetchJson = (url: string) => Promise<unknown>;

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com';
const PAGE = 1000;
const OFFSET_CAP = 9000; // data API rejects offset > 10000; stay below and slice by time window instead

export interface GammaEvent {
  slug: string;
  title: string;
  volume: number;
  closed: boolean;
  markets: MarketRow[];
}

const num = (v: unknown, d = 0): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : d;
};
const parseJson = <T>(v: unknown, fallback: T): T => {
  if (Array.isArray(v)) return v as T;
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
};

/** "2026-08-24 13:00:00+00" -> epoch seconds. */
export function parseStart(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const ms = Date.parse(v.replace(' ', 'T').replace(/\+00$/, '+00:00'));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function mapEvent(raw: Record<string, any>): GammaEvent {
  const title = String(raw.title ?? '');
  const game = title.includes(':') ? title.split(':')[0].trim() : null;
  const markets: MarketRow[] = (raw.markets ?? []).map((m: Record<string, any>) => {
    const prices = parseJson<unknown[]>(m.outcomePrices, []).map((p) => num(p, NaN));
    return {
      cid: String(m.conditionId),
      eventSlug: String(raw.slug),
      eventTitle: title,
      game,
      marketType: (m.sportsMarketType as string | undefined) ?? null,
      question: String(m.question ?? ''),
      outcomes: parseJson<string[]>(m.outcomes, []).map((o) => String(o).trim()),
      tokenIds: parseJson<string[]>(m.clobTokenIds, []),
      gameStart: parseStart(m.gameStartTime),
      // an unresolved market has fractional prices; resolved ones are 0/1 (or 0.5/0.5 when voided)
      result: m.closed && prices.length && prices.every((p) => Number.isFinite(p)) ? prices : null,
      volume: num(m.volume),
      closed: Boolean(m.closed),
    };
  });
  return { slug: String(raw.slug), title, volume: num(raw.volume), closed: Boolean(raw.closed), markets };
}

const toSecs = (v: unknown): number | null => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};
const optNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const CATEGORIES = ['esports', 'sports', 'politics', 'geopolitics', 'crypto', 'finance', 'economy', 'culture', 'tech', 'science', 'weather'];
function categoryOf(raw: Record<string, any>): string {
  const slugs = new Set(((raw.tags as Array<Record<string, any>>) ?? []).map((t) => String(t.slug ?? '').toLowerCase()));
  return CATEGORIES.find((c) => slugs.has(c)) ?? '';
}

/** One row per event for the scanner: event-level OI/volume/liquidity plus price and moves of its busiest market. */
export function mapSnapshot(raw: Record<string, any>, ts: number): SnapRow | null {
  if (!raw.id || !raw.slug) return null;
  const markets: Array<Record<string, any>> = raw.markets ?? [];
  const top = [...markets].sort((a, b) => num(b.volume24hr) - num(a.volume24hr))[0];
  const prices = top ? parseJson<unknown[]>(top.outcomePrices, []).map((p) => optNum(p)) : [];
  return {
    eventId: String(raw.id), ts, slug: String(raw.slug), title: String(raw.title ?? ''),
    oi: num(raw.openInterest), vol24: num(raw.volume24hr), vol1w: num(raw.volume1wk), liq: num(raw.liquidity),
    price: top ? (optNum(top.lastTradePrice) || prices[0] || null) : null,
    ch1h: top ? optNum(top.oneHourPriceChange) : null, ch1d: top ? optNum(top.oneDayPriceChange) : null,
    created: toSecs(raw.createdAt) ?? toSecs(raw.startDate), endDate: toSecs(raw.endDate),
    isGame: markets.some((m) => Boolean(m.sportsMarketType || m.gameStartTime)),
    cat: categoryOf(raw),
  };
}

export function mapPrint(raw: Record<string, any>): PrintRow | null {
  const t = mapTrade(raw);
  if (!t) return null;
  const key = createHash('sha1').update([raw.transactionHash ?? '', t.cid, t.wallet, t.side, t.size, t.price, t.ts].join('|')).digest('hex');
  return {
    key, ts: t.ts, wallet: t.wallet, cid: t.cid, eventSlug: String(raw.eventSlug ?? raw.slug ?? ''), title: String(raw.title ?? ''),
    outcome: raw.outcome ? String(raw.outcome) : null, side: t.side, price: t.price, size: t.size, usd: t.size * t.price,
    name: raw.name ? String(raw.name) : raw.pseudonym ? String(raw.pseudonym) : null,
  };
}

export function mapTrade(raw: Record<string, any>): TradeRow | null {
  const side = raw.side === 'BUY' || raw.side === 'SELL' ? raw.side : null;
  const price = num(raw.price, NaN);
  const size = num(raw.size, NaN);
  const ts = num(raw.timestamp, NaN);
  const outcomeIndex = num(raw.outcomeIndex, NaN);
  if (!side || !raw.conditionId || !raw.proxyWallet || ![price, size, ts, outcomeIndex].every(Number.isFinite)) return null;
  if (price < 0 || price > 1 || size <= 0) return null;
  return {
    cid: String(raw.conditionId),
    wallet: String(raw.proxyWallet).toLowerCase(),
    side,
    outcomeIndex,
    price,
    size,
    ts,
    tx: raw.transactionHash ? String(raw.transactionHash) : null,
  };
}

export interface ClientOptions {
  minIntervalMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class PolymarketClient {
  private lastCall = 0;
  private readonly fetchJson: FetchJson;
  private readonly minIntervalMs: number;
  private readonly retries: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(fetchJson: FetchJson, opts: ClientOptions = {}) {
    this.fetchJson = fetchJson;
    this.minIntervalMs = opts.minIntervalMs ?? 120;
    this.retries = opts.retries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  private async get(url: string): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const wait = this.lastCall + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastCall = this.now();
      try {
        return await this.fetchJson(url);
      } catch (error) {
        lastError = error;
        await this.sleep(400 * 2 ** attempt);
      }
    }
    throw new Error(`request failed after ${this.retries + 1} attempts: ${url}: ${String(lastError)}`);
  }

  async eventBySlug(slug: string): Promise<GammaEvent | undefined> {
    const rows = (await this.get(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`)) as Record<string, any>[];
    return Array.isArray(rows) && rows[0] ? mapEvent(rows[0]) : undefined;
  }

  async esportsEvents(opts: { closed: boolean; limit?: number; offset?: number }): Promise<GammaEvent[]> {
    const rows = (await this.get(
      `${GAMMA}/events?tag_slug=esports&closed=${opts.closed}&limit=${opts.limit ?? 100}&offset=${opts.offset ?? 0}&order=startDate&ascending=false`,
    )) as Record<string, any>[];
    return Array.isArray(rows) ? rows.map(mapEvent) : [];
  }

  /** The busiest active events, ranked by 24h volume. */
  async topEvents(opts: { offset?: number; limit?: number; ts: number }): Promise<SnapRow[]> {
    const rows = (await this.get(`${GAMMA}/events?active=true&closed=false&limit=${opts.limit ?? 100}&offset=${opts.offset ?? 0}&order=volume24hr&ascending=false`)) as Record<string, any>[];
    return Array.isArray(rows) ? rows.map((r) => mapSnapshot(r, opts.ts)).filter((x): x is SnapRow => x !== null) : [];
  }

  /** The platform-wide feed of fills at least `minUsd`, newest first. */
  async bigPrints(opts: { minUsd: number; limit?: number }): Promise<PrintRow[]> {
    const rows = (await this.get(`${DATA}/trades?limit=${opts.limit ?? 500}&filterType=CASH&filterAmount=${opts.minUsd}&takerOnly=false`)) as Record<string, any>[];
    return Array.isArray(rows) ? rows.map(mapPrint).filter((x): x is PrintRow => x !== null) : [];
  }

  /** Cheap wallet profile (two calls): first activity and markets traded. */
  async walletLite(wallet: string): Promise<{ firstSeen: number | null; traded: number | null }> {
    const first = (await this.get(`${DATA}/activity?user=${wallet}&limit=1&sortDirection=ASC`)) as Record<string, any>[];
    const traded = (await this.get(`${DATA}/traded?user=${wallet}`)) as Record<string, any>;
    return {
      firstSeen: Array.isArray(first) && first[0] ? num(first[0].timestamp, NaN) || null : null,
      traded: traded && typeof traded.traded === 'number' ? traded.traded : null,
    };
  }

  async searchEvents(query: string): Promise<Array<{ slug: string; title: string; volume: number }>> {
    const d = (await this.get(`${GAMMA}/public-search?q=${encodeURIComponent(query)}&limit_per_type=8&keep_closed_markets=1`)) as Record<string, any>;
    return ((d?.events as Record<string, any>[]) ?? []).map((e) => ({ slug: String(e.slug), title: String(e.title), volume: num(e.volume) }));
  }

  /**
   * Every fill in a market, BOTH sides (taker and maker). takerOnly=true hides resting limit
   * orders, which is exactly where large patient positions show up.
   */
  async marketTrades(cid: string, opts: { end?: number } = {}): Promise<TradeRow[]> {
    const out: TradeRow[] = [];
    let end = opts.end;
    for (let guard = 0; guard < 50; guard++) {
      let offset = 0;
      let exhausted = false;
      let minTs = Infinity;
      for (; offset <= OFFSET_CAP; offset += PAGE) {
        const url = `${DATA}/trades?market=${cid}&takerOnly=false&limit=${PAGE}&offset=${offset}${end !== undefined ? `&end=${end}` : ''}`;
        const rows = (await this.get(url)) as Record<string, any>[];
        if (!Array.isArray(rows)) break;
        for (const raw of rows) {
          const t = mapTrade(raw);
          if (t) {
            out.push(t);
            if (t.ts < minTs) minTs = t.ts;
          }
        }
        if (rows.length < PAGE) {
          exhausted = true;
          break;
        }
      }
      if (exhausted || !Number.isFinite(minTs) || minTs === end) break;
      end = minTs; // slice the next window just below what we already have; duplicates are dropped by the store
    }
    return out;
  }

  async walletProfile(wallet: string, opts: { skillMinCost?: number } = {}): Promise<WalletRow> {
    const first = (await this.get(`${DATA}/activity?user=${wallet}&limit=1&sortDirection=ASC`)) as Record<string, any>[];
    const traded = (await this.get(`${DATA}/traded?user=${wallet}`)) as Record<string, any>;
    const closed = await this.closedPositions(wallet, 400);
    const minCost = opts.skillMinCost ?? 5000;
    const big = closed.filter((p) => p.cost >= minCost);
    const units: Unit[] = big.map((p) => ({ q: p.avgPrice, win: p.pnl > 0 ? 1 : 0 }));
    return {
      wallet: wallet.toLowerCase(),
      firstSeen: Array.isArray(first) && first[0] ? num(first[0].timestamp, NaN) || null : null,
      traded: traded && typeof traded.traded === 'number' ? traded.traded : null,
      bigPositions: big.length,
      skillZ: units.length >= 10 ? clusteredZ(units).z : null,
      fetchedAt: Math.floor(this.now() / 1000),
    };
  }

  async closedPositions(wallet: string, max = 400): Promise<Array<{ avgPrice: number; cost: number; pnl: number }>> {
    const out: Array<{ avgPrice: number; cost: number; pnl: number }> = [];
    for (let offset = 0; offset < max; offset += 50) {
      const rows = (await this.get(`${DATA}/closed-positions?user=${wallet}&limit=50&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`)) as Record<string, any>[];
      if (!Array.isArray(rows)) break;
      for (const r of rows) out.push({ avgPrice: num(r.avgPrice), cost: num(r.totalBought) * num(r.avgPrice), pnl: num(r.realizedPnl) });
      if (rows.length < 50) break;
    }
    return out;
  }
}

export const httpFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'polymarket-radar/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
