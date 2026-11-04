# Market making, liquidity rewards and maker rebates on Polymarket (2026-11-03)

Tags: **PROVEN** = primary doc, live API or real-money result; **REPORTED** = third-party claim, unreplicated;
**UNKNOWN** = no source; **EST** = our arithmetic from the numbers below (not measured).

## How it works (5 lines)
1. You post resting limit orders (maker). Makers pay no fee; takers pay `C × feeRate × p × (1−p)`.
2. Each rewarded market has a daily pool, a min order size and a max spread from the midpoint. Orders inside that band get points, sampled once a minute.
3. Each UTC day the pool is split by your share of points. Two-sided quotes score more; one-sided quotes score 1/3 as much.
4. Maker rebates are separate: 15–25% of taker fees, split by how much of your liquidity got filled.
5. The risk: you get filled mostly when news moves the price against you (adverse selection). That loss can exceed rewards plus spread.

## Program mechanics (PROVEN, primary docs, read 2026-11-03)
- Scoring: `S(v,s) = ((v−s)/v)² · b`. v = max spread (¢), s = your distance from the size-cutoff-adjusted mid, b = "in-game multiplier", value not published.
  Two-sided: `Qmin = max(min(Qone,Qtwo), max(Qone,Qtwo)/c)`, c = 3.0. If mid < 0.10 or > 0.90, only two-sided quotes score.
  Sampled once a minute at a random offset (≤1,440 per UTC-day epoch); payout = your epoch-point share × pool. https://docs.polymarket.com/programs/liquidity-rewards.md
- Paid daily at midnight UTC. Minimum payout $1. Source: https://docs.polymarket.com/developers/market-makers/liquidity-rewards
  The live pilot found the $1 minimum applies per account, not per market (REPORTED, `tlafargue` pilot, link below).
