import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KIND_TEXT, looksLikeTokenLadder, rank, saveEdges, scanAll, scanReferenced, screenEvent, verifyCandidate, type EdgeCandidate } from '../../radar/edges';
import { fairRange, oneDayAfterLaunch } from '../../radar/fairvalue';
import type { RefConfig } from '../../radar/refs';
import { parseDate, parseLadder } from '../../radar/ladder';
import { PolymarketClient, type FetchJson } from '../../radar/polymarket';
import { strip, vlen } from '../../radar/tui/ansi';
import { moveSelection, render, type Model, type View } from '../../radar/tui/render';

const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };
const mk = (id: string, label: string, bid: number, ask: number, over: Record<string, unknown> = {}) => ({
  conditionId: `0x${id}`, groupItemTitle: label, question: `Will it be ${label}?`, bestBid: bid, bestAsk: ask, liquidityNum: 5_000, clobTokenIds: `["y${id}","n${id}"]`, active: true, closed: false, acceptingOrders: true, endDate: '2026-12-01T00:00:00Z', ...over,
});
const ev = (title: string, markets: unknown[], over: Record<string, unknown> = {}) => ({ slug: title.toLowerCase().replace(/\W+/g, '-'), title, volume24hr: 1000, negRisk: false, markets, ...over });

describe('date parsing regressions', () => {
  const REF = Date.UTC(2026, 10, 1) / 1000;
  it('places labels without a year in the right year instead of Date.parse\'s 2001', () => {
    expect(parseDate('November 2', REF)).toBe(Date.UTC(2026, 10, 2, 23, 59, 59) / 1000);
    expect(parseDate('March 31', REF)).toBe(Date.UTC(2027, 2, 31, 23, 59, 59) / 1000); // already past this year, so next year
    expect(parseDate('October 31, 2026', REF)).toBe(Date.UTC(2026, 9, 31, 23, 59, 59) / 1000);
    expect(parseDate('Yes', REF)).toBeNull();
  });
  it('orders a year-less by-date ladder correctly (the false +65pt "arbitrage" came from March 31 sorting before November 2)', () => {
    const l = parseLadder('US imports Russian diesel by...?', [
      { cid: 'a', label: 'March 31', question: 'Will the US import Russian diesel by March 31?', endsAt: Date.UTC(2027, 2, 31) / 1000 },
      { cid: 'b', label: 'November 2', question: 'Will the US import Russian diesel by November 2?', endsAt: Date.UTC(2026, 10, 2) / 1000 },
    ]);
    expect(l?.kind).toBe('by-date');
    expect(l?.rungs.map((r) => r.label)).toEqual(['November 2', 'March 31']);
  });
  it('is NOT a ladder when the labels are names or buckets that share one deadline', () => {
    const same = Date.UTC(2026, 10, 30) / 1000;
    expect(parseLadder('Who will Trump speak to by November 30?', [{ cid: 'a', label: 'Xi Jinping', question: 'Will Trump speak to Xi by November 30?', endsAt: same }, { cid: 'b', label: 'Mojtaba Khamenei', question: 'Will Trump speak to M by November 30?', endsAt: same }])).toBeNull();
    expect(parseLadder('Fed decision in January?', [{ cid: 'a', label: '50+ bps increase', question: 'Will the Fed move by 50+ bps?', endsAt: same }, { cid: 'b', label: 'No change', question: 'Will the Fed move by 0?', endsAt: same }])).toBeNull();
    expect(parseLadder('Will Anthropic hit __ by December 31?', [{ cid: 'a', label: '↓$600B', question: 'Will it hit?' }, { cid: 'b', label: '↑$1.5T', question: 'Will it hit?' }])).toBeNull();
  });
});

