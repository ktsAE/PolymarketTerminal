import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SEED_CASES } from '../../radar/cases.seed';
import { decodeEntities, parseFeed } from '../../radar/news';
import { liftText, newbiesLines, type NewWalletsResult } from '../../radar/newwallets';
import { httpFetchText } from '../../radar/poll';
import { PolymarketClient } from '../../radar/polymarket';
import { parseWalletInput, resolveWalletInput } from '../../radar/walletinput';
import { addWatched, loadWatched, notifyText } from '../../radar/walletwatch';

afterEach(() => vi.unstubAllGlobals());
const ESC = String.fromCharCode(27);
const CTRL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e]/;

describe('decodeEntities', () => {
  it('never yields ESC or control characters, and does not throw on huge code points', () => {
    for (const s of ['&#27;', '&#x1b;', '&#0;', '&#127;', '&#x9b;', '&#8238;', '&#x202e;', '&#xd800;']) expect(CTRL.test(decodeEntities(`a${s}b`)), s).toBe(false);
    expect(() => decodeEntities('&#99999999;')).not.toThrow();
    expect(() => decodeEntities('&#x110000;')).not.toThrow();
    expect(() => decodeEntities('&#99999999999999999999;')).not.toThrow();
    expect(decodeEntities('&#65;&#x42; &amp; &#8212;')).toBe('AB & —');
  });
  it('one poisoned item does not break the feed or inject ESC', () => {
    const xml = `<rss><channel><item><title>Hello &#27;[2J &#99999999; world</title><link>https://a.test/1</link></item><item><title>Fine</title><link>https://a.test/2</link></item></channel></rss>`;
    const items = parseFeed(xml, 'f');
    expect(items.map((i) => i.url)).toEqual(['https://a.test/1', 'https://a.test/2']);
    expect(items[0].title).not.toContain(ESC);
  });
});

describe('client rate limiter', () => {
  const mk = (starts: number[], t: { v: number }, f?: (n: number) => Error | null) => {
    let n = 0;
    return new PolymarketClient(
      async () => {
        starts.push(t.v);
        const e = f?.(++n);
        if (e) throw e;
        return {};
      },
      { minIntervalMs: 100, retries: 3, now: () => t.v, sleep: async (ms) => void (t.v += ms), random: () => 0 },
    );
  };
  it('spaces concurrent calls by the minimum interval (real clock; Date is frozen in unit tests)', async () => {
    const starts: number[] = [];
    const c = new PolymarketClient(async () => (starts.push(performance.now()), {}), { minIntervalMs: 30, now: () => performance.now() });
    await Promise.all(Array.from({ length: 10 }, (_, i) => (c as any).get(`https://x.test/${i}`)));
    expect(starts).toHaveLength(10);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(25);
  });
  it('a 429 holds back every worker, not only the one that was refused', async () => {
    const starts: number[] = [];
    const t = { v: 1000 };
    const c = mk(starts, t, (n) => (n === 1 ? new Error('HTTP 429 retry-after: 5') : null));
    await Promise.all(Array.from({ length: 4 }, (_, i) => (c as any).get(`https://x.test/${i}`)));
    // first call is refused at t=1000; no request may start before t=6000 afterwards
    const after = starts.slice(1);
    expect(after.length).toBe(4);
    for (const s of after) expect(s).toBeGreaterThanOrEqual(6000);
  });
});

describe('notifications', () => {
  it('strips control characters and markup', () => {
    const s = notifyText(`-bad <a href="x">hi</a> &${ESC}]0;t\u0007 ok`);
    expect(s).not.toMatch(/[<>\u0000-\u0008\u001b]/);
    expect(s).toContain('&lt;a href');
  });
});

