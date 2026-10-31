import { describe, expect, it } from 'vitest';
import { D, flowBySlug, gamePhase, rankAnomalies, rankGames, scoreEvent, scoreGame, tagWallet, type PastFn, type PrintFlow } from '../../radar/detect';
import { mapPrint, mapSnapshot } from '../../radar/polymarket';
import { openStore, type PrintRow, type SnapRow } from '../../radar/store';

const NOW = 1_800_000_000;
const snap = (over: Partial<SnapRow> = {}): SnapRow => ({
  eventId: 'e1', ts: NOW, slug: 'ev', title: 'Will X happen?', oi: 500_000, vol24: 100_000, vol1w: 400_000, liq: 300_000, price: 0.4, ch1h: null, ch1d: null,
  created: NOW - 30 * 86_400, endDate: NOW + 20 * 86_400, isGame: false, cat: 'politics', startsAt: null, ...over,
});
const never: PastFn = () => undefined;
const pastOf = (map: Record<number, Partial<SnapRow>>): PastFn => (id, target) => {
  const age = NOW - target;
  const key = Object.keys(map).map(Number).filter((k) => k <= age + 1).sort((a, b) => b - a)[0] ?? Math.max(...Object.keys(map).map(Number));
  return snap({ eventId: id, ts: NOW - key, ...map[key] });
};
const codes = (s: SnapRow, past: PastFn, flow: PrintFlow | null = null) => (scoreEvent(s, past, flow, NOW)?.reasons ?? []).map((r) => r.code);

describe('open interest', () => {
  it('stays silent and says so until it has history', () => {
    const a = scoreEvent(snap({ vol24: 100_000, vol1w: 700_000 }), never, null, NOW);
    expect(a).toBeNull(); // a normal day with no history: nothing to say
    const b = scoreEvent(snap({ vol24: 500_000, vol1w: 560_000 }), never, null, NOW)!; // volume spike, no OI history
    expect(b.notes.join()).toMatch(/waiting for history/);
    expect(b.m.dOi1h).toBeNull();
  });

  it('flags a 1h jump and a larger surge', () => {
    expect(codes(snap({ oi: 560_000 }), pastOf({ 3600: { oi: 500_000 } }))).toContain('oi_jump'); // +12%
    const surge = codes(snap({ oi: 600_000 }), pastOf({ 3600: { oi: 500_000 } })); // +20% is a surge, reported once
    expect(surge).toContain('oi_surge');
    expect(surge).not.toContain('oi_jump');
  });

  it('ignores moves that are small in dollars or percent', () => {
    expect(codes(snap({ oi: 510_000 }), pastOf({ 3600: { oi: 500_000 } }))).not.toContain('oi_jump'); // +2%
    expect(codes(snap({ oi: 20_000 }), pastOf({ 3600: { oi: 10_000 } }))).not.toContain('oi_surge'); // +100% but only $10k
  });

  it('reports a heavy drain separately from a jump', () => {
    expect(codes(snap({ oi: 400_000 }), pastOf({ 3600: { oi: 500_000 } }))).toContain('oi_drain');
  });

  it('uses the 15 minute window when the hour is not covered yet', () => {
    const past = pastOf({ 900: { oi: 500_000 } });
    expect(codes(snap({ oi: 530_000 }), past)).toContain('oi_jump');
  });

  it('refuses stale history instead of pretending: a 10 minute-old snapshot says nothing about an hour', () => {
    const a = scoreEvent(snap({ oi: 900_000, vol24: 100_000, vol1w: 120_000 }), pastOf({ 600: { oi: 500_000 } }), null, NOW);
    expect(a?.m.dOi1h ?? null).toBeNull();
  });
});

