export const SCALE: 1000000;
export const SHARE_SCALE: 1000000n;
/** Strict unsigned plain decimal, <=6 fractional digits, probability in [0,1]. */
export function parseUnits(value: string): number;
/** Strict unsigned plain decimal, <=6 fractional digits; returns microshares. */
export function parseShares(value: string): bigint;
export function formatUnits(value: number): string;
export function formatShares(value: bigint): string;
