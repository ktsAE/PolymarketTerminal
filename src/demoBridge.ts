import type { AccountStatus, Instrument, MarketEvent, MarketLeague, OrderDraft, TerminalBridge } from "./types";

const disconnectedStatus: AccountStatus = {
  connected: false,
  armed: false,
  maxOrderUsd: 25,
  closedOnly: null,
  geoblock: { blocked: null, country: "", region: "", checkedAt: null, error: "Desktop only" },
};

const instruments: Instrument[] = [
  {
    assetId: "10001",
    conditionId: "demo-1",
    eventId: "demo-event-1",
    eventSlug: "fed-rate-cut-demo",
    eventTitle: "Will the Fed cut rates at the next meeting?",
    marketTitle: "Fed rate cut at the next meeting?",
    outcome: "Yes",
    tickSize: "0.01",
    minOrderSize: "5",
    volume24hr: 2_430_000,
    category: "Economy",
    tags: ["Economy", "Fed"],
  },
  {
    assetId: "10002",
    conditionId: "demo-1",
    eventId: "demo-event-1",
    eventSlug: "fed-rate-cut-demo",
    eventTitle: "Will the Fed cut rates at the next meeting?",
    marketTitle: "Fed rate cut at the next meeting?",
    outcome: "No",
    tickSize: "0.01",
    minOrderSize: "5",
    volume24hr: 2_430_000,
    category: "Economy",
    tags: ["Economy", "Fed"],
  },
  {
    assetId: "10003",
    conditionId: "demo-2",
    eventId: "demo-event-2",
    eventSlug: "btc-150k-demo",
    eventTitle: "Will BTC trade above $150k this year?",
    marketTitle: "BTC above $150k this year?",
    outcome: "Yes",
    tickSize: "0.01",
    minOrderSize: "5",
    volume24hr: 1_280_000,
    category: "Crypto",
    tags: ["Crypto", "Bitcoin"],
  },
  {
    assetId: "10004",
    conditionId: "demo-3",
    eventId: "demo-event-3",
    eventSlug: "ai-launch-demo",
    eventTitle: "Will the next major AI model launch before December?",
    marketTitle: "Major AI model launch before December?",
    outcome: "Yes",
    tickSize: "0.01",
    minOrderSize: "5",
    volume24hr: 860_000,
    category: "Tech & AI",
    tags: ["Tech", "AI"],
  },
  {
    assetId: "10005",
    conditionId: "demo-4",
    eventId: "demo-event-4",
    eventSlug: "nba-bos-bkn-demo",
    eventTitle: "Boston Celtics vs. Brooklyn Nets",
    marketTitle: "Celtics vs. Nets",
    outcome: "Celtics",
    tickSize: "0.01",
    minOrderSize: "5",
    volume24hr: 740_000,
    category: "Sports",
    tags: ["Sports", "Basketball", "NBA"],
    leagueId: "10345",
    leagueSlug: "nba",
    leagueName: "NBA",
    startTime: new Date(Date.now() + 5_400_000).toISOString(),
    sportsMarketType: "moneyline",
  },
  {
    assetId: "10006",
    conditionId: "demo-5",
    eventId: "demo-event-5",
    eventSlug: "election-demo",
    eventTitle: "Will the leading candidate win the next election?",
    marketTitle: "Leading candidate wins the next election?",
    outcome: "Yes",
    tickSize: "0.01",
    minOrderSize: "5",
    volume24hr: 690_000,
    category: "Politics",
    tags: ["Politics", "Election"],
  },
];

const leagues: MarketLeague[] = [
  { id: "34", slug: "nba", name: "NBA", seriesId: "10345", primaryTagId: "745", ordering: "away" },
  { id: "10", slug: "nfl", name: "NFL", seriesId: "12185", primaryTagId: "450", ordering: "away" },
  { id: "2", slug: "epl", name: "Premier League", seriesId: "10188", primaryTagId: "306", ordering: "home" },
];

const listeners = new Set<(event: MarketEvent) => void>();
const statusListeners = new Set<(status: "live") => void>();

function levels(mid: number) {
  return {
    bids: Array.from({ length: 28 }, (_, index) => ({
      price: (mid - 0.01 * (index + 1)).toFixed(2),
      size: String(Math.round(70 + Math.random() * 850)),
    })).filter((level) => Number(level.price) > 0),
    asks: Array.from({ length: 28 }, (_, index) => ({
      price: (mid + 0.01 * (index + 1)).toFixed(2),
      size: String(Math.round(70 + Math.random() * 850)),
    })).filter((level) => Number(level.price) < 1),
  };
}

export const demoBridge: TerminalBridge = {
  async listMarkets() {
    return instruments;
  },
  async listLeagues() {
    return leagues;
  },
  async listLeagueMarkets(seriesId) {
    return instruments.filter((instrument) => instrument.leagueId === seriesId);
  },
  async subscribeAssets(assetIds) {
    queueMicrotask(() => {
      statusListeners.forEach((listener) => listener("live"));
      assetIds.forEach((assetId, index) => {
        const mid = 0.48 + index * 0.04;
        const snapshot = levels(mid);
        listeners.forEach((listener) =>
          listener({
            event_type: "book",
            asset_id: assetId,
            ...snapshot,
            timestamp: String(Date.now()),
          }),
        );
        [
          { side: "BUY" as const, size: "46", offset: 0.01 },
          { side: "SELL" as const, size: "128", offset: -0.01 },
          { side: "BUY" as const, size: "360", offset: 0.01 },
          { side: "BUY" as const, size: "84", offset: 0.02 },
          { side: "SELL" as const, size: "215", offset: -0.01 },
          { side: "BUY" as const, size: "52", offset: 0 },
          { side: "SELL" as const, size: "620", offset: -0.02 },
          { side: "BUY" as const, size: "175", offset: 0.01 },
          { side: "SELL" as const, size: "96", offset: -0.01 },
          { side: "BUY" as const, size: "410", offset: 0.02 },
        ].forEach((trade, tradeIndex) => {
          listeners.forEach((listener) =>
            listener({
              event_type: "last_trade_price",
              asset_id: assetId,
              price: (mid + trade.offset).toFixed(2),
              size: trade.size,
              side: trade.side,
              timestamp: String(Date.now() - tradeIndex * 850),
              transaction_hash: `demo-${assetId}-${tradeIndex}`,
            }),
          );
        });
      });
    });
    return { subscribed: assetIds };
  },
  async unsubscribeAssets() {
    return { subscribed: [] };
  },
  async submitOrder(draft: OrderDraft) {
    return { ...draft, status: "DRY_ACCEPTED", createdAt: new Date().toISOString() };
  },
  async getAccountStatus() {
    return disconnectedStatus;
  },
  async connectAccount() {
    throw new Error("Private-key login is available only in the Electron desktop app");
  },
  async disconnectAccount() {
    return disconnectedStatus;
  },
  async setTradingArmed() {
    throw new Error("Live trading is available only in the Electron desktop app");
  },
  async getAccountSnapshot() {
    throw new Error("Connect an account in the Electron desktop app");
  },
  async cancelAllOrders() {
    return { canceled: [], status: "DEMO" };
  },
  onMarketEvent(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },
  onConnectionStatus(callback) {
    const typedCallback = callback as (status: "live") => void;
    statusListeners.add(typedCallback);
    return () => statusListeners.delete(typedCallback);
  },
};
