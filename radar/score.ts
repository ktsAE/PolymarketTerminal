import { INFORMATIVE_BAND, oppositeShare, peakPositions, type Position } from './features.ts';
import type { MarketRow, TradeRow } from './store.ts';

/**
 * v0 indicator score. This is NOT a validated detector: it names observable things worth a
 * human's attention and explains each one. With a base rate near 0.03% of matches (Sportradar 2025),
 * even a 1%-false-positive rule is ~97% wrong, so the output is a ranked "look here" list with
 * reasons, never an accusation.
 */
export const SCORE_VERSION = 'v0.1-indicators';

export interface WalletProfile {
  firstSeen: number | null; // epoch seconds
  traded: number | null;
  bigPositions: number | null;
  skillZ: number | null;
}

export interface ScoreInput {
  market: MarketRow;
  trades: readonly TradeRow[];
  wallets: ReadonlyMap<string, WalletProfile>;
  /** Volume baseline for markets of the same type (used for thin side markets). */
  baseline?: { n: number; median: number; p90: number };
}

export type Level = 'NONE' | 'WATCH' | 'ELEVATED';
export interface Reason {
  code: string;
  points: number;
  text: string;
  /** Set when the reason is about one wallet, so context can be netted against it. */
  wallet?: string;
}
export interface ScoreResult {
  version: string;
  score: number;
  level: Level;
  reasons: Reason[];
  /** Things the score could not look at because the data was missing. */
  gaps: string[];
}

export const T = {
  whaleMinUsd: 10_000,
  whaleMarketShare: 0.1,
  dominantMarketShare: 0.3,
  liveShareMin: 0.5,
  underdogVwap: 0.45,
  freshWalletDays: 14,
  freshWalletMaxMarkets: 5,
  freshWalletMinUsd: 2_000,
  clusterMinWallets: 3,
  clusterMinUsd: 1_000,
  clusterWindowDays: 7,
  frequentBettorMarkets: 200,
  frequentBettorBig: 50,
  twoSidedShare: 0.25,
  sideMarketMinUsd: 1_000,
  sideMarketBaselineMultiple: 5,
  watch: 25,
  elevated: 50,
} as const;

const SIDE_MARKET = /handicap|over_under|totals/;
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const days = (secs: number) => secs / 86_400;

