import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FORWARD_DIR, quoteOf, readJsonl, winnerFromPrices, type OutcomeQuote } from './forward.ts';
import { CI_LEVEL, DEFAULT_BOOTSTRAP, MIN_BETS, NO_EDGE, dayClusteredCi, verdictOf } from './ledger.ts';
import { httpFetchJson, type FetchJson, type PolymarketClient } from './polymarket.ts';
import type { TradeRow } from './store.ts';

/**
 * Calm-then-jump scanner with a pre-registered forward test.
 * A jump flag is a lead to look at, not a trade signal, and never an accusation against any wallet.
 * The trigger and the three strategies below were FROZEN before any forward data existed. Do not tune them on the log they score:
 * a changed rule is a new strategy with a new id, scored only on flags logged after the change.
 */

// ---- frozen trigger ----
/** Jump measured over this many seconds: price now vs price this long ago. */
export const JUMP_WINDOW_SECS = 30 * 60;
/** Calm window: the 24h ending JUMP_WINDOW_SECS ago. */
export const CALM_SECS = 24 * 3600;
/** Max high-low range of the price in the calm window. */
export const CALM_MAX_RANGE = 0.1;
/** Min price points in the calm window. */
export const CALM_MIN_POINTS = 3;
/** Min |price now - reference price|. */
export const JUMP_MIN_MOVE = 0.15;
/** Reference price must be inside [REF_MIN, REF_MAX]. */
export const REF_MIN = 0.1;
export const REF_MAX = 0.9;
/**
 * Cheap gamma screen on |oneHourPriceChange|. Lossless by construction: price 1h ago sits inside the calm window, so a 0.15 jump
 * after a range of at most 0.10 still shows a 1h change of at least 0.15 - 0.10.
 */
export const SCREEN_MIN_CH1H = JUMP_MIN_MOVE - CALM_MAX_RANGE;
/** Busiest active markets screened per scan. */
export const SCREEN_MARKETS = 400;
/** prices-history fidelity in minutes (must stay <= 10). */
export const HISTORY_FIDELITY = 10;
/** A cid is flagged at most once per this many seconds. */
export const JUMP_DEDUPE_SECS = 24 * 3600;
/** Entry quote is taken this long after the flag, inclusive. */
export const ENTRY_MIN_SECS = 5 * 60;
export const ENTRY_MAX_SECS = 15 * 60;
/** jump-follow-fresh acts only at or above this freshShare. */
export const FRESH_MIN_SHARE = 0.5;

// ---- loose variant (pre-registered 2026-11-02, after the frozen rule missed a sparse-history positive control) ----
/** detectJumpAny: the reference point (last at or before now - 30 min) may be at most this old. */
export const ANY_REF_MAX_AGE_SECS = 6 * 3600;
/**
 * The scan's gamma screen stays SCREEN_MIN_CH1H (0.05), which is looser than the 0.10 the loose rule alone would use.
 * Raising it to 0.10 would drop frozen-rule flags with a 1h change in [0.05, 0.10). For the loose rule the screen is NOT
 * strictly lossless, because there is no calm bound on the price 1h ago: |ch1h| >= 0.15 - |p(1h ago) - pRef|. At 0.05
 * it misses only paths where the price moved more than 0.10 against the jump between 60 and 30 min ago (a whipsaw),
 * or where gamma's 1h figure is stale.
 */
export const SCREEN_MIN_CH1H_ANY = SCREEN_MIN_CH1H;

export const JUMPS_PATH = join(FORWARD_DIR, 'jumps.jsonl');

export const JUMP_CAVEAT =
  'Jump flags are leads, not trade signals. A jump is not evidence of wrongdoing; never accuse a wallet. ' +
  'Backtest on 2,400 markets: jump-fade ROI/$1 +13.0%, 99% CI [-4%, +32%], n=357 (not significant). ' +
  'Loose variant (no calm filter; jump-fade-any/jump-follow-any) backtest: newer 40% fade +14.3% CI [+0.4%, +29.4%] n=606, follow -8.9%; ' +
  'older 60% fade +7.6% CI [-4.8%, +19.7%]. It was chosen after seeing these results (3 calm variants tried), so it is a lead, not an edge; only forward flags count as evidence.';

