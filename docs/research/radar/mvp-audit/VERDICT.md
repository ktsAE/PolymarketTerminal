# Radar MVP verdict (2026-11-12)

MVP = a trader-researcher launches it, finds markets with unusual new-wallet activity, inspects holders/book/wallet record, follows wallets, without being misled.

## Verdict: READY WITH FIXES

The core loop works. Nothing blocks launch, but several things can mislead the user or crash the TUI, so ship after the S-sized fixes in 1-4.

Evidence:
- `npx tsc --noEmit` re-run by me: exit 0, no output. Matches baseline.md Results #1.
- baseline.md: 480/480 unit tests, doctor all services OK, git clean.
- ux.md Smoke run: 38 PASS / 0 FAIL on the 9 live tabs.
- data.md §1: `newbies` and `xray` ran live with no errors. Newbies took 10 s once and 3 m 43 s once.
- data.md §4: secret hygiene PASS. code.md §3: no secrets in radar/.

Caveat on the handoffs: data.md §3.5 says the removed tabs are "still reachable by keys n e j". code.md (header, key handler `app.ts:650-800`) and ux.md (Key map) say there is no binding. I grepped `app.ts` and found no `n/e/l/u` case, and `j` only on Book (line 546). I follow code.md. The dead tabs are dead code, not a live path.

## REMOVE
1. Dead tab code in `render.ts`: `newsRows`, `edgeRows`, `ledgerRows`, `newRows`, `jumpRows`, `printRows`, `leadRows`, the dead types and `Model` fields (code.md §1, ~480-520 LOC). The `leadRows` fallthrough hides tab typos. Also ux.md "Hidden tabs".
2. `ledgerView` and the `snapshotModel` copies in `app.ts` (code.md §1). `ledgerView` runs `statSync` and scores forward logs on every refresh for a tab nobody can see.
3. Background news poll, `opts.news` and `--no-news` (code.md §1). It does network and DB writes for removed Leads/News data.
4. Never-called `startEdgeScan`, `startNewScan`, `startJumpScan`, `openNew`, `openJumps`, `openNews` (code.md §1; ux.md "Documented but dead" #5).
5. Stale help text: "Big prints" in empty states at `render.ts:343` and `:430`, and key hints for `n e j u` (ux.md "Documented but dead" #5, #6). Restrict `scan --tab` to live tabs (code.md §1, last row).
6. `surgelog.ts` and `surge.ts`, with their test: unreachable from any live or CLI path (code.md §2).
7. README framing as a "surveillance toolkit for suspected match-fixing", and README sections ~105-300 that document removed features as "What to buy or sell" (data.md §3.1, §3.5, §5).

## FIX (ranked)
| # | Fix | Effort | Source |
|---|-----|--------|--------|
| 1 | Newbies: always show "new accounts are mostly ordinary people; not evidence of wrongdoing", in the CLI and at any terminal height. Add a minimum-sample warning (NEW < ~5 or NEW$ < $500; seen: LIFT x14.0 on 4 wallets / $127). | S | data.md §1, §3.1, §5 |
| 2 | Decision: BUY/SELL/ARB wording and green `+Npt` read as advice. Add "model estimate, not advice", or soften the verbs. | S | data.md §3.4, §5 |
| 3 | Crash resilience: add `.catch` to `loadFollowing`, `scanNewWallets`, `loadXray`, `loadHolders`, `loadDecision`, `loadBookMeta` and the `r` poll. Make `schedule()` survive a throwing `poll` (`.finally(schedule)`). Add an `unhandledRejection` handler. Any stray rejection currently exits the TUI with code 1 (`app.ts:632-636`). | S | code.md §3 |
| 4 | Make Enter open Decision on tabs 1/2/7. The footer says "enter open", but Enter works only on tabs 3 and 9. | S | ux.md ranked #4, "Suggested minimal first-run flow" |
| 5 | Footer clipped on a 120-col terminal, hiding `q`/`r`/`f`/`b`/`o`. Shorten it (≤100 cols) and move the rest to `?` (see ADD 1). | M | ux.md ranked #1, Empty-state/help coverage |
| 6 | HTTP: add `AbortSignal.timeout` to `httpFetchJson` (`polymarket.ts:583`; a hung socket blocks forever). Honour 429 `Retry-After`. Don't retry 401/403. Replace the raw "request failed after 4 attempts … TypeError" with a doctor-style message. | M | data.md §2, §5 |
| 7 | Tab 3 does not scan. Auto-scan on `3`, or say "press w, ~4 min". Show an ETA (see ADD 2). | S | ux.md ranked #3, #8 |
| 8 | `+` anywhere jumps to Following's add box, while on Book it means "compress ticks". Make `+` Following-only on tab 9, or use `n`/`a`. | S | ux.md Conflicts, ranked #2 |
| 9 | Atomic writes (temp file + `rename`) for `wallets.json` and `people.json`. A crash mid-write can corrupt Following/Holders data. | S | code.md §3 |
| 10 | X-ray: "unrealized $0" next to a $22k open book looks wrong. Label open/unredeemed as partial. Reconsider showing the display name beside the address. | S | data.md §3.3 |
| 11 | Footer messaging: `a` says "run wallet-watch" although Following polls itself. `o` only prints the URL. `f`/`b` give no feedback when they don't apply. | S | ux.md ranked #6, #9 |
| 12 | Newbies "under 14 days" is a profile-age date, not a funding trace. State the data-coverage line ("age known for 73-95% of money") outside the gray, height≥12 case. | S | data.md §3.2 |

## ADD (max 3)
1. `?` help overlay with the full key map. Removes the need for the 300-char footer (ux.md ranked #1, Empty-state/help coverage).
2. Progress ETA and cancel for wallet-age lookups. Observed 10 s to 3 m 43 s with only a stage line (data.md §1, §5; ux.md "Hidden steps").
3. "As of HH:MM" data-age line on Newbies, X-ray and Decision (data.md §3.6, §5).

## Out of scope for MVP
- Deleting the CLI-only modules (`newmarkets`, `jump`, `ledger`, `edges`, `forward`, `news*`, `xaccounts`, the cases/ingest/score path). They are not live in the TUI. Leave them or cut later (code.md §2).
- Mid-session gamma-loss staleness behaviour inside the TUI: not tested (data.md §2). Needs its own check.
- Why the second `newbies` run took 3 m 43 s: cause not isolated (data.md §1).
- Whether `poll()` and `loadBookMeta` never throw: not verified (code.md Verification). Fix 3 covers it defensively.
- Per-tab context-flow redesign (auto-open tabs 4/5/6/8) and `j` down-scroll outside Book (ux.md ranked #3, #7).
- New features: alerts, wallet clustering or funding-trace claims, edge/arb scoring improvements.
