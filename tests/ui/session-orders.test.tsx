import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionOrders } from '../../src/components/SessionOrders';
afterEach(cleanup);
it('distinguishes session acceptance from working orders and fills', () => {
 const clear = vi.fn(); render(<SessionOrders onClearDry={clear} />);
 expect(screen.getByText(/Accepted is not a fill/)).toBeDefined();
 fireEvent.click(screen.getByRole('button', { name: 'Clear DRY local' })); expect(clear).toHaveBeenCalledOnce();
});
