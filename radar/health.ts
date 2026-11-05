/**
 * Preflight: which Polymarket services the radar needs are answering, and in the shape the code expects.
 * Run it before launching (`npm run radar -- doctor`; `tui` runs it too). It tells apart "their server is down or blocked from here"
 * from "an endpoint changed" (HTTP 410/404 or a different JSON shape), which is how the Data API v1 retirement looked.
 */

export interface Probe {
  id: string;
  url: string;
  /** What stops working when this one is down. */
  needed: string;
  /** Without it the radar cannot show events at all. */
  core: boolean;
  /** Returns an error text when the JSON is not what the code reads. */
  check: (body: unknown) => string | null;
}

const WALLET = '0x7a0da16a1205ee51a56fa862e8baa61e350eff14';
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const dataList = (body: unknown): string | null => (isObj(body) && Array.isArray(body.data) ? null : 'expected {"data":[...]}');

export const PROBES: readonly Probe[] = [
  { id: 'gamma events', url: 'https://gamma-api.polymarket.com/events?limit=1&active=true&closed=false', needed: 'event list, search, market names, holders picker, decision', core: true, check: (b) => (Array.isArray(b) ? null : 'expected an array') },
  { id: 'clob time', url: 'https://clob.polymarket.com/time', needed: 'order books, cost of a trade', core: false, check: (b) => (typeof b === 'number' || (typeof b === 'string' && /^\d+$/.test(b)) ? null : 'expected a unix time') },
  { id: 'data v2 trades', url: 'https://data-api.polymarket.com/v2/trades?limit=1', needed: 'big prints, anomalies, flow', core: true, check: dataList },
  { id: 'data v2 holders', url: `https://data-api.polymarket.com/v2/holders?condition=0x${'0'.repeat(64)}`, needed: 'holders tab', core: false, check: dataList },
  { id: 'data v2 activity', url: `https://data-api.polymarket.com/v2/activity?user=${WALLET}&limit=1`, needed: 'wallet profiles, watchlist', core: false, check: dataList },
  { id: 'data v2 positions', url: `https://data-api.polymarket.com/v2/positions?user=${WALLET}&limit=1`, needed: 'x-ray, holders positions', core: false, check: dataList },
  { id: 'data v2 user-pnl', url: `https://data-api.polymarket.com/v2/user-pnl?user=${WALLET}&interval=max&fidelity=1d`, needed: 'x-ray PnL curve', core: false, check: (b) => (isObj(b) && isObj(b.data) && Array.isArray(b.data.points) ? null : 'expected data.points') },
];

export interface ProbeResult {
  probe: Probe;
  ok: boolean;
  ms: number;
  /** Short reason when not ok. */
  problem: string | null;
}

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number; text: () => Promise<string> }>;

export async function runProbe(p: Probe, fetcher: Fetcher = fetch as unknown as Fetcher, timeoutMs = 10_000): Promise<ProbeResult> {
  const t0 = Date.now();
  const done = (problem: string | null): ProbeResult => ({ probe: p, ok: problem === null, ms: Date.now() - t0, problem });
  try {
    const res = await fetcher(p.url, { headers: { 'user-agent': 'polymarket-radar/0.1' }, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (res.status === 410) return done('HTTP 410: this endpoint was retired, the code needs migrating');
    if (res.status === 404) return done('HTTP 404: the route moved or was removed');
    if (res.status === 429) return done('HTTP 429: rate limited, wait a minute');
    if (res.status >= 500) return done(`HTTP ${res.status}: their server is failing`);
    if (res.status !== 200) return done(`HTTP ${res.status}`);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return done('answered 200 but not JSON');
    }
    const shape = p.check(body);
    return done(shape ? `answers, but the shape changed: ${shape}` : null);
  } catch (error) {
    const e = error as { name?: string; cause?: { code?: string } };
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return done(`no answer within ${timeoutMs / 1000}s`);
    const code = e?.cause?.code;
    return done(code === 'ECONNRESET' || code === 'ECONNREFUSED' ? `connection ${code === 'ECONNRESET' ? 'reset' : 'refused'} (host down, or blocked from this network)` : `cannot connect (${code ?? (error instanceof Error ? error.message : String(error))})`);
  }
}

export async function runHealth(fetcher?: Fetcher, timeoutMs?: number): Promise<ProbeResult[]> {
  return Promise.all(PROBES.map((p) => runProbe(p, fetcher, timeoutMs)));
}

export function formatHealth(results: readonly ProbeResult[]): string[] {
  const out = results.map((r) => `${r.ok ? 'OK  ' : 'DOWN'} ${r.probe.id.padEnd(18)} ${String(r.ms).padStart(5)}ms${r.ok ? '' : `  ${r.problem}  -> affects: ${r.probe.needed}`}`);
  const bad = results.filter((r) => !r.ok);
  out.push(bad.length === 0 ? 'all services answering' : `${bad.length} of ${results.length} not working${bad.some((r) => r.probe.core) ? ' (a core service: the radar cannot show events until it is back)' : ''}`);
  return out;
}

/** True when the radar can run usefully: every core service answers. */
export const coreHealthy = (results: readonly ProbeResult[]): boolean => results.every((r) => r.ok || !r.probe.core);
