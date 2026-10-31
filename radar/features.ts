import type { TradeRow } from './store.ts';

/**
 * Pure feature functions. Two lessons from the first data pull are baked in:
 *  - the unit of analysis is the match-side, not the wallet or the trade (many wallets piling onto
 *    one winning underdog is ONE observation, not dozens);
 *  - exposure is measured at its peak, because a position that was later sold or redeemed still
 *    tells you what the wallet was willing to risk.
 */

export interface Unit {
  /** Price paid for the side (implied probability of winning). */
  q: number;
  win: 0 | 1;
}

export interface ZResult {
  n: number;
  wins: number;
  expected: number;
  z: number;
}

/** z-score of realized wins against the entry prices; 0 when there is nothing to test. */
export function clusteredZ(units: readonly Unit[]): ZResult {
  const n = units.length;
  const wins = units.reduce((s, u) => s + u.win, 0);
  const expected = units.reduce((s, u) => s + u.q, 0);
  const variance = units.reduce((s, u) => s + u.q * (1 - u.q), 0);
  return { n, wins, expected, z: variance > 0 ? (wins - expected) / Math.sqrt(variance) : 0 };
}

export interface Position {
  wallet: string;
  outcomeIndex: number;
  /** Highest net share count held at any time. */
  peakShares: number;
  /** Dollars paid for the shares held at that peak (average-cost basis). */
  peakCost: number;
  vwap: number;
  firstTs: number;
  peakTs: number;
  fills: number;
  /** Share of cost deployed at or after gameStart (null if the start is unknown). */
  liveShare: number | null;
}

/** Peak exposure per wallet per outcome, replaying fills in time order (BUY adds, SELL reduces at average cost). */
export interface PriceBand {
  min: number;
  max: number;
}
/** Fills outside this band are mostly settlement sweeping (buying 0.99 after the result is known) and say nothing about information. */
export const INFORMATIVE_BAND: PriceBand = { min: 0.03, max: 0.97 };

export function peakPositions(trades: readonly TradeRow[], gameStart: number | null, band?: PriceBand): Position[] {
  const byKey = new Map<string, TradeRow[]>();
  for (const t of trades) {
    if (band && (t.price < band.min || t.price > band.max)) continue;
    const k = `${t.wallet}|${t.outcomeIndex}`;
    const list = byKey.get(k);
    if (list) list.push(t);
    else byKey.set(k, [t]);
  }
  const out: Position[] = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.ts - b.ts);
    let shares = 0;
    let cost = 0;
    let best: Position | null = null;
    let liveCostAtPeak = 0;
    let liveCost = 0;
    for (const t of list) {
      if (t.side === 'BUY') {
        shares += t.size;
        const c = t.size * t.price;
        cost += c;
        if (gameStart !== null && t.ts >= gameStart) liveCost += c;
      } else if (shares > 0) {
        const sold = Math.min(shares, t.size);
        const avg = cost / shares;
        cost -= avg * sold;
        liveCost = liveCost * (1 - sold / shares);
        shares -= sold;
      }
      if (!best || shares > best.peakShares) {
        best = {
          wallet: t.wallet, outcomeIndex: t.outcomeIndex, peakShares: shares, peakCost: cost, vwap: shares > 0 ? cost / shares : 0,
          firstTs: list[0].ts, peakTs: t.ts, fills: list.length, liveShare: null,
        };
        liveCostAtPeak = liveCost;
      }
    }
    if (best && best.peakShares > 0) {
      best.liveShare = gameStart === null ? null : best.peakCost > 0 ? Math.min(1, liveCostAtPeak / best.peakCost) : 0;
      out.push(best);
    }
  }
  return out.sort((a, b) => b.peakCost - a.peakCost);
}

/** Fraction of a wallet's bought dollars that went to outcomes other than `outcomeIndex` in this market (market-maker / arbitrage tell). */
export function oppositeShare(trades: readonly TradeRow[], wallet: string, outcomeIndex: number): number {
  let same = 0;
  let other = 0;
  for (const t of trades) {
    if (t.wallet !== wallet || t.side !== 'BUY') continue;
    if (t.outcomeIndex === outcomeIndex) same += t.size * t.price;
    else other += t.size * t.price;
  }
  return same + other > 0 ? other / (same + other) : 0;
}

export interface FlowSummary {
  trades: number;
  wallets: number;
  /** Dollar volume (price * size summed over BUYs, one count per fill side) */
  buyVolume: number;
  preStartShare: number | null;
  topWalletShare: number;
}

export function flowSummary(trades: readonly TradeRow[], gameStart: number | null): FlowSummary {
  let vol = 0;
  let pre = 0;
  const byWallet = new Map<string, number>();
  for (const t of trades) {
    if (t.side !== 'BUY') continue;
    const d = t.size * t.price;
    vol += d;
    if (gameStart !== null && t.ts < gameStart) pre += d;
    byWallet.set(t.wallet, (byWallet.get(t.wallet) ?? 0) + d);
  }
  const top = Math.max(0, ...byWallet.values());
  return {
    trades: trades.length,
    wallets: new Set(trades.map((t) => t.wallet)).size,
    buyVolume: vol,
    preStartShare: gameStart === null || vol === 0 ? null : pre / vol,
    topWalletShare: vol > 0 ? top / vol : 0,
  };
}
