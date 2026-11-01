import { describe, expect, it } from 'vitest';
import { PolymarketClient, type FetchJson } from '../../radar/polymarket';
import type { TradeRow } from '../../radar/store';
import { rankSurges, scanSurges, scoreSurge, SURGE_CAVEAT, SURGE_FLAG_TEXT, SURGE_THRESHOLDS } from '../../radar/surge';

const NOW = 2_000_000_000;
const H = 3600;
let seq = 0;
/** One taker fill worth `usd` dollars at price 0.5. */
const fill = (ts: number, usd: number, over: Partial<TradeRow> = {}): TradeRow => ({ cid: '0xm', wallet: `w${seq++}`, side: 'BUY', outcomeIndex: 0, price: 0.5, ts, tx: null, ...over, size: usd / (over.price ?? 0.5) });
/** `hours` quiet hours before the trailing hour, `usd` each, by wallet "old" (or by the given wallets in turn). */
const baseline = (hours: number, usd: number, wallets = ['old']): TradeRow[] => Array.from({ length: hours }, (_, i) => fill(NOW - H - i * H - 60, usd, { wallet: wallets[i % wallets.length] }));
const old = { createdAt: NOW - 30 * 86_400 };
const flagsOf = (trades: TradeRow[], market = old) => scoreSurge(trades, market, NOW).flags;

describe('volume surge flag', () => {
  it('trips at exactly 8x the median hour and not just below', () => {
    const base = baseline(10, 300); // median $300 -> bar $2400
    expect(flagsOf([...base, fill(NOW - 10, 2400)])).toContain('volume_surge');
    expect(flagsOf([...base, fill(NOW - 10, 2399)])).not.toContain('volume_surge');
    const m = scoreSurge([...base, fill(NOW - 10, 2400)], old, NOW).metrics;
    expect(m).toMatchObject({ medianHourUsd: 300, baselineHours: 10, usd1h: 2400, volRatio: 8 });
  });
  it('needs at least $2000 even when the ratio is huge', () => {
    const base = baseline(10, 100);
    expect(flagsOf([...base, fill(NOW - 10, SURGE_THRESHOLDS.minUsd)])).toContain('volume_surge');
    expect(flagsOf([...base, fill(NOW - 10, 1999)])).toEqual([]);
  });
  it('counts silent hours as zero, so a quiet market with a median of 0 surges on any $2000 hour', () => {
    const base = [fill(NOW - 20 * H, 500, { wallet: 'old' })]; // one fill 20h ago, 19 empty hours since
    const s = scoreSurge([...base, fill(NOW - 10, 2000)], old, NOW);
    expect(s.metrics.medianHourUsd).toBe(0);
    expect(s.metrics.volRatio).toBeNull();
    expect(s.flags).toContain('volume_surge');
  });
  it('ignores fills after now', () => {
    expect(scoreSurge([...baseline(5, 10), fill(NOW + 10, 9000)], old, NOW).metrics.usd1h).toBe(0);
  });
});

describe('one-sided flag', () => {
  const base = baseline(10, 10);
  it('trips at 75% of buy dollars on one outcome and not below', () => {
    const s = scoreSurge([...base, fill(NOW - 10, 1500), fill(NOW - 20, 500, { outcomeIndex: 1 })], old, NOW);
    expect(s.flags).toContain('one_sided');
    expect(s.metrics).toMatchObject({ oneSidedShare: 0.75, dirIdx: 0, buyUsd1h: 2000 });
    expect(flagsOf([...base, fill(NOW - 10, 1499), fill(NOW - 20, 501, { outcomeIndex: 1 })])).not.toContain('one_sided');
  });
  it('reads the direction from buying only and reports the price move in that direction', () => {
    const s = scoreSurge([...base, fill(NOW - 50, 1800, { outcomeIndex: 1, price: 0.4 }), fill(NOW - 10, 900, { side: 'SELL', price: 0.4, outcomeIndex: 1 })], old, NOW);
    expect(s.metrics.dirIdx).toBe(1);
    expect(s.metrics.oneSidedShare).toBe(1);
    expect(s.metrics.priceJump).toBeCloseTo(0.1); // outcome-0 price 0.5 -> 0.6
    expect(s.metrics.dirJump).toBeCloseTo(-0.1);
  });
  it('has no direction on a tie', () => {
    const s = scoreSurge([...base, fill(NOW - 10, 1000), fill(NOW - 20, 1000, { outcomeIndex: 1 })], old, NOW);
    expect(s.metrics.dirIdx).toBeNull();
    expect(s.flags).not.toContain('one_sided');
  });
});

