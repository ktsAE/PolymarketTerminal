import { describe, expect, it } from 'vitest';
import { cursorPage, v2 } from './v2';
import { ingestEvent } from '../../radar/ingest';
import { mapEvent, mapTrade, PolymarketClient, parseStart, type FetchJson } from '../../radar/polymarket';
import { scoreMarket, T, type WalletProfile } from '../../radar/score';
import { openStore, type MarketRow, type TradeRow } from '../../radar/store';

const CID = `0x${'a'.repeat(64)}`;
const raw = (i: number, over: Record<string, unknown> = {}) => ({
  proxyWallet: `0x${String(i % 50).padStart(40, '0')}`, side: 'BUY', conditionId: CID, size: 10, price: 0.5, timestamp: 2_000_000 - i,
  outcomeIndex: 0, transactionHash: `0xtx${i}`, ...over,
});
const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };

describe('polymarket mapping', () => {
  it('rejects malformed trades and lowercases wallets', () => {
    expect(mapTrade(raw(1, { side: 'HOLD' }))).toBeNull();
    expect(mapTrade(raw(1, { price: 1.5 }))).toBeNull();
    expect(mapTrade(raw(1, { size: 0 }))).toBeNull();
    expect(mapTrade(raw(1, { proxyWallet: '0xABC' }))?.wallet).toBe('0xabc');
  });

  it('parses start times and voided results', () => {
    expect(parseStart('2026-08-24 13:00:00+00')).toBe(Date.parse('2026-08-24T13:00:00Z') / 1000);
    const e = mapEvent({
      slug: 's', title: 'Counter-Strike: A vs B', volume: '10', closed: true,
      markets: [{ conditionId: CID, sportsMarketType: 'moneyline', question: 'q', outcomes: '["A"," B"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: '["1","2"]', gameStartTime: '2026-10-21 10:45:00+00', volume: '5', closed: true }],
    });
    expect(e.markets[0]).toMatchObject({ game: 'Counter-Strike', outcomes: ['A', 'B'], result: [0.5, 0.5], volume: 5 });
  });

  it('leaves open markets without a result', () => {
    const e = mapEvent({ slug: 's', title: 'x', markets: [{ conditionId: CID, outcomes: '["A","B"]', outcomePrices: '["0.4","0.6"]', closed: false }] });
    expect(e.markets[0].result).toBeNull();
  });
});

describe('market trade fetching', () => {
  it('asks for both sides, not just takers', async () => {
    const urls: string[] = [];
    const client = new PolymarketClient(async (u) => (urls.push(u), []), fast);
    await client.marketTrades(CID);
    expect(urls[0]).toContain('/v2/trades?');
    expect(urls[0]).toContain('condition=' + CID);
    expect(urls[0]).toContain('taker_only=false');
  });

  it('follows the v2 cursor to the end, with no offset and no depth cap (v1 stopped at 10,000 rows)', async () => {
    const total = 12_500;
    const all = Array.from({ length: total }, (_, i) => raw(i));
    const calls: string[] = [];
    const fetchJson: FetchJson = async (url) => {
      calls.push(url);
      return cursorPage(all, new URL(url).searchParams); // rejects offset= and market= like the real API
    };
    const trades = await new PolymarketClient(fetchJson, fast).marketTrades(CID);
    expect(new Set(trades.map((t) => t.tx)).size).toBe(total);
    expect(calls).toHaveLength(13);
    expect(calls.some((c) => c.includes('offset='))).toBe(false);
    expect(calls[1]).toContain('cursor=c1000');
  });

  it('stops early at maxFills and keeps only fills at or before `end`', async () => {
    const all = Array.from({ length: 5000 }, (_, i) => raw(i)); // timestamps fall by one per row
    const client = new PolymarketClient(async (url) => cursorPage(all, new URL(url).searchParams), fast);
    expect((await client.marketTrades(CID, { maxFills: 2000 })).length).toBe(2000);
    const cut = 2_000_000 - 100;
    const some = await client.marketTrades(CID, { end: cut });
    expect(some.length).toBe(5000 - 100);
    expect(some.every((t) => t.ts <= cut)).toBe(true);
  });

  it('lastTradeAtOrBefore walks back to the right fill, returns null past the start, and throws when it cannot reach', async () => {
    const all = Array.from({ length: 3000 }, (_, i) => raw(i)); // ts = 2_000_000 - i, newest first
    const client = new PolymarketClient(async (url) => cursorPage(all, new URL(url).searchParams), fast);
    expect((await client.lastTradeAtOrBefore(CID, 2_000_000 - 1500))?.ts).toBe(2_000_000 - 1500);
    expect(await client.lastTradeAtOrBefore(CID, 1_000_000)).toBeNull();
    await expect(client.lastTradeAtOrBefore(CID, 2_000_000 - 2500, { maxPages: 1 })).rejects.toThrow(/could not reach/);
  });

  it('an HTTP 410 (endpoint retired) fails at once with a clear message instead of retrying', async () => {
    let n = 0;
    const gone = new PolymarketClient(async () => (n++, Promise.reject(new Error('HTTP 410'))), { ...fast, retries: 3 });
    await expect(gone.marketTrades(CID)).rejects.toThrow(/endpoint retired \(HTTP 410\)/);
    expect(n).toBe(1);
  });

  it('retries transient failures and then gives up with a clear error', async () => {
    let n = 0;
    const flaky = new PolymarketClient(async () => (++n < 3 ? Promise.reject(new Error('boom')) : []), { ...fast, retries: 3 });
    await expect(flaky.marketTrades(CID)).resolves.toEqual([]);
    const dead = new PolymarketClient(async () => Promise.reject(new Error('down')), { ...fast, retries: 1 });
    await expect(dead.marketTrades(CID)).rejects.toThrow(/failed after 2 attempts/);
  });
});

const market = (over: Partial<MarketRow> = {}): MarketRow => ({
  cid: CID, eventSlug: 'e', eventTitle: 'CS: A vs B', game: 'CS', marketType: 'moneyline', question: 'A vs B', outcomes: ['A', 'B'], tokenIds: [],
  gameStart: 1000, result: null, volume: 100_000, closed: true, ...over,
});
const fill = (wallet: string, over: Partial<TradeRow> = {}): TradeRow => ({ cid: CID, wallet, side: 'BUY', outcomeIndex: 0, price: 0.4, size: 50_000, ts: 2000, tx: null, ...over });
const profile = (over: Partial<WalletProfile> = {}): WalletProfile => ({ firstSeen: 0, traded: 500, bigPositions: 100, skillZ: 0, ...over });
const codes = (r: ReturnType<typeof scoreMarket>) => r.reasons.map((x) => x.code);

describe('indicator score', () => {
  it('flags a large in-play underdog position and says why', () => {
    const r = scoreMarket({ market: market(), trades: [fill('0xwhale1234567890')], wallets: new Map() });
    expect(codes(r)).toEqual(expect.arrayContaining(['whale_in_play', 'underdog_conviction']));
    expect(r.gaps.join()).toMatch(/no profile/);
    expect(r.score).toBe(35);
    expect(r.level).toBe('WATCH');
  });

  it('is calmer when the wallet is a known frequent large bettor', () => {
    const wallets = new Map([['0xwhale1234567890', profile({ traded: 400, bigPositions: 300 })]]);
    const r = scoreMarket({ market: market(), trades: [fill('0xwhale1234567890')], wallets });
    expect(codes(r)).toContain('frequent_large_bettor');
    expect(r.score).toBeLessThan(25);
    expect(r.level).toBe('NONE');
  });

  it('never lets one wallet’s context cancel another wallet’s flag', () => {
    const wallets = new Map([['0xknown000000000001', profile()]]);
    const trades = [fill('0xknown000000000001'), fill('0xunknown00000000002', { outcomeIndex: 1 })];
    const r = scoreMarket({ market: market(), trades, wallets });
    expect(r.score).toBeGreaterThanOrEqual(25);
  });

  it('flags a fresh wallet with little history and real money', () => {
    const wallets = new Map([['0xfresh0000000000001', profile({ firstSeen: 1000 - 3 * 86_400, traded: 2, bigPositions: 0 })]]);
    const r = scoreMarket({ market: market(), trades: [fill('0xfresh0000000000001', { size: 6000, price: 0.5 })], wallets });
    expect(codes(r)).toContain('fresh_wallet');
  });

  it('flags several young wallets backing the same outcome', () => {
    const wallets = new Map<string, WalletProfile>();
    const trades: TradeRow[] = [];
    for (let i = 0; i < T.clusterMinWallets; i++) {
      const w = `0xyoung00000000000${i}`;
      wallets.set(w, profile({ firstSeen: 1000 - 86_400, traded: 8, bigPositions: 0 }));
      trades.push(fill(w, { size: 4000, price: 0.5 }));
    }
    expect(codes(scoreMarket({ market: market(), trades, wallets }))).toContain('young_wallet_cluster');
  });

  it('ignores huge fills at 0.999 (settlement sweeping), as seen in real data', () => {
    const r = scoreMarket({ market: market(), trades: [fill('0xsweeper000000000', { price: 0.999, size: 700_000 })], wallets: new Map() });
    expect(r.reasons).toEqual([]);
    expect(r.score).toBe(0);
  });

  it('does not call money built before the start "in play"', () => {
    const r = scoreMarket({ market: market(), trades: [fill('0xearly0000000000', { ts: 500 })], wallets: new Map() });
    expect(codes(r)).not.toContain('whale_in_play');
  });

  it('notices money in a side market that is normally empty, and admits when it has no baseline', () => {
    const side = market({ marketType: 'round_handicap_game_1', volume: 3000 });
    const flagged = scoreMarket({ market: side, trades: [], wallets: new Map(), baseline: { n: 1000, median: 0, p90: 10 } });
    expect(codes(flagged)).toContain('side_market_activity');
    const blind = scoreMarket({ market: side, trades: [], wallets: new Map() });
    expect(blind.score).toBe(0);
    expect(blind.gaps.join()).toMatch(/no volume baseline/);
  });
});

describe('ingest (end to end against a fake API)', () => {
  it('stores markets and both-sided trades, profiles the biggest wallets once, and is idempotent', async () => {
    const wallet = `0x${'1'.repeat(40)}`;
    const calls: string[] = [];
    const fetchJson: FetchJson = async (url) => {
      calls.push(url);
      if (url.includes('/events?slug=')) {
        return [{ slug: 'ev', title: 'Counter-Strike: A vs B', volume: 50_000, closed: true, markets: [
          { conditionId: CID, sportsMarketType: 'moneyline', question: 'A vs B', outcomes: '["A","B"]', outcomePrices: '["0","1"]', clobTokenIds: '["1","2"]', gameStartTime: '2026-08-24 13:00:00+00', volume: 50_000, closed: true },
          { conditionId: `0x${'b'.repeat(64)}`, sportsMarketType: 'round_handicap_game_1', question: 'thin', outcomes: '["O","U"]', outcomePrices: '["0","1"]', clobTokenIds: '[]', volume: 0, closed: true },
        ] }];
      }
      if (url.includes('/v2/trades?')) return v2([raw(1, { proxyWallet: wallet, size: 30_000, price: 0.4, timestamp: Date.parse('2026-08-24T14:00:00Z') / 1000 })]);
      if (url.includes('/v2/activity?')) return v2([{ timestamp: 1_700_000_000 }]);
      if (url.includes('/v2/user-stats?')) return v2({ proxyWallet: wallet, trades: 7 });
      if (url.includes('/v2/positions?') && url.includes('status=CLOSED')) return v2([]);
      throw new Error(`unexpected ${url}`);
    };
    const store = openStore();
    const client = new PolymarketClient(fetchJson, fast);
    const first = await ingestEvent(client, store, 'ev', { now: () => 1_800_000_000_000 });
    expect(first).toMatchObject({ markets: 2, tradedMarkets: 1, newTrades: 1, profiled: 1 });
    expect(store.getWallet(wallet)).toMatchObject({ firstSeen: 1_700_000_000, traded: 7 });
    expect(calls.filter((c) => c.includes('/v2/trades?')).every((c) => c.includes('taker_only=false'))).toBe(true);

    const again = await ingestEvent(client, store, 'ev', { now: () => 1_800_000_000_000 });
    expect(again).toMatchObject({ newTrades: 0, profiled: 0 });
    expect(await ingestEvent(client, store, 'missing-event-nope').catch(() => 'threw')).toBeDefined();
    store.close();
  });
});
