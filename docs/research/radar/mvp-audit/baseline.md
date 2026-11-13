# MVP audit baseline

Repo: ~/PolymarketTerminal (branch main, up to date with github/main)
Scope: baseline checks only. No code changed.

## Results

| # | Command | Exit | Result |
|---|---------|------|--------|
| 1 | `npx tsc --noEmit` | 0 | Pass. No output, no type errors. |
| 2 | `npx vitest run --project unit` | 0 | Pass. 44/44 test files, 480/480 tests. No failures. |
| 3 | `npm run -s doctor` | 0 | Pass. All services answering. |
| 4 | `git status --short` | 0 | Clean. No output, no uncommitted or untracked changes. |

## Failures

None. No failure ids or signatures to report.

## Notes

- Vitest emitted 9 `ExperimentalWarning: SQLite is an experimental feature` lines (Node SQLite). These are warnings, not failures.
- Doctor latencies: gamma events 958ms, clob time 519ms, data v2 trades 901ms, holders 1237ms, activity 1068ms, positions 984ms, user-pnl 1626ms. Live network calls, so timings vary between runs.
- Raw logs: ~/.hermes/cache/scratch/{tsc,vitest,doctor,gitstatus}.log
