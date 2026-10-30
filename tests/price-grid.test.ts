import { describe, it, expect } from 'vitest';
import { bucketPrice, createPriceGrid, groupPrices } from '../src/domain/price-grid';
describe('price grid', () => {
  it('floors rather than rounds and retains absolute anchors', () => {
    expect(bucketPrice(555000, 10000, 2)).toBe(540000);
    expect(createPriceGrid({ tickUnits: 10000, compression: 2, minUnits: 530000, maxUnits: 590000 })).toEqual([520000, 540000, 560000, 580000]);
  });
  it('bounds rows and rejects invalid precision or compression', () => {
    expect(() => createPriceGrid({ tickUnits: 1, maxRows: 10 })).toThrow();
    expect(() => bucketPrice(10, 0)).toThrow();
    expect(() => bucketPrice(10, 1, 3 as 2)).toThrow();
  });
  it('sums exact shares in a bucket', () => {
    expect(groupPrices([{ priceUnits: 101000, shares: 2n }, { priceUnits: 109000, shares: 3n }], 10000)).toEqual([{ priceUnits: 100000, shares: 5n }]);
  });
});
