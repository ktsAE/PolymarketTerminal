export type ShareAmount = number | string;

/** Presentation-only conversion; never use for order/financial validation. */
export function sharesNumber(value: ShareAmount): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function bubbleDiameter(volume: number, scale: number, rowHeight: number): number {
  const max = Math.max(0, Math.min(32, rowHeight - 2));
  const min = Math.min(8, max);
  const ratio = Math.min(1, Math.max(0, volume) / Math.max(1, scale));
  return Math.sqrt(min * min + (max * max - min * min) * ratio);
}

export interface DepthSample {
  levels: readonly { priceUnits: number; shares: ShareAmount }[];
  bestPriceUnits: number;
  tickUnits: number;
  compression?: 1 | 2 | 5;
  side: 'BID' | 'ASK';
}
/** Includes BBO and levels up to twenty native ticks away, grouped after sampling. */
export function sampleDepthScale({ levels, bestPriceUnits, tickUnits, compression = 1, side }: DepthSample): number {
  if (!(tickUnits > 0)) return 1;
  const groups = new Map<number, number>();
  for (const level of levels) {
    const distance = side === 'BID' ? bestPriceUnits - level.priceUnits : level.priceUnits - bestPriceUnits;
    if (distance < 0 || distance > 20 * tickUnits) continue;
    const group = Math.floor(level.priceUnits / (tickUnits * compression));
    groups.set(group, (groups.get(group) ?? 0) + sharesNumber(level.shares));
  }
  return Math.max(1, ...groups.values());
}

export interface DepthScaleState { value: number; belowSince: number | null }
/** Caller samples at most every 250ms; the state machine is deterministic and timer-free. */
export function updateDepthScale(state: DepthScaleState, target: number, now: number): DepthScaleState {
  target = Number.isFinite(target) ? Math.max(1, target) : 1;
  const value = Math.max(1, state.value);
  if (target >= value) return { value: target, belowSince: null };
  if (target >= value * 0.7) return { value, belowSince: null };
  const belowSince = state.belowSince !== null && state.belowSince <= now ? state.belowSince : now;
  return now - belowSince >= 2000 ? { value: target, belowSince: null } : { value, belowSince };
}
