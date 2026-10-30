# Professional Terminal Reliability Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task, after implementation is explicitly authorized.

**Goal:** Make the existing Polymarket DOM, execution displays, adaptive workspace and league discovery trustworthy and usable without weakening DRY mode or live-trading controls.

**Architecture:** Extract pure price/order-flow/workspace models from the monolithic React application, give feed state a lifetime independent of mounted panels, and expose narrow validated discovery and order-intent IPC contracts. Keep the Electron main process authoritative for trading eligibility, freshness and risk; the renderer only presents data and requests actions. Deliver correctness before visual polish; do not rebuild the application or add arbitrary docking.

**Tech Stack:** Existing Electron, React, TypeScript, Vite, ws, Zod and @polymarket/client. Proposed test additions: Vitest, jsdom and React Testing Library; retain Node/Electron trading mapping tests and use the existing Electron screenshot approach with workspace-local storage and deterministic fixtures.

---

Status: PLAN ONLY. No application changes, installs, builds, orders or commits performed in this planning pass.

Inputs:
- docs/research/terminal-gap-analysis/REPORT.md (G1–G12 and primary-source bibliography).
- Current src/App.tsx, src/types.ts, src/demoBridge.ts, src/styles.css.
- Current electron/main.cjs, electron/preload.cjs, electron/trading.mjs and scripts/trading-orders.test.mjs.
- README.md, DESIGN.md, package.json, tsconfig.json and scripts/qa-screenshot.cjs.

Public product documentation establishes reference behavior, not proprietary algorithms. Numerical policies below are deliberate PolyScalp product decisions, not claims about Tiger or MetaScalp internals.

## 1. Reinspection baseline and scope

Current working tree already includes all six requested features. Do not mark them as absent or replace them wholesale.

| Existing location | Current behavior | Planned change |
| --- | --- | --- |
| src/App.tsx:43–117 | Book reducer; last_trade_price retained to 40 prints; missing side becomes BUY | Separate book reducer and normalized execution ingestion; unknown direction stays unknown; analytical history independent of tape length |
| src/App.tsx:269–470 | BookPanel owns compression, row size, scaling, cluster calculations and order placement | Controlled BookPanel composed from reusable ladder/cluster/bubble/settings components |
| src/App.tsx:341–358 | Three moving windows anchored on Date.now/latest trade | Fixed epoch-aligned intervals, explicit current/closed labels and coverage |
| src/App.tsx:1000–1005,1127–1134,1536–1540 | Width-based equal-grid AUTO, minimum cell sizes | Measured height as well as width; readable-row minimum; explicit scroll policy |
| src/App.tsx:1018–1024,1189–1204 | Restores asset IDs only from loaded instrument cache | Resolve saved identities before committing restored workspace; unresolved placeholders |
| src/App.tsx:1088–1121,1411–1490 | Series-ID favorites; cache search; silent list truncation | Preserve stars; explicit loaded-search scope, pagination and saved discovery filters |
| src/App.tsx:359–362,1320–1328 | Session accepted results masquerade as working orders; cancel-all marks every accepted result canceled | Session-submission labels until authenticated reconciliation is verified; update only confirmed cancellation IDs |
| electron/main.cjs:325–339 | Renderer draft is schema checked; DRY logs, LIVE delegates | Main validates market identity, native ticks, snapshot generation and captured intent; mode never inferred/upgraded |
| electron/trading.mjs:111–128,230–258 | Arming/location/cap/post-only/FAK; cancel-all disarms after successful response | Preserve checks; enforce arm epoch across async work; disarm before cancellation attempt; propagate status |

The existing tests cover request mapping and the $25 default cap, not feed accuracy, IPC trust boundaries, arming races, layouts or restoration. Existing README/DESIGN acceptance assertions are not newly reproduced results.

In scope: correctness and useful parity for the six requested areas; honest session-order labeling; safety regression protection. Out of scope: new signer/login design, automatic strategies, new order types, per-order cancel/drag-to-replace, historical API backfill, arbitrarily dockable panes, alerts, named outcome watchlists and a general Bookmap chart. Authenticated working-order reconciliation is a separately gated final increment, not a prerequisite for honestly labeling session submissions.

## 2. Non-negotiable trading boundaries

S1. Start in DRY, disconnected and disarmed on every process launch. Connecting, restoring, changing layouts, selecting a league, opening a book and replaying data NEVER arm trading. Never persist keys, connected status, arm state or pending order intents.

S2. An order intent captures mode, asset, native price, size/unit, execution, book generation and arm epoch when the interaction begins. Never reinterpret a DRY request as LIVE because arming changed during a click, a render or an IPC round trip. A LIVE request after disarm is rejected, not downgraded and not retried.

S3. DRY uses the same schema/tick/size/metadata validation as LIVE but NEVER creates a secure client, signs, places, cancels or simulates fills against the account. DRY_ACCEPTED means a validated simulated submission only, not an execution. No new notional cap is imposed on DRY; show the current live cap and warn when a DRY draft exceeds it. LIVE retains the configured cap (default $25); UI cannot raise it.

S4. LIVE requires main-process authorization: connected client, explicit confirmed session arm, matching current arm epoch, location explicitly allowed (cached no longer than 60 seconds), verified not-close-only restrictions, valid native price/size, current market accepting orders, fresh current-generation book and configured cap. Validate restrictions when arming and recheck before submission when their cache age exceeds 60 seconds; unknown/error fails closed. Renderer checks are convenience only.

S5. Tick/size metadata lives in main, populated from validated market discovery/resolution and current tick messages. Reject missing/unsupported tick metadata; do not accept a renderer-provided tick or minimum size as authoritative. Check 0 < price < 1, exact tick alignment, positive finite size and supported decimal precision. Convert USD to shares under the existing BUY/SELL mapping; enforce known market minimum/size increments after conversion, rejecting rather than silently rounding upward.

S6. Book readiness is false after disconnect/reconnect/resubscribe/tick change until a fresh validated snapshot arrives. Main tracks per-asset snapshot generation/revision. A received snapshot or valid book delta refreshes book time; last-trade/BBO messages alone do not. LIVE is blocked if no snapshot, disconnected or book time is older than 10 seconds; UI says STALE and offers a read-only refresh. A quiet market is allowed to become stale; do not assume a heartbeat proves current depth. A successful validated refresh snapshot clears stale state. This is conservative by design.

S7. At 1T, BUY lane = post-only GTC BUY; SELL lane = post-only GTC SELL; clicking bid depth = protected FAK SELL; clicking ask depth = protected FAK BUY. Prices are the exact native row prices, never unlimited market orders. FAK has no guaranteed fill and may fill partially. For USD SELL, “USD” remains target notional at the protection price, not guaranteed realized proceeds; show that in size help. Existing GTC postOnly, FAK maxPrice/minPrice and BUY maxSpend boundaries remain intact.

