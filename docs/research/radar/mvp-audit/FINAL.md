# Radar MVP final verification (2026-11-12, independent re-run)

## Command results (observed this run)
| Command | Result |
|---|---|
| `npx tsc --noEmit` | exit 0, no output |
| `npx vitest run --project unit` | exit 0; 44 files passed (44), 489 tests passed (489) |
| `npm run -s doctor` | exit 0; "all services answering" (7 data/gamma/clob checks OK, 1.0-1.2 s each) |
| `python3 scripts/tui-smoke.py` (`~/.hermes/cache/scratch/final-smoke.out`) | **45 PASS / 3 FAIL** (lines starting PASS/FAIL). Fails: `down arrow moves the selection down`, `up arrow moves it back`, `pasting a wallet address after / opens its x-ray with all-in PnL and the closed-versus-open contrast` (x-ray wait hit its 90 s cap: "x-ray took 91s"). Not isolated whether the arrow fails are a regression or the script's timing; not investigated. |
| `git status --short` | 22 modified, 4 deleted (radar/surge.ts, surgelog.ts, tests surge/surgelog), untracked: docs/research/radar/mvp-audit/, tests/radar/harden.test.ts, tests/radar/net.test.ts. Nothing staged (`git diff --cached --stat` empty). |
| `git diff --stat` | 26 files, +782/-2338. Only radar/, tests/, scripts/, docs/, README.md: **confirmed**, no path outside scope. |
| secrets grep (`git diff \| grep -iE 'api[_-]?key\|secret\|password\|token='`) | no matches (tracked diff only; untracked new files not grepped) |

## VERDICT checklist
REMOVE
1. DONE: no `newsRows/edgeRows/ledgerRows/newRows/jumpRows/leadRows` in radar/ (`printRows` remains only as a local var in `collect.ts:71`, unrelated).
2. DONE: `ledgerView` gone. A single live `snapshotModel` remains (`tui/app.ts:72,112,122`).
3. DONE: no `--no-news`, `opts.news`, news poll in `tui/app.ts`.
4. DONE: no `startEdgeScan/startNewScan/startJumpScan/openNew/openJumps/openNews` in radar/.
5. DONE: "Big prints" no longer in render.ts (remains in `health.ts:25` as a data-source description, and `radar/README.md:54` as a removed-tabs note); `scan --tab` restricted to live tabs (`cli.ts:532,706`).
6. DONE: `radar/surge*.ts`, `tests/radar/surge*` absent (`git status` D). Other "surge" hits are the `oi_surge` signal (`detect.ts:153`, `render.ts:117`).
7. DONE: README.md and radar/README.md contain no "surveillance"/"match-fixing"/"what to buy" (grep empty); radar/README.md cut to 61 lines.

FIX
1. DONE: `newwallets.ts:229-240` caveat + small-sample (<5 wallets or <$500); CLI `newbiesLines`.
2. DONE: `render.ts:367` DECISION_DISCLAIMER, `:815`; `cli.ts:415`.
3. DONE: `.catch` at `app.ts:218,244,285,371,428,463,607`; `unhandledRejection` at `app.ts:521`. (Not tested live that poll rejection resumes polling beyond harden's tests.)
4. DONE: `render.ts:866` `enterOpensDecision` = tabs 1/2/7; `app.ts:562`.
5. DONE: `render.ts:799` short FOOTER (~110 chars incl. leading space; smoke "footer is short" PASS); `?` overlay at `app.ts:548-555`.
6. DONE: 15 s timeout `polymarket.ts:613`; Retry-After `:303,615`; no retry of 400/401/403 `:297`; limiter fix `:279-305`. Doctor-style message `:309` (truncated message; not live-tested).
7. DONE: `app.ts:532` auto-scan on tab 3; smoke PASS "3 opens … starts the scan by itself".
8. DONE: `render.ts:864` `opensFollowPrompt` excludes book and follow; `n` opens it.
9. DONE: temp+rename `walletwatch.ts:49-51`, `people.ts:130-132`.
10. DONE: `xray.ts:202-207` "(partial)" labels. Display name beside address: not verified.
11. PARTIAL: `f`/`b` give feedback when not applicable (`app.ts:689-704`), `o` shows link in footer (smoke PASS); the `a` wording no longer says "run wallet-watch" (`app.ts:579`). Not separately verified for every message.
12. DONE: `newwallets.ts:237` coverageNote ("age known for N% of the money; not a funding trace") used in `newbiesLines` (`:240`).
ADD
1. DONE: `?` help overlay `render.ts:801-823`, `app.ts:548-555`.
2. DONE: ETA `newwallets.ts:199,221`; Esc cancels `app.ts:436-441,559` (smoke PASS "Esc cancels a running new-wallet scan").
3. DONE: `render.ts:110-112` `asOf` (smoke PASS "as-of time once the scan is done"). Whether Decision and X-ray also show it: not checked.

## THREATS.md Status
All 5 Critical/High (#1-#5) are FIXED or ALREADY FIXED (Status table, THREATS.md:68-72). Mediums #11-#13 and Lows #14,#17-#19 DEFERRED with reasons. No Critical/High is open. Residual: source URL `cases.seed.ts:107` still contains named individuals; the 10 s old-code limiter test was not run against old code.

## Open items
- Smoke script: 3 FAIL (see above). The run goal requires it to pass: **not met**.
- harden.md notes the holders table now shows address not name on NEW rows; smoke checks may rely on that. Unconfirmed as the cause.
- Deferred Mediums #11-#13 (retention, `engines`, follow-list caps), Lows; `news.ts` regex cost on hostile feeds.
- Untracked new files not secret-scanned; `docs/` mvp-audit dir untracked (no commit made, per instruction).

## Go / no-go
**NO-GO against the stated run goal** (smoke 45/3, not all pass). tsc, unit tests, doctor, scope and secrets checks pass; all VERDICT items DONE except Fix 11 PARTIAL. Becomes GO once the 3 smoke failures are diagnosed (arrow-key selection ×2; x-ray at the 90 s cap, likely a slow wallet) and either fixed or shown to be script/data flakiness.

## Update after fix (parent re-run)
The 3 smoke failures were diagnosed. The X-ray one was a real regression from the hardening pass: a wallet pasted after an earlier search was no longer recognised because the search box kept the previous query. `/` now starts with an empty box (`radar/tui/app.ts`). Re-run: tsc clean, 489/489 unit tests, smoke 48 PASS / 0 FAIL, X-ray step 8 s. Verdict: GO.
