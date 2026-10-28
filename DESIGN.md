# PolyScalp terminal design system

Research date: 2026-10-28. Product: local Electron/React Polymarket order-flow terminal.

## Evidence and interpretation

This UI is based on behavior documented by the products below, not a copy of their trade dress.

- [Tiger Dynamic DOM](https://support.tiger.com/english/windows/dom), [DOM settings](https://support.tiger.com/english/windows/dom/dom-settings/main), [price-scale adjustment](https://support.tiger.com/english/windows/dom/how-to-adjust-dom-scale), [workspaces](https://support.tiger.com/english/settings/workspace), and [watchlists](https://support.tiger.com/english/windows/watchlist). Observed in official documentation: a fixed price ladder, proportional resting-depth shading, separate executed-trade clusters/feed, configurable filters, own-order area, auto-scroll threshold, tick aggregation, docked workspaces, and grouped/linked watchlists. The official multi-DOM screenshot was inspected at full resolution; its books keep price centered and put depth, historical clusters, and executed circles on separate layers.
- [MetaScalp order book](https://metascalp.gitbook.io/english/orderbook), [tick settings](https://metascalp.gitbook.io/english/orderbook/setting/ticks), [cluster settings](https://metascalp.gitbook.io/english/orderbook/setting/clusters), and [current product page](https://app.metascalp.io/). Official material distinguishes resting book liquidity, real-time executed tape, and price/time clusters. It documents minimum-size filters, millisecond aggregation, large-print emphasis, compression, auto-centering, row-height controls, linked books/charts/watchlists, and multi-book workspaces.
- [Rung ladder](https://rungterminal.com/docs/en/ladder/) and [Rung grid/tree](https://rungterminal.com/docs/en/grid/). Official documentation describes one fixed row per tick; row-level BUY/SELL placement; right-click cancel; drag-to-replace; `C` to recenter; a Grid for many markets; and a navigator grouped by Date or League with LIVE and Favorites. Its published ladder screenshot was inspected at full resolution.
- [Polymarket market discovery](https://docs.polymarket.com/market-data/discover-markets), [Gamma API](https://gamma-api.polymarket.com/docs), and [order-book data](https://docs.polymarket.com/market-data/prices-order-books). The implemented hierarchy uses `/sports`, stable `series` IDs, `/events?series_id=…`, event IDs/slugs, market `gameStartTime`, condition IDs, outcomes and CLOB token IDs.

Unknowns remain explicit: the reviewed products do not publish a universal bubble-radius formula, fade duration, or canonical way to combine every Polymarket multi-outcome event into one DOM. PolyScalp therefore opens one outcome asset per DOM and labels bubble behavior as an implementation choice.

## Information architecture

```text
Sports
└── League / tournament (favorite this: NBA)
    └── Scheduled event (Nets vs Celtics, local start time)
        └── Market (moneyline, overtime, team to score first…)
            └── Outcome asset (open this as a DOM)
```

League favorites persist the Gamma sports `series` ID. They never depend only on display text. Expanding a league loads its active series events. Event times come from `market.gameStartTime`; `startDate` is not treated as game time because it can be the market creation/open timestamp.

Global search and tree navigation have different jobs: search finds loaded matching leagues/events/markets/outcomes; the tree preserves league → event → contract context. Recent contains outcome assets that were actually opened.

## DOM semantics

Each panel is a continuous probability ladder, high price at the top and low price at the bottom. A row is never moved merely because it has no liquidity.

Columns, left to right:

1. BUY action lane — rests a GTC buy at the displayed price.
2. Bid depth — resting shares, with a proportional green heat bar; clicking populated depth sends a taking SELL/FAK.
3. Price — probability in cents; current/last traded bucket is explicitly highlighted.
4. Ask depth — resting shares, with a proportional red heat bar; clicking populated depth sends a taking BUY/FAK.
5. SELL action lane — rests a GTC sell at the displayed price.
6. Executed volume — live trade prints aggregated into their displayed price bucket.

Resting depth and executed volume are never derived from each other. Bubbles use square-root area scaling so one outlier does not make all other prints invisible. Green means reported BUY, red SELL, and split color means both sides aggregated at the same displayed price. The visible minimum-size filter is `ALL`, `≥50`, `≥200`, or `≥500` shares.

`1T`, `2T`, and `5T` change semantic price aggregation. Wheel movement pans the ladder and visibly pauses auto-centering. `C`/the center control returns to live automatic centering. Panel height independently controls how many rows are rendered.

## Workspace behavior

- AUTO calculates 1–3 equal-width columns and enough equal-height rows to fit every open book in the viewport. At 1440×960, six books form a 3×2 layout; at 1100×800, they form 2×3.
- Focus expands one book without closing or unsubscribing the others.
- Panels can be reordered by dragging their header handle.
- The navigator can collapse, returning its width to the books.
- Manual 1C/2C/3C modes remain available.
- Up to six visible DOMs are an intentional MVP limit; Tiger/MetaScalp-style arbitrary docking and saved named workspaces are a later phase.

## Readability and visual tokens

Dense does not mean microscopic. Navigational names are 10–11 px, DOM prices are 10 px bold monospace, depth values are 9 px monospace, and only tertiary labels fall to 7–8 px. Numbers align through a monospace stack. Column headers are persistent. Color always has a text/shape companion.

- Canvas: `#080A0E`
- Panel: `#0A0F15`
- Raised/header: `#10161E`
- Border: `#293544`
- Primary text: `#E6E9EF`
- Muted text: `#768295`
- Focus/action: `#2F6DF6`
- Bid/buy: `#19C98A`
- Ask/sell: `#F35F78`
- Warning/dry/favorite: `#EAB44F`
- Spacing rhythm: 4 px base; DOM row: 22 px; radius: 2–4 px

## Trading guardrails retained

- The application starts in DRY mode; clicks produce audited dry orders only.
- Live orders require a connected signer and an explicit session-level ARM action.
- The arm dialog states that subsequent DOM clicks are real and shows the per-order USD cap.
- Submit remains disabled until the WebSocket is live and an initial book snapshot is ready.
- The main process validates asset ID, side, tick-bounded price, positive size, execution type, and mode.
- Private keys remain in Electron main-process memory for the session and are not stored by this app.

## Verified acceptance snapshot

- League favorite uses a series ID and survives reload.
- NBA expands into scheduled events and displays the user's local start time.
- Outcome buttons open independent CLOB token books.
- Six books auto-fit at 1440×960 and 1100×800.
- Tick aggregation, manual pan, recenter, depth heat bars, and price-aligned print bubbles render together.
- Compact QA observed 6 panels, 54 DOM rows and 30 executed-volume bubbles.