S8. At 2T/5T, no DOM click submits any order in either mode. Click/Enter on any trading lane zooms to 1T centered on that group's midpoint and shows “Expanded to native ticks — choose a price to submit.” A second distinct action at 1T is required. No auto-submit after zoom. Group-level tooltips show native price range and total shares. This avoids inventing executable-price semantics for a grouped bucket.

S9. Capture row identity on pointer-down; freeze centering until pointer-up/cancel. Cancel if layout, compression, tick, asset, mode or arm epoch changes. Require current book generation and price row to match at submit; recheck in main. After all asynchronous location/restriction/metadata checks, synchronously revalidate account identity, arm epoch, book freshness/generation, tick version and market eligibility immediately before the SDK call, with no intervening await. In-flight SDK requests cannot be recalled by disarming; show them as pending/unknown until resolved rather than claiming disarm canceled them. Use a per-panel pending guard and a request ID. Main remembers in-flight/recent request IDs for the session and must not execute the same ID twice. An uncertain SDK/network outcome is UNKNOWN_SUBMISSION; do not retry automatically. Retry requires account review and a new explicit action.

S10. Freeze UI order gestures during resize/drag/workspace switches, settings overlays and disarm transitions. On market socket disconnect, renderer reload/navigation, account restriction failure or cancel-all attempt, disarm in main and invalidate arm epoch BEFORE awaited work. Reconnect never rearms. A plain focus/layout/settings change need not disarm but cancels an active gesture.

S11. Cancel-all remains an explicit confirmed account-wide LIVE action, even when entry mode is DRY; label it “Cancel LIVE account orders,” disabled without an account. Disarm before issuing network cancellation, including failures. Never mark all orders canceled from a successful request alone. Use returned canceled IDs; unresolved IDs stay unknown/pending until reconciliation. DRY markers are not touched by account cancel-all; provide “Clear DRY submissions” as a separate local action.

S12. Credentials stay inside Electron main-process session memory; no key in storage, logs, screenshots, saved workspaces or renderer responses. Keep contextIsolation=true, sandbox=true, nodeIntegration=false and explicit preload methods. Do not add generic invoke/eval/network bridges. Validate IPC sender as the application window's current main frame; reject other windows/frames.

S13. Automated tests and screenshot QA are offline and DRY-only, with account/live submission methods that throw if called. QA userData, sessionData, caches and output remain under artifacts/ within this workspace. No test account, funds, real signing or live order is needed for this plan. Live validation is a separate owner-authorized activity, not an automated acceptance step.

## 3. Exact UI behavior

### 3.1 DOM, price compression and centering

- One asset/outcome per panel; retain six open books maximum, high prices at top and continuous empty rows. Prices stay within (0,1), rendered as cents with enough decimal precision to distinguish native ticks.
- Price arithmetic uses integer probability units (1 unit = 0.000001); parse decimal strings without floating-point rounding. Support metadata ticks exactly representable at this scale. An unsupported precision shows “Unsupported tick precision — trading disabled,” rather than clamping to 0.001 as today.
- A native price n in integer units maps to group floor(n / (tickUnits × compression)); group contains its valid native prices from low through high inclusive. Price header at >1T displays low–high, not a fictitious single executable price. Both bid and ask may appear in one group; neither is inferred from the other.
- Defaults: 1T, 22 px rows, AUTO centering, full row labels. Keep 1T/2T/5T and 18/22/26 px controls. Measure the actual ladder viewport, not panel height minus a hard-coded constant. Visible rows = largest odd count fitting viewport, clamped to 1–99; grid minimum is seven rows, except focus/edge windows where visible-row count still reflects available pixels.
- AUTO stores a center group and only recenters when rounded BBO midpoint leaves ±max(1, floor(visibleRows/4)) rows around center. First valid snapshot centers immediately. Clamp center to show a full valid range where possible near probability endpoints. Pointer gestures freeze movement.
- Wheel over ladder pans by three displayed rows per wheel notch and sets MANUAL; preserve fractional trackpad accumulation. Show MANUAL status and Center control. C only recenters when the ladder has focus and no input/select/dialog is active; it never submits or cancels orders.
- LIVE/DRY mode is global but prominently visible in every panel. STALE/CONNECTING/UNSUPPORTED blocks order submission. A frozen/partial execution view does not itself block trading when the book is independently healthy; its warnings remain visible.

### 3.2 Resting-depth normalization

- Depth bars always represent resting shares; total imbalance remains explicitly “Full-book depth” rather than near-spread volume.
- AUTO sample = levels within 20 native ticks from BBO on each side; sum sampled native levels into displayed groups, then use the maximum sampled group volume as target (minimum 1 share). Recompute at most every 250 ms. Increases apply immediately; decreases apply after target stays below 70% of current scale for two continuous seconds, then set scale to target. Out-of-window orders do not influence AUTO scale.
- Retain fixed 500/2K/10K-share scales. Display effective full-scale amount and sample depth in settings/tooltip; bars saturate at 100%. Manual mode does not change with feed activity. All numeric totals remain available even when bars saturate.

### 3.3 Executed-volume bubbles and tape

- Label rail “Executed · 10s.” One bubble is all qualifying reported prints at that displayed price over ten second-aligned bins, not a single trade and not resting depth. Window at clock t is [floor(t/1000)×1000−9000, t]; future events are not displayed early. Tick view at 250 ms even during inactivity.
- Default filters remain ALL/≥50/≥200/≥500 shares and apply to each execution before bubble aggregation. Filter does not change clusters, raw public tape, or total 10s print-volume counter. Label counter “10s public volume” and show quality/coverage with it.
- Bubble channels: reported BUY green, SELL red, unknown neutral. If both known directions occur, split fill by buy/sell proportion, even when unequal. Unknown portion is a neutral outlined wedge/segment; tooltip gives all three totals, count and coverage. Shape/text supplements color.
- Diameter d = sqrt(dMin² + (dMax²−dMin²) × min(1, volume/scale)); dMax=min(32,rowHeight−2), dMin=min(8,dMax). Scale is maximum qualifying group volume in the current 10s window, sampled on the same clock. This intentionally bounded area encoding is not strict area proportionality; disclose relative scaling in help. Bubbles cannot overlap adjacent rows.
- Hide bubble numbers below diameter 16 px; tooltip and keyboard-accessible price-row details retain exact values. Settings offer “Numbers: Auto/Off,” never shrink text to 6 px to fit. Empty interval produces no bubble, not a zero circle.
- Public Tape contains up to 1,000 recent received prints across the active six assets, chronological newest-first, visibly labeled public/not personal. Display provider time and receive-time fallback marker, unknown side, data quality and reconnect gaps. Tape length never controls cluster totals.

### 3.4 Executed-volume clusters

