# Access, costs and legality from Uzbekistan

Checked 2026-11-03. This is research, not legal or tax advice. Tags: **PROVEN** means a primary source or a live probe; **REPORTED** means a secondary source; **UNKNOWN** means no source found.

## Verdict per route
| Route | Polymarket allows it? | Uzbek law allows it? | Verdict |
|---|---|---|---|
| polymarket.com (international) from a UZ IP | **Yes**: UZ is on none of the three restricted lists in the docs geoblock page, the help-center list or the ToS list (PROVEN, [docs](https://docs.polymarket.com/api-reference/geoblock), [help](https://help.polymarket.com/en/articles/13364163-geographic-restrictions), [tos](https://polymarket.com/tos)) | **Unclear**. Since 2023-01-01 residents may buy or sell crypto only through domestic licensed VASPs (REPORTED, [Elliptic](https://www.elliptic.co/country-guides/uzbekistan/)). Betting with operators not licensed by NAPP is an offence for the *operator* (REPORTED, [MGL](https://www.mygaminglicense.com/license/uzbekistan)). Player liability is UNKNOWN. | **Yes on the platform side; UNKNOWN under Uzbek law** |
| polymarket.com through a VPN | **No**: VPN circumvention is "strictly prohibited". Violators "may have their wallets placed in close-only mode" (PROVEN, [tos](https://polymarket.com/tos), effective 2026-08-11) | n/a | **No**, and Xin doesn't need one |
| Polymarket US (polymarket.us) | **No**: requires an SSN and US KYC. It is a CFTC-regulated exchange (PROVEN, [US signup](https://docs.polymarket.us/learn/get-started/signup)) | n/a | **No** |
| Direct API or bot trading | **Yes** from non-restricted IPs. The API enforces the same geoblock (PROVEN, [docs](https://docs.polymarket.com/api-reference/geoblock)) | same as row 1 | **Yes / UNKNOWN** |
| Funding: UZS → local VASP (e.g. UzNEX) → USDC → Polygon | The bridge accepts it (PROVEN, [assets](https://docs.polymarket.com/trading/bridge/supported-assets)) | The legality of withdrawing crypto from a UZ VASP to a foreign platform is UNKNOWN | **UNKNOWN** |

Notes:
- **Live probe.** `GET https://polymarket.com/api/geoblock` is public. From this machine it returned `{"blocked":false,"country":"AE"}` (PROVEN, 2026-11-03). The IP was not Uzbek, so the UZ result itself is untested. Xin should run it from his own connection.
- **The official lists disagree.** The help center marks AR, JP, MT and IE as fully blocked ([help](https://help.polymarket.com/en/articles/13364163-geographic-restrictions)). The docs show JP, MT and IE as frontend close-only and leave AR off entirely ([docs](https://docs.polymarket.com/api-reference/geoblock)). The ToS adds Hungary and Slovenia ([tos](https://polymarket.com/tos)). Uzbekistan appears on none of the three.
- **ISP blocks are separate from Polymarket's.** A third-party tracker reports UZ as "Accessible", with no government or ISP block (REPORTED, [startpolymarket](https://startpolymarket.com/countries/uzbekistan), updated 2026-08-02).
- **KYC on the international site.** The ToS text I read contains no KYC requirement. A voluntary KYC/KYB form exists and is required for co-location (PROVEN, [docs](https://docs.polymarket.com/api-reference/geoblock)). BeInCrypto reports that large or fast deposit→trade→withdraw cycles can trigger verification and that VPN users risk bans (REPORTED, [Yahoo/BeInCrypto](https://finance.yahoo.com/markets/crypto/articles/polymarket-blocking-vpn-access-kyc-181022107.html), 2026-05-27).
- **What happens to funds if you are restricted.** You go to close-only: you can sell, or hold until resolution, then withdraw. You are not confiscated (PROVEN, [help](https://help.polymarket.com/en/articles/13364163-geographic-restrictions)). OFAC-blocked regions cannot even close positions ([docs](https://docs.polymarket.com/api-reference/geoblock)).

## Costs (international platform)
| Item | Value | Tag / source |
|---|---|---|
| Polymarket deposit and withdrawal fee | $0. Intermediaries such as MoonPay or Coinbase charge their own fees | PROVEN, [fees](https://docs.polymarket.com/trading/fees) |
| Collateral | pUSD on Polygon. Deposits are auto-converted | PROVEN, [assets](https://docs.polymarket.com/trading/bridge/supported-assets) |
| Bridge minimum deposit | $2 on Polygon, Arbitrum, Base, Solana and Tron. Live API on 2026-11-03: Ethereum $3, Bitcoin $3.6 (the docs page still says $7 and $9) | PROVEN, [assets](https://docs.polymarket.com/trading/bridge/supported-assets), live `bridge.polymarket.com/supported-assets` |
| Withdrawal | pUSD → USDC through a Uniswap v3 pool. The UI enforces a gap under 10 bp. The pool can run dry. Withdrawals above $50,000 should be split | PROVEN, [withdraw](https://docs.polymarket.com/trading/bridge/withdraw) |
| Withdrawal limits | None published for the international site (US has FIFO and same-source rules) | UNKNOWN for intl; PROVEN for US, [US rules](https://docs.polymarket.us/learn/deposits/withdraw-funds/rules) |
| Card through MoonPay | About 4.5% (Stripe about 2.9%). Card maximum $115,000 per transaction | REPORTED, [polymarkets.co.il](https://polymarkets.co.il/en/guide/deposit-guide) |
| Exchange → Polygon USDC withdrawal fee | About $0.10–$1.00 flat | REPORTED, [polymarkets.co.il](https://polymarkets.co.il/en/guide/deposit-guide) |
| UZS → USDT/USDC spread at a local VASP | UNKNOWN | — |
| Taker fee | `fee = C × feeRate × p × (1−p)`. Makers pay 0 | PROVEN, [fees](https://docs.polymarket.com/trading/fees) |
| feeRate by category | Crypto 0.07; Sports, Economics, Culture, Weather, Other and Combos 0.05; Finance, Politics, Mentions and Tech 0.04; Geopolitics 0 | PROVEN, [fees](https://docs.polymarket.com/trading/fees) |
| Taker fee as % of notional (= feeRate×(1−p)) at p=0.50 | Crypto 3.5%, Sports 2.5%, Politics 2.0%. One round trip at 0.50 costs double: 7% / 5% / 4% | Calculated from the [fees](https://docs.polymarket.com/trading/fees) formula |
| Maker rebate (share of taker fees) | Crypto 20%, Sports 15%, most others 25%, Combos 0%. Paid daily in pUSD, minimum $1 accrued | PROVEN, [maker rebates](https://docs.polymarket.com/programs/maker-rebates) |

## Fixed costs vs capital (crypto route, one deposit plus one withdrawal)
"Fixed" here means the $0.10–$1.00 exchange→Polygon fee ([source](https://polymarkets.co.il/en/guide/deposit-guide)) plus a withdrawal swap of at most 0.10% ([withdraw](https://docs.polymarket.com/trading/bridge/withdraw)). The card column is a separate route at about 4.5% ([source](https://polymarkets.co.il/en/guide/deposit-guide)). None of this includes trading fees or spreads.

| Capital | Deposit fee % ([src](https://polymarkets.co.il/en/guide/deposit-guide)) | Withdrawal swap ≤0.10% ([src](https://docs.polymarket.com/trading/bridge/withdraw)) | Card route instead, ~4.5% ([src](https://polymarkets.co.il/en/guide/deposit-guide)) |
|---|---|---|---|
| $100 | 0.10–1.00% | ≤$0.10 | ~$4.50 |
| $500 | 0.02–0.20% | ≤$0.50 | ~$22.50 |
| $2,000 | 0.005–0.05% | ≤$2 | ~$90 |
| $10,000 | 0.001–0.01% | ≤$10 | ~$450 |
| $50,000 | 0.0002–0.002% | ≤$50 (split the withdrawal) | ~$2,250 |

Fixed costs are negligible above $500 on the crypto route. The cost that matters is taker fees: a single taker round trip at p=0.50 in a crypto market costs 7% of notional, as shown in the costs table ([fees](https://docs.polymarket.com/trading/fees)).

## Tax notes for Uzbekistan (high level, not advice)
- **Standard rate.** Personal income tax for residents is 12% (PROVEN, [gov.uz](https://gov.uz/ru/advice/70/document/1325)). Tax residency means being in Uzbekistan more than 183 days in a 12-month period (PROVEN, [Tax Code art. 30](https://lex.uz/ru/mact/4674893)).
- **Crypto exemption.** Under PP-3832, crypto-asset operations by individuals are not taxable objects and the income is excluded from the base (PROVEN, [regulation.gov.uz](https://regulation.gov.uz/ru/document/12538)). The exemption is reported to run until 2029-01-01 (REPORTED, [Azizov & Partners](https://azizovpartners.uz/ru/memos/kriptoaktivy-v-respublike-uzbekistan-2/)).
- **Betting exemption.** Winnings are exempt from personal income tax only when the bookmaker or online game is licensed by NAPP (PROVEN, [UP-68](https://lex.uz/uz/doc-passport/6899275)). Polymarket is not NAPP-licensed.
- **UNKNOWN:** whether Polymarket profits count as an exempt "crypto-asset operation" or as taxable betting winnings at 12% ([gov.uz](https://gov.uz/ru/advice/70/document/1325)). Ask an Uzbek tax adviser.

## Account-security risks
- **Fake bot repos.** "Polymarket Trap" (disclosed 2026-07-17): a fake repo, `Trum3it/polymarket-arbitrage-bot` (36 stars, 53 forks), pulled in a malicious npm dependency (`clob-client-math`, part of 30 packages). Running `npm install` stole `POLYMARKET_PRIVATE_KEY` from `.env`, plus wallet vaults and browser passwords (REPORTED, [dependencywatch](https://dependencywatch.io/incident/npm-2026-07-17-polymarket-trap-clob-client-math)).
- **Earlier incidents.** More than 20 fake bot repos appeared in a hijacked `dev-protocol` org (March 2026). In January 2026, a custodial bot (Polycule) lost about $230k (REPORTED, [CopyGrade](https://copygrade.com/blog/polymarket-copy-bot-malware)). SlowMist warned about a copy-trading bot in December 2025 (REPORTED, [Cryptopolitan](https://www.cryptopolitan.com/polymarket-copy-traders-warned/)).
- **Rules.** Never put the main wallet's key into a third-party bot. Use the official `@polymarket/clob-client` SDK. Fund a separate hot wallet with only what you are trading.
- **The cited orcalayer repo doesn't exist.** `github.com/orcalayer/05-polymarket-mechanics-facts` returned HTTP 404 on 2026-11-03. The orcalayer account has 10 other public repos ([GitHub API](https://api.github.com/users/orcalayer/repos)), none with that name. Its claims could not be checked (UNKNOWN).

## Typical failure modes for small accounts
- **Taker fees.** Crossing the spread near 0.50 in crypto markets costs up to 3.5% per side ([fees](https://docs.polymarket.com/trading/fees)). Limit (maker) orders pay 0.
- **Rebates are out of reach.** The $1 minimum payout ([maker rebates](https://docs.polymarket.com/programs/maker-rebates)) means tiny makers can wait days for anything.
- **Card deposits.** About 4.5% lost before the first trade ([source](https://polymarkets.co.il/en/guide/deposit-guide)).
- **Withdrawal swaps.** A dry pUSD→USDC pool can stall withdrawals ([withdraw](https://docs.polymarket.com/trading/bridge/withdraw)).
- **Spreads and resolution surprises** (disputed or ambiguous rules): I have no sourced numbers for these here. They are covered by sibling research files (UNKNOWN in this file).

## Open questions
1. Does Uzbek currency or crypto law penalize an individual who moves USDC from a licensed VASP to a foreign dApp? (UNKNOWN)
2. How are Polymarket profits taxed: as an exempt crypto operation or as 12% income ([gov.uz](https://gov.uz/ru/advice/70/document/1325))? (UNKNOWN)
3. Run the geoblock call from a real Uzbek IP to confirm `blocked:false`. (Not yet tested)
4. Which local VASP allows USDC withdrawals on Polygon, and at what spread and fee? (UNKNOWN)
5. Are there KYC trigger thresholds on the international site? No official number is published. (UNKNOWN)
