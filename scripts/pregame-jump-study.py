#!/usr/bin/env python3
"""Pre-game jump study: does following or fading a 15-point price jump in the hours before a game start make money?

Data (cached outside the repo, see scripts/pandascore-elo.py `fetch --what polymarket`):
  ~/.hermes/cache/scratch/pandascore/pm_games.json  21,192 resolved esports moneylines (cid, start, y0 = outcome 0 won)
  ~/.hermes/cache/scratch/pandascore/pm_px.json     CLOB prices-history, start-9h .. start, fidelity 10 (outcome 0 price)
  ~/.hermes/cache/scratch/nba_games.json            1,541 NBA moneylines, same layout, 6h before start (optional)

FROZEN RULE (written before any return was computed; no tuning):
  trigger  = first price point t at least 20 min before start where |p(t) - p(ref)| >= 0.15, ref = last point at or before t-30min
             (not older than 6h), ref price in [0.10, 0.90]. No "calm" requirement (the loose rule of radar/jump.ts).
  entry    = first price point 5-15 min after the trigger and before start; entry price + 1 cent.
  follow   = buy the outcome that jumped up; fade = buy the other outcome. Hold to resolution.
  split    = older 60% / newer 40% of games by start time. CI = bootstrap over start days (2,000 resamples, seed 11).
  variants = 2 (follow, fade) x 2 samples (esports, NBA).
Usage: python3 scripts/pregame-jump-study.py
"""
import bisect
import collections
import json
import os
import random

random.seed(11)
HOME = os.path.expanduser("~/.hermes/cache/scratch")


def run(items):
    out, skipped = [], collections.Counter()
    for it in items:
        s, start, y0 = it["pts"], it["start"], it["y0"]
        if len(s) < 4:
            skipped["too few points"] += 1
            continue
        ts = [a for a, _ in s]
        trig = None
        for t, p in s:
            if t > start - 1200:
                break
            k = bisect.bisect_right(ts, t - 1800) - 1
            if k < 0 or (t - 1800) - ts[k] > 6 * 3600:
                continue
            pr = s[k][1]
            if 0.10 <= pr <= 0.90 and abs(p - pr) >= 0.15:
                trig = (t, p, pr)
                break
        if not trig:
            skipped["no jump"] += 1
            continue
        t, p, pr = trig
        d = 1 if p > pr else -1
        j = next((m for m, (tt, _) in enumerate(s) if t + 300 <= tt <= t + 900 and tt < start), None)
        if j is None:
            skipped["no entry point in 5-15m"] += 1
            continue
        e = s[j][1]
        if not (0.03 <= (e if d == 1 else 1 - e) <= 0.97):
            skipped["entry already decided"] += 1
            continue
        for strat, side in (("follow", d), ("fade", -d)):
            cost = (e if side == 1 else 1 - e) + 0.01
            win = (y0 == 1) if side == 1 else (y0 == 0)
            out.append(dict(day=int(start // 86400), start=start, strat=strat, ret=(1.0 if win else 0.0) / cost - 1, pp=(1.0 if win else 0.0) - cost))
    return out, skipped


def boot(rows, n=2000):
    by = collections.defaultdict(list)
    for r in rows:
        by[r["day"]].append(r["ret"])
    ks, o = list(by), []
    for _ in range(n):
        sm = [x for k in (random.choice(ks) for _ in ks) for x in by[k]]
        o.append(sum(sm) / len(sm))
    o.sort()
    return o[int(n * .025)], o[int(n * .975)]


def report(name, items):
    res, sk = run(items)
    starts = sorted({r["start"] for r in res})
    if not starts:
        print(name, "no triggers", dict(sk))
        return
    cut = starts[int(len(starts) * .6)]
    print(f"{name}: {len(items)} markets | triggered {len(res) // 2} | skipped {dict(sk)}")
    for part, fn in (("older 60%", lambda r: r["start"] < cut), ("newer 40%", lambda r: r["start"] >= cut), ("all      ", lambda r: True)):
        for strat in ("follow", "fade"):
            rows = [r for r in res if r["strat"] == strat and fn(r)]
            if len(rows) < 20:
                print(f"   {part} {strat:6s} n={len(rows)} too few")
                continue
            lo, hi = boot(rows)
            print(f"   {part} {strat:6s} n={len(rows):4d} days={len({r['day'] for r in rows}):3d} ROI {sum(r['ret'] for r in rows) / len(rows) * 100:+6.1f}% [{lo * 100:+6.1f},{hi * 100:+6.1f}]  pp {sum(r['pp'] for r in rows) / len(rows) * 100:+5.1f}")


games = json.load(open(f"{HOME}/pandascore/pm_games.json"))
px = json.load(open(f"{HOME}/pandascore/pm_px.json"))
report("ESPORTS pre-game (9h before start)", [dict(pts=[tuple(x) for x in px.get(g["cid"], [])], start=g["start"], y0=g["y0"]) for g in games])
nba_path = f"{HOME}/nba_games.json"
if os.path.exists(nba_path):
    nba = json.load(open(nba_path))
    report("NBA pre-game (6h before start)", [dict(pts=[tuple(x) for x in n["h"]], start=float(n["st"]), y0=int(n["y0"])) for n in nba if n.get("h")])
