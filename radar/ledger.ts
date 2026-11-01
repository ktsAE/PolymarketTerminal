import type { OutcomeQuote, ResultLine, SnapshotLine, WindowLabel } from './forward.ts';

/**
 * Pre-registered paper-trading ledger over the forward logs (radar/forward.ts).
 * The strategies below were fixed in code before any forward data existed. Do not tune them on the data they score:
 * a changed rule is a new strategy with a new id, scored only on games logged after the change.
 */

/** A bet on one outcome of one market, filled at `price` (the T-5m ask, so the spread is paid). */
export interface Bet {
  outcomeIdx: number;
  price: number;
}

/** The valid snapshots of one cid, by window label. A label is absent when it was never logged or its book was one-sided. */
export type CidSnapshots = Partial<Record<WindowLabel, SnapshotLine>>;

export interface Strategy {
  id: string;
  description: string;
  pick: (snaps: CidSnapshots) => Bet | null;
}

/** Minimum move in mid between T-8h and T-5m for the move strategies. */
export const MOVE_THRESHOLD = 0.03;
/** A strategy gets a non-null verdict only with at least this many bets... */
export const MIN_BETS = 300;
/** ...and a lower bound of this two-sided bootstrap CI above 0. 99%, not 95%: five strategies are tested at once. */
export const CI_LEVEL = 0.99;
export const NO_EDGE = 'NO EDGE PROVEN';
export const EDGE = 'EDGE: 99% CI of ROI above 0';
export const DEFAULT_BOOTSTRAP = { iterations: 2000, seed: 20261101 };

const EPS = 1e-9;

/** The T-5m ask of outcome i, if it is a tradable price. */
function entry(snaps: CidSnapshots, i: number): Bet | null {
  const ask = snaps['T-5m']?.quotes[i]?.ask;
  return typeof ask === 'number' && ask > 0 && ask < 1 ? { outcomeIdx: i, price: ask } : null;
}

/** Index of the single outcome maximising `score`, or null on a tie or an empty list. */
function argmaxUnique(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (xs[i] > xs[best]) best = i;
  return xs.filter((x) => Math.abs(x - xs[best]) < EPS).length === 1 ? best : null;
}

/** Change in mid per outcome from T-8h to T-5m, or null when either snapshot is missing. */
function moves(snaps: CidSnapshots): number[] | null {
  const a = snaps['T-8h'];
  const b = snaps['T-5m'];
  if (!a || !b) return null;
  return b.quotes.map((q, i) => q.mid - a.quotes[i].mid);
}

const mids = (snaps: CidSnapshots, label: WindowLabel): number[] | null => snaps[label]?.quotes.map((q) => q.mid) ?? null;

export const STRATEGIES: readonly Strategy[] = [
  {
    id: 'fade-move',
    description: `buy the side whose mid fell >= ${MOVE_THRESHOLD} from T-8h to T-5m, at the T-5m ask`,
    pick: (s) => {
      const m = moves(s);
      if (!m) return null;
      const i = argmaxUnique(m.map((x) => -x));
      return i !== null && m[i] <= -MOVE_THRESHOLD + EPS ? entry(s, i) : null;
    },
  },
  {
    id: 'follow-move',
    description: `control: buy the side whose mid rose >= ${MOVE_THRESHOLD} from T-8h to T-5m, at the T-5m ask`,
    pick: (s) => {
      const m = moves(s);
      if (!m) return null;
      const i = argmaxUnique(m);
      return i !== null && m[i] >= MOVE_THRESHOLD - EPS ? entry(s, i) : null;
    },
  },
  {
    id: 'favorite',
    description: 'control: buy the highest T-5m mid, at the T-5m ask',
    pick: (s) => {
      const m = mids(s, 'T-5m');
      const i = m ? argmaxUnique(m) : null;
      return i === null ? null : entry(s, i);
    },
  },
  {
    id: 'underdog',
    description: 'control: buy the lowest T-5m mid, at the T-5m ask',
    pick: (s) => {
      const m = mids(s, 'T-5m');
      const i = m ? argmaxUnique(m.map((x) => -x)) : null;
      return i === null ? null : entry(s, i);
    },
  },
  {
    id: 'top-holders-lean',
    description: 'buy the side holding more top-10-holder dollars (shares x T-2h mid) at T-2h, at the T-5m ask; only where holders were logged',
    pick: (s) => {
      const t2 = s['T-2h'];
      if (!t2 || !t2.holders || !t2.holders.length) return null;
      const usd = t2.outcomes.map(() => 0);
      for (const h of t2.holders) if (h.outcomeIndex >= 0 && h.outcomeIndex < usd.length && Number.isFinite(h.size)) usd[h.outcomeIndex] += h.size * t2.quotes[h.outcomeIndex].mid;
      const i = argmaxUnique(usd);
      return i === null || usd[i] <= 0 ? null : entry(s, i);
    },
  },
];

