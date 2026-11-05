/**
 * Who sent USDC to these wallets: reads ERC-20 Transfer logs from a public Polygon RPC.
 * Public nodes cap eth_getLogs at 10,000 blocks per call (about 5.5 hours) and require a token address, but one call can filter on many recipients at once,
 * so scanning N days for a whole market's holders costs N*4.4 calls, not one pass per wallet. Both USDC variants Polymarket funding has used are scanned.
 * Only transfers INTO the given wallets are read, over a bounded recent window: older funding is simply not seen.
 */

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
export const USDC_TOKENS = ['0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'];
export const DEFAULT_RPC = 'https://polygon-bor-rpc.publicnode.com';
export const BLOCKS_PER_CALL = 10_000;
const SECS_PER_BLOCK = 2.1;

export interface Transfer {
  from: string;
  to: string;
  /** USDC (6 decimals). */
  usd: number;
  block: number;
}

export interface ScanProgress {
  done: number;
  total: number;
  found: number;
}

export type RpcCall = (method: string, params: unknown[]) => Promise<unknown>;

export function httpRpc(url: string = process.env.RADAR_POLYGON_RPC ?? DEFAULT_RPC, timeoutMs = 30_000): RpcCall {
  return async (method, params) => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'polymarket-radar/0.1' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`RPC: ${String(body.error.message ?? 'error').slice(0, 120)}`);
    return body.result;
  };
}

const pad = (a: string): string => `0x${'0'.repeat(24)}${a.toLowerCase().slice(2)}`;
const unpad = (t: string): string => `0x${t.slice(-40)}`;

export function parseTransfer(l: { topics?: string[]; data?: string; blockNumber?: string }): Transfer | null {
  if (!l.topics || l.topics.length < 3 || l.topics[0] !== TRANSFER_TOPIC || !l.data) return null;
  const usd = Number(BigInt(l.data)) / 1e6;
  return { from: unpad(l.topics[1]), to: unpad(l.topics[2]), usd, block: Number.parseInt(l.blockNumber ?? '0', 16) };
}

export interface ScanOptions {
  days?: number;
  concurrency?: number;
  retries?: number;
  /** Stops early (returns what was found) when this returns true. */
  cancelled?: () => boolean;
  onProgress?: (p: ScanProgress) => void;
  sleep?: (ms: number) => Promise<void>;
}

/** All USDC transfers into `recipients` over the last `days` days, newest windows first. A window that keeps failing is skipped and counted in `failed`. */
export async function scanFunding(rpc: RpcCall, recipients: readonly string[], opts: ScanOptions = {}): Promise<{ transfers: Transfer[]; head: number; failed: number }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const head = Number.parseInt(String(await rpc('eth_blockNumber', [])), 16);
  const windows = Math.ceil(((opts.days ?? 14) * 86_400) / SECS_PER_BLOCK / BLOCKS_PER_CALL);
  const topics = [TRANSFER_TOPIC, null, [...new Set(recipients.map(pad))]];
  const out: Transfer[] = [];
  let next = 0;
  let done = 0;
  let failed = 0;
  const worker = async () => {
    while (!opts.cancelled?.()) {
      const i = next++;
      if (i >= windows) return;
      const to = head - i * BLOCKS_PER_CALL;
      const from = Math.max(0, to - BLOCKS_PER_CALL + 1);
      let ok = false;
      for (let attempt = 0; attempt <= (opts.retries ?? 2) && !ok; attempt++) {
        try {
          const logs = (await rpc('eth_getLogs', [{ fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, address: USDC_TOKENS, topics }])) as Array<{ topics?: string[]; data?: string; blockNumber?: string }>;
          for (const l of Array.isArray(logs) ? logs : []) {
            const t = parseTransfer(l);
            if (t) out.push(t);
          }
          ok = true;
        } catch {
          await sleep(500 * (attempt + 1));
        }
      }
      if (!ok) failed++;
      done++;
      opts.onProgress?.({ done, total: windows, found: out.length });
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 3 }, worker));
  return { transfers: out, head, failed };
}

/**
 * How many distinct wallets `funder` paid USDC to in the latest 10,000-block window. A wallet that pays dozens of strangers is a service (bridge, relayer,
 * exchange), and a shared service is no evidence of a shared owner. An RPC error here (usually "too many results") means the same thing and returns Infinity.
 */
export async function funderFanOut(rpc: RpcCall, funder: string, head: number): Promise<number> {
  try {
    const logs = (await rpc('eth_getLogs', [{ fromBlock: `0x${Math.max(0, head - BLOCKS_PER_CALL + 1).toString(16)}`, toBlock: `0x${head.toString(16)}`, address: USDC_TOKENS, topics: [TRANSFER_TOPIC, pad(funder)] }])) as Array<{ topics?: string[] }>;
    return new Set((Array.isArray(logs) ? logs : []).map((l) => l.topics?.[2] ?? '')).size;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Rough age of a block in hours, from the head block. */
export const blockAgeHours = (block: number, head: number): number => ((head - block) * SECS_PER_BLOCK) / 3_600;
