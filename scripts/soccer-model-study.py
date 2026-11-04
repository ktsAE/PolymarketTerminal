#!/usr/bin/env python3
"""Does a DataGaffer-style soccer model (team ratings from goals and shots, Poisson simulation) beat the sharp closing line?

Data: football-data.co.uk (free): results, shots, shots on target and Pinnacle odds. Seasons 2022/23 to 2025/26, 7 leagues (E0 SP1 D1 I1 F1 N1 P1).
DataGaffer itself cannot be backtested: its free section is a current-ratings snapshot with no history and no match probabilities (simulations are paid).
This tests the same kind of model on the same kind of inputs. Polymarket soccer prices track Pinnacle (tlafargue: median gap 0.7c), so Pinnacle is the benchmark.
Usage: python3 scripts/soccer-model-study.py fetch | report

FROZEN SPEC (written before any odds were compared with the model)
  model     walk-forward, uses only matches before the one predicted. Per team, an exponentially weighted average (half-life 12 matches) of a goal proxy scored and conceded,
            proxy = 0.5 * goals + 0.5 * (0.30 * shots_on_target + 0.04 * (shots - shots_on_target)); strengths = team average / league average (shrunk toward 1 with 6 pseudo-matches);
            lambda_home = league_home_goals * att_home * def_away, lambda_away = league_away_goals * att_away * def_home, independent Poisson to 10 goals -> P(H), P(D), P(A).
            Matches are predicted only when both teams have >= 8 earlier matches in that league's data.
  benchmark Pinnacle closing odds (PSCH/PSCD/PSCA; opening PSH/PSD/PSA when closing is missing), margin removed proportionally.
  split     train = seasons 2022/23 to 2024/25 (choose the edge threshold T from {0.02, 0.03, 0.05, 0.08}); test = 2025/26 to date, scored once.
  bet       back the outcome with model prob - market prob >= T at the Pinnacle odds (so the bookmaker's margin is paid). ROI per 1 staked. CI: bootstrap over match days (2,000 resamples, seed 3).
  report    log-loss of market, model, and a 50/50 blend; variants tried: 4 thresholds x 3 outcomes pooled = 4.
"""
import csv
import io
import math
import os
import random
import statistics
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime

random.seed(3)
DIR = os.path.expanduser("~/.hermes/cache/scratch/soccer")
LEAGUES = ["E0", "SP1", "D1", "I1", "F1", "N1", "P1"]
SEASONS = ["2223", "2324", "2425", "2526"]
TEST_SEASON = "2526"
HALF_LIFE = 12
PRIOR = 6


def cmd_fetch():
    os.makedirs(DIR, exist_ok=True)
    for s in SEASONS:
        for lg in LEAGUES:
            p = f"{DIR}/{s}_{lg}.csv"
            if os.path.exists(p) and os.path.getsize(p) > 1000:
                continue
            try:
                req = urllib.request.Request(f"https://www.football-data.co.uk/mmz4281/{s}/{lg}.csv", headers={"User-Agent": "polymarket-radar/0.1"})
                data = urllib.request.urlopen(req, timeout=40).read()
                open(p, "wb").write(data)
                print("ok", s, lg, len(data))
            except Exception as e:  # noqa: BLE001
                print("skip", s, lg, e)


