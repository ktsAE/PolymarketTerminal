import { describe, expect, it } from 'vitest';
import type { FillLine, PnlPoint, PositionLine } from '../../radar/polymarket';
import { PolymarketClient } from '../../radar/polymarket';
import { buildXray, closedStats, drawdownOf, formatXray, greenDaysOf, loadXray, makerShareOf, openStats, windowOf } from '../../radar/xray';
import { cursorPage, v2 } from './v2';

const DAY = 86_400;
const NOW = 1_800_000_000;
const pt = (daysAgo: number, pnl: number, vol: number, over: Partial<PnlPoint> = {}): PnlPoint => ({
  ts: NOW - daysAgo * DAY, economicPnl: pnl, positionPnl: pnl, realizedPnl: pnl, referralIncome: 0, rewardIncome: 0, yieldIncome: 0, makerRebate: 0, takerRebate: 0, volume: vol, tradeCount: 10, ...over,
});
const pos = (totalPnl: number, over: Partial<PositionLine> = {}): PositionLine => ({
  cid: 'c', title: 't', slug: 's', outcome: 'Yes', status: 'CLOSED', cost: 100, value: 0, totalPnl, realizedPnl: totalPnl, unrealizedPnl: 0, firstEntryAt: null, ...over,
});
const fill = (i: number): FillLine => ({ ts: NOW - i, tx: `0x${i}`, token: 't', side: 'BUY', price: 0.5, size: 10 });

describe('windows, drawdown and green days', () => {
  const pts = [pt(100, 0, 0), pt(60, 500, 10_000), pt(30, 300, 20_000), pt(8, 800, 30_000), pt(0, 700, 40_000)];
  it('measures PnL and volume inside each window', () => {
    expect(windowOf(pts, 7, NOW)).toMatchObject({ pnl: -100, volume: 10_000 });
    expect(windowOf(pts, 7, NOW).ror).toBeCloseTo(-0.01);
    expect(windowOf(pts, 30, NOW).pnl).toBe(400);
    expect(windowOf(pts, 1000, NOW)).toMatchObject({ pnl: 700, volume: 40_000 }); // a window longer than the history starts at zero
    expect(windowOf([], 7, NOW)).toEqual({ pnl: 0, volume: 0, ror: null });
  });
  it('finds the deepest peak-to-trough fall and counts green days among active ones', () => {
    expect(drawdownOf(pts)).toBe(-200);
    expect(greenDaysOf(pts)).toEqual({ green: 2, active: 4 });
    expect(greenDaysOf([pt(2, 0, 0), pt(1, 0, 0)])).toEqual({ green: 0, active: 0 });
  });
});

describe('closed and open position stats', () => {
  it('computes win rate and profit factor on closed positions only, and the concentration of the biggest win', () => {
    const c = closedStats([pos(300), pos(100), pos(100), pos(-100), pos(-50), pos(0)]);
    expect(c).toMatchObject({ n: 6, wins: 3, losses: 2, grossWin: 500, grossLoss: 150, net: 350 });
    expect(c.winRate).toBeCloseTo(0.6);
    expect(c.profitFactor).toBeCloseTo(500 / 150);
    expect(c.biggestWinShare).toBeCloseTo(0.6);
    expect(closedStats([pos(5)]).profitFactor).toBe(Infinity);
    expect(closedStats([]).profitFactor).toBeNull();
  });
  it('sums open value and the positions under water', () => {
    const o = openStats([pos(0, { status: 'OPEN', value: 50, unrealizedPnl: 20 }), pos(0, { status: 'OPEN', value: 10, unrealizedPnl: -30 }), pos(0, { status: 'OPEN', value: 5, unrealizedPnl: -10 })]);
    expect(o).toEqual({ n: 3, value: 65, unrealized: -20, underwater: 2, underwaterLoss: -40 });
  });
});

describe('maker share', () => {
  it('is the share of fills that are not in the taker-only list, and says nothing from too few fills', () => {
    const all = Array.from({ length: 100 }, (_, i) => fill(i));
    expect(makerShareOf(all, all.slice(0, 25))).toMatchObject({ fills: 100 });
    expect(makerShareOf(all, all.slice(0, 25))?.share).toBeCloseTo(0.75);
    expect(makerShareOf(all, [])?.share).toBe(1);
    expect(makerShareOf(all.slice(0, 10), [])).toBeNull();
  });
});

