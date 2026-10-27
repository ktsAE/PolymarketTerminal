import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { demoBridge } from "./demoBridge";
import type {
  BookState,
  ConnectionStatus,
  Instrument,
  MarketEvent,
  OrderDraft,
} from "./types";

const bridge = window.polymarketTerminal ?? demoBridge;
const STORAGE_KEY = "pm-terminal:open-instruments";

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

interface Toast {
  id: number;
  tone: "good" | "bad";
  message: string;
}

interface BookPanelProps {
  instrument: Instrument;
  book: BookState;
  connection: ConnectionStatus;
  onClose(): void;
  onOrder(draft: OrderDraft): Promise<void>;
  onDragStart(): void;
  onDrop(): void;
}

function BookPanel({
  instrument,
  book,
  connection,
  onClose,
  onOrder,
  onDragStart,
  onDrop,
}: BookPanelProps) {
  const [size, setSize] = useState("10");
  const [sizeUnit, setSizeUnit] = useState<"USD" | "SHARES">("USD");
  const [pending, setPending] = useState(false);

  const asks = useMemo(
    () =>
      [...book.asks.entries()]
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .slice(0, 8)
        .reverse(),
    [book.asks],
  );
  const bids = useMemo(
    () =>
      [...book.bids.entries()]
        .sort((a, b) => Number(b[0]) - Number(a[0]))
        .slice(0, 8),
    [book.bids],
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
        mode: "DRY",
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
          disabled={disabled}
          title={`Rest BUY ${size} ${sizeUnit.toLowerCase()} at ${priceLabel(price)}`}
          onClick={() => place("BUY", price, "GTC")}
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
          <span>{isBid ? Number(levelSize).toLocaleString() : ""}</span>
        </button>
        <div className="price-cell">{priceLabel(price)}</div>
        <button
          className="liquidity ask-size"
          disabled={disabled || isBid}
          title={!isBid ? `Take ask: BUY at ${priceLabel(price)} or better` : undefined}
          onClick={() => !isBid && place("BUY", price, "FAK")}
        >
          {!isBid && <span className="depth" style={{ width: `${depth}%` }} />}
          <span>{!isBid ? Number(levelSize).toLocaleString() : ""}</span>
        </button>
        <button
          className="order-lane sell-lane"
          disabled={disabled}
          title={`Rest SELL ${size} ${sizeUnit.toLowerCase()} at ${priceLabel(price)}`}
          onClick={() => place("SELL", price, "GTC")}
        >
          {!isBid ? "SELL +" : ""}
        </button>
      </div>
    );
  };

  const spread = book.bestBid && book.bestAsk ? Number(book.bestAsk) - Number(book.bestBid) : undefined;

  return (
    <section
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
        <span className="dry-label">DRY · clicks are logged, never posted</span>
      </footer>
    </section>
  );
}

export function App() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [openInstruments, setOpenInstruments] = useState<Instrument[]>([]);
  const [books, setBooks] = useState<Map<string, BookState>>(new Map());
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [marketError, setMarketError] = useState<string>();
  const [columns, setColumns] = useState(2);
  const [toast, setToast] = useState<Toast>();
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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return instruments
      .filter(
        (item) =>
          !needle ||
          item.marketTitle.toLowerCase().includes(needle) ||
          item.eventTitle.toLowerCase().includes(needle) ||
          item.outcome.toLowerCase().includes(needle),
      )
      .slice(0, 60);
  }, [instruments, query]);

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
        tone: "good",
        message: `${result.status}: ${draft.side} ${draft.size} ${draft.sizeUnit} ${draft.outcome} @ ${priceLabel(draft.price)} ${draft.execution}`,
      });
    } catch (error) {
      setToast({
        id: Date.now(),
        tone: "bad",
        message: error instanceof Error ? error.message : "Order rejected",
      });
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
          <span className="mode-pill">DRY MODE</span>
        </div>
        <div className="layout-switcher" aria-label="Grid columns">
          {[1, 2, 3].map((count) => (
            <button key={count} className={columns === count ? "active" : ""} onClick={() => setColumns(count)}>
              {count}C
            </button>
          ))}
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
                </button>
              );
            })}
          </div>
        </aside>

        <section className="books-workspace">
          <div className="workspace-hint">
            <span>Click ASK to buy · click BID to sell · outer lanes place resting limits</span>
            <span>Drag panels to reorder</span>
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

      {toast && <div className={`toast toast-${toast.tone}`}>{toast.message}</div>}
    </main>
  );
}
