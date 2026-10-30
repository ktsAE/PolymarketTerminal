import { expect, it } from 'vitest';
import { matchesDate } from '../src/state/workspaceStore';
it('uses local calendar boundaries, including DST days, not elapsed 24-hour windows', () => {
 const now = new Date(2026, 2, 8, 23, 30);
 expect(matchesDate(new Date(2026, 2, 9, 0, 1).toISOString(), 'Tomorrow', now)).toBe(true);
 expect(matchesDate(new Date(2026, 2, 8, 0, 1).toISOString(), 'Today', now)).toBe(true);
 expect(matchesDate(new Date(2026, 2, 15).toISOString(), 'Next 7 days', now)).toBe(false);
 expect(matchesDate(undefined, 'All', now)).toBe(true);
 expect(matchesDate(undefined, 'Today', now)).toBe(false);
});
