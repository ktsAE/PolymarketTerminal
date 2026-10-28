import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { demoBridge } from "./demoBridge";
import type {
  AccountSnapshot,
  AccountStatus,
  BookState,
  ConnectionStatus,
  Instrument,
  MarketEvent,
  OrderDraft,
} from "./types";

const bridge = window.polymarketTerminal ?? demoBridge;
const STORAGE_KEY = "pm-terminal:open-instruments";
const FAVORITES_KEY = "pm-terminal:favorites";
const RECENTS_KEY = "pm-terminal:recent-instruments";
const MAX_OPEN_BOOKS = 6;
const INITIAL_ACCOUNT_STATUS: AccountStatus = {
  connected: false,
  armed: false,
  maxOrderUsd: 25,
  closedOnly: null,
  geoblock: { blocked: null, country: "", region: "", checkedAt: null, error: "Not checked" },
};

function freshBook(instrument: Instrument): BookState {
  return {
    assetId: instrument.assetId,
    bids: new Map(),
    asks: new Map(),
    tickSize: instrument.tickSize,
    recentTrades: [],
    ready: false,
  };
}

function applyMarketEvent(current: Map<string, BookState>, event: MarketEvent) {
  const next = new Map(current);
  if (event.event_type === "book" && event.asset_id) {
    const previous = next.get(event.asset_id);
    if (!previous) return current;
    const bids = new Map((event.bids ?? []).map((level) => [level.price, level.size]));
    const asks = new Map((event.asks ?? []).map((level) => [level.price, level.size]));
    next.set(event.asset_id, {
      ...previous,
      bids,
      asks,
      bestBid: [...bids.keys()].sort((a, b) => Number(b) - Number(a))[0],
      bestAsk: [...asks.keys()].sort((a, b) => Number(a) - Number(b))[0],
      timestamp: event.timestamp,
      ready: true,
    });
    return next;
  }

  if (event.event_type === "price_change") {
    for (const change of event.price_changes ?? []) {
      const previous = next.get(change.asset_id);
      if (!previous) continue;
      const bids = new Map(previous.bids);
      const asks = new Map(previous.asks);
      const target = change.side === "BUY" ? bids : asks;
      if (Number(change.size) === 0) target.delete(change.price);
      else target.set(change.price, change.size);
      next.set(change.asset_id, {
        ...previous,
        bids,
        asks,
        bestBid: change.best_bid ?? previous.bestBid,
        bestAsk: change.best_ask ?? previous.bestAsk,
        timestamp: event.timestamp,
        ready: true,
      });
    }
    return next;
  }

  if (event.asset_id) {
    const previous = next.get(event.asset_id);
    if (!previous) return current;
    if (event.event_type === "tick_size_change" && event.new_tick_size) {
      next.set(event.asset_id, { ...previous, tickSize: event.new_tick_size });
    } else if (event.event_type === "best_bid_ask") {
      next.set(event.asset_id, {
        ...previous,
        bestBid: event.best_bid,
        bestAsk: event.best_ask,
        timestamp: event.timestamp,
      });
    } else if (event.event_type === "last_trade_price" && event.price) {
      const timestamp = event.timestamp ?? String(Date.now());
      const size = event.size ?? "0";
      const side = event.side ?? "BUY";
      const id = event.transaction_hash ?? `${timestamp}-${event.price}-${size}-${side}`;
      const recentTrades = previous.recentTrades.some((trade) => trade.id === id)
        ? previous.recentTrades
        : [{ id, price: event.price, size, side, timestamp }, ...previous.recentTrades].slice(0, 40);
      next.set(event.asset_id, {
        ...previous,
        lastTrade: event.price,
        lastTradeSize: size,
        lastTradeSide: side,
        recentTrades,
        timestamp,
      });
    }
  }
  return next;
}

function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 1,
  }).format(value);
}

function compactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function readStoredIds(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function priceLabel(value: string) {
  const numeric = Number(value) * 100;
  return `${numeric.toFixed(numeric % 1 === 0 ? 0 : 1)}¢`;
}

function shortAddress(value?: string) {
  if (!value) return "not connected";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function signedMoney(value: number) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value)}`;
}

interface Toast {
  id: number;
  tone: "good" | "bad";
  message: string;
}

interface BookPanelProps {
  instrument: Instrument;
  book: BookState;
  connection: ConnectionStatus;
  accountStatus: AccountStatus;
  favorite: boolean;
  focused: boolean;
  onClose(): void;
  onToggleFavorite(): void;
  onToggleFocus(): void;
  onOrder(draft: OrderDraft): Promise<void>;
  onDragStart(): void;
  onDrop(): void;
}

function BookPanel({
  instrument,
  book,
  connection,
  accountStatus,
  favorite,
  focused,
  onClose,
  onToggleFavorite,
  onToggleFocus,
  onOrder,
  onDragStart,
  onDrop,
}: BookPanelProps) {
  const [size, setSize] = useState("10");
  const [sizeUnit, setSizeUnit] = useState<"USD" | "SHARES">("USD");
  const [pending, setPending] = useState(false);
  const [visibleLevels, setVisibleLevels] = useState(8);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!panelRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const levels = Math.max(2, Math.min(26, Math.floor((entry.contentRect.height - 176) / 40)));
      setVisibleLevels(levels);
    });
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, []);

  const asks = useMemo(
    () =>
      [...book.asks.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .slice(0, visibleLevels)
        .reverse(),
    [book.asks, visibleLevels],
  );
  const bids = useMemo(
    () =>
      [...book.bids.entries()]
        .sort((a, b) => Number(b[0]) - Number(a[0]))
        .slice(0, visibleLevels),
    [book.bids, visibleLevels],
  );
  const maxDepth = Math.max(1, ...asks.map(([, value]) => Number(value)), ...bids.map(([, value]) => Number(value)));
  const bidDepth = [...book.bids.values()].reduce((sum, value) => sum + Number(value), 0);
  const askDepth = [...book.asks.values()].reduce((sum, value) => sum + Number(value), 0);
  const totalDepth = bidDepth + askDepth;
  const bidShare = totalDepth > 0 ? (bidDepth / totalDepth) * 100 : 50;
  const maxPrint = Math.max(1, ...book.recentTrades.map((trade) => Number(trade.size)));
  const rollingPrintVolume = book.recentTrades.reduce((sum, trade) => sum + Number(trade.size), 0);
  const disabled = pending || connection !== "live" || !book.ready || Number(size) <= 0;

  const place = async (side: "BUY" | "SELL", price: string, execution: "GTC" | "FAK") => {
    if (disabled) return;
    setPending(true);
    try {
      await onOrder({
        assetId: instrument.assetId,
        marketTitle: instrument.marketTitle,
        outcome: instrument.outcome,
        side,
        price,
        size,
        sizeUnit,
        execution,
        mode: accountStatus.armed ? "LIVE" : "DRY",
      });
    } finally {
      setPending(false);
    }
  };

  const row = (side: "bid" | "ask", [price, levelSize]: [string, string]) => {
    const isBid = side === "bid";
    const depth = Math.min(100, (Number(levelSize) / maxDepth) * 100);
    return (
      <div className={`book-row ${side}`} key={`${side}-${price}`}>
        <button
          className="order-lane buy-lane"
          disabled={disabled || !isBid}
          title={`Rest BUY ${size} ${sizeUnit.toLowerCase()} at ${priceLabel(price)}`}
          onClick={() => isBid && place("BUY", price, "GTC")}
        >
          {isBid ? "+ BUY" : ""}
        </button>
        <button
          className="liquidity bid-size"
          disabled={disabled || !isBid}
          title={isBid ? `Take bid: SELL at ${priceLabel(price)} or better` : undefined}
          onClick={() => isBid && place("SELL", price, "FAK")}
        >
          {isBid && <span className="depth" style={{ width: `${depth}%` }} />}
          <span className="level-value">{isBid ? Number(levelSize).toLocaleString() : ""}</span>
        </button>
        <div className="price-cell">{priceLabel(price)}</div>
        <button
          className="liquidity ask-size"
          disabled={disabled || isBid}
          title={!isBid ? `Take ask: BUY at ${priceLabel(price)} or better` : undefined}
          onClick={() => !isBid && place("BUY", price, "FAK")}
        >
          {!isBid && <span className="depth" style={{ width: `${depth}%` }} />}
          <span className="level-value">{!isBid ? Number(levelSize).toLocaleString() : ""}</span>
        </button>
        <button
          className="order-lane sell-lane"
          disabled={disabled || isBid}
          title={`Rest SELL ${size} ${sizeUnit.toLowerCase()} at ${priceLabel(price)}`}
          onClick={() => !isBid && place("SELL", price, "GTC")}
        >
          {!isBid ? "SELL +" : ""}
        </button>
      </div>
    );
  };

  const spread = book.bestBid && book.bestAsk ? Number(book.bestAsk) - Number(book.bestBid) : undefined;

  return (
    <section
      ref={panelRef}
      className={`book-panel ${focused ? "focused" : ""}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <header className="book-header">
        <div className="book-title" title={instrument.marketTitle}>
          <span className="drag-handle">⠿</span>
          <div>
            <strong>{instrument.marketTitle}</strong>
            <span className={`outcome outcome-${instrument.outcome.toLowerCase()}`}>{instrument.outcome}</span>
          </div>
        </div>
        <div className="book-header-meta">
          <span><b>{money(instrument.volume24hr)}</b> 24H</span>
          <button className={`icon-button star-button ${favorite ? "active" : ""}`} onClick={onToggleFavorite} aria-label={favorite ? "Remove favorite" : "Add favorite"}>★</button>
          <button className={`icon-button focus-button ${focused ? "active" : ""}`} onClick={onToggleFocus} aria-label={focused ? "Exit focus" : "Focus order book"}>{focused ? "↙" : "↗"}</button>
          <button className="icon-button" onClick={onClose} aria-label="Close order book">×</button>
        </div>
      </header>

      <div className="trade-strip">
        <label>
          QTY
          <input value={size} inputMode="decimal" onChange={(event) => setSize(event.target.value)} />
        </label>
        <div className="segmented">
          <button className={sizeUnit === "USD" ? "active" : ""} onClick={() => setSizeUnit("USD")}>$</button>
          <button className={sizeUnit === "SHARES" ? "active" : ""} onClick={() => setSizeUnit("SHARES")}>SH</button>
        </div>
        <div className="size-presets" aria-label="Quick order size">
          {[5, 10, 25, 100].map((value) => <button key={value} className={size === String(value) ? "active" : ""} onClick={() => setSize(String(value))}>{value}</button>)}
        </div>
        <div className="quote">
          <span>BID {book.bestBid ? priceLabel(book.bestBid) : "—"}</span>
          <span>ASK {book.bestAsk ? priceLabel(book.bestAsk) : "—"}</span>
          <span>SPR {spread !== undefined ? `${(spread * 100).toFixed(1)}¢` : "—"}</span>
        </div>
        <div className="depth-summary" title={`Full visible book: ${compactNumber(bidDepth)} bid shares / ${compactNumber(askDepth)} ask shares`}>
          <span style={{ width: `${bidShare}%` }} />
          <b>B {bidShare.toFixed(0)}%</b>
          <b>A {(100 - bidShare).toFixed(0)}%</b>
        </div>
      </div>

      <div className="book-body">
        <div className="ladder-stack">
          <div className="book-columns">
            <span>REST</span>
            <span>BID SH</span>
            <span>PRICE</span>
            <span>ASK SH</span>
            <span>REST</span>
          </div>
          <div className="book-ladder">
            {!book.ready && <div className="book-loading">Waiting for book snapshot…</div>}
            {asks.map((level) => row("ask", level))}
            <div className="spread-row">
              <span>LAST {book.lastTrade ? priceLabel(book.lastTrade) : "—"}</span>
              <span>{connection === "live" ? "LIVE" : connection.toUpperCase()}</span>
            </div>
            {bids.map((level) => row("bid", level))}
          </div>
        </div>

        <aside className="prints-rail" aria-label="Live executed trades">
          <header>
            <span>PRINTS</span>
            <b>{compactNumber(rollingPrintVolume)} sh</b>
          </header>
          <div className="prints-list">
            {book.recentTrades.length === 0 && <div className="prints-empty">Awaiting live trades</div>}
            {book.recentTrades.slice(0, Math.max(5, visibleLevels)).map((trade) => {
              const bubbleSize = 16 + Math.sqrt(Number(trade.size) / maxPrint) * 24;
              return (
                <div className={`trade-print trade-${trade.side.toLowerCase()}`} key={trade.id} title={`${trade.side} ${Number(trade.size).toLocaleString()} shares at ${priceLabel(trade.price)}`}>
                  <i style={{ width: bubbleSize, height: bubbleSize }}><span>{compactNumber(Number(trade.size))}</span></i>
                  <div><b>{priceLabel(trade.price)}</b><span>{trade.side}</span></div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>

      <footer className="book-footer">
        <span>Tick {book.tickSize}</span>
        <span>Min {instrument.minOrderSize} sh</span>
        <span>Depth {compactNumber(totalDepth)} sh</span>
        <span className={accountStatus.armed ? "live-label" : "dry-label"}>
          {accountStatus.armed ? `LIVE · max $${accountStatus.maxOrderUsd}` : "DRY · no order sent"}
        </span>
      </footer>
    </section>
  );
}

interface LoginModalProps {
  onClose(): void;
  onConnect(request: { privateKey: string; walletAddress?: string }): Promise<void>;
}

function LoginModal({ onClose, onConnect }: LoginModalProps) {
  const [privateKey, setPrivateKey] = useState("");
  const [walletAddress, setWalletAddress] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(undefined);
    try {
      await onConnect({ privateKey: privateKey.trim(), walletAddress: walletAddress.trim() || undefined });
      setPrivateKey("");
      setWalletAddress("");
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Could not connect account");
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="login-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>POLYMARKET ACCOUNT</span>
            <strong>Connect a signer</strong>
          </div>
          <button type="button" className="icon-button" onClick={onClose}>×</button>
        </header>

        <div className="security-callout">
          Use a dedicated low-balance wallet. The key stays in app memory for this session and is never saved.
        </div>

        <label className="field-label">
          PRIVATE KEY
          <input
            autoFocus
            autoComplete="off"
            spellCheck={false}
            type="password"
            placeholder="0x…"
            value={privateKey}
            onChange={(event) => setPrivateKey(event.target.value)}
          />
        </label>

        <label className="field-label">
          EXISTING POLYMARKET WALLET <span>OPTIONAL</span>
          <input
            autoComplete="off"
            spellCheck={false}
            placeholder="0x… leave blank for Deposit Wallet"
            value={walletAddress}
            onChange={(event) => setWalletAddress(event.target.value)}
          />
        </label>

        <p className="field-help">
          If the signer owns an existing Proxy, Safe or Deposit Wallet, enter that account wallet here. Leaving it blank uses the signer's default Deposit Wallet.
        </p>
        {error && <div className="form-error">{error}</div>}
        <button className="primary-button" disabled={pending || privateKey.trim().length < 66}>
          {pending ? "CONNECTING…" : "CONNECT FOR THIS SESSION"}
        </button>
      </form>
    </div>
  );
}

interface AccountDrawerProps {
  status: AccountStatus;
  snapshot?: AccountSnapshot;
  loading: boolean;
  onClose(): void;
  onConnect(): void;
  onRefresh(): void;
  onToggleArmed(): void;
  onDisconnect(): void;
  onCancelAll(): void;
}

function AccountDrawer({
  status,
  snapshot,
  loading,
  onClose,
  onConnect,
  onRefresh,
  onToggleArmed,
  onDisconnect,
  onCancelAll,
}: AccountDrawerProps) {
  const openPnl = (snapshot?.openPositions ?? []).reduce((sum, position) => sum + Number(position.totalPnl), 0);
  const realizedPnl = [
    ...(snapshot?.openPositions ?? []),
    ...(snapshot?.closedPositions ?? []),
  ].reduce((sum, position) => sum + Number(position.realizedPnl), 0);

  return (
    <aside className="account-drawer">
      <header className="account-header">
        <div>
          <span>ACCOUNT</span>
          <strong>{status.connected ? shortAddress(status.account?.wallet) : "Not connected"}</strong>
        </div>
        <button className="icon-button" onClick={onClose}>×</button>
      </header>

      {!status.connected ? (
        <div className="account-empty">
          <div className="account-orb">◎</div>
          <strong>Connect to see positions and PnL</strong>
          <span>The public order-book terminal remains usable in dry mode.</span>
          <button className="primary-button" onClick={onConnect}>CONNECT PRIVATE KEY</button>
        </div>
      ) : (
        <>
          <div className="account-identity">
            <div><span>WALLET TYPE</span><b>{status.account?.walletType}</b></div>
            <div><span>LOCATION</span><b>{status.geoblock.blocked === false ? `${status.geoblock.country || "OK"} · OK` : status.geoblock.blocked ? "BLOCKED" : "UNVERIFIED"}</b></div>
            <div><span>OPEN ORDERS</span><b>{snapshot?.openOrderCount ?? "—"}</b></div>
          </div>

          <div className="account-metrics">
            <article>
              <span>PORTFOLIO VALUE</span>
              <strong>{snapshot ? money(Number(snapshot.portfolioValue)) : "—"}</strong>
            </article>
            <article>
              <span>OPEN PNL</span>
              <strong className={openPnl >= 0 ? "positive" : "negative"}>{snapshot ? signedMoney(openPnl) : "—"}</strong>
            </article>
            <article>
              <span>REALIZED · LOADED</span>
              <strong className={realizedPnl >= 0 ? "positive" : "negative"}>{snapshot ? signedMoney(realizedPnl) : "—"}</strong>
            </article>
          </div>

          <div className="account-actions">
            <button className={status.armed ? "danger-button armed" : "arm-button"} onClick={onToggleArmed}>
              {status.armed ? "DISARM LIVE" : `ARM LIVE · $${status.maxOrderUsd} MAX`}
            </button>
            <button onClick={onRefresh} disabled={loading}>{loading ? "…" : "↻"}</button>
          </div>

          <section className="positions-section">
            <div className="section-title"><span>OPEN POSITIONS</span><b>{snapshot?.openPositions.length ?? 0}</b></div>
            <div className="positions-list">
              {loading && !snapshot && <div className="drawer-message">Loading portfolio…</div>}
              {!loading && snapshot?.openPositions.length === 0 && <div className="drawer-message">No open positions.</div>}
              {snapshot?.openPositions.map((position) => (
                <article className="position-card" key={`${position.conditionId}-${position.assetId}`}>
                  <div className="position-title">
                    <strong>{position.title}</strong>
                    <span>{position.outcome}</span>
                  </div>
                  <div className="position-numbers">
                    <div><span>SIZE</span><b>{Number(position.currentSize).toLocaleString()}</b></div>
                    <div><span>AVG</span><b>{priceLabel(position.avgPrice)}</b></div>
                    <div><span>VALUE</span><b>{money(Number(position.currentValue))}</b></div>
                    <div><span>PNL</span><b className={Number(position.totalPnl) >= 0 ? "positive" : "negative"}>{signedMoney(Number(position.totalPnl))}</b></div>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <div className="account-footer-actions">
            <button className="cancel-all" onClick={onCancelAll}>CANCEL ALL OPEN ORDERS</button>
            <button onClick={onDisconnect}>DISCONNECT SESSION</button>
          </div>
        </>
      )}
    </aside>
  );
}

export function App() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [openInstruments, setOpenInstruments] = useState<Instrument[]>([]);
  const [books, setBooks] = useState<Map<string, BookState>>(new Map());
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All");
  const [marketView, setMarketView] = useState<"All" | "Favorites" | "Recent">("All");
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(() => new Set(readStoredIds(FAVORITES_KEY)));
  const [recentIds, setRecentIds] = useState<string[]>(() => readStoredIds(RECENTS_KEY));
  const [loading, setLoading] = useState(true);
  const [marketError, setMarketError] = useState<string>();
  const [layoutMode, setLayoutMode] = useState<"AUTO" | "1" | "2" | "3">("AUTO");
  const [focusedAssetId, setFocusedAssetId] = useState<string>();
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [toast, setToast] = useState<Toast>();
  const [accountStatus, setAccountStatus] = useState<AccountStatus>(INITIAL_ACCOUNT_STATUS);
  const [accountSnapshot, setAccountSnapshot] = useState<AccountSnapshot>();
  const [accountOpen, setAccountOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [accountLoading, setAccountLoading] = useState(false);
  const dragIndex = useRef<number | undefined>(undefined);
  const booksWorkspaceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const offEvent = bridge.onMarketEvent((event) => {
      setBooks((current) => applyMarketEvent(current, event));
    });
    const offStatus = bridge.onConnectionStatus(setConnection);
    return () => {
      offEvent();
      offStatus();
    };
  }, []);

  useEffect(() => {
    if (!booksWorkspaceRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setWorkspaceWidth(entry.contentRect.width));
    observer.observe(booksWorkspaceRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    bridge.getAccountStatus().then(setAccountStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    bridge
      .listMarkets()
      .then((items) => {
        if (!active) return;
        setInstruments(items);
        const savedIds = readStoredIds(STORAGE_KEY);
        const restored = savedIds
          .map((assetId) => items.find((item) => item.assetId === assetId))
          .filter((item): item is Instrument => Boolean(item))
          .slice(0, 6);
        const initial = restored.length ? restored : items.slice(0, 2);
        setOpenInstruments(initial);
        setRecentIds((current) => [
          ...initial.map((instrument) => instrument.assetId),
          ...current.filter((assetId) => !initial.some((instrument) => instrument.assetId === assetId)),
        ].slice(0, 30));
        setBooks(new Map(initial.map((instrument) => [instrument.assetId, freshBook(instrument)])));
        if (initial.length) bridge.subscribeAssets(initial.map((instrument) => instrument.assetId));
      })
      .catch((error: unknown) => {
        if (active) setMarketError(error instanceof Error ? error.message : "Could not load markets");
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(openInstruments.map((item) => item.assetId)));
  }, [openInstruments]);

  useEffect(() => {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favoriteIds]));
  }, [favoriteIds]);

  useEffect(() => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recentIds));
  }, [recentIds]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), 3600);
    return () => clearTimeout(timer);
  }, [toast]);

  const categories = useMemo(() => {
    const preferred = ["Politics", "Crypto", "Sports", "Economy", "Tech & AI", "World", "Culture", "Other"];
    const available = new Set(instruments.map((instrument) => instrument.category));
    return ["All", ...preferred.filter((item) => available.has(item))];
  }, [instruments]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const result = instruments
      .filter(
        (item) =>
          (marketView === "All" ||
            (marketView === "Favorites" && favoriteIds.has(item.assetId)) ||
            (marketView === "Recent" && recentIds.includes(item.assetId))) &&
          (category === "All" || item.category === category) &&
          (!needle ||
            item.marketTitle.toLowerCase().includes(needle) ||
            item.eventTitle.toLowerCase().includes(needle) ||
            item.outcome.toLowerCase().includes(needle) ||
            item.tags.some((tag) => tag.toLowerCase().includes(needle))),
      );
    return result
      .sort((a, b) => {
        if (marketView === "Recent") return recentIds.indexOf(a.assetId) - recentIds.indexOf(b.assetId);
        const favoriteDelta = Number(favoriteIds.has(b.assetId)) - Number(favoriteIds.has(a.assetId));
        return favoriteDelta || b.volume24hr - a.volume24hr;
      })
      .slice(0, 80);
  }, [category, favoriteIds, instruments, marketView, query, recentIds]);

  const displayedOpenInstruments = useMemo(
    () => focusedAssetId ? openInstruments.filter((item) => item.assetId === focusedAssetId) : openInstruments,
    [focusedAssetId, openInstruments],
  );
  const gridColumns = useMemo(() => {
    const count = displayedOpenInstruments.length;
    if (count <= 1 || focusedAssetId) return 1;
    if (layoutMode !== "AUTO") return Math.min(count, Number(layoutMode));
    const available = Math.max(340, workspaceWidth - 2);
    return Math.min(count, 3, Math.max(1, Math.floor((available + 9) / 369)));
  }, [displayedOpenInstruments.length, focusedAssetId, layoutMode, workspaceWidth]);
  const gridRows = Math.max(1, Math.ceil(displayedOpenInstruments.length / gridColumns));

  const refreshAccount = useCallback(async () => {
    if (!accountStatus.connected) return;
    setAccountLoading(true);
    try {
      setAccountSnapshot(await bridge.getAccountSnapshot());
    } catch (error) {
      setToast({
        id: Date.now(),
        tone: "bad",
        message: error instanceof Error ? error.message : "Could not load account",
      });
    } finally {
      setAccountLoading(false);
    }
  }, [accountStatus.connected]);

  useEffect(() => {
    if (accountOpen && accountStatus.connected && !accountSnapshot) refreshAccount();
  }, [accountOpen, accountSnapshot, accountStatus.connected, refreshAccount]);

  const openBook = useCallback(
    async (instrument: Instrument) => {
      setRecentIds((current) => [instrument.assetId, ...current.filter((assetId) => assetId !== instrument.assetId)].slice(0, 30));
      if (openInstruments.some((item) => item.assetId === instrument.assetId)) {
        setFocusedAssetId(instrument.assetId);
        return;
      }
      if (openInstruments.length >= MAX_OPEN_BOOKS) {
        setToast({ id: Date.now(), tone: "bad", message: `Workspace limit: ${MAX_OPEN_BOOKS} simultaneous books` });
        return;
      }
      setOpenInstruments((current) => [...current, instrument]);
      setBooks((current) => new Map(current).set(instrument.assetId, freshBook(instrument)));
      await bridge.subscribeAssets([instrument.assetId]);
    },
    [openInstruments],
  );

  const closeBook = async (instrument: Instrument) => {
    if (focusedAssetId === instrument.assetId) setFocusedAssetId(undefined);
    setOpenInstruments((current) => current.filter((item) => item.assetId !== instrument.assetId));
    setBooks((current) => {
      const next = new Map(current);
      next.delete(instrument.assetId);
      return next;
    });
    await bridge.unsubscribeAssets([instrument.assetId]);
  };

  const toggleFavorite = useCallback((assetId: string) => {
    setFavoriteIds((current) => {
      const next = new Set(current);
      if (next.has(assetId)) next.delete(assetId);
      else next.add(assetId);
      return next;
    });
  }, []);

  const submitOrder = async (draft: OrderDraft) => {
    try {
      const result = await bridge.submitOrder(draft);
      setToast({
        id: Date.now(),
        tone: result.status.includes("ACCEPTED") ? "good" : "bad",
        message: `${result.status}: ${draft.side} ${draft.size} ${draft.sizeUnit} ${draft.outcome} @ ${priceLabel(draft.price)} ${draft.execution}${result.message ? ` · ${result.message}` : ""}`,
      });
      if (draft.mode === "LIVE") refreshAccount();
    } catch (error) {
      setToast({
        id: Date.now(),
        tone: "bad",
        message: error instanceof Error ? error.message : "Order rejected",
      });
    }
  };

  const connectAccount = async (request: { privateKey: string; walletAddress?: string }) => {
    const status = await bridge.connectAccount(request);
    setAccountStatus(status);
    setAccountSnapshot(undefined);
    setLoginOpen(false);
    setAccountOpen(true);
    setToast({ id: Date.now(), tone: "good", message: `CONNECTED: ${shortAddress(status.account?.wallet)} · live remains disarmed` });
  };

  const disconnectAccount = async () => {
    setAccountStatus(await bridge.disconnectAccount());
    setAccountSnapshot(undefined);
    setToast({ id: Date.now(), tone: "good", message: "Account disconnected; key removed from app memory" });
  };

  const toggleArmed = async () => {
    if (!accountStatus.connected) {
      setLoginOpen(true);
      return;
    }
    if (!accountStatus.armed) {
      const confirmed = window.confirm(
        `Arm live trading for this session? Clicking a book will place real orders, capped at $${accountStatus.maxOrderUsd} each.`,
      );
      if (!confirmed) return;
    }
    try {
      const status = await bridge.setTradingArmed(!accountStatus.armed);
      setAccountStatus(status);
      setToast({
        id: Date.now(),
        tone: status.armed ? "bad" : "good",
        message: status.armed ? "LIVE TRADING ARMED" : "Live trading disarmed",
      });
    } catch (error) {
      setToast({ id: Date.now(), tone: "bad", message: error instanceof Error ? error.message : "Could not change trading mode" });
    }
  };

  const cancelAllOrders = async () => {
    if (!window.confirm("Cancel every open order for this connected Polymarket account?")) return;
    try {
      const result = await bridge.cancelAllOrders();
      setAccountStatus(await bridge.getAccountStatus());
      setToast({ id: Date.now(), tone: "good", message: `${result.status}: ${result.canceled.length} orders canceled` });
      refreshAccount();
    } catch (error) {
      setToast({ id: Date.now(), tone: "bad", message: error instanceof Error ? error.message : "Cancel-all failed" });
    }
  };

  const reorder = (targetIndex: number) => {
    if (dragIndex.current === undefined || dragIndex.current === targetIndex) return;
    setOpenInstruments((current) => {
      const next = [...current];
      const [moved] = next.splice(dragIndex.current!, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    dragIndex.current = undefined;
  };

  return (
    <main className="terminal-shell">
      <header className="topbar">
        <div className="brand">
          <button className={`navigator-toggle ${drawerCollapsed ? "collapsed" : ""}`} onClick={() => setDrawerCollapsed((value) => !value)} aria-label="Toggle market navigator">☰</button>
          <div className="brand-mark">PM</div>
          <div>
            <strong>POLYSCALP</strong>
            <span>orderflow workstation</span>
          </div>
        </div>
        <div className="top-stats">
          <span className={`status status-${connection}`}><i />{connection}</span>
          <span>{openInstruments.length} books</span>
          <span>{gridColumns}×{gridRows} workspace</span>
          <button className={`mode-pill ${accountStatus.armed ? "mode-live" : ""}`} onClick={toggleArmed}>
            {accountStatus.armed ? "LIVE ARMED" : "DRY MODE"}
          </button>
        </div>
        <div className="top-actions">
          <button className={`account-button ${accountStatus.connected ? "connected" : ""}`} onClick={() => setAccountOpen(true)}>
            <i /> {shortAddress(accountStatus.account?.wallet)}
          </button>
          <div className="layout-switcher" aria-label="Grid columns">
            {(["AUTO", "1", "2", "3"] as const).map((mode) => (
              <button key={mode} className={layoutMode === mode ? "active" : ""} onClick={() => { setFocusedAssetId(undefined); setLayoutMode(mode); }}>
                {mode === "AUTO" ? "AUTO" : `${mode}C`}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className={`workspace ${drawerCollapsed ? "drawer-collapsed" : ""}`}>
        <aside className="market-drawer">
          <div className="drawer-heading">
            <span>MARKET NAVIGATOR</span>
            <span>{filtered.length}/{instruments.length}</span>
          </div>
          <div className="search-wrap">
            <span>⌕</span>
            <input
              className="market-search"
              placeholder="Search question, tag, outcome…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && <button onClick={() => setQuery("")} aria-label="Clear search">×</button>}
          </div>
          <div className="market-view-tabs">
            {(["All", "Favorites", "Recent"] as const).map((view) => (
              <button key={view} className={marketView === view ? "active" : ""} onClick={() => setMarketView(view)}>
                {view === "Favorites" ? "★ Favorites" : view}
                {view === "Favorites" && <b>{favoriteIds.size}</b>}
              </button>
            ))}
          </div>
          <div className="category-strip">
            {categories.map((item) => (
              <button key={item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>
                {item}
              </button>
            ))}
          </div>
          <div className="market-list">
            {loading && <div className="drawer-message">Loading active markets…</div>}
            {marketError && <div className="drawer-message error">{marketError}</div>}
            {!loading && !marketError && filtered.length === 0 && <div className="drawer-message">No markets in this view. Star a market to keep it here.</div>}
            {filtered.map((instrument) => {
              const isOpen = openInstruments.some((item) => item.assetId === instrument.assetId);
              const isFavorite = favoriteIds.has(instrument.assetId);
              return (
                <div
                  role="button"
                  tabIndex={0}
                  className={`market-item ${isOpen ? "open" : ""}`}
                  key={instrument.assetId}
                  onClick={() => openBook(instrument)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") openBook(instrument);
                  }}
                >
                  <div className="market-item-top">
                    <span className="market-name">{instrument.marketTitle}</span>
                    <button
                      className={`market-star ${isFavorite ? "active" : ""}`}
                      aria-label={isFavorite ? "Remove favorite" : "Add favorite"}
                      onClick={(event) => { event.stopPropagation(); toggleFavorite(instrument.assetId); }}
                    >★</button>
                  </div>
                  <span className="market-meta">
                    <b>{instrument.outcome}</b>
                    <span>{money(instrument.volume24hr)} 24H</span>
                    <i>{isOpen ? "● OPEN" : "+ OPEN"}</i>
                  </span>
                  <span className="market-category">{instrument.category}</span>
                </div>
              );
            })}
          </div>
        </aside>

        <section ref={booksWorkspaceRef} className="books-workspace">
          <div className="workspace-hint">
            <span>Click ASK to buy · BID to sell · outer lanes rest post-only orders</span>
            <span className="workspace-legend"><i className="legend-depth" /> resting depth <i className="legend-print" /> executed prints · AUTO fits panels to available space</span>
          </div>
          {openInstruments.length === 0 ? (
            <div className="empty-state">
              <strong>No books open</strong>
              <span>Select a market outcome from the left.</span>
            </div>
          ) : (
            <div
              className={`book-grid layout-${layoutMode.toLowerCase()} ${focusedAssetId ? "has-focus" : ""}`}
              style={{
                gridTemplateColumns: `repeat(${gridColumns}, minmax(340px, 1fr))`,
                gridTemplateRows: `repeat(${gridRows}, minmax(230px, 1fr))`,
              }}
            >
              {displayedOpenInstruments.map((instrument) => {
                const index = openInstruments.findIndex((item) => item.assetId === instrument.assetId);
                return (
                <BookPanel
                  key={instrument.assetId}
                  instrument={instrument}
                  book={books.get(instrument.assetId) ?? freshBook(instrument)}
                  connection={connection}
                  accountStatus={accountStatus}
                  favorite={favoriteIds.has(instrument.assetId)}
                  focused={focusedAssetId === instrument.assetId}
                  onClose={() => closeBook(instrument)}
                  onToggleFavorite={() => toggleFavorite(instrument.assetId)}
                  onToggleFocus={() => setFocusedAssetId((current) => current === instrument.assetId ? undefined : instrument.assetId)}
                  onOrder={submitOrder}
                  onDragStart={() => {
                    dragIndex.current = index;
                  }}
                  onDrop={() => reorder(index)}
                />
                );
              })}
            </div>
          )}
        </section>
      </div>

      {accountOpen && (
        <AccountDrawer
          status={accountStatus}
          snapshot={accountSnapshot}
          loading={accountLoading}
          onClose={() => setAccountOpen(false)}
          onConnect={() => setLoginOpen(true)}
          onRefresh={refreshAccount}
          onToggleArmed={toggleArmed}
          onDisconnect={disconnectAccount}
          onCancelAll={cancelAllOrders}
        />
      )}
      {loginOpen && <LoginModal onClose={() => setLoginOpen(false)} onConnect={connectAccount} />}
      {toast && <div className={`toast toast-${toast.tone}`}>{toast.message}</div>}
    </main>
  );
}
