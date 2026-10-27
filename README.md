# Polymarket Orderbook Terminal MVP

Local Electron workstation for opening several Polymarket order books and placing orders directly from the price ladder.

## Current scope

- Up to six simultaneous live order books over one shared Polymarket market WebSocket.
- Dynamic subscriptions as panels are opened and closed.
- Full book snapshots, price-level deltas, tick-size changes, BBO and last-trade updates.
- Click ASK liquidity for a protected taker BUY (FAK); click BID liquidity for a protected taker SELL (FAK).
- Click the outer BUY/SELL lanes for post-only resting limit orders.
- Categorized market discovery with tag-aware search.
- Responsive 1/2/3-column workspace, drag-to-reorder, resize handles and persisted open books.
- Depth bars and proportional liquidity bubbles at every visible level.
- In-memory private-key connection, portfolio value, open positions, PnL and open-order count.
- DRY mode by default. Live orders require an authenticated account, explicit session arming, a passing location check and a per-order notional cap.

## Run

```sh
npm install
npm run dev
```

Or build and launch the local desktop bundle:

```sh
npm start
```

Check the real public market-discovery and order-book feed without placing an order:

```sh
npm run smoke:live
```

Check that the authenticated trading module loads under Electron's Node runtime without connecting a wallet:

```sh
npm run smoke:trading-module
```

The browser-only preview uses demo markets and synthetic books:

```sh
npm run dev:web
```

## Connect an account

1. Start the desktop app and click **NOT CONNECTED**.
2. Click **CONNECT PRIVATE KEY**.
3. Paste the private key for a dedicated low-balance signer. Do not use a high-value primary wallet.
4. If this signer controls an existing Polymarket Proxy, Safe or Deposit Wallet, paste that account wallet address in the optional second field. Leaving it blank selects the signer's default Deposit Wallet flow.
5. Connection does not arm trading. Review the wallet, location and positions, then click **ARM LIVE** when ready.

The private key is passed to the Electron main process, held in memory for the current session and never written to the order log or project files. Disconnecting or closing the app removes it from process memory.

The default live-order cap is $25. To start with a lower cap:

```sh
PM_TERMINAL_MAX_ORDER_USD=5 npm start
```

## Safety boundary

The renderer has no Node access and the signer never returns from the main process after connection. Every live order rechecks session arming, a recent Polymarket geoblock result and the notional cap. Resting orders are post-only. The account drawer includes a confirmed cancel-all control that also disarms live trading.

Private-key login is the fastest MVP integration, not the ideal long-term design. A dedicated signer or Polymarket session key limits exposure better than importing a primary wallet key. Live authentication and order placement cannot be fully verified without the owner's actual wallet type and a deliberately funded test account; keep the first live test at the minimum supported size.

## Sources

- [Polymarket market WebSocket](https://docs.polymarket.com/api-reference/wss/market)
- [Polymarket order placement](https://docs.polymarket.com/trading/place-orders)
- [Polymarket wallet authentication](https://docs.polymarket.com/trading/wallets-auth)
- [Polymarket TypeScript SDK](https://docs.polymarket.com/getting-started/typescript)
- [Polymarket wallet activity](https://docs.polymarket.com/trading/wallet-activity)
- [Polymarket geographic restrictions](https://docs.polymarket.com/api-reference/geoblock)
