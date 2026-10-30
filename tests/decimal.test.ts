import { describe, it, expect } from 'vitest';
import { parseUnits, parseShares, formatUnits, formatShares } from '../shared/decimal.cjs';
describe('exact decimal', () => {
  it('parses and formats without floating arithmetic', () => {
    expect(parseUnits('0.000001')).toBe(1);
    expect(parseUnits('1')).toBe(1_000_000);
    expect(formatUnits(123400)).toBe('0.1234');
    expect(formatShares(parseShares('9007199254740993.123456'))).toBe('9007199254740993.123456');
    expect(parseShares('0.1') + parseShares('0.2')).toBe(300000n);
  });
  it.each(['1e-6', '-0.1', '.1', '1.', '0.0000001', ' 0.1', 'NaN'])('rejects %s', value => {
    expect(() => parseUnits(value)).toThrow();
    expect(() => parseShares(value)).toThrow();
  });
  it('enforces probability bounds', () => {
    expect(() => parseUnits('1.000001')).toThrow();
    expect(() => formatUnits(0.5)).toThrow();
  });
});
