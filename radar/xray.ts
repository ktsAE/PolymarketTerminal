import type { FillLine, PnlPoint, PolymarketClient, PositionLine } from './polymarket.ts';

/**
 * Wallet X-ray: what a wallet's record really says, with every position counted (Data API v2 user-pnl, open and closed positions, fills).
 *
 * Profile pages and tracker sites show numbers computed on CLOSED positions only (win rate, profit factor). Positions that are still open and
 * under water never enter them, so "profit factor 3 and a 65% win rate" can sit next to a negative net PnL. This view puts the closed-only figures
 * next to the all-in ones, and says plainly when they disagree. Everything here describes behavior and results; none of it says why a wallet traded.
 */

export interface XrayWindow {
  pnl: number;
  volume: number;
  /** pnl / volume, null when nothing was traded. */
  ror: number | null;
}

export interface XrayReport {
  wallet: string;
  /** All-in PnL (every position, income included) and its parts. */
  economicPnl: number;
  tradingPnl: number;
  income: { referral: number; rewards: number; yield: number; makerRebate: number; takerRebate: number; total: number };
  volume: number;
  trades: number;
  /** economicPnl / volume. */
  returnOnVolume: number | null;
  windows: { d7: XrayWindow; d30: XrayWindow; d90: XrayWindow };
  /** Deepest peak-to-trough fall of the all-in PnL curve, and the share of active days that closed green. */
  maxDrawdown: number;
  greenDays: { green: number; active: number };
  firstDay: number | null;
  closed: { n: number; wins: number; losses: number; winRate: number | null; grossWin: number; grossLoss: number; profitFactor: number | null; net: number; biggestWin: number; biggestWinShare: number | null; top5WinShare: number | null };
  open: { n: number; value: number; unrealized: number; underwater: number; underwaterLoss: number };
  /** Profit factor once the open positions' unrealized gains and losses are counted too. */
  profitFactorAllIn: number | null;
  /** Share of the sampled fills where the wallet was resting (maker), and how many fills that is based on. null when there is too little to say. */
  makerShare: { share: number; fills: number; hours: number } | null;
  flags: string[];
  /** Rows capped at the sampling limits, so figures from positions may be incomplete. */
  truncated: string[];
}

const usd = (x: number): string => `${x < 0 ? '-' : ''}$${Math.round(Math.abs(x)).toLocaleString('en-US')}`;
const pct = (x: number, d = 1): string => `${(x * 100).toFixed(d)}%`;

export function windowOf(points: readonly PnlPoint[], days: number, nowSecs: number): XrayWindow {
  if (points.length === 0) return { pnl: 0, volume: 0, ror: null };
  const cut = nowSecs - days * 86_400;
  const last = points[points.length - 1];
  let base = points[0];
  for (const p of points) {
    if (p.ts <= cut) base = p;
    else break;
  }
  // a window that starts before the first point starts at zero
  const startPnl = points[0].ts > cut ? 0 : base.economicPnl;
  const startVol = points[0].ts > cut ? 0 : base.volume;
  const pnl = last.economicPnl - startPnl;
  const volume = last.volume - startVol;
  return { pnl, volume, ror: volume > 0 ? pnl / volume : null };
}

export function drawdownOf(points: readonly PnlPoint[]): number {
  let peak = 0;
  let worst = 0;
  for (const p of points) {
    peak = Math.max(peak, p.economicPnl);
    worst = Math.min(worst, p.economicPnl - peak);
  }
  return worst;
}

export function greenDaysOf(points: readonly PnlPoint[]): { green: number; active: number } {
  let green = 0;
  let active = 0;
  for (let i = 1; i < points.length; i++) {
    const d = points[i].economicPnl - points[i - 1].economicPnl;
    if (Math.abs(d) < 0.005) continue;
    active++;
    if (d > 0) green++;
  }
  return { green, active };
}

export function closedStats(closed: readonly PositionLine[]): XrayReport['closed'] {
  const wins = closed.filter((p) => p.totalPnl > 0.005);
  const losses = closed.filter((p) => p.totalPnl < -0.005);
  const grossWin = wins.reduce((a, p) => a + p.totalPnl, 0);
  const grossLoss = -losses.reduce((a, p) => a + p.totalPnl, 0);
  const sorted = wins.map((p) => p.totalPnl).sort((a, b) => b - a);
  const decided = wins.length + losses.length;
  return {
    n: closed.length, wins: wins.length, losses: losses.length, winRate: decided > 0 ? wins.length / decided : null, grossWin, grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : null, net: grossWin - grossLoss,
    biggestWin: sorted[0] ?? 0, biggestWinShare: grossWin > 0 ? (sorted[0] ?? 0) / grossWin : null, top5WinShare: grossWin > 0 ? sorted.slice(0, 5).reduce((a, x) => a + x, 0) / grossWin : null,
  };
}

