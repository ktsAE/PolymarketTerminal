/**
 * Ladders: one event, several markets that are the same question at different thresholds ("FDV above $30M / $45M / $70M",
 * "launch by Oct 31 / Nov 30"). Their prices must be ordered. When they are not, there is a trade that cannot lose
 * (assuming the markets resolve from the same source), which is the one kind of edge that needs no model.
 */

export interface LadderMarket {
  cid: string;
  label: string;
  question: string;
}
export interface LadderRung {
  cid: string;
  label: string;
  /** Threshold in dollars ('above'), or epoch seconds ('by-date'). */
  x: number;
}
export interface Ladder {
  kind: 'above' | 'by-date';
  rungs: LadderRung[]; // ascending x
}
export interface Quote {
  bid: number | null;
  ask: number | null;
}
export interface Violation {
  kind: Ladder['kind'];
  /** Buy YES here... */
  yes: LadderRung;
  /** ...and buy NO here. */
  no: LadderRung;
  /** Guaranteed profit per share pair before fees: payoff is at least $1 and the pair costs $1 less this. */
  edge: number;
  cost: number;
}

/** "$30M" -> 30e6, "1.5B" -> 1.5e9, "$250k" -> 250000, "100" -> 100. */
export function parseAmount(label: string): number | null {
  const m = /^\s*[<>≥≤]?\s*\$?\s*([\d,]+(?:\.\d+)?)\s*([kmbt])?\b/i.exec(label);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  const mult = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[(m[2] ?? '').toLowerCase() as 'k' | 'm' | 'b' | 't'] ?? 1;
  return Number.isFinite(n) ? n * mult : null;
}

const MONTHS = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i;
export function parseDate(label: string): number | null {
  if (!MONTHS.test(label) || !/\d/.test(label)) return null;
  const ms = Date.parse(`${label} 23:59:59 GMT`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const ABOVE = /\b(above|over|more than|greater|exceed|at least|reach|hit|surpass)\b/i;
const BY = /\b(by|before|on or before)\b/i;

/** Detects a ladder from the labels (groupItemTitle) of an event's markets; null when the markets are not one. */
export function parseLadder(title: string, markets: readonly LadderMarket[]): Ladder | null {
  if (markets.length < 2) return null;
  const amounts = markets.map((m) => parseAmount(m.label));
  const dates = markets.map((m) => parseDate(m.label));
  const text = `${title} ${markets[0].question}`;
  if (amounts.every((x) => x !== null) && ABOVE.test(text)) {
    return { kind: 'above', rungs: markets.map((m, i) => ({ cid: m.cid, label: m.label, x: amounts[i] as number })).sort((a, b) => a.x - b.x) };
  }
  if (dates.every((x) => x !== null) && BY.test(text)) {
    return { kind: 'by-date', rungs: markets.map((m, i) => ({ cid: m.cid, label: m.label, x: dates[i] as number })).sort((a, b) => a.x - b.x) };
  }
  return null;
}

/**
 * Executable-price check. For an 'above' ladder, P(above low) >= P(above high), so buying YES on the low rung and NO on
 * the high rung pays at least $1 in every outcome (2 in between). It costs ask(low) + 1 - bid(high); a violation is bid(high) > ask(low).
 * For a 'by-date' ladder an earlier date can never be likelier than a later one: buy YES late, NO early.
 */
export function ladderViolations(ladder: Ladder, quotes: ReadonlyMap<string, Quote>): Violation[] {
  const out: Violation[] = [];
  for (let i = 0; i < ladder.rungs.length; i++) {
    for (let j = i + 1; j < ladder.rungs.length; j++) {
      const lo = ladder.rungs[i];
      const hi = ladder.rungs[j];
      const qLo = quotes.get(lo.cid);
      const qHi = quotes.get(hi.cid);
      if (!qLo || !qHi) continue;
      // 'above': YES low / NO high.  'by-date': YES late (hi) / NO early (lo).
      const yes = ladder.kind === 'above' ? lo : hi;
      const no = ladder.kind === 'above' ? hi : lo;
      const askYes = ladder.kind === 'above' ? qLo.ask : qHi.ask;
      const bidNo = ladder.kind === 'above' ? qHi.bid : qLo.bid;
      if (askYes === null || bidNo === null) continue;
      const edge = bidNo - askYes;
      if (edge > 0) out.push({ kind: ladder.kind, yes, no, edge, cost: askYes + (1 - bidNo) });
    }
  }
  return out.sort((a, b) => b.edge - a.edge);
}
