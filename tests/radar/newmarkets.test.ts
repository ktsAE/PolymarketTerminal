import { cursorPage, v2 } from './v2';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NEWMARKET_THRESHOLDS as T, earlyFeatures, logFlagged, scanNewMarkets, scoreFeatures, scoreNewMarketLog, summarizeNewMarkets, type EarlyFeatures, type NewMarketLine } from '../../radar/newmarkets';
import { parseJsonl } from '../../radar/forward';
import { PolymarketClient, type FetchJson } from '../../radar/polymarket';
import type { TradeRow } from '../../radar/store';

const H = 3600;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // ms
const NOW_S = NOW / 1000;
const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };
const dir = () => mkdtempSync(join(tmpdir(), 'newm-'));

let seq = 0;
const tr = (p: Partial<TradeRow> & { ts: number }): TradeRow => ({ cid: '0xc', wallet: `0xw${seq++}`, side: 'BUY', outcomeIndex: 0, price: 0.5, size: 100, tx: `t${seq}`, ...p });

const base: EarlyFeatures = { firstTs: 0, windowSecs: 3600, windowComplete: true, fills: 50, usd: 5000, wallets: 20, topWalletShare: 0.1, newAcctShare: null, ageCoverage: null, yesUsd: 2600, noUsd: 2400, oneSided: 0.52, leanIdx: 0, firstPrice: 0.5, lastPrice: 0.52, drift: 0.02, largestUsd: 300, largestShare: 0.06, tradesPerMin: 0.8 };

describe('earlyFeatures', () => {
  it('computes volume, wallets, flow, drift, largest print and pace over the first hour only', () => {
    const t0 = NOW_S - 3 * H;
    const trades = [
      tr({ ts: t0 + 600, wallet: '0xb', side: 'SELL', outcomeIndex: 1, price: 0.4, size: 500 }), // YES bet $200, yes price 0.6
      tr({ ts: t0, wallet: '0xa', price: 0.5, size: 1000 }), // YES $500, first
      tr({ ts: t0 + 1200, wallet: '0xa', outcomeIndex: 1, price: 0.3, size: 100 }), // NO $30, yes price 0.7
      tr({ ts: t0 + H, wallet: '0xc', price: 0.7, size: 10 }), // YES $7 at the inclusive edge
      tr({ ts: t0 + H + 1, wallet: '0xd', price: 0.9, size: 1e6 }), // outside the window
    ];
    const f = earlyFeatures(trades, NOW_S);
    expect(f).toMatchObject({ firstTs: t0, windowSecs: H, windowComplete: true, fills: 4, usd: 737, wallets: 3, yesUsd: 707, noUsd: 30, leanIdx: 0, firstPrice: 0.5, lastPrice: 0.7, drift: 0.2, largestUsd: 500, newAcctShare: null, ageCoverage: null });
    expect(f.topWalletShare).toBeCloseTo(530 / 737, 4);
    expect(f.oneSided).toBeCloseTo(707 / 737, 4);
    expect(f.largestShare).toBeCloseTo(500 / 737, 4);
    expect(f.tradesPerMin).toBeCloseTo(4 / 60, 4);
  });

  it('uses the partial window of a market younger than an hour and handles no trades', () => {
    const f = earlyFeatures([tr({ ts: NOW_S - 600 }), tr({ ts: NOW_S - 300 })], NOW_S);
    expect(f).toMatchObject({ windowSecs: 600, windowComplete: false, fills: 2, tradesPerMin: 0.2 });
    expect(earlyFeatures([], NOW_S)).toMatchObject({ firstTs: null, fills: 0, usd: 0, leanIdx: null, drift: null });
  });

  it('measures new-account share against known ages only', () => {
    const t0 = NOW_S - 2 * H;
    const trades = [tr({ ts: t0, wallet: '0xnew', size: 600 }), tr({ ts: t0 + 1, wallet: '0xold', size: 200 }), tr({ ts: t0 + 2, wallet: '0xunk', size: 200 })];
    const f = earlyFeatures(trades, NOW_S, new Map<string, number | null>([['0xnew', 2], ['0xold', 400], ['0xunk', null]]));
    expect(f.newAcctShare).toBeCloseTo(0.6, 4);
    expect(f.ageCoverage).toBeCloseTo(0.8, 4);
  });
});

