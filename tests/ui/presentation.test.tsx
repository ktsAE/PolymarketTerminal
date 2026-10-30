import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelSettings, DEFAULT_PANEL_SETTINGS } from '../../src/components/PanelSettings';
import { ExecutedBubble } from '../../src/components/ExecutedBubble';
import { ClusterCell } from '../../src/components/ClusterColumns';

afterEach(cleanup);
describe('panel settings', () => {
  it('opens an accessible dialog, traps focus and returns focus on Escape', () => {
    const onChange = vi.fn();
    render(<PanelSettings value={DEFAULT_PANEL_SETTINGS} onChange={onChange} />);
    const trigger = screen.getByRole('button', { name: 'Settings' });
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Panel settings' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    const close = screen.getByRole('button', { name: 'Close settings' });
    close.focus();
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Row height'));
    fireEvent.change(screen.getByLabelText('Compression'), { target: { value: '5' } });
    expect(onChange).toHaveBeenCalledWith({ ...DEFAULT_PANEL_SETTINGS, compression: 5 });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
describe('executed bubbles', () => {
  it('splits unequal directions including unknown and describes all values', () => {
    render(<ExecutedBubble buy="60.5" sell="20" unknown="19.5" scale={100} rowHeight={22} count={4} coverage="PARTIAL" />);
    const bubble = screen.getByRole('img');
    expect(bubble.getAttribute('aria-label')).toContain('Executed · 10s');
    expect(bubble.getAttribute('aria-label')).toContain('BUY 60.5');
    expect(bubble.getAttribute('style')).toContain('60.5%');
    expect(bubble.getAttribute('style')).toContain('80.5%');
    expect(bubble.textContent).toBe('100');
  });
  it('hides tiny labels and does not draw empty intervals', () => {
    const { rerender } = render(<ExecutedBubble buy={1} sell={0} scale={1000} rowHeight={18} />);
    expect(screen.getByRole('img').textContent).toBe('');
    rerender(<ExecutedBubble buy={0} sell={0} scale={1000} rowHeight={18} />);
    expect(screen.queryByRole('img')).toBeNull();
  });
});
describe('cluster cells', () => {
  it('does not imply numeric zero when history is unavailable', () => {
    render(<ClusterCell buy={0} sell={0} mode="VOLUME" scale={1} unavailable coverage="UNAVAILABLE" />);
    expect(screen.getByRole('cell').getAttribute('aria-label')).not.toContain('total 0');
    expect(screen.getByRole('cell').textContent).toBe('—');
  });
  it('shows known delta with unknown warning and independent normalization', () => {
    render(<ClusterCell buy="60" sell="20" unknown="10" mode="DELTA" scale={200} poc coverage="GAP" />);
    const cell = screen.getByRole('cell');
    expect(cell.textContent).toBe('+40*');
    expect(cell.getAttribute('data-direction')).toBe('buy');
    expect(cell.getAttribute('data-poc')).toBe('true');
    expect(cell.getAttribute('aria-label')).toContain('UNKNOWN 10');
    expect(cell.getAttribute('aria-label')).toContain('GAP');
    expect(cell.getAttribute('style')).toContain('20%');
  });
});
