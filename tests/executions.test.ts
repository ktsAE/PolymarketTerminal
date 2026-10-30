import { describe, it, expect } from 'vitest';
import { normalizeExecution, qualifyingPrints } from '../src/domain/executions';
const input = { marketId: 'm', assetId: 'a', price: '0.55', size: '2.1', timestampMs: 10000, transactionHash: 'tx' };
describe('executions', () => {
  it('never fabricates aggressor side or strong identity', () => {
    const r = normalizeExecution(input, 10000);
    expect(r.status).toBe('accepted');
    expect(r.execution?.side).toBe('UNKNOWN');
    expect(r.execution?.identity).toBe('AMBIGUOUS');
    expect(r.execution?.transactionHash).toBe('tx');
    expect(r.execution?.id).toBeUndefined();
  });
  it('uses receipt fallback and explicit verified side and ID', () => {
    const r = normalizeExecution({ ...input, timestampMs: undefined, providerId: 'x', side: 'SELL', aggressorVerified: true }, 10000);
    expect(r.execution).toMatchObject({ timestampMs: 10000, timeSource: 'receipt', side: 'SELL', id: 'x', identity: 'STRONG' });
  });
  it('preserves reported sides and falls back for malformed provider time', () => {
    expect(normalizeExecution({ ...input, side: 'BUY' }, 10000).execution?.side).toBe('BUY');
    expect(normalizeExecution({ ...input, timestampMs: NaN }, 10000).execution).toMatchObject({ timeSource: 'receipt', timestampMs: 10000 });
  });
  it('uses ten epoch-second buckets, inclusive of their first millisecond', () => {
    const e = normalizeExecution(input, 10000).execution!;
    expect(qualifyingPrints([{ ...e, timestampMs: 1499 }, { ...e, timestampMs: 2000 }], 11000, 0n).map(e => e.timestampMs)).toEqual([2000]);
  });
  it('holds near future and quarantines remote future', () => {
    expect(normalizeExecution({ ...input, timestampMs: 12000 }, 10000).status).toBe('held');
    expect(normalizeExecution({ ...input, timestampMs: 12001 }, 10000).status).toBe('quarantined');
    expect(normalizeExecution({ ...input, price: 'wat' }, 10000).status).toBe('invalid');
  });
  it('qualifies exact prints only within the trailing ten seconds', () => {
    const e = normalizeExecution(input, 10000).execution!;
    expect(qualifyingPrints([e, { ...e, timestampMs: 0 }, { ...e, timestampMs: 10001 }], 10000, 2000000n)).toEqual([e]);
  });
});
