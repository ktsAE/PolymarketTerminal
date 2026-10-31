import type { PrintRow, SnapRow } from './store.ts';

/**
 * Market-wide anomaly detectors. Every rule is a named, explainable indicator with points;
 * nothing here claims intent. Rules that need history (open-interest jumps) stay silent until the
 * app has watched long enough, and the result says so instead of pretending.
 */

export const DETECT_VERSION = 'v0.2-scanner';

export type Level = 'NONE' | 'WATCH' | 'HOT';
export interface Reason {
  code: string;
  points: number;
  text: string;
}

export interface WalletTag {
  /** NEW: first activity under 14 days ago; THIN: 5 or fewer markets ever; WHALE: 200+ markets; REG: everything else; ? = not profiled yet. */
  kind: 'NEW' | 'THIN' | 'WHALE' | 'REG' | '?';
  ageDays: number | null;
  traded: number | null;
}

export interface PrintFlow {
  usd1h: number;
  prints1h: number;
  biggestUsd: number;
  freshUsd: number;
  freshWallets: number;
  cluster: boolean;
  /** The single largest fill in the last hour, for display. */
  top: { usd: number; wallet: string; tag: WalletTag['kind']; outcome: string | null; side: 'BUY' | 'SELL' } | null;
}

export interface Anomaly {
  eventId: string;
  slug: string;
  title: string;
  cat: string;
  isGame: boolean;
  /** Scheduled start (epoch seconds) for games. */
  startsAt: number | null;
  score: number;
  level: Level;
  reasons: Reason[];
  notes: string[];
  m: {
    oi: number;
    dOi1h: number | null;
    dOi1hPct: number | null;
    dOi1hSpanMin: number | null;
    dOi15m: number | null;
    dOi15mPct: number | null;
    dOi24h: number | null;
    dOi24hPct: number | null;
    vol24: number;
    accel: number | null;
    turnover: number | null;
    liq: number;
    price: number | null;
    ch1h: number | null;
    ch1d: number | null;
    /** Price change over about the last 30 minutes, from our own snapshots. */
    dPrice30m: number | null;
  };
  flow: PrintFlow | null;
}

export const D = {
  minVol24: 40_000,
  oiJump15mMinUsd: 15_000,
  oiJump15mPct: 0.03,
  oiJump1hMinUsd: 25_000,
  oiJump1hPct: 0.05,
  oiJump1hBigPct: 0.15,
  oiMove24hMinUsd: 100_000,
  oiMove24hPct: 0.1,
  accelMin: 3,
  accelBig: 6,
  accelBaselineMin: 1_000,
  newMarketDays: 7,
  turnoverMin: 3,
  turnoverMinVol: 100_000,
  turnoverMinOi: 10_000,
  priceMove1h: 0.1,
  priceMove1hBig: 0.2,
  priceMove1d: 0.25,
  thinLiqRatio: 0.05,
  thinLiqMinVol: 100_000,
  flowMinUsd1h: 50_000,
  freshWalletDays: 14,
  freshWalletMaxMarkets: 10,
  thinMaxMarkets: 5,
  whaleMinMarkets: 200,
  clusterMinWallets: 3,
  clusterMinUsd: 5_000,
  clusterWindowSecs: 1_800,
  watch: 25,
  hot: 50,
  /** History is usable when it covers at least this share of the window (and at most 2x of it). */
  minSpanShare: 0.5,
  /** Markets ending within this many hours are structurally volatile. */
  nearExpiryHours: 36,
} as const;

export type PastFn = (eventId: string, ts: number) => SnapRow | undefined;