// ---- scoring ----

export interface ScoredBet extends Bet {
  cid: string;
  slug: string;
  /** UTC day of game start, YYYY-MM-DD: the bootstrap cluster. */
  day: string;
  /** Payout per share of the backed outcome: 1 win, 0 loss, 0.5 even void split. */
  payout: number;
  /** Profit per $1 staked: payout / price - 1. */
  ret: number;
}

export interface StrategyScore {
  id: string;
  description: string;
  n: number;
  events: number;
  days: number;
  wins: number;
  voids: number;
  /** wins / n, or null with no bets. */
  hitRate: number | null;
  /** Mean entry price: the hit rate needed to break even, the base rate the hit rate is read against. */
  breakEven: number | null;
  /** Mean profit per $1 staked. */
  roi: number | null;
  /** Day-clustered percentile bootstrap CI of roi at CI_LEVEL, or null with no bets. */
  ci: [number, number] | null;
  verdict: string;
  bets: ScoredBet[];
}

export interface LedgerReport {
  /** Distinct cids with at least one valid snapshot. */
  markets: number;
  /** Of those, cids with a result line. */
  settled: number;
  /** Snapshot lines dropped: malformed, one-sided book, or a duplicate cid+label. */
  skippedSnapshots: number;
  ciLevel: number;
  minBets: number;
  iterations: number;
  seed: number;
  strategies: StrategyScore[];
}

export interface ScoreOptions {
  iterations?: number;
  seed?: number;
  strategies?: readonly Strategy[];
}

const LABELS: readonly WindowLabel[] = ['T-8h', 'T-2h', 'T-5m'];

function validQuote(q: OutcomeQuote | undefined): boolean {
  return !!q && [q.bid, q.ask, q.mid].every(Number.isFinite) && q.bid > 0 && q.ask < 1 && q.ask >= q.bid;
}

/** A snapshot line usable for scoring: known label, every outcome quoted on both sides. */
export function validSnapshot(x: unknown): x is SnapshotLine {
  const s = x as SnapshotLine;
  return (
    !!s &&
    typeof s.cid === 'string' &&
    LABELS.includes(s.label) &&
    typeof s.startTs === 'number' &&
    Number.isFinite(s.startTs) &&
    Array.isArray(s.outcomes) &&
    s.outcomes.length >= 2 &&
    Array.isArray(s.quotes) &&
    s.quotes.length === s.outcomes.length &&
    s.quotes.every(validQuote)
  );
}

/** Groups valid snapshots by cid, keeping the first line per cid+label. */
export function groupSnapshots(snapshots: readonly unknown[]): { byCid: Map<string, CidSnapshots>; skipped: number } {
  const byCid = new Map<string, CidSnapshots>();
  let skipped = 0;
  for (const s of snapshots) {
    if (!validSnapshot(s)) {
      skipped++;
      continue;
    }
    const g = byCid.get(s.cid) ?? {};
    if (g[s.label]) {
      skipped++;
      continue;
    }
    g[s.label] = s;
    byCid.set(s.cid, g);
  }
  return { byCid, skipped };
}

/** Deterministic PRNG (mulberry32) in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: readonly number[], p: number): number {
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Percentile bootstrap CI of mean return, resampling whole UTC days with replacement
 * (games on one day share news, line moves and liquidity, so they are not independent).
 */
