import { describe, expect, it } from 'vitest';
import { loadHolders, peopleOnly } from '../../radar/holders';
import { PolymarketClient, type FetchJson } from '../../radar/polymarket';
import { openStore } from '../../radar/store';
import { v2 } from './v2';

const CID = `0x${'c'.repeat(64)}`;
const HUMAN = `0x${'1'.repeat(40)}`;
const BOT = `0x${'2'.repeat(40)}`;
const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };
const NOW = 1_800_000_000;

function fakeApi(calls: string[] = []): FetchJson {
  return async (url) => {
    calls.push(url);
    if (url.includes('/events?slug=')) return [{ slug: 'ev', title: 'Senate', volume: 1, closed: false, markets: [
      { conditionId: `0x${'d'.repeat(64)}`, question: 'tiny', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', clobTokenIds: '[]', volume: 10, closed: false },
      { conditionId: CID, question: 'Will X win?', outcomes: '["Yes","No"]', outcomePrices: '["0.8","0.2"]', clobTokenIds: '[]', volume: 5_000_000, closed: false } ] }];
    if (url.includes('/v2/holders?')) {
      expect(url).toMatch(/condition=0x[cd]{64}/);
      return v2([{ tokenId: '1', holders: [{ proxyWallet: HUMAN, amount: 400_000, outcomeIndex: 0, name: 'person' }] }, { tokenId: '2', holders: [{ proxyWallet: BOT, amount: 90_000, outcomeIndex: 1, name: 'machine' }] }]);
    }
    if (url.includes('/v2/activity?') && url.includes('sort_direction=ASC')) return v2([{ timestamp: NOW - 100 * 86_400 }]);
    if (url.includes('/v2/activity?')) {
      const wallet = url.includes(BOT.slice(2)) ? BOT : HUMAN;
      if (wallet === BOT) return v2(Array.from({ length: 500 }, (_, i) => ({ timestamp: NOW - i * 2, type: 'TRADE', side: i % 2 ? 'BUY' : 'SELL', usdcSize: 20, conditionId: `0x${i % 7}` })));
      return v2(Array.from({ length: 30 }, (_, i) => ({ timestamp: NOW - i * 86_400, type: 'TRADE', side: 'BUY', usdcSize: 900, conditionId: `0x${i}` })));
    }
    if (url.includes('/v2/user-stats?')) return v2({ trades: url.includes(BOT.slice(2)) ? 40_000 : 9 });
    if (url.includes('/v2/leaderboard?')) return v2({ pnl: url.includes('time_period=WEEK') ? 1_000 : 147_000, volume: url.includes(BOT.slice(2)) ? 90_000_000 : 800_000, userName: 'lb-name' });
    if (url.includes('/v2/positions?')) return v2([{ outcomeIndex: url.includes(BOT.slice(2)) ? 1 : 0, currentSize: 1000, avgPrice: 0.5, currentPrice: 0.8, currentValue: 800, unrealizedPnl: 300 }]);
    throw new Error(`unexpected ${url}`);
  };
}

describe('loading top holders', () => {
  it('picks the busiest market, profiles each holder and separates people from machines', async () => {
    const store = openStore();
    const progress: number[] = [];
    const v = await loadHolders(new PolymarketClient(fakeApi(), fast), store, 'ev', { now: () => NOW * 1000, onProgress: (x) => progress.push(x.loaded) });
    expect(v).toMatchObject({ question: 'Will X win?', total: 2, loaded: 2, done: true, error: null });
    const byName = Object.fromEntries(v.rows.map((r) => [r.name, r]));
    expect(byName.person).toMatchObject({ cls: 'HUMAN', pnlAll: 147_000, pnlWeek: 1_000, uPnl: 300, outcome: 'Yes', traded: 9 });
    expect(byName.machine.cls).toBe('BOT');
    expect(byName.machine.reasons.join()).toMatch(/40,000 markets/);
    expect(peopleOnly(v.rows).map((r) => r.name)).toEqual(['person']);
    expect(Math.max(...progress)).toBe(2);
    store.close();
  });

  it('caches wallet profiles, so reopening does not re-fetch their history', async () => {
    const store = openStore();
    const calls: string[] = [];
    const client = new PolymarketClient(fakeApi(calls), fast);
    await loadHolders(client, store, 'ev', { now: () => NOW * 1000 });
    const before = calls.filter((c) => c.includes('/v2/activity?') || c.includes('/v2/leaderboard?') || c.includes('/v2/user-stats?')).length;
    await loadHolders(client, store, 'ev', { now: () => (NOW + 60) * 1000 });
    const after = calls.filter((c) => c.includes('/v2/activity?') || c.includes('/v2/leaderboard?') || c.includes('/v2/user-stats?')).length;
    expect(after).toBe(before); // positions are re-read (they change), profiles are not
    expect(calls.filter((c) => c.includes('/positions?'))).toHaveLength(4);
    store.close();
  });

  it('lists every open market of the event and loads the one asked for (spreads and totals included)', async () => {
    const store = openStore();
    const asked: string[] = [];
    const api = fakeApi();
    const spy: FetchJson = async (u) => {
      if (u.includes('/v2/holders?')) { asked.push(/condition=(\w+)/.exec(u)![1]); }
      return api(u);
    };
    const side = `0x${'d'.repeat(64)}`;
    const client = new PolymarketClient(spy, fast);
    const main = await loadHolders(client, store, 'ev', { now: () => NOW * 1000 });
    expect(main.markets.map((m) => m.cid)).toEqual([CID, side]); // busiest first
    expect(main.cid).toBe(CID);
    const other = await loadHolders(client, store, 'ev', { now: () => NOW * 1000, cid: side });
    expect(other.cid).toBe(side);
    expect(other.question).toBe('tiny');
    expect(asked).toEqual([CID, side]);
    // an unknown cid falls back to the busiest market rather than failing
    expect((await loadHolders(client, store, 'ev', { now: () => NOW * 1000, cid: '0xnope' })).cid).toBe(CID);
    store.close();
  });

  it('reports a missing event instead of throwing', async () => {
    const store = openStore();
    const v = await loadHolders(new PolymarketClient(async () => [], fast), store, 'nope');
    expect(v.error).toMatch(/not found/);
    expect(v.done).toBe(true);
    store.close();
  });

  it('keeps going when one wallet fails and says so', async () => {
    const store = openStore();
    const api = fakeApi();
    const flaky: FetchJson = async (u) => {
      if (u.includes(BOT.slice(2)) && u.includes('/v2/user-stats?')) throw new Error('HTTP 500');
      return api(u);
    };
    const v = await loadHolders(new PolymarketClient(flaky, { ...fast, retries: 0 }), store, 'ev', { now: () => NOW * 1000 });
    expect(v.rows.map((r) => r.name)).toEqual(['person']);
    expect(v.loaded).toBe(2);
    expect(v.error).toMatch(/failed/);
    store.close();
  });
});

describe('protocol contract holders', () => {
  it('are skipped without an error, and not retried', async () => {
    const { PolymarketClient, ProtocolContractError } = await import('../../radar/polymarket');
    let calls = 0;
    const f = async () => {
      calls++;
      throw new Error('HTTP 400: {"error":"user is a protocol contract address: 0xabc","code":"invalid_request"}');
    };
    const c = new PolymarketClient(f, { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 });
    await expect(c.positions(`0x${'a'.repeat(40)}`)).rejects.toBeInstanceOf(ProtocolContractError);
    expect(calls).toBe(1);
  });
});
