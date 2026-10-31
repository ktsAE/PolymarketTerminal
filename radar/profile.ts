/**
 * Who is behind a wallet: a person with a view, or automation (bots, market makers, rebate farmers)?
 * Pure functions over a wallet's recent activity plus lifetime totals. Every verdict carries its reasons;
 * it is a screen to find people, not an identification of anyone.
 */

export interface ActivityRec {
  ts: number; // epoch seconds
  type: string; // TRADE, REWARD, MAKER_REBATE, TAKER_REBATE, MERGE, SPLIT, REDEEM, YIELD, ...
  side: string; // BUY / SELL / ''
  usd: number;
  cid: string;
}

export interface ActivitySummary {
  events: number;
  trades: number;
  spanHours: number;
  /** Events per day over the observed window (window floored at one hour so a 1-hour burst does not explode). */
  perDay: number;
  medGapSecs: number | null;
  medUsd: number | null;
  /** Share of multi-trade markets where a BUY and a SELL happened within 10 minutes of each other. */
  flipShare: number;
  distinctMarkets: number;
  rewards: number; // REWARD + MAKER_REBATE + TAKER_REBATE
  mergeSplit: number;
}

export interface Lifetime {
  /** Markets ever traded. */
  traded: number | null;
  /** All-time volume in dollars. */
  vol: number | null;
  /** Days since first activity. */
  ageDays: number | null;
}

export type WalletClass = 'BOT' | 'ALGO' | 'MM' | 'HUMAN' | 'LOW_DATA';
export interface Classification {
  cls: WalletClass;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  /** Points toward automation / liquidity provision, for transparency. */
  autoPoints: number;
  mmPoints: number;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export function summarizeActivity(recs: readonly ActivityRec[]): ActivitySummary {
  const sorted = [...recs].sort((a, b) => a.ts - b.ts);
  const trades = sorted.filter((r) => r.type === 'TRADE');
  const spanHours = sorted.length > 1 ? (sorted[sorted.length - 1].ts - sorted[0].ts) / 3600 : 0;
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].ts - sorted[i - 1].ts);

  const byMarket = new Map<string, ActivityRec[]>();
  for (const t of trades) {
    const list = byMarket.get(t.cid);
    if (list) list.push(t);
    else byMarket.set(t.cid, [t]);
  }
  let multi = 0;
  let flips = 0;
  for (const list of byMarket.values()) {
    if (list.length < 2) continue;
    multi++;
    for (let i = 1; i < list.length; i++) {
      if (list[i].side !== list[i - 1].side && list[i].side && list[i - 1].side && list[i].ts - list[i - 1].ts <= 600) {
        flips++;
        break;
      }
    }
  }
  return {
    events: sorted.length,
    trades: trades.length,
    spanHours,
    perDay: sorted.length / (Math.max(spanHours, 1) / 24),
    medGapSecs: median(gaps),
    medUsd: median(trades.map((t) => t.usd).filter((u) => u > 0)),
    flipShare: multi > 0 ? flips / multi : 0,
    distinctMarkets: byMarket.size,
    rewards: sorted.filter((r) => r.type === 'REWARD' || r.type === 'MAKER_REBATE' || r.type === 'TAKER_REBATE').length,
    mergeSplit: sorted.filter((r) => r.type === 'MERGE' || r.type === 'SPLIT').length,
  };
}

export const P = {
  minEvents: 15,
  hugeBreadth: 5_000,
  manyMarkets: 1_000,
  fewHundred: 300,
  marketsPerDayHigh: 10,
  marketsPerDayMid: 5,
  marketsPerDayLow: 3,
  highCadence: 300,
  midCadence: 100,
  fastGapSecs: 10,
  fastGapMinEvents: 100,
  hugeVolume: 20_000_000,
  mergeSplitMin: 5,
  rewardsMin: 5,
  flipMin: 0.3,
  flipMinTrades: 30,
  smallTradeUsd: 60,
  smallTradeMinTrades: 100,
} as const;

