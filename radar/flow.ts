import type { TradeRow } from './store.ts';

/**
 * Who has been buying which side of one market, in the terms of its first outcome ("YES" below).
 * Buying outcome 0 or selling outcome 1 is a bet on YES; buying outcome 1 or selling outcome 0 is a bet on NO.
 */

export interface FlowWindow {
  secs: number;
  yesUsd: number;
  noUsd: number;
  fills: number;
  wallets: number;
}

export interface NetWallet {
  wallet: string;
  /** Net shares of YES exposure (negative = net NO). */
  netShares: number;
  /** Dollars bought minus sold on that exposure. */
  netUsd: number;
  fills: number;
}

export interface MarketFlow {
  windows: FlowWindow[]; // 1h, 6h, 24h
  /** Share of the last 24h's dollars done by the single busiest wallet. */
  topWalletShare: number;
  priceNow: number | null; // YES terms
  price1h: number | null;
  price6h: number | null;
  topYes: NetWallet[];
  topNo: NetWallet[];
  fills: number;
}

const WINDOWS = [3_600, 6 * 3_600, 24 * 3_600];
const yesPrice = (t: TradeRow): number => (t.outcomeIndex === 0 ? t.price : 1 - t.price);
const yesBet = (t: TradeRow): boolean => (t.outcomeIndex === 0) === (t.side === 'BUY');

export function marketFlow(trades: readonly TradeRow[], nowSecs: number, top = 6): MarketFlow {
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  const windows: FlowWindow[] = WINDOWS.map((secs) => {
    const w = new Set<string>();
    let yes = 0;
    let no = 0;
    let fills = 0;
    for (const t of sorted) {
      if (t.ts < nowSecs - secs) continue;
      fills++;
      w.add(t.wallet);
      if (yesBet(t)) yes += t.size * t.price;
      else no += t.size * t.price;
    }
    return { secs, yesUsd: yes, noUsd: no, fills, wallets: w.size };
  });
  const day = new Map<string, number>();
  const net = new Map<string, NetWallet>();
  for (const t of sorted) {
    const usd = t.size * t.price;
    if (t.ts >= nowSecs - 86_400) day.set(t.wallet, (day.get(t.wallet) ?? 0) + usd);
    const n = net.get(t.wallet) ?? { wallet: t.wallet, netShares: 0, netUsd: 0, fills: 0 };
    const sign = yesBet(t) ? 1 : -1;
    n.netShares += sign * t.size;
    n.netUsd += sign * usd;
    n.fills++;
    net.set(t.wallet, n);
  }
  const dayTotal = [...day.values()].reduce((a, b) => a + b, 0);
  const priceAt = (secsAgo: number): number | null => {
    const upTo = sorted.filter((t) => t.ts <= nowSecs - secsAgo);
    return upTo.length ? yesPrice(upTo[upTo.length - 1]) : null;
  };
  const all = [...net.values()];
  return {
    windows,
    topWalletShare: dayTotal > 0 ? Math.max(...day.values()) / dayTotal : 0,
    priceNow: sorted.length ? yesPrice(sorted[sorted.length - 1]) : null,
    price1h: priceAt(3_600),
    price6h: priceAt(6 * 3_600),
    topYes: all.filter((n) => n.netShares > 0).sort((a, b) => b.netShares - a.netShares).slice(0, top),
    topNo: all.filter((n) => n.netShares < 0).sort((a, b) => a.netShares - b.netShares).slice(0, top),
    fills: sorted.length,
  };
}