describe('scoreFeatures (pre-registered thresholds)', () => {
  it('stays silent below the activity floor and on ordinary two-sided tape', () => {
    expect(scoreFeatures({ ...base, usd: T.minUsd - 1, oneSided: 1, topWalletShare: 1 })).toEqual({ score: 0, reasons: [] });
    expect(scoreFeatures({ ...base, fills: T.minFills - 1, oneSided: 1 })).toEqual({ score: 0, reasons: [] });
    expect(scoreFeatures(base)).toEqual({ score: 0, reasons: [] });
  });

  it('labels one-sided flow with the outcome name, stronger above 90%', () => {
    expect(scoreFeatures({ ...base, oneSided: T.oneSided, leanIdx: 1 }, ['Up', 'Down'])).toEqual({ score: 2, reasons: ['one-sided flow 80% to Down'] });
    expect(scoreFeatures({ ...base, oneSided: 0.91 })).toEqual({ score: 3, reasons: ['one-sided flow 91% to Yes'] });
    expect(scoreFeatures({ ...base, oneSided: T.oneSided - 0.001 }).score).toBe(0);
  });

  it('flags concentration, new accounts, drift with the flow, a dominant print and heavy volume', () => {
    const s = scoreFeatures({ ...base, oneSided: 0.91, topWalletShare: 0.64, newAcctShare: 0.45, drift: 0.14, largestUsd: 3000, largestShare: 0.3, usd: 30000 });
    expect(s.reasons).toEqual(['one-sided flow 91% to Yes', 'top wallet 64% of volume', 'accounts under 30d old 45% of volume', 'price drift 14 pts toward Yes', 'largest print $3k (30% of volume)', '$30k in first hour']);
    expect(s.score).toBe(3 + 2 + 2 + 1 + 1 + 1);
    expect(s.score).toBeGreaterThanOrEqual(T.flagScore);
    for (const r of s.reasons) expect(r).not.toMatch(/insider|fraud/i);
  });

  it('reports drift against the flow without scoring it, and checks the concentration threshold edge', () => {
    expect(scoreFeatures({ ...base, drift: -0.12, leanIdx: 0 })).toEqual({ score: 0, reasons: ['price drift 12 pts toward No'] });
    expect(scoreFeatures({ ...base, topWalletShare: T.topWallet }).score).toBe(2);
    expect(scoreFeatures({ ...base, topWalletShare: T.topWallet - 0.01 }).score).toBe(0);
    expect(scoreFeatures({ ...base, newAcctShare: T.newAcctShare - 0.01 }).score).toBe(0);
  });
});

const line = (cid: string, bucket: number, extra: Partial<NewMarketLine> = {}): NewMarketLine => ({ v: 1, cid, slug: cid, eventSlug: `ev-${cid}`, title: cid, outcomes: ['Yes', 'No'], createdAt: NOW_S - 2 * H, capturedAt: bucket * H + 60, bucket, features: base, score: 5, reasons: ['x'], leanIdx: 0, leaning: 'Yes', bid: 0.38, ask: 0.4, mid: 0.39, ...extra });

describe('logFlagged', () => {
  it('writes one line per cid+hour bucket, across calls and within a batch, tolerating malformed lines', () => {
    const path = join(dir(), 'newmarkets.jsonl');
    writeFileSync(path, 'garbage{\n{"cid":"a","bucket":10}\n[1]\n');
    const r = logFlagged([line('a', 10), line('a', 11), line('b', 10), line('b', 10)], path);
    expect(r).toEqual({ written: 2, duplicates: 2 });
    expect(logFlagged([line('a', 11)], path)).toEqual({ written: 0, duplicates: 1 });
    expect(parseJsonl(readFileSync(path, 'utf8')).map((l) => `${l.cid}|${l.bucket}`)).toEqual(['a|10', 'a|11', 'b|10']);
  });
});