const usd = (n: number): string => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`);

export function classifyWallet(s: ActivitySummary, life: Lifetime): Classification {
  const reasons: string[] = [];
  let auto = 0;
  let mm = 0;

  // Lifetime breadth, judged against how long the account has existed: a patient human can reach 1,000 markets in years, a bot in weeks.
  const perDayMarkets = life.traded !== null && life.ageDays !== null ? life.traded / Math.max(life.ageDays, 1) : null;
  if (life.traded !== null && life.traded >= P.hugeBreadth) {
    auto += 3;
    reasons.push(`${life.traded.toLocaleString('en-US')} markets traded lifetime`);
  } else if (life.traded !== null && life.traded >= P.manyMarkets) {
    auto += 2;
    reasons.push(`${life.traded.toLocaleString('en-US')} markets traded lifetime`);
  }
  if (perDayMarkets !== null && perDayMarkets >= P.marketsPerDayHigh) {
    auto += 3;
    reasons.push(`${perDayMarkets.toFixed(0)} new markets per day of account age`);
  } else if (perDayMarkets !== null && perDayMarkets >= P.marketsPerDayMid) {
    auto += 2;
    reasons.push(`${perDayMarkets.toFixed(1)} new markets per day of account age`);
  } else if (perDayMarkets !== null && perDayMarkets >= P.marketsPerDayLow && life.traded !== null && life.traded >= P.fewHundred) {
    auto += 1;
    reasons.push(`${perDayMarkets.toFixed(1)} new markets per day of account age`);
  }
  if (s.perDay >= P.highCadence) {
    auto += 3;
    reasons.push(`${Math.round(s.perDay).toLocaleString('en-US')} events/day`);
  } else if (s.perDay >= P.midCadence) {
    auto += 2;
    reasons.push(`${Math.round(s.perDay)} events/day`);
  }
  if (s.medGapSecs !== null && s.medGapSecs <= P.fastGapSecs && s.events >= P.fastGapMinEvents) {
    auto += 3;
    reasons.push(`median ${s.medGapSecs}s between events`);
  }
  if (life.vol !== null && life.vol >= P.hugeVolume) {
    auto += 2;
    reasons.push(`${usd(life.vol)} lifetime volume`);
  }
  if (s.mergeSplit >= P.mergeSplitMin) {
    auto += 1;
    reasons.push(`${s.mergeSplit} merge/split operations`);
  }

  if (s.rewards >= P.rewardsMin) {
    mm += 2;
    reasons.push(`${s.rewards} liquidity-reward / rebate payouts`);
  }
  if (s.flipShare >= P.flipMin && s.trades >= P.flipMinTrades) {
    mm += 2;
    reasons.push(`buys and sells the same market within minutes (${Math.round(s.flipShare * 100)}%)`);
  }
  if (s.medUsd !== null && s.medUsd <= P.smallTradeUsd && s.trades >= P.smallTradeMinTrades) {
    mm += 1;
    reasons.push(`median fill only ${usd(s.medUsd)}`);
  }

  const base = { reasons, autoPoints: auto, mmPoints: mm };
  const manyLifetime = life.traded !== null && life.traded >= P.hugeBreadth;
  if (s.events < P.minEvents && !manyLifetime) return { cls: 'LOW_DATA', confidence: 'low', ...base, reasons: [`only ${s.events} recent events`, ...reasons] };
  if (auto >= 3) return { cls: 'BOT', confidence: auto >= 5 ? 'high' : 'medium', ...base };
  if (mm >= 3) return { cls: 'MM', confidence: mm >= 5 ? 'high' : 'medium', ...base };
  if (auto >= 2) return { cls: 'ALGO', confidence: 'low', ...base };
  return { cls: 'HUMAN', confidence: auto === 0 && mm === 0 ? 'medium' : 'low', ...base, reasons: reasons.length ? reasons : ['low cadence, few markets, no reward/rebate payouts'] };
}

/** Wallets worth showing when the user asks for "people, not machines". */
export const isPerson = (c: WalletClass): boolean => c === 'HUMAN' || c === 'LOW_DATA';
