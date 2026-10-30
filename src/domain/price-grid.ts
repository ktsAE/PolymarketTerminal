export type Compression = 1 | 2 | 5;
export function assertPriceUnits(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) throw new RangeError('Invalid probability units');
}
export function gridStep(tickUnits: number, compression: Compression = 1): number {
  if (!Number.isSafeInteger(tickUnits) || tickUnits <= 0 || tickUnits > 1_000_000 || ![1, 2, 5].includes(compression)) throw new RangeError('Invalid tick or compression');
  return tickUnits * compression;
}
export function bucketPrice(priceUnits: number, tickUnits: number, compression: Compression = 1): number {
  assertPriceUnits(priceUnits);
  const step = gridStep(tickUnits, compression);
  return Math.floor(priceUnits / step) * step;
}
export interface PriceGridOptions { tickUnits: number; compression?: Compression; minUnits?: number; maxUnits?: number; maxRows?: number; descending?: boolean }
/** Continuous inclusive ascending bucket anchors; throws rather than silently truncating. */
export function createPriceGrid({ tickUnits, compression = 1, minUnits = 0, maxUnits = 1_000_000, maxRows = 10001, descending = false }: PriceGridOptions): number[] {
  const step = gridStep(tickUnits, compression);
  const first = bucketPrice(minUnits, tickUnits, compression);
  const last = bucketPrice(maxUnits, tickUnits, compression);
  if (minUnits > maxUnits || !Number.isSafeInteger(maxRows) || maxRows < 1) throw new RangeError('Invalid grid bounds');
  const count = (last - first) / step + 1;
  if (count > maxRows) throw new RangeError('Price grid exceeds row limit');
  const rows = Array.from({ length: count }, (_, i) => first + i * step);
  return descending ? rows.reverse() : rows;
}
export function groupPrices(levels: readonly { priceUnits: number; shares: bigint }[], tickUnits: number, compression: Compression = 1): { priceUnits: number; shares: bigint }[] {
  gridStep(tickUnits, compression);
  const buckets = new Map<number, bigint>();
  for (const level of levels) {
    if (typeof level.shares !== 'bigint' || level.shares < 0n) throw new RangeError('Invalid shares');
    const price = bucketPrice(level.priceUnits, tickUnits, compression);
    buckets.set(price, (buckets.get(price) ?? 0n) + level.shares);
  }
  return [...buckets].sort(([a], [b]) => a - b).map(([priceUnits, shares]) => ({ priceUnits, shares }));
}
