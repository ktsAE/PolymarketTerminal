import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decide, type DMarket, type Reference } from './decide.ts';
import { bookQuote } from './decide-data.ts';
import { ladderViolations, parseLadder } from './ladder.ts';
import { httpFetchJson, type FetchJson, type PolymarketClient } from './polymarket.ts';
import { fetchDexReference, loadRefs, refFor, type RefConfig } from './refs.ts';

/**
 * Edge scan over every active event: STRUCTURAL edges only, i.e. prices that contradict each other so that a set of bets pays more than it costs
 * whatever happens. Backtests (docs/research/radar/HOLDERS_STUDY.md) found no edge in holders, wallet form or price bands, so nothing here is a forecast.
 *
 *   LADDER   thresholds/dates priced out of order: buy YES on the easier rung and NO on the harder one for less than $1; pays >= $1.
 *   SUM_BID  mutually exclusive outcomes (negRisk event) whose YES bids add up to more than $1: buy NO on all of them; pays >= n-1 for less.
 *   SUM_ASK  the same outcomes whose YES asks add up to less than $1: buy YES on all; pays $1 ONLY IF a listed outcome wins (low confidence).
 *   REF      NOT structural: a rung of a token-FDV ladder whose live ask sits outside the fair-value RANGE that the Decision view (decide.ts)
 *            derives from a hand-configured external price (.radar/refs.json). A model call, always low confidence; its "payoff" is the model's
 *            nearest range edge, not a guaranteed payout. Token -> DEX pair mapping is never guessed (lookalike mints exist).
 *
 * Stage 1 screens gamma's quotes (cheap, can lag). Stage 2 re-prices the best candidates from live order books and measures depth.
 * Everything is before fees and assumes every leg fills at the price shown; a profit that needs ten legs to fill together is not free money.
 */

export type EdgeKind = 'LADDER' | 'SUM_BID' | 'SUM_ASK' | 'REF';

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
  /** Guaranteed minimum payoff of the whole set, in dollars per share set (REF: the model range's nearest edge, NOT guaranteed). */
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

/** Event titles that look like a token FDV / market-cap / token-price ladder (the kind an external DEX price can value). Majors' spot-price ladders are not included. */
export const TOKEN_LADDER_RE = /\bfdv\b|market ?cap|\bmcap\b|\btoken\b[^?]*\bprice\b|\bprice\b[^?]*\btoken\b/i;
export const looksLikeTokenLadder = (title: string): boolean => TOKEN_LADDER_RE.test(title) && !/\bIPO\b|\bstocks?\b|\bshares\b/i.test(title); // company market caps have no DEX price

export interface RefScanOptions {
  minEdge?: number; // dollars, default 0.02
  /** Active events to look through; when absent they are read from the client (busiest first). */
  events?: Array<Record<string, any>>;
  maxEvents?: number; // default 400, only when events are not given
  fetchJson?: FetchJson; // for the DEX reference, default httpFetchJson
  now?: () => number; // epoch ms
}

export interface RefScanResult {
  candidates: EdgeCandidate[];
  /** One entry per reference/event that could not be priced. */
  errors: string[];
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * External-price edges: for every active event matched by a refs.json entry, rebuild the Decision view's verdict (decide.ts, which owns the
 * fair-value math) from live order books and the DEX reference, and emit a REF candidate for each rung whose live ask is outside the model
 * range by >= minEdge. Never throws: per-reference failures land in `errors`.
 */
export async function scanReferenced(client: PolymarketClient, refs: readonly RefConfig[], opts: RefScanOptions = {}): Promise<RefScanResult> {
  const out: RefScanResult = { candidates: [], errors: [] };
  if (refs.length === 0) return out;
  const minEdge = opts.minEdge ?? 0.02;
  const now = opts.now ?? Date.now;
  let events = opts.events;
  if (!events) {
    events = [];
    const want = opts.maxEvents ?? 400;
    try {
      for (let off = 0; off < want; off += 100) {
        const page = await client.activeEventsRaw(off, Math.min(100, want - off));
        if (page.length === 0) break;
        events.push(...page);
      }
    } catch (error) {
      out.errors.push(`ref scan events: ${errText(error)}`);
    }
  }
  for (const raw of events) {
    const slug = String(raw.slug ?? '');
    const cfg = refFor(slug, refs);
    if (!cfg) continue;
    try {
      out.candidates.push(...(await refEvent(client, cfg, raw, minEdge, opts.fetchJson ?? httpFetchJson, Math.floor(now() / 1000))));
    } catch (error) {
      out.errors.push(`ref ${cfg.match} (${slug}): ${errText(error)}`);
    }
  }
  return out;
}

