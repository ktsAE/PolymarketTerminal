# Copy trading, wallet following and insider signals on Polymarket (checked 2026-11-03)

Tags: PROVEN = reproducible data/primary record; REPORTED = vendor, press or one non-peer-reviewed study; UNKNOWN = no data found.

## How it works
1. Every Polymarket fill is on-chain, so anyone can rank wallets by past PnL and watch what they buy.
2. Trackers (Polywhaler, Polycopy feed, leaderboards) alert you; copy bots (Polycopy, PolyCop, others) place the same order from your wallet.
3. You always enter after the leader, at a worse price, and pay spread + Polymarket fee + the tool's fee.
4. "Insider signals" = flagging fresh wallets that bet big on one event, hoping they know something.
5. It pays only if past skill persists AND survives your delay and costs. Every test below says it does not.

## Evidence
Academic / independent studies
- Profits are concentrated: top 1% of profitable users take 76.5% of profits ($67B of volume studied); winners mostly provide liquidity with limit orders, losers take with market orders; monthly persistence is "modest", possibly selection not skill; insider trading "unlikely to explain" the largest winners. PROVEN (paper, data public on Hugging Face), dated 2026-08-28.
  https://www.osc.ca/sites/default/files/2026-10/research-grant-competition-2026-who-wins-and-who-loses-in-prediction-markets.pdf
- 273 top wallets: top decile of profitable wallets has 52% of positive PnL ($98M of $189M); median event win rate 93% vs trade win rate 58% (patient, staggered holding, not fast trades); 67% at least partly automated. REPORTED (single author, 18 pp, descriptive, no copy test), 2026-04-20.
  https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6624899
- Split-half test on 6,119 wallets (24.2M fills, 2026-06-10 to 07-03): Spearman of past vs future edge 0.011 (p=0.39); taker-heavy (copyable) wallets 0.009; the best past decile scored -4.7% next period (taker-heavy top decile -6.6%); 160 wallets that made >$10k were 75/160 positive next period and lost $95k together. The only repeaters were high-frequency market makers, whose edge is quoting, not holdings. REPORTED (open repo, reproducible scripts).
  https://github.com/tlafargue/polymarket-research/blob/main/studies/2026-07-03-wallet-skill-splithalf.md
- "Informed" football wallets that buy before goals: 92 wallets earned +$2.33 per $10 at their own price out of sample (t 6.8, n 10,198), but copying 1-5 s later earned -$0.10 per $10 (t -0.5). 92% of the best wallet's buys were maker fills; the ask moved +9c in the same millisecond. A naive outcome-selected version (+$4.23 per $10) fell to -$0.41 per $10 (n 6,243) on all signals. REPORTED (vendor research, 2026-10).
  https://github.com/orcalayer/polymarket-arbitrage-market-making-copy-trading-backtests/blob/main/03-informed-traders-copy.md
- Walk-forward whale copying in 5 sports: MLB top-10 wallets +$2.72 to +$3.78 per $10 while being picked, -$2.23 to +$0.16 the month after; month-to-month Spearman -0.01, +0.15, +0.08, -0.03; "every wallet" baseline lost $0.31-$0.63 per $10 every month; at +3c slippage everything is negative. NFL picked wallets -$1.63 to +$1.46 per $10, no month with |t|>=2. REPORTED (OrcaLayer, 2026-10-10; vendor sells analytics).
  https://orcalayer.com/blog/polymarket-copy-trading-whales-backtest ; https://reddit.com/r/algotrading/comments/1x38s11/walkforward_test_of_copying_top_polymarket

This repo (docs/research/radar/HOLDERS_STUDY.md, Parts 4-5, 2026-10-31 to 11-03), PROVEN within its sample
- Per-game wallet skill: CS2 Spearman +0.17 (p=0.07), Dota 2 -0.21, LoL +0.01; top quartile by old ROI later earned -4.4% (CS2), -23.5% (Dota 2), -6.1% (LoL).
- Point-in-time follow test, 861 wallets, cutoff 2026-09-20: pooled +4.8% to +8.4% for "good record" groups came from ONE wallet (+$496k on $3.5M in 14 d); without it about 0%.
- With no wallet allowed to carry a group, every group loses: -1.5% to -2.3% per $ traded equal-weighted (good-record wallets -1.5% to -1.7%); good records lose 0.5-1 pt less, CI includes 0 in almost every row.
- Rank correlation of past profit factor with forward return +0.089 (14 d) / +0.119 (30 d): weak ranking signal, no copyable profit. These are THEIR prices; a copier does worse.

Commercial tools (vendor pages, REPORTED; no audited user returns found anywhere: UNKNOWN)
- Polycopy: free manual copy + paper trading; Premium $30/month (auto-copy bots); 0.5% flat fee on every real order on top of Polymarket fees. https://polycopy.app/pricing
  A July 2026 review listed 1% taker / 0.5% maker and estimated ~$40/month (~8%) of cost on a $500 account turned over 2x. https://predictionbotreview.com/reviews/polycopy
