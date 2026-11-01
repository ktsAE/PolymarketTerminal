#!/usr/bin/env python3
"""Do sudden one-sided / concentrated / fresh-wallet volume surges predict how Polymarket markets resolve? (retrospective study)

  python3 scripts/surge-study.py fetch  [--dir D] [--n 2400]   # resumable; ~1 h of polite downloading (re-run until it says complete)
  python3 scripts/surge-study.py report [--dir D]

Rules are pre-registered in docs/research/radar/SURGE_STUDY.md (hash in <dir>/prereg.txt). In short:
  surge   = first fill time t where trailing-1h taker USD >= 8x the market's median complete clock hour so far (>= 12 hours of history,
            zero hours included) AND >= $2,000; window W = (t-1h, t]
  flags   = one-sided (>=75% of W's BUY USD on one outcome), concentrated (top-3 wallets >= 50% of W's USD),
            fresh (>= 50% of W's USD from wallets whose first fill in this market is inside W), young (t - createdAt < 7 days)
  trade   = buy the surge-direction outcome at the size-weighted price of fills in [t+5m, t+15m] (+1 cent), hold to resolution
  S1 all one-sided, S2 one-sided & young, S3 one-sided & concentrated & fresh, S4 fade each. Test = newer 40% by close time.
Behaviour labels only: a surge is "unusual flow", never evidence of an insider.
Cache (raw fills, gzip) lives outside the repo: ~/.hermes/cache/scratch/surge/.
"""
import argparse, bisect, collections, concurrent.futures as cf, datetime as dt, gzip, json, os, random, statistics, threading, time
import urllib.error, urllib.request

UA = {"User-Agent": "polymarket-radar/0.1"}
G, D = "https://gamma-api.polymarket.com", "https://data-api.polymarket.com"
VMIN, VMAX, PAGE_CAP = 10_000, 750_000, 40          # lifetime volume band; max 1000-fill pages per market (40k fills)
MULT, FLOOR, MIN_HOURS = 8, 2000.0, 12               # surge definition (frozen)
ONE_SIDED, CONC, FRESH, YOUNG = 0.75, 0.50, 0.50, 7 * 86400
DELAY, ENTRY_WIN, FALLBACK, SPREAD = 300, 600, 6 * 3600, 0.01
LO_P, HI_P = 0.03, 0.97
U0, U1 = dt.datetime(2025, 11, 1, tzinfo=dt.timezone.utc).timestamp(), dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc).timestamp()

# ---------------------------------------------------------------- http: per-host pacing, back off on 429, 404/422 are answers
locks, last = collections.defaultdict(threading.Lock), collections.defaultdict(float)
NOTFOUND, TOOLARGE = object(), object()
def get(url, pace=0.1):
    host = url.split("/")[2]
    for i in range(6):
        with locks[host]:
            w = last[host] + pace - time.time()
            if w > 0: time.sleep(w)
            last[host] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404: return NOTFOUND
            if e.code == 422: return TOOLARGE
            time.sleep((8 if e.code == 429 else 1) * (i + 1))
        except Exception: time.sleep(1 + i)
    return None

def save(obj, path, gz=False):  # atomic
    with (gzip.open if gz else open)(path + ".tmp", "wt") as f: json.dump(obj, f)
    os.replace(path + ".tmp", path)

def load_json(path):
    with (gzip.open if path.endswith(".gz") else open)(path, "rt") as f: return json.load(f)

def ts(s):
    if not s: return None
    try: return dt.datetime.fromisoformat(s.replace(" ", "T").replace("+00", "+00:00").replace("Z", "+00:00").replace("+00:00:00", "+00:00")).timestamp()
    except Exception: return None

def iso(t): return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

POLI = {"politics", "geopolitics", "elections", "world", "world-affairs", "global-elections", "foreign-policy", "middle-east", "ukraine", "trump"}
def category(tags):
    if "esports" in tags: return "esports"
    if "crypto" in tags: return "crypto"
    if "sports" in tags: return "sports"
    if tags & POLI: return "politics"
    return "other"