describe('screening one event', () => {
  it('finds a threshold ladder whose harder rung is bid above the easier one', () => {
    const [c] = screenEvent(ev('FDV above ___ one day after launch?', [mk('1', '$30M', 0.48, 0.5), mk('2', '$45M', 0.6, 0.62)]));
    expect(c.kind).toBe('LADDER');
    expect(c.legs.map((l) => `${l.action} ${l.label}`)).toEqual(['BUY YES $30M', 'BUY NO $45M']);
    expect(c.cost).toBeCloseTo(0.5 + 0.4);
    expect(c.edgePts).toBeCloseTo(10);
    expect(c.confidence).toBe('medium');
  });
  it('finds nothing when the ladder is in order, when quotes are one-sided, or when liquidity is thin', () => {
    expect(screenEvent(ev('FDV above ___?', [mk('1', '$30M', 0.7, 0.72), mk('2', '$45M', 0.5, 0.52)]))).toEqual([]);
    expect(screenEvent(ev('FDV above ___?', [mk('1', '$30M', 0.48, 0.5), mk('2', '$45M', 0, 0.62)]))).toEqual([]);
    expect(screenEvent(ev('FDV above ___?', [mk('1', '$30M', 0.48, 0.5, { liquidityNum: 100 }), mk('2', '$45M', 0.6, 0.62, { liquidityNum: 100 })]))).toEqual([]);
  });
  it('finds NO-on-everything when mutually exclusive outcomes are bid above $1 in total', () => {
    const cs = screenEvent(ev('Who wins?', [mk('1', 'A', 0.5, 0.55), mk('2', 'B', 0.4, 0.45), mk('3', 'C', 0.2, 0.25)], { negRisk: true }));
    const c = cs.find((x) => x.kind === 'SUM_BID') as EdgeCandidate;
    expect(c.legs.map((l) => l.action)).toEqual(['BUY NO', 'BUY NO', 'BUY NO']);
    expect(c.payoff).toBe(2);
    expect(c.cost).toBeCloseTo(3 - 1.1);
    expect(c.edgePts).toBeCloseTo(10);
  });
  it('flags YES-on-everything as low confidence (an unlisted winner pays nothing) and needs every market quoted', () => {
    const cs = screenEvent(ev('Who wins?', [mk('1', 'A', 0.2, 0.25), mk('2', 'B', 0.2, 0.25), mk('3', 'C', 0.2, 0.25)], { negRisk: true }));
    const c = cs.find((x) => x.kind === 'SUM_ASK') as EdgeCandidate;
    expect(c.confidence).toBe('low');
    expect(c.caveats.join()).toMatch(/ONLY IF/);
    // one market without a usable quote: exhaustiveness cannot be assumed, so no SUM_ASK
    expect(screenEvent(ev('Who wins?', [mk('1', 'A', 0.2, 0.25), mk('2', 'B', 0.2, 0.25), mk('3', 'C', 0, 0.25)], { negRisk: true })).some((x) => x.kind === 'SUM_ASK')).toBe(false);
  });
  it('does not treat non-negRisk groups as mutually exclusive', () => {
    expect(screenEvent(ev('Who wins?', [mk('1', 'A', 0.5, 0.55), mk('2', 'B', 0.4, 0.45), mk('3', 'C', 0.2, 0.25)], { negRisk: false }))).toEqual([]);
  });
  it('flags an implausibly large edge as probably a misreading', () => {
    const [c] = screenEvent(ev('FDV above ___?', [mk('1', '$30M', 0.05, 0.06), mk('2', '$45M', 0.7, 0.72)]));
    expect(c.caveats[0]).toMatch(/SUSPICIOUSLY LARGE/);
  });
});

const BOOKS: Record<string, { bids: Array<[string, string]>; asks: Array<[string, string]> }> = {};
function client(events: unknown[][], books = BOOKS): { c: PolymarketClient; calls: string[] } {
  const calls: string[] = [];
  const f: FetchJson = async (url) => {
    calls.push(url);
    if (url.includes('/events?active=true')) {
      const off = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
      return events[off / 100] ?? [];
    }
    if (url.includes('/book?token_id=')) {
      const t = /token_id=(\w+)/.exec(url)?.[1] as string;
      const b = books[t];
      if (!b) throw new Error('HTTP 404');
      return { bids: b.bids.map(([price, size]) => ({ price, size })), asks: b.asks.map(([price, size]) => ({ price, size })) };
    }
    throw new Error(`unexpected ${url}`);
  };
  return { c: new PolymarketClient(f, fast), calls };
}
const ladderEvent = ev('FDV above ___ one day after launch?', [mk('1', '$30M', 0.48, 0.5), mk('2', '$45M', 0.6, 0.62)]);

