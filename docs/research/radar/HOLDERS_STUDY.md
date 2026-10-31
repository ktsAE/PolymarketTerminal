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
