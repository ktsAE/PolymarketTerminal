#!/usr/bin/env python3
"""Is it worth following Polymarket accounts that look like winners (good profit factor, green last 7 days, human-like)?

Point-in-time test on Data API v2 `user-pnl` (daily, complete: includes losing and unredeemed positions, so no survivorship in the record).
Usage:  python3 scripts/follow-winners-study.py fetch      # about 5-10 minutes of polite downloading, cache outside the repo
        python3 scripts/follow-winners-study.py report

FROZEN SPEC (written before any forward result was computed; nothing tuned afterwards)
  cutoff T          2026-09-20 00:00 UTC. Selection uses ONLY series points at or before T. Forward windows: 14 and 30 days after T.
  population        takers in 120 random resolved markets (volume >= $20k) that ended in the 4 days before T, so everyone was active near T and
                    is followed whether or not they kept trading. Up to 3,000 random wallets of them.
  eligible (E)      first series point at least 60 days before T; >= 5 trades in the 7 days before T; <= 40 trades/day averaged over the 30 days
                    before T (human-like, not a bot); >= $2,000 volume over those 30 days.
  selections        A  green 7d:  economic_pnl(T) - economic_pnl(T-7d) > 0
                    B  good PF:   daily profit factor over the 60 days before T >= 1.5 (sum of positive daily changes / |sum of negative|, >= 15 days with a change)
                    C  A and B    (the question asked)
                    D  profit per volume: PnL over the 60 days before T divided by the volume traded in them >= +3% (fixed before looking at any forward result;
                       added after A-C had been seen, so it counts as extra variants)
                    E  top 20% of eligible wallets by that same profit per volume
                    F  D and A    (good profit per volume and green over 7 days)
  forward outcome   dP = economic_pnl(T+H) - economic_pnl(T); dV = volume(T+H) - volume(T). Only wallets with dV >= $500 count (a copier needs trades).
                    return = sum dP / sum dV over a group (pooled, per dollar traded), also the median per-wallet dP/dV and the share with dP > 0.
  robust measures   PRIMARY from now on (added after seeing that one wallet carried the pooled number, so they are extra variants): no wallet may carry a group.
                    ew      equal-weight mean of per-wallet return dP/dV, each wallet's return winsorized at the 5th/95th percentile of all followed wallets
                    capped  pooled return with every wallet's turnover capped at $100,000 (a copier puts the same limited capital behind each wallet)
                    The unweighted pooled return and the "without its biggest winner" line stay as secondary numbers.
  comparison        selected vs eligible-and-not-selected, wallet-clustered bootstrap (2,000 resamples, seed 5) of the difference.
  variants          6 selections x 2 horizons = 12 comparisons, plus 3 rank correlations. Reported all.
  caveat            this measures THEIR results at THEIR prices. A copier enters later at worse prices, so every number here is an upper bound for copying.
"""
import bisect
import collections
import json
import os
import random
import statistics
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

UA = {"User-Agent": "polymarket-radar/0.1"}
DATA = "https://data-api.polymarket.com/v2"
GAMMA = "https://gamma-api.polymarket.com"
DIR = os.path.expanduser("~/.hermes/cache/scratch/follow-winners") + ("" if os.environ.get("FOLLOW_T", "2026-09-20") == "2026-09-20" else "-" + os.environ["FOLLOW_T"])
CUT = os.environ.get("FOLLOW_T", "2026-09-20")  # replication: FOLLOW_T=2026-08-20 python3 scripts/follow-winners-study.py fetch / refetch / report ...
T = int(datetime.fromisoformat(CUT).replace(tzinfo=timezone.utc).timestamp())
DAY = 86400
random.seed(5)
KEY = "economic_pnl"  # report arg: economic_pnl (everything incl. referral/rewards/rebates) or position_pnl (trading only; the copyable part)


def get(url, tries=4):
    err = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r:
                return json.load(r)
        except Exception as e:  # noqa: BLE001 - retried, then raised below
            err = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"{url}: {err}")


