import { v2 } from './v2';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonl } from '../../radar/forward';
import { candidatesOf, captureEntries, detectJump, detectJumpAny, flowOf, formatJumps, logJumps, scanJumps, scoreJumps, settleJumps, type JumpFlag, type PricePoint } from '../../radar/jump';
import { NO_EDGE } from '../../radar/ledger';
import { PolymarketClient, type FetchJson } from '../../radar/polymarket';
import type { TradeRow } from '../../radar/store';

const M = 60;
const H = 3600;
const NOW_S = Date.UTC(2026, 10, 1, 12, 0, 0) / 1000;
const NOW = NOW_S * 1000;
const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };
const dir = () => mkdtempSync(join(tmpdir(), 'jump-'));

/** Calm points every 10 min over the 24h ending 30 min ago at `calm` (optionally one outlier), then `now` at NOW_S. */
function series(calm: number, now: number, opts: { outlier?: number; points?: number } = {}): PricePoint[] {
  const ref = NOW_S - 30 * M;
  const n = opts.points ?? 145;
  const out: PricePoint[] = [];
  for (let i = n - 1; i >= 0; i--) out.push({ t: ref - i * 10 * M, p: calm });
  if (opts.outlier !== undefined) out[0] = { t: out[0].t, p: opts.outlier };
  out.push({ t: NOW_S - 5 * M, p: now });
  return out;
}

describe('detectJump', () => {
  it('fires at the move and band boundaries, not just inside them', () => {
    expect(detectJump(series(0.5, 0.65), { now: NOW_S })).toMatchObject({ jump: true, direction: 'up', pRef: 0.5, pNow: 0.65, move: 0.15 });
    expect(detectJump(series(0.5, 0.35), { now: NOW_S })).toMatchObject({ jump: true, direction: 'down', move: -0.15 });
    expect(detectJump(series(0.5, 0.6499), { now: NOW_S })).toEqual({ jump: false, reason: 'small-move' });
    expect(detectJump(series(0.1, 0.25), { now: NOW_S })).toMatchObject({ jump: true, pRef: 0.1 });
    expect(detectJump(series(0.9, 0.75), { now: NOW_S })).toMatchObject({ jump: true, pRef: 0.9 });
    expect(detectJump(series(0.09, 0.3), { now: NOW_S })).toEqual({ jump: false, reason: 'ref-out-of-band' });
    expect(detectJump(series(0.91, 0.7), { now: NOW_S })).toEqual({ jump: false, reason: 'ref-out-of-band' });
  });
  it('requires a calm 24h: range <= 0.10 over >= 3 points', () => {
    expect(detectJump(series(0.5, 0.7, { outlier: 0.6 }), { now: NOW_S })).toMatchObject({ jump: true, calmRange: 0.1 });
    expect(detectJump(series(0.5, 0.7, { outlier: 0.6001 }), { now: NOW_S })).toEqual({ jump: false, reason: 'not-calm' });
    expect(detectJump(series(0.5, 0.7, { points: 3 }), { now: NOW_S })).toMatchObject({ jump: true, calmPoints: 3 });
    expect(detectJump(series(0.5, 0.7, { points: 2 }), { now: NOW_S })).toEqual({ jump: false, reason: 'too-few-points' });
    // a point older than 24h before the reference is outside the calm window and cannot break it
    const s = series(0.5, 0.7);
    s.unshift({ t: NOW_S - 30 * M - 25 * H, p: 0.95 });
    expect(detectJump(s, { now: NOW_S }).jump).toBe(true);
  });
  it('needs a price inside the last 30 min and ignores junk points', () => {
    const s = series(0.5, 0.7).slice(0, -1);
    expect(detectJump(s, { now: NOW_S })).toEqual({ jump: false, reason: 'no-recent-price' });
    expect(detectJump([], {})).toEqual({ jump: false, reason: 'no-recent-price' });
    expect(detectJump([...series(0.5, 0.7), { t: NaN, p: 0.1 }, { t: NOW_S - 60, p: 7 }], { now: NOW_S }).jump).toBe(true);
  });
});