describe('follow list', () => {
  it('moves a corrupt file aside instead of overwriting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hard-'));
    try {
      const p = join(dir, 'wallets.json');
      writeFileSync(p, '{not json');
      const w = `0x${'a'.repeat(40)}`;
      addWatched(w, undefined, p);
      const files = readdirSync(dir);
      const aside = files.find((f) => f.includes('.corrupt-'));
      expect(aside).toBeDefined();
      expect(readFileSync(join(dir, aside!), 'utf8')).toBe('{not json');
      expect(loadWatched(p).map((x) => x.wallet)).toEqual([w]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('wallet input', () => {
  const A = `0x${'a'.repeat(40)}`;
  const B = `0x${'b'.repeat(40)}`;
  it('takes an address only as the whole input or a profile link', () => {
    expect(parseWalletInput(A)).toEqual({ wallet: A });
    expect(parseWalletInput(`https://polymarket.com/profile/${A}`)).toEqual({ wallet: A });
    expect(parseWalletInput(`look at ${A} please`)).toBeNull();
    expect(parseWalletInput(`https://polymarket.com/event/foo?ref=${A}`)).toBeNull();
  });
  it('refuses a handle that matches several profiles', async () => {
    const client = { searchProfiles: async () => [{ wallet: A, name: 'Bob', pseudonym: null }, { wallet: B, name: 'bob', pseudonym: null }] } as unknown as PolymarketClient;
    await expect(resolveWalletInput(client, '@bob')).rejects.toThrow(/matches 2 profiles/);
  });
});

describe('feed fetch', () => {
  it('has a timeout and a size cap', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return { ok: true, headers: new Headers({ 'content-length': '5000000' }), text: async () => 'x' };
    });
    await expect(httpFetchText('https://x.test')).rejects.toThrow(/too large/);
    expect(signal).toBeInstanceOf(AbortSignal);
    vi.stubGlobal('fetch', async () => ({ ok: true, headers: new Headers(), text: async () => 'y'.repeat(3_000_000) }));
    expect((await httpFetchText('https://x.test')).length).toBe(2_000_000);
  });
});

describe('newbies command output', () => {
  const row = (over: object) => ({ cid: 'c', eventSlug: 'ev', question: 'Q?', newUsd: 100, newWallets: 3, wallets: 10, newShare: 0.5, lift: 14, lean: null, ...over });
  const r = (rows: object[]) => ({ rows, windowMins: 30, maxAgeDays: 14, coverage: 0.9, trades: 1, markets: 1, wallets: 1, platformNewShare: 0.04, newWalletsTotal: 3 }) as unknown as NewWalletsResult;
  it('prints the caveat first, marks small-sample LIFT with * (width 6) and notes it', () => {
    const lines = newbiesLines(r([row({}), row({ newUsd: 9000, newWallets: 9, lift: 3 })]), 25);
    expect(lines[0]).toMatch(/not evidence of wrongdoing/);
    expect(lines.some((l) => /small sample/.test(l))).toBe(true);
    expect(lines.some((l) => /x14\.0\*/.test(l))).toBe(true);
    expect(liftText(row({}) as any)).toBe('x14.0*');
    expect(lines.find((l) => /x3\.0 /.test(l))).toBeDefined();
  });
  it('omits the small-sample note when no shown row is small', () => {
    const lines = newbiesLines(r([row({ newUsd: 9000, newWallets: 9 })]), 25);
    expect(lines.some((l) => /small sample/.test(l))).toBe(false);
    expect(lines[0]).toMatch(/not evidence of wrongdoing/);
  });
  it('is what the CLI prints', () => {
    expect(readFileSync(join(__dirname, '../../radar/cli.ts'), 'utf8')).toContain('newbiesLines(result,');
  });
});

describe('seed cases', () => {
  it('name no individual in an allegation', () => {
    const text = JSON.stringify(SEED_CASES.flatMap((c) => c.events.map((e) => [e.summary, e.tier])).concat(SEED_CASES.map((c) => [c.row.notes ?? '', ''])));
    for (const name of ['Feran', 'zvezd', 'Ahilles']) expect(text).not.toContain(name);
  });
});
