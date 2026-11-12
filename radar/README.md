# Radar

A read-only terminal screener for Polymarket: where new accounts are putting money, who holds a market, what the order book looks like, what a trade would really cost, and a wallet's full record. It never places orders.

## Quick start

```
npm run doctor                 # probe the endpoints the radar needs (exit 1 if a core one is down)
npm run tui                    # launch the TUI (runs doctor first; --force starts anyway, --no-check skips it)
# 3 Newbies   markets ranked by money from accounts under 14 days old (scans on first open, 1-4 min; Esc cancels)
# Enter       -> 4 Holders: who holds the market, classified HUMAN / NEW? / ALGO / MM / BOT
# 8           -> Book: the live order book with the cost of a trade
# p           -> 5 Decision: model estimate of each market (not advice)
# x           -> 6 X-ray: the real record of the selected wallet
# ?           -> every key for the tab you are on · Esc closes · q quits
```

Requires Node >= 22.18. Local state lives in `.radar/` (gitignored). Footer on every screen: `↑↓ move · 1-9 tabs · Enter open · p decide · h holders · / search · ? all keys · r refresh · q quit`.

## Tabs

Switch with `1`-`9` or `Tab`. `↑ ↓ k` move, `PgUp PgDn g G` jump, `/` search (or paste a `0x…` address to open its X-ray), `o` shows the selected link, `r` refreshes, `n` follows a wallet from any tab.

- **1 Markets**: events with reasons for why they stand out (open-interest jumps, volume spikes, fast price moves, churn). OI signals need a few minutes of the app's own history. `Enter`/`p` decide, `h` holders, `f` category filter.
- **2 Games**: live and next-24h games with kickoff countdown. `Enter`/`p`, `h` as above.
- **3 Newbies**: reads the last 30 minutes of platform fills, looks up profile age, ranks markets by NEW$ (money from profiles under 14 days old), NEW/ALL wallets, SHARE, and LIFT (share vs the platform average). `*` after LIFT marks a small sample (under 5 new wallets or under $500). `Enter`/`h` opens Holders, `8` the book, `w` rescans, `Esc` cancels and keeps the partial table. A coverage line says how much of the money has a known age.
- **4 Holders**: market strip (bid/ask, depth, end date, oracle status), top holders with a pattern-based class, flow by class, and a CLUSTER line for 3+ same-side holders whose profiles were created within 24h. `[ ]` step market, `{ }` step market type, `b` show/hide bots and market makers, `x` X-ray, `a` follow, `p` decision, `8` book.
- **5 Decision**: one line per market of the event, ending in a model estimate: `LEANS X`, `ARB (est.)`, WATCH, NO EDGE, AVOID, with `EST.EDGE` and a cost-of-trade block ($50 / $500, slippage and taker fee). `h` holders of the selected row, `8` its book. Always labelled a model estimate, not advice.
- **6 X-ray**: one wallet with every position counted: all-in PnL, closed-only vs all-in win rate and profit factor, windows, open positions. OPEN figures are partial; a missing value reads "unknown, not zero". `a` follow.
- **7 Search**: `/`, type part of a market name, Enter. `Enter`/`p` decision, `h` holders.
- **8 Book**: live order book over the CLOB WebSocket (falls back to polling): ladder, volume clusters, prints, trade feed. `+`/`-` tick size, `c` re-centre, `m` shares/dollars, `t` cluster period, `s` tape filter, `i` flip outcome, `[ ]` step market.
- **9 Following**: wallets you follow (`n`, or `+`, then paste an address, a `polymarket.com/profile/0x…` link or a `polymarket.com/@name` link), their recent bets, PnL and holdings; refreshes every 90 s and sends a desktop notification on a new bet. `-` unfollows, `Enter`/`x` X-ray.

## CLI-only commands

`npm run radar -- <command>`:

```
doctor                          endpoint preflight
scan [--tab games|holders|decision|search|wallets --slug S]   print one frame and exit
newbies [--mins 30 --days 14 --min-new 3 --top 25]            the Newbies table
holders <slug> [--all]          the Holders table
decide <slug>                   Decision for an event
research <slug>                 deadline, oracle history, recent headlines
xray <0x address>               wallet X-ray
people list|add|remove|check    name watchlist (.radar/people.json): a match means "look", never "this is that person"
wallet-add | wallet-list | wallet-remove <0x…>      followed wallets (.radar/wallets.json)
wallet-watch [--every 120 --no-notify]              print and notify new bets of followed wallets
find <text>                     look up an event slug
```

## Retired from the TUI, still in the CLI

Big prints, Leads/news inbox, News, Edge, Jumps, New markets, Ledger. They found no edge and are no longer tabs. The commands remain: `edges`, `jumps`, `jumps-settle`, `jumps-score`, `watch`, `new-scan`, `new-score`, `forward-log`, `forward-settle`, `ledger`, `daemon`, `x-add`, `x-list`, `x-poll`, `news poll|list|dismiss`, `map <slug>` (experimental on-chain funding map), plus the older case registry (`cases`, `ingest`, `report`, `link`, `case-add`, `backfill`). Any unknown command prints the full command list.

## What this is not

- **Not trading advice.** Decision output is a model estimate; fees and slippage are estimates, and the fee category is inferred from tags.
- **No edge is proven.** Backtests and forward tests found no measurable edge from following top holders, wallet form, new-market flow, jumps or line moves. See the studies in `docs/research/radar/` (`HOLDERS_STUDY.md`, `SURGE_STUDY.md`, `ELO_STUDY.md`, `SOCCER_MODEL_STUDY.md`, `DOSSIER.md`). The ledger only reads `EDGE` at n >= 300 settled bets with a 99% CI above zero.
- **Labels are not accusations.** "New account", NEW, CLUSTER and HUMAN/ALGO/BOT/MM describe behaviour in public data. Most new accounts are ordinary people, promotions or referral waves; a profile creation date is not a funding trace; anyone can pick any display name. Nothing here says who traded or why.
- Wallet PnL and X-ray figures are at that wallet's own prices; a follower would not get the same fills.
