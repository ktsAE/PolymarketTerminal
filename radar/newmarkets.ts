import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FORWARD_DIR, quoteOf, readJsonl, winnerFromPrices } from './forward.ts';
import type { PolymarketClient } from './polymarket.ts';
import type { TradeRow } from './store.ts';

/**
 * New-market watcher: markets created in the last `hours` whose first hour of trading looks unusual
 * (one-sided aggressor flow, one wallet dominating, money from very young accounts, a fast price move).
 * Every flag is a set of plain behavior labels; nothing here says anything about who traded or why.
 *
 * Flow is read from TAKER fills only (data-api v2 taker_only=true): with both sides included every fill
 * appears twice, once per counterparty, and net flow cancels to ~50/50 by construction.
 */

// ---- PRE-REGISTERED defaults ----
// Fixed before any outcome data was looked at. docs/research/radar/NEWMARKETS_STUDY.md may revise them;
// change them only there-and-here together, with the study's reasoning, never to fit the forward log.
export const NEWMARKET_THRESHOLDS = {
  /** Early window: this many seconds from the market's first taker fill. */
  earlySecs: 3600,
  /** Below this early taker volume (USD) or fill count a market scores 0: too little tape to describe. */
  minUsd: 1000,
  minFills: 5,
  /** Aggressor dollars on the leaning side / all aggressor dollars. */
  oneSided: 0.8,
  oneSidedStrong: 0.9,
  /** Single wallet's share of early taker dollars. */
  topWallet: 0.5,
  /** An account younger than this (days since first on-chain activity) counts as new. */
  newAcctDays: 30,
  /** Share of early dollars from new accounts. */
  newAcctShare: 0.3,
  /** Price move (probability units) from first fill to end of the window, toward the leaning side. */
  drift: 0.1,
  /** Largest single fill: both absolute and as a share of early volume. */
  largestUsd: 2500,
  largestShare: 0.25,
  /** Heavy early volume. */
  heavyUsd: 25_000,
  /** Score at or above which a market is flagged and logged. */
  flagScore: 4,
} as const;

const T = NEWMARKET_THRESHOLDS;
export const NEWMARKETS_PATH = join(FORWARD_DIR, 'newmarkets.jsonl');
export const NEWMARKETS_RESULTS_PATH = join(FORWARD_DIR, 'newmarkets-results.jsonl');
/** Recurring crypto candle markets (5m/15m up-or-down) are created by the hundred per hour; skipped by default. */
export const DEFAULT_EXCLUDE = /-updown-|up-or-down/i;

const PAGE = 1000;

export interface EarlyFeatures {
  /** First taker fill (epoch seconds); null when there were none. */
  firstTs: number | null;
  /** Seconds of the early window actually observed (< earlySecs while the market is younger than that). */
  windowSecs: number;
  windowComplete: boolean;
  fills: number;
  usd: number;
  wallets: number;
  topWalletShare: number;
  /** Share of early dollars from wallets known to be < newAcctDays old; null when no ages were supplied. */
  newAcctShare: number | null;
  /** Share of early dollars whose wallet age is known; null when no ages were supplied. */
  ageCoverage: number | null;
  /** Aggressor dollars betting on outcome 0 / outcome 1. */
  yesUsd: number;
  noUsd: number;
  /** max(yesUsd, noUsd) / (yesUsd + noUsd). */
  oneSided: number;
  /** Outcome the aggressor money leaned to (0 or 1); null on a tie or no fills. */
  leanIdx: 0 | 1 | null;
  /** Outcome-0 price of the first and last fill in the window. */
  firstPrice: number | null;
  lastPrice: number | null;
  /** lastPrice - firstPrice, outcome-0 terms. */
  drift: number | null;
  largestUsd: number;
  largestShare: number;
  tradesPerMin: number;
}

const yesBet = (t: TradeRow): boolean => (t.outcomeIndex === 0) === (t.side === 'BUY');
const yesPrice = (t: TradeRow): number => (t.outcomeIndex === 0 ? t.price : 1 - t.price);
const r4 = (x: number): number => Math.round(x * 1e4) / 1e4;

/**
 * Early-window features from one market's taker fills (any order). `ages` maps lowercase wallet -> account age in days
 * (null = looked up, unknown); wallets missing from the map are treated as unknown.
 */
