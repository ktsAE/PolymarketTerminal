import { describe, expect, it } from 'vitest';
import { autoCenter, buildDom, tapeOf, viewOf, type DomOpts } from '../../radar/dom';
import { newLiveState, type LiveState, type LiveTrade } from '../../radar/livebook';

const NOW = 1_800_000_000_000;
const base = (): LiveState => {
  const s = newLiveState('t', 10);
  for (const [p, z] of [[480, 100], [470, 50], [450, 200]]) s.bids.set(p, z);
  for (const [p, z] of [[500, 70], [510, 40], [550, 300]]) s.asks.set(p, z);
  return s;
};
const tr = (secsAgo: number, side: 'BUY' | 'SELL', price: number, size: number): LiveTrade => ({ ts: NOW / 1000 - secsAgo, side, price, size, tx: null, wallet: null });
const opts = (over: Partial<DomOpts> = {}): DomOpts => ({ rows: 9, group: 1, unit: 'SH', flip: false, periodSecs: 60, clusterCols: 3, scroll: 0, manualCenter: null, nowMs: NOW, ...over });

describe('DOM rows', () => {
  it('centres on the mid, lists prices high to low and marks the best bid, best ask and last price', () => {
    const s = base();
    s.trades.push(tr(5, 'BUY', 0.5, 10));
    const d = buildDom(s, opts());
    expect(d.rows).toHaveLength(9);
    expect(d.rows.map((r) => r.mills)).toEqual([530, 520, 510, 500, 490, 480, 470, 460, 450]);
    expect(d.rows[0].mills).toBeGreaterThan(d.rows[8].mills);
    expect(d.rows.every((r, i) => i === 0 || d.rows[i - 1].mills - r.mills === 10)).toBe(true);
    expect(d.rows.find((r) => r.isBestBid)?.mills).toBe(480);
    expect(d.rows.find((r) => r.isBestAsk)?.mills).toBe(500);
    expect(d.rows.find((r) => r.isLast)?.mills).toBe(500);
    expect(d.rows.find((r) => r.mills === 480)).toMatchObject({ bid: 100, ask: 0 });
    expect(d.rows.find((r) => r.mills === 510)).toMatchObject({ bid: 0, ask: 40 });
    expect(d.mid).toBe(490);
    expect(d.maxDepth).toBe(200); // the 450 row (200) is in the window
  });
  it('groups ticks into one row, summing the sizes in it', () => {
    const d = buildDom(base(), opts({ group: 5, rows: 5 }));
    expect(d.stepMills).toBe(50);
    expect(d.rows.find((r) => r.mills === 450)).toMatchObject({ bid: 350 }); // 480+470+450 all fall in the 450..499 bucket
    expect(d.rows.find((r) => r.mills === 500)).toMatchObject({ ask: 110 });
  });
  it('reports dollars instead of shares', () => {
    const d = buildDom(base(), opts({ unit: 'USD' }));
    expect(d.rows.find((r) => r.mills === 480)?.bid).toBeCloseTo(48);
  });
  it('scrolls, freezes on a manual centre and keeps the window inside 0..100c', () => {
    const s = base();
    expect(buildDom(s, opts({ scroll: 2 })).centerMills).toBe(autoCenter(s, false, 1) + 20);
    expect(buildDom(s, opts({ manualCenter: 300 })).centerMills).toBe(300);
    const high = buildDom(s, opts({ manualCenter: 995, rows: 9 }));
    expect(high.rows[0].mills).toBeLessThanOrEqual(990);
    const low = buildDom(s, opts({ manualCenter: 5, rows: 9 }));
    expect(low.rows.at(-1)!.mills).toBeGreaterThanOrEqual(10);
  });
});

describe('clusters and prints', () => {
  it('sums buys and sells per price per time bucket, oldest bucket first, with the per-bucket delta', () => {
    const s = base();
    // now is on a minute boundary; buckets are [-120,-60), [-60,0), [0,60) relative to the boundary
    const edge = Math.floor(NOW / 1000 / 60) * 60;
    const t = (ts: number, side: 'BUY' | 'SELL', price: number, size: number): LiveTrade => ({ ts, side, price, size, tx: null, wallet: null });
    s.trades.push(t(edge - 100, 'BUY', 0.5, 10), t(edge - 30, 'SELL', 0.5, 4), t(edge - 20, 'SELL', 0.5, 1), t(edge + 1, 'BUY', 0.48, 7), t(edge - 500, 'BUY', 0.5, 99));
    const d = buildDom(s, opts({ nowMs: (edge + 5) * 1000 }));
    const r500 = d.rows.find((r) => r.mills === 500)!;
    expect(r500.clusters).toEqual([{ buy: 10, sell: 0 }, { buy: 0, sell: 5 }, { buy: 0, sell: 0 }]);
    expect(d.rows.find((r) => r.mills === 480)!.clusters[2]).toEqual({ buy: 7, sell: 0 });
    expect(d.colDelta).toEqual([10, -5, 7]); // the fill 500s old is outside every bucket
    expect(d.colTotal).toEqual([10, 5, 7]);
    expect(d.clusterMax).toBe(10);
  });
  it('shows only the last 20 seconds of fills as prints', () => {
    const s = base();
    s.trades.push(tr(5, 'SELL', 0.49, 30), tr(60, 'BUY', 0.49, 99));
    const d = buildDom(s, opts());
    expect(d.rows.find((r) => r.mills === 490)?.print).toEqual({ buy: 0, sell: 30 });
  });
});

describe('the other outcome', () => {
  it('mirrors prices and swaps sides and fill direction', () => {
    const s = base();
    s.trades.push(tr(5, 'BUY', 0.62, 10));
    const v = viewOf(s, true);
    expect([...v.bids].sort()).toEqual([[450, 300], [490, 40], [500, 70]].sort()); // asks 500/510/550 become bids at 500/490/450
    expect([...v.asks].sort()).toEqual([[520, 100], [530, 50], [550, 200]].sort());
    expect(v.trades[0]).toMatchObject({ side: 'SELL', price: 1 - 0.62 });
    const d = buildDom(s, opts({ flip: true }));
    expect(d.bestBid).toBe(500);
    expect(d.bestAsk).toBe(520);
  });
  it('lists the tape newest first with a minimum size', () => {
    const s = base();
    s.trades.push(tr(30, 'BUY', 0.5, 4), tr(20, 'SELL', 0.5, 400), tr(10, 'BUY', 0.5, 10));
    expect(tapeOf(s, false, 0, 10).map((t) => t.size)).toEqual([10, 400, 4]);
    expect(tapeOf(s, false, 100, 10).map((t) => t.size)).toEqual([400]);
    expect(tapeOf(s, false, 0, 2)).toHaveLength(2);
  });
});
