import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BookPanel } from '../../src/App';
import { marketStore } from '../../src/state/marketStore';
import type { Instrument, BookState, AccountStatus } from '../../src/types';
afterEach(cleanup);
beforeEach(() => localStorage.clear());
const instrument = { assetId: 'a', marketTitle: 'Test', outcome: 'Yes', tickSize: '0.01', minOrderSize: '1', category: 'Sports', volume24hr: 1, tags: [] } as unknown as Instrument;
const accountStatus = { armed: false, maxOrderUsd: 25, armEpoch: 1 } as AccountStatus;
const book = () => ({ assetId: 'a', bids: new Map([['0.50','10']]), asks: new Map([['0.51','10']]), bestBid: '0.50', bestAsk: '0.51', tickSize: '0.01', ready: true, recentTrades: [], bookReceivedAt: marketStore.getAnalysis('a').nowMs, generation: 1, tickVersion: 1 } as BookState);
function setup(value = book()) {
 const onOrder = vi.fn(async () => undefined);
 const props = { workspace: 'SCALP 1', instrument, book: value, connection: 'live' as const, accountStatus, sessionOrders: [], leagueFavorite: false, focused: false, onClose: vi.fn(), onToggleLeagueFavorite: vi.fn(), onToggleFocus: vi.fn(), onOrder, onDragStart: vi.fn(), onDrop: vi.fn() };
 const view = render(<BookPanel {...props} />);
 return { onOrder, props, ...view };
}
it('compressed clicks zoom only and require a second exact click', () => {
 const { onOrder } = setup(); fireEvent.click(screen.getByText('2T'));
 fireEvent.click(screen.getAllByTitle(/^Rest BUY/)[0]);
 expect(onOrder).not.toHaveBeenCalled();
 expect(screen.getByRole('status').textContent).toContain('Choose an exact price');
 fireEvent.click(screen.getAllByTitle(/^Rest BUY/)[0]);
 expect(onOrder).toHaveBeenCalledTimes(1);
});
it('stale snapshots disable order controls and expose Refresh', () => {
 const { onOrder } = setup({ ...book(), bookReceivedAt: marketStore.getAnalysis('a').nowMs - 11000 });
 fireEvent.click(screen.getAllByTitle(/^Rest BUY/)[0]);
 expect(onOrder).not.toHaveBeenCalled();
 expect(screen.getByRole('button', { name: 'Refresh book' })).toBeDefined();
});
it.each(['0.1', '0.01', '0.001', '0.0001'])('renders native %s ticks and submits exact probability units', async tickSize => {
 const { onOrder, container } = setup({ ...book(), tickSize });
 expect(container.querySelectorAll('.dom-row').length).toBeGreaterThanOrEqual(7);
 fireEvent.click(screen.getAllByTitle(/^Rest BUY/)[0]);
 const draft = onOrder.mock.calls[0]?.[0] as unknown as { price: string; mode: string };
 expect(Number(draft.price)).toBeGreaterThan(0);
 expect(Number(draft.price)).toBeLessThan(1);
 expect(draft.mode).toBe('DRY');
 await act(async () => {});
});
it('a pointer gesture cannot be promoted from DRY to LIVE by an arm update', () => {
 const { onOrder, props, rerender } = setup();
 const lane = screen.getAllByTitle(/^Rest BUY/)[0];
 fireEvent.pointerDown(lane, { button: 0, pointerId: 1 });
 rerender(<BookPanel {...props} accountStatus={{ ...accountStatus, armed: true, liveEnabled: true, armEpoch: 2 }} />);
 fireEvent.pointerUp(lane, { pointerId: 1 }); fireEvent.click(lane);
 expect(onOrder).not.toHaveBeenCalled();
});
it('generation, layout and settings changes invalidate captured gestures', () => {
 const { onOrder, props, rerender } = setup();
 const lane = screen.getAllByTitle(/^Rest BUY/)[0];
 fireEvent.pointerDown(lane, { button: 0, pointerId: 1 });
 rerender(<BookPanel {...props} book={{ ...props.book, generation: 2 }} layoutGeneration="new-layout" />);
 fireEvent.pointerUp(lane, { pointerId: 1 }); fireEvent.click(lane);
 expect(onOrder).not.toHaveBeenCalled();
});
it('Enter and Space do not submit repeated keydown events', () => {
 const { onOrder } = setup(); const lane = screen.getAllByTitle(/^Rest BUY/)[0];
 fireEvent.keyDown(lane, { key: 'Enter', repeat: true });
 expect(onOrder).not.toHaveBeenCalled();
 fireEvent.keyDown(lane, { key: ' ', repeat: false });
 fireEvent.keyDown(lane, { key: ' ', repeat: true });
 expect(onOrder).toHaveBeenCalledTimes(1);
});
it('depth clicks submit FAK at the exact ask, without synthesizing fills', () => {
 const { onOrder } = setup();
 fireEvent.click(screen.getByTitle(/^Lift ask/));
 expect(onOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY', execution: 'FAK', price: '0.51', size: '10', mode: 'DRY' }));
});
it('cluster visibility removes actual dynamic columns', () => {
 const { container } = setup();
 expect(container.querySelectorAll('.cluster-heading')).toHaveLength(3);
 fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
 fireEvent.click(screen.getByRole('checkbox', { name: 'Show clusters' }));
 expect(container.querySelectorAll('.cluster-heading')).toHaveLength(0);
 expect(container.querySelectorAll('.cluster-cell')).toHaveLength(0);
});
