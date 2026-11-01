import { describe, expect, it } from 'vitest';
import { decide, rulesAmbiguity, type DMarket, type DWallet, type DecideInput, type Reference } from '../../radar/decide';
import { bookQuote, loadDecision } from '../../radar/decide-data';
import { etToUtcSecs, fairRange, normalCdf, oneDayAfterLaunch, probAbove } from '../../radar/fairvalue';
import { marketFlow } from '../../radar/flow';
import { loadHolders } from '../../radar/holders';
import { accountAge, identityFor } from '../../radar/identity';
import { ladderViolations, parseAmount, parseLadder } from '../../radar/ladder';
import { compact, matchPeople, type IdentityStrings, type Person } from '../../radar/people';
import { PolymarketClient, type FetchJson } from '../../radar/polymarket';
import { fetchDexReference, loadRefs, refFor } from '../../radar/refs';
import { openStore, type TradeRow } from '../../radar/store';
import { strip, vlen } from '../../radar/tui/ansi';
import { moveSelection, render, type Model, type View } from '../../radar/tui/render';

const NOW = 1_793_463_400; // 2026-10-31 16:16:40 UTC
const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };

const JON: Person = { name: 'Jonathan Smithers', org: 'AcmeCoin', role: 'Head of Growth', handles: ['@jsmithers_ac'], aliases: ['Jon Smithers'] };
const noId: IdentityStrings = { name: null, pseudonym: null, xUsername: null, bio: null };

describe('name matching against the watchlist', () => {
  it('normalises names so spacing, accents and punctuation do not matter', () => {
    expect(compact("José  O'Neil-Smith")).toBe('joseoneilsmith');
  });
  it('scores an exact linked X handle highest, then exact names, containment, near-misses and bio mentions', () => {
    const top = (id: Partial<IdentityStrings>) => matchPeople({ ...noId, ...id }, [JON])[0];
    expect(top({ xUsername: 'jsmithers_ac' })).toMatchObject({ kind: 'HANDLE', score: 100, field: 'linked X handle' });
    expect(top({ name: 'Jonathan-Smithers' })).toMatchObject({ kind: 'NAME', score: 90 });
    expect(top({ name: 'Jon Smithers' })).toMatchObject({ kind: 'NAME', score: 90 }); // alias
    expect(top({ name: 'jsmithers_ac' })).toMatchObject({ kind: 'NAME', score: 85 }); // display name equals the handle
    expect(top({ name: 'jonathansmithers88' })).toMatchObject({ kind: 'CONTAINS', score: 75 });
    expect(top({ name: 'Jonathon Smithers' })).toMatchObject({ kind: 'FUZZY', score: 60 });
    expect(top({ bio: 'worked with jonathan smithers once' })).toMatchObject({ kind: 'BIO', score: 40 });
  });
  it('does not match unrelated names, short common names, or an empty list', () => {
    expect(matchPeople({ ...noId, name: 'CryptoWolf', xUsername: 'cryptowolf99' }, [JON])).toEqual([]);
    expect(matchPeople({ ...noId, name: 'Alex' }, [{ name: 'Alex' }])).toEqual([]); // 4 letters: too common to mean anything
    expect(matchPeople({ ...noId, name: 'Jonathan Smithers' }, [])).toEqual([]);
  });
  it('returns the best match per person, best first', () => {
    const other: Person = { name: 'Maria Valentina Lopez', handles: ['mvlopez'] };
    const hits = matchPeople({ ...noId, name: 'Jonathan Smithers', xUsername: 'mvlopez' }, [JON, other]);
    expect(hits.map((h) => [h.person.name, h.score])).toEqual([['Maria Valentina Lopez', 100], ['Jonathan Smithers', 90]]);
  });
});

describe('account age and identity', () => {
  it('labels the creation date and flags accounts under 30 days', () => {
    expect(accountAge(NOW - 5 * 86_400, NOW)).toMatchObject({ days: 5, isNew: true, label: '2026-10-26 (5d)' });
    expect(accountAge(NOW - 40 * 86_400, NOW).isNew).toBe(false);
    expect(accountAge(null, NOW)).toEqual({ days: null, label: '?', isNew: false });
  });

  const profileApi = (calls: string[]): FetchJson => async (url) => {
    calls.push(url);
    if (url.includes('0xmissing')) throw new Error('HTTP 404');
    return { createdAt: '2026-10-29T10:00:00.000Z', name: 'Newbie', pseudonym: 'Brave-Fox', xUsername: 'newbie_x', bio: 'hi', verifiedBadge: false };
  };

  it('reads and caches the public profile, creation date included', async () => {
    const store = openStore();
    const calls: string[] = [];
    const client = new PolymarketClient(profileApi(calls), fast);
    const a = await identityFor(client, store, '0xabc', () => NOW * 1000);
    expect(a).toMatchObject({ name: 'Newbie', xUsername: 'newbie_x', createdAt: Math.floor(Date.parse('2026-10-29T10:00:00.000Z') / 1000) });
    await identityFor(client, store, '0xabc', () => (NOW + 60) * 1000);
    expect(calls).toHaveLength(1);
    store.close();
  });

  it('treats a missing profile as an answer: one request, remembered, no retries', async () => {
    const store = openStore();
    const calls: string[] = [];
    const client = new PolymarketClient(profileApi(calls), fast);
    const id = await identityFor(client, store, '0xmissing', () => NOW * 1000);
    expect(id).toMatchObject({ createdAt: null, name: null });
    await identityFor(client, store, '0xmissing', () => (NOW + 60) * 1000);
    expect(calls).toHaveLength(1);
    store.close();
  });

  it('does not cache a failed lookup', async () => {
    const store = openStore();
    let fail = true;
    const client = new PolymarketClient(async () => { if (fail) throw new Error('boom'); return { createdAt: '2026-01-01T00:00:00Z' }; }, fast);
    expect(await identityFor(client, store, '0xabc', () => NOW * 1000)).toBeNull();
    fail = false;
    expect((await identityFor(client, store, '0xabc', () => NOW * 1000))?.createdAt).not.toBeNull();
    store.close();
  });
});