const CLOB = 'https://clob.polymarket.com';
const EPS = 1e-9;
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const utcDay = (secs: number): string => new Date(secs * 1000).toISOString().slice(0, 10);

// ---- pure detection ----

export interface PricePoint {
  t: number; // epoch s
  p: number;
}

export type JumpCheck =
  | { jump: true; direction: 'up' | 'down'; pRef: number; pNow: number; move: number; calmRange: number; calmPoints: number; refTs: number; nowTs: number }
  | { jump: false; reason: 'no-recent-price' | 'too-few-points' | 'not-calm' | 'ref-out-of-band' | 'small-move' };

/**
 * Frozen trigger on one outcome's price series. `now` (epoch s) defaults to the last point's time.
 * pNow = last price at or before now, which must be inside the jump window; pRef = last price at or before now - 30 min;
 * calm = range <= 0.10 over >= 3 points in [now - 30 min - 24h, now - 30 min]; then |pNow - pRef| >= 0.15 with pRef in [0.10, 0.90].
 */
export function detectJump(series: readonly PricePoint[], opts: { now?: number } = {}): JumpCheck {
  const pts = series.filter((x) => x && Number.isFinite(x.t) && Number.isFinite(x.p) && x.p >= 0 && x.p <= 1).slice().sort((a, b) => a.t - b.t);
  const nowTs = opts.now ?? pts[pts.length - 1]?.t;
  if (nowTs === undefined) return { jump: false, reason: 'no-recent-price' };
  const refTs = nowTs - JUMP_WINDOW_SECS;
  const upToNow = pts.filter((x) => x.t <= nowTs);
  const last = upToNow[upToNow.length - 1];
  if (!last || last.t <= refTs) return { jump: false, reason: 'no-recent-price' };
  const calm = pts.filter((x) => x.t <= refTs && x.t >= refTs - CALM_SECS);
  if (calm.length < CALM_MIN_POINTS) return { jump: false, reason: 'too-few-points' };
  const ps = calm.map((x) => x.p);
  const calmRange = r6(Math.max(...ps) - Math.min(...ps));
  if (calmRange > CALM_MAX_RANGE + EPS) return { jump: false, reason: 'not-calm' };
  const pRef = calm[calm.length - 1].p;
  if (pRef < REF_MIN - EPS || pRef > REF_MAX + EPS) return { jump: false, reason: 'ref-out-of-band' };
  const move = r6(last.p - pRef);
  if (Math.abs(move) < JUMP_MIN_MOVE - EPS) return { jump: false, reason: 'small-move' };
  return { jump: true, direction: move > 0 ? 'up' : 'down', pRef, pNow: last.p, move, calmRange, calmPoints: calm.length, refTs, nowTs };
}

export type JumpAnyCheck =
  | { jump: true; direction: 'up' | 'down'; pRef: number; pNow: number; move: number; calm: boolean; calmRange: number; calmPoints: number; refTs: number; nowTs: number }
  | { jump: false; reason: 'no-recent-price' | 'no-ref' | 'stale-ref' | 'ref-out-of-band' | 'small-move' };

/**
 * Loose trigger = the frozen rule OR the same move test with no calm requirement. When the frozen rule holds, its result is
 * returned with calm=true. Otherwise: pNow = last price in (now - 30 min, now]; pRef = last price at or before now - 30 min,
 * no older than 6h (sparse CLOB histories are about hourly); |pNow - pRef| >= 0.15 with pRef in [0.10, 0.90]; calm=false.
 * calmRange/calmPoints describe the points in the 24h calm window (the ref point is always one of them).
 */
