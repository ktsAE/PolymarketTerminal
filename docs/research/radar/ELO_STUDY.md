# Does a PandaScore Elo beat Polymarket's esports closing line? (pre-registered study, Nov 1 2026)

**Verdict: no edge.** The pre-registered strategy lost 3.6% per $1 on the held-out test set, 95% CI [-14.9%, +7.8%], 757 bets.
Elo alone predicts much worse than the closing price. Adding Elo to the close (a blend) did not improve test log-loss.
The test sample cannot see an ROI edge smaller than about ±16% for this strategy, so a small edge is not ruled out.
Nothing here suggests one exists.

Reproduce: `python3 scripts/pandascore-elo.py fetch` (about 70 min, mostly waiting on PandaScore's 1000 requests/hour
limit), then `python3 scripts/pandascore-elo.py report` (about 1 min). The cache lives in `~/.hermes/cache/scratch/pandascore/`
(63 MB), never in the repo.

## Data
- **PandaScore** (free tier, token from `.radar/.env`): `/{csgo,lol,dota2,valorant}/matches/past` with
  `filter[status]=finished`, one `range[begin_at]` window per month, sorted by `begin_at`, 100 per page.
  - Pulled 2023-01-01 to 2026-11-01: 1132 calls, 0 refusals. The free tier returned full match history; X-Total runs back
    to 2016 for CS (100,957 past matches).
  - **Refused:** `/betting/matches` (odds) returned **HTTP 401**. PandaScore odds were not used.
  - 103,505 rows. Dropped 1294 forfeits/draws and 3 rows with no winner or time.
- **Polymarket**: resolved esports `moneyline` markets from Gamma `events?tag_slug=esports&closed=true`, in weekly
  `end_date` windows from 2025-06-01. Windows are split when they hit the 3000-offset cap.
  - Titles must look like `Counter-Strike|LoL|Dota 2|Valorant: A vs B (BOn)`. 21,192 markets, 21,094 after de-duping one
    market per match.
  - Prices come from CLOB `prices-history`, `startTs = start - 9h`, `endTs = start`, `fidelity=10` (same request as
    `scripts/elo-vs-market.py`). 658 series came back empty.

## Method (pre-registered)
The protocol is written in the script's docstring. It was fixed before any test-set outcome was computed. The test set
was scored once.

1. **Elo:** one table per game, keyed by PandaScore team id. Teams start at 1500, on the usual 400-point logistic scale.
   The rating is online: each match is predicted before it updates the ratings.
   - K is picked per game by log-loss on the **oldest 50%** of that game's PandaScore matches. That half ends between
     Jul and Dec 2024, before the first Polymarket market in the sample (Oct 2025).
2. **Join:** a Polymarket market and a PandaScore match must be the same game, start within 6h of each other, and have
   both team names match after normalisation.
   - Names match exactly on name, acronym or slug. Failing that, one side matches exactly and the other has a difflib
     ratio ≥ 0.85 or is a ≥4-character substring.
   - The best name score wins, then the closest start time.
3. **Close:** the last price point at least 5 minutes before `gameStartTime`, and at most 60 minutes older than that.
   - Kept only closes between 0.03 and 0.97.
   - Both teams need at least 10 earlier PandaScore results in that game.
4. **Split:** usable rows sorted by start time; the older 60% is train, the newer 40% is test.
5. **Strategy:** bet $1 on the side whose Elo probability beats its close by at least T. Cost is the close plus 1 cent
   (spread penalty).
   - T comes from {0.03, 0.05, 0.07, 0.10, 0.13, 0.16, 0.20}. The rule is the highest train ROI among values with ≥ 40
     train bets.
6. **Intervals:** 95% bootstrap over UTC-day clusters (B=4000 on test). An esports event is one match here, so the day
   is the coarser cluster.
   - "Detectable ROI" = 2.8 × the clustered standard error (80% power, two-sided 5%).
7. **Log-loss on test:** close, Elo, and a logistic blend (intercept + logit(close) + logit(Elo)) fitted on train.

### Changes made before scoring (none used Polymarket outcomes)
- **K grid widened:** from 8..48 to 8..96, because K landed on the top of the grid. This used only the oldest-half
  PandaScore log-loss.
- **Substring name rule added:** after reading 25 unmatched name pairs (for example `FOKUS` / `FOKUS REALITY`).
- **Join checks:** `report --join-only` prints only sample and join diagnostics, never ROI or log-loss against the price.
  The one outcome-based check is whether PandaScore and Polymarket agree on the winner (data quality).

## Sample sizes (real output of `report`)

| game | matches | first | last | K (tuned on oldest 50%) | Elo log-loss oldest 50% | newest 50% |
| --- | --- | --- | --- | --- | --- | --- |
| Counter-Strike | 55126 | 2023-01-03 | 2026-11-01 | 40 | 0.6508 | 0.6343 |
| LoL | 18902 | 2023-01-01 | 2026-10-31 | 48 | 0.6240 | 0.6233 |
| Dota 2 | 14703 | 2023-01-02 | 2026-11-01 | 64 | 0.6351 | 0.6270 |
| Valorant | 13477 | 2023-01-04 | 2026-11-01 | 64 | 0.6275 | 0.6577 |

