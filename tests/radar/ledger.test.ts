import { describe, expect, it } from 'vitest';
import type { HolderTop, ResultLine, SnapshotLine, WindowLabel } from '../../radar/forward';
import { EDGE, NO_EDGE, STRATEGIES, dayClusteredCi, formatLedger, groupSnapshots, mulberry32, scoreLedger } from '../../radar/ledger';

const DAY = 86400;
const BASE = Date.UTC(2026, 10, 2, 18, 0, 0) / 1000;
const OFFSET: Record<WindowLabel, number> = { 'T-8h': 8 * 3600, 'T-2h': 2 * 3600, 'T-5m': 300 };

/** Two-outcome snapshot; `a` is outcome A's mid, B mirrors it, spread 0.02. */
function snap(cid: string, label: WindowLabel, a: number, startTs: number, holders: HolderTop[] | null = null): SnapshotLine {
  const q = (outcome: string, mid: number) => ({ outcome, bid: +(mid - 0.01).toFixed(4), ask: +(mid + 0.01).toFixed(4), mid, bidUsd: 50, askUsd: 50 });
  return { v: 1, cid, slug: `ev-${cid}`, title: cid, event: cid, sport: 'nba', outcomes: ['A', 'B'], startTs, label, capturedAt: startTs - OFFSET[label], quotes: [q('A', a), q('B', +(1 - a).toFixed(4))], vol24: null, holders, holdersAbsent: holders === null };
}
const result = (cid: string, winnerIdx: number | null): ResultLine => ({ cid, winnerIdx, payout: winnerIdx === null ? [0.5, 0.5] : winnerIdx === 0 ? [1, 0] : [0, 1], settledAt: 0 });

/** n markets, 10 per UTC day, where A's mid falls 0.55 -> 0.50 and A wins ~80% (seeded): fade-move clearly wins. */
function fadeWorld(n: number, seed = 7): { snaps: SnapshotLine[]; results: ResultLine[] } {
  const rng = mulberry32(seed);
  const snaps: SnapshotLine[] = [];
  const results: ResultLine[] = [];
  for (let i = 0; i < n; i++) {
    const cid = `0x${i}`;
    const start = BASE + Math.floor(i / 10) * DAY + (i % 10) * 600;
    snaps.push(snap(cid, 'T-8h', 0.55, start), snap(cid, 'T-5m', 0.5, start));
    results.push(result(cid, rng() < 0.8 ? 0 : 1));
  }
  return { snaps, results };
}

const byId = (r: ReturnType<typeof scoreLedger>, id: string) => r.strategies.find((s) => s.id === id)!;

describe('pre-registered strategies', () => {
  it('has the five fixed strategies in order', () => {
    expect(STRATEGIES.map((s) => s.id)).toEqual(['fade-move', 'follow-move', 'favorite', 'underdog', 'top-holders-lean']);
  });

  it('fade buys the side that fell at the T-5m ask; follow buys the other; under-threshold moves bet nothing', () => {
    const g = groupSnapshots([snap('c', 'T-8h', 0.6, BASE), snap('c', 'T-5m', 0.55, BASE)]).byCid.get('c')!;
    expect(STRATEGIES[0].pick(g)).toEqual({ outcomeIdx: 0, price: 0.56 });
    expect(STRATEGIES[1].pick(g)).toEqual({ outcomeIdx: 1, price: 0.46 });
    expect(STRATEGIES[2].pick(g)).toEqual({ outcomeIdx: 0, price: 0.56 });
    expect(STRATEGIES[3].pick(g)).toEqual({ outcomeIdx: 1, price: 0.46 });
    const small = groupSnapshots([snap('d', 'T-8h', 0.6, BASE), snap('d', 'T-5m', 0.58, BASE)]).byCid.get('d')!;
    expect(STRATEGIES[0].pick(small)).toBeNull();
    expect(STRATEGIES[1].pick(small)).toBeNull();
  });

  it('top-holders-lean needs logged holders at T-2h and weighs shares by mid', () => {
    const h: HolderTop[] = [
      { wallet: 'w1', side: 'A', outcomeIndex: 0, size: 1000 }, // 1000 x 0.3 = $300
      { wallet: 'w2', side: 'B', outcomeIndex: 1, size: 500 }, // 500 x 0.7 = $350
    ];
    const withH = groupSnapshots([snap('c', 'T-2h', 0.3, BASE, h), snap('c', 'T-5m', 0.3, BASE)]).byCid.get('c')!;
    expect(STRATEGIES[4].pick(withH)).toEqual({ outcomeIdx: 1, price: 0.71 });
    const noH = groupSnapshots([snap('c', 'T-2h', 0.3, BASE, null), snap('c', 'T-5m', 0.3, BASE)]).byCid.get('c')!;
    expect(STRATEGIES[4].pick(noH)).toBeNull();
  });
});

