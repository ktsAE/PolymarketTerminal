import { v2 } from './v2';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureWindow, dueCaptures, parseJsonl, quoteOf, seenKeys, settleSnapshots, snapshotKey, snapshotUpcoming, unsettled, upcomingMoneylines, winnerFromPrices } from '../../radar/forward';
import { PolymarketClient, type FetchJson } from '../../radar/polymarket';

const H = 3600;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // ms
const NOW_S = NOW / 1000;
const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };
const iso = (secs: number) => new Date(secs * 1000).toISOString().replace('T', ' ').replace('.000Z', '+00');
const dir = () => mkdtempSync(join(tmpdir(), 'fwd-'));

describe('capture windows', () => {
  it('labels inclusive boundaries and rejects the gaps between windows', () => {
    expect(captureWindow(6.5 * H)).toBe('T-8h');
    expect(captureWindow(9.5 * H)).toBe('T-8h');
    expect(captureWindow(9.5 * H + 1)).toBeNull();
    expect(captureWindow(6.5 * H - 1)).toBeNull();
    expect(captureWindow(2.5 * H)).toBe('T-2h');
    expect(captureWindow(1.5 * H)).toBe('T-2h');
    expect(captureWindow(1.5 * H - 1)).toBeNull();
    expect(captureWindow(2.5 * H + 1)).toBeNull();
    expect(captureWindow(600)).toBe('T-5m');
    expect(captureWindow(0)).toBe('T-5m');
    expect(captureWindow(601)).toBeNull();
    expect(captureWindow(-1)).toBeNull();
    expect(captureWindow(NaN)).toBeNull();
  });
});

describe('dedupe', () => {
  it('never captures the same cid+label twice, but a new window for the same cid is due', () => {
    const seen = seenKeys([{ cid: 'a', label: 'T-2h' }, { cid: 'junk' }]);
    expect(seen).toEqual(new Set([snapshotKey('a', 'T-2h')]));
    const ms = [{ cid: 'a', startTs: NOW_S + 2 * H }, { cid: 'b', startTs: NOW_S + 2 * H }, { cid: 'b', startTs: NOW_S + 2 * H }, { cid: 'c', startTs: NOW_S + 5 * H }];
    expect(dueCaptures(ms, seen, NOW_S).map((d) => `${d.cid} ${d.label}`)).toEqual(['b T-2h']);
    expect(dueCaptures([{ cid: 'a', startTs: NOW_S + 8 * H }], seen, NOW_S).map((d) => d.label)).toEqual(['T-8h']);
  });
  it('tolerates malformed JSONL lines', () => {
    expect(parseJsonl('{"cid":"a","label":"T-5m"}\n\nnot json\n{"cid":"b",\n[1,2]\nnull\n{"cid":"c","label":"T-8h"}\n')).toEqual([{ cid: 'a', label: 'T-5m' }, { cid: 'c', label: 'T-8h' }]);
  });
});