export function openStats(open: readonly PositionLine[]): XrayReport['open'] {
  const under = open.filter((p) => p.unrealizedPnl < -0.005);
  return { n: open.length, value: open.reduce((a, p) => a + p.value, 0), unrealized: open.reduce((a, p) => a + p.unrealizedPnl, 0), underwater: under.length, underwaterLoss: under.reduce((a, p) => a + p.unrealizedPnl, 0) };
}

/** Share of the wallet's recent fills where it was resting. `all` holds taker and maker fills, `takerOnly` just the taker ones, both over the same period. */
export function makerShareOf(all: readonly FillLine[], takerOnly: readonly FillLine[]): { share: number; fills: number; hours: number } | null {
  if (all.length < 30) return null;
  const key = (f: FillLine) => `${f.tx}|${f.token}|${f.side}|${f.price}|${f.size}|${f.ts}`;
  const taker = new Set(takerOnly.map(key));
  const matched = all.filter((f) => taker.has(key(f))).length;
  const ts = all.map((f) => f.ts);
  return { share: 1 - matched / all.length, fills: all.length, hours: (Math.max(...ts) - Math.min(...ts)) / 3600 };
}

export function xrayFlags(r: Omit<XrayReport, 'flags' | 'truncated'>): string[] {
  const out: string[] = [];
  const pf = r.closed.profitFactor;
  if (pf !== null && Number.isFinite(pf) && pf >= 1.5 && r.economicPnl <= 0)
    out.push(`profit factor ${pf.toFixed(1)} counts closed positions only, yet the all-in PnL is ${usd(r.economicPnl)}: ${r.open.underwater} open positions are under water (${usd(r.open.underwaterLoss)}), and fees, losses never redeemed and income are not in that ratio`);
  else if (r.profitFactorAllIn !== null && pf !== null && Number.isFinite(pf) && pf >= 1.5 && r.profitFactorAllIn < 1)
    out.push(`profit factor is ${pf.toFixed(1)} on closed positions but ${r.profitFactorAllIn.toFixed(2)} once open positions are counted`);
  if (r.closed.winRate !== null && r.closed.winRate >= 0.6 && r.returnOnVolume !== null && r.returnOnVolume < 0)
    out.push(`wins ${pct(r.closed.winRate, 0)} of positions but returns ${pct(r.returnOnVolume)} on volume: many small wins, fewer large losses`);
  if (r.economicPnl > 0 && r.income.total / r.economicPnl > 0.25) out.push(`${pct(r.income.total / r.economicPnl, 0)} of the profit is referral, rewards, yield or rebates (${usd(r.income.total)}), not price moves`);
  if (r.closed.biggestWinShare !== null && r.closed.biggestWinShare > 0.4 && r.closed.wins >= 5) out.push(`one position is ${pct(r.closed.biggestWinShare, 0)} of all gross profit (${usd(r.closed.biggestWin)}): the record leans on a single result`);
  if (r.makerShare && r.makerShare.share >= 0.5) out.push(`mostly rests orders in the book (${pct(r.makerShare.share, 0)} of its last ${r.makerShare.fills} fills, over ${r.makerShare.hours.toFixed(0)} hours, were maker fills): the market-maker pattern, whose income is the spread`);
  if (r.greenDays.active >= 20 && r.windows.d30.pnl > 0 && r.windows.d90.pnl <= 0) out.push('green over 30 days but not over 90: a recent run, not a long record');
  if (r.volume > 0 && r.trades > 0 && r.trades / Math.max(1, r.firstDay ? (Date.now() / 1000 - r.firstDay) / 86_400 : 1) > 200) out.push('very high trade count per day: automation is likely');
  return out;
}

export function buildXray(wallet: string, points: readonly PnlPoint[], open: readonly PositionLine[], closed: readonly PositionLine[], fills: { all: readonly FillLine[]; takerOnly: readonly FillLine[] }, nowSecs: number, truncated: string[] = []): XrayReport {
  const last = points[points.length - 1];
  const income = {
    referral: last?.referralIncome ?? 0, rewards: last?.rewardIncome ?? 0, yield: last?.yieldIncome ?? 0, makerRebate: last?.makerRebate ?? 0, takerRebate: last?.takerRebate ?? 0, total: 0,
  };
  income.total = income.referral + income.rewards + income.yield + income.makerRebate + income.takerRebate;
  const economicPnl = last?.economicPnl ?? 0;
  const volume = last?.volume ?? 0;
  const cl = closedStats(closed);
  const op = openStats(open);
  const grossWinAll = cl.grossWin + open.filter((p) => p.unrealizedPnl > 0).reduce((a, p) => a + p.unrealizedPnl, 0);
  const grossLossAll = cl.grossLoss + -op.underwaterLoss;
  const base = {
    wallet, economicPnl, tradingPnl: last?.positionPnl ?? 0, income, volume, trades: last?.tradeCount ?? 0, returnOnVolume: volume > 0 ? economicPnl / volume : null,
    windows: { d7: windowOf(points, 7, nowSecs), d30: windowOf(points, 30, nowSecs), d90: windowOf(points, 90, nowSecs) }, maxDrawdown: drawdownOf(points), greenDays: greenDaysOf(points),
    firstDay: points[0]?.ts ?? null, closed: cl, open: op, profitFactorAllIn: grossLossAll > 0 ? grossWinAll / grossLossAll : null, makerShare: makerShareOf(fills.all, fills.takerOnly),
  };
  return { ...base, flags: xrayFlags(base), truncated };
}