def f(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def load():
    rows = []
    for fn in sorted(os.listdir(DIR)):
        if not fn.endswith(".csv"):
            continue
        season, lg = fn[:-4].split("_")
        text = open(f"{DIR}/{fn}", encoding="utf-8-sig", errors="replace").read()
        for r in csv.DictReader(io.StringIO(text)):
            try:
                d = datetime.strptime(r["Date"], "%d/%m/%Y" if len(r["Date"]) == 10 else "%d/%m/%y")
            except (KeyError, ValueError):
                continue
            hg, ag = f(r.get("FTHG")), f(r.get("FTAG"))
            if hg is None or ag is None:
                continue
            odds = [f(r.get(k)) for k in ("PSCH", "PSCD", "PSCA")]
            if None in odds:
                odds = [f(r.get(k)) for k in ("PSH", "PSD", "PSA")]
            if None in odds or min(odds) <= 1:
                continue
            rows.append(dict(season=season, lg=lg, date=d, home=r["HomeTeam"], away=r["AwayTeam"], hg=hg, ag=ag,
                             hs=f(r.get("HS")), as_=f(r.get("AS")), hst=f(r.get("HST")), ast=f(r.get("AST")), odds=odds))
    rows.sort(key=lambda r: r["date"])
    return rows


def proxy(goals, shots, sot):
    if shots is None or sot is None:
        return goals
    return 0.5 * goals + 0.5 * (0.30 * sot + 0.04 * max(shots - sot, 0))


def poisson(lam, n=11):
    p = [math.exp(-lam)]
    for k in range(1, n):
        p.append(p[-1] * lam / k)
    return p


def probs(lh, la):
    ph, pa = poisson(lh), poisson(la)
    h = d = a = 0.0
    for i, x in enumerate(ph):
        for j, y in enumerate(pa):
            if i > j:
                h += x * y
            elif i == j:
                d += x * y
            else:
                a += x * y
    s = h + d + a
    return [h / s, d / s, a / s]


def predictions(rows):
    decay = 0.5 ** (1 / HALF_LIFE)
    state = defaultdict(lambda: dict(w=0.0, sc=0.0, co=0.0, n=0))     # per (league, team)
    league = defaultdict(lambda: dict(n=0, hg=0.0, ag=0.0, pg=0.0))
    out = []
    for r in rows:
        L = league[r["lg"]]
        H, A = state[(r["lg"], r["home"])], state[(r["lg"], r["away"])]
        if L["n"] >= 40 and H["n"] >= 8 and A["n"] >= 8:
            mh, ma, mp = L["hg"] / L["n"], L["ag"] / L["n"], L["pg"] / (2 * L["n"])

            def strength(S):
                att = (S["sc"] + PRIOR * mp) / (S["w"] + PRIOR) / mp
                dfn = (S["co"] + PRIOR * mp) / (S["w"] + PRIOR) / mp
                return att, dfn
            ah, dh = strength(H)
            aa, da = strength(A)
            lh = mh * ah * da * (1.0)
            la = ma * aa * dh
            # keep the home advantage in the league goal means; strengths are venue-agnostic
            lh = max(0.2, min(4.5, lh * (mp / mh if False else 1.0)))
            la = max(0.2, min(4.5, la))
            r = dict(r, model=probs(lh, la))
            out.append(r)
        ph, pa = proxy(r["hg"], r["hs"], r["hst"]), proxy(r["ag"], r["as_"], r["ast"])
        for S, sc, co in ((H, ph, pa), (A, pa, ph)):
            S["sc"] = S["sc"] * decay + sc
            S["co"] = S["co"] * decay + co
            S["w"] = S["w"] * decay + 1
            S["n"] += 1
        L["n"] += 1
        L["hg"] += r["hg"]
        L["ag"] += r["ag"]
        L["pg"] += ph + pa
    return out


def market(r):
    inv = [1 / o for o in r["odds"]]
    s = sum(inv)
    return [x / s for x in inv]


def outcome(r):
    return 0 if r["hg"] > r["ag"] else (1 if r["hg"] == r["ag"] else 2)


def logloss(ps, rows):
    return -statistics.mean(math.log(max(p[outcome(r)], 1e-9)) for p, r in zip(ps, rows))


def bets(rows, thr):
    out = []
    for r in rows:
        m, p = market(r), r["model"]
        for k in range(3):
            if p[k] - m[k] >= thr:
                out.append((r["date"].toordinal(), (r["odds"][k] - 1) if outcome(r) == k else -1.0, r["lg"]))
    return out


def boot(b, n=2000):
    by = defaultdict(list)
    for d, x, _ in b:
        by[d].append(x)
    ks, o = list(by), []
    for _ in range(n):
        s = [x for k in (random.choice(ks) for _ in ks) for x in by[k]]
        o.append(sum(s) / len(s))
    o.sort()
    return o[int(n * .025)], o[int(n * .975)]


def cmd_report():
    rows = load()
    preds = predictions(rows)
    train = [r for r in preds if r["season"] != TEST_SEASON]
    test = [r for r in preds if r["season"] == TEST_SEASON]
    print(f"matches with odds {len(rows)}; predicted {len(preds)}; train {len(train)} (to 2024/25); test {len(test)} (2025/26 to {max(r['date'] for r in test).date()})")
    for name, part in (("train", train), ("TEST", test)):
        mk, md = [market(r) for r in part], [r["model"] for r in part]
        bl = [[(a + b) / 2 for a, b in zip(x, y)] for x, y in zip(mk, md)]
        print(f"{name}: log-loss market {logloss(mk, part):.4f} | model {logloss(md, part):.4f} ({logloss(md, part) - logloss(mk, part):+.4f}) | blend 50/50 {logloss(bl, part):.4f} ({logloss(bl, part) - logloss(mk, part):+.4f})")
    print("\nbetting where model prob exceeds the Pinnacle closing prob by >= T, at Pinnacle closing odds (bookmaker margin paid):")
    best = None
    for thr in (0.02, 0.03, 0.05, 0.08):
        b = bets(train, thr)
        if len(b) >= 100:
            roi = sum(x for _, x, _ in b) / len(b)
            print(f"  train T={thr:.2f}: n={len(b):5d} ROI {roi * 100:+6.1f}%")
            if best is None or roi > best[1]:
                best = (thr, roi)
    thr = best[0] if best else 0.05
    print(f"  chosen on train: T={thr:.2f}")
    for t in (thr,):
        b = bets(test, t)
        lo, hi = boot(b)
        print(f"  TEST  T={t:.2f}: n={len(b)} ROI {sum(x for _, x, _ in b) / len(b) * 100:+6.1f}% [{lo * 100:+.1f}, {hi * 100:+.1f}], hit {sum(x > 0 for _, x, _ in b) / len(b):.1%}")
    allb = bets(test, 0.0001)
    print(f"  TEST, any positive model-vs-market gap at all: n={len(allb)} ROI {sum(x for _, x, _ in allb) / len(allb) * 100:+.1f}%  (bookmaker margin plus model error; there is no way to separate them here)")
    print("  TEST by league at the chosen T:", {lg: (len(x), round(sum(v for _, v, l in bets(test, thr) if l == lg) / max(1, len(x)) * 100, 1)) for lg in LEAGUES for x in [[1 for _, _, l in bets(test, thr) if l == lg]]})


if __name__ == "__main__":
    {"fetch": cmd_fetch, "report": cmd_report}[sys.argv[1] if len(sys.argv) > 1 else "report"]()
