# Radar

A terminal scanner for unusual activity across Polymarket: open-interest jumps, volume spikes, fast price moves, and large fills
from new or thin wallets. Zero dependencies, runs in any terminal, uses little CPU and RAM.

```
npm run tui                 # the live scanner (polls every 2 minutes; --interval S, --no-news)
npm run scan                # one poll, print one frame, exit (good for logs and screenshots)
npm run test:tui            # drives the real TUI through a pseudo-terminal against live data (needs network)
```

Keys: `↑↓ / j k` move · `PgUp PgDn g G` jump · `1`-`5` or `Tab` switch tabs · `f` cycle category filter · `h` load the selected event's top holders · `b` show/hide bots and market makers · `o` show the selected link · `r` refresh now · `q` quit.

Tabs: **1 Anomalies** (non-game events with reasons and an OI sparkline), **2 Games** (live and next-24h games with kickoff countdown, pre-game line moves, OI and fills),
**3 Big prints** (large fills with the wallet's history: NEW / THIN / WHALE), **4 Holders** (top holders of the selected event, see below),
**5 Leads** (ESIC and news inbox, see below).

## Holders: people, not machines

`h` on any event loads the top holders of its busiest market (about 12 per side) and profiles each wallet in a few seconds (cached 12h):
current position and unrealized PnL, Polymarket's own all-time and 7-day PnL, markets traded, events per day, and a verdict:

| WHO | Meaning |
| --- | --- |
| HUMAN | low cadence, modest breadth, no reward payouts |
| NEW? | too little history to say (kept in the people list) |
| ALGO | some automation signs, not conclusive (e.g. 1,000+ markets, or 5+ new markets a day) |
| MM | looks like a market maker / rebate farmer: liquidity-reward and rebate payouts, buying and selling the same market within minutes, tiny fills |
| BOT | clearly automated: very many markets, hundreds of events a day, seconds between events, merge/split operations |

By default only HUMAN and NEW? rows are shown; `b` adds the machines, and the detail pane lists the reasons behind every verdict.
A `!` marks positions the wallet never bought at a price (shares transferred in). `npm run radar -- holders <slug> [--all]` prints the same table.
This is a screen built from activity patterns, not an identification; PnL is Polymarket's figure, which includes market-making profit.

What it flags (all explained on screen; none claims intent):

| Signal | Meaning |
| --- | --- |
| OI++ / OI+ / OI- | open interest up >=15% / >=5% (or >=3% over 15 min) / down >=15%, with a dollar floor. Needs history: Polymarket exposes none, so the app builds it from its own snapshots (15-minute signals after ~8 min of running, hourly after ~30 min) |
| VOL++ / VOL+ | 24h volume 6x / 3x the average of the previous six days |
| PX1H / PX1D | price moved >=10% in an hour or >=25% in a day, with real volume |
| CHURN / THIN | volume several times open interest / liquidity thin against volume |
| FILLS / NEW$ / CLUSTER | many large fills in the last hour / money from new or thin wallets / 3+ such wallets on one outcome |

Live games and markets expiring within 36 hours have their price and volume rules switched off (their swings are normal). Games are also hidden from the list by default (`g` shows them): in a 9-minute live check every OI jump in the top results was a sports game, where OI rises around kickoff.

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

## Decision tab (`decide.ts`, `decide-data.ts`) - what to buy or sell, and why

`d` on any event (or `npm run radar -- decide <event-slug>`) builds one verdict per market of that event. TUI tab `6`.

What it will call an edge, and nothing else:

1. **ARB** - prices of a ladder (`FDV above $30M / $45M / $70M`, `launch by Oct 31 / Nov 30`) that are out of order. Buy YES on the easier rung
   and NO on the harder one for less than their guaranteed payoff. No model, but both legs must fill and the markets must settle from the same source.
2. **BUY YES / BUY NO (low confidence)** - only for token-FDV ladders, from an external DEX price (`.radar/refs.json`). The fair probability is a *range*
   (volatility 0.5x/1x/1.5x, with and without a drift term); a market is only called mispriced when it sits outside the whole range by 5 points, and the
   depth within 3 points of that price is shown, because an edge you cannot buy at size is not one.
3. **WATCH** - for "launch by date" markets where the facts can be checked but the ruling cannot be modelled (a checklist is printed), and for markets where a
   top wallet's name closely matches the watchlist. Never a trade by itself.

Everything else is **NO EDGE** or **AVOID** (closed, unpriced, or already priced at 97%+). If the reference price cannot be read the decision says so instead of
reporting "no edge" as a verdict.

Wallet findings are **leads, not signals**. The backtests (`docs/research/radar/HOLDERS_STUDY.md`) found no measurable edge from following top holders or
from wallet form, so nothing about who holds what changes a BUY/SELL.

### Account age and names

* `CREATED` (Holders tab, Decision wallet table) is when the wallet's Polymarket profile was made (`/public-profile`), not its first trade. Under 30 days is
  highlighted; a new account holding $300+ becomes a `NEW` lead with its date.
* The profile also gives the display name, pseudonym, **linked X handle** and bio. There is **no e-mail** anywhere in Polymarket's public API, so matching uses these.
* `.radar/people.json` is the watchlist: `people add "Full Name" --org X --role Y --handle xhandle --alias "Nickname"`, `people list`, `people remove`,
  `people check <wallet>`. Scores: linked X handle equals a known handle 100, exact name 90, name contained 75, near-miss spelling 60, bio mention 40 (leads need 60+).
  Names under 5 letters never match. **A match means "look", never "this is that person"**: anyone can choose any display name.

### Reference prices

`.radar/refs.json` maps an event (substring of its slug) to a token mint; see `radar/refs.example.json`. This tool cannot tell which mint is the official one
(lookalike mints exist), so you set it and the `checks` you list are printed with every decision. "1 day after launch" is measured at 4:00 PM New York time on the
next day, daylight saving included (it is 21:00 UTC, not 20:00, after the clocks go back on the first Sunday of November).

### Limits worth remembering

* The model has no sell-pressure term (airdrop/sale unlocks, exchange listings) and the reference pool can be thin; both are printed as `CHECK`/`NOTE` lines.
* Books and trades are read for the two busiest markets of an event only (rate limit politeness); other rungs get quotes and the ladder check but no wallets.
* `npm run test:tui` drives the real TUI in a pseudo-terminal including `h` and `d`.
