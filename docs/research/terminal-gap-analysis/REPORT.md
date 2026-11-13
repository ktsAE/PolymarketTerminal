# Professional terminal research and repository gap analysis

Research date: 2026-10-28. Scope: Tiger.Trade/Tiger.com Windows, MetaScalp, comparable order-flow terminals, and sports-exchange navigation. Repository: PolymarketTerminal, current working tree. Research only; no application code changed.

## Executive conclusion

This repository is not missing the six requested concepts. It already implements a continuous DOM, executed-volume bubbles, three cluster columns, automatic grid layout, league/event/market/outcome navigation, and persisted league favorites. The largest gaps are data correctness, temporal semantics, scaling stability, and workflow persistence—not adding more decorative columns.

Recommended order:

1. Make execution-derived displays trustworthy: explicit data coverage, robust trade identity, fixed cluster intervals, independent history aggregation, and reliable side semantics.
2. Make the ladder stable and safe: compression-to-order-price rules, centering deadband, near-spread volume normalization, and reconciled working-order markers.
3. Make six-book layouts usable rather than merely fitted: overflow policy, narrow-panel settings access, persistent panel settings, and optional proportional splitters.
4. Finish discovery: lazy-loaded asset restoration, full schedule access, explicit search scope, and saved league/date/live filters.

Retain the existing separation between resting liquidity, public executions, and personal account activity. Retain DRY-by-default and live-order guardrails.

## Method, confidence and limits

- Primary sources: official product manuals, feature pages, and release notes listed below. Other terminals were not authenticated or tested hands-on.
- Repository claims are based on source inspection, not just README/DESIGN descriptions. Line references refer to this working tree and may move later.
- Public screenshots were collected as linked/downloaded evidence. Visual-analysis tools failed in this environment; the downloaded images were NOT independently visually interpreted in this review. Dynamic behavior claims below come from documentation, not screenshots. MetaScalp screenshot download was blocked with HTTP 403; its official documentation page remains the preferred image source.
- No desktop/browser preview, build, live feed test, wallet connection, or order placement was run. The existing screenshot harness writes outside the allowed workspace and launches Electron with default profile storage, so it was inspected but not executed.
- DESIGN.md contains earlier visual-review and QA assertions. Those are existing project claims, not newly reproduced results.
- Exact proprietary algorithms, bubble radius functions, autoscale refresh cadence, and hidden execution internals are not public in the reviewed material. “Implementation” here means documented user-facing behavior, not access to vendor source code.
- Existing changes to .gitignore, README.md and package.json were present before this review and were left intact.

## 1. What the professional terminals actually do

### DOM: resting liquidity and a stable price ladder

Tiger combines clusters, executed-trade graph/tape, dynamic order book, information and trading controls in one DOM window. Cluster and graph areas can be hidden. Resting-volume fill is proportional to a configurable full-scale value. Price-step multipliers aggregate native ticks, and auto-scroll has a centering threshold. [T1–T4]

MetaScalp distinguishes summed resting limit orders at each price from its neighboring real-time trade tape. It exposes row height, price compression presets, linked compression changes, auto-scroll/centering, and manual versus automatic fill settings. Large-order highlighting considers a configured number of large orders and a strictness multiplier. [M1–M5]

Quantower explicitly separates current bids/asks, liquidity changes, cumulative resting size, and executed-trade-related DOM columns. ATAS Smart DOM similarly combines configurable depth, trade, profile and footprint columns. [Q4, A1]

Implication: a DOM should not collapse empty ticks merely because they contain no orders. Compression is a semantic grouping of price levels, not a CSS zoom. Resting-depth changes must never be treated as executions.

### Volume bubbles: executed trades, not depth

Tiger shows executions as circles with direction colors and separate filters for hiding small trades versus hiding only their numeric labels. Aggregating trades with matching microsecond timestamps and direction produces rectangles. Compact tape mode changes horizontal density. [T1, T2]