describe('summarizeNewMarkets', () => {
  it('counts continuation vs reversal per horizon and at resolution, and ROI at the capture ask', () => {
    const log = [line('a', 1), line('b', 1, { leanIdx: 1, leaning: 'No', ask: 0.5, mid: 0.48 }), line('c', 1, { ask: null }), line('d', 1)];
    const res = [
      { cid: 'a', bucket: 1, kind: '+1h', price: 0.5 },
      { cid: 'a', bucket: 1, kind: '+1h', price: 0.1 }, // duplicate key ignored
      { cid: 'b', bucket: 1, kind: '+1h', price: 0.3 },
      { cid: 'c', bucket: 1, kind: '+1h', price: 0.39 },
      { cid: 'a', bucket: 1, kind: 'resolution', winnerIdx: 0, payout: [1, 0] },
      { cid: 'b', bucket: 1, kind: 'resolution', winnerIdx: 0, payout: [1, 0] },
      { cid: 'c', bucket: 1, kind: 'resolution', winnerIdx: 0, payout: [1, 0] }, // no ask: counted, not priced
      { cid: 'd', bucket: 1, kind: 'resolution', winnerIdx: null, payout: [0.5, 0.5] },
      { cid: 'zz', bucket: 1, kind: 'resolution', winnerIdx: 0, payout: [1, 0] }, // not in log
      { bogus: true },
    ];
    const s = summarizeNewMarkets(log, res);
    expect(s.logged).toBe(4);
    expect(s.horizons['+1h']).toEqual({ n: 3, continuation: 1, reversal: 1, flat: 1 });
    expect(s.horizons['+24h'].n).toBe(0);
    expect(s.resolution).toEqual({ n: 4, continuation: 2, reversal: 1, flat: 0, void: 1 });
    // a: 1-0.4, b: 0-0.5, d: 0.5-0.4 => pnl 0.2 on stake 1.3
    expect(s.roi).toEqual({ n: 3, stake: 1.3, pnl: 0.2, roi: 0.1538 });
  });
});

// ---- fake API ----
interface Fake {
  markets: Array<Record<string, unknown>>;
  trades: Record<string, Array<Record<string, unknown>>>; // cid -> raw taker trades
  failCids?: string[];
  firstSeen?: Record<string, number>;
  events?: Record<string, unknown>;
}
function fakeApi(f: Fake) {
  const calls: string[] = [];
  const fetchJson: FetchJson = async (url) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname === '/markets') return f.markets.slice(Number(u.searchParams.get('offset')), Number(u.searchParams.get('offset')) + Number(u.searchParams.get('limit')));
    if (u.pathname === '/v2/trades') {
      const cid = u.searchParams.get('condition')!;
      if (f.failCids?.includes(cid)) throw new Error('HTTP 500');
      expect(u.searchParams.get('taker_only')).toBe('true');
      const rows = [...(f.trades[cid] ?? [])].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
      return cursorPage(rows, u.searchParams);
    }
    if (u.pathname === '/v2/activity') {
      const w = u.searchParams.get('user')!;
      return v2(f.firstSeen?.[w] !== undefined ? [{ timestamp: f.firstSeen[w] }] : []);
    }
    if (u.pathname === '/book') return { bids: [{ price: '0.6', size: '100' }], asks: [{ price: '0.64', size: '50' }] };
    if (u.pathname === '/events') return f.events?.[u.searchParams.get('slug')!] ? [f.events[u.searchParams.get('slug')!]] : [];
    throw new Error(`unexpected ${url}`);
  };
  return { client: new PolymarketClient(fetchJson, fast), calls };
}
const iso = (secs: number) => new Date(secs * 1000).toISOString();
const mkt = (cid: string, createdSecs: number, volume: number, slug = cid) => ({ conditionId: cid, slug, question: `${cid}?`, createdAt: iso(createdSecs), volume: String(volume), volumeNum: volume, outcomes: '["Yes","No"]', clobTokenIds: `["${cid}-y","${cid}-n"]`, events: [{ slug: `ev-${cid}` }] });
const raw = (cid: string, ts: number, wallet: string, opts: { side?: string; oi?: number; price?: number; size?: number } = {}) => ({ conditionId: cid, proxyWallet: wallet, side: opts.side ?? 'BUY', outcomeIndex: opts.oi ?? 0, price: opts.price ?? 0.5, size: opts.size ?? 100, timestamp: ts, transactionHash: `${cid}-${wallet}-${ts}` });

