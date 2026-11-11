import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyEvent, applySnapshot, LiveBookFeed, mergeRestTrades, newLiveState, toMills, type WsLike } from '../../radar/livebook';

const TOK = '111';
const OTHER = '222';
const level = (price: string, size: string) => ({ price, size });

describe('live book events', () => {
  it('replaces both sides on a book snapshot and ignores another token', () => {
    const s = newLiveState(TOK);
    expect(applyEvent(s, { event_type: 'book', asset_id: OTHER, bids: [level('0.4', '5')], asks: [] }, 1)).toBe(false);
    expect(s.bids.size).toBe(0);
    expect(applyEvent(s, { event_type: 'book', asset_id: TOK, bids: [level('0.48', '100'), level('0.47', '50')], asks: [level('0.5', '70'), level('1', '9'), level('0', '9')] }, 7)).toBe(true);
    expect([...s.bids]).toEqual([[480, 100], [470, 50]]);
    expect([...s.asks]).toEqual([[500, 70]]); // prices of 0 and 1 are not levels
    expect(s.synced).toBe(true);
    expect(s.updatedAt).toBe(7);
  });
  it('applies price_change as the level\'s new total size: BUY is a bid, SELL an ask, size 0 removes, other tokens are skipped', () => {
    const s = newLiveState(TOK);
    applySnapshot(s, [level('0.48', '100')], [level('0.5', '70')]);
    const ev = { event_type: 'price_change', price_changes: [
      { asset_id: TOK, price: '0.48', size: '250', side: 'BUY' },
      { asset_id: TOK, price: '0.5', size: '0', side: 'SELL' },
      { asset_id: TOK, price: '0.51', size: '40', side: 'SELL' },
      { asset_id: OTHER, price: '0.52', size: '999', side: 'SELL' },
      { asset_id: TOK, price: 'x', size: '1', side: 'BUY' },
    ] };
    expect(applyEvent(s, ev, 1)).toBe(true);
    expect([...s.bids]).toEqual([[480, 250]]);
    expect([...s.asks]).toEqual([[510, 40]]);
    expect(applyEvent(s, { event_type: 'price_change', price_changes: [{ asset_id: OTHER, price: '0.3', size: '1', side: 'BUY' }] }, 1)).toBe(false);
  });
  it('records fills from last_trade_price once, with the taker side and the transaction hash', () => {
    const s = newLiveState(TOK);
    const ev = { event_type: 'last_trade_price', asset_id: TOK, price: '0.62', size: '46.62', side: 'SELL', timestamp: '1794404025505', transaction_hash: '0xabc' };
    expect(applyEvent(s, ev, 0)).toBe(true);
    applyEvent(s, ev, 0); // duplicate delivery
    expect(s.trades).toHaveLength(1);
    expect(s.trades[0]).toMatchObject({ side: 'SELL', price: 0.62, size: 46.62, tx: '0xabc', wallet: null });
    expect(s.trades[0].ts).toBeCloseTo(1794404025.505);
    expect(applyEvent(s, { ...ev, side: 'HOLD' }, 0)).toBe(false);
    expect(applyEvent(s, { ...ev, asset_id: OTHER, transaction_hash: '0xdef' }, 0)).toBe(false);
  });
  it('follows tick size changes and ignores unknown events', () => {
    const s = newLiveState(TOK, 10);
    applyEvent(s, { event_type: 'tick_size_change', asset_id: TOK, new_tick_size: '0.001' }, 0);
    expect(s.tickMills).toBe(1);
    expect(applyEvent(s, { event_type: 'something_new' }, 0)).toBe(false);
    expect(applyEvent(s, null as never, 0)).toBe(false);
    expect(toMills(0.485)).toBe(485);
  });
});

describe('merging REST fills', () => {
  const row = (over: Record<string, unknown>) => ({ cid: 'c', wallet: '0xw', side: 'BUY', outcomeIndex: 0, price: 0.62, size: 10, ts: 100, tx: '0xabc', ...over }) as never;
  it('attaches the wallet to a fill the socket already delivered, adds older history, and only takes this token\'s fills', () => {
    const s = newLiveState(TOK);
    applyEvent(s, { event_type: 'last_trade_price', asset_id: TOK, price: '0.62', size: '10', side: 'BUY', timestamp: '100000', transaction_hash: '0xabc' }, 0);
    mergeRestTrades(s, [row({}), row({ tx: '0xold', ts: 50, wallet: '0xold' }), row({ tx: '0xnoo', outcomeIndex: 1 })], 0);
    expect(s.trades.map((t) => [t.tx, t.wallet])).toEqual([['0xold', '0xold'], ['0xabc', '0xw']]);
    mergeRestTrades(s, [row({})], 0);
    expect(s.trades).toHaveLength(2);
  });
});

