import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ladderViolations, parseLadder } from './ladder.ts';
import type { PolymarketClient } from './polymarket.ts';

/**
 * Edge scan over every active event: STRUCTURAL edges only, i.e. prices that contradict each other so that a set of bets pays more than it costs
 * whatever happens. Backtests (docs/research/radar/HOLDERS_STUDY.md) found no edge in holders, wallet form or price bands, so nothing here is a forecast.
 *
 *   LADDER   thresholds/dates priced out of order: buy YES on the easier rung and NO on the harder one for less than $1; pays >= $1.
 *   SUM_BID  mutually exclusive outcomes (negRisk event) whose YES bids add up to more than $1: buy NO on all of them; pays >= n-1 for less.
 *   SUM_ASK  the same outcomes whose YES asks add up to less than $1: buy YES on all; pays $1 ONLY IF a listed outcome wins (low confidence).
 *
 * Stage 1 screens gamma's quotes (cheap, can lag). Stage 2 re-prices the best candidates from live order books and measures depth.
 * Everything is before fees and assumes every leg fills at the price shown; a profit that needs ten legs to fill together is not free money.
 */

export type EdgeKind = 'LADDER' | 'SUM_BID' | 'SUM_ASK';

export interface Leg {
  cid: string;
  label: string;
  action: 'BUY YES' | 'BUY NO';
  /** Screen price from gamma quotes. */
  price: number;
  yesToken: string | null;
  noToken: string | null;
}

export interface EdgeCandidate {
  kind: EdgeKind;
  slug: string;
  title: string;
  legs: Leg[];
  /** Guaranteed minimum payoff of the whole set, in dollars per share set. */
  payoff: number;
  /** Cost of the set at screen prices; edge = payoff - cost (dollars per set, shown in points = x100). */
  cost: number;
  edgePts: number;
  confidence: 'medium' | 'low';
  /** Smallest liquidity among the legs' markets, and the event's 24h volume. */
  liqMin: number;
  vol24: number;
  caveats: string[];
  /** Set by verification: null = not checked. */
  verified: boolean | null;
  liveEdgePts: number | null;
  /** Dollars of the whole set you can buy at the best prices (smallest leg decides). */
  depthUsd: number | null;
  /** Profit if you buy that much: live edge x depth. The honest size of the opportunity. */
  profitUsd: number | null;
  /** Why verification could not confirm it. */
  note: string | null;
}

export interface ScanOptions {
  minEdge?: number; // dollars per set, default 0.02
  minLiq?: number; // per-market liquidity, default 500
  maxLegs?: number; // default 12
}

/** Edge (dollars per set) above which a candidate is flagged as probably a misreading. */
export const SUSPICIOUS = 0.25;

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const toks = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  try {
    const p = typeof v === 'string' ? JSON.parse(v) : [];
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
};

interface M {
  cid: string;
  label: string;
  question: string;
  bid: number;
  ask: number;
  liq: number;
  yesToken: string | null;
  noToken: string | null;
  endsAt: number | null;
}

function openMarkets(raw: Record<string, any>): { all: number; quoted: M[] } {
  const markets = ((raw.markets ?? []) as Array<Record<string, any>>).filter((m) => m.conditionId && !m.closed && m.active !== false && m.acceptingOrders !== false);
  const quoted: M[] = [];
  for (const m of markets) {
    const bid = num(m.bestBid);
    const ask = num(m.bestAsk);
    if (bid === null || ask === null || bid <= 0 || ask >= 1 || ask < bid) continue; // one-sided or empty books carry no tradable price
    const t = toks(m.clobTokenIds);
    quoted.push({ cid: String(m.conditionId), label: String(m.groupItemTitle || m.question || ''), question: String(m.question ?? ''), bid, ask, liq: num(m.liquidityNum) ?? num(m.liquidity) ?? 0, yesToken: t[0] ?? null, noToken: t[1] ?? null, endsAt: typeof m.endDate === 'string' && Number.isFinite(Date.parse(m.endDate)) ? Math.floor(Date.parse(m.endDate) / 1000) : null });
  }
  return { all: markets.length, quoted };
}

