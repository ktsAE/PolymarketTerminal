import { expect, it } from 'vitest';
import { calculateWorkspaceLayout } from '../../src/hooks/useWorkspaceLayout';
it.each([1, 2, 3, 4, 5, 6])('AUTO fits %s panels without shrinking below native minimum width', panelCount => {
 const result = calculateWorkspaceLayout({ width: 1120, height: 900, panelCount, columns: 'AUTO', rowHeight: 22 });
 expect(result.panelWidth).toBeGreaterThanOrEqual(360);
 expect(result.columns).toBe(Math.min(3, panelCount));
 expect(result.contentWidth).toBeLessThanOrEqual(1120);
 expect(result.rowHeights.every(height => height >= 194 + 7 * 22)).toBe(true);
});
it('manual columns preserve minimum width and explicitly report overflow', () => {
 const result = calculateWorkspaceLayout({ width: 600, height: 250, panelCount: 6, columns: 3, rowHeight: 26 });
 expect(result.columns).toBe(3);
 expect(result.rows).toBe(2);
 expect(result.panelWidth).toBe(360);
 expect(result.contentWidth).toBe(1096);
 expect(result.overflowX).toBe(true);
 expect(result.overflowY).toBe(true);
});
it('shared row heights use the tallest measured panel chrome and seven native rows', () => {
 const result = calculateWorkspaceLayout({ width: 800, height: 300, panelCount: 2, columns: 2, rowHeight: 22, chromeHeights: [210, 250], rowHeights: [26, 18] });
 expect(result.rowHeights).toEqual([392]);
 expect(result.contentHeight).toBe(392);
});