describe('detectJumpAny', () => {
  // cartel-like positive control: prior day hourly 0.09-0.27, then 0.155@15:50, 0.26@16:30, 0.49@17:30 (UTC, Oct 31)
  const at = (h: number, m: number) => Date.UTC(2026, 9, 31, h, m) / 1000;
  const prior: PricePoint[] = [];
  for (let i = 24; i >= 1; i--) prior.push({ t: at(15, 50) - i * H, p: i % 2 ? 0.09 : 0.27 });
  const cartel = [...prior, { t: at(15, 50), p: 0.155 }, { t: at(16, 30), p: 0.26 }, { t: at(17, 30), p: 0.49 }];

  it('fires on the sparse cartel series only while a point sits inside the 30-min window', () => {
    expect(detectJump(cartel, { now: at(17, 30) }).jump).toBe(false); // frozen rule misses it
    expect(detectJumpAny(cartel, { now: at(17, 30) })).toMatchObject({ jump: true, direction: 'up', pRef: 0.26, pNow: 0.49, move: 0.23, calm: false });
    // ref 45 min old (sparse history), last point inside the window
    expect(detectJumpAny(cartel, { now: at(17, 45) })).toMatchObject({ jump: true, pRef: 0.26, pNow: 0.49 });
    // window (17:40, 18:10] holds no point
    expect(detectJumpAny(cartel, { now: at(18, 10) })).toEqual({ jump: false, reason: 'no-recent-price' });
    // at 16:30 the move from 0.155 is only 0.105
    expect(detectJumpAny(cartel, { now: at(16, 30) })).toEqual({ jump: false, reason: 'small-move' });
    const r = detectJumpAny(cartel, { now: at(17, 30) });
    expect(r.jump && r.calmRange).toBeGreaterThan(0.1);
  });
  it('takes pRef as the last point at or before refTs, no older than 6h', () => {
    const s = (ageH: number): PricePoint[] => [{ t: NOW_S - 30 * M - ageH * H, p: 0.4 }, { t: NOW_S - 5 * M, p: 0.6 }];
    expect(detectJumpAny(s(6), { now: NOW_S })).toMatchObject({ jump: true, pRef: 0.4, calm: false, calmPoints: 1, calmRange: 0 });
    expect(detectJumpAny(s(6.01), { now: NOW_S })).toEqual({ jump: false, reason: 'stale-ref' });
    expect(detectJumpAny([{ t: NOW_S - 5 * M, p: 0.6 }], { now: NOW_S })).toEqual({ jump: false, reason: 'no-ref' });
    expect(detectJumpAny([{ t: NOW_S - 40 * M, p: 0.95 }, { t: NOW_S - 5 * M, p: 0.6 }], { now: NOW_S })).toEqual({ jump: false, reason: 'ref-out-of-band' });
  });
  it('calm=true exactly when the frozen rule holds, and is a superset of it', () => {
    expect(detectJumpAny(series(0.5, 0.65), { now: NOW_S })).toMatchObject({ jump: true, calm: true, calmRange: 0, pRef: 0.5 });
    expect(detectJumpAny(series(0.5, 0.7, { outlier: 0.6001 }), { now: NOW_S })).toMatchObject({ jump: true, calm: false, calmRange: 0.1001 });
    // frozen fires with a ref 10h old (3 calm points); the loose rule alone would call it stale, but the union keeps it
    const old = [0, 1, 2].map((i) => ({ t: NOW_S - 30 * M - (10 + i) * H, p: 0.5 })).concat([{ t: NOW_S - 5 * M, p: 0.7 }]);
    expect(detectJump(old, { now: NOW_S }).jump).toBe(true);
    expect(detectJumpAny(old, { now: NOW_S })).toMatchObject({ jump: true, calm: true });
    expect(detectJumpAny(series(0.5, 0.6499), { now: NOW_S })).toEqual({ jump: false, reason: 'small-move' });
  });
});

