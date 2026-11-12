import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PolymarketClient, httpFetchJson, type FetchJson } from '../../radar/polymarket';
import { saveWatched } from '../../radar/walletwatch';
import { savePeople } from '../../radar/people';

const mk = (f: FetchJson, sleeps: number[] = [], random = () => 0) =>
  new PolymarketClient(f, { minIntervalMs: 0, now: () => 0, sleep: async (ms) => void sleeps.push(ms), random });
const call = (c: PolymarketClient) => (c as any).get('https://x.test/a?cursor=SECRET');

afterEach(() => vi.unstubAllGlobals());

describe('http resilience', () => {
  it('httpFetchJson passes a timeout signal', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return { ok: true, json: async () => ({}) };
    });
    await httpFetchJson('https://x.test');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
  });

  it('httpFetchJson surfaces Retry-After', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '7' }) }));
    await expect(httpFetchJson('https://x.test')).rejects.toThrow(/HTTP 429.*retry-after: 7/);
  });

  it('does not retry 403', async () => {
    let n = 0;
    const c = mk(async () => { n++; throw new Error('HTTP 403'); });
    const err = await call(c).catch((e: Error) => e);
    expect(n).toBe(1);
    expect(err.message).toMatch(/^request failed after 1 attempts/);
    expect(err.message).not.toContain('SECRET');
    expect(err.message).not.toContain('?');
  });

  it('retries 500 and honours Retry-After capped at 30s', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const c = mk(async () => { n++; throw new Error(n === 1 ? 'HTTP 429 retry-after: 5' : n === 2 ? 'HTTP 429 retry-after: 999' : 'HTTP 500'); }, sleeps);
    await expect(call(c)).rejects.toThrow(/^request failed after 4 attempts/);
    expect(sleeps.slice(0, 2)).toEqual([5000, 30000]);
    expect(sleeps[2]).toBe(1600);
  });

  it('jitter stays within bounds', async () => {
    for (const r of [0, 0.5, 0.999]) {
      const sleeps: number[] = [];
      await call(mk(async () => { throw new Error('HTTP 500'); }, sleeps, () => r)).catch(() => undefined);
      sleeps.forEach((ms, i) => {
        expect(ms).toBeGreaterThanOrEqual(400 * 2 ** i);
        expect(ms).toBeLessThan(400 * 2 ** i + 100);
      });
    }
  });
});

describe('atomic writes', () => {
  it('leave no temp file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'net-'));
    try {
      saveWatched([{ wallet: `0x${'a'.repeat(40)}` }], join(dir, 'wallets.json'));
      savePeople([{ name: 'Ann' }] as any, join(dir, 'people.json'));
      expect(readdirSync(dir).sort()).toEqual(['people.json', 'wallets.json']);
      expect(readFileSync(join(dir, 'people.json'), 'utf8')).toContain('Ann');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
