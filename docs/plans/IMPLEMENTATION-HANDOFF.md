# PolymarketTerminal implementation handoff

Updated 2026-10-28. This is a continuation guide, not a release sign-off.

## Start here

The accepted plan is `docs/plans/2026-10-28-professional-terminal-implementation.md`. The prior research is `docs/research/terminal-gap-analysis/REPORT.md`; feed limitations are documented in `docs/contracts/polymarket-feed.md`. Do not redo the research or rewrite the plan unless a specific missing fact blocks implementation. Read the relevant task and safety boundaries in the plan before changing code.

The user wants small batches, preserving separate engineering, visual-design, market-data and QA lanes without unnecessary parallel agents. Inspect only relevant files, run focused offline tests first, report briefly, and stop after each batch. Use independent review for trading-critical changes. Do not commit automatically. Preserve all existing uncommitted changes; many predate the latest session and include the plan's implementation.

## Current state and immediate priority

The complete plan is NOT finished or independently accepted. A feed-safety batch is in progress and NOT approved:

- `electron/main.cjs` forwards registry-accepted canonical market messages rather than raw messages; malformed frames trigger conservative invalidation. Snapshot refresh checks supersession.
- `electron/safety.cjs` includes invalidation and revision fencing for malformed or out-of-order deltas and updates observed during refresh.
- `tests/main-feed.test.cjs` contains focused offline regression tests. On the last run, `node --test tests/main-feed.test.cjs` passed 14/14 and `git diff --check` passed.
- Independent review identified a remaining serious issue: on first subscription an arbitrarily old provider timestamp can be accepted as a snapshot, then treated as fresh based on receipt time (`electron/safety.cjs`, inspect current implementation). Next batch: investigate provider timestamp semantics and implement a safe, tested freshness policy if supported; independently review. Do not invent provider guarantees or weaken fail-closed behavior.
- Timestamp-less or pre-fence refresh snapshots are deliberately rejected. This can prevent recovery in quiet markets; resolve only with verified provider evidence and a safe proof policy.
- A broader offline unit run reported 12 failures across trading-safety and market-store tests and two unhandled errors; prior baseline was not established. Most safety failures involved rejected timestamp-less fixtures; another involved missing `persistAuditResult`. Investigate actual causes and fix tests or code without weakening safeguards. A market-store coverage test expected GAP but got PARTIAL OVERFLOW. Do not assume these failures are harmless or pre-existing.

## Plan task inventory (evidence, not acceptance)

Existing files and test descriptions are evidence of implementation, not proof of completion. Recheck only the relevant task before working on it.

1. Test harness: present; isolation and full passing status still need verification.
2. Feed capabilities: partial. Contract records unknown direction/identity guarantees; planned sanitized feed fixture and contract test were not found. Verify any provider claim before relying on it.
3. Exact decimals and price groups: implementation and tests present; integration/build parity unverified.
4. Execution normalization: implementation and tests present; acceptance unverified.
5. Time-based aggregation: implementation and tests present; full acceptance unverified.
6. Market store and book health: implementation and tests present; active feed-boundary issues above, lifecycle/performance acceptance unverified. Asset-specific rerender isolation and per-asset versus global analysis budgets need review against the plan.
7. Trading policy/arm epochs: implementation and tests present; independent safety review and passing suite outstanding.
8. Main order intents/idempotency: implementation and tests present; direct IPC trust boundary, idempotency and safety invariants require review.
9. Controlled ladder/safe gestures: functionality and tests present, but much remains in `src/App.tsx` rather than the planned extraction; acceptance unverified.
10. Centering/depth normalization: implementation and tests present; acceptance unverified.
11. Bubbles/public tape: implementation and tests present; thresholds, accessibility and visual acceptance unverified.
12. Cluster UI: implementation and tests present; full normalization/coverage acceptance unverified.
13. Workspace persistence: implementation and tests present; sensitive-state exclusion and hydration/write barrier require verification.
14. Resolution and refresh: implementation and tests present; provider endpoints and full main-process behavior unverified; refresh caveat above.
15. Layout/settings: implementation and tests present; full viewport, keyboard/focus and visual matrix unverified.
16. League pagination: implementation and tests present; verify provider guarantees and error paths. Review noted an older eager-fetch league path may remain.
17. Navigator/filter/search: implementation and tests present; full behavior and accessibility unverified.
18. Honest session orders/cancel status: implementation and tests present; verify partial/failed cancellation and UI synchronization. Review noted cancel-all wording may still need to identify LIVE account orders explicitly.
19. Replay/screenshots: partial. Existing report is historical and not a fresh passing run. Reproduce offline QA and complete the planned matrix/manual visual review. Previous report showed missing PUBLIC labeling; selector drift was suspected, not confirmed.
20. Documentation/release gates: partial. `docs/verification/terminal-acceptance.md` was not found. Record actual test, safety and visual evidence before release.
21. Authenticated working-order overlay: separately gated and optional. Do not implement or enable without the plan's requirements and separate authorization.

## Safety and workflow

Start DRY, disconnected and disarmed; never infer or upgrade mode, weaken main-process authorization or bypass order safeguards. No real signing, account mutation, live order, test funds or live validation without explicit owner authorization. Automated QA must be offline/DRY-only with workspace-local artifacts and throwing account/trading stubs. Keep credentials out of renderer, storage, logs and artifacts. The full S1–S13 boundaries in the accepted plan are authoritative.

Before editing, inspect `git status --short` and preserve all user changes, including untracked implementation files. Do not use destructive cleanup or stage unrelated work. Work within the current workspace. Do not claim LIVE readiness until the plan's release gates and independent safety reviews actually pass.
