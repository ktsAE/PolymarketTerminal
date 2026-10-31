# Radar

A terminal scanner for unusual activity across Polymarket: open-interest jumps, volume spikes, fast price moves, and large fills
from new or thin wallets. Zero dependencies, runs in any terminal, uses little CPU and RAM.

```
npm run tui                 # the live scanner (polls every 2 minutes; --interval S, --no-news)
npm run scan                # one poll, print one frame, exit (good for logs and screenshots)
npm run test:tui            # drives the real TUI through a pseudo-terminal against live data (needs network)
```

Keys: `↑↓ / j k` move · `PgUp PgDn g G` jump · `1 2 3` or `Tab` switch tabs · `f` cycle category filter · `o` show the selected link · `r` refresh now · `q` quit.

Tabs: **Anomalies** (ranked events with reasons and an OI sparkline), **Big prints** (large fills with the wallet's history: NEW / THIN / WHALE),
**Integrity leads** (ESIC and news inbox, see below).

What it flags (all explained on screen; none claims intent):

| Signal | Meaning |
| --- | --- |
| OI++ / OI+ / OI- | open interest up >=15% / >=5% (or >=3% over 15 min) / down >=15%, with a dollar floor. Needs history: Polymarket exposes none, so the app builds it from its own snapshots (15-minute signals after ~8 min of running, hourly after ~30 min) |
| VOL++ / VOL+ | 24h volume 6x / 3x the average of the previous six days |
| PX1H / PX1D | price moved >=10% in an hour or >=25% in a day, with real volume |
| CHURN / THIN | volume several times open interest / liquidity thin against volume |
| FILLS / NEW$ / CLUSTER | many large fills in the last hour / money from new or thin wallets / 3+ such wallets on one outcome |

Live games and markets expiring within 36 hours have their price and volume rules switched off (their swings are normal); OI and fill signals stay on.

Surveillance toolkit for suspected match-fixing ("322") and insider flow on Polymarket.
It keeps **proven** and **alleged** cases apart, stores everything locally, and explains every flag.

```
npm run radar -- seed                      # load the evidence-graded case registry
npm run radar -- cases                     # list cases with their current evidence tier
npm run radar -- find "Alliance Phantom"   # look up a Polymarket event slug
npm run radar -- ingest <event-slug>       # fetch markets + all fills (both sides) + top wallet profiles
npm run radar -- report <event-slug>       # indicator score, reasons, largest positions, linked case
npm run radar -- link <case-id> <slug>     # attach a Polymarket event to a case
npm run radar -- backfill --max 20         # ingest recent resolved esports events
npm run radar -- news poll                 # read free feeds (ESIC, HLTV, Dust2, Dexerto, Esports Insider, Reddit RSS) into the inbox
npm run radar -- news list [--all]         # relevant leads with a SUGGESTED tier (never applied automatically)
npm run radar -- news dismiss <url>        # drop a lead
npm run radar -- case-add case.json        # record a reviewed case; tiers are validated against sources
```

The database lives at `.radar/radar.db` (override with `RADAR_DB`). Requires Node >= 22.18 (uses `node:sqlite`).

## Evidence tiers (`evidence.ts`)

| Tier | Meaning | Needs |
| --- | --- | --- |
| SANCTIONED | final ruling with published findings | integrity body / league / court / regulator, `documented: true` |
| ORGANIZER_ACTION | organizer punished, no documentation | authoritative source |
| INVESTIGATING | official investigation, no finding | authoritative source |
| ALLEGED_CONCRETE | named source gives checkable specifics | analyst/journalist/player + a non-"statement" claim |
| ALLEGED_UNSUPPORTED | named allegation, nothing checkable | named alleging source |
| RUMOR | community talk | anything |
| CLEARED | official body found no violation | authoritative source |

`store.addCaseEvent` rejects a tier its sources do not justify. `tierAsOf` returns what was known at a past time, so
backtests do not use hindsight. Only SANCTIONED/ORGANIZER_ACTION count as positive labels.

## Lessons baked into the code

- Fetch **both sides** of every fill. `takerOnly=true` hid a $175k resting order in the Alliance case.
- Unit of analysis is the **match-side**, not the wallet: many wallets on one winning underdog is one observation.
- Measure **peak** exposure; positions are sold/redeemed afterwards.
- Ignore fills priced outside 0.03-0.97 (settlement sweeping carries no information).
- Net context (frequent large bettor, two-sided activity) **per wallet**, never across wallets.

## Status (v0.1)

Indicators are not validated. On the five ESIC-sanctioned matches available on Polymarket (four NOMERCY, PlayTime vs Liquid)
the v0 score was 0 for all: the fixing money was on sportsbooks, so Polymarket flow alone does not reveal these cases.
Next sources: cross-venue odds, in-game telemetry, and social/news ingestion. See docs/research/radar/DOSSIER.md.

## News inbox (`news.ts`, `poll.ts`)

Free feeds -> keyword classification -> a reviewed queue. A feed item is a *lead*; it earns a tier only when you record a case with
sources that justify it. Suggested hints: ESIC final ruling -> SANCTIONED, ESIC interim/provisional -> INVESTIGATING, appeals -> none,
journalism -> none (find the primary source), Reddit -> RUMOR.

Feed access notes (checked 2026-10-31): ESIC's firewall blocks User-Agents that pretend to be browsers but allows an honest
`polymarket-radar/0.1`; Reddit rate-limits unauthenticated RSS hard (one subreddit per run is reliable; search endpoints return 403);
cyberscore, escorenews and several others return 403 and are not polled.
