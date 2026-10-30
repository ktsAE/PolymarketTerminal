import { render, fireEvent, screen, cleanup, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BookPanel } from '../../src/components/BookPanel';
import { marketStore } from '../../src/state/marketStore';
import type { Instrument, BookState, AccountStatus } from '../../src/types';
afterEach(cleanup);
function setup() {
 const instrument = { assetId: 'center', marketTitle: 'Center', outcome: 'Yes', tickSize: '0.01', minOrderSize: '1', category: 'Sports', volume24hr: 1 } as Instrument;
 const book = { assetId: 'center', bids: new Map(), asks: new Map(), bestBid: '0.50', bestAsk: '0.52', tickSize: '0.01', ready: true, recentTrades: [], bookReceivedAt: marketStore.getAnalysis('center').nowMs } as BookState;
 const props = { workspace: 'SCALP 1', instrument, book, connection: 'live' as const, accountStatus: { armed: false, maxOrderUsd: 25 } as AccountStatus, sessionOrders: [], leagueFavorite: false, focused: false, onClose: vi.fn(), onToggleLeagueFavorite: vi.fn(), onToggleFocus: vi.fn(), onOrder: vi.fn(async () => undefined), onDragStart: vi.fn(), onDrop: vi.fn() };
 const view = render(<BookPanel {...props} />);
 const ladder = view.container.querySelector('.book-ladder')!;
 const prices = () => [...view.container.querySelectorAll('.price-cell')].map(node => node.textContent);
 return { ...view, props, ladder, prices };
}
it('AUTO keeps prices stable inside the row-count deadband', () => {
 const { props, rerender, prices } = setup(); const before = prices();
 rerender(<BookPanel {...props} book={{ ...props.book, bestBid: '0.51', bestAsk: '0.53' }} />);
 expect(prices()).toEqual(before);
 rerender(<BookPanel {...props} book={{ ...props.book, bestBid: '0.60', bestAsk: '0.62' }} />);
 expect(prices()).not.toEqual(before);
});
it('accumulates trackpad wheel deltas and pans exactly three rows per notch', () => {
 const { ladder, prices } = setup(); const before = prices();
 fireEvent.wheel(ladder, { deltaY: 40 }); expect(prices()).toEqual(before);
 fireEvent.wheel(ladder, { deltaY: 60 });
 expect(prices()[0]).toBe(before[3]);
 fireEvent.keyDown(ladder, { key: 'c' }); expect(prices()).toEqual(before);
});
it('C typed in the quantity input never recenters another ladder', () => {
 const { ladder, prices } = setup(); fireEvent.wheel(ladder, { deltaY: 100 }); const before = prices();
 fireEvent.keyDown(screen.getByRole('textbox', { name: 'QTY' }), { key: 'c' });
 expect(prices()).toEqual(before);
});
it('measures the actual ladder viewport, with at least seven continuous rows', () => {
 const observers: { cb: ResizeObserverCallback; target?: Element }[] = [];
 vi.stubGlobal('ResizeObserver', class {
   record: typeof observers[number];
   constructor(cb: ResizeObserverCallback) { this.record = { cb }; observers.push(this.record); }
   observe(target: Element) { this.record.target = target; }
   disconnect() {}
 });
 const { ladder, container } = setup();
 const observer = observers.find(entry => entry.target === ladder)!;
 expect(observer).toBeDefined();
 fireEvent(ladder, new Event('resize'));
 // A native viewport of 22*19px produces 19 rows, not panel-height-minus-chrome guesses.
 act(() => observer.cb([{ contentRect: { height: 418 }, target: ladder } as ResizeObserverEntry], {} as ResizeObserver));
 expect(container.querySelectorAll('.dom-row')).toHaveLength(19);
});