describe('concentrated flag', () => {
  const base = baseline(10, 10);
  const hour = (otherUsd: number) => [
    ...['a', 'b', 'c'].map((w) => fill(NOW - 10, 400, { wallet: w })),
    ...Array.from({ length: 12 }, (_, i) => fill(NOW - 20, otherUsd, { wallet: `x${i}` })),
  ];
  it('trips when the top three wallets do exactly half the volume and not below', () => {
    const s = scoreSurge([...base, ...hour(100)], old, NOW);
    expect(s.metrics.top3Share).toBe(0.5);
    expect(s.flags).toContain('concentrated');
    expect(flagsOf([...base, ...hour(101)])).not.toContain('concentrated');
  });
  it('flags one wallet doing everything as concentrated and one-sided', () => {
    const f = flagsOf([...base, fill(NOW - 10, 3000, { wallet: 'z' }), fill(NOW - 5, 3000, { wallet: 'z' })]);
    expect(f).toEqual(expect.arrayContaining(['volume_surge', 'one_sided', 'concentrated', 'fresh_wallets']));
  });
});

describe('fresh-wallet flag', () => {
  const base = [...baseline(10, 10), fill(NOW - 5 * H, 10, { wallet: 'seen' })];
  it('trips when half the hour comes from wallets with no earlier fill and not below', () => {
    const s = scoreSurge([...base, fill(NOW - 10, 1000, { wallet: 'seen' }), fill(NOW - 20, 1000, { wallet: 'new' })], old, NOW);
    expect(s.metrics.freshShare).toBe(0.5);
    expect(s.flags).toContain('fresh_wallets');
    expect(flagsOf([...base, fill(NOW - 10, 1001, { wallet: 'seen' }), fill(NOW - 20, 999, { wallet: 'new' })])).not.toContain('fresh_wallets');
  });
});

describe('young market flag', () => {
  it('trips under 7 days old and not at 7', () => {
    expect(flagsOf([], { createdAt: NOW - 7 * 86_400 + 60 })).toEqual(['young_market']);
    expect(flagsOf([], { createdAt: NOW - 7 * 86_400 })).toEqual([]);
    expect(scoreSurge([], { createdAt: null }, NOW).metrics).toMatchObject({ ageDays: null, young: false });
  });
  it('alone scores nothing: only a volume surge makes a market rank', () => {
    expect(scoreSurge([], { createdAt: NOW - 3600 }, NOW).score).toBe(0);
  });
});

describe('degenerate input', () => {
  it('scores empty input as nothing', () => {
    const s = scoreSurge([], old, NOW);
    expect(s).toMatchObject({ score: 0, flags: [] });
    expect(s.metrics).toMatchObject({ usd1h: 0, fills1h: 0, baselineHours: 0, medianHourUsd: 0, volRatio: null, oneSidedShare: 0, top3Share: 0, freshShare: 0, priceNow: null, priceJump: null, dirIdx: null });
  });
  it('scores a single small fill as nothing', () => {
    expect(scoreSurge([fill(NOW - 10, 50)], old, NOW)).toMatchObject({ score: 0, flags: [] });
  });
  it('treats a lone big first fill of a brand-new market as a surge, but not when the history was cut off', () => {
    const t = [fill(NOW - 10, 5000)];
    const s = scoreSurge(t, { createdAt: NOW - 1800 }, NOW);
    expect(s.flags).toEqual(['volume_surge', 'one_sided', 'concentrated', 'fresh_wallets', 'young_market']);
    expect(s.metrics.priceJump).toBe(0);
    expect(scoreSurge(t, { createdAt: NOW - 1800, historyComplete: false }, NOW).flags).toEqual(['young_market']);
  });
});

describe('ranking', () => {
  it('ranks by score: more flags beat fewer, a bigger multiple breaks ties, then dollars', () => {
    const base = baseline(10, 250, Array.from({ length: 10 }, (_, i) => `p${i}`)); // the same wallets traded before, so nobody is fresh
    const plain = scoreSurge([...base, ...Array.from({ length: 10 }, (_, i) => fill(NOW - 10, 200, { wallet: `p${i}`, outcomeIndex: i % 2 }))], old, NOW); // $2000 = 8x, spread out
    const big = scoreSurge([...base, ...Array.from({ length: 10 }, (_, i) => fill(NOW - 10, 800, { wallet: `p${i}`, outcomeIndex: i % 2 }))], old, NOW); // 32x
    const lopsided = scoreSurge([...base, fill(NOW - 10, 2000, { wallet: 'z' })], old, NOW);
    expect(plain.flags).toEqual(['volume_surge']);
    expect(big.flags).toEqual(['volume_surge']);
    expect(big.score).toBeGreaterThan(plain.score);
    expect(lopsided.score).toBeGreaterThan(big.score);
    const r = rankSurges([{ id: 'plain', ...plain }, { id: 'lopsided', ...lopsided }, { id: 'big', ...big }]);
    expect(r.map((x) => x.id)).toEqual(['lopsided', 'big', 'plain']);
  });
});

describe('wording', () => {
  it('describes behavior only', () => {
    const all = [...Object.values(SURGE_FLAG_TEXT), SURGE_CAVEAT].join(' ');
    expect(all).not.toMatch(/insider|informed|cheat|fix(ed|ing)|manipulat|smart money/i);
    expect(SURGE_CAVEAT).toMatch(/not signals/);
    expect(SURGE_CAVEAT).toMatch(/not a recommendation/);
  });
});

// ---- scanSurges with a fake API ----

