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
  category: string;
  tags: string[];
}

export interface PriceLevel {
  price: string;
  size: string;
}

export interface TradePrint {
  id: string;
  price: string;
  size: string;
  side: "BUY" | "SELL";
  timestamp: string;
}

export interface BookState {
  assetId: string;
  bids: Map<string, string>;
  asks: Map<string, string>;
  tickSize: string;
  bestBid?: string;
  bestAsk?: string;
  lastTrade?: string;
  lastTradeSize?: string;
  lastTradeSide?: "BUY" | "SELL";
  recentTrades: TradePrint[];
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
  size?: string;
  side?: "BUY" | "SELL";
  transaction_hash?: string;
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
  mode: "DRY" | "LIVE";
}

export interface GeoblockStatus {
  blocked: boolean | null;
  country: string;
  region: string;
  checkedAt: string | null;
  error: string;
}

export interface AccountStatus {
  connected: boolean;
  armed: boolean;
  maxOrderUsd: number;
  geoblock: GeoblockStatus;
  closedOnly: boolean | null;
  account?: {
    signer: string;
    signerType: string;
    wallet: string;
    walletType: string;
  };
}

export interface AccountPosition {
  assetId: string;
  conditionId: string;
  title: string;
  outcome: string;
  currentSize: string;
  avgPrice: string;
  currentPrice: string;
  currentValue: string;
  realizedPnl: string;
  unrealizedPnl: string;
  totalPnl: string;
  percentPnl: string;
  status: string;
  redeemable: boolean;
}

export interface AccountSnapshot {
  wallet: string;
  portfolioValue: string;
  openPositions: AccountPosition[];
  closedPositions: AccountPosition[];
  openOrderCount: number;
  refreshedAt: string;
}

export interface OrderResult extends OrderDraft {
  status: string;
  createdAt: string;
  orderId?: string;
  message?: string;
}

export interface TerminalBridge {
  listMarkets(): Promise<Instrument[]>;
  subscribeAssets(assetIds: string[]): Promise<{ subscribed: string[] }>;
  unsubscribeAssets(assetIds: string[]): Promise<{ subscribed: string[] }>;
  submitOrder(draft: OrderDraft): Promise<OrderResult>;
  getAccountStatus(): Promise<AccountStatus>;
  connectAccount(request: { privateKey: string; walletAddress?: string }): Promise<AccountStatus>;
  disconnectAccount(): Promise<AccountStatus>;
  setTradingArmed(armed: boolean): Promise<AccountStatus>;
  getAccountSnapshot(): Promise<AccountSnapshot>;
  cancelAllOrders(): Promise<{ canceled: string[]; status: string }>;
  onMarketEvent(callback: (event: MarketEvent) => void): () => void;
  onConnectionStatus(callback: (status: ConnectionStatus) => void): () => void;
}

declare global {
  interface Window {
    polymarketTerminal?: TerminalBridge;
  }
}
