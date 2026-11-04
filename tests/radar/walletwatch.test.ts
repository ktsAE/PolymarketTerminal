import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PolymarketClient, type TradeLine } from '../../radar/polymarket';
import { addWatched, describeTrade, freshTrades, loadWatched, pollWatched, removeWatched } from '../../radar/walletwatch';
import { v2 } from './v2';

const A = `0x${'a'.repeat(40)}`;
const B = `0x${'B'.repeat(40)}`;
const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };
const t = (ts: number, over: Partial<TradeLine> = {}): TradeLine => ({ ts, tx: `0x${ts}`, token: 'tok', side: 'BUY', price: 0.62, size: 200, outcome: 'Yes', title: 'Will it rain?', slug: 's', cid: 'c', ...over });

describe('the watchlist file', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'ww-')), 'sub', 'wallets.json');
  it('adds, updates the note, lowercases, rejects bad addresses and removes', () => {
    const p = file();
    expect(loadWatched(p)).toEqual([]); // missing file
    expect(addWatched(B, 'whale', p)).toMatchObject({ added: true });
    expect(addWatched(B.toLowerCase(), undefined, p).added).toBe(false);
    expect(addWatched(B, 'renamed', p).list).toEqual([{ wallet: B.toLowerCase(), note: 'renamed' }]);
    expect(() => addWatched('0x123', undefined, p)).toThrow(/not a wallet address/);
    expect(removeWatched(B, p)).toBe(true);
    expect(removeWatched(B, p)).toBe(false);
    expect(loadWatched(p)).toEqual([]);
  });
  it('survives a corrupt or odd file', () => {
    const p = file();
    addWatched(A, 'x', p);
    writeFileSync(p, '{ not json');
    expect(loadWatched(p)).toEqual([]);
    writeFileSync(p, JSON.stringify([A, { wallet: A }, { wallet: 'nope' }, 42, null, { wallet: B, note: 7 }]));
    expect(loadWatched(p)).toEqual([{ wallet: A }, { wallet: B.toLowerCase() }]);
    expect(readFileSync(p, 'utf8')).toBeTruthy();
  });
});

describe('what counts as a fresh trade', () => {
  it('records the first pass silently, then returns only trades not seen before, oldest first', () => {
    const seen = new Set<string>();
    expect(freshTrades([t(3), t(1), t(2)], seen, true)).toEqual([]);
    expect(seen.size).toBe(3);
    expect(freshTrades([t(5), t(4), t(3), t(2)], seen, false).map((x) => x.ts)).toEqual([4, 5]);
    expect(freshTrades([t(5), t(4)], seen, false)).toEqual([]);
  });
  it('describes a trade with the note, outcome, size, price and market', () => {
    expect(describeTrade({ wallet: A, note: 'whale' }, t(1))).toBe('whale: BUY Yes $124 at 62.0c on "Will it rain?"');
    expect(describeTrade({ wallet: A }, t(1, { size: 10, price: 0.5, side: 'SELL' }))).toMatch(/^0xaaaaaa…: SELL Yes \$5 at 50\.0c/);
  });
});

describe('polling', () => {
  it('stays quiet on the first pass, alerts on a new trade later, ignores non-trades, and isolates a failing wallet', async () => {
    let round = 0;
    const row = (ts: number) => ({ proxyWallet: A, timestamp: ts, type: 'TRADE', side: 'BUY', price: 0.5, size: 100, outcome: 'Yes', title: 'Q', eventSlug: 'e', conditionId: 'c', transactionHash: `0x${ts}`, tokenId: 'tok' });
    const f = async (url: string) => {
      if (url.includes(B.slice(2).toLowerCase())) throw new Error('HTTP 500');
      expect(url).toContain('/v2/activity?');
      const rows = round === 0 ? [row(1), row(2)] : [row(3), row(2), row(1), { ...row(9), type: 'REWARD' }, { ...row(10), type: 'TRADE', side: undefined }];
      return v2(rows);
    };
    const client = new PolymarketClient(f, { ...fast, retries: 0 });
    const list = [{ wallet: A }, { wallet: B.toLowerCase() }];
    const seen = new Map<string, Set<string>>();
    const primed = new Set<string>();
    const first = await pollWatched(client, list, seen, primed);
    expect(first[0].trades).toEqual([]);
    expect(first[1].error).toMatch(/failed after 1 attempts/);
    round = 1;
    const second = await pollWatched(client, list, seen, primed);
    expect(second[0].trades.map((x) => x.ts)).toEqual([3]);
    expect(second[1].trades).toEqual([]);
  });
});
