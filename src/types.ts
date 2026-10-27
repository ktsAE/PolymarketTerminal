export type ConnectionStatus = "idle" | "connecting" | "live" | "reconnecting" | "error";

export interface Instrument {
  assetId: string;
  conditionId: string;
  eventTitle: string;
  marketTitle: string;
  outcome: string;
  tickSize: string;
  minOrderSize: string;
  volume24hr: number;
}

export interface PriceLevel {
  price: string;
  size: string;
}

export interface BookState {
  assetId: string;
  bids: Map<string, string>;
  asks: Map<string, string>;
  tickSize: string;
  bestBid?: string;
  bestAsk?: string;
  lastTrade?: string;
  timestamp?: string;
  ready: boolean;
}

export interface MarketEvent {
  event_type?: string;
  asset_id?: string;
  market?: string;
  bids?: PriceLevel[];
  asks?: PriceLevel[];
  price_changes?: Array<{
    asset_id: string;
    price: string;
    size: string;
    side: "BUY" | "SELL";
    best_bid?: string;
    best_ask?: string;
  }>;
  price?: string;
  new_tick_size?: string;
  best_bid?: string;
  best_ask?: string;
  timestamp?: string;
}

export interface OrderDraft {
  assetId: string;
  marketTitle: string;
  outcome: string;
  side: "BUY" | "SELL";
  price: string;
  size: string;
  sizeUnit: "USD" | "SHARES";
  execution: "GTC" | "FAK";
  mode: "DRY";
}

export interface TerminalBridge {
  listMarkets(): Promise<Instrument[]>;
  subscribeAssets(assetIds: string[]): Promise<{ subscribed: string[] }>;
  unsubscribeAssets(assetIds: string[]): Promise<{ subscribed: string[] }>;
  submitOrder(draft: OrderDraft): Promise<OrderDraft & { status: string; createdAt: string }>;
  onMarketEvent(callback: (event: MarketEvent) => void): () => void;
  onConnectionStatus(callback: (status: ConnectionStatus) => void): () => void;
}

declare global {
  interface Window {
    polymarketTerminal?: TerminalBridge;
  }
}
