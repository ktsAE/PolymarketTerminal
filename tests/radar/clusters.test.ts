import { describe, expect, it } from 'vitest';
import { CLUSTER_CAVEAT, findClusters, formatCluster, type ClusterInput } from '../../radar/clusters';

const NOW = 1_800_000_000;
const H = 3_600;
const D = 86_400;
const w = (id: string, createdAgo: number | null, outcomeIndex = 0, posUsd: number | null = 1000, traded: number | null = 1): ClusterInput => ({
  wallet: id, createdAt: createdAgo === null ? null : NOW - createdAgo, outcomeIndex, outcome: outcomeIndex === 0 ? 'Yes' : 'No', posUsd, traded,
});

describe('new-account clusters', () => {
  it('groups young accounts created within the window that hold the same side', () => {
    const rows = [w('a', 2 * D), w('b', 2 * D - 2 * H), w('c', 2 * D - 5 * H, 0, 3000, 40), w('d', 9 * D)];
    const [c] = findClusters(rows, NOW);
    expect(c.wallets).toEqual(['a', 'b', 'c']);
    expect(c).toMatchObject({ outcome: 'Yes', totalUsd: 5000, singleMarket: 2 });
    expect(findClusters(rows, NOW)).toHaveLength(1);
    const text = formatCluster(c);
    expect(text).toMatch(/^3 new accounts created within 5\.0 h of each other \(.*UTC\) all hold Yes: \$5\.0k together, 2 traded only 1-2 markets$/);
  });
  it('keeps the sides apart, ignores old and unknown-age accounts, and needs three wallets', () => {
    expect(findClusters([w('a', D), w('b', D), w('c', D, 1), w('d', D, 1)], NOW)).toEqual([]);
    expect(findClusters([w('a', D), w('b', D), w('c', 400 * D), w('d', null)], NOW)).toEqual([]);
    expect(findClusters([w('a', D), w('b', D), w('c', D), w('d', D, 1), w('e', D, 1), w('f', D, 1)], NOW)).toHaveLength(2);
  });
  it('splits accounts created far apart into separate windows and lists the biggest cluster first', () => {
    const rows = [w('a', 10 * D, 0, 100), w('b', 10 * D, 0, 100), w('c', 10 * D, 0, 100), w('d', 3 * D, 0, 900), w('e', 3 * D, 0, 900), w('f', 3 * D, 0, 900)];
    const cs = findClusters(rows, NOW);
    expect(cs.map((c) => c.wallets.join(''))).toEqual(['def', 'abc']);
  });
  it('counts a wallet once and tolerates missing position sizes', () => {
    const cs = findClusters([w('a', D, 0, null), w('a', D, 0, null), w('b', D, 0, null), w('c', D, 0, null)], NOW);
    expect(cs[0].wallets).toEqual(['a', 'b', 'c']);
    expect(cs[0].totalUsd).toBe(0);
  });
  it('states what it does not prove', () => {
    expect(CLUSTER_CAVEAT).toMatch(/not proof of common control/);
  });
});
