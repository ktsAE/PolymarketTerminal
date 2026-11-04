import type { WalletClass } from './profile.ts';
import type { TradeRow } from './store.ts';

/**
 * Who is pushing a market: dollars bet on YES and on NO by wallet class (HUMAN, MM, BOT, ALGO...), over the last hour, 6 hours and day.
 * Only wallets that were profiled carry a class; the rest are UNKNOWN, and the coverage figure says how much of the money that is.
 * Buying outcome 0 or selling outcome 1 is a bet on YES (the first outcome); the opposite is a bet on NO.
 */

export type FlowClass = WalletClass | 'UNKNOWN';
export const FLOW_CLASSES: FlowClass[] = ['HUMAN', 'ALGO', 'BOT', 'MM', 'LOW_DATA', 'UNKNOWN'];

export interface ClassBucket {
  cls: FlowClass;
  yesUsd: number;
  noUsd: number;
  fills: number;
  wallets: number;
}

export interface ClassFlowWindow {
  secs: number;
  buckets: ClassBucket[];
  totalUsd: number;
  /** Share of the window's dollars done by profiled wallets. */
  coverage: number;
}

export interface ClassFlow {
  windows: ClassFlowWindow[]; // 1h, 6h, 24h
  fills: number;
  profiled: number;
}

const WINDOWS = [3_600, 6 * 3_600, 24 * 3_600];
const yesBet = (t: TradeRow): boolean => (t.outcomeIndex === 0) === (t.side === 'BUY');

export function classFlow(trades: readonly TradeRow[], classOf: ReadonlyMap<string, WalletClass>, nowSecs: number): ClassFlow {
  const windows = WINDOWS.map((secs): ClassFlowWindow => {
    const by = new Map<FlowClass, { b: ClassBucket; w: Set<string> }>();
    let total = 0;
    let known = 0;
    for (const t of trades) {
      if (t.ts < nowSecs - secs || t.ts > nowSecs + 60) continue;
      const cls: FlowClass = classOf.get(t.wallet) ?? 'UNKNOWN';
      const usd = t.size * t.price;
      const e = by.get(cls) ?? { b: { cls, yesUsd: 0, noUsd: 0, fills: 0, wallets: 0 }, w: new Set<string>() };
      by.set(cls, e);
      if (yesBet(t)) e.b.yesUsd += usd;
      else e.b.noUsd += usd;
      e.b.fills++;
      e.w.add(t.wallet);
      total += usd;
      if (cls !== 'UNKNOWN') known += usd;
    }
    const buckets = FLOW_CLASSES.flatMap((cls) => {
      const e = by.get(cls);
      return e ? [{ ...e.b, wallets: e.w.size }] : [];
    });
    return { secs, buckets, totalUsd: total, coverage: total > 0 ? known / total : 0 };
  });
  return { windows, fills: trades.length, profiled: new Set([...classOf.keys()]).size };
}

const usd = (x: number): string => {
  const a = Math.abs(x);
  const s = a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(a / 1e3).toFixed(1)}k` : `${Math.round(a)}`;
  return `${x < 0 ? '-' : ''}$${s}`;
};

/** Lines for the Holders tab: one per class for the 24h window, with the 1h net beside it, then the coverage caveat. */
export function formatClassFlow(f: ClassFlow, yesLabel: string, noLabel: string): string[] {
  const day = f.windows[2];
  const hour = f.windows[0];
  if (!day || day.totalUsd <= 0) return ['no fills in the last 24h'];
  const out = [`FLOW BY WHO, last 24h (1h net in brackets)  net = ${yesLabel} minus ${noLabel}`];
  for (const b of day.buckets) {
    const net = b.yesUsd - b.noUsd;
    const h = hour.buckets.find((x) => x.cls === b.cls);
    const hn = h ? h.yesUsd - h.noUsd : 0;
    out.push(`${b.cls.padEnd(8)} ${yesLabel} ${usd(b.yesUsd).padStart(8)}  ${noLabel} ${usd(b.noUsd).padStart(8)}  net ${(net >= 0 ? '+' : '') + usd(net)}`.padEnd(54) + `[${hn >= 0 ? '+' : ''}${usd(hn)}]  ${b.wallets} wallet(s), ${b.fills} fills`);
  }
  out.push(`${Math.round(day.coverage * 100)}% of the money is from wallets that were profiled; UNKNOWN is the rest. Market makers trade both sides, so their net says little.`);
  return out;
}
