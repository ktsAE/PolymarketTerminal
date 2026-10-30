import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/App';
import { marketStore } from '../../src/state/marketStore';
import { terminalFixture as fixture } from '../fixtures/terminal';

async function settle(assertion: () => void) {
  // Bounded virtual-time polling: also flush React effects and bridge microtasks.
  for (let attempt = 0; attempt < 20; attempt++) {
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    try { assertion(); return; } catch (error) { if (attempt === 19) throw error; }
  }
}

async function ready() {
  const result = render(<App />);
  await settle(() => expect(result.container.querySelectorAll('.book-panel')).toHaveLength(2));
  await settle(() => expect(screen.getAllByTitle(/^Lift ask: BUY/).some(button => !(button as HTMLButtonElement).disabled)).toBe(true));
  return result;
}

describe('terminal integration regressions (offline only)', () => {
  beforeEach(() => {
    // Own the publication/idle clock rather than racing real 50/250ms timers
    // against concurrently running suites while Date itself is frozen.
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date(fixture.now));
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(fixture.now));
    // RTL's user-event async wrapper detects fake timers through the Jest API;
    // expose just that compatibility hook so its final zero-delay drain can run.
    vi.stubGlobal('jest', { advanceTimersByTime: vi.advanceTimersByTime });
  });
  it('boots PUBLIC/DRY, consumes authoritative health, and releases subscriptions on unmount', async () => {
    const { unmount } = await ready();
    expect(screen.getByText('PUBLIC')).toBeInTheDocument();
    expect(screen.getByText('DRY MODE')).toBeInTheDocument();
    expect(fixture.subscriptions()).toHaveLength(2);
    const id = fixture.subscriptions()[0];
    expect(marketStore.getBook(id)).toMatchObject({ ready: true, generation: fixture.instruments.findIndex(item => item.assetId === id) + 1, tickVersion: 1, bookReceivedAt: Date.parse(fixture.now) });
    expect(fixture.listenerCounts()).toEqual({ events: 1, statuses: 1, accounts: 1, health: 1 });
    unmount();
    await settle(() => expect(fixture.subscriptions()).toEqual([]));
    expect(fixture.listenerCounts()).toEqual({ events: 0, statuses: 0, accounts: 0, health: 0 });
    expect(fixture.liveCalls()).toBe(0);
  });

  it('compressed depth click expands to native ticks without submitting an order', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { container } = await ready();
    const panel = container.querySelector('.book-panel') as HTMLElement;
    await user.click(within(panel).getByRole('button', { name: 'Settings' }));
    await user.selectOptions(screen.getByLabelText('Compression'), '2');
    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    const ask = within(panel).getAllByTitle(/^Lift ask: BUY/).find(button => !(button as HTMLButtonElement).disabled)!;
    await user.click(ask);
    expect(fixture.bridge.submitOrder).not.toHaveBeenCalled();
    await user.click(within(panel).getByRole('button', { name: 'Settings' }));
    expect(screen.getByLabelText('Compression')).toHaveValue('1');
    expect(fixture.liveCalls()).toBe(0);
  });

  it('disconnect invalidates readiness; trade-only replay cannot re-enable orders, refresh can', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { container } = await ready();
    const panel = container.querySelector('.book-panel') as HTMLElement;
    const assetId = fixture.subscriptions()[0];
    act(() => { fixture.emitStatus('reconnecting'); fixture.emitStatus('live'); fixture.emitEvent({ event_type: 'last_trade_price', asset_id: assetId, price: '0.51', size: '100', side: 'BUY', timestamp: String(Date.now()), transaction_hash: 'reconnect-trade' }); });
    await settle(() => expect(marketStore.getBook(assetId)?.ready).toBe(false));
    // Store reads are synchronous; React observes the immutable map at the next
    // throttled publication. Assert the rendered safety state, not the old DOM.
    await settle(() => expect(within(panel).getAllByTitle(/^Lift ask: BUY/).every(button => (button as HTMLButtonElement).disabled)).toBe(true));
    await user.click(within(panel).getByRole('button', { name: 'Refresh book' }));
    await settle(() => expect(marketStore.getBook(assetId)?.ready).toBe(true));
    expect(fixture.bridge.submitOrder).not.toHaveBeenCalled();
    expect(fixture.liveCalls()).toBe(0);
  });

  it('records session submissions as accepted, never fills, and clears DRY locally', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { container } = await ready();
    await user.click(screen.getAllByTitle(/^Lift ask: BUY/).find(button => !(button as HTMLButtonElement).disabled)!);
    await settle(() => expect(fixture.orders).toHaveLength(1));
    expect(fixture.orders[0]).toMatchObject({ mode: 'DRY', side: 'BUY', tickVersion: 1 });
    expect(fixture.orders[0].requestId).toEqual(expect.any(String));
    await user.click(container.querySelector('.dock-toggle') as HTMLElement);
    expect(screen.getByText(/Accepted is not a fill/)).toBeInTheDocument();
    expect(container.querySelectorAll('.orders-table > div:not(.dock-empty)')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Clear DRY local' }));
    expect(container.querySelectorAll('.orders-table > div:not(.dock-empty)')).toHaveLength(0);
    expect(fixture.liveCalls()).toBe(0);
  });

  it('retains ambiguous same-hash public prints with approximate aggregates, never session orders', async () => {
    await ready();
    const assetId = fixture.subscriptions()[0];
    expect(marketStore.getAnalysis(assetId).nowMs).toBe(Date.parse(fixture.now));
    const trade = { event_type: 'last_trade_price', asset_id: assetId, price: '0.51', size: '123', side: 'BUY' as const, timestamp: String(Date.now()), transaction_hash: 'qa-replay-unique' };
    const project = () => marketStore.getAnalysis(assetId).clusters.project({ nowMs: Date.now(), intervalSeconds: 5, tickUnits: 10000 });
    const total = () => project().reduce((sum, bucket) => sum + bucket.rows.reduce((n, row) => n + row.total, 0n), 0n);
    const before = total();
    act(() => { fixture.emitEvent(trade); fixture.emitEvent(trade); });
    const executions = marketStore.getAnalysis(assetId).executions.filter(item => item.transactionHash === trade.transaction_hash);
    expect(executions).toHaveLength(2);
    expect(executions.every(item => item.identity === 'AMBIGUOUS' && item.id === undefined)).toBe(true);
    expect(total() - before).toBe(246000000n);
    expect(project().find(bucket => bucket.startMs === Date.now())?.quality.approximate).toBe(true);
    expect(fixture.orders).toEqual([]);
    expect(fixture.bridge.submitOrder).not.toHaveBeenCalled();
    expect(fixture.liveCalls()).toBe(0);
  });

  it('denies live submission and every account mutation at the fixture boundary', async () => {
    await expect(fixture.bridge.submitOrder({ assetId: fixture.instruments[0].assetId, marketTitle: 'QA', outcome: 'Yes', side: 'BUY', price: '0.5', size: '1', sizeUnit: 'SHARES', execution: 'GTC', mode: 'LIVE' })).rejects.toThrow(/forbidden/);
    for (const operation of [() => fixture.bridge.connectAccount({ privateKey: 'not-a-key' }), () => fixture.bridge.disconnectAccount(), () => fixture.bridge.setTradingArmed(true), () => fixture.bridge.getAccountSnapshot(), () => fixture.bridge.cancelAllOrders()]) await expect(operation()).rejects.toThrow(/forbidden/);
    expect(fixture.orders).toEqual([]);
    expect(fixture.liveCalls()).toBe(6);
  });
});
