import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseStart, type PolymarketClient } from './polymarket.ts';

/**
 * Forward logger: snapshots upcoming game moneylines at fixed distances before start (T-8h, T-2h, T-5m) and later records who won,
 * so an edge found in backtests can be tested on games that did not exist when it was found. Append-only JSONL; one line per cid+label, ever.
 */

export type WindowLabel = 'T-8h' | 'T-2h' | 'T-5m';

/** Capture windows in seconds before start, inclusive at both ends. */
export const WINDOWS: ReadonlyArray<{ label: WindowLabel; min: number; max: number }> = [
  { label: 'T-8h', min: 6.5 * 3600, max: 9.5 * 3600 },
  { label: 'T-2h', min: 1.5 * 3600, max: 2.5 * 3600 },
  { label: 'T-5m', min: 0, max: 10 * 60 },
];

export const HORIZON_SECS = 12 * 3600;
export const FORWARD_DIR = process.env.RADAR_FORWARD ?? '.radar/forward';
export const SNAPSHOTS_PATH = join(FORWARD_DIR, 'snapshots.jsonl');
export const RESULTS_PATH = join(FORWARD_DIR, 'results.jsonl');

/** Leagues logged by default besides every esports series (gamma tag 64). */
export const DEFAULT_SPORTS = ['nba', 'nfl', 'nhl', 'mlb', 'epl', 'lal', 'bun', 'sea', 'fl1', 'ucl', 'mls'];
const ESPORTS_TAG = '64';

export interface OutcomeQuote {
  outcome: string;
  bid: number;
  ask: number;
  mid: number;
  /** Top-of-book depth in dollars (size x price) on each side. */
  bidUsd: number;
  askUsd: number;
}

export interface HolderTop {
  wallet: string;
  side: string;
  outcomeIndex: number;
  size: number;
}

export interface SnapshotLine {
  v: 1;
  cid: string;
  slug: string;
  title: string;
  event: string;
  sport: string;
  outcomes: string[];
  startTs: number;
  label: WindowLabel;
  capturedAt: number;
  quotes: OutcomeQuote[];
  vol24: number | null;
  /** Top-10 holders by size across outcomes; null when not fetched or the call failed (see holdersAbsent). */
  holders: HolderTop[] | null;
  holdersAbsent: boolean;
}

export interface ResultLine {
  cid: string;
  /** Index into the snapshot's outcomes; null when the market was voided (split payout). */
  winnerIdx: number | null;
  payout: number[];
  settledAt: number;
}

/** A moneyline market found upcoming, before books are read. */
export interface Upcoming {
  cid: string;
  slug: string;
  title: string;
  event: string;
  sport: string;
  outcomes: string[];
  tokenIds: string[];
  startTs: number;
  vol24: number | null;
}

// ---- pure helpers ----

/** Which capture window `secsToStart` falls in, or null (outside every window, or already started). */
export function captureWindow(secsToStart: number): WindowLabel | null {
  if (!Number.isFinite(secsToStart)) return null;
  return WINDOWS.find((w) => secsToStart >= w.min && secsToStart <= w.max)?.label ?? null;
}

export const snapshotKey = (cid: string, label: string): string => `${cid}|${label}`;

/** Parses JSONL, skipping blank, truncated or non-object lines. */
export function parseJsonl<T = Record<string, unknown>>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const v = JSON.parse(s);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as T);
    } catch {
      /* a half-written line from a crash is skipped, not fatal */
    }
  }
  return out;
}

export function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  return existsSync(path) ? parseJsonl<T>(readFileSync(path, 'utf8')) : [];
}

/** cid|label keys already captured. */
export function seenKeys(lines: ReadonlyArray<Record<string, unknown>>): Set<string> {
  const s = new Set<string>();
  for (const l of lines) if (typeof l.cid === 'string' && typeof l.label === 'string') s.add(snapshotKey(l.cid, l.label));
  return s;
}

/** Upcoming markets due for capture now: inside a window and not yet captured for it. */
export function dueCaptures<T extends { cid: string; startTs: number }>(markets: readonly T[], seen: ReadonlySet<string>, nowSecs: number): Array<T & { label: WindowLabel }> {
  const out: Array<T & { label: WindowLabel }> = [];
  const taken = new Set(seen);
  for (const m of markets) {
    const label = captureWindow(m.startTs - nowSecs);
    if (!label || taken.has(snapshotKey(m.cid, label))) continue;
    taken.add(snapshotKey(m.cid, label));
    out.push({ ...m, label });
  }
  return out;
}