const legOf = (m: M, action: Leg['action'], price: number): Leg => ({ cid: m.cid, label: m.label, action, price, yesToken: m.yesToken, noToken: m.noToken });

function base(raw: Record<string, any>, kind: EdgeKind, legs: Leg[], payoff: number, cost: number, ms: readonly M[], caveats: string[], confidence: EdgeCandidate['confidence']): EdgeCandidate {
  return {
    kind, slug: String(raw.slug), title: String(raw.title ?? raw.slug), legs, payoff, cost, edgePts: (payoff - cost) * 100, confidence,
    liqMin: Math.min(...ms.map((m) => m.liq)), vol24: num(raw.volume24hr) ?? 0,
    // a free 25+ points on a liquid market is far more likely a misread of the rules or dates than a real gift
    caveats: payoff - cost >= SUSPICIOUS ? [`SUSPICIOUSLY LARGE (${((payoff - cost) * 100).toFixed(0)} points): read both markets' rules, deadlines and sources before believing it`, ...caveats] : caveats,
    verified: null, liveEdgePts: null, depthUsd: null, profitUsd: null, note: null,
  };
}

/** Stage 1: candidates from gamma's embedded quotes. Pure. */
export function screenEvent(raw: Record<string, any>, opts: ScanOptions = {}): EdgeCandidate[] {
  const minEdge = opts.minEdge ?? 0.02;
  const minLiq = opts.minLiq ?? 500;
  const maxLegs = opts.maxLegs ?? 12;
  const { all, quoted } = openMarkets(raw);
  const ms = quoted.filter((m) => m.liq >= minLiq);
  if (ms.length < 2) return [];
  const out: EdgeCandidate[] = [];

  // 1. ladders: out-of-order thresholds or dates
  const ladder = parseLadder(String(raw.title ?? ''), ms.map((m) => ({ cid: m.cid, label: m.label, question: m.question, endsAt: m.endsAt })));
  if (ladder) {
    const byCid = new Map(ms.map((m) => [m.cid, m]));
    const v = ladderViolations(ladder, new Map(ms.map((m) => [m.cid, { bid: m.bid, ask: m.ask }])))[0];
    if (v && v.edge >= minEdge) {
      const yes = byCid.get(v.yes.cid) as M;
      const no = byCid.get(v.no.cid) as M;
      out.push(base(raw, 'LADDER', [legOf(yes, 'BUY YES', yes.ask), legOf(no, 'BUY NO', 1 - no.bid)], 1, yes.ask + (1 - no.bid), [yes, no], [`pays at least $1 only if both markets settle from the same source and on the same facts (${ladder.kind === 'above' ? 'a higher threshold cannot be likelier than a lower one' : 'an earlier deadline cannot be likelier than a later one'})`, 'both legs must fill; if one fills and the other moves away you hold a plain bet'], 'medium'));
    }
  }

  // 2/3. mutually exclusive outcomes
  if (raw.negRisk === true && ms.length <= maxLegs) {
    const n = ms.length;
    const sumBid = ms.reduce((a, m) => a + m.bid, 0);
    if (sumBid - 1 >= minEdge) {
      out.push(base(raw, 'SUM_BID', ms.map((m) => legOf(m, 'BUY NO', 1 - m.bid)), n - 1, n - sumBid, ms, [`${n} legs must all fill; fees on any leg reduce the margin`, 'at most one outcome can win in a negRisk event, so NO on all of them pays at least n-1'], 'medium'));
    }
    const allQuoted = quoted.length === all && quoted.every((m) => m.liq >= minLiq);
    const sumAsk = ms.reduce((a, m) => a + m.ask, 0);
    if (allQuoted && 1 - sumAsk >= minEdge) {
      out.push(base(raw, 'SUM_ASK', ms.map((m) => legOf(m, 'BUY YES', m.ask)), 1, sumAsk, ms, ['pays $1 ONLY IF one of these listed outcomes wins: if the real winner is not listed (or nobody wins) every leg loses', `${n} legs must all fill`], 'low'));
    }
  }
  return out;
}