- Three columns, oldest left: previous two closed buckets plus current in-progress bucket. Period selector 5s/15s/60s; default 15s. Headers show local interval start time and “LIVE” for current; tooltips show exact [start,end) with timezone.
- Bucket start = floor(eventTimeMs / periodMs) × periodMs. Event at the end belongs to the next bucket. Wall clock advances columns without events. Late prints update retained buckets and briefly mark header “CORRECTED”; corrections do not imply coverage completeness.
- Retain price/second analytical aggregates for ten minutes independent of raw tape. Aggregate by absolute price units, not current tick/compression, so compression and period changes do not destroy history. Tick changes affect presentation/order eligibility, not historical prices.
- Volume shows total shares including unknown side. Delta shows reported BUY minus SELL only; if any prints have unknown direction, suffix known delta with “*” and explain excluded unknown volume. Directional header says “Reported Δ,” never “Aggressor Δ” unless provider semantics are verified. Rename current BIDASK mode to “BUY×SELL” until classification is proven; unknown amounts are visible in details.
- Cluster bar intensity uses total volume for Volume/BUY×SELL and abs(known delta) for Delta. Direction color uses the sign of known delta only; zero/unknown-only is neutral. Cluster details always list BUY, SELL and UNKNOWN totals, including zero-known-delta cases. Default normalization is shared across the three columns at max selected-mode magnitude, minimum 1. Settings: Shared AUTO / Per-column AUTO / Fixed 500/2K/10K shares. No depth-setting coupling. Highlight highest-total-volume price cell per column with outline; ties all outlined. Zero known delta with high two-way volume remains visible through text/outline, not false directional fill.
- Coverage: “Observed since HH:MM:SS” on subscription; partial intervals show striped header and PARTIAL; gaps use hatched cells/background and details; outside retained history says UNAVAILABLE, never numeric zero. Fully observed means locally continuous subscribed coverage, NOT guaranteed exchange completeness. Reconnect gaps remain marked even if a fresh book snapshot arrives. No synthetic backfill from depth.
- If fallback timestamps or ambiguous duplicate identity affect a bucket, mark APPROXIMATE separately from PARTIAL. Allow volume/delta display with quality warnings; never label it an exact footprint.

### 3.5 Workspace, settings and persistence

- AUTO columns = min(openCount,3,max(1,floor((availableWidth+gap)/(360+gap)))), gap=8 px. Manual 1C/2C/3C remains; minimum panel width 360 px. More manual columns than fit causes explicit horizontal workspace scroll, not clipped prices.
- Minimum panel height = measured non-ladder chrome + seven rows at selected row height. Compute one shared grid row height from the maximum chrome/row-height minimum among books in that grid row. If viewport fits all rows, distribute extra height equally; otherwise scroll vertically. Header displays “6 books · 2×3 · scroll” when necessary. Do not promise all books always fit.
- Navigator width persists 240–520 px; collapsed uses zero. Bottom dock collapsed=31 px tabs; expanded height persists 100–360 px, further clamped so workspace retains at least one minimum-height panel where window size permits. Never auto-collapse the dock just to hide overflow.
- No proportional splitters between books in this delivery; equal grid, drag-reorder, focus and chrome resize already cover the workflow. Keep focus-mounted data/settings independent of panel mounting; hide/unmount presentation safely without unsubscribing other active books.
- Panel Settings button is always visible. At width <430 px move extra selectors into its popover instead of removing their functionality. Popover contains compression, row size, cluster mode/period/normalization, bubble threshold/labels, depth scale and visibility toggles for clusters/bubbles. Default all analysis columns on; opt-out hides them without stopping aggregation. Price/depth/essential trading rails never disappear implicitly.
- DOM/cluster numbers >=9 px, prices >=10 px; narrow layouts scroll or hide optional columns by explicit user choice. Keyboard navigation, names and tooltips must be available without hover-only dependence. Settings dialogs/popovers trap focus appropriately, Escape closes and returns focus.
- Three SCALP slots persist ordered assets and per-book settings independently. Defaults: size 10, USD, 1T,22px,15s,Volume,AUTO scales,ALL bubble threshold. Quantity persists only by explicit “Remember working size” opt-in; otherwise reset to 10 USD on process launch. Never persist pending/error submission state or manual ladder center.
- Restoring a saved asset displays a non-trading placeholder until main resolves current metadata and fresh book. Not found/settled: keep a labeled unavailable card with Retry/Remove, do not replace it with random top-volume instruments. An intentionally empty workspace stays empty.
- Switching slots pauses old subscriptions (no background collection), retains their in-memory analysis up to ten minutes, and marks the inactive interval as a gap on return. Do not silently exceed the six active subscription limit. Focus alone keeps all six subscribed. Persist no analytical history across process restarts in this increment.
- Storage schema is versioned. Migrate existing IDs, slot names, layout, favorites and chrome widths once; hold all writes until hydration completes. Malformed storage falls back with a recoverable warning. Preserve old keys for rollback rather than destructive migration.

### 3.6 League tree, favorites and search

- Keep league/tournament → local-time event → market → outcome. Star always means favorite league series ID, including the panel star, with title “Favorite league: NBA.” No event/outcome stars introduced.
- Leagues/Favorites/Recent remain. Favorites tab restricts both tree and loaded-search results to favorite leagues; Recent searches recent identities only; Leagues searches all loaded instruments. Label search “Search loaded markets”; show searched loaded count and “Load a league to include its schedule.” No false global-search claim.
- Add one saved filter per slot: date=All/Today/Tomorrow/Next 7 days; marketType=All or observed exact types; favorite filter stays the existing tab. Date ranges use user's local calendar, including DST. Missing start times remain under “Time not published” when date=All and are excluded from date-specific results with a visible excluded count.
- No Live/In Play filter until an authoritative status field/feed has been verified. A scheduled time in the past does not prove live play. Preserve local gameStartTime, not market creation/startDate.
- League events load one page (100 events) at a time with cursor/offset and hasMore/completeness status. Show “100 loaded · more available,” Load more, retry and no-active-events separately. Use stable IDs to merge repeated pages; no silent 300-event cap. If provider cannot guarantee total, show loaded count, not a fabricated total.
- Tree render chunks: initially 20 events/league and 20 markets/event, with “Show 20 more” for already loaded items; fetching next page is a separate visible action. Search results show first 50 plus “Show more”; never silently truncate at 14/12/24. Expanding a matching search result opens its ancestor league/event and retains context.
- Favorite ordering: favorites first in Leagues, then existing major-league order, then alphabetic. No manual ordering or named working lists yet. Recent stores asset identities and resolves them like saved books; it is not limited to current cache. Clear Recent is local only.

### 3.7 Orders, connection and errors

