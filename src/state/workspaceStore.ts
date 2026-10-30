import { DEFAULT_PANEL_SETTINGS, type PanelSettingsValue } from '../components/PanelSettings';
export type Columns = 'AUTO' | '1' | '2' | '3';
export const DATE_FILTERS = ['All', 'Today', 'Tomorrow', 'Next 7 days'] as const;
export type DateFilter = typeof DATE_FILTERS[number];
export interface DiscoveryFilters { date: DateFilter; marketType: string }
export const DEFAULT_FILTERS: DiscoveryFilters = { date: 'All', marketType: 'all' };
export interface Workspace { version: 2; assetIds: string[]; layout: Columns; filters: DiscoveryFilters }
const key = (slot: string) => `pm-terminal:v2:workspace:${slot}`;
export function storageGet(key: string): string | null { try { return localStorage.getItem(key); } catch (error) { console.warn('Workspace storage unavailable', error); return null; } }
export function storageSet(key: string, value: string) { try { localStorage.setItem(key, value); } catch (error) { console.warn('Workspace storage unavailable', error); } }
function parse(key: string): unknown { try { return JSON.parse(storageGet(key) ?? 'null'); } catch { return null; } }
const ids = (value: unknown[]) => [...new Set(value.filter((id): id is string => typeof id === 'string' && id.length > 0))].slice(0, 6);
const columns = (value: unknown): Columns => value === '1' || value === '2' || value === '3' ? value : 'AUTO';
function filters(value: unknown): DiscoveryFilters {
 const v = value as Partial<DiscoveryFilters> | null;
 return { date: DATE_FILTERS.includes(v?.date as DateFilter) ? v!.date! : 'All', marketType: typeof v?.marketType === 'string' && v.marketType.length < 100 ? v.marketType : 'all' };
}
export function matchesDate(value: string | undefined, filter: DateFilter, now = new Date()): boolean {
 if (filter === 'All') return true;
 const time = value ? new Date(value).getTime() : NaN;
 const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
 const end = new Date(start);
 if (filter === 'Tomorrow') start.setDate(start.getDate() + 1);
 end.setDate(end.getDate() + (filter === 'Next 7 days' ? 7 : filter === 'Tomorrow' ? 2 : 1));
 return Number.isFinite(time) && time >= start.getTime() && time < end.getTime();
}
export function readWorkspace(slot: string): Workspace | null {
 const saved = parse(key(slot)) as Workspace | null;
 if (saved?.version === 2 && Array.isArray(saved.assetIds)) return { version: 2, assetIds: ids(saved.assetIds), layout: columns(saved.layout), filters: filters(saved.filters) };
 const legacy = parse(`pm-terminal:workspace:${slot}`) ?? (slot === 'SCALP 1' ? parse('pm-terminal:open-instruments') : null);
 if (!Array.isArray(legacy)) return null;
 const value: Workspace = { version: 2, assetIds: ids(legacy), layout: columns(storageGet(`pm-terminal:workspace:${slot}:layout`)), filters: { ...DEFAULT_FILTERS } };
 saveWorkspace(slot, value.assetIds, value.layout, value.filters);
 return value;
}
export function saveWorkspace(slot: string, assetIds: string[], layout: Columns, discovery: DiscoveryFilters = DEFAULT_FILTERS) {
 storageSet(key(slot), JSON.stringify({ version: 2, assetIds: ids(assetIds), layout: columns(layout), filters: filters(discovery) }));
}
const panelKey = (slot: string, asset: string) => `${key(slot)}:panel:${asset}`;
const options: Record<keyof PanelSettingsValue, readonly unknown[]> = {
 rowHeight: [18,22,26], compression: [1,2,5], period: [5,15,60], mode: ['VOLUME','DELTA','BUYSELL'], bubbleThreshold: [0,50,200,500], bubbleLabels: ['Auto','Off'], depthScale: ['AUTO',500,2000,10000], clusterScale: ['SHARED','COLUMN',500,2000,10000], showClusters: [true,false], showBubbles: [true,false], rememberSize: [true,false],
};
function validatePanel(value: unknown): PanelSettingsValue {
 const result = { ...DEFAULT_PANEL_SETTINGS };
 if (value && typeof value === 'object') for (const name of Object.keys(options) as (keyof PanelSettingsValue)[]) {
  const v = (value as Record<string, unknown>)[name];
  if (options[name].includes(v)) Object.assign(result, { [name]: v });
 }
 return result;
}
export function readPanelSettings(slot: string, asset: string): PanelSettingsValue { return validatePanel(parse(panelKey(slot, asset))); }
export function savePanelSettings(slot: string, asset: string, value: PanelSettingsValue) { storageSet(panelKey(slot, asset), JSON.stringify(validatePanel(value))); }
