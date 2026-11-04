import { describe, expect, it } from 'vitest';
import { classFlow, formatClassFlow } from '../../radar/classflow';
import type { WalletClass } from '../../radar/profile';
import type { TradeRow } from '../../radar/store';

const NOW = 1_800_000_000;
const tr = (wallet: string, secsAgo: number, side: 'BUY' | 'SELL', outcomeIndex: number, price: number, size: number): TradeRow =>
  ({ wallet, ts: NOW - secsAgo, side, outcomeIndex, price, size, cid: 'c', tx: `${wallet}${secsAgo}`, token: 't' }) as TradeRow;

describe('flow by wallet class', () => {
  const classOf = new Map<string, WalletClass>([['h1', 'HUMAN'], ['m1', 'MM'], ['b1', 'BOT']]);
  const trades = [
    tr('h1', 600, 'BUY', 0, 0.5, 1000), // human bets $500 YES, 10 min ago
    tr('h1', 7_200, 'BUY', 1, 0.4, 500), // human bets $200 NO, 2h ago
    tr('m1', 300, 'BUY', 0, 0.5, 400), // MM $200 YES
    tr('m1', 300, 'SELL', 0, 0.5, 400), // ...and sells it: counts as NO exposure
    tr('x9', 900, 'SELL', 0, 0.6, 100), // unprofiled, sells YES = NO $60
    tr('b1', 2 * 86_400, 'BUY', 0, 0.5, 100), // outside every window
  ];
  const f = classFlow(trades, classOf, NOW);
  it('sums YES and NO dollars per class in each window (selling YES counts as NO)', () => {
    const h1 = f.windows[0].buckets;
    expect(h1.find((b) => b.cls === 'HUMAN')).toMatchObject({ yesUsd: 500, noUsd: 0, fills: 1, wallets: 1 });
    expect(h1.find((b) => b.cls === 'MM')).toMatchObject({ yesUsd: 200, noUsd: 200 });
    expect(h1.find((b) => b.cls === 'UNKNOWN')).toMatchObject({ yesUsd: 0, noUsd: 60 });
    expect(h1.find((b) => b.cls === 'BOT')).toBeUndefined();
    expect(f.windows[2].buckets.find((b) => b.cls === 'HUMAN')).toMatchObject({ yesUsd: 500, noUsd: 200, fills: 2 });
    expect(f.windows[1].buckets.find((b) => b.cls === 'HUMAN')?.noUsd).toBe(200); // 2h ago is inside 6h, outside 1h
  });
  it('reports how much of the money comes from profiled wallets', () => {
    expect(f.windows[0].totalUsd).toBeCloseTo(960);
    expect(f.windows[0].coverage).toBeCloseTo(900 / 960);
    expect(classFlow([], classOf, NOW).windows[0]).toMatchObject({ totalUsd: 0, coverage: 0, buckets: [] });
  });
  it('formats lines with net and the coverage caveat, or says there is nothing', () => {
    const lines = formatClassFlow(f, 'Yes', 'No');
    expect(lines[0]).toMatch(/FLOW BY WHO, last 24h/);
    expect(lines.find((l) => l.startsWith('HUMAN'))).toMatch(/Yes\s+\$500\s+No\s+\$200\s+net \+\$300\s+\[\+\$500\]\s+1 wallet\(s\), 2 fills/);
    expect(lines.at(-1)).toMatch(/\d+% of the money is from wallets that were profiled/);
    expect(formatClassFlow(classFlow([], classOf, NOW), 'Yes', 'No')).toEqual(['no fills in the last 24h']);
  });
});