describe('scanNewMarkets', () => {
  const t0 = NOW_S - 3 * H;
  // hot: one wallet buys Yes hard, price climbs; calm: two-sided small tape; boom: fetch fails; old: outside 24h; updown: excluded
  const hotTrades = [
    ...Array.from({ length: 8 }, (_, i) => raw('hot', t0 + i * 60, '0xwhale', { price: 0.4 + i * 0.03, size: 1000 })),
    raw('hot', t0 + 600, '0xsmall1', { size: 50 }),
    raw('hot', t0 + 700, '0xsmall2', { side: 'SELL', size: 50 }),
    ...Array.from({ length: 6 }, (_, i) => raw('hot', t0 + 800 + i, `0xextra${i}`, { size: 10 })),
  ];
  const calmTrades = Array.from({ length: 20 }, (_, i) => raw('calm', t0 + i * 120, `0xc${i}`, { oi: i % 2, price: 0.5, size: 200 }));
  const markets = [mkt('hot', NOW_S - 4 * H, 9000), mkt('calm', NOW_S - 5 * H, 8000), mkt('boom', NOW_S - 6 * H, 7000), mkt('btc', NOW_S - H, 99999, 'btc-updown-5m-1'), mkt('old', NOW_S - 30 * H, 50000)];
  const fake = (): Fake => ({ markets, trades: { hot: hotTrades, calm: calmTrades }, failCids: ['boom'], firstSeen: { '0xwhale': NOW_S - 2 * 86400 } });

  it('flags one-sided concentrated tape from a young account, skips failed fetches, and logs once per bucket', async () => {
    const { client } = fakeApi(fake());
    const s = await scanNewMarkets(client, { now: () => NOW, ageCache: new Map() });
    expect(s).toMatchObject({ listed: 4, excluded: 1, considered: 3, scanned: 2, skipped: 1, truncated: 0, noTrades: 0, flagged: 1 });
    expect(s.errors.some((e) => e.startsWith('boom'))).toBe(true);
    const hot = s.rows.find((r) => r.cid === 'hot')!;
    expect(hot.flagged).toBe(true);
    // whale $4,040 of $4,120 early taker dollars
    expect(hot.reasons).toEqual(expect.arrayContaining(['top wallet 98% of volume', 'accounts under 30d old 98% of volume', 'one-sided flow 99% to Yes']));
    expect(s.rows.find((r) => r.cid === 'calm')).toMatchObject({ flagged: false, score: 0 });
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatchObject({ cid: 'hot', eventSlug: 'ev-hot', leanIdx: 0, leaning: 'Yes', bid: 0.6, ask: 0.64, mid: 0.62, capturedAt: NOW_S, bucket: Math.floor(NOW_S / H), createdAt: NOW_S - 4 * H });
    const path = join(dir(), 'newmarkets.jsonl');
    expect(logFlagged(s.lines, path).written).toBe(1);
    const again = await scanNewMarkets(client, { now: () => NOW + 60_000, ageCache: new Map() });
    expect(logFlagged(again.lines, path)).toEqual({ written: 0, duplicates: 1 });
  });

  it('caps wallet-age lookups per scan and reuses the cache', async () => {
    const { client, calls } = fakeApi(fake());
    const cache = new Map<string, number | null>();
    const s = await scanNewMarkets(client, { now: () => NOW, ageCache: cache, maxAgeLookups: 3 });
    expect(s.ageLookups).toBe(3);
    expect(calls.filter((u) => u.includes('/activity')).length).toBe(3);
    expect(cache.size).toBe(3);
    const before = calls.length;
    const s2 = await scanNewMarkets(client, { now: () => NOW, ageCache: cache, maxAgeLookups: 3 });
    expect(s2.ageLookups).toBe(3); // three new wallets, the first three come from cache
    expect(calls.slice(before).filter((u) => u.includes('/activity')).length).toBe(3);
  });

  it('counts a market with more fills than the page budget as truncated, not scanned', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => raw('hot', t0 + i, `0xm${i % 50}`, { size: 1 }));
    const { client } = fakeApi({ markets: [mkt('hot', NOW_S - H, 9000)], trades: { hot: many } });
    const s = await scanNewMarkets(client, { now: () => NOW, ageCache: new Map(), maxPages: 2 });
    expect(s).toMatchObject({ considered: 1, scanned: 0, truncated: 1 });
    const ok = await scanNewMarkets(client, { now: () => NOW, ageCache: new Map(), maxPages: 3, maxAgeLookups: 0 });
    expect(ok).toMatchObject({ scanned: 1, truncated: 0 });
    expect(ok.rows[0].features.fills).toBe(2500);
  });
});