describe('verification against live books', () => {
  it('confirms a candidate and measures depth and profit', async () => {
    const { c } = client([]);
    const [cand] = screenEvent(ladderEvent);
    const books = { y1: { bids: [], asks: [['0.50', '400']] as Array<[string, string]> }, n2: { bids: [], asks: [['0.40', '1000']] as Array<[string, string]> } };
    await verifyCandidate(client([], books).c, cand);
    expect(c).toBeDefined();
    expect(cand.verified).toBe(true);
    expect(cand.liveEdgePts).toBeCloseTo(10);
    expect(cand.depthUsd).toBeCloseTo(200); // min(400 x 0.50, 1000 x 0.40)
    expect(cand.profitUsd).toBeCloseTo(20);
  });
  it('rejects a stale screen quote', async () => {
    const [cand] = screenEvent(ladderEvent);
    await verifyCandidate(client([], { y1: { bids: [], asks: [['0.55', '100']] }, n2: { bids: [], asks: [['0.47', '100']] } }).c, cand);
    expect(cand.verified).toBe(false);
    expect(cand.note).toMatch(/stale/);
  });
  it('reports when a book cannot be read, without calling it confirmed or stale', async () => {
    const [cand] = screenEvent(ladderEvent);
    await verifyCandidate(client([], { y1: { bids: [], asks: [] } }).c, cand);
    expect(cand.verified).toBeNull();
    expect(cand.note).toMatch(/nothing to buy|could not check/);
  });
});

describe('scanning everything', () => {
  it('pages through events, screens each, verifies the best, and ranks confirmed profit first', async () => {
    const small = ev('Thing above ___ by year end?', [mk('3', '$1B', 0.4, 0.42), mk('4', '$2B', 0.5, 0.52)]);
    const books = {
      y1: { bids: [], asks: [['0.50', '400']] as Array<[string, string]> }, n2: { bids: [], asks: [['0.40', '1000']] as Array<[string, string]> },
      y3: { bids: [], asks: [['0.42', '10']] as Array<[string, string]> }, n4: { bids: [], asks: [['0.50', '10']] as Array<[string, string]> },
    };
    const stages: string[] = [];
    const { c, calls } = client([[ladderEvent, ev('Nothing here', [mk('9', 'A', 0.5, 0.52)])], [small]], books);
    const r = await scanAll(c, { events: 150, now: () => 1_000, onProgress: (s) => stages.push(s) });
    expect(r).toMatchObject({ eventsScanned: 3, marketsScanned: 5, errors: [] });
    expect(calls.filter((u) => u.includes('/events?active=true')).length).toBe(2);
    expect(r.candidates.map((x) => x.title)).toEqual([ladderEvent.title, small.title]);
    expect(r.candidates[0].profitUsd).toBeCloseTo(20);
    expect(r.candidates[1].verified).toBe(true);
    expect(stages[0]).toMatch(/reading events 1-100/);
    expect(stages.some((s) => s.startsWith('checking live books'))).toBe(true);
    expect(stages[stages.length - 1]).toBe('done');
  });
  it('keeps going and says so when a page fails', async () => {
    const f: FetchJson = async () => { throw new Error('HTTP 500'); };
    const r = await scanAll(new PolymarketClient(f, { ...fast, retries: 0 }), { events: 100 });
    expect(r.candidates).toEqual([]);
    expect(r.errors[0]).toMatch(/events 0\+/);
  });
  it('ranks stale ones last', () => {
    const base = (over: Partial<EdgeCandidate>): EdgeCandidate => ({ ...screenEvent(ladderEvent)[0], ...over });
    const r = rank([base({ verified: false, title: 'stale' }), base({ verified: null, edgePts: 5, title: 'unchecked' }), base({ verified: true, profitUsd: 3, title: 'live' })]);
    expect(r.map((x) => x.title)).toEqual(['live', 'unchecked', 'stale']);
  });
  it('saves the list as JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'edges-'));
    const file = join(dir, 'sub', 'edges.json');
    saveEdges({ at: Date.UTC(2026, 10, 1), eventsScanned: 1, marketsScanned: 2, candidates: screenEvent(ladderEvent), errors: [], unmapped: [] }, file);
    const j = JSON.parse(readFileSync(file, 'utf8'));
    expect(j.generatedAt).toBe('2026-11-01T00:00:00.000Z');
    expect(j.candidates).toHaveLength(1);
    expect(j.note).toMatch(/before fees/);
  });
});

