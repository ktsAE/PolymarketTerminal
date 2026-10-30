import { describe, it, expect } from 'vitest';
import { ClusterStore, intervalStart } from '../src/domain/clusters';
import { normalizeExecution } from '../src/domain/executions';
const e = (timestampMs: number, more = {}) => normalizeExecution({ marketId: 'm', assetId: 'a', price: '0.555', size: '2', timestampMs, ...more }, timestampMs).execution!;
const projection = (s: ClusterStore, nowMs = 17000, intervalSeconds: 5 | 15 | 60 = 5) => s.project({ nowMs, intervalSeconds, tickUnits: 1000 });
describe('fixed second cluster aggregates', () => {
  it('exports epoch alignment, projects oldest first, and does not call current future coverage partial', () => {
    expect(intervalStart(17999, 5)).toBe(15000);
    const s = new ClusterStore({ startedAtMs: 0 }); s.ingest(e(10000)); s.ingest(e(15000, { side: 'SELL' }));
    const p = projection(s); expect(p.map(b => b.startMs)).toEqual([5000, 10000, 15000]);
    expect(p[2].quality.partial).toBe(false); expect(p[2].rows[0].sell).toBe(2000000n);
  });
  it('shows pre-observation buckets unavailable, including startup current bucket partial', () => {
    const s = new ClusterStore({ startedAtMs: 16000 }); const p = projection(s);
    expect(p[0].quality.unavailable).toBe(true); expect(p[1].quality.unavailable).toBe(true); expect(p[2].quality.partial).toBe(true);
  });
  it('rejects new admissions rather than evicting existing sums and marks partial GAP', () => {
    const s = new ClusterStore({ startedAtMs: 0, maxExecutions: 1 }); expect(s.ingest(e(10000))).toBe('inserted');
    expect(s.ingest(e(11000))).toBe('overflow');
    const b = projection(s, 12000)[2]; expect(b.rows[0].total).toBe(2000000n); expect(b.quality).toMatchObject({ gap: true, partial: true, overflow: true });
  });
  it('retains bounded overflow provenance independently of overlapping connection and invalid spans', () => {
    const s = new ClusterStore({ startedAtMs: 0, maxGaps: 2 });
    s.markGap(10000, 20000); s.markGap(11000, 12000, 'OVERFLOW'); s.markGap(9000, 21000, 'INVALID');
    expect(s.getGaps('OVERFLOW')).toEqual([{ start: 11000, end: 12000 }]);
    expect(projection(s, 11000)[2].quality.overflow).toBe(true);
    expect(projection(s, 15000)[2].quality).toMatchObject({ gap: true, overflow: false });
    s.prune(611999); expect(s.getGaps('OVERFLOW')).toHaveLength(1);
    s.prune(612000); expect(s.getGaps('OVERFLOW')).toEqual([]);
    const bounded = new ClusterStore({ maxGaps: 2 });
    for (let i = 0; i < 10; i++) bounded.markGap(i * 2000, i * 2000 + 1000, 'OVERFLOW');
    expect(bounded.getGaps('OVERFLOW')).toHaveLength(2);
    expect(bounded.getGaps('OVERFLOW')[0].start).toBe(0);
  });
  it('retains exact ten-minute aggregates independently of short timed record storage', () => {
    const s = new ClusterStore({ startedAtMs: 0, maxExecutions: 1 }); s.ingest(e(10000));
    s.prune(21000); expect(s.size).toBe(0); expect(s.ingest(e(21000))).toBe('inserted');
    expect(projection(s, 22000, 60)[2].rows[0].total).toBe(4000000n);
  });
  it('never deduplicates ambiguous prints; corrects strong identities with no old sums', () => {
    const s = new ClusterStore({ startedAtMs: 0 }); s.ingest(e(10000)); s.ingest(e(10000));
    const strong = e(10000, { providerId: 'id' }); s.ingest(strong); expect(s.ingest(strong)).toBe('duplicate');
    expect(s.ingest({ ...strong, timestampMs: 15000, priceUnits: 600000, side: 'SELL', revision: 2 }, 17000)).toBe('corrected');
    expect(s.ingest({ ...strong, revision: 1 })).toBe('stale');
    const p = projection(s); expect(p[1].rows[0].total).toBe(4000000n); expect(p[2].rows[0].sell).toBe(2000000n);
    expect(p[1].correctedUntil).toBeGreaterThan(0); expect(p[2].correctedUntil).toBeGreaterThan(0);
  });
  it('marks late arrivals corrected and preserves absolute prices across tick regrouping', () => {
    const s = new ClusterStore({ startedAtMs: 0 }); s.ingest(e(10000), 17000);
    expect(projection(s)[1].correctedUntil).toBeGreaterThanOrEqual(17000);
    expect(s.project({ nowMs: 17000, intervalSeconds: 5, tickUnits: 10000, compression: 2 })[1].rows[0].priceUnits).toBe(540000);
    expect(projection(s)[1].rows[0].priceUnits).toBe(555000);
  });
  it('bounds cells separately and marks overflow', () => {
    const s = new ClusterStore({ startedAtMs: 0, maxCells: 1 }); s.ingest(e(10000)); expect(s.ingest(e(11000))).toBe('overflow'); expect(s.cellCount).toBe(1);
  });
  it('holds future, quarantines remote future, expires old aggregates and keeps boundaries', () => {
    const s = new ClusterStore({ startedAtMs: 0 }); s.ingest(e(10000));
    expect(s.ingest(e(101000), 100000)).toBe('held'); expect(s.ingest(e(103000), 100000)).toBe('quarantined');
    s.prune(610000); expect(s.cellCount).toBe(1); s.prune(611000); expect(s.cellCount).toBe(0); expect(s.ingest(e(10000), 611000)).toBe('expired');
  });
  it('scopes strong IDs and exact big integer sums', () => {
    const s = new ClusterStore({ startedAtMs: 0 }); const strong = { ...e(10000, { providerId: 'same' }), shares: 999999999999999999999n };
    s.ingest(strong); s.ingest({ ...strong, assetId: 'b' });
    expect(projection(s, 12000)[2].rows[0].total).toBe(1999999999999999999998n);
  });
});