- Rename unresolved ladder markers “Session submission” and render as hollow badges, with DRY/LIVE text, not authoritative working liquidity. No fill simulation, PnL update or account position is inferred from acceptance.
- Public Market Tape and personal account information remain separate tabs. Orders tab defaults to “Session submissions,” with status, mode, protection price and request ID. UNKNOWN_SUBMISSION is prominent and cannot be one-click retried.
- Show main-reported armed status on every account-status change, including failed location/cancellation calls. A stale UI cannot override main. Stale account snapshot shows age and refresh; public market data cannot populate personal fills.
- Optional reconciled “LIVE working” overlay is enabled only after complete authenticated pagination/lifecycle behavior passes Task 21; otherwise honest hollow session markers are the supported release behavior.

## 4. Data contracts and component boundaries

### 4.1 Model contracts (proposed; not code added yet)

Add src/domain/contracts.ts; keep existing account/order display types in src/types.ts and re-export narrowly as needed. DTOs crossing IPC remain JSON serializable (no Maps/BigInt); internal maps can use integer keys and fixed-point accumulators.

```ts
export type ReportedSide = "BUY" | "SELL" | "UNKNOWN";
export type IdentityQuality = "PROVIDER" | "AMBIGUOUS";
export interface Execution {
  assetId: string;
  localId: string;                 // unique ingest ID, not evidence of exchange uniqueness
  providerId?: string;             // only when provider guarantees per-execution identity
  transactionHash?: string;        // provenance, never sufficient identity by itself
  identityQuality: IdentityQuality;
  priceUnits: number;
  sizeDecimal: string;
  side: ReportedSide;
  eventTimeMs: number;
  receivedTimeMs: number;
  timeSource: "PROVIDER" | "RECEIVED";
  connectionEpoch: number;
}
export interface CoverageSpan {
  fromMs: number;
  toMs: number | null;
  state: "OBSERVED" | "GAP" | "OVERFLOW";
}
export interface OrderIntent {
  requestId: string;
  assetId: string;
  side: "BUY" | "SELL";
  price: string;                   // native price only
  size: string;
  sizeUnit: "USD" | "SHARES";
  execution: "GTC" | "FAK";
  mode: "DRY" | "LIVE";
  bookGeneration: number;
  tickVersion: number;
  armEpoch: number;
}
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  completeness: "MORE" | "EXHAUSTED" | "UNKNOWN";
}
```

Use fixed-point share accumulators at six decimals only after validating current feed precision. Reject/quarantine unsupported precision rather than silently truncate; mark coverage partial. Aggregate BUY/SELL/UNKNOWN separately and keep count. Fixed-point accumulators may use BigInt internally; convert to decimal strings for DTOs and formatted output. Do not use JS floating addition for financial validation.

Execution identity policy:
- Task 2 must validate actual documented per-execution IDs, side meaning, timestamp units and message granularity against sanitized recorded fixtures. No assumed transaction-hash uniqueness or assumed aggressor direction.
- If strong IDs exist, deduplicate per asset over the ten-minute retention horizon using them. Different executions in one transaction remain distinct.
- Without strong IDs, assign local receive sequence and retain separate messages. Mark identity AMBIGUOUS and affected aggregates APPROXIMATE. Do not silently drop identical timestamp/price/size messages: they may be legitimate distinct fills. Detect repeated fingerprints for diagnostics without claiming exact totals. Ambiguous reconnect overlap remains a visible quality limitation, not a solved dedup problem.
- Missing/malformed timestamp uses receipt time with APPROXIMATE flag; provider timestamps beyond receive time+2s are quarantined and flagged; <=2s future events are held until wall clock catches up. Invalid price/size never enters sums. Preserve diagnostic counts without raw secrets.

Analytical store: src/state/marketStore.ts owns per-asset book and execution aggregates, coverage, retained timed bubble candidates and raw tape. Single injectable clock, 250 ms scheduler only while relevant views exist; no per-row timers. Apply full aggregate updates per event; publish dirty snapshots no more than every 50 ms. Per-asset selectors prevent an unrelated asset from rerendering every ladder. Initial resource budget: 1,000 tape entries globally; 20,000 timed print records and 100,000 price-second cells per active asset. Prune by ten-minute horizon before budget checks. On reaching a budget, stop admitting analysis records for that asset until space is reclaimed, visibly mark OVERFLOW from first omitted event, and continue book processing independently. Never evict analytical totals silently to satisfy a tape cap. Benchmark the six-asset budget before release; retain visible overflow behavior if tuning bounds.

Data required from public feed: authoritative asset, current depth snapshot/deltas, tick version, BBO, connection epoch, provider/receive timestamps, execution size and optionally reported direction/strong execution ID. Absence of direction/ID lowers quality, not invented values. Snapshot recovery does not recover missed executions. Read-only snapshot refresh and asset resolution endpoints must be verified before IPC implementation.

Discovery required: stable series/event/condition/asset IDs, title/outcome, gameStartTime, sportsMarketType, current acceptingOrders/closed flags, tick and minimum size, page boundaries. Cached metadata is display-only until main refresh succeeds for live eligibility; refresh it before arming/submission if older than 60 seconds. Provider errors produce UNRESOLVED, not SETTLED.

### 4.2 Target files and responsibilities

Existing src/App.tsx stays root orchestration, not the home for new arithmetic or reducers. Extract incrementally; do not mix wholesale CSS cleanup into correctness commits.

| File | Responsibility |
| --- | --- |
| src/domain/contracts.ts | Execution/coverage/intent/settings/workspace DTOs |
| src/domain/decimal.ts | Strict decimal parsing/formatting and integer probability units |
| src/domain/priceGrid.ts | Native groups, row identities, bounded centering and compression |
| src/domain/executions.ts | Normalize/validate execution and identity provenance |
| src/domain/clusters.ts | Fixed second/period aggregation, coverage projection and late correction |
| src/domain/scales.ts | Deterministic depth/cluster/bubble normalization |
| src/state/marketStore.ts | Feed store and subscriptions independent of component mount |
| src/state/workspaceStore.ts | Versioned slot hydration/settings migration and write barrier |
| src/hooks/useMarketAsset.ts | useSyncExternalStore per-asset snapshots |
| src/hooks/useWorkspaceLayout.ts | Width/height/chrome measurements and scroll policy |
| src/components/BookPanel.tsx | Compose book header, position strip, toolbar and ladder |
| src/components/DomLadder.tsx | Stable native/group rows and captured interaction |
| src/components/ClusterColumns.tsx | Modes/fills/coverage/correction markers |
| src/components/ExecutedBubble.tsx | Bounded area/colors/details; no data ingestion |
| src/components/PanelSettings.tsx | Accessible settings and optional-column visibility |
| src/components/MarketNavigator.tsx | League tree, loaded search, filters and pagination |
| src/components/WorkspaceGrid.tsx | Equal grid/focus/drag and explicit overflow status |
| src/components/SessionOrders.tsx | Honest acknowledgment/unknown status presentation |
| electron/market-state.cjs | Authoritative book generation/freshness/tick/asset metadata registry |
| electron/discovery.cjs | Validated asset resolution, public snapshot and paginated league fetch |
| electron/order-policy.cjs | Strict main-process intent/price/size validation and idempotency |
| electron/trading-service.mjs | Injectable client/location/clock policy, arm epoch and lifecycle |
| electron/trading.mjs | Existing public exports and actual SDK adapter; preserve buildOrderRequest API |
| electron/main.cjs / preload.cjs | Bind policy to narrow validated IPC and account/feed events |
| src/demoBridge.ts | Same contracts; deterministic fixtures; LIVE throws, never DRY_ACCEPTED for LIVE |
| src/styles.css | Explicit column/row dimensions; replace conflicting affected overrides only |

