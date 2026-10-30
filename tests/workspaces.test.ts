// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { readWorkspace, saveWorkspace, readPanelSettings, savePanelSettings } from '../src/state/workspaceStore';
import { DEFAULT_PANEL_SETTINGS } from '../src/components/PanelSettings';
describe('versioned workspace persistence', () => {
 beforeEach(() => localStorage.clear());
 it('distinguishes an intentionally empty slot from an unsaved slot', () => {
  expect(readWorkspace('SCALP 1')).toBeNull();
  saveWorkspace('SCALP 1', [], '2');
  expect(readWorkspace('SCALP 1')).toMatchObject({ assetIds: [], layout: '2' });
 });
 it('migrates legacy empty slots without falling back to global books', () => {
  localStorage.setItem('pm-terminal:workspace:SCALP 2', '[]');
  localStorage.setItem('pm-terminal:open-instruments', '["other"]');
  expect(readWorkspace('SCALP 2')?.assetIds).toEqual([]);
 });
 it('validates persisted enums and strips unknown settings', () => {
  localStorage.setItem('pm-terminal:v2:workspace:SCALP 1', JSON.stringify({ version: 2, assetIds: ['a', 'a', 2], layout: 'bad', filters: { date: 'bad' } }));
  expect(readWorkspace('SCALP 1')).toMatchObject({ assetIds: ['a'], layout: 'AUTO', filters: { date: 'All', marketType: 'all' } });
  localStorage.setItem('pm-terminal:v2:workspace:SCALP 1:panel:a', JSON.stringify({ compression: 9, rowHeight: 26, armed: true }));
  expect(readPanelSettings('SCALP 1', 'a')).toEqual({ ...DEFAULT_PANEL_SETTINGS, rowHeight: 26 });
 });
 it('isolates settings by slot and asset', () => {
  savePanelSettings('SCALP 1', 'a', { ...DEFAULT_PANEL_SETTINGS, compression: 5 });
  expect(readPanelSettings('SCALP 1', 'a').compression).toBe(5);
  expect(readPanelSettings('SCALP 2', 'a').compression).toBe(1);
 });
});
