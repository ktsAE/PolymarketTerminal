import { describe, expect, it } from 'vitest';
import { aggregateNewWallets, labelOf, scanNewWallets, summarizeScan } from '../../radar/newwallets';
import { PolymarketClient, type GlobalTrade } from '../../radar/polymarket';
import { openStore } from '../../radar/store';
import { cursorPage } from './v2';

const NOW = 1_800_000_000;
const DAY = 86_400;
let n = 0;
const tr = (wallet: string, cid: string, side: 'BUY' | 'SELL', outcomeIndex: number, usd: number, over: Partial<GlobalTrade> = {}): GlobalTrade => ({
  cid, wallet, side, outcomeIndex, price: 0.5, size: usd / 0.5, ts: NOW - 60, tx: `0x${n++}`, eventSlug: `ev-${cid}`, title: `Question ${cid}?`, outcome: outcomeIndex === 0 ? 'Yes' : 'No', name: null, ...over,
} as GlobalTrade);
const ages = (m: Record<string, number | null>) => new Map(Object.entries(m).map(([w, d]) => [w, d === null ? null : NOW - d * DAY]));

describe('new-wallet aggregation', () => {
  const trades = [
    // market A: three new wallets lean Yes, one old wallet trades a lot
    tr('n1', 'A', 'BUY', 0, 400), tr('n2', 'A', 'BUY', 0, 300), tr('n3', 'A', 'BUY', 0, 200), tr('n3', 'A', 'SELL', 1, 100), tr('old1', 'A', 'BUY', 1, 1000),
    // market B: one new wallet only
    tr('n1', 'B', 'BUY', 1, 500), tr('old1', 'B', 'BUY', 0, 4000), tr('old2', 'B', 'BUY', 1, 4000),
    // market C: only old wallets, plus a wallet without a profile and one not aged yet
    tr('old2', 'C', 'BUY', 0, 2000), tr('nop', 'C', 'BUY', 0, 500), tr('pending', 'C', 'BUY', 0, 500),
  ];
  const created = ages({ n1: 2, n2: 5, n3: 13, old1: 400, old2: 90, nop: null });
  const r = aggregateNewWallets(trades, created, NOW, 30, { maxAgeDays: 14, minNewWallets: 3, minNewUsd: 100 });
  it('ranks markets by the money new wallets put in and counts wallets, share and lean', () => {
    expect(r.rows.map((x) => x.cid)).toEqual(['A']); // B has one new wallet, C none
    const a = r.rows[0];
    expect(a).toMatchObject({ newWallets: 3, wallets: 4, newUsd: 1000, knownUsd: 2000, eventSlug: 'ev-A', question: 'Question A?' });
    expect(a.newShare).toBeCloseTo(0.5);
    expect(a.lean).toEqual({ outcome: 'Yes', share: 1 }); // buying Yes and selling No both lean Yes
    expect(a.topShare).toBeCloseTo(0.4);
    expect(a.top.map((e) => [e.wallet, e.ageDays, e.usd])).toEqual([['n1', 2, 400], ['n2', 5, 300], ['n3', 13, 300]]);
  });
  it('compares with the platform: lift is the market share over the platform share, and unaged wallets are reported', () => {
    // known money: A 2000 + B 8500 + C 2000 (the wallet with no profile and the unaged one do not count); new money 1500 (A 1000 + B 500)
    expect(r.platformNewShare).toBeCloseTo(1500 / 12_500, 5);
    expect(r.rows[0].lift).toBeCloseTo(0.5 / 0.12, 3);
    expect(r.toAge).toBe(1); // "pending" has no entry
    expect(r.newWalletsTotal).toBe(3);
    expect(summarizeScan(r)).toMatch(/last 30 min: 11 fills, 3 markets, 7 wallets \(age known for \d+% of the money\)/);
  });
  it('names the other outcome when only a sell was seen', () => {
    expect(labelOf(new Map([[0, 'Yes']]), 1)).toBe('not Yes');
    expect(labelOf(new Map(), 1)).toBe('#1');
    expect(labelOf(new Map([[1, 'No']]), 1)).toBe('No');
  });
  it('ignores accounts older than the cut-off and honours the minimums', () => {
    const old = aggregateNewWallets(trades, ages({ n1: 40, n2: 40, n3: 40, old1: 400, old2: 90 }), NOW, 30);
    expect(old.rows).toEqual([]);
    expect(aggregateNewWallets(trades, created, NOW, 30, { minNewWallets: 4 }).rows).toEqual([]);
    expect(aggregateNewWallets(trades, created, NOW, 30, { minNewUsd: 5000 }).rows).toEqual([]);
    expect(aggregateNewWallets([], new Map(), NOW, 30)).toMatchObject({ rows: [], coverage: 0, platformNewShare: 0 });
  });
});

describe('scanning the platform', () => {
  const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };
  const rawRow = (wallet: string, cid: string, usd: number, ts = NOW - 30) => ({ proxyWallet: wallet, conditionId: cid, eventSlug: `ev-${cid}`, title: `Q ${cid}`, outcome: 'Yes', outcomeIndex: 0, side: 'BUY', price: 0.5, size: usd / 0.5, timestamp: ts, transactionHash: `0x${n++}` });
  it('pages the global feed back to the window, ages wallets (cache first), and returns the ranked markets', async () => {
    const store = openStore();
    store.upsertIdentity({ wallet: 'w1', fetchedAt: NOW - 10, createdAt: NOW - 3 * DAY, name: null, pseudonym: null, xUsername: null, bio: null, verified: false });
    const feed = [rawRow('w1', 'X', 200), rawRow('w2', 'X', 150), rawRow('w3', 'X', 120), rawRow('w4', 'X', 10), rawRow('w5', 'Y', 90), rawRow('w1', 'X', 100, NOW - 99_999)];
    const urls: string[] = [];
    const f = async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname === '/v2/trades') return cursorPage(feed, u.searchParams);
      if (u.pathname === '/public-profile') {
        const a = u.searchParams.get('address');
        if (a === 'w3') throw new Error('HTTP 404');
        return { createdAt: new Date((NOW - (a === 'w2' ? 2 : 400) * DAY) * 1000).toISOString() };
      }
      throw new Error(`unexpected ${url}`);
    };
    const stages: string[] = [];
    const { result, error } = await scanNewWallets(new PolymarketClient(f as never, fast), store, { windowMins: 30, now: () => NOW * 1000, minNewWallets: 2, minNewUsd: 50, onProgress: (s) => stages.push(s) });
    expect(error).toBeNull();
    expect(result?.trades).toBe(5); // the fill from before the window is dropped
    expect(urls.filter((u) => u.includes('public-profile')).map((u) => new URL(u).searchParams.get('address')).sort()).toEqual(['w2', 'w3', 'w5']); // w1 cached, w4 under $25
    expect(result?.rows.map((x) => [x.cid, x.newWallets, x.newUsd])).toEqual([['X', 2, 350]]); // w1 (3d) and w2 (2d); w3 has no profile
    expect(stages.some((s) => /looking up/.test(s))).toBe(true);
    expect(stages.at(-1)).toBe('done');
    store.close();
  });
  it('reports an API failure instead of throwing', async () => {
    const store = openStore();
    const res = await scanNewWallets(new PolymarketClient(async () => Promise.reject(new Error('down')), { ...fast, retries: 0 }), store, { now: () => NOW * 1000 });
    expect(res.result).toBeNull();
    expect(res.error).toMatch(/failed after 1 attempts/);
    store.close();
  });
});