Main/renderer decimal validation must not drift: build a shared runtime CommonJS decimal helper in shared/decimal.cjs, accompanied by shared/decimal.d.cts, and have src/domain/decimal.ts wrap it. Configure Vite's CommonJS handling for that exact shared file and test both environments; if bundling cannot support it cleanly, use a generated dual-format shared module with a build parity test rather than two independent handwritten validators. Do not import Electron into renderer code. This interop decision is resolved in Task 3 before price/order changes.

### 4.3 IPC additions/revisions

- resolveInstruments({assetIds}) -> one status per ID: RESOLVED/UNAVAILABLE/UNRESOLVED plus validated metadata. Max 30 IDs/request, deduplicated and bounded strings. Do not conflate network failure with absent asset.
- listLeagueMarketsPage({seriesId,cursor}) -> Page<event-with-markets>; page size fixed at 100 in main. Cursor opaque, generated/validated by main, never accepts arbitrary URL.
- refreshBook({assetId}) -> validated snapshot for an allowed active asset; rate limit once/asset/5s. Store in main before publish. Never generic arbitrary HTTP.
- submitOrder(OrderIntent) -> acknowledgment with request ID; main supplies market/outcome titles from its registry, not renderer draft text.
- onAccountStatus(status-with-armEpoch), onAssetHealth(asset,generation,tickVersion,freshness), onAnalysisGap(asset,interval/reason). Existing event subscriptions retain explicit cleanup.
- Existing auth/cancel-all remain narrow. No per-order cancel/replace IPC in base scope.
- Update TerminalBridge, preload and demo in the same contract commit. Validate sender and payload in main. Test obsolete payload rejection; do not accept legacy LIVE drafts without generation/epoch fields.

## 5. Ordered implementation tasks

Tasks below are delivery packets. Within each packet, perform each numbered test/edit/check action as a small step; do not attempt an entire phase in a single change. Every code packet follows RED → minimal GREEN → typecheck → relevant regression tests → review. Never stage unrelated existing .gitignore/README/package.json work. Suggested commits are for implementation only; this planning pass makes no commits.

### Task 1 — Establish isolated tests and baseline

Files: modify package.json, package-lock.json, vite.config.ts, scripts/qa-screenshot.cjs; create vitest.config.ts, tests/setup.ts, tests/fixtures/terminal.ts and tests/baseline.test.tsx.

1. Add the smallest fixture test for default DRY, six-book cap and explicit side/action mapping; run it and record missing-runner RED.
2. Add vitest/jsdom/@testing-library/react/@testing-library/user-event dev dependencies and scripts test:unit=`vitest run`, test:ui=`vitest run tests/ui`, qa:terminal=`electron scripts/qa-screenshot.cjs`. Keep test:orders unchanged initially.
3. Configure DOM only for *.test.tsx, node for pure models, and deterministic clock/storage reset. Stub secure-client/account mutations to throw.
4. Change QA userData/sessionData paths before app readiness to artifacts/qa/profile and output to artifacts/qa/screenshots. Never use /tmp or default Electron user profile. Use a stub bridge, no real preload trading.
5. Verify original behavior snapshots under fixtures; avoid making random demo depth a test oracle. Commit `test: establish isolated terminal regression harness`.

### Task 2 — Record feed/metadata capabilities before directional claims

Files: create docs/contracts/polymarket-feed.md, tests/fixtures/market-feed.json and tests/feed-contract.test.ts; modify src/types.ts only for validated DTO optionality.

1. Write RED fixtures for missing side, two executions sharing a hash, exact timestamp boundaries, same-time identical messages, tick changes and malformed metadata.
2. Compare current official API/SDK contracts and sanitized public samples; record timestamp units, execution granularity, direction meaning, identity guarantees, precision and supported resolution/snapshot pagination endpoints. No wallet samples.
3. Mark unresolved guarantees UNKNOWN; implement fallback-quality expectations, not speculative aggressor or uniqueness assertions. If endpoint/granularity cannot support a feature, use the explicit limited/disabled behavior in this plan.
4. GREEN contract tests; review the data contract before implementing accumulation. Commit `docs: define verified market feed capabilities`.

### Task 3 — Shared exact decimal and price groups

Files: create shared/decimal.cjs, shared/decimal.d.cts, src/domain/decimal.ts, src/domain/priceGrid.ts, tests/decimal.test.ts and tests/price-grid.test.ts; modify vite.config.ts for shared-module interop.

1. RED exact decimal/formatter tests for 0.01,0.001,0.0001; malformed/exponent/nonfinite/unsupported precision; share math and native tick alignment.
2. Implement strict probability integer conversion and fixed-point shares. Demonstrate identical helpers in renderer test build and Node require.
3. RED 1T/2T/5T tests: complete empty rows, group boundaries near 0/1, bid/ask same group, changes of native tick without corrupting historical absolute price.
4. Implement floor grouping, center clamps and row keys; no trading hookup yet. GREEN and typecheck. Commit `feat: add exact native price grid primitives`.

Example complete helper/test specification (the shared decimal parser handles string-to-units separately):

```ts
export function intervalStart(ms: number, periodMs: number): number {
  if (!Number.isSafeInteger(ms) || ms < 0 ||
      !Number.isSafeInteger(periodMs) || periodMs <= 0) {
    throw new RangeError("Invalid interval");
  }
  return Math.floor(ms / periodMs) * periodMs;
}
```

```ts
import { expect, it } from "vitest";
import { intervalStart } from "../src/domain/clusters";
it("puts an exact end timestamp into the next fixed bucket", () => {
  expect(intervalStart(14999, 15000)).toBe(0);
  expect(intervalStart(15000, 15000)).toBe(15000);
  expect(() => intervalStart(-1, 15000)).toThrow(RangeError);
});
```

Run that test RED before Task 5 exports the function. This example is a test oracle, not authorization to edit code now.

### Task 4 — Normalize executions without inventing side or identity

Files: create src/domain/contracts.ts, src/domain/executions.ts and tests/executions.test.ts; modify src/types.ts.