MetaScalp supports ordinary/smooth tape modes, configurable smooth-update speed, millisecond aggregation, round or square ticks, dots/lines/both, compact placement, large-trade emphasis/alerts, and filters in coins/lots or USD. [M3]

Bookmap explicitly calls its bubbles executed volume and distinguishes them from the resting-liquidity heatmap and current order book. Its public feature imagery is a useful visual reference for a price/time execution layer, but it does not publish a universal size formula. [B1]

Implication: choose and label whether a bubble means one trade, a timed burst, or an aggregate at a price. Those are materially different signals. No reviewed source proves that the repository should copy a particular bubble diameter, fade duration or collision algorithm.

### Clusters: executions aggregated by price and interval

Tiger supports Volume, Delta and Bid/Ask presentations, configurable full-fill thresholds, maximum-volume highlighting, and grouping by time, volume, delta, trade count or range. Cluster width can be changed manually, historical clusters browsed, and live position restored. [T3]

MetaScalp offers Sum, Delta and Buy×Sell, custom timeframes such as 1 or 7 seconds, optional history loading, minimum-volume filters and manual/automatic fill. In Delta mode the fill uses absolute delta; Sum and Buy×Sell fill use total volume. [M4]

ATAS places a mini-footprint directly in the DOM. Quantower offers footprint/cluster presentations with bid/ask imbalance views and tick aggregation. [A1, Q3]

Implication: cluster totals need interval integrity and retained history; changing the number of prints arriving must not silently erase a completed interval. Depth normalization and cluster normalization are separate controls.

### “Automatic resizing” is several different features

| Mechanism | Public evidence | Do not confuse it with |
| --- | --- | --- |
| Volume normalization | Tiger 7.1 one-click setup can reconfigure full-scale volume/filters on instrument, price-scale or filter-currency changes; 7.2 adds near-spread search depth. MetaScalp offers automatic fill. [T5, T6, M2, M4] | Changing panel dimensions |
| Price compression | Tiger tick multipliers; MetaScalp compression presets and auto-compression on reopening/restarting the DOM. [T4, M5] | Continuously resizing every pane on every trade |
| Centering | Tiger threshold; MetaScalp auto-scroll. [T2, M2] | Price aggregation or layout reflow |
| Shared panel resizing | Quantower Binds resize children proportionally, with movable internal dividers and coordinated aligned separators. [Q1] | Proof that Tiger/MetaScalp autonomously reflow every window |
| Workspace persistence | ATAS saves workspace/layer organization and adjustable positions/proportions. [A3] | A documented mobile-style responsive layout |

No reviewed source establishes autonomous cluster-column width changes driven by incoming volume. Tiger/MetaScalp auto-fill formulas, damping, sampling windows and exact update cadence remain unknown.

### League navigation and favorites need domain-appropriate references

Tiger/MetaScalp financial instrument workspaces are relevant to ladder workflows, but they do not establish a sports-league taxonomy.

Bet Angel provides an expandable event/market tree, hierarchy-wide search, saved market filters, and an explicit “Soccer - English Premier - Popular Markets” example. Guardian Watch Lists offer up to five lists, optional synchronization, pinning, and switching into trading views. [S1–S3]

Geeks Toy documents sport/event-type quick picks, nested tree expansion/collapse, day and market-type filters, In Play/On Now, and opening a leaf in grid or ladder mode. Its text does not prove a mandatory league level. [S4]

ATAS watchlists offer configurable instrument lists, sorting, drag-to-chart/DOM and instrument linking. Quantower supports saved favorite lists; selecting a saved list appends it to the existing watchlist, an interaction detail not necessarily appropriate for this product. [A2, Q2]

Implication: preserve the repository’s league → scheduled event → market → outcome hierarchy. A league favorite is a durable discovery preference; an outcome watchlist and a workspace of open books are different objects and should not silently replace one another.

## 2. Current repository: verified baseline

