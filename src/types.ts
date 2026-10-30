export type ConnectionStatus = "idle" | "connecting" | "live" | "reconnecting" | "error";

export interface Instrument {
  assetId: string;
  conditionId: string;
  eventId: string;
  eventSlug: string;
  eventTitle: string;
  marketTitle: string;
  outcome: string;
  tickSize: string;
  minOrderSize: string;
  volume24hr: number;
  category: string;
  tags: string[];
  leagueId?: string;
  leagueSlug?: string;
  leagueName?: string;
  leagueImage?: string;
  startTime?: string;
  sportsMarketType?: string;
  acceptingOrders?: boolean;
  closed?: boolean;
  metadataAt?: number;
}

export interface MarketLeague {
  id: string;
  slug: string;
  name: string;
  image?: string;
  seriesId: string;
  primaryTagId?: string;
  ordering?: "home" | "away";
}

export interface PriceLevel {
  price: string;
  size: string;
}

export interface TradePrint {
  id: string;
  price: string;
  size: string;
  side: "BUY" | "SELL" | "UNKNOWN";
  timestamp: string;
  timeSource?: 'provider' | 'receipt';
  identity?: 'STRONG' | 'AMBIGUOUS';
  receivedAt?: number;
  quality?: string;
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
  lastTradeSide?: "BUY" | "SELL" | "UNKNOWN";
  generation?: number;
  tickVersion?: number;
  bookReceivedAt?: number;
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
  tick_size?: string;
  min_order_size?: string;
  best_bid?: string;
  best_ask?: string;
  timestamp?: string;
}

export interface OrderDraft {
  /** Optional for migration only; main rejects submission without all four fields. */
  requestId?: string;
  bookGeneration?: number;
  tickVersion?: number;
  armEpoch?: number;
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
  armEpoch?: number;
  liveEnabled?: boolean;
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

export interface AssetHealth {
  assetId: string;
  active: boolean;
  generation: number;
  tickVersion: number;
  initialized: boolean;
  bookReceivedAt: number | null;
  fresh: boolean;
  tickSize?: string;
}

export interface InstrumentResolution {
  assetId: string;
  status: "RESOLVED" | "UNAVAILABLE" | "UNRESOLVED";
  instrument?: Instrument;
}

export interface LeagueMarketsPage {
  items: Instrument[];
  nextCursor: string | null;
  completeness: "MORE" | "EXHAUSTED" | "UNKNOWN";
  eventCount: number;
}

export interface TerminalBridge {
  resolveInstruments(request: { assetIds: string[] }): Promise<InstrumentResolution[]>;
  listLeagueMarketsPage(request: { seriesId: string; cursor?: string | null }): Promise<LeagueMarketsPage>;
  refreshBook(request: { assetId: string }): Promise<void>;
  onAccountStatus(callback: (status: AccountStatus) => void): () => void;
  onAssetHealth(callback: (health: AssetHealth) => void): () => void;
  listMarkets(): Promise<Instrument[]>;
  listLeagues(): Promise<MarketLeague[]>;
  listLeagueMarkets(seriesId: string): Promise<Instrument[]>;
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
