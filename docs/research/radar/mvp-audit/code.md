# Radar MVP code audit

Live tabs (`radar/tui/render.ts:25`): anomalies, games, wallets, holders, decision, xray, search, book, follow. `LABS` is `[]` (`render.ts:26`), so no other tab can be shown.
Every row below was read at the cited line. LOC is approximate (end line minus start line). Nothing was edited.

Key fact: `app.ts` has no key binding for e, j, n, l, or any other removed tab. The key handler is at `app.ts:650-800`. It handles only `/ w p b f o x h - [ ] r q`, Enter and the digits 1-9. The `open*` and `start*Scan` helpers below are therefore never called.

## 1. Dead code reachable only from removed tabs

| Item | File:line | LOC | Recommendation |
|---|---|---|---|
| `newsRows` | tui/render.ts:543 | 33 | delete |
| `edgeRows` | tui/render.ts:576 | 52 | delete |
| `ledgerRows` | tui/render.ts:628 | 48 | delete |
| `jumpLedgerBlock` | tui/render.ts:676 | 17 | delete |
| `newRows` | tui/render.ts:693 | 52 | delete |
| `jumpRows` | tui/render.ts:745 | 47 | delete |
| `printRows` | tui/render.ts:1049 | 44 | delete |
| `leadRows` | tui/render.ts:1093 | 34 | delete |
| `detailLines` branches for prints, edge, new, jumps, ledger, news | tui/render.ts:1163-1220 | ~58 | delete |
| Dispatch ternaries for dead tabs in `render` and `listLength` | tui/render.ts:1250, 1267 | 2 long lines | simplify. The `leadRows` fallthrough at 1250 and `m.leads.length` at 1267 hide any tab typo. |
| Dead types and constants: `JumpsView`, `NewMarketsView`, `EdgeView`, `LedgerView`, `NEW_STANDING`, `JUMPS_STANDING`, `LEDGER_STANDING`, `flaggedNew`, `jumpFlags`, `unmappedNote`, and the `Tab` union members | tui/render.ts:15, 62-135 | ~70 | delete. `cli.ts:15` imports the 4 constants/`unmappedNote`, so move those into the CLI before deleting. |
| `Model` fields `prints`, `leads`, `news`, `edges`, `ledger`, `newMarkets`, `jumps` | tui/render.ts:27-70 | ~15 | delete |
| `TAB_LABEL` entries for removed tabs | tui/render.ts:24 | 1 | delete |
| `startEdgeScan` | tui/app.ts:288-322 | 35 | delete (never called) |
| `startNewScan` and `openNew` | tui/app.ts:324-355 | 32 | delete (never called) |
| `startJumpScan` and `openJumps` | tui/app.ts:357-387 | 31 | delete (never called) |
| `openNews` (calls `loadNews`) | tui/app.ts:389-405 | 17 | delete (never called) |
| `ledgerView` and `ledgerCache` | tui/app.ts:87-112 | 26 | delete. It is called from `snapshotModel` (app.ts:131) on every refresh. It runs `statSync` on 3 files, then bootstrap-scores the forward logs whenever a log changes (`readJsonl`, `scoreLedger`, `scoreJumps`), purely for the removed Ledger tab. |
| `snapshotModel` copies of `prints`, `leads`, `news`, `edges`, `newMarkets`, `jumps` | tui/app.ts:122-133 | 8 | delete |
| `selectedSlug` branches for prints, news, edge, new, jumps | tui/app.ts:148 | 1 long line | trim |
| `--once` branches for jumps and new | tui/app.ts:202-209 | 8 | delete |
| `o` handler branches for leads and news | tui/app.ts:791 | 1 | trim |
| Constants `NEW_TAB_RESCAN_MS`, `TUI_SCAN`, `JUMPS_TAB_RESCAN_MS` | tui/app.ts:28-33 | 6 | delete |
| Background news poll (`opts.news`, `pollFeeds` every 15 min plus a 5 s one-shot) | tui/app.ts:801-812 | 12 | delete. It feeds only the removed Leads/News data, yet still hits the network and writes the DB. Also drop `news?` at app.ts:61 and `--no-news` at cli.ts:529. |
| Imports that become unused: edges, ledger, jump, newmarkets, newsview, poll (`pollFeeds`) | tui/app.ts:4,6-8,19,22 | 6 | delete |
| Imports that become unused: edges, ledger, jump, newmarkets, newsview, `NewsRow`/`PrintRow` | tui/render.ts:2-6,20 | 6 | delete |
| `scanJumpsWithProgress` | tui/app.ts:39-56 | ~18 | keep only if the `jumps` CLI stays. Used by cli.ts:172 and :210. If kept, move it into jump.ts. It does not belong in app.ts. |
| `--tab` option accepting removed tabs | cli.ts:533 | 1 | fix. `scan --tab prints|leads|edge|ledger|new|jumps` renders a blank or fallthrough page. Restrict it to the live tabs. The help text at cli.ts:709 lists them too. |

