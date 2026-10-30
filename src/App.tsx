import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import { bridge } from "./bridge";
import type {
  AccountSnapshot,
  AccountStatus,
  BookState,
  ConnectionStatus,
  Instrument,
  MarketLeague,

  OrderDraft,
  OrderResult,
} from "./types";

import { readWorkspace, saveWorkspace, readPanelSettings, DEFAULT_FILTERS, storageGet, storageSet, type DiscoveryFilters } from './state/workspaceStore';
import { MarketNavigator } from './components/MarketNavigator';
import { marketStore } from './state/marketStore';
import { priceLabel, shortAddress, tradeTime } from './lib/format';
import { BookPanel } from './components/BookPanel';
import { LoginModal } from './components/LoginModal';
import { AccountDrawer } from './components/AccountDrawer';
import { BottomDock, type DockTab, type TapeExecution } from './components/BottomDock';
import type { TradeLogEntry } from './components/tradeLog';
import { calculateWorkspaceLayout } from './hooks/useWorkspaceLayout';

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
const FAVORITE_LEAGUES_KEY = "pm-terminal:favorite-leagues";
const RECENTS_KEY = "pm-terminal:recent-instruments";
const ACTIVE_WORKSPACE_KEY = "pm-terminal:active-workspace";
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