| Area | Implemented evidence | Assessment |
| --- | --- | --- |
| DOM | src/App.tsx:295–327 groups native ticks into continuous probability rows; 400–459 renders separate own-order, bid, price, ask and action lanes. | Substantial baseline, not missing. |
| Depth | src/App.tsx:363–369 calculates automatic/manual scale and full-book imbalance; 404–405 uses proportional fill. | Correct separation from prints; simplistic automatic scaling. |
| Centering/density | src/App.tsx:273–293 has 18/22/26 px rows and ResizeObserver-driven visible row count; 297–305 derives live center. | Responsive density exists; centering stability needs work. |
| Bubbles | src/App.tsx:99–114 accepts last_trade_price; 328–340 aggregates retained prints per displayed price; 407–410 maps size to diameter; 461–467 renders bubbles. | A recent-price aggregate, not a chronological tape. |
| Clusters | src/App.tsx:341–358 produces three 5/15/60-second windows; 373–377 supports Volume/Delta/Bid×Ask; 417–423 renders cells. | Modes exist, but interval/history semantics are weak. |
| Auto layout | src/App.tsx:1000–1005 measures workspace width; 1123–1134 derives 1–3 columns and rows; 1536–1540 sizes equal cells. | Automatic equal-grid reflow already exists. |
| Workspace controls | src/App.tsx:1052–1067 persists books/layout/chrome dimensions; 1189–1224 switches slots and resizes navigator/dock. | Useful MVP; incomplete per-book persistence. |
| League navigation | electron/main.cjs:158–189 normalizes sports/series IDs; 210–240 produces event/market/outcome assets and gameStartTime; 287–301 fetches league events. src/App.tsx:1411–1490 renders hierarchy. | Domain-correct foundation. |
| Favorites | src/App.tsx:1074–1076 persists series IDs; 1088–1107 filters/sorts favorites; 1440–1447 toggles the league star. | Already league-level, not merely outcome-level. |
| Safety/semantics | Public tape is separate from Orders; DOM actions distinguish resting GTC and protected taking FAK. README.md documents DRY/live arming and cap. | Preserve; not a justification for replacing guardrails with vendor defaults. |

## 3. Prioritized gap analysis

P0 = correctness/safety before treating the display as a professional execution tool. P1 = important workflow/readability maturity. P2 = optional parity/polish. Effort is relative, not a calendar estimate.

### G1 — P0: execution history is capped by trade count, not analytical coverage

Evidence: src/App.tsx:104–106 truncates recentTrades to 40. Bubbles, cluster totals and rolling volume all derive from that array (328–370). Public tape also depends on these retained arrays (1135–1138).

Consequence: on a busy market, even a 5-second bucket can lose earlier trades. Three 60-second columns cannot promise 180 seconds of history. On a quiet market, bubbles can represent arbitrarily old prints. “Rolling volume” means retained-print volume, not a fixed-time measure.

Recommendation: separate incremental price/time cluster aggregation from the visible tape ring buffer. Declare retention, subscription-start coverage and reconnect gaps. Add a distinct timed window for recent bubbles. Offer history loading only where the available API can support it; do not imply a complete exchange footprint from a partial live subscription.

Acceptance: ingest more than 40 trades in one interval and preserve exact cluster sums; idle expiration advances without another trade; reconnect visibly marks incomplete coverage. Effort: M–L. References: [T3, M4, B1].

### G2 — P0: cluster columns are sliding windows, not fixed historical buckets

Evidence: src/App.tsx:343 anchors to max(Date.now(), latest trade timestamp); 345–350 derives three windows from that anchor. The memo depends on prints, period and step, not a wall clock.

Consequence: historical membership shifts as new trades arrive. During inactivity columns do not advance on their own. A trade exactly equal to the selected end timestamp is excluded by timestamp >= end. The UI does not represent stable completed intervals in the footprint sense.

Recommendation: align buckets to integer event-time boundaries, keep completed bucket IDs, tick the visible clock independently, and define late/out-of-order handling. If sliding windows are intended, explicitly label them as rolling windows rather than historical clusters.

