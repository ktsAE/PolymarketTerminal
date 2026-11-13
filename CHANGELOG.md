# Changelog

## 0.2.0 - 2026-11-12: Radar terminal screener

A read-only terminal screener for Polymarket (`npm run tui`, docs in `radar/README.md`). It never places orders and claims no trading edge.

### Added
- Nine tabs: Markets, Games, Newbies (markets ranked by money from new accounts), Holders (with flow by wallet class and a new-account cluster line), Decision (cost of a trade), X-ray (a wallet's real record), Search, live Book (WebSocket DOM with clusters, prints and trade feed), Following (follow by 0x address, profile link or @name).
- `npm run doctor`: probes every endpoint and its JSON shape before launch.
- `?` help overlay, Esc to cancel scans, "as of" times, standing "not advice" and "ordinary people, not evidence of wrongdoing" captions.
- CLI: `newbies`, `xray`, `map`, `wallet-add/list/remove/watch`, and the research commands.

### Security and reliability
- Terminal escape sequences and control characters in market titles, wallet names and headlines are stripped before drawing.
- 15 s HTTP timeout, no retry on 400/401/403, `Retry-After` honoured, a rate limiter that holds under concurrency.
- Atomic writes for the follow and people lists; a corrupt list is set aside, not overwritten.
- Crash guards on every background load and an unhandled-rejection handler that restores the terminal.
- Safer desktop notifications; news entity decoding can no longer produce control characters.
- Details: `docs/research/radar/mvp-audit/` (VERDICT, THREATS, FINAL).

### Removed from the TUI (still in the CLI)
- Big prints, Leads, News, Edge, Jumps, New markets, Ledger tabs; `surge.ts` and `surgelog.ts` deleted.

### Known limits
- Deferred: database pruning (the DB grows), follow-list caps, behaviour when the Gamma API drops mid-session.
- No license file yet; the repository is private.
