/**
 * Clusters of new accounts holding the same side of a market.
 *
 * Pattern: several wallets whose Polymarket profiles were created within a few hours of each other, all young, all on the same side. One person splitting a large bet
 * across fresh accounts looks like this. So does a referral wave, a promotion, or a group of friends signing up together, and a profile creation date is not an on-chain funding trace.
 * The output is a pointer to look closer (X-ray each wallet, check who funded them), never a statement that the accounts are one entity.
 */

export interface ClusterInput {
  wallet: string;
  /** Epoch seconds the profile was created. */
  createdAt?: number | null;
  outcomeIndex: number;
  outcome: string;
  posUsd: number | null;
  /** How many markets the wallet has traded in all. */
  traded: number | null;
}

export interface Cluster {
  outcome: string;
  outcomeIndex: number;
  wallets: string[];
  firstCreated: number;
  lastCreated: number;
  totalUsd: number;
  /** Members that have traded only 1 or 2 markets in total. */
  singleMarket: number;
}

export interface ClusterOptions {
  /** Accounts older than this many days do not count as new. */
  maxAgeDays?: number;
  /** Creation times within this many hours of the cluster's first account belong to it. */
  windowHours?: number;
  minWallets?: number;
}

export function findClusters(rows: readonly ClusterInput[], nowSecs: number, opts: ClusterOptions = {}): Cluster[] {
  const maxAge = (opts.maxAgeDays ?? 14) * 86_400;
  const window = (opts.windowHours ?? 24) * 3_600;
  const min = opts.minWallets ?? 3;
  const out: Cluster[] = [];
  const sides = new Map<number, ClusterInput[]>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (typeof r.createdAt !== 'number' || nowSecs - r.createdAt > maxAge || r.createdAt > nowSecs + 3_600 || seen.has(`${r.wallet}|${r.outcomeIndex}`)) continue;
    seen.add(`${r.wallet}|${r.outcomeIndex}`);
    sides.set(r.outcomeIndex, [...(sides.get(r.outcomeIndex) ?? []), r]);
  }
  for (const [idx, list] of sides) {
    const sorted = [...list].sort((a, b) => (a.createdAt as number) - (b.createdAt as number));
    let i = 0;
    while (i < sorted.length) {
      // greedy windows anchored on the earliest account not yet used
      let j = i;
      while (j + 1 < sorted.length && (sorted[j + 1].createdAt as number) - (sorted[i].createdAt as number) <= window) j++;
      const group = sorted.slice(i, j + 1);
      if (group.length >= min)
        out.push({
          outcome: group[0].outcome, outcomeIndex: idx, wallets: group.map((g) => g.wallet), firstCreated: group[0].createdAt as number, lastCreated: group[group.length - 1].createdAt as number,
          totalUsd: group.reduce((a, g) => a + (g.posUsd ?? 0), 0), singleMarket: group.filter((g) => g.traded !== null && g.traded <= 2).length,
        });
      i = j + 1;
    }
  }
  return out.sort((a, b) => b.totalUsd - a.totalUsd);
}

const usd = (x: number): string => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${Math.round(x)}`);
const stamp = (t: number): string => new Date(t * 1000).toISOString().slice(5, 16).replace('T', ' ');

export function formatCluster(c: Cluster): string {
  const span = c.lastCreated - c.firstCreated;
  const spanText = span < 3_600 ? `${Math.max(1, Math.round(span / 60))} min` : `${(span / 3_600).toFixed(1)} h`;
  return `${c.wallets.length} new accounts created within ${spanText} of each other (${stamp(c.firstCreated)}–${stamp(c.lastCreated)} UTC) all hold ${c.outcome}: ${usd(c.totalUsd)} together${c.singleMarket ? `, ${c.singleMarket} traded only 1-2 markets` : ''}`;
}

export const CLUSTER_CAVEAT = 'Same-day signups can be one person splitting a bet, or a referral wave or a friends group; creation dates are not proof of common control.';