const iso = (secs: number): string => new Date(secs * 1000).toISOString();
const rawFill = (cid: string, t: TradeRow) => ({ conditionId: cid, proxyWallet: t.wallet, side: t.side, outcomeIndex: t.outcomeIndex, price: t.price, size: t.size, timestamp: t.ts, transactionHash: `0x${seq++}` });
const market = (cid: string, slug: string, createdAt: number, over: Record<string, unknown> = {}) => ({
  conditionId: cid, slug, question: `Question ${slug}?`, createdAt: iso(createdAt), outcomes: '["Yes","No"]', clobTokenIds: `["y${cid}","n${cid}"]`, closed: false, ...over,
});

function fakeClient(): { c: PolymarketClient; calls: string[] } {
  const trades: Record<string, TradeRow[]> = {
    // young market: one wallet buys $6000 of No in the last hour after a quiet day
    '0xA': [...baseline(24, 20), fill(NOW - 100, 6000, { wallet: 'z', outcomeIndex: 1, price: 0.3 })],
    // busy old market: steady volume, no surge
    '0xB': [...baseline(24, 5000), fill(NOW - 100, 5000)],
    // old quiet market with a spread-out surge
    '0xC': [...baseline(24, 100, Array.from({ length: 10 }, (_, i) => `c${i}`)), ...Array.from({ length: 10 }, (_, i) => fill(NOW - 100, 300, { wallet: `c${i}`, outcomeIndex: i % 2 }))],
    '0xE': [],
  };
  const calls: string[] = [];
  const f: FetchJson = async (url) => {
    calls.push(url);
    if (url.includes('/markets?order=createdAt')) return [market('0xA', 'young-one', NOW - 2 * 86_400), market('0xD', 'broken', NOW - 86_400), market('0xX', 'btc-updown-5m', NOW - 600), market('0xE', 'empty', NOW - 3600)];
    if (url.includes('/events?active=true'))
      return [{ slug: 'busy-event', markets: [market('0xB', 'busy', NOW - 90 * 86_400, { volume24hr: 900_000 }), market('0xC', 'quiet-old', NOW - 60 * 86_400, { volume24hr: 1000 }), market('0xA', 'young-one', NOW - 2 * 86_400, { volume24hr: 10 })] }];
    if (url.includes('/trades?market=')) {
      const cid = /market=(\w+)/.exec(url)?.[1] as string;
      if (cid === '0xD') throw new Error('HTTP 500');
      if (!(cid in trades)) throw new Error(`unexpected trades ${cid}`);
      return Number(/offset=(\d+)/.exec(url)?.[1] ?? 0) === 0 ? trades[cid].map((t) => rawFill(cid, t)) : [];
    }
    if (url.includes('/book?token_id=n0xA')) return { bids: [{ price: '0.30', size: '100' }], asks: [{ price: '0.35', size: '200' }, { price: '0.33', size: '50' }] };
    if (url.includes('/book?token_id=')) return { bids: [], asks: [] };
    throw new Error(`unexpected ${url}`);
  };
  return { c: new PolymarketClient(f, { minIntervalMs: 0, retries: 0, sleep: async () => undefined, now: () => 0 }), calls };
}

describe('scanSurges', () => {
  it('scans newest and busiest markets, skips a failing one, and ranks flagged surges with direction and best ask', async () => {
    const { c, calls } = fakeClient();
    const stages: string[] = [];
    const r = await scanSurges(c, { now: () => NOW * 1000, onProgress: (s) => stages.push(s) });
    expect(r).toMatchObject({ candidates: 5, scanned: 4, skipped: 1, noTrades: 1, flagged: 2, caveat: SURGE_CAVEAT });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^0xD: /);
    expect(calls.some((u) => u.includes('market=0xX'))).toBe(false); // candle markets excluded by default
    expect(r.rows.map((x) => x.slug)).toEqual(['young-one', 'quiet-old']);
    const [top, second] = r.rows;
    expect(top).toMatchObject({ cid: '0xA', eventSlug: 'young-one', source: 'new', dirIdx: 1, dirOutcome: 'No', bestAsk: 0.33, askUsd: 16.5, title: 'Question young-one?' });
    expect(top.flags).toEqual(['volume_surge', 'one_sided', 'concentrated', 'fresh_wallets', 'young_market']);
    expect(top.metrics.young).toBe(true);
    expect(second).toMatchObject({ cid: '0xC', eventSlug: 'busy-event', source: 'mover', flags: ['volume_surge'], dirIdx: null, bestAsk: null });
    expect(top.score).toBeGreaterThan(second.score);
    expect(stages[stages.length - 1]).toBe('done');
  });
  it('returns an empty result with errors when the listings fail, without throwing', async () => {
    const f: FetchJson = async () => { throw new Error('HTTP 503'); };
    const r = await scanSurges(new PolymarketClient(f, { minIntervalMs: 0, retries: 0, sleep: async () => undefined }), { now: () => NOW * 1000 });
    expect(r).toMatchObject({ candidates: 0, rows: [], flagged: 0 });
    expect(r.errors.length).toBe(2);
  });
});