def slim(x):
    try: outs, pr = json.loads(x["outcomes"]), [float(v) for v in json.loads(x["outcomePrices"])]
    except Exception: return None
    evs = x.get("events") or []
    tags = {t.get("slug") for t in (x.get("tags") or []) if t.get("slug")}
    return dict(cid=x["conditionId"], slug=x["slug"], q=x.get("question", ""), ev=evs[0]["slug"] if evs else x["slug"],
                created=ts(x.get("createdAt")), end=ts(x.get("endDate")), closed=ts(x.get("closedTime")), outs=outs, res=pr,
                vol=float(x.get("volumeNum") or x.get("volume") or 0), cat=category(tags), tags=sorted(tags)[:12])

# ---------------------------------------------------------------- fetch stage 1: universe
def window_rows(d0, d1):
    out, off = [], 0
    while True:
        r = get(f"{G}/markets?closed=true&include_tag=true&limit=100&offset={off}&volume_num_min={VMIN}&volume_num_max={VMAX}"
                f"&end_date_min={iso(d0)}&end_date_max={iso(d1)}")
        if not isinstance(r, list):
            if r is not TOOLARGE or d1 - d0 < 1800: return None
            mid = (d0 + d1) // 2
            a_, b_ = window_rows(d0, mid), window_rows(mid, d1)
            return None if a_ is None or b_ is None else a_ + b_
        out += r
        if len(r) < 100: return out
        off += 100

def windows():
    rnd, out, t = random.Random(20261101), [], U0
    while t < U1:
        d = t + rnd.randrange(7) * 86400
        if d < U1: out.append((int(d), int(d + 86400), f"d{int(d)}"))
        t += 7 * 86400
    t = U1
    while t < U1 + 450 * 86400: out.append((int(t), int(t + 30 * 86400), f"f{int(t)}")); t += 30 * 86400
    return out

def stage_universe(a):
    os.makedirs(f"{a.dir}/universe", exist_ok=True)
    def one(w):
        p = f"{a.dir}/universe/{w[2]}.json"
        if os.path.exists(p): return
        rows = window_rows(w[0], w[1])
        if rows is not None: save([m for m in (slim(x) for x in rows) if m], p)
    ws = windows()
    with cf.ThreadPoolExecutor(6) as ex: list(ex.map(one, ws))
    have = sum(os.path.exists(f"{a.dir}/universe/{w[2]}.json") for w in ws)
    print(f"universe: {have}/{len(ws)} windows on disk")
    return have == len(ws)

# ---------------------------------------------------------------- fetch stage 2: stratified sample
def stage_sample(a):
    path = f"{a.dir}/sample.json"
    if os.path.exists(path): return load_json(path)
    seen, allm = set(), []
    for f in sorted(os.listdir(f"{a.dir}/universe")):
        for m in load_json(f"{a.dir}/universe/{f}"):
            if m["cid"] not in seen: seen.add(m["cid"]); allm.append(m)
    ok = [m for m in allm if len(m["outs"]) == 2 and sorted(m["res"]) == [0.0, 1.0] and m["created"] and m["end"]]
    rnd = random.Random(20261101)
    by_ev = collections.defaultdict(list)
    for m in ok: by_ev[m["ev"]].append(m)
    pool = [m for k in sorted(by_ev) for m in rnd.sample(by_ev[k], min(2, len(by_ev[k])))]
    strata = collections.defaultdict(list)
    for m in pool: m["life"] = "short" if m["end"] - m["created"] < 7 * 86400 else "long"; strata[(m["cat"], m["life"])].append(m)
    quota, chosen, rest = a.n // 10, [], []
    for k in sorted(strata):
        rnd.shuffle(strata[k]); chosen += strata[k][:quota]; rest += strata[k][quota:]
    rnd.shuffle(rest); chosen += rest[: max(0, a.n - len(chosen))]
    meta = dict(universe=len(allm), eligible=len(ok), events=len(by_ev), pool=len(pool),
                pool_strata={f"{c}/{l}": len(v) for (c, l), v in sorted(strata.items())})
    save(dict(meta=meta, markets=chosen), path)
    print("sample:", meta, "chosen", len(chosen))
    return dict(meta=meta, markets=chosen)

