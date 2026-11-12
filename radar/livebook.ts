import type { Book } from './polymarket.ts';
import type { TradeRow } from './store.ts';

/**
 * Live order book of one outcome token, kept in sync from Polymarket's market WebSocket (wss://ws-subscriptions-clob.polymarket.com/ws/market):
 *   book              full snapshot on subscribe
 *   price_change      one level's new TOTAL size (0 removes it), side BUY = bid, SELL = ask; a message carries both tokens of the market, so we filter by asset_id
 *   last_trade_price  a fill (price, size, taker side, transaction hash)
 *   tick_size_change  new minimum price step
 * Prices are stored as integer "mills" (price x 1000) so levels compare exactly. A hot market sends ~300 updates a second: the feed throttles what it hands to the UI.
 * If the socket is down the feed polls the REST book every few seconds instead, and while live it re-syncs from REST now and then to correct any drift.
 */

export const MILLS = 1000;
export const toMills = (price: number): number => Math.round(price * MILLS);
export type FeedStatus = 'connecting' | 'live' | 'polling' | 'down';

export interface LiveTrade {
  /** Epoch seconds (fractional). */
  ts: number;
  /** Taker side: BUY lifted an ask, SELL hit a bid. */
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  tx: string | null;
  wallet: string | null;
}

export interface LiveState {
  tokenId: string;
  bids: Map<number, number>;
  asks: Map<number, number>;
  tickMills: number;
  trades: LiveTrade[];
  status: FeedStatus;
  updatedAt: number | null;
  frames: number;
  synced: boolean;
  error: string | null;
}

export const MAX_TRADES = 3_000;

export function newLiveState(tokenId: string, tickMills = 10): LiveState {
  return { tokenId, bids: new Map(), asks: new Map(), tickMills, trades: [], status: 'connecting', updatedAt: null, frames: 0, synced: false, error: null };
}

const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v));
  return Number.isFinite(n) ? n : NaN;
};

export function applySnapshot(s: LiveState, bids: ReadonlyArray<{ price: unknown; size: unknown }>, asks: ReadonlyArray<{ price: unknown; size: unknown }>): void {
  const fill = (m: Map<number, number>, ls: ReadonlyArray<{ price: unknown; size: unknown }>) => {
    m.clear();
    for (const l of ls) {
      const p = num(l.price);
      const z = num(l.size);
      if (p > 0 && p < 1 && z > 0) m.set(toMills(p), z);
    }
  };
  fill(s.bids, bids);
  fill(s.asks, asks);
  s.synced = true;
}

export function bookToLevels(b: Book): { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> } {
  return { bids: b.bids, asks: b.asks };
}

const tradeKey = (t: { tx: string | null; price: number; size: number; side: string }): string => `${t.tx ?? ''}|${toMills(t.price)}|${t.size}|${t.side}`;

function pushTrade(s: LiveState, t: LiveTrade): void {
  if (t.tx && s.trades.some((x) => x.tx === t.tx && toMills(x.price) === toMills(t.price) && x.size === t.size && x.side === t.side)) return;
  s.trades.push(t);
  if (s.trades.length > MAX_TRADES) s.trades.splice(0, s.trades.length - MAX_TRADES);
}

