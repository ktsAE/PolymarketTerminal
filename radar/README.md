# Radar

A terminal scanner for unusual activity across Polymarket: open-interest jumps, volume spikes, fast price moves, and large fills
from new or thin wallets. Zero dependencies, runs in any terminal, uses little CPU and RAM.

```
npm run tui                 # the live scanner (polls every 2 minutes; --interval S, --no-news)
npm run scan                # one poll, print one frame, exit (good for logs and screenshots)
npm run test:tui            # drives the real TUI through a pseudo-terminal against live data (needs network)
```

Keys: `↑↓` (or `k` up) move · `PgUp PgDn g G` jump · `1`-`9`, `0` or `Tab` switch tabs · `w` New tab (scans new markets) · `j` Jumps tab (scans for calm-then-jump moves; `j` no longer moves down) · `f` cycle category filter · `h` load the selected event's top holders · `b` show/hide bots and market makers · `o` show the selected link · `r` refresh now · `q` quit.

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

`p` on any event (or `npm run radar -- decide <event-slug>`) builds one verdict per market of that event. TUI tab `6`.

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
* `npm run test:tui` drives the real TUI in a pseudo-terminal including `h` and `p`.

## Search and News (`newssearch.ts`, `newsview.ts`)

* `/` opens a search prompt (Search tab, `7`): type part of a market name, Enter. While typing, letters like `q` and `p` are text. Esc cancels. Results are events by volume with open/closed state.
* `n` on the selected event from any tab (Anomalies, Games, Big prints, Holders, Decision, Search) opens the News tab (`8`):
  the market's deadline, oracle history (`proposed > disputed > ...`) and bid/ask, then headlines from the last 7 days. `o` shows the selected headline's link.
  CLI equivalent: `npm run radar -- research <event-slug>`.
* Sources are keyless Google News RSS and Bing News RSS, merged, de-duplicated and sorted newest first. If a source fails it is named on screen, and if both fail the tab says so:
  an empty list is never presented as "nothing happened". Headlines are leads to read; they decide nothing.
* The query is the market title without placeholders, dates and question words ("Will 1win launch a token by ___?" -> "1win launch a token").
  Google News links are redirects; the headline's publisher comes from its title suffix, Bing's from the unwrapped link.
* Not wired up (needs an account or key): X/Twitter search (`xurl` + X API), PandaScore results, a Solana RPC. See the research notes for why each would help.

## Edge scan (`edges.ts`) - `e`, Edge tab `9`, `npm run radar -- edges`

Screens every active event (busiest 400 by 24h volume by default) for STRUCTURAL edges, then re-prices the best ones from live order books.
The list is saved to `.radar/edges.json` each run. `p` on a row opens the Decision view, `n` the news, `o` the link.

| TYPE | meaning | pays |
| --- | --- | --- |
| LADDER | thresholds or dates priced out of order: buy YES on the easier rung and NO on the harder one | at least $1 for less than $1 |
| SUM>1 | mutually exclusive outcomes (negRisk events) whose YES bids add up to more than $1: buy NO on all | at least n-1 for less |
| SUM<1 | the same outcomes with YES asks adding up to less than $1: buy YES on all (LOW confidence) | $1 only if a LISTED outcome wins |
| REF | a token-FDV rung priced outside the model's fair range from an external DEX price (`.radar/refs.json`, see Reference prices): a model call, LOW confidence, shown in yellow with `~` before its edge | the near edge of the fair range: NOT guaranteed |

REF rows only appear for events you mapped in `.radar/refs.json`; nothing is mapped automatically. When the scan sees token FDV / market-cap / price
ladders with no entry, the Edge tab prints one dim line `N token markets have no reference price (add to .radar/refs.json)` and `edges` lists their titles.

What the columns mean: SCREEN is the edge on gamma's quotes (cheap, can lag). LIVE is the edge on the real order books (STALE = it was gone). `$@DEPTH` is the profit if you buy
everything available at the best prices: "+90 points on $0 of depth" is not an opportunity, so the list is ranked by this, not by points.

Rules baked in after real mistakes:
* A date ladder needs labels that ARE dates and strictly different deadlines. `Date.parse("March 31")` assumes the year 2001; year-less labels are placed with the market's own deadline instead.
  People's names, "50+ bps" or "↓$600B" labels under one shared deadline are not ladders (they produced fake +90 point "arbitrage").
* A candidate with 25+ points of edge is flagged SUSPICIOUSLY LARGE: on a liquid market that is almost always a misread rule, source or deadline.
* Everything is before fees and assumes every leg fills. A set that needs ten legs to fill together carries leg risk; a ladder only pays if both markets settle from the same facts.
* "Nothing structural right now" is the normal answer for an efficient market, and on 2026-11-01 the scan found only micro-depth leftovers. No forecasting edge is claimed anywhere in this list.