describe('edge tab', () => {
  const empty: Model = {
    anomalies: [], games: [], prints: [], leads: [], holders: null, showBots: false, oiSeries: [], filter: null,
    status: { lastPollAt: 1, nextPollAt: null, busy: false, error: null, events: 0, historySecs: 0, printsWindowMin: null, message: null },
  };
  const v = (over: Partial<View> = {}): View => ({ tab: 'edge', sel: 0, cols: 130, rows: 36, ...over });
  const withResult = (cands: EdgeCandidate[], over: Record<string, unknown> = {}): Model => ({ ...empty, edges: { stage: 'done', done: true, error: null, result: { at: Date.UTC(2026, 10, 1, 12), eventsScanned: 400, marketsScanned: 3000, candidates: cands, errors: [], unmapped: [] }, ...over } });
  it('explains how to start a scan', () => {
    expect(strip(render(empty, v(), Date.now()).join('\n'))).toMatch(/press e to scan every active market/);
  });
  it('lists candidates with live status, profit at depth and the standing caveat, and details the selected one', async () => {
    const live = screenEvent(ladderEvent)[0];
    await verifyCandidate(client([], { y1: { bids: [], asks: [['0.50', '400']] }, n2: { bids: [], asks: [['0.40', '1000']] } }).c, live);
    const stale = { ...screenEvent(ladderEvent)[0], title: 'Stale thing', verified: false as const, liveEdgePts: null, note: 'live books price the set at 1.020 against a payoff of 1.00: the screen quote was stale' };
    const out = strip(render(withResult([live, stale]), v(), Date.now()).join('\n'));
    expect(out).toMatch(/Edge scan\s+400 events, 3000 markets, 2 candidate/);
    expect(out).toMatch(/TYPE\s+LIVE\s+SCREEN/);
    expect(out).toMatch(/LADDER\s+\+10\.0pt/);
    expect(out).toMatch(/STALE/);
    expect(out).toMatch(/\$20/); // profit at depth
    expect(out).toMatch(/no forecasting edge is claimed/);
    expect(out).toMatch(/BUY YES "\$30M" @0\.500/); // detail panel for the selected row
    expect(out).toMatch(/1-9,0 tabs/);
  });
  it('says an empty result is normal', () => {
    expect(strip(render(withResult([]), v(), Date.now()).join('\n'))).toMatch(/nothing structural right now/);
  });
  it('switches with key 9 and moves within the list', () => {
    const m = withResult([screenEvent(ladderEvent)[0], screenEvent(ladderEvent)[0], screenEvent(ladderEvent)[0]]);
    expect(moveSelection(v({ tab: 'anomalies' }), '9', m).tab).toBe('edge');
    expect(moveSelection(v({ sel: 0 }), 'end', m).sel).toBe(2);
  });
  it('never overflows its box at any size', () => {
    const cands = Array.from({ length: 25 }, (_, i) => ({ ...screenEvent(ladderEvent)[0], title: `日本語のイベント ${i} with a very long title that must be clipped at every width`, caveats: ['a caveat '.repeat(30)], note: 'a note '.repeat(30), verified: i % 2 === 0 ? true : null, liveEdgePts: 5, depthUsd: 100, profitUsd: 5 }));
    for (const [cols, rows] of [[50, 12], [60, 16], [80, 24], [140, 40], [220, 60]]) {
      const lines = render(withResult(cands, { error: 'events 100+: HTTP 500' }), v({ cols, rows, sel: 3 }), Date.now());
      expect(lines, `${cols}x${rows}`).toHaveLength(rows);
      for (const l of lines) expect(vlen(l), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
    }
  });
});

describe('external-price (REF) rows', () => {
  const NOW_MS = Date.UTC(2026, 10, 2, 12);
  const nowSecs = NOW_MS / 1000;
  const launch = nowSecs - 3_600;
  const days = (oneDayAfterLaunch(launch) - nowSecs) / 86_400;
  const SUPPLY = 1e9;
  const PRICE = 0.15; // FDV $150M
  const ref: RefConfig = { match: 'tok-fdv', kind: 'dex-token', chain: 'solana', mint: 'MINTtok', supply: SUPPLY, sigmaDay: 0.8, checks: ['the mint is the official one'] };
  const f100 = fairRange(PRICE * SUPPLY, 100e6, 0.8, days);
  const f200 = fairRange(PRICE * SUPPLY, 200e6, 0.8, days);
  const dex = { pairs: [{ chainId: 'solana', dexId: 'raydium', priceUsd: String(PRICE), liquidity: { usd: 400_000 }, volume: { h1: 50_000 }, pairCreatedAt: launch * 1000 }] };
  const tokEvent = (a100: number, a200: number) => ev('Tok FDV above ___ one day after launch?', [mk('a', '$100M', a100 - 0.02, a100), mk('b', '$200M', a200 - 0.02, a200)], { description: 'Resolves on the most liquid source once the token is actively and publicly tradable.' });
  const book = (ask: number) => ({ bids: [[(ask - 0.02).toFixed(3), '500']] as Array<[string, string]>, asks: [[ask.toFixed(3), '500']] as Array<[string, string]> });
  const books = (a100: number, a200: number) => ({ ya: book(a100), na: book(1 - a100 + 0.02), yb: book(a200), nb: book(1 - a200 + 0.02) });
  function world(events: unknown[][], bk: Record<string, { bids: Array<[string, string]>; asks: Array<[string, string]> }>, dexBody: unknown = dex): { c: PolymarketClient; f: FetchJson; calls: string[] } {
    const calls: string[] = [];
    const f: FetchJson = async (url) => {
      calls.push(url);
      if (url.includes('dexscreener')) {
        if (dexBody instanceof Error) throw dexBody;
        return dexBody;
      }
      if (url.includes('/events?active=true')) return events[Number(/offset=(\d+)/.exec(url)?.[1] ?? 0) / 100] ?? [];
      if (url.includes('/book?token_id=')) {
        const b = bk[/token_id=(\w+)/.exec(url)?.[1] as string];
        if (!b) throw new Error('HTTP 404');
        return { bids: b.bids.map(([price, size]) => ({ price, size })), asks: b.asks.map(([price, size]) => ({ price, size })) };
      }
      throw new Error(`unexpected ${url}`);
    };
    return { c: new PolymarketClient(f, fast), f, calls };
  }

  it('emits a REF row when the live ask is below the model range, priced from live books with Decision caveats', async () => {
    // in-order ladder (no ARB), $100M ask below the model's low end, $200M inside its range
    const ask = Math.round((f100.lo - 0.04) * 100) / 100;
    const mid200 = Math.round((f200.lo + 0.02) * 100) / 100;
    expect(mid200 + 0.02).toBeLessThan(ask);
    const { c, f } = world([], books(ask, mid200));
    const r = await scanReferenced(c, [ref], { events: [tokEvent(ask, mid200)], fetchJson: f, now: () => NOW_MS });
    expect(r.errors).toEqual([]);
    expect(r.candidates).toHaveLength(1);
    const x = r.candidates[0];
    expect(x.kind).toBe('REF');
    expect(x.legs.map((l) => `${l.action} ${l.label}`)).toEqual(['BUY YES $100M']);
    expect(x.edgePts).toBeCloseTo((f100.lo - ask) * 100, 6);
    expect(x.confidence).toBe('low');
    expect(x.verified).toBe(true);
    expect(x.depthUsd).toBeCloseTo(500 * ask);
    const cav = x.caveats.join('\n');
    expect(cav).toMatch(/rules needs the token "actively and publicly tradable"/);
    expect(cav).toMatch(/reference price comes from 1 pool/);
    expect(cav).toMatch(/confirm: the mint is the official one/);
    expect(KIND_TEXT.REF).toBe('REF');
  });
  it('emits BUY NO when the YES bid is above the model range', async () => {
    const yesAsk = Math.round((f200.hi + 0.25) * 100) / 100;
    const in100 = Math.round((f100.hi - 0.05) * 100) / 100;
    expect(yesAsk).toBeLessThan(in100);
    const { c, f } = world([], books(in100, yesAsk));
    const r = await scanReferenced(c, [ref], { events: [tokEvent(in100, yesAsk)], fetchJson: f, now: () => NOW_MS });
    expect(r.candidates).toHaveLength(1);
    const x = r.candidates.find((k) => k.legs[0].label === '$200M') as EdgeCandidate;
    expect(x.legs[0].action).toBe('BUY NO');
    expect(x.edgePts).toBeCloseTo((1 - f200.hi - (1 - yesAsk + 0.02)) * 100, 6);
  });
  it('emits nothing when every live ask sits inside the range', async () => {
    const m100 = Math.round(((f100.lo + f100.hi) / 2) * 100) / 100;
    const m200 = Math.round(((f200.lo + f200.hi) / 2) * 100) / 100;
    const { c, f } = world([], books(m100, m200));
    const r = await scanReferenced(c, [ref], { events: [tokEvent(m100, m200)], fetchJson: f, now: () => NOW_MS });
    expect(r).toEqual({ candidates: [], errors: [] });
  });
  it('captures a per-reference failure instead of throwing', async () => {
    const { c, f } = world([], books(0.3, 0.2), new Error('HTTP 429'));
    const r = await scanReferenced(c, [ref], { events: [tokEvent(0.3, 0.2)], fetchJson: f, now: () => NOW_MS });
    expect(r.candidates).toEqual([]);
    expect(r.errors).toEqual([expect.stringMatching(/^ref tok-fdv \(tok-fdv-above-.*\): HTTP 429/)]);
    const none = await scanReferenced(world([], books(0.3, 0.2), { pairs: [] }).c, [ref], { events: [tokEvent(0.3, 0.2)], fetchJson: world([], {}, { pairs: [] }).f, now: () => NOW_MS });
    expect(none.errors[0]).toMatch(/no pool with liquidity/);
  });
  it('scanAll adds REF rows only when refs exist, lists unmapped token ladders, and records ref errors', async () => {
    // in-order ladder (no ARB), $100M ask below the model's low end, $200M inside its range
    const ask = Math.round((f100.lo - 0.04) * 100) / 100;
    const mid200 = Math.round((f200.lo + 0.02) * 100) / 100;
    expect(mid200 + 0.02).toBeLessThan(ask);
    const other = ev('Foo FDV above ___ one day after launch?', [mk('c', '$1B', 0.4, 0.42), mk('d', '$2B', 0.2, 0.22)]);
    const btc = ev('Bitcoin above ___ on November 3?', [mk('e', '$100k', 0.4, 0.42), mk('g', '$110k', 0.2, 0.22)]);
    const evs = [[tokEvent(ask, mid200), other, btc]];
    const w = world(evs, books(ask, mid200));
    const r = await scanAll(w.c, { events: 100, refs: [ref], fetchJson: w.f, now: () => NOW_MS, verifyTop: 0 });
    expect(r.candidates.filter((x) => x.kind === 'REF')).toHaveLength(1);
    expect(r.unmapped).toEqual([other.title]);
    expect(r.errors).toEqual([]);

    const w0 = world(evs, books(ask, mid200));
    const r0 = await scanAll(w0.c, { events: 100, refs: [], fetchJson: w0.f, now: () => NOW_MS, verifyTop: 0 });
    expect(r0.candidates.some((x) => x.kind === 'REF')).toBe(false);
    expect(w0.calls.some((u) => u.includes('dexscreener'))).toBe(false);
    expect(r0.unmapped).toEqual([tokEvent(ask, mid200).title, other.title]);

    const we = world(evs, books(ask, mid200), new Error('HTTP 500'));
    const re = await scanAll(we.c, { events: 100, refs: [ref], fetchJson: we.f, now: () => NOW_MS, verifyTop: 0 });
    expect(re.errors).toEqual([expect.stringMatching(/^ref tok-fdv .*HTTP 500/)]);
  });
  it('detects token ladders by title only (no auto-mapping)', () => {
    expect(looksLikeTokenLadder('1win FDV above ___ one day after launch?')).toBe(true);
    expect(looksLikeTokenLadder('Pump.fun market cap above ___ on Dec 31?')).toBe(true);
    expect(looksLikeTokenLadder('Bitcoin above ___ on November 3?')).toBe(false);
    expect(looksLikeTokenLadder('Anthropic IPO Closing Market Cap')).toBe(false);
  });
  it('ranks REF rows by edge with unchecked ones, never above a live-confirmed structural edge', () => {
    const b = (over: Partial<EdgeCandidate>): EdgeCandidate => ({ ...screenEvent(ladderEvent)[0], ...over });
    const r = rank([
      b({ verified: null, edgePts: 5, title: 'unchecked' }),
      b({ kind: 'REF', verified: true, edgePts: 40, liveEdgePts: 40, profitUsd: 10_000, title: 'ref' }),
      b({ verified: true, profitUsd: 3, title: 'live' }),
      b({ verified: false, title: 'stale' }),
      b({ verified: null, edgePts: 60, title: 'big unchecked' }),
    ]);
    expect(r.map((x) => x.title)).toEqual(['live', 'big unchecked', 'ref', 'unchecked', 'stale']);
  });
});
