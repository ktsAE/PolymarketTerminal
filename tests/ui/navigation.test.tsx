import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MarketNavigator } from '../../src/components/MarketNavigator';
import type { Instrument, TerminalBridge } from '../../src/types';
afterEach(cleanup);
const items = Array.from({ length: 65 }, (_, i) => ({ assetId: `a${i}`, conditionId: `c${i}`, eventId: i < 25 ? 'event0' : `event${i}`, eventTitle: i < 25 ? 'Game zero' : `Game ${i}`, marketTitle: `Market ${i}`, outcome: 'Yes', leagueId: i === 64 ? 'other' : 'nba', tags: [], volume24hr: 1 } as Instrument));
function setup(favorites = new Set<string>()) {
 const onOpen = vi.fn();
 render(<MarketNavigator bridge={{ listLeagueMarketsPage: vi.fn(async () => ({ items: [], completeness: 'EXHAUSTED', nextCursor: null, eventCount: 0 })) } as unknown as TerminalBridge} instruments={items} leagues={[{ seriesId: 'nba', name: 'NBA', slug: 'nba' }]} favoriteIds={favorites} recentIds={['a64']} openIds={[]} filters={{ date: 'All', marketType: 'all' }} onFilters={vi.fn()} onItems={vi.fn()} onOpen={onOpen} onFavorite={vi.fn()} onClearRecent={vi.fn()} />);
 return onOpen;
}
it('pages once at a time, retries the same cursor and caches completed league loads', async () => {
 const onItems = vi.fn();
 let finish!: (page: unknown) => void;
 const listPage = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ items: [items[25]], nextCursor: null, completeness: 'EXHAUSTED', eventCount: 1 });
 render(<MarketNavigator bridge={{ listLeagueMarketsPage: listPage } as unknown as TerminalBridge} instruments={[]} leagues={[{ id: 'nba', seriesId: 'nba', name: 'NBA', slug: 'nba' }]} favoriteIds={new Set()} recentIds={[]} openIds={[]} filters={{ date: 'All', marketType: 'all' }} onFilters={vi.fn()} onItems={onItems} onOpen={vi.fn()} onFavorite={vi.fn()} onClearRecent={vi.fn()} />);
 fireEvent.click(screen.getByText('NBA')); fireEvent.click(screen.getByText('NBA'));
 expect(listPage).toHaveBeenCalledTimes(1);
 await act(async () => finish({ items: [items[0]], nextCursor: 'page2', completeness: 'MORE', eventCount: 1 }));
 fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
 await screen.findByText('offline');
 fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
 await screen.findByText('All available pages loaded');
 expect(listPage.mock.calls.map(call => call[0])).toEqual([{ seriesId: 'nba' }, { seriesId: 'nba', cursor: 'page2' }, { seriesId: 'nba', cursor: 'page2' }]);
 fireEvent.click(screen.getByText('NBA')); fireEvent.click(screen.getByText('NBA'));
 expect(listPage).toHaveBeenCalledTimes(3);
 expect(onItems).toHaveBeenCalledTimes(2);
});
it('resolves unknown recent IDs through the bridge and clears only local recents', async () => {
 const resolve = vi.fn(async () => [{ assetId: 'unknown', status: 'RESOLVED', instrument: { ...items[0], assetId: 'unknown' } }]);
 const onItems = vi.fn(); const clear = vi.fn();
 render(<MarketNavigator bridge={{ resolveInstruments: resolve } as unknown as TerminalBridge} instruments={[]} leagues={[]} favoriteIds={new Set()} recentIds={['unknown']} openIds={[]} filters={{ date: 'All', marketType: 'all' }} onFilters={vi.fn()} onItems={onItems} onOpen={vi.fn()} onFavorite={vi.fn()} onClearRecent={clear} />);
 fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
 await waitFor(() => expect(onItems).toHaveBeenCalledWith([expect.objectContaining({ assetId: 'unknown' })]));
 expect(resolve).toHaveBeenCalledWith({ assetIds: ['unknown'] });
 fireEvent.click(screen.getByRole('button', { name: 'Clear recent (local)' }));
 expect(clear).toHaveBeenCalledTimes(1);
});
it('explicitly reveals more than twenty events and markets and fifty results', async () => {
 setup();
 await screen.findByText('Game zero');
 fireEvent.click(screen.getByText('Game zero'));
 expect(screen.queryByText('Market 24')).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'Show 20 more markets' }));
 expect(screen.getByText('Market 24')).toBeDefined();
 expect(screen.queryByText('Game 63')).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'Show 20 more events' }));
 expect(screen.getByText('Game 63')).toBeDefined();
 fireEvent.change(screen.getByPlaceholderText('Search loaded markets'), { target: { value: 'Market' } });
 const results = screen.getByRole('region', { name: 'Loaded search results' });
 expect(within(results).getAllByRole('button', { name: 'Open book' })).toHaveLength(50);
 fireEvent.click(within(results).getByRole('button', { name: 'Show more' }));
 expect(within(results).getAllByRole('button', { name: 'Open book' })).toHaveLength(65);
});
it('scopes favorite and recent queries, with no order action on match selection', () => {
 const open = setup(new Set(['nba']));
 fireEvent.click(screen.getByRole('button', { name: /Favorites/ }));
 fireEvent.change(screen.getByPlaceholderText('Search loaded markets'), { target: { value: 'Market 64' } });
 expect(screen.queryByRole('button', { name: 'Open book' })).toBeNull();
 fireEvent.click(screen.getByRole('button', { name: 'Recent' }));
 fireEvent.click(screen.getByRole('button', { name: /Show in context/ }));
 expect(open).not.toHaveBeenCalled();
 expect(screen.getByText('Game 64')).toBeDefined();
});