describe('pure parsing', () => {
  it('keeps only upcoming moneylines within 12h with matching tokens', () => {
    const raw = { slug: 'nba-x', title: 'X vs Y', markets: [
      { sportsMarketType: 'moneyline', conditionId: '0x1', gameStartTime: iso(NOW_S + 2 * H), outcomes: '["X","Y"]', clobTokenIds: '["1","2"]', volume24hr: 500, question: 'X vs. Y' },
      { sportsMarketType: 'child_moneyline', conditionId: '0x2', gameStartTime: iso(NOW_S + 2 * H), outcomes: '["X","Y"]', clobTokenIds: '["3","4"]' },
      { sportsMarketType: 'moneyline', conditionId: '0x3', gameStartTime: iso(NOW_S + 13 * H), outcomes: '["X","Y"]', clobTokenIds: '["5","6"]' },
      { sportsMarketType: 'moneyline', conditionId: '0x4', gameStartTime: iso(NOW_S - 60), outcomes: '["X","Y"]', clobTokenIds: '["7","8"]' },
      { sportsMarketType: 'moneyline', conditionId: '0x5', gameStartTime: iso(NOW_S + H), outcomes: '["X","Y"]', clobTokenIds: '["9"]' },
    ] };
    const u = upcomingMoneylines(raw, 'nba', NOW_S);
    expect(u.map((m) => m.cid)).toEqual(['0x1']);
    expect(u[0]).toMatchObject({ sport: 'nba', startTs: NOW_S + 2 * H, outcomes: ['X', 'Y'], vol24: 500, slug: 'nba-x' });
  });
  it('treats a one-sided book as no quote', () => {
    expect(quoteOf('X', { bids: [], asks: [{ price: 0.5, size: 10 }] })).toBeNull();
    expect(quoteOf('X', { bids: [{ price: 0.4, size: 10 }], asks: [] })).toBeNull();
    expect(quoteOf('X', { bids: [{ price: 0.4, size: 100 }], asks: [{ price: 0.42, size: 50 }] })).toEqual({ outcome: 'X', bid: 0.4, ask: 0.42, mid: 0.41, bidUsd: 40, askUsd: 21 });
  });
  it('reads winners, voids and not-yet-final prices', () => {
    expect(winnerFromPrices([0, 1])).toBe(1);
    expect(winnerFromPrices([1, 0])).toBe(0);
    expect(winnerFromPrices([0.5, 0.5])).toBeNull();
    expect(winnerFromPrices([0.6, 0.4])).toBeUndefined();
    expect(winnerFromPrices(null)).toBeUndefined();
  });
  it('lists only started, unsettled snapshots', () => {
    const t = unsettled([{ cid: 'a', slug: 's', startTs: NOW_S - 10 }, { cid: 'a', slug: 's', startTs: NOW_S - 10 }, { cid: 'b', slug: 's', startTs: NOW_S - 10 }, { cid: 'c', slug: 't', startTs: NOW_S + 10 }, { slug: 'x' }], [{ cid: 'b' }], NOW_S);
    expect([...t.entries()].map(([k, v]) => [k, [...v]])).toEqual([['s', ['a']]]);
  });
});

// ---- fake API ----
function fakeApi(books: Record<string, { bids: Array<[number, number]>; asks: Array<[number, number]> }>, events: Record<string, unknown>[], closed: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const fetchJson: FetchJson = async (url) => {
    calls.push(url);
    if (url.endsWith('/sports')) return [{ sport: 'nba', series: '1', tags: '1,745' }, { sport: 'lol', series: '2', tags: '1,64,65' }, { sport: 'cricipl', series: '3', tags: '1' }];
    if (url.includes('series_id=1&')) return events;
    if (url.includes('series_id=')) return [];
    const tok = /token_id=(\w+)/.exec(url)?.[1];
    if (tok) {
      const b = books[tok] ?? { bids: [], asks: [] };
      return { bids: b.bids.map(([price, size]) => ({ price: String(price), size: String(size) })), asks: b.asks.map(([price, size]) => ({ price: String(price), size: String(size) })) };
    }
    if (url.includes('/v2/holders')) return v2([{ tokenId: 't', holders: [{ proxyWallet: '0xAA', outcomeIndex: 0, amount: 100 }, { proxyWallet: '0xbb', outcomeIndex: 1, amount: 300 }] }]);
    const slug = /slug=([\w-]+)/.exec(url)?.[1];
    if (slug && closed[slug]) return [closed[slug]];
    if (slug) return [];
    throw new Error(`unexpected ${url}`);
  };
  return { client: new PolymarketClient(fetchJson, fast), calls };
}

const game = (slug: string, cid: string, startSecs: number, toks: [string, string]) => ({ slug, title: slug, markets: [{ sportsMarketType: 'moneyline', conditionId: cid, gameStartTime: iso(startSecs), outcomes: '["A","B"]', clobTokenIds: JSON.stringify(toks), volume24hr: 1234, question: `${slug} winner` }] });

