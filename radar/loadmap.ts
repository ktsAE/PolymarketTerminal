import { funderFanOut, httpRpc, scanFunding, type RpcCall, type ScanProgress } from './chainfunding.ts';
import { buildFundMap, type FundMap, type MapHolder } from './fundmap.ts';
import type { HolderRow } from './holders.ts';
import type { PolymarketClient } from './polymarket.ts';

export interface MapView {
  cid: string;
  question: string;
  stage: string;
  done: boolean;
  error: string | null;
  scan: ScanProgress | null;
  /** Windows that kept failing (the map may be missing transfers). */
  failed: number;
  days: number;
  map: FundMap | null;
  holders: MapHolder[];
}

export function toMapHolders(rows: readonly HolderRow[]): MapHolder[] {
  return rows.map((r) => ({ wallet: r.wallet, outcome: r.outcome, outcomeIndex: r.outcomeIndex, posUsd: r.posUsd, cls: r.cls, createdAt: r.createdAt ?? null, name: r.name }));
}

/** Scans the chain for funding of the loaded holders and builds the map. `onProgress` gets the view as it fills in; never throws. */
export async function loadMap(
  client: PolymarketClient,
  cid: string,
  question: string,
  rows: readonly HolderRow[],
  opts: { days?: number; rpc?: RpcCall; cancelled?: () => boolean; onProgress?: (v: MapView) => void; controlSize?: number; serviceFanOut?: number } = {},
): Promise<MapView> {
  const days = opts.days ?? 14;
  const holders = toMapHolders(rows);
  const view: MapView = { cid, question, stage: 'sampling other traders of the market', done: false, error: null, scan: null, failed: 0, days, map: null, holders };
  const emit = () => opts.onProgress?.({ ...view });
  try {
    emit();
    if (holders.length < 2) throw new Error('load the holders first (h) — a map needs at least 2');
    const mine = new Set(holders.map((h) => h.wallet.toLowerCase()));
    const trades = await client.tradesPage(cid, { limit: 400 }).catch(() => []);
    const control = [...new Set(trades.map((t) => t.wallet.toLowerCase()))].filter((w) => !mine.has(w)).slice(0, opts.controlSize ?? 30);
    view.stage = 'reading USDC transfers from the Polygon chain';
    emit();
    const res = await scanFunding(opts.rpc ?? httpRpc(), [...holders.map((h) => h.wallet), ...control], {
      days, cancelled: opts.cancelled, onProgress: (p) => { view.scan = p; emit(); },
    });
    view.failed = res.failed;
    const rpc = opts.rpc ?? httpRpc();
    // funders that would link holders: probe how many strangers each one pays, and drop the busy ones as services
    const first = buildFundMap(holders, res.transfers, control, {});
    const candidates = [...new Set(first.groups.flatMap((g) => (g.funder ? [g.funder] : [])))].slice(0, 12);
    view.stage = 'checking whether the funders are services';
    emit();
    const busy: string[] = [];
    for (const f of candidates) if ((await funderFanOut(rpc, f, res.head)) >= (opts.serviceFanOut ?? 12)) busy.push(f);
    view.map = busy.length ? buildFundMap(holders, res.transfers, control, { ignore: busy, markHubs: busy }) : first;
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
  }
  view.done = true;
  view.stage = 'done';
  emit();
  return view;
}
