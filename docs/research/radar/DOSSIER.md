# Radar research dossier: esports match-fixing ("322") and insider flow on Polymarket

Retrieved 2026-10-31. Status: decision-grounding research, not an implementation or a validated detector.
Claims are marked [source], [measured] (our own data pull, code in session) or [derived] (arithmetic on the others).
Allegations are allegations; only sanctions/charges named as such are findings.

## 1. What is documented

Esports fixing (ESIC = Esports Integrity Commission)
- NOMERCY (CS2, Tier-2 LAN, Mar 28 2026): ESIC says betting intelligence identified a high-value combination wager on a -9.5 round
  handicap across all four matches; every result met it. Reported accumulator about $57k with a potential payout over $4.5M. Lifetime ban for
  player kzy (Oct 2026). [Dexerto 2026; ESIC]
- ATOX (CS2, ESL Pro League S20 vs Falcons): ESIC circulated a preliminary notice via its SBAN (Suspicious Betting Alert Network), then an
  anti-corruption supporter supplied statistical data; admissions extracted; 3 lifetime bans, others 8 months to 3 years. [ESIC public report, May 2025]
- StarCraft II "Firefly"/"Jim": bettor placed pre-match wagers on Firefly to lose, often exact map score or heavy handicap, across 7
  tournaments; Firefly lost every flagged series, often by the exact score; kick-back transfers hours later. Trigger was a Reddit thread; ESIC then
  circulated SBAN and operators returned correct-score wagering data. [ESIC public report, Jul 2025]
- Dota 2 EWC 2026 (PlayTime vs Team Liquid, Jul 7): a coach/player agreed to a 0-2 loss for payment; the attempt FAILED (series ended 1-1). Lifetime
  ban and 5-year ban. Evidence included draft and gameplay observations, device and financial data, multi-source betting intelligence. [ESIC via vptop]
- Origin of "322": Dota 2, Jun 14 2013, player Solo bet $100 at 3.22 against his own team. [Rivalry]
- Sportradar 2025: about 100,000 esports matches monitored, 34 flagged for abnormal betting patterns (41 in 2024), 0.03% suspicion rate. Triggers:
  unusually high bets, or smaller coordinated wagers across several bookmakers. [Esports Insider 2026-02]

What this does and does not support: documented cases are real and mostly Tier-2/regional CS2 and Dota. The regulated-book detection rate is tiny (0.03%).
"A lot" of Tier-2 throwing is plausible but NOT established by what we found; fixing sold into unregulated Asian books is invisible to these counts.

