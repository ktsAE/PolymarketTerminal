import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonl, winnerFromPrices } from './forward.ts';
import { CI_LEVEL, DEFAULT_BOOTSTRAP, MIN_BETS, dayClusteredCi, verdictOf } from './ledger.ts';
import type { PolymarketClient } from './polymarket.ts';
import { SURGE_CAVEAT, type SurgeFlag, type SurgeMetrics, type SurgeRow } from './surge.ts';

/**
 * Forward alert log: every surge alert is written down when it fires (with the price a follower would have paid then),
 * the surge-direction price is sampled later at fixed offsets, and the market's result is recorded once it resolves.
 * Rules below were fixed in code before any alert was logged; scoring uses only what was known at alert time plus the result.
 * A changed rule is a new rule with a new id, scored only on alerts logged after the change.
 */

export const SURGE_DIR = process.env.RADAR_SURGE ?? '.radar/surge';
export const ALERTS_PATH = join(SURGE_DIR, 'alerts.jsonl');
export const PATHS_PATH = join(SURGE_DIR, 'paths.jsonl');
export const RESULTS_PATH = join(SURGE_DIR, 'results.jsonl');

/** One alert line per market per this many seconds. */
export const DEDUPE_SECS = 6 * 3600;

export type PathLabel = '+5m' | '+1h' | '+24h';
export const FOLLOW_UPS: ReadonlyArray<{ label: PathLabel; secs: number }> = [
  { label: '+5m', secs: 5 * 60 },
  { label: '+1h', secs: 3600 },
  { label: '+24h', secs: 24 * 3600 },
];

/** What logAlerts accepts: a scan row, plus the bid of the surge-direction outcome and the market creation time when the caller has them. */
export type AlertInput = SurgeRow & { bestBid?: number | null; createdAt?: number | null };

export interface AlertLine {
  v: 1;
  /** `${cid}|${firstSeenAt}`: unique per alert. */
  id: string;
  cid: string;
  slug: string;
  eventSlug: string;
  title: string;
  outcomes: string[];
  tokenIds: string[];
  flags: SurgeFlag[];
  metrics: SurgeMetrics;
  /** Surge-direction outcome index (most last-hour buying); null when there was no single direction. */
  dirIdx: number | null;
  /** Best ask / best bid of the surge-direction outcome at alert time; null when not read or that side was empty. */
  ask: number | null;
  bid: number | null;
  /** Market creation, epoch s (given, else derived from metrics.ageDays); null when unknown. */
  createdAt: number | null;
  /** When the alert was logged, epoch s. */
  firstSeenAt: number;
}

export interface PathLine {
  v: 1;
  alertId: string;
  cid: string;
  label: PathLabel;
  dirIdx: number;
  /** firstSeenAt + offset, and when the book was actually read (both epoch s); lagSecs = capturedAt - dueAt. */
  dueAt: number;
  capturedAt: number;
  lagSecs: number;
  bid: number | null;
  ask: number | null;
  /** Mid of the surge-direction outcome; null when either side of the book was empty. */
  mid: number | null;
}

export interface SurgeResultLine {
  cid: string;
  /** Winning outcome index; null for a void (split) payout. */
  winnerIdx: number | null;
  payout: number[];
  settledAt: number;
}

// ---- helpers ----

function appendLine(path: string, line: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(line) + '\n');
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const price = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x > 0 && x < 1 ? x : null);
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;

/** An alert line usable for follow-up and scoring. */
export function validAlert(x: unknown): x is AlertLine {
  const a = x as AlertLine;
  return (
    !!a &&
    typeof a.id === 'string' &&
    typeof a.cid === 'string' &&
    typeof a.firstSeenAt === 'number' &&
    Number.isFinite(a.firstSeenAt) &&
    Array.isArray(a.outcomes) &&
    Array.isArray(a.flags) &&
    (a.dirIdx === null || (Number.isInteger(a.dirIdx) && a.dirIdx >= 0 && a.dirIdx < a.outcomes.length))
  );
}

// ---- logging ----

export interface LogSummary {
  written: number;
  /** Not flagged volume_surge, or already alerted for that market within DEDUPE_SECS. */
  skipped: number;
  lines: AlertLine[];
}