Rough total in app.ts and render.ts: about 480-520 LOC removable.

## 2. Modules not imported by any live path

The live path is cli.ts → tui/app.ts → ../collect, decide-data, holders, xray, bookview, livebook, following, walletwatch, newwallets, walletinput, people, refs, polymarket, store and render. Imports were checked with `grep from './x.ts'`.

| Item | File:line | LOC | Recommendation |
|---|---|---|---|
| surgelog.ts | whole file | 395 | Imported by nothing in radar/. Only tests/radar/surgelog.test.ts and scripts/surge-study.py reference it. Delete with its test, or move it to scripts/ if the surge study stays. |
| surge.ts | whole file | 356 | Imported only by surgelog.ts, so it is also unreachable. Same call as surgelog.ts. |
| newmarkets.ts | whole file | 554 | Reachable only from cli.ts (`new-scan`, `new-score`, daemon) and the dead TUI code. Not live for the TUI. Delete along with the CLI commands, or keep as a CLI-only tool. |
| jump.ts | whole file | 620 | CLI only (`jumps*`, daemon). Not live for the TUI. Same call as newmarkets.ts. |
| ledger.ts | whole file | 328 | CLI `ledger` only, plus `surgelog.ts` and the dead `ledgerView`. Same call as newmarkets.ts. |
| edges.ts | whole file | 405 | CLI `edges` only. It also writes `.radar/edges.json` (edges.ts:398). Same call as newmarkets.ts. |
| forward.ts | whole file | 323 | CLI only (`forward-log`, `forward-settle`), plus the dead code above. Same call as newmarkets.ts. |
| news.ts, newssearch.ts, newsview.ts | 159 + 113 + 84 | 356 | No live TUI use after the news cleanup. `news.ts` is reached via cli.ts:30, :661 and `poll.ts`. The `news-search` test covers `newssearch.ts`. Delete or keep as CLI-only. |
| xaccounts.ts | whole file | 272 | CLI only (`x-add`, `x-list`, `x-poll`). Not live. |
| health.ts | whole file | 81 | CLI only (`doctor`, plus `tui` startup check at cli.ts:511). Keep. |
| cases.seed.ts, evidence.ts, ingest.ts, features.ts, score.ts | 180 + 124 + 56 + 142 + 153 | 655 | CLI only (`seed`, `cases`, `ingest`, `report`, `backfill`), the old research-case path. Not live for the TUI. Delete if the MVP cuts that CLI. |
| `scan --tab` and `--once` | cli.ts:533 | n/a | keep, as a render smoke-test hook. |

Count of non-test .ts files under radar/: 49. The TUI reaches roughly 28 of them. About 4,000 LOC outside app.ts and render.ts are CLI-only or orphaned.

Further: `decide.ts` and `ladder.ts` are live through decision. `fairvalue.ts` is live through decide/refs. `flow.ts` is live through decide. `chainfunding.ts`, `fundmap.ts` and `loadmap.ts` are live through holders and cli.

## 3. Risky spots