export function detectJumpAny(series: readonly PricePoint[], opts: { now?: number } = {}): JumpAnyCheck {
  const frozen = detectJump(series, opts);
  if (frozen.jump) return { jump: true, direction: frozen.direction, pRef: frozen.pRef, pNow: frozen.pNow, move: frozen.move, calm: true, calmRange: frozen.calmRange, calmPoints: frozen.calmPoints, refTs: frozen.refTs, nowTs: frozen.nowTs };
  const pts = series.filter((x) => x && Number.isFinite(x.t) && Number.isFinite(x.p) && x.p >= 0 && x.p <= 1).slice().sort((a, b) => a.t - b.t);
  const nowTs = opts.now ?? pts[pts.length - 1]?.t;
  if (nowTs === undefined) return { jump: false, reason: 'no-recent-price' };
  const refTs = nowTs - JUMP_WINDOW_SECS;
  const upToNow = pts.filter((x) => x.t <= nowTs);
  const last = upToNow[upToNow.length - 1];
  if (!last || last.t <= refTs) return { jump: false, reason: 'no-recent-price' };
  const before = pts.filter((x) => x.t <= refTs);
  const ref = before[before.length - 1];
  if (!ref) return { jump: false, reason: 'no-ref' };
  if (refTs - ref.t > ANY_REF_MAX_AGE_SECS + EPS) return { jump: false, reason: 'stale-ref' };
  if (ref.p < REF_MIN - EPS || ref.p > REF_MAX + EPS) return { jump: false, reason: 'ref-out-of-band' };
  const move = r6(last.p - ref.p);
  if (Math.abs(move) < JUMP_MIN_MOVE - EPS) return { jump: false, reason: 'small-move' };
  const ps = before.filter((x) => x.t >= refTs - CALM_SECS).map((x) => x.p);
  return { jump: true, direction: move > 0 ? 'up' : 'down', pRef: ref.p, pNow: last.p, move, calm: false, calmRange: r6(Math.max(...ps) - Math.min(...ps)), calmPoints: ps.length, refTs, nowTs };
}

/**
 * Taker USD in the jump window, and the share of window BUY USD from wallets with no earlier fill in this market.
 * freshShare is null unless `complete` (the fills cover the market's whole history) and there was window buying.
 */
export function flowOf(trades: readonly TradeRow[], nowTs: number, complete: boolean): { vol30m: number; freshShare: number | null } {
  const start = nowTs - JUMP_WINDOW_SECS;
  const win = trades.filter((t) => t.ts > start && t.ts <= nowTs);
  const vol30m = r6(win.reduce((s, t) => s + t.size * t.price, 0));
  if (!complete) return { vol30m, freshShare: null };
  const before = new Set(trades.filter((t) => t.ts <= start).map((t) => t.wallet));
  const buys = win.filter((t) => t.side === 'BUY');
  const total = buys.reduce((s, t) => s + t.size * t.price, 0);
  if (total <= 0) return { vol30m, freshShare: null };
  const fresh = buys.filter((t) => !before.has(t.wallet)).reduce((s, t) => s + t.size * t.price, 0);
  return { vol30m, freshShare: r6(fresh / total) };
}

// ---- scan ----

export interface SideQuote {
  outcome: string;
  bid: number | null;
  ask: number | null;
}

export interface JumpFlag {
  cid: string;
  slug: string;
  eventSlug: string;
  title: string;
  outcomes: string[];
  tokenIds: string[];
  /** Direction of outcome 0's price. */
  direction: 'up' | 'down';
  /** Outcome whose price jumped up (0 when direction is up, else 1). */
  upIdx: number;
  /** Outcome 0 price 30 min ago and now. */
  pRef: number;
  pNow: number;
  move: number;
  /** High-low range and point count of the 24h window before the reference time. */
  calmRange: number;
  calmPoints: number;
  /** True when the frozen calm rule fired; false = loose rule only. Old log lines without this field count as calm. */
  calm: boolean;
  /** Taker USD over the last 30 min (from the latest page of up to 1000 taker fills). */
  vol30m: number;
  /** Share of last-30-min buy USD from wallets new to the market; null when the market history was too long to read in one page. */
  freshShare: number | null;
  /** Best bid/ask of both outcomes at detection; null for an empty side. */
  quotes: SideQuote[];
  detectedAt: number; // epoch s
}