# ---------------------------------------------------------------- fetch stage 3: full taker fill history per market
def walk(cid):
    rows, seen, end, pages = [], set(), None, 0
    while True:
        mn, done = None, False
        for off in range(0, 10000, 1000):
            pg = get(f"{D}/trades?market={cid}&limit=1000&offset={off}" + (f"&end={end}" if end else "")); pages += 1
            if not isinstance(pg, list): return None, "err"
            for r in pg:
                k = (r.get("transactionHash"), r["proxyWallet"], r["side"], r["size"], r["timestamp"], r["outcomeIndex"], r["price"])
                if k in seen: continue
                seen.add(k)
                rows.append([r["proxyWallet"].lower(), 1 if r["side"] == "BUY" else 0, int(r["outcomeIndex"]), float(r["size"]), float(r["price"]), int(r["timestamp"])])
                mn = r["timestamp"] if mn is None else min(mn, r["timestamp"])
            if len(pg) < 1000: done = True; break
            if pages >= PAGE_CAP: return rows, "cap"
        if done or mn is None or mn == end: return rows, "ok"
        end = mn

def fpath(a, cid): return f"{a.dir}/fills/{cid[:20]}.json.gz"

def fetch_market(a, m):
    p = fpath(a, m["cid"])
    if os.path.exists(p): return
    rows, st = walk(m["cid"])
    if rows is None: return
    save(dict(status=st, rows=sorted(rows, key=lambda r: r[5]) if st == "ok" else []), p, gz=True)

def stage_fills(a, ms):
    os.makedirs(f"{a.dir}/fills", exist_ok=True)
    t0, done = time.time(), [0]
    def one(m):
        fetch_market(a, m); done[0] += 1
        if done[0] % 200 == 0: print(f"  fills {done[0]}/{len(ms)} ({time.time() - t0:.0f}s)", flush=True)
    with cf.ThreadPoolExecutor(12) as ex: list(ex.map(one, ms))
    have = sum(os.path.exists(fpath(a, m["cid"])) for m in ms)
    print(f"fills: {have}/{len(ms)} markets on disk in {time.time() - t0:.0f}s")
    return have == len(ms)

# ---------------------------------------------------------------- surge detection (frozen rules)
def close_time(m): return m["closed"] or m["end"]