Acceptance: test exact boundary timestamps, three completed intervals, idle rollover, future timestamps and out-of-order arrival; completed totals stay stable except for a documented late-trade correction. Effort: M. References: [T3, M4, Q3].

### G3 — P0: execution identity and direction need an explicit data contract

Evidence: src/App.tsx:101–106 defaults missing size to zero and missing side to BUY; transaction_hash alone is preferred as ID, otherwise timestamp/price/size/side. src/types.ts:39–45 has no unknown side, coverage or provenance fields.

Risks to validate: missing direction becomes positive delta; multiple distinct fills sharing one transaction hash can be collapsed; identical same-millisecond trades can collide in the fallback ID. Conversely, once an ID ages out of the 40-print buffer, an old replay is no longer deduplicated. These are source-level risks, not observed production incidents.

Recommendation: validate actual feed side semantics before calling the view aggressor delta or Bid×Ask. Preserve unknown side separately, use a provider-backed execution identity where available, and explicitly define replay/deduplication behavior. Do not derive executions from order-book changes.

Acceptance: fixture tests for missing side, duplicate replay, separate fills in one transaction, same-time identical trades, and reconnect overlap. Effort: M. References: [M4, Q4, P1]. The precise guarantees of the current Polymarket feed require a separate API/fixture validation.

### G4 — P0: compressed depth and clicked order price need a deliberate policy

Evidence: src/App.tsx:305 rounds both bid and ask prices to the nearest displayed step; 308–318 sums those buckets; 406 and 438/448 submit the displayed bucket price as the FAK limit.

Consequence: grouping can place native bid and ask levels into the same visual bucket. A nearest-rounded representative price is not necessarily the actual best price or the worst executable price of all liquidity shown in that bucket. Displayed size therefore cannot be assumed fully executable at the clicked number.

Recommendation: specify integer-tick bucket boundaries and per-side representative/execution limits. Keep displayed aggregation separate from order-price selection. Expose bucket range and effective protection price before live use.

Acceptance: 2T/5T tests near the spread and probability bounds; every submitted order price respects native ticks and the explicitly chosen protection policy. Effort: M. References: [T4, M5]; order-price policy is a product recommendation, not a documented vendor algorithm.

### G5 — P1: live centering and automatic depth scaling can jump

Evidence: src/App.tsx:297–305 follows current BBO midpoint whenever autoCenter is true; 363 uses the maximum of all grouped bids/asks, including offscreen levels, as AUTO depth scale.

Consequence: quote moves can move rows under the pointer; an offscreen outlier can flatten visible bars. There is no near-spread sampling depth, temporal smoothing, or configurable centering deadband here.

Recommendation: adopt a threshold/deadband and consider pointer-interaction freeze; normalize using configurable near-spread depth with a stable scale policy. Retain fixed scale overrides. Exact quantile/damping formula should be an explicit product choice, not attributed to Tiger.

Acceptance: BBO oscillation within deadband leaves rows fixed; far-away outliers do not destroy near-market contrast; panning stays manual until explicit recenter. Effort: M. References: [T2, T5, T6, M2].

### G6 — P1: bubble identity, age, colors and size mapping are ambiguous

Evidence: src/App.tsx:328–340 combines all retained qualifying prints at each price with no time expiration. 409 computes diameter = 17 + 23 × sqrt(volume / maximum); 410 marks mixed only when buy equals sell. CSS allows visible overflow and bubbles up to 43 px (src/styles.css:440–444), while rows can be 18 px.

Consequence: bubbles are price-level aggregates, not individual prints or millisecond bursts. Mixed activity is colored as the majority direction unless exactly tied. Large bubbles can overlap adjacent rows; severity requires visual testing. The diameter offset means area is not strictly proportional to volume. DESIGN.md:44's claims about mixed color and “square-root area scaling” are imprecise relative to this implementation.

