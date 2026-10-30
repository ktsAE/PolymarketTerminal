import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AccountPosition, AccountStatus, BookState, ConnectionStatus, Instrument, OrderDraft, OrderResult } from "../types";
import { bridge } from "../bridge";
import { marketStore } from "../state/marketStore";
import { readPanelSettings, savePanelSettings, rememberedSize } from "../state/workspaceStore";
import { PanelSettings, type PanelSettingsValue } from "./PanelSettings";
import { localStartLabel as startLabel } from "./MarketNavigator";
import { ExecutedBubble } from "./ExecutedBubble";
import { ClusterCell } from "./ClusterColumns";
import { compactNumber, money, priceLabel, signedMoney } from "../lib/format";
import { parseUnits, formatUnits, parseShares, formatShares } from "../../shared/decimal.cjs";
import { qualifyingPrints } from "../domain/executions";
import { sampleDepthScale, updateDepthScale } from "../domain/scales";

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
    shortLabel: `${new Date(column.startMs).toLocaleTimeString([], { hour12: false })}${analysis.nowMs < column.endMs ? ' ●' : ''}${column.quality.gap ? ' GAP' : column.quality.partial ? ' PART' : ''}`,
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
            {settings.showClusters && clusterColumns.map((column) => <span className="cluster-heading" title={column.label} aria-label={column.label} key={column.startMs}>{column.shortLabel}</span>)}
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
