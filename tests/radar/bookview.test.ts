import { describe, expect, it } from 'vitest';
import { bidShare, costSummary, dom, loadBook, tape } from '../../radar/bookview';
import { PolymarketClient } from '../../radar/polymarket';
import { render, strip, vlen } from './helpers-book';

const book = { bids: [{ price: 0.48, size: 1000 }, { price: 0.45, size: 2000 }], asks: [{ price: 0.5, size: 400 }, { price: 0.53, size: 800 }, { price: 0.6, size: 100 }] };

describe('order book view', () => {
  it('puts the i-th best bid and ask on one row with cumulative dollars growing away from the spread', () => {
    const d = dom(book, 3);
    expect(d.rows).toHaveLength(3);
    expect(d.rows[0].bid).toMatchObject({ price: 0.48, size: 1000 });
    expect(d.rows[0].bid?.cum).toBeCloseTo(480);
    expect(d.rows[1].bid?.cum).toBeCloseTo(480 + 900);
    expect(d.rows[0].ask?.cum).toBeCloseTo(200);
    expect(d.rows[2].ask?.cum).toBeCloseTo(200 + 424 + 60);
    expect(d.rows[2].bid).toBeNull(); // only two bids
    expect(d.max).toBeCloseTo(1380);
    expect(dom({ bids: [], asks: [] }, 3)).toEqual({ rows: [], max: 1 });
  });
  it('turns fills into tape lines with the outcome name and flags the big ones', () => {
    const t = tape([{ cid: 'c', wallet: '0xabc', side: 'SELL', outcomeIndex: 1, price: 0.4, size: 5000, ts: 9, tx: null }, { cid: 'c', wallet: '0xdef', side: 'BUY', outcomeIndex: 0, price: 0.5, size: 10, ts: 8, tx: null }] as never, ['Yes', 'No']);
    expect(t[0]).toMatchObject({ side: 'SELL', outcome: 'No', usd: 2000, big: true });
    expect(t[1]).toMatchObject({ outcome: 'Yes', big: false });
  });
  it('measures how much of the nearby money is bids', () => {
    expect(bidShare({ bid: 0.4, ask: 0.5, spreadCents: 10, bidDepthUsd: 300, askDepthUsd: 100 })).toBeCloseTo(0.75);
    expect(bidShare({ bid: null, ask: null, spreadCents: null, bidDepthUsd: 0, askDepthUsd: 0 })).toBeNull();
  });
  it('prices both outcomes with slippage and the cost of leaving', () => {
    const c = costSummary(book, ['Yes', 'No'], 0.05);
    expect(c).toHaveLength(4);
    expect(c[0]).toMatch(/^buy \$50 Yes: avg 50\.0c, slip 0\.0c, needs 51\.\dc? ?%? ?/);
    expect(c.join('\n')).toMatch(/buy \$500 No:/);
  });
  it('loads the market book through the client and reports failures', async () => {
    const ev = [{ slug: 's', title: 'T', volume: 1, closed: false, tags: ['sports'], markets: [{ conditionId: '0xc', question: 'Q?', outcomes: '["Yes","No"]', clobTokenIds: '["t1","t2"]', volume: 1, closed: false }] }];
    const f = async (url: string) => (url.includes('/events?') ? ev : url.includes('/book?') ? { bids: [{ price: '0.4', size: '10' }], asks: [{ price: '0.6', size: '10' }] } : Promise.reject(new Error('x')));
    const v = await loadBook(new PolymarketClient(f as never, { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 }), 's', '0xc', () => 5);
    expect(v).toMatchObject({ question: 'Q?', fetchedAt: 5, error: null, feeRate: 0.05 });
    expect(v.summary?.bid).toBe(0.4);
    const bad = await loadBook(new PolymarketClient(async () => [] as never, { minIntervalMs: 0, retries: 0, sleep: async () => undefined, now: () => 0 }), 's', '0xc');
    expect(bad.error).toMatch(/market not found/);
  });
  it('renders inside every box size', () => {
    const m = { anomalies: [], games: [], prints: [], leads: [], holders: null, showBots: false, oiSeries: [], filter: null, status: { lastPollAt: 1, nextPollAt: null, busy: false, error: null, events: 0, historySecs: 0, printsWindowMin: null, message: null },
      book: { slug: 's', cid: 'c', question: 'Will X?', outcomes: ['Yes', 'No'], book, summary: { bid: 0.48, ask: 0.5, spreadCents: 2, bidDepthUsd: 900, askDepthUsd: 400 }, feeRate: 0.05, fetchedAt: Date.now(), error: null, trades: [{ cid: 'c', wallet: `0x${'a'.repeat(40)}`, side: 'BUY', outcomeIndex: 0, price: 0.62, size: 2000, ts: Math.floor(Date.now() / 1000) - 5, tx: null }] } };
    const text = render(m as never, { tab: 'book', sel: 0, cols: 120, rows: 40 }, Date.now()).map(strip).join('\n');
    expect(text).toMatch(/ORDER BOOK\s+Will X\?/);
    expect(text).toMatch(/BID 48\.0\s+ASK 50\.0\s+MID 49\.0\s+SPR 2\.0c/);
    expect(text).toMatch(/DEPTH ±5c.*69% of nearby money is bids/);
    expect(text).toMatch(/TIME\s+SIDE\s+OUTCOME\s+PRICE/);
    expect(text).toMatch(/BUY\s+Yes\s+62\.0\s+\$1\.2k/);
    expect(text).toMatch(/buy \$500 No:/);
    for (const [cols, rows] of [[40, 10], [80, 24], [100, 30], [111, 40], [140, 50], [220, 60]]) {
      const lines = render(m as never, { tab: 'book', sel: 0, cols, rows }, Date.now());
      expect(lines).toHaveLength(rows);
      for (const l of lines) expect(vlen(l)).toBeLessThanOrEqual(cols);
    }
    expect(strip(render({ ...m, book: null } as never, { tab: 'book', sel: 0, cols: 120, rows: 20 }, Date.now()).join('\n'))).toMatch(/press 8 on a market/);
  });
});

describe('closed markets', () => {
  it('say there is no order book instead of showing a URL', async () => {
    const { refreshBook } = await import('../../radar/bookview');
    const f = async () => { throw new Error('HTTP 404'); };
    const r = await refreshBook(new PolymarketClient(f as never, { minIntervalMs: 0, retries: 0, sleep: async () => undefined, now: () => 0 }), 'tok', {} as never);
    expect(r.error).toBe('no order book: this market has closed or is not trading');
  });
});
