# Do sudden volume surges predict Polymarket outcomes? (retrospective study, Nov 1 2026)

Question: when a market suddenly trades many times its normal hourly volume, mostly on one side, and especially when the flow is
concentrated in a few wallets or comes from wallets new to that market (the "weird new bet" / open-interest-spike pattern), does
following that flow beat the price? Previous studies in HOLDERS_STUDY.md found no edge from holders, price bands or streaks; this one
tests surges only.

Reproduce: `python3 scripts/surge-study.py fetch` (resumable, about an hour of polite downloading; cache in
`~/.hermes/cache/scratch/surge/`, never in the repo) then `python3 scripts/surge-study.py report`.

## Pre-registered rules (written and hashed before any trade data was downloaded or any return computed)

Data. Public endpoints only: gamma `/markets?closed=true&include_tag=true` for the universe, data-api `/trades?market=<conditionId>`
(taker fills, each trade counted once) walked backwards with `end` past the 10,000-offset cap, gamma `/public-profile` for account
ages on a 100-surge sample. USD of a fill = size x price.

Universe and sample. Resolved binary markets (two outcomes, payout exactly 0/1) with lifetime volume $10k-$750k. Scheduled end date on
one seeded random day per week from 2025-11-01 to 2026-10-31, plus every closed market whose scheduled end date is still in the future
(questions that resolved early, e.g. "by <date>" markets that happened). At most 2 markets per event. Stratified by category
(politics/geopolitics, crypto, sports, esports, other; from gamma tags) x scheduled life (< 7 days vs >= 7 days from creation to end
date), 240 per stratum, shortfall filled at random from the remaining pool, 2,400 markets requested. Markets whose fill history is
longer than 40,000 fills are dropped (counted), because the start of their history cannot be reached reliably.

Surge (frozen, from taker fills only).
- Baseline B(t) = median USD volume of the market's complete UTC clock hours from its first fill up to the hour that ends at or before
  t - 1h (zero hours included). At least 12 such hours are required, so surges in the first ~13 hours of trading are not detectable.
- (a) Volume surge at fill time t: trailing volume V(t) over (t - 1h, t] >= 8 x B(t) and >= $2,000. Only the FIRST t per market where
  (a) holds counts; the surge window is W = (t - 1h, t]. Later surges in the same market are ignored.
- (b) One-sided: >= 75% of the BUY USD in W is on one outcome. That outcome is the surge direction d.
- (c) Concentrated: the top 3 wallets (by USD, buys and sells) account for >= 50% of the USD in W.
- (d) Fresh share: share of the USD in W from wallets whose first fill in this market (within the downloaded data) is inside W.
  "Fresh" = fresh share >= 50%. Account age is NOT in this flag; it is checked separately on 100 surges.
- Young market: t - createdAt < 7 days.

Trade (what a follower could do). Entry time t + 5 min. Entry price = size-weighted average price of outcome d over all fills in
[t + 5 min, t + 15 min] (fills on the other outcome converted as 1 - price); if there are none, the first fill after t + 5 min within
6 h; otherwise no trade (counted). Cost = entry price + 1 cent spread penalty. Only entries with price 0.03-0.97 and entry time before the
market's close are traded. Exit = resolution: payout 1 if d won, 0 otherwise. Return = payout / cost - 1 per $1 staked (primary);
payout - cost in probability points (secondary).

Strategies.
- S1: follow every one-sided first surge.
- S2: S1 restricted to young markets.
- S3: S1 restricted to concentrated AND fresh surges.
- S4a/b/c: fade S1/S2/S3 (buy the other outcome at 1 - entry price + 1 cent). Controls, not tests.

Split and statistics. Markets ordered by close time (closedTime, else end date); test = the newer 40% of all usable markets, train = the
older 60%. Nothing is fitted; train is only a replication check. Event-clustered bootstrap (2,000 resamples, fixed seed). Three primary
tests (S1-S3 on test), so the Bonferroni-adjusted interval is 98.3% (alpha 0.05 / 3) next to the 95% one. Minimum detectable effect
(80% power, two-sided 5%) = 2.8 x bootstrap SE, SE = 95% half-width / 1.96.

Verdict rule per strategy (on test): "edge" if the 98.3% interval is above zero and the train mean is also positive; "negative" if the
98.3% interval is below zero; "no edge" if the interval includes zero and the detectable effect is <= 10 ROI points; "inconclusive"
otherwise (or fewer than 30 trades).