Recommendation: name the current aggregate honestly; define age/window, volume units, filter-before/after aggregation policy and stable normalization. Use split/dual-side encoding whenever both sides are present if that is the intended meaning. Provide compact-size/label controls and an explicit overlap policy.

Acceptance: documented behavior for mixed unequal volumes, quiet markets, one outlier, threshold aggregation and minimum row height. Effort: M. References: [T2, M3, B1].

### G7 — P1: cluster numbers lack magnitude visualization and separate scaling

Evidence: src/App.tsx:417–423 supplies only sign-based classes; src/styles.css:530–544 uses fixed backgrounds. There is no volume-proportional cluster fill, maximum/POC marker or independent cluster normalization.

Consequence: a tiny positive delta and a very large positive delta can have the same background. The depth-scale setting does not solve cluster readability.

Recommendation: independent total-volume/absolute-delta fill, explicit per-column versus shared normalization, maximum-volume marker and minimum-label filter. Keep the three modes but verify ordering: the current BIDASK text is buy×sell, not self-evidently bid×ask under every side convention.

Acceptance: known fixtures yield proportionate fill; zero delta with large two-way volume remains interpretable; scaling is independent of resting-book depth. Effort: M. References: [T3, M4, A1].

### G8 — P1: equal-grid auto-fit is not a complete workspace system

Evidence: src/App.tsx:1127–1134 uses width-based column count; 1539–1540 imposes 340 px minimum width and 220 px minimum height. Panel ResizeObserver computes 3–49 rows using a hard-coded 190 px overhead. src/styles.css:447–454 and 636–639 hide settings at narrow widths; cluster text is 6 px (538).

Consequence: six books can exceed available height when the bottom dock is expanded. Making panel rectangles fit does not establish readable cluster text or accessible settings. Narrow panels lose direct access to some settings. No proportional book splitters or independent cluster/tape width controls are present.

Recommendation: define minimum useful book height/row count and an explicit overflow/focus/paging policy. Provide an overflow settings menu before hiding controls; prioritize optional columns over shrinking data text. Add persisted proportional splitters only if the workflow needs them—free-form docking is not required for initial correctness.

Acceptance: 1–6 books at 980×680, 1100×800 and 1440×960 with navigator expanded/collapsed and dock collapsed/expanded; include 18/22/26 px rows and all settings keyboard-accessible. Effort: M–L. References: [Q1, A3]. Existing QA assertions are not a substitute for this matrix.

### G9 — P1: persistence saves asset IDs, but restoration depends on discovery cache

Evidence: startup src/App.tsx:1018–1024 restores only IDs found in the initial items list; favorite league loading occurs later (1042–1049). Workspace switching similarly resolves IDs only from currently loaded instruments (1191–1199). Recents use the same loaded-instrument lookup (1109–1111). Panel options at 270–281 are local state rather than persisted configuration.

Consequence: a valid outcome discovered through a league can disappear on restart if absent from the initial top-volume discovery set. Changing workspace rebuilds books and loses their recent execution history. Per-book row height, compression, filters, periods and scale reset after unmount/remount, including focus/workspace transitions.

Recommendation: persist a versioned workspace model with asset metadata or an asset-ID resolver, resolve saved IDs before replacing the workspace, and distinguish expired assets from unresolved assets. Persist per-book settings separately from transient feed state. Decide explicitly whether background workspace history continues or displays a coverage gap.

Acceptance: reopen a saved asset outside the initial discovery pages; favorite leagues load late without deleting saved books; switching/focusing preserves settings; invalid/settled outcomes get a visible status. Effort: M. References: [A3, Q1, A2].

### G10 — P1: discovery is coherent but silently bounded

Evidence: src/App.tsx:1114–1121 searches only loaded instruments and caps results at 24. League tree caps at 100 leagues (1106), 14 shown events (1422), and 12 markets per event (1470), without a visible load-more control in that render path. electron/main.cjs:11–12 and 272–301 bound initial discovery to five 100-event pages and league discovery to three pages. Start-time cutoff is not an authoritative in-play feed.

