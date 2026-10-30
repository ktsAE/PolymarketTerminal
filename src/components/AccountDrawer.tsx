import type { AccountSnapshot, AccountStatus } from "../types";
import { money, priceLabel, shortAddress, signedMoney } from "../lib/format";

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

export function AccountDrawer({
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
            <button className={status.armed ? "danger-button armed" : "arm-button"} disabled={!status.armed && !status.liveEnabled} title={!status.liveEnabled ? 'LIVE disabled pending review' : undefined} onClick={onToggleArmed}>
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
