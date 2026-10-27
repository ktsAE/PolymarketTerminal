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
      next.set(event.asset_id, {
        ...previous,
        lastTrade: event.price,
        timestamp: event.timestamp,
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
  onClose(): void;
  onOrder(draft: OrderDraft): Promise<void>;
  onDragStart(): void;
  onDrop(): void;
}

function BookPanel({
  instrument,
  book,
  connection,
  accountStatus,
  onClose,
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
      const levels = Math.max(5, Math.min(18, Math.floor((entry.contentRect.height - 195) / 42)));
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
    const bubbleSize = 7 + Math.sqrt(depth / 100) * 17;
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
          {isBid && <i className="volume-bubble" style={{ width: bubbleSize, height: bubbleSize }} />}
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
          {!isBid && <i className="volume-bubble" style={{ width: bubbleSize, height: bubbleSize }} />}
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
      className="book-panel"
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
        <button className="icon-button" onClick={onClose} aria-label="Close order book">
          ×
        </button>
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
        <div className="quote">
          <span>BID {book.bestBid ? priceLabel(book.bestBid) : "—"}</span>
          <span>ASK {book.bestAsk ? priceLabel(book.bestAsk) : "—"}</span>
          <span>SPR {spread !== undefined ? `${(spread * 100).toFixed(1)}¢` : "—"}</span>
        </div>
      </div>

      <div className="book-columns">
        <span>MY BUY</span>
        <span>BID</span>
        <span>PRICE</span>
        <span>ASK</span>
        <span>MY SELL</span>
      </div>

      <div className="book-ladder">
        {!book.ready && <div className="book-loading">Waiting for book snapshot…</div>}
        {asks.map((level) => row("ask", level))}
        <div className="spread-row">
          <span>LAST {book.lastTrade ? priceLabel(book.lastTrade) : "—"}</span>
          <span>{connection === "live" ? "LIVE FEED" : connection.toUpperCase()}</span>
        </div>
        {bids.map((level) => row("bid", level))}
      </div>

      <footer className="book-footer">
        <span>Tick {book.tickSize}</span>
        <span>Min {instrument.minOrderSize} sh</span>
        <span className={accountStatus.armed ? "live-label" : "dry-label"}>
          {accountStatus.armed ? `LIVE · max $${accountStatus.maxOrderUsd}` : "DRY · clicks are logged, never posted"}
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
  const [loading, setLoading] = useState(true);
  const [marketError, setMarketError] = useState<string>();
  const [columns, setColumns] = useState(2);
  const [toast, setToast] = useState<Toast>();
  const [accountStatus, setAccountStatus] = useState<AccountStatus>(INITIAL_ACCOUNT_STATUS);
  const [accountSnapshot, setAccountSnapshot] = useState<AccountSnapshot>();
  const [accountOpen, setAccountOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [accountLoading, setAccountLoading] = useState(false);
  const dragIndex = useRef<number | undefined>(undefined);

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
    bridge.getAccountStatus().then(setAccountStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    bridge
      .listMarkets()
      .then((items) => {
        if (!active) return;
        setInstruments(items);
        const savedIds = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]") as string[];
        const restored = savedIds
          .map((assetId) => items.find((item) => item.assetId === assetId))
          .filter((item): item is Instrument => Boolean(item))
          .slice(0, 6);
        const initial = restored.length ? restored : items.slice(0, 2);
        setOpenInstruments(initial);
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
    return instruments
      .filter(
        (item) =>
          (category === "All" || item.category === category) &&
          (!needle ||
            item.marketTitle.toLowerCase().includes(needle) ||
            item.eventTitle.toLowerCase().includes(needle) ||
            item.outcome.toLowerCase().includes(needle) ||
            item.tags.some((tag) => tag.toLowerCase().includes(needle))),
      )
      .slice(0, 60);
  }, [category, instruments, query]);

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
      if (openInstruments.some((item) => item.assetId === instrument.assetId)) return;
      if (openInstruments.length >= 6) {
        setToast({ id: Date.now(), tone: "bad", message: "MVP limit: six simultaneous books" });
        return;
      }
      setOpenInstruments((current) => [...current, instrument]);
      setBooks((current) => new Map(current).set(instrument.assetId, freshBook(instrument)));
      await bridge.subscribeAssets([instrument.assetId]);
    },
    [openInstruments],
  );

  const closeBook = async (instrument: Instrument) => {
    setOpenInstruments((current) => current.filter((item) => item.assetId !== instrument.assetId));
    setBooks((current) => {
      const next = new Map(current);
      next.delete(instrument.assetId);
      return next;
    });
    await bridge.unsubscribeAssets([instrument.assetId]);
  };

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
          <div className="brand-mark">PM</div>
          <div>
            <strong>ORDERBOOK</strong>
            <span>local workstation</span>
          </div>
        </div>
        <div className="top-stats">
          <span className={`status status-${connection}`}><i />{connection}</span>
          <span>{openInstruments.length} books</span>
          <button className={`mode-pill ${accountStatus.armed ? "mode-live" : ""}`} onClick={toggleArmed}>
            {accountStatus.armed ? "LIVE ARMED" : "DRY MODE"}
          </button>
        </div>
        <div className="top-actions">
          <button className={`account-button ${accountStatus.connected ? "connected" : ""}`} onClick={() => setAccountOpen(true)}>
            <i /> {shortAddress(accountStatus.account?.wallet)}
          </button>
          <div className="layout-switcher" aria-label="Grid columns">
            {[1, 2, 3].map((count) => (
              <button key={count} className={columns === count ? "active" : ""} onClick={() => setColumns(count)}>
                {count}C
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="workspace">
        <aside className="market-drawer">
          <div className="drawer-heading">
            <span>MARKETS</span>
            <span>{instruments.length}</span>
          </div>
          <input
            className="market-search"
            placeholder="Search market or outcome…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
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
            {filtered.map((instrument) => {
              const isOpen = openInstruments.some((item) => item.assetId === instrument.assetId);
              return (
                <button
                  className={`market-item ${isOpen ? "open" : ""}`}
                  key={instrument.assetId}
                  onClick={() => openBook(instrument)}
                  disabled={isOpen}
                >
                  <span className="market-name">{instrument.marketTitle}</span>
                  <span className="market-meta">
                    <b>{instrument.outcome}</b>
                    <span>{money(instrument.volume24hr)} vol</span>
                    <i>{isOpen ? "OPEN" : "+ BOOK"}</i>
                  </span>
                  <span className="market-category">{instrument.category}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="books-workspace">
          <div className="workspace-hint">
            <span>Click ASK to buy · click BID to sell · outer lanes place post-only limits</span>
            <span>Drag panels · resize from the bottom-right corner</span>
          </div>
          {openInstruments.length === 0 ? (
            <div className="empty-state">
              <strong>No books open</strong>
              <span>Select a market outcome from the left.</span>
            </div>
          ) : (
            <div className="book-grid" style={{ gridTemplateColumns: `repeat(${columns}, minmax(360px, 1fr))` }}>
              {openInstruments.map((instrument, index) => (
                <BookPanel
                  key={instrument.assetId}
                  instrument={instrument}
                  book={books.get(instrument.assetId) ?? freshBook(instrument)}
                  connection={connection}
                  accountStatus={accountStatus}
                  onClose={() => closeBook(instrument)}
                  onOrder={submitOrder}
                  onDragStart={() => {
                    dragIndex.current = index;
                  }}
                  onDrop={() => reorder(index)}
                />
              ))}
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