- **Join:** 20,718 of 21,094 Polymarket matches joined (20,535 exact, 183 fuzzy); 376 had no name+time match.
  - The winner agrees between PandaScore and Polymarket in 20,716 of 20,718. The median start difference is 4 minutes.
- **Dropped after the join:**
  - a team with fewer than 10 prior results: 4635
  - no price point in the 60 minutes before close: 718
  - close outside 0.03–0.97: 98
- **Usable:** 15,267 (Counter-Strike 8578, LoL 2771, Dota 2 2100, Valorant 1818).
- **Train:** 9160 matches, 2025-10-04 to 2026-06-04. **Test:** 6107 matches, 2026-06-04 to 2026-11-01.

## Train: choosing T (ROI per $1 at close + 1 cent)

| T | bets | ROI | 95% CI (day clusters) |
| --- | --- | --- | --- |
| 0.03 | 7286 | +3.4% | [-0.0, +7.0] |
| 0.05 | 6168 | +4.9% | [+1.2, +8.5] |
| 0.07 | 5185 | +4.8% | [+0.8, +9.2] |
| 0.10 | 3852 | +5.7% | [+1.0, +10.6] |
| 0.13 | 2781 | +9.1% | [+3.5, +15.1] |
| 0.16 | 2021 | +11.8% | [+4.7, +19.1] |
| 0.20 | 1293 | +13.6% | [+4.5, +22.5] |

T = 0.20 was picked; it is the edge of the grid. The blend fitted on train was
logit p = +0.017 + 0.812·logit(close) + 0.272·logit(Elo).

## Test (newer 40%, scored once)

| strategy | bets | days | ROI | 95% CI | detectable ROI (80% power) |
| --- | --- | --- | --- | --- | --- |
| Elo edge >= 0.20 | 757 | 145 | -3.6% | [-14.9, +7.8] | +/-16.0% |
| always favourite (reference) | 6107 | 151 | -0.1% | [-2.0, +1.8] | +/-2.7% |
| always underdog (reference) | 6107 | 151 | -8.1% | [-12.1, -3.8] | +/-5.9% |

| model | test log-loss | 95% CI of (model - close) |
| --- | --- | --- |
| close | 0.5906 | - |
| Elo | 0.6323 | +0.0418 [+0.0343, +0.0494] |
| blend | 0.5913 | +0.0008 [-0.0010, +0.0025] |

- **Brier on test:** close 0.2031, Elo 0.2204, blend 0.2033.
- **Close calibration on test** (favourite side, price bucket → win rate):

  | bucket | n | win rate |
  | --- | --- | --- |
  | 0.5–0.6 | 2024 | 0.56 |
  | 0.6–0.7 | 1812 | 0.65 |
  | 0.7–0.8 | 1277 | 0.78 |
  | 0.8–0.9 | 766 | 0.84 |
  | 0.9–1.0 | 228 | 0.95 |

  This is the sanity gate: the closing price is well calibrated. Backing every favourite lands at about −0.1% after the
  1-cent penalty.

**Variants tried: 48 in the scored run.** That is a K grid of 10 × 4 games on the oldest PandaScore half, a T grid of 7 on
train, and 1 blend fit. Earlier, three `--join-only` runs evaluated the old 8-value K grid on the CS, LoL and Dota data
(PandaScore only).

## What this supports

**Proven on this sample:**
- The Polymarket close is a much better forecast than a results-only Elo: log-loss 0.591 vs 0.632, and the difference's
  CI excludes 0.
- Adding Elo to the close does not help out of sample. The blend's log-loss is +0.0008 vs the close, CI [−0.0010, +0.0025].
  So Elo carries no information the close has not already priced, at a resolution of about 0.002 log-loss.
- The pre-registered "Elo disagrees by ≥ 20 points" bet did not hold up. It went from +13.6% on train to −3.6% on test.
  The test CI [−14.9, +7.8] includes zero and excludes the train estimate.

**Not shown:**
- An edge smaller than about 16% ROI for the T=0.20 strategy can be neither seen nor excluded with 757 test bets.
- For the whole book (favourite reference), the test resolves about ±2.7%.

**Why train looked good (interpretation, not tested):**
- Train ROI rose steadily with T, so Elo-vs-close disagreements were profitable from Oct 2025 to Jun 2026.
- The likely reasons are a market that was thinner and less efficient early on, or a regime change, plus selection
  among 7 thresholds. One more year of forward data would tell these apart; this study cannot.

## Limits
- Elo uses series results only: no maps, rosters, patches, LAN/online or BO-format adjustment. It is a deliberately
  simple baseline. A richer model (roster-aware ratings, map-level Glicko) is untested.
- **Drops:** 22% of joined markets lacked 10 prior PandaScore results for a team (team tier was not checked). The study
  covers only teams with some PandaScore history.
- **Price data:**
  - The "close" is the CLOB prices-history point (10-minute fidelity), not a traded fill. Real depth and fees are not
    modelled beyond the flat 1-cent penalty.
  - 658 markets had empty price series.
- **No sharp-book comparison:** PandaScore odds are refused on this tier (HTTP 401), and no other bookmaker line was
  available. A cross-venue test remains the open lead.