export interface ScanOptions {
  /** Used for CLOB prices-history (not a PolymarketClient method). Default: plain HTTP. */
  fetchJson?: FetchJson;
  now?: () => number; // epoch ms
  markets?: number; // default SCREEN_MARKETS
  maxEventPages?: number; // default 10
  /** Read one page of fills per confirmed jump for vol30m/freshShare (default true). */
  flow?: boolean;
}

export interface JumpScan {
  events: number;
  markets: number;
  screened: number;
  checked: number;
  flags: JumpFlag[];
  reasons: Record<string, number>;
  errors: string[];
}

interface Candidate {
  cid: string;
  slug: string;
  eventSlug: string;
  title: string;
  outcomes: string[];
  tokenIds: string[];
  vol24: number;
  ch1h: number | null;
}

const arr = (v: unknown): string[] => {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(a) ? a.map((x) => String(x).trim()) : [];
  } catch {
    return [];
  }
};
const optNum = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Sports and esports events, including every side market of a game (spreads, totals, props). A goal, a kill or a point makes the price jump for a
 * reason everyone sees, so those jumps say nothing unusual and are never flagged. Detected from gamma's own labels: any market with a
 * sportsMarketType, an event gameId or live/ended game state, or a Sports / Esports / Games tag.
 */
export function isSportsEvent(ev: Record<string, any>): boolean {
  if (ev.gameId !== undefined && ev.gameId !== null && ev.gameId !== '') return true;
  if (typeof ev.live === 'boolean' || typeof ev.ended === 'boolean') return true;
  if ((ev.markets ?? []).some((m: Record<string, any>) => m?.sportsMarketType)) return true;
  const tags = Array.isArray(ev.tags) ? ev.tags : [];
  return tags.some((t: Record<string, any>) => ['sports', 'esports', 'games'].includes(String(t?.slug ?? '').toLowerCase()));
}

/** Active, order-accepting binary markets of raw gamma events, sports and esports excluded (see isSportsEvent). */
export function candidatesOf(events: ReadonlyArray<Record<string, any>>): Candidate[] {
  const out: Candidate[] = [];
  for (const ev of events) {
    if (isSportsEvent(ev)) continue;
    for (const m of (ev.markets ?? []) as Array<Record<string, any>>) {
      if (!m.conditionId || m.closed || m.active === false || m.acceptingOrders === false) continue;
      const outcomes = arr(m.outcomes);
      const tokenIds = arr(m.clobTokenIds);
      if (outcomes.length !== 2 || tokenIds.length !== 2) continue;
      out.push({ cid: String(m.conditionId), slug: String(m.slug ?? ''), eventSlug: String(ev.slug ?? ''), title: String(m.question ?? ev.title ?? ''), outcomes, tokenIds, vol24: optNum(m.volume24hr) ?? 0, ch1h: optNum(m.oneHourPriceChange) });
    }
  }
  return out;
}

async function priceHistory(fetchJson: FetchJson, token: string, startTs: number, endTs: number): Promise<PricePoint[]> {
  const r = (await fetchJson(`${CLOB}/prices-history?market=${token}&startTs=${startTs}&endTs=${endTs}&fidelity=${HISTORY_FIDELITY}`)) as Record<string, any>;
  const h = Array.isArray(r?.history) ? r.history : [];
  return h.map((x: Record<string, any>) => ({ t: Number(x.t), p: Number(x.p) })).filter((x: PricePoint) => Number.isFinite(x.t) && Number.isFinite(x.p));
}

