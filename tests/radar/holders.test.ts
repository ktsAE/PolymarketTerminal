import { describe, expect, it } from 'vitest';
import { loadHolders, peopleOnly } from '../../radar/holders';
import { PolymarketClient, type FetchJson } from '../../radar/polymarket';
import { openStore } from '../../radar/store';

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
    if (url.includes('/holders?')) return [{ token: '1', holders: [{ proxyWallet: HUMAN, amount: 400_000, outcomeIndex: 0, name: 'person' }] }, { token: '2', holders: [{ proxyWallet: BOT, amount: 90_000, outcomeIndex: 1, name: 'machine' }] }];
    if (url.includes('/activity?') && url.includes('sortDirection=ASC')) return [{ timestamp: NOW - 100 * 86_400 }];
    if (url.includes('/activity?')) {
      const wallet = url.includes(BOT.slice(2)) ? BOT : HUMAN;
      if (wallet === BOT) return Array.from({ length: 500 }, (_, i) => ({ timestamp: NOW - i * 2, type: 'TRADE', side: i % 2 ? 'BUY' : 'SELL', usdcSize: 20, conditionId: `0x${i % 7}` }));
      return Array.from({ length: 30 }, (_, i) => ({ timestamp: NOW - i * 86_400, type: 'TRADE', side: 'BUY', usdcSize: 900, conditionId: `0x${i}` }));
    }
    if (url.includes('/traded?')) return { traded: url.includes(BOT.slice(2)) ? 40_000 : 9 };
    if (url.includes('/v1/leaderboard?')) return [{ pnl: url.includes('timePeriod=week') ? 1_000 : 147_000, vol: url.includes(BOT.slice(2)) ? 90_000_000 : 800_000, userName: 'lb-name' }];
    if (url.includes('/positions?')) return [{ outcomeIndex: url.includes(BOT.slice(2)) ? 1 : 0, size: 1000, avgPrice: 0.5, curPrice: 0.8, currentValue: 800, cashPnl: 300 }];
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
    const before = calls.filter((c) => c.includes('/activity?') || c.includes('/v1/leaderboard?') || c.includes('/traded?')).length;
    await loadHolders(client, store, 'ev', { now: () => (NOW + 60) * 1000 });
    const after = calls.filter((c) => c.includes('/activity?') || c.includes('/v1/leaderboard?') || c.includes('/traded?')).length;
    expect(after).toBe(before); // positions are re-read (they change), profiles are not
    expect(calls.filter((c) => c.includes('/positions?'))).toHaveLength(4);
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
      if (u.includes(BOT.slice(2)) && u.includes('/traded?')) throw new Error('HTTP 500');
      return api(u);
    };
    const v = await loadHolders(new PolymarketClient(flaky, { ...fast, retries: 0 }), store, 'ev', { now: () => NOW * 1000 });
    expect(v.rows.map((r) => r.name)).toEqual(['person']);
    expect(v.loaded).toBe(2);
    expect(v.error).toMatch(/failed/);
    store.close();
  });
});