Consequence: “global search” means global over the loaded cache, not all active markets. Markets beyond tree limits may be loaded but inaccessible through the tree. “Upcoming events” counts are based on grouped loaded data, not necessarily complete schedules.

Recommendation: label cache-only scope or implement remote/paginated search; add load-more/count coverage and date/market-type filters. Add live status only from an appropriate authoritative field/feed, not by assuming start time implies in-play. Ensure Favorites filtering and free-text result scope are explicitly defined.

Acceptance: the 15th event and 13th market are discoverable; search finds an unloaded league event or clearly declares that limitation; saved league/date filters restore. Effort: M. References: [S1, S2, S4].

### G11 — P1: favorites are good; named working lists are a separate extension

Evidence: persisted seriesId favorites and favorite-first ordering already exist (1074–1107); Recent is distinct from Favorites. There is no named multi-list watchlist, user ordering of leagues, or saved filter definition in the inspected UI.

Recommendation: retain league stars as the primary sports discovery primitive. Optionally add named outcome working lists and saved league/date/market-type filters without changing what the existing star means. Clarify the book-header star as a league favorite; its accessibility label does so already.

Acceptance: starring NBA retains the league schedule across reloads; new named lists do not silently open every market, overwrite favorites, or replace the active workspace. Effort: S–M. References: [A2, Q2, S2, S3]. Do not copy Quantower's append-list interaction without an explicit product decision.

### G12 — P0 for live-trading trust: working-order markers are session acknowledgments

Evidence: src/App.tsx:359–362 selects session GTC results whose status includes ACCEPTED. Row markers count those results (412–432, 459). TerminalBridge (src/types.ts:153–167) exposes submission and cancel-all, but no per-order cancel/replace or user-order event subscription.

Consequence: accepted-session markers are not a reconciled current-order view and may outlive fills/cancellation. A professional ladder must not imply these are authoritative working orders. This is adjacent to the requested DOM comparison, not a request to implement trading changes now.

Recommendation: reconcile lifecycle from authenticated order/fill data and offer per-order controls only with tested safety behavior. Until then label markers as session submissions, separate DRY and LIVE, and avoid overstating “working.”

Acceptance: partial fill, complete fill, reject, cancel-all and reconnect update markers consistently with actual order state. Effort: L. Reference: professional DOM own-order workflow [T1, Q4]; specific authenticated integration remains to be designed.

## 4. Suggested delivery sequence — not implementation authorization

1. Data model/fixtures: G1–G4, plus reconciliation design for G12. Decide side, identity, time, coverage and native-tick invariants first.
2. Rendering behavior: G5–G7. Write down what every bar, cell, bubble and color means; use replay fixtures rather than live activity for acceptance.
3. Workspace reliability: G8–G9. Preserve the current equal-grid default; add usability and restoration guarantees before arbitrary docking.
4. Discovery workflow: G10–G11. Keep league favorites; complete pagination/search/filter semantics.
5. Optional parity: custom cluster periods, history browsing, linked instrument groups, alerts, per-column widths and named working lists. These are P2 unless user workflows demonstrate otherwise.

Avoid bundling all of this into a visual rewrite. The existing ladder hierarchy and data-layer separation are worth retaining.

## 5. Public screenshot evidence index

Images belong to their respective vendors; copies here are research references, not redistributable application assets. Screenshots establish visual examples, not dynamic behavior. Image interpretation was unavailable in this session, as noted above.