## Forward test: logger, ledger, X log (`forward.ts`, `ledger.ts`, `xaccounts.ts`) - Ledger tab `0`

Every claim of a betting edge has to survive a forward test on data logged before the games were played. The pipeline:

1. **Snapshot** (`forward-log`): every upcoming moneyline (esports series plus NBA/NFL/NHL/MLB and the big soccer leagues) starting in the next 12h is
   captured once per window: T-8h (6.5-9.5h before start), T-2h (1.5-2.5h) and T-5m (0-10 min). A line holds the live CLOB bid/ask/mid per outcome,
   24h volume and the top-10 holders. Markets with a one-sided book are skipped. A cid+window is never written twice.
2. **Settle** (`forward-settle`): started markets are looked up until they close; the payout vector is logged once per cid (an even split = void).
3. **Score** (`ledger`, Ledger tab `0`): five strategies fixed in code before any data existed (fade-move, follow-move, favorite, underdog,
   top-holders-lean), every fill at the T-5m ask. Per strategy: n, hit rate next to its break-even (mean fill price), ROI per $1 and a 99%
   bootstrap CI that resamples whole game days.
4. **X log** (`x-add`, `x-poll`): public posts of hand-picked accounts, read for free through r.jina.ai (profiles only, about 5 recent posts per poll).
   `firstSeenAt` is the only time a scorer may use; a time claimed in a post never counts.

```
npm run radar -- daemon [--every 30]   # loop: snapshot every N seconds (default 30), settle every 5 min, poll X handles every 15 min,
                                       #       new-market scan every 10 min, new-market scoring every 30 min,
                                       #       jump scan + log every 5 min, jump entries every cycle, jump settle every 15 min
npm run radar -- forward-log           # one snapshot pass
npm run radar -- forward-settle        # one settle pass
npm run radar -- ledger                # score the logs; says "no data yet" until there are snapshots
npm run radar -- x-add <handle> [note] # add an account to .radar/x_accounts.json
npm run radar -- x-list                # accounts and how many posts each has logged
npm run radar -- x-poll                # one poll of every account
```

The daemon prints one status line per cycle. A failing step (network, rate limit) is reported on that line and the loop goes on. Ctrl-C stops it after the current step (twice forces it).
Keep `--every` at 300 seconds or less: the T-5m window is 10 minutes wide.

Logs live in `.radar/forward/snapshots.jsonl`, `.radar/forward/results.jsonl` (override the directory with `RADAR_FORWARD`) and `.radar/x/posts.jsonl`,
with the account list in `.radar/x_accounts.json`. `.radar/` is gitignored: the logs stay on this machine.

**An edge is claimed only by the ledger verdict.** A strategy reads `EDGE` only when it has n >= 300 settled bets AND the lower bound of its 99%
day-clustered CI of ROI is above 0; until then it reads `NO EDGE PROVEN`, whatever its hit rate looks like. These are paper results at the quoted
ask, before fees and slippage. Do not change a strategy after looking at its results: a strategy tuned on the logs it is scored on proves nothing.

## New-market watcher (`newmarkets.ts`) - New tab `w`, `new-scan`, `new-score`

Markets created in the last 24h whose **first hour** of trading looks unusual. The scanner lists new markets by creation time (gamma,
`closed=false`, volume >= $1k), drops crypto up/down candle markets, takes the busiest 150, and reads their **taker fills only** (with both
counterparties included every fill appears twice and net flow cancels to ~50/50). For the biggest early wallets it looks up the first
Polymarket activity to get account age (at most 80 lookups per scan, cached for the process).

Each market gets plain behavior labels and a score; it is flagged at score >= 4. The labels, all fixed in `NEWMARKET_THRESHOLDS` before any outcome data:
`one-sided flow 91% to Yes`, `top wallet 64% of volume`, `accounts under 30d old 45% of volume`, `price drift 14 pts toward Yes` (only scored when the
move goes with the flow), `largest print $3k (30% of volume)`, `$30k in first hour`. Fewer than $1k or 5 fills in the first hour scores 0. A market with
more fills than the scanner pages through is counted as "too busy" and not scored.

```
npm run radar -- new-scan [--hours 24 --top 20]   # scan once, print the ranked rows with reasons and links, append flagged ones to the forward log
npm run radar -- new-score                         # fill in +1h/+6h/+24h prices and resolutions for logged markets, print the tallies and paper ROI
```

The New tab (`w`) scans the 60 busiest new markets (about a minute) and shows the flagged ones: age, score, 60-minute volume, top-wallet share,
new-account share and lean (side and its share of flow). The detail pane lists the reasons. `p` decides and `n` searches news on the selected
market's event, `o` shows its link. Opening the tab reuses a scan under 10 minutes old; `w` on the tab rescans. Every TUI scan also logs its flagged lines.

