import { describe, expect, it } from 'vitest';
import { costSummary, cycle, defaultUi, emptyBook, GROUPS, loadBookMeta, toBook, type BookView } from '../../radar/bookview';
import { newLiveState } from '../../radar/livebook';
import { PolymarketClient } from '../../radar/polymarket';
import { strip, vlen } from '../../radar/tui/ansi';
import { render, type Model } from '../../radar/tui/render';

const fast = { minIntervalMs: 0, retries: 0, sleep: async () => undefined, now: () => 0 };

describe('book metadata', () => {
  const ev = [{ slug: 's', title: 'T', volume: 1, closed: false, tags: [{ slug: 'sports' }], markets: [{ conditionId: '0xc', question: 'Q?', outcomes: '["Heat","Jazz"]', clobTokenIds: '["t1","t2"]', orderPriceMinTickSize: 0.001, volume: 1, closed: false }] }];
  it('reads the tokens, outcome names, tick size and fee category of a market', async () => {
    const f = async (url: string) => (url.includes('/events?') ? ev : Promise.reject(new Error('x')));
    const v = await loadBookMeta(new PolymarketClient(f as never, fast), 's', '0xc');
    expect(v).toMatchObject({ question: 'Q?', outcomes: ['Heat', 'Jazz'], tokenIds: ['t1', 't2'], tickMills: 1, feeRate: 0.05, error: null });
  });
  it('defaults the tick to one cent and reports an unknown market or one without a book', async () => {
    const noTick = [{ ...ev[0], markets: [{ ...ev[0].markets[0], orderPriceMinTickSize: undefined }] }];
    expect((await loadBookMeta(new PolymarketClient((async () => noTick) as never, fast), 's', '0xc')).tickMills).toBe(10);
    expect((await loadBookMeta(new PolymarketClient((async () => []) as never, fast), 's', '0xc')).error).toMatch(/market not found/);
    const noBook = [{ ...ev[0], markets: [{ ...ev[0].markets[0], clobTokenIds: '[]' }] }];
    expect((await loadBookMeta(new PolymarketClient((async () => noBook) as never, fast), 's', '0xc')).error).toMatch(/no order book/);
  });
});

describe('cost lines and helpers', () => {
  it('prices both outcomes from the live state, including after flipping the view', () => {
    const s = newLiveState('t');
    s.bids.set(480, 1000); s.bids.set(450, 2000); s.asks.set(500, 400); s.asks.set(530, 800);
    const b = toBook(s, false);
    expect(b.bids.map((l) => l.price)).toEqual([0.48, 0.45]);
    expect(toBook(s, true).bids.map((l) => l.price)).toEqual([0.5, 0.47]);
    const c = costSummary(b, ['Yes', 'No'], 0.05);
    expect(c).toHaveLength(4);
    expect(c[0]).toMatch(/^buy \$50 Yes: avg 50\.0c, slip 0\.0c, needs 51\.\d% to break even/);
    expect(c.join('\n')).toMatch(/buy \$500 No:/);
    expect(costSummary({ bids: [], asks: [] }, ['A', 'B'], 0.05)[0]).toBe('buy $50 A: nothing to buy');
  });
  it('cycles through options and wraps', () => {
    expect(cycle(GROUPS, 5, 1)).toBe(10);
    expect(cycle(GROUPS, 10, 1)).toBe(1);
    expect(cycle(GROUPS, 1, -1)).toBe(10);
  });
});