describe('ladders', () => {
  it('parses amounts', () => {
    expect([parseAmount('$30M'), parseAmount('$1.5B'), parseAmount('250k'), parseAmount('100'), parseAmount('Yes')]).toEqual([30e6, 1.5e9, 250_000, 100, null]);
  });
  const rungs = (labels: string[], q = 'Will FDV be above X?') => labels.map((label, i) => ({ cid: `c${i}`, label, question: q }));
  it('detects threshold and by-date ladders and ignores unrelated markets', () => {
    expect(parseLadder('FDV above ___ one day after launch?', rungs(['$70M', '$30M', '$45M']))?.rungs.map((r) => r.label)).toEqual(['$30M', '$45M', '$70M']);
    expect(parseLadder('Will X launch a token by ___?', rungs(['November 30, 2026', 'October 31, 2026'], 'Will X launch a token by October 31?'))).toMatchObject({ kind: 'by-date' });
    expect(parseLadder('Who wins the election?', rungs(['Alice', 'Bob']))).toBeNull();
    expect(parseLadder('FDV above ___?', rungs(['$30M']))).toBeNull();
  });
  it('finds the guaranteed pair when a harder threshold is bid above an easier one', () => {
    const ladder = parseLadder('FDV above ___?', rungs(['$30M', '$45M']))!;
    const quotes = new Map([['c0', { bid: 0.48, ask: 0.5 }], ['c1', { bid: 0.6, ask: 0.62 }]]);
    const [v] = ladderViolations(ladder, quotes);
    expect(v).toMatchObject({ kind: 'above' });
    expect(v.yes.label).toBe('$30M');
    expect(v.no.label).toBe('$45M');
    expect(v.edge).toBeCloseTo(0.1);
    expect(v.cost).toBeCloseTo(0.9); // 0.50 + (1 - 0.60): pays at least $1 in every outcome
    expect(ladderViolations(ladder, new Map([['c0', { bid: 0.7, ask: 0.72 }], ['c1', { bid: 0.5, ask: 0.52 }]]))).toEqual([]);
  });
  it('flags an earlier date priced above a later one', () => {
    const ladder = parseLadder('Launch by ___?', rungs(['October 31, 2026', 'November 30, 2026'], 'Will it launch by October 31?'))!;
    const [v] = ladderViolations(ladder, new Map([['c0', { bid: 0.8, ask: 0.82 }], ['c1', { bid: 0.6, ask: 0.62 }]]));
    expect(v.yes.label).toBe('November 30, 2026');
    expect(v.no.label).toBe('October 31, 2026');
    expect(v.edge).toBeCloseTo(0.18);
  });
});

describe('fair value and the New York clock', () => {
  it('has a sane normal CDF and probability model', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 5);
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 3);
    expect(probAbove(100, 100, 0.5, 1, false)).toBeCloseTo(0.5, 5); // median at spot
    expect(probAbove(100, 150, 0.5, 1, false)).toBeLessThan(probAbove(100, 120, 0.5, 1, false));
    expect(probAbove(100, 90, 0.5, 0, false)).toBe(1);
  });
  it('gives a range that widens with the assumptions tried', () => {
    const r = fairRange(40e6, 70e6, 0.8, 1.2);
    expect(r.lo).toBeLessThan(r.hi);
    expect(r.tried).toBe(6);
    expect(r.lo).toBeGreaterThan(0);
    expect(r.hi).toBeLessThan(0.6);
  });
  it('honours daylight saving: 4 PM ET is 20:00 UTC in summer and 21:00 UTC after the clocks go back (Nov 1 2026)', () => {
    expect(etToUtcSecs(2026, 7, 1, 16, 0)).toBe(Date.UTC(2026, 6, 1, 20, 0) / 1000);
    expect(etToUtcSecs(2026, 11, 2, 16, 0)).toBe(Date.UTC(2026, 10, 2, 21, 0) / 1000);
    expect(oneDayAfterLaunch(Date.UTC(2026, 9, 31, 16, 3) / 1000)).toBe(Date.UTC(2026, 10, 1, 21, 0) / 1000);
    expect(oneDayAfterLaunch(Date.UTC(2026, 5, 10, 3, 0) / 1000)).toBe(Date.UTC(2026, 5, 10, 20, 0) / 1000); // 23:00 ET on Jun 9, so Jun 10 4 PM
  });
});