/** Moneyline markets of one raw gamma event that start within (now, now+horizon]. */
export function upcomingMoneylines(raw: Record<string, any>, sport: string, nowSecs: number, horizon = HORIZON_SECS): Upcoming[] {
  const arr = (v: unknown): string[] => {
    try {
      const a = typeof v === 'string' ? JSON.parse(v) : v;
      return Array.isArray(a) ? a.map((x) => String(x).trim()) : [];
    } catch {
      return [];
    }
  };
  const out: Upcoming[] = [];
  for (const m of (raw.markets ?? []) as Array<Record<string, any>>) {
    if (m.sportsMarketType !== 'moneyline' || !m.conditionId || m.closed || m.acceptingOrders === false) continue;
    const startTs = parseStart(m.gameStartTime) ?? parseStart(raw.startTime);
    if (startTs === null || startTs <= nowSecs || startTs - nowSecs > horizon) continue;
    const outcomes = arr(m.outcomes);
    const tokenIds = arr(m.clobTokenIds);
    if (outcomes.length < 2 || tokenIds.length !== outcomes.length) continue;
    const v = Number(m.volume24hr);
    out.push({ cid: String(m.conditionId), slug: String(raw.slug ?? ''), title: String(m.question ?? ''), event: String(raw.title ?? ''), sport, outcomes, tokenIds, startTs, vol24: m.volume24hr === null || m.volume24hr === undefined || !Number.isFinite(v) ? null : v });
  }
  return out;
}

/** Quote from the best levels, or null when either side is empty (a one-sided book has no tradable mid). */
export function quoteOf(outcome: string, book: { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> }): OutcomeQuote | null {
  const b = book.bids[0];
  const a = book.asks[0];
  if (!b || !a || b.price <= 0 || a.price >= 1 || a.price < b.price) return null;
  const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
  return { outcome, bid: b.price, ask: a.price, mid: r6((b.price + a.price) / 2), bidUsd: r6(b.price * b.size), askUsd: r6(a.price * a.size) };
}

/** Winning outcome from final prices: index of the 1, null for an even void split, undefined while not final. */
export function winnerFromPrices(prices: readonly number[] | null): number | null | undefined {
  if (!prices || prices.length < 2 || !prices.every(Number.isFinite)) return undefined;
  const max = Math.max(...prices);
  if (max >= 0.99) return prices.indexOf(max);
  if (prices.every((p) => Math.abs(p - prices[0]) < 1e-6)) return null;
  return undefined;
}

/** Snapshot cids that started before now and have no result line yet, grouped by event slug. */
export function unsettled(snaps: ReadonlyArray<Record<string, unknown>>, results: ReadonlyArray<Record<string, unknown>>, nowSecs: number): Map<string, Set<string>> {
  const done = new Set(results.map((r) => r.cid).filter((c): c is string => typeof c === 'string'));
  const bySlug = new Map<string, Set<string>>();
  for (const s of snaps) {
    if (typeof s.cid !== 'string' || typeof s.slug !== 'string' || done.has(s.cid)) continue;
    if (typeof s.startTs === 'number' && s.startTs > nowSecs) continue;
    if (!bySlug.has(s.slug)) bySlug.set(s.slug, new Set());
    bySlug.get(s.slug)!.add(s.cid);
  }
  return bySlug;
}

// ---- I/O ----

function appendLine(path: string, line: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + '\n');
}

export interface SnapshotOptions {
  path?: string;
  /** Sport codes from gamma /sports; default: every esports series plus DEFAULT_SPORTS. */
  sports?: string[];
  holders?: boolean; // default true
  dryRun?: boolean; // read everything, write nothing
  now?: () => number; // epoch ms
  maxPagesPerSeries?: number; // default 5
}