1. RED normalizer fixtures from Task 2, including missing size/side/timestamp, ambiguous hash and future time handling.
2. Implement strict normalization, receipt provenance, UNKNOWN side, strong-ID-only dedup, bounded quarantine and diagnostic quality. Assign ingest sequence per connection epoch; never use transaction_hash alone as ID.
3. GREEN asserts missing side produces zero known delta, distinct hash-sharing fills survive and unsupported precision does not enter totals. Commit `feat: normalize public executions with provenance`.

### Task 5 — Independent fixed-time analytical aggregation

Files: create src/domain/clusters.ts and tests/clusters.test.ts.

1. RED >40/>1,000 prints, exact boundary, three columns, late corrections, ten-minute retention, unknown side and period/compression switching tests.
2. Implement native absolute-price/second sums and selected-period projection, coverage spans and bounded resource handling. Inject clock; do not depend on Date.now inside memo functions.
3. RED idle rollover, future-event holding, partial first bucket, reconnect gap and overflow acceptance; implement minimal rules.
4. GREEN sums remain exact for all supported fixture precision; raw tape truncation never alters cluster totals. Commit `feat: aggregate fixed execution intervals with coverage`.

### Task 6 — External market store and health generations

Files: create src/state/marketStore.ts, src/hooks/useMarketAsset.ts, electron/market-state.cjs and tests/market-store.test.ts; modify electron/main.cjs and src/App.tsx feed lifecycle only.

1. RED disconnected snapshot invalidation, generation mismatch, tick transition, quiet stale interval, independent execution/book health and focus retention.
2. Extract book reducer and event store, single clock/publish scheduler and immutable per-asset snapshots. Main applies validated book deltas before sending health updates; cap active subscriptions to six total, not merely six per call.
3. Wire App to selectors without changing appearance. Focus has no subscription churn; switching slots stops old collection and records gap; teardown cancels timers/listeners.
4. GREEN performance fixture (six assets ×100 events/s for 60 simulated seconds) loses no aggregate sums; renders publish at <=20Hz; memory obeys budgets or exposes overflow. No release frame-time claim without hardware benchmark. Commit `refactor: isolate asset feed state from panel lifetime`.

### Task 7 — Injectable trading policy and arm epochs

Files: create electron/trading-service.mjs, tests/trading-safety.test.ts; modify electron/trading.mjs, electron/main.cjs.

1. RED tests with fake clock/client/fetch for fresh launch, connection disarmed, denied/unknown location, close-only unknown, cap rejection, failed cancel-all and disarm while geoblock await is pending.
2. Extract service factory without changing SDK adapter behavior or buildOrderRequest export. Add incrementing epoch on arm/disarm/disconnect; revalidate epoch and armed state immediately before invoking SDK after awaited checks.
3. Disarm before cancel-all network call; publish status in success AND failure paths. Renderer reload/socket disconnect invalidates session arm.
4. GREEN assert fake client place calls=0 for every rejected case and no SDK import/client creation on DRY path. Commit `fix: make session arming fail closed across async work`.

### Task 8 — Main-process order-intent validation/idempotency

Files: create electron/order-policy.cjs and tests/order-policy.test.ts; modify electron/main.cjs, electron/preload.cjs, src/types.ts, src/demoBridge.ts and scripts/trading-orders.test.mjs.

1. RED schema/sender spoofing/price tick/minimum size/unknown asset/stale snapshot/epoch/request replay tests. Include duplicate request ID with different body -> reject.
2. Add intent and health IPC contracts from section 4.3 atomically. Main derives display metadata and applies strict integer validation; enforce max request memory 5,000 entries/session and reject new submissions with clear error when full until restart, rather than evicting idempotency keys silently.
3. DRY bypasses secure SDK but not contract validation; above-live-cap is warning only. LIVE request cap remains existing server configuration and post-only/FAK mapping. Network uncertainty is UNKNOWN_SUBMISSION, no auto retries.
4. GREEN existing request-mapping tests plus new direct IPC tests demonstrate that bypassing renderer does not bypass safety. Demo rejects LIVE explicitly. Commit `feat: validate captured native order intents in main`.

### Task 9 — Controlled BookPanel extraction and safe gestures

Files: create src/components/BookPanel.tsx, src/components/DomLadder.tsx and tests/ui/dom-interaction.test.tsx; modify src/App.tsx and src/styles.css affected selectors.

1. RED 1T side mapping; 2T/5T first action submits zero; second explicit 1T action submits once; pointer-down then row shift/compression/mode change cancels.
2. Extract presentational panel/ladder, capture immutable intent context, pending guard, exact row price and zoom-only compressed behavior. A drag gesture never becomes a click; keyboard Enter/Space makes exactly one action, with repeated keydown ignored.
3. GREEN no requests from C/wheel/resize/drag/settings/navigation; captured DRY remains DRY if arm changes mid-gesture. Commit `feat: make ladder actions explicit and native-tick safe`.

### Task 10 — Stable centering and depth normalization

Files: create src/domain/scales.ts, tests/scales.test.ts and tests/ui/centering.test.tsx; modify src/components/DomLadder.tsx and BookPanel.tsx.

1. RED deadband, endpoint clamp, pointer freeze, manual pan and keyboard focus rules.
2. Implement section 3.1 centering; measure ladder viewport instead of hard-coded chrome subtraction.
3. RED near-BBO sample, offscreen outlier, immediate increase/two-second delayed decrease and fixed-scale tests; implement section 3.2.
4. GREEN with fake clock; depth auto changes never affect cluster scale. Commit `feat: stabilize ladder centering and depth scales`.

### Task 11 — Truthful timed bubbles and public tape

Files: create src/components/ExecutedBubble.tsx and tests/ui/executed-bubbles.test.tsx; modify BookPanel.tsx, src/App.tsx public tape and src/styles.css.

1. RED ten-second idle expiry, individual-print threshold, unequal mixed-side split, unknown portion and bounded diameter at all row sizes.
2. Implement section 3.3 from analytical/timed records, not book size or tape count; tooltip/details clarify relative scaling and print window.
3. GREEN tape cap of 1,000 leaves cluster totals unchanged; all public output labeled not personal. Commit `feat: render bounded executed-volume windows`.

### Task 12 — Cluster cells, fills and coverage UI

Files: create src/components/ClusterColumns.tsx and tests/ui/clusters.test.tsx; modify BookPanel.tsx and src/styles.css.

1. RED exact interval labels, closed/current markers, partial/gap/approximate states, unknown-side delta asterisk and correction badge (visible for two seconds per corrected bucket).
2. Implement section 3.4 modes/normalization/POC ties and accessible details. Shared and per-column maxima computed from retained rows including offscreen prices within those intervals; disclose that scale scope in settings.
3. GREEN changing bubble threshold/depth scale has no effect on cluster volume; colors never imply unknown direction. Commit `feat: show fixed clusters with independent intensity and coverage`.