export function scoreMarket(input: ScoreInput): ScoreResult {
  const { market, trades, wallets } = input;
  const reasons: Reason[] = [];
  const gaps: string[] = [];
  const add = (code: string, points: number, text: string, wallet?: string) => reasons.push({ code, points, text, wallet });
  const positions = peakPositions(trades, market.gameStart, INFORMATIVE_BAND);
  const sizeFloor = Math.max(T.whaleMinUsd, T.whaleMarketShare * market.volume);
  const flagged = new Set<string>();

  // R1/R2: a single wallet carrying a large share of the market, built mostly in play
  const whales = positions.filter((p) => p.peakCost >= sizeFloor && (p.liveShare ?? 0) >= T.liveShareMin);
  for (const p of whales.slice(0, 2)) {
    flagged.add(p.wallet);
    const outcome = market.outcomes[p.outcomeIndex] ?? `#${p.outcomeIndex}`;
    add('whale_in_play', 25, `${short(p.wallet)} held up to ${usd(p.peakCost)} on ${outcome}, ${Math.round((p.liveShare ?? 0) * 100)}% built after the start (${Math.round((100 * p.peakCost) / Math.max(market.volume, 1))}% of market volume)`, p.wallet);
    if (market.volume > 0 && p.peakCost >= T.dominantMarketShare * market.volume) add('dominant_position', 10, `${short(p.wallet)} alone is >=${Math.round(T.dominantMarketShare * 100)}% of the market's volume`, p.wallet);
    if (p.vwap < T.underdogVwap) add('underdog_conviction', 10, `${short(p.wallet)} paid an average ${p.vwap.toFixed(2)} (backing the underdog)`, p.wallet);
  }

  // R3: fresh, thin-history wallet with real money in
  for (const p of positions) {
    if (p.peakCost < T.freshWalletMinUsd) continue;
    const w = wallets.get(p.wallet);
    if (!w) {
      if (p.peakCost >= sizeFloor) gaps.push(`no profile for ${short(p.wallet)} (${usd(p.peakCost)})`);
      continue;
    }
    const ageDays = w.firstSeen !== null ? days(p.firstTs - w.firstSeen) : null;
    if (ageDays !== null && ageDays <= T.freshWalletDays && (w.traded ?? Infinity) <= T.freshWalletMaxMarkets) {
      flagged.add(p.wallet);
      add('fresh_wallet', 25, `${short(p.wallet)} is ${Math.max(0, ageDays).toFixed(1)} days old with ${w.traded} market(s) traded and put ${usd(p.peakCost)} here`, p.wallet);
    }
  }

  // R4: several young wallets on the same outcome
  const youngByOutcome = new Map<number, Position[]>();
  for (const p of positions) {
    const w = wallets.get(p.wallet);
    if (!w || w.firstSeen === null || p.peakCost < T.clusterMinUsd) continue;
    if (days(p.firstTs - w.firstSeen) > T.clusterWindowDays) continue;
    const list = youngByOutcome.get(p.outcomeIndex) ?? [];
    list.push(p);
    youngByOutcome.set(p.outcomeIndex, list);
  }
  for (const [idx, list] of youngByOutcome) {
    if (list.length >= T.clusterMinWallets)
      add('young_wallet_cluster', 25, `${list.length} wallets under ${T.clusterWindowDays} days old each put >=${usd(T.clusterMinUsd)} on ${market.outcomes[idx] ?? `#${idx}`} (total ${usd(list.reduce((s, p) => s + p.peakCost, 0))}); funding links not checked`);
  }

  // R5: money in a side market that is normally empty
  if (market.marketType && SIDE_MARKET.test(market.marketType)) {
    const b = input.baseline;
    if (!b || b.n < 20) gaps.push(`no volume baseline for ${market.marketType}`);
    else if (market.volume >= Math.max(T.sideMarketMinUsd, T.sideMarketBaselineMultiple * b.p90))
      add('side_market_activity', 20, `${market.marketType} volume ${usd(market.volume)} vs typical p90 ${usd(b.p90)} (n=${b.n})`);
  }

  // Dampeners: context that makes the same activity less surprising (once per wallet)
  const dampened = new Set<string>();
  for (const p of positions) {
    if (!flagged.has(p.wallet) || dampened.has(p.wallet)) continue;
    dampened.add(p.wallet);
    const w = wallets.get(p.wallet);
    if (w && (w.traded ?? 0) >= T.frequentBettorMarkets && (w.bigPositions ?? 0) >= T.frequentBettorBig)
      add('frequent_large_bettor', -15, `${short(p.wallet)} has traded ${w.traded} markets and ${w.bigPositions} large positions: size is normal for them${w.skillZ !== null ? ` (profit-rate z ${w.skillZ.toFixed(1)} vs entry prices)` : ''}`, p.wallet);
    if (oppositeShare(trades, p.wallet, p.outcomeIndex) >= T.twoSidedShare)
      add('two_sided_activity', -15, `${short(p.wallet)} also bought the other side (market-maker / arbitrage pattern)`, p.wallet);
  }

  // Net each wallet's points on its own (context cannot push one wallet below zero or cancel another wallet's flags)
  const perWallet = new Map<string, number>();
  let loose = 0;
  for (const r of reasons) {
    if (r.wallet) perWallet.set(r.wallet, (perWallet.get(r.wallet) ?? 0) + r.points);
    else loose += r.points;
  }
  const raw = loose + [...perWallet.values()].reduce((s, v) => s + Math.max(0, v), 0);
  const score = Math.max(0, Math.min(100, raw));
  const level: Level = score >= T.elevated ? 'ELEVATED' : score >= T.watch ? 'WATCH' : 'NONE';
  return { version: SCORE_VERSION, score, level, reasons, gaps };
}

export function short(wallet: string): string {
  return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
}