Forward log, in `.radar/forward/` (gitignored, `RADAR_FORWARD` overrides the directory):
* `newmarkets.jsonl`: one line per flagged market per hour (cid + hour bucket is never written twice): features, score, reasons, leaning side, and the
  live bid/ask/mid of the leaning outcome at capture.
* `newmarkets-results.jsonl` (append-only): the leaning-side price of the last taker fill at +1h, +6h and +24h after capture (written once the horizon
  has passed), and the resolution payout. `new-score` reports continuation vs reversal against the capture mid, and the ROI of buying one share of
  the leaning side at the capture ask held to resolution, before fees.

**Honesty rule.** A flag describes trading behavior, never who traded or why: it is not evidence of insider trading, and the code never says so.
No edge is claimed until the forward log shows one: the tallies are read only after enough flagged markets have resolved, and the thresholds are
not tuned on the log they are scored on (the event study owns any revision). Markets that resolve within the scan window drop out of `closed=false`.

## Calm-then-jump (`jump.ts`) - Jumps tab `j`, `jumps`, `jumps-settle`, `jumps-score`

Finds markets whose price jumped 15+ points in the last 30 minutes. The scan reads the busiest ~400 active binary markets, keeps those whose
gamma 1h change is 5+ points, confirms each on CLOB price history (outcome 0) and reads both books plus one page of taker fills.

The rule is **frozen** in `jump.ts` (constants and strategies were fixed before any forward data; do not tune them on the log):
* **calm rule**: the 24h before the reference point moved within 10 points (at least 3 price points), and outcome 0 moved 15+ points between
  its price 30 min ago (`pRef`, inside 0.10-0.90) and now (`pNow`).
