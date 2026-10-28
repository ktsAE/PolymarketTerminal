import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { demoBridge } from "./demoBridge";
import type {
  AccountPosition,
  AccountSnapshot,
  AccountStatus,
  BookState,
  ConnectionStatus,
  Instrument,
  MarketLeague,
  MarketEvent,
  OrderDraft,
  OrderResult,
  TradePrint,
} from "./types";

const bridge = window.polymarketTerminal ?? demoBridge;
const STORAGE_KEY = "pm-terminal:open-instruments";
const FAVORITE_LEAGUES_KEY = "pm-terminal:favorite-leagues";
const RECENTS_KEY = "pm-terminal:recent-instruments";
const ACTIVE_WORKSPACE_KEY = "pm-terminal:active-workspace";
const WORKSPACE_KEY = "pm-terminal:workspace";
const NAV_WIDTH_KEY = "pm-terminal:navigator-width";
const DOCK_HEIGHT_KEY = "pm-terminal:dock-height";
const MAX_OPEN_BOOKS = 6;
const WORKSPACE_SLOTS = ["SCALP 1", "SCALP 2", "SCALP 3"] as const;
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

function startLabel(value?: string) {
  if (!value) return "START TBA";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "START TBA";
  const now = new Date();
  const diff = date.getTime() - now.getTime();
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  if (diff <= 0 && diff > -6 * 60 * 60 * 1000) return `LIVE · ${time}`;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  if (day === today) return `TODAY · ${time}`;
  if (day === today + 86_400_000) return `TOMORROW · ${time}`;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date).toUpperCase();
}

