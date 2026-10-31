#!/usr/bin/env python3
"""Does a wallet's recent form (streaks, win rate, profit factor) predict its NEXT position? And does any subgroup make money?

  python3 scripts/wallet-form-study.py fetch  [--dir D] [--matches Worlds]   # top holders of finished matches -> their histories (~8 min)
  python3 scripts/wallet-form-study.py report [--dir D]

DATA TRAPS this script exists to document (each one produced a wrong conclusion once):
 1. /closed-positions lists only sold or redeemed positions, so it is biased toward winners (76% win rate, +47% ROI: impossible).
 2. /positions holds the resolved-but-unredeemed positions (mostly losers), but reaches years back while closed-positions is capped at the
    250 newest rows. Merge both and cut everything older than the oldest closed row, or the bias flips to losers (31% win rate).
 3. After merging, CHECK: win rate should match the average entry price and ROI should sit slightly below zero (fees/spread).
 4. Timestamps differ in kind (exact close time vs date-only market end). A streak effect that flips sign when the required gap between the
    streak and the bet goes from 12h to 24h is an ordering artifact, not a finding.
"""
import argparse, collections, concurrent.futures as cf, datetime as dt, json, os, random, statistics as st, threading, time, urllib.request

UA = {"User-Agent": "polymarket-radar/0.1"}
lock, last = threading.Lock(), [0.0]

def get(url):
    for i in range(4):
        with lock:
            wait = last[0] + 0.08 - time.time()
            if wait > 0: time.sleep(wait)
            last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r: return json.load(r)
        except Exception: time.sleep(1 + i)
    return None

def cmd_fetch(a):
    os.makedirs(f"{a.dir}/wallets", exist_ok=True); os.makedirs(f"{a.dir}/pos", exist_ok=True)
    matches = []
    for off in range(0, 600, 100):
        page = get(f"https://gamma-api.polymarket.com/events?tag_slug=esports&closed=true&limit=100&offset={off}&order=startDate&ascending=false") or []
        for e in page:
            if a.matches.lower() in e["title"].lower():
                for m in e["markets"]:
                    if m.get("sportsMarketType") == "moneyline": matches.append(m["conditionId"])
    def holders(cid):
        h = get(f"https://data-api.polymarket.com/holders?market={cid}&limit=20") or []
        return [x["proxyWallet"].lower() for g in h for x in g["holders"]]
    with cf.ThreadPoolExecutor(6) as ex: wallets = sorted({w for l in ex.map(holders, matches) for w in l})
    print(f"{len(matches)} matches, {len(wallets)} wallets")
    def one(w):
        c_path, p_path = f"{a.dir}/wallets/{w}.json", f"{a.dir}/pos/{w}.json"
        if not os.path.exists(c_path):
            closed = []
            for off in range(0, 250, 50):
                p = get(f"https://data-api.polymarket.com/closed-positions?user={w}&limit=50&offset={off}&sortBy=TIMESTAMP&sortDirection=DESC")
                if p is None: return
                closed += p
                if len(p) < 50: break
            json.dump(closed, open(c_path, "w"))
        if not os.path.exists(p_path):
            pos = []
            for off in range(0, 2000, 500):
                p = get(f"https://data-api.polymarket.com/positions?user={w}&limit=500&offset={off}&sizeThreshold=0")
                if p is None: return
                pos += p
                if len(p) < 500: break
            json.dump(pos, open(p_path, "w"))
    t0 = time.time()
    with cf.ThreadPoolExecutor(6) as ex: list(ex.map(lambda w: None if time.time() - t0 > a.budget else one(w), wallets))
    print(f"{len(os.listdir(a.dir + '/pos'))}/{len(wallets)} wallets on disk (re-run to resume)")

def end_ts(d):
    try: return dt.datetime.fromisoformat(str(d)[:10]).replace(tzinfo=dt.timezone.utc).timestamp() + 43200
    except Exception: return None

