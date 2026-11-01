import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJsonl } from '../../radar/forward';
import { EDGE, NO_EDGE } from '../../radar/ledger';
import { PolymarketClient, type FetchJson } from '../../radar/polymarket';
import type { SurgeFlag, SurgeMetrics } from '../../radar/surge';
import { DEDUPE_SECS, betOf, followUp, formatSurgeLog, logAlerts, scoreSurgeLog, SURGE_RULES, type AlertInput, type AlertLine } from '../../radar/surgelog';

const H = 3600;
const NOW = Date.UTC(2026, 10, 1, 12, 0, 0); // ms
const NOW_S = NOW / 1000;
const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0 };
const dir = () => mkdtempSync(join(tmpdir(), 'surgelog-'));
const read = (p: string) => parseJsonl<Record<string, unknown>>(readFileSync(p, 'utf8'));

const metrics: SurgeMetrics = {
  ageDays: 2, young: true, usd1h: 5000, fills1h: 40, wallets1h: 6, medianHourUsd: 100, baselineHours: 48, volRatio: 50, buyUsd1h: 4800,
  oneSidedShare: 0.9, dirIdx: 0, top3Share: 0.7, freshShare: 0.6, priceNow: 0.4, price1hAgo: 0.3, priceJump: 0.1, dirJump: 0.1, historyComplete: true,
};

const row = (cid: string, flags: SurgeFlag[] = ['volume_surge'], extra: Partial<AlertInput> = {}): AlertInput => ({
  cid, slug: `m-${cid}`, eventSlug: `e-${cid}`, title: `market ${cid}`, outcomes: ['Yes', 'No'], tokenIds: [`${cid}y`, `${cid}n`], source: 'new',
  score: 3, flags, metrics, dirIdx: 0, dirOutcome: 'Yes', bestAsk: 0.42, askUsd: 100, bestBid: 0.4, ...extra,
});

describe('logAlerts', () => {
  it('logs each market once per 6 hours and only volume_surge rows', () => {
    const p = join(dir(), 'alerts.jsonl');
    const r1 = logAlerts([row('a'), row('b', ['young_market']), row('a')], p, NOW);
    expect(r1).toMatchObject({ written: 1, skipped: 2 });
    expect(r1.lines[0]).toMatchObject({ v: 1, id: `a|${NOW_S}`, cid: 'a', dirIdx: 0, ask: 0.42, bid: 0.4, createdAt: NOW_S - 2 * 86400, firstSeenAt: NOW_S, flags: ['volume_surge'] });
    expect(logAlerts([row('a')], p, NOW + (DEDUPE_SECS - 1) * 1000).written).toBe(0);
    expect(logAlerts([row('a')], p, NOW + DEDUPE_SECS * 1000).written).toBe(1);
    expect(read(p).map((l) => l.firstSeenAt)).toEqual([NOW_S, NOW_S + DEDUPE_SECS]);
  });
  it('tolerates malformed lines in an existing log and stores null for missing prices', () => {
    const p = join(dir(), 'alerts.jsonl');
    writeFileSync(p, `garbage{\n{"cid":"a","firstSeenAt":${NOW_S - H}}\n[1]\n{"cid":`);
    const r = logAlerts([row('a'), row('c', ['volume_surge'], { bestAsk: null, bestBid: undefined })], p, NOW);
    expect(r.lines.map((l) => l.cid)).toEqual(['c']);
    expect(r.lines[0]).toMatchObject({ ask: null, bid: null });
  });
});

function fakeClient(books: Record<string, { bid?: number; ask?: number }>, events: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchJson: FetchJson = async (url) => {
    calls.push(url);
    const tok = /token_id=(\w+)/.exec(url)?.[1];
    if (tok) {
      const b = books[tok] ?? {};
      return { bids: b.bid === undefined ? [] : [{ price: String(b.bid), size: '10' }], asks: b.ask === undefined ? [] : [{ price: String(b.ask), size: '10' }] };
    }
    const slug = /slug=([\w-]+)/.exec(url)?.[1];
    if (slug) return events[slug] ? [events[slug]] : [];
    throw new Error(`unexpected ${url}`);
  };
  return { client: new PolymarketClient(fetchJson, fast), calls };
}

