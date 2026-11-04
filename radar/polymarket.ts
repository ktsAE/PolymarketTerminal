import { createHash } from 'node:crypto';
import type { MarketRow, PrintRow, SnapRow, TradeRow, WalletRow } from './store.ts';
import { clusteredZ, type Unit } from './features.ts';
import type { ActivityRec } from './profile.ts';

export type FetchJson = (url: string) => Promise<unknown>;

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA = 'https://data-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const PAGE = 1000;
/** Data API v2 (v1 was retired on 2026-11-02 and answers HTTP 410). Responses are `{ data, pagination }` in snake_case; paging is by opaque cursor, with no offset cap. */
const DATA_V2 = `${DATA}/v2`;
const MAX_CURSOR_PAGES = 300;

const camelKey = (k: string): string => k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
/** snake_case -> camelCase, deep, so the rest of the radar keeps reading proxyWallet / conditionId / outcomeIndex as it always did. */
export function camelKeys(x: unknown): any {
  if (Array.isArray(x)) return x.map(camelKeys);
  if (x && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) out[camelKey(k)] = camelKeys(v);
    return out;
  }
  return x;
}

type Q = Record<string, string | number | boolean | undefined | null>;

export interface GammaEvent {
  slug: string;
  title: string;
  volume: number;
  closed: boolean;
  markets: MarketRow[];
  /** Tag slugs of the event (lowercase), used to estimate the fee category. */
  tags?: string[];
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
  const tags = (Array.isArray(raw.tags) ? raw.tags : []).map((t: Record<string, any>) => String(t?.slug ?? '').toLowerCase()).filter(Boolean);
  return { slug: String(raw.slug), title, volume: num(raw.volume), closed: Boolean(raw.closed), markets, tags };
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
    startsAt: markets.map((m) => parseStart(m.gameStartTime)).filter((x): x is number => x !== null).sort((a, b) => a - b)[0] ?? null,
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

export interface PnlPoint {
  ts: number;
  economicPnl: number;
  positionPnl: number;
  realizedPnl: number;
  referralIncome: number;
  rewardIncome: number;
  yieldIncome: number;
  makerRebate: number;
  takerRebate: number;
  volume: number;
  tradeCount: number;
}
export interface PositionLine {
  cid: string;
  title: string;
  slug: string;
  outcome: string;
  status: string;
  cost: number;
  value: number;
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  firstEntryAt: number | null;
}
export interface TradeLine {
  ts: number;
  tx: string;
  token: string;
  side: string;
  price: number;
  size: number;
  outcome: string;
  title: string;
  slug: string;
  cid: string;
}
export interface FillLine {
  ts: number;
  tx: string;
  token: string;
  side: string;
  price: number;
  size: number;
}

export class NotFoundError extends Error {
  constructor(url: string) {
    super(`not found: ${url}`);
    this.name = 'NotFoundError';
  }
}

/** What a wallet publishes on its public Polymarket profile. There is no e-mail field; the API never exposes one. */
export interface PublicProfile {
  createdAt: number | null; // epoch seconds
  name: string | null;
  pseudonym: string | null;
  xUsername: string | null;
  bio: string | null;
  verified: boolean;
}

export interface BookLevel {
  price: number;
  size: number;
}
export interface Book {
  bids: BookLevel[]; // best (highest) first
  asks: BookLevel[]; // best (lowest) first
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
        // A 404 is an answer ("no such profile"), not a glitch: retrying it only burns seconds.
        if (error instanceof Error && /^HTTP 404/.test(error.message)) throw new NotFoundError(url);
        // 410 Gone: the endpoint was retired. Retrying cannot help, so fail at once with a message that names the cause.
        if (error instanceof Error && /^HTTP 410/.test(error.message)) throw new Error(`endpoint retired (HTTP 410): ${url}`);
        lastError = error;
        await this.sleep(400 * 2 ** attempt);
      }
    }
    throw new Error(`request failed after ${this.retries + 1} attempts: ${url}: ${String(lastError)}`);
  }

  /** One page of a Data API v2 route: payload unwrapped from `data`, keys camelCased, plus the cursor of the next page (null at the end). */
  private async dataPage(path: string, q: Q = {}): Promise<{ data: any; next: string | null }> {
    const qs = Object.entries(q)
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join('&');
    const r = (await this.get(`${DATA_V2}/${path}${qs ? `?${qs}` : ''}`)) as Record<string, any> | null;
    const next = r?.pagination?.next_cursor;
    return { data: camelKeys(r?.data ?? null), next: typeof next === 'string' && next ? next : null };
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
    const { data: rows } = await this.dataPage('trades', { limit: Math.min(opts.limit ?? 500, 1000), filter_type: 'CASH', filter_amount: opts.minUsd, taker_only: false });
    return Array.isArray(rows) ? rows.map(mapPrint).filter((x): x is PrintRow => x !== null) : [];
  }

  /** Cheap wallet profile (two calls): first activity and markets traded. */
  async walletLite(wallet: string): Promise<{ firstSeen: number | null; traded: number | null }> {
    const [first, traded] = await Promise.all([this.firstActivityTs(wallet), this.marketsTraded(wallet)]);
    return { firstSeen: first, traded };
  }

  /** Top holders of a market's outcome tokens (up to `limit` per outcome). */
  async holders(cid: string, limit = 20): Promise<Array<{ wallet: string; name: string | null; outcomeIndex: number; shares: number }>> {
    const { data: groups } = await this.dataPage('holders', { condition: cid, limit });
    const out: Array<{ wallet: string; name: string | null; outcomeIndex: number; shares: number }> = [];
    for (const g of Array.isArray(groups) ? groups : [])
      for (const h of (g.holders as Array<Record<string, any>>) ?? [])
        if (h.proxyWallet) out.push({ wallet: String(h.proxyWallet).toLowerCase(), name: h.name ? String(h.name) : h.pseudonym ? String(h.pseudonym) : null, outcomeIndex: num(h.outcomeIndex), shares: num(h.amount) });
    return out;
  }

  /** A wallet's most recent activity (trades, rewards, rebates, merges...), newest first. */
  async activityRecords(wallet: string, limit = 500): Promise<ActivityRec[]> {
    const { data: rows } = await this.dataPage('activity', { user: wallet, limit: Math.min(limit, 500) });
    return (Array.isArray(rows) ? rows : []).map((r) => ({ ts: num(r.timestamp), type: String(r.type ?? ''), side: String(r.side ?? ''), usd: num(r.usdcSize), cid: String(r.conditionId ?? '') }));
  }

  async firstActivityTs(wallet: string): Promise<number | null> {
    const { data: rows } = await this.dataPage('activity', { user: wallet, limit: 1, sort_direction: 'ASC' });
    return Array.isArray(rows) && rows[0] ? num(rows[0].timestamp, NaN) || null : null;
  }

  async marketsTraded(wallet: string): Promise<number | null> {
    const { data: r } = await this.dataPage('user-stats', { user: wallet });
    return r && typeof r.trades === 'number' ? r.trades : null;
  }

  /** All-time or recent PnL and volume from Polymarket's own leaderboard (null when the wallet is not ranked). */
  async leaderboard(wallet: string, period: 'all' | 'week'): Promise<{ pnl: number; vol: number; name: string | null } | null> {
    const { data: r } = await this.dataPage('leaderboard', { user: wallet, time_period: period === 'week' ? 'WEEK' : 'ALL', order_by: 'PNL' });
    return r && typeof r === 'object' && !Array.isArray(r) ? { pnl: num(r.pnl), vol: num(r.volume), name: r.userName ? String(r.userName) : null } : null;
  }

  async positions(wallet: string, cid: string): Promise<Array<{ outcomeIndex: number; size: number; avgPrice: number; curPrice: number; currentValue: number; cashPnl: number }>> {
    const { data: rows } = await this.dataPage('positions', { user: wallet, condition: cid, limit: 10 });
    return (Array.isArray(rows) ? rows : []).map((r) => ({ outcomeIndex: num(r.outcomeIndex), size: num(r.currentSize), avgPrice: num(r.avgPrice), curPrice: num(r.currentPrice), currentValue: num(r.currentValue), cashPnl: num(r.unrealizedPnl) }));
  }

  /** Active events, busiest by 24h volume first, in raw gamma form (embedded markets carry bestBid/bestAsk, liquidity, token ids, negRisk). */
  async activeEventsRaw(offset: number, limit = 100): Promise<Array<Record<string, any>>> {
    const rows = (await this.get(`${GAMMA}/events?active=true&closed=false&limit=${limit}&offset=${offset}&order=volume24hr&ascending=false`)) as Array<Record<string, any>>;
    return Array.isArray(rows) ? rows : [];
  }

  /** The raw gamma event (quotes, liquidity and rules text included) for callers that need more than `mapEvent` keeps. */
  async eventRaw(slug: string): Promise<Record<string, any> | undefined> {
    const rows = (await this.get(`${GAMMA}/events?slug=${encodeURIComponent(slug)}`)) as Record<string, any>[];
    return Array.isArray(rows) ? rows[0] : undefined;
  }

  /** Gamma's league list: sport code, its series id and tag ids (tag 64 = esports). */
  async sportsList(): Promise<Array<{ sport: string; series: string; tags: string[] }>> {
    const rows = (await this.get(`${GAMMA}/sports`)) as Array<Record<string, any>>;
    return (Array.isArray(rows) ? rows : []).filter((r) => r.sport && r.series).map((r) => ({ sport: String(r.sport), series: String(r.series), tags: String(r.tags ?? '').split(',').map((t) => t.trim()).filter(Boolean) }));
  }

  /** Open events of one series in raw gamma form, optionally bounded by end date (ISO). */
  async seriesEventsRaw(seriesId: string, opts: { endMin?: string; endMax?: string; offset?: number; limit?: number } = {}): Promise<Array<Record<string, any>>> {
    const range = `${opts.endMin ? `&end_date_min=${encodeURIComponent(opts.endMin)}` : ''}${opts.endMax ? `&end_date_max=${encodeURIComponent(opts.endMax)}` : ''}`;
    const rows = (await this.get(`${GAMMA}/events?active=true&closed=false&series_id=${encodeURIComponent(seriesId)}&limit=${opts.limit ?? 100}&offset=${opts.offset ?? 0}${range}`)) as Array<Record<string, any>>;
    return Array.isArray(rows) ? rows : [];
  }

  /** Public profile of a wallet: creation date, display name, linked X handle, bio. Null when the wallet never made a profile. */
  async publicProfile(wallet: string): Promise<PublicProfile | null> {
    try {
      const r = (await this.get(`${GAMMA}/public-profile?address=${wallet}`)) as Record<string, any>;
      if (!r || typeof r !== 'object') return null;
      const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
      return { createdAt: toSecs(r.createdAt), name: text(r.name), pseudonym: text(r.pseudonym), xUsername: text(r.xUsername), bio: text(r.bio), verified: Boolean(r.verifiedBadge) };
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }

  /** Order book of one outcome token, sorted best-first (the API returns levels unsorted). */
  async book(tokenId: string): Promise<Book> {
    const r = (await this.get(`${CLOB}/book?token_id=${tokenId}`)) as Record<string, any>;
    const levels = (v: unknown): BookLevel[] => (Array.isArray(v) ? v : []).map((l: Record<string, any>) => ({ price: num(l.price, NaN), size: num(l.size, NaN) })).filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.size > 0);
    return { bids: levels(r?.bids).sort((a, b) => b.price - a.price), asks: levels(r?.asks).sort((a, b) => a.price - b.price) };
  }

  async searchEvents(query: string, limit = 8): Promise<Array<{ slug: string; title: string; volume: number; closed: boolean }>> {
    const d = (await this.get(`${GAMMA}/public-search?q=${encodeURIComponent(query)}&limit_per_type=${limit}&keep_closed_markets=1`)) as Record<string, any>;
    return ((d?.events as Record<string, any>[]) ?? []).map((e) => ({ slug: String(e.slug), title: String(e.title), volume: num(e.volume), closed: Boolean(e.closed) }));
  }

  /**
   * Every fill in a market, BOTH sides (taker and maker). takerOnly=true hides resting limit
   * orders, which is exactly where large patient positions show up.
   */
  async marketTrades(cid: string, opts: { end?: number; maxFills?: number } = {}): Promise<TradeRow[]> {
    const out: TradeRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_CURSOR_PAGES && out.length < (opts.maxFills ?? Infinity); page++) {
      const { data: rows, next } = await this.dataPage('trades', { condition: cid, taker_only: false, limit: PAGE, cursor });
      for (const raw of Array.isArray(rows) ? rows : []) {
        const t = mapTrade(raw);
        if (t && (opts.end === undefined || t.ts <= opts.end)) out.push(t);
      }
      if (!next) break;
      cursor = next;
    }
    return out;
  }

  /** Open markets newest-created first, in raw gamma /markets form (each carries createdAt, outcomes, clobTokenIds, events[]). */
  async newMarketsRaw(opts: { offset?: number; limit?: number; minVolume?: number } = {}): Promise<Array<Record<string, any>>> {
    const rows = (await this.get(`${GAMMA}/markets?order=createdAt&ascending=false&closed=false&limit=${opts.limit ?? 100}&offset=${opts.offset ?? 0}${opts.minVolume ? `&volume_num_min=${opts.minVolume}` : ''}`)) as Array<Record<string, any>>;
    return Array.isArray(rows) ? rows : [];
  }

  /** One page of a market's fills, newest first, with the cursor of the next page (null at the end). takerOnly=true counts each fill once, from the aggressor's side. v2 has no time-window or offset parameter: walk with the cursor. */
  async tradesCursor(cid: string, opts: { cursor?: string; limit?: number; takerOnly?: boolean } = {}): Promise<{ rows: TradeRow[]; next: string | null }> {
    const { data, next } = await this.dataPage('trades', { condition: cid, taker_only: opts.takerOnly ?? false, limit: Math.min(opts.limit ?? PAGE, 1000), cursor: opts.cursor });
    return { rows: Array.isArray(data) ? data.map(mapTrade).filter((t): t is TradeRow => t !== null) : [], next };
  }

  /** The newest page of a market's fills (kept for callers that only need the latest trades). */
  async tradesPage(cid: string, opts: { limit?: number; takerOnly?: boolean } = {}): Promise<TradeRow[]> {
    return (await this.tradesCursor(cid, opts)).rows;
  }

  /** The most recent fill at or before `end` (null when there is none). Walks newest-first pages; throws when `maxPages` pages were not enough to get back to `end`, so a caller never records "no trade" for a market it simply did not reach. */
  async lastTradeAtOrBefore(cid: string, end: number, opts: { takerOnly?: boolean; maxPages?: number } = {}): Promise<TradeRow | null> {
    let cursor: string | undefined;
    const maxPages = opts.maxPages ?? 40;
    for (let page = 0; page < maxPages; page++) {
      const { rows, next } = await this.tradesCursor(cid, { cursor, takerOnly: opts.takerOnly });
      const hit = rows.find((t) => t.ts <= end);
      if (hit) return hit;
      if (!next) return null;
      cursor = next;
    }
    throw new Error(`could not reach ${new Date(end * 1000).toISOString()} within ${maxPages} pages of fills`);
  }

  async walletProfile(wallet: string, opts: { skillMinCost?: number } = {}): Promise<WalletRow> {
    const [firstSeen, traded, closed] = await Promise.all([this.firstActivityTs(wallet), this.marketsTraded(wallet), this.closedPositions(wallet, 400)]);
    const minCost = opts.skillMinCost ?? 5000;
    const big = closed.filter((p) => p.cost >= minCost);
    const units: Unit[] = big.map((p) => ({ q: p.avgPrice, win: p.pnl > 0 ? 1 : 0 }));
    return {
      wallet: wallet.toLowerCase(),
      firstSeen,
      traded,
      bigPositions: big.length,
      skillZ: units.length >= 10 ? clusteredZ(units).z : null,
      fetchedAt: Math.floor(this.now() / 1000),
    };
  }

  /** Daily cumulative PnL series of a wallet (Data API v2 user-pnl): every position is counted, open and lost ones too. Oldest first. */
  async userPnlSeries(wallet: string): Promise<PnlPoint[]> {
    const { data } = await this.dataPage('user-pnl', { user: wallet, interval: 'max', fidelity: '1d' });
    const pts: Array<Record<string, any>> = Array.isArray(data?.points) ? data.points : [];
    return pts
      .map((r) => ({
        ts: num(r.timestamp), economicPnl: num(r.economicPnl), positionPnl: num(r.positionPnl), realizedPnl: num(r.realizedPnl), referralIncome: num(r.referralIncome), rewardIncome: num(r.rewardIncome),
        yieldIncome: num(r.yieldIncome), makerRebate: num(r.makerRebate), takerRebate: num(r.takerRebate), volume: num(r.volumeUsdc, num(r.volume)), tradeCount: num(r.tradeCount),
      }))
      .filter((r) => r.ts > 0)
      .sort((x, y) => x.ts - y.ts);
  }

  /** A wallet's latest trades (newest first), with the market they were in. */
  async recentTrades(wallet: string, limit = 50): Promise<TradeLine[]> {
    const { data } = await this.dataPage('activity', { user: wallet, limit: Math.min(limit, 500) });
    return (Array.isArray(data) ? data : [])
      .filter((r: Record<string, any>) => String(r.type ?? 'TRADE') === 'TRADE' && (r.side === 'BUY' || r.side === 'SELL'))
      .map((r: Record<string, any>) => ({
        ts: num(r.timestamp), tx: String(r.transactionHash ?? ''), token: String(r.tokenId ?? ''), side: String(r.side), price: num(r.price), size: num(r.size), outcome: String(r.outcome ?? ''),
        title: String(r.title ?? ''), slug: String(r.eventSlug ?? r.slug ?? ''), cid: String(r.conditionId ?? ''),
      }));
  }

  /** A wallet's positions of one lifecycle status, newest first, following the cursor up to `max` rows. */
  async userPositions(wallet: string, status: 'OPEN' | 'CLOSED' | 'REDEEMABLE_LOST', max = 3000): Promise<PositionLine[]> {
    const out: PositionLine[] = [];
    let cursor: string | undefined;
    while (out.length < max) {
      const { data, next } = await this.dataPage('positions', { user: wallet, status, limit: 1000, cursor });
      for (const r of Array.isArray(data) ? data : [])
        out.push({
          cid: String(r.conditionId ?? ''), title: String(r.title ?? ''), slug: String(r.eventSlug ?? r.slug ?? ''), outcome: String(r.outcome ?? ''), status,
          cost: num(r.totalCostUsdc), value: num(r.currentValue), totalPnl: num(r.totalPnl), realizedPnl: num(r.realizedPnl), unrealizedPnl: num(r.unrealizedPnl), firstEntryAt: num(r.firstEntryAt) || null,
        });
      if (!next) break;
      cursor = next;
    }
    return out.slice(0, max);
  }

  /** A wallet's fills, newest first. takerOnly=true keeps only the fills where it was the aggressor; false adds the ones where it was resting (maker). */
  async userFills(wallet: string, opts: { takerOnly: boolean; max?: number; sinceTs?: number }): Promise<FillLine[]> {
    const out: FillLine[] = [];
    let cursor: string | undefined;
    while (out.length < (opts.max ?? 1000)) {
      const { data, next } = await this.dataPage('trades', { user: wallet, taker_only: opts.takerOnly, limit: 1000, cursor });
      let reached = false;
      for (const r of Array.isArray(data) ? data : []) {
        const ts = num(r.timestamp);
        if (opts.sinceTs !== undefined && ts < opts.sinceTs) {
          reached = true;
          continue;
        }
        out.push({ ts, tx: String(r.transactionHash ?? ''), token: String(r.tokenId ?? ''), side: String(r.side ?? ''), price: num(r.price), size: num(r.size) });
      }
      if (!next || reached) break;
      cursor = next;
    }
    return out.slice(0, opts.max ?? 1000);
  }

  async closedPositions(wallet: string, max = 400): Promise<Array<{ avgPrice: number; cost: number; pnl: number }>> {
    const out: Array<{ avgPrice: number; cost: number; pnl: number }> = [];
    let cursor: string | undefined;
    while (out.length < max) {
      const { data: rows, next } = await this.dataPage('positions', { user: wallet, status: 'CLOSED', limit: 50, cursor });
      for (const r of Array.isArray(rows) ? rows : []) out.push({ avgPrice: num(r.avgPrice), cost: num(r.totalSize) * num(r.avgPrice), pnl: num(r.realizedPnl) });
      if (!next) break;
      cursor = next;
    }
    return out.slice(0, max);
  }
}

export const httpFetchJson: FetchJson = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'polymarket-radar/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};
