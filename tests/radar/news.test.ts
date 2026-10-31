import { describe, expect, it } from 'vitest';
import { classify, decodeEntities, parseFeed, parseWpJson } from '../../radar/news';
import { parseFeedBody, pollFeeds } from '../../radar/poll';
import { openStore } from '../../radar/store';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title>
<item><title><![CDATA[ESIC bans NOMERCY &amp; co for match manipulation]]></title><link>https://hltv.test/a</link><pubDate>Thu, 15 Oct 2026 12:53:00 GMT</pubDate><description><![CDATA[<p>Five players banned.</p>]]></description></item>
<item><title>No link item</title></item>
<item><title>Second</title><guid>https://hltv.test/b</guid></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Is this 322?</title><link href="https://reddit.test/r/x/1" /><updated>2026-10-30T10:00:00+00:00</updated><content type="html">&lt;p&gt;look at this&lt;/p&gt;</content></entry></feed>`;

describe('feed parsing', () => {
  it('reads RSS with CDATA and entities, skipping items without a link', () => {
    const items = parseFeed(RSS, 'hltv');
    expect(items.map((i) => i.url)).toEqual(['https://hltv.test/a', 'https://hltv.test/b']);
    expect(items[0]).toMatchObject({ title: 'ESIC bans NOMERCY & co for match manipulation', summary: 'Five players banned.', publishedAt: Date.parse('2026-10-15T12:53:00Z') });
  });
  it('reads Atom entries', () => {
    expect(parseFeed(ATOM, 'reddit')[0]).toMatchObject({ url: 'https://reddit.test/r/x/1', title: 'Is this 322?', summary: 'look at this' });
  });
  it('reads WordPress JSON', () => {
    const items = parseWpJson([{ link: 'https://esic.test/p', title: { rendered: 'LIFETIME BAN &#8220;x&#8221;' }, excerpt: { rendered: '<p>e</p>' }, date_gmt: '2026-10-16T13:34:00' }], 'esic');
    expect(items[0]).toMatchObject({ title: 'LIFETIME BAN “x”', summary: 'e', publishedAt: Date.parse('2026-10-16T13:34:00Z') });
    expect(parseWpJson({ not: 'an array' }, 'esic')).toEqual([]);
  });
  it('decodes numeric and named entities', () => {
    expect(decodeEntities('a &amp; b &#x27;c&#39; &lt;')).toBe("a & b 'c' <");
  });
});

describe('classification', () => {
  const rel = (title: string, kind: 'authority' | 'journalism' | 'community' = 'journalism', summary = '') => classify({ title, summary }, kind);

  it('catches real headlines from this month', () => {
    for (const t of [
      'ESIC bans NOMERCY for match manipulation',
      'United21 bans CTRL for life following match-fixing suspicion',
      'CS2 pro banned for life after match-fixing scandal linked to $4.5 million bet',
      'Alliance обвиняют в 322 в кс 2 — ставка $348 тыс. на United21',
      'Inner Circle Academy forfeit PGL Bucharest qualifier over cheats',
      'nifee handed four-year ban by ESIC for match manipulation and betting-related corruption',
    ])
      expect(rel(t).relevant, t).toBe(true);
  });

  it('ignores ordinary news and numbers that merely contain 322', () => {
    for (const t of ['BLAST Open Porto 2026 Final Peaked at Nearly 850,000 Viewers', 'Match peaked at 322 viewers', 'Team earns $322 prize', 'Player scores 1322 points', 'Roster change: stikle- takes over as head coach'])
      expect(rel(t).relevant, t).toBe(false);
  });

  it('never upgrades an interim measure or an appeal to SANCTIONED', () => {
    expect(rel('ESIC Issues Interim Suspension to Dota 2 Participant', 'authority').tierHint).toBe('INVESTIGATING');
    expect(rel('Public Statement on Interim Suspension of Team Clown Crew', 'authority').tierHint).toBe('INVESTIGATING');
    expect(rel('Tuvshintugs v. Esports Integrity Commission, Award, 25 January 2026', 'authority').tierHint).toBeNull();
    expect(rel('LIFETIME BAN ISSUED TO player FOLLOWING FURTHER INTEGRITY BREACHES', 'authority').tierHint).toBe('SANCTIONED');
  });

  it('only authorities can suggest a tier above RUMOR; journalism gets no tier', () => {
    expect(rel('United21 bans CTRL for life following match-fixing suspicion', 'journalism').tierHint).toBeNull();
    expect(rel('Anyone think this map was 322?', 'community').tierHint).toBe('RUMOR');
  });
});

describe('polling', () => {
  it('stores items once, reports a failing feed without stopping the rest', async () => {
    const store = openStore();
    const feeds = [
      { id: 'hltv', name: 'HLTV', url: 'u1', format: 'rss' as const, kind: 'journalism' as const },
      { id: 'esic', name: 'ESIC', url: 'u2', format: 'wp-json' as const, kind: 'authority' as const },
      { id: 'bad', name: 'Bad', url: 'u3', format: 'rss' as const, kind: 'community' as const },
    ];
    const bodies: Record<string, string> = { u1: RSS, u2: JSON.stringify([{ link: 'https://esic.test/p', title: { rendered: 'ESIC Issues Interim Suspension to X' }, excerpt: { rendered: '' }, date_gmt: '2026-10-16T00:00:00' }]) };
    const fetchText = async (u: string) => {
      if (!bodies[u]) throw new Error('HTTP 429');
      return bodies[u];
    };
    const opts = { feeds, sleep: async () => undefined, now: () => 5 };
    const first = await pollFeeds(fetchText, store, opts);
    expect(first.map((r) => [r.feed, r.added, r.error])).toEqual([['HLTV', 2, undefined], ['ESIC', 1, undefined], ['Bad', 0, 'HTTP 429']]);
    expect(first[0].relevantNew).toBe(1);
    expect((await pollFeeds(fetchText, store, opts)).map((r) => r.added)).toEqual([0, 0, 0]);
    const inbox = store.listNews();
    expect(inbox.map((n) => n.tierHint).sort()).toEqual(['INVESTIGATING', null]);
    expect(store.setNewsStatus(inbox[0].url, 'dismissed')).toBe(true);
    expect(store.listNews()).toHaveLength(1);
    expect(parseFeedBody(feeds[1], bodies.u2)).toHaveLength(1);
    store.close();
  });
});