| Item | File:line | LOC | Recommendation |
|---|---|---|---|
| `loadFollowing(...).then(...)` has no `.catch`. A rejection is unhandled, and the handler at app.ts:632 then restores the terminal and exits with code 1, so the TUI crashes. | tui/app.ts:431-438 | 8 | fix: add `.catch(e => putFollow({loading:false, message: String(e)}))` |
| `void scanNewWallets(...).then(...)` has no `.catch`. A throw before it returns `{result, error}` crashes the TUI. | tui/app.ts:557-569 | 13 | fix: add `.catch` |
| `void loadXray(...)` has no `.catch`. | tui/app.ts:582 | 8 | fix, unless `loadXray` is provably non-throwing. xray.ts has 1 try and 1 catch, so check it. |
| `void loadHolders(...)` and `void loadDecision(...)` have no `.catch`. | tui/app.ts:255, 276 | 20 | fix, or confirm the loaders catch everything. holders.ts has 5 try and 6 catch. decide-data.ts has 7 try and 8 catch. |
| `loadBookMeta(...).then` has no `.catch`. bookview.ts comment says "Never throws", which is OK only if that holds. | tui/app.ts:512 | 5 | fix (cheap guard) |
| `void poll().then(() => paint())` on `r`. `poll` is not shown to catch everything, and a throw crashes the TUI. | tui/app.ts:696 | 1 | fix: add `.catch` |
| `schedule()` is `setTimeout(async () => { await poll(); paint(); schedule(); })`. If `poll` throws, the chain stops, polling silently dies, and the rejection goes uncaught. | tui/app.ts:236-243 | 8 | fix: wrap in try/catch, or `.finally(schedule)` |
| `uncaughtException` handler only. There is no `unhandledRejection` handler. Node turns an unhandled rejection into an uncaught exception, so the effect is the same: the TUI exits with code 1 on any stray async error. | tui/app.ts:632-636 | 5 | fix: log to `.radar/` and keep running for non-fatal errors |
| Timers are cleared on `quit`: `timers` and `pollTimer` at app.ts:230-232, and `bookFeed.stop()`. `livebook.stop()` clears all four of its timers (livebook.ts:212-215). | tui/app.ts:228-236 | n/a | keep |
| The one-shot `setTimeout(newsPoll, 5_000)` handle is not stored, so `quit()` cannot clear it. It is harmless because `quit` calls `process.exit`, and it goes away with the news-poll removal. | tui/app.ts:810 | 1 | delete (with news poll) |
| The `once` branch awaits and returns without calling `store.close()` itself. cli.ts's `finally` closes the store. | tui/app.ts:196-212; cli.ts:711 | n/a | keep |
| Secrets: grep for `apiKey|SECRET|Authorization|KEY` across radar/ found none. The only credential-like input is `RADAR_POLYGON_RPC` (chainfunding.ts:11, default public RPC). The URL is never logged: the error messages at chainfunding.ts:14, 16 print only the status or the RPC message. | chainfunding.ts:11 | n/a | keep. If a keyed RPC URL is used, add a note to the README that it must not be committed. |
| Files written outside `.radar/`: none by default. Every path defaults to `.radar/...` (cli.ts:36, edges.ts:403, forward.ts:20, people.ts:20, refs.ts:28, surgelog.ts:15, walletwatch.ts:11, xaccounts.ts:51-52). Each can be redirected with a `RADAR_*` env var, and a mistaken value would write anywhere, e.g. `RADAR_DB` at cli.ts:36 with `mkdirSync` at :41. | various | n/a | keep. Optionally warn when a `RADAR_*` path resolves outside the cwd. |
| Other writes: `walletwatch.ts:41` (`.radar/wallets.json`), `people.ts:130`, `cli.ts:641` (`x_accounts.json`). All use plain `writeFileSync`, which is not atomic. A crash mid-write can truncate the file. Following and Holders depend on `wallets.json` and `people.json`. | walletwatch.ts:39-41; people.ts:128-130 | 6 | fix: write to a temp file and `rename`. |
| `notify` shells out via `execFile('notify-send', [...])` with an argument array, so there is no shell injection. The callback ignores errors, so a missing binary is silent. Trade text containing `\n` is fine. | walletwatch.ts:109-111 | 3 | keep |
| Duplicate `notify` implementation inline in cli.ts. | cli.ts:219 | 1 | fix when touching it: call `walletwatch.notify` instead. |
| Each of 4 modules re-implements `appendLine` (forward.ts:191, jump.ts:375, newmarkets.ts:234, surgelog.ts:82). | listed | ~4 each | delete, via the module removals in §2. |

## Verification

Every line number above came from `grep -n` or `sed -n` output on the files in ~/PolymarketTerminal/radar. Not run: tsc, tests and the TUI. Execution and build checks are out of scope for this audit.
Not verified: whether `poll()` and `loadBookMeta` actually never throw. I read `loadBookMeta`'s doc comment (bookview.ts:51) but not its body.
