import type { AccountStatus, AssetHealth, ConnectionStatus, Instrument, MarketEvent, OrderDraft, TerminalBridge } from '../../src/types';

// Self-contained: the offline screenshot harness serializes this factory into the renderer.
export function createTerminalFixture() {
  const now = '2026-10-28T12:00:00.000Z';
  const instruments: Instrument[] = Array.from({ length: 8 }, (_, index) => ({
    assetId: String(100000 + index), conditionId: `qa-condition-${index}`,
    eventId: String(200000 + index), eventSlug: `qa-event-${index}`,
    eventTitle: `QA fixture event ${index + 1}`, marketTitle: `QA fixture market ${index + 1}`,
    outcome: index % 2 ? 'No' : 'Yes', tickSize: '0.01', minOrderSize: '1',
    volume24hr: 100000 + index * 1000, category: 'Sports', tags: ['Sports'],
    leagueId: '90001', leagueSlug: 'nba', leagueName: 'QA League',
    startTime: '2026-10-28T14:00:00.000Z', acceptingOrders: true, closed: false,
    metadataAt: Date.parse(now),
  }));
  const events = new Set<(event: MarketEvent) => void>();
  const statuses = new Set<(status: ConnectionStatus) => void>();
  const accounts = new Set<(status: AccountStatus) => void>();
  const health = new Set<(status: AssetHealth) => void>();
  const subscribed = new Set<string>();
  const orders: OrderDraft[] = [];
  let live = 0;
  let epoch = 0;
  let generation = 0;
  const generations = new Map<string, number>();
  const forbidden = async (): Promise<never> => { live++; throw new Error('Live account/order operation forbidden in QA'); };
  const initialAccount = (): AccountStatus => ({
    connected: false, armed: false, armEpoch: 0, liveEnabled: false, maxOrderUsd: 25, closedOnly: null,
    geoblock: { blocked: null, country: '', region: '', checkedAt: null, error: 'Offline QA' },
  });
  let account = initialAccount();
  const emitEvent = (event: MarketEvent) => events.forEach(listener => listener(event));
  const emitStatus = (status: ConnectionStatus) => {
    if (status !== 'live') for (const assetId of subscribed) {
      generations.set(assetId, ++generation);
      emitHealth({ assetId, active: true, generation, tickVersion: 1, initialized: false, bookReceivedAt: null, fresh: false, tickSize: '0.01' });
    }
    statuses.forEach(listener => listener(status));
  };
  const emitHealth = (status: AssetHealth) => health.forEach(listener => listener(status));
  const emitAccount = (status: AccountStatus) => { account = status; accounts.forEach(listener => listener(status)); };
  function snapshot(assetId: string) {
    if (!subscribed.has(assetId)) return;
    const generation = generations.get(assetId)!;
    const levels = (side: number) => Array.from({ length: 20 }, (_, index) => ({
      price: (0.5 + side * (index + 1) * 0.01).toFixed(2), size: String(100 + index * 25),
    }));
    // Mirror main: registry health is delivered before the corresponding tagged raw book.
    emitHealth({ assetId, active: true, generation, tickVersion: 1, initialized: true, bookReceivedAt: Date.parse(now), fresh: true, tickSize: '0.01' });
    emitEvent({ event_type: 'book', asset_id: assetId, bids: levels(-1), asks: levels(1), timestamp: String(Date.parse(now)), generation, tickVersion: 1 } as MarketEvent);
  }
  const bridge: TerminalBridge = {
    async resolveInstruments({ assetIds }) { return assetIds.map(assetId => {
      const instrument = instruments.find(item => item.assetId === assetId);
      return instrument ? { assetId, status: 'RESOLVED' as const, instrument } : { assetId, status: 'UNAVAILABLE' as const };
    }); },
    async listLeagueMarketsPage() { return { items: instruments, nextCursor: null, completeness: 'EXHAUSTED', eventCount: instruments.length }; },
    async refreshBook({ assetId }) { snapshot(assetId); },
    async listMarkets() { return instruments; },
    async listLeagues() { return [{ id: '90001', seriesId: '90001', slug: 'nba', name: 'QA League' }]; },
    async listLeagueMarkets() { return instruments; },
    async subscribeAssets(assetIds) {
      assetIds.forEach(id => { if (!subscribed.has(id)) generations.set(id, ++generation); subscribed.add(id); });
      const token = epoch;
      queueMicrotask(() => {
        if (token !== epoch) return;
        emitStatus('live');
        assetIds.forEach(assetId => {
          if (!subscribed.has(assetId)) return;
          snapshot(assetId);
          for (let index = 0; index < 12; index++) emitEvent({
            event_type: 'last_trade_price', asset_id: assetId, price: index % 2 ? '0.49' : '0.51',
            size: String(50 + index * 40), side: index % 2 ? 'SELL' : 'BUY',
            timestamp: String(Date.parse(now) - index * 850), transaction_hash: `${assetId}-qa-${index}`,
          });
        });
      });
      return { subscribed: [...subscribed] };
    },
    async unsubscribeAssets(assetIds) { assetIds.forEach(id => subscribed.delete(id)); return { subscribed: [...subscribed] }; },
    async submitOrder(draft) {
      if (draft.mode !== 'DRY') return forbidden();
      orders.push({ ...draft });
      return { ...draft, status: 'DRY_ACCEPTED', createdAt: now };
    },
    async getAccountStatus() { return account; },
    connectAccount: forbidden, disconnectAccount: forbidden, setTradingArmed: forbidden,
    getAccountSnapshot: forbidden, cancelAllOrders: forbidden,
    onMarketEvent(callback) { events.add(callback); return () => { events.delete(callback); }; },
    onConnectionStatus(callback) { statuses.add(callback); return () => { statuses.delete(callback); }; },
    onAccountStatus(callback) { accounts.add(callback); return () => { accounts.delete(callback); }; },
    onAssetHealth(callback) { health.add(callback); return () => { health.delete(callback); }; },
  };
  return { bridge, instruments, orders, now, liveCalls: () => live, emitEvent, emitStatus, emitHealth, emitAccount,
    subscriptions: () => [...subscribed], listenerCounts: () => ({ events: events.size, statuses: statuses.size, accounts: accounts.size, health: health.size }),
    reset() { epoch++; generation = 0; generations.clear(); live = 0; orders.length = 0; subscribed.clear(); events.clear(); statuses.clear(); accounts.clear(); health.clear(); account = initialAccount(); } };
}

export const terminalFixture = createTerminalFixture();
