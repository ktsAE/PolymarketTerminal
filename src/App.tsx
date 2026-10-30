import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { demoBridge } from "./demoBridge";
import type {
  AccountPosition,
  AccountSnapshot,
  AccountStatus,
  AssetHealth,
  BookState,
  ConnectionStatus,
  Instrument,
  MarketLeague,

  OrderDraft,
  OrderResult,
  TradePrint,
} from "./types";

import { PanelSettings, type PanelSettingsValue } from './components/PanelSettings';
import { readWorkspace, saveWorkspace, readPanelSettings, savePanelSettings, DEFAULT_FILTERS, storageGet, storageSet, type DiscoveryFilters } from './state/workspaceStore';
import { MarketNavigator, localStartLabel } from './components/MarketNavigator';
import { marketStore } from './state/marketStore';
import { parseUnits, formatUnits, parseShares, formatShares } from '../shared/decimal.cjs';
import { qualifyingPrints } from './domain/executions';
import { ExecutedBubble } from './components/ExecutedBubble';
import { ClusterCell } from './components/ClusterColumns';
import { SessionOrders } from './components/SessionOrders';
import { sampleDepthScale, updateDepthScale } from './domain/scales';
import { money, compactNumber, priceLabel, shortAddress, signedMoney, tradeTime } from './lib/format';
import { LoginModal } from './components/LoginModal';
import { AccountDrawer } from './components/AccountDrawer';
import { BottomDock, type DockTab, type TapeExecution } from './components/BottomDock';
import type { TradeLogEntry } from './components/tradeLog';
import { calculateWorkspaceLayout } from './hooks/useWorkspaceLayout';

const bridge = window.polymarketTerminal ?? demoBridge;
// Session-scoped, not panel/workspace-scoped. Never persist signer/account data.
let submissionRows: OrderResult[] = [];
const submissionListeners = new Set<() => void>();
const submissionRequests = new Map<string, Promise<OrderResult>>();
function setSubmissionRows(update: (current: OrderResult[]) => OrderResult[]) {
  submissionRows = update(submissionRows);
  submissionListeners.forEach(listener => listener());
}
const subscribeSubmissions = (listener: () => void) => { submissionListeners.add(listener); return () => { submissionListeners.delete(listener); }; };
const getSubmissionRows = () => submissionRows;
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

function readStoredIds(key: string) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function rememberedSize(workspace: string, assetId: string): { size: string; sizeUnit: 'USD' | 'SHARES' } {
  const fallback = { size: '10', sizeUnit: 'USD' as const };
  if (!readPanelSettings(workspace, assetId).rememberSize) return fallback;
  try {
    const value = JSON.parse(localStorage.getItem(`pm-terminal:v2:size:${workspace}:${assetId}`) ?? 'null');
    if (typeof value?.size !== 'string' || !/^\d+(\.\d{1,6})?$/.test(value.size) || parseShares(value.size) <= 0n || !['USD', 'SHARES'].includes(value.sizeUnit)) return fallback;
    return value;
  } catch { return fallback; }
}

function startLabel(value?: string) { return localStartLabel(value); }

function mergeInstruments(current: Instrument[], incoming: Instrument[]) {
  const merged = new Map(current.map((item) => [item.assetId, item]));
  incoming.forEach((item) => merged.set(item.assetId, item));
  return [...merged.values()];
}