describe('scoreLedger', () => {
  it('a clearly winning strategy gets a verdict only at n >= 300', () => {
    const { snaps, results } = fadeWorld(300);
    const r = scoreLedger(snaps, results);
    const fade = byId(r, 'fade-move');
    expect(fade.n).toBe(300);
    expect(fade.events).toBe(300);
    expect(fade.days).toBe(30);
    expect(fade.roi!).toBeGreaterThan(0.3);
    expect(fade.ci![0]).toBeGreaterThan(0);
    expect(fade.verdict).toBe(EDGE);
    expect(byId(r, 'follow-move').verdict).toBe(NO_EDGE);
    expect(byId(r, 'follow-move').roi!).toBeLessThan(0);

    const fewer = byId(scoreLedger(...Object.values(fadeWorld(299)) as [SnapshotLine[], ResultLine[]]), 'fade-move');
    expect(fewer.ci![0]).toBeGreaterThan(0);
    expect(fewer.verdict).toBe(NO_EDGE);
  });

  it('small n is always NO EDGE PROVEN, even when every bet wins', () => {
    const snaps: SnapshotLine[] = [];
    const results: ResultLine[] = [];
    for (let i = 0; i < 40; i++) {
      snaps.push(snap(`m${i}`, 'T-8h', 0.4, BASE + i * DAY), snap(`m${i}`, 'T-5m', 0.3, BASE + i * DAY));
      results.push(result(`m${i}`, 0));
    }
    const r = scoreLedger(snaps, results);
    for (const s of r.strategies) expect(s.verdict).toBe(NO_EDGE);
    expect(byId(r, 'fade-move').hitRate).toBe(1);
  });

  it('skips one-sided, malformed, duplicate and missing snapshots and unsettled markets', () => {
    const oneSided = { ...snap('x', 'T-8h', 0.6, BASE), quotes: [{ outcome: 'A', bid: 0, ask: 0.62, mid: 0.31, bidUsd: 0, askUsd: 5 }, snap('x', 'T-8h', 0.6, BASE).quotes[1]] };
    const missingSide = { ...snap('y', 'T-8h', 0.6, BASE), quotes: [snap('y', 'T-8h', 0.6, BASE).quotes[0]] };
    const snaps = [
      oneSided,
      snap('x', 'T-5m', 0.5, BASE), // x: T-8h unusable -> no move bet, still a favorite/underdog bet
      missingSide,
      snap('y', 'T-5m', 0.5, BASE),
      snap('z', 'T-5m', 0.4, BASE),
      snap('z', 'T-5m', 0.9, BASE), // duplicate label: first kept
      { cid: 'junk' },
      snap('u', 'T-8h', 0.6, BASE), // only T-8h: nothing to fill at
      snap('w', 'T-8h', 0.6, BASE),
      snap('w', 'T-5m', 0.5, BASE), // no result line: never scored
    ];
    const results = [result('x', 0), result('y', 1), result('z', null), result('u', 0)];
    const r = scoreLedger(snaps, results);
    expect(r.skippedSnapshots).toBe(4);
    expect(r.markets).toBe(5);
    expect(r.settled).toBe(4);
    for (const id of ['fade-move', 'follow-move', 'top-holders-lean']) expect(byId(r, id).n).toBe(0);
    const fav = byId(r, 'favorite');
    expect(fav.n).toBe(1); // x and y tie at 0.5; z: B at 0.6 favored, voided
    expect(fav.voids).toBe(1);
    expect(fav.bets[0]).toMatchObject({ cid: 'z', outcomeIdx: 1, price: 0.61, payout: 0.5 });
    expect(fav.roi!).toBeCloseTo(0.5 / 0.61 - 1, 9);
    expect(fav.verdict).toBe(NO_EDGE);
  });

  it('bootstrap is deterministic for a seed and clusters by day', () => {
    const { snaps, results } = fadeWorld(120);
    const a = scoreLedger(snaps, results, { seed: 1 });
    const b = scoreLedger(snaps, results, { seed: 1 });
    expect(a.strategies.map((s) => s.ci)).toEqual(b.strategies.map((s) => s.ci));
    expect(byId(a, 'fade-move').ci).not.toEqual(byId(scoreLedger(snaps, results, { seed: 2 }), 'fade-move').ci);

    // all bets on one day: no between-day variation to resample, so the CI collapses to the mean
    const oneDay = [{ day: 'd', ret: 1 }, { day: 'd', ret: -1 }, { day: 'd', ret: 0.5 }];
    const ci = dayClusteredCi(oneDay, 0.99, 500, 3)!;
    expect(ci[0]).toBeCloseTo(0.5 / 3, 12);
    expect(ci[1]).toBeCloseTo(0.5 / 3, 12);
    expect(dayClusteredCi([], 0.99, 500, 3)).toBeNull();
  });
});

describe('formatLedger', () => {
  it('prints every hit rate beside its break-even rate and every verdict', () => {
    const { snaps, results } = fadeWorld(300);
    const lines = formatLedger(scoreLedger(snaps, results));
    expect(lines).toHaveLength(2 + STRATEGIES.length);
    for (const l of lines.filter((x) => /hit \d/.test(x))) expect(l).toMatch(/hit [\d.]+% vs break-even [\d.]+%/);
    expect(lines.find((l) => l.startsWith('fade-move'))).toContain(EDGE);
    expect(lines.find((l) => l.startsWith('top-holders-lean'))).toContain('n=0');
    expect(lines.find((l) => l.startsWith('top-holders-lean'))).toContain(NO_EDGE);
  });
});