describe('scoreNewMarketLog', () => {
  it('fills due horizons and resolution once each, append-only', async () => {
    const d = dir();
    const path = join(d, 'newmarkets.jsonl');
    const capturedAt = NOW_S - 7 * H;
    const l = line('hot', Math.floor(capturedAt / H), { capturedAt, eventSlug: 'ev-hot', mid: 0.62, ask: 0.64 });
    writeFileSync(path, JSON.stringify(l) + '\nnot json\n' + JSON.stringify(l) + '\n');
    const trades = { hot: [raw('hot', capturedAt + 1800, '0xa', { price: 0.7 }), raw('hot', capturedAt + 5 * H, '0xb', { oi: 1, price: 0.45 })] };
    const events = { 'ev-hot': { slug: 'ev-hot', title: 'e', markets: [{ conditionId: 'hot', closed: true, outcomePrices: '["1","0"]', outcomes: '["Yes","No"]' }] } };
    const { client } = fakeApi({ markets: [], trades, events });
    const r = await scoreNewMarketLog(client, path, { now: () => NOW });
    expect(r.errors).toEqual([]);
    expect(r.written).toBe(3); // +1h, +6h, resolution; +24h not due yet
    const results = () => parseJsonl(readFileSync(join(d, 'newmarkets-results.jsonl'), 'utf8'));
    expect(results()).toEqual([
      { cid: 'hot', bucket: l.bucket, kind: '+1h', at: NOW_S, price: 0.7 },
      { cid: 'hot', bucket: l.bucket, kind: '+6h', at: NOW_S, price: 0.55 },
      { cid: 'hot', bucket: l.bucket, kind: 'resolution', at: NOW_S, winnerIdx: 0, payout: [1, 0] },
    ]);
    expect(r.horizons['+1h']).toEqual({ n: 1, continuation: 1, reversal: 0, flat: 0 });
    expect(r.horizons['+6h']).toEqual({ n: 1, continuation: 0, reversal: 1, flat: 0 });
    expect(r.resolution).toMatchObject({ n: 1, continuation: 1 });
    expect(r.roi).toEqual({ n: 1, stake: 0.64, pnl: 0.36, roi: 0.5625 });

    const r2 = await scoreNewMarketLog(client, path, { now: () => NOW + 60 });
    expect(r2.written).toBe(0);
    expect(results()).toHaveLength(3);
    const r3 = await scoreNewMarketLog(client, path, { now: () => NOW + 18 * H * 1000 });
    expect(r3.errors).toEqual([]);
    expect(r3.written).toBe(1);
    expect(results().map((x) => x.kind)).toEqual(['+1h', '+6h', 'resolution', '+24h']);
  });
});