### Task 13 — Versioned workspace persistence

Files: create src/state/workspaceStore.ts and tests/workspaces.test.ts; modify src/App.tsx and src/types.ts.

1. RED legacy migration, intentionally empty slot, malformed storage, hydration write barrier and focus/remount setting persistence.
2. Define schemaVersion=2 document with three slots, ordered assets (assetId plus display snapshot), per-book options, slot filter and chrome dimensions. Persist settings on change with 200 ms debounce; flush on explicit slot switch; storage errors warn without breaking feed.
3. Default working size reset unless opt-in; never serialize sensitive/transient state. Tests explicitly assert absence of armed/privateKey/order-intent values.
4. GREEN slot isolation and rollback keys preserved. Commit `feat: persist versioned workspace settings safely`.

### Task 14 — Safe asset resolution and public snapshot refresh

Files: create electron/discovery.cjs, tests/discovery.test.ts and tests/ui/restoration.test.tsx; modify main.cjs, preload.cjs, src/types.ts, demoBridge.ts and workspaceStore.ts.

1. RED saved asset absent from top discovery, provider timeout vs unavailable, stale resolution response after switching slots, and resolved-but-closed market.
2. Implement verified Task 2 endpoints behind bounded IPC, main metadata cache and public book refresh. Validate asset IDs and instrument consistency; no arbitrary URLs; timeouts 10s, per-asset refresh rate limit 5s.
3. Restore in saved order after ID resolution; placeholders stay until resolution; generation token discards stale results. Do not subscribe unresolved/settled identities or overwrite them in storage.
4. GREEN DRY view restored correctly, LIVE unavailable until current metadata/snapshot ready. Commit `feat: resolve saved outcomes independently of discovery cache`.

### Task 15 — Height-aware AUTO grid and settings access

Files: create src/hooks/useWorkspaceLayout.ts, src/components/WorkspaceGrid.tsx, src/components/PanelSettings.tsx and tests/ui/workspace-layout.test.tsx; modify src/App.tsx and styles.css.

1. RED layout-function tests for all viewport/book/row-height/dock combinations; explicit minimum width and height overflow, focus return and pointer-canceled-on-resize.
2. Implement section 3.5 dimensions, measured chrome, scroll indicator and preserved dock state; no auto text shrinking.
3. RED keyboard settings access at <430px; implement popover, all controls, optional column toggles and focus return.
4. GREEN screenshot matrix verifies prices/settings readable and no row/bubble overlap. Commit `feat: make adaptive workspace overflow explicit`.

### Task 16 — Paged league data without hidden limits

Files: modify electron/discovery.cjs, main.cjs, preload.cjs, src/types.ts and demoBridge.ts; create tests/league-pages.test.ts.

1. RED >300 events, repeated page, empty final page, opaque cursor validation, missing totals and page failure/retry.
2. Implement one page per requested cursor and explicit completeness, retaining event/market/outcome relations before flattening panel instruments.
3. Cache by series/cursor, one in-flight request/key; no eager endless fetch of every favorite. Abort or ignore stale searches/slot filters, never discard already loaded pages on error.
4. GREEN pagination reaches the 301st event; invalid cursors do not invoke arbitrary network. Commit `feat: expose bounded paginated league discovery`.

### Task 17 — Navigator extraction, saved filters and scoped search

Files: create src/components/MarketNavigator.tsx, tests/ui/navigation.test.tsx and tests/date-filters.test.ts; modify src/App.tsx and styles.css.

1. RED event 21/market 21/search result 51, ancestor expansion, favorite-only search, Recent unresolved identity and local DST day boundaries.
2. Extract tree; implement separate show-more vs fetch-more, explicit loaded search label/count, date/observed-type controls and series-ID favorites unchanged.
3. No LIVE filter; show missing-time excluded count and incomplete schedule counts. Persist slot filters via workspaceStore. Retry errors in-place with existing items intact.
4. GREEN starring a league never opens or trades an outcome; tab/search interactions never submit orders. Commit `feat: complete league discovery and filter workflows`.

### Task 18 — Honest session orders and cancellation status

Files: create src/components/SessionOrders.tsx and tests/ui/session-orders.test.tsx; modify App.tsx, BookPanel.tsx and styles.css.

1. RED accepted acknowledgment not displayed as confirmed working/fill; failed/partial cancel-all does not mark every row canceled; DRY unaffected by account cancellations.
2. Implement section 3.7 hollow badges/session labels/UNKNOWN_SUBMISSION, confirmed ID updates and separate Clear DRY action.
3. GREEN no acceptance mutates PnL/positions, public tape never labeled own fills, failed cancel-all leaves main disarmed with status reflected. Commit `fix: distinguish session acknowledgments from working orders`.

### Task 19 — Replay integration and screenshot acceptance

Files: extend tests/fixtures/terminal.ts, create tests/ui/terminal.integration.test.tsx; modify scripts/qa-screenshot.cjs.

1. Replay known fixtures: >40 prints/s, idle, boundary, tick change, unknown side, same hash/different fills, reconnect, data overflow and unresolved saved outcome.
2. QA at 980×680,1100×800,1440×960 ×1/2/4/6 books ×18/22/26px ×dock expanded/collapsed; navigator expanded/collapsed. Automate pairwise coverage for fast PR checks and full matrix for release. Record measured row/panel bounds and saved screenshots, not just element counts.
3. Assert LIVE methods called zero times, no secrets in artifacts, bubble bounds within own row, readable native prices, reachable settings, and explicit scroll where minima exceed viewport. Test capped/failed storage and late IPC responses.
4. GREEN tests/build with no network and reproducible clock; review screenshots manually because pixel artifacts alone do not establish usability. Commit `test: cover terminal replay and adaptive workspace acceptance`.

### Task 20 — Documentation and release gates

Files: update README.md, DESIGN.md and docs/research/terminal-gap-analysis/REPORT.md status appendix only; create docs/verification/terminal-acceptance.md.

1. Update actual semantics: 10s bubble aggregates, fixed clusters, approximate identity/direction, observed coverage, native-only trading, overflow, loaded search and session markers. Do not rewrite original research as if new behavior existed when researched.
2. Document schema migration, rollback, named commands, all acceptance results and unresolved provider limitations. Record exact environment/hardware for performance runs.
3. Require source review, safety regression review and visual review before enabling LIVE use of changed order-intent path. Automated acceptance remains DRY; no live test implied.
4. Commit only scoped documentation `docs: document terminal semantics and release evidence`.

### Task 21 — Separately gated optional authenticated working-order overlay

Do not include this in the base release unless specifically authorized. Files: create electron/account-orders.mjs and tests/account-orders.test.ts; extend trading-service, preload, types and SessionOrders only after SDK capabilities are proven.

