'use strict';
const SCALE = 1000000;
const SHARE_SCALE = 1000000n;
function parseShares(value) {
  if (typeof value !== 'string' || value.length > 1024 || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) {
    throw new TypeError('Expected unsigned plain decimal string with at most six fractional digits');
  }
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * SHARE_SCALE + BigInt(fraction.padEnd(6, '0'));
}
function parseUnits(value) {
  const units = parseShares(value);
  if (units > SHARE_SCALE) throw new RangeError('Probability must be between zero and one');
  return Number(units);
}
function formatShares(value) {
  if (typeof value !== 'bigint' || value < 0n) throw new TypeError('Expected nonnegative bigint microshares');
  const fraction = (value % SHARE_SCALE).toString().padStart(6, '0').replace(/0+$/, '');
  return (value / SHARE_SCALE).toString() + (fraction ? '.' + fraction : '');
}
function formatUnits(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > SCALE) throw new RangeError('Invalid probability units');
  return formatShares(BigInt(value));
}
exports.SCALE = SCALE;
exports.SHARE_SCALE = SHARE_SCALE;
exports.parseUnits = parseUnits;
exports.parseShares = parseShares;
exports.formatUnits = formatUnits;
exports.formatShares = formatShares;