/** Appends each volume_surge alert once per market per DEDUPE_SECS. `now` is epoch ms. */
export function logAlerts(alerts: readonly AlertInput[], path: string = ALERTS_PATH, now: number = Date.now()): LogSummary {
  const nowSecs = Math.floor(now / 1000);
  const last = new Map<string, number>();
  for (const a of readJsonl(path)) {
    if (typeof a.cid === 'string' && typeof a.firstSeenAt === 'number') last.set(a.cid, Math.max(last.get(a.cid) ?? -Infinity, a.firstSeenAt));
  }
  const sum: LogSummary = { written: 0, skipped: 0, lines: [] };
  for (const r of alerts) {
    const prev = last.get(r.cid);
    if (!r.flags.includes('volume_surge') || (prev !== undefined && nowSecs - prev < DEDUPE_SECS)) {
      sum.skipped++;
      continue;
    }
    const age = r.metrics.ageDays;
    const createdAt = r.createdAt ?? (typeof age === 'number' && Number.isFinite(age) ? Math.round(nowSecs - age * 86400) : null);
    const line: AlertLine = {
      v: 1,
      id: `${r.cid}|${nowSecs}`,
      cid: r.cid,
      slug: r.slug,
      eventSlug: r.eventSlug,
      title: r.title,
      outcomes: r.outcomes,
      tokenIds: r.tokenIds,
      flags: r.flags,
      metrics: r.metrics,
      dirIdx: r.dirIdx,
      ask: price(r.bestAsk),
      bid: price(r.bestBid),
      createdAt,
      firstSeenAt: nowSecs,
    };
    appendLine(path, line);
    last.set(r.cid, nowSecs);
    sum.lines.push(line);
    sum.written++;
  }
  return sum;
}

// ---- follow-up ----

export interface FollowUpSummary {
  alerts: number;
  paths: PathLine[];
  results: SurgeResultLine[];
  errors: string[];
}

/**
 * For each logged alert: samples the surge-direction book at +5m, +1h and +24h (each once, only once that time has passed),
 * then records the result once the market has resolved. paths.jsonl and results.jsonl sit next to the alerts file. `now` is epoch ms.
 */
export async function followUp(client: PolymarketClient, path: string = ALERTS_PATH, now: number = Date.now()): Promise<FollowUpSummary> {
  const nowSecs = Math.floor(now / 1000);
  const pathsPath = join(dirname(path), 'paths.jsonl');
  const resultsPath = join(dirname(path), 'results.jsonl');
  const alerts = readJsonl<unknown>(path).filter(validAlert);
  const done = new Set(readJsonl(pathsPath).map((p) => `${p.alertId}|${p.label}`));
  const settled = new Set(readJsonl(resultsPath).map((r) => r.cid).filter((c): c is string => typeof c === 'string'));
  const sum: FollowUpSummary = { alerts: alerts.length, paths: [], results: [], errors: [] };

  for (const a of alerts) {
    if (a.dirIdx === null) continue;
    const token = a.tokenIds?.[a.dirIdx];
    if (typeof token !== 'string' || !token) continue;
    const due = FOLLOW_UPS.filter((f) => nowSecs >= a.firstSeenAt + f.secs && !done.has(`${a.id}|${f.label}`));
    if (!due.length) continue;
    try {
      const book = await client.book(token);
      const bid = price(book.bids[0]?.price);
      const ask = price(book.asks[0]?.price);
      const mid = bid !== null && ask !== null && ask >= bid ? r6((bid + ask) / 2) : null;
      for (const f of due) {
        const dueAt = a.firstSeenAt + f.secs;
        const line: PathLine = { v: 1, alertId: a.id, cid: a.cid, label: f.label, dirIdx: a.dirIdx, dueAt, capturedAt: nowSecs, lagSecs: nowSecs - dueAt, bid, ask, mid };
        appendLine(pathsPath, line);
        done.add(`${a.id}|${f.label}`);
        sum.paths.push(line);
      }
    } catch (e) {
      sum.errors.push(`${a.cid} book: ${msg(e)}`);
    }
  }

  const bySlug = new Map<string, Set<string>>();
  for (const a of alerts) {
    if (settled.has(a.cid) || typeof a.eventSlug !== 'string' || !a.eventSlug) continue;
    if (!bySlug.has(a.eventSlug)) bySlug.set(a.eventSlug, new Set());
    bySlug.get(a.eventSlug)!.add(a.cid);
  }
  for (const [slug, cids] of bySlug) {
    try {
      const ev = await client.eventBySlug(slug);
      for (const m of ev?.markets ?? []) {
        if (!cids.has(m.cid) || !m.closed || settled.has(m.cid)) continue;
        const winnerIdx = winnerFromPrices(m.result);
        if (winnerIdx === undefined || !m.result) continue;
        const line: SurgeResultLine = { cid: m.cid, winnerIdx, payout: m.result, settledAt: nowSecs };
        appendLine(resultsPath, line);
        settled.add(m.cid);
        sum.results.push(line);
      }
    } catch (e) {
      sum.errors.push(`${slug}: ${msg(e)}`);
    }
  }
  return sum;
}

