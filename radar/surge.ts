import { DEFAULT_EXCLUDE, takerTrades } from './newmarkets.ts';
import type { PolymarketClient } from './polymarket.ts';
import type { TradeRow } from './store.ts';

/**
 * Surge detector: young markets, and quiet markets, whose last hour of taker flow is far above their own usual hourly
 * volume, optionally lopsided to one outcome, done by a few wallets, or by wallets not seen earlier in the market.
 *
 * Everything here describes trading behavior. A flag is a lead to read, not a signal and not a recommendation:
 * a surge alone says nothing about who traded or why, and whether surges carry information is what
 * scripts/surge-study.py tests (docs/research/radar/SURGE_STUDY.md).
 *
 * Flow is read from TAKER fills only (each fill counted once, from the aggressor's side), as the backtest does.
 */

// ---- FROZEN thresholds: mirror the pre-registered backtest (scripts/surge-study.py). Change them only there-and-here together. ----
export const SURGE_THRESHOLDS = {
  /** Trailing window that is tested for a surge. */
  windowSecs: 3600,
  /** (a) Trailing-hour USD volume >= this multiple of the market's own median hourly volume ... */
  volRatio: 8,
  /** ... and at least this many dollars. Below this floor no other flag is evaluated either. */
  minUsd: 2000,
  /** (b) Share of the hour's BUY dollars on a single outcome. */
  oneSided: 0.75,
  /** (c) Share of the hour's dollars done by the three busiest wallets. */
  top3: 0.5,
  /** (d) Share of the hour's dollars from wallets whose first fill in the available data falls inside the hour. */
  fresh: 0.5,
  /** Market younger than this counts as young. */
  youngDays: 7,
} as const;

/** Baseline is bounded so one call stays cheap: at most this many hours before the trailing hour. */
export const MAX_BASELINE_HOURS = 30 * 24;

export type SurgeFlag = 'volume_surge' | 'one_sided' | 'concentrated' | 'fresh_wallets' | 'young_market';

/** Plain behavior wording for each flag; safe to show to a user. */
export const SURGE_FLAG_TEXT: Record<SurgeFlag, string> = {
  volume_surge: `last-hour volume at least ${SURGE_THRESHOLDS.volRatio}x this market's median hour and at least $${SURGE_THRESHOLDS.minUsd}`,
  one_sided: `at least ${SURGE_THRESHOLDS.oneSided * 100}% of last-hour buying on one outcome`,
  concentrated: `three wallets did at least ${SURGE_THRESHOLDS.top3 * 100}% of last-hour volume`,
  fresh_wallets: `at least ${SURGE_THRESHOLDS.fresh * 100}% of last-hour volume from wallets with no earlier fill in this market`,
  young_market: `market created less than ${SURGE_THRESHOLDS.youngDays} days ago`,
};

export const SURGE_CAVEAT = 'Flags describe trading behavior only. They are leads to read, not signals; a surge alone is not a recommendation.';

export interface SurgeMarket {
  /** Creation time, epoch seconds; null when unknown. */
  createdAt: number | null;
  /** False when the trades passed in do not reach back to the market's first fill (baseline and freshness then only cover what was fetched). Default true. */
  historyComplete?: boolean;
}

export interface SurgeMetrics {
  /** Days since creation; null when unknown. */
  ageDays: number | null;
  young: boolean;
  /** Trailing-hour taker dollars, fills and distinct wallets. */
  usd1h: number;
  fills1h: number;
  wallets1h: number;
  /** Median USD volume of the full hours before the trailing hour (zero hours included), and how many hours that is. */
  medianHourUsd: number;
  baselineHours: number;
  /** usd1h / medianHourUsd; null when the median is 0 (any volume is then "infinitely" above it). */
  volRatio: number | null;
  /** BUY dollars in the hour, the largest single-outcome share of them, and that outcome (the surge direction). */
  buyUsd1h: number;
  oneSidedShare: number;
  dirIdx: number | null;
  /** Share of the hour's dollars from the three busiest wallets. */
  top3Share: number;
  /** Share of the hour's dollars from wallets whose first fill in the available data is inside the hour. */
  freshShare: number;
  /** Outcome-0 price of the last fill now and at the start of the hour (last fill before it, else first fill inside it). */
  priceNow: number | null;
  price1hAgo: number | null;
  /** priceNow - price1hAgo, outcome-0 terms; dirJump is the same move in the surge direction's terms. */
  priceJump: number | null;
  dirJump: number | null;
  historyComplete: boolean;
}

