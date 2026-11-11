import { MILLS, type LiveState, type LiveTrade } from './livebook.ts';

/**
 * The DOM ("glass") view-model, as in scalping terminals (Tiger.com, CScalp): one row per price, descending, with the resting bid size on the left of the price and the ask size on the right,
 * trade clusters (volume traded at that price per time bucket, buy vs sell) beside it, and the latest prints at the price. Everything is derived from a LiveState; rendering is elsewhere.
 * `group` merges that many ticks into one row ("compression" in CScalp, 1T/2T/5T in Tiger).
 */

export type Unit = 'SH' | 'USD';

export interface DomOpts {
  rows: number;
  group: number;
  unit: Unit;
  /** View the other outcome (a NO book is the YES book mirrored: price 1-p, bids and asks swapped). */
  flip: boolean;
  periodSecs: number;
  clusterCols: number;
  /** Rows scrolled from the centre (positive = towards higher prices). */
  scroll: number;
  /** Frozen centre in mills; null follows the market. */
  manualCenter: number | null;
  nowMs: number;
  /** A print stays on its price row this long. */
  recentSecs?: number;
}

export interface DomCluster {
  buy: number;
  sell: number;
}
export interface DomRow {
  mills: number;
  bid: number;
  ask: number;
  clusters: DomCluster[];
  print: DomCluster;
  isBestBid: boolean;
  isBestAsk: boolean;
  isLast: boolean;
}
export interface DomModel {
  rows: DomRow[];
  maxDepth: number;
  clusterMax: number;
  colStarts: number[];
  colDelta: number[];
  colTotal: number[];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  last: LiveTrade | null;
  centerMills: number;
  stepMills: number;
  /** Money (in the chosen unit) resting within 5 cents of the best price on each side. */
  bidNear: number;
  askNear: number;
}

export interface SideView {
  bids: Map<number, number>;
  asks: Map<number, number>;
  trades: LiveTrade[];
}

/** The book as seen from one outcome: the other outcome mirrors prices and swaps the sides. */
export function viewOf(s: Pick<LiveState, 'bids' | 'asks' | 'trades'>, flip: boolean): SideView {
  if (!flip) return { bids: s.bids, asks: s.asks, trades: s.trades };
  const mirror = (m: Map<number, number>) => new Map([...m].map(([p, z]) => [MILLS - p, z] as const));
  return { bids: mirror(s.asks), asks: mirror(s.bids), trades: s.trades.map((t) => ({ ...t, price: 1 - t.price, side: t.side === 'BUY' ? 'SELL' : 'BUY' })) };
}

export const bestOf = (v: SideView): { bid: number | null; ask: number | null } => ({
  bid: v.bids.size ? Math.max(...v.bids.keys()) : null,
  ask: v.asks.size ? Math.min(...v.asks.keys()) : null,
});

/** The row (in mills) the ladder centres on when following the market. */
export function autoCenter(s: Pick<LiveState, 'bids' | 'asks' | 'trades' | 'tickMills'>, flip: boolean, group: number): number {
  const v = viewOf(s, flip);
  const { bid, ask } = bestOf(v);
  const step = s.tickMills * group;
  const last = v.trades.at(-1);
  const mid = bid !== null && ask !== null ? (bid + ask) / 2 : bid ?? ask ?? (last ? last.price * MILLS : MILLS / 2);
  return Math.floor(mid / step) * step;
}

