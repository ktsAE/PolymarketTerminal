import { existsSync, readFileSync } from 'node:fs';
import { oneDayAfterLaunch } from './fairvalue.ts';
import type { Reference } from './decide.ts';
import type { FetchJson } from './polymarket.ts';

/**
 * External reference prices for markets that settle on something outside Polymarket. Right now: a token's DEX price,
 * for "FDV above X one day after launch" and "launch by date" markets.
 *
 * The mapping from market to token is configured by hand in .radar/refs.json, because the one thing this tool cannot do is
 * tell which token mint is the official one (a wrong mint means a fake token's price). Example in radar/refs.example.json.
 */

export interface RefConfig {
  /** Matched as a substring of the event slug. */
  match: string;
  kind: 'dex-token';
  chain: string;
  mint: string;
  supply: number;
  sigmaDay?: number;
  /** Override the launch time (epoch seconds) when the first pool is not the real launch. */
  launchAt?: number;
  /** Facts to confirm by hand before acting; shown in the decision. */
  checks?: string[];
}

export const REFS_PATH = process.env.RADAR_REFS ?? '.radar/refs.json';
export const DEFAULT_SIGMA_DAY = 0.8;

export function loadRefs(path = REFS_PATH): RefConfig[] {
  if (!existsSync(path)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { refs?: unknown })?.refs;
  if (!Array.isArray(list)) throw new Error(`${path}: expected a JSON array or { "refs": [...] }`);
  return list.map((r, i) => {
    if (!r || typeof r.match !== 'string' || typeof r.mint !== 'string') throw new Error(`${path}: entry ${i} needs "match" and "mint"`);
    return { match: r.match, kind: 'dex-token', chain: String(r.chain ?? 'solana'), mint: r.mint, supply: Number(r.supply ?? 1e9), sigmaDay: r.sigmaDay === undefined ? undefined : Number(r.sigmaDay), launchAt: r.launchAt === undefined ? undefined : Number(r.launchAt), checks: Array.isArray(r.checks) ? r.checks.map(String) : [] } as RefConfig;
  });
}

export const refFor = (slug: string, refs: readonly RefConfig[]): RefConfig | undefined => refs.find((r) => slug.includes(r.match));

interface DexPair {
  chainId?: string;
  dexId?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h1?: number };
  pairCreatedAt?: number;
}

/** Price, liquidity and first-pool time of a token from DexScreener (free, keyless). Null when no pool has liquidity. */
export async function fetchDexReference(fetchJson: FetchJson, cfg: RefConfig, titleOfEvent: string, now: number): Promise<Reference | null> {
  const body = (await fetchJson(`https://api.dexscreener.com/latest/dex/tokens/${cfg.mint}`)) as { pairs?: DexPair[] };
  const pairs = (body?.pairs ?? []).filter((p) => (p.chainId ?? cfg.chain) === cfg.chain && Number(p.priceUsd) > 0);
  if (pairs.length === 0) return null;
  const liq = (p: DexPair): number => p.liquidity?.usd ?? 0;
  const top = [...pairs].sort((a, b) => liq(b) - liq(a))[0];
  if (liq(top) <= 0) return null;
  const real = pairs.filter((p) => liq(p) >= 5_000);
  const prices = real.map((p) => Number(p.priceUsd));
  const created = pairs.filter((p) => liq(p) >= 1_000 && p.pairCreatedAt).map((p) => (p.pairCreatedAt as number) / 1000);
  const launchAt = cfg.launchAt ?? (created.length ? Math.min(...created) : null);
  const price = Number(top.priceUsd);
  const oneDay = /(one|1) day after launch/i.test(titleOfEvent);
  return {
    kind: 'token-fdv',
    source: `DexScreener ${top.dexId ?? 'pool'}`,
    mint: cfg.mint,
    spotPrice: price,
    spotFdv: price * cfg.supply,
    supply: cfg.supply,
    sigmaDay: cfg.sigmaDay ?? DEFAULT_SIGMA_DAY,
    asOf: now,
    launchAt,
    resolveAt: oneDay && launchAt !== null ? oneDayAfterLaunch(launchAt) : null,
    pools: pairs.filter((p) => liq(p) >= 1_000).length,
    liqUsd: pairs.reduce((a, p) => a + liq(p), 0),
    vol1hUsd: pairs.reduce((a, p) => a + (p.volume?.h1 ?? 0), 0),
    priceSpread: prices.length >= 2 ? Math.max(...prices) / Math.min(...prices) - 1 : null,
    checks: cfg.checks ?? [],
  };
}