describe('flow', () => {
  const t = (wallet: string, side: 'BUY' | 'SELL', outcomeIndex: number, price: number, size: number, ts: number): TradeRow => ({ cid: 'c', wallet, side, outcomeIndex, price, size, ts, tx: null });
  it('counts buying outcome 0 and selling outcome 1 as bets on the first outcome', () => {
    const f = marketFlow([t('a', 'BUY', 0, 0.5, 100, NOW - 60), t('b', 'SELL', 1, 0.5, 100, NOW - 50), t('c', 'BUY', 1, 0.5, 40, NOW - 40), t('d', 'SELL', 0, 0.6, 10, NOW - 30), t('e', 'BUY', 0, 0.5, 100, NOW - 9 * 3_600)], NOW);
    expect(f.windows[0]).toMatchObject({ fills: 4, wallets: 4 });
    expect(f.windows[0].yesUsd).toBeCloseTo(100); // a and b, 50 each
    expect(f.windows[0].noUsd).toBeCloseTo(26); // c 20 + d 6
    expect(f.windows[2].fills).toBe(5);
    expect(f.topYes.map((n) => n.wallet)).toEqual(expect.arrayContaining(['a', 'b', 'e']));
    expect(f.topNo.map((n) => n.wallet)).toEqual(expect.arrayContaining(['c', 'd']));
    expect(f.priceNow).toBeCloseTo(0.6); // the latest fill traded outcome 0 at 0.6, which is already in first-outcome terms
    expect(f.price1h).toBeCloseTo(0.5); // the last fill at or before an hour ago (wallet e, outcome 0 at 0.5)
  });
});

const market = (over: Partial<DMarket> & { cid: string; label: string }): DMarket => ({ question: 'Will FDV be above X?', outcomes: ['Yes', 'No'], closed: false, yesBid: 0.4, yesAsk: 0.45, last: 0.42, askDepthSh: 2_000, bidDepthSh: 2_000, liq: 20_000, vol24: 1_000, ...over });
const REF: Reference = { kind: 'token-fdv', source: 'test', mint: 'M', spotPrice: 0.04, spotFdv: 40e6, supply: 1e9, sigmaDay: 0.8, asOf: NOW, launchAt: NOW - 900, resolveAt: NOW + 1.2 * 86_400, pools: 3, liqUsd: 90_000, vol1hUsd: 250_000, priceSpread: 0.02, checks: ['mint is official'] };
const base = (over: Partial<DecideInput>): DecideInput => ({ event: { slug: 'e', title: 'Acme FDV above ___ one day after launch?', description: '' }, markets: [], flows: {}, wallets: {}, reference: null, now: NOW, ...over });
const wallet = (over: Partial<DWallet>): DWallet => ({ wallet: '0x' + 'a'.repeat(40), name: 'someone', side: 0, shares: 1_000, posUsd: 900, createdAt: NOW - 400 * 86_400, cls: 'HUMAN', traded: 30, pnlAll: null, xUsername: null, matches: [], ...over });

