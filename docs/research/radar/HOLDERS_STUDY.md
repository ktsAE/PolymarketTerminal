# Do top human holders have an edge? (retrospective study, Oct 31 2026)

Question: if you take the top 10/20/50 holders of a market, drop obvious bots, and look at which side they hold, does that predict outcomes
better than the market price?

Reproduce: `python3 scripts/holders-study.py fetch` then `report` (about 10 minutes of polite downloading).

## Method
- Polymarket only exposes CURRENT holders, so past holdings are rebuilt from the full fill history (both maker and taker side) of markets that
  already resolved: net shares per wallet per outcome at time T. Splits, merges and transfers are not visible, so holdings are approximate.
- Signal `s` = (dollar share of the top-K holders on outcome A) - (market price of A at T). Edge = average of (outcome - price) in the direction
  of `s` (probability points; positive means following the holders beat the price), with a bootstrap 95% interval.
- Machines removed with: >=150 fills in the market, holding both sides (>=20% of the larger side), or heavy trading across the sample.
- "Prior winners/losers": wallets with >=5 earlier finished games in the sample and cumulative PnL above +$500 / below -$500, computed only from
  games that had resolved BEFORE T (no lookahead). Polymarket's all-time PnL cannot be used retrospectively: it includes the result being tested.

## Results
Slow markets (politics, geopolitics, tech, sports futures; one market per event, $150k-$2.5M): 57 markets, but only 24 were still undecided
(price between 5% and 95%) a week before resolution. 15-19 usable markets per horizon, intervals about +/-20 points. Inconclusive.

Esports game moneylines, 218 games (658k fills), T = 2 hours and 5 minutes before kickoff:

| group (top-20) | 2h before | 5 min before |
| --- | --- | --- |
| all holders | -0.4pp [-7.8, +7.2] | +2.3pp [-4.8, +9.5] |
| people only | +0.1pp [-7.5, +7.6] | +0.6pp [-6.3, +7.6] |
| prior winners | -0.6pp [-9.1, +7.9] | -2.2pp [-10.1, +5.7] |
| prior losers | -13.8pp [-23.2, -4.3] | -6.9pp [-15.4, +1.8] |

Top-10 and top-50 give the same picture. Baseline in the sample: always backing the favourite earned +4.2pp.

## What this supports
- No detectable edge from following the top holders, people-only, or proven winners. The intervals (about +/-7 points) mean an edge under ~5 points
  would not be visible with this sample.
- One lead: the prior-LOSERS group leans the wrong way, so fading them would have gained. Direction is negative in all 9 definitions tried and
  not explained by favourite/underdog (-15pp when they lean underdog, -13pp when favourite; baseline +/-4pp). But: 24 variants were looked at,
  the effect halves from the first half of games (-20pp) to the second (-8pp, CI includes 0), it is outside the shuffled-outcome placebo range
  ([-11.4, +10.0]) only slightly, and a 14-point edge is implausibly large. Treat as a hypothesis, not a finding.

