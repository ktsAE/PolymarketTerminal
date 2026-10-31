#!/usr/bin/env python3
"""Do the top human holders of a game market know something the price does not? (retrospective study)

For esports game moneylines that already finished, rebuild every wallet's holdings T seconds before kickoff from
the full fill history (both sides), drop machines, and ask whether the holders' dollar tilt versus the market price
predicted who won. PnL weighting uses ONLY games that had already finished by T (no lookahead).

  python3 scripts/holders-study.py fetch  [--dir D] [--games 260]   # download fills (slow, ~10 min, polite rate limit)
  python3 scripts/holders-study.py report [--dir D]                  # run the analysis on what was downloaded

Output rows: "follow-tilt edge" = average of (outcome - price) in the direction the holders lean, in probability points.
Positive = following them beat the price. Read the confidence interval before the number.
"""
import argparse, collections, concurrent.futures as cf, datetime as dt, json, os, random, threading, time, urllib.request

UA = {"User-Agent": "polymarket-radar/0.1"}
GAMES = ("Counter-Strike", "Dota 2", "Valorant", "LoL")

lock, last = threading.Lock(), [0.0]
def get(url):
    for i in range(4):
        with lock:
            wait = last[0] + 0.11 - time.time()
            if wait > 0: time.sleep(wait)
            last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r: return json.load(r)
        except Exception: time.sleep(1 + i)
    return None

def pick_games(n):
    out = []
    for off in range(0, 1500, 100):
        page = get(f"https://gamma-api.polymarket.com/events?tag_slug=esports&closed=true&limit=100&offset={off}&order=startDate&ascending=false")
        if not page: break
        for e in page:
            game = e["title"].split(":")[0] if ":" in e["title"] else ""
            for m in e["markets"]:
                if m.get("sportsMarketType") != "moneyline" or game not in GAMES or not m.get("gameStartTime"): continue
                try: res = sorted(float(x) for x in json.loads(m["outcomePrices"]))
                except Exception: continue
                vol = float(m.get("volume") or 0)
                if res == [0.0, 1.0] and 40_000 <= vol <= 900_000:
                    start = dt.datetime.fromisoformat(m["gameStartTime"].replace(" ", "T").replace("+00", "+00:00")).timestamp()
                    out.append(dict(cid=m["conditionId"], title=e["title"], start=start, vol=vol, result=[float(x) for x in json.loads(m["outcomePrices"])]))
    out.sort(key=lambda c: c["start"])
    return out[-n:]

def fetch_fills(c, base):
    path = f"{base}/games/{c['cid'][:16]}.json"
    if os.path.exists(path): return
    rows, end, seen = [], None, set()
    for _ in range(30):
        min_ts, done = None, False
        for off in range(0, 10000, 1000):
            page = get(f"https://data-api.polymarket.com/trades?market={c['cid']}&takerOnly=false&limit=1000&offset={off}" + (f"&end={end}" if end else ""))
            if page is None: return
            for r in page:
                k = (r.get("transactionHash"), r["proxyWallet"], r["side"], r["size"], r["timestamp"])
                if k in seen: continue
                seen.add(k)
                rows.append([r["proxyWallet"].lower(), 1 if r["side"] == "BUY" else 0, r["outcomeIndex"], r["size"], r["price"], r["timestamp"]])
                min_ts = r["timestamp"] if min_ts is None else min(min_ts, r["timestamp"])
            if len(page) < 1000: done = True; break
        if done or min_ts is None or min_ts == end: break
        end = min_ts
    json.dump(rows, open(path, "w"))

def cmd_fetch(a):
    os.makedirs(f"{a.dir}/games", exist_ok=True)
    sample = pick_games(a.games)
    json.dump(sample, open(f"{a.dir}/games_sample.json", "w"))
    t0 = time.time()
    with cf.ThreadPoolExecutor(4) as ex: list(ex.map(lambda c: fetch_fills(c, a.dir), sample))
    print(f"{len(os.listdir(a.dir + '/games'))}/{len(sample)} games on disk in {time.time() - t0:.0f}s (re-run to resume)")

def market_pnl(g):
    pnl, net = collections.defaultdict(float), collections.defaultdict(lambda: [0.0, 0.0])
    for w, b, o, sz, px, ts in g["rows"]:
        pnl[w] += -sz * px if b else sz * px
        net[w][o] += sz if b else -sz
    win = 0 if g["y"] == 1 else 1
    for w, shares in net.items(): pnl[w] += shares[win]
    return pnl

