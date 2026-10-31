/**
 * Fair-value helpers for "token FDV above X at time T" markets, from an external spot price.
 * The model is deliberately crude (log-normal price, no sell-pressure term) and is used as a RANGE over its own
 * assumptions: a market is only called mispriced when it sits outside the whole range.
 */

/** Standard normal CDF (Abramowitz-Stegun 7.1.26). */
export function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/** P(price at T > threshold) when ln(price) is normal with sd = sigmaDay*sqrt(days). `martingale` centres the mean (not the median) on spot. */
export function probAbove(spot: number, threshold: number, sigmaDay: number, days: number, martingale: boolean): number {
  if (!(spot > 0) || !(threshold > 0)) return NaN;
  if (days <= 0) return spot > threshold ? 1 : 0;
  const sd = sigmaDay * Math.sqrt(days);
  const mu = Math.log(spot) - (martingale ? (sd * sd) / 2 : 0);
  return 1 - normalCdf((Math.log(threshold) - mu) / sd);
}

export interface FairRange {
  lo: number;
  hi: number;
  /** The combinations tried: volatility 0.5x/1x/1.5x, with and without the martingale shift. */
  tried: number;
}

export function fairRange(spot: number, threshold: number, sigmaDay: number, days: number): FairRange {
  const ps: number[] = [];
  for (const k of [0.5, 1, 1.5]) for (const m of [false, true]) ps.push(probAbove(spot, threshold, sigmaDay * k, days, m));
  return { lo: Math.min(...ps), hi: Math.max(...ps), tried: ps.length };
}

const ET_PARTS: Intl.DateTimeFormatOptions = { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' };
const etFmt = new Intl.DateTimeFormat('en-US', ET_PARTS);

function etParts(utcMs: number): { y: number; m: number; d: number; h: number; mi: number } {
  const p = Object.fromEntries(etFmt.formatToParts(new Date(utcMs)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute };
}

/** Wall-clock time in New York -> epoch seconds, honouring daylight saving (so 4 PM is 20:00 UTC in summer, 21:00 UTC after the clocks go back). */
export function etToUtcSecs(y: number, m: number, d: number, h: number, mi: number): number {
  for (const offsetH of [4, 5]) {
    const ms = Date.UTC(y, m - 1, d, h + offsetH, mi);
    const p = etParts(ms);
    if (p.y === y && p.m === m && p.d === d && p.h === h && p.mi === mi) return ms / 1000;
  }
  return Date.UTC(y, m - 1, d, h + 5, mi) / 1000;
}

/** "1 day after launch" as these markets define it: 4:00 PM ET on the calendar day (in ET) after launch. */
export function oneDayAfterLaunch(launchSecs: number): number {
  const l = etParts(launchSecs * 1000);
  const next = new Date(Date.UTC(l.y, l.m - 1, l.d + 1));
  return etToUtcSecs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 16, 0);
}