/** Screens the busiest ~400 active markets on gamma's 1h change, confirms on CLOB prices-history with detectJumpAny (frozen OR loose rule), and returns flags. Writes nothing. */
export async function scanJumps(client: PolymarketClient, opts: ScanOptions = {}): Promise<JumpScan> {
  const fetchJson = opts.fetchJson ?? httpFetchJson;
  const nowTs = Math.floor((opts.now ?? Date.now)() / 1000);
  const want = opts.markets ?? SCREEN_MARKETS;
  const sum: JumpScan = { events: 0, markets: 0, screened: 0, checked: 0, flags: [], reasons: {}, errors: [] };

  const byCid = new Map<string, Candidate>();
  for (let page = 0; page < (opts.maxEventPages ?? 10) && byCid.size < want; page++) {
    let rows: Array<Record<string, any>>;
    try {
      rows = await client.activeEventsRaw(page * 100, 100);
    } catch (e) {
      sum.errors.push(`events page ${page}: ${msg(e)}`);
      break;
    }
    sum.events += rows.length;
    for (const c of candidatesOf(rows)) if (!byCid.has(c.cid)) byCid.set(c.cid, c);
    if (rows.length < 100) break;
  }
  const busiest = [...byCid.values()].sort((a, b) => b.vol24 - a.vol24).slice(0, want);
  sum.markets = busiest.length;
  const screened = busiest.filter((c) => c.ch1h !== null && Math.abs(c.ch1h) >= Math.min(SCREEN_MIN_CH1H, SCREEN_MIN_CH1H_ANY) - EPS);
  sum.screened = screened.length;

  for (const c of screened) {
    try {
      const series = await priceHistory(fetchJson, c.tokenIds[0], nowTs - JUMP_WINDOW_SECS - CALM_SECS - 600, nowTs);
      sum.checked++;
      const d = detectJumpAny(series, { now: nowTs });
      if (!d.jump) {
        sum.reasons[d.reason] = (sum.reasons[d.reason] ?? 0) + 1;
        continue;
      }
      const quotes: SideQuote[] = [];
      for (const [i, tok] of c.tokenIds.entries()) {
        const b = await client.book(tok);
        quotes.push({ outcome: c.outcomes[i], bid: b.bids[0]?.price ?? null, ask: b.asks[0]?.price ?? null });
      }
      let flow: { vol30m: number; freshShare: number | null } = { vol30m: 0, freshShare: null };
      if (opts.flow !== false) {
        const limit = 1000;
        const fills = await client.tradesPage(c.cid, { takerOnly: true, limit });
        flow = flowOf(fills, nowTs, fills.length < limit);
      }
      sum.flags.push({ cid: c.cid, slug: c.slug, eventSlug: c.eventSlug, title: c.title, outcomes: c.outcomes, tokenIds: c.tokenIds, direction: d.direction, upIdx: d.direction === 'up' ? 0 : 1, pRef: d.pRef, pNow: d.pNow, move: d.move, calmRange: d.calmRange, calmPoints: d.calmPoints, calm: d.calm, ...flow, quotes, detectedAt: nowTs });
    } catch (e) {
      sum.errors.push(`${c.cid}: ${msg(e)}`);
    }
  }
  return sum;
}

// ---- forward log (one JSONL, three line kinds) ----

export interface JumpFlagLine extends JumpFlag {
  v: 1;
  kind: 'flag';
  /** `${cid}|${flaggedAt}` */
  id: string;
  flaggedAt: number;
}
export interface JumpEntryLine {
  v: 1;
  kind: 'entry';
  id: string;
  cid: string;
  capturedAt: number;
  lagSecs: number;
  /** Both outcomes, both sides present. */
  quotes: OutcomeQuote[];
}
export interface JumpResultLine {
  v: 1;
  kind: 'result';
  cid: string;
  /** null = void split. */
  winnerIdx: number | null;
  payout: number[];
  settledAt: number;
}
export type JumpLine = JumpFlagLine | JumpEntryLine | JumpResultLine;

function appendLine(path: string, line: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + '\n');
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function validFlagLine(x: unknown): x is JumpFlagLine {
  const l = x as JumpFlagLine;
  return !!l && l.kind === 'flag' && typeof l.id === 'string' && typeof l.cid === 'string' && isNum(l.flaggedAt) && Array.isArray(l.outcomes) && l.outcomes.length === 2 && Array.isArray(l.tokenIds) && l.tokenIds.length === 2 && (l.upIdx === 0 || l.upIdx === 1) && (l.freshShare === null || isNum(l.freshShare)) && (l.calm === undefined || typeof l.calm === 'boolean');
}