describe('volume, price and structural suppression', () => {
  it('flags volume far above the previous six days', () => {
    expect(codes(snap({ vol24: 400_000, vol1w: 460_000 }), never)).toContain('volume_spike'); // baseline 10k/day -> 40x
    expect(codes(snap({ vol24: 100_000, vol1w: 400_000 }), never)).not.toContain('volume_spike'); // 100k vs 50k/day = 2x
  });

  it('does not trust the volume baseline of a brand-new market', () => {
    const a = scoreEvent(snap({ created: NOW - 2 * 86_400, vol24: 400_000, vol1w: 460_000 }), never, null, NOW);
    expect(a).toBeNull();
  });

  it('flags a fast price move only with real volume', () => {
    expect(codes(snap({ ch1h: 0.15, vol24: 200_000 }), never)).toContain('price_move_1h');
    expect(codes(snap({ ch1h: 0.15, vol24: 10_000 }), never)).not.toContain('price_move_1h');
  });

  it('turns off price/volume rules for live games and markets about to expire', () => {
    const hot = { ch1h: 0.4, vol24: 900_000, vol1w: 950_000 };
    expect(codes(snap({ ...hot, isGame: true }), never)).toEqual([]);
    expect(codes(snap({ ...hot, endDate: NOW + 3_600 }), never)).toEqual([]);
    expect(codes(snap({ ...hot }), never)).toEqual(expect.arrayContaining(['price_move_1h', 'volume_spike']));
  });

  it('keeps OI rules on for games', () => {
    expect(codes(snap({ isGame: true, oi: 600_000 }), pastOf({ 3600: { oi: 500_000 } }))).toContain('oi_surge');
  });

  it('skips settled events with no liquidity and no open interest', () => {
    expect(scoreEvent(snap({ liq: 0, oi: 384, vol24: 1_000_000, ch1h: 0.5 }), never, null, NOW)).toBeNull();
  });
});

describe('large fills and wallets', () => {
  const p = (over: Partial<PrintRow> = {}): PrintRow => ({
    key: Math.random().toString(36), ts: NOW - 600, wallet: '0xa', cid: '0xc1', eventSlug: 'ev', title: 't', outcome: 'Yes', side: 'BUY', price: 0.4, size: 25_000, usd: 10_000, name: null, ...over,
  });

  it('tags wallets by history', () => {
    expect(tagWallet(undefined, NOW).kind).toBe('?');
    expect(tagWallet({ firstSeen: NOW - 3 * 86_400, traded: 2 }, NOW).kind).toBe('NEW');
    expect(tagWallet({ firstSeen: NOW - 400 * 86_400, traded: 3 }, NOW).kind).toBe('THIN');
    expect(tagWallet({ firstSeen: NOW - 400 * 86_400, traded: 900 }, NOW).kind).toBe('WHALE');
    expect(tagWallet({ firstSeen: NOW - 400 * 86_400, traded: 80 }, NOW).kind).toBe('REG');
  });

  it('measures the last hour of fills and fresh money', () => {
    const tags = new Map([['0xa', tagWallet({ firstSeen: NOW - 86_400, traded: 1 }, NOW)], ['0xb', tagWallet({ firstSeen: NOW - 900 * 86_400, traded: 900 }, NOW)]]);
    const flow = flowBySlug([p(), p({ wallet: '0xb', usd: 60_000 }), p({ ts: NOW - 7_200, usd: 99_000 })], tags, NOW).get('ev')!;
    expect(flow).toMatchObject({ prints1h: 2, usd1h: 70_000, biggestUsd: 60_000, freshUsd: 10_000, freshWallets: 1, cluster: false });
    expect(flow.top).toMatchObject({ usd: 60_000, tag: 'WHALE' });
  });

  it('detects several new wallets backing one outcome within the window', () => {
    const tags = new Map<string, ReturnType<typeof tagWallet>>();
    const prints: PrintRow[] = [];
    for (let i = 0; i < D.clusterMinWallets; i++) {
      tags.set(`0x${i}`, tagWallet({ firstSeen: NOW - 86_400, traded: 1 }, NOW));
      prints.push(p({ wallet: `0x${i}`, ts: NOW - 600 + i * 60, usd: 3_000 }));
    }
    expect(flowBySlug(prints, tags, NOW).get('ev')!.cluster).toBe(true);
    // same wallets spread over two outcomes is not a cluster
    const split = prints.map((x, i) => ({ ...x, outcome: i === 0 ? 'No' : 'Yes' }));
    expect(flowBySlug(split, tags, NOW).get('ev')!.cluster).toBe(false);
  });

  it('adds fill reasons to the score', () => {
    const flow: PrintFlow = { usd1h: 120_000, prints1h: 6, biggestUsd: 40_000, freshUsd: 15_000, freshWallets: 2, cluster: true, top: null };
    expect(codes(snap(), never, flow)).toEqual(expect.arrayContaining(['big_prints', 'fresh_money', 'wallet_cluster']));
  });
});

