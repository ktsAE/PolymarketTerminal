import { fairRange } from './fairvalue.ts';
import type { MarketFlow } from './flow.ts';
import { accountAge } from './identity.ts';
import { ladderViolations, parseLadder, type Ladder, type Violation } from './ladder.ts';
import { describePerson, LEAD_SCORE, type NameMatch } from './people.ts';

/**
 * What to do with each market of an event, and why.
 *
 * An EDGE is only claimed from things that can be measured:
 *   1. ladder arbitrage      - prices that are out of order and can be bought for less than their guaranteed payoff (no model);
 *   2. a fair-value RANGE    - from an external price (a token's DEX price) under a stated model, and only when the market sits
 *                              outside the whole range, not just outside its middle;
 *   3. nothing else.
 * Wallet signals (new accounts, names that resemble people on the watchlist, who is buying) are LEADS and risk notes. The backtests in
 * docs/research/radar/HOLDERS_STUDY.md found no measurable edge from following holders, so they never turn into BUY on their own.
 */

export const DECIDE_VERSION = 'v0.1-decision';

export type Action = 'BUY YES' | 'BUY NO' | 'ARB' | 'WATCH' | 'NO EDGE' | 'AVOID';

export interface DMarket {
  cid: string;
  label: string;
  question: string;
  outcomes: string[];
  closed: boolean;
  yesBid: number | null;
  yesAsk: number | null;
  last: number | null;
  /** Shares resting within 3 points of the best price, on each side of the first outcome's book. */
  askDepthSh: number | null;
  bidDepthSh: number | null;
  liq: number;
  vol24: number;
}

export interface DWallet {
  wallet: string;
  name: string | null;
  /** Which outcome it holds (0 = first outcome), null if unknown. */
  side: 0 | 1 | null;
  shares: number;
  posUsd: number | null;
  createdAt: number | null;
  cls: string;
  traded: number | null;
  pnlAll: number | null;
  xUsername: string | null;
  matches: NameMatch[];
}

export interface Reference {
  kind: 'token-fdv';
  source: string;
  mint: string;
  spotPrice: number;
  spotFdv: number;
  supply: number;
  sigmaDay: number;
  asOf: number;
  /** First pool creation, epoch seconds. */
  launchAt: number | null;
  /** When the market measures the FDV, epoch seconds (null when it cannot be derived yet). */
  resolveAt: number | null;
  pools: number;
  liqUsd: number;
  vol1hUsd: number;
  /** max/min price across pools with real liquidity, minus 1. */
  priceSpread: number | null;
  /** Things the user must confirm by hand (e.g. that the mint is the official one). */
  checks: string[];
}

export interface DEvent {
  slug: string;
  title: string;
  description: string;
}

export interface DecideInput {
  event: DEvent;
  markets: DMarket[];
  flows: Record<string, MarketFlow | undefined>;
  wallets: Record<string, DWallet[] | undefined>;
  reference: Reference | null;
  /** Why the configured reference could not be read (when it was configured but is null): "no edge" must not be reported as a verdict then. */
  referenceError?: string | null;
  now: number; // epoch seconds
}

export interface Lead {
  kind: 'MATCH' | 'NEW';
  wallet: string;
  name: string | null;
  side: 0 | 1 | null;
  text: string;
  score: number;
}

export interface MarketDecision {
  cid: string;
  label: string;
  outcomes: string[];
  action: Action;
  /** Outcome index to buy (0 = first outcome), for BUY and ARB. */
  side: 0 | 1 | null;
  edgePts: number | null;
  fair: { lo: number; hi: number } | null;
  yesBid: number | null;
  yesAsk: number | null;
  spread: number | null;
  capacityUsd: number | null;
  /** Dollars buying each outcome in the last hour, when trades were read. */
  flow1h: { first: number; second: number } | null;
  confidence: 'low' | 'medium';
  reasons: string[];
  context: string[];
  risks: string[];
  invalidates: string[];
  leads: Lead[];
}

export interface Decision {
  version: string;
  slug: string;
  title: string;
  asOf: number;
  markets: MarketDecision[];
  notes: string[];
  headline: string;
  ladder: Ladder | null;
  reference: Reference | null;
}

