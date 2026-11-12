# Radar MVP audit: data reliability and honesty (2026-11-12)

## 1. Live runs (real output, MSK clock)
| Command | Wall time | Result |
|---|---|---|
| `radar newbies --mins 10 --top 5` (22:14:58) | **10.4 s** | OK. 4,801 fills / 847 markets / 1,716 wallets; 461 wallet-age lookups (206 cached); "age known for 95% of the money"; 5 rows printed. No errors. |
| `radar xray 0x7a0d…ff14` (22:15:08) | **5.0 s** | OK. All-in PnL -$8,921, 720 closed positions, 2 open, 3 NOTE lines + copier caveat. No errors. |
| `radar doctor` | 2.3 s | All 7 probes OK (gamma 1.8 s, clob 1.5 s, data v2 0.5-0.9 s). |
| `newbies` again at 22:15:38 (gamma blocked, see §2) | **3 m 43 s** | Succeeded but 9,075 fills / 2,530 wallets, "age known for 73% of the money". Slowness is NOT from gamma (newbies never calls gamma); likely the larger age-lookup batch. I did not isolate the cause. Run-to-run cost varies 10 s to 3.7 min with cache state / window. |

Observations on the first run: the BTC 5-min up/down market ranks #1 as "new money" and a CS2 map market shows LIFT x14.0 on 4 wallets / $127. Tiny-sample rows rank high on LIFT; no minimum-dollar warning besides the `$100+ and 3+ wallets` filter.

## 2. Failure modes
Method: no code edited. Gamma was simulated unreachable with a scratch `--import` shim (in ~/.hermes/cache/scratch/blk) rejecting fetches to gamma-api with ECONNRESET (the real block was not reproducible now; gamma answered live).
- Retry (`radar/polymarket.ts:262-281`): per-call min interval 120 ms, 3 retries (4 attempts), exponential backoff 0.4/0.8/1.6/3.2 s (~6 s total). 404, 400-protocol-contract and 410 fail fast with typed errors. **Every other failure, including 429, 5xx and a 4xx like 401/403, is retried the same way**; there is no `Retry-After` handling, no jitter, and no per-request timeout in `httpFetchJson` (line 583: plain `fetch`, no `AbortSignal`), so a hung socket blocks indefinitely (only `doctor` has a 10 s timeout). Non-JSON 200 bodies throw from `res.json()` and are retried generically.
- Gamma unreachable, measured: `radar find bitcoin` → after 6.4 s prints `request failed after 4 attempts: https://gamma-api.polymarket.com/public-search?...: TypeError: fetch failed` (raw error, URL included, no hint about network block). `radar doctor` → `DOWN gamma events 59ms connection reset (host down, or blocked from this network) … a core service: the radar cannot show events until it is back`; good message. `radar tui` runs doctor first and refuses to start unless `--force` (cli.ts:509-521); `--no-check`/`--once` skip it. With gamma blocked `tui --once` still rendered from the local store with no staleness marker seen.
- Unaffected by a gamma block: `newbies`, `xray` (data-api only). Not tested: mid-session gamma loss inside the live TUI (how stale data is flagged).
- Sequential client: `lastCall` throttle means 461-2,500 age lookups run serially, hence minute-scale scans; no overall progress timeout/cancel measured.

## 3. Honesty gaps (numbers/labels readable as signals or accusations)
Caveats that exist: Newbies detail line "New accounts are mostly ordinary people" (only shown when height>=20 and a row is selected); README line 372 ("a high LIFT is where to look, not a signal that anything is wrong"); X-ray footer "does not say a copier would earn the same, or why the wallet traded"; `CLUSTER_CAVEAT` (shown only if height>=26); Decision/Jumps/New standing lines; README 122 "leads, not signals".
Gaps:
1. **Newbies table** (`render.ts:814+`): headers `NEW$ / LIFT / LEANS TO` with green at x>=3 and yellow at x>=1.5 colour-code "suspicion" with no caveat on short terminals (<20 rows) or CLI `newbies` output (CLI prints table only, no caveat line). `LEANS TO "Spirit Academy 100%"` reads as a directional call; sample is 4 wallets. README line 47 frames the whole toolkit as "surveillance toolkit for suspected match-fixing ('322') and insider flow", which primes accusation.
2. **Newbies "under 14 days" age** is a Polymarket profile/first-activity date, not funding trace; coverage ("age known for 73-95% of the money") is shown in the CLI header but only as a gray line (height>=12) in the TUI.
3. **X-ray**: `STYLE 100% maker fills … the market-maker pattern` and NOTE "profit factor … yet all-in PnL is -$8,921" label a wallet's behaviour by a 1,000-fill / 26 h window (window stated, good). Net PnL/"biggest win", "top 5 = 15%" are shown without noting that unrealized/open and unredeemed are partial ("unrealized $0" for a $22k open book looks wrong/unverified). Wallets are shown by full address; the TUI also prints the Polymarket display `name` next to addresses, which attaches a person-like identity to flow.
4. **Edge/arb scoring** remains in README (`EDGE`, `BUY YES`, `ARB`, "BUY/SELL" in Decision tab with `+Npt` green edge, `confidence`, `room for ~$`) while Decision tab is in the MVP bar. Standing line exists ("edges are model/structure based, never from following wallets") but BUY/SELL verbs and green `+NN points` still read as advice; no "not financial advice" line anywhere I found (grep: none in README or tui/).
5. Removed-from-bar tabs (Jumps, New markets, Ledger, Edge) are still reachable by keys `n e j w 8 9` and carry caveats, OK; but README sections 105-300 still document them as features ("What to buy or sell").
6. Stale-data flag: no "as of HH:MM / data age" line found on Newbies or X-ray output; `PnL` "7d -$50,172" style figures do not show their fetch time.

## 4. Secret hygiene
- `.gitignore` contains `.env`, `.env.*` (with `!.env.example`), `.radar/` (`git check-ignore -v .radar/x` → `.gitignore:16:.radar/`), `.hermes/`, `.omh/`, `artifacts/`, `node_modules/`.
- `git ls-files | grep -i env` → only `src/vite-env.d.ts` (a type shim, no secrets). Broader grep for `.env|secret|key|token|.db|.sqlite|.radar` over tracked files → same single match. No values printed or inspected.
- `radar/refs.example.json` is tracked (example only); real `refs.json` lives under ignored `.radar/`.
- Radar uses no API keys (public gamma/data/clob endpoints, user-agent `polymarket-radar/0.1`).
Result: PASS.

## 5. Recommendations (data/honesty)
- Fix: add `AbortSignal.timeout` to `httpFetchJson`; honour 429 `Retry-After`; do not retry 401/403; print `doctor`-style message instead of the raw "request failed after 4 attempts" in CLI/TUI errors.
- Fix: always print the "new accounts are mostly ordinary people; not evidence of wrongdoing" line in the Newbies table output (CLI and any terminal height) and a minimum-sample warning when NEW < ~5 or NEW$ < $500 (LIFT x14.0 on 4 wallets).
- Fix: show data age ("as of HH:MM") on Newbies/X-ray; rename the README intro from "suspected match-fixing and insider flow" toward "wallet activity leads".
- Remove/soften from MVP: BUY/SELL/ARB wording and green `+Npt` in Decision unless a one-line "model estimate, not advice" accompanies it.
- Add: a progress ETA / cancel for wallet-age lookups (observed 10 s to 3.7 min).