describe('followUp', () => {
  it('samples each offset only after it passed and only once, and settles once', async () => {
    const d = dir();
    const p = join(d, 'alerts.jsonl');
    logAlerts([row('a'), row('b')], p, NOW);
    writeFileSync(p, readFileSync(p, 'utf8') + 'not json\n');
    const open = { slug: 'e-a', title: 'A', markets: [{ conditionId: 'a', closed: false, outcomePrices: '["0.5","0.5"]', outcomes: '["Yes","No"]' }] };
    const shut = { slug: 'e-a', title: 'A', markets: [{ conditionId: 'a', closed: true, outcomePrices: '["1","0"]', outcomes: '["Yes","No"]' }] };
    const books = { ay: { bid: 0.5, ask: 0.52 }, by: { bid: 0.3 } };
    const paths = () => read(join(d, 'paths.jsonl'));

    let { client } = fakeClient(books, { 'e-a': open });
    const r0 = await followUp(client, p, NOW + 299 * 1000);
    expect(r0).toMatchObject({ alerts: 2, paths: [], results: [], errors: [] });

    const r1 = await followUp(client, p, NOW + 300 * 1000);
    expect(r1.paths.map((x) => `${x.cid} ${x.label}`)).toEqual(['a +5m', 'b +5m']);
    expect(r1.paths[0]).toMatchObject({ alertId: `a|${NOW_S}`, dirIdx: 0, dueAt: NOW_S + 300, capturedAt: NOW_S + 300, lagSecs: 0, bid: 0.5, ask: 0.52, mid: 0.51 });
    expect(r1.paths[1]).toMatchObject({ bid: 0.3, ask: null, mid: null });
    expect((await followUp(client, p, NOW + 600 * 1000)).paths).toEqual([]);

    const r2 = await followUp(client, p, NOW + 2 * H * 1000);
    expect(r2.paths.map((x) => `${x.cid} ${x.label} ${x.lagSecs}`)).toEqual(['a +1h 3600', 'b +1h 3600']);

    ({ client } = fakeClient(books, { 'e-a': shut }));
    const r3 = await followUp(client, p, NOW + 25 * H * 1000);
    expect(r3.paths.map((x) => `${x.cid} ${x.label}`)).toEqual(['a +24h', 'b +24h']);
    expect(r3.results).toEqual([{ cid: 'a', winnerIdx: 0, payout: [1, 0], settledAt: NOW_S + 25 * H }]);

    const { client: c4, calls } = fakeClient(books, { 'e-a': shut });
    const r4 = await followUp(c4, p, NOW + 30 * H * 1000);
    expect(r4).toMatchObject({ paths: [], results: [] });
    expect(calls.some((u) => u.includes('slug=e-a'))).toBe(false);
    expect(paths()).toHaveLength(6);
    expect(read(join(d, 'results.jsonl'))).toHaveLength(1);
  });
  it('reports a failed book read and retries it next run', async () => {
    const d = dir();
    const p = join(d, 'alerts.jsonl');
    logAlerts([row('a')], p, NOW);
    const bad = new PolymarketClient(async () => { throw new Error('HTTP 500'); }, { ...fast, retries: 0 });
    const r = await followUp(bad, p, NOW + 400 * 1000);
    expect(r.paths).toEqual([]);
    expect(r.errors.length).toBe(2);
    const { client } = fakeClient({ ay: { bid: 0.5, ask: 0.6 } }, {});
    expect((await followUp(client, p, NOW + 500 * 1000)).paths.map((x) => x.label)).toEqual(['+5m']);
  });
});

const alert = (i: number, extra: Partial<AlertLine> = {}): AlertLine => ({
  v: 1, id: `c${i}|${NOW_S + i}`, cid: `c${i}`, slug: `m${i}`, eventSlug: `e${i}`, title: `t${i}`, outcomes: ['Yes', 'No'], tokenIds: ['y', 'n'],
  flags: ['volume_surge'], metrics, dirIdx: 0, ask: 0.5, bid: 0.48, createdAt: null, firstSeenAt: NOW_S + (i % 40) * 86400 + i, ...extra,
});