function eventGroups(items: Instrument[]) {
  const groups = new Map<string, Instrument[]>();
  for (const item of items) {
    const key = item.eventId || item.eventTitle;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return [...groups.entries()]
    .map(([id, instruments]) => ({ id, instruments }))
    .sort((a, b) => {
      const aTime = a.instruments[0]?.startTime ? new Date(a.instruments[0].startTime!).getTime() : Number.MAX_SAFE_INTEGER;
      const bTime = b.instruments[0]?.startTime ? new Date(b.instruments[0].startTime!).getTime() : Number.MAX_SAFE_INTEGER;
      return aTime - bTime || b.instruments[0].volume24hr - a.instruments[0].volume24hr;
    });
}

function mergeInstruments(current: Instrument[], incoming: Instrument[]) {
  const merged = new Map(current.map((item) => [item.assetId, item]));
  incoming.forEach((item) => merged.set(item.assetId, item));
  return [...merged.values()];
}

function tradeTime(value: string) {
  const numeric = Number(value);
  const millis = Number.isFinite(numeric)
    ? numeric > 10_000_000_000 ? numeric : numeric * 1000
    : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : Date.now();
}

function readStoredNumber(key: string, fallback: number) {
  const stored = localStorage.getItem(key);
  if (stored === null || stored.trim() === "") return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? value : fallback;
}

interface TradeLogEntry {
  id: number;
  time: string;
  tone: "info" | "good" | "bad";
  message: string;
}

function prependTradeLog(current: TradeLogEntry[], tone: TradeLogEntry["tone"], message: string) {
  return [{ id: Date.now(), time: new Date().toLocaleTimeString(), tone, message }, ...current].slice(0, 200);
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
  position?: AccountPosition;
  sessionOrders: OrderResult[];
  leagueFavorite: boolean;
  focused: boolean;
  onClose(): void;
  onToggleLeagueFavorite(): void;
  onToggleFocus(): void;
  onOrder(draft: OrderDraft): Promise<OrderResult | void>;
  onDragStart(): void;
  onDrop(): void;
}

function BookPanel({
  instrument,
  book,
  connection,
  accountStatus,
  position,
  sessionOrders,
  leagueFavorite,
  focused,
  onClose,
  onToggleLeagueFavorite,
  onToggleFocus,
  onOrder,
  onDragStart,
  onDrop,
}: BookPanelProps) {
  const [size, setSize] = useState("10");
  const [sizeUnit, setSizeUnit] = useState<"USD" | "SHARES">("USD");
  const [pending, setPending] = useState(false);
  const [visibleRows, setVisibleRows] = useState(15);
  const [groupTicks, setGroupTicks] = useState<1 | 2 | 5>(1);
  const [autoCenter, setAutoCenter] = useState(true);
  const [manualCenter, setManualCenter] = useState<number>();
  const [printThreshold, setPrintThreshold] = useState(0);
  const [clusterMode, setClusterMode] = useState<"VOLUME" | "DELTA" | "BIDASK">("VOLUME");
  const [clusterPeriod, setClusterPeriod] = useState<5 | 15 | 60>(15);
  const [rowHeight, setRowHeight] = useState<18 | 22 | 26>(22);
  const [depthScale, setDepthScale] = useState<"AUTO" | "500" | "2000" | "10000">("AUTO");
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!panelRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      let rows = Math.max(3, Math.min(49, Math.floor((entry.contentRect.height - 190) / rowHeight)));
      if (rows % 2 === 0) rows -= 1;
      setVisibleRows(rows);
    });
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, [rowHeight]);

  const nativeTick = Math.max(0.001, Number(book.tickSize || instrument.tickSize || 0.01));
  const step = nativeTick * groupTicks;
  const marketCenter = useMemo(() => {
    if (book.bestBid && book.bestAsk) return (Number(book.bestBid) + Number(book.bestAsk)) / 2;
    if (book.lastTrade) return Number(book.lastTrade);
    if (book.bestBid) return Number(book.bestBid) + step;
    if (book.bestAsk) return Number(book.bestAsk) - step;
    return 0.5;
  }, [book.bestAsk, book.bestBid, book.lastTrade, step]);
  const center = autoCenter ? marketCenter : (manualCenter ?? marketCenter);
  const bucket = (price: number) => Math.round(price / step) * step;
  const groupedBids = useMemo(() => {
    const result = new Map<number, number>();
    book.bids.forEach((value, price) => {
      const key = bucket(Number(price));
      result.set(key, (result.get(key) ?? 0) + Number(value));
    });
    return result;
  }, [book.bids, step]);
  const groupedAsks = useMemo(() => {
    const result = new Map<number, number>();
    book.asks.forEach((value, price) => {
      const key = bucket(Number(price));
      result.set(key, (result.get(key) ?? 0) + Number(value));
    });
    return result;
  }, [book.asks, step]);
  const rowPrices = useMemo(() => {
    const centerIndex = Math.round(center / step);
    const half = Math.floor(visibleRows / 2);
    return Array.from({ length: visibleRows }, (_, index) => (centerIndex + half - index) * step)
      .filter((price) => price > 0 && price < 1);
  }, [center, step, visibleRows]);
  const prints = useMemo(() => {
    const result = new Map<number, { buy: number; sell: number; count: number }>();
    book.recentTrades.forEach((trade) => {
      const sizeValue = Number(trade.size);
      if (sizeValue < printThreshold) return;
      const key = bucket(Number(trade.price));
      const current = result.get(key) ?? { buy: 0, sell: 0, count: 0 };
      current[trade.side === "BUY" ? "buy" : "sell"] += sizeValue;
      current.count += 1;
      result.set(key, current);
    });
    return result;
  }, [book.recentTrades, printThreshold, step]);
  const clusterColumns = useMemo(() => {
    const periodMs = clusterPeriod * 1000;
    const anchor = book.recentTrades.reduce((latest, trade) => Math.max(latest, tradeTime(trade.timestamp)), Date.now());
    return Array.from({ length: 3 }, (_, columnIndex) => {
      const end = anchor - columnIndex * periodMs;
      const start = end - periodMs;
      const levels = new Map<number, { buy: number; sell: number }>();
      book.recentTrades.forEach((trade) => {
        const timestamp = tradeTime(trade.timestamp);
        if (timestamp < start || timestamp >= end) return;
        const key = bucket(Number(trade.price));
        const level = levels.get(key) ?? { buy: 0, sell: 0 };
        level[trade.side === "BUY" ? "buy" : "sell"] += Number(trade.size);
        levels.set(key, level);
      });
      return { label: columnIndex === 0 ? "NOW" : `-${columnIndex * clusterPeriod}s`, levels };
    }).reverse();
  }, [book.recentTrades, clusterPeriod, step]);
  const ownOrders = useMemo(
    () => sessionOrders.filter((order) => order.assetId === instrument.assetId && order.execution === "GTC" && order.status.includes("ACCEPTED")),
    [instrument.assetId, sessionOrders],
  );
  const autoDepth = Math.max(1, ...groupedBids.values(), ...groupedAsks.values());
  const maxDepth = depthScale === "AUTO" ? autoDepth : Number(depthScale);
  const maxPrint = Math.max(1, ...[...prints.values()].map((print) => print.buy + print.sell));
  const bidDepth = [...book.bids.values()].reduce((sum, value) => sum + Number(value), 0);
  const askDepth = [...book.asks.values()].reduce((sum, value) => sum + Number(value), 0);
  const totalDepth = bidDepth + askDepth;
  const bidShare = totalDepth > 0 ? (bidDepth / totalDepth) * 100 : 50;
  const rollingPrintVolume = book.recentTrades.reduce((sum, trade) => sum + Number(trade.size), 0);
  const disabled = pending || connection !== "live" || !book.ready || Number(size) <= 0;

  const clusterLabel = (level?: { buy: number; sell: number }) => {
    if (!level) return "";
    if (clusterMode === "BIDASK") return `${compactNumber(level.buy)}×${compactNumber(level.sell)}`;
    const value = clusterMode === "DELTA" ? level.buy - level.sell : level.buy + level.sell;
    return `${value > 0 && clusterMode === "DELTA" ? "+" : ""}${compactNumber(value)}`;
  };

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

  const row = (numericPrice: number) => {
    const key = bucket(numericPrice);
    const bidSize = groupedBids.get(key) ?? 0;
    const askSize = groupedAsks.get(key) ?? 0;
    const bidBar = Math.min(100, (bidSize / maxDepth) * 100);
    const askBar = Math.min(100, (askSize / maxDepth) * 100);
    const price = numericPrice.toFixed(Math.max(2, String(nativeTick).split(".")[1]?.length ?? 2));
    const print = prints.get(key);
    const printSize = print ? print.buy + print.sell : 0;
    const bubbleSize = print ? 17 + Math.sqrt(printSize / maxPrint) * 23 : 0;
    const printSide = !print ? "" : print.buy > print.sell ? "buy" : print.sell > print.buy ? "sell" : "mixed";
    const atLast = book.lastTrade && Math.abs(bucket(Number(book.lastTrade)) - key) < step / 2;
    const rowOrders = ownOrders.filter((order) => Math.abs(bucket(Number(order.price)) - key) < step / 2);
    const buyOrders = rowOrders.filter((order) => order.side === "BUY");
    const sellOrders = rowOrders.filter((order) => order.side === "SELL");
    return (
      <div className={`dom-row ${atLast ? "last-price" : ""}`} key={price} style={{ height: rowHeight }}>
        {clusterColumns.map((column) => {
          const level = column.levels.get(key);
          const delta = (level?.buy ?? 0) - (level?.sell ?? 0);
          return (
            <div className={`cluster-cell ${delta > 0 ? "cluster-buy" : delta < 0 ? "cluster-sell" : ""}`} key={column.label} title={level ? `${compactNumber(level.buy)} bought / ${compactNumber(level.sell)} sold` : "No prints in this bucket"}>
              {clusterLabel(level)}
            </div>
          );
        })}
        <button
          className="order-lane buy-lane"
          disabled={disabled}
          title={`Rest BUY ${size} ${sizeUnit.toLowerCase()} at ${priceLabel(price)}`}
          onClick={() => place("BUY", price, "GTC")}
        >
          {buyOrders.length ? <b className={buyOrders.some((order) => order.mode === "LIVE") ? "working-live" : "working-dry"}>{buyOrders.length}</b> : "BUY"}
        </button>
        <button
          className="liquidity bid-size"
          disabled={disabled || bidSize <= 0}
          title={bidSize > 0 ? `Hit bid: SELL at ${priceLabel(price)} or better` : "No resting bids at this tick"}
          onClick={() => bidSize > 0 && place("SELL", price, "FAK")}
        >
          {bidSize > 0 && <span className="depth" style={{ width: `${bidBar}%` }} />}
          <span className="level-value">{bidSize > 0 ? compactNumber(bidSize) : ""}</span>
        </button>
        <div className="price-cell">{priceLabel(price)}</div>
        <button
          className="liquidity ask-size"
          disabled={disabled || askSize <= 0}
          title={askSize > 0 ? `Lift ask: BUY at ${priceLabel(price)} or better` : "No resting asks at this tick"}
          onClick={() => askSize > 0 && place("BUY", price, "FAK")}
        >
          {askSize > 0 && <span className="depth" style={{ width: `${askBar}%` }} />}
          <span className="level-value">{askSize > 0 ? compactNumber(askSize) : ""}</span>
        </button>
        <button
          className="order-lane sell-lane"
          disabled={disabled}
          title={`Rest SELL ${size} ${sizeUnit.toLowerCase()} at ${priceLabel(price)}`}
          onClick={() => place("SELL", price, "GTC")}
        >
          {sellOrders.length ? <b className={sellOrders.some((order) => order.mode === "LIVE") ? "working-live" : "working-dry"}>{sellOrders.length}</b> : "SELL"}
        </button>
        <div className="print-cell">
          {print && (
            <i
              className={`volume-bubble bubble-${printSide}`}
              style={{ width: bubbleSize, height: bubbleSize }}
              title={`${print.count} prints · ${compactNumber(print.buy)} buy / ${compactNumber(print.sell)} sell shares`}
            >{compactNumber(printSize)}</i>
          )}
        </div>
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
            <span className="book-context">{instrument.leagueName ?? instrument.category} · {startLabel(instrument.startTime)}</span>
          </div>
          <span className={`outcome outcome-${instrument.outcome.toLowerCase()}`}>{instrument.outcome}</span>
        </div>
        <div className="book-header-meta">
          <span><b>{money(instrument.volume24hr)}</b> 24H</span>
          {instrument.leagueId && <button className={`icon-button star-button ${leagueFavorite ? "active" : ""}`} onClick={onToggleLeagueFavorite} aria-label={leagueFavorite ? `Remove ${instrument.leagueName} favorite` : `Favorite ${instrument.leagueName}`}>★</button>}
          <button className={`icon-button focus-button ${focused ? "active" : ""}`} onClick={onToggleFocus} aria-label={focused ? "Exit focus" : "Focus order book"}>{focused ? "↙" : "↗"}</button>
          <button className="icon-button" onClick={onClose} aria-label="Close order book">×</button>
        </div>
      </header>

      <div className="position-strip">
        <span>POS <b>{position ? compactNumber(Number(position.currentSize)) : "—"}</b></span>
        <span>AVG <b>{position ? priceLabel(position.avgPrice) : "—"}</b></span>
        <span>PNL <b className={position && Number(position.totalPnl) < 0 ? "negative" : "positive"}>{position ? signedMoney(Number(position.totalPnl)) : "$0.00"}</b></span>
        <span>SPREAD <b>{spread === undefined ? "—" : `${(spread * 100).toFixed(1)}¢`}</b></span>
        <div className="flow-settings">
          <select value={clusterMode} onChange={(event) => setClusterMode(event.target.value as typeof clusterMode)} title="Cluster calculation">
            <option value="VOLUME">VOL</option>
            <option value="DELTA">Δ</option>
            <option value="BIDASK">B×A</option>
          </select>
          <select value={clusterPeriod} onChange={(event) => setClusterPeriod(Number(event.target.value) as typeof clusterPeriod)} title="Cluster time bucket">
            <option value={5}>5s</option>
            <option value={15}>15s</option>
            <option value={60}>60s</option>
          </select>
          <select value={depthScale} onChange={(event) => setDepthScale(event.target.value as typeof depthScale)} title="Depth heatmap maximum">
            <option value="AUTO">MAX A</option>
            <option value="500">MAX 500</option>
            <option value="2000">MAX 2K</option>
            <option value="10000">MAX 10K</option>
          </select>
          <select value={rowHeight} onChange={(event) => setRowHeight(Number(event.target.value) as typeof rowHeight)} title="DOM row height">
            <option value={18}>ROW 18</option>
            <option value={22}>ROW 22</option>
            <option value={26}>ROW 26</option>
          </select>
        </div>
      </div>

      <div className="trade-strip dom-toolbar">
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
        <div className="dom-controls">
          <div className="tick-groups" aria-label="Price aggregation">
            {([1, 2, 5] as const).map((value) => <button className={groupTicks === value ? "active" : ""} key={value} onClick={() => setGroupTicks(value)}>{value}T</button>)}
          </div>
          <button className={`center-button ${autoCenter ? "active" : ""}`} onClick={() => { setAutoCenter(true); setManualCenter(undefined); }} title="Recenter price ladder (C)">◎ C</button>
          <select value={printThreshold} onChange={(event) => setPrintThreshold(Number(event.target.value))} title="Minimum executed trade size shown">
            <option value={0}>ALL PRINTS</option>
            <option value={50}>≥50</option>
            <option value={200}>≥200</option>
            <option value={500}>≥500</option>
          </select>
        </div>
        <div className="depth-summary" title={`Full visible book: ${compactNumber(bidDepth)} bid shares / ${compactNumber(askDepth)} ask shares`}>
          <span style={{ width: `${bidShare}%` }} />
          <b>B {bidShare.toFixed(0)}%</b>
          <b>A {(100 - bidShare).toFixed(0)}%</b>
        </div>
      </div>

      <div className="book-body dom-body">
        <div className="ladder-stack">
          <div className="dom-columns">
            {clusterColumns.map((column) => <span className="cluster-heading" key={column.label}>{column.label}</span>)}
            <span>BUY</span>
            <span>BID DEPTH</span>
            <span>PRICE</span>
            <span>ASK DEPTH</span>
            <span>SELL</span>
            <span>EXECUTED</span>
          </div>
          <div
            className={`book-ladder ${autoCenter ? "auto-centered" : "manual-centered"}`}
            onWheel={(event) => {
              event.preventDefault();
              const next = Math.max(step, Math.min(1 - step, center - Math.sign(event.deltaY) * step * 3));
              setAutoCenter(false);
              setManualCenter(next);
            }}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key.toLowerCase() === "c") {
                setAutoCenter(true);
                setManualCenter(undefined);
              }
            }}
          >
            {!book.ready && <div className="book-loading">Waiting for book snapshot…</div>}
            {rowPrices.map(row)}
          </div>
        </div>
      </div>

      <footer className="book-footer">
        <span>Tick {book.tickSize}</span>
        <span>Group {groupTicks}T</span>
        <span>Min {instrument.minOrderSize} sh</span>
        <span>Depth {compactNumber(totalDepth)} sh</span>
        <span>Prints {compactNumber(rollingPrintVolume)} sh</span>
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