export function earlyFeatures(trades: readonly TradeRow[], nowSecs: number, ages?: ReadonlyMap<string, number | null>, earlySecs: number = T.earlySecs): EarlyFeatures {
  const sorted = [...trades].sort((a, b) => a.ts - b.ts);
  const firstTs = sorted.length ? sorted[0].ts : null;
  const empty: EarlyFeatures = { firstTs, windowSecs: 0, windowComplete: false, fills: 0, usd: 0, wallets: 0, topWalletShare: 0, newAcctShare: ages ? 0 : null, ageCoverage: ages ? 0 : null, yesUsd: 0, noUsd: 0, oneSided: 0, leanIdx: null, firstPrice: null, lastPrice: null, drift: null, largestUsd: 0, largestShare: 0, tradesPerMin: 0 };
  if (firstTs === null) return empty;
  const endTs = firstTs + earlySecs;
  const win = sorted.filter((t) => t.ts <= endTs && t.ts <= nowSecs);
  if (!win.length) return empty;
  const windowSecs = Math.max(0, Math.min(endTs, nowSecs) - firstTs);
  let usd = 0;
  let yes = 0;
  let no = 0;
  let largest = 0;
  const byWallet = new Map<string, number>();
  for (const t of win) {
    const u = t.size * t.price;
    usd += u;
    if (yesBet(t)) yes += u;
    else no += u;
    if (u > largest) largest = u;
    byWallet.set(t.wallet, (byWallet.get(t.wallet) ?? 0) + u);
  }
  let newUsd = 0;
  let knownUsd = 0;
  if (ages)
    for (const [w, u] of byWallet) {
      const a = ages.get(w);
      if (a === undefined || a === null) continue;
      knownUsd += u;
      if (a < T.newAcctDays) newUsd += u;
    }
  const firstPrice = yesPrice(win[0]);
  const lastPrice = yesPrice(win[win.length - 1]);
  const share = (x: number): number => (usd > 0 ? r4(x / usd) : 0);
  return {
    firstTs,
    windowSecs,
    windowComplete: nowSecs >= endTs,
    fills: win.length,
    usd: r4(usd),
    wallets: byWallet.size,
    topWalletShare: share(Math.max(...byWallet.values())),
    newAcctShare: ages ? share(newUsd) : null,
    ageCoverage: ages ? share(knownUsd) : null,
    yesUsd: r4(yes),
    noUsd: r4(no),
    oneSided: yes + no > 0 ? r4(Math.max(yes, no) / (yes + no)) : 0,
    leanIdx: yes > no ? 0 : no > yes ? 1 : null,
    firstPrice: r4(firstPrice),
    lastPrice: r4(lastPrice),
    drift: r4(lastPrice - firstPrice),
    largestUsd: r4(largest),
    largestShare: share(largest),
    tradesPerMin: r4(win.length / Math.max(windowSecs / 60, 1)),
  };
}

