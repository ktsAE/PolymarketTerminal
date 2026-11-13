# Polymarket Terminal

Two independent local tools for Polymarket, built on its public APIs:

| | What it is | Orders? | Start |
|---|---|---|---|
| **Radar** (`radar/`) | A terminal screener: markets where new accounts are putting money, holders by wallet class, a live order-book DOM, a wallet's real record, cost of a trade, wallet following | **Never.** Read-only | `npm run doctor`, then `npm run tui` |
| **Desktop terminal** (Electron) | Several live order books on a price ladder, with optional order entry | Yes, only after you connect a key and arm it. DRY by default | `npm install`, then `npm run dev` |

Requires Node >= 22.18. Everything runs on your machine; there is no server, account or telemetry.

## Radar in 60 seconds

```sh
npm install
npm run doctor     # checks the Polymarket endpoints the radar needs
npm run tui        # 1 Markets . 2 Games . 3 Newbies . 4 Holders . 5 Decision . 6 X-ray . 7 Search . 8 Book . 9 Following
```

Typical flow: **3 Newbies** (markets ranked by money from accounts under 14 days old) -> Enter for **Holders** -> `8` for the live **Book** -> `p` for **Decision** -> `x` for a wallet's **X-ray**. Press `?` for every key. Full guide: [`radar/README.md`](radar/README.md). Release notes: [`CHANGELOG.md`](CHANGELOG.md).

What the radar is **not**: it is not trading advice and it has found no trading edge (see the studies in [`docs/research/radar/`](docs/research/radar/)). Labels such as "new account" or "cluster" describe behaviour; they are not accusations about anyone.

## Disclaimer and risk

Educational and research software, provided as is, with no warranty. Nothing here is financial, legal or investment advice. Prediction markets can lose you money, and trading may be restricted where you live: check Polymarket's terms and geographic rules yourself. The desktop terminal can place real orders if you connect a key and arm live trading; you are responsible for every order. This project is not affiliated with or endorsed by Polymarket.

## Security

Read [`SECURITY.md`](SECURITY.md) before connecting a key. In short: use a dedicated low-balance signer, never a primary wallet; the radar needs no key at all. Report vulnerabilities privately as described there.

## Desktop terminal

Local Electron workstation for opening several Polymarket order books and placing orders directly from the price ladder.

## Current scope

- Up to six simultaneous live order books over one shared Polymarket market WebSocket.
- Dynamic subscriptions as panels are opened and closed.
- Full book snapshots, price-level deltas, tick-size changes, BBO and last-trade updates.
- Click ASK liquidity for a protected taker BUY (FAK); click BID liquidity for a protected taker SELL (FAK).
- Click the outer BUY/SELL lanes for post-only resting limit orders.
- Sports hierarchy backed by Gamma `/sports` and `series_id`: league/tournament → scheduled event → market → outcome.
- Persisted league-level Favorites (for example NBA, not one Celtics/Nets outcome), expandable schedules, local game-start times, global loaded-market search and Recent outcomes.
- AUTO workspace that derives a 1/2/3-column grid from the available window, plus manual column modes, drag-to-reorder, focus mode and persisted open books.
- Three persistent SCALP workspace slots and a width-resizable/collapsible league navigator.
- Full-book bid/ask imbalance and heat bars for resting depth.
- Continuous, fixed-price DOM rows with 1/2/5-tick compression, wheel panning, explicit recentering and responsive visible depth.
- Three historical time-cluster columns with Volume, Delta and Bid×Ask modes, 5/15/60-second buckets, independent 18/22/26-pixel rows and configurable depth normalization.
- Executed-trade bubbles driven by `last_trade_price` and aligned to their price rows, with size filters and rolling print volume. Resting liquidity stays in separate heat-bar columns.
- Per-book position size, average entry, PnL and spread strip, plus session working-order markers in the outer DOM rails.
- A resizable bottom dock for session Orders, clearly labeled public Market Tape, Positions, Account state and Trade Log.
- Quick working-size presets (5/10/25/100) beside the editable dollars/shares quantity.
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

Check real league discovery, NBA series grouping, `gameStartTime`, outcomes and CLOB asset IDs:

```sh
npm run smoke:leagues
```

Check that the authenticated trading module loads under Electron's Node runtime without connecting a wallet:

```sh
npm run smoke:trading-module
```

The browser-only preview uses demo markets and synthetic books:

```sh
npm run dev:web
```

The visual reference audit and implementation tokens are documented in [`DESIGN.md`](DESIGN.md).

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
