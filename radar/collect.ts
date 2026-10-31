import { flowBySlug, rankAnomalies, rankGames, tagWallet, type WalletTag } from './detect.ts';
import type { PolymarketClient } from './polymarket.ts';
import type { RadarStore } from './store.ts';
import type { Model, TaggedPrint } from './tui/render.ts';

export interface CycleOptions {
  /** Pages of 100 events, ranked by 24h volume. */
  pages?: number;
  /** Capture fills of at least this many dollars. */
  minPrintUsd?: number;
  /** Profile wallets behind fills of at least this size (two API calls each). */
  profileMinUsd?: number;
  profileCap?: number;
  now?: () => number;
  /** Called as soon as each stage's data is stored, so the screen can show results before the slow wallet profiling finishes. */
  onStage?: (stage: 'snapshots' | 'prints') => void;
}

export interface CycleResult {
  events: number;
  newPrints: number;
  profiled: number;
  /** Wallets we tried to profile but could not; they stay tagged "?" until the next cycle. */
  profileErrors: number;
  at: number; // epoch ms
}

const DAY = 86_400;

/** One poll: store a snapshot of the busiest events, capture large fills, profile unknown wallets. */
export async function runCycle(client: PolymarketClient, store: RadarStore, opts: CycleOptions = {}): Promise<CycleResult> {
  const now = opts.now ?? Date.now;
  const ts = Math.floor(now() / 1000);
  const snaps = [];
  for (let page = 0; page < (opts.pages ?? 3); page++) snaps.push(...(await client.topEvents({ offset: page * 100, limit: 100, ts })));
  store.insertSnapshots(snaps);
  opts.onStage?.('snapshots');

  const prints = await client.bigPrints({ minUsd: opts.minPrintUsd ?? 2_000, limit: 1_000 });
  const newPrints = store.insertPrints(prints);
  opts.onStage?.('prints');

  const wanted = new Map<string, number>();
  for (const p of prints) if (p.usd >= (opts.profileMinUsd ?? 5_000) && !store.getWallet(p.wallet)) wanted.set(p.wallet, Math.max(wanted.get(p.wallet) ?? 0, p.usd));
  let profiled = 0;
  let profileErrors = 0;
  for (const [wallet] of [...wanted].sort((a, b) => b[1] - a[1]).slice(0, opts.profileCap ?? 40)) {
    try {
      const w = await client.walletLite(wallet);
      store.upsertWallet({ wallet, firstSeen: w.firstSeen, traded: w.traded, bigPositions: null, skillZ: null, fetchedAt: ts });
      profiled++;
    } catch {
      profileErrors++;
    }
  }
  store.pruneOld(ts - 3 * DAY, ts - 2 * DAY);
  return { events: snaps.length, newPrints, profiled, profileErrors, at: now() };
}

/** Category filter for the anomaly list (null = all). */
export function applyFilters<T extends { cat: string }>(list: readonly T[], f: { cat: string | null }): T[] {
  return f.cat === null ? [...list] : list.filter((a) => a.cat === f.cat);
}

/** Recomputes everything the screen shows from stored data. Cheap: no network. */
export function buildModel(store: RadarStore, nowMs: number): Pick<Model, 'anomalies' | 'games' | 'prints' | 'leads'> & { historySecs: number; events: number } {
  const nowSecs = Math.floor(nowMs / 1000);
  const span = store.snapshotSpan();
  const latest = span ? store.latestSnapshots().filter((s) => s.ts >= span.last - 900) : [];

  const printRows = store.printsSince(nowSecs - 6 * 3_600, 400);
  const tags = new Map<string, WalletTag>();
  for (const p of printRows) {
    if (tags.has(p.wallet)) continue;
    const w = store.getWallet(p.wallet);
    tags.set(p.wallet, tagWallet(w ? { firstSeen: w.firstSeen, traded: w.traded } : undefined, p.ts));
  }
  const flows = flowBySlug(printRows, tags, nowSecs);
  const past = (id: string, ts: number) => store.snapshotNear(id, ts);
  const anomalies = rankAnomalies(latest, past, flows, nowSecs);
  const games = rankGames(latest, past, flows, nowSecs);
  const prints: TaggedPrint[] = printRows.map((p) => ({ ...p, tag: tags.get(p.wallet) ?? tagWallet(undefined, p.ts) }));
  return { anomalies, games, prints, leads: store.listNews({ relevantOnly: true, limit: 100 }), historySecs: span ? span.last - span.first : 0, events: latest.length };
}
