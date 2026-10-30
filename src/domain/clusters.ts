import { bucketPrice, gridStep, type Compression } from './price-grid';
import { validTime, type Execution } from './executions';
export type ClusterInterval = 5 | 15 | 60;
export type GapReason = 'CONNECTION' | 'INVALID' | 'OVERFLOW';
export interface ClusterRow { priceUnits: number; buy: bigint; sell: bigint; unknown: bigint; total: bigint; count: number }
export interface ClusterBucket {
  startMs: number; endMs: number; rows: ClusterRow[]; correctedUntil?: number;
  quality: { partial: boolean; gap: boolean; overflow: boolean; approximate: boolean; unavailable: boolean };
}
export interface ClusterProjection {
  nowMs: number; intervalSeconds: ClusterInterval; tickUnits: number; compression?: Compression;
  marketId?: string; assetId?: string;
}
export interface ClusterOptions { startedAtMs?: number; maxExecutions?: number; maxCells?: number; maxGaps?: number }
export type IngestResult = 'inserted' | 'corrected' | 'duplicate' | 'stale' | 'expired' | 'held' | 'quarantined' | 'overflow';
interface Cell extends ClusterRow { second: number; marketId: string; assetId: string; approximateCount: number; correctedUntil: number }
const RETENTION_MS = 600000;
export function intervalStart(nowMs: number, seconds: ClusterInterval): number {
  if (!validTime(nowMs) || ![5, 15, 60].includes(seconds)) throw new RangeError('Invalid interval');
  return Math.floor(nowMs / (seconds * 1000)) * seconds * 1000;
}
/** Exact native-price, one-second aggregates. Raw records serve the short print
 * window and strong-ID corrections, never as the source of historical sums. */