export interface SnapshotSummary {
  series: number;
  events: number;
  upcoming: number;
  due: number;
  written: number;
  skippedOneSided: number;
  holdersAbsent: number;
  lines: SnapshotLine[];
  errors: string[];
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function snapshotUpcoming(client: PolymarketClient, opts: SnapshotOptions = {}): Promise<SnapshotSummary> {
  const path = opts.path ?? SNAPSHOTS_PATH;
  const nowMs = (opts.now ?? Date.now)();
  const nowSecs = Math.floor(nowMs / 1000);
  const sum: SnapshotSummary = { series: 0, events: 0, upcoming: 0, due: 0, written: 0, skippedOneSided: 0, holdersAbsent: 0, lines: [], errors: [] };

  const leagues = await client.sportsList();
  const wanted = opts.sports ? new Set(opts.sports) : null;
  const picked = leagues.filter((l) => (wanted ? wanted.has(l.sport) : l.tags.includes(ESPORTS_TAG) || DEFAULT_SPORTS.includes(l.sport)));
  const seriesSeen = new Set<string>();
  const upcoming = new Map<string, Upcoming>();
  // esports events end ~6h after start, NBA at start: bound by end date generously, filter by game start below
  const endMin = new Date(nowMs).toISOString();
  const endMax = new Date(nowMs + (HORIZON_SECS + 24 * 3600) * 1000).toISOString();
  for (const l of picked) {
    if (seriesSeen.has(l.series)) continue;
    seriesSeen.add(l.series);
    sum.series++;
    try {
      for (let page = 0; page < (opts.maxPagesPerSeries ?? 5); page++) {
        const rows = await client.seriesEventsRaw(l.series, { endMin, endMax, offset: page * 100, limit: 100 });
        sum.events += rows.length;
        for (const raw of rows) for (const u of upcomingMoneylines(raw, l.sport, nowSecs)) if (!upcoming.has(u.cid)) upcoming.set(u.cid, u);
        if (rows.length < 100) break;
      }
    } catch (e) {
      sum.errors.push(`${l.sport}: ${msg(e)}`);
    }
  }
  sum.upcoming = upcoming.size;

  const due = dueCaptures([...upcoming.values()], seenKeys(readJsonl(path)), nowSecs);
  sum.due = due.length;
  for (const d of due) {
    try {
      const quotes: OutcomeQuote[] = [];
      for (const [i, token] of d.tokenIds.entries()) {
        const q = quoteOf(d.outcomes[i], await client.book(token));
        if (!q) break;
        quotes.push(q);
      }
      if (quotes.length !== d.outcomes.length) {
        sum.skippedOneSided++;
        continue;
      }
      let holders: HolderTop[] | null = null;
      if (opts.holders !== false) {
        try {
          holders = (await client.holders(d.cid, 10))
            .sort((a, b) => b.shares - a.shares)
            .slice(0, 10)
            .map((h) => ({ wallet: h.wallet, side: d.outcomes[h.outcomeIndex] ?? String(h.outcomeIndex), outcomeIndex: h.outcomeIndex, size: h.shares }));
        } catch {
          holders = null;
        }
      }
      if (holders === null) sum.holdersAbsent++;
      const line: SnapshotLine = { v: 1, cid: d.cid, slug: d.slug, title: d.title, event: d.event, sport: d.sport, outcomes: d.outcomes, startTs: d.startTs, label: d.label, capturedAt: Math.floor((opts.now ?? Date.now)() / 1000), quotes, vol24: d.vol24, holders, holdersAbsent: holders === null };
      if (!opts.dryRun) appendLine(path, line);
      sum.lines.push(line);
      sum.written++;
    } catch (e) {
      sum.errors.push(`${d.cid} ${d.label}: ${msg(e)}`);
    }
  }
  return sum;
}

export interface SettleOptions {
  resultsPath?: string; // default: results.jsonl next to the snapshots file
  now?: () => number;
  dryRun?: boolean;
}

export interface SettleSummary {
  pending: number;
  settled: number;
  results: ResultLine[];
  errors: string[];
}

export async function settleSnapshots(client: PolymarketClient, path: string = SNAPSHOTS_PATH, opts: SettleOptions = {}): Promise<SettleSummary> {
  const resultsPath = opts.resultsPath ?? join(dirname(path), 'results.jsonl');
  const nowSecs = Math.floor((opts.now ?? Date.now)() / 1000);
  const todo = unsettled(readJsonl(path), readJsonl(resultsPath), nowSecs);
  const sum: SettleSummary = { pending: [...todo.values()].reduce((a, s) => a + s.size, 0), settled: 0, results: [], errors: [] };
  for (const [slug, cids] of todo) {
    try {
      const ev = await client.eventBySlug(slug);
      for (const m of ev?.markets ?? []) {
        if (!cids.has(m.cid) || !m.closed) continue;
        const winnerIdx = winnerFromPrices(m.result);
        if (winnerIdx === undefined || !m.result) continue;
        const line: ResultLine = { cid: m.cid, winnerIdx, payout: m.result, settledAt: nowSecs };
        if (!opts.dryRun) appendLine(resultsPath, line);
        sum.results.push(line);
        sum.settled++;
      }
    } catch (e) {
      sum.errors.push(`${slug}: ${msg(e)}`);
    }
  }
  return sum;
}