describe('ranking and mapping', () => {
  it('ranks by score, then volume', () => {
    const a = snap({ eventId: 'a', slug: 'a', vol24: 500_000, vol1w: 520_000 });
    const b = snap({ eventId: 'b', slug: 'b', vol24: 900_000, vol1w: 950_000, ch1h: 0.3 });
    const ranked = rankAnomalies([a, b], never, new Map(), NOW);
    expect(ranked.map((x) => x.eventId)).toEqual(['b', 'a']);
  });

  it('maps a Gamma event to a snapshot with game and category detection', () => {
    const s = mapSnapshot({
      id: 7, slug: 'x', title: 'A vs. B', openInterest: '1500', volume24hr: 10, volume1wk: 70, liquidity: '9', createdAt: '2026-10-01T00:00:00Z', endDate: '2026-11-01T00:00:00Z',
      tags: [{ slug: 'games' }, { slug: 'Sports' }],
      markets: [{ volume24hr: 1, sportsMarketType: 'moneyline', lastTradePrice: 0.7, oneHourPriceChange: -0.2 }, { volume24hr: 9, gameStartTime: '2026-10-31 10:00:00+00', outcomePrices: '["0.55","0.45"]', oneHourPriceChange: 0.1, oneDayPriceChange: 0.3 }],
    }, NOW)!;
    expect(s).toMatchObject({ eventId: '7', oi: 1500, isGame: true, cat: 'sports', ch1h: 0.1, ch1d: 0.3, price: 0.55, startsAt: Date.parse('2026-10-31T10:00:00Z') / 1000 });
    expect(mapSnapshot({ id: 1, slug: 's', title: 't', markets: [{ volume24hr: 1 }] }, NOW)).toMatchObject({ isGame: false, cat: '' });
    expect(mapSnapshot({ slug: 'no-id' }, NOW)).toBeNull();
  });

  it('maps a large trade to a print with a stable key', () => {
    const raw = { proxyWallet: '0xAB', side: 'BUY', conditionId: '0xc', size: 100, price: 0.5, timestamp: 5, outcomeIndex: 0, outcome: 'Yes', title: 'T', eventSlug: 'ev', transactionHash: '0xh', name: 'bob' };
    const a = mapPrint(raw)!;
    expect(a).toMatchObject({ wallet: '0xab', usd: 50, eventSlug: 'ev', name: 'bob' });
    expect(mapPrint(raw)!.key).toBe(a.key);
    expect(mapPrint({ ...raw, side: 'X' })).toBeNull();
  });
});

describe('storage of snapshots and prints', () => {
  it('finds the nearest earlier snapshot, falling back to the earliest', () => {
    const s = openStore();
    s.insertSnapshots([snap({ ts: 100, oi: 1 }), snap({ ts: 200, oi: 2 }), snap({ ts: 300, oi: 3 })]);
    expect(s.snapshotNear('e1', 250)?.oi).toBe(2);
    expect(s.snapshotNear('e1', 50)?.oi).toBe(1);
    expect(s.snapshotNear('nope', 250)).toBeUndefined();
    expect(s.snapshotSpan()).toEqual({ first: 100, last: 300 });
    expect(s.latestSnapshots()).toHaveLength(1);
    expect(s.snapshotSeries('e1', 150).map((x) => x.oi)).toEqual([2, 3]);
    s.pruneOld(250, 0);
    expect(s.snapshotSeries('e1', 0)).toHaveLength(1);
    s.close();
  });

  it('stores prints once and migrates databases created before categories existed', () => {
    const s = openStore();
    const pr: PrintRow = { key: 'k', ts: 5, wallet: '0xa', cid: '0xc', eventSlug: 'ev', title: 't', outcome: 'Yes', side: 'BUY', price: 0.5, size: 10, usd: 5, name: null };
    expect(s.insertPrints([pr])).toBe(1);
    expect(s.insertPrints([pr])).toBe(0);
    expect(s.printsSince(0)).toHaveLength(1);
    s.close();
  });
});