export const T = {
  /** Smallest guaranteed profit per share pair worth calling an ARB. */
  arbMin: 0.015,
  /** Distance outside the whole model range before a market is called mispriced. */
  modelMin: 0.05,
  /** A price this close to 0 or 1 is already decided. */
  decided: 0.97,
  wideSpread: 0.08,
  thinUsd: 300,
  /** A new account must hold at least this much to be a lead. */
  newLeadUsd: 300,
  topWalletShare: 0.5,
} as const;

const usd = (n: number): string => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : `$${Math.round(n)}`);
const pts = (x: number): string => `${(x * 100).toFixed(0)}`;
const clock = (secs: number): string => new Date(secs * 1000).toISOString().slice(5, 16).replace('T', ' ') + 'Z';

/** Phrases in a market's rules that leave room for interpretation. */
export function rulesAmbiguity(description: string): string[] {
  const out: string[] = [];
  if (/\bofficial(ly)?\b/i.test(description)) out.push('depends on what counts as "official"');
  if (/credible reporting|consensus/i.test(description)) out.push('settled on a judgment of "credible reporting"');
  if (/actively and publicly tradable|publicly tradable/i.test(description)) out.push('needs the token "actively and publicly tradable" (not defined)');
  return out;
}

function leadsFor(ws: readonly DWallet[], outcomes: readonly string[], nowSecs: number): Lead[] {
  const leads: Lead[] = [];
  for (const w of ws) {
    const who = w.name ?? `${w.wallet.slice(0, 8)}…`;
    const side = w.side === null ? '' : ` ${outcomes[w.side] ?? `#${w.side}`}`;
    const stake = w.posUsd !== null ? ` ${usd(w.posUsd)}` : '';
    const m = w.matches.find((x) => x.score >= LEAD_SCORE);
    if (m) leads.push({ kind: 'MATCH', wallet: w.wallet, name: w.name, side: w.side, score: m.score, text: `${who}${stake}${side}: ${m.why}; the watchlist has ${describePerson(m.person)}. A name match only: unverified` });
    const age = accountAge(w.createdAt, nowSecs);
    if (age.isNew && (w.posUsd ?? 0) >= T.newLeadUsd) leads.push({ kind: 'NEW', wallet: w.wallet, name: w.name, side: w.side, score: 30, text: `${who}${stake}${side}: account created ${age.label}` });
  }
  return leads.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
}

function contextFor(flow: MarketFlow | undefined): string[] {
  if (!flow || flow.fills === 0) return [];
  const w1 = flow.windows[0];
  const w24 = flow.windows[2];
  const out = [`last hour: ${usd(w1.yesUsd)} bought the first outcome vs ${usd(w1.noUsd)} the second (${w1.fills} fills, ${w1.wallets} wallets); 24h: ${usd(w24.yesUsd)} vs ${usd(w24.noUsd)}`];
  if (flow.priceNow !== null && flow.price6h !== null) out.push(`price ${flow.price6h.toFixed(2)} six hours ago, ${flow.priceNow.toFixed(2)} at the last fill`);
  return out;
}