describe('rendering the order book tab', () => {
  const model = (book: BookView | null) => ({ anomalies: [], games: [], prints: [], leads: [], holders: null, showBots: false, oiSeries: [], filter: null, status: { lastPollAt: 1, nextPollAt: null, busy: false, error: null, events: 0, historySecs: 0, printsWindowMin: null, message: null }, book }) as unknown as Model;
  const live = (): BookView => {
    const s = newLiveState('t', 10);
    for (const [p, z] of [[480, 120_000], [470, 5_000], [460, 800], [450, 40_000]]) s.bids.set(p, z);
    for (const [p, z] of [[500, 30_000], [510, 2_000], [520, 90_000], [560, 600]]) s.asks.set(p, z);
    const now = Date.now() / 1000;
    s.trades.push({ ts: now - 3, side: 'BUY', price: 0.5, size: 2_400, tx: '0x1', wallet: `0x${'a'.repeat(40)}` }, { ts: now - 9, side: 'SELL', price: 0.48, size: 150, tx: '0x2', wallet: null }, { ts: now - 90, side: 'BUY', price: 0.5, size: 800, tx: '0x3', wallet: null });
    s.status = 'live'; s.synced = true; s.frames = 12_345;
    return { ...emptyBook('s', 'c'), question: 'Will X happen?', outcomes: ['Yes', 'No'], tokenIds: ['t'], live: s, ui: defaultUi() };
  };
  it('draws the ladder with sizes either side of the price, best bid/ask, clusters, prints and the trade feed', () => {
    const text = render(model(live()), { tab: 'book', sel: 0, cols: 150, rows: 44 }, Date.now()).map(strip).join('\n');
    expect(text).toMatch(/ORDER BOOK\s+Will X happen\?\s+● LIVE/);
    expect(text).toMatch(/BID 48\.0\s+ASK 50\.0\s+MID 49\.00\s+SPR 2\.0c/);
    expect(text).toMatch(/Yes view · 1T · sh · 1m clusters/);
    expect(text).toMatch(/±5c depth/);
    expect(text).toMatch(/BID\s+PRICE\s+ASK\s+PRINTS/);
    expect(text).toMatch(/120k\s+48\s+/); // bid size left of its price
    expect(text).toMatch(/\s50\s+30\.0k/); // ask size right of its price
    expect(text).toMatch(/TIME\s+SIDE\s+PRICE\s+SIZE\s+WALLET/);
    expect(text).toMatch(/BUY\s+50\.0\s+⬤\$1\.2k\s+0xaaaa…aaaa/); // tape line, newest first
    expect(text).toMatch(/\+ \/ - compress ticks/);
    expect(text).toMatch(/buy \$500 No:/);
  });
  it('shows the polling and connecting states, the empty state and a lookup error', () => {
    const polling = live();
    polling.live!.status = 'polling';
    expect(strip(render(model(polling), { tab: 'book', sel: 0, cols: 130, rows: 30 }, Date.now()).join('\n'))).toMatch(/◐ POLLING \(socket down/);
    const wait = { ...emptyBook('s', 'c'), live: newLiveState('t') };
    expect(strip(render(model(wait), { tab: 'book', sel: 0, cols: 130, rows: 30 }, Date.now()).join('\n'))).toMatch(/waiting for the book…/);
    expect(strip(render(model({ ...emptyBook('s', 'c'), error: 'market not found: s' }), { tab: 'book', sel: 0, cols: 130, rows: 30 }, Date.now()).join('\n'))).toMatch(/market not found: s/);
    expect(strip(render(model(null), { tab: 'book', sel: 0, cols: 120, rows: 20 }, Date.now()).join('\n'))).toMatch(/press 8 on a market/);
  });
  it('flips to the other outcome and changes grouping and units', () => {
    const v = live();
    v.ui = { ...v.ui, flip: true, group: 5, unit: 'USD' };
    const text = render(model(v), { tab: 'book', sel: 0, cols: 150, rows: 44 }, Date.now()).map(strip).join('\n');
    expect(text).toMatch(/No view · 5T · \$ · 1m clusters/);
    expect(text).toMatch(/BID 50\.0\s+ASK 52\.0/); // NO bid = 1 - YES best ask
  });
  it('stays inside its box at every size, with and without the cluster and tape columns', () => {
    for (const [cols, rows] of [[40, 10], [60, 14], [84, 20], [100, 24], [128, 30], [150, 44], [220, 60]])
      for (const flip of [false, true]) {
        const v = live();
        v.ui.flip = flip;
        const lines = render(model(v), { tab: 'book', sel: 0, cols, rows }, Date.now());
        expect(lines, `${cols}x${rows}`).toHaveLength(rows);
        for (const l of lines) expect(vlen(l), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
      }
  });
});
