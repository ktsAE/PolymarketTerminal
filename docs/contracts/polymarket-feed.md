# Market-data adapter and external store contract

This is a local adapter/domain contract, NOT a claim of verified exchange guarantees.
Public documentation entry point: https://docs.polymarket.com/ . No authenticated
feed, wallet, orders, or live trading is involved in this data layer.

## Provider evidence and unresolved semantics

Public market messages are not assumed to provide execution-unique IDs, replay,
complete sequencing, corrections, or verified aggressor direction. Those guarantees
remain UNKNOWN. A transaction hash is provenance, not execution identity: one
transaction may contain several fills. Identical payloads are separate observations.
A reported BUY/SELL is preserved as Reported BUY/SELL, not labeled aggressor flow.
Missing or unrecognized side is UNKNOWN. Never infer BUY from missing side.

## Exact decimals and grids

`shared/decimal.cjs`, its `decimal.d.cts` declarations and the
`src/domain/decimal.ts` facade expose `parseUnits`, `parseShares`, `formatUnits`,
`formatShares`, `SCALE = 1000000`, `SHARE_SCALE = 1000000n`.
Probability micro-units are integer numbers in inclusive 0..1000000. Share amounts
and sums are BigInt microshares. Inputs are unsigned plain decimal strings with
an integer component, no leading zeroes except zero, at most six fractional digits,
and at most 1024 characters. Whitespace, signs, exponent notation, float inputs,
trailing decimal points and excess precision are rejected, never rounded.
Serialize BigInt explicitly rather than converting it to Number.

`price-grid.ts` exports `bucketPrice`, `gridStep`, `createPriceGrid`, `groupPrices`,
`assertPriceUnits`, and `Compression = 1 | 2 | 5`. Anchor is
`floor(priceUnits / (tickUnits * compression)) * step`, absolute zero-origin.
Tick is any positive integer <=1000000; no unsupported minimum clamp or assumption
that tick divides 1000000. `createPriceGrid` includes empty anchors, is ascending
unless descending is requested, and throws beyond maxRows (default 10001).
`groupPrices` produces occupied rows with exact sums.

## Execution normalization

`normalizeExecution(input, receiptMs)` accepts marketId, assetId, decimal price/size,
optional timestampMs (epoch milliseconds), providerId, transactionHash, side,
sideVerified, deprecated aggressorVerified, and revision. Result is
`{status: 'accepted'|'held'|'quarantined'|'invalid', execution?, reason?}`.

Absent OR malformed provider time falls back to receipt time with
`timeSource: 'receipt'`; receipt time itself must be a nonnegative safe integer.
Future offset (0,2000] ms is held; >2000 ms is quarantined. Bad decimal/zero size,
invalid receipt or revision is invalid. Reported BUY/SELL is retained without
requiring either verification flag; those flags do not change semantics.
Only an independently verified execution-unique providerId enables STRONG identity.
MarketStore never supplies it. Revision defaults to 0, must be a nonnegative safe
integer; strong-ID corrections alone can be reconciled safely.

`qualifyingPrints(executions, nowMs, minimumShares)` returns individual prints with
size >= threshold in `[floor(nowMs/1000)*1000 - 9000, nowMs]` (ten epoch-second
buckets including the partial current second). It is not `(now-10000, now]`.
No aggregation, synthetic identity, future prints, or implicit clock is introduced.

## Fixed one-second aggregates

`ClusterStore({startedAtMs?, maxExecutions?, maxCells?, maxGaps?})` exports:

- `ingest(execution, nowMs = execution.receiptMs)` -> inserted, corrected,
  duplicate, stale, expired, held, quarantined, or overflow.
- `project({nowMs, intervalSeconds: 5|15|60, tickUnits, compression?, marketId?,
  assetId?})` -> exactly three epoch-aligned buckets, OLDEST FIRST.
- `markGap(startMs,endMs)`, `prune(nowMs)`, `size` (timed records), `cellCount`.
- `intervalStart(nowMs, intervalSeconds)` is a named module export.