/** A flag line counts as calm unless it says calm:false (lines logged before the loose variant have no field). */
export const isCalmFlag = (f: { calm?: boolean }): boolean => f.calm !== false;
export function validEntryLine(x: unknown): x is JumpEntryLine {
  const l = x as JumpEntryLine;
  return !!l && l.kind === 'entry' && typeof l.id === 'string' && Array.isArray(l.quotes) && l.quotes.length === 2 && l.quotes.every((q) => q && isNum(q.bid) && isNum(q.ask) && q.bid > 0 && q.ask < 1 && q.ask >= q.bid);
}
export function validResultLine(x: unknown): x is JumpResultLine {
  const l = x as JumpResultLine;
  return !!l && l.kind === 'result' && typeof l.cid === 'string' && Array.isArray(l.payout) && l.payout.length === 2 && l.payout.every(isNum);
}

/** Appends one flag line per cid, skipping any cid flagged within the last 24h (in the file or earlier in this batch). Returns the lines written. */
export function logJumps(flags: readonly JumpFlag[], path: string = JUMPS_PATH, opts: { dryRun?: boolean } = {}): JumpFlagLine[] {
  const last = new Map<string, number>();
  for (const l of readJsonl<unknown>(path)) if (validFlagLine(l)) last.set(l.cid, Math.max(last.get(l.cid) ?? -Infinity, l.flaggedAt));
  const out: JumpFlagLine[] = [];
  for (const f of flags) {
    const prev = last.get(f.cid);
    if (prev !== undefined && f.detectedAt - prev < JUMP_DEDUPE_SECS) continue;
    const line: JumpFlagLine = { v: 1, kind: 'flag', id: `${f.cid}|${f.detectedAt}`, ...f, flaggedAt: f.detectedAt };
    if (!opts.dryRun) appendLine(path, line);
    last.set(f.cid, f.detectedAt);
    out.push(line);
  }
  return out;
}

export interface EntrySummary {
  due: number;
  written: number;
  skippedOneSided: number;
  missed: number;
  lines: JumpEntryLine[];
  errors: string[];
}

/** For each flag 5-15 min old without an entry line, reads both books and appends an entry; a one-sided book is skipped (retried next call while inside the window). */
export async function captureEntries(client: PolymarketClient, path: string = JUMPS_PATH, opts: { now?: () => number } = {}): Promise<EntrySummary> {
  const nowTs = Math.floor((opts.now ?? Date.now)() / 1000);
  const lines = readJsonl<unknown>(path);
  const done = new Set(lines.filter(validEntryLine).map((l) => l.id));
  const sum: EntrySummary = { due: 0, written: 0, skippedOneSided: 0, missed: 0, lines: [], errors: [] };
  for (const f of lines.filter(validFlagLine)) {
    if (done.has(f.id)) continue;
    const age = nowTs - f.flaggedAt;
    if (age > ENTRY_MAX_SECS) {
      sum.missed++;
      continue;
    }
    if (age < ENTRY_MIN_SECS) continue;
    sum.due++;
    try {
      const quotes: OutcomeQuote[] = [];
      for (const [i, tok] of f.tokenIds.entries()) {
        const q = quoteOf(f.outcomes[i], await client.book(tok));
        if (!q) break;
        quotes.push(q);
      }
      if (quotes.length !== 2) {
        sum.skippedOneSided++;
        continue;
      }
      const line: JumpEntryLine = { v: 1, kind: 'entry', id: f.id, cid: f.cid, capturedAt: nowTs, lagSecs: age, quotes };
      appendLine(path, line);
      done.add(f.id);
      sum.lines.push(line);
      sum.written++;
    } catch (e) {
      sum.errors.push(`${f.cid}: ${msg(e)}`);
    }
  }
  return sum;
}

export interface JumpSettleSummary {
  pending: number;
  settled: number;
  lines: JumpResultLine[];
  errors: string[];
}