Also reported, descriptive: surge counts per category, entry-price-bucket calibration of the surge-direction outcome, the 100-surge
account-age check. Exploratory splits (S1 by category, S1 by hours to close) are labelled as such and do not change any verdict.
Language: a flagged surge is "unusual flow". It is never evidence that a wallet is an insider.

<!-- RESULTS BELOW ARE FILLED IN FROM `report` OUTPUT AFTER THE RULES ABOVE WERE HASHED -->

## Results

Pre-registration record printed by `report`: `2026-11-01T20:24:39Z 231f8796a2f1cb784c63683cafc4b88eb90c9c4a7c08ebec47ed20013b4cfc3c`
(sha256 of this file when it held only the rules above; a copy is kept in the cache as `prereg_rules.md`).

### Sample
- Universe: 65177 closed markets with $10,000-$750,000 lifetime volume (52 sampled end-days plus future-dated ones); 64888 binary with a
  0/1 payout, in 38270 events; 46129 after keeping at most 2 per event.
- 2400 markets drawn, 240 per stratum (politics with life < 7 days had only 234, the shortfall was filled at random). All 2400 histories
  were complete (none hit the 40,000-fill cap); 1,554,146 taker fills.
- By category: politics 474, crypto 482, sports 484, esports 480, other 480.
- Split by close time: train = 1440 markets closing before 2026-06-09, test = the newer 960.

### Surges per category (first surge per market)

| category | markets | surge | one-sided | young | concentrated | fresh | conc+fresh | S1 trades |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| politics | 474 | 362 | 327 | 221 | 348 | 263 | 250 | 162 |
| crypto | 482 | 245 | 210 | 117 | 219 | 176 | 151 | 89 |
| sports | 484 | 377 | 290 | 253 | 366 | 290 | 279 | 260 |
| esports | 480 | 314 | 229 | 169 | 295 | 261 | 244 | 186 |
| other | 480 | 327 | 308 | 200 | 310 | 246 | 230 | 93 |
| all | 2400 | 1625 | 1364 | 960 | 1538 | 1236 | 1154 | 790 |

What a "surge" mostly is in this data: the median surge hour traded $2,428 and the median baseline hour was $0 (baseline exactly $0 in
1058 of 1625 surges). So the typical first surge is the first $2,000+ hour of an otherwise quiet market, often one or a few large
prints, which is why concentration and fresh share are high almost everywhere. Median market age at the surge was 5.9 d and the median
time from surge to close 9.9 hours. Of 1364 one-sided surges, 86 had no fill within 6h to enter at and 488 had an entry price outside
0.03-0.97 (the outcome was effectively settled), leaving 790 trades.

### Pre-registered strategies (ROI per $1, +1 cent, hold to resolution; event-clustered bootstrap)

| strategy | train n | train ROI [95%] | test n | test ROI [95%] | test 98.3% | detectable effect | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S1 follow one-sided | 469 | +4.3% [-6.7, +17.6] | 321 | -6.4% [-15.2, +3.4] | [-17.8, +5.6] | ~13 points | inconclusive |
| S2 follow young | 284 | +10.0% [-6.7, +30.5] | 191 | -2.5% [-14.6, +9.9] | [-17.7, +12.0] | ~18 points | inconclusive |
| S3 follow conc+fresh | 348 | +8.0% [-5.7, +26.0] | 228 | -4.1% [-15.3, +7.2] | [-18.0, +9.6] | ~16 points | inconclusive |
| S4a fade S1 (control) | 469 | -7.8% [-24.1, +10.2] | 321 | +4.5% [-18.2, +28.6] | [-22.5, +34.8] | ~33 points | inconclusive |
| S4b fade S2 (control) | 284 | -1.4% [-24.1, +24.9] | 191 | -4.5% [-28.3, +20.5] | [-32.8, +29.3] | ~35 points | inconclusive |
| S4c fade S3 (control) | 348 | -4.7% [-23.0, +15.3] | 228 | +11.2% [-16.5, +41.9] | [-20.8, +48.3] | ~42 points | inconclusive |

Same trades in probability points (outcome minus cost), which is less noisy than ROI:

| strategy | train | test |
| --- | --- | --- |
| S1 follow one-sided | -0.9pp [-4.9, +2.9] | -3.4pp [-8.3, +2.0] |
| S2 follow young | -1.3pp [-6.4, +3.7] | -1.7pp [-8.2, +4.8] |
| S3 follow conc+fresh | -0.8pp [-5.4, +3.7] | -2.6pp [-8.6, +3.1] |
| S4a fade S1 | -1.1pp [-4.9, +2.9] | +1.4pp [-3.9, +6.3] |
| S4b fade S2 | -0.7pp [-5.7, +4.4] | -0.3pp [-6.7, +6.2] |
| S4c fade S3 | -1.2pp [-5.7, +3.4] | +0.6pp [-5.1, +6.6] |