const usd = (n: number): string => {
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
  return `${sign}$${Math.round(a)}`;
};
const pct = (x: number): string => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(x !== 0 && Math.abs(x) < 0.1 ? 1 : 0)}%`;

interface Delta {
  abs: number;
  pct: number;
  spanSecs: number;
}

/** Change of `field` versus ~`windowSecs` ago; null when our history is too short or too stale for that window. */
function delta(s: SnapRow, past: PastFn, windowSecs: number, field: 'oi'): Delta | null {
  const p = past(s.eventId, s.ts - windowSecs);
  if (!p) return null;
  const span = s.ts - p.ts;
  if (span < windowSecs * D.minSpanShare || span > windowSecs * 2) return null;
  const abs = s[field] - p[field];
  return { abs, pct: p[field] > 0 ? abs / p[field] : 0, spanSecs: span };
}

export function scoreEvent(s: SnapRow, past: PastFn, flow: PrintFlow | null, now: number, opts: { keepEmpty?: boolean } = {}): Anomaly | null {
  // Settled or empty events (liquidity 0 and no open interest) are noise, e.g. finished sports games.
  if (s.liq <= 0 && s.oi < 1_000) return null;
  const reasons: Reason[] = [];
  const notes: string[] = [];
  const add = (code: string, points: number, text: string) => reasons.push({ code, points, text });

  const d15m = delta(s, past, 900, 'oi');
  const d1h = delta(s, past, 3_600, 'oi');
  const d24h = delta(s, past, 86_400, 'oi');
  if (!d1h && !d15m) notes.push('OI delta: waiting for history');
  // Live games and markets about to expire swing in price and volume by nature; only OI/fill signals stay meaningful.
  const nearExpiry = s.endDate !== null && s.endDate - now < D.nearExpiryHours * 3_600;
  const structural = s.isGame || nearExpiry;
  if (structural) notes.push(s.isGame ? 'live/game market: price and volume swings are expected, so those rules are off' : 'expires soon: price and volume swings are expected, so those rules are off');

  if (d1h && s.oi > 0) {
    const big = Math.abs(d1h.abs) >= D.oiJump1hMinUsd;
    if (big && d1h.pct >= D.oiJump1hBigPct) add('oi_surge', 40, `open interest +${usd(d1h.abs)} (${pct(d1h.pct)}) in ${Math.round(d1h.spanSecs / 60)}m`);
    else if (big && d1h.pct >= D.oiJump1hPct) add('oi_jump', 30, `open interest +${usd(d1h.abs)} (${pct(d1h.pct)}) in ${Math.round(d1h.spanSecs / 60)}m`);
    else if (big && d1h.pct <= -D.oiJump1hBigPct) add('oi_drain', 20, `open interest ${usd(d1h.abs)} (${pct(d1h.pct)}) in ${Math.round(d1h.spanSecs / 60)}m: positions leaving`);
  }
  if (d15m && !d1h && s.oi > 0 && d15m.abs >= D.oiJump15mMinUsd && d15m.pct >= D.oiJump15mPct)
    add('oi_jump', 25, `open interest +${usd(d15m.abs)} (${pct(d15m.pct)}) in ${Math.round(d15m.spanSecs / 60)}m`);
  if (d24h && Math.abs(d24h.abs) >= D.oiMove24hMinUsd && Math.abs(d24h.pct) >= D.oiMove24hPct && !reasons.some((r) => r.code.startsWith('oi_')))
    add('oi_move_24h', 15, `open interest ${usd(d24h.abs)} (${pct(d24h.pct)}) over ${Math.round(d24h.spanSecs / 3600)}h`);

  // Volume acceleration: today's volume against the average of the previous six days.
  let accel: number | null = null;
  const ageDays = s.created !== null ? (now - s.created) / 86_400 : null;
  const baseline = s.vol1w > s.vol24 ? (s.vol1w - s.vol24) / 6 : 0;
  if (ageDays !== null && ageDays < D.newMarketDays) notes.push('new market: volume baseline unreliable');
  else if (baseline >= D.accelBaselineMin) accel = s.vol24 / baseline;
  if (!structural && accel !== null && s.vol24 >= D.minVol24) {
    if (accel >= D.accelBig) add('volume_spike', 30, `24h volume ${usd(s.vol24)} is ${accel.toFixed(1)}x its usual day (${usd(baseline)})`);
    else if (accel >= D.accelMin) add('volume_accel', 20, `24h volume ${usd(s.vol24)} is ${accel.toFixed(1)}x its usual day (${usd(baseline)})`);
  }

  const turnover = s.oi >= D.turnoverMinOi ? s.vol24 / s.oi : null;
  if (!structural && turnover !== null && turnover >= D.turnoverMin && s.vol24 >= D.turnoverMinVol) add('turnover', 8, `24h volume is ${turnover.toFixed(1)}x open interest (heavy churn)`);

  if (!structural && s.vol24 >= D.minVol24) {
    if (s.ch1h !== null && Math.abs(s.ch1h) >= D.priceMove1h) add('price_move_1h', Math.abs(s.ch1h) >= D.priceMove1hBig ? 25 : 15, `price ${pct(s.ch1h)} in the last hour`);
    if (s.ch1d !== null && Math.abs(s.ch1d) >= D.priceMove1d) add('price_move_1d', 10, `price ${pct(s.ch1d)} over 24h`);
  }
  if (!structural && s.vol24 >= D.thinLiqMinVol && s.liq < D.thinLiqRatio * s.vol24) add('thin_liquidity', 8, `liquidity ${usd(s.liq)} is thin against ${usd(s.vol24)} traded`);

  if (flow) {
    if (flow.usd1h >= D.flowMinUsd1h) add('big_prints', 15, `${flow.prints1h} large fills = ${usd(flow.usd1h)} in the last hour (biggest ${usd(flow.biggestUsd)})`);
    if (flow.freshWallets > 0) add('fresh_money', 20, `${flow.freshWallets} new/thin wallet(s) put ${usd(flow.freshUsd)} in`);
    if (flow.cluster) add('wallet_cluster', 25, `${D.clusterMinWallets}+ new/thin wallets on the same outcome within ${D.clusterWindowSecs / 60}m`);
  }

  const score = Math.max(0, Math.min(100, reasons.reduce((a, r) => a + r.points, 0)));
  if (reasons.length === 0 && !opts.keepEmpty) return null;
  return {
    eventId: s.eventId, slug: s.slug, title: s.title, cat: s.cat, isGame: s.isGame, startsAt: s.startsAt, score, level: score >= D.hot ? 'HOT' : score >= D.watch ? 'WATCH' : 'NONE', reasons, notes,
    m: {
      oi: s.oi, dOi1h: d1h?.abs ?? null, dOi1hPct: d1h?.pct ?? null, dOi1hSpanMin: d1h ? Math.round(d1h.spanSecs / 60) : null,
      dOi15m: d15m?.abs ?? null, dOi15mPct: d15m?.pct ?? null,
      dOi24h: d24h?.abs ?? null, dOi24hPct: d24h?.pct ?? null, vol24: s.vol24, accel, turnover, liq: s.liq, price: s.price, ch1h: s.ch1h, ch1d: s.ch1d, dPrice30m: null,
    },
    flow,
  };
}

export function tagWallet(profile: { firstSeen: number | null; traded: number | null } | undefined, at: number): WalletTag {
  if (!profile) return { kind: '?', ageDays: null, traded: null };
  const ageDays = profile.firstSeen !== null ? Math.max(0, (at - profile.firstSeen) / 86_400) : null;
  const traded = profile.traded;
  let kind: WalletTag['kind'] = 'REG';
  if (traded !== null && traded >= D.whaleMinMarkets) kind = 'WHALE';
  else if ((ageDays !== null && ageDays <= D.freshWalletDays && (traded ?? Infinity) <= D.freshWalletMaxMarkets)) kind = 'NEW';
  else if (traded !== null && traded <= D.thinMaxMarkets) kind = 'THIN';
  return { kind, ageDays, traded };
}

/** Large-fill flow per event slug over the last hour, with wallet quality and clustering. */
export function flowBySlug(prints: readonly PrintRow[], tags: ReadonlyMap<string, WalletTag>, now: number): Map<string, PrintFlow> {
  const recent = prints.filter((p) => p.ts >= now - 3_600);
  const out = new Map<string, PrintFlow>();
  const groups = new Map<string, PrintRow[]>();
  for (const p of recent) {
    const g = groups.get(p.eventSlug);
    if (g) g.push(p);
    else groups.set(p.eventSlug, [p]);
  }
  for (const [slug, list] of groups) {
    let usdSum = 0;
    let fresh = 0;
    const freshWallets = new Set<string>();
    let top: PrintRow | null = null;
    for (const p of list) {
      usdSum += p.usd;
      if (!top || p.usd > top.usd) top = p;
      const k = tags.get(p.wallet)?.kind;
      if (p.side === 'BUY' && (k === 'NEW' || k === 'THIN')) {
        fresh += p.usd;
        freshWallets.add(p.wallet);
      }
    }
    // cluster: >= N distinct new/thin wallets buying the same market+outcome inside one window
    let cluster = false;
    const byOutcome = new Map<string, PrintRow[]>();
    for (const p of list) {
      const k = tags.get(p.wallet)?.kind;
      if (p.side !== 'BUY' || (k !== 'NEW' && k !== 'THIN')) continue;
      const key = `${p.cid}|${p.outcome ?? ''}`;
      const g = byOutcome.get(key);
      if (g) g.push(p);
      else byOutcome.set(key, [p]);
    }
    for (const g of byOutcome.values()) {
      g.sort((a, b) => a.ts - b.ts);
      for (let i = 0; i < g.length && !cluster; i++) {
        const w = g.filter((x) => x.ts >= g[i].ts && x.ts <= g[i].ts + D.clusterWindowSecs);
        if (new Set(w.map((x) => x.wallet)).size >= D.clusterMinWallets && w.reduce((a, x) => a + x.usd, 0) >= D.clusterMinUsd) cluster = true;
      }
    }
    out.set(slug, {
      usd1h: usdSum, prints1h: list.length, biggestUsd: top?.usd ?? 0, freshUsd: fresh, freshWallets: freshWallets.size, cluster,
      top: top ? { usd: top.usd, wallet: top.wallet, tag: tags.get(top.wallet)?.kind ?? '?', outcome: top.outcome, side: top.side } : null,
    });
  }
  return out;
}

export function rankAnomalies(snaps: readonly SnapRow[], past: PastFn, flows: ReadonlyMap<string, PrintFlow>, now: number): Anomaly[] {
  const out: Anomaly[] = [];
  for (const s of snaps) {
    if (s.isGame) continue; // games have their own view and rules (rankGames)
    const a = scoreEvent(s, past, flows.get(s.slug) ?? null, now);
    if (a) out.push(a);
  }
  return out.sort((x, y) => y.score - x.score || y.m.vol24 - x.m.vol24);
}

// ---------------------------------------------------------------- games ----

export const G = {
  /** Show games that start within this many seconds ahead, and ones that began less than `liveWindowSecs` ago. */
  lookaheadSecs: 24 * 3_600,
  liveWindowSecs: 3 * 3_600,
  lineMove: 0.05,
  lineMoveBig: 0.1,
  lineMoveMinVol: 20_000,
  /** A live game whose main market trades beyond this (or below 1 minus this) is treated as decided. */
  decidedPrice: 0.97,
} as const;

export type GamePhase = 'PRE' | 'LIVE' | 'OVER' | 'UNKNOWN';
export function gamePhase(startsAt: number | null, now: number): GamePhase {
  if (startsAt === null) return 'UNKNOWN';
  if (now < startsAt) return 'PRE';
  return now - startsAt < G.liveWindowSecs ? 'LIVE' : 'OVER';
}

/** Games get their own rules: OI and fills as everywhere, plus a pre-game line move (price shifting before the start). */
export function scoreGame(s: SnapRow, past: PastFn, flow: PrintFlow | null, now: number): Anomaly | null {
  const phase = gamePhase(s.startsAt, now);
  if (phase === 'OVER' || (phase === 'PRE' && (s.startsAt as number) - now > G.lookaheadSecs)) return null;
  if (phase === 'UNKNOWN') return null;
  // A live game whose main market has settled near 0 or 1 is over; the scheduled-start window cannot know that.
  if (phase === 'LIVE' && s.price !== null && (s.price >= G.decidedPrice || s.price <= 1 - G.decidedPrice)) return null;
  const base = scoreEvent(s, past, flow, now, { keepEmpty: true });
  if (!base) return null;
  const p = past(s.eventId, s.ts - 1_800);
  const span = p ? s.ts - p.ts : 0;
  if (p && span >= 900 && span <= 3_600 && s.price !== null && p.price !== null) {
    base.m.dPrice30m = s.price - p.price;
    if (phase === 'PRE' && s.vol24 >= G.lineMoveMinVol && Math.abs(base.m.dPrice30m) >= G.lineMove) {
      const big = Math.abs(base.m.dPrice30m) >= G.lineMoveBig;
      base.reasons.push({ code: 'line_move', points: big ? 35 : 25, text: `price moved ${base.m.dPrice30m >= 0 ? '+' : ''}${(base.m.dPrice30m * 100).toFixed(0)} points in ${Math.round(span / 60)}m before the start` });
    }
  }
  base.notes = base.notes.filter((n) => !/live\/game market/.test(n));
  if (phase === 'LIVE') base.notes.push('live: price and volume swings are expected; only OI and fill signals count');
  const score = Math.max(0, Math.min(100, base.reasons.reduce((a, r) => a + r.points, 0)));
  base.score = score;
  base.level = score >= D.hot ? 'HOT' : score >= D.watch ? 'WATCH' : 'NONE';
  return base;
}

/** Upcoming and live games: flagged ones first, then by how soon they start. */
export function rankGames(snaps: readonly SnapRow[], past: PastFn, flows: ReadonlyMap<string, PrintFlow>, now: number): Anomaly[] {
  const out: Anomaly[] = [];
  for (const s of snaps) {
    if (!s.isGame) continue;
    const a = scoreGame(s, past, flows.get(s.slug) ?? null, now);
    if (a) out.push(a);
  }
  return out.sort((x, y) => y.score - x.score || (x.startsAt ?? Infinity) - (y.startsAt ?? Infinity) || y.m.vol24 - x.m.vol24);
}
