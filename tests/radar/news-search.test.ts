import { describe, expect, it } from 'vitest';
import { loadNews } from '../../radar/newsview';
import { buildNewsQuery, bingUrl, googleUrl, parseBing, parseGoogle, searchNews } from '../../radar/newssearch';
import { PolymarketClient, type FetchJson } from '../../radar/polymarket';
import { strip, vlen } from '../../radar/tui/ansi';
import { moveSelection, render, type Model, type View } from '../../radar/tui/render';

const NOW = Date.parse('2026-10-31T20:00:00Z');
const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };

const rss = (items: Array<{ title: string; link: string; date: string }>): string =>
  `<?xml version="1.0"?><rss><channel><title>t</title>${items.map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.date}</pubDate></item>`).join('')}</channel></rss>`;

const GOOGLE = rss([
  { title: 'US troops join raid in Ecuador - Reuters', link: 'https://news.google.com/rss/articles/AAA', date: 'Sat, 31 Oct 2026 10:00:00 GMT' },
  { title: 'Older story - AP News', link: 'https://news.google.com/rss/articles/BBB', date: 'Mon, 12 Oct 2026 10:00:00 GMT' },
  { title: 'Cartel boss arrested &amp; extradited - El Pais English', link: 'https://news.google.com/rss/articles/CCC', date: 'Fri, 30 Oct 2026 08:00:00 GMT' },
]);
const BING = rss([
  { title: 'US troops join raid in Ecuador', link: 'http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&url=https%3a%2f%2fwww.nytimes.com%2f2026%2f10%2f31%2fraid.html&c=1', date: 'Sat, 31 Oct 2026 11:00:00 GMT' },
  { title: 'Fresh item only on Bing', link: 'http://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fexample.org%2fa&c=2', date: 'Sat, 31 Oct 2026 18:00:00 GMT' },
]);

describe('news query', () => {
  it('turns market titles into search text', () => {
    expect(buildNewsQuery('Will 1win launch a token by ___?')).toBe('1win launch a token');
    expect(buildNewsQuery('U.S. anti-cartel operation on foreign soil by...?')).toBe('U.S. anti-cartel operation on foreign soil');
    expect(buildNewsQuery('U.S. anti-cartel operation on foreign soil by October 31?')).toBe('U.S. anti-cartel operation on foreign soil');
    expect(buildNewsQuery('Counter-Strike: FURIA vs FUT Esports (BO3) - Esports World Cup Playoffs')).toBe('Counter-Strike: FURIA vs FUT Esports - Esports World Cup Playoffs');
    expect(buildNewsQuery('Who will Trump nominate as Fed Chair?')).toBe('will Trump nominate as Fed Chair');
  });
  it('builds source URLs', () => {
    expect(googleUrl('a b', 7)).toContain('q=a%20b%20when%3A7d');
    expect(bingUrl('a b')).toContain('q=a%20b&format=rss');
  });
});

describe('parsing', () => {
  it('splits the publisher off Google titles and decodes entities', () => {
    const [a, , c] = parseGoogle(GOOGLE);
    expect(a).toMatchObject({ title: 'US troops join raid in Ecuador', source: 'Reuters', via: 'google' });
    expect(c.title).toBe('Cartel boss arrested & extradited');
    expect(c.source).toBe('El Pais English');
  });
  it('unwraps Bing redirect links and uses the host as the source', () => {
    const [a] = parseBing(BING);
    expect(a.url).toBe('https://www.nytimes.com/2026/10/31/raid.html');
    expect(a.source).toBe('nytimes.com');
  });
});

describe('searching', () => {
  const fetchText = async (url: string) => (url.includes('news.google.com') ? GOOGLE : BING);
  it('merges both sources, drops duplicates and old items, newest first', async () => {
    const r = await searchNews(fetchText, 'cartel', { now: () => NOW });
    expect(r.errors).toEqual([]);
    expect(r.hits.map((h) => h.title)).toEqual(['Fresh item only on Bing', 'US troops join raid in Ecuador', 'Cartel boss arrested & extradited']);
    expect(r.hits[1].via).toBe('google'); // the Google copy came first, the Bing duplicate was dropped
  });
  it('reports a failing source and still returns the other', async () => {
    const r = await searchNews(async (u) => { if (u.includes('bing.com')) throw new Error('HTTP 503'); return GOOGLE; }, 'cartel', { now: () => NOW });
    expect(r.errors).toEqual(['bing: HTTP 503']);
    expect(r.hits.length).toBe(2);
  });
  it('keeps undated items and respects the limit', async () => {
    const undated = rss([{ title: 'No date here - Blog', link: 'https://x.test/1', date: '' }]);
    const r = await searchNews(async () => undated, 'x', { now: () => NOW, limit: 1 });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0].publishedAt).toBeNull();
  });
});

function api(): FetchJson {
  return async (url) => {
    if (url.includes('/events?slug=')) {
      return [{ slug: 'ev', title: 'Will 1win launch a token by ___?', description: 'Rules  text\nhere', markets: [
        { conditionId: '0xa', groupItemTitle: 'October 31, 2026', bestBid: 0.6, bestAsk: 0.61, umaResolutionStatuses: '["proposed","disputed"]', endDate: '2026-11-01T03:59:00Z', volume24hr: 900, closed: false },
        { conditionId: '0xb', groupItemTitle: 'November 30, 2026', bestBid: 0.9, bestAsk: 0.95, umaResolutionStatuses: '[]', endDate: '2026-12-01T04:59:00Z', volume24hr: 10, closed: false },
      ] }];
    }
    throw new Error(`unexpected ${url}`);
  };
}
const text = async (url: string) => (url.includes('news.google.com') ? GOOGLE : BING);

describe('loading the news view', () => {
  it('combines the market state with headlines', async () => {
    const stages: string[] = [];
    const v = await loadNews(new PolymarketClient(api(), fast), text, 'ev', { now: () => NOW, onProgress: (x) => stages.push(x.stage) });
    expect(v).toMatchObject({ done: true, error: null, query: '1win launch a token', title: 'Will 1win launch a token by ___?' });
    expect(v.hits.length).toBe(3);
    expect(v.markets[0]).toMatchObject({ label: 'October 31, 2026', bid: 0.6, ask: 0.61, uma: ['proposed', 'disputed'] });
    expect(v.markets[0].endsAt).toBe(Date.parse('2026-11-01T03:59:00Z') / 1000);
    expect(v.rules).toBe('Rules text here');
    expect(stages[0]).toBe('reading the market');
    expect(stages.some((s) => s.startsWith('searching news'))).toBe(true);
    expect(stages[stages.length - 1]).toBe('done');
  });
  it('says so when both sources fail instead of looking like a quiet day', async () => {
    const v = await loadNews(new PolymarketClient(api(), fast), async () => { throw new Error('offline'); }, 'ev', { now: () => NOW });
    expect(v.hits).toEqual([]);
    expect(v.error).toMatch(/both news sources failed/);
  });
  it('reports a missing event', async () => {
    const v = await loadNews(new PolymarketClient(async () => [], fast), text, 'nope', { now: () => NOW });
    expect(v.error).toMatch(/event not found/);
    expect(v.done).toBe(true);
  });
});

describe('news tab', () => {
  const empty: Model = {
    anomalies: [], games: [], prints: [], leads: [], holders: null, showBots: false, oiSeries: [], filter: null,
    status: { lastPollAt: NOW, nextPollAt: null, busy: false, error: null, events: 0, historySecs: 0, printsWindowMin: null, message: null },
  };
  const v = (over: Partial<View> = {}): View => ({ tab: 'news', sel: 0, cols: 120, rows: 36, ...over });
  it('explains how to open it', () => {
    expect(strip(render(empty, v(), Date.now()).join('\n'))).toMatch(/press n to search news/);
  });
  it('shows market state, the query, headlines with age and source, and the selected headline link', async () => {
    const nv = await loadNews(new PolymarketClient(api(), fast), text, 'ev', { now: () => Date.now() });
    const fresh = { ...nv, hits: nv.hits.map((h, i) => ({ ...h, publishedAt: Date.now() - (i + 1) * 3_600_000 })) };
    const out = strip(render({ ...empty, news: fresh }, v(), Date.now()).join('\n'));
    expect(out).toMatch(/October 31, 2026\s+0\.60\/0\.61/);
    expect(out).toMatch(/oracle: proposed>disputed/);
    expect(out).toMatch(/searched: 1win launch a token/);
    expect(out).toMatch(/AGO\s+SOURCE\s+HEADLINE/);
    expect(out).toMatch(/Reuters|nytimes\.com|El Pais/);
    expect(out).toMatch(/1h|2h|3h/);
    expect(out).toMatch(/https?:\/\//); // detail panel shows the link
    expect(out).toMatch(/1-9 tabs/);
  });
  it('switches with key 8 and moves within headlines', () => {
    const m: Model = { ...empty, news: { slug: 's', title: 't', query: 'q', stage: 'done', done: true, error: null, sourceErrors: [], markets: [], rules: '', hits: [1, 2, 3].map((i) => ({ title: `H${i}`, source: 's', url: `https://x/${i}`, publishedAt: null, via: 'google' as const })) } };
    expect(moveSelection(v({ tab: 'anomalies' }), '8', m).tab).toBe('news');
    expect(moveSelection(v({ sel: 0 }), 'end', m).sel).toBe(2);
  });
  it('never overflows its box at any size', () => {
    const hits = Array.from({ length: 30 }, (_, i) => ({ title: `日本語の見出し ${i} with a very long headline that must be clipped cleanly at every width`, source: 'Some Publisher Name Inc', url: 'https://example.org/' + 'x'.repeat(200), publishedAt: Date.now() - i * 3_600_000, via: 'bing' as const }));
    const m: Model = { ...empty, news: { slug: 's', title: 'A long market title '.repeat(6), query: 'q', stage: 'done', done: true, error: 'google: HTTP 503', sourceErrors: ['google: HTTP 503'], hits, rules: 'r '.repeat(300), markets: [{ label: 'October 31, 2026', bid: 0.5, ask: 0.55, uma: ['proposed', 'disputed', 'proposed', 'disputed'], endsAt: Date.now() / 1000 + 3600, closed: false }] } };
    for (const [cols, rows] of [[50, 12], [60, 16], [80, 24], [140, 40], [220, 60]]) {
      const lines = render(m, v({ cols, rows, sel: 4 }), Date.now());
      expect(lines, `${cols}x${rows}`).toHaveLength(rows);
      for (const l of lines) expect(vlen(l), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
    }
  });
});