// ---- pre-registered rules ----

export interface SurgeRule {
  id: string;
  description: string;
  /** Which logged alerts the rule acts on. */
  match: (a: AlertLine) => boolean;
  /** follow = buy the surge-direction outcome at its alert-time ask; fade = buy the other side of a two-outcome market at 1 - the direction's alert-time bid. */
  side: 'follow' | 'fade';
}

const all = (): boolean => true;
const young = (a: AlertLine): boolean => a.flags.includes('young_market');
const concFresh = (a: AlertLine): boolean => a.flags.includes('concentrated') && a.flags.includes('fresh_wallets');

/** FIXED before any data existed. Do not edit to fit the log. */
export const SURGE_RULES: readonly SurgeRule[] = Object.freeze([
  { id: 'follow-all', description: 'buy the surge direction of every alert at the alert-time ask', match: all, side: 'follow' },
  { id: 'follow-young', description: 'buy the surge direction of alerts on markets < 7 days old at the alert-time ask', match: young, side: 'follow' },
  { id: 'follow-concentrated-fresh', description: 'buy the surge direction of alerts flagged both concentrated and fresh_wallets at the alert-time ask', match: concFresh, side: 'follow' },
  { id: 'fade-all', description: 'control: buy against the surge (2-outcome markets) at 1 - the alert-time bid', match: all, side: 'fade' },
  { id: 'fade-young', description: 'control: fade-all restricted to markets < 7 days old', match: young, side: 'fade' },
  { id: 'fade-concentrated-fresh', description: 'control: fade-all restricted to concentrated + fresh_wallets alerts', match: concFresh, side: 'fade' },
] as SurgeRule[]);

/** The bet a rule takes on one alert, or null when the rule does not apply or no tradable price was logged. */
export function betOf(rule: SurgeRule, a: AlertLine): { outcomeIdx: number; price: number } | null {
  if (a.dirIdx === null || !rule.match(a)) return null;
  if (rule.side === 'follow') {
    const p = price(a.ask);
    return p === null ? null : { outcomeIdx: a.dirIdx, price: p };
  }
  const bid = price(a.bid);
  if (a.outcomes.length !== 2 || bid === null) return null;
  return { outcomeIdx: 1 - a.dirIdx, price: r6(1 - bid) };
}

// ---- scoring ----

export interface SurgeBet {
  alertId: string;
  cid: string;
  outcomeIdx: number;
  price: number;
  /** UTC day of the alert: the bootstrap cluster. */
  day: string;
  /** Payout per share: 1 win, 0 loss, fractional on a void split. */
  payout: number;
  /** Profit per $1 staked: payout / price - 1. */
  ret: number;
}

export interface SurgeRuleScore {
  id: string;
  description: string;
  n: number;
  markets: number;
  days: number;
  wins: number;
  voids: number;
  hitRate: number | null;
  /** Mean entry price = hit rate needed to break even. */
  breakEven: number | null;
  roi: number | null;
  ci: [number, number] | null;
  verdict: string;
  bets: SurgeBet[];
}

export interface SurgeLogReport {
  alerts: number;
  settled: number;
  skippedAlerts: number;
  ciLevel: number;
  minBets: number;
  iterations: number;
  seed: number;
  rules: SurgeRuleScore[];
  caveat: string;
}

export interface SurgeScoreOptions {
  iterations?: number;
  seed?: number;
  rules?: readonly SurgeRule[];
}

const utcDay = (secs: number): string => new Date(secs * 1000).toISOString().slice(0, 10);