export function decide(inp: DecideInput): Decision {
  const { event, markets, reference: ref, now } = inp;
  const ladder = parseLadder(event.title, markets.filter((m) => !m.closed).map((m) => ({ cid: m.cid, label: m.label, question: m.question })));
  const quotes = new Map(markets.map((m) => [m.cid, { bid: m.yesBid, ask: m.yesAsk }]));
  const violations: Violation[] = ladder ? ladderViolations(ladder, quotes) : [];
  const ambiguity = rulesAmbiguity(event.description);
  const isFdvEvent = /\bfdv\b|market cap|mcap/i.test(event.title);

  const decided = markets.map((m): MarketDecision => {
    const spread = m.yesBid !== null && m.yesAsk !== null ? m.yesAsk - m.yesBid : null;
    const mid = m.yesBid !== null && m.yesAsk !== null ? (m.yesBid + m.yesAsk) / 2 : m.last;
    const d: MarketDecision = {
      cid: m.cid, label: m.label, outcomes: m.outcomes, action: 'NO EDGE', side: null, edgePts: null, fair: null, yesBid: m.yesBid, yesAsk: m.yesAsk, spread, capacityUsd: null,
      flow1h: inp.flows[m.cid] && inp.flows[m.cid]!.fills > 0 ? { first: inp.flows[m.cid]!.windows[0].yesUsd, second: inp.flows[m.cid]!.windows[0].noUsd } : null,
      confidence: 'low', reasons: [], context: contextFor(inp.flows[m.cid]), risks: [], invalidates: [], leads: leadsFor(inp.wallets[m.cid] ?? [], m.outcomes, now),
    };
    const flow = inp.flows[m.cid];
    if (spread !== null && spread >= T.wideSpread) d.risks.push(`wide spread: ${pts(spread)} points between bid and ask`);
    if (m.liq > 0 && m.liq < 5_000) d.risks.push(`thin book: ${usd(m.liq)} of resting liquidity`);
    if (flow && flow.topWalletShare >= T.topWalletShare) d.risks.push(`one wallet did ${Math.round(flow.topWalletShare * 100)}% of the last 24h's dollars`);
    for (const a of ambiguity) d.risks.push(`rules ${a}`);

    if (m.closed) return { ...d, action: 'AVOID', reasons: ['market is closed'] };
    if (mid === null) return { ...d, action: 'AVOID', reasons: ['no price: nobody has quoted or traded it'] };
    if (mid >= T.decided || mid <= 1 - T.decided) return { ...d, action: 'AVOID', reasons: [`priced at ${mid.toFixed(2)}: already treated as decided`] };

    // 1. structure: a guaranteed pair
    const arb = violations.find((v) => (v.yes.cid === m.cid || v.no.cid === m.cid) && v.edge >= T.arbMin);
    if (arb) {
      const buyYes = arb.yes.cid === m.cid;
      const other = buyYes ? arb.no : arb.yes;
      return {
        ...d, action: 'ARB', side: buyYes ? 0 : 1, edgePts: arb.edge * 100, confidence: 'medium',
        reasons: [`prices are out of order: buy YES "${arb.yes.label}" and NO "${arb.no.label}" together for ${arb.cost.toFixed(3)}; they pay at least $1 in every outcome, ${pts(arb.edge)} points locked in before fees (this leg: ${buyYes ? 'YES' : 'NO'}, the other: "${other.label}")`],
        invalidates: ['one leg fills and the other moves away', 'the two markets resolve from different sources', 'fees on either leg exceed the locked-in margin'],
      };
    }

    // 2. external reference with a model range
    const rung = ladder?.kind === 'above' ? ladder.rungs.find((r) => r.cid === m.cid) : undefined;
    if (ref && isFdvEvent && rung && m.yesBid !== null && m.yesAsk !== null) {
      if (ref.resolveAt === null) {
        d.reasons.push('the FDV is measured a day after launch and the launch time is not known yet, so there is no fair value');
      } else if (ref.resolveAt <= now) {
        d.reasons.push(`measurement time ${clock(ref.resolveAt)} has passed; the market should be settling`);
      } else {
        const days = (ref.resolveAt - now) / 86_400;
        const fair = fairRange(ref.spotFdv, rung.x, ref.sigmaDay, days);
        d.fair = { lo: fair.lo, hi: fair.hi };
        const edgeYes = fair.lo - m.yesAsk;
        const edgeNo = m.yesBid - fair.hi;
        const head = `FDV now ${usd(ref.spotFdv)}; chance it is above ${usd(rung.x)} at ${clock(ref.resolveAt)}: model ${pts(fair.lo)}-${pts(fair.hi)}%, market ${pts(m.yesBid)}/${pts(m.yesAsk)}`;
        if (edgeYes >= T.modelMin) {
          d.action = 'BUY YES'; d.side = 0; d.edgePts = edgeYes * 100;
          d.reasons.push(`${head}: even the model's low end is ${pts(edgeYes)} points above the ask`);
          d.capacityUsd = m.askDepthSh !== null ? m.askDepthSh * m.yesAsk : null;
        } else if (edgeNo >= T.modelMin) {
          d.action = 'BUY NO'; d.side = 1; d.edgePts = edgeNo * 100;
          d.reasons.push(`${head}: the bid is ${pts(edgeNo)} points above even the model's high end`);
          d.capacityUsd = m.bidDepthSh !== null ? m.bidDepthSh * (1 - m.yesBid) : null;
        } else d.reasons.push(`${head}: the market sits inside the model's range, so no edge`);
        if ((d.action === 'BUY YES' || d.action === 'BUY NO') && d.capacityUsd !== null && d.capacityUsd < T.thinUsd) d.risks.push(`only ~${usd(d.capacityUsd)} can be bought within 3 points of that price: the edge exists on paper but not at size`);
        d.invalidates.push(`the token's price moves (every 10% move shifts these ranges)`, `the model leaves out sell pressure from unlocked airdrop/sale tokens and any exchange listing news`, `the reference price comes from ${ref.pools} pool(s) with ${usd(ref.liqUsd)} of liquidity, easy to move`);
        d.risks.push(`model range assumes ${Math.round(ref.sigmaDay * 100)}%/day volatility, tried at 0.5x to 1.5x, with and without a drift term`);
        d.risks.push(`measurement time ${clock(ref.resolveAt)} assumes the first DEX pool was "the launch"; if the launch-date market is ruled differently, the FDV is measured a day after whenever the launch is ruled to happen`);
      }
    }

    // 3. "by date" launch markets: the facts are knowable, the ruling is not
    if (d.action === 'NO EDGE' && ladder?.kind === 'by-date' && ref) {
      d.action = 'WATCH';
      d.reasons.push(`the token has traded since ${ref.launchAt ? clock(ref.launchAt) : '?'} on ${ref.pools} pool(s) holding ${usd(ref.liqUsd)}, so the "tradable" part looks met; whether that counts as the project officially launching is a ruling, not something to model`);
      for (const c of ref.checks) d.invalidates.push(`confirm: ${c}`);
    }

    // 4. leads never create a trade, but a strong one deserves attention
    const strong = d.leads.find((l) => l.kind === 'MATCH' && l.score >= 85);
    if (d.action === 'NO EDGE' && strong) {
      d.action = 'WATCH';
      d.reasons.push(`a top wallet's name closely matches a person on the watchlist: ${strong.text}`);
    }
    if (d.action === 'NO EDGE' && d.reasons.length === 0) {
      d.reasons.push(
        ref ? 'priced inside what the available data supports'
        : inp.referenceError ? `the reference price could not be read (${inp.referenceError}), so this is NOT a verdict: run it again`
        : 'no external reference and no ladder inconsistency: nothing here beats the price',
      );
    }
    return d;
  });

  const notes: string[] = [];
  if (!ref && inp.referenceError) notes.push(`reference price unavailable: ${inp.referenceError}. Model-based calls were skipped`);
  if (ladder) notes.push(`${ladder.rungs.length}-rung ${ladder.kind === 'above' ? 'threshold' : 'date'} ladder${violations.length ? `: ${violations.length} ordering violation(s)` : ': prices are in order'}`);
  if (ref) {
    notes.push(`reference ${ref.source}: price ${ref.spotPrice < 0.01 ? ref.spotPrice.toPrecision(3) : ref.spotPrice.toFixed(4)} = FDV ${usd(ref.spotFdv)} at ${clock(ref.asOf)}; ${ref.pools} pool(s), ${usd(ref.liqUsd)} liquidity, ${usd(ref.vol1hUsd)} volume in the last hour`);
    if (ref.priceSpread !== null && ref.priceSpread > 0.1) notes.push(`pools disagree by ${Math.round(ref.priceSpread * 100)}%: the "most liquid source" the rules name may be easy to move`);
    if (ref.liqUsd < 250_000) notes.push(`the reference token is thin (${usd(ref.liqUsd)} liquidity): a single trade can move the settlement price`);
  }
  for (const a of ambiguity) notes.push(`rules ${a}`);
  notes.push('wallet findings below are leads, not an edge: backtests found no measurable edge from following top holders');

  const buys = decided.filter((x) => x.action === 'BUY YES' || x.action === 'BUY NO').length;
  const arbs = decided.filter((x) => x.action === 'ARB').length;
  const watch = decided.filter((x) => x.action === 'WATCH').length;
  const base = buys + arbs > 0 ? `${arbs ? `${arbs} arbitrage leg(s)` : ''}${arbs && buys ? ' · ' : ''}${buys ? `${buys} model-based call(s) (low confidence)` : ''}` : watch > 0 ? 'no measurable edge; some markets deserve a look (see WATCH)' : 'no measurable edge found';
  const headline = !ref && inp.referenceError ? `reference price unavailable, model skipped: ${base}` : base;
  return { version: DECIDE_VERSION, slug: event.slug, title: event.title, asOf: now, markets: decided, notes, headline, ladder, reference: ref };
}
