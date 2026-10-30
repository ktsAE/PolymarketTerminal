import { describe, expect, it } from 'vitest';
import { bubbleDiameter, sampleDepthScale, updateDepthScale } from '../src/domain/scales';
import { calculateWorkspaceLayout } from '../src/hooks/useWorkspaceLayout';

describe('presentation scales', () => {
  it('encodes bounded bubble area, not diameter', () => {
    expect(bubbleDiameter(0, 100, 22)).toBe(8);
    expect(bubbleDiameter(50, 100, 22)).toBeCloseTo(Math.sqrt(232));
    expect(bubbleDiameter(1000, 100, 18)).toBe(16);
  });
  it('samples twenty native ticks before grouping and ignores distant size', () => {
    expect(sampleDepthScale({ levels: [{ priceUnits: 500, shares: 20 }, { priceUnits: 490, shares: 30 }, { priceUnits: 200, shares: 9999 }], bestPriceUnits: 500, tickUnits: 10, compression: 2, side: 'BID' })).toBe(30);
  });
  it('increases immediately, decreases after two continuous seconds below 70%', () => {
    let state = updateDepthScale({ value: 100, belowSince: null }, 60, 1000);
    expect(state.value).toBe(100);
    state = updateDepthScale(state, 60, 2999);
    expect(state.value).toBe(100);
    expect(updateDepthScale(state, 60, 3000).value).toBe(60);
    state = updateDepthScale(state, 80, 3000);
    expect(state.belowSince).toBeNull();
    expect(updateDepthScale(state, 200, 3001).value).toBe(200);
  });
});
describe('workspace layout', () => {
  it('caps AUTO at three with readable panel minima and explicit overflow', () => {
    const layout = calculateWorkspaceLayout({ width: 700, height: 400, panelCount: 6, columns: 'AUTO', rowHeight: 22 });
    expect(layout.columns).toBe(1);
    expect(layout.rowHeights).toEqual(Array(6).fill(348));
    expect(layout.overflowY).toBe(true);
    expect(calculateWorkspaceLayout({ width: 700, height: 400, panelCount: 2, columns: 3, rowHeight: 22 }).overflowX).toBe(true);
  });
  it('uses measured chrome and maximum minimum per grid row', () => {
    const layout = calculateWorkspaceLayout({ width: 1200, height: 300, panelCount: 3, columns: 'AUTO', rowHeight: 18, chromeHeights: [100, 200, 150] });
    expect(layout.columns).toBe(3);
    expect(layout.rowHeights).toEqual([326]);
  });
});