/** Payout vector of a result line: its payout if well-formed, else one-hot on winnerIdx, else an even split for a void. */
function payoutsOf(r: Record<string, unknown>, k: number): number[] | null {
  if (Array.isArray(r.payout) && r.payout.length === k && r.payout.every((p) => typeof p === 'number' && Number.isFinite(p))) return r.payout as number[];
  if (r.winnerIdx === null) return Array.from({ length: k }, () => 1 / k);
  if (typeof r.winnerIdx === 'number' && Number.isInteger(r.winnerIdx) && r.winnerIdx >= 0 && r.winnerIdx < k) return Array.from({ length: k }, (_, i) => (i === r.winnerIdx ? 1 : 0));
  return null;
}

/** Scores every fixed rule on the alert log. Only alerts whose market has a result line produce bets. */
export function scoreSurgeLog(alerts: readonly unknown[], results: readonly unknown[], opts: SurgeScoreOptions = {}): SurgeLogReport {
  const iterations = opts.iterations ?? DEFAULT_BOOTSTRAP.iterations;
  const seed = opts.seed ?? DEFAULT_BOOTSTRAP.seed;
  const seen = new Set<string>();
  const valid: AlertLine[] = [];
  let skipped = 0;
  for (const a of alerts) {
    if (!validAlert(a) || seen.has(a.id)) {
      skipped++;
      continue;
    }
    seen.add(a.id);
    valid.push(a);
  }
  const res = new Map<string, Record<string, unknown>>();
  for (const r of results as Array<Record<string, unknown>>) if (r && typeof r === 'object' && typeof r.cid === 'string' && !res.has(r.cid)) res.set(r.cid, r);
  const settledAlerts = valid.filter((a) => res.has(a.cid));

  const rules = (opts.rules ?? SURGE_RULES).map((rule): SurgeRuleScore => {
    const bets: SurgeBet[] = [];
    for (const a of settledAlerts) {
      const bet = betOf(rule, a);
      if (!bet) continue;
      const pay = payoutsOf(res.get(a.cid)!, a.outcomes.length);
      if (!pay) continue;
      const payout = pay[bet.outcomeIdx];
      bets.push({ alertId: a.id, cid: a.cid, ...bet, day: utcDay(a.firstSeenAt), payout, ret: payout / bet.price - 1 });
    }
    const n = bets.length;
    const mean = (f: (b: SurgeBet) => number): number | null => (n ? bets.reduce((s, b) => s + f(b), 0) / n : null);
    const wins = bets.filter((b) => b.payout >= 0.99).length;
    const ci = dayClusteredCi(bets, CI_LEVEL, iterations, seed);
    return {
      id: rule.id,
      description: rule.description,
      n,
      markets: new Set(bets.map((b) => b.cid)).size,
      days: new Set(bets.map((b) => b.day)).size,
      wins,
      voids: bets.filter((b) => b.payout > 0.01 && b.payout < 0.99).length,
      hitRate: n ? wins / n : null,
      breakEven: mean((b) => b.price),
      roi: mean((b) => b.ret),
      ci,
      verdict: verdictOf(n, ci),
      bets,
    };
  });
  return { alerts: valid.length, settled: settledAlerts.length, skippedAlerts: skipped, ciLevel: CI_LEVEL, minBets: MIN_BETS, iterations, seed, rules, caveat: SURGE_CAVEAT };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;

/** Plain text lines for the CLI/TUI. A hit rate is always printed next to its break-even base rate. */
export function formatSurgeLog(report: SurgeLogReport): string[] {
  const lines = [
    `Surge alert log: ${report.settled}/${report.alerts} alerts settled, ${report.skippedAlerts} alert lines skipped`,
    `Verdict needs n>=${report.minBets} bets and the ${pct(report.ciLevel)} day-clustered bootstrap CI of ROI above 0 (${report.iterations} resamples, seed ${report.seed}). Follow fill = alert-time ask; fade fill = 1 - alert-time bid.`,
  ];
  for (const s of report.rules) {
    if (!s.n || s.hitRate === null || s.breakEven === null || s.roi === null || !s.ci) {
      lines.push(`${s.id.padEnd(25)} n=0  no settled bets yet  ${s.verdict}`);
      continue;
    }
    lines.push(
      `${s.id.padEnd(25)} n=${s.n} (${s.markets} markets, ${s.days} days)  hit ${pct(s.hitRate)} vs break-even ${pct(s.breakEven)}  ROI/$1 ${signed(s.roi)}  ${pct(report.ciLevel)} CI [${signed(s.ci[0])}, ${signed(s.ci[1])}]  ${s.verdict}`,
    );
  }
  lines.push(report.caveat);
  return lines;
}