- Polywhaler (alerts, not execution): free feed; Pro $4.92/mo billed yearly ($59), alerts "within minutes"; Premium $14.92/mo ($179/yr), alerts 1.9 s median; Quant $29.92/mo with API. https://polywhaler.com/pricing
- PolyCop (Telegram bot): 0.5% on profitable trades, "most copied trades within two seconds" (source is an affiliate review). https://polymarket101.com/en/docs/guides/polycop-review-2026
- Poly Syncer: ~$99-$499/month, self-reported. https://copygrade.com/guides/polymarket-copy-trading-platforms-compared
- PolyHelper: free Chrome extension with data panels and a points/airdrop program; not a copy bot. https://polyhelper.gitbook.io/polyhelper-docs
- Who profits: the tool sellers (subscriptions + per-trade builder fees, affiliate payouts per paid month: https://polycopy.app/pricing) and the market makers you buy from. No vendor publishes verified net returns for its users.
- Latency is not the fix: 1.9 s alerts or <2 s copies are still too late per the 1-5 s copy result above; sports markets also delay taker orders (OrcaLayer: https://orcalayer.com/blog/polymarket-strategies-that-dont-work).
- Key risk: copy bots need trading permission over your wallet; CopyGrade calls custody the worst-case question (Polycule named as a "cautionary tale"). https://copygrade.com/guides/polymarket-copy-trading-platforms-compared

Insider trading: cases and rules (PROVEN = official records)
- First CFTC insider case on event contracts (2026-04-23): US soldier Van Dyke, ~$33,034 bet on Maduro markets, ~$409,881 profit; criminal charges up to 10-20 years per count; CFTC seeks disgorgement, penalties, trading bans.
  https://cftc.gov/PressRoom/PressReleases/9217-26 ; https://www.justice.gov/opa/pr/us-soldier-charged-using-classified-information-profit-prediction-market-bets
- Second criminal case (May 2026): Google engineer "AlphaRaccoon", $2.7M bet, $1.2M profit on Year-in-Search markets, arrested in Switzerland (a non-US resident). REPORTED (press): https://thenextweb.com/news/google-engineer-polymarket-insider-trading-charges
- CFTC opened at least 3 more probes in 2026 (Biden pardons: trader netted >$300k; Iran: network made $2.4M, 98% win rate; more Google traders). REPORTED (WIRED FOIA, 2026-09-11): https://wired.com/story/polymarket-investigations-iran-biden-google-foia
- Polymarket rules (Terms of Use, updated 2026-03-23): no trading on confidential information that breaches a duty, on tips from someone with such a duty, or if you can influence the outcome; ban, legal action, referral. Polymarket claims 90+ referrals, 315+ wallet details given, 2 arrests; works with Chainalysis and Palantir.
  https://integrity.polymarket.com/ ; https://www.businesswire.com/news/home/20260320997513/en/Polymarket-Publishes-Enhanced-Market-Integrity-Rules-Across-Its-DeFi-Platform-and-CFTC-Regulated-U.S.-Exchange
- Following someone else's suspected insider wallet is not itself banned by these rules if you have no tip (UNKNOWN in court); it is just unprofitable for the latency reasons above, and suspected insiders are a tiny, unpredictable set.
- Trading on your own non-public information: possible criminal exposure even abroad (Swiss arrest above), funds frozen, account ban. Uzbekistan-specific law on this: UNKNOWN.

## Per capital tier (monthly, net of costs)
Derived arithmetic: copied results of -1.0% to -4.1% per $ (OrcaLayer copies) or -1.5% to -2.3% per $ (repo, at the leaders' own prices) times an assumed 2x monthly turnover gives about -2% to -8% per month before fixed fees; fixed fee share = $30 Polycopy or $14.92 Polywhaler / capital.

| capital | realistic monthly return | hours/week | tools/skills | main risks |
| --- | --- | --- | --- | --- |
| $100 | -2% to -8%, plus 30% (Polycopy) or 15% (Polywhaler) in fees: not feasible | 1-3 | free tracker only, paper trading | fees exceed any edge; wallet key exposure |
| $500 | -2% to -8%, plus 6% / 3% fees: not feasible | 2-4 | free Polycopy paper bots | same; overtrading |
| $2,000 | -2% to -8%, plus 1.5% / 0.75% fees | 3-5 | tracker + manual copy, spreadsheet of fills | slippage, thin books, custody |
| $10,000 | -2% to -8%; fees ~0.3% | 5-10 | own scripts on the public Data API; measure your own fills | slippage grows with size; one bad market |
| $50,000 | -2% to -8%; your orders move thin books, making copies worse | 10+ | own infrastructure | price impact, custody, KYC/withdrawal limits |
| any (insider info) | not feasible: illegal / ToS breach | - | - | prosecution, disgorgement, bans |

Single months vary widely (NFL picked wallets -16% to +15% per $ copied, none significant: OrcaLayer link above); that is noise, not a return range to plan on.

## Difficulty: 2/5 to run (tools are easy), 5/5 to profit (no study found a copier edge).

## Cheapest honest test ($0)
1. Pick wallets with a rule frozen today (e.g. profit factor >= 1.5 over 60 d) using only data up to today.
2. Run Polycopy's free paper bots or log each leader buy yourself with the ask price 5-60 s later plus 1c and the fee.
3. After 30 days, compare net per $ against zero and against "copy all wallets". Expect about -1% to -4% per $; only a positive result over 2 separate months would justify real money.
4. Or rerun this repo's test at a second cutoff: `FOLLOW_T=2026-08-20` with `scripts/follow-winners-study.py` (HOLDERS_STUDY.md Part 5).

## Open questions
- Slow markets (politics, months to resolve) are untested for copying; the SSRN paper says politics specialists are 98% profitable, but that is survivors, not a copy test.
- Copying maker-style (posting limit orders at the leader's price instead of taking) is untested.
- 0xinsider's cohort test (+1.57 pt, CI [+0.32, +2.82]; HOLDERS_STUDY.md Part 4) has not been reproduced.
- No vendor publishes audited user returns; Polycopy's fee (0.5% flat vs 1%/0.5%) differs between sources.
- Uzbekistan law on non-public-information trading on offshore prediction markets: UNKNOWN.
