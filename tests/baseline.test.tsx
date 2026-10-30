import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { terminalFixture } from './fixtures/terminal';

describe('offline terminal baseline', () => {
  it('starts unarmed in DRY mode without live calls', async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll('.book-panel')).toHaveLength(2));
    expect(screen.getByText('DRY MODE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /not connected/i })).toBeInTheDocument();
    expect(terminalFixture.instruments.every(item => /^\d+$/.test(item.assetId))).toBe(true);
    expect(terminalFixture.bridge.submitOrder).not.toHaveBeenCalled();
    expect(terminalFixture.liveCalls()).toBe(0);
  });

  it('caps a restored workspace at six books when switching slots', async () => {
    const user = userEvent.setup();
    localStorage.setItem('pm-terminal:workspace:SCALP 2', JSON.stringify(terminalFixture.instruments.map(item => item.assetId)));
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelectorAll('.book-panel')).toHaveLength(2));
    await user.click(screen.getByRole('button', { name: 'SCALP 2' }));
    await waitFor(() => expect(container.querySelectorAll('.book-panel')).toHaveLength(6));
    expect(terminalFixture.liveCalls()).toBe(0);
  });

  it('maps lifting asks to BUY and hitting bids to SELL, always DRY', async () => {
    const user = userEvent.setup();
    render(<App />);
    const asks = await screen.findAllByTitle(/^Lift ask: BUY/);
    await user.click(asks[0]);
    await waitFor(() => expect(terminalFixture.bridge.submitOrder).toHaveBeenLastCalledWith(expect.objectContaining({ side: 'BUY', mode: 'DRY' })));
    const bids = screen.getAllByTitle(/^Hit bid: SELL/);
    await user.click(bids[0]);
    await waitFor(() => expect(terminalFixture.bridge.submitOrder).toHaveBeenLastCalledWith(expect.objectContaining({ side: 'SELL', mode: 'DRY' })));
    expect(terminalFixture.liveCalls()).toBe(0);
  });
});