class FakeWs implements WsLike {
  static all: FakeWs[] = [];
  sent: string[] = [];
  closed = false;
  onopen: WsLike['onopen'] = null;
  onmessage: WsLike['onmessage'] = null;
  onclose: WsLike['onclose'] = null;
  onerror: WsLike['onerror'] = null;
  constructor(public url: string) { FakeWs.all.push(this); }
  send(d: string) { this.sent.push(d); }
  close() { this.closed = true; }
  open() { this.onopen?.({}); }
  say(x: unknown) { this.onmessage?.({ data: typeof x === 'string' ? x : JSON.stringify(x) }); }
  drop() { this.onclose?.({}); }
}

describe('the live feed', () => {
  beforeEach(() => { vi.useFakeTimers(); FakeWs.all = []; });
  afterEach(() => vi.useRealTimers());
  const make = (over: Record<string, unknown> = {}) => {
    const updates: number[] = [];
    const fetchBook = vi.fn(async () => ({ bids: [{ price: 0.4, size: 10 }], asks: [{ price: 0.6, size: 20 }] }));
    const fetchTrades = vi.fn(async () => [] as never[]);
    const feed = new LiveBookFeed({ tokenId: TOK, tokenIndex: 0, wsFactory: (u) => new FakeWs(u), fetchBook, fetchTrades, onUpdate: () => updates.push(Date.now()), throttleMs: 100, ...over } as never);
    return { feed, updates, fetchBook, fetchTrades };
  };
  it('shows the REST book at once, subscribes when the socket opens, goes live on the snapshot and applies updates', async () => {
    const { feed, fetchBook } = make();
    feed.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(fetchBook).toHaveBeenCalledTimes(1);
    expect([...feed.state.bids]).toEqual([[400, 10]]);
    expect(feed.state.status).toBe('polling'); // data, but no socket yet
    const ws = FakeWs.all[0];
    expect(ws.url).toMatch(/ws-subscriptions-clob\.polymarket\.com\/ws\/market/);
    ws.open();
    expect(JSON.parse(ws.sent[0])).toEqual({ assets_ids: [TOK], type: 'market' });
    ws.say([{ event_type: 'book', asset_id: TOK, bids: [level('0.45', '5')], asks: [level('0.55', '6')] }]);
    expect(feed.state.status).toBe('live');
    ws.say({ event_type: 'price_change', price_changes: [{ asset_id: TOK, price: '0.46', size: '9', side: 'BUY' }] });
    expect([...feed.state.bids]).toEqual([[450, 5], [460, 9]]);
    ws.say('PONG');
    feed.stop();
  });
  it('throttles a flood of updates into few UI updates', async () => {
    const { feed, updates } = make();
    feed.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];
    ws.open();
    updates.length = 0;
    for (let i = 0; i < 300; i++) ws.say({ event_type: 'price_change', price_changes: [{ asset_id: TOK, price: '0.47', size: String(i + 1), side: 'BUY' }] });
    await vi.advanceTimersByTimeAsync(110);
    expect(updates.length).toBe(1);
    expect(feed.state.bids.get(470)).toBe(300);
    feed.stop();
  });
  it('falls back to polling when the socket drops, reconnects with backoff, and stops cleanly', async () => {
    const { feed, fetchBook } = make();
    feed.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];
    ws.open();
    ws.say([{ event_type: 'book', asset_id: TOK, bids: [], asks: [] }]);
    expect(feed.state.status).toBe('live');
    ws.drop();
    expect(feed.state.status).toBe('polling');
    fetchBook.mockClear();
    await vi.advanceTimersByTimeAsync(3_200);
    expect(fetchBook).toHaveBeenCalled(); // REST polling while down
    expect(FakeWs.all.length).toBeGreaterThanOrEqual(2); // reconnected after 1s
    const ws2 = FakeWs.all.at(-1)!;
    ws2.drop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWs.all.length).toBe(2); // the second wait is 2s: not yet
    await vi.advanceTimersByTimeAsync(1_100);
    expect(FakeWs.all.length).toBe(3);
    feed.stop();
    expect(FakeWs.all.at(-1)!.closed).toBe(true);
    const calls = fetchBook.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetchBook.mock.calls.length).toBe(calls); // nothing runs after stop
  });
  it('pings every 10s and reconnects a socket that went silent for 30s', async () => {
    const { feed } = make();
    feed.start();
    await vi.advanceTimersByTimeAsync(10);
    const ws = FakeWs.all[0];
    ws.open();
    await vi.advanceTimersByTimeAsync(10_050);
    expect(ws.sent).toContain('PING');
    ws.say('PONG');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(ws.closed).toBe(true);
    feed.stop();
  });
  it('survives a failing REST call and a socket constructor that throws', async () => {
    const { feed } = make({ fetchBook: async () => { throw new Error('HTTP 500'); }, wsFactory: () => { throw new Error('no websocket'); } });
    feed.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(feed.state.error).toMatch(/HTTP 500|no websocket/);
    expect(feed.state.status).toBe('polling');
    feed.stop();
  });
});