### Calibration of the surge-direction outcome by entry price (all 790 trades, train+test)

| entry price | n | mean entry | won | won minus entry [95%] |
| --- | --- | --- | --- | --- |
| 0.03-0.20 | 9 | 0.108 | 0.222 | +11.4pp [-13.3, +46.5] |
| 0.20-0.40 | 77 | 0.319 | 0.312 | -0.7pp [-11.0, +10.2] |
| 0.40-0.60 | 209 | 0.515 | 0.512 | -0.3pp [-7.3, +6.4] |
| 0.60-0.80 | 224 | 0.693 | 0.661 | -3.2pp [-9.5, +2.8] |
| 0.80-0.97 | 271 | 0.901 | 0.900 | -0.0pp [-3.7, +3.3] |

Five minutes after a surge, the price of the side the surge bought is about as good as a calibrated probability: the surge side
won about as often as its price said, in every bucket with more than 9 trades.

### Exploratory splits (2 splits, pooled train+test; not tests)
- S1 by category: politics +4.0% [-15.6, +34.1], crypto -13.0% [-26.3, +2.2], sports +6.8% [-6.3, +22.8], esports -8.4% [-21.3, +4.1],
  other +3.2% [-9.0, +15.2].
- S1 by time from surge to close: <6h -3.7% [-14.4, +7.3], 6-48h +4.7% [-6.8, +17.7], >48h -2.4% [-16.8, +16.6].
- No cell has an interval above zero, so there is nothing to follow up here.

### Account age on 100 random one-sided surges (descriptive)
379 wallets (the top 5 of each surge hour), all with an account date (366 from the profile, 13 from first activity).
20.0% of their surge-hour USD came from accounts younger than 30 days. Among wallet-surge pairs, 280 were new to the market (first fill
inside the surge hour), and 67 of those (24%) were accounts under 30 days old; 123 were already in the market, of which 19 (15%) were.
"Fresh to this market" is therefore mostly NOT "new account": only 24% of fresh wallets were accounts under 30 days old. Neither measure says anything about who is behind a wallet.

## Verdict
- S1 (follow one-sided surges): inconclusive by the pre-registered rule. No edge was found. The train half was positive (+4.3%) and the
  test half negative (-6.4%), so the sign did not hold. The test could only have detected an edge of about 13 ROI points or more.
- S2 (young markets only): inconclusive. Same sign flip (+10.0% train, -2.5% test). Detectable effect about 18 points.
- S3 (concentrated + fresh): inconclusive. Same sign flip (+8.0% train, -4.1% test). Detectable effect about 16 points.
- S4 fades (controls): inconclusive in all three. They mirror S1-S3 minus the spread, with wider intervals because fading usually buys
  the cheap side.
- Proven: in this sample, following a surge 5 minutes after it does not beat the price by a large margin (the S1 test 98.3% interval
  tops out at +5.6% ROI; in probability points the test interval is [-8.3, +2.0]). Not proven either way: smaller edges, under about
  13-18 ROI points. Alleged and not tested here: that any particular surge came from inside information. Unusual flow is not evidence
  of an insider.

## Limits
- Volume band $10,000-$750,000: the biggest markets are excluded, and lifetime volume is known only after the fact (a surge itself pushes a
  market over $10k), so surge markets may be over-represented. Only resolved markets are included (survivorship).
- The data-api offset cap (~10,000) is worked around by walking backwards with `end`; no market hit the 40,000-fill page cap.
- There are no news timestamps, so a surge cannot be split into before-news and after-news. Many sports and esports surges are around
  game time, when public information arrives quickly.
- Taker fills only: makers are not seen, so concentration and fresh share describe the takers. "Fresh" means new to this market within
  the downloaded history, not a new account (see the age check).
- The baseline needs 12 complete hours of trading, so surges in a market's first ~13 hours cannot be detected (the separate new-market
  study covers the first hour). A 1-cent spread is a rough guess at slippage, and fees are ignored.
- Categories come from gamma tags. The case markets the user raised (the "anti-cartel operation" market, the "322" esports matches)
  were not specifically sampled, and this study says nothing about them individually.