## What would settle it
A forward test: record the holders, their PnL (Polymarket's figure AT that moment, no lookahead) and the price about 2 hours before each game, then
score the signal after resolution. Needs a few hundred games; Polymarket lists well over 100 a day, so about a week of logging.

---
# Part 2: wallet form (streaks, win rate, profit factor, Worlds form) and a subgroup scan (Oct 31 2026)

Reproduce: `python3 scripts/wallet-form-study.py fetch` then `report`. Data: 457 wallets that were top-20 holders in 36 finished Worlds LoL matches,
256 left after removing machines (>15 closed positions/day or tiny stakes), 69.5k positions, 51.5k bets with >=20 earlier game bets.

## Result: no usable edge
- Within-wallet, price-adjusted, next-bet ROI. Hot (3 wins) vs cold (3 losses): -12.6pp [-19, -6]. Win rate(20) >=60% vs <=40%: -7.9pp [-13, -3].
  Profit factor(20) >=1.5 vs <=0.8: -3.3pp [-7, +1]. 5-streaks: -13pp, wide. Direction is "form does not persist, if anything it reverses".
- Skill persistence (older half to newer half, 191 wallets): Spearman +0.06. Top fifth by old ROI earned -8.4% later vs -9.3% for the bottom fifth.
- Worlds-specific form (profit factor / ROI so far at Worlds): too few wallets with enough Worlds history (8-16); inconclusive, mostly negative.
- Subgroup scan (24 groups: game, entry price, stake size, streak states, Worlds): 0 groups with a 95% CI above zero. Baseline ROI -4.4% (fees/spread).
- Favourite bias in 392 games: +0.1pp [-4.5, +4.4] at 10 min before kickoff, +2.5pp [-2.4, +7.4] at 2 h. Nothing.
- Reading: the streak reversal is the usual "money follows hot hands, price already adjusts". It is not tradeable without a sign-stable test.

## Data traps (cost me three wrong answers; encoded in the script)
1. `/closed-positions` shows only sold/redeemed positions, so it is biased to winners: 76% win rate, +47% ROI. Impossible.
2. `/positions` holds the resolved-but-unredeemed ones (mostly losers) but reaches back further than the 250 newest closed rows. Merging both and
   cutting before the oldest closed row gives win rate 48.9% = entry price 48.9%, ROI -4.8%. That is the sanity check to pass before any test.
3. The H1 streak result flips from -12.6pp at a 12h gap to +60..70pp at 24h+. The two sources date positions differently (exact close time vs
   market end date at noon), so the gap changes which losers count as "prior". Treat the +60pp as an artifact: it would be a free lunch, so it is a bug.
   The sign-flip is itself the evidence that streak results from this data cannot be trusted either way.

## Where an edge could still be (untested)
- Lead/lag: price reaction after big prints by wallets with a *prior* (pre-game) record, measured on live data with timestamps (needs forward logging).
- Cross-venue gaps (Polymarket vs sportsbook/Pinnacle closing line) for esports: the only place with an external truth to compare against.
- Structural, not wallet-based: mispricing in correlated markets (match winner vs map handicaps/totals within the same event), checked for arbitrage.

---
# Part 3: price-band / calibration backtest across all categories (Oct 31 2026)

Reproduce: `python3 scripts/calibration-study.py fetch` then `report`.
Data: 4,302 resolved binary markets (volume >= $30k, 12-hourly YES price history), 4,702 market-horizon observations, 2,293 markets.
Test design: strategies fixed in advance, chosen on the older 60% of markets (by resolution time), then checked on the newer 40% (from 2026-04-01).
24 cells (category x T-3/7/14/30 days x four price bands), event-clustered bootstrap.

## Result: no price-band edge
- No cell had a positive 95% interval on the training half (0 of 24; about 0.6 expected by chance).
- Mean ROI across cells was -1.2% on train and +3.4% on test; train and test cell results correlate only 0.39, so nothing persisted reliably.
- A first look at ~1,300 markets showed one tempting cell (buy NO when YES is 5-15% two weeks out: +5.9%, CI [+1.5, +9.3]) among ~20 tried. It did not appear in the larger sample.
- All returns are before spread and fees (real fills 1-3 points worse), so any real edge would be smaller than shown.

## What is still untested
- Ladder arbitrage frequency (needs order-book history, which Polymarket does not serve retroactively: log it forward).
- Cross-venue gaps (Polymarket vs Kalshi/sportsbooks) on the same event.
- Resolution-rule risk (ambiguous wording) as a mispricing source: disputes are ~1-4% of markets and cluster in vaguely worded ones.

---
# Part 4: wallets by game/tournament, and a rating model against the closing line (Oct 31 2026)

## Wallet skill per game (256 people-like wallets, positions merged from /closed-positions + /positions)
Older half -> newer half ROI, wallets with 40+ positions in that game, permutation test on the rank correlation:
- CS2: 73 wallets, Spearman +0.17 (p=0.07); the top quartile by old ROI earned -4.4% later (all wallets -4.9%).
- Dota 2: 47 wallets, Spearman -0.21; top quartile -23.5% later (all -8.6%). LoL: 149 wallets, Spearman +0.01; top quartile -6.1% (all -3.6%).
- Tournaments with enough wallets show pooled ROI between -9% and +15% with 12-139 wallets each; no tournament-level pattern worth trading.
- Today in this sample: 7 of 198 wallets are on a 5-win streak and 18 on a 0-of-5 streak. Earlier tests found streaks do not predict the next bet.
External boards exist (polynode.io, pmwallets.com, onchainpoly.com, predictionist.com, 0xinsider.com). They rank wallets by results that already happened,
so they cannot show that skill persists; 0xinsider publishes a cohort test (S/A/B grades +1.57 points, CI [+0.32,+2.82]) with data at github.com/0xinsider/research: worth reproducing.

## Elo against the closing price (1,545 resolved esports moneylines with a price series, mostly CS2)
Reproduce: `python3 scripts/elo-vs-market.py fetch` then `report`.
- Closing lines are close to calibrated: underdogs priced 3-20% won 13.0% vs 13.7% priced, 20-35%: 26.4% vs 28.1%, 35-50%: 43.3% vs 42.3%. The underdog hint seen on 311 matches vanished at 1,545.
- Elo built only from these results (online, 24 K-factor): Brier 0.241 vs 0.225 for the closing line, so alone it is worse than the market.
- Betting the side Elo prefers when it differs from the market by 5+ points, at the closing price (before spread/fees):
  teams with 5+ prior results: older half n=30 ROI +17% [-31, +69]; newer half n=210 ROI +21% [-0.4, +45]. With 3+ prior results: older +0.2% [-26, +29], newer +9.9% [-6, +29].
  The regression coefficient on Elo, controlling for the market price, was +0.74 with CI [-0.48, +2.29] (n=311).
- Reading: the only estimate that is non-negative in every cut, but no interval clears zero reliably, and it improves as Elo gets more history. It is a lead, not a finding.
  The next step is a better rating source than 1,545 Polymarket results: HLTV / Oracle's Elixir / Liquipedia results back to 2023, then test on the same closing lines.

## Part 4: pre-game price jumps in esports and NBA (Nov 2 2026)

Question: in the hours before a game starts, does following or fading a 15-point price jump make money? Rule frozen before any return was computed
(`scripts/pregame-jump-study.py`): first jump of >= 0.15 within 30 minutes, reference price 0.10-0.90, trigger at least 20 minutes before start, entry 5-15
minutes later plus 1 cent, hold to resolution, older 60% / newer 40% split, bootstrap over start days. 2 strategies x 2 samples, nothing tuned.

| sample | strategy | older 60% | newer 40% | all |
| --- | --- | --- | --- | --- |
| esports, 21,192 games, 3,193 triggers | follow | -10.1% [-13.9, -6.1] n=2012 | -4.5% [-9.5, +0.7] n=1181 | -8.0% [-10.9, -5.0] |
| esports | fade | +7.1% [+0.7, +13.3] | -0.9% [-9.5, +7.9] | +4.1% [-1.1, +9.2] |
| NBA, 1,541 games | both | 7 triggers in total: NBA pre-game lines hardly ever jump 15 points | | |

Verdict: no edge. Following a pre-game jump loses in both halves (the interval excludes zero overall). Fading looked good on the older half but fell to
-0.9% on the newer half, the same shrink-with-more-data pattern as the other leads. The 1-cent spread is probably optimistic for thin esports markets, so real fade
returns would be lower. Not tested: NBA/soccer/other sports with enough triggers, and the order book at the time of the jump.

## Part 5: is it worth following wallets with a good profit factor and a green last 7 days? (Nov 3 2026)

Point-in-time test (`scripts/follow-winners-study.py`, rule frozen before any forward result): wallets are picked as of 2026-09-20 using only their daily PnL history up to that day
(Data API v2 `user-pnl`, which includes every losing and unredeemed position), then followed for 14 and 30 days. Population: takers in 120 random resolved markets that ended in the
4 days before the cutoff; 3,000 wallets sampled; 861 eligible (>= 60 days of history, >= 5 trades in the last 7 days, <= 40 trades/day = human-like, >= $2,000 volume in 30 days).
Selections: A green over 7 days (39%), B daily profit factor >= 1.5 over 60 days (13%), C both (10%, n=84 followed). Return = PnL per dollar traded. 6 comparisons + 2 rank correlations, all reported.
Trading-only PnL (`position_pnl`); using `economic_pnl` (adds referral, rewards, rebates) gives the same picture.

| forward | group | pooled return | share of wallets in profit | vs not selected | pooled return WITHOUT its single biggest winner |
| --- | --- | --- | --- | --- | --- |
| 14 days | C (PF >= 1.5 and green 7d), n=84 | +4.8% | 42.9% (others 29.7%) | +6.2% [-0.5, +11.3] | -0.2% |
| 14 days | B (PF >= 1.5), n=105 | +4.6% | 41.9% | +6.0% [-0.3, +11.1] | -0.2% |
| 30 days | C, n=84 | +6.5% | 39.3% (others 25.8%) | +7.6% [-1.0, +15.2] | 0.0% |
| 30 days | B, n=105 | +6.3% | 40.0% | +7.4% [-0.8, +14.5] | 0.0% |

Rank correlation of past profit factor with forward return: +0.089 (14d), +0.119 (30d); n ~ 725-765, so about 2.4 and 3.2 standard errors: real but weak persistence.

Reading: wallets with a good record are more likely to be in profit next (about 40-43% vs 26-30%), and lose less when they lose (median per-wallet return -0.6% vs -1.4%), so there is weak persistence in WHO does better.
But the average dollar return is carried by one giant winner in each group ($0.5M gain on $3.5M traded at 14d, $1.2M on $5.7M at 30d): remove that single wallet and the selected group's pooled return is
zero, and every confidence interval for the difference includes 0. The typical selected wallet still loses slightly. All numbers are THEIR results at THEIR prices; a copier enters later at worse prices
and pays the spread, so they are an upper bound for copying. Verdict: not shown to be worth following; weak ranking signal, no demonstrated copyable profit. Not tested: a second cutoff date
(replication), entry delay, position-level copying, wallets sampled other than from markets that ended near the cutoff.

Part 5 addendum: profit per volume (added after A-C were seen, so these are extra variants: 12 comparisons in total). D = profit over the 60 days before the cutoff divided by volume traded >= +3% (8% of eligible),
E = top 20% by that ratio (cut-off +1.06%), F = D and green 7 days. Same cutoff, same 861 wallets, trading-only PnL.

| forward | group | n | pooled return | share in profit (others) | vs not selected | pooled return without its biggest winner |
| --- | --- | --- | --- | --- | --- | --- |
| 14 days | D profit/volume >= +3% | 61 | +6.1% | 39.3% (30.5%) | +7.4% [-1.6, +13.2] | -0.04% |
| 14 days | E top 20% | 157 | +3.5% | 42.7% (28.0%) | +4.9% [-0.7, +9.8] | -0.6% |
| 14 days | F D and green 7d | 51 | +6.1% | 41.2% (30.5%) | +7.4% [-1.7, +13.0] | -0.1% |
| 30 days | D | 62 | +8.4% | 41.9% (26.0%) | +9.4% [-1.3, +17.7] | +0.3% |
| 30 days | E | 161 | +5.0% | 38.5% (24.3%) | +6.0% [-0.8, +12.8] | -0.3% |
| 30 days | F | 52 | +8.4% | 42.3% (26.2%) | +9.4% [-1.8, +17.9] | +0.2% |

Rank correlation of 60-day profit per volume with forward return: +0.065 (14d), +0.096 (30d) (profit factor: +0.089, +0.119). Median per-wallet forward return of group D is -2.1% (14d) and -0.8% (30d), no better than the others.
Profit per volume is not a better filter than profit factor. The gain comes from one wallet (RichieRicher, 0x361b16e3: profit factor 3.2 and +8.1% profit per volume before the cutoff, then +$496k on $3.5M traded in 14 days and +$1.19M on $5.7M in 30 days),
which every selection contains; without it each group's pooled return is about zero. One wallet is one observation: it neither shows the criteria work nor that they fail. A second cutoff date is the test that would (set `FOLLOW_T=2026-08-20` and run fetch, refetch, report).