type DockTab = "ORDERS" | "MARKET TAPE" | "POSITIONS" | "ACCOUNT" | "TRADE LOG";

interface TapeExecution {
  instrument: Instrument;
  trade: TradePrint;
}

interface BottomDockProps {
  activeTab: DockTab;
  height: number;
  collapsed: boolean;
  accountStatus: AccountStatus;
  snapshot?: AccountSnapshot;
  orders: OrderResult[];
  tape: TapeExecution[];
  logs: TradeLogEntry[];
  onTab(tab: DockTab): void;
  onToggle(): void;
  onResizeStart(event: ReactPointerEvent<HTMLDivElement>): void;
  onCancelAll(): void;
}

function BottomDock({
  activeTab,
  height,
  collapsed,
  accountStatus,
  snapshot,
  orders,
  tape,
  logs,
  onTab,
  onToggle,
  onResizeStart,
  onCancelAll,
}: BottomDockProps) {
  const tabs: Array<{ id: DockTab; count?: number }> = [
    { id: "ORDERS", count: snapshot?.openOrderCount ?? orders.filter((order) => order.mode === "LIVE" && order.status.includes("ACCEPTED")).length },
    { id: "MARKET TAPE", count: tape.length },
    { id: "POSITIONS", count: snapshot?.openPositions.length ?? 0 },
    { id: "ACCOUNT" },
    { id: "TRADE LOG", count: logs.length },
  ];

  return (
    <section className={`bottom-dock ${collapsed ? "collapsed" : ""}`} style={{ height: collapsed ? 31 : height }}>
      <div className="dock-resizer" onPointerDown={onResizeStart} title="Drag to resize blotter" />
      <nav className="dock-tabs">
        {tabs.map((tab) => (
          <button key={tab.id} className={activeTab === tab.id && !collapsed ? "active" : ""} onClick={() => { onTab(tab.id); if (collapsed) onToggle(); }}>
            {tab.id}{tab.count !== undefined && <b>{tab.count}</b>}
          </button>
        ))}
        <span className="dock-note">{activeTab === "MARKET TAPE" ? "PUBLIC CLOB PRINTS · NOT PERSONAL FILLS" : accountStatus.connected ? shortAddress(accountStatus.account?.wallet) : "ACCOUNT OFFLINE"}</span>
        <button className="dock-toggle" onClick={onToggle}>{collapsed ? "▴" : "▾"}</button>
      </nav>
      {!collapsed && (
        <div className="dock-content">
          {activeTab === "ORDERS" && (
            <div className="blotter-table orders-table">
              <header><span>TIME</span><span>MODE</span><span>MARKET / OUTCOME</span><span>SIDE</span><span>QTY</span><span>PRICE</span><span>TYPE</span><span>STATUS</span></header>
              {orders.length === 0 && <div className="dock-empty">No session orders. Resting GTC orders appear in the outer DOM rails after submission.</div>}
              {orders.map((order) => (
                <div key={`${order.createdAt}-${order.orderId ?? order.assetId}`}>
                  <span>{new Date(order.createdAt).toLocaleTimeString()}</span>
                  <span className={order.mode === "LIVE" ? "live-text" : "dry-text"}>{order.mode}</span>
                  <span title={order.marketTitle}>{order.marketTitle} · {order.outcome}</span>
                  <span className={order.side === "BUY" ? "buy-text" : "sell-text"}>{order.side}</span>
                  <span>{order.size} {order.sizeUnit === "SHARES" ? "sh" : "$"}</span>
                  <span>{priceLabel(order.price)}</span>
                  <span>{order.execution}</span>
                  <span title={order.message}>{order.status}</span>
                </div>
              ))}
            </div>
          )}
          {activeTab === "MARKET TAPE" && (
            <div className="blotter-table tape-table">
              <header><span>TIME</span><span>LEAGUE</span><span>MARKET / OUTCOME</span><span>AGGRESSOR</span><span>PRICE</span><span>SIZE</span></header>
              {tape.length === 0 && <div className="dock-empty">Waiting for public market prints from the open books.</div>}
              {tape.map(({ instrument, trade }) => (
                <div key={`${instrument.assetId}-${trade.id}`}>
                  <span>{new Date(tradeTime(trade.timestamp)).toLocaleTimeString()}</span>
                  <span>{instrument.leagueName ?? instrument.category}</span>
                  <span title={instrument.marketTitle}>{instrument.marketTitle} · {instrument.outcome}</span>
                  <span className={trade.side === "BUY" ? "buy-text" : "sell-text"}>{trade.side}</span>
                  <span>{priceLabel(trade.price)}</span>
                  <span>{compactNumber(Number(trade.size))} sh</span>
                </div>
              ))}
            </div>
          )}
          {activeTab === "POSITIONS" && (
            <div className="blotter-table positions-table">
              <header><span>MARKET / OUTCOME</span><span>SIZE</span><span>AVG</span><span>MARK</span><span>VALUE</span><span>PNL</span></header>
              {!accountStatus.connected && <div className="dock-empty">Connect an account to load positions and PnL.</div>}
              {accountStatus.connected && !snapshot && <div className="dock-empty">Open Account and refresh to load positions.</div>}
              {snapshot?.openPositions.map((position) => (
                <div key={`${position.conditionId}-${position.assetId}`}>
                  <span title={position.title}>{position.title} · {position.outcome}</span>
                  <span>{compactNumber(Number(position.currentSize))}</span>
                  <span>{priceLabel(position.avgPrice)}</span>
                  <span>{priceLabel(position.currentPrice)}</span>
                  <span>{money(Number(position.currentValue))}</span>
                  <span className={Number(position.totalPnl) >= 0 ? "buy-text" : "sell-text"}>{signedMoney(Number(position.totalPnl))}</span>
                </div>
              ))}
            </div>
          )}
          {activeTab === "ACCOUNT" && (
            <div className="dock-account">
              <article><span>WALLET</span><b>{shortAddress(accountStatus.account?.wallet)}</b></article>
              <article><span>PORTFOLIO</span><b>{snapshot ? money(Number(snapshot.portfolioValue)) : "—"}</b></article>
              <article><span>OPEN ORDERS</span><b>{snapshot?.openOrderCount ?? "—"}</b></article>
              <article><span>REGION</span><b>{accountStatus.geoblock.blocked === false ? `${accountStatus.geoblock.country || "OK"} · ALLOWED` : accountStatus.geoblock.blocked ? "BLOCKED" : "UNVERIFIED"}</b></article>
              <article><span>TRADING</span><b className={accountStatus.armed ? "sell-text" : "dry-text"}>{accountStatus.armed ? `LIVE · $${accountStatus.maxOrderUsd} CAP` : "DRY"}</b></article>
              <button onClick={onCancelAll} disabled={!accountStatus.connected}>CANCEL ALL OPEN ORDERS</button>
            </div>
          )}
          {activeTab === "TRADE LOG" && (
            <div className="trade-log">
              {logs.length === 0 && <div className="dock-empty">Session events will appear here.</div>}
              {logs.map((entry) => <div className={`log-${entry.tone}`} key={entry.id}><time>{entry.time}</time><span>{entry.message}</span></div>)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function App() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [leagues, setLeagues] = useState<MarketLeague[]>([]);
  const [openInstruments, setOpenInstruments] = useState<Instrument[]>([]);
  const [books, setBooks] = useState<Map<string, BookState>>(new Map());
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [query, setQuery] = useState("");
  const [marketView, setMarketView] = useState<"Leagues" | "Favorites" | "Recent">("Leagues");
  const [favoriteLeagueIds, setFavoriteLeagueIds] = useState<Set<string>>(() => new Set(readStoredIds(FAVORITE_LEAGUES_KEY)));
  const [expandedLeagueIds, setExpandedLeagueIds] = useState<Set<string>>(new Set());
  const [loadedLeagueIds, setLoadedLeagueIds] = useState<Set<string>>(new Set());
  const [loadingLeagueIds, setLoadingLeagueIds] = useState<Set<string>>(new Set());
  const [leagueErrors, setLeagueErrors] = useState<Map<string, string>>(new Map());
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
  const [sessionOrders, setSessionOrders] = useState<OrderResult[]>([]);
  const [tradeLog, setTradeLog] = useState<TradeLogEntry[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<(typeof WORKSPACE_SLOTS)[number]>(() => {
    const stored = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    return WORKSPACE_SLOTS.includes(stored as (typeof WORKSPACE_SLOTS)[number]) ? stored as (typeof WORKSPACE_SLOTS)[number] : "SCALP 1";
  });
  const [navigatorWidth, setNavigatorWidth] = useState(() => Math.max(240, Math.min(520, readStoredNumber(NAV_WIDTH_KEY, 326))));
  const [dockHeight, setDockHeight] = useState(() => Math.max(100, Math.min(360, readStoredNumber(DOCK_HEIGHT_KEY, 156))));
  const [dockCollapsed, setDockCollapsed] = useState(true);
  const [dockTab, setDockTab] = useState<DockTab>("ORDERS");
  const dragIndex = useRef<number | undefined>(undefined);
  const booksWorkspaceRef = useRef<HTMLElement>(null);
  const initializedLeagueTree = useRef(false);

  const loadLeague = useCallback(async (seriesId: string) => {
    if (loadedLeagueIds.has(seriesId) || loadingLeagueIds.has(seriesId)) return;
    setLoadingLeagueIds((current) => new Set(current).add(seriesId));
    setLeagueErrors((current) => {
      const next = new Map(current);
      next.delete(seriesId);
      return next;
    });
    try {
      const items = await bridge.listLeagueMarkets(seriesId);
      setInstruments((current) => mergeInstruments(current, items));
      setLoadedLeagueIds((current) => new Set(current).add(seriesId));
    } catch (error) {
      setLeagueErrors((current) => new Map(current).set(seriesId, error instanceof Error ? error.message : "Could not load league"));
    } finally {
      setLoadingLeagueIds((current) => {
        const next = new Set(current);
        next.delete(seriesId);
        return next;
      });
    }
  }, [loadedLeagueIds, loadingLeagueIds]);

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
    Promise.all([bridge.listMarkets(), bridge.listLeagues()])
      .then(([items, leagueItems]) => {
        if (!active) return;
        setInstruments(items);
        setLeagues(leagueItems);
        const workspaceIds = readStoredIds(`${WORKSPACE_KEY}:${activeWorkspace}`);
        const savedIds = workspaceIds.length ? workspaceIds : readStoredIds(STORAGE_KEY);
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
    if (initializedLeagueTree.current || leagues.length === 0) return;
    initializedLeagueTree.current = true;
    const favoriteTargets = leagues.filter((league) => favoriteLeagueIds.has(league.seriesId));
    const fallback = leagues.find((league) => league.slug === "nba") ?? leagues[0];
    const targets = favoriteTargets.length ? favoriteTargets : fallback ? [fallback] : [];
    setExpandedLeagueIds(new Set(targets.map((league) => league.seriesId)));
    targets.forEach((league) => void loadLeague(league.seriesId));
  }, [favoriteLeagueIds, leagues, loadLeague]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(openInstruments.map((item) => item.assetId)));
    localStorage.setItem(`${WORKSPACE_KEY}:${activeWorkspace}`, JSON.stringify(openInstruments.map((item) => item.assetId)));
  }, [activeWorkspace, openInstruments]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, activeWorkspace);
    localStorage.setItem(`${WORKSPACE_KEY}:${activeWorkspace}:layout`, layoutMode);
  }, [activeWorkspace, layoutMode]);

  useEffect(() => {
    localStorage.setItem(NAV_WIDTH_KEY, String(navigatorWidth));
  }, [navigatorWidth]);

  useEffect(() => {
    localStorage.setItem(DOCK_HEIGHT_KEY, String(dockHeight));
  }, [dockHeight]);

  useEffect(() => {
    setTradeLog((current) => prependTradeLog(current, connection === "live" ? "good" : connection === "error" ? "bad" : "info", `Market data ${connection}`));
  }, [connection]);

  useEffect(() => {
    localStorage.setItem(FAVORITE_LEAGUES_KEY, JSON.stringify([...favoriteLeagueIds]));
  }, [favoriteLeagueIds]);

  useEffect(() => {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(recentIds));
  }, [recentIds]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), 3600);
    return () => clearTimeout(timer);
  }, [toast]);

  const filteredLeagues = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const major = ["nba", "nfl", "nhl", "mlb", "epl", "mls", "ufc", "wnba"];
    return leagues
      .filter((league) => marketView !== "Favorites" || favoriteLeagueIds.has(league.seriesId))
      .filter((league) => {
        if (!needle) return true;
        if (`${league.name} ${league.slug}`.toLowerCase().includes(needle)) return true;
        return instruments.some((item) => item.leagueId === league.seriesId && `${item.eventTitle} ${item.marketTitle} ${item.outcome}`.toLowerCase().includes(needle));
      })
      .sort((a, b) => {
        const favoriteDelta = Number(favoriteLeagueIds.has(b.seriesId)) - Number(favoriteLeagueIds.has(a.seriesId));
        if (favoriteDelta) return favoriteDelta;
        const aMajor = major.indexOf(a.slug);
        const bMajor = major.indexOf(b.slug);
        if (aMajor >= 0 || bMajor >= 0) return (aMajor < 0 ? 999 : aMajor) - (bMajor < 0 ? 999 : bMajor);
        return a.name.localeCompare(b.name);
      })
      .slice(0, 100);
  }, [favoriteLeagueIds, instruments, leagues, marketView, query]);

  const recentInstruments = useMemo(
    () => recentIds.map((assetId) => instruments.find((item) => item.assetId === assetId)).filter((item): item is Instrument => Boolean(item)),
    [instruments, recentIds],
  );

  const searchResults = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || marketView === "Recent") return [];
    return instruments
      .filter((item) => `${item.leagueName ?? ""} ${item.eventTitle} ${item.marketTitle} ${item.outcome} ${item.tags.join(" ")}`.toLowerCase().includes(needle))
      .sort((a, b) => b.volume24hr - a.volume24hr)
      .slice(0, 24);
  }, [instruments, marketView, query]);

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
  const publicTape = useMemo<TapeExecution[]>(() => openInstruments
    .flatMap((instrument) => (books.get(instrument.assetId)?.recentTrades ?? []).map((trade) => ({ instrument, trade })))
    .sort((a, b) => tradeTime(b.trade.timestamp) - tradeTime(a.trade.timestamp))
    .slice(0, 150), [books, openInstruments]);

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
    if (accountStatus.connected && !accountSnapshot) refreshAccount();
  }, [accountSnapshot, accountStatus.connected, refreshAccount]);

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

  const switchWorkspace = async (nextWorkspace: (typeof WORKSPACE_SLOTS)[number]) => {
    if (nextWorkspace === activeWorkspace) return;
    const savedIds = readStoredIds(`${WORKSPACE_KEY}:${nextWorkspace}`);
    const target = savedIds
      .map((assetId) => instruments.find((instrument) => instrument.assetId === assetId))
      .filter((instrument): instrument is Instrument => Boolean(instrument))
      .slice(0, MAX_OPEN_BOOKS);
    const oldIds = openInstruments.map((instrument) => instrument.assetId);
    if (oldIds.length) await bridge.unsubscribeAssets(oldIds);
    setOpenInstruments(target);
    setBooks(new Map(target.map((instrument) => [instrument.assetId, freshBook(instrument)])));
    setFocusedAssetId(undefined);
    setActiveWorkspace(nextWorkspace);
    const savedLayout = localStorage.getItem(`${WORKSPACE_KEY}:${nextWorkspace}:layout`);
    if (savedLayout === "AUTO" || savedLayout === "1" || savedLayout === "2" || savedLayout === "3") setLayoutMode(savedLayout);
    if (target.length) await bridge.subscribeAssets(target.map((instrument) => instrument.assetId));
    setTradeLog((current) => prependTradeLog(current, "info", `Workspace changed to ${nextWorkspace}`));
  };

  const resizeNavigator = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = navigatorWidth;
    const move = (moveEvent: PointerEvent) => setNavigatorWidth(Math.max(240, Math.min(520, startWidth + moveEvent.clientX - startX)));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const resizeDock = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (dockCollapsed) setDockCollapsed(false);
    const startY = event.clientY;
    const startHeight = dockHeight;
    const move = (moveEvent: PointerEvent) => setDockHeight(Math.max(100, Math.min(360, startHeight + startY - moveEvent.clientY)));
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  const toggleLeagueFavorite = useCallback((seriesId: string) => {
    setFavoriteLeagueIds((current) => {
      const next = new Set(current);
      if (next.has(seriesId)) next.delete(seriesId);
      else next.add(seriesId);
      return next;
    });
  }, []);

  const toggleLeagueExpanded = (seriesId: string) => {
    const opening = !expandedLeagueIds.has(seriesId);
    setExpandedLeagueIds((current) => {
      const next = new Set(current);
      if (next.has(seriesId)) next.delete(seriesId);
      else next.add(seriesId);
      return next;
    });
    if (opening) void loadLeague(seriesId);
  };

  const submitOrder = async (draft: OrderDraft) => {
    try {
      const result = await bridge.submitOrder(draft);
      setSessionOrders((current) => [result, ...current].slice(0, 250));
      setTradeLog((current) => prependTradeLog(current, result.status.includes("ACCEPTED") ? "good" : "bad", `${result.status} · ${draft.side} ${draft.size} ${draft.sizeUnit} ${draft.outcome} @ ${priceLabel(draft.price)} ${draft.execution}`));
      setToast({
        id: Date.now(),
        tone: result.status.includes("ACCEPTED") ? "good" : "bad",
        message: `${result.status}: ${draft.side} ${draft.size} ${draft.sizeUnit} ${draft.outcome} @ ${priceLabel(draft.price)} ${draft.execution}${result.message ? ` · ${result.message}` : ""}`,
      });
      if (draft.mode === "LIVE") refreshAccount();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Order rejected";
      setTradeLog((current) => prependTradeLog(current, "bad", message));
      setToast({
        id: Date.now(),
        tone: "bad",
        message,
      });
    }
  };

  const connectAccount = async (request: { privateKey: string; walletAddress?: string }) => {
    const status = await bridge.connectAccount(request);
    setAccountStatus(status);
    setAccountSnapshot(undefined);
    setLoginOpen(false);
    setAccountOpen(true);
    setTradeLog((current) => prependTradeLog(current, "good", `Account connected ${shortAddress(status.account?.wallet)} · live disarmed`));
    setToast({ id: Date.now(), tone: "good", message: `CONNECTED: ${shortAddress(status.account?.wallet)} · live remains disarmed` });
  };

  const disconnectAccount = async () => {
    setAccountStatus(await bridge.disconnectAccount());
    setAccountSnapshot(undefined);
    setTradeLog((current) => prependTradeLog(current, "info", "Account disconnected and session key cleared"));
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
      setTradeLog((current) => prependTradeLog(current, status.armed ? "bad" : "info", status.armed ? `Live trading armed · $${status.maxOrderUsd} order cap` : "Live trading disarmed"));
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
      setSessionOrders((current) => current.map((order) => order.mode === "LIVE" && order.execution === "GTC" && order.status.includes("ACCEPTED") ? { ...order, status: "CANCELED" } : order));
      setTradeLog((current) => prependTradeLog(current, "good", `${result.status} · ${result.canceled.length} orders canceled`));
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
      <header className="topbar" style={{ gridTemplateColumns: `${drawerCollapsed ? 72 : navigatorWidth}px minmax(280px, 1fr) auto` }}>
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
          <div className="workspace-tabs" aria-label="Saved workspaces">
            {WORKSPACE_SLOTS.map((slot) => <button key={slot} className={activeWorkspace === slot ? "active" : ""} onClick={() => void switchWorkspace(slot)}>{slot}</button>)}
          </div>
          <span>{openInstruments.length} DOM · {gridColumns}×{gridRows}</span>
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

      <div className={`workspace ${drawerCollapsed ? "drawer-collapsed" : ""}`} style={{ gridTemplateColumns: drawerCollapsed ? "0 minmax(0, 1fr)" : `${navigatorWidth}px minmax(0, 1fr)` }}>
        <aside className="market-drawer">
          <div className="drawer-heading">
            <span>SPORTS NAVIGATOR</span>
            <span>{leagues.length} LEAGUES</span>
          </div>
          <div className="search-wrap">
            <span>⌕</span>
            <input
              className="market-search"
              placeholder="Search league, game, market…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && <button onClick={() => setQuery("")} aria-label="Clear search">×</button>}
          </div>
          <div className="market-view-tabs">
            {(["Leagues", "Favorites", "Recent"] as const).map((view) => (
              <button key={view} className={marketView === view ? "active" : ""} onClick={() => setMarketView(view)}>
                {view === "Favorites" ? "★ Favorites" : view}
                {view === "Favorites" && <b>{favoriteLeagueIds.size}</b>}
              </button>
            ))}
          </div>
          <div className="market-list">
            {loading && <div className="drawer-message">Loading leagues and active markets…</div>}
            {marketError && <div className="drawer-message error">{marketError}</div>}
            {!loading && !marketError && marketView !== "Recent" && filteredLeagues.length === 0 && (
              <div className="drawer-message">No leagues in this view. Star a league such as NBA to keep its whole schedule here.</div>
            )}

            {marketView !== "Recent" && filteredLeagues.map((league) => {
              const expanded = expandedLeagueIds.has(league.seriesId);
              const favorite = favoriteLeagueIds.has(league.seriesId);
              const loadingLeague = loadingLeagueIds.has(league.seriesId);
              const leagueItems = instruments.filter((item) => item.leagueId === league.seriesId);
              const groupedEvents = eventGroups(leagueItems);
              const recentCutoff = Date.now() - 6 * 60 * 60 * 1000;
              const relevantEvents = groupedEvents.filter((group) => {
                const time = group.instruments[0]?.startTime;
                return !time || new Date(time).getTime() >= recentCutoff;
              });
              const shownEvents = (relevantEvents.length ? relevantEvents : groupedEvents).slice(0, 14);
              return (
                <section className={`league-node ${expanded ? "expanded" : ""}`} key={league.seriesId}>
                  <div
                    className="league-header"
                    role="button"
                    tabIndex={0}
                    onClick={() => toggleLeagueExpanded(league.seriesId)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") toggleLeagueExpanded(league.seriesId);
                    }}
                  >
                    <span className="league-chevron">{expanded ? "▾" : "▸"}</span>
                    {league.image ? <img src={league.image} alt="" /> : <i>{league.name.slice(0, 2).toUpperCase()}</i>}
                    <div>
                      <strong>{league.name}</strong>
                      <span>{loadedLeagueIds.has(league.seriesId) ? `${groupedEvents.length} upcoming events` : "Open schedule"}</span>
                    </div>
                    <button
                      className={`league-star ${favorite ? "active" : ""}`}
                      aria-label={favorite ? `Remove ${league.name} from favorites` : `Favorite ${league.name}`}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleLeagueFavorite(league.seriesId);
                        if (!loadedLeagueIds.has(league.seriesId)) void loadLeague(league.seriesId);
                      }}
                    >★</button>
                  </div>

                  {expanded && (
                    <div className="league-events">
                      {loadingLeague && <div className="league-state">Loading {league.name} schedule…</div>}
                      {leagueErrors.has(league.seriesId) && <div className="league-state error">{leagueErrors.get(league.seriesId)}</div>}
                      {!loadingLeague && loadedLeagueIds.has(league.seriesId) && shownEvents.length === 0 && <div className="league-state">No active events.</div>}
                      {shownEvents.map((group) => {
                        const eventInstrument = group.instruments[0];
                        const contracts = new Map<string, Instrument[]>();
                        group.instruments.forEach((item) => contracts.set(item.conditionId, [...(contracts.get(item.conditionId) ?? []), item]));
                        return (
                          <details className="event-node" key={group.id}>
                            <summary>
                              <div>
                                <strong>{eventInstrument.eventTitle}</strong>
                                <time title={eventInstrument.startTime ? new Date(eventInstrument.startTime).toLocaleString() : "Start time not published"}>{startLabel(eventInstrument.startTime)}</time>
                              </div>
                              <span>{contracts.size} MKT</span>
                            </summary>
                            <div className="event-contracts">
                              {[...contracts.values()].slice(0, 12).map((contract) => {
                                const first = contract[0];
                                const label = first.marketTitle === first.eventTitle
                                  ? (first.sportsMarketType || "Moneyline").replaceAll("_", " ")
                                  : first.marketTitle.replace(`${first.eventTitle}: `, "");
                                return (
                                  <div className="contract-row" key={first.conditionId}>
                                    <span title={first.marketTitle}>{label}</span>
                                    <div>
                                      {contract.map((instrument) => {
                                        const isOpen = openInstruments.some((item) => item.assetId === instrument.assetId);
                                        return <button className={isOpen ? "open" : ""} key={instrument.assetId} onClick={() => openBook(instrument)}>{instrument.outcome}<b>{isOpen ? "●" : "+"}</b></button>;
                                      })}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </details>
                        );
                      })}
                    </div>
                  )}
                </section>
              );
            })}

            {marketView === "Recent" && recentInstruments.length === 0 && <div className="drawer-message">Open a market outcome and it will appear here.</div>}
            {marketView === "Recent" && recentInstruments.map((instrument) => {
              const isOpen = openInstruments.some((item) => item.assetId === instrument.assetId);
              return (
                <button className={`recent-market ${isOpen ? "open" : ""}`} key={instrument.assetId} onClick={() => openBook(instrument)}>
                  <span>{instrument.leagueName ?? instrument.category} · {startLabel(instrument.startTime)}</span>
                  <strong>{instrument.marketTitle}</strong>
                  <i>{instrument.outcome} {isOpen ? "●" : "+"}</i>
                </button>
              );
            })}

            {searchResults.length > 0 && (
              <section className="search-results">
                <header>MARKET MATCHES <b>{searchResults.length}</b></header>
                {searchResults.map((instrument) => (
                  <button key={instrument.assetId} onClick={() => openBook(instrument)}>
                    <span>{instrument.leagueName ?? instrument.category} · {startLabel(instrument.startTime)}</span>
                    <strong>{instrument.marketTitle}</strong>
                    <i>{instrument.outcome} · {money(instrument.volume24hr)}</i>
                  </button>
                ))}
              </section>
            )}
          </div>
          <div className="navigator-resizer" onPointerDown={resizeNavigator} title="Drag to resize navigator" />
        </aside>

        <section ref={booksWorkspaceRef} className="books-workspace">
          <div className="workspace-hint">
            <span>BUY/SELL lanes rest limits · click ASK/BID depth to take · wheel pans · C recenters</span>
            <span className="workspace-legend"><i className="legend-depth" /> resting liquidity <i className="legend-print" /> executed volume · local time</span>
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
                gridTemplateRows: `repeat(${gridRows}, minmax(220px, 1fr))`,
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
                  position={accountSnapshot?.openPositions.find((position) => position.assetId === instrument.assetId)}
                  sessionOrders={sessionOrders}
                  leagueFavorite={Boolean(instrument.leagueId && favoriteLeagueIds.has(instrument.leagueId))}
                  focused={focusedAssetId === instrument.assetId}
                  onClose={() => closeBook(instrument)}
                  onToggleLeagueFavorite={() => instrument.leagueId && toggleLeagueFavorite(instrument.leagueId)}
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

      <BottomDock
        activeTab={dockTab}
        height={dockHeight}
        collapsed={dockCollapsed}
        accountStatus={accountStatus}
        snapshot={accountSnapshot}
        orders={sessionOrders}
        tape={publicTape}
        logs={tradeLog}
        onTab={setDockTab}
        onToggle={() => setDockCollapsed((value) => !value)}
        onResizeStart={resizeDock}
        onCancelAll={cancelAllOrders}
      />

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