describe('games', () => {
  const game = (over: Partial<SnapRow> = {}): SnapRow => snap({ isGame: true, cat: 'sports', title: 'A vs. B', startsAt: NOW + 7_200, price: 0.5, vol24: 200_000, vol1w: 210_000, endDate: NOW + 3 * 86_400, ...over });

  it('knows the phase of a game', () => {
    expect(gamePhase(NOW + 60, NOW)).toBe('PRE');
    expect(gamePhase(NOW - 3_600, NOW)).toBe('LIVE');
    expect(gamePhase(NOW - 5 * 3_600, NOW)).toBe('OVER');
    expect(gamePhase(null, NOW)).toBe('UNKNOWN');
  });

  it('only lists games starting within a day or live now', () => {
    expect(scoreGame(game(), never, null, NOW)).not.toBeNull();
    expect(scoreGame(game({ startsAt: NOW + 3 * 86_400 }), never, null, NOW)).toBeNull();
    expect(scoreGame(game({ startsAt: NOW - 5 * 3_600 }), never, null, NOW)).toBeNull();
    expect(scoreGame(game({ startsAt: null }), never, null, NOW)).toBeNull();
  });

  it('keeps quiet games on the list with a zero score', () => {
    const a = scoreGame(game(), never, null, NOW)!;
    expect(a.score).toBe(0);
    expect(a.startsAt).toBe(NOW + 7_200);
  });

  it('flags a pre-game line move from our own snapshots', () => {
    const past: PastFn = (id, t) => ({ ...game({ eventId: id, ts: NOW - 1_800, price: 0.4 }), ts: t <= NOW - 1_800 ? NOW - 1_800 : t });
    const a = scoreGame(game({ price: 0.5 }), past, null, NOW)!;
    expect(a.reasons.map((r) => r.code)).toContain('line_move');
    expect(a.m.dPrice30m).toBeCloseTo(0.1);
  });

  it('ignores line moves once the game is live (price swings with the score)', () => {
    const past: PastFn = (id) => game({ eventId: id, ts: NOW - 1_800, price: 0.2 });
    const a = scoreGame(game({ startsAt: NOW - 1_200, price: 0.7 }), past, null, NOW)!;
    expect(a.reasons.map((r) => r.code)).not.toContain('line_move');
    expect(a.notes.join()).toMatch(/live/);
  });

  it('drops live games whose main market has already settled', () => {
    expect(scoreGame(game({ startsAt: NOW - 3_000, price: 1 }), never, null, NOW)).toBeNull();
    expect(scoreGame(game({ startsAt: NOW - 3_000, price: 0.01 }), never, null, NOW)).toBeNull();
    expect(scoreGame(game({ startsAt: NOW - 3_000, price: 0.6 }), never, null, NOW)).not.toBeNull();
    expect(scoreGame(game({ startsAt: NOW + 600, price: 0.99 }), never, null, NOW)).not.toBeNull(); // pre-game extremes are legitimate (heavy favourites)
  });

  it('still reports OI surges in games', () => {
    const a = scoreGame(game({ oi: 600_000 }), pastOf({ 3600: { oi: 500_000, isGame: true, startsAt: NOW + 7_200 } }), null, NOW)!;
    expect(a.reasons.map((r) => r.code)).toContain('oi_surge');
  });

  it('keeps games out of the anomaly list and out-ranks quiet ones in the games list', () => {
    const quiet = game({ eventId: 'q', slug: 'q', startsAt: NOW + 1_000 });
    const busy = game({ eventId: 'b', slug: 'b', startsAt: NOW + 20_000, oi: 700_000 });
    const past = pastOf({ 3600: { oi: 500_000 } });
    expect(rankAnomalies([quiet, busy], past, new Map(), NOW)).toEqual([]);
    expect(rankGames([quiet, busy], past, new Map(), NOW).map((x) => x.eventId)).toEqual(['b', 'q']);
  });
});