export class ClusterStore {
  private records = new Map<number, Execution>();
  private identities = new Map<string, number>();
  private cells = new Map<string, Cell>();
  private sequence = 0;
  private gaps: { start: number; end: number; reason: GapReason }[] = [];
  private watermark = 0;
  private lastPrunedSecond = -1;
  private startedAt: number | undefined;
  readonly maxExecutions: number;
  readonly maxCells: number;
  readonly maxGaps: number;
  constructor(options: ClusterOptions = {}) {
    this.maxExecutions = options.maxExecutions ?? 20000;
    this.maxCells = options.maxCells ?? 100000;
    this.maxGaps = options.maxGaps ?? 1024;
    for (const limit of [this.maxExecutions, this.maxCells, this.maxGaps]) if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid storage limit');
    if (options.startedAtMs !== undefined && !validTime(options.startedAtMs)) throw new RangeError('Invalid start');
    this.startedAt = options.startedAtMs;
  }
  get size(): number { return this.records.size; }
  get cellCount(): number { return this.cells.size; }
  hasCell(execution: Execution): boolean { return this.cells.has(this.cellKey(execution)); }
  private identity(e: Execution): string | undefined { return e.identity === 'STRONG' && e.id ? JSON.stringify([e.marketId, e.assetId, e.id]) : undefined; }
  private cellKey(e: Execution): string { return JSON.stringify([e.marketId, e.assetId, Math.floor(e.timestampMs / 1000) * 1000, e.priceUnits]); }
  private adjust(e: Execution, direction: 1 | -1, correctedUntil: number): void {
    const key = this.cellKey(e);
    const cell = this.cells.get(key) ?? { marketId: e.marketId, assetId: e.assetId, second: Math.floor(e.timestampMs / 1000) * 1000, priceUnits: e.priceUnits, buy: 0n, sell: 0n, unknown: 0n, total: 0n, count: 0, approximateCount: 0, correctedUntil: 0 };
    const amount = e.shares * BigInt(direction);
    if (e.side === 'BUY') cell.buy += amount;
    else if (e.side === 'SELL') cell.sell += amount;
    else cell.unknown += amount;
    cell.total += amount; cell.count += direction;
    if (e.identity === 'AMBIGUOUS' || e.timeSource === 'receipt') cell.approximateCount += direction;
    cell.correctedUntil = Math.max(cell.correctedUntil, correctedUntil);
    // Keep a zero cell after correction so the source bucket retains its badge.
    this.cells.set(key, cell);
  }
  ingest(e: Execution, nowMs = e.receiptMs): IngestResult {
    if (!validTime(nowMs) || !validTime(e.timestampMs) || !validTime(e.receiptMs)) throw new RangeError('Invalid execution time');
    bucketPrice(e.priceUnits, 1);
    if (typeof e.shares !== 'bigint' || e.shares <= 0n || !['BUY', 'SELL', 'UNKNOWN'].includes(e.side) || !Number.isSafeInteger(e.revision) || e.revision < 0) throw new RangeError('Invalid execution');
    if (e.timestampMs > nowMs) return e.timestampMs - nowMs > 2000 ? 'quarantined' : 'held';
    this.prune(nowMs);
    if (e.timestampMs < this.watermark - RETENTION_MS) return 'expired';
    this.startedAt ??= nowMs;
    const identity = this.identity(e);
    const priorKey = identity === undefined ? undefined : this.identities.get(identity);
    const prior = priorKey === undefined ? undefined : this.records.get(priorKey);
    if (prior && e.revision <= prior.revision) return e.revision < prior.revision ? 'stale' : 'duplicate';
    if ((!prior && this.records.size >= this.maxExecutions) || (!this.cells.has(this.cellKey(e)) && this.cells.size >= this.maxCells)) {
      const second = Math.floor(e.timestampMs / 1000) * 1000;
      this.markGap(second, second + 1000, 'OVERFLOW'); return 'overflow';
    }
    const correctedUntil = prior || e.timestampMs < Math.floor(nowMs / 1000) * 1000 ? nowMs + 2000 : 0;
    if (prior) this.adjust(prior, -1, correctedUntil);
    this.adjust(e, 1, correctedUntil);
    const key = priorKey ?? this.sequence++;
    this.records.set(key, { ...e }); if (identity) this.identities.set(identity, key);
    return prior ? 'corrected' : 'inserted';
  }
  /** Reasons have independent bounded spans: merging connection loss must not
   * erase the first omitted execution second or relabel invalid packets. */
  markGap(startMs: number, endMs: number, reason: GapReason = 'CONNECTION'): void {
    if (!validTime(startMs) || !validTime(endMs) || endMs <= startMs) throw new RangeError('Invalid gap');
    const sorted = [...this.gaps.filter(g => g.reason === reason), { start: startMs, end: endMs, reason }].sort((a, b) => a.start - b.start);
    const merged: typeof sorted = [];
    for (const gap of sorted) {
      const last = merged[merged.length - 1];
      if (last && gap.start <= last.end) last.end = Math.max(last.end, gap.end); else merged.push({ ...gap });
    }
    while (merged.length > this.maxGaps) { const first = merged.shift()!; merged[0].start = first.start; }
    this.gaps = [...this.gaps.filter(g => g.reason !== reason), ...merged];
  }
  getGaps(reason?: GapReason): { start: number; end: number }[] {
    return this.gaps.filter(g => reason === undefined || g.reason === reason).map(({ start, end }) => ({ start, end }));
  }
  prune(nowMs: number): void {
    if (!validTime(nowMs)) throw new RangeError('Invalid clock');
    this.watermark = Math.max(this.watermark, nowMs);
    const second = Math.floor(this.watermark / 1000) * 1000;
    if (second === this.lastPrunedSecond) return;
    this.lastPrunedSecond = second;
    const cutoff = second - RETENTION_MS;
    for (const [key, cell] of this.cells) if (cell.second < cutoff) this.cells.delete(key);
    for (const [key, e] of this.records) {
      if (e.timestampMs < (this.identity(e) ? cutoff : second - 9000)) {
        this.records.delete(key); const id = this.identity(e); if (id) this.identities.delete(id);
      }
    }
    this.gaps = this.gaps.filter(g => g.end > cutoff);
  }
  project(options: ClusterProjection): ClusterBucket[] {
    const { nowMs, intervalSeconds, tickUnits, compression = 1, marketId, assetId } = options;
    const current = intervalStart(nowMs, intervalSeconds); gridStep(tickUnits, compression); this.prune(nowMs);
    const width = intervalSeconds * 1000;
    const coverageStart = Math.max(this.startedAt ?? nowMs, Math.floor(this.watermark / 1000) * 1000 - RETENTION_MS);
    return Array.from({ length: 3 }, (_, index) => {
      const startMs = current - (2 - index) * width; const endMs = startMs + width;
      const rows = new Map<number, ClusterRow>(); let approximate = false; let correctedUntil = 0;
      for (const c of this.cells.values()) {
        if (c.second < startMs || c.second >= endMs || c.second > nowMs || (marketId !== undefined && c.marketId !== marketId) || (assetId !== undefined && c.assetId !== assetId)) continue;
        correctedUntil = Math.max(correctedUntil, c.correctedUntil); approximate ||= c.approximateCount > 0;
        if (!c.count) continue;
        const priceUnits = bucketPrice(c.priceUnits, tickUnits, compression);
        const row = rows.get(priceUnits) ?? { priceUnits, buy: 0n, sell: 0n, unknown: 0n, total: 0n, count: 0 };
        row.buy += c.buy; row.sell += c.sell; row.unknown += c.unknown; row.total += c.total; row.count += c.count; rows.set(priceUnits, row);
      }
      const gap = this.gaps.some(g => g.start <= nowMs && g.start < endMs && g.end > startMs);
      const overflow = this.gaps.some(g => g.reason === 'OVERFLOW' && g.start <= nowMs && g.start < endMs && g.end > startMs);
      return { startMs, endMs, rows: [...rows.values()].sort((a, b) => a.priceUnits - b.priceUnits), correctedUntil: correctedUntil || undefined,
        quality: { partial: startMs < coverageStart || gap, unavailable: endMs <= coverageStart, gap, overflow, approximate } };
    });
  }
}
