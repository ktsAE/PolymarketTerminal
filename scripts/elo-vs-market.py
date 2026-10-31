#!/usr/bin/env python3
"""Does a simple Elo rating (built only from Polymarket-resolved esports matches) add information beyond the market's closing price?

  python3 scripts/elo-vs-market.py fetch  [--dir D]     # ~4 min: resolved esports moneylines + 10-minute price series before kickoff
  python3 scripts/elo-vs-market.py report [--dir D]

Closing price = last price at least 5 minutes before kickoff. Elo is online (each match is predicted before it updates the ratings).
Prices for closed markets: use startTs/endTs windows (fidelity 10); interval=max&fidelity=60 returns nothing.
Returns are per $ at the closing price, before spread and fees.
"""
import argparse, collections, concurrent.futures as cf, datetime as dt, json, math, os, random, re, threading, time, urllib.request

UA = {"User-Agent": "polymarket-radar/0.1"}
T = re.compile(r"^(Counter-Strike|LoL|Dota 2|Valorant): (.+?) vs\.? (.+?) \((BO\d)\)(?: - (.+))?$")
lock, last = threading.Lock(), [0.0]
def get(u):
    for _ in range(3):
        with lock:
            w = last[0] + 0.04 - time.time()
            if w > 0: time.sleep(w)
            last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers=UA), timeout=30) as r: return json.load(r)
        except Exception: time.sleep(0.4)

def fetch(a):
    os.makedirs(a.dir, exist_ok=True); games = []
    for off in range(0, 12000, 100):
        page = get(f"https://gamma-api.polymarket.com/events?tag_slug=esports&closed=true&limit=100&offset={off}&order=startDate&ascending=false")
        if not page: break
        for e in page:
            m0 = T.match(e["title"])
            for m in e["markets"] if m0 else []:
                if m.get("sportsMarketType") != "moneyline" or not m.get("gameStartTime"): continue
                try: pr = [float(x) for x in json.loads(m["outcomePrices"])]; toks = json.loads(m["clobTokenIds"]); outs = json.loads(m["outcomes"])
                except Exception: continue
                if sorted(pr) != [0.0, 1.0]: continue
                st = dt.datetime.fromisoformat(m["gameStartTime"].replace(" ", "T").replace("+00", "+00:00")).timestamp()
                games.append(dict(cid=m["conditionId"], game=m0.group(1), a=outs[0].strip(), b=outs[1].strip(), start=st, y0=1 if pr[0] == 1.0 else 0, tok=toks[0]))
    json.dump(games, open(f"{a.dir}/games.json", "w")); px = {}
    def one(x):
        r = get(f"https://clob.polymarket.com/prices-history?market={x['tok']}&startTs={int(x['start'] - 9 * 3600)}&endTs={int(x['start'])}&fidelity=10")
        if r is not None and r.get("history") is not None: px[x["cid"]] = [[p["t"], p["p"]] for p in r["history"]]
    with cf.ThreadPoolExecutor(10) as ex: list(ex.map(one, games))
    json.dump(px, open(f"{a.dir}/px.json", "w")); print(len(games), "games,", len(px), "price series")

def report(a):
    G = sorted(json.load(open(f"{a.dir}/games.json")), key=lambda x: x["start"]); PX = json.load(open(f"{a.dir}/px.json"))
    elo = collections.defaultdict(lambda: 1500.0); n = collections.Counter(); rows = []
    for x in G:
        ka, kb = (x["game"], x["a"].lower()), (x["game"], x["b"].lower())
        c = [p for t, p in (PX.get(x["cid"]) or []) if t <= x["start"] - 300]; pm = c[-1] if c else None
        pe = 1 / (1 + 10 ** ((elo[kb] - elo[ka]) / 400))
        if pm is not None and 0.03 <= pm <= 0.97: rows.append(dict(y=x["y0"], pm=pm, pe=pe, na=n[ka], nb=n[kb], start=x["start"]))
        elo[ka] += 24 * (x["y0"] - pe); elo[kb] -= 24 * (x["y0"] - pe); n[ka] += 1; n[kb] += 1
    mid = sorted(r["start"] for r in rows)[len(rows) // 2]; random.seed(4)
    def ci(v, B=800):
        o = sorted(sum(random.choice(v) for _ in v) / len(v) for _ in range(B)); return o[int(B * .025)], o[int(B * .975)]
    print(len(rows), "matches with a closing price")
    for mn in (3, 5):
        for nm, sub in (("older", lambda r: r["start"] < mid), ("newer", lambda r: r["start"] >= mid)):
            s = [r for r in rows if r["na"] >= mn and r["nb"] >= mn and abs(r["pe"] - r["pm"]) >= 0.05 and sub(r)]
            rt = [(r["y"] / r["pm"] - 1) if r["pe"] > r["pm"] else ((1 - r["y"]) / (1 - r["pm"]) - 1) for r in s]
            if len(rt) >= 25: lo, hi = ci(rt); print(f"Elo disagrees >=5pts, teams >={mn} prior results, {nm}: n={len(rt)} ROI {sum(rt)/len(rt)*100:+.1f}% [{lo*100:+.1f},{hi*100:+.1f}]")

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("cmd", choices=["fetch", "report"])
    ap.add_argument("--dir", default=os.path.join(os.environ.get("TMPDIR", "/tmp"), "elo")); a = ap.parse_args(); {"fetch": fetch, "report": report}[a.cmd](a)