describe('flowOf', () => {
  const tr = (wallet: string, side: 'BUY' | 'SELL', usd: number, ts: number): TradeRow => ({ cid: 'c', wallet, side, outcomeIndex: 0, price: 0.5, size: usd * 2, ts, tx: null });
  it('counts 30-min volume and buy USD from wallets new to the market, only with full history', () => {
    const t = [tr('old', 'BUY', 10, NOW_S - 2 * H), tr('old', 'BUY', 30, NOW_S - 60), tr('new', 'BUY', 90, NOW_S - 60), tr('new', 'SELL', 20, NOW_S - 60)];
    expect(flowOf(t, NOW_S, true)).toEqual({ vol30m: 140, freshShare: 0.75 });
    expect(flowOf(t, NOW_S, false)).toEqual({ vol30m: 140, freshShare: null });
  });
});

// ---- fake API ----
const flag = (cid: string, at: number, over: Partial<JumpFlag> = {}): JumpFlag => ({ cid, slug: `m-${cid}`, eventSlug: `e-${cid}`, title: cid, outcomes: ['Yes', 'No'], tokenIds: [`${cid}y`, `${cid}n`], direction: 'up', upIdx: 0, pRef: 0.4, pNow: 0.6, move: 0.2, calmRange: 0.05, calmPoints: 145, calm: true, vol30m: 1000, freshShare: null, quotes: [], detectedAt: at, ...over });

function fakeApi(opts: { books?: Record<string, { bids: Array<[number, number]>; asks: Array<[number, number]> }>; events?: Array<Record<string, unknown>>; history?: Record<string, PricePoint[]>; closed?: Record<string, unknown>; trades?: unknown[] } = {}) {
  const calls: string[] = [];
  const fetchJson: FetchJson = async (url) => {
    calls.push(url);
    if (url.includes('/prices-history')) {
      const tok = /market=(\w+)/.exec(url)![1];
      return { history: opts.history?.[tok] ?? [] };
    }
    if (url.includes('/events?active=true')) return /offset=0&/.test(url) ? (opts.events ?? []) : [];
    const tok = /token_id=(\w+)/.exec(url)?.[1];
    if (tok) {
      const b = opts.books?.[tok] ?? { bids: [], asks: [] };
      return { bids: b.bids.map(([price, size]) => ({ price: String(price), size: String(size) })), asks: b.asks.map(([price, size]) => ({ price: String(price), size: String(size) })) };
    }
    if (url.includes('/v2/trades?')) return v2(opts.trades ?? []);
    const slug = /slug=([\w-]+)/.exec(url)?.[1];
    if (slug) return opts.closed?.[slug] ? [opts.closed[slug]] : [];
    throw new Error(`unexpected ${url}`);
  };
  return { client: new PolymarketClient(fetchJson, fast), fetchJson, calls };
}

describe('scanJumps', () => {
  it('screens on gamma 1h change, confirms on prices-history, and reads both books', async () => {
    const mk = (cid: string, ch1h: number | null, vol: number, extra: Record<string, unknown> = {}) => ({ conditionId: cid, slug: `m-${cid}`, question: `Q ${cid}?`, outcomes: '["Yes","No"]', clobTokenIds: JSON.stringify([`${cid}y`, `${cid}n`]), volume24hr: vol, oneHourPriceChange: ch1h, active: true, closed: false, ...extra });
    const events = [{ slug: 'ev', title: 'Ev', markets: [mk('a', 0.2, 900), mk('b', 0.04, 800), mk('c', -0.3, 700), mk('d', null, 600), mk('e', 0.5, 500, { closed: true }), mk('f', 0.12, 400)] }];
    const history = { ay: series(0.4, 0.6), cy: series(0.5, 0.45), fy: series(0.3, 0.55, { outlier: 0.45 }) };
    const books = { ay: { bids: [[0.58, 10]] as Array<[number, number]>, asks: [[0.61, 10]] as Array<[number, number]> }, an: { bids: [] as Array<[number, number]>, asks: [[0.42, 10]] as Array<[number, number]> } };
    const trades = [{ conditionId: 'a', proxyWallet: '0xN', side: 'BUY', price: 0.6, size: 100, timestamp: NOW_S - 120, outcomeIndex: 0 }];
    const { client, fetchJson, calls } = fakeApi({ events, history, books, trades });
    const s = await scanJumps(client, { fetchJson, now: () => NOW });
    expect(s).toMatchObject({ markets: 5, screened: 3, checked: 3, reasons: { 'small-move': 1 }, errors: [] });
    expect(calls.filter((u) => u.includes('prices-history')).every((u) => /fidelity=10\b/.test(u))).toBe(true);
    expect(s.flags.map((f) => [f.cid, f.calm])).toEqual([['a', true], ['f', false]]);
    expect(s.flags[0]).toMatchObject({ cid: 'a', slug: 'm-a', eventSlug: 'ev', title: 'Q a?', direction: 'up', upIdx: 0, pRef: 0.4, pNow: 0.6, vol30m: 60, freshShare: 1, detectedAt: NOW_S });
    expect(s.flags[1]).toMatchObject({ pRef: 0.3, pNow: 0.55, calmRange: 0.15 });
    expect(s.flags[0].quotes).toEqual([{ outcome: 'Yes', bid: 0.58, ask: 0.61 }, { outcome: 'No', bid: null, ask: 0.42 }]);
  });
});