export interface SurgeScore {
  /** 0 unless the volume surge flag trips; otherwise 2 + 1 per other flag + up to 1 for how far volume is above the bar. */
  score: number;
  flags: SurgeFlag[];
  metrics: SurgeMetrics;
}

const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;
const outcome0Price = (t: TradeRow): number => (t.outcomeIndex === 0 ? t.price : 1 - t.price);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Pure: surge score, flags and metrics for one market from its taker fills (any order) and creation time, as of `nowSecs`. */
export function scoreSurge(trades: readonly TradeRow[], market: SurgeMarket, nowSecs: number): SurgeScore {
  const T = SURGE_THRESHOLDS;
  const historyComplete = market.historyComplete ?? true;
  const sorted = trades.filter((t) => t.ts <= nowSecs).sort((a, b) => a.ts - b.ts);
  const start = nowSecs - T.windowSecs;
  const hour = sorted.filter((t) => t.ts > start);
  const before = sorted.filter((t) => t.ts <= start);

  const ageDays = market.createdAt === null ? null : Math.max(0, (nowSecs - market.createdAt) / 86_400);
  const young = ageDays !== null && ageDays < T.youngDays;

  // baseline: full hours [start - (i+1)h, start - i·h) back to the oldest fill fetched
  const hours: number[] = [];
  if (before.length) {
    const n = Math.min(MAX_BASELINE_HOURS, Math.ceil((start - before[0].ts + 1) / T.windowSecs));
    for (let i = 0; i < n; i++) hours.push(0);
    for (const t of before) {
      const i = Math.floor((start - t.ts) / T.windowSecs);
      if (i < n) hours[i] += t.size * t.price;
    }
  }
  const medianHourUsd = median(hours);

  let usd1h = 0;
  let buyUsd1h = 0;
  const buyBy = new Map<number, number>();
  const byWallet = new Map<string, number>();
  for (const t of hour) {
    const u = t.size * t.price;
    usd1h += u;
    byWallet.set(t.wallet, (byWallet.get(t.wallet) ?? 0) + u);
    if (t.side === 'BUY') {
      buyUsd1h += u;
      buyBy.set(t.outcomeIndex, (buyBy.get(t.outcomeIndex) ?? 0) + u);
    }
  }
  let dirIdx: number | null = null;
  let dirUsd = 0;
  for (const [i, u] of [...buyBy.entries()].sort((a, b) => a[0] - b[0])) {
    if (u > dirUsd) [dirIdx, dirUsd] = [i, u];
    else if (u === dirUsd) dirIdx = null; // a tie has no direction
  }
  const seenBefore = new Set(before.map((t) => t.wallet));
  const freshUsd = [...byWallet.entries()].filter(([w]) => !seenBefore.has(w)).reduce((a, [, u]) => a + u, 0);
  const top3Usd = [...byWallet.values()].sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
  const share = (x: number): number => (usd1h > 0 ? r4(x / usd1h) : 0);

  const priceNow = sorted.length ? outcome0Price(sorted[sorted.length - 1]) : null;
  const price1hAgo = before.length ? outcome0Price(before[before.length - 1]) : hour.length ? outcome0Price(hour[0]) : null;
  const priceJump = priceNow !== null && price1hAgo !== null ? r4(priceNow - price1hAgo) : null;

  const metrics: SurgeMetrics = {
    ageDays: ageDays === null ? null : r4(ageDays),
    young,
    usd1h: r4(usd1h),
    fills1h: hour.length,
    wallets1h: byWallet.size,
    medianHourUsd: r4(medianHourUsd),
    baselineHours: hours.length,
    volRatio: medianHourUsd > 0 ? r4(usd1h / medianHourUsd) : null,
    buyUsd1h: r4(buyUsd1h),
    oneSidedShare: buyUsd1h > 0 ? r4(dirUsd / buyUsd1h) : 0,
    dirIdx,
    top3Share: share(top3Usd),
    freshShare: share(freshUsd),
    priceNow: priceNow === null ? null : r4(priceNow),
    price1hAgo: price1hAgo === null ? null : r4(price1hAgo),
    priceJump,
    dirJump: priceJump === null || dirIdx === null ? null : dirIdx === 0 ? priceJump : r4(-priceJump),
    historyComplete,
  };

  const flags: SurgeFlag[] = [];
  // with truncated history and no fill before the hour there is no baseline at all: nothing about "unusual" can be said
  const judgeable = historyComplete || before.length > 0;
  if (usd1h >= T.minUsd && judgeable) {
    if (medianHourUsd === 0 || usd1h >= T.volRatio * medianHourUsd) flags.push('volume_surge');
    if (dirIdx !== null && metrics.oneSidedShare >= T.oneSided) flags.push('one_sided');
    if (metrics.top3Share >= T.top3) flags.push('concentrated');
    if (metrics.freshShare >= T.fresh) flags.push('fresh_wallets');
  }
  if (young) flags.push('young_market');

  let score = 0;
  if (flags.includes('volume_surge')) {
    const ratio = metrics.volRatio ?? Infinity;
    score = 2 + (flags.length - 1) + r4(Math.min(1, Math.log2(ratio / T.volRatio) / 4));
  }
  return { score: r4(score), flags, metrics };
}

