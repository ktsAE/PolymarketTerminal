import type { Instrument, MarketEvent, OrderDraft, TerminalBridge } from "./types";

const instruments: Instrument[] = [
  {
    assetId: "10001",
    conditionId: "demo-1",
    eventTitle: "Will the Fed cut rates at the next meeting?",
    marketTitle: "Fed rate cut at the next meeting?",
    outcome: "Yes",
    tickSize: "0.01",
    minOrderSize: "5",
    volume24hr: 2_430_000,
  },
  {
    assetId: "10002",
    conditionId: "demo-1",
    eventTitle: "Will the Fed cut rates at the next meeting?",
    marketTitle: "Fed rate cut at the next meeting?",
    outcome: "No",
    tickSize: "0.01",
    minOrderSize: "5",
    volume24hr: 2_430_000,
  },
  {
    assetId: "10003",
    conditionId: "demo-2",
    eventTitle: "Will BTC trade above $150k this year?",
    marketTitle: "BTC above $150k this year?",
    outcome: "Yes",
    tickSize: "0.01",
    minOrderSize: "5",
    volume24hr: 1_280_000,
  },
  {
    assetId: "10004",
    conditionId: "demo-3",
    eventTitle: "Will the next major AI model launch before December?",
    marketTitle: "Major AI model launch before December?",
    outcome: "Yes",
    tickSize: "0.01",
    minOrderSize: "5",
    volume24hr: 860_000,
  },
];

const listeners = new Set<(event: MarketEvent) => void>();
const statusListeners = new Set<(status: "live") => void>();

function levels(mid: number) {
  return {
    bids: Array.from({ length: 9 }, (_, index) => ({
      price: (mid - 0.01 * (index + 1)).toFixed(2),
      size: String(Math.round(70 + Math.random() * 850)),
    })),
    asks: Array.from({ length: 9 }, (_, index) => ({
      price: (mid + 0.01 * (index + 1)).toFixed(2),
      size: String(Math.round(70 + Math.random() * 850)),
    })),
  };
}

export const demoBridge: TerminalBridge = {
  async listMarkets() {
    return instruments;
  },
  async subscribeAssets(assetIds) {
    queueMicrotask(() => {
      statusListeners.forEach((listener) => listener("live"));
      assetIds.forEach((assetId, index) => {
        const snapshot = levels(0.48 + index * 0.04);
        listeners.forEach((listener) =>
          listener({
            event_type: "book",
            asset_id: assetId,
            ...snapshot,
            timestamp: String(Date.now()),
          }),
        );
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