describe('logJumps', () => {
  it('writes one line per cid and never twice within 24h', () => {
    const path = join(dir(), 'jumps.jsonl');
    expect(logJumps([flag('a', NOW_S), flag('a', NOW_S + 60), flag('b', NOW_S)], path).map((l) => l.id)).toEqual([`a|${NOW_S}`, `b|${NOW_S}`]);
    expect(logJumps([flag('a', NOW_S + 24 * H - 1)], path)).toHaveLength(0);
    expect(logJumps([flag('a', NOW_S + 24 * H)], path)).toHaveLength(1);
    const lines = parseJsonl(readFileSync(path, 'utf8'));
    expect(lines.map((l) => l.id)).toEqual([`a|${NOW_S}`, `b|${NOW_S}`, `a|${NOW_S + 24 * H}`]);
    expect(lines[0]).toMatchObject({ v: 1, kind: 'flag', cid: 'a', flaggedAt: NOW_S });
  });
  it('dry run writes nothing', () => {
    const path = join(dir(), 'jumps.jsonl');
    expect(logJumps([flag('a', NOW_S)], path, { dryRun: true })).toHaveLength(1);
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });
});

describe('captureEntries', () => {
  const both = { bids: [[0.55, 10]] as Array<[number, number]>, asks: [[0.6, 10]] as Array<[number, number]> };
  it('enters 5-15 min after the flag, skips one-sided books, never twice', async () => {
    const path = join(dir(), 'jumps.jsonl');
    logJumps([flag('a', NOW_S), flag('b', NOW_S), flag('c', NOW_S - 20 * M)], path);
    const { client } = fakeApi({ books: { ay: both, an: { bids: [[0.38, 5]], asks: [[0.42, 5]] }, by: both, bn: { bids: [[0.3, 5]], asks: [] } } });
    const early = await captureEntries(client, path, { now: () => NOW + 4 * 60_000 });
    expect(early).toMatchObject({ due: 0, written: 0, missed: 1 });
    const r = await captureEntries(client, path, { now: () => NOW + 5 * 60_000 });
    expect(r).toMatchObject({ due: 2, written: 1, skippedOneSided: 1, missed: 1, errors: [] });
    const entries = parseJsonl(readFileSync(path, 'utf8')).filter((l) => l.kind === 'entry');
    expect(entries).toEqual([{ v: 1, kind: 'entry', id: `a|${NOW_S}`, cid: 'a', capturedAt: NOW_S + 300, lagSecs: 300, quotes: [{ outcome: 'Yes', bid: 0.55, ask: 0.6, mid: 0.575, bidUsd: 5.5, askUsd: 6 }, { outcome: 'No', bid: 0.38, ask: 0.42, mid: 0.4, bidUsd: 1.9, askUsd: 2.1 }] }]);
    const again = await captureEntries(client, path, { now: () => NOW + 15 * 60_000 });
    expect(again).toMatchObject({ due: 1, written: 0, skippedOneSided: 1 });
    expect(parseJsonl(readFileSync(path, 'utf8')).filter((l) => l.kind === 'entry')).toHaveLength(1);
  });
});

