# Security

## Reporting a vulnerability
Please do not open a public issue for a security problem. Use GitHub's private vulnerability reporting for this repository (Security tab, "Report a vulnerability"). Include what you saw, the steps to reproduce, and the version (see `CHANGELOG.md`). There is no bounty; I will acknowledge a report and fix real issues as time allows.

## What the project does with your data
- **Radar:** read-only. It calls Polymarket's public APIs, a public Polygon RPC (only for the optional `map` command) and, for the optional news feature, public RSS feeds. It needs no key and sends nothing anywhere else. Local state (watchlists, a cache database) lives in `.radar/` in the project folder and is gitignored.
- **Desktop terminal:** if you choose to connect, the private key is held in memory in Electron's main process for that session and is not written to disk. Live orders need an explicit arming step and are capped (default $25, `PM_TERMINAL_MAX_ORDER_USD`).

## Advice for users
- Never paste a primary wallet's key. Use a dedicated signer with a small balance.
- Do not commit `.radar/`, `.env*` or any credentials file. They are gitignored; keep it that way.
- Treat everything the radar shows as data from the public internet: market titles and wallet names are written by other people. The TUI strips terminal escape sequences before drawing them, but report any case that slips through.
- Wallet names and addresses are public information, but pairing them with labels can still mislead. Do not use the radar to accuse anyone.

## Known limits
See "Known limits" in `CHANGELOG.md` and the threat review in `docs/research/radar/mvp-audit/THREATS.md`.