export interface XrayLoad {
  report: XrayReport | null;
  stage: string;
  done: boolean;
  error: string | null;
}

/** Loads everything for a wallet. `onProgress` gets the stage text while it works. Never throws: a failure lands in `error`. */
export async function loadXray(client: PolymarketClient, wallet: string, opts: { now?: () => number; onProgress?: (x: XrayLoad) => void; maxPositions?: number } = {}): Promise<XrayLoad> {
  const now = opts.now ?? Date.now;
  const state: XrayLoad = { report: null, stage: 'reading the PnL history', done: false, error: null };
  const emit = () => opts.onProgress?.({ ...state });
  try {
    emit();
    const max = opts.maxPositions ?? 3000;
    const points = await client.userPnlSeries(wallet);
    state.stage = 'reading open positions';
    emit();
    const open = await client.userPositions(wallet, 'OPEN', max);
    state.stage = 'reading closed positions';
    emit();
    const closed = await client.userPositions(wallet, 'CLOSED', max);
    state.stage = 'reading recent fills';
    emit();
    const all = await client.userFills(wallet, { takerOnly: false, max: 1000 });
    const since = all.length ? all[all.length - 1].ts : undefined;
    const takerOnly = all.length >= 30 ? await client.userFills(wallet, { takerOnly: true, max: 5000, sinceTs: since }) : [];
    const truncated: string[] = [];
    if (open.length >= max) truncated.push(`open positions capped at ${max}`);
    if (closed.length >= max) truncated.push(`closed positions capped at ${max}: win rate and profit factor use the newest ${max}`);
    state.report = buildXray(wallet.toLowerCase(), points, open, closed, { all, takerOnly }, Math.floor(now() / 1000), truncated);
  } catch (error) {
    state.error = error instanceof Error ? error.message : String(error);
  }
  state.done = true;
  state.stage = 'done';
  emit();
  return state;
}

export function formatXray(r: XrayReport): string[] {
  const money = (w: XrayWindow) => `${usd(w.pnl)} on ${usd(w.volume)} traded${w.ror === null ? '' : ` (${pct(w.ror)})`}`;
  const out: string[] = [];
  out.push(`ALL-IN PnL ${usd(r.economicPnl)}  (trading ${usd(r.tradingPnl)} + income ${usd(r.income.total)})   volume ${usd(r.volume)}   return on volume ${r.returnOnVolume === null ? '-' : pct(r.returnOnVolume)}   trades ${r.trades.toLocaleString('en-US')}`);
  out.push(`windows   7d ${money(r.windows.d7)}   30d ${money(r.windows.d30)}   90d ${money(r.windows.d90)}`);
  out.push(`curve     deepest fall ${usd(r.maxDrawdown)}   green days ${r.greenDays.green}/${r.greenDays.active}${r.greenDays.active ? ` (${pct(r.greenDays.green / r.greenDays.active, 0)})` : ''}`);
  const c = r.closed;
  out.push(`CLOSED    ${c.n} positions: ${c.wins} won / ${c.losses} lost${c.winRate === null ? '' : ` (${pct(c.winRate, 0)})`}   profit factor ${c.profitFactor === null ? '-' : Number.isFinite(c.profitFactor) ? c.profitFactor.toFixed(2) : 'inf'}   net ${usd(c.net)}   biggest win ${usd(c.biggestWin)}${c.top5WinShare === null ? '' : `, top 5 = ${pct(c.top5WinShare, 0)} of gross profit`}`);
  out.push(`OPEN      ${r.open.n} positions worth ${usd(r.open.value)}, unrealized ${usd(r.open.unrealized)}; ${r.open.underwater} under water (${usd(r.open.underwaterLoss)})   profit factor with open positions counted ${r.profitFactorAllIn === null ? '-' : r.profitFactorAllIn.toFixed(2)}`);
  out.push(`INCOME    referral ${usd(r.income.referral)}   rewards ${usd(r.income.rewards)}   yield ${usd(r.income.yield)}   maker rebate ${usd(r.income.makerRebate)}   taker rebate ${usd(r.income.takerRebate)}`);
  out.push(`STYLE     ${r.makerShare ? `${pct(r.makerShare.share, 0)} maker fills (last ${r.makerShare.fills} fills, ${r.makerShare.hours.toFixed(0)} hours: a recent window, not a lifetime figure)` : 'maker share: too few recent fills to say'}`);
  for (const f of r.flags) out.push(`NOTE      ${f}`);
  for (const t of r.truncated) out.push(`LIMIT     ${t}`);
  out.push('A record describes what happened at that wallet\'s own prices. It does not say a copier would earn the same, or why the wallet traded.');
  return out;
}