export function buildDom(s: LiveState, o: DomOpts): DomModel {
  const v = viewOf(s, o.flip);
  const step = s.tickMills * o.group;
  const bucket = (m: number): number => Math.floor(m / step) * step;
  const { bid, ask } = bestOf(v);
  const nowSecs = o.nowMs / 1000;
  const money = (price: number, size: number): number => (o.unit === 'USD' ? size * price : size);

  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  for (const [m, z] of v.bids) bids.set(bucket(m), (bids.get(bucket(m)) ?? 0) + money(m / MILLS, z));
  for (const [m, z] of v.asks) asks.set(bucket(m), (asks.get(bucket(m)) ?? 0) + money(m / MILLS, z));

  const periodMs = o.periodSecs;
  const colStarts = Array.from({ length: o.clusterCols }, (_, j) => Math.floor(nowSecs / periodMs) * periodMs - (o.clusterCols - 1 - j) * periodMs);
  const grid = new Map<number, DomCluster[]>();
  const prints = new Map<number, DomCluster>();
  const colDelta = colStarts.map(() => 0);
  const colTotal = colStarts.map(() => 0);
  const recent = o.recentSecs ?? 20;
  const first = colStarts[0] ?? Infinity;
  for (const t of v.trades) {
    const m = bucket(Math.round(t.price * MILLS));
    const amount = money(t.price, t.size);
    if (t.ts >= first) {
      const j = Math.min(colStarts.length - 1, Math.floor((t.ts - first) / periodMs));
      const cells = grid.get(m) ?? colStarts.map(() => ({ buy: 0, sell: 0 }));
      grid.set(m, cells);
      cells[j][t.side === 'BUY' ? 'buy' : 'sell'] += amount;
      colDelta[j] += t.side === 'BUY' ? amount : -amount;
      colTotal[j] += amount;
    }
    if (t.ts >= nowSecs - recent) {
      const p = prints.get(m) ?? { buy: 0, sell: 0 };
      prints.set(m, p);
      p[t.side === 'BUY' ? 'buy' : 'sell'] += amount;
    }
  }

  const last = v.trades.at(-1) ?? null;
  const half = Math.floor((Math.max(3, o.rows) - 1) / 2);
  const rawCenter = o.manualCenter ?? autoCenter(s, o.flip, o.group);
  let center = rawCenter + o.scroll * step;
  // keep the window inside (0, 1): shift instead of showing impossible prices
  const maxTop = bucket(MILLS - s.tickMills);
  const top0 = center + half * step;
  if (top0 > maxTop) center -= top0 - maxTop;
  const bottom0 = center - half * step;
  if (bottom0 < step) center += step - bottom0;
  const bestBidRow = bid === null ? null : bucket(bid);
  const bestAskRow = ask === null ? null : bucket(ask);
  const lastRow = last ? bucket(Math.round(last.price * MILLS)) : null;

  const rows: DomRow[] = [];
  for (let i = 0; i < Math.max(3, o.rows); i++) {
    const m = center + (half - i) * step;
    rows.push({
      mills: m,
      bid: bids.get(m) ?? 0,
      ask: asks.get(m) ?? 0,
      clusters: grid.get(m) ?? colStarts.map(() => ({ buy: 0, sell: 0 })),
      print: prints.get(m) ?? { buy: 0, sell: 0 },
      isBestBid: m === bestBidRow,
      isBestAsk: m === bestAskRow,
      isLast: m === lastRow,
    });
  }
  const near = (m: Map<number, number>, from: number | null, sign: 1 | -1): number => {
    if (from === null) return 0;
    let sum = 0;
    for (const [b, z] of m) if ((b - bucket(from)) * sign <= 50 && (b - bucket(from)) * sign >= -50) sum += z;
    return sum;
  };
  return {
    rows,
    maxDepth: Math.max(1, ...rows.map((r) => Math.max(r.bid, r.ask))),
    clusterMax: Math.max(1, ...rows.flatMap((r) => r.clusters.map((c) => Math.max(c.buy, c.sell)))),
    colStarts,
    colDelta,
    colTotal,
    bestBid: bid,
    bestAsk: ask,
    mid: bid !== null && ask !== null ? (bid + ask) / 2 : null,
    last,
    centerMills: center,
    stepMills: step,
    bidNear: near(bids, bid, -1),
    askNear: near(asks, ask, 1),
  };
}

/** Tape lines for the chosen outcome, newest first, with a minimum dollar size. */
export function tapeOf(s: Pick<LiveState, 'bids' | 'asks' | 'trades'>, flip: boolean, minUsd: number, limit: number): LiveTrade[] {
  const out: LiveTrade[] = [];
  const trades = viewOf(s, flip).trades;
  for (let i = trades.length - 1; i >= 0 && out.length < limit; i--) if (trades[i].size * trades[i].price >= minUsd) out.push(trades[i]);
  return out;
}