/** Applies one WebSocket event. Returns true when anything the screen shows changed. Events for other tokens are ignored. */
export function applyEvent(s: LiveState, ev: Record<string, any>, nowMs: number): boolean {
  if (!ev || typeof ev !== 'object') return false;
  s.frames++;
  switch (ev.event_type) {
    case 'book': {
      if (ev.asset_id !== s.tokenId) return false;
      applySnapshot(s, Array.isArray(ev.bids) ? ev.bids : [], Array.isArray(ev.asks) ? ev.asks : []);
      s.updatedAt = nowMs;
      return true;
    }
    case 'price_change': {
      let changed = false;
      const changes: Array<Record<string, any>> = Array.isArray(ev.price_changes) ? ev.price_changes : ev.asset_id ? [ev] : [];
      for (const ch of changes) {
        if (ch.asset_id !== s.tokenId) continue;
        const p = toMills(num(ch.price));
        const z = num(ch.size);
        if (!(p > 0 && p < MILLS) || !Number.isFinite(z)) continue;
        const side = ch.side === 'BUY' ? s.bids : ch.side === 'SELL' ? s.asks : null;
        if (!side) continue;
        if (z <= 0) side.delete(p);
        else side.set(p, z);
        changed = true;
      }
      if (changed) s.updatedAt = nowMs;
      return changed;
    }
    case 'last_trade_price': {
      if (ev.asset_id !== s.tokenId) return false;
      const price = num(ev.price);
      const size = num(ev.size);
      if (!(price > 0 && price < 1) || !(size > 0) || (ev.side !== 'BUY' && ev.side !== 'SELL')) return false;
      const ts = Number(ev.timestamp) > 1e12 ? Number(ev.timestamp) / 1000 : Number(ev.timestamp) || nowMs / 1000;
      pushTrade(s, { ts, side: ev.side, price, size, tx: typeof ev.transaction_hash === 'string' ? ev.transaction_hash : null, wallet: null });
      s.updatedAt = nowMs;
      return true;
    }
    case 'tick_size_change': {
      if (ev.asset_id !== s.tokenId) return false;
      const t = toMills(num(ev.new_tick_size));
      if (t >= 1 && t <= 100) s.tickMills = t;
      return true;
    }
    default:
      return false;
  }
}

/** Folds REST fills (which carry the wallet) into the trade list: the same fill seen on the socket gets its wallet attached; older fills fill in the history. Only fills of THIS token are used. */
export function mergeRestTrades(s: LiveState, rows: readonly TradeRow[], tokenIndex: number): void {
  const byKey = new Map(s.trades.map((t) => [tradeKey(t), t]));
  for (const r of rows) {
    if (r.outcomeIndex !== tokenIndex) continue;
    const t: LiveTrade = { ts: r.ts, side: r.side, price: r.price, size: r.size, tx: r.tx, wallet: r.wallet };
    const have = byKey.get(tradeKey(t));
    if (have) {
      if (!have.wallet) have.wallet = r.wallet;
      continue;
    }
    // a socket fill lacks the wallet but may have a slightly different float; match on tx + price + side when sizes differ only in rounding
    const near = r.tx ? s.trades.find((x) => x.tx === r.tx && toMills(x.price) === toMills(r.price) && x.side === r.side && Math.abs(x.size - r.size) < 0.01) : undefined;
    if (near) {
      near.wallet = near.wallet ?? r.wallet;
      continue;
    }
    s.trades.push(t);
    byKey.set(tradeKey(t), t);
  }
  s.trades.sort((a, b) => a.ts - b.ts);
  if (s.trades.length > MAX_TRADES) s.trades.splice(0, s.trades.length - MAX_TRADES);
}

export interface WsLike {
  send(data: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
}

export const MARKET_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export interface FeedOptions {
  tokenId: string;
  /** Which outcome this token is (0 = first outcome), to pick its fills out of the market's trade list. */
  tokenIndex: number;
  tickMills?: number;
  url?: string;
  wsFactory?: (url: string) => WsLike;
  fetchBook: () => Promise<Book>;
  fetchTrades: () => Promise<TradeRow[]>;
  onUpdate: (s: LiveState) => void;
  now?: () => number;
  /** Minimum time between UI updates. */
  throttleMs?: number;
}

export class LiveBookFeed {
  readonly state: LiveState;
  private ws: WsLike | null = null;
  private running = false;
  private dirty = false;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnect: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private lastFrame = 0;
  private lastBookSync = 0;
  private lastTradeSync = 0;
  private busy = false;

  private readonly o: FeedOptions;

  constructor(o: FeedOptions) {
    this.o = o;
    this.state = newLiveState(o.tokenId, o.tickMills ?? 10);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.resync(true);
    this.connect();
    this.tick = setInterval(() => void this.resync(false), 1_000);
  }