const money = (n: number): string => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}k` : `$${Math.round(n)}`);
const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** Points and plain behavior labels for one market's early features. Outcome names default to Yes/No. */
export function scoreFeatures(f: EarlyFeatures, outcomes: readonly string[] = ['Yes', 'No']): { score: number; reasons: string[] } {
  if (f.usd < T.minUsd || f.fills < T.minFills) return { score: 0, reasons: [] };
  const name = (i: number | null): string => (i === null ? '?' : outcomes[i] ?? `outcome ${i}`);
  let score = 0;
  const reasons: string[] = [];
  if (f.oneSided >= T.oneSided && f.leanIdx !== null) {
    score += f.oneSided >= T.oneSidedStrong ? 3 : 2;
    reasons.push(`one-sided flow ${pct(f.oneSided)} to ${name(f.leanIdx)}`);
  }
  if (f.topWalletShare >= T.topWallet) {
    score += 2;
    reasons.push(`top wallet ${pct(f.topWalletShare)} of volume`);
  }
  if (f.newAcctShare !== null && f.newAcctShare >= T.newAcctShare) {
    score += 2;
    reasons.push(`accounts under ${T.newAcctDays}d old ${pct(f.newAcctShare)} of volume`);
  }
  if (f.drift !== null && Math.abs(f.drift) >= T.drift) {
    const toward = f.drift > 0 ? 0 : 1;
    // a move with the flow is the pattern of interest; a move against it is reported but scores nothing
    if (f.leanIdx === null || f.leanIdx === toward) score += 1;
    reasons.push(`price drift ${Math.round(Math.abs(f.drift) * 100)} pts toward ${name(toward)}`);
  }
  if (f.largestUsd >= T.largestUsd && f.largestShare >= T.largestShare) {
    score += 1;
    reasons.push(`largest print ${money(f.largestUsd)} (${pct(f.largestShare)} of volume)`);
  }
  if (f.usd >= T.heavyUsd) {
    score += 1;
    reasons.push(`${money(f.usd)} in first hour`);
  }
  return { score, reasons };
}

// ---- forward log schema ----

export interface NewMarketLine {
  v: 1;
  cid: string;
  slug: string;
  eventSlug: string;
  title: string;
  outcomes: string[];
  createdAt: number; // epoch seconds
  capturedAt: number;
  /** floor(capturedAt / 3600): one line per cid per hour bucket. */
  bucket: number;
  features: EarlyFeatures;
  score: number;
  reasons: string[];
  leanIdx: 0 | 1 | null;
  leaning: string | null;
  /** Live book of the leaning outcome's token at capture; null when not read or one-sided. */
  bid: number | null;
  ask: number | null;
  mid: number | null;
}

export type ResultKind = '+1h' | '+6h' | '+24h' | 'resolution';
export const HORIZONS: ReadonlyArray<{ kind: Exclude<ResultKind, 'resolution'>; secs: number }> = [
  { kind: '+1h', secs: 3600 },
  { kind: '+6h', secs: 6 * 3600 },
  { kind: '+24h', secs: 24 * 3600 },
];

export interface NewMarketResult {
  cid: string;
  bucket: number;
  kind: ResultKind;
  /** When this line was written (epoch seconds). */
  at: number;
  /** Horizons: leaning-outcome price of the last taker fill at or before capturedAt + horizon; null if none. */
  price?: number | null;
  /** Resolution: winning outcome index (null = void split) and final payouts. */
  winnerIdx?: number | null;
  payout?: number[];
}

export const logKey = (cid: string, bucket: number): string => `${cid}|${bucket}`;
const resultKey = (cid: string, bucket: number, kind: string): string => `${cid}|${bucket}|${kind}`;

function appendLine(path: string, line: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + '\n');
}

/** Appends flagged lines, one per cid+hour bucket ever (against the file and within the batch). */
export function logFlagged(lines: readonly NewMarketLine[], path: string = NEWMARKETS_PATH): { written: number; duplicates: number } {
  const seen = new Set<string>();
  for (const l of readJsonl(path)) if (typeof l.cid === 'string' && typeof l.bucket === 'number') seen.add(logKey(l.cid, l.bucket));
  let written = 0;
  let duplicates = 0;
  for (const l of lines) {
    const k = logKey(l.cid, l.bucket);
    if (seen.has(k)) {
      duplicates++;
      continue;
    }
    seen.add(k);
    appendLine(path, l);
    written++;
  }
  return { written, duplicates };
}

// ---- scanner ----

export interface ScanOptions {
  /** Markets created within this many hours (default 24). */
  hours?: number;
  /** Gamma volume_num_min prefilter in USD (default 1000; gamma counts both sides of each fill). */
  minVolume?: number;
  /** Most markets to fetch trades for, busiest first (default 150). */
  maxMarkets?: number;
  /** Hard cap on wallet-age lookups per scan (default 80) and per market (default 8, biggest early wallets first). */
  maxAgeLookups?: number;
  ageLookupsPerMarket?: number;
  /** wallet -> first-activity epoch seconds (null = no activity found). Defaults to a process-wide cache. */
  ageCache?: Map<string, number | null>;
  /** Trade pages (1000 fills) per market before giving up as too busy (default 10). */
  maxPages?: number;
  exclude?: RegExp | null;
  /** Read the leaning token's book for flagged markets (default true). */
  books?: boolean;
  now?: () => number; // epoch ms
}

export interface ScanRow {
  cid: string;
  slug: string;
  eventSlug: string;
  title: string;
  outcomes: string[];
  tokenIds: string[];
  createdAt: number;
  features: EarlyFeatures;
  score: number;
  reasons: string[];
  flagged: boolean;
}

export interface ScanSummary {
  listed: number; // markets returned by gamma within the window
  excluded: number;
  considered: number; // after exclude + maxMarkets
  scanned: number;
  noTrades: number;
  skipped: number; // trade fetch failed
  truncated: number; // more fills than maxPages allows: early window not reachable
  ageLookups: number;
  flagged: number;
  rows: ScanRow[];
  lines: NewMarketLine[];
  errors: string[];
}

const DEFAULT_AGE_CACHE = new Map<string, number | null>();
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
const tradeKey = (t: TradeRow): string => [t.tx ?? '', t.wallet, t.side, t.outcomeIndex, t.price, t.size, t.ts].join('|');

/** All taker fills of a market, newest first, following the v2 cursor up to `maxPages` pages. complete=false when the oldest fill was not reached. */
export async function takerTrades(client: PolymarketClient, cid: string, maxPages = 10): Promise<{ trades: TradeRow[]; complete: boolean }> {
  const out = new Map<string, TradeRow>();
  let cursor: string | undefined;
  for (let pages = 0; pages < maxPages; pages++) {
    const { rows, next } = await client.tradesCursor(cid, { cursor, limit: PAGE, takerOnly: true });
    for (const t of rows) out.set(tradeKey(t), t);
    if (!next) return { trades: [...out.values()], complete: true };
    cursor = next;
  }
  return { trades: [...out.values()], complete: false };
}

export async function scanNewMarkets(client: PolymarketClient, opts: ScanOptions = {}): Promise<ScanSummary> {
  const nowMs = (opts.now ?? Date.now)();
  const nowSecs = Math.floor(nowMs / 1000);
  const cutoff = nowSecs - (opts.hours ?? 24) * 3600;
  const cache = opts.ageCache ?? DEFAULT_AGE_CACHE;
  const lookupCap = opts.maxAgeLookups ?? 80;
  const perMarket = opts.ageLookupsPerMarket ?? 8;
  const exclude = opts.exclude === undefined ? DEFAULT_EXCLUDE : opts.exclude;
  const sum: ScanSummary = { listed: 0, excluded: 0, considered: 0, scanned: 0, noTrades: 0, skipped: 0, truncated: 0, ageLookups: 0, flagged: 0, rows: [], lines: [], errors: [] };

  const found: Array<Record<string, any>> = [];
  for (let page = 0; page < 20; page++) {
    let rows: Array<Record<string, any>>;
    try {
      rows = await client.newMarketsRaw({ offset: page * 100, limit: 100, minVolume: opts.minVolume ?? 1000 });
    } catch (e) {
      sum.errors.push(`gamma page ${page}: ${msg(e)}`);
      break;
    }
    let older = false;
    for (const r of rows) {
      const c = isoSecs(r.createdAt);
      if (c === null || c < cutoff) {
        older = true;
        continue;
      }
      found.push(r);
    }
    if (older || rows.length < 100) break;
  }
  sum.listed = found.length;
  const kept = found.filter((r) => !(exclude && exclude.test(String(r.slug ?? ''))));
  sum.excluded = found.length - kept.length;
  const picked = kept.sort((a, b) => Number(b.volumeNum ?? b.volume ?? 0) - Number(a.volumeNum ?? a.volume ?? 0)).slice(0, opts.maxMarkets ?? 150);
  sum.considered = picked.length;

  for (const r of picked) {
    const cid = String(r.conditionId ?? '');
    if (!cid) continue;
    let fetched: { trades: TradeRow[]; complete: boolean };
    try {
      fetched = await takerTrades(client, cid, opts.maxPages ?? 10);
    } catch (e) {
      sum.skipped++;
      sum.errors.push(`${cid}: ${msg(e)}`);
      continue;
    }
    if (!fetched.complete) {
      sum.truncated++;
      continue;
    }
    sum.scanned++;
    if (!fetched.trades.length) {
      sum.noTrades++;
      continue;
    }
    // ages for the biggest early wallets, within the per-scan and per-market caps
    const plain = earlyFeatures(fetched.trades, nowSecs);
    const endTs = (plain.firstTs ?? 0) + T.earlySecs;
    const byWallet = new Map<string, number>();
    for (const t of fetched.trades) if (t.ts <= endTs) byWallet.set(t.wallet, (byWallet.get(t.wallet) ?? 0) + t.size * t.price);
    const top = [...byWallet.entries()].sort((a, b) => b[1] - a[1]).slice(0, perMarket).map(([w]) => w);
    for (const w of top) {
      if (cache.has(w) || sum.ageLookups >= lookupCap) continue;
      sum.ageLookups++;
      try {
        cache.set(w, await client.firstActivityTs(w));
      } catch {
        /* unknown age; not cached so a later scan can retry */
      }
    }
    const ages = new Map<string, number | null>();
    for (const w of byWallet.keys()) if (cache.has(w)) {
      const first = cache.get(w) ?? null;
      ages.set(w, first === null ? null : (nowSecs - first) / 86400);
    }
    const features = earlyFeatures(fetched.trades, nowSecs, ages);
    const outcomes = arr(r.outcomes);
    const { score, reasons } = scoreFeatures(features, outcomes.length ? outcomes : undefined);
    const ev = Array.isArray(r.events) && r.events[0] ? r.events[0] : {};
    const row: ScanRow = { cid, slug: String(r.slug ?? ''), eventSlug: String(ev.slug ?? r.slug ?? ''), title: String(r.question ?? ''), outcomes, tokenIds: arr(r.clobTokenIds), createdAt: isoSecs(r.createdAt) ?? 0, features, score, reasons, flagged: score >= T.flagScore };
    sum.rows.push(row);
    if (!row.flagged) continue;
    sum.flagged++;
    let quote: { bid: number; ask: number; mid: number } | null = null;
    const token = features.leanIdx !== null ? row.tokenIds[features.leanIdx] : undefined;
    if (token && opts.books !== false) {
      try {
        quote = quoteOf('', await client.book(token));
      } catch (e) {
        sum.errors.push(`${cid} book: ${msg(e)}`);
      }
    }
    const capturedAt = Math.floor((opts.now ?? Date.now)() / 1000);
    sum.lines.push({ v: 1, cid, slug: row.slug, eventSlug: row.eventSlug, title: row.title, outcomes, createdAt: row.createdAt, capturedAt, bucket: Math.floor(capturedAt / 3600), features, score, reasons, leanIdx: features.leanIdx, leaning: features.leanIdx !== null ? outcomes[features.leanIdx] ?? null : null, bid: quote?.bid ?? null, ask: quote?.ask ?? null, mid: quote?.mid ?? null });
  }
  sum.rows.sort((a, b) => b.score - a.score);
  return sum;
}

// ---- scoring the forward log ----

export interface Tally {
  n: number;
  continuation: number;
  reversal: number;
  flat: number;
}

export interface NewMarketScore {
  logged: number;
  written: number;
  errors: string[];
  horizons: Record<Exclude<ResultKind, 'resolution'>, Tally>;
  resolution: Tally & { void: number };
  /** Buying 1 share of the leaning side at the capture ask, held to resolution. */
  roi: { n: number; stake: number; pnl: number; roi: number | null };
}

export interface ScoreLogOptions {
  resultsPath?: string; // default newmarkets-results.jsonl next to the log
  now?: () => number;
}

const tally = (): Tally => ({ n: 0, continuation: 0, reversal: 0, flat: 0 });

/** Summary over log + results lines (pure): continuation vs reversal per horizon and at resolution, and ROI at the capture ask. */
export function summarizeNewMarkets(logLines: ReadonlyArray<Record<string, any>>, results: ReadonlyArray<Record<string, any>>): Omit<NewMarketScore, 'written' | 'errors'> {
  const byKey = new Map<string, Record<string, any>>();
  for (const l of logLines) if (typeof l.cid === 'string' && typeof l.bucket === 'number') byKey.set(logKey(l.cid, l.bucket), l);
  const horizons = { '+1h': tally(), '+6h': tally(), '+24h': tally() } as NewMarketScore['horizons'];
  const resolution = { ...tally(), void: 0 };
  const roi = { n: 0, stake: 0, pnl: 0, roi: null as number | null };
  const done = new Set<string>();
  for (const r of results) {
    if (typeof r.cid !== 'string' || typeof r.bucket !== 'number' || typeof r.kind !== 'string') continue;
    const rk = resultKey(r.cid, r.bucket, r.kind);
    if (done.has(rk)) continue;
    done.add(rk);
    const l = byKey.get(logKey(r.cid, r.bucket));
    if (!l || (l.leanIdx !== 0 && l.leanIdx !== 1)) continue;
    if (r.kind === 'resolution') {
      if (!Array.isArray(r.payout)) continue;
      resolution.n++;
      if (r.winnerIdx === null) resolution.void++;
      else if (r.winnerIdx === l.leanIdx) resolution.continuation++;
      else resolution.reversal++;
      const pay = Number(r.payout[l.leanIdx]);
      if (typeof l.ask === 'number' && l.ask > 0 && Number.isFinite(pay)) {
        roi.n++;
        roi.stake += l.ask;
        roi.pnl += pay - l.ask;
      }
      continue;
    }
    const t = horizons[r.kind as keyof typeof horizons];
    if (!t || typeof r.price !== 'number' || typeof l.mid !== 'number') continue;
    t.n++;
    if (r.price > l.mid) t.continuation++;
    else if (r.price < l.mid) t.reversal++;
    else t.flat++;
  }
  roi.stake = r4(roi.stake);
  roi.pnl = r4(roi.pnl);
  roi.roi = roi.stake > 0 ? r4(roi.pnl / roi.stake) : null;
  return { logged: byKey.size, horizons, resolution, roi };
}

/**
 * Fills in +1h/+6h/+24h leaning-side prices (last taker fill at or before the horizon) and resolution for logged
 * markets, appending each cid+bucket+kind to the results file at most once, then summarizes everything recorded.
 */
export async function scoreNewMarketLog(client: PolymarketClient, path: string = NEWMARKETS_PATH, opts: ScoreLogOptions = {}): Promise<NewMarketScore> {
  const resultsPath = opts.resultsPath ?? join(dirname(path), 'newmarkets-results.jsonl');
  const nowSecs = Math.floor((opts.now ?? Date.now)() / 1000);
  const logLines = readJsonl<Record<string, any>>(path);
  const done = new Set<string>();
  for (const r of readJsonl<Record<string, any>>(resultsPath)) if (typeof r.cid === 'string' && typeof r.bucket === 'number' && typeof r.kind === 'string') done.add(resultKey(r.cid, r.bucket, r.kind));
  const errors: string[] = [];
  let written = 0;
  const write = (line: NewMarketResult): void => {
    const k = resultKey(line.cid, line.bucket, line.kind);
    if (done.has(k)) return;
    done.add(k);
    appendLine(resultsPath, line);
    written++;
  };
  const events = new Map<string, Awaited<ReturnType<PolymarketClient['eventBySlug']>> | null>();
  const seenLog = new Set<string>();
  for (const l of logLines) {
    if (typeof l.cid !== 'string' || typeof l.bucket !== 'number' || typeof l.capturedAt !== 'number' || (l.leanIdx !== 0 && l.leanIdx !== 1)) continue;
    if (seenLog.has(logKey(l.cid, l.bucket))) continue;
    seenLog.add(logKey(l.cid, l.bucket));
    for (const h of HORIZONS) {
      if (done.has(resultKey(l.cid, l.bucket, h.kind)) || nowSecs < l.capturedAt + h.secs) continue;
      try {
        const last = await client.lastTradeAtOrBefore(l.cid, l.capturedAt + h.secs, { takerOnly: true });
        const price = last ? r4(last.outcomeIndex === l.leanIdx ? last.price : 1 - last.price) : null;
        write({ cid: l.cid, bucket: l.bucket, kind: h.kind, at: nowSecs, price });
      } catch (e) {
        errors.push(`${l.cid} ${h.kind}: ${msg(e)}`);
      }
    }
    if (done.has(resultKey(l.cid, l.bucket, 'resolution')) || typeof l.eventSlug !== 'string' || !l.eventSlug) continue;
    try {
      if (!events.has(l.eventSlug)) events.set(l.eventSlug, (await client.eventBySlug(l.eventSlug)) ?? null);
      const m = events.get(l.eventSlug)?.markets.find((x) => x.cid === l.cid);
      if (!m || !m.closed || !m.result) continue;
      const winnerIdx = winnerFromPrices(m.result);
      if (winnerIdx === undefined) continue;
      write({ cid: l.cid, bucket: l.bucket, kind: 'resolution', at: nowSecs, winnerIdx, payout: m.result });
    } catch (e) {
      errors.push(`${l.eventSlug}: ${msg(e)}`);
    }
  }
  return { ...summarizeNewMarkets(logLines, readJsonl(resultsPath)), written, errors };
}