interface Priced {
  m: DMarket;
  raw: Record<string, any>;
  yesToken: string | null;
  noToken: string | null;
  /** Best NO ask and its top-level size, from the live NO book (null when not read). */
  noAsk: { price: number; size: number } | null;
  yesTop: { price: number; size: number } | null;
  live: boolean;
}

async function refEvent(client: PolymarketClient, cfg: RefConfig, raw: Record<string, any>, minEdge: number, fetchJson: FetchJson, nowSecs: number): Promise<EdgeCandidate[]> {
  const title = String(raw.title ?? raw.slug);
  const rows = ((raw.markets ?? []) as Array<Record<string, any>>).filter((m) => m.conditionId && !m.closed && m.active !== false && m.acceptingOrders !== false);
  if (rows.length === 0) return [];
  const priced: Priced[] = [];
  for (const r of rows) {
    const t = toks(r.clobTokenIds);
    const m: DMarket = {
      cid: String(r.conditionId), label: String(r.groupItemTitle || r.question || ''), question: String(r.question ?? ''), outcomes: ['Yes', 'No'], closed: false,
      yesBid: num(r.bestBid), yesAsk: num(r.bestAsk), last: num(r.lastTradePrice),
      endsAt: typeof r.endDate === 'string' && Number.isFinite(Date.parse(r.endDate)) ? Math.floor(Date.parse(r.endDate) / 1000) : null,
      askDepthSh: null, bidDepthSh: null, liq: num(r.liquidityNum) ?? num(r.liquidity) ?? 0, vol24: num(r.volume24hr) ?? 0,
    };
    const p: Priced = { m, raw: r, yesToken: t[0] ?? null, noToken: t[1] ?? null, noAsk: null, yesTop: null, live: false };
    try {
      if (!p.yesToken || !p.noToken) throw new Error('no token ids');
      const yb = await client.book(p.yesToken);
      const q = bookQuote(yb);
      m.yesBid = q.bid; m.yesAsk = q.ask; m.bidDepthSh = q.bidDepthSh; m.askDepthSh = q.askDepthSh;
      p.yesTop = yb.asks[0] ? { price: yb.asks[0].price, size: yb.asks[0].size } : null;
      const nb = await client.book(p.noToken);
      p.noAsk = nb.asks[0] ? { price: nb.asks[0].price, size: nb.asks[0].size } : null;
      p.live = true;
    } catch {
      // keep gamma's quote; the candidate is then unverified
    }
    priced.push(p);
  }

  const reference: Reference | null = await fetchDexReference(fetchJson, cfg, title, nowSecs);
  if (!reference) throw new Error('no pool with liquidity was found for the configured mint');
  const d = decide({ event: { slug: String(raw.slug), title, description: String(raw.description ?? '') }, markets: priced.map((p) => p.m), flows: {}, wallets: {}, reference, now: nowSecs });
  const refNotes = d.notes.filter((n) => /^reference |pools disagree|reference token is thin/.test(n));

  const out: EdgeCandidate[] = [];
  for (const md of d.markets) {
    if (!md.fair) continue;
    const p = priced.find((x) => x.m.cid === md.cid) as Priced;
    const { lo, hi } = md.fair;
    // YES is cheap when its ask is below the model's low end; NO is cheap when its ask is below 1 - the model's high end
    const yesAsk = p.m.yesAsk;
    const noAsk = p.live ? p.noAsk?.price ?? null : p.m.yesBid !== null ? 1 - p.m.yesBid : null;
    const pick = yesAsk !== null && lo - yesAsk >= minEdge ? { action: 'BUY YES' as const, ask: yesAsk, payoff: lo, top: p.yesTop }
      : noAsk !== null && 1 - hi - noAsk >= minEdge ? { action: 'BUY NO' as const, ask: noAsk, payoff: 1 - hi, top: p.noAsk }
      : null;
    if (!pick) continue;
    const edge = pick.payoff - pick.ask;
    const depthUsd = p.live && pick.top ? pick.top.size * pick.top.price : null;
    out.push({
      kind: 'REF', slug: String(raw.slug), title, payoff: pick.payoff, cost: pick.ask, edgePts: edge * 100, confidence: 'low',
      legs: [{ cid: md.cid, label: md.label, action: pick.action, price: pick.ask, yesToken: p.yesToken, noToken: p.noToken }],
      liqMin: p.m.liq, vol24: num(raw.volume24hr) ?? 0,
      caveats: [
        `model call, not an arbitrage: model range ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}% from ${reference.source}; "payoff" is the range's nearest edge and nothing is guaranteed`,
        ...(edge >= SUSPICIOUS ? [`SUSPICIOUSLY LARGE (${(edge * 100).toFixed(0)} points): check the mint, the launch time and the rules before believing it`] : []),
        ...md.reasons, ...md.risks, ...md.invalidates, ...refNotes, ...reference.checks.map((c) => `confirm: ${c}`),
      ],
      verified: p.live ? true : null, liveEdgePts: p.live ? edge * 100 : null, depthUsd, profitUsd: depthUsd === null ? null : edge * depthUsd,
      note: p.live ? null : 'priced from gamma quotes (live books could not be read): not confirmed',
    });
  }
  return out;
}