describe('settleJumps', () => {
  it('writes each result once and tolerates malformed lines', async () => {
    const path = join(dir(), 'jumps.jsonl');
    logJumps([flag('a', NOW_S), flag('b', NOW_S)], path);
    writeFileSync(path, readFileSync(path, 'utf8') + 'garbage{\n{"kind":"flag","cid":"x"\n[1]\n');
    const closed = {
      'e-a': { slug: 'e-a', title: 'a', markets: [{ conditionId: 'a', closed: true, outcomePrices: '["0","1"]', outcomes: '["Yes","No"]' }] },
      'e-b': { slug: 'e-b', title: 'b', markets: [{ conditionId: 'b', closed: false, outcomePrices: '["0.6","0.4"]', outcomes: '["Yes","No"]' }] },
    };
    const { client } = fakeApi({ closed });
    expect(await settleJumps(client, path, { now: () => NOW })).toMatchObject({ pending: 2, settled: 1, errors: [] });
    const results = () => parseJsonl(readFileSync(path, 'utf8')).filter((l) => l.kind === 'result');
    expect(results()).toEqual([{ v: 1, kind: 'result', cid: 'a', winnerIdx: 1, payout: [0, 1], settledAt: NOW_S }]);
    expect(await settleJumps(client, path, { now: () => NOW + 1000 })).toMatchObject({ pending: 1, settled: 0 });
    expect(results()).toHaveLength(1);
  });
});

