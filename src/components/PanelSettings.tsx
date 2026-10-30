import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import './terminal.css';

export interface PanelSettingsValue {
  rowHeight: 18 | 22 | 26;
  compression: 1 | 2 | 5;
  period: 5 | 15 | 60;
  mode: 'VOLUME' | 'DELTA' | 'BUYSELL';
  bubbleThreshold: 0 | 50 | 200 | 500;
  bubbleLabels: 'Auto' | 'Off';
  depthScale: 'AUTO' | 500 | 2000 | 10000;
  clusterScale: 'SHARED' | 'COLUMN' | 500 | 2000 | 10000;
  showClusters: boolean;
  showBubbles: boolean;
  rememberSize: boolean;
}
export const DEFAULT_PANEL_SETTINGS: Readonly<PanelSettingsValue> = Object.freeze({
  rowHeight: 22, compression: 1, period: 15, mode: 'VOLUME', bubbleThreshold: 0,
  bubbleLabels: 'Auto', depthScale: 'AUTO', clusterScale: 'SHARED',
  showClusters: true, showBubbles: true, rememberSize: false,
});
export interface PanelSettingsProps {
  value: PanelSettingsValue;
  onChange: (value: PanelSettingsValue) => void;
  onOpenChange?: (open: boolean) => void;
}
export function PanelSettings({ value, onChange, onOpenChange }: PanelSettingsProps) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  const changeOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
    if (!next) trigger.current?.focus();
  };
  useEffect(() => {
    if (open) dialog.current?.querySelector<HTMLElement>('select, input, button')?.focus();
  }, [open]);
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); changeOpen(false); }
    if (event.key !== 'Tab') return;
    const controls = dialog.current?.querySelectorAll<HTMLElement>('select, input, button, [tabindex="0"]');
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  const select = <K extends keyof PanelSettingsValue>(key: K, label: string, options: readonly PanelSettingsValue[K][]) => (
    <label className="terminal-setting" key={key}>{label}<select aria-label={label} value={String(value[key])} onChange={event => {
      const next = options.find(option => String(option) === event.target.value);
      if (next !== undefined) onChange({ ...value, [key]: next });
    }}>{options.map(option => <option value={String(option)} key={String(option)}>{String(option)}</option>)}</select></label>
  );
  return <div className="terminal-settings">
    <button type="button" className="terminal-settings-trigger" ref={trigger} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => changeOpen(!open)}>Settings</button>
    {open && <div className="terminal-settings-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) changeOpen(false); }}>
      <div className="terminal-settings-dialog" id={id} ref={dialog} role="dialog" aria-modal="true" aria-label="Panel settings" onKeyDown={keyDown}>
        <h3>Panel settings</h3>
        {select('rowHeight', 'Row height', [18, 22, 26])}
        {select('compression', 'Compression', [1, 2, 5])}
        {select('period', 'Cluster period (seconds)', [5, 15, 60])}
        {select('mode', 'Cluster mode', ['VOLUME', 'DELTA', 'BUYSELL'])}
        {select('bubbleThreshold', 'Bubble threshold (shares)', [0, 50, 200, 500])}
        {select('bubbleLabels', 'Bubble numbers', ['Auto', 'Off'])}
        {select('depthScale', 'Depth scale', ['AUTO', 500, 2000, 10000])}
        {select('clusterScale', 'Cluster scale', ['SHARED', 'COLUMN', 500, 2000, 10000])}
        {(['showClusters', 'showBubbles', 'rememberSize'] as const).map((key, index) => <label className="terminal-setting" key={key}>{['Show clusters', 'Show bubbles', 'Remember working size'][index]}<input type="checkbox" checked={value[key]} onChange={event => onChange({ ...value, [key]: event.target.checked })} /></label>)}
        <p className="terminal-setting-help">Executed · 10s bubbles use bounded relative area, not resting depth. AUTO depth samples within 20 native ticks. Cluster scales are independent of depth.</p>
        <button type="button" onClick={() => changeOpen(false)}>Close settings</button>
      </div>
    </div>}
  </div>;
}
