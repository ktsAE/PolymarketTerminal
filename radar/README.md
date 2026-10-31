# Radar

Surveillance toolkit for suspected match-fixing ("322") and insider flow on Polymarket.
It keeps **proven** and **alleged** cases apart, stores everything locally, and explains every flag.

```
npm run radar -- seed                      # load the evidence-graded case registry
npm run radar -- cases                     # list cases with their current evidence tier
npm run radar -- find "Alliance Phantom"   # look up a Polymarket event slug
npm run radar -- ingest <event-slug>       # fetch markets + all fills (both sides) + top wallet profiles
npm run radar -- report <event-slug>       # indicator score, reasons, largest positions, linked case
npm run radar -- link <case-id> <slug>     # attach a Polymarket event to a case
npm run radar -- backfill --max 20         # ingest recent resolved esports events
```

The database lives at `.radar/radar.db` (override with `RADAR_DB`). Requires Node >= 22.18 (uses `node:sqlite`).

## Evidence tiers (`evidence.ts`)

| Tier | Meaning | Needs |
| --- | --- | --- |
| SANCTIONED | final ruling with published findings | integrity body / league / court / regulator, `documented: true` |
| ORGANIZER_ACTION | organizer punished, no documentation | authoritative source |
| INVESTIGATING | official investigation, no finding | authoritative source |
| ALLEGED_CONCRETE | named source gives checkable specifics | analyst/journalist/player + a non-"statement" claim |
| ALLEGED_UNSUPPORTED | named allegation, nothing checkable | named alleging source |
| RUMOR | community talk | anything |
| CLEARED | official body found no violation | authoritative source |

`store.addCaseEvent` rejects a tier its sources do not justify. `tierAsOf` returns what was known at a past time, so
backtests do not use hindsight. Only SANCTIONED/ORGANIZER_ACTION count as positive labels.

## Lessons baked into the code

- Fetch **both sides** of every fill. `takerOnly=true` hid a $175k resting order in the Alliance case.
- Unit of analysis is the **match-side**, not the wallet: many wallets on one winning underdog is one observation.
- Measure **peak** exposure; positions are sold/redeemed afterwards.
- Ignore fills priced outside 0.03-0.97 (settlement sweeping carries no information).
- Net context (frequent large bettor, two-sided activity) **per wallet**, never across wallets.

## Status (v0.1)

Indicators are not validated. On the five ESIC-sanctioned matches available on Polymarket (four NOMERCY, PlayTime vs Liquid)
the v0 score was 0 for all: the fixing money was on sportsbooks, so Polymarket flow alone does not reveal these cases.
Next sources: cross-venue odds, in-game telemetry, and social/news ingestion. See docs/research/radar/DOSSIER.md.