/** Stage 2: re-price from live order books. Mutates and returns the candidate. */
export async function verifyCandidate(client: PolymarketClient, c: EdgeCandidate): Promise<EdgeCandidate> {
  try {
    let cost = 0;
    let depthUsd = Infinity;
    for (const leg of c.legs) {
      const token = leg.action === 'BUY YES' ? leg.yesToken : leg.noToken;
      if (!token) throw new Error(`no token id for ${leg.label}`);
      const ask = (await client.book(token)).asks[0];
      if (!ask) throw new Error(`nothing to buy for ${leg.action} "${leg.label}"`);
      cost += ask.price;
      depthUsd = Math.min(depthUsd, ask.size * ask.price);
    }
    c.liveEdgePts = (c.payoff - cost) * 100;
    c.depthUsd = Number.isFinite(depthUsd) ? depthUsd : null;
    c.profitUsd = c.depthUsd === null ? null : (c.liveEdgePts / 100) * c.depthUsd;
    c.verified = c.liveEdgePts > 0;
    c.note = c.verified ? null : `live books price the set at ${cost.toFixed(3)} against a payoff of ${c.payoff.toFixed(2)}: the screen quote was stale`;
  } catch (error) {
    c.verified = null;
    c.note = `could not check live books: ${error instanceof Error ? error.message : String(error)}`;
  }
  return c;
}

export interface ScanResult {
  at: number; // epoch ms
  eventsScanned: number;
  marketsScanned: number;
  candidates: EdgeCandidate[];
  errors: string[];
}

export interface ScanRun extends ScanOptions {
  events?: number; // how many events to read, busiest first (default 400)
  verifyTop?: number; // default 12
  now?: () => number;
  onProgress?: (stage: string, partial: ScanResult) => void;
}

/** Ranks live-confirmed candidates first by the profit available at the depth you can buy, then unchecked ones by screen edge, stale ones last. */
export function rank(cs: EdgeCandidate[]): EdgeCandidate[] {
  const score = (c: EdgeCandidate): number => (c.verified === false ? -1000 : c.verified ? 1000 + (c.profitUsd ?? 0) : c.edgePts);
  return [...cs].sort((a, b) => score(b) - score(a) || b.liqMin - a.liqMin);
}

export async function scanAll(client: PolymarketClient, run: ScanRun = {}): Promise<ScanResult> {
  const now = run.now ?? Date.now;
  const result: ScanResult = { at: now(), eventsScanned: 0, marketsScanned: 0, candidates: [], errors: [] };
  const emit = (stage: string) => run.onProgress?.(stage, { ...result, candidates: [...result.candidates] });
  const want = run.events ?? 400;
  for (let offset = 0; offset < want; offset += 100) {
    emit(`reading events ${offset + 1}-${Math.min(want, offset + 100)}`);
    let page: Array<Record<string, any>> = [];
    try {
      page = await client.activeEventsRaw(offset, Math.min(100, want - offset));
    } catch (error) {
      result.errors.push(`events ${offset}+: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
    if (page.length === 0) break;
    for (const raw of page) {
      result.eventsScanned++;
      result.marketsScanned += ((raw.markets ?? []) as unknown[]).length;
      result.candidates.push(...screenEvent(raw, run));
    }
    result.candidates = rank(result.candidates);
    emit(`screened ${result.eventsScanned} events, ${result.candidates.length} candidate(s)`);
  }
  const top = result.candidates.slice(0, run.verifyTop ?? 12);
  for (const [i, c] of top.entries()) {
    emit(`checking live books ${i + 1}/${top.length}: ${c.title.slice(0, 40)}`);
    await verifyCandidate(client, c);
    result.candidates = rank(result.candidates);
  }
  emit('done');
  return result;
}

export function saveEdges(result: ScanResult, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...result, generatedAt: new Date(result.at).toISOString(), note: 'structural edges only, before fees; verify before acting' }, null, 2) + '\n');
}

export const EDGES_PATH = process.env.RADAR_EDGES ?? '.radar/edges.json';

export const KIND_TEXT: Record<EdgeKind, string> = { LADDER: 'LADDER', SUM_BID: 'SUM>1', SUM_ASK: 'SUM<1' };