- A quote at the band edge (s → v) scores ~0. Quoting halfway out gives 0.25× the score of quoting at mid (from the formula).
- Taker fee rate / maker rebate share by category (https://docs.polymarket.com/polymarket-learn/trading/fees):
  Crypto 0.07/20%, Sports 0.05/15%, Finance 0.04/25%, Politics 0.04/25%, Economics 0.05/25%, Culture 0.05/25%,
  Weather 0.05/25%, Other 0.05/25%, Mentions 0.04/25%, Tech 0.04/25%, Geopolitics 0 (no rebate), Combos 0.05/0%.
  Fee peaks at p = 0.50: 100 shares in Crypto = $1.75 fee (same page).
- Maker rebates: daily pUSD, $1 minimum, by filled maker liquidity; 0%-fee markets pay none: https://docs.polymarket.com/developers/market-makers/maker-rebates-program
- At p = 0.50, Politics: rebate per filled share = 0.25 × 0.04 × 0.25 = **0.25¢ per share** (EST from the two pages above).
  The tlafargue study measured adverse selection of 9–13¢ per filled share, so rebates cannot cover it.
- Access: Uzbekistan (UZ) is not on the geoblock lists ("block", "close-only API/frontend") as of 2026-11-03:
  https://docs.polymarket.com/api-reference/geoblock.md. The pilot reports the trading endpoint is
  geofenced by egress IP, so the IP your bot or VPS trades from matters (REPORTED).

## Reward budget today (PROVEN, own snapshot)
Snapshot 2026-11-03 17:00 UTC, all pages of `https://clob.polymarket.com/rewards/markets/current`:
- **14,837 rewarded markets, $232,287/day** in total pools (`total_daily_rate`).
- Pool per market: median $5/day; p75 $13; p90 $35; p99 $133; max $2,502/day.
  9,285 markets are ≤ $5/day (sum $24.2k/day). 12,318 are ≤ $20/day (sum $60.7k/day).
  Top 1% of markets hold 28% of the budget. 217 markets are > $100/day (sum $72.5k/day).
- Min size is 20 shares in 11,183 markets (50 sh: 2,155; 100 sh: 316; 200 sh: 255).
  Max spread is 4.5¢ in 7,605 markets (6.5¢: 3,876; 5.5¢: 2,605).
- Only 429 markets combine min size 20 with a pool ≥ $50/day.
- Biggest pools sit on the most contested books. Example: Gamma `clobRewards`,
  "Will the Democratic Party control the House after the 2026 Midterms" pays $1,000/day,
  with $7.03M of book liquidity and $4.17M 24h volume (https://gamma-api.polymarket.com/markets?order=volume24hr).
- Earlier: $200.5k/day on 8,391 markets (2026-07-03, `tlafargue/.../2026-07-04-rewards-quiet-tail.md`). Football markets pay $1–10/day per market with a 50-share minimum (REPORTED, OrcaLayer `02-inplay-maker.md`).

## Real results from makers
- **tlafargue live pilot, real money, 2026-07-07→09** (PROVEN as a published ledger; one operator, n = 5 markets):
  https://github.com/tlafargue/polymarket-research/blob/main/studies/2026-07-09-rewards-pilot-live.md
  - $190 capital, 5 quiet pools ($5–20/day each), quoting min size on both sides at mid ± max_spread/2, requoting every 60 s.
  - Realized/modeled rewards: **0.696 on day 1 and 0.698 on day 2**. Per market: 0.48–0.98; sparse books got the biggest haircut.
  - Rewards $2.76 (day 1) and $4.53 (day 2). **$7.52 rewards vs −$18.33 marked fill losses in ~40 h.** Net ≈ −$10.8.
  - 7 fills over 5 news events. Two "sweep + 15–20¢ gap" fills cost −$11.75 and −$0.50.
  - Rescan: of 140 candidates, 6 had spread ≤ 10¢ and **0** also had calm price history. "Safely quotable universe is empty."
  - With protective rules turned on, only ~2–3 competed markets were left, "earning pennies/day".
- **tlafargue paper model, before the pilot**: $5.8k/day on $3.5k capital (top-100 quiet pools; sole-quoter assumption).
  Refuted live; an example of how badly paper rewards overstate profit.
  https://github.com/tlafargue/polymarket-research/blob/main/studies/2026-07-04-rewards-quiet-tail.md
- **tlafargue plain-MM test**: once fills are simulated with queue position, a naive +0.29¢/share turns into **−0.33¢/share**,
  and fills are ~9× more toxic than average (README table, https://github.com/tlafargue/polymarket-research).
- **OrcaLayer in-play football maker**: 13-day replay on the recorded order book lost **−$23,055**, with 12 of 13 days negative (Sep–Oct 2026; replay, not live).
  https://github.com/orcalayer/polymarket-arbitrage-market-making-copy-trading-backtests (`02-inplay-maker.md`)
- **Akey, Grégoire, Harvie, Martineau, "Who Wins and Who Loses in Prediction Markets?"** (SSRN 6443103, rev. 2026-10-18):
  - Dataset: 588M trades, $67B. The top 1% of winners take **76.5% of profits**.
  - Winners mostly provide liquidity with limit orders; losers take it with market orders.
  - The author on HN: many market makers are also among the *least* successful accounts.
  - No exact maker share of winners in the abstract: **UNKNOWN** (full PDF blocked to curl).
  - https://papers.ssrn.com/sol3/papers.cfm?abstract_id=6443103 , https://news.ycombinator.com/item?id=48221877

## Infrastructure needed
- Funded Polygon wallet holding pUSD/USDC, plus CLOB L2 API keys derived from the wallet (pilot study and liquidity-rewards doc).
- The pilot reports these details (REPORTED, `2026-07-09-rewards-pilot-live.md`):
  - After the order-version migration the legacy `py-clob-client` stopped working; use `py-clob-client-v2`.
  - New UI accounts are POLY_1271 deposit wallets (signature_type=3).
  - The server heartbeat is a dead-man switch: a wrong id cancels ALL orders.
- An always-on bot is needed: a 60 s requote loop at minimum; the pilot says WS mid tracking below one minute is needed against news sweeps.
  A VPS whose egress IP is not geoblocked.
  OrcaLayer reports a 1 s taker delay in football (`01-cross-market-arbitrage.md`); maker latency needs: UNKNOWN.
- Security: fake "Polymarket bot" repos steal wallet keys (StepSecurity 2026-03-15, cited in OrcaLayer `05-polymarket-mechanics-facts.md`).

## Inventory risk
- Every fill is a directional position held until resolution or a costly exit. Quiet books have mids 79–92¢ wide, so exiting means "crossing fog" (pilot).
- One min-size pickoff (100 sh × ≤50¢) can cost up to ~$50, more than a day of a $5–20 pool (quiet-tail study).
- Basic rule: pull quotes 24 h before any scheduled event or resolution.

## By capital (EST unless tagged; monthly = 30 × daily; gross = rewards + rebates before fill losses)
| Capital | Realistic monthly gross | Net after fills | Hours/wk | Tools / skills | Main risks |
|---|---|---|---|---|---|
| $100 | $0–$10 (quiet pools, below the $1/day minimum on bad days) | likely negative | 5–10 setup, then bot | py-clob-client-v2, VPS, Python | one pickoff = weeks of rewards |
| $500 | ~$10–$140 (unprotected pilot: $4.53/day on $190 ≈ $136/mo; with protective rules: pennies/day) | negative to ~0 (pilot net −$10.8 in 2 days) | 5–10 | same + WS feed, kill-switches | adverse fills 2.4× rewards (pilot) |
| $2,000 | ~$50–$400 if ~20 quiet pools are quoted | UNKNOWN; pilot says the safe set is ~empty | 10–15 | daily scan/rotate, per-market blacklists | news lumps; pools decay ~⅓/day (paper addendum) |
| $10,000 | contested pools; share depends on competitors: UNKNOWN | UNKNOWN; naive MM −0.33¢/share | 20+ | sub-second WS, inventory/hedge model | toxic flow vs pros, key security |
| $50,000 | pro MM territory; OSC paper shows the winners exist, but returns are not published | UNKNOWN | full-time | low-latency infra, fair-value model | OrcaLayer replay −$23k in 13 days |
The $500 and $2,000 rows extrapolate one 2-day, n = 5 pilot. They are an order of magnitude, not a forecast.

## Difficulty: 4/5
Collecting rewards is easy. Collecting them without giving the money back on fills is the hard part (pilot), and nobody has shown it publicly at small size.

## Cheapest honest test (≈$0 → $100)
1. Snapshot `/rewards/markets/current` and the order books. Paper-score 10 quiet pools for 3 days with the formula above.
   Multiply the result by 0.70 (pilot calibration).
2. Go live only with $100 on 3–5 two-sided books with spread ≤ 10¢. Use post-only orders, a 60 s requote, a gap-pull rule, and a 24 h pull before events.
3. Log rewards (`/rewards/user/total`), rebates and marked fill P&L every day.
   Kill rule: stop if fill losses exceed rewards in week 1.
4. First check the geoblock endpoint from your own IP.

## Open questions
- What is `b`, the in-game multiplier? Why do sparse books pay 0.48–0.73× of model?
- Is the July "safe set is empty" finding still true with today's $232k/day and 14.8k pools? It needs a fresh rescan.
- What share of OSC-paper winners are pure makers, and how much of their profit comes from rewards? (Full paper text not read.)
- Can a bot from Uzbekistan route through an IP that is not geoblocked without breaking the ToS? (UZ itself is not listed.)
- Rate limits per tier for order placement/cancel: https://docs.polymarket.com/programs/builders/tiers.md (not read).