describe('scoreJumps', () => {
  const entry = (id: string, cid: string, askUp: number, askDown: number) => ({ v: 1, kind: 'entry', id, cid, capturedAt: 0, lagSecs: 300, quotes: [{ outcome: 'Yes', bid: askUp - 0.02, ask: askUp, mid: askUp - 0.01, bidUsd: 1, askUsd: 1 }, { outcome: 'No', bid: askDown - 0.02, ask: askDown, mid: askDown - 0.01, bidUsd: 1, askUsd: 1 }] });
  const fl = (cid: string, day: number, fresh: number | null, calm: boolean | undefined = true) => {
    const l: Record<string, unknown> = { v: 1, kind: 'flag', id: `${cid}|${NOW_S + day * 86400}`, ...flag(cid, NOW_S + day * 86400, { freshShare: fresh }), flaggedAt: NOW_S + day * 86400 };
    if (calm === undefined) delete l.calm;
    else l.calm = calm;
    return l as { id: string; cid: string } & Record<string, unknown>;
  };
  const res = (cid: string, winnerIdx: number) => ({ v: 1, kind: 'result', cid, winnerIdx, payout: winnerIdx === 0 ? [1, 0] : [0, 1], settledAt: 0 });

  function log(n: number): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) {
      const f = fl(`c${i}`, i % 7, i % 2 ? 0.8 : 0.2);
      out.push(f, entry(f.id, f.cid, 0.6, 0.42), res(f.cid, i % 3 === 0 ? 0 : 1));
    }
    return out;
  }

  it('fills at the chosen outcome entry ask, follow-fresh only at freshShare >= 0.5, skips malformed', () => {
    const lines = [...log(4), 'junk', { kind: 'entry', id: 'x', quotes: [] }, fl('c0', 0, 0.2), fl('nores', 1, 0.9), entry(fl('nores', 1, 0.9).id, 'nores', 0.6, 0.42)];
    const r = scoreJumps(lines, { iterations: 200 });
    expect(r).toMatchObject({ flags: 5, entries: 5, settled: 4, skippedLines: 3 });
    const [fade, follow, fresh] = r.strategies;
    expect(fade).toMatchObject({ id: 'jump-fade', n: 4, wins: 2, hitRate: 0.5, verdict: NO_EDGE });
    expect(fade.bets.every((b) => b.outcomeIdx === 1 && b.price === 0.42)).toBe(true);
    expect(fade.roi).toBeCloseTo(0.5 / 0.42 - 1, 9);
    expect(follow).toMatchObject({ id: 'jump-follow', n: 4, wins: 2, breakEven: 0.6 });
    expect(fresh.bets.map((b) => b.cid)).toEqual(['c1', 'c3']);
  });

  it('bootstrap CI is deterministic for a seed; small n is always NO EDGE PROVEN', () => {
    const lines = log(60).map((l) => (l && (l as any).kind === 'entry' ? entry((l as any).id, (l as any).cid, 0.6, 0.1) : l));
    const a = scoreJumps(lines, { iterations: 300, seed: 7 });
    const b = scoreJumps(lines, { iterations: 300, seed: 7 });
    expect(a.strategies[0].ci).toEqual(b.strategies[0].ci);
    expect(a.strategies[0].ci![0]).toBeGreaterThan(0); // huge fake edge...
    expect(a.strategies[0].verdict).toBe(NO_EDGE); // ...still not proven at n=60
    expect(scoreJumps([], {}).strategies.every((s) => s.n === 0 && s.ci === null && s.verdict === NO_EDGE)).toBe(true);
  });

  it('original strategies see calm flags only (old lines without calm count as calm); -any strategies see all', () => {
    const lines: unknown[] = [];
    const add = (cid: string, calm: boolean | undefined) => {
      const f = fl(cid, 0, 0.9, calm);
      lines.push(f, entry(f.id, f.cid, 0.6, 0.42), res(f.cid, 1));
    };
    add('calm', true);
    add('old', undefined);
    add('loose', false);
    const r = scoreJumps(lines, { iterations: 100 });
    expect(r).toMatchObject({ flags: 3, calmFlags: 2, settled: 3, skippedLines: 0 });
    const by = Object.fromEntries(r.strategies.map((s) => [s.id, s]));
    expect(Object.keys(by)).toEqual(['jump-fade', 'jump-follow', 'jump-follow-fresh', 'jump-fade-any', 'jump-follow-any']);
    for (const id of ['jump-fade', 'jump-follow', 'jump-follow-fresh']) expect(by[id].bets.map((b) => b.cid)).toEqual(['calm', 'old']);
    expect(by['jump-fade-any'].bets.map((b) => [b.cid, b.outcomeIdx, b.price])).toEqual([['calm', 1, 0.42], ['loose', 1, 0.42], ['old', 1, 0.42]]);
    expect(by['jump-follow-any'].bets.map((b) => b.outcomeIdx)).toEqual([0, 0, 0]);
    expect(r.strategies.every((s) => s.verdict === NO_EDGE)).toBe(true);
    expect(scoreJumps([{ ...fl('bad', 0, null), calm: 'yes' }]).flags).toBe(0);
  });

  it('format says leads, not signals, never accuses, and quotes the backtest', () => {
    const text = formatJumps(scoreJumps(log(4), { iterations: 100 })).join('\n');
    expect(text).toMatch(/leads, not trade signals/);
    expect(text).toMatch(/never accuse a wallet/);
    expect(text).toMatch(/2,400 markets.*\+13\.0%.*\[-4%, \+32%\].*n=357.*not significant/);
    expect(text).toMatch(/jump-follow-fresh/);
    expect(text).toMatch(/jump-fade-any/);
    expect(text).toMatch(/\+14\.3%.*\[\+0\.4%, \+29\.4%\].*n=606.*-8\.9%.*\+7\.6%.*\[-4\.8%, \+19\.7%\]/);
    expect(text).toMatch(/chosen after seeing these results.*only forward flags count/);
    expect(text).toMatch(/4 flags \(4 calm, 0 loose-only\)/);
  });
});

