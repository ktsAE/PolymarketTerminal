# TUI UX audit (radar/tui)

Sources: `radar/tui/render.ts` (footer line 1259, `moveSelection` 1271, `TABS`/`TAB_LABEL` 24-28), `radar/tui/app.ts` (stdin handler 653-797, `bookKey` 524, `typeSearch` 613, `typeFollow` 439).
No code edited.

## Smoke run
`python3 scripts/tui-smoke.py` -> **38 PASS, 0 FAIL**, exit 0 (counted from real output: `grep -c ^PASS` = 38, `grep -c ^FAIL` = 0). Notable timings it printed: x-ray 3s, new-wallet scan 240s (that is most of the ~5 min).
The smoke only covers the 9 current tabs; nothing tests the dead keys/tabs listed below.

## Tabs (9, numbered 1-9 in the tab bar)
1 Markets (anomalies) · 2 Games · 3 Newbies (wallets) · 4 Holders · 5 Decision · 6 X-ray · 7 Search · 8 Book · 9 Following.
`Tab` type still has 7 more (prints, leads, news, edge, ledger, new, jumps); `LABS=[]`, so they are never on the bar.

## Key map
Global = works on every tab (when not typing in a search/follow box).

| Key | Global action | Per-tab override / note |
|---|---|---|
| ↑ / `k` / ↓ | move selection | **Book:** `k`/↑ scroll up, `j`/↓ scroll down (book's bookKey runs first). `j` is NOT bound elsewhere (dead). |
| PgUp/PgDn, Home/`g`, End/`G` | page / top / bottom | Book: PgUp/PgDn scroll book; Home/End fall through to selection (no-op, list length 0) |
| Tab | next tab among the 9 (wraps) | not in footer |
| `1`-`9` | jump to tab | `8` also opens a book from context (see 8); `9` also refreshes follow list if >45s old. `0` mapped but does nothing |
| `3` / `w` | Newbies; `w` starts a scan if none/older than 5 min, rescans if already on it | `3` only switches tab, does NOT scan (shows "press w" until w pressed) |
| `6` / `x` | X-ray tab | `x` on Holders or Following opens the selected wallet; else reopens last x-ray; else message. `6` never loads anything |
| `/` | start search, switches to tab 7 | while typing: all letters are text (q, p, h...), Enter runs, Esc cancels. Pasted 0x address -> opens X-ray |
| Enter | Newbies: open holders of row; Following: x-ray of card | **dead on every other tab** (footer says "enter open") |
| `h` | open holders for selected event | Newbies: holders of row; Decision: holders of selected market row; Holders/X-ray/Book/Following: "select an event first" (no slug) except Holders/Decision |
| `p` | decision for selected event | works from 1,2,4(holders slug),5,7; message elsewhere |
| `8` | open order book | from Newbies row, Decision row, or current Holders market; else reopen last book; else message |
| `a` | add wallet to watch list | only on Holders (selected row) or X-ray; message elsewhere |
| `+` / `=` | **Following: opens add-wallet input (on ANY tab, jumps to 9)** | **Book:** compress ticks (grouping) |
| `-` / `_` | **Following:** unfollow selected | **Book:** finer ticks. Elsewhere: no-op |
| `[ ] { }` | switch market | only Holders and Book (needs holders loaded for same event) |
| `f` | cycle category filter | applies to anomalies list only, but silently works on every tab and resets sel |
| `b` | toggle bots/market makers | affects Holders/anomalies; global key |
| `o` | show link in footer message | Holders -> profile URL; event tabs -> event URL |
| `r` | refresh poll | |
| `q`, Ctrl-C | quit | |
| Book only | `m` shares/USD · `t` cluster period · `s` tape filter · `i` flip outcome · `c` centre | `m,t,s,i,c` are consumed on Book only |
| Following input | Esc cancel, Enter add, Backspace | accepts address or polymarket profile link / @name |

## Conflicts
- `+`/`-` mean different things: Following add/remove vs Book tick compress/expand. `+` on Markets/Holders silently yanks you to Following with an input box.
- `j`/`k`: `k` moves up everywhere, `j` moves down only on Book; elsewhere `j` is dead.
- `w` and `3` differ (scan vs plain switch); `x` and `6` differ (context action vs plain switch). `8` is the same split.
- `h` on Decision means "holders of the selected market", on Markets "holders of the event" (footer only says "on 5: the selected row").
- Typing mode swallows `q`/Ctrl-C only via Ctrl-C; `q` is text. Not shown anywhere on the tab 7 hint until `/` is pressed (hint appears: "Enter search · Esc cancel").

## Documented but dead / misleading
1. Footer "enter open": Enter does something only on tabs 3 and 9.
2. Footer "h holders (**on 5**: the selected row)": numbering is stale-looking; Decision is 5 so it is right, but reads like the Newbies row; the actual Newbies (3) h/Enter also open holders.
3. Footer "f category": only filters the Markets list.
4. Footer "o link": silently shows the URL as a status message, nothing opens.
5. Empty-state texts reference removed tabs/keys: Holders (render.ts:343) and Decision (:430) say "Anomalies, Games or **Big prints**"; News/Edge/New/Jumps/Ledger/Leads/Big prints renderers (`n`, `e`, `j`, `u`, `l` keys: texts at 545, 578, 701, 753, 634...) describe keys with no binding. `startEdgeScan`, `openNew`, `openJumps`, `openNews` in app.ts are defined but never called (dead code); `Key` type lists `'j'|'u'|'0'`.
6. `scan --tab` CLI help/parse still accepts games|prints|leads|decision|edge|ledger|new|jumps (cli.ts:533, 706); several of those cannot be reached interactively.
7. Wallet watch message tells the user to run `npm run radar -- wallet-watch` in another terminal: the TUI's Following tab refresh every 90s also notifies, so guidance is contradictory.

## Hidden tabs / hidden steps
- 4 Holders, 5 Decision, 6 X-ray, 8 Book are empty until a context action (`h`, `p`, select a wallet + `x`, `8` from a row). Pressing the number first just shows a help line. Reachable only via those steps for content.
- Book (8) is only reachable with content from Holders/Decision/Newbies; from Markets (tab 1) `8` says "open Holders, Decision or a Newbies row first".
- Newbies (3): `3` does not scan; only `w` does. The 240s scan runs with no ETA.
- X-ray: needs a Holders row or pasted address; `a`/`x` flow is not explained in footer except "x x-ray".
- Seven removed tabs (prints, leads, news, edge, ledger, new, jumps) are unreachable from the keyboard but their code (~600 lines in render.ts) and CLI flag remain.

## Empty-state / help coverage
All 9 live tabs have a one-line empty state (1: render.ts:270, 2: :325, 3: :816, 4: :343, 5: :430, 6: :794, 7: :515, 8: :894, 9: :959). Gaps: none of them has a "?" help screen; the footer is one 300+ char line that is clipped on terminals under ~200 cols, so `r refresh · q quit` (and often `b`, `o`, `f`) are not visible on a normal 120-col window (footer is clipped by `clip(.., cols)`; status message further shortens it). No `?` key. Tab 1/2 empty states say "first poll is loading" without distinguishing loading from empty.

## Numbering
Tab bar labels "1 Markets … 9 Following" match keys 1-9. Inconsistent: Tab-key cycle order equals numbering (good); internal names differ from labels (anomalies/Markets, wallets/Newbies, follow/Following); `scan --tab` uses internal names; tab 1 text says "Anomalies" in empty states of 4 and 5; CLI `tui` lacks `--tab` for the 9 numbered tabs (xray/wallets/book/follow not in the list at cli.ts:533).

## Ranked confusing points
1. Footer is truncated at normal widths: quit/refresh/filter keys invisible; no `?` help.
2. `+`/`-` do opposite jobs by tab; `+` anywhere hijacks to Following input.
3. Tabs 4-6, 8 are blank until context actions; number keys alone give nothing, and `3` doesn't scan while `w` does.
4. Enter documented as "open" but dead on 7 of 9 tabs (including Search results and Markets).
5. Stale help text mentioning Big prints / n / e / j / u keys that no longer exist; dead functions in app.ts.
6. `o` only prints the URL; `f`/`b` global but only affect some tabs without feedback.
7. `j` down only in Book; `k` up everywhere.
8. Newbies scan takes ~240s with only a stage line; scan CLI `--tab` accepts unreachable tabs.
9. `a` says "run wallet-watch" while Following polls itself.

## Suggested minimal first-run flow
1. Launch `npm run tui`; land on 1 Markets (shows "loading" then rows). Footer should show `? help · ↑↓ · Enter open · / search · q quit` first, rest on `?`.
2. ↑↓ to a market, Enter (make Enter = open Decision, same as `p`).
3. `h` for holders (Decision -> Holders), `x` on a holder for X-ray, `a` to follow.
4. `8` for the book of that market; `+`/`-` stay book-only and Following uses `n`/`d` or `a`.
5. `9` to see Following; `/` to search any market or paste a wallet.
Optional: `w` (or `3` with auto-scan) for Newbies, flagged "takes ~4 min".
Minimal fixes to support it: auto-scan on `3`, make Enter open Decision on 1/2/7, add `?` overlay and a short footer, remove dead keys/tabs/help strings.
