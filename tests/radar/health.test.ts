import { describe, expect, it } from 'vitest';
import { coreHealthy, formatHealth, PROBES, runHealth, runProbe } from '../../radar/health';

const reply = (status: number, body: unknown) => async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const gamma = PROBES[0];
const trades = PROBES.find((p) => p.id === 'data v2 trades')!;

describe('preflight health check', () => {
  it('passes a service that answers in the expected shape', async () => {
    expect((await runProbe(gamma, reply(200, [{ slug: 'x' }]))).ok).toBe(true);
    expect((await runProbe(trades, reply(200, { data: [] }))).ok).toBe(true);
  });
  it('tells a retired endpoint, a moved route, a shape change, rate limiting and server errors apart', async () => {
    expect((await runProbe(trades, reply(410, 'gone'))).problem).toMatch(/retired, the code needs migrating/);
    expect((await runProbe(trades, reply(404, ''))).problem).toMatch(/route moved/);
    expect((await runProbe(trades, reply(200, { rows: [] }))).problem).toMatch(/shape changed/);
    expect((await runProbe(trades, reply(200, '<html>'))).problem).toMatch(/not JSON/);
    expect((await runProbe(trades, reply(429, ''))).problem).toMatch(/rate limited/);
    expect((await runProbe(trades, reply(503, ''))).problem).toMatch(/server is failing/);
  });
  it('explains a reset connection and a timeout, never throwing', async () => {
    const reset = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); };
    expect((await runProbe(gamma, reset)).problem).toMatch(/connection reset \(host down, or blocked from this network\)/);
    const slow = async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); };
    expect((await runProbe(gamma, slow, 5000)).problem).toBe('no answer within 5s');
  });
  it('summarizes, and only a core service being down blocks launching', async () => {
    const f = async (url: string) => (url.includes('gamma') ? { status: 500, text: async () => '' } : url.includes('/v2/holders') ? { status: 410, text: async () => '' } : { status: 200, text: async () => (url.includes('clob') ? '1793916022' : url.includes('user-pnl') ? '{"data":{"points":[]}}' : url.includes('/v2/') ? '{"data":[]}' : '[]') });
    const res = await runHealth(f);
    expect(res.filter((r) => !r.ok).map((r) => r.probe.id).sort()).toEqual(['data v2 holders', 'gamma events']);
    expect(coreHealthy(res)).toBe(false);
    expect(formatHealth(res).at(-1)).toMatch(/2 of 7 not working \(a core service/);
    expect(coreHealthy(res.filter((r) => r.probe.id !== 'gamma events'))).toBe(true); // holders alone is not core
    expect(formatHealth(res).join('\n')).toMatch(/DOWN gamma events .*-> affects: event list/);
  });
});