def cmd_fetch():
    os.makedirs(f"{DIR}/pnl", exist_ok=True)
    pool_path = f"{DIR}/wallets.json"
    if not os.path.exists(pool_path):
        d0 = datetime.fromtimestamp(T - 4 * DAY, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        d1 = datetime.fromtimestamp(T, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        markets, off = [], 0
        while off < 2000:  # gamma rejects offsets past 2,000 (HTTP 422); more than 2,000 markets qualify, a random 120 of the first 2,000 is used
            page = get(f"{GAMMA}/markets?closed=true&end_date_min={d0}&end_date_max={d1}&volume_num_min=20000&limit=100&offset={off}")
            markets += [m["conditionId"] for m in page if m.get("conditionId")]
            if len(page) < 100:
                break
            off += 100
        random.shuffle(markets)
        markets = markets[:120]
        wallets = collections.Counter()
        for i, cid in enumerate(markets):
            cur = None
            for _ in range(3):
                q = f"{DATA}/trades?condition={cid}&taker_only=true&limit=1000" + (f"&cursor={urllib.parse.quote(cur)}" if cur else "")
                r = get(q)
                for t in r.get("data") or []:
                    if t.get("timestamp", 0) <= T:
                        wallets[t["proxy_wallet"].lower()] += 1
                cur = (r.get("pagination") or {}).get("next_cursor")
                if not cur:
                    break
            if i % 20 == 0:
                print(f"markets {i}/{len(markets)} wallets so far {len(wallets)}", flush=True)
        ws = sorted(wallets)
        random.shuffle(ws)
        json.dump({"markets": len(markets), "pool": len(ws), "wallets": ws[:3000]}, open(pool_path, "w"))
    pool = json.load(open(pool_path))
    todo = [w for w in pool["wallets"] if not os.path.exists(f"{DIR}/pnl/{w}.json")]
    print(f"pool {pool['pool']} wallets from {pool['markets']} markets; fetching pnl for {len(todo)} of {len(pool['wallets'])}", flush=True)

    def one(w):
        try:
            r = get(f"{DATA}/user-pnl?user={w}&interval=max&fidelity=1d")
            pts = [{k: p.get(k) for k in ("timestamp", "economic_pnl", "position_pnl", "wallet_income", "volume", "trade_count")} for p in (r.get("data") or {}).get("points", [])]
            json.dump(pts, open(f"{DIR}/pnl/{w}.json", "w"))
        except Exception as e:  # noqa: BLE001
            print("skip", w[:10], str(e)[:80], flush=True)
        time.sleep(0.05)

    with ThreadPoolExecutor(6) as ex:
        for i, _ in enumerate(ex.map(one, todo)):
            if i % 300 == 0:
                print(f"pnl {i}/{len(todo)}", flush=True)
    print("done")


def cmd_refetch():
    """Re-download, with every PnL field, only the wallets that pass the eligibility filter (it uses trade counts and volume, not PnL, so this does not select on results)."""
    os.makedirs(f"{DIR}/pnl2", exist_ok=True)
    todo = []
    for fn in os.listdir(f"{DIR}/pnl"):
        if features(series(f"{DIR}/pnl/{fn}")) is not None and not os.path.exists(f"{DIR}/pnl2/{fn}"):
            todo.append(fn[:-5])
    print(f"refetching {len(todo)} eligible wallets", flush=True)

    def one(w):
        try:
            r = get(f"{DATA}/user-pnl?user={w}&interval=max&fidelity=1d")
            pts = [{k: p.get(k) for k in ("timestamp", "economic_pnl", "position_pnl", "wallet_income", "volume", "trade_count")} for p in (r.get("data") or {}).get("points", [])]
            json.dump(pts, open(f"{DIR}/pnl2/{w}.json", "w"))
        except Exception as e:  # noqa: BLE001
            print("skip", w[:10], str(e)[:80], flush=True)
        time.sleep(0.05)

    with ThreadPoolExecutor(6) as ex:
        list(ex.map(one, todo))
    print("done")


def series(path):
    pts = [p for p in json.load(open(path)) if None not in (p["timestamp"], p.get(KEY), p["volume"], p["trade_count"])]
    pts.sort(key=lambda p: p["timestamp"])
    return pts


def at(pts, ts, key, ts_list=None):
    """Value of a cumulative series at ts: the last point at or before ts (None before the first point)."""
    tl = ts_list or [p["timestamp"] for p in pts]
    i = bisect.bisect_right(tl, ts) - 1
    return pts[i][key] if i >= 0 else None


def features(pts):
    tl = [p["timestamp"] for p in pts]
    if not pts or tl[0] > T - 60 * DAY:
        return None
    g = lambda ts, k: at(pts, ts, k, tl)  # noqa: E731
    tc7 = (g(T, "trade_count") or 0) - (g(T - 7 * DAY, "trade_count") or 0)
    tc30 = (g(T, "trade_count") or 0) - (g(T - 30 * DAY, "trade_count") or 0)
    v30 = (g(T, "volume") or 0) - (g(T - 30 * DAY, "volume") or 0)
    if tc7 < 5 or tc30 / 30 > 40 or v30 < 2000:
        return None
    pnl7 = g(T, KEY) - (g(T - 7 * DAY, KEY) or 0)
    v60 = (g(T, "volume") or 0) - (g(T - 60 * DAY, "volume") or 0)
    ppv60 = (g(T, KEY) - (g(T - 60 * DAY, KEY) or 0)) / v60 if v60 >= 2000 else float("nan")
    ups = downs = days = 0
    prev = g(T - 60 * DAY, KEY) or 0
    for p in pts:
        if T - 60 * DAY < p["timestamp"] <= T:
            d = p[KEY] - prev
            prev = p[KEY]
            if abs(d) > 1e-9:
                days += 1
                ups += max(d, 0)
                downs += max(-d, 0)
    pf = (ups / downs) if downs > 0 else (float("inf") if ups > 0 else 0.0)
    return dict(green7=pnl7 > 0, pf=pf, pf_ok=days >= 15 and pf >= 1.5, pnl7=pnl7, v30=v30, ppv60=ppv60, tl=tl)


def forward(pts, tl, h):
    dp = at(pts, T + h * DAY, KEY, tl) - at(pts, T, KEY, tl)
    dv = at(pts, T + h * DAY, "volume", tl) - at(pts, T, "volume", tl)
    return dp, dv


def pooled(rows):
    v = sum(r["dv"] for r in rows)
    return sum(r["dp"] for r in rows) / v if v > 0 else float("nan")


CAP = 100_000


def capped(rows):
    num = den = 0.0
    for r in rows:
        k = min(1.0, CAP / r["dv"]) if r["dv"] > 0 else 0.0
        num += r["dp"] * k
        den += r["dv"] * k
    return num / den if den > 0 else float("nan")


def winsor_bounds(rows):
    xs = sorted(r["dp"] / r["dv"] for r in rows)
    return xs[int(len(xs) * 0.05)], xs[min(len(xs) - 1, int(len(xs) * 0.95))]


def ew(rows, lo, hi):
    return statistics.mean(min(max(r["dp"] / r["dv"], lo), hi) for r in rows)


def boot_robust(a, b, fn, n=2000):
    out = []
    for _ in range(n):
        out.append(fn([random.choice(a) for _ in a]) - fn([random.choice(b) for _ in b]))
    out.sort()
    return out[int(n * .025)], out[int(n * .975)]


def boot_diff(a, b, n=2000):
    out = []
    for _ in range(n):
        sa = [random.choice(a) for _ in a]
        sb = [random.choice(b) for _ in b]
        out.append(pooled(sa) - pooled(sb))
    out.sort()
    return out[int(n * .025)], out[int(n * .975)]


def spearman(x, y):
    def rank(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        for k, i in enumerate(order):
            r[i] = k
        return r
    rx, ry = rank(x), rank(y)
    mx, my = statistics.mean(rx), statistics.mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** .5
    return num / den if den else float("nan")


def cmd_report():
    global KEY
    KEY = sys.argv[2] if len(sys.argv) > 2 else "economic_pnl"
    src = "pnl2" if KEY != "economic_pnl" else "pnl"
    pool = json.load(open(f"{DIR}/wallets.json"))
    print(f"PnL measure: {KEY} ({'trading PnL only' if KEY == 'position_pnl' else 'includes referral, rewards, rebates and yield income'})")
    elig, total = [], 0
    for fn in os.listdir(f"{DIR}/{src}"):
        total += 1
        pts = series(f"{DIR}/{src}/{fn}")
        f = features(pts)
        if f is None:
            continue
        f["pts"], f["w"] = pts, fn[:-5]
        elig.append(f)
    print(f"population {pool['pool']} wallets from {pool['markets']} markets; fetched {total}; eligible (history, active, human-like, volume) {len(elig)}")
    vals = sorted(f["ppv60"] for f in elig if f["ppv60"] == f["ppv60"])
    q80 = vals[int(len(vals) * 0.8)] if vals else float("inf")
    print(f"profit per volume over the 60 days before T: top-20% cut-off = {q80:+.4f}; share of eligible with >= +3%: {sum(1 for f in elig if f['ppv60'] >= 0.03) / len(elig):.0%}")
    sel = {
        "A green 7d": lambda f: f["green7"],
        "B profit factor >= 1.5": lambda f: f["pf_ok"],
        "C both (the question)": lambda f: f["green7"] and f["pf_ok"],
        "D profit/volume >= +3%": lambda f: f["ppv60"] >= 0.03,
        "E top 20% profit/volume": lambda f: f["ppv60"] >= q80,
        "F D and green 7d": lambda f: f["ppv60"] >= 0.03 and f["green7"],
    }
    print("\nShare of eligible wallets selected:", {k: f"{sum(fn(f) for f in elig)} ({sum(fn(f) for f in elig) / len(elig):.0%})" for k, fn in sel.items()})
    for h in (14, 30):
        rows = []
        for f in elig:
            dp, dv = forward(f["pts"], f["tl"], h)
            rows.append(dict(f=f, dp=dp, dv=dv))
        active = [r for r in rows if r["dv"] >= 500]
        print(f"\n=== forward {h} days: {len(active)} of {len(rows)} eligible wallets traded >= $500 ({len(rows) - len(active)} went quiet) ===")
        wlo, whi = winsor_bounds(active)
        print(f"winsorizing per-wallet returns at [{wlo:+.3f}, {whi:+.3f}] (5th/95th percentile of all followed wallets)")
        top = sorted(active, key=lambda r: -r["dp"])
        print(f"largest single forward gain: ${top[0]['dp']:,.0f} (wallet traded ${top[0]['dv']:,.0f}); wallets with a forward gain above $5,000: {sum(r['dp'] > 5000 for r in active)}")
        print(f"all eligible: pooled return {pooled(active):+.4f} per $ traded | median per-wallet {statistics.median(r['dp'] / r['dv'] for r in active):+.4f} | share positive {sum(r['dp'] > 0 for r in active) / len(active):.1%}")
        for name, fn in sel.items():
            s = [r for r in active if fn(r["f"])]
            c = [r for r in active if not fn(r["f"])]
            if len(s) < 15:
                print(f"  {name:24s} n={len(s)} too few")
                continue
            lo, hi = boot_diff(s, c)
            s_trim = [r for r in s if r is not max(s, key=lambda z: z["dp"])]
            e_s, e_c = ew(s, wlo, whi), ew(c, wlo, whi)
            elo_, ehi_ = boot_robust(s, c, lambda z: ew(z, wlo, whi))
            k_s, k_c = capped(s), capped(c)
            klo_, khi_ = boot_robust(s, c, capped)
            print(f"      PRIMARY  equal-weight winsorized mean: selected {e_s:+.4f} vs others {e_c:+.4f} | diff {e_s - e_c:+.4f} [{elo_:+.4f},{ehi_:+.4f}]   ||   turnover capped at $100k: selected {k_s:+.4f} vs others {k_c:+.4f} | diff {k_s - k_c:+.4f} [{klo_:+.4f},{khi_:+.4f}]")
            print(f"      secondary: pooled without its single biggest winner {pooled(s_trim):+.4f}")
            print(f"  {name:24s} n={len(s):4d} pooled {pooled(s):+.4f} | median {statistics.median(r['dp'] / r['dv'] for r in s):+.4f} | positive {sum(r['dp'] > 0 for r in s) / len(s):5.1%} || others n={len(c):4d} pooled {pooled(c):+.4f} positive {sum(r['dp'] > 0 for r in c) / len(c):5.1%} || diff {pooled(s) - pooled(c):+.4f} [{lo:+.4f},{hi:+.4f}]")
        x1 = [min(r["f"]["pf"], 10) for r in active]
        x2 = [r["f"]["pnl7"] / max(r["f"]["v30"], 1) for r in active]
        y = [r["dp"] / r["dv"] for r in active]
        x3 = [r["f"]["ppv60"] if r["f"]["ppv60"] == r["f"]["ppv60"] else 0.0 for r in active]
        print(f"  rank correlation with forward return: past profit factor {spearman(x1, y):+.3f} | last-7-day PnL per $ traded {spearman(x2, y):+.3f} | profit per volume (60d) {spearman(x3, y):+.3f}  (0 = no persistence)")


if __name__ == "__main__":
    {"fetch": cmd_fetch, "refetch": cmd_refetch, "report": cmd_report}[sys.argv[1] if len(sys.argv) > 1 else "report"]()
