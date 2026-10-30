import { parseShares, parseUnits } from '../../shared/decimal.cjs';
export type ExecutionSide = 'BUY' | 'SELL' | 'UNKNOWN';
export interface Execution {
  marketId: string; assetId: string; priceUnits: number; shares: bigint;
  side: ExecutionSide; timestampMs: number; receiptMs: number;
  timeSource: 'provider' | 'receipt'; identity: 'STRONG' | 'AMBIGUOUS';
  id?: string; transactionHash?: string; revision: number;
}
export interface ExecutionInput {
  marketId: string; assetId: string; price: string; size: string;
  timestampMs?: number; providerId?: string; transactionHash?: string;
  side?: string; sideVerified?: boolean; aggressorVerified?: boolean; revision?: number;
}
export interface NormalizationResult {
  status: 'accepted' | 'held' | 'quarantined' | 'invalid';
  execution?: Execution; reason?: string;
}
export function validTime(value: number): boolean { return Number.isSafeInteger(value) && value >= 0; }
/** Adapter must supply providerId ONLY when verified to uniquely identify an execution. */
export function normalizeExecution(input: ExecutionInput, receiptMs: number): NormalizationResult {
  try {
    if (!validTime(receiptMs) || !input.marketId || !input.assetId) throw new Error('Invalid receipt or instrument');
    const providerTime = input.timestampMs !== undefined && validTime(input.timestampMs);
    const timestampMs = providerTime ? input.timestampMs! : receiptMs;
    const shares = parseShares(input.size);
    if (shares === 0n) throw new Error('Execution size must be positive');
    const revision = input.revision ?? 0;
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid revision');
    const id = input.providerId || undefined;
    const execution: Execution = {
      marketId: input.marketId, assetId: input.assetId, priceUnits: parseUnits(input.price), shares,
      side: input.side === 'BUY' || input.side === 'SELL' ? input.side : 'UNKNOWN',
      timestampMs, receiptMs, timeSource: providerTime ? 'provider' : 'receipt',
      identity: id ? 'STRONG' : 'AMBIGUOUS', id, transactionHash: input.transactionHash,
      revision,
    };
    const future = timestampMs - receiptMs;
    return { status: future > 2000 ? 'quarantined' : future > 0 ? 'held' : 'accepted', execution };
  } catch (error) {
    return { status: 'invalid', reason: error instanceof Error ? error.message : 'Invalid execution' };
  }
}
/** Ten epoch-second buckets [floor(now/1000)*1000 - 9000, now]. */
export function qualifyingPrints(executions: readonly Execution[], nowMs: number, minimumShares: bigint): Execution[] {
  if (!validTime(nowMs) || typeof minimumShares !== 'bigint' || minimumShares < 0n) throw new RangeError('Invalid print window');
  return executions.filter(e => e.timestampMs >= Math.floor(nowMs / 1000) * 1000 - 9000 && e.timestampMs <= nowMs && e.shares >= minimumShares);
}
