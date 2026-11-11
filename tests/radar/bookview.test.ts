import { describe, expect, it } from 'vitest';
import { costSummary, ladder, loadBook } from '../../radar/bookview';
import { PolymarketClient } from '../../radar/polymarket';
import { render, strip, vlen } from './helpers-book';

const book = { bids: [{ price: 0.48, size: 1000 }, { price: 0.45, size: 2000 }], asks: [{ price: 0.5, size: 400 }, { price: 0.53, size: 800 }, { price: 0.6, size: 100 }] };

describe('order book view', () => {
  it('lists asks high-to-best, the spread, then bids, with cumulative dollars', () => {
    const l = ladder(book, ['Yes', 'No'], 3);
    expect(l.map((x) => x.side)).toEqual(['ask', 'ask', 'ask', 'spread', 'bid', 'bid']);
    expect(l[0].text).toMatch(/60\.0c\s+40\.0c\s+100\s+\$684/); // furthest ask: cumulative includes the nearer ones (200 + 424 + 60)
    expect(l[2].text).toMatch(/50\.0c\s+50\.0c\s+400\s+\$200/);
    expect(l[3].text).toMatch(/spread 2\.0c/);
    expect(l[4].text).toMatch(/48\.0c\s+52\.0c\s+1,000\s+\$480/);
    expect(ladder({ bids: [], asks: [] }, ['Yes', 'No'], 3)[0].text).toMatch(/one-sided/);
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
      book: { slug: 's', cid: 'c', question: 'Will X?', outcomes: ['Yes', 'No'], book, summary: { bid: 0.48, ask: 0.5, spreadCents: 2, bidDepthUsd: 900, askDepthUsd: 400 }, feeRate: 0.05, fetchedAt: Date.now(), error: null } };
    const text = render(m as never, { tab: 'book', sel: 0, cols: 120, rows: 40 }, Date.now()).map(strip).join('\n');
    expect(text).toMatch(/Order book\s+Will X\?/);
    expect(text).toMatch(/spread 2\.0c/);
    expect(text).toMatch(/buy \$500 No:/);
    for (const [cols, rows] of [[40, 10], [80, 24], [140, 50], [220, 60]]) {
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