Native absolute prices, BigInt buy/sell/unknown/total sums and counts are indexed
by market, asset, epoch second and price. Aggregates retain ten minutes at exact
one-second granularity, inclusive cutoff second. Tick/compression only regroup at
projection time; historical amounts are not rewritten on tick changes. Raw timed
records are separate: ambiguous records retain the ten-second print window;
strong records retain ten minutes for correction/dedup. Pruning uses a monotonic
watermark; the clock should advance normally, not request historical as-of queries.

Default ceilings are 100000 price-second cells and 20000 timed records. At a ceiling,
new admissions return explicit overflow, mark the rejected second as GAP/partial,
and DO NOT evict accepted aggregates. Timed record expiration does not erase sums.
MarketStore enforces these budgets across its assets, not per panel. Gap intervals
merge overlaps; a maximum 1024 is enforced by conservative oldest coalescing.

Strong IDs are scoped by market and asset. Equal revision is duplicate, lower stale,
higher replaces all old contributions. Native source and destination cells retain
`correctedUntil = receipt/current time + 2000` for a correction badge. A print arriving
after its epoch second also sets this timestamp. No cancellation protocol is assumed.

Each bucket has startMs/endMs, ascending occupied rows, optional correctedUntil,
and quality {partial, gap, approximate, unavailable}. Intervals are [start,end).
partial means missing coverage before observation/retention or a known gap; the
current bucket is evaluated only through NOW, not through its future end, so it
is not automatically partial. unavailable means wholly before coverage start.
approximate means ambiguous identity or receipt-time fallback, not float math.
UNKNOWN contributes to volume, never to reported buy-minus-sell delta.

## External MarketStore and hook

`src/state/marketStore.ts` exports `class MarketStore(clock?:()=>number)` and lazy
singleton `marketStore` (no timers until active assets or subscribers exist).

- `setActive(instruments: Instrument[])`: call BEFORE subscribing the bridge to
  asset IDs. Same active set/focus does not reset history or readiness. Removed
  assets pause, retain history ten minutes, and record a gap on resume.
- `ingest(event: MarketEvent)`: handles book snapshots, absolute-size deltas,
  best_bid_ask, tick_size_change, and last_trade_price. Snapshot restores ready;
  delta/BBO/trade alone never does. Provider timestamps are millisecond strings.
- `setConnection(status: ConnectionStatus)`: non-live transitions invalidate ready,
  advance generation, and record gaps until each asset receives a fresh snapshot.
- `getSnapshot(): ReadonlyMap<string,BookState>`: stable reference until publish;
  contains active assets only. Treat maps/books as immutable. Old published books
  are never mutated. Book metadata includes generation, tickVersion, bookReceivedAt.
- `getBook(assetId): BookState|undefined`: latest synchronous internal book.
- `subscribe(listener): ()=>void`: external store notifications, capped to 20 Hz.
  A first/batched event publication may flush in a microtask; later updates wait
  for the remaining 50 ms budget. One 250 ms idle timer rolls epochs, prunes
  history and releases held prints; an optional timeout handles publication only.
- `getAnalysis(assetId)`: `{clusters, executions, observedSince, gaps, quality,
  nowMs}`. Executions are all individual prints in the ten-second window, NOT
  derived from recentTrades. Unknown assets have UNAVAILABLE analysis; paused
  assets retain analysis with PARTIAL GAP quality.
  Cluster quality is per interval; overall quality is conservative APPROXIMATE or
  PARTIAL GAP. UI should project clusters using the returned nowMs.
- `dispose()`: clears timers, subscriptions, queues and retained assets.

The raw recentTrades tape is capped at 1000 total across the store, with global
monotonic observation IDs unrelated to transaction hash. Analysis does not inherit
the old 40-print display limit. Future queue is bounded to 1000, releases only when
timestamp <= now; quarantine, invalid events and overflow visibly mark gaps.
No trade deduplication, price rounding or side guessing is performed.

`useMarketAsset(assetId)` exports `{book, analysis}`. It uses useSyncExternalStore
with the stable published MAP as its snapshot, not a newly allocated analysis
object. This prevents render loops; idle publications refresh now-based analysis.
Direct parent consumers can likewise use marketStore.subscribe/getSnapshot.
