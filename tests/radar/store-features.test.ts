import { describe, expect, it } from 'vitest';
import { clusteredZ, flowSummary, INFORMATIVE_BAND, oppositeShare, peakPositions } from '../../radar/features';
import { openStore, type MarketRow, type TradeRow } from '../../radar/store';

const market = (over: Partial<MarketRow> = {}): MarketRow => ({
  cid: '0xaa', eventSlug: 'ev', eventTitle: 'Counter-Strike: A vs B', game: 'Counter-Strike', marketType: 'moneyline', question: 'A vs B',
  outcomes: ['A', 'B'], tokenIds: ['1', '2'], gameStart: 1000, result: null, volume: 5000, closed: false, ...over,
});
const trade = (over: Partial<TradeRow> = {}): TradeRow => ({
  cid: '0xaa', wallet: '0xw1', side: 'BUY', outcomeIndex: 0, price: 0.4, size: 100, ts: 1100, tx: '0xt', ...over,
});

describe('store', () => {
  it('round-trips markets, including voided results', () => {
    const s = openStore();
    s.upsertMarket(market({ result: [0.5, 0.5], closed: true }), 1);
    expect(s.getMarket('0xaa')).toMatchObject({ outcomes: ['A', 'B'], result: [0.5, 0.5], closed: true, volume: 5000 });
    s.close();
  });

  it('inserts trades idempotently and returns them in time order', () => {
    const s = openStore();
    const rows = [trade({ ts: 1300, tx: '0x3' }), trade({ ts: 1100, tx: '0x1' }), trade({ ts: 1200, tx: '0x2' })];
    expect(s.insertTrades(rows)).toBe(3);
    expect(s.insertTrades(rows)).toBe(0);
    expect(s.tradesFor('0xaa').map((t) => t.ts)).toEqual([1100, 1200, 1300]);
    s.close();
  });

  it('keeps both counterparties of one fill (they are different wallets)', () => {
    const s = openStore();
    expect(s.insertTrades([trade({ wallet: '0xmaker' }), trade({ wallet: '0xtaker' })])).toBe(2);
    s.close();
  });

  it('refuses a case tier its sources do not justify, and ignores duplicates', () => {
    const s = openStore();
    s.upsertCase({ id: 'c', title: 't', game: null, tournament: null, teams: [], matchAt: null, polymarketSlug: null, notes: null });
    const rumor = { at: 5, tier: 'SANCTIONED' as const, summary: 'x', sources: [{ kind: 'community' as const, url: 'u', retrievedAt: 'r' }], claims: [] };
    expect(() => s.addCaseEvent('c', rumor)).toThrow(/SANCTIONED/);
    const ok = { ...rumor, tier: 'RUMOR' as const };
    s.addCaseEvent('c', ok);
    s.addCaseEvent('c', ok);
    expect(s.caseEvents('c')).toHaveLength(1);
    s.close();
  });

  it('summarizes volume by market type', () => {
    const s = openStore();
    for (let i = 0; i < 10; i++) s.upsertMarket(market({ cid: `0x${i}`, marketType: 'round_handicap_game_1', volume: i === 9 ? 500 : 0 }), 1);
    expect(s.volumeBaseline('round_handicap_game_1')).toEqual({ n: 10, median: 0, p90: 500 });
    expect(s.volumeBaseline('nope').n).toBe(0);
    s.close();
  });
});

describe('features', () => {
  it('scores wins against entry prices, one observation per unit', () => {
    const r = clusteredZ([{ q: 0.5, win: 1 }, { q: 0.5, win: 0 }]);
    expect(r).toMatchObject({ n: 2, wins: 1, expected: 1, z: 0 });
    expect(clusteredZ([]).z).toBe(0);
    expect(clusteredZ(Array.from({ length: 50 }, () => ({ q: 0.2, win: 1 as const }))).z).toBeGreaterThan(5);
  });

  it('remembers peak exposure after the position is sold or redeemed', () => {
    const fills = [
      trade({ ts: 1100, size: 200, price: 0.4 }),
      trade({ ts: 1200, size: 100, price: 0.5 }),
      trade({ ts: 5000, side: 'SELL', size: 300, price: 0.999 }),
    ];
    const [p] = peakPositions(fills, 1000);
    expect(p.peakShares).toBe(300);
    expect(p.peakCost).toBeCloseTo(130);
    expect(p.vwap).toBeCloseTo(130 / 300);
    expect(p.liveShare).toBe(1);
  });

  it('separates pre-start from in-play money', () => {
    const [p] = peakPositions([trade({ ts: 900, size: 100, price: 0.5 }), trade({ ts: 1100, size: 100, price: 0.5 })], 1000);
    expect(p.liveShare).toBeCloseTo(0.5);
    expect(peakPositions([trade()], null)[0].liveShare).toBeNull();
  });

  it('can ignore settlement-sweeping fills outside the informative band', () => {
    const sweep = trade({ price: 0.999, size: 1_000_000 });
    expect(peakPositions([sweep], 1000)).toHaveLength(1);
    expect(peakPositions([sweep], 1000, INFORMATIVE_BAND)).toHaveLength(0);
  });

  it('measures how much of a wallet bought the other side', () => {
    const fills = [trade({ outcomeIndex: 0, size: 100, price: 0.5 }), trade({ outcomeIndex: 1, size: 100, price: 0.5 })];
    expect(oppositeShare(fills, '0xw1', 0)).toBeCloseTo(0.5);
    expect(oppositeShare(fills, '0xother', 0)).toBe(0);
  });

  it('summarizes flow concentration and the pre-start share', () => {
    const f = flowSummary([trade({ ts: 900, size: 100, price: 0.5 }), trade({ wallet: '0xw2', ts: 1100, size: 300, price: 0.5 })], 1000);
    expect(f).toMatchObject({ trades: 2, wallets: 2 });
    expect(f.preStartShare).toBeCloseTo(0.25);
    expect(f.topWalletShare).toBeCloseTo(0.75);
  });
});
