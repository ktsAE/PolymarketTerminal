#!/usr/bin/env python3
"""Is there a price-band edge across resolved Polymarket markets? (train on older 60%, test on newer 40%)

  python3 scripts/calibration-study.py fetch  [--dir D] [--n 4500]    # ~10 min: universe + price history (12h resolution)
  python3 scripts/calibration-study.py report [--dir D]

Strategies: at T-3/7/14/30 days before resolution, buy NO when YES is 3-20% / 20-50%, or buy YES at 50-80% / 80-97%, per category.
Returns are per $ staked at the last traded price BEFORE spread and fees (real fills are 1-3 points worse). Bootstrap clusters by event.
Pitfalls: price history for closed markets only works with interval=max&fidelity>=720 (fidelity=60 returns empty);
`closedTime` can lag the real event, so keep to prices well inside 0.02-0.98.
"""
import argparse, collections, concurrent.futures as cf, datetime as dt, json, math, os, random, threading, time, urllib.request

UA = {"User-Agent": "polymarket-radar/0.1"}
lock, last = threading.Lock(), [0.0]
def get(u):
    for _ in range(3):
        with lock:
            w = last[0] + 0.05 - time.time()
            if w > 0: time.sleep(w)
            last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30) as r: return json.load(r)
        except Exception: time.sleep(0.6)

def fetch(a):
    os.makedirs(a.dir, exist_ok=True); cand = []
    for off in range(0, 6000, 100):
        page = get(f"https://gamma-api.polymarket.com/events?closed=true&limit=100&offset={off}&order=volume&ascending=false")
        if not page: break
        for e in page:
            for m in e["markets"]:
                try: pr = [float(x) for x in json.loads(m["outcomePrices"])]; toks = json.loads(m["clobTokenIds"]); outs = json.loads(m["outcomes"])
                except Exception: continue
                if len(pr) != 2 or sorted(pr) != [0.0, 1.0] or [o.lower() for o in outs] != ["yes", "no"] or float(m.get("volume") or 0) < 30000: continue
                ct = m.get("closedTime") or m.get("endDate")
                try: t = dt.datetime.fromisoformat(ct.replace(" ", "T").replace("+00", "+00:00").replace("Z", "+00:00")).timestamp()
                except Exception: continue
                cand.append(dict(cid=m["conditionId"], ev=e["slug"], yes=toks[0], y=1 if pr[0] == 1.0 else 0, end=t, tags=[x.get("slug") for x in (e.get("tags") or [])][:6]))
    json.dump(cand, open(f"{a.dir}/cand.json", "w"))
    random.seed(7); random.shuffle(cand); path = f"{a.dir}/hist.json"
    hist = json.load(open(path)) if os.path.exists(path) else {}
    def one(c):
        if c["cid"] in hist: return
        r = get(f"https://clob.polymarket.com/prices-history?market={c['yes']}&interval=max&fidelity=720")
        if r and r.get("history") is not None: hist[c["cid"]] = [[p["t"], p["p"]] for p in r["history"]]
    with cf.ThreadPoolExecutor(10) as ex: list(ex.map(one, cand[:a.n]))
    json.dump(hist, open(path, "w")); print(len(hist), "histories (re-run to resume)")

def price_at(h, t):
    best = None
    for ts, p in h:
        if ts <= t: best = p
        else: break
    return best

def report(a):
    cand = {c["cid"]: c for c in json.load(open(f"{a.dir}/cand.json"))}; hist = json.load(open(f"{a.dir}/hist.json")); rows = []
    for cid, h in hist.items():
        c = cand[cid]
        if len(h) < 4: continue
        for hz in (3, 7, 14, 30):
            if hz * 86400 > (c["end"] - h[0][0]) * 0.9: continue
            p = price_at(h, c["end"] - hz * 86400)
            if p is not None and 0.02 <= p <= 0.98: rows.append(dict(ev=c["ev"], hz=hz, p=p, y=c["y"], end=c["end"], tags=set(c["tags"])))
    cut = sorted({r["end"] for r in rows})[int(len({r["end"] for r in rows}) * 0.6)]
    train, test = [r for r in rows if r["end"] < cut], [r for r in rows if r["end"] >= cut]
    ret = lambda r, s: (1 - r["y"]) / (1 - r["p"]) - 1 if s == "no" else r["y"] / r["p"] - 1
    random.seed(11)
    def stat(sub, side, B=500):
        evs = collections.defaultdict(list)
        for r in sub: evs[r["ev"]].append(ret(r, side))
        ks = list(evs); n = sum(map(len, evs.values())); m = sum(map(sum, evs.values())) / n; out = []
        for _ in range(B):
            s = [random.choice(ks) for _ in ks]; out.append(sum(sum(evs[k]) for k in s) / max(1, sum(len(evs[k]) for k in s)))
        out.sort(); return n, m, out[int(B * .025)], out[int(B * .975)]
    cats = {"all": None, "politics": "politics", "sports": "sports", "crypto": "crypto", "pop-culture": "pop-culture", "tweets": "tweets-markets"}
    strat = [("NO @ YES 3-20%", .03, .20, "no"), ("NO @ YES 20-50%", .20, .50, "no"), ("YES @ 50-80%", .50, .80, "yes"), ("YES @ 80-97%", .80, .97, "yes")]
    res = []
    for cn, tag in cats.items():
        for hz in (3, 7, 14, 30):
            for name, lo, hi, side in strat:
                f = lambda S: [r for r in S if r["hz"] == hz and lo <= r["p"] < hi and (tag is None or tag in r["tags"])]
                x, y = f(train), f(test)
                if len(x) >= 50 and len(y) >= 25: res.append((cn, hz, name, stat(x, side), stat(y, side)))
    sig = [r for r in res if r[3][2] > 0]
    print(f"{len(rows)} obs, {len(res)} cells; train-significant {len(sig)} (chance ~{len(res) * .025:.1f})")
    for cn, hz, name, ta, tb in sig: print(f"  {cn} T-{hz}d {name}: train {ta[1]*100:+.1f}% [{ta[2]*100:+.1f},{ta[3]*100:+.1f}] -> test {tb[1]*100:+.1f}% [{tb[2]*100:+.1f},{tb[3]*100:+.1f}]")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["fetch", "report"])
    ap.add_argument("--dir", default=os.path.join(os.environ.get("TMPDIR", "/tmp"), "calib")); ap.add_argument("--n", type=int, default=4500)
    a = ap.parse_args(); {"fetch": fetch, "report": report}[a.cmd](a)
