import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketStore } from '../src/state/marketStore';
import type { AssetHealth, Instrument } from '../src/types';
const instrument = (assetId = 'a') => ({ assetId, conditionId: 'm', tickSize: '0.001' } as Instrument);
const trade = (asset_id = 'a', timestamp = '10000') => ({ event_type: 'last_trade_price', asset_id, price: '0.555', size: '2', timestamp });
const snapshot = { event_type: 'book', asset_id: 'a', bids: [{ price: '0.55', size: '3' }], asks: [{ price: '0.56', size: '4' }] };
afterEach(() => vi.useRealTimers());
const health = (overrides: Partial<AssetHealth> = {}): AssetHealth => ({ assetId: 'a', active: true, generation: 7, tickVersion: 1, initialized: true, bookReceivedAt: 10000, fresh: true, tickSize: '0.001', ...overrides });
describe('external market store', () => {
  it('resolves the default clock dynamically after construction', () => {
    const s = new MarketStore(); vi.useFakeTimers(); vi.setSystemTime(10000);
    s.setActive([instrument()]); expect(s.getAnalysis('a').observedSince).toBe(10000); s.dispose();
  });
  it('requires authoritative initialization and a local snapshot matching its identity', () => {
    const s = new MarketStore(() => 10000); s.setActive([instrument()]);
    s.applyHealth(health()); expect(s.getBook('a')?.ready).toBe(false);
    s.ingest(snapshot); expect(s.getBook('a')).toMatchObject({ ready: true, generation: 7, tickVersion: 1, bookReceivedAt: 10000 });
    s.applyHealth(health({ generation: 8, initialized: false, bookReceivedAt: null }));
    expect(s.getBook('a')?.ready).toBe(false);
    s.applyHealth(health({ generation: 8 })); expect(s.getBook('a')?.ready).toBe(false);
    s.ingest(snapshot); expect(s.getBook('a')?.ready).toBe(true);
    s.applyHealth(health()); expect(s.getBook('a')?.generation).toBe(8);
    s.applyHealth(health({ generation: 8, fresh: false })); expect(s.getBook('a')?.ready).toBe(false); s.dispose();
    const after = new MarketStore(() => 10000); after.setActive([instrument()]); after.ingest(snapshot); after.applyHealth(health());
    expect(after.getBook('a')).toMatchObject({ ready: false, generation: 7, tickVersion: 1 });
    after.ingest({ ...snapshot, generation: 0, tickVersion: 0 } as typeof snapshot);
    expect(after.getBook('a')?.ready).toBe(false);
    after.ingest({ ...snapshot, generation: 7, tickVersion: 1 } as typeof snapshot);
    expect(after.getBook('a')?.ready).toBe(true); after.dispose();
  });
  it('invalidates malformed snapshots, deltas, and tick changes until another snapshot', () => {
    const s = new MarketStore(() => 10000); s.setActive([instrument()]); s.ingest(snapshot);
    s.ingest({ event_type: 'book', asset_id: 'a', bids: [] }); expect(s.getBook('a')?.ready).toBe(false);
    s.ingest(snapshot); s.ingest({ event_type: 'price_change', price_changes: [{ asset_id: 'a', side: 'BAD' as 'BUY', price: '0.5', size: '1' }] });
    expect(s.getBook('a')?.ready).toBe(false);
    s.ingest({ event_type: 'price_change', price_changes: [{ asset_id: 'a', side: 'BUY', price: '0.5', size: '1' }] }); expect(s.getBook('a')?.ready).toBe(false);
    s.ingest(snapshot); s.ingest({ event_type: 'tick_size_change', asset_id: 'a', new_tick_size: '0.01' }); expect(s.getBook('a')?.ready).toBe(false);
    s.ingest(snapshot); s.ingest({ event_type: 'tick_size_change', asset_id: 'a', new_tick_size: 'bad' }); expect(s.getBook('a')?.ready).toBe(false); s.dispose();
  });
  it('marks the rejected late execution second at global capacity', () => {
    const s = new MarketStore(() => 20000); s.setActive([instrument()]);
    const clusters = s.getAnalysis('a').clusters; vi.spyOn(clusters, 'size', 'get').mockReturnValue(20000);
    s.ingest(trade('a', '15001'));
    expect(s.getAnalysis('a')).toMatchObject({ quality: 'PARTIAL OVERFLOW', qualityReason: 'OVERFLOW', overflows: [{ start: 15000, end: 16000 }] });
    expect(s.getAnalysis('a').gaps).toContainEqual({ start: 15000, end: 16000 }); s.dispose();
  });
  it('rejects delayed tagged snapshots and stale health without changing authoritative identity', () => {
    const s = new MarketStore(() => 10000); s.setActive([instrument()]); s.applyHealth(health());
    s.ingest({ ...snapshot, timestamp: '9990' });
    s.applyHealth(health({ generation: 8, tickVersion: 2, tickSize: '0.01' }));
    s.ingest({ ...snapshot, generation: 7, tickVersion: 1 } as typeof snapshot);
    expect(s.getBook('a')).toMatchObject({ ready: false, generation: 8, tickVersion: 2 });
    s.ingest({ ...snapshot, timestamp: '9980' }); expect(s.getBook('a')?.ready).toBe(false);
    s.ingest({ ...snapshot, timestamp: '10000', tick_size: '0.01', min_order_size: '1' });
    expect(s.getBook('a')?.ready).toBe(true);
    s.applyHealth(health({ generation: 9, tickVersion: 1 })); expect(s.getBook('a')?.generation).toBe(8);
    s.applyHealth(health({ assetId: 'inactive' })); expect(s.getBook('inactive')).toBeUndefined(); s.dispose();
  });
  it('accepts a snapshot between invalidation and initialization and expires health freshness', async () => {
    vi.useFakeTimers(); let now = 10000; const s = new MarketStore(() => now); s.setActive([instrument()]);
    s.applyHealth(health({ initialized: false, bookReceivedAt: null })); s.ingest(snapshot);
    expect(s.getBook('a')?.ready).toBe(false); s.applyHealth(health()); expect(s.getBook('a')?.ready).toBe(true);
    now = 20001; await vi.advanceTimersByTimeAsync(250); expect(s.getBook('a')?.ready).toBe(false);
    s.applyHealth(health({ bookReceivedAt: now })); expect(s.getBook('a')?.ready).toBe(true);
    s.applyHealth(health({ bookReceivedAt: now, tickSize: undefined })); expect(s.getBook('a')?.ready).toBe(false); s.dispose();
  });
  it('stops timers when inactive and unsubscribed, and can reuse the store', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000); const s = new MarketStore();
    const off = s.subscribe(() => {}); s.setActive([instrument()]); await vi.advanceTimersByTimeAsync(0);
    s.ingest(snapshot); await vi.advanceTimersByTimeAsync(0); off(); s.setActive([]);
    await vi.advanceTimersByTimeAsync(0); expect(vi.getTimerCount()).toBe(0);
    vi.setSystemTime(20000); s.setActive([instrument()]); s.ingest(snapshot);
    expect(s.getBook('a')).toMatchObject({ ready: true, bookReceivedAt: 20000 }); s.dispose();
  });
  it('resets only detached sessions, clears retained health/history, and cancels old queued publications', async () => {
    vi.useFakeTimers(); vi.setSystemTime(10000); const s = new MarketStore();
    s.setActive([instrument()]); const off = s.subscribe(() => {});
    expect(() => s.reset()).toThrow(/inactive, unsubscribed/);
    s.applyHealth(health()); s.ingest(snapshot); s.ingest(trade());
    off(); expect(() => s.reset()).toThrow(/inactive, unsubscribed/);
    s.setActive([]); s.reset();
    expect(vi.getTimerCount()).toBe(0);
    expect(s.getSnapshot().size).toBe(0); expect(s.getBook('a')).toBeUndefined();
    expect(s.getAnalysis('a').executions).toEqual([]);
    const listener = vi.fn(); const stop = s.subscribe(listener); s.setActive([instrument()]);
    s.applyHealth(health()); s.ingest(snapshot); await Promise.resolve();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot().get('a')?.ready).toBe(true);
    expect(s.getAnalysis('a').quality).toBe('APPROXIMATE');
    stop(); s.setActive([]); s.reset(); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0); s.dispose();
    expect(() => s.reset()).toThrow();
  });
  it('bounds future prints and extends disconnect gaps through idle time', async () => {
    vi.useFakeTimers(); let now = 10000; const s = new MarketStore(() => now); s.setActive([instrument()]);
    for (let i = 0; i < 1001; i++) s.ingest(trade('a', '11000'));
    s.ingest(trade('a', '14000')); s.setConnection('reconnecting');
    now = 11000; await vi.advanceTimersByTimeAsync(250);
    expect(s.getAnalysis('a').executions).toHaveLength(1000);
    expect(s.getAnalysis('a').gaps.some(g => g.start <= 10000 && g.end >= 11000)).toBe(true);
    s.setConnection('live'); expect(s.getBook('a')?.ready).toBe(false);
    now = 12000; s.ingest(snapshot); expect(s.getBook('a')?.ready).toBe(true); s.dispose();
  });
  it('has stable published snapshots and synchronous book reads', async () => {
    let now = 10000; const s = new MarketStore(() => now); s.setActive([instrument()]);
    await Promise.resolve(); const before = s.getSnapshot(); now += 50;
    s.ingest(snapshot); expect(s.getBook('a')?.ready).toBe(true);
    expect(s.getSnapshot()).toBe(before); await Promise.resolve();
    expect(s.getSnapshot()).not.toBe(before); expect(s.getSnapshot()).toBe(s.getSnapshot()); s.dispose();
  });
  it('is lazy, preserves old published books and throttles publication to twenty Hz', async () => {
    vi.useFakeTimers(); let now = 10000; const s = new MarketStore(() => now);
    expect(vi.getTimerCount()).toBe(0); s.setActive([instrument()]);
    const listener = vi.fn(); const off = s.subscribe(listener); await Promise.resolve();
    const oldBook = s.getSnapshot().get('a'); expect(oldBook?.ready).toBe(false);
    for (let i = 0; i < 20; i++) { s.ingest(snapshot); await Promise.resolve(); }
    expect(listener).toHaveBeenCalledTimes(1); expect(oldBook?.ready).toBe(false);
    now += 50; await vi.advanceTimersByTimeAsync(50); expect(listener).toHaveBeenCalledTimes(2);
    expect(s.getSnapshot().get('a')?.ready).toBe(true); off(); s.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('handles BBO without making an unsnapshotted book ready', () => {
    const s = new MarketStore(() => 10000); s.setActive([instrument()]);
    s.ingest({ event_type: 'best_bid_ask', asset_id: 'a', best_bid: '0.551', best_ask: '0.559' });
    expect(s.getBook('a')).toMatchObject({ bestBid: '0.551', bestAsk: '0.559', ready: false }); s.dispose();
  });
  it('keeps all analysis beyond 40 prints and caps the global raw tape at 1000', () => {
    const s = new MarketStore(() => 10000); s.setActive([instrument(), instrument('b')]);
    for (let i = 0; i < 1100; i++) s.ingest(trade(i % 2 ? 'a' : 'b'));
    expect(s.getAnalysis('a').executions).toHaveLength(550);
    expect([...['a', 'b']].reduce((n, id) => n + s.getBook(id)!.recentTrades.length, 0)).toBe(1000);
    expect(new Set(['a', 'b'].flatMap(id => s.getBook(id)!.recentTrades.map(t => t.id))).size).toBe(1000); s.dispose();
  });
  it('does not invent BUY or trust transaction hashes; malformed timestamps use receipt', () => {
    const s = new MarketStore(() => 10000); s.setActive([instrument()]);
    s.ingest({ ...trade(), timestamp: 'bad', transaction_hash: 'same' }); s.ingest({ ...trade(), side: 'SELL', transaction_hash: 'same' });
    expect(s.getAnalysis('a').executions.map(e => e.side)).toEqual(['UNKNOWN', 'SELL']);
    expect(s.getAnalysis('a').executions[0].timeSource).toBe('receipt');
    expect(s.getAnalysis('a').executions.every(e => e.identity === 'AMBIGUOUS')).toBe(true);
    expect(s.getBook('a')!.recentTrades).toHaveLength(2);
    expect(s.getBook('a')!.recentTrades[1]).toMatchObject({ timeSource: 'receipt', receivedAt: 10000, identity: 'AMBIGUOUS', quality: 'APPROXIMATE' });
    expect(s.getBook('a')!.recentTrades[0]).toMatchObject({ timeSource: 'provider', receivedAt: 10000, identity: 'AMBIGUOUS', quality: 'APPROXIMATE' }); s.dispose();
  });
  it('invalidates readiness on disconnect and does not reset on focus/no-op active set', () => {
    let now = 10000; const s = new MarketStore(() => now); s.setActive([instrument()]); s.ingest(snapshot); s.ingest(trade());
    s.setActive([instrument()]); expect(s.getBook('a')?.ready).toBe(true);
    s.setConnection('reconnecting'); expect(s.getBook('a')?.ready).toBe(false);
    now = 11000; s.setConnection('live'); expect(s.getBook('a')?.ready).toBe(false); s.ingest(snapshot);
    expect(s.getAnalysis('a').gaps.length).toBeGreaterThan(0);
    expect(s.getAnalysis('a').executions).toHaveLength(1); s.dispose();
  });
  it('retains paused history and records a resume gap', () => {
    let now = 10000; const s = new MarketStore(() => now); s.setActive([instrument()]); s.ingest(trade()); s.setActive([]);
    now = 12000; s.setActive([instrument()]); expect(s.getAnalysis('a').executions).toHaveLength(1);
    expect(s.getAnalysis('a').gaps).toContainEqual({ start: 10000, end: 12000 }); s.dispose();
  });
  it('applies native tick changes and deltas without unsupported tick clamps', () => {
    const s = new MarketStore(() => 10000); s.setActive([instrument()]); s.ingest(snapshot); s.ingest(trade());
    s.ingest({ event_type: 'tick_size_change', asset_id: 'a', new_tick_size: '0.000001' });
    expect(s.getBook('a')?.tickSize).toBe('0.000001');
    s.ingest({ event_type: 'price_change', price_changes: [{ asset_id: 'a', side: 'BUY', price: '0.55', size: '0' }] });
    expect(s.getBook('a')?.bids.size).toBe(0);
    expect(s.getAnalysis('a').executions[0].priceUnits).toBe(555000); s.dispose();
  });
  it('rolls idle epochs and releases bounded future prints via one timer', async () => {
    vi.useFakeTimers(); let now = 10000; const s = new MarketStore(() => now); s.setActive([instrument()]); const listener = vi.fn(); s.subscribe(listener);
    s.ingest(trade('a', '11000')); expect(s.getAnalysis('a').executions).toHaveLength(0);
    now = 11000; await vi.advanceTimersByTimeAsync(250); expect(s.getAnalysis('a').executions).toHaveLength(1);
    now = 22000; await vi.advanceTimersByTimeAsync(250); expect(s.getAnalysis('a').executions).toHaveLength(0);
    expect(listener).toHaveBeenCalled(); s.dispose(); expect(vi.getTimerCount()).toBe(0);
  });
  it('makes invalid, quarantine and future queue overflow visible', () => {
    const s = new MarketStore(() => 10000); s.setActive([instrument()]); s.ingest({ ...trade(), price: 'bad' });
    s.ingest(trade('a', '14000')); for (let i = 0; i < 1001; i++) s.ingest(trade('a', '11000'));
    expect(s.getAnalysis('a').quality).toMatch(/^PARTIAL/); expect(s.getAnalysis('a').qualityReason).toBe('OVERFLOW'); expect(s.getAnalysis('a').gaps.length).toBeGreaterThan(0); s.dispose();
  });
  it('processes six assets at 100 events/s for sixty seconds with exact retained aggregates', () => {
    let now = 10000; const s = new MarketStore(() => now); s.setActive(Array.from({ length: 6 }, (_, i) => instrument(String(i))));
    for (let second = 0; second < 60; second++) { now = 10000 + second * 1000; for (let i = 0; i < 600; i++) s.ingest(trade(String(i % 6), String(now))); }
    for (let i = 0; i < 6; i++) { const a = s.getAnalysis(String(i)); const buckets = a.clusters.project({ nowMs: now, intervalSeconds: 60, tickUnits: 1000 }); expect(buckets.reduce((sum, b) => sum + b.rows.reduce((n, r) => n + r.total, 0n), 0n)).toBe(12000000000n); }
    s.dispose();
  });
});