describe('snapshotUpcoming', () => {
  const books = { a1: { bids: [[0.4, 100]] as Array<[number, number]>, asks: [[0.42, 50]] as Array<[number, number]> }, a2: { bids: [[0.58, 10]] as Array<[number, number]>, asks: [[0.6, 20]] as Array<[number, number]> }, b1: { bids: [[0.3, 10]] as Array<[number, number]>, asks: [] as Array<[number, number]> }, b2: { bids: [[0.6, 10]] as Array<[number, number]>, asks: [[0.7, 10]] as Array<[number, number]> } };
  const events = [game('g1', '0xg1', NOW_S + 2 * H, ['a1', 'a2']), game('g2', '0xg2', NOW_S + 5 * 60, ['b1', 'b2']), game('g3', '0xg3', NOW_S + 4 * H, ['a1', 'a2'])];

  it('writes one line per due market, skips one-sided books, and never repeats a cid+label', async () => {
    const path = join(dir(), 'snapshots.jsonl');
    const { client, calls } = fakeApi(books, events);
    const s = await snapshotUpcoming(client, { path, now: () => NOW });
    expect(calls.filter((u) => u.includes('series_id=')).length).toBe(2); // nba + esports lol, not cricket
    expect(s).toMatchObject({ series: 2, upcoming: 3, due: 2, written: 1, skippedOneSided: 1, holdersAbsent: 0, errors: [] });
    const lines = parseJsonl(readFileSync(path, 'utf8'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ v: 1, cid: '0xg1', slug: 'g1', sport: 'nba', label: 'T-2h', startTs: NOW_S + 2 * H, capturedAt: NOW_S, vol24: 1234, outcomes: ['A', 'B'], holdersAbsent: false });
    expect(lines[0].quotes).toEqual([{ outcome: 'A', bid: 0.4, ask: 0.42, mid: 0.41, bidUsd: 40, askUsd: 21 }, { outcome: 'B', bid: 0.58, ask: 0.6, mid: 0.59, bidUsd: 5.8, askUsd: 12 }]);
    expect(lines[0].holders).toEqual([{ wallet: '0xbb', side: 'B', outcomeIndex: 1, size: 300 }, { wallet: '0xaa', side: 'A', outcomeIndex: 0, size: 100 }]);

    const again = await snapshotUpcoming(client, { path, now: () => NOW + 60_000 });
    expect(again.written).toBe(0);
    expect(parseJsonl(readFileSync(path, 'utf8'))).toHaveLength(1);
  });

  it('dry run writes nothing; holders can be skipped and are flagged absent', async () => {
    const path = join(dir(), 'snapshots.jsonl');
    const { client } = fakeApi(books, events);
    const s = await snapshotUpcoming(client, { path, now: () => NOW, dryRun: true, holders: false });
    expect(s.written).toBe(1);
    expect(s.lines[0]).toMatchObject({ holders: null, holdersAbsent: true });
    expect(() => readFileSync(path, 'utf8')).toThrow();
  });
});

describe('settleSnapshots', () => {
  it('writes each result once and tolerates malformed snapshot lines', async () => {
    const d = dir();
    const path = join(d, 'snapshots.jsonl');
    const snap = (cid: string, slug: string, label: string) => JSON.stringify({ cid, slug, label, startTs: NOW_S - 3 * H });
    writeFileSync(path, [snap('0xg1', 'g1', 'T-8h'), 'garbage{', snap('0xg1', 'g1', 'T-2h'), snap('0xg2', 'g2', 'T-5m'), '{"cid":"0xg9"'].join('\n') + '\n');
    const closed = {
      g1: { slug: 'g1', title: 'g1', markets: [{ conditionId: '0xg1', closed: true, outcomePrices: '["0","1"]', outcomes: '["A","B"]' }] },
      g2: { slug: 'g2', title: 'g2', markets: [{ conditionId: '0xg2', closed: false, outcomePrices: '["0.5","0.5"]', outcomes: '["A","B"]' }] },
    };
    const { client } = fakeApi({}, [], closed);
    const r = await settleSnapshots(client, path, { now: () => NOW });
    expect(r).toMatchObject({ pending: 2, settled: 1, errors: [] });
    const results = () => parseJsonl(readFileSync(join(d, 'results.jsonl'), 'utf8'));
    expect(results()).toEqual([{ cid: '0xg1', winnerIdx: 1, payout: [0, 1], settledAt: NOW_S }]);
    const r2 = await settleSnapshots(client, path, { now: () => NOW + 1000 });
    expect(r2).toMatchObject({ pending: 1, settled: 0 });
    expect(results()).toHaveLength(1);
  });
});