describe('sports and side markets are never candidates', () => {
  const mk = (over: Record<string, unknown> = {}) => ({ conditionId: '0xa', slug: 'm', question: 'Will X happen?', outcomes: '["Yes","No"]', clobTokenIds: '["1","2"]', active: true, closed: false, acceptingOrders: true, ...over });
  const ev = (over: Record<string, unknown> = {}, markets: unknown[] = [mk()]) => ({ slug: 'e', title: 'T', markets, ...over });
  it('keeps an ordinary event market', () => {
    expect(candidatesOf([ev()])).toHaveLength(1);
  });
  it('drops events with a sports market type (moneyline, spreads, totals, props) and every sibling market', () => {
    for (const t of ['moneyline', 'spreads', 'totals', 'points', 'soccer_exact_score']) expect(candidatesOf([ev({}, [mk({ sportsMarketType: t })])]), t).toHaveLength(0);
    expect(candidatesOf([ev({}, [mk(), mk({ conditionId: '0xb', sportsMarketType: 'spreads' })])])).toHaveLength(0);
  });
  it('drops events with a game id, live/ended game state, or a Sports / Esports / Games tag', () => {
    expect(candidatesOf([ev({ gameId: '19571' })])).toHaveLength(0);
    expect(candidatesOf([ev({ live: false })])).toHaveLength(0);
    expect(candidatesOf([ev({ ended: true })])).toHaveLength(0);
    for (const slug of ['sports', 'esports', 'games']) expect(candidatesOf([ev({ tags: [{ slug }] })]), slug).toHaveLength(0);
  });
  it('keeps politics and geopolitics events', () => {
    expect(candidatesOf([ev({ tags: [{ slug: 'politics' }, { slug: 'geopolitics' }] })])).toHaveLength(1);
  });
});

describe('pre-game match-winner markets are allowed, nothing else in sports', () => {
  const NOW = Date.UTC(2026, 10, 2, 12) / 1000;
  const mk = (over: Record<string, unknown> = {}) => ({ conditionId: '0xa', slug: 'm', question: 'Team A vs Team B', outcomes: '["A","B"]', clobTokenIds: '["1","2"]', active: true, closed: false, acceptingOrders: true, sportsMarketType: 'moneyline', gameStartTime: '2026-11-02 18:00:00+00', ...over });
  const ev = (over: Record<string, unknown> = {}, markets: unknown[] = [mk()]) => ({ slug: 'g', title: 'G', gameId: '1', live: false, ended: false, markets, ...over });
  it('keeps the moneyline of a game that starts later and marks it pregame', () => {
    const c = candidatesOf([ev()], NOW);
    expect(c).toHaveLength(1);
    expect(c[0].pregame).toBe(true);
  });
  it('drops the same moneyline once the game is live, ended, or its start time has passed or is unknown', () => {
    expect(candidatesOf([ev({ live: true })], NOW)).toHaveLength(0);
    expect(candidatesOf([ev({ ended: true })], NOW)).toHaveLength(0);
    expect(candidatesOf([ev({}, [mk({ gameStartTime: '2026-11-02 11:00:00+00' })])], NOW)).toHaveLength(0);
    expect(candidatesOf([ev({}, [mk({ gameStartTime: undefined })])], NOW)).toHaveLength(0);
  });
  it('still drops every side market of a pre-game event, even next to the moneyline', () => {
    const c = candidatesOf([ev({}, [mk(), mk({ conditionId: '0xb', sportsMarketType: 'spreads' }), mk({ conditionId: '0xc', sportsMarketType: 'totals' }), mk({ conditionId: '0xd', sportsMarketType: 'points' })])], NOW);
    expect(c.map((x) => x.cid)).toEqual(['0xa']);
  });
  it('non-sports markets are never marked pregame', () => {
    const c = candidatesOf([{ slug: 'e', title: 'T', markets: [{ conditionId: '0xe', slug: 's', question: 'Q', outcomes: '["Yes","No"]', clobTokenIds: '["1","2"]', active: true, closed: false, acceptingOrders: true }] }], NOW);
    expect(c[0].pregame).toBe(false);
  });
  it('scoreJumps keeps the pregame block separate from the default block', () => {
    const flag = (id: string, pregame?: boolean) => ({ v: 1, kind: 'flag', id, cid: id, slug: 's', eventSlug: 'e', title: 't', outcomes: ['A', 'B'], tokenIds: ['1', '2'], direction: 'up', upIdx: 0, pRef: 0.3, pNow: 0.5, move: 0.2, calmRange: 0.05, calmPoints: 5, calm: true, vol30m: 1, freshShare: null, quotes: [], detectedAt: 1, flaggedAt: 1, ...(pregame ? { pregame } : {}) });
    const lines = [flag('a|1'), flag('b|1', true), flag('c|1', true)];
    expect(scoreJumps(lines).flags).toBe(1);
    expect(scoreJumps(lines, { pregame: true }).flags).toBe(2);
  });
});
