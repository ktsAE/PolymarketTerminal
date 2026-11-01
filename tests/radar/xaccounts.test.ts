import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanPostText, extractPickHints, jinaProfileUrl, loadHandles, loadPosts, parseProfileMarkdown, pollAccounts, textSha1 } from '../../radar/xaccounts';

// Synthetic fixture modelled on the shape r.jina.ai returns for an X profile (header, Pinned marker, list items).
const avatar = (n: number): string => `[![Image ${n}: @demo_tipster](https://pbs.twimg.com/profile_images/1/a_normal.jpg)](https://x.com/demo_tipster)`;
const PROFILE = `Title: Demo Tipster (@demo_tipster) on X

URL Source: https://x.com/demo_tipster

Markdown Content:
Demo Tipster

1,234

posts

[![Image 1: Demo Tipster profile banner](https://pbs.twimg.com/profile_banners/1/1/1500x500)](https://x.com/demo_tipster/header_photo)

@demo_tipster

Synthetic bio line. Links: [example.org](https://t.co/abc "https://example.org")

*   Pinned

${avatar(3)} Season record thread, read before tailing 👇 [example.org/record…](https://t.co/xyz "https://example.org/record")   
*   ${avatar(4)} Rivertown Rams to win tonight, 62% on the market looks cheap. ![Image 5](https://pbs.twimg.com/media/X?format=webp&name=large)    
*   ${avatar(6)} [Oct 30](https://x.com/demo_tipster/status/1234567890) Harbor Hawks -3.5 and the over 47.5 at +110   
*   ${avatar(7)} Quiet day, no plays.   
`;

const NOW = Date.parse('2026-11-01T12:00:00Z');
const fast = { sleep: async () => undefined, gapMs: 0 };

describe('parseProfileMarkdown', () => {
  it('skips the header, marks the pinned post, strips images and link noise', () => {
    const posts = parseProfileMarkdown(PROFILE, '@demo_tipster');
    expect(posts.map((p) => p.text)).toEqual([
      'Season record thread, read before tailing 👇 example.org/record…',
      'Rivertown Rams to win tonight, 62% on the market looks cheap.',
      'Harbor Hawks -3.5 and the over 47.5 at +110',
      'Quiet day, no plays.',
    ]);
    expect(posts.map((p) => p.pinned)).toEqual([true, false, false, false]);
    expect(posts.every((p) => p.handle === 'demo_tipster')).toBe(true);
    expect(posts[2].url).toBe('https://x.com/demo_tipster/status/1234567890');
    expect(posts[0].url).toBeUndefined();
    expect(posts.some((p) => /pbs\.twimg|t\.co|Synthetic bio/.test(p.text))).toBe(false);
  });
  it('returns nothing for a login wall or empty page', () => {
    expect(parseProfileMarkdown('Title: X\n\nMarkdown Content:\nSomething went wrong. Log in.', 'a')).toEqual([]);
  });
  it('cleans link markdown with titles', () => {
    expect(cleanPostText('see [site](https://t.co/q "https://site.example") now https://t.co/zz')).toBe('see site now');
  });
  it('builds the jina profile url', () => {
    expect(jinaProfileUrl('@Polymarket')).toBe('https://r.jina.ai/https://x.com/Polymarket');
  });
});

describe('pollAccounts', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'xacc-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends only new posts with firstSeenAt, captures per-handle errors, pauses between handles', async () => {
    const store = join(dir, 'x', 'posts.jsonl');
    const urls: string[] = [];
    const pauses: number[] = [];
    const fetchText = async (url: string): Promise<string> => {
      urls.push(url);
      if (url.endsWith('/broken')) throw new Error('HTTP 429');
      return PROFILE;
    };
    const opts = { gapMs: 5, sleep: async (ms: number) => void pauses.push(ms) };
    const r1 = await pollAccounts(fetchText, ['demo_tipster', { handle: 'broken' }], store, () => NOW, opts);
    expect(r1).toEqual([
      { handle: 'demo_tipster', parsed: 4, added: 4 },
      { handle: 'broken', parsed: 0, added: 0, error: 'HTTP 429' },
    ]);
    expect(pauses).toEqual([5]);
    expect(urls[0]).toBe('https://r.jina.ai/https://x.com/demo_tipster');

    const lines = await loadPosts(store);
    expect(lines).toHaveLength(4);
    expect(lines[1]).toEqual({
      handle: 'demo_tipster',
      text: 'Rivertown Rams to win tonight, 62% on the market looks cheap.',
      pinned: false,
      textSha1: textSha1('Rivertown Rams to win tonight, 62% on the market looks cheap.'),
      firstSeenAt: NOW,
    });

    // second poll: one new post at the top, the rest already logged keep their original firstSeenAt
    const later = NOW + 3_600_000;
    const updated = PROFILE.replace('*   Pinned', `*   ${avatar(9)} Fresh synthetic post.\n*   Pinned`);
    const r2 = await pollAccounts(async () => updated, ['@demo_tipster'], store, () => later, fast);
    expect(r2).toEqual([{ handle: 'demo_tipster', parsed: 5, added: 1 }]);
    const all = await loadPosts(store);
    expect(all).toHaveLength(5);
    expect(all[4]).toMatchObject({ text: 'Fresh synthetic post.', firstSeenAt: later });
    expect(all.filter((p) => p.firstSeenAt === NOW)).toHaveLength(4);
    expect((await readFile(store, 'utf8')).trim().split('\n')).toHaveLength(5);
  });
});

describe('loadHandles', () => {
  it('reads [{handle, note}], strips @, dedupes, tolerates a missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'xacc-'));
    const p = join(dir, 'x_accounts.json');
    await writeFile(p, JSON.stringify([{ handle: '@Alpha', note: 'nba' }, { handle: 'alpha' }, 'beta', { nope: 1 }]));
    expect(await loadHandles(p)).toEqual([{ handle: 'Alpha', note: 'nba' }, { handle: 'beta' }]);
    expect(await loadHandles(join(dir, 'missing.json'))).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe('extractPickHints', () => {
  const teams = ['Rivertown Rams', 'Harbor Hawks'];
  it('flags to-win, odds percent and team names', () => {
    const h = extractPickHints('Rivertown Rams to win tonight, 62% on the market looks cheap.', teams);
    expect(h).toContainEqual(expect.objectContaining({ kind: 'to-win', team: 'Rivertown Rams' }));
    expect(h).toContainEqual({ kind: 'odds-pct', match: '62%', value: 62 });
    expect(h).toContainEqual({ kind: 'team', match: 'Rivertown Rams', team: 'Rivertown Rams' });
  });
  it('flags spreads, totals, american odds and moneyline', () => {
    const h = extractPickHints('Harbor Hawks -3.5 and the over 47.5 at +110. Rams ML too', teams);
    expect(h).toContainEqual(expect.objectContaining({ kind: 'spread', team: 'Harbor Hawks', value: -3.5 }));
    expect(h).toContainEqual(expect.objectContaining({ kind: 'over-under', value: 47.5 }));
    expect(h).toContainEqual({ kind: 'american-odds', match: '+110', value: 110 });
    expect(h.some((x) => x.kind === 'moneyline')).toBe(true);
  });
  it('returns nothing for a plain post', () => {
    expect(extractPickHints('Quiet day, no plays.', teams)).toEqual([]);
  });
});