def load(base):
    sample = json.load(open(f"{base}/games_sample.json"))
    games = []
    for c in sample:
        p = f"{base}/games/{c['cid'][:16]}.json"
        if not os.path.exists(p): continue
        rows = sorted(json.load(open(p)), key=lambda r: r[5])
        if len(rows) < 150: continue
        games.append(dict(c=c, rows=rows, y=1 if c["result"][0] == 1.0 else 0, S=c["start"], Rm=max(rows[-1][5], c["start"] + 1800)))
    games.sort(key=lambda g: g["S"])
    for g in games: g["pnl"] = market_pnl(g)
    counts = collections.defaultdict(list)
    for g in games:
        for w, n in collections.Counter(r[0] for r in g["rows"]).items(): counts[w].append(n)
    machines = {w for w, l in counts.items() if sum(1 for n in l if n >= 100) >= 3 or sum(l) >= 3000}
    return games, machines

def observations(games, machines, t_off, k, mode, min_prior=5, thr=500):
    out = []
    for gi, g in enumerate(games):
        T = g["S"] - t_off
        past = [r for r in g["rows"] if r[5] <= T]
        if len(past) < 100: continue
        recent = past[-20:]
        vol = sum(r[3] for r in recent)
        p = sum((r[4] if r[2] == 0 else 1 - r[4]) * r[3] for r in recent) / vol
        if not 0.05 <= p <= 0.95: continue
        net, fills = collections.defaultdict(lambda: [0.0, 0.0]), collections.Counter()
        for w, b, o, sz, px, ts in past:
            net[w][o] += sz if b else -sz
            fills[w] += 1
        prior, prior_n = collections.defaultdict(float), collections.Counter()
        if mode in ("smart", "losers"):
            for h in games[:gi]:
                if h["Rm"] <= T:
                    for w, v in h["pnl"].items(): prior[w] += v; prior_n[w] += 1
        a_vals, b_vals = [], []
        for w, (a, b) in net.items():
            a, b = max(a, 0), max(b, 0)
            if a + b <= 0: continue
            lo, hi = sorted((a, b))
            machine = fills[w] >= 150 or (hi > 0 and lo / hi >= 0.2) or w in machines
            if mode != "all" and machine: continue
            if mode == "smart" and not (prior_n[w] >= min_prior and prior[w] > thr): continue
            if mode == "losers" and not (prior_n[w] >= min_prior and prior[w] < -thr): continue
            if a > 0: a_vals.append(a * p)
            if b > 0: b_vals.append(b * (1 - p))
        a_vals, b_vals = sorted(a_vals, reverse=True)[:k], sorted(b_vals, reverse=True)[:k]
        need = 1 if mode in ("smart", "losers") else 3
        va, vb = sum(a_vals), sum(b_vals)
        if len(a_vals) + len(b_vals) < need or va + vb < 2_000: continue
        out.append((va / (va + vb) - p, g["y"] - p))
    return out

def describe(label, rows):
    follow = [(e if s > 0 else -e) for s, e in rows if s != 0]
    if len(follow) < 15: return f"{label:<26} n={len(follow):<4} (too few)"
    random.seed(1)
    boots = sorted(sum(random.choice(follow) for _ in follow) / len(follow) for _ in range(3000))
    return f"{label:<26} n={len(follow):<4} edge {sum(follow) / len(follow) * 100:+5.1f}pp  95% CI [{boots[75] * 100:+5.1f}, {boots[2925] * 100:+5.1f}]"

def cmd_report(a):
    games, machines = load(a.dir)
    print(f"{len(games)} games, {len(machines)} wallets screened as machines across the sample")
    for t_off, name in ((7200, "2h before start"), (300, "5 min before start")):
        print(f"\n== {name} ==")
        for mode, label in (("all", "all holders"), ("people", "people only"), ("smart", "prior winners"), ("losers", "prior losers")):
            for k in (10, 20, 50): print(describe(f"{label} top-{k}", observations(games, machines, t_off, k, mode)))

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["fetch", "report"])
    ap.add_argument("--dir", default=os.path.join(os.environ.get("TMPDIR", "/tmp"), "holder_study"))
    ap.add_argument("--games", type=int, default=260)
    args = ap.parse_args()
    {"fetch": cmd_fetch, "report": cmd_report}[args.cmd](args)