* **loose rule** (`calm=false`): the same 15-point move from a reference at most 6h older than 30 min ago, no calm requirement.
* Each flag carries direction, `pRef -> pNow`, taker volume over 30 min, `freshShare` (share of 30-min buy dollars from wallets new to the market;
  `-` when the market's history is longer than one page of fills) and the books at detection.

```
npm run radar -- jumps [--top 25]   # one live scan, printed only (not logged): rows with direction, pRef->pNow, volume, freshShare, link
npm run radar -- jumps-settle       # write result lines for flagged markets that have resolved
npm run radar -- jumps-score        # score the five frozen strategies on the log; says "no data yet" on an empty log
```

The **daemon** is the logger: it runs the scan and appends new flags at most every 5 minutes (one flag per market per 24h), captures the entry
books of each flag 5-15 minutes after it (every cycle), and settles results at most every 15 minutes. A failing step is reported on the status line
and the loop goes on. The log is `.radar/forward/jumps.jsonl` (flag, entry and result lines; `RADAR_FORWARD` overrides the directory), gitignored with the rest of `.radar/`.

The Jumps tab (`j`) shows the last scan: DIR, PRICE 30M (`pRef->pNow`), RULE (calm/loose), VOL30M, FRESH and the market, biggest move first.
Before the first scan it says `press j to scan`; the scan runs in the background with its progress on the title line, and a new scan supersedes a
running one. Opening the tab reuses a scan under 5 minutes old; `j` on the tab rescans. `p` decides, `n` searches news, `o` shows the link of the
selected row. The TUI never writes the log. The Ledger tab (`0`) adds a second block below the paper ledger with the `jumps-score` report.

Strategies (`JUMP_STRATEGIES`, scored at the entry ask, 99% day-clustered bootstrap CI): `jump-fade`, `jump-follow` (control) and `jump-follow-fresh`
on calm flags; `jump-fade-any` and `jump-follow-any` (control) on every flag. The loose pair was registered after seeing a backtest, which the score
output states.

**Leads, not signals; no edge shown.** A jump flag is something to look at, not a trade and not evidence of wrongdoing. **An edge is claimed only by a
score verdict**: `EDGE` needs n >= 300 settled bets and the lower bound of the 99% CI of ROI above 0; until then every strategy reads `NO EDGE PROVEN`.

## Terminal alerts without the daemon: `npm run radar -- watch`

Scans for 15-point price jumps every few minutes (`--every 5`) and prints a line plus a desktop notification (`notify-send`) for each new flag. Writes nothing to disk and needs
no daemon. Options: `--no-notify`, `--calm-only` (frozen calm rule only). Sports and esports events, with all their side markets (spreads, totals, props), are excluded by the scanner itself (`isSportsEvent` in jump.ts): a goal or a kill moves the price for a reason everyone sees. `--no-sports` is now redundant. Markets already at 0.97+/0.03- are skipped because
they have decided. A flag is a lead to inspect, never a trade signal; most jumps on live games are the game finishing.

Pre-game exception: the match-winner (moneyline) market of a sports or esports game that has not started (not live, not ended, start time still ahead) is scanned and its flags carry `pregame: true`.
Spreads, totals, props and anything in play stay excluded. Pre-game flags are scored in their own block (`jumps-score` prints it second) so they never mix with the non-sports results.
Untested: the backtest sample had no game start times, so there is no pre-game-only backtest; an earlier esports line-move test (fade, last ~8h before kickoff) was positive but not significant.
`watch --no-sports` hides pre-game flags too.

## Polymarket Data API v2 (v1 was retired on 2026-11-02)

Every `data-api.polymarket.com` v1 route now answers HTTP 410 ("Data API v1 has been retired"). The radar client (`radar/polymarket.ts`) speaks v2 through one helper, `dataPage`:
responses are `{ data, pagination }` in snake_case (converted back to the camelCase the rest of the code reads), markets are selected with `condition` (not `market`), and paging is by
opaque `next_cursor`: v2 rejects `offset` and ignores time-window parameters, but has no 10,000-row cap. Replaced routes: `/traded` -> `/v2/user-stats` (`data.trades`),
`/closed-positions` -> `/v2/positions?status=CLOSED`, `/v1/leaderboard` -> `/v2/leaderboard`. A 410 now fails at once as "endpoint retired".
Not ported: the Python research scripts (`holders-study.py`, `surge-study.py`, `newmarket-study.py`, `wallet-form-study.py`) still call v1 in their `fetch` step, so they cannot re-download until ported; their cached data and `report` steps are unaffected.

## Holders for any market of an event

`h` loads the busiest market of the selected event as before, but the Holders tab now lists every open market of the event (spreads, totals, props included).
`]` / `[` step to the next / previous market, `}` / `{` jump to the next / previous market TYPE (moneyline, spreads, totals...), which is what makes a game with hundreds of markets navigable.
The header shows `market 3/425 · spreads`. Each market is profiled the same way (HUMAN / NEW? / ALGO / MM / BOT).

## Wallet X-ray (`x`, `npm run radar -- xray <0x address>`)

The real record of one wallet, with every position counted (Data API v2 `user-pnl`, open and closed positions, recent fills). Profile pages and tracker sites compute win rate and profit factor on CLOSED
positions only, so open losers never enter them: a "profit factor 3 and 65% win rate" can sit next to a negative net PnL. The X-ray prints the closed-only figures next to the all-in ones and says so
when they disagree. It shows: all-in PnL split into trading and income (referral, rewards, yield, rebates), return on volume, 7/30/90-day windows, deepest fall and green days, closed positions (win rate,
profit factor, how much one win contributes), open positions (value, unrealized, how many are under water, profit factor with them counted), and the maker share of the latest 1,000 fills (over the hours that
span; a recent window, not a lifetime figure). Open it from Holders (select a wallet, press `x`), from anywhere by pressing `/` and pasting a `0x…` address, or from the CLI.
It describes results at that wallet's own prices: a copier would not earn the same, and the notes never say why a wallet traded.

## Cost of a trade (COST block in the Decision tab, `radar/cost.ts`)

For the selected market the Decision tab now prints what $50 and $500 would really cost, buying YES and buying NO: shares, average price after walking the book (slippage vs the best price), the taker fee
(fee = shares x rate x p x (1-p); rate by category: crypto 7%, sports/economics/culture/weather/other 5%, finance/politics/mentions/tech 4%, geopolitics 0%; resting orders pay none), the probability you need
to break even, and how much selling straight back would lose. The fee category is ESTIMATED from the event's tags: check the market page before trading size. Example, a 2-cent-wide sports book at 50 cents:
buying and immediately selling $100 loses about 8.8% (4% spread plus two taker fees). For a small account that is the number that decides whether anything can pay.

## Wallet watchlist (`a`, `wallet-add`, `wallet-watch`)

Press `a` on a holder (or in an X-ray) to add that wallet to `.radar/wallets.json`; or `npm run radar -- wallet-add <0x…> [note]`, `wallet-list`, `wallet-remove <0x…>`.
`npm run radar -- wallet-watch [--every 120] [--no-notify]` checks the list every N seconds (minimum 30), prints each new trade with the market link and sends a desktop notification (`notify-send`).
The first pass only records what is already there, so old trades never alert. The list is re-read each pass, so adding a wallet from the TUI takes effect without a restart. Backtests found that following
wallets does not pay (HOLDERS_STUDY.md), so a notice is a prompt to look at the market, not a signal. Searching (`/`) with a `0x…` address anywhere in the box opens that wallet's X-ray.