// ---- live scan ----

export interface SurgeScanOptions {
  /** Newest-created open markets to consider (default 100). */
  newest?: number;
  /** Gamma volume_num_min prefilter for the newest list (default 1000). */
  minVolume?: number;
  /** Busiest events by 24h volume to read; their markets are ranked by 24h volume (default 50 events, 60 markets). */
  moverEvents?: number;
  movers?: number;
  /** Taker trade pages (1000 fills) per market (default 3). The client itself paces every request. */
  maxPages?: number;
  exclude?: RegExp | null;
  /** Read the surge-direction book of flagged markets for the best ask (default true). */
  books?: boolean;
  now?: () => number; // epoch ms
  onProgress?: (stage: string) => void;
}

export interface SurgeRow {
  cid: string;
  slug: string;
  eventSlug: string;
  title: string;
  outcomes: string[];
  tokenIds: string[];
  /** Where the candidate came from. */
  source: 'new' | 'mover';
  score: number;
  flags: SurgeFlag[];
  metrics: SurgeMetrics;
  /** Surge-direction outcome (most last-hour buying) and its name. */
  dirIdx: number | null;
  dirOutcome: string | null;
  /** Best ask a follower would pay now for the surge-direction outcome, and dollars resting at it; null when not read or empty. */
  bestAsk: number | null;
  askUsd: number | null;
}

export interface SurgeScanResult {
  at: number; // epoch ms
  candidates: number; // distinct markets considered
  scanned: number; // trades read
  skipped: number; // trade fetch failed
  noTrades: number;
  flagged: number;
  /** Flagged markets (volume_surge tripped), highest score first. */
  rows: SurgeRow[];
  errors: string[];
  caveat: string;
}

interface Candidate {
  raw: Record<string, any>;
  eventSlug: string;
  source: SurgeRow['source'];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const arr = (v: unknown): string[] => {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(a) ? a.map((x) => String(x).trim()) : [];
  } catch {
    return [];
  }
};
const isoSecs = (v: unknown): number | null => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
};

/** Ranking used by scanSurges: score, then last-hour dollars. */
export function rankSurges<T extends { score: number; metrics: { usd1h: number } }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.score - a.score || b.metrics.usd1h - a.metrics.usd1h);
}