describe('scoreSurgeLog', () => {
  it('fixes six rules: three follow rules and a fade control for each', () => {
    expect(SURGE_RULES.map((r) => r.id)).toEqual(['follow-all', 'follow-young', 'follow-concentrated-fresh', 'fade-all', 'fade-young', 'fade-concentrated-fresh']);
    const [fAll, fYoung, fCf, xAll] = SURGE_RULES;
    const a = alert(1, { flags: ['volume_surge', 'concentrated', 'fresh_wallets'] });
    expect(betOf(fAll, a)).toEqual({ outcomeIdx: 0, price: 0.5 });
    expect(betOf(fYoung, a)).toBeNull();
    expect(betOf(fCf, a)).toEqual({ outcomeIdx: 0, price: 0.5 });
    expect(betOf(xAll, a)).toEqual({ outcomeIdx: 1, price: 0.52 });
    expect(betOf(xAll, alert(2, { outcomes: ['A', 'B', 'C'] }))).toBeNull();
    expect(betOf(fAll, alert(3, { dirIdx: null }))).toBeNull();
    expect(betOf(fAll, alert(4, { ask: null }))).toBeNull();
  });

  it('gates the verdict at 299 vs 300 bets', () => {
    // every follow bet at 0.5 wins: ROI +1 with a degenerate CI above 0
    const mk = (n: number) => Array.from({ length: n }, (_, i) => alert(i));
    const res = (n: number) => Array.from({ length: n }, (_, i) => ({ cid: `c${i}`, winnerIdx: 0, payout: [1, 0] }));
    const r299 = scoreSurgeLog(mk(299), res(299), { iterations: 200 });
    const r300 = scoreSurgeLog(mk(300), res(300), { iterations: 200 });
    const fa = (r: ReturnType<typeof scoreSurgeLog>) => r.rules.find((s) => s.id === 'follow-all')!;
    expect(fa(r299)).toMatchObject({ n: 299, verdict: NO_EDGE });
    expect(fa(r300)).toMatchObject({ n: 300, hitRate: 1, breakEven: 0.5, roi: 1, verdict: EDGE });
    expect(fa(r300).ci![0]).toBeGreaterThan(0);
    expect(r300.rules.find((s) => s.id === 'fade-all')).toMatchObject({ n: 300, wins: 0, verdict: NO_EDGE });
  });

  it('splits a void payout, skips malformed and duplicate alerts, ignores unsettled ones', () => {
    const alerts = [alert(1), alert(2), alert(3), alert(1), { cid: 'x' }, null, 'junk', alert(4, { dirIdx: 5 })];
    const results = [{ cid: 'c1', winnerIdx: null, payout: [0.5, 0.5] }, { cid: 'c2', winnerIdx: null }, { cid: 'c1', winnerIdx: 0, payout: [1, 0] }, 'bad'];
    const r = scoreSurgeLog(alerts, results, { iterations: 100 });
    expect(r).toMatchObject({ alerts: 3, settled: 2, skippedAlerts: 5 });
    const fa = r.rules.find((s) => s.id === 'follow-all')!;
    expect(fa).toMatchObject({ n: 2, wins: 0, voids: 2, hitRate: 0, roi: 0 });
    expect(fa.bets.map((b) => b.payout)).toEqual([0.5, 0.5]);
  });

  it('gives a deterministic CI for a fixed seed', () => {
    const alerts = Array.from({ length: 120 }, (_, i) => alert(i));
    const results = alerts.map((a, i) => ({ cid: a.cid, winnerIdx: i % 7 < 3 ? 0 : 1, payout: i % 7 < 3 ? [1, 0] : [0, 1] }));
    const a = scoreSurgeLog(alerts, results, { iterations: 500, seed: 7 });
    const b = scoreSurgeLog(alerts, results, { iterations: 500, seed: 7 });
    const c = scoreSurgeLog(alerts, results, { iterations: 500, seed: 8 });
    expect(a.rules.map((s) => s.ci)).toEqual(b.rules.map((s) => s.ci));
    expect(a.rules[0].ci).not.toEqual(c.rules[0].ci);
    expect(a.rules[0].ci![0]).toBeLessThan(a.rules[0].roi!);
  });

  it('formats one line per rule with break-even beside hit rate, and the caveat', () => {
    const lines = formatSurgeLog(scoreSurgeLog([alert(1)], [{ cid: 'c1', winnerIdx: 0, payout: [1, 0] }], { iterations: 50 }));
    expect(lines[0]).toBe('Surge alert log: 1/1 alerts settled, 0 alert lines skipped');
    expect(lines.find((l) => l.startsWith('follow-all'))).toMatch(/n=1 .*hit 100\.0% vs break-even 50\.0%.*NO EDGE PROVEN/);
    expect(lines.find((l) => l.startsWith('follow-young'))).toMatch(/n=0  no settled bets yet  NO EDGE PROVEN/);
    expect(lines.at(-1)).toMatch(/not a recommendation/);
  });
});
