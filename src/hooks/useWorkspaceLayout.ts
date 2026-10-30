import { useMemo } from 'react';

export interface WorkspaceLayoutInput {
  width: number;
  height: number;
  panelCount: number;
  columns: 'AUTO' | 1 | 2 | 3;
  rowHeight: 18 | 22 | 26;
  chromeHeights?: readonly (number | undefined)[];
  rowHeights?: readonly (18 | 22 | 26)[];
}
export interface WorkspaceLayout {
  columns: number;
  rows: number;
  panelWidth: number;
  rowHeights: number[];
  contentWidth: number;
  contentHeight: number;
  overflowX: boolean;
  overflowY: boolean;
  gap: 8;
}
export function calculateWorkspaceLayout(input: WorkspaceLayoutInput): WorkspaceLayout {
  const width = Math.max(0, input.width);
  const height = Math.max(0, input.height);
  const count = Math.max(0, Math.floor(input.panelCount));
  const columns = input.columns === 'AUTO'
    ? Math.max(1, Math.min(count || 1, 3, Math.floor((width + 8) / 368)))
    : input.columns;
  const rows = Math.ceil(count / columns);
  const panelWidth = Math.max(360, (width - (columns - 1) * 8) / columns);
  const minima = Array.from({ length: rows }, (_, row) => {
    let min = 0;
    for (let index = row * columns; index < Math.min(count, (row + 1) * columns); index++) {
      min = Math.max(min, (input.chromeHeights?.[index] ?? 194) + 7 * (input.rowHeights?.[index] ?? input.rowHeight));
    }
    return min;
  });
  const minimumHeight = minima.reduce((sum, value) => sum + value, 0) + Math.max(0, rows - 1) * 8;
  const extra = rows ? Math.max(0, height - minimumHeight) / rows : 0;
  const rowHeights = minima.map(value => value + extra);
  const contentWidth = count ? columns * panelWidth + (columns - 1) * 8 : 0;
  const contentHeight = rows ? Math.max(height, minimumHeight) : 0;
  return { columns, rows, panelWidth, rowHeights, contentWidth, contentHeight, overflowX: contentWidth > width, overflowY: contentHeight > height, gap: 8 };
}
export function useWorkspaceLayout(input: WorkspaceLayoutInput): WorkspaceLayout {
  return useMemo(() => calculateWorkspaceLayout(input), [input.width, input.height, input.panelCount, input.columns, input.rowHeight, input.chromeHeights, input.rowHeights]);
}