/** Candidates = newest created markets plus the busiest 24h markets; read recent taker fills of each; return flagged ones ranked. A failing market is skipped and noted. */
export async function scanSurges(client: PolymarketClient, opts: SurgeScanOptions = {}): Promise<SurgeScanResult> {
  const now = opts.now ?? Date.now;
  const res: SurgeScanResult = { at: now(), candidates: 0, scanned: 0, skipped: 0, noTrades: 0, flagged: 0, rows: [], errors: [], caveat: SURGE_CAVEAT };
  const exclude = opts.exclude === undefined ? DEFAULT_EXCLUDE : opts.exclude;
  const progress = opts.onProgress ?? (() => undefined);
  const seen = new Map<string, Candidate>();
  const add = (raw: Record<string, any>, eventSlug: string, source: Candidate['source']): void => {
    const cid = String(raw.conditionId ?? '');
    if (!cid || raw.closed === true || seen.has(cid) || (exclude && exclude.test(String(raw.slug ?? '')))) return;
    seen.set(cid, { raw, eventSlug, source });
  };

  progress('reading newest markets');
  const newest = opts.newest ?? 100;
  for (let offset = 0; offset < newest; offset += 100) {
    try {
      const rows = await client.newMarketsRaw({ offset, limit: Math.min(100, newest - offset), minVolume: opts.minVolume ?? 1000 });
      for (const r of rows) add(r, String((Array.isArray(r.events) && r.events[0]?.slug) || r.slug || ''), 'new');
      if (rows.length < Math.min(100, newest - offset)) break;
    } catch (e) {
      res.errors.push(`newest markets ${offset}+: ${msg(e)}`);
      break;
    }
  }

  progress('reading busiest events');
  try {
    const events = await client.activeEventsRaw(0, opts.moverEvents ?? 50);
    const ms = events.flatMap((ev) => ((ev.markets ?? []) as Array<Record<string, any>>).map((m) => ({ m, slug: String(ev.slug ?? '') })));
    ms.sort((a, b) => Number(b.m.volume24hr ?? 0) - Number(a.m.volume24hr ?? 0));
    let taken = 0;
    for (const { m, slug } of ms) {
      if (taken >= (opts.movers ?? 60)) break;
      const before = seen.size;
      add(m, slug, 'mover');
      if (seen.size > before) taken++;
    }
  } catch (e) {
    res.errors.push(`busiest events: ${msg(e)}`);
  }
  res.candidates = seen.size;

  let i = 0;
  for (const [cid, c] of seen) {
    progress(`reading trades ${++i}/${seen.size}`);
    let fetched: { trades: TradeRow[]; complete: boolean };
    try {
      fetched = await takerTrades(client, cid, opts.maxPages ?? 3);
    } catch (e) {
      res.skipped++;
      res.errors.push(`${cid}: ${msg(e)}`);
      continue;
    }
    res.scanned++;
    if (!fetched.trades.length) {
      res.noTrades++;
      continue;
    }
    const nowSecs = Math.floor(now() / 1000);
    const s = scoreSurge(fetched.trades, { createdAt: isoSecs(c.raw.createdAt), historyComplete: fetched.complete }, nowSecs);
    if (!s.flags.includes('volume_surge')) continue;
    const outcomes = arr(c.raw.outcomes);
    const tokenIds = arr(c.raw.clobTokenIds);
    const dirIdx = s.metrics.dirIdx;
    const row: SurgeRow = {
      cid, slug: String(c.raw.slug ?? ''), eventSlug: c.eventSlug, title: String(c.raw.question ?? c.raw.slug ?? ''), outcomes, tokenIds, source: c.source,
      score: s.score, flags: s.flags, metrics: s.metrics, dirIdx, dirOutcome: dirIdx === null ? null : outcomes[dirIdx] ?? null, bestAsk: null, askUsd: null,
    };
    const token = dirIdx === null ? undefined : tokenIds[dirIdx];
    if (token && opts.books !== false) {
      try {
        const ask = (await client.book(token)).asks[0];
        if (ask) [row.bestAsk, row.askUsd] = [ask.price, r4(ask.price * ask.size)];
      } catch (e) {
        res.errors.push(`${cid} book: ${msg(e)}`);
      }
    }
    res.rows.push(row);
  }
  res.rows = rankSurges(res.rows);
  res.flagged = res.rows.length;
  progress('done');
  return res;
}
