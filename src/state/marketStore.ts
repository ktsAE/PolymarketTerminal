import type { AssetHealth, BookState, ConnectionStatus, Instrument, MarketEvent, TradePrint } from '../types';
import { ClusterStore, type GapReason } from '../domain/clusters';
import { normalizeExecution, qualifyingPrints, type Execution } from '../domain/executions';
import { parseShares, parseUnits, formatUnits, formatShares } from '../../shared/decimal.cjs';
type FeedBook = BookState & { generation?: number; tickVersion?: number; bookReceivedAt?: number };
type Gap = { start: number; end: number };
interface Asset {
  instrument: Instrument; book: FeedBook; clusters: ClusterStore; executions: Execution[];
  observedSince: number; gaps: Gap[]; pausedAt?: number; disconnectedAt?: number;
  health?: AssetHealth; snapshotGeneration?: number; snapshotTickVersion?: number; snapshotTimestamp?: number;
}
/** Adapter boundary: all feed events enter here before any component observes them.
 * Published maps/books are immutable by convention; do not mutate getSnapshot(). */
export class MarketStore {
  private assets = new Map<string, Asset>();
  private active = new Set<string>();
  private listeners = new Set<() => void>();
  private snapshot: ReadonlyMap<string, BookState> = new Map();
  private timer?: ReturnType<typeof setInterval>;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private queued = false;
  private disposed = false;
  private lastPublished = -Infinity;
  private sequence = 0;
  private generation = 0;
  private lifecycle = 0;
  private connection: ConnectionStatus = 'idle';
  private future: Execution[] = [];
  private tape: { assetId: string; id: string }[] = [];
  constructor(private clock: () => number = () => Date.now()) {}
  private invalidateBook(a: Asset): void {
    a.snapshotGeneration = undefined; a.snapshotTickVersion = undefined;
    if (a.health) a.health = { ...a.health, initialized: false };
    a.book = { ...a.book, ready: false };
  }
  private ready(a: Asset): boolean {
    return a.snapshotGeneration === a.book.generation && a.snapshotTickVersion === a.book.tickVersion &&
      (!a.health || (a.health.active && a.health.initialized && a.health.fresh &&
        a.health.bookReceivedAt !== null && this.clock() - a.health.bookReceivedAt <= 10000));
  }
  applyHealth(health: AssetHealth): void {
    const a = !this.disposed && this.active.has(health.assetId) ? this.assets.get(health.assetId) : undefined;
    if (!a) return;
    const previous = a.health;
    if (previous && (health.generation < previous.generation || health.tickVersion < previous.tickVersion ||
      (health.generation === previous.generation && health.tickVersion === previous.tickVersion &&
        health.bookReceivedAt !== null && previous.bookReceivedAt !== null && health.bookReceivedAt < previous.bookReceivedAt))) return;
    // Health describes identity, not book contents. Never relabel a previously received
    // snapshot as belonging to a different generation (including the first health).
    if (health.generation !== a.book.generation || health.tickVersion !== a.book.tickVersion) this.invalidateBook(a);
    a.health = { ...health };
    a.book = { ...a.book, generation: health.generation, tickVersion: health.tickVersion, bookReceivedAt: health.bookReceivedAt ?? undefined };
    try {
      const tick = parseUnits(health.tickSize ?? ''); if (tick <= 0) throw new Error('Invalid tick');
      a.book = { ...a.book, tickSize: formatUnits(tick) };
    } catch { this.invalidateBook(a); }
    if (!health.active || !health.initialized) this.invalidateBook(a);
    a.book = { ...a.book, ready: this.ready(a) }; this.schedule();
  }
  getSnapshot = (): ReadonlyMap<string, BookState> => this.snapshot;
  getBook = (assetId: string): BookState | undefined => this.assets.get(assetId)?.book;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); this.ensureTimer();
    return () => { this.listeners.delete(listener); this.ensureTimer(); };
  };
  private ensureTimer(): void {
    if (!this.disposed && (this.active.size || this.listeners.size)) this.timer ??= setInterval(() => this.tick(), 250);
    else {
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      if (this.publishTimer) { clearTimeout(this.publishTimer); this.publishTimer = undefined; }
    }
  }
  private schedule(): void {
    if (this.disposed || this.queued || this.publishTimer) return;
    this.queued = true;
    const lifecycle = this.lifecycle;
    queueMicrotask(() => {
      if (lifecycle !== this.lifecycle) return;
      this.queued = false; if (this.disposed) return;
      if (!this.active.size && !this.listeners.size) { this.lastPublished = -Infinity; this.publish(); return; }
      const elapsed = this.clock() - this.lastPublished;
      const delay = elapsed < 0 ? 0 : 50 - elapsed;
      if (delay > 0) this.publishTimer = setTimeout(() => { this.publishTimer = undefined; this.publish(); }, delay);
      else this.publish();
    });
  }
  private publish(): void {
    if (this.disposed) return;
    this.lastPublished = this.clock();
    this.snapshot = new Map([...this.active].flatMap(id => { const a = this.assets.get(id); return a ? [[id, a.book] as const] : []; }));
    for (const listener of this.listeners) listener();
  }
  setActive(instruments: Instrument[]): void {
    if (this.disposed) return;
    const now = this.clock(); const next = new Set(instruments.map(i => i.assetId));
    for (const id of this.active) if (!next.has(id)) { const a = this.assets.get(id)!; a.pausedAt = now; this.invalidateBook(a); }
    for (const instrument of instruments) {
      let a = this.assets.get(instrument.assetId);
      if (!a) {
        a = { instrument, book: { assetId: instrument.assetId, bids: new Map(), asks: new Map(), tickSize: instrument.tickSize, recentTrades: [], ready: false, generation: this.generation, tickVersion: 0 }, clusters: new ClusterStore({ startedAtMs: now }), executions: [], observedSince: now, gaps: [] };
        this.assets.set(instrument.assetId, a);
      } else {
        a.instrument = instrument;
        if (a.pausedAt !== undefined) { this.gap(a, a.pausedAt, now); a.pausedAt = undefined; }
      }
    }
    this.active = next; this.future = this.future.filter(e => next.has(e.assetId)); this.ensureTimer(); this.prune(now); this.schedule();
  }
  setConnection(status: ConnectionStatus): void {
    if (this.disposed || status === this.connection) return;
    this.connection = status; const now = this.clock();
    if (status !== 'live') {
      this.generation++;
      for (const id of this.active) { const a = this.assets.get(id)!; a.disconnectedAt ??= now; this.invalidateBook(a); if (!a.health) a.book = { ...a.book, generation: this.generation }; }
    }
    // Only an authoritative snapshot restores readiness and closes the gap.
    this.schedule();
  }
  private gap(a: Asset, start: number, end: number, reason: GapReason = 'CONNECTION'): void {
    end = Math.max(start + 1, end); a.clusters.markGap(start, end, reason);
    const gaps = [...a.gaps, { start, end }].sort((x, y) => x.start - y.start); const merged: Gap[] = [];
    for (const g of gaps) { const last = merged[merged.length - 1]; if (last && g.start <= last.end) last.end = Math.max(last.end, g.end); else merged.push({ ...g }); }
    while (merged.length > 1024) { const first = merged.shift()!; merged[0].start = first.start; } a.gaps = merged;
  }
  private invalid(a: Asset, now: number): void { this.gap(a, Math.floor(now / 1000) * 1000, now + 1, 'INVALID'); }
  private overflow(a: Asset, e: Execution): void {
    const second = Math.floor(e.timestampMs / 1000) * 1000;
    this.gap(a, second, second + 1000, 'OVERFLOW');
  }
  private levels(levels: { price: string; size: string }[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const level of levels) { const price = formatUnits(parseUnits(level.price)); const shares = parseShares(level.size); if (shares > 0n) result.set(price, level.size); }
    return result;
  }
  private best(levels: Map<string, string>, side: 'BUY' | 'SELL'): string | undefined {
    let best: string | undefined; for (const price of levels.keys()) if (best === undefined || (side === 'BUY' ? parseUnits(price) > parseUnits(best) : parseUnits(price) < parseUnits(best))) best = price; return best;
  }
  ingest(event: MarketEvent): void {
    if (this.disposed) return;
    const now = this.clock();
    if (event.event_type === 'price_change') {
      if (!Array.isArray(event.price_changes) || event.price_changes.some(change => !change || typeof change.asset_id !== 'string')) {
        for (const id of this.active) { const a = this.assets.get(id)!; this.invalid(a, now); this.invalidateBook(a); }
        this.schedule(); return;
      }
      for (const change of event.price_changes) {
        const a = this.active.has(change.asset_id) ? this.assets.get(change.asset_id) : undefined; if (!a) continue;
        try {
          if (change.side !== 'BUY' && change.side !== 'SELL') throw new Error('Unknown book side');
          const key = change.side === 'BUY' ? 'bids' : 'asks'; const levels = new Map(a.book[key]); const price = formatUnits(parseUnits(change.price));
          if (parseShares(change.size) === 0n) levels.delete(price); else levels.set(price, change.size);
          a.book = { ...a.book, [key]: levels, timestamp: event.timestamp, bookReceivedAt: a.health ? a.health.bookReceivedAt ?? undefined : now };
          a.book = { ...a.book, bestBid: this.best(a.book.bids, 'BUY'), bestAsk: this.best(a.book.asks, 'SELL') };
        } catch { this.invalid(a, now); this.invalidateBook(a); }
      }
      this.schedule(); return;
    }
    const a = event.asset_id && this.active.has(event.asset_id) ? this.assets.get(event.asset_id) : undefined; if (!a) return;
    try {
      switch (event.event_type) {
        case 'book': {
          const tagged = event as MarketEvent & { generation?: number; tickVersion?: number };
          if ((tagged.generation !== undefined && tagged.generation !== a.book.generation) ||
            (tagged.tickVersion !== undefined && tagged.tickVersion !== a.book.tickVersion)) return;
          const timestamp = event.timestamp && /^\d+$/.test(event.timestamp) ? Number(event.timestamp) : undefined;
          if (timestamp !== undefined && a.snapshotTimestamp !== undefined && timestamp < a.snapshotTimestamp) return;
          if (!Array.isArray(event.bids) || !Array.isArray(event.asks)) throw new Error('Snapshot requires both sides');
          const tick = parseUnits(event.tick_size ?? a.health?.tickSize ?? a.book.tickSize);
          if (tick <= 0 || (a.health && tick !== parseUnits(a.health.tickSize ?? ''))) throw new Error('Invalid snapshot tick');
          if (event.min_order_size !== undefined && parseShares(event.min_order_size) <= 0n) throw new Error('Invalid minimum');
          const bids = this.levels(event.bids); const asks = this.levels(event.asks);
          a.snapshotGeneration = a.book.generation; a.snapshotTickVersion = a.book.tickVersion; a.snapshotTimestamp = timestamp;
          a.book = { ...a.book, bids, asks, tickSize: formatUnits(tick), bestBid: this.best(bids, 'BUY'), bestAsk: this.best(asks, 'SELL'), timestamp: event.timestamp, bookReceivedAt: a.health ? a.health.bookReceivedAt ?? undefined : now };
          a.book = { ...a.book, ready: this.ready(a) };
          if (a.disconnectedAt !== undefined) { this.gap(a, a.disconnectedAt, now); a.disconnectedAt = undefined; } break;
        }
        case 'best_bid_ask':
          a.book = { ...a.book, bestBid: event.best_bid === undefined ? undefined : formatUnits(parseUnits(event.best_bid)), bestAsk: event.best_ask === undefined ? undefined : formatUnits(parseUnits(event.best_ask)), timestamp: event.timestamp }; break;
        case 'tick_size_change': {
          const tick = parseUnits(event.new_tick_size ?? ''); if (tick <= 0) throw new Error('Invalid tick');
          this.invalidateBook(a);
          a.book = { ...a.book, tickSize: formatUnits(tick), tickVersion: a.health ? a.health.tickVersion : (a.book.tickVersion ?? 0) + 1 }; break;
        }
        case 'last_trade_price': {
          const timestampMs = typeof event.timestamp === 'string' && /^\d+$/.test(event.timestamp) ? Number(event.timestamp) : undefined;
          const result = normalizeExecution({ marketId: event.market || a.instrument.conditionId || a.instrument.assetId, assetId: a.instrument.assetId, price: event.price ?? '', size: event.size ?? '', side: event.side, timestampMs, transactionHash: event.transaction_hash }, now);
          if (!result.execution || result.status === 'invalid' || result.status === 'quarantined') this.invalid(a, now);
          else if (result.status === 'held') { if (this.future.length >= 1000) this.overflow(a, result.execution); else this.future.push(result.execution); }
          else this.admit(a, result.execution, now); break;
        }
      }
    } catch { this.invalid(a, now); if (event.event_type !== 'last_trade_price') this.invalidateBook(a); }
    this.schedule();
  }
  private admit(a: Asset, e: Execution, now: number): void {
    // Global budgets, not a multiplied per-instrument allowance.
    let records = 0; let cells = 0;
    for (const asset of this.assets.values()) { asset.clusters.prune(now); records += asset.clusters.size; cells += asset.clusters.cellCount; }
    if (records >= 20000 || (cells >= 100000 && !a.clusters.hasCell(e))) { this.overflow(a, e); return; }
    const result = a.clusters.ingest(e, now);
    if (result === 'overflow') { this.overflow(a, e); return; }
    if (result === 'quarantined') { this.invalid(a, now); return; }
    if (result !== 'inserted' && result !== 'corrected') return;
    a.executions = qualifyingPrints([...a.executions, e], now, 0n);
    const id = String(++this.sequence);
    const print: TradePrint = { id, price: formatUnits(e.priceUnits), size: formatShares(e.shares), side: e.side, timestamp: String(e.timestampMs), timeSource: e.timeSource, identity: e.identity, receivedAt: e.receiptMs, quality: e.identity === 'AMBIGUOUS' || e.timeSource === 'receipt' ? 'APPROXIMATE' : 'EXACT' };
    a.book = { ...a.book, lastTrade: print.price, lastTradeSize: print.size, lastTradeSide: print.side, recentTrades: [print, ...a.book.recentTrades], timestamp: print.timestamp };
    this.tape.push({ assetId: e.assetId, id });
    if (this.tape.length > 1000) { const oldest = this.tape.shift()!; const owner = this.assets.get(oldest.assetId); if (owner) owner.book = { ...owner.book, recentTrades: owner.book.recentTrades.filter(t => t.id !== oldest.id) }; }
  }
  private prune(now: number): void {
    for (const [id, a] of this.assets) {
      a.clusters.prune(now); a.executions = qualifyingPrints(a.executions, now, 0n); a.gaps = a.gaps.filter(g => g.end > now - 600000);
      if (!this.active.has(id) && a.pausedAt !== undefined && now - a.pausedAt > 600000) this.assets.delete(id);
    }
  }
  private tick(): void {
    const now = this.clock(); this.prune(now);
    const held = this.future; this.future = [];
    for (const e of held) { if (e.timestampMs > now) this.future.push(e); else { const a = this.assets.get(e.assetId); if (a && this.active.has(e.assetId)) this.admit(a, e, now); } }
    for (const id of this.active) {
      const a = this.assets.get(id)!;
      if (a.disconnectedAt !== undefined) this.gap(a, a.disconnectedAt, now);
      if (a.health && a.book.ready !== this.ready(a)) a.book = { ...a.book, ready: this.ready(a) };
    }
    this.schedule();
  }
  getAnalysis = (assetId: string): { clusters: ClusterStore; executions: Execution[]; observedSince: number; gaps: Gap[]; overflows: Gap[]; quality: string; qualityReason?: GapReason; nowMs: number } => {
    const nowMs = this.clock(); const a = this.assets.get(assetId);
    if (!a) return { clusters: this.emptyClusters, executions: [], observedSince: nowMs, gaps: [], overflows: [], quality: 'UNAVAILABLE', nowMs };
    a.clusters.prune(nowMs);
    const overflows = a.clusters.getGaps('OVERFLOW');
    const qualityReason: GapReason | undefined = overflows.length ? 'OVERFLOW' :
      a.clusters.getGaps('INVALID').length ? 'INVALID' :
      a.clusters.getGaps('CONNECTION').length || a.disconnectedAt !== undefined || a.pausedAt !== undefined ? 'CONNECTION' : undefined;
    const gaps = a.gaps.filter(g => g.end > Math.floor(nowMs / 1000) * 1000 - 600000).map(g => ({ ...g }));
    return { clusters: a.clusters, executions: qualifyingPrints(a.executions, nowMs, 0n), observedSince: a.observedSince, gaps, overflows, qualityReason,
      quality: qualityReason === 'OVERFLOW' ? 'PARTIAL OVERFLOW' : qualityReason === 'INVALID' ? 'PARTIAL INVALID GAP' : qualityReason ? 'PARTIAL GAP' : 'APPROXIMATE', nowMs };
  };
  private emptyClusters = new ClusterStore();
  /** Clear retained session data only after all consumers have detached. Unlike dispose,
   * this leaves the store reusable for a new isolated session. */
  reset(): void {
    if (this.disposed || this.listeners.size || this.active.size) throw new Error('Reset requires an inactive, unsubscribed store');
    this.lifecycle++;
    if (this.timer) clearInterval(this.timer);
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.timer = undefined; this.publishTimer = undefined; this.queued = false;
    this.assets.clear(); this.future = []; this.tape = []; this.snapshot = new Map();
    this.sequence = 0; this.generation = 0; this.connection = 'idle'; this.lastPublished = -Infinity;
    this.emptyClusters = new ClusterStore();
  }
  dispose(): void {
    this.disposed = true; if (this.timer) clearInterval(this.timer); if (this.publishTimer) clearTimeout(this.publishTimer);
    this.timer = undefined; this.publishTimer = undefined; this.listeners.clear(); this.future = []; this.assets.clear(); this.active.clear(); this.tape = []; this.snapshot = new Map();
  }
}
export const marketStore = new MarketStore();