Insider-flow cases outside esports are in the earlier chat summary (Maduro, Iran, Google Year in Search, Ballon d'Or 2026, etc.).

## 2. Detection methods that exist

- Bookmaker side (industry standard): cross-operator odds monitoring (Sportradar UFDS: 600+ operators), SBAN alerts among sportsbooks/organizers.
- Academic/on-chain: Mitts & Ofir (Harvard CorpGov, Mar 2026): five signals (cross-sectional bet size, within-trader bet size, profitability, pre-event
  timing, directional concentration). Cambridge MPhil (Jun 2026): five trade-level detectors + wallet synchrony + USDC funding tracing; recovered 16 of 22
  reported insider entries vs 1 for the best causal baseline (ground truth = reported cases; a thesis, treat as indicative).
- Telemetry: we found NO validated public model for detecting match-fixing from in-game data. Closest: MOBA griefer/"actor" identification (ActorLens,
  arXiv 2307.09699) and Riot's intentional-feeding detection. In-game throw heuristics (deaths/min, draft/item anomalies, eco rounds) are practitioner
  folklore until validated against ESIC-labelled matches.
- Polymarket itself: surveillance with Chainalysis/Palantir, 90+ referrals, 315+ wallet detail disclosures. Its findings are not published in real time.
- Competitor: onchainpoly.com (smart-money leaderboards for Polymarket esports, 50,976 wallets, PnL-ranked). It is a copy-trading/analytics product, not
  an integrity radar.

## 3. Data available

- Polymarket Gamma: events tagged esports; per-market sportsMarketType (moneyline, child_moneyline, totals, map_handicap, round_handicap_game_N,
  round_over_under_game_N, dota2_game_ends_daytime, dota2_both_teams_roshan), gameStartTime, volume, resolution source (Liquipedia, HLTV).
- Polymarket Data API v2: /trades (market, user, side, filterType/filterAmount, start/end windows, 10000 limit, offset cap 10000), /activity (first-seen
  via sort ASC), /traded, /positions, /oi. CLOB market websocket: book, price_change, last_trade_price, best_bid_ask, new_market, market_resolved.
  A separate real-time trade-activity socket (RTDS) exists per third-party SDKs; NOT verified from the docs we read.
- Live in-game: PandaScore Low Latency Feed (LoL/CS2/Dota 2; internal use only; public streams lag 3-4 min), GRID Series Events (not in the Open Access
  program), Abios. OpenDota API is free for Dota. Pricing and ToS for all of these were NOT verified.
- Sharp-book prices: third-party Pinnacle esports feeds exist (PinnWire, KashRock, pnclAPI). Cost and ToS NOT verified.

## 4. Measured on Polymarket (Oct 10-31 2026 snapshot)

- 1,500+ esports events with a moneyline in about 3 weeks (our fetch cap). CS2 934 matches, $110M moneyline volume; median CS2 moneyline $13k
  (p10 $436, p90 $321k). 41% of matches had at least $20k moneyline volume. [measured]
- CS2 side markets (667 events): moneyline median $12,993; map winner median $5,403; map_handicap median $40; round_handicap and round_over_under
  median $0, only 1-2% reach $1k. [measured] Meaning: fixers' preferred exotic bets are almost untraded on Polymarket, so any size there is an
  immediate anomaly, but it is also not where fixers can extract much money.
- Sample of 300 resolved matches (248,527 taker trades): median 153 wallets and 434 trades per CS2 match; top wallet about 16% of volume. [measured]
- Taker positions overall are well calibrated (hit 52.2% vs 53.2% implied; z -3.4 from fees/spread). [measured]
- The first-look dollar-weighted "edge" on large underdog buys was ONE wallet (62% of the dollars in that bucket). [measured]
- Large underdog positions looked significant per position (z +4 to +5.6) but collapse when clustered per match-side (n=59, z +0.12; match-bootstrap
  95% CI includes zero). Many wallets piling on one winning underdog inflate naive z-scores. [measured]
- Wallet-level skill with at least 5 matches of $200+: 147 wallets, z>=3 observed 1 vs 0.2 by chance. Underpowered at 300 matches; needs months. [measured]

## 5. Base-rate arithmetic [derived from Sportradar 0.034%]

- 90% recall, 1% false-positive rate -> precision about 3% (about 10 alerts per 1000 matches).
- 90% recall, 0.1% FPR -> about 23%. 70% recall, 0.01% FPR -> about 70%.
- 50% precision at 90% recall needs FPR about 0.03%.
Tier-2/3 base rates are higher than the all-esports 0.034%, but unknown. Implication: rank and explain, require multiple independent signals, never auto-accuse.

## 6. Open items

- Validate on ESIC-labelled matches (NOMERCY Mar 28 2026, ATOX vs Falcons ESL Pro League S20, PlayTime vs Liquid EWC Jul 7 2026) if they exist on Polymarket.
- Verify RTDS, vendor pricing/ToS (PandaScore, GRID, Pinnacle feeds), HLTV/Liquipedia terms.
- Months of backfill before wallet-level baselines mean anything.

## 7. First implementation and validation (Oct 31 2026)

Code: `radar/` (evidence ladder, SQLite store, Polymarket client, features, v0 indicator score, CLI). 171 tests pass.

Cases re-checked against on-chain data [measured]:
- Alliance vs Phantom Academy (United21, Aug 24): the X claim is exact (wallet 0x6d20c3...: 83 fills incl. maker side, 740,994 shares,
  cost $348,992, avg 0.471, proceeds $740,253). Fix unverified; wallet is an established large bettor (423 markets, 339 positions of $5k+,
  profit +$6.4M, profit-rate z -2.2). Taker-only data had shown only $47.9k of it.
- CTRL vs 9INE (organizer ban, market voided 50/50): all flow in play ($40 pre-start), money on the favourite; score 0.
- NOMERCY x4 (ESIC-proven, Mar 28) and PlayTime vs Liquid (ESIC-proven attempted fix, failed 1-1) exist on Polymarket: score 0 on all five.
  In NOMERCY's matches the opponent was already a heavy favourite (0.8-0.97) and Polymarket money followed it.

Conclusion: Polymarket flow does not reveal Tier-2 fixes; the fixing money is on sportsbooks. The Radar needs cross-venue odds, in-game
telemetry and social/news ingestion. Polymarket remains useful as the venue to trade on and for insider flow outside esports.

Evidence tiers observed this month: ESIC final ruling (NOMERCY), organizer ban without documents (United21/CTRL), analyst allegation with bet
figures (EPL 35 LiXO vs Nemiga), first-hand player allegation without artifacts (6666), community accusation with an on-chain-verifiable bet
(Alliance). The registry (radar/cases.seed.ts) records each at the tier its sources justify.

Limits: profit-rate z is inflated for scalpers; the 0.03-0.97 band and all thresholds are untuned; X posts and the ICT Academy item were not
retrieved (no X access configured; ICT Academy not identified).

## 8. Pivot: a market-wide scanner TUI (Oct 31 2026)

The product is a Bloomberg-style terminal scanner, not an esports-only tool. Esports integrity stays as the "Integrity leads" tab.
Data sources checked live: Gamma `events?order=volume24hr` gives event-level openInterest, volume24hr/1wk, liquidity and market price moves
for the 300 busiest events in 3 calls; Data API `/trades?filterType=CASH&filterAmount=2000` gives ~1000 large fills (~2h) per call.
Polymarket exposes no OI history, so OI deltas come from our own snapshots (SQLite).

Noise finding [measured]: the first version flagged 68 events, mostly live games and same-day markets whose price/volume swings are structural.
Switching those rules off for games (any market with a sports market type or game start time; 130 of the top 300 events) and for markets
expiring within 36h cut it to 6 watch-level events, leaving geopolitics/politics/economy markets at 7-46x normal volume.

Live OI check [measured, Oct 31 2026 13:54 -> 14:04 UTC]: with 9 minutes of own snapshots the 15-minute OI rule fired on real data. Every
top OI hit was a sports game (open interest rises around kickoff); no non-game market had an unusual OI move in that window. Games are now
hidden from the default list.
