# Polymarket Orderbook Terminal MVP

Local Electron workstation for opening several Polymarket order books and staging orders directly from the price ladder.

## Current scope

- Up to six simultaneous live order books over one shared Polymarket market WebSocket.
- Dynamic subscriptions as panels are opened and closed.
- Full book snapshots, price-level deltas, tick-size changes, BBO and last-trade updates.
- Click ASK liquidity to stage a taker BUY (FAK).
- Click BID liquidity to stage a taker SELL (FAK).
- Click the outer BUY/SELL lanes to stage resting GTC orders.
- Responsive 1/2/3-column workspace, drag-to-reorder and persisted open books.
- DRY mode only. Orders are validated and appended to Electron's local `orders.jsonl`; nothing is sent to the exchange.

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

The browser-only preview uses demo markets and synthetic books:

```sh
npm run dev:web
```

## Safety boundary

Live trading is intentionally not enabled in this first slice. The renderer has no Node access and never receives secrets. Authenticated order placement will be added in the Electron main process using the official unified Polymarket SDK, after wallet type and credential-storage choices are confirmed.

## Sources

- [Polymarket market WebSocket](https://docs.polymarket.com/api-reference/wss/market)
- [Polymarket order placement](https://docs.polymarket.com/trading/place-orders)
- [Polymarket wallet authentication](https://docs.polymarket.com/trading/wallets-auth)
