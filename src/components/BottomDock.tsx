import type { PointerEvent as ReactPointerEvent } from "react";
import type { AccountSnapshot, AccountStatus, Instrument, OrderResult, TradePrint } from "../types";
import { compactNumber, money, priceLabel, shortAddress, signedMoney, tradeTime } from "../lib/format";
import { SessionOrders } from "./SessionOrders";
import type { TradeLogEntry } from "./tradeLog";

export type DockTab = "ORDERS" | "MARKET TAPE" | "POSITIONS" | "ACCOUNT" | "TRADE LOG";

export interface TapeExecution {
  instrument: Instrument;
  trade: TradePrint;
}

interface BottomDockProps {
  onClearDry(): void;
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

export function BottomDock({
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
  onClearDry,
}: BottomDockProps) {
  const tabs: Array<{ id: DockTab; count?: number }> = [
    { id: "ORDERS", count: orders.length },
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
            {tab.id === 'ORDERS' ? 'SESSION ORDERS' : tab.id}{tab.count !== undefined && <b>{tab.count}</b>}
          </button>
        ))}
        <span className="dock-note">{activeTab === "MARKET TAPE" ? "PUBLIC CLOB PRINTS · NOT PERSONAL FILLS" : accountStatus.connected ? shortAddress(accountStatus.account?.wallet) : "ACCOUNT OFFLINE"}</span>
        <button className="dock-toggle" onClick={onToggle}>{collapsed ? "▴" : "▾"}</button>
      </nav>
      {!collapsed && (
        <div className="dock-content">
          {activeTab === "ORDERS" && <SessionOrders onClearDry={onClearDry} />}
          {activeTab === "ORDERS" && (
            <div className="blotter-table orders-table">
              <header><span>TIME</span><span>MODE</span><span>MARKET / OUTCOME</span><span>SIDE</span><span>QTY</span><span>PRICE</span><span>TYPE</span><span>STATUS</span></header>
              {orders.length === 0 && <div className="dock-empty">No session submissions. Accepted is not a fill; hollow markers are not working orders.</div>}
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
              <header><span>TIME</span><span>LEAGUE</span><span>MARKET / OUTCOME</span><span>REPORTED SIDE</span><span>PRICE</span><span>SIZE</span></header>
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