export interface ScanResult {
  at: number; // epoch ms
  eventsScanned: number;
  marketsScanned: number;
  candidates: EdgeCandidate[];
  errors: string[];
  /** Titles of active events that look like token FDV / market-cap / price ladders but match no refs.json entry (never auto-mapped). */
  unmapped: string[];
}

export interface ScanRun extends ScanOptions {
  events?: number; // how many events to read, busiest first (default 400)
  verifyTop?: number; // default 12
  now?: () => number;
  onProgress?: (stage: string, partial: ScanResult) => void;
  /** External references (default: loadRefs() from .radar/refs.json; [] disables REF rows). */
  refs?: readonly RefConfig[];
  fetchJson?: FetchJson;
}

/**
 * Ranks live-confirmed structural candidates first by the profit available at the depth you can buy, then unchecked ones and REF (model)
 * rows by edge (a REF row never outranks a live-confirmed structural one), stale ones last.
 */
export function rank(cs: EdgeCandidate[]): EdgeCandidate[] {
  const score = (c: EdgeCandidate): number => (c.verified === false ? -1000 : c.kind === 'REF' ? Math.min(999, c.liveEdgePts ?? c.edgePts) : c.verified ? 1000 + (c.profitUsd ?? 0) : c.edgePts);
  return [...cs].sort((a, b) => score(b) - score(a) || b.liqMin - a.liqMin);
}

export async function scanAll(client: PolymarketClient, run: ScanRun = {}): Promise<ScanResult> {
  const now = run.now ?? Date.now;
  const result: ScanResult = { at: now(), eventsScanned: 0, marketsScanned: 0, candidates: [], errors: [], unmapped: [] };
  let refs: readonly RefConfig[] = [];
  try {
    refs = run.refs ?? loadRefs();
  } catch (error) {
    result.errors.push(`refs: ${errText(error)}`);
  }
  const refEvents: Array<Record<string, any>> = [];
  const emit = (stage: string) => run.onProgress?.(stage, { ...result, candidates: [...result.candidates], unmapped: [...result.unmapped] });
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
      const slug = String(raw.slug ?? '');
      const title = String(raw.title ?? slug);
      if (refFor(slug, refs)) refEvents.push(raw);
      else if (looksLikeTokenLadder(title) && !result.unmapped.includes(title)) result.unmapped.push(title);
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
  if (refs.length > 0 && refEvents.length > 0) {
    emit(`pricing ${refEvents.length} referenced event(s) against external prices`);
    const r = await scanReferenced(client, refs, { events: refEvents, minEdge: run.minEdge, fetchJson: run.fetchJson, now });
    result.candidates = rank([...result.candidates, ...r.candidates]);
    result.errors.push(...r.errors);
  }
  emit('done');
  return result;
}

export function saveEdges(result: ScanResult, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...result, generatedAt: new Date(result.at).toISOString(), note: 'structural edges plus REF model calls (external price, low confidence), before fees; verify before acting' }, null, 2) + '\n');
}

export const EDGES_PATH = process.env.RADAR_EDGES ?? '.radar/edges.json';

export const KIND_TEXT: Record<EdgeKind, string> = { LADDER: 'LADDER', SUM_BID: 'SUM>1', SUM_ASK: 'SUM<1', REF: 'REF' };