function readStoredNumber(key: string, fallback: number) {
  const stored = storageGet(key);
  if (stored === null || stored.trim() === "") return fallback;
  const value = Number(stored);
  return Number.isFinite(value) ? value : fallback;
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
  layoutGeneration?: string;
  onGeometry?(assetId: string, chrome: number, rowHeight: 18 | 22 | 26): void;
  workspace: string;
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

export function BookPanel({
  layoutGeneration,
  onGeometry,
  workspace,
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
  const [size, setSize] = useState(() => rememberedSize(workspace, instrument.assetId).size);
  const [sizeUnit, setSizeUnit] = useState<'USD' | 'SHARES'>(() => rememberedSize(workspace, instrument.assetId).sizeUnit);
  const [pending, setPending] = useState(false);
  const [visibleRows, setVisibleRows] = useState(15);
  const [settings, setSettings] = useState(() => readPanelSettings(workspace, instrument.assetId));
  useEffect(() => {
    const key = `pm-terminal:v2:size:${workspace}:${instrument.assetId}`;
    try {
      if (!settings.rememberSize) localStorage.removeItem(key);
      else if (/^\d+(\.\d{1,6})?$/.test(size) && parseShares(size) > 0n) localStorage.setItem(key, JSON.stringify({ size, sizeUnit }));
    } catch { /* Storage is optional; never block local order entry. */ }
  }, [workspace, instrument.assetId, settings.rememberSize, size, sizeUnit]);
  const updateSettings = (value: PanelSettingsValue) => { setSettings(value); savePanelSettings(workspace, instrument.assetId, value); };
  const groupTicks = settings.compression;
  const setGroupTicks = (compression: 1 | 2 | 5) => updateSettings({ ...settings, compression });
  const printThreshold = settings.bubbleThreshold;
  const setPrintThreshold = (value: number) => updateSettings({ ...settings, bubbleThreshold: value as PanelSettingsValue['bubbleThreshold'] });
  const clusterMode = settings.mode;
  const setClusterMode = (mode: PanelSettingsValue['mode']) => updateSettings({ ...settings, mode });
  const clusterPeriod = settings.period;
  const setClusterPeriod = (period: PanelSettingsValue['period']) => updateSettings({ ...settings, period });
  const rowHeight = settings.rowHeight;
  const setRowHeight = (rowHeight: PanelSettingsValue['rowHeight']) => updateSettings({ ...settings, rowHeight });
  const depthScale = settings.depthScale;
  const setDepthScale = (value: string | number) => updateSettings({ ...settings, depthScale: value === 'AUTO' ? 'AUTO' : Number(value) as 500 | 2000 | 10000 });
  const [autoCenter, setAutoCenter] = useState(true);
  const [manualCenter, setManualCenter] = useState<number>();
  const pendingRef = useRef(false);
  const [notice, setNotice] = useState('');
  const panelRef = useRef<HTMLElement>(null);
  const ladderRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pointerActive, setPointerActive] = useState(false);
  const gesture = useRef<{ draft: OrderDraft; context: string; compression: number; released: boolean } | null>(null);
  const wheelDelta = useRef(0);
  const layoutEpoch = useRef(0);

  useEffect(() => {
    if (!ladderRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      layoutEpoch.current++;
      const chrome = (panelRef.current?.getBoundingClientRect().height ?? 0) - entry.contentRect.height;
      if (chrome > 0) onGeometry?.(instrument.assetId, chrome, rowHeight);
      let rows = Math.max(1, Math.min(99, Math.floor(entry.contentRect.height / rowHeight)));
      if (rows % 2 === 0) rows -= 1;
      setVisibleRows(rows);
    });
    observer.observe(ladderRef.current);
    return () => observer.disconnect();
  }, [rowHeight, onGeometry, instrument.assetId]);


  const parsedTick = (() => { try { return parseUnits(book.tickSize); } catch { return 0; } })();
  const supportedTick = parsedTick > 0 && parsedTick <= 1_000_000;
  // A harmless projection step keeps invalid metadata renderable; controls stay blocked.
  const tickUnits = supportedTick ? parsedTick : 1_000_000;
  const stepUnits = tickUnits * groupTicks;
  const step = stepUnits / 1_000_000;
  const analysis = marketStore.getAnalysis(instrument.assetId);
  const marketCenter = useMemo(() => {
    if (book.bestBid && book.bestAsk) return (Number(book.bestBid) + Number(book.bestAsk)) / 2;
    if (book.lastTrade) return Number(book.lastTrade);
    if (book.bestBid) return Number(book.bestBid) + step;
    if (book.bestAsk) return Number(book.bestAsk) - step;
    return 0.5;
  }, [book.bestAsk, book.bestBid, book.lastTrade, step]);
  const stableCenter = useRef(marketCenter);
  if (autoCenter && !pointerActive && !settingsOpen && Math.abs(marketCenter - stableCenter.current) / step > Math.floor(visibleRows / 4)) stableCenter.current = marketCenter;
  const center = autoCenter ? stableCenter.current : (manualCenter ?? marketCenter);
  const bucket = (price: number) => Math.floor(parseUnits(price.toFixed(6)) / stepUnits) * stepUnits / 1_000_000;
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
    const firstIndex = groupTicks === 1 ? 1 : 0;
    const lastIndex = Math.floor((Math.floor(999_999 / tickUnits) * tickUnits) / stepUnits);
    const count = Math.max(0, Math.min(visibleRows, lastIndex - firstIndex + 1));
    const top = Math.max(firstIndex + count - 1, Math.min(lastIndex, Math.round(center / step) + Math.floor(count / 2)));
    return Array.from({ length: count }, (_, index) => (top - index) * stepUnits / 1_000_000);
  }, [center, step, visibleRows, tickUnits, groupTicks]);
  const prints = new Map<number, { buy: bigint; sell: bigint; unknown: bigint; count: number }>();
  for (const execution of qualifyingPrints(analysis.executions, analysis.nowMs, parseShares(String(printThreshold)))) {
    const key = Math.floor(execution.priceUnits / stepUnits) * stepUnits / 1_000_000;
    const value = prints.get(key) ?? { buy: 0n, sell: 0n, unknown: 0n, count: 0 };
    value[execution.side === 'BUY' ? 'buy' : execution.side === 'SELL' ? 'sell' : 'unknown'] += execution.shares;
    value.count++; prints.set(key, value);
  }
  const clusterColumns = analysis.clusters.project({ nowMs: analysis.nowMs, intervalSeconds: clusterPeriod, tickUnits, compression: groupTicks, assetId: instrument.assetId }).map(column => ({
    ...column,
    label: `[${new Date(column.startMs).toLocaleTimeString()}, ${new Date(column.endMs).toLocaleTimeString()}) ${analysis.nowMs < column.endMs ? 'LIVE' : 'CLOSED'}${column.quality.partial ? ' PARTIAL' : ''}${column.quality.gap ? ' GAP' : ''}${column.quality.approximate ? ' APPROXIMATE' : ''}${column.quality.unavailable ? ' UNAVAILABLE' : ''}${(column.correctedUntil ?? 0) > analysis.nowMs ? ' CORRECTED' : ''}`,
    levels: new Map(column.rows.map(row => [row.priceUnits / 1_000_000, row])),
  }));
  const ownOrders = useMemo(
    () => sessionOrders.filter((order) => order.assetId === instrument.assetId && order.execution === "GTC" && order.status.includes("ACCEPTED")),
    [instrument.assetId, sessionOrders],
  );
  const depthState = useRef({ value: 1, belowSince: null as number | null });
  const autoDepth = Math.max(...(['BID', 'ASK'] as const).map(side => sampleDepthScale({ side, levels: [...(side === 'BID' ? book.bids : book.asks)].map(([price, shares]) => ({ priceUnits: parseUnits(price), shares })), bestPriceUnits: parseUnits((side === 'BID' ? book.bestBid : book.bestAsk) || '0.5'), tickUnits, compression: groupTicks })));
  depthState.current = updateDepthScale(depthState.current, autoDepth, analysis.nowMs);
  const maxDepth = depthScale === "AUTO" ? depthState.current.value : Number(depthScale);
  const maxPrint = Math.max(1, ...[...prints.values()].map(print => Number(formatShares(print.buy + print.sell + print.unknown))));
  const clusterMagnitude = (row: { buy: bigint; sell: bigint; total: bigint }) => Number(formatShares(clusterMode === 'DELTA' ? (row.buy > row.sell ? row.buy - row.sell : row.sell - row.buy) : row.total));
  const sharedClusterMax = Math.max(1, ...clusterColumns.flatMap(column => column.rows.map(clusterMagnitude)));
  const bidDepth = [...book.bids.values()].reduce((sum, value) => sum + Number(value), 0);
  const askDepth = [...book.asks.values()].reduce((sum, value) => sum + Number(value), 0);
  const totalDepth = bidDepth + askDepth;
  const bidShare = totalDepth > 0 ? (bidDepth / totalDepth) * 100 : 50;
  const rollingPrintVolume = Number(formatShares(qualifyingPrints(analysis.executions, analysis.nowMs, 0n).reduce((sum, execution) => sum + execution.shares, 0n)));
  const stale = !book.bookReceivedAt || analysis.nowMs - book.bookReceivedAt > 10_000;
  const disabled = pending || stale || !supportedTick || connection !== 'live' || !book.ready || !Number.isFinite(Number(size)) || Number(size) <= 0 || (accountStatus.armed && !accountStatus.liveEnabled);


  const gestureContext = () => JSON.stringify([workspace, instrument.assetId, book.generation, book.tickVersion, book.tickSize, accountStatus.armEpoch, accountStatus.armed, size, sizeUnit, settings, focused, layoutGeneration, layoutEpoch.current]);
  const capture = (side: 'BUY' | 'SELL', price: string, execution: 'GTC' | 'FAK') => {
    gesture.current = { context: gestureContext(), compression: groupTicks, released: false, draft: {
      requestId: crypto.randomUUID(), bookGeneration: book.generation, tickVersion: book.tickVersion,
      armEpoch: accountStatus.armEpoch, assetId: instrument.assetId, marketTitle: instrument.marketTitle,
      outcome: instrument.outcome, side, price, size, sizeUnit, execution, mode: accountStatus.armed ? 'LIVE' : 'DRY',
    } };
  };
  const orderGesture = (side: 'BUY' | 'SELL', price: string, execution: 'GTC' | 'FAK') => ({
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button > 0 || disabled || settingsOpen) return;
      capture(side, price, execution); setPointerActive(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    onPointerUp: () => { if (gesture.current) gesture.current.released = true; },
    onPointerCancel: () => { if (gesture.current) gesture.current.context = 'cancelled'; setPointerActive(false); },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (event.repeat || disabled || settingsOpen) return;
      capture(side, price, execution);
      if (gesture.current) gesture.current.released = true;
      void place(side, price, execution);
    },
    onClick: () => void place(side, price, execution),
  });
  const place = async (side: "BUY" | "SELL", price: string, execution: "GTC" | "FAK") => {
    const captured = gesture.current;
    gesture.current = null;
    setPointerActive(false);
    if (disabled || settingsOpen || pendingRef.current) return;
    if (captured && (!captured.released || captured.context !== gestureContext() || captured.draft.price !== price || captured.draft.side !== side || captured.draft.execution !== execution)) {
      setNotice('Gesture cancelled · book, mode or layout changed. Click again.'); return;
    }
    if (groupTicks !== 1) {
      const anchor = Math.floor(parseUnits(price) / stepUnits) * stepUnits;
      const low = Math.max(tickUnits, anchor);
      const high = Math.min(Math.floor(999_999 / tickUnits) * tickUnits, anchor + stepUnits - tickUnits);
      setGroupTicks(1); setAutoCenter(false); setManualCenter((low + high) / 2_000_000);
      setNotice('Choose an exact price · zoomed to 1T. Click again to submit.');
      return;
    }
    pendingRef.current = true;
    setPending(true);
    try {
      await onOrder(captured?.draft ?? {
        requestId: crypto.randomUUID(),
        bookGeneration: book.generation,
        tickVersion: book.tickVersion,
        armEpoch: accountStatus.armEpoch,
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
      pendingRef.current = false;
      setPending(false);
    }
  };

  const row = (numericPrice: number) => {
    const key = bucket(numericPrice);
    const bidSize = groupedBids.get(key) ?? 0;
    const askSize = groupedAsks.get(key) ?? 0;
    const bidBar = Math.min(100, (bidSize / maxDepth) * 100);
    const askBar = Math.min(100, (askSize / maxDepth) * 100);
    const price = formatUnits(Math.max(tickUnits, parseUnits(numericPrice.toFixed(6))));
    const print = prints.get(key);
    const rangeLabel = groupTicks === 1 ? priceLabel(price) : `${priceLabel(price)}–${priceLabel(formatUnits(Math.min(Math.floor(999_999 / tickUnits) * tickUnits, parseUnits(numericPrice.toFixed(6)) + stepUnits - tickUnits)))}`;
    const atLast = book.lastTrade && Math.abs(bucket(Number(book.lastTrade)) - key) < step / 2;
    const rowOrders = ownOrders.filter((order) => Math.abs(bucket(Number(order.price)) - key) < step / 2);
    const buyOrders = rowOrders.filter((order) => order.side === "BUY");
    const sellOrders = rowOrders.filter((order) => order.side === "SELL");
    return (
      <div className={`dom-row ${atLast ? "last-price" : ""}`} key={price} style={{ height: rowHeight }}>
        {settings.showClusters && clusterColumns.map((column) => {
          const level = column.levels.get(key);
          const scale = typeof settings.clusterScale === 'number' ? settings.clusterScale : settings.clusterScale === 'COLUMN' ? Math.max(1, ...column.rows.map(clusterMagnitude)) : sharedClusterMax;
          const poc = level && level.total > 0n && level.total === column.rows.reduce((max, row) => row.total > max ? row.total : max, 0n);
          return <div className="cluster-cell" key={column.startMs}>{settings.showClusters && <ClusterCell buy={formatShares(level?.buy ?? 0n)} sell={formatShares(level?.sell ?? 0n)} unknown={formatShares(level?.unknown ?? 0n)} mode={clusterMode} scale={scale} poc={Boolean(poc)} coverage={column.label} unavailable={column.quality.unavailable} />}</div>;
        })}
        <button
          className="order-lane buy-lane"
          disabled={disabled}
          title={`Rest BUY ${size} ${sizeUnit.toLowerCase()} at ${priceLabel(price)}`}
          {...orderGesture('BUY', price, 'GTC')}
        >
          {buyOrders.length ? <b title="SessionSubmission · not working orders" className="session-marker">○ {buyOrders.some(order => order.mode === 'LIVE') ? 'LIVE' : 'DRY'} {buyOrders.length}</b> : "BUY"}
        </button>
        <button
          className="liquidity bid-size"
          disabled={disabled || bidSize <= 0}
          title={bidSize > 0 ? `Hit bid: SELL at ${priceLabel(price)} or better` : "No resting bids at this tick"}
          {...orderGesture('SELL', price, 'FAK')}
        >
          {bidSize > 0 && <span className="depth" style={{ width: `${bidBar}%` }} />}
          <span className="level-value">{bidSize > 0 ? compactNumber(bidSize) : ""}</span>
        </button>
        <div className="price-cell">{rangeLabel}</div>
        <button
          className="liquidity ask-size"
          disabled={disabled || askSize <= 0}
          title={askSize > 0 ? `Lift ask: BUY at ${priceLabel(price)} or better` : "No resting asks at this tick"}
          {...orderGesture('BUY', price, 'FAK')}
        >
          {askSize > 0 && <span className="depth" style={{ width: `${askBar}%` }} />}
          <span className="level-value">{askSize > 0 ? compactNumber(askSize) : ""}</span>
        </button>
        <button
          className="order-lane sell-lane"
          disabled={disabled}
          title={`Rest SELL ${size} ${sizeUnit.toLowerCase()} at ${priceLabel(price)}`}
          {...orderGesture('SELL', price, 'GTC')}
        >
          {sellOrders.length ? <b title="SessionSubmission · not working orders" className="session-marker">○ {sellOrders.some(order => order.mode === 'LIVE') ? 'LIVE' : 'DRY'} {sellOrders.length}</b> : "SELL"}
        </button>
        <div className="print-cell">
          {print && settings.showBubbles && <ExecutedBubble buy={formatShares(print.buy)} sell={formatShares(print.sell)} unknown={formatShares(print.unknown)} count={print.count} scale={maxPrint} rowHeight={rowHeight} labels={settings.bubbleLabels} coverage={analysis.quality} priceLabel={rangeLabel} />}
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
      onDragStart={(event) => { if ((event.target as HTMLElement).closest('button,input,select,.book-ladder')) { event.preventDefault(); return; } layoutEpoch.current++; onDragStart(); }}
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

      <div className="book-health">
        <PanelSettings value={settings} onChange={updateSettings} onOpenChange={(open) => { layoutEpoch.current++; setSettingsOpen(open); setPointerActive(false); }} />
        {!accountStatus.armed && sizeUnit === 'USD' && Number(size) > accountStatus.maxOrderUsd && <span>DRY · exceeds LIVE ${accountStatus.maxOrderUsd} cap</span>}
        {sizeUnit === 'USD' && <span title="SELL converts the USD target to shares at the selected price; proceeds may differ.">USD SELL = target proceeds</span>}
        {(stale || !book.ready) && <><span>STALE · orders blocked</span><button aria-label="Refresh book" onClick={() => bridge.refreshBook?.({ assetId: instrument.assetId })}>Refresh</button></>}
        {!supportedTick && <span>Unsupported tick · orders blocked</span>}
        {notice && <span role="status">{notice}</span>}
      </div>
      <div className="position-strip">
        <span>POS <b>{position ? compactNumber(Number(position.currentSize)) : "—"}</b></span>
        <span>AVG <b>{position ? priceLabel(position.avgPrice) : "—"}</b></span>
        <span>PNL <b className={position && Number(position.totalPnl) < 0 ? "negative" : "positive"}>{position ? signedMoney(Number(position.totalPnl)) : "$0.00"}</b></span>
        <span>SPREAD <b>{spread === undefined ? "—" : `${(spread * 100).toFixed(1)}¢`}</b></span>
        <div className="flow-settings">
          <select value={clusterMode} onChange={(event) => setClusterMode(event.target.value as typeof clusterMode)} title="Cluster calculation">
            <option value="VOLUME">VOL</option>
            <option value="DELTA">Δ</option>
            <option value="BUYSELL">B×A</option>
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
          <button className={`center-button ${autoCenter ? "active" : ""}`} onClick={() => { layoutEpoch.current++; stableCenter.current = marketCenter; setAutoCenter(true); setManualCenter(undefined); }} title="Recenter price ladder (C)">◎ C</button>
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
        <div className="ladder-stack" style={{ '--dom-columns': `${settings.showClusters ? `repeat(${clusterColumns.length}, minmax(30px, 1fr)) ` : ''}30px minmax(38px, 1fr) 58px minmax(38px, 1fr) 30px 54px` } as React.CSSProperties}>
          <div className="dom-columns">
            {settings.showClusters && clusterColumns.map((column) => <span className="cluster-heading" title={column.label} key={column.startMs}>{column.label}</span>)}
            <span>BUY</span>
            <span>BID DEPTH</span>
            <span>PRICE</span>
            <span>ASK DEPTH</span>
            <span>SELL</span>
            <span>EXECUTED</span>
          </div>
          <div
            ref={ladderRef}
            className={`book-ladder ${autoCenter ? "auto-centered" : "manual-centered"}`}
            onWheel={(event) => {
              event.preventDefault();
              if (pointerActive || settingsOpen) return;
              wheelDelta.current += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1);
              const notches = Math.trunc(wheelDelta.current / 100);
              if (!notches) return;
              wheelDelta.current -= notches * 100;
              layoutEpoch.current++;
              const next = Math.max(step, Math.min(1 - step, center - notches * step * 3));
              setAutoCenter(false);
              setManualCenter(next);
            }}
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key.toLowerCase() === "c" && !event.repeat && !settingsOpen && !pointerActive && !(event.target as HTMLElement).closest('input,select,textarea,[role="dialog"]')) {
                stableCenter.current = marketCenter;
                layoutEpoch.current++;
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

export function App() {
  const [instruments, setInstruments] = useState<Instrument[]>([]);
  const [leagues, setLeagues] = useState<MarketLeague[]>([]);
  const [openInstruments, setOpenInstruments] = useState<Instrument[]>([]);
  const [books, setBooks] = useState<ReadonlyMap<string, BookState>>(() => marketStore.getSnapshot());
  const [restored, setRestored] = useState(false);
  const [unresolvedIds, setUnresolvedIds] = useState<string[]>([]);
  const [discoveryFilters, setDiscoveryFilters] = useState<DiscoveryFilters>({ ...DEFAULT_FILTERS });
  const restorationGeneration = useRef(0);
  const subscriptionQueue = useRef(Promise.resolve());
  const subscribedIds = useRef<string[]>([]);
  const openRef = useRef<Instrument[]>([]);
  const pendingRef = useRef<string[]>([]);
  openRef.current = openInstruments;
  pendingRef.current = unresolvedIds;
  const mergeLoadedItems = useCallback((items: Instrument[]) => setInstruments(current => mergeInstruments(current, items)), []);
  const [connection, setConnection] = useState<ConnectionStatus>("idle");
  const [favoriteLeagueIds, setFavoriteLeagueIds] = useState<Set<string>>(() => new Set(readStoredIds(FAVORITE_LEAGUES_KEY)));
  const [recentIds, setRecentIds] = useState<string[]>(() => readStoredIds(RECENTS_KEY));
  const [loading, setLoading] = useState(true);
  const [marketError, setMarketError] = useState<string>();
  const [layoutMode, setLayoutMode] = useState<"AUTO" | "1" | "2" | "3">("AUTO");
  const [focusedAssetId, setFocusedAssetId] = useState<string>();
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [workspaceHeight, setWorkspaceHeight] = useState(0);
  const [geometry, setGeometry] = useState<Record<string, { chrome: number; rowHeight: 18 | 22 | 26 }>>({});
  const reportGeometry = useCallback((assetId: string, chrome: number, rowHeight: 18 | 22 | 26) => setGeometry(current => current[assetId]?.chrome === chrome && current[assetId]?.rowHeight === rowHeight ? current : { ...current, [assetId]: { chrome, rowHeight } }), []);
  const [toast, setToast] = useState<Toast>();
  const [accountStatus, setAccountStatus] = useState<AccountStatus>(INITIAL_ACCOUNT_STATUS);
  const [accountSnapshot, setAccountSnapshot] = useState<AccountSnapshot>();
  const [accountOpen, setAccountOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [accountLoading, setAccountLoading] = useState(false);
  const sessionOrders = useSyncExternalStore(subscribeSubmissions, getSubmissionRows);
  const setSessionOrders = setSubmissionRows;
  const [tradeLog, setTradeLog] = useState<TradeLogEntry[]>([]);
  const [activeWorkspace, setActiveWorkspace] = useState<(typeof WORKSPACE_SLOTS)[number]>(() => {
    const stored = storageGet(ACTIVE_WORKSPACE_KEY);
    return WORKSPACE_SLOTS.includes(stored as (typeof WORKSPACE_SLOTS)[number]) ? stored as (typeof WORKSPACE_SLOTS)[number] : "SCALP 1";
  });
  const [navigatorWidth, setNavigatorWidth] = useState(() => Math.max(240, Math.min(520, readStoredNumber(NAV_WIDTH_KEY, 326))));
  const [dockHeight, setDockHeight] = useState(() => Math.max(100, Math.min(360, readStoredNumber(DOCK_HEIGHT_KEY, 156))));
  const [dockCollapsed, setDockCollapsed] = useState(true);
  const [dockTab, setDockTab] = useState<DockTab>("ORDERS");
  const dragIndex = useRef<number | undefined>(undefined);
  const booksWorkspaceRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const offStore = marketStore.subscribe(() => setBooks(marketStore.getSnapshot()));
    const offEvent = bridge.onMarketEvent(event => marketStore.ingest(event));
    const offStatus = bridge.onConnectionStatus(status => { marketStore.setConnection(status); setConnection(status); });
    const offAccount = bridge.onAccountStatus?.(setAccountStatus);
    const offHealth = bridge.onAssetHealth?.(health => marketStore.applyHealth(health));
    return () => { offStore(); offEvent(); offStatus(); offAccount?.(); offHealth?.(); restorationGeneration.current++; marketStore.setActive([]); subscriptionQueue.current = subscriptionQueue.current.catch(() => undefined).then(async () => { if (subscribedIds.current.length) await bridge.unsubscribeAssets(subscribedIds.current); subscribedIds.current = []; }); };
  }, []);

  useEffect(() => {
    if (!booksWorkspaceRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { setWorkspaceWidth(entry.contentRect.width); setWorkspaceHeight(entry.contentRect.height); });
    observer.observe(booksWorkspaceRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    bridge.getAccountStatus().then(setAccountStatus).catch(() => undefined);
  }, []);

  useEffect(() => {
    let active = true;
    const generation = restorationGeneration.current;
    Promise.all([bridge.listMarkets(), bridge.listLeagues()])
      .then(async ([items, leagueItems]) => {
        if (!active) return;
        setInstruments(current => mergeInstruments(current, items));
        setLeagues(leagueItems);
        if (generation !== restorationGeneration.current) return;
        const saved = readWorkspace(activeWorkspace);
        const savedIds = saved?.assetIds ?? items.slice(0, 2).map(item => item.assetId);
        const missing = savedIds.filter(id => !items.some(item => item.assetId === id && !item.closed));
        const resolved = missing.length && bridge.resolveInstruments ? await bridge.resolveInstruments({ assetIds: missing }).catch(() => []) : [];
        if (!active || generation !== restorationGeneration.current) return;
        const all = mergeInstruments(items, resolved.flatMap(result => result.status === 'RESOLVED' && result.instrument && !result.instrument.closed ? [result.instrument] : []));
        setInstruments(current => mergeInstruments(current, all));
        const initial = savedIds.map(id => all.find(item => item.assetId === id && !item.closed)).filter((item): item is Instrument => Boolean(item));
        setUnresolvedIds(savedIds.filter(id => !initial.some(item => item.assetId === id)));
        setLayoutMode(saved?.layout ?? 'AUTO');
        setDiscoveryFilters(saved?.filters ?? { ...DEFAULT_FILTERS });
        setRestored(true);
        setOpenInstruments(initial);
        setRecentIds((current) => [
          ...initial.map((instrument) => instrument.assetId),
          ...current.filter((assetId) => !initial.some((instrument) => instrument.assetId === assetId)),
        ].slice(0, 30));
        openRef.current = initial;
        setBooks(marketStore.getSnapshot());
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
    if (restored) saveWorkspace(activeWorkspace, [...openInstruments.map(item => item.assetId), ...unresolvedIds], layoutMode, discoveryFilters);
  }, [activeWorkspace, openInstruments, unresolvedIds, layoutMode, discoveryFilters, restored]);

  useEffect(() => {
    const target = restored ? openInstruments.slice(0, MAX_OPEN_BOOKS) : [];
    const ids = target.map(item => item.assetId);
    marketStore.setActive(target);
    subscriptionQueue.current = subscriptionQueue.current.catch(error => console.warn('Subscription transition failed', error)).then(async () => {
      const removed = subscribedIds.current.filter(id => !ids.includes(id));
      if (removed.length) await bridge.unsubscribeAssets(removed);
      subscribedIds.current = subscribedIds.current.filter(id => !removed.includes(id));
      const added = ids.filter(id => !subscribedIds.current.includes(id));
      if (added.length) await bridge.subscribeAssets(added);
      subscribedIds.current = ids;
    });
  }, [openInstruments, restored]);

  useEffect(() => {
    storageSet(ACTIVE_WORKSPACE_KEY, activeWorkspace);
    // Version 2 writes are gated on completed restoration above.
  }, [activeWorkspace, layoutMode]);

  useEffect(() => {
    storageSet(NAV_WIDTH_KEY, String(navigatorWidth));
  }, [navigatorWidth]);

  useEffect(() => {
    storageSet(DOCK_HEIGHT_KEY, String(dockHeight));
  }, [dockHeight]);

  useEffect(() => {
    setTradeLog((current) => prependTradeLog(current, connection === "live" ? "good" : connection === "error" ? "bad" : "info", `Market data ${connection}`));
  }, [connection]);

  useEffect(() => {
    storageSet(FAVORITE_LEAGUES_KEY, JSON.stringify([...favoriteLeagueIds]));
  }, [favoriteLeagueIds]);

  useEffect(() => {
    storageSet(RECENTS_KEY, JSON.stringify(recentIds));
  }, [recentIds]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(undefined), 3600);
    return () => clearTimeout(timer);
  }, [toast]);

  const displayedOpenInstruments = useMemo(
    () => focusedAssetId ? openInstruments.filter((item) => item.assetId === focusedAssetId) : openInstruments,
    [focusedAssetId, openInstruments],
  );
  const gridLayout = calculateWorkspaceLayout({ width: workspaceWidth, height: Math.max(0, workspaceHeight - 29), panelCount: displayedOpenInstruments.length, columns: focusedAssetId ? 1 : layoutMode === 'AUTO' ? 'AUTO' : Number(layoutMode) as 1 | 2 | 3, rowHeight: 22, chromeHeights: displayedOpenInstruments.map(item => geometry[item.assetId]?.chrome ?? 218), rowHeights: displayedOpenInstruments.map(item => geometry[item.assetId]?.rowHeight ?? readPanelSettings(activeWorkspace, item.assetId).rowHeight) });
  const gridColumns = gridLayout.columns;
  const gridRows = gridLayout.rows;
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
      if (!restored || instrument.closed) return;
      if (openRef.current.some((item) => item.assetId === instrument.assetId)) {
        setFocusedAssetId(instrument.assetId);
        return;
      }
      if (openRef.current.length + pendingRef.current.length >= MAX_OPEN_BOOKS) {
        setToast({ id: Date.now(), tone: "bad", message: `Workspace limit: ${MAX_OPEN_BOOKS} simultaneous books` });
        return;
      }
      openRef.current = [...openRef.current, instrument];
      setOpenInstruments(openRef.current);
    },
    [restored],
  );

  const closeBook = async (instrument: Instrument) => {
    if (focusedAssetId === instrument.assetId) setFocusedAssetId(undefined);
    openRef.current = openRef.current.filter(item => item.assetId !== instrument.assetId);
    setOpenInstruments(openRef.current);
  };

  const switchWorkspace = async (nextWorkspace: (typeof WORKSPACE_SLOTS)[number]) => {
    if (nextWorkspace === activeWorkspace) return;
    const generation = ++restorationGeneration.current;
    setRestored(false);
    setActiveWorkspace(nextWorkspace);
    setOpenInstruments([]); openRef.current = [];
    setFocusedAssetId(undefined);
    const saved = readWorkspace(nextWorkspace);
    const savedIds = saved?.assetIds ?? [];
    setUnresolvedIds(savedIds); pendingRef.current = savedIds;
    setLayoutMode(saved?.layout ?? 'AUTO');
    setDiscoveryFilters(saved?.filters ?? { ...DEFAULT_FILTERS });
    const missing = savedIds.filter(id => !instruments.some(item => item.assetId === id && !item.closed));
    const results = missing.length && bridge.resolveInstruments ? await bridge.resolveInstruments({ assetIds: missing }).catch(() => []) : [];
    if (generation !== restorationGeneration.current) return;
    const all = mergeInstruments(instruments, results.flatMap(result => result.status === 'RESOLVED' && result.instrument && !result.instrument.closed ? [result.instrument] : []));
    setInstruments(current => mergeInstruments(current, all));
    const target = savedIds.map(id => all.find(item => item.assetId === id && !item.closed)).filter((item): item is Instrument => Boolean(item));
    const pendingIds = savedIds.filter(id => !target.some(item => item.assetId === id));
    openRef.current = target;
    pendingRef.current = pendingIds;
    setOpenInstruments(target);
    setUnresolvedIds(pendingIds);
    setRestored(true);
    setTradeLog((current) => prependTradeLog(current, "info", `Workspace changed to ${nextWorkspace}`));
  };

  const retryUnavailable = async (id: string) => {
    const generation = restorationGeneration.current;
    const results = await bridge.resolveInstruments({ assetIds: [id] }).catch(() => []);
    if (generation !== restorationGeneration.current || !pendingRef.current.includes(id)) return;
    const item = results.find(result => result.assetId === id && result.status === 'RESOLVED')?.instrument;
    if (!item || item.closed) return;
    mergeLoadedItems([item]);
    pendingRef.current = pendingRef.current.filter(value => value !== id);
    openRef.current = [...openRef.current, item].slice(0, MAX_OPEN_BOOKS);
    setUnresolvedIds(pendingRef.current);
    setOpenInstruments(openRef.current);
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

  const submitOrder = (input: OrderDraft): Promise<OrderResult> => {
    const draft = { ...input, requestId: input.requestId || crypto.randomUUID() };
    const cached = submissionRequests.get(draft.requestId);
    if (cached) return cached;
    const pending: OrderResult = { ...draft, status: 'SUBMITTING', createdAt: new Date().toISOString() };
    setSessionOrders(current => [pending, ...current]);
    const request = Promise.resolve().then(async () => {
    try {
      const response = await bridge.submitOrder(draft);
      if (!response || typeof response.status !== 'string') throw new Error('Missing submission acknowledgement');
      const result = { ...response, requestId: draft.requestId };
      setSessionOrders(current => current.map(row => row.requestId === draft.requestId ? result : row));
      setTradeLog((current) => prependTradeLog(current, result.status.includes("ACCEPTED") ? "good" : "bad", `${result.status} · ${draft.side} ${draft.size} ${draft.sizeUnit} ${draft.outcome} @ ${priceLabel(draft.price)} ${draft.execution}`));
      setToast({
        id: Date.now(),
        tone: result.status.includes("ACCEPTED") ? "good" : "bad",
        message: `${result.status}: ${draft.side} ${draft.size} ${draft.sizeUnit} ${draft.outcome} @ ${priceLabel(draft.price)} ${draft.execution}${result.message ? ` · ${result.message}` : ""}`,
      });
      if (draft.mode === "LIVE") refreshAccount();
      return result;
    } catch (error) {
      const message = `Submission uncertain · review account before any new order. No automatic retry. ${error instanceof Error ? error.message : 'Transport failure'}`;
      const result = { ...pending, status: 'UNKNOWN_SUBMISSION', message };
      setSessionOrders(current => current.map(row => row.requestId === draft.requestId ? result : row));
      setTradeLog((current) => prependTradeLog(current, "bad", `${draft.requestId} · ${message}`));
      setToast({
        id: Date.now(),
        tone: "bad",
        message,
      });
      return result;
    }
    });
    submissionRequests.set(draft.requestId, request);
    return request;
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
    if (!accountStatus.armed && !accountStatus.liveEnabled) return;
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
      setSessionOrders(current => current.map(order => order.mode === 'LIVE' && order.orderId && result.canceled.includes(order.orderId) ? { ...order, status: 'CANCELED' } : order));
      setTradeLog((current) => prependTradeLog(current, "good", `${result.status} · ${result.canceled.length} orders canceled`));
      setToast({ id: Date.now(), tone: "good", message: `${result.status}: ${result.canceled.length} orders canceled` });
      refreshAccount();
    } catch (error) {
      setToast({ id: Date.now(), tone: "bad", message: error instanceof Error ? error.message : "Cancel-all failed" });
    } finally { await refreshAccount(); }
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
          <span>PUBLIC</span>
          <span className={`status status-${connection}`}><i />{connection}</span>
          <div className="workspace-tabs" aria-label="Saved workspaces">
            {WORKSPACE_SLOTS.map((slot) => <button key={slot} className={activeWorkspace === slot ? "active" : ""} onClick={() => void switchWorkspace(slot)}>{slot}</button>)}
          </div>
          <span>{openInstruments.length} DOM · {gridColumns}×{gridRows}</span>
          <button className={`mode-pill ${accountStatus.armed ? "mode-live" : ""}`} disabled={!accountStatus.armed && !accountStatus.liveEnabled} title={!accountStatus.liveEnabled ? 'LIVE disabled pending review' : undefined} onClick={toggleArmed}>
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
          <MarketNavigator bridge={bridge} instruments={instruments} leagues={leagues} favoriteIds={favoriteLeagueIds} recentIds={recentIds} openIds={openInstruments.map(item => item.assetId)} filters={discoveryFilters} onFilters={setDiscoveryFilters} onItems={mergeLoadedItems} onOpen={openBook} onFavorite={toggleLeagueFavorite} onClearRecent={() => setRecentIds([])} />
          {loading && <div className="drawer-message">Loading leagues and active markets…</div>}
          {marketError && <div className="drawer-message error">{marketError}</div>}

          <div className="navigator-resizer" onPointerDown={resizeNavigator} title="Drag to resize navigator" />
        </aside>

        <section ref={booksWorkspaceRef} className="books-workspace">
          <div className="workspace-hint">
            <span>BUY/SELL lanes rest limits · click ASK/BID depth to take · wheel pans · C recenters</span>
            <span className="workspace-legend">{gridLayout.overflowX || gridLayout.overflowY ? 'SCROLL · ' : ''}<i className="legend-depth" /> resting liquidity <i className="legend-print" /> executed volume · local time</span>
          </div>
          {unresolvedIds.map(id => <article className="unavailable-book" key={id}><strong>Unavailable book · {id}</strong><span>Unresolved or settled. Saved locally; no subscription or order controls.</span><button aria-label={`Retry ${id}`} disabled={!restored} onClick={() => void retryUnavailable(id)}>Retry</button><button aria-label={`Remove ${id}`} disabled={!restored} onClick={() => { pendingRef.current = pendingRef.current.filter(value => value !== id); setUnresolvedIds(pendingRef.current); }}>Remove</button></article>)}
          {openInstruments.length === 0 ? (
            <div className="empty-state">
              <strong>No books open</strong>
              <span>Select a market outcome from the left.</span>
            </div>
          ) : (
            <div
              className={`book-grid layout-${layoutMode.toLowerCase()} ${focusedAssetId ? "has-focus" : ""}`}
              style={{
                gridTemplateColumns: `repeat(${gridColumns}, ${gridLayout.panelWidth}px)`,
                gridTemplateRows: gridLayout.rowHeights.map(height => `${height}px`).join(' '),
                width: gridLayout.contentWidth,
                height: gridLayout.contentHeight,
              }}
            >
              {displayedOpenInstruments.map((instrument) => {
                const index = openInstruments.findIndex((item) => item.assetId === instrument.assetId);
                return (
                <BookPanel
                  key={`${activeWorkspace}:${instrument.assetId}`}
                  workspace={activeWorkspace}
                  onGeometry={reportGeometry}
                  layoutGeneration={`${layoutMode}:${workspaceWidth}:${workspaceHeight}:${openInstruments.map(item => item.assetId).join(',')}`}
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
        onClearDry={() => setSessionOrders(current => current.filter(order => order.mode !== 'DRY'))}
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