def load_people(base):
    people = {}
    for f in os.listdir(f"{base}/wallets"):
        w = f[:-5]
        closed = json.load(open(f"{base}/wallets/{f}"))
        pos = json.load(open(f"{base}/pos/{w}.json")) if os.path.exists(f"{base}/pos/{w}.json") else []
        cutoff = min((float(r["timestamp"]) for r in closed if r.get("timestamp")), default=-1e18) if len(closed) >= 250 else -1e18  # trap 2
        P = {}
        for r in closed:
            try: ap, tb, pnl, ts = float(r["avgPrice"]), float(r["totalBought"]), float(r["realizedPnl"]), float(r["timestamp"])
            except Exception: continue
            P[(r["conditionId"], r["outcomeIndex"])] = dict(ts=ts, ap=ap, cost=ap * tb, pnl=pnl, title=r.get("title") or "", ev=r.get("eventSlug") or "")
        for r in pos:
            key = (r["conditionId"], r["outcomeIndex"])
            if not r.get("redeemable") or key in P: continue
            ts = end_ts(r.get("endDate"))
            if ts is None or ts < cutoff: continue
            try: ap, tb, pnl = float(r["avgPrice"]), float(r["totalBought"]), float(r["realizedPnl"] or 0) + float(r["cashPnl"] or 0)
            except Exception: continue
            P[key] = dict(ts=ts, ap=ap, cost=ap * tb, pnl=pnl, title=r.get("title") or "", ev=r.get("eventSlug") or "")
        L = []
        for p in P.values():
            if 0 < p["ap"] < 1 and p["cost"] >= 20:
                p["roi"], p["win"] = max(-1.0, min(5.0, p["pnl"] / p["cost"])), p["pnl"] > 0
                L.append(p)
        L.sort(key=lambda x: x["ts"])
        if len(L) >= 30 and len(L) / (max(L[-1]["ts"] - L[0]["ts"], 43200) / 86400) <= 15 and st.median(p["cost"] for p in L) >= 12: people[w] = L  # machines out
    return people

isgame = lambda p: " vs" in p["title"].lower()

def build_rows(people, gap):
    bucket = collections.defaultdict(list)
    for L in people.values():
        for p in L:
            if isgame(p): bucket[min(int(p["ap"] * 20), 19)].append(p["roi"])
    bmean = {b: sum(v) / len(v) for b, v in bucket.items()}
    rows = []
    for w, L in people.items():
        G = [p for p in L if isgame(p)]
        for i, p in enumerate(G):
            prior = [q for q in G[:i] if q["ts"] <= p["ts"] - gap and q["ev"] != p["ev"]]
            if len(prior) < 20: continue
            l3 = prior[-3:]
            rows.append(dict(w=w, roi=p["roi"], ex=p["roi"] - bmean[min(int(p["ap"] * 20), 19)], hot=all(q["win"] for q in l3), cold=all(not q["win"] for q in l3)))
    return rows

def within_diff(rows, key="ex"):
    g, o = collections.defaultdict(list), collections.defaultdict(list)
    for r in rows:
        (g if r["hot"] else o if r["cold"] else collections.defaultdict(list))[r["w"]].append(r[key])
    d = {w: sum(g[w]) / len(g[w]) - sum(o[w]) / len(o[w]) for w in g if w in o and len(g[w]) >= 3 and len(o[w]) >= 3}
    random.seed(1)
    boots = sorted(sum(d[random.choice(list(d))] for _ in d) / len(d) for _ in range(1500))
    return sum(d.values()) / len(d), boots[37], boots[1462], len(d)

def cmd_report(a):
    people = load_people(a.dir)
    allp = [p for L in people.values() for p in L]
    print(f"{len(people)} people-like wallets, {len(allp)} positions")
    print(f"BIAS CHECK (trap 3): win rate {100 * sum(p['win'] for p in allp) / len(allp):.1f}% vs mean entry price {100 * sum(p['ap'] for p in allp) / len(allp):.1f}%, "
          f"mean ROI {100 * sum(p['roi'] for p in allp) / len(allp):+.1f}% (expect equal win rate / entry and ROI slightly below 0)")
    print("\nH1 3-win vs 3-loss streak, price-adjusted, within wallet, by required gap before the bet (trap 4: must NOT flip sign):")
    for hours in (12, 24, 48, 96):
        m, lo, hi, n = within_diff(build_rows(people, hours * 3600))
        print(f"  gap {hours:>3}h: {m * 100:+6.1f}pp [{lo * 100:+6.1f}, {hi * 100:+6.1f}] over {n} wallets")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["fetch", "report"])
    ap.add_argument("--dir", default=os.path.join(os.environ.get("TMPDIR", "/tmp"), "wallet_form"))
    ap.add_argument("--matches", default="Worlds")
    ap.add_argument("--budget", type=int, default=2400)
    args = ap.parse_args()
    {"fetch": cmd_fetch, "report": cmd_report}[args.cmd](args)