| File / link | Official source and intended comparison |
| --- | --- |
| Tiger DOM (third-party screenshot, not redistributed) | [T1]. Downloaded official DOM image; reference for combined DOM composition. Original: https://s3-eu-central-1.amazonaws.com/euc-cdn.freshdesk.com/data/helpdesk/attachments/production/80035074291/original/VJAeZcubp3WokNerBKLbVB7cstMziZRbjA.png?1630933767 |
| [Bookmap bubbles](bookmap-bubbles.webp) | [B1]. Downloaded official feature image. Original: https://bookmap.com/static/features/v2/s3/1.webp |
| Bet Angel league filter (third-party screenshot, not redistributed) | [S2]. Downloaded official filter example. Original: https://www.betangel.com/user-guide/drex_filtering_markets_custom_2.png |
| [MetaScalp DOM page](https://metascalp.gitbook.io/metascalp/stakan) | [M1]. Embedded complete DOM, trade tape and cluster screenshots; local image retrieval blocked. Use the page rather than relying on expiring image tokens. |
| [Quantower resizing animation](https://help.quantower.com/quantower/general-settings/binds) | [Q1]. Embedded animation documents bind resizing and divider interaction; not locally archived. |
| [ATAS Smart DOM image](https://atas.net/wp-content/uploads/2026/06/smart-dom-depth-of-market-analysis-atas.webp) | [A1]. Official mini-footprint/DOM reference; URL checked by research subagent, not locally archived. |
| [Geeks Toy expanded tree](https://www.geekstoy.co.uk/UserManuals/EN/Market%20Navigator%203.PNG) | [S4]. Official hierarchy reference; not locally archived. |

public-image-sources.json preserves discovered image URLs and retrieval attempts. It is a raw discovery record, not proof that every listed image was saved; the MetaScalp candidate selection initially found branding and the final DOM download was blocked.

## 6. Primary source bibliography

Tiger.Trade / Tiger.com Windows:
- T1: https://support.tiger.com/english/windows/dom
- T2: https://support.tiger.com/english/windows/dom/dom-settings/main
- T3: https://support.tiger.com/english/windows/dom/dom-settings/cluster
- T4: https://support.tiger.com/english/windows/dom/how-to-adjust-dom-scale
- T5: https://support.tiger.com/english/platform-updates/version-7.1
- T6: https://support.tiger.com/english/platform-updates/version-7.2

MetaScalp (Russian manual; behaviors summarized in English):
- M1: https://metascalp.gitbook.io/metascalp/stakan
- M2: https://metascalp.gitbook.io/metascalp/stakan/setting/stakan
- M3: https://metascalp.gitbook.io/metascalp/stakan/setting/ticks
- M4: https://metascalp.gitbook.io/metascalp/stakan/setting/clusters
- M5: https://metascalp.gitbook.io/metascalp/stakan/control
- M6: https://metascalp.gitbook.io/metascalp/stakan/setting/general

Comparable order-flow/workspace tools:
- B1: https://bookmap.com/en/features
- A1: https://atas.net/modules/smart-dom/
- A2: https://atas.net/modules/watchlist/
- A3: https://atas.net/modules/workspaces/
- Q1: https://help.quantower.com/quantower/general-settings/binds
- Q2: https://help.quantower.com/quantower/analytics-panels/watchlist
- Q3: https://help.quantower.com/quantower/analytics-panels/chart/volume-analysis-tools/cluster-chart
- Q4: https://help.quantower.com/quantower/trading-panels/dom-trader/dom-trader-columns

Sports navigation:
- S1: https://www.betangel.com/user-guide/searching_markets.html
- S2: https://www.betangel.com/user-guide/filtering_markets.html
- S3: https://www.betangel.com/user-guide/guardian___watch_lists.html
- S4: https://www.geekstoy.co.uk/UserManuals/EN/Market%20Navigator.html

Platform data reference / follow-up verification:
- P1: https://docs.polymarket.com/api-reference/wss/market (also referenced by README.md; current feed completeness/identity/side guarantees were not independently established in this review).

Rung ladder/grid URLs already present in DESIGN.md were investigated, but follow-up retrieval returned HTTP 403. This review does not promote that pre-existing document's Rung assertions to newly verified evidence. Trading Technologies sources were also blocked; no unsupported TT claims are included.