export function dayClusteredCi(bets: ReadonlyArray<{ day: string; ret: number }>, level = CI_LEVEL, iterations = DEFAULT_BOOTSTRAP.iterations, seed = DEFAULT_BOOTSTRAP.seed): [number, number] | null {
  if (!bets.length) return null;
  const byDay = new Map<string, { sum: number; n: number }>();
  for (const b of bets) {
    const d = byDay.get(b.day) ?? { sum: 0, n: 0 };
    d.sum += b.ret;
    d.n++;
    byDay.set(b.day, d);
  }
  const days = [...byDay.keys()].sort().map((k) => byDay.get(k)!);
  const rng = mulberry32(seed);
  const stats: number[] = [];
  for (let it = 0; it < iterations; it++) {
    let sum = 0;
    let n = 0;
    for (let j = 0; j < days.length; j++) {
      const d = days[Math.floor(rng() * days.length)];
      sum += d.sum;
      n += d.n;
    }
    stats.push(sum / n);
  }
  stats.sort((a, b) => a - b);
  const tail = (1 - level) / 2;
  return [quantile(stats, tail), quantile(stats, 1 - tail)];
}

export function verdictOf(n: number, ci: [number, number] | null): string {
  return n >= MIN_BETS && ci !== null && ci[0] > 0 ? EDGE : NO_EDGE;
}

const utcDay = (secs: number): string => new Date(secs * 1000).toISOString().slice(0, 10);

/** Scores every pre-registered strategy on the forward logs. Only cids with a result line produce bets. */
export function scoreLedger(snapshots: readonly unknown[], results: readonly unknown[], opts: ScoreOptions = {}): LedgerReport {
  const iterations = opts.iterations ?? DEFAULT_BOOTSTRAP.iterations;
  const seed = opts.seed ?? DEFAULT_BOOTSTRAP.seed;
  const { byCid, skipped } = groupSnapshots(snapshots);
  const res = new Map<string, ResultLine>();
  for (const r of results as ResultLine[]) if (r && typeof r.cid === 'string' && Array.isArray(r.payout) && !res.has(r.cid)) res.set(r.cid, r);
  const cids = [...byCid.keys()].sort();
  const settled = cids.filter((c) => res.has(c));

  const strategies = (opts.strategies ?? STRATEGIES).map((st): StrategyScore => {
    const bets: ScoredBet[] = [];
    for (const cid of settled) {
      const snaps = byCid.get(cid)!;
      const bet = st.pick(snaps);
      if (!bet) continue;
      const payout = Number(res.get(cid)!.payout[bet.outcomeIdx]);
      if (!Number.isFinite(payout) || !(bet.price > 0 && bet.price < 1)) continue;
      const any = (snaps['T-5m'] ?? snaps['T-2h'] ?? snaps['T-8h'])!;
      bets.push({ ...bet, cid, slug: any.slug, day: utcDay(any.startTs), payout, ret: payout / bet.price - 1 });
    }
    const n = bets.length;
    const mean = (f: (b: ScoredBet) => number): number | null => (n ? bets.reduce((a, b) => a + f(b), 0) / n : null);
    const wins = bets.filter((b) => b.payout >= 0.99).length;
    const ci = dayClusteredCi(bets, CI_LEVEL, iterations, seed);
    return {
      id: st.id,
      description: st.description,
      n,
      events: new Set(bets.map((b) => b.slug)).size,
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
  return { markets: cids.length, settled: settled.length, skippedSnapshots: skipped, ciLevel: CI_LEVEL, minBets: MIN_BETS, iterations, seed, strategies };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;

/** Plain text lines for the CLI/TUI. A hit rate is always printed next to its break-even base rate. */
export function formatLedger(report: LedgerReport): string[] {
  const lines = [
    `Pre-registered paper ledger: ${report.settled}/${report.markets} logged markets settled, ${report.skippedSnapshots} snapshot lines skipped`,
    `Verdict needs n>=${report.minBets} bets and the ${pct(report.ciLevel)} day-clustered bootstrap CI of ROI above 0 (${report.iterations} resamples, seed ${report.seed}). Fill = T-5m ask.`,
  ];
  for (const s of report.strategies) {
    if (!s.n || s.hitRate === null || s.breakEven === null || s.roi === null || !s.ci) {
      lines.push(`${s.id.padEnd(17)} n=0  no settled bets yet  ${s.verdict}`);
      continue;
    }
    lines.push(
      `${s.id.padEnd(17)} n=${s.n} (${s.events} events, ${s.days} days)  hit ${pct(s.hitRate)} vs break-even ${pct(s.breakEven)}  ROI/$1 ${signed(s.roi)}  ${pct(report.ciLevel)} CI [${signed(s.ci[0])}, ${signed(s.ci[1])}]  ${s.verdict}`,
    );
  }
  return lines;
}