describe('the report and its notes', () => {
  const base = (over: { points?: PnlPoint[]; open?: PositionLine[]; closed?: PositionLine[] } = {}) =>
    buildXray('0xabc', over.points ?? [pt(100, 0, 0), pt(0, -500, 10_000)], over.open ?? [], over.closed ?? [], { all: [], takerOnly: [] }, NOW);
  it('explains the contradiction of a high closed profit factor with a negative all-in PnL', () => {
    const r = base({
      closed: [...Array.from({ length: 13 }, () => pos(100)), ...Array.from({ length: 4 }, () => pos(-100))],
      open: Array.from({ length: 10 }, () => pos(0, { status: 'OPEN', value: 20, unrealizedPnl: -150 })),
    });
    expect(r.closed.profitFactor).toBeCloseTo(3.25);
    expect(r.economicPnl).toBe(-500);
    expect(r.profitFactorAllIn).toBeLessThan(1);
    expect(r.flags.join('\n')).toMatch(/profit factor 3\.3 counts closed positions only, yet the all-in PnL is -\$500: 10 open positions are under water/);
  });
  it('notes winning often while losing on volume, income-driven profit and a single big win', () => {
    const r = base({
      points: [pt(100, 0, 0), pt(0, -500, 10_000, { referralIncome: 0 })],
      closed: [...Array.from({ length: 13 }, () => pos(10)), ...Array.from({ length: 7 }, () => pos(-100))],
    });
    expect(r.flags.join('\n')).toMatch(/wins 65% of positions but returns -5\.0% on volume/);
    const inc = base({ points: [pt(100, 0, 0), pt(0, 1000, 50_000, { referralIncome: 400, rewardIncome: 100 })] });
    expect(inc.flags.join('\n')).toMatch(/50% of the profit is referral, rewards, yield or rebates/);
    const one = base({ closed: [pos(900), pos(20), pos(20), pos(20), pos(20), pos(20)] });
    expect(one.flags.join('\n')).toMatch(/one position is 90% of all gross profit/);
  });
  it('has no notes for an empty wallet and formats without crashing', () => {
    const r = buildXray('0xabc', [], [], [], { all: [], takerOnly: [] }, NOW);
    expect(r.flags).toEqual([]);
    expect(formatXray(r).join('\n')).toMatch(/ALL-IN PnL \$0/);
    expect(formatXray(base()).join('\n')).toMatch(/does not say a copier would earn the same/);
  });
});

describe('loading from the API', () => {
  const W = `0x${'a'.repeat(40)}`;
  const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };
  it('reads series, open and closed positions and fills through the v2 routes, and reports a failure instead of throwing', async () => {
    const urls: string[] = [];
    const fills = Array.from({ length: 60 }, (_, i) => ({ transactionHash: `0x${i}`, tokenId: 't', side: 'BUY', price: 0.5, size: 10, timestamp: NOW - i }));
    const f = async (url: string) => {
      urls.push(url);
      const u = new URL(url);
      if (u.pathname === '/v2/user-pnl') return v2({ points: [{ timestamp: NOW - DAY, economicPnl: 10, positionPnl: 10, volumeUsdc: 100, tradeCount: 3 }, { timestamp: NOW, economicPnl: 25, positionPnl: 20, referralIncome: 5, volumeUsdc: 400, tradeCount: 9 }] });
      if (u.pathname === '/v2/positions') return v2(u.searchParams.get('status') === 'OPEN' ? [{ conditionId: '0x1', totalCostUsdc: 50, currentValue: 40, unrealizedPnl: -10, totalPnl: -10 }] : [{ conditionId: '0x2', totalCostUsdc: 50, totalPnl: 30, realizedPnl: 30 }]);
      if (u.pathname === '/v2/trades') return cursorPage(u.searchParams.get('taker_only') === 'true' ? fills.slice(0, 15) : fills, u.searchParams);
      throw new Error(`unexpected ${url}`);
    };
    const res = await loadXray(new PolymarketClient(f, fast), W, { now: () => NOW * 1000 });
    expect(res.error).toBeNull();
    expect(res.report).toMatchObject({ economicPnl: 25, tradingPnl: 20, volume: 400, trades: 9 });
    expect(res.report?.income.referral).toBe(5);
    expect(res.report?.open).toMatchObject({ n: 1, underwater: 1 });
    expect(res.report?.closed).toMatchObject({ n: 1, wins: 1 });
    expect(res.report?.makerShare?.share).toBeCloseTo(0.75);
    expect(urls.some((u) => u.includes('offset='))).toBe(false);
    const dead = await loadXray(new PolymarketClient(async () => Promise.reject(new Error('down')), { ...fast, retries: 0 }), W);
    expect(dead.report).toBeNull();
    expect(dead.error).toMatch(/failed after 1 attempts/);
    expect(dead.done).toBe(true);
  });
});