1. Verify authenticated open-order pagination, order IDs, partial fills/cancels, event ordering, restart/reconnect and restrictions using mock contracts, not a funded account.
2. Snapshot all pages; layer validated user events or polling at 5s (only if permitted) with sequence/generation checks. Mark STALE after two failed polls or >15s without successful reconciliation. Include orders opened outside this app; never infer from public tape.
3. Show solid “LIVE working” badges only from a complete recent reconciled snapshot; keep session hollow markers distinct, suppress duplicate badges for matched IDs. Snapshot absence does not by itself prove filled vs canceled; show UNKNOWN/NO LONGER OPEN unless authoritative lifecycle states resolve it.
4. No new order placement, cancel/replace or auto retry is introduced by the overlay. Failure keeps the base honest-session UI functional. Separate spec/safety review and commit `feat: add reconciled read-only working-order overlay` only when authorized.

## 6. Verification commands and expected outcomes

Run commands from repository root. Do not run them in this planning pass. Dependencies must already be installed or be installed explicitly in Task 1 with workspace-local npm cache and no inspection of user configuration/secrets. Existing agent scripts reference home tooling and are not needed for acceptance.

- `npm run typecheck` -> exit 0, no TypeScript diagnostics.
- `npm run test:unit -- tests/decimal.test.ts tests/price-grid.test.ts` -> RED before Task 3, GREEN afterward; exact supported decimals and grouping.
- `npm run test:unit -- tests/executions.test.ts tests/clusters.test.ts tests/market-store.test.ts` -> GREEN exact fixture sums with documented quality flags, no idle/reconnect false completeness.
- `npm run test:unit -- tests/trading-safety.test.ts tests/order-policy.test.ts` -> GREEN, zero fake client order calls in all denied/DRY cases.
- `npm run test:ui` -> GREEN ladder, focus, settings, workspace restoration, discovery and session-order suites.
- `PM_TERMINAL_MAX_ORDER_USD=25 npm run test:orders` -> existing mapping/risk-cap checks plus extended native mapping cases GREEN; no secure client construction. This script uses Electron's Node runtime but must not create a profile.
- `npm run build` -> typecheck and Vite success, no renderer import of Electron/signing code. During authorized implementation build output remains under dist/ in workspace.
- `npm run qa:terminal` -> deterministic offline screenshots/bounds report under artifacts/qa/, DRY-only, LIVE/account-mutating bridge calls=0; userData and sessionData under workspace.

Read-only real-network `smoke:live` and `smoke:leagues` may be run separately with explicit approval if desired, but are NOT deterministic release gates and must never place orders. Do not run `npm start` or authenticated smoke tests as a substitute for a mocked safety suite.

Illustrative minimal UI safety test (Task 9 must export the indicated test driver from tests/fixtures/terminal.ts, with real DomLadder behind it):

```ts
import { expect, it, vi } from "vitest";
import { renderLadderDriver } from "./fixtures/terminal";
it("requires a new native-tick action after compressed zoom", async () => {
  const submit = vi.fn();
  const ui = renderLadderDriver({ compression: 5, mode: "DRY", submit });
  await ui.clickAskGroupContaining("0.50");
  expect(submit).not.toHaveBeenCalled();
  expect(ui.compression()).toBe(1);
  await ui.clickNativeAsk("0.50");
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0][0]).toMatchObject({
    mode: "DRY", execution: "FAK", side: "BUY", price: "0.50",
  });
});
```

## 7. Acceptance matrix and traceability

| Gate | Required observable result | Tasks | Research gaps |
| --- | --- | --- | --- |
| A1 Data | >1,000 prints in a fixed bucket preserve expected volume after tape truncation; unknowns/ambiguous identities visibly qualified | 2,4–6 | G1–G3 |
| A2 Time | Exact boundary goes next interval; clock rolls columns during idle; late correction marked; gap never becomes zero/completed history | 5,12 | G1–G3 |
| A3 Native action | 2T/5T first click only zooms; only 1T fresh intent may submit exact tick-bounded GTC/FAK | 3,8–9 | G4 |
| A4 Stable DOM | BBO jitter inside deadband doesn't move rows; pointer freeze; offscreen outlier doesn't flatten near-spread bars | 9–10 | G5 |
| A5 Executions | Timed bubbles expire, mixed/unknown direction explicit, no overlap at 18/22/26px; cluster intensity independent | 11–12 | G6–G7 |
| A6 Workspace | Six assets readable or explicitly scrollable at matrix sizes; settings all reachable; focus preserves subscription/settings | 6,13–15,19 | G8–G9 |
| A7 Discovery | Asset outside top cache restores; unresolved preserved; >300 events accessible; loaded-search scope/favorite/date filters honest | 14,16–17 | G9–G11 |
| A8 Account truth | Session acknowledgment never a fill/confirmed working order; cancel errors remain disarmed; partial cancellation no blanket success | 7,18 | G12 |
| A9 DRY | Launch/connect/reload restore never arm; DRY path cannot sign/place/cancel; direct IPC validation rejects unsafe LIVE; no auto retries | 1,7–9,19 | Safety |
| A10 Boundary | Main rejects malformed/spoofed/stale/old epoch/unsupported tick/over-cap intent; SDK called at most once/request ID | 7–8 | Safety |

## 8. Dependencies, review and rollback

Critical order: 1 → 2 → 3–5 → 6–8 → 9–12 → 13–18 → 19–20. Task 13 pure migration tests and Task 16 pagination fixtures can be prepared independently after contracts settle; integration remains sequential. Do not parallel-edit App.tsx/main.cjs while extracting their responsibilities.

Stop/go gates:
- After Task 2: provider uncertainties documented; weaker-quality fallback approved; no made-up aggressor delta/backfill.
- After Task 8: security/order-policy review before any live-capable UI wiring. A feature flag must not bypass main safety validations. If not approved, retain DRY-only operation for the new path.
- After Task 15: inspect actual screenshots and keyboard interactions; fitting panels is not sufficient.
- After Task 20: tests plus main-process safety and visual review. Task 21 remains separately optional.

Rollback keeps old storage keys and schemaVersion=2 under a separate key. Downgrade can restore old lists without interpreting new settings. Never roll back to an unsafe LIVE path as a fallback; if new safety validation fails, keep new trading disabled and preserve read-only/DRY diagnosis. Do not attempt to undo exchange orders via rollback or replay accepted requests.

Open external facts to resolve in Task 2: execution side meaning, strong IDs/granularity, precision and tick metadata, safe asset resolution/snapshot endpoints and page guarantees. These are validation gates, not permission to guess. No new research is required to choose DOM visuals; retain official screenshot references in the research folder while producing fresh local screenshots under isolated QA.

Implementation handoff: execute only after user authorization, one scoped packet at a time, with spec-compliance review followed by code-quality/safety review. Planning approval does not authorize real orders, credentials, deployment or Task 21.