  stop(): void {
    this.running = false;
    for (const t of [this.emitTimer, this.reconnect]) if (t) clearTimeout(t);
    for (const t of [this.tick, this.heartbeat]) if (t) clearInterval(t);
    this.emitTimer = this.reconnect = null;
    this.tick = this.heartbeat = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (!this.dirty || !this.running) return;
      this.dirty = false;
      this.o.onUpdate(this.state);
    }, this.o.throttleMs ?? 120);
  }

  private connect(): void {
    if (!this.running || this.ws) return;
    this.state.status = this.state.synced ? 'polling' : 'connecting';
    let ws: WsLike;
    try {
      ws = (this.o.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WsLike))(this.o.url ?? MARKET_WS_URL);
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
      this.down();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.lastFrame = this.now();
      ws.send(JSON.stringify({ assets_ids: [this.o.tokenId], type: 'market' }));
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (this.ws !== ws) return;
        if (this.now() - this.lastFrame > 30_000) return ws.close(); // silent socket: reconnect
        try {
          ws.send('PING');
        } catch {
          /* the close handler takes over */
        }
      }, 10_000);
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      this.lastFrame = this.now();
      const text = String(e.data);
      if (text === 'PONG') return;
      let msgs: unknown;
      try {
        msgs = JSON.parse(text);
      } catch {
        return;
      }
      let changed = false;
      for (const m of Array.isArray(msgs) ? msgs : [msgs]) {
        const was = this.state.synced;
        if (applyEvent(this.state, m as Record<string, any>, this.now())) changed = true;
        if ((m as Record<string, any>)?.event_type === 'book') this.attempt = 0; // only a real book frame proves the subscription worked
        if ((m as Record<string, any>)?.event_type === 'book' && this.state.synced && !was) this.lastBookSync = this.now();
        if ((m as Record<string, any>)?.event_type === 'book' && (m as Record<string, any>).asset_id === this.o.tokenId) this.state.status = 'live';
      }
      if (changed || this.state.status === 'live') this.markDirty();
    };
    ws.onclose = () => this.ws === ws && this.down();
    ws.onerror = () => this.ws === ws && this.down();
  }

  private down(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    if (!this.running) return;
    this.state.status = 'polling';
    this.markDirty();
    const delay = Math.min(1_000 * 2 ** this.attempt, 15_000) + Math.floor(Math.random() * 250);
    this.attempt++;
    if (this.reconnect) clearTimeout(this.reconnect);
    this.reconnect = setTimeout(() => {
      this.reconnect = null;
      this.connect();
    }, delay);
  }

  /** REST: the book every 3s while the socket is down (30s to correct drift while live), the fills every 3s / 10s. */
  private async resync(first: boolean): Promise<void> {
    if (!this.running || this.busy) return;
    const live = this.state.status === 'live';
    const t = this.now();
    const bookDue = first || t - this.lastBookSync >= (live ? 30_000 : 3_000);
    const tradesDue = first || t - this.lastTradeSync >= (live ? 10_000 : 3_000);
    if (!bookDue && !tradesDue) return;
    this.busy = true;
    try {
      if (bookDue) {
        this.lastBookSync = t;
        const b = await this.o.fetchBook();
        if (this.running) {
          applySnapshot(this.state, b.bids, b.asks);
          this.state.updatedAt = this.now();
          this.state.error = null;
          if (this.state.status === 'connecting') this.state.status = 'polling';
        }
      }
      if (tradesDue) {
        this.lastTradeSync = t;
        const rows = await this.o.fetchTrades().catch(() => null);
        if (rows && this.running) mergeRestTrades(this.state, rows, this.o.tokenIndex);
      }
      if (this.running) this.markDirty();
    } catch (error) {
      this.state.error = error instanceof Error ? error.message : String(error);
      if (this.running) this.markDirty();
    } finally {
      this.busy = false;
    }
  }
}
