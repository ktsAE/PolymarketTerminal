# PolyScalp terminal design system

Capture date: 2026-10-28. Target: the local Electron/React Polymarket terminal in this repository.

## Reference evidence

- [Rung Terminal](https://rungterminal.com/) — inspected the full desktop landing capture at 1440 px and the published [ladder screenshot](https://rungterminal.com/docs/img/ladder.png). Observed: near-black workspace, one-row price ladders, separate buy/price/sell columns, compact order size controls, tape beside the ladder, and direct click-on-price trading. Extracted landing tokens included `#0B0E14` background, `#11151F` input, `#1C2230` border, `#2F6DF6` primary, system UI type, and 6 px input radius.
- [Tiger.com Windows terminal](https://www.tiger.com/terminal) — inspected the full page and the published [Dynamic DOM screenshot](https://cdn-se.tiger.trade/img/why-us-slider/why-us_2.png?auto=format&fit=max&w=3840). Observed: multi-DOM workspace with several equal-width panels, persistent platform chrome, dense 20-ish px ladder rows, heat/depth blocks, execution bubbles over the ladder, and bottom account/order tabs. Extracted site tokens included `#0D0D11` background and `#FF721C` accent; the terminal screenshot itself uses mostly neutral black/gray with blue/red/orange data layers.
- [MetaScalp](https://metascalp.io/en) — inspected the full 1440 px page and a representative [terminal screenshot](https://fsr-develop.com/wp-content/uploads/2024/10/unnamed-1024x576.png). The product describes order book, tape, clusters, working position sizes and real-time PnL in one window. The screenshot shows large size-scaled green/red trade circles alongside a heat-colored order book and several books on one canvas.

These references inform interaction density and information hierarchy only. Their logos, exact layouts, assets and trade dress are not copied.

## Product principles

1. Discovery stays visible. Search, categories, favorites and recent markets live in one persistent navigator.
2. The workspace owns sizing. Panels fill an automatically computed 1–3 column grid; individual native resize handles are not used.
3. One click means one obvious action. The bid/ask liquidity cells take liquidity; outer lanes rest post-only orders. Live trading remains explicitly armed and capped.
4. Do not conflate data. Ladder bars are resting depth. Circular prints are executed trades from Polymarket's `last_trade_price` stream.
5. Dense, not decorative. Borders, spacing and type are compact; color is reserved for state, side, depth and action.

## Tokens

Implementation choices adapted from the observed systems:

- Canvas: `#080A0E`
- Primary panel: `#0D1117`
- Raised panel: `#111720`
- Border: `#222A35`
- Primary text: `#E6E9EF`
- Muted text: `#768295`
- Focus/action blue: `#2F6DF6`
- Bid/buy: `#19C98A`
- Ask/sell: `#F35F78`
- Warning/dry/favorite: `#EAB44F`
- UI font: Inter/system UI; numbers: SFMono/Consolas fallback
- Radius: 2–4 px for terminal controls and panels, 50% only for trade prints/status lights
- Spacing rhythm: 4 px base, usually 6–12 px around dense controls

## Layout

- Top chrome: 52 px.
- Navigator: 310 px desktop, 260 px compact, collapsible to 0.
- Workspace gap: 8 px.
- AUTO layout target: minimum 340 px per book, maximum three columns, rows derived from book count. Each book fills its grid cell and internally recomputes visible depth levels.
- Focus mode: one book occupies the complete workspace without closing or unsubscribing the other books.

## Components

### Market navigator

- Search covers event title, market title, outcome and tags.
- All / Favorites / Recent views precede category filters.
- A star is an independent target and persists the outcome asset ID locally.
- Open markets remain selectable; selecting one focuses that book.

### Order-book panel

- Header: drag handle, truncated question, outcome chip, 24 h volume, favorite, focus and close.
- Working-size strip: editable quantity, dollars/shares unit, 5/10/25/100 presets, best bid/ask/spread, and full-book bid/ask imbalance.
- Ladder: outer resting-order lanes, resting bid size, price, resting ask size, and mirrored heat bars.
- Prints rail: recent executed trades, scaled with square-root sizing so outliers remain legible. Green is reported BUY; red is reported SELL.
- Footer: tick, minimum size, total current resting depth and live/dry status.

## Fidelity and unresolved details

- Rung's published screenshot supports its ladder/tape structure, but does not establish all responsive, hover or keyboard behavior.
- Tiger's screenshots show its Windows terminal rather than its website's extracted brand system; spacing values in this implementation are visual estimates.
- MetaScalp's representative screenshot is a third-party published capture. Its circle sizing and exact aggregation formula are unknown, so this terminal uses a documented square-root scale.
- Polymarket WebSocket trade prints arrive live and are not historical backfill. A quiet market can show an empty prints rail until the next execution.