describe('decisions', () => {
  it('calls a guaranteed pair ARB on both legs', () => {
    const d = decide(base({ markets: [market({ cid: 'a', label: '$30M', yesBid: 0.48, yesAsk: 0.5 }), market({ cid: 'b', label: '$45M', yesBid: 0.6, yesAsk: 0.62 })] }));
    expect(d.markets.map((m) => [m.action, m.side])).toEqual([['ARB', 0], ['ARB', 1]]);
    expect(d.markets[0].edgePts).toBeCloseTo(10);
    expect(d.markets[0].confidence).toBe('medium');
    expect(d.headline).toMatch(/arbitrage/);
  });

  const fdvMarkets = (bid: number) => [market({ cid: 'a', label: '$30M', yesBid: 0.9, yesAsk: 0.93 }), market({ cid: 'b', label: '$70M', yesBid: bid, yesAsk: bid + 0.02, bidDepthSh: 1_000 })];
  it('says BUY NO only when the market sits above the whole model range, and shows what it assumed', () => {
    const fair = fairRange(40e6, 70e6, 0.8, 1.2);
    const d = decide(base({ markets: fdvMarkets(Math.min(0.9, fair.hi + 0.12)), reference: REF }));
    const m = d.markets[1];
    expect(m).toMatchObject({ action: 'BUY NO', side: 1, confidence: 'low' });
    expect(m.edgePts).toBeGreaterThanOrEqual(11);
    expect(m.fair).toEqual({ lo: fair.lo, hi: fair.hi });
    expect(m.reasons.join()).toMatch(/model \d+-\d+%/);
    expect(m.invalidates.join()).toMatch(/sell pressure/);
    expect(m.risks.join()).toMatch(/assumes the first DEX pool was "the launch"/);
    expect(m.capacityUsd).toBeGreaterThan(0);
  });
  it('says NO EDGE when the market is inside the range', () => {
    const fair = fairRange(40e6, 70e6, 0.8, 1.2);
    const d = decide(base({ markets: fdvMarkets((fair.lo + fair.hi) / 2), reference: REF }));
    expect(d.markets[1].action).toBe('NO EDGE');
    expect(d.markets[1].reasons.join()).toMatch(/inside the model's range/);
  });
  it('warns when an edge exists on paper but there is almost nothing to buy', () => {
    const fair = fairRange(40e6, 70e6, 0.8, 1.2);
    const ms = fdvMarkets(Math.min(0.9, fair.hi + 0.12));
    ms[1].bidDepthSh = 20;
    const m = decide(base({ markets: ms, reference: REF })).markets[1];
    expect(m.action).toBe('BUY NO');
    expect(m.risks.join()).toMatch(/not at size/);
  });
  it('does not call the model before the launch time is known or after the measurement time', () => {
    const m1 = decide(base({ markets: fdvMarkets(0.8), reference: { ...REF, resolveAt: null } })).markets[1];
    expect(m1.action).toBe('NO EDGE');
    expect(m1.reasons.join()).toMatch(/launch time is not known/);
    const m2 = decide(base({ markets: fdvMarkets(0.8), reference: { ...REF, resolveAt: NOW - 10 } })).markets[1];
    expect(m2.reasons.join()).toMatch(/has passed/);
  });
  it('says so when the reference could not be read, instead of reporting "no edge" as a verdict', () => {
    const d = decide(base({ markets: fdvMarkets(0.8), referenceError: 'fetch failed' }));
    expect(d.markets[1].reasons.join()).toMatch(/NOT a verdict/);
    expect(d.headline).toMatch(/reference price unavailable/);
    expect(d.notes.join()).toMatch(/Model-based calls were skipped/);
  });
  it('marks closed, unpriced and already-decided markets AVOID', () => {
    const d = decide(base({ markets: [market({ cid: 'a', label: 'x', closed: true }), market({ cid: 'b', label: 'y', yesBid: null, yesAsk: null, last: null }), market({ cid: 'c', label: 'z', yesBid: 0.98, yesAsk: 1 })] }));
    expect(d.markets.map((m) => m.action)).toEqual(['AVOID', 'AVOID', 'AVOID']);
  });
  it('treats a launch-by-date market as a ruling to watch, with checks, never as an edge', () => {
    const d = decide({
      ...base({ reference: REF }),
      event: { slug: 'l', title: 'Will Acme launch a token by ___?', description: 'The token must be actively and publicly tradable. Resolves on official announcement or credible reporting.' },
      markets: [market({ cid: 'a', label: 'October 31, 2026', question: 'Will Acme launch a token by October 31, 2026?', yesBid: 0.55, yesAsk: 0.6 }), market({ cid: 'b', label: 'November 30, 2026', question: 'Will Acme launch a token by November 30, 2026?', yesBid: 0.9, yesAsk: 0.93 })],
    });
    expect(d.markets[0]).toMatchObject({ action: 'WATCH', edgePts: null });
    expect(d.markets[0].invalidates).toContain('confirm: mint is official');
    expect(d.markets[0].risks.join()).toMatch(/official/);
  });
  it('turns a strong watchlist match into WATCH, but never into BUY', () => {
    const hit = matchPeople({ ...noId, xUsername: 'jsmithers_ac' }, [JON]);
    const d = decide(base({ markets: [market({ cid: 'a', label: 'Will it happen?', question: 'Will it happen?', yesBid: 0.4, yesAsk: 0.45 })], event: { slug: 'e', title: 'Will it happen?', description: '' }, wallets: { a: [wallet({ name: 'jsm', side: 0, matches: hit })] } }));
    expect(d.markets[0].action).toBe('WATCH');
    expect(d.markets[0].leads[0]).toMatchObject({ kind: 'MATCH', score: 100 });
    expect(d.markets[0].leads[0].text).toMatch(/Jonathan Smithers.*unverified/);
    expect(d.markets[0].edgePts).toBeNull();
  });
  it('reports new accounts with their creation date, only when they hold something', () => {
    const d = decide(base({ markets: [market({ cid: 'a', label: 'q', question: 'Will it happen?' })], event: { slug: 'e', title: 'Will it happen?', description: '' }, wallets: { a: [wallet({ name: 'fresh', createdAt: NOW - 2 * 86_400, posUsd: 1_500 }), wallet({ wallet: '0x' + 'b'.repeat(40), name: 'tiny', createdAt: NOW - 1 * 86_400, posUsd: 20 }), wallet({ wallet: '0x' + 'c'.repeat(40), name: 'old', createdAt: NOW - 90 * 86_400, posUsd: 5_000 })] } }));
    expect(d.markets[0].leads).toHaveLength(1);
    expect(d.markets[0].leads[0]).toMatchObject({ kind: 'NEW', name: 'fresh' });
    expect(d.markets[0].leads[0].text).toContain('2026-10-29 (2d)');
  });
  it('spots wording that leaves room for interpretation', () => {
    expect(rulesAmbiguity('Resolves yes if X officially launches. Credible reporting counts.')).toHaveLength(2);
    expect(rulesAmbiguity('Resolves to the closing price on Binance.')).toEqual([]);
  });
});

describe('reference prices', () => {
  const pairs = { pairs: [
    { chainId: 'solana', dexId: 'meteora', priceUsd: '0.04', liquidity: { usd: 50_000 }, volume: { h1: 200_000 }, pairCreatedAt: (NOW - 900) * 1000 },
    { chainId: 'solana', dexId: 'raydium', priceUsd: '0.041', liquidity: { usd: 9_000 }, volume: { h1: 5_000 }, pairCreatedAt: (NOW - 700) * 1000 },
    { chainId: 'solana', dexId: 'junk', priceUsd: '0.9', liquidity: { usd: 2_000 }, volume: { h1: 10 }, pairCreatedAt: (NOW - 1_000) * 1000 },
    { chainId: 'bsc', dexId: 'other-chain', priceUsd: '5', liquidity: { usd: 9_000_000 } },
  ] };
  const cfg = { match: 'acme', kind: 'dex-token' as const, chain: 'solana', mint: 'M', supply: 1e9, checks: ['x'] };
  it('prices from the deepest pool on the right chain and derives the one-day measurement time', async () => {
    const r = await fetchDexReference(async () => pairs, cfg, 'Acme FDV above ___ one day after launch?', NOW);
    expect(r).toMatchObject({ spotPrice: 0.04, spotFdv: 40_000_000, pools: 3, launchAt: NOW - 1_000, sigmaDay: 0.8 });
    expect(r?.resolveAt).toBe(oneDayAfterLaunch(NOW - 1_000));
    expect(r?.liqUsd).toBe(61_000);
    expect(r?.priceSpread).toBeCloseTo(0.025); // only pools with >= $5k count
  });
  it('has no measurement time for markets that are not "one day after launch", and none when nothing has liquidity', async () => {
    expect((await fetchDexReference(async () => pairs, cfg, 'Acme launch by ___?', NOW))?.resolveAt).toBeNull();
    expect(await fetchDexReference(async () => ({ pairs: [{ chainId: 'solana', priceUsd: '1', liquidity: { usd: 0 } }] }), cfg, 't', NOW)).toBeNull();
  });
  it('matches configs by slug substring', () => {
    expect(refFor('acme-fdv-above', [cfg])).toBe(cfg);
    expect(refFor('other', [cfg])).toBeUndefined();
    expect(loadRefs('/nonexistent/refs.json')).toEqual([]);
  });
  it('summarises a book: best prices and the depth within 3 points', () => {
    expect(bookQuote({ bids: [{ price: 0.5, size: 10 }, { price: 0.48, size: 5 }, { price: 0.4, size: 99 }], asks: [{ price: 0.52, size: 7 }, { price: 0.6, size: 50 }] })).toEqual({ bid: 0.5, ask: 0.52, bidDepthSh: 15, askDepthSh: 7 });
    expect(bookQuote({ bids: [], asks: [] })).toMatchObject({ bid: null, ask: null });
  });
});

// ---- end to end on a fake API -------------------------------------------------------------------------------------------------
const CID_A = `0x${'a'.repeat(64)}`;
const CID_B = `0x${'b'.repeat(64)}`;
const W_INSIDER = `0x${'1'.repeat(40)}`;
const W_NEW = `0x${'2'.repeat(40)}`;
const W_NOPROFILE = `0x${'3'.repeat(40)}`;

function fakeApi(calls: string[] = []): FetchJson {
  const raw = {
    slug: 'acme-fdv', title: 'Acme FDV above ___ one day after launch?', description: 'The token must be actively and publicly tradable.',
    markets: [
      { conditionId: CID_A, question: 'Will Acme FDV be above $30M one day after launch?', groupItemTitle: '$30M', outcomes: '["Yes","No"]', clobTokenIds: '["tokA","tokA2"]', bestBid: 0.9, bestAsk: 0.93, lastTradePrice: 0.91, liquidityNum: 20_000, volume24hr: 9_000, closed: false },
      { conditionId: CID_B, question: 'Will Acme FDV be above $70M one day after launch?', groupItemTitle: '$70M', outcomes: '["Yes","No"]', clobTokenIds: '["tokB","tokB2"]', bestBid: 0.5, bestAsk: 0.6, lastTradePrice: 0.55, liquidityNum: 10_000, volume24hr: 5_000, closed: false },
    ],
  };
  const fill = (cid: string, wallet: string, side: string, outcomeIndex: number, price: number, size: number, ts: number) => ({ conditionId: cid, proxyWallet: wallet, side, outcomeIndex, price, size, timestamp: ts, transactionHash: `0x${ts}${wallet.slice(2, 6)}` });
  return async (url) => {
    calls.push(url);
    if (url.includes('/events?slug=')) return [raw];
    if (url.includes('clob.polymarket.com/book')) {
      const b = url.includes('tokA') ? { bids: [{ price: '0.91', size: '300' }], asks: [{ price: '0.92', size: '300' }] } : { bids: [{ price: '0.5', size: '2000' }, { price: '0.2', size: '9' }], asks: [{ price: '0.55', size: '100' }] };
      return b;
    }
    if (url.includes('api.dexscreener.com')) throw new Error('reference tests inject their own fetch');
    if (url.includes('/trades?market=')) return [fill(url.includes(CID_A) ? CID_A : CID_B, W_NEW, 'BUY', 0, 0.9, 400, NOW - 600), fill(CID_B, W_INSIDER, 'BUY', 1, 0.5, 3000, NOW - 300)];
    if (url.includes('/holders?')) return [{ token: 't', holders: [{ proxyWallet: W_NEW, amount: 400, outcomeIndex: 0, name: 'fresh-face' }, { proxyWallet: W_INSIDER, amount: 3000, outcomeIndex: 1, name: 'Jonathan Smithers' }, { proxyWallet: W_NOPROFILE, amount: 50, outcomeIndex: 1, name: null }] }];
    if (url.includes('/public-profile?')) {
      if (url.includes(W_NOPROFILE)) throw new Error('HTTP 404');
      if (url.includes(W_INSIDER)) return { createdAt: '2025-01-01T00:00:00Z', name: 'Jonathan Smithers', xUsername: 'jsmithers_ac', bio: '', verifiedBadge: false };
      return { createdAt: new Date((NOW - 3 * 86_400) * 1000).toISOString(), name: 'fresh-face', pseudonym: 'Brave-Fox', xUsername: null, bio: null, verifiedBadge: false };
    }
    if (url.includes('/activity?') && url.includes('sortDirection=ASC')) return [{ timestamp: NOW - 100 * 86_400 }];
    if (url.includes('/activity?')) return Array.from({ length: 30 }, (_, i) => ({ timestamp: NOW - i * 86_400, type: 'TRADE', side: 'BUY', usdcSize: 500, conditionId: `0x${i}` }));
    if (url.includes('/traded?')) return { traded: 12 };
    if (url.includes('/v1/leaderboard?')) return [{ pnl: 5_000, vol: 90_000, userName: 'lb' }];
    if (url.includes('/positions?')) return [{ outcomeIndex: url.includes(W_NEW.slice(2)) ? 0 : 1, size: 1000, avgPrice: 0.5, curPrice: 0.9, currentValue: 900, cashPnl: 400 }];
    throw new Error(`unexpected ${url}`);
  };
}
const dexApi: FetchJson = async () => ({ pairs: [{ chainId: 'solana', dexId: 'meteora', priceUsd: '0.04', liquidity: { usd: 80_000 }, volume: { h1: 100_000 }, pairCreatedAt: (NOW - 900) * 1000 }] });
const refCfg = { match: 'acme', kind: 'dex-token' as const, chain: 'solana', mint: 'M', supply: 1e9, checks: ['confirm the mint'] };

describe('loading a decision end to end', () => {
  it('combines books, the reference price, flow, wallets, creation dates and watchlist hits', async () => {
    const store = openStore();
    const stages: string[] = [];
    const v = await loadDecision(new PolymarketClient(fakeApi(), fast), store, 'acme-fdv', { now: () => NOW * 1000, people: [JON, { name: 'Jonathan Smithers', handles: ['jsmithers_ac'] }], refs: [refCfg], fetchJson: dexApi, onProgress: (x) => stages.push(x.stage) });
    expect(v).toMatchObject({ done: true, error: null, title: 'Acme FDV above ___ one day after launch?' });
    expect(stages[0]).toBe('reading order books');
    expect(stages).toContain('reading the reference price');
    expect(stages.some((s) => s.startsWith('reading trades'))).toBe(true);
    expect(stages.some((s) => s.startsWith('profiling'))).toBe(true);
    expect(stages[stages.length - 1]).toBe('done');
    const d = v.decision!;
    // the book overrides gamma's quote, and depth comes from the book
    const b = d.markets.find((m) => m.label === '$70M')!;
    expect([b.yesBid, b.yesAsk]).toEqual([0.5, 0.55]);
    expect(d.reference).toMatchObject({ spotFdv: 40_000_000, pools: 1 });
    expect(b.fair).not.toBeNull(); // the model ran: reference + a ladder rung + a known measurement time
    expect(d.ladder?.rungs.map((r) => r.label)).toEqual(['$30M', '$70M']);
    // wallets: creation dates, the 404 profile, the watchlist hit
    const ws = v.wallets[CID_B];
    expect(ws.find((w) => w.wallet === W_INSIDER)).toMatchObject({ createdAt: Math.floor(Date.parse('2025-01-01T00:00:00Z') / 1000), xUsername: 'jsmithers_ac', side: 1 });
    expect(ws.find((w) => w.wallet === W_INSIDER)!.matches[0]).toMatchObject({ kind: 'HANDLE', score: 100 });
    expect(ws.find((w) => w.wallet === W_NOPROFILE)).toMatchObject({ createdAt: null });
    const kinds = b.leads.map((l) => `${l.kind}:${l.name}`);
    expect(kinds).toContain('MATCH:Jonathan Smithers');
    const a = d.markets.find((m) => m.label === '$30M')!;
    expect(a.leads.some((l) => l.kind === 'NEW' && l.text.includes('fresh-face'))).toBe(true);
    expect(b.flow1h).toMatchObject({ first: expect.any(Number), second: expect.any(Number) });
    store.close();
  });

  it('survives a failing reference and reports it', async () => {
    const store = openStore();
    const v = await loadDecision(new PolymarketClient(fakeApi(), fast), store, 'acme-fdv', { now: () => NOW * 1000, refs: [refCfg], fetchJson: async () => { throw new Error('fetch failed'); }, retryDelayMs: 0 });
    expect(v.done).toBe(true);
    expect(v.decision?.headline).toMatch(/reference price unavailable/);
    expect(v.decision?.markets.every((m) => m.fair === null)).toBe(true);
    store.close();
  });

  it('reports a missing event instead of throwing', async () => {
    const store = openStore();
    const v = await loadDecision(new PolymarketClient(async () => [], fast), store, 'nope', { now: () => NOW * 1000 });
    expect(v).toMatchObject({ done: true, decision: null });
    expect(v.error).toMatch(/event not found/);
    store.close();
  });
});

describe('holders gain a creation date and watchlist hits', () => {
  it('adds createdAt, the linked X handle and matches to each holder row', async () => {
    const store = openStore();
    const v = await loadHolders(new PolymarketClient(fakeApi(), fast), store, 'acme-fdv', { now: () => NOW * 1000, people: [JON] });
    const insider = v.rows.find((r) => r.wallet === W_INSIDER);
    expect(insider).toMatchObject({ xUsername: 'jsmithers_ac' });
    expect(insider?.createdAt).toBe(Math.floor(Date.parse('2025-01-01T00:00:00Z') / 1000));
    expect(insider?.matches?.[0]).toMatchObject({ kind: 'HANDLE' });
    expect(v.rows.find((r) => r.wallet === W_NOPROFILE)?.createdAt).toBeNull();
    store.close();
  });
});

describe('decision tab', () => {
  const view = (over: Partial<View> = {}): View => ({ tab: 'decision', sel: 0, cols: 140, rows: 42, ...over });
  const empty: Model = {
    anomalies: [], games: [], prints: [], leads: [], holders: null, showBots: false, oiSeries: [], filter: null,
    status: { lastPollAt: NOW * 1000, nextPollAt: null, busy: false, error: null, events: 0, historySecs: 0, printsWindowMin: null, message: null },
  };
  it('explains how to open it when nothing is loaded', () => {
    const text = strip(render(empty, view(), Date.now()).join('\n'));
    expect(text).toMatch(/6 Decision/);
    expect(text).toMatch(/press p to decide/);
  });
  it('shows actions, quotes, the model range, wallet creation dates and flags, and the standing caveat', async () => {
    const store = openStore();
    const dv = await loadDecision(new PolymarketClient(fakeApi(), fast), store, 'acme-fdv', { now: () => NOW * 1000, people: [JON], refs: [refCfg], fetchJson: dexApi });
    store.close();
    const m: Model = { ...empty, decision: dv };
    const lines = render(m, view({ sel: 1 }), Date.now()).map(strip);
    expect(lines.length).toBe(42);
    const text = lines.join('\n');
    expect(text).toMatch(/ACTION\s+MARKET\s+BID\/ASK\s+MODEL/);
    expect(text).toMatch(/\$30M/);
    expect(text).toMatch(/0\.50\/0\.55/);
    expect(text).toMatch(/never from following wallets/);
    expect(text).toMatch(/CREATED/);
    expect(text).toMatch(/2025-01-01/); // the watchlisted wallet's creation date
    expect(text).toMatch(/≈/); // name-match marker
    expect(text).toMatch(/1-9,0 tabs/);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(140 + 20); // no line overflows the terminal (width counts glyphs, not bytes)
  });
  it('never overflows its box at any terminal size, with a loaded decision', async () => {
    const store = openStore();
    const dv = await loadDecision(new PolymarketClient(fakeApi(), fast), store, 'acme-fdv', { now: () => NOW * 1000, people: [JON], refs: [refCfg], fetchJson: dexApi });
    store.close();
    for (const [cols, rows] of [[50, 12], [60, 16], [80, 24], [100, 30], [140, 40], [220, 60]]) {
      for (const sel of [0, 1]) {
        const lines = render({ ...empty, decision: dv }, view({ cols, rows, sel }), Date.now());
        expect(lines, `${cols}x${rows}`).toHaveLength(rows);
        for (const l of lines) expect(vlen(l), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
      }
    }
  });
  it('moves the selection within the decision rows and switches with key 6', async () => {
    const store = openStore();
    const dv = await loadDecision(new PolymarketClient(fakeApi(), fast), store, 'acme-fdv', { now: () => NOW * 1000 });
    store.close();
    const m: Model = { ...empty, decision: dv };
    expect(moveSelection(view({ tab: 'anomalies' }), '6', m).tab).toBe('decision');
    expect(moveSelection(view({ sel: 0 }), 'down', m).sel).toBe(1);
    expect(moveSelection(view({ sel: 1 }), 'down', m).sel).toBe(1); // two markets: stops at the last
  });
  it('adds the CREATED column to holders and highlights new accounts', () => {
    const now = Date.now() / 1000;
    const row = (name: string, createdAt: number | null, matches: NonNullable<Model['holders']>['rows'][number]['matches'] = []) => ({ wallet: `0x${name.padEnd(40, '0')}`, name, outcomeIndex: 0, outcome: 'Yes', shares: 1000, avgPrice: 0.5, curPrice: 0.6, posUsd: 600, uPnl: 100, pnlAll: 1000, pnlWeek: 10, vol: 5000, traded: 4, ageDays: 5, perDay: 2, cls: 'HUMAN' as const, confidence: 'medium' as const, reasons: [], flags: [], createdAt, xUsername: null, matches });
    const hit = matchPeople({ ...noId, name: 'Jonathan Smithers' }, [JON]);
    const m: Model = { ...empty, holders: { slug: 's', eventTitle: 't', question: 'Q?', cid: 'c', total: 3, loaded: 3, done: true, error: null, rows: [row('fresh', now - 2 * 86_400), row('veteran', now - 900 * 86_400), row('Jonathan Smithers', null, hit)] } };
    const text = strip(render(m, view({ tab: 'holders' }), Date.now()).join('\n'));
    expect(text).toMatch(/CREATED/);
    expect(text).toContain(new Date((now - 2 * 86_400) * 1000).toISOString().slice(0, 10));
    expect(text).toMatch(/≈ Jonathan Smithers/);
    const detail = strip(render(m, view({ tab: 'holders', sel: 0 }), Date.now()).join('\n'));
    expect(detail).toMatch(/profile created .*\(2d\).*NEW ACCOUNT/);
  });
});

describe('search tab', () => {
  const empty: Model = {
    anomalies: [], games: [], prints: [], leads: [], holders: null, showBots: false, oiSeries: [], filter: null,
    status: { lastPollAt: NOW * 1000, nextPollAt: null, busy: false, error: null, events: 0, historySecs: 0, printsWindowMin: null, message: null },
  };
  const v = (over: Partial<View> = {}): View => ({ tab: 'search', sel: 0, cols: 120, rows: 30, ...over });
  it('maps public-search results with their open/closed state', async () => {
    const client = new PolymarketClient(async (url) => {
      expect(url).toContain('limit_per_type=25');
      return { events: [{ slug: 'a', title: 'Alpha', volume: '12', closed: false }, { slug: 'b', title: 'Beta', volume: 5, closed: true }] };
    }, fast);
    expect(await client.searchEvents('x', 25)).toEqual([{ slug: 'a', title: 'Alpha', volume: 12, closed: false }, { slug: 'b', title: 'Beta', volume: 5, closed: true }]);
  });
  it('shows the prompt, a cursor while typing, results with state, and an empty-result message', () => {
    const hits = [{ slug: 'will-1win-launch-a-token-by', title: 'Will 1win launch a token by ___?', volume: 55_000, closed: false }, { slug: 'old', title: 'Old market', volume: 9_000_000, closed: true }];
    const typing = strip(render({ ...empty, search: { query: '1wi', typing: true, loading: false, error: null, results: [] } }, v(), Date.now()).join('\n'));
    expect(typing).toMatch(/Search\s+1wi/);
    expect(typing).toMatch(/Enter search/);
    const done = strip(render({ ...empty, search: { query: '1win', typing: false, loading: false, error: null, results: hits } }, v(), Date.now()).join('\n'));
    expect(done).toMatch(/VOLUME\s+STATE\s+EVENT/);
    expect(done).toMatch(/Will 1win launch a token by/);
    expect(done).toMatch(/open/);
    expect(done).toMatch(/closed/);
    expect(done).toMatch(/p decide/); // detail line for the selected result
    const none = strip(render({ ...empty, search: { query: 'zzzz', typing: false, loading: false, error: null, results: [] } }, v(), Date.now()).join('\n'));
    expect(none).toMatch(/no events matched/);
    expect(strip(render(empty, v(), Date.now()).join('\n'))).toMatch(/press \//);
  });
  it('switches with key 7 and moves within results', () => {
    const m: Model = { ...empty, search: { query: 'q', typing: false, loading: false, error: null, results: [1, 2, 3].map((i) => ({ slug: `s${i}`, title: `T${i}`, volume: i, closed: false })) } };
    expect(moveSelection(v({ tab: 'anomalies' }), '7', m).tab).toBe('search');
    expect(moveSelection(v({ sel: 0 }), 'end', m).sel).toBe(2);
  });
  it('never overflows its box at any size', () => {
    const m: Model = { ...empty, search: { query: 'bitcoin', typing: false, loading: false, error: 'HTTP 500', results: Array.from({ length: 30 }, (_, i) => ({ slug: `slug-number-${i}-with-a-long-name`, title: `日本語のタイトル ${i} with a really long market title that must be clipped`, volume: i * 1e5, closed: i % 2 === 0 })) } };
    for (const [cols, rows] of [[50, 12], [60, 16], [80, 24], [140, 40], [220, 60]]) {
      const lines = render(m, v({ cols, rows, sel: 3 }), Date.now());
      expect(lines, `${cols}x${rows}`).toHaveLength(rows);
      for (const l of lines) expect(vlen(l), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
    }
  });
});