/** Writes one result line per flagged cid once its market has resolved (winner via winnerFromPrices); never twice. */
export async function settleJumps(client: PolymarketClient, path: string = JUMPS_PATH, opts: { now?: () => number } = {}): Promise<JumpSettleSummary> {
  const nowTs = Math.floor((opts.now ?? Date.now)() / 1000);
  const lines = readJsonl<unknown>(path);
  const settled = new Set(lines.filter(validResultLine).map((l) => l.cid));
  const bySlug = new Map<string, Set<string>>();
  for (const f of lines.filter(validFlagLine)) {
    if (settled.has(f.cid) || !f.eventSlug) continue;
    if (!bySlug.has(f.eventSlug)) bySlug.set(f.eventSlug, new Set());
    bySlug.get(f.eventSlug)!.add(f.cid);
  }
  const sum: JumpSettleSummary = { pending: [...bySlug.values()].reduce((a, s) => a + s.size, 0), settled: 0, lines: [], errors: [] };
  for (const [slug, cids] of bySlug) {
    try {
      const ev = await client.eventBySlug(slug);
      for (const m of ev?.markets ?? []) {
        if (!cids.has(m.cid) || !m.closed || settled.has(m.cid) || !m.result) continue;
        const winnerIdx = winnerFromPrices(m.result);
        if (winnerIdx === undefined) continue;
        const line: JumpResultLine = { v: 1, kind: 'result', cid: m.cid, winnerIdx, payout: m.result, settledAt: nowTs };
        appendLine(path, line);
        settled.add(m.cid);
        sum.lines.push(line);
        sum.settled++;
      }
    } catch (e) {
      sum.errors.push(`${slug}: ${msg(e)}`);
    }
  }
  return sum;
}

// ---- pre-registered strategies ----

export interface JumpStrategy {
  id: string;
  description: string;
  /** Which flags it sees: 'calm' = frozen-rule flags only (isCalmFlag), 'any' = every flag. */
  universe: 'calm' | 'any';
  /** Outcome index to buy, or null to pass. Fill = that outcome's entry ask. */
  pick: (f: JumpFlagLine) => number | null;
}

/**
 * The first three are FROZEN from before any forward data existed and see calm flags only. The two -any strategies were
 * pre-registered on 2026-11-02, after the loose backtest, and see every flag. Do not edit any of them to fit the log.
 */
export const JUMP_STRATEGIES: readonly JumpStrategy[] = Object.freeze([
  { id: 'jump-fade', universe: 'calm', description: 'buy the outcome that jumped down, at its entry ask (5-15 min after the flag)', pick: (f: JumpFlagLine) => 1 - f.upIdx },
  { id: 'jump-follow', universe: 'calm', description: 'control: buy the outcome that jumped up, at its entry ask', pick: (f: JumpFlagLine) => f.upIdx },
  { id: 'jump-follow-fresh', universe: 'calm', description: `buy the outcome that jumped up only when freshShare >= ${FRESH_MIN_SHARE}, at its entry ask`, pick: (f: JumpFlagLine) => (f.freshShare !== null && f.freshShare >= FRESH_MIN_SHARE - EPS ? f.upIdx : null) },
  { id: 'jump-fade-any', universe: 'any', description: 'buy the outcome that jumped down on any flag (calm or loose rule), at its entry ask', pick: (f: JumpFlagLine) => 1 - f.upIdx },
  { id: 'jump-follow-any', universe: 'any', description: 'control: buy the outcome that jumped up on any flag, at its entry ask', pick: (f: JumpFlagLine) => f.upIdx },
] as JumpStrategy[]);

export interface JumpBet {
  id: string;
  cid: string;
  eventSlug: string;
  outcomeIdx: number;
  price: number;
  day: string;
  payout: number;
  ret: number;
}

export interface JumpStrategyScore {
  id: string;
  description: string;
  n: number;
  events: number;
  days: number;
  wins: number;
  hitRate: number | null;
  breakEven: number | null;
  roi: number | null;
  ci: [number, number] | null;
  verdict: string;
  bets: JumpBet[];
}

export interface JumpReport {
  flags: number;
  /** Flags from the frozen calm rule (old lines without `calm` included). */
  calmFlags: number;
  entries: number;
  settled: number;
  skippedLines: number;
  ciLevel: number;
  minBets: number;
  iterations: number;
  seed: number;
  strategies: JumpStrategyScore[];
  caveat: string;
}

