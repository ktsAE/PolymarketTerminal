# Does a DataGaffer-style soccer model beat the sharp closing line? (Nov 4 2026)

DataGaffer (datagaffer.com, one developer, paid) sells match simulations, team ratings (goals, shots, xG, pace, PPDA) and a "Value Finder" for club football.
It cannot be backtested directly: the free part is a current-ratings table with no history and no match probabilities, and its Accuracy page measures simulated vs actual score, not profit against a price.
So `scripts/soccer-model-study.py` builds the same kind of model from free data (football-data.co.uk: results, shots, shots on target, Pinnacle odds; 7 leagues, 2022/23 to 2025/26)
and tests it against Pinnacle's closing odds, the sharp benchmark (Polymarket soccer prices track it, tlafargue: median gap 0.7 cents). Rule frozen before any comparison (see the script header).

Result (walk-forward, 7,514 matches predicted; train 6,387 to 2024/25; test 1,127 of 2025/26, data ends 2026-01-15):

| | market (Pinnacle, margin removed) | model | 50/50 blend |
| --- | --- | --- | --- |
| log-loss, train | 0.9491 | 0.9828 (+0.034 worse) | 0.9612 |
| log-loss, TEST | 0.9528 | 0.9833 (+0.031 worse) | 0.9645 |

Betting where the model rates an outcome at least T above the market, at Pinnacle odds (bookmaker margin paid): every threshold lost on train (-13% to -18%); T=0.02 chosen on train;
TEST n=1,269 bets, ROI -17.5% [-26.6, -7.9], hit rate 21.4%. All seven leagues negative on test (-1.6% to -36%, small n each).

Verdict: no edge. The market was better calibrated than a goals-and-shots model on the same data, and following the model's disagreements lost money with an interval clearly below zero.
Limits: the stand-in is a simple model, not DataGaffer's (it adds pace, PPDA, league strength coefficients, a manager factor and betting-trend data that I did not have); Pinnacle odds are a proxy for Polymarket prices
(not compared match by match); the 2025/26 file ends 2026-01-15; one threshold family was tried. What would change the conclusion: DataGaffer's own pre-match probabilities, timestamped before kickoff, compared with Polymarket prices
over about 300 matches (needs a paid account).