def detect(m, rows):
    """First volume surge (a) in the market and its flags; None if there is none. rows sorted by time."""
    if not rows: return None
    usd = [r[3] * r[4] for r in rows]
    h0 = rows[0][5] // 3600
    hourly = collections.Counter()
    for r, u in zip(rows, usd): hourly[r[5] // 3600] += u
    base, nxt = [], h0          # sorted complete-hour volumes included so far; next hour index to add
    j, V, n = 0, 0.0, len(rows)
    ct = close_time(m)
    i = 0
    while i < n:
        t = rows[i][5]
        while i < n and rows[i][5] == t: V += usd[i]; i += 1
        while rows[j][5] <= t - 3600: V -= usd[j]; j += 1
        if t >= ct: break
        H = (t - 3600) // 3600 - 1
        while nxt <= H: bisect.insort(base, hourly.get(nxt, 0.0)); nxt += 1
        if len(base) < MIN_HOURS: continue
        k = len(base); B = base[k // 2] if k % 2 else (base[k // 2 - 1] + base[k // 2]) / 2
        if V >= MULT * B and V >= FLOOR: return flags(m, rows, usd, j, i, t, B, V)
    return None

def flags(m, rows, usd, j, i, t, B, V):
    W = range(j, i)
    buy = [0.0, 0.0]; wal = collections.Counter()
    for k in W:
        r = rows[k]; wal[r[0]] += usd[k]
        if r[1] == 1: buy[r[2]] += usd[k]
    first = {}
    for r in rows[:i]: first.setdefault(r[0], r[5])
    tot = sum(usd[k] for k in W)
    d = 0 if buy[0] >= buy[1] else 1
    bs = buy[d] / sum(buy) if sum(buy) else 0.0
    top3 = sum(v for _, v in wal.most_common(3)) / tot
    fresh = sum(v for w, v in wal.items() if first[w] > t - 3600) / tot
    return dict(t=t, B=B, V=V, d=d, buy_share=bs, one_sided=sum(buy) > 0 and bs >= ONE_SIDED, top3=top3, conc=top3 >= CONC,
                fresh_share=fresh, fresh=fresh >= FRESH, young=t - m["created"] < YOUNG, age_d=(t - m["created"]) / 86400,
                to_close_h=(close_time(m) - t) / 3600, fills=i - j, top_wallets=[w for w, _ in wal.most_common(5)],
                wallet_usd=dict(wal.most_common(5)), first_in_w={w: first[w] > t - 3600 for w, _ in wal.most_common(5)})

def entry_price(m, rows, s):
    """Size-weighted price of outcome d over [t+5m, t+15m]; else first fill within 6h after t+5m."""
    t0, d = s["t"] + DELAY, s["d"]
    k = bisect.bisect_left([r[5] for r in rows], t0)
    win = [r for r in rows[k:] if r[5] <= t0 + ENTRY_WIN]
    px = lambda r: r[4] if r[2] == d else 1 - r[4]
    if win: return sum(px(r) * r[3] for r in win) / sum(r[3] for r in win), t0
    if k < len(rows) and rows[k][5] <= t0 + FALLBACK: return px(rows[k]), rows[k][5]
    return None, t0

# ---------------------------------------------------------------- fetch stage 4: account ages for 100 one-sided surges
def stage_profiles(a, ms):
    path = f"{a.dir}/profiles.json"
    if os.path.exists(path) and load_json(path).get("done"): return
    sur = []
    for m in ms:
        p = fpath(a, m["cid"])
        if not os.path.exists(p): continue
        d = load_json(p)
        if d["status"] != "ok": continue
        s = detect(m, d["rows"])
        if s and s["one_sided"]: sur.append((m["cid"], s))
    pick = random.Random(100).sample(sur, min(100, len(sur)))
    want = sorted({w for _, s in pick for w in s["top_wallets"]})
    prof = {}
    lk = threading.Lock()
    def one(w):
        r = get(f"{G}/public-profile?address={w}")
        c, src = (ts(r.get("createdAt")), "profile") if isinstance(r, dict) else (None, None)
        if c is None:
            act = get(f"{D}/activity?user={w}&limit=1&sortDirection=ASC")
            if isinstance(act, list) and act: c, src = float(act[0]["timestamp"]), "first_activity"
        with lk: prof[w] = [c, src]
    with cf.ThreadPoolExecutor(6) as ex: list(ex.map(one, want))
    save(dict(done=True, surges=[c for c, _ in pick], wallets=prof), path)
    print(f"profiles: {len(pick)} surges, {len(want)} wallets, {sum(v[0] is not None for v in prof.values())} with an age")

def cmd_fetch(a):
    os.makedirs(a.dir, exist_ok=True)
    if not stage_universe(a): print("universe incomplete; re-run fetch"); return
    s = stage_sample(a)
    if not stage_fills(a, s["markets"]): print("fills incomplete; re-run fetch"); return
    stage_profiles(a, s["markets"])
    print("fetch complete")

# ---------------------------------------------------------------- statistics
def boot(rows, B=2000, seed=11):
    """rows = [(event, value)] -> n, mean, 95% lo/hi, 98.3% lo/hi (event-clustered bootstrap of the mean)."""
    if not rows: return dict(n=0)
    ev = collections.defaultdict(list)
    for e, v in rows: ev[e].append(v)
    ks, n = list(ev), len(rows)
    rnd, out = random.Random(seed), []
    for _ in range(B):
        sm = cnt = 0
        for _ in ks:
            vs = ev[ks[rnd.randrange(len(ks))]]; sm += sum(vs); cnt += len(vs)
        out.append(sm / cnt)
    out.sort()
    q = lambda p: out[min(B - 1, int(B * p))]
    return dict(n=n, ev=len(ks), mean=sum(v for _, v in rows) / n, lo=q(.025), hi=q(.975), blo=q(.05 / 3 / 2), bhi=q(1 - .05 / 3 / 2))

def fmt(st, unit="%"):
    if not st["n"]: return "n=0"
    return f"n={st['n']:<4} ({st['ev']} ev) {st['mean'] * 100:+6.1f}{unit} 95% [{st['lo'] * 100:+6.1f}, {st['hi'] * 100:+6.1f}]"

def mde(st): return (st["hi"] - st["lo"]) / 2 / 1.96 * 2.8

def verdict(te, tr):
    if te["n"] < 30: return "inconclusive (fewer than 30 trades)"
    if te["blo"] > 0 and tr.get("n") and tr["mean"] > 0: return "EDGE"
    if te["bhi"] < 0: return "negative (following loses)"
    if te["blo"] <= 0 <= te["bhi"] and mde(te) <= 0.10: return "no edge"
    return "inconclusive"

# ---------------------------------------------------------------- report
def cmd_report(a):
    s = load_json(f"{a.dir}/sample.json"); ms = s["markets"]; meta = s["meta"]
    pr = f"{a.dir}/prereg.txt"
    print("== Frozen rules ==")
    print(f"  pre-registration: {' '.join(open(pr).read().split()) if os.path.exists(pr) else 'missing'}")
    print(f"  surge: trailing 1h >= {MULT}x median complete hour (>= {MIN_HOURS} hours, zeros incl.) and >= ${FLOOR:,.0f}; one-sided >= {ONE_SIDED:.0%} of buy USD; "
          f"top-3 >= {CONC:.0%}; fresh >= {FRESH:.0%}; young < {YOUNG // 86400} days")
    print(f"  trade: entry VWAP [t+{DELAY // 60}m, t+{(DELAY + ENTRY_WIN) // 60}m] (else first fill within {FALLBACK // 3600}h), +{SPREAD * 100:.0f} cent, "
          f"entry {LO_P}-{HI_P}; sample {a.n} markets, {a.n // 10} per stratum, <=2 per event, <= {PAGE_CAP * 1000:,} fills; bootstrap 2,000, Bonferroni 98.3%")
    print(f"  universe: end-days {iso(U0)[:10]}..{iso(U1 - 86400)[:10]}, volume ${VMIN // 1000}k-${VMAX // 1000}k; split: train older 60%, test newer 40% by close time")
    print("  verdict: edge if 98.3% CI > 0 and train > 0 (alpha 0.05/3); no edge if CI spans 0 and detectable effect <= 10 ROI points; "
          "inconclusive otherwise or < 30 trades; detectable effect = 2.8 x (95% half-width / 1.96)")
    print("== Sample ==")
    print(f"universe (closed, vol ${VMIN:,}-${VMAX:,}, 52 sampled end-days + future-dated): {meta['universe']}; eligible binary 0/1: {meta['eligible']} in {meta['events']} events")
    print(f"pool (<=2 per event): {meta['pool']}; strata {meta['pool_strata']}")
    status, usable, surges = collections.Counter(), [], []
    for m in ms:
        p = fpath(a, m["cid"])
        if not os.path.exists(p): status["missing"] += 1; continue
        d = load_json(p)
        if d["status"] != "ok": status[d["status"]] += 1; continue
        if not d["rows"]: status["no fills"] += 1; continue
        status["ok"] += 1
        m["nfills"] = len(d["rows"]); usable.append(m)
        sg = detect(m, d["rows"])
        if sg:
            sg["entry"], sg["t_entry"] = entry_price(m, d["rows"], sg)
            m["surge"] = sg; surges.append(m)
    print(f"requested {len(ms)}; fill status {dict(status)} (cap = more than {PAGE_CAP * 1000:,} fills, dropped)")
    print(f"usable markets {len(usable)}, total taker fills {sum(m['nfills'] for m in usable):,}; by category {dict(collections.Counter(m['cat'] for m in usable))}")
    cut = sorted(close_time(m) for m in usable)[int(len(usable) * 0.6)]
    for m in usable: m["split"] = "test" if close_time(m) >= cut else "train"
    print(f"split: train = close before {iso(cut)[:10]} ({sum(m['split'] == 'train' for m in usable)} markets), test = newer ({sum(m['split'] == 'test' for m in usable)})")

    print("\n== Surges per category (first surge per market) ==")
    print(f"  {'category':<9} {'markets':>7} {'surge':>6} {'1-sided':>7} {'young':>6} {'conc':>5} {'fresh':>6} {'conc+fresh':>10} {'S1 trades':>9}")
    def tradable(m):
        sg = m.get("surge")
        return bool(sg and sg["one_sided"] and sg["entry"] is not None and LO_P <= sg["entry"] <= HI_P and sg["t_entry"] < close_time(m))
    tot = collections.Counter()
    for c in ("politics", "crypto", "sports", "esports", "other", "ALL"):
        X = [m for m in usable if c == "ALL" or m["cat"] == c]; S = [m["surge"] for m in X if m.get("surge")]
        row = [len(X), len(S), sum(x["one_sided"] for x in S), sum(x["young"] for x in S), sum(x["conc"] for x in S), sum(x["fresh"] for x in S),
               sum(x["conc"] and x["fresh"] for x in S), sum(tradable(m) for m in X)]
        print(f"  {c:<9} {row[0]:>7} {row[1]:>6} {row[2]:>7} {row[3]:>6} {row[4]:>5} {row[5]:>6} {row[6]:>10} {row[7]:>9}")
    S = [m["surge"] for m in surges]
    if S:
        print(f"  median surge-hour USD ${statistics.median(x['V'] for x in S):,.0f}; median baseline hour ${statistics.median(x['B'] for x in S):,.0f}; "
              f"baseline hour = $0 in {sum(x['B'] == 0 for x in S)} of {len(S)}")
        print(f"  median market age at surge {statistics.median(x['age_d'] for x in S):.1f} d; median hours from surge to close {statistics.median(x['to_close_h'] for x in S):.1f}")
        os_ = [x for x in S if x["one_sided"]]
        print(f"  one-sided surges: {len(os_)}; no entry fill within 6h: {sum(m['surge']['entry'] is None for m in surges if m['surge']['one_sided'])}; "
              f"entry outside {LO_P}-{HI_P}: {sum(1 for m in surges if m['surge']['one_sided'] and m['surge']['entry'] is not None and not LO_P <= m['surge']['entry'] <= HI_P)}")
    pp = lambda m, side: m["res"][side] - ((m["surge"]["entry"] if side == m["surge"]["d"] else 1 - m["surge"]["entry"]) + SPREAD)
    roi = lambda m, side: m["res"][side] / ((m["surge"]["entry"] if side == m["surge"]["d"] else 1 - m["surge"]["entry"]) + SPREAD) - 1
    strat = [("S1 follow one-sided", lambda g: True, False), ("S2 follow young", lambda g: g["young"], False),
             ("S3 follow conc+fresh", lambda g: g["conc"] and g["fresh"], False),
             ("S4a fade S1", lambda g: True, True), ("S4b fade S2", lambda g: g["young"], True), ("S4c fade S3", lambda g: g["conc"] and g["fresh"], True)]

    print("\n== Pre-registered strategies: ROI per $1 staked, +1c spread, hold to resolution ==")
    res = {}
    for name, sel, fade in strat:
        out = {}
        for sp in ("train", "test"):
            X = [m for m in usable if m["split"] == sp and tradable(m) and sel(m["surge"])]
            side = lambda m: 1 - m["surge"]["d"] if fade else m["surge"]["d"]
            out[sp] = (boot([(m["ev"], roi(m, side(m))) for m in X]), boot([(m["ev"], pp(m, side(m))) for m in X]))
        res[name] = out
        print(f"  {name:<22} train {fmt(out['train'][0])}")
        print(f"  {'':<22} test  {fmt(out['test'][0])}")
    print("\n== Same trades in probability points (outcome minus cost) ==")
    for name, out in res.items():
        print(f"  {name:<22} train {fmt(out['train'][1], 'pp')} | test {fmt(out['test'][1], 'pp')}")

    print("\n== Verdicts (test half; Bonferroni 98.3% interval for the three primary tests) ==")
    for name, out in res.items():
        te, tr = out["test"][0], out["train"][0]
        if not te["n"]: print(f"  {name:<22} no trades"); continue
        role = "control" if name.startswith("S4") else "primary"
        print(f"  {name:<22} [{role}] test ROI {te['mean'] * 100:+.1f}%, 98.3% [{te['blo'] * 100:+.1f}, {te['bhi'] * 100:+.1f}], "
              f"detectable effect ~{mde(te) * 100:.0f} ROI points; train {tr['mean'] * 100 if tr['n'] else float('nan'):+.1f}% -> {verdict(te, tr)}")

    print("\n== Calibration: surge-direction outcome by entry price (all one-sided tradable surges, train+test) ==")
    T = [m for m in usable if tradable(m)]
    for lo, hi in ((0.03, 0.2), (0.2, 0.4), (0.4, 0.6), (0.6, 0.8), (0.8, 0.97)):
        X = [m for m in T if lo <= m["surge"]["entry"] < hi or (hi == 0.97 and m["surge"]["entry"] == 0.97)]
        if not X: print(f"  {lo:.2f}-{hi:.2f}  n=0"); continue
        w = boot([(m["ev"], m["res"][m["surge"]["d"]] - m["surge"]["entry"]) for m in X])
        print(f"  {lo:.2f}-{hi:.2f}  n={len(X):<4} mean entry {statistics.mean(m['surge']['entry'] for m in X):.3f}  won {statistics.mean(m['res'][m['surge']['d']] for m in X):.3f}  "
              f"won minus entry {w['mean'] * 100:+.1f}pp [{w['lo'] * 100:+.1f}, {w['hi'] * 100:+.1f}]")

    print("\n== Exploratory (not pre-registered as tests; 2 splits): S1 ROI, train+test pooled ==")
    for c in ("politics", "crypto", "sports", "esports", "other"):
        print(f"  cat {c:<9} {fmt(boot([(m['ev'], roi(m, m['surge']['d'])) for m in T if m['cat'] == c]))}")
    for lo, hi, lab in ((0, 6, "<6h"), (6, 48, "6-48h"), (48, 1e9, ">48h")):
        print(f"  to close {lab:<6} {fmt(boot([(m['ev'], roi(m, m['surge']['d'])) for m in T if lo <= m['surge']['to_close_h'] < hi]))}")

    pth = f"{a.dir}/profiles.json"
    print("\n== Account age check (100 random one-sided surges, top-5 wallets of each surge hour; descriptive) ==")
    if not os.path.exists(pth): print("  profiles not fetched"); return
    P = load_json(pth); prof = P["wallets"]; by = {m["cid"]: m for m in surges}
    cov = new = tot_usd = 0.0; fr = collections.Counter()
    for cid in P["surges"]:
        if cid not in by: continue
        g = by[cid]["surge"]
        for w in g["top_wallets"]:
            u = g["wallet_usd"][w]; tot_usd += u
            c = prof.get(w, [None])[0]
            if c is None: continue
            cov += u; isnew = g["t"] - c < 30 * 86400; new += u * isnew
            fr[(g["first_in_w"][w], isnew)] += 1
    print(f"  surges {len(P['surges'])}, wallets {len(prof)}, with an account date {sum(v[0] is not None for v in prof.values())} "
          f"(profile {sum(v[1] == 'profile' for v in prof.values())}, first activity {sum(v[1] == 'first_activity' for v in prof.values())})")
    if cov:
        print(f"  top-5 surge USD with a known account date: {cov / tot_usd * 100:.0f}%; of that, from accounts < 30 days old: {new / cov * 100:.1f}%")
        a1 = fr[(True, True)] + fr[(True, False)]; a0 = fr[(False, True)] + fr[(False, False)]
        print(f"  wallets new to the market (first fill in surge hour): {a1}, of which account < 30 days: {fr[(True, True)]} ({fr[(True, True)] / max(1, a1) * 100:.0f}%)")
        print(f"  wallets already in the market: {a0}, of which account < 30 days: {fr[(False, True)]} ({fr[(False, True)] / max(1, a0) * 100:.0f}%)")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["fetch", "report"])
    ap.add_argument("--dir", default=os.path.expanduser("~/.hermes/cache/scratch/surge"))
    ap.add_argument("--n", type=int, default=2400)
    args = ap.parse_args()
    {"fetch": cmd_fetch, "report": cmd_report}[args.cmd](args)