/** Scores the frozen strategies on the jump log. Only flags with an entry line and a result line produce bets. */
export function scoreJumps(lines: readonly unknown[], opts: { iterations?: number; seed?: number } = {}): JumpReport {
  const iterations = opts.iterations ?? DEFAULT_BOOTSTRAP.iterations;
  const seed = opts.seed ?? DEFAULT_BOOTSTRAP.seed;
  const flags = new Map<string, JumpFlagLine>();
  const entries = new Map<string, JumpEntryLine>();
  const results = new Map<string, JumpResultLine>();
  let skipped = 0;
  for (const l of lines) {
    if (validFlagLine(l) && !flags.has(l.id)) flags.set(l.id, l);
    else if (validEntryLine(l) && !entries.has(l.id)) entries.set(l.id, l);
    else if (validResultLine(l) && !results.has(l.cid)) results.set(l.cid, l);
    else skipped++;
  }
  const ready = [...flags.values()].filter((f) => entries.has(f.id) && results.has(f.cid)).sort((a, b) => a.flaggedAt - b.flaggedAt || a.id.localeCompare(b.id));

  const strategies = JUMP_STRATEGIES.map((st): JumpStrategyScore => {
    const bets: JumpBet[] = [];
    for (const f of ready) {
      if (st.universe === 'calm' && !isCalmFlag(f)) continue;
      const i = st.pick(f);
      if (i === null) continue;
      const price = entries.get(f.id)!.quotes[i].ask;
      const payout = results.get(f.cid)!.payout[i];
      if (!(price > 0 && price < 1)) continue;
      bets.push({ id: f.id, cid: f.cid, eventSlug: f.eventSlug, outcomeIdx: i, price, day: utcDay(f.flaggedAt), payout, ret: payout / price - 1 });
    }
    const n = bets.length;
    const mean = (g: (b: JumpBet) => number): number | null => (n ? bets.reduce((s, b) => s + g(b), 0) / n : null);
    const wins = bets.filter((b) => b.payout >= 0.99).length;
    const ci = dayClusteredCi(bets, CI_LEVEL, iterations, seed);
    return { id: st.id, description: st.description, n, events: new Set(bets.map((b) => b.eventSlug)).size, days: new Set(bets.map((b) => b.day)).size, wins, hitRate: n ? wins / n : null, breakEven: mean((b) => b.price), roi: mean((b) => b.ret), ci, verdict: verdictOf(n, ci), bets };
  });
  return { flags: flags.size, calmFlags: [...flags.values()].filter(isCalmFlag).length, entries: entries.size, settled: ready.length, skippedLines: skipped, ciLevel: CI_LEVEL, minBets: MIN_BETS, iterations, seed, strategies, caveat: JUMP_CAVEAT };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;

/** Plain text lines for the CLI/TUI. A hit rate is always printed next to its break-even base rate. */
export function formatJumps(report: JumpReport): string[] {
  const lines = [
    `Calm-then-jump forward log: ${report.flags} flags (${report.calmFlags} calm, ${report.flags - report.calmFlags} loose-only), ${report.entries} entries, ${report.settled} scorable, ${report.skippedLines} lines skipped`,
    `Verdict needs n>=${report.minBets} bets and the ${pct(report.ciLevel)} day-clustered bootstrap CI of ROI above 0 (${report.iterations} resamples, seed ${report.seed}); otherwise ${NO_EDGE}. Fill = entry ask 5-15 min after the flag.`,
  ];
  for (const s of report.strategies) {
    if (!s.n || s.hitRate === null || s.breakEven === null || s.roi === null || !s.ci) {
      lines.push(`${s.id.padEnd(18)} n=0  no settled bets yet  ${s.verdict}`);
      continue;
    }
    lines.push(`${s.id.padEnd(18)} n=${s.n} (${s.events} events, ${s.days} days)  hit ${pct(s.hitRate)} vs break-even ${pct(s.breakEven)}  ROI/$1 ${signed(s.roi)}  ${pct(report.ciLevel)} CI [${signed(s.ci[0])}, ${signed(s.ci[1])}]  ${s.verdict}`);
  }
  lines.push(report.caveat);
  return lines;
}
