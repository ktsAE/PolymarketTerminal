#!/usr/bin/env python3
"""Does unusual EARLY activity in a newly created Polymarket market predict anything tradeable? (event study)

  python3 scripts/newmarket-study.py fetch  [--dir D] [--n 2600]   # resumable; ~1-2 h of polite downloading
  python3 scripts/newmarket-study.py report [--dir D]

Sample: binary markets created in the last 90 days that have resolved (gamma closed=true, lifetime volume >= $5k, scheduled
life >= 26h), at most 2 per event, quota-sampled across five categories. Cache lives in ~/.hermes/cache/scratch/newmarkets/.

Window = the first 60 minutes after the market's FIRST fill (found by probing data-api /trades with `end`, then bisection).
Features: taker USD volume, distinct wallets (makers+takers), top-wallet share of gross participation, gross share from accounts
younger than 30 days (top-10 wallets per market profiled; gamma public-profile createdAt, first activity as fallback), net taker
flow one-sidedness |buy-sell|/gross, |price drift| over the window, largest taker print.

PRE-REGISTERED (fixed before the test half was scored):
  score = mean of the 7 feature percentiles, percentiles taken against the TRAIN distribution of the same category
  flag  = score >= 90th percentile of train scores (top decile)
  trade = buy the side the early net taker flow leaned toward at the price 10 min after the window closes (first fill + 70 min),
          pay 1 cent extra (spread), hold to resolution. ROI per $1, event-clustered bootstrap 95% CI.
  split = older 60% of markets by createdAt = train, newer 40% = test.
Everything else in the report (single-feature flags, fading, global percentiles) is an exploratory variant and counted as such.
Behaviour labels only: a flag means "unusual early flow", never "insider".
"""
import argparse, bisect, collections, concurrent.futures as cf, datetime as dt, json, os, random, re, statistics, threading, time
import urllib.error, urllib.request

UA = {"User-Agent": "polymarket-radar/0.1"}
G, D, C = "https://gamma-api.polymarket.com", "https://data-api.polymarket.com", "https://clob.polymarket.com"
NOW = time.time()
START = NOW - 90 * 86400
WIN, ENTRY = 3600, 4200  # window length; entry = first fill + 70 min
CASE_EVENTS = ["uptspt-anti-cartel-operation-on-foreign-soil-byptptpt"]
CASE_RE = re.compile(r"322|throw")
# No resolved esports market in the window has '322'/'throw' in its title or slug; this open market is the closest thematic case
CASE_EXTRA = ["will-a-dota-2-match-fixing-ban-be-announced-before-2027"]
FEATS = ["vol", "wallets", "top_share", "new_share", "one_sided", "drift", "max_print"]

# ---------------------------------------------------------------- http (per-host pacing, 404 is an answer)
locks = collections.defaultdict(threading.Lock)
last = collections.defaultdict(float)
NOTFOUND, TOOLARGE = object(), object()
def get(url, pace=0.07):
    host = url.split("/")[2]
    for i in range(5):
        with locks[host]:
            w = last[host] + pace - time.time()
            if w > 0: time.sleep(w)
            last[host] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40) as r: return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404: return NOTFOUND
            if e.code == 422: return TOOLARGE  # gamma: "offset too large"
            time.sleep((5 if e.code == 429 else 1) * (i + 1))
        except Exception: time.sleep(1 + i)
    return None

def save(obj, path):  # atomic: a killed fetch never leaves half a file behind
    json.dump(obj, open(path + ".tmp", "w")); os.replace(path + ".tmp", path)

def ts(s):
    if not s: return None
    try: return dt.datetime.fromisoformat(s.replace(" ", "T").replace("+00", "+00:00").replace("Z", "+00:00").replace("+00:00:00", "+00:00")).timestamp()
    except Exception: return None

ESPORTS = {"cs2", "csgo", "lol", "dota2", "val", "valorant", "r6", "r6siege", "cod", "ow", "rl", "sc2", "mlbb", "hok", "pubg", "apex", "codmw", "fifa", "kog"}
CRYPTO = {"btc", "eth", "sol", "xrp", "bitcoin", "ethereum", "solana", "doge", "dogecoin", "bnb", "hype", "hyperliquid", "ada", "link", "ltc"}
def category(m):
    s = m["slug"]; p = s.split("-")[0]
    if p in ESPORTS or m.get("esports"): return "esports"
    if p in CRYPTO or "up-or-down" in s or "updown" in s: return "crypto"
    if "temperature" in s: return "weather"
    if m.get("smt") or m.get("gst"): return "sports"
    return "other"

def slim(x, ev_slug=None):
    try: outs, toks, pr = json.loads(x["outcomes"]), json.loads(x["clobTokenIds"]), [float(v) for v in json.loads(x["outcomePrices"])]
    except Exception: return None
    evs = x.get("events") or []
    return dict(cid=x["conditionId"], slug=x["slug"], q=x.get("question", ""), ev=ev_slug or (evs[0]["slug"] if evs else x["slug"]),
                created=ts(x.get("createdAt")), end=ts(x.get("endDate")), closed=ts(x.get("closedTime")), outs=outs, toks=toks, res=pr,
                vol=float(x.get("volumeNum") or x.get("volume") or 0), smt=x.get("sportsMarketType"), gst=x.get("gameStartTime"))

# ---------------------------------------------------------------- fetch stage 1: universe
def window_rows(d0, d1):
    """All markets with end date in [d0, d1]; gamma answers 422 past an offset of ~2000-3000, so split the window in halves when it does."""
    out, off = [], 0
    while True:
        r = get(f"{G}/markets?closed=true&limit=100&offset={off}&volume_num_min=5000&end_date_min={iso(d0)}&end_date_max={iso(d1)}")
        if not isinstance(r, list):
            if r is not TOOLARGE or d1 - d0 < 1800: return None  # a real failure: retry on next run
            mid = (d0 + d1) // 2
            a_, b_ = window_rows(d0, mid), window_rows(mid, d1)
            return None if a_ is None or b_ is None else a_ + b_
        out += r
        if len(r) < 100: return out
        off += 100

def universe_window(a, d0, d1, tag):
    path = f"{a.dir}/universe/{tag}.json"
    if os.path.exists(path): return
    rows = window_rows(d0, d1)
    if rows is None: return
    out = [m for m in (slim(x) for x in rows) if m and m["created"] and m["created"] >= START]
    save(out, path)

def iso(t): return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def stage_universe(a):
    os.makedirs(f"{a.dir}/universe", exist_ok=True)
    wins = []
    t = START - START % 86400
    while t < NOW: wins.append((int(t), int(t + 86400), f"d{int(t)}")); t += 86400
    # markets that resolved early but are scheduled to end later ("by Dec 31" questions)
    t2 = t
    while t2 < NOW + 500 * 86400: wins.append((int(t2), int(t2 + 30 * 86400), f"f{int(t2)}")); t2 += 30 * 86400
    with cf.ThreadPoolExecutor(6) as ex: list(ex.map(lambda w: universe_window(a, *w), wins))
    files = os.listdir(f"{a.dir}/universe")
    print(f"universe: {len(files)}/{len(wins)} windows on disk")
    return len(files) == len(wins)

# ---------------------------------------------------------------- fetch stage 2: case studies
def stage_cases(a):
    path = f"{a.dir}/cases.json"
    if os.path.exists(path): return
    cases, esports_cids, failed = [], set(), 0
    for slug in CASE_EVENTS:
        r = get(f"{G}/events?slug={slug}")
        for x in (r[0]["markets"] if isinstance(r, list) and r else []):
            m = slim(x, slug)
            if m: m["why"] = "named case"; cases.append(m)
    t = START - START % 86400
    while t < NOW:
        off = 0
        while off < 3000:
            r = get(f"{G}/events?tag_slug=esports&closed=true&limit=100&offset={off}&end_date_min={iso(t)}&end_date_max={iso(t + 7 * 86400)}")
            if not isinstance(r, list): failed += 1; break
            if not r: break
            for e in r:
                for x in e.get("markets") or []:
                    esports_cids.add(x["conditionId"])
                    if CASE_RE.search((x["slug"] + " " + x.get("question", "") + " " + e.get("title", "")).lower()):
                        m = slim(x, e["slug"])
                        if m: m["why"] = "esports 322/throw"; m["esports"] = True; cases.append(m)
            if len(r) < 100: break
            off += 100
        t += 7 * 86400
    save(dict(cases=cases, esports=sorted(esports_cids), failed_weeks=failed), path)
    print(f"cases: {len(cases)} markets ({sum(c['why'] != 'named case' for c in cases)} esports 322/throw); {len(esports_cids)} esports cids scanned; {failed} week pages failed")

def stage_cases_extra(a):
    """Second route to 322/throw markets (gamma public-search, open and closed), plus the CASE_EXTRA open market."""
    path = f"{a.dir}/cases_extra.json"
    if os.path.exists(path): return
    cases, search = [], []
    for q in ("322", "throw"):
        for st in ("closed", "active"):
            r = get(f"{G}/public-search?q={q}&limit_per_type=50&events_status={st}")
            evs = r.get("events") or [] if isinstance(r, dict) else []
            esp = [e for e in evs if "esports" in {t.get("slug") for t in e.get("tags") or []}]
            rec = [e for e in esp if (ts(e.get("createdAt")) or 0) >= START]
            search.append(dict(q=q, status=st, events=len(evs), esports=len(esp), esports_last90d=len(rec)))
            for e in rec:
                for x in e.get("markets") or []:
                    if CASE_RE.search((x["slug"] + " " + x.get("question", "") + " " + e.get("title", "")).lower()):
                        m = slim(x, e["slug"])
                        if m: m["why"] = "esports 322/throw (search)"; m["esports"] = True; cases.append(m)
    for slug in CASE_EXTRA:
        r = get(f"{G}/events?slug={slug}")
        for x in (r[0]["markets"] if isinstance(r, list) and r else []):
            m = slim(x, slug)
            if m: m["why"] = "esports match-fixing question (open market, descriptive)"; m["esports"] = True; cases.append(m)
    save(dict(cases=cases, search=search), path)
    print(f"cases_extra: {len(cases)} markets; search {search}")

# ---------------------------------------------------------------- fetch stage 3: sample
def stage_sample(a):
    path = f"{a.dir}/sample.json"
    if os.path.exists(path): return json.load(open(path))
    esports = set(json.load(open(f"{a.dir}/cases.json"))["esports"])
    seen, allm = set(), []
    for f in sorted(os.listdir(f"{a.dir}/universe")):
        for m in json.load(open(f"{a.dir}/universe/{f}")):
            if m["cid"] in seen: continue
            seen.add(m["cid"]); m["esports"] = m["cid"] in esports; allm.append(m)
    ok = [m for m in allm if len(m["outs"]) == 2 and len(m["toks"]) == 2 and sorted(m["res"]) in ([0.0, 1.0], [0.5, 0.5])
          and m["end"] and m["end"] - m["created"] >= 26 * 3600]
    random.seed(20261101)
    by_ev = collections.defaultdict(list)
    for m in ok: by_ev[m["ev"]].append(m)
    pool = [m for ms in by_ev.values() for m in random.sample(ms, min(2, len(ms)))]
    by_cat = collections.defaultdict(list)
    for m in pool: m["cat"] = category(m); by_cat[m["cat"]].append(m)
    quota, chosen = a.n // len(by_cat), []
    for c, ms in by_cat.items(): random.shuffle(ms); chosen += ms[:quota]
    rest = [m for c, ms in by_cat.items() for m in ms[quota:]]
    random.shuffle(rest); chosen += rest[: max(0, a.n - len(chosen))]
    meta = dict(universe=len(allm), eligible=len(ok), events=len(by_ev), pool=len(pool), pool_by_cat={c: len(v) for c, v in by_cat.items()})
    save(dict(meta=meta, markets=chosen), path)
    print("sample:", meta, "chosen", len(chosen))
    return dict(meta=meta, markets=chosen)

# ---------------------------------------------------------------- fetch stage 4: early fills + price path per market
def has_fill_before(cid, E):
    r = get(f"{D}/trades?market={cid}&takerOnly=false&limit=1&end={int(E)}")
    return None if not isinstance(r, list) else len(r) > 0

def walk(cid, E, taker, lo=None, cap=20):
    rows, seen, end, pages = [], set(), int(E), 0
    while True:
        mn, done = None, False
        for off in range(0, 10000, 1000):
            pg = get(f"{D}/trades?market={cid}&takerOnly={'true' if taker else 'false'}&limit=1000&offset={off}&end={end}"); pages += 1
            if not isinstance(pg, list): return None, "err"
            for r in pg:
                k = (r.get("transactionHash"), r["proxyWallet"], r["side"], r["size"], r["timestamp"], r["outcomeIndex"], r["price"])
                if k in seen: continue
                seen.add(k)
                rows.append([r["proxyWallet"].lower(), 1 if r["side"] == "BUY" else 0, int(r["outcomeIndex"]), float(r["size"]), float(r["price"]), int(r["timestamp"]), r.get("transactionHash", "")[:18]])
                mn = r["timestamp"] if mn is None else min(mn, r["timestamp"])
            if len(pg) < 1000: done = True; break
            if pages >= cap: return rows, "cap"
        if done or mn is None or mn == end or (lo is not None and mn <= lo): return rows, "ok"
        end = mn

def fetch_market(m, a):
    path = f"{a.dir}/markets/{m['cid'][:18]}.json"
    if os.path.exists(path): return
    cid, ct = m["cid"], m["created"]
    stop = (m["closed"] or m["end"]) + 3600
    lo, hi = ct - 60, None
    for step in (600, 3600, 3 * 3600, 12 * 3600, 86400, 3 * 86400, 7 * 86400, 30 * 86400, 120 * 86400):
        E = min(ct + step, stop)
        h = has_fill_before(cid, E)
        if h is None: return
        if h: hi = E; break
        lo = E
        if E >= stop: break
    if hi is None: save(dict(status="nofills"), path); return
    while hi - lo > 900:
        mid = (lo + hi) / 2
        h = has_fill_before(cid, mid)
        if h is None: return
        if h: hi = mid
        else: lo = mid
    E = hi + WIN + 1200
    rows, st = walk(cid, E, False, lo)
    if rows is None: return
    if st == "cap": save(dict(status="cap"), path); return
    rows = [r for r in rows if r[5] >= lo]
    if not rows: save(dict(status="nofills"), path); return
    F = min(r[5] for r in rows)
    taker, st2 = walk(cid, E, True, lo)
    if taker is None: return
    taker = [r for r in taker if r[5] >= F]
    hist = get(f"{C}/prices-history?market={m['toks'][0]}&startTs={int(F)}&endTs={int(F + 26 * 3600)}&fidelity=10")
    hist = [[p["t"], p["p"]] for p in hist.get("history", [])] if isinstance(hist, dict) else None
    save(dict(status="ok", F=F, rows=[r for r in rows if r[5] <= F + ENTRY], taker=[r for r in taker if r[5] <= F + ENTRY], hist=hist), path)

def stage_markets(a, ms):
    os.makedirs(f"{a.dir}/markets", exist_ok=True)
    t0 = time.time()
    with cf.ThreadPoolExecutor(16) as ex: list(ex.map(lambda m: fetch_market(m, a), ms))
    have = sum(os.path.exists(f"{a.dir}/markets/{m['cid'][:18]}.json") for m in ms)
    print(f"markets: {have}/{len(ms)} on disk in {time.time() - t0:.0f}s (re-run to resume)")

# ---------------------------------------------------------------- fetch stage 5: wallet ages
def top_wallets(rows, k=10):
    g = collections.Counter()
    for w, b, o, sz, px, t, tx in rows: g[w] += sz * px
    return [w for w, _ in g.most_common(k)]

def stage_profiles(a, ms):
    path = f"{a.dir}/profiles.json"
    prof = json.load(open(path)) if os.path.exists(path) else {}
    want = set()
    for m in ms:
        p = f"{a.dir}/markets/{m['cid'][:18]}.json"
        if not os.path.exists(p): continue
        d = json.load(open(p))
        if d.get("status") == "ok": want.update(top_wallets([r for r in d["rows"] if r[5] <= d["F"] + WIN]))
    todo = sorted(want - set(prof))
    print(f"profiles: {len(want)} wallets wanted, {len(todo)} to fetch")
    lk = threading.Lock()
    def one(w):
        r = get(f"{G}/public-profile?address={w}")
        c, src = (ts(r.get("createdAt")), "profile") if isinstance(r, dict) else (None, None)
        if c is None:
            act = get(f"{D}/activity?user={w}&limit=1&sortDirection=ASC")
            if isinstance(act, list) and act: c, src = float(act[0]["timestamp"]), "first_activity"
        if r is None and c is None: return
        with lk: prof[w] = [c, src]
    for i in range(0, len(todo), 2000):
        with cf.ThreadPoolExecutor(8) as ex: list(ex.map(one, todo[i:i + 2000]))
        save(prof, path); print(f"  {min(i + 2000, len(todo))}/{len(todo)}")
    save(prof, path)

def all_cases(a):
    cj = json.load(open(f"{a.dir}/cases.json"))
    p = f"{a.dir}/cases_extra.json"
    ex = json.load(open(p)) if os.path.exists(p) else dict(cases=[], search=[])
    seen = {c["cid"] for c in cj["cases"]}
    cj["cases"] = cj["cases"] + [c for c in ex["cases"] if c["cid"] not in seen and not seen.add(c["cid"])]
    cj["search"] = ex["search"]
    return cj

def cmd_fetch(a):
    os.makedirs(a.dir, exist_ok=True)
    if not stage_universe(a): print("universe incomplete; re-run fetch (the sample is only drawn from a complete universe)"); return
    stage_cases(a); stage_cases_extra(a)
    s = stage_sample(a)
    cases = all_cases(a)["cases"]
    for c in cases: c["cat"] = category(c)
    ms = s["markets"] + [c for c in cases if c["cid"] not in {m["cid"] for m in s["markets"]}]
    stage_markets(a, ms); stage_profiles(a, ms)

# ---------------------------------------------------------------- analysis
def p0(r):  # outcome-0 equivalent price of a fill
    return r[4] if r[2] == 0 else 1 - r[4]

def price_at(h, t):
    if not h: return None
    i = bisect.bisect_right([x[0] for x in h], t) - 1
    return h[i][1] if i >= 0 else None

def features(m, d, prof):
    F = d["F"]; rows = [r for r in d["rows"] if r[5] <= F + WIN]; tk = sorted([r for r in d["taker"] if r[5] <= F + WIN], key=lambda r: r[5])
    if not rows or not tk: return None
    gross = collections.Counter()
    for r in rows: gross[r[0]] += r[3] * r[4]
    G_ = sum(gross.values())
    vol = sum(r[3] * r[4] for r in tk)
    flow = sum((1 if (r[1] == 1) == (r[2] == 0) else -1) * r[3] * r[4] for r in tk)  # + = toward outcome 0
    tops = top_wallets(rows)
    prof_vol = sum(gross[w] for w in tops if w in prof and prof[w][0] is not None)
    new_vol = sum(gross[w] for w in tops if w in prof and prof[w][0] is not None and F - prof[w][0] < 30 * 86400)
    first, lastp = p0(tk[0]), p0(tk[-1])
    hist = d.get("hist") or []
    t0 = F + ENTRY
    P0 = price_at(hist, t0)
    if P0 is None:
        later = [r for r in sorted(d["taker"], key=lambda r: r[5]) if r[5] <= t0]
        P0 = p0(later[-1]) if later else None
    return dict(vol=vol, wallets=len(gross), top_share=max(gross.values()) / G_ if G_ else 0, new_share=new_vol / G_ if G_ else 0,
                coverage=prof_vol / G_ if G_ else 0, one_sided=abs(flow) / vol if vol else 0, lean=0 if flow > 0 else 1 if flow < 0 else None,
                drift=abs(lastp - first), drift_signed=lastp - first, max_print=max(r[3] * r[4] for r in tk), P0=P0, t0=t0, hist=hist,
                delay_h=(F - m["created"]) / 3600, fills=len(tk), F=F)

def load(a):
    s = json.load(open(f"{a.dir}/sample.json")); cj = all_cases(a)
    prof = json.load(open(f"{a.dir}/profiles.json")) if os.path.exists(f"{a.dir}/profiles.json") else {}
    status, out = collections.Counter(), []
    sc, why = {m["cid"] for m in s["markets"]}, {c["cid"]: c["why"] for c in cj["cases"]}
    for m in s["markets"] + [c for c in cj["cases"] if c["cid"] not in sc]:
        if m["cid"] in why: m["why"] = why[m["cid"]]
        p = f"{a.dir}/markets/{m['cid'][:18]}.json"
        if not os.path.exists(p): status["missing"] += 1; continue
        d = json.load(open(p))
        if d["status"] != "ok": status[d["status"]] += 1; continue
        f = features(m, d, prof)
        if f is None: status["no taker fills in window"] += 1; continue
        m.setdefault("cat", category(m)); m.update(f); out.append(m)
    return s, cj, prof, out, status

def ecdf_pct(ref, x):
    return bisect.bisect_right(ref, x) / len(ref) if ref else 0.5

def roi(m, side, spread=0.01):
    q = m["P0"] if side == 0 else 1 - m["P0"]
    pay = m["res"][side]
    return pay / (q + spread) - 1

def boot(rows, key=lambda r: r[1], B=2000, seed=11):
    """rows = [(event, value)]; event-clustered bootstrap of the mean."""
    if not rows: return 0, None, None, None
    ev = collections.defaultdict(list)
    for e, v in rows: ev[e].append(v)
    ks = list(ev); n = len(rows); mean = sum(v for _, v in rows) / n
    rnd = random.Random(seed); out = []
    for _ in range(B):
        sm = cnt = 0
        for _ in ks:
            vs = ev[ks[rnd.randrange(len(ks))]]; sm += sum(vs); cnt += len(vs)
        out.append(sm / cnt)
    out.sort()
    return n, mean, out[int(B * .025)], out[int(B * .975)]

def fmt(st, pct=True, unit="%"):
    n, m, lo, hi = st
    if not n: return "n=0"
    k = 100 if pct else 1
    return f"n={n:<5} {m * k:+6.1f}{unit} [{lo * k:+6.1f}, {hi * k:+6.1f}]"

def cmd_report(a):
    s, cj, prof, ms, status = load(a)
    case_cids = {c["cid"] for c in cj["cases"]}
    sample_cids = {m["cid"] for m in s["markets"]}
    main = [m for m in ms if m["cid"] in sample_cids]
    print("== Sample ==")
    print(f"universe (closed, vol>=$5k, created in last 90d): {s['meta']['universe']}; eligible binary, life>=26h: {s['meta']['eligible']} in {s['meta']['events']} events")
    print(f"pool (<=2 per event): {s['meta']['pool']} by category {s['meta']['pool_by_cat']}")
    print(f"sampled {len(s['markets'])}; usable {len(main)}; dropped: {dict(status)} (counts include case markets)")
    cats = collections.Counter(m["cat"] for m in main); print("usable by category:", dict(cats))
    print(f"wallet profiles: {len(prof)} ({collections.Counter(v[1] for v in prof.values())})")
    cov = sorted(m["coverage"] for m in main)
    print(f"age coverage (share of early gross USD in profiled top-10 wallets): median {cov[len(cov) // 2]:.2f}")
    print(f"delay from creation to first fill: median {statistics.median(m['delay_h'] for m in main):.1f}h")

    main.sort(key=lambda m: m["created"])
    cut = main[int(len(main) * 0.6)]["created"]
    train, test = [m for m in main if m["created"] < cut], [m for m in main if m["created"] >= cut]
    print(f"train {len(train)} markets created before {iso(cut)[:10]}; test {len(test)}")

    refs = {c: {f: sorted(m[f] for m in train if m["cat"] == c) for f in FEATS} for c in cats}
    gref = {f: sorted(m[f] for m in train) for f in FEATS}
    def score(m, mode="cat"):
        ref = refs.get(m["cat"]) if mode == "cat" and len(refs.get(m["cat"], {}).get("vol", [])) >= 50 else gref
        return sum(ecdf_pct(ref[f], m[f]) for f in FEATS) / len(FEATS)
    for m in main + [x for x in ms if x["cid"] in case_cids]:
        m["score"], m["gscore"] = score(m), score(m, "glob")
        for f in FEATS: m["pct_" + f] = ecdf_pct(gref[f], m[f])
    thr = sorted(m["score"] for m in train)[int(len(train) * 0.9)]
    gthr = sorted(m["gscore"] for m in train)[int(len(train) * 0.9)]
    for m in main + [x for x in ms if x["cid"] in case_cids]: m["flag"] = m["score"] >= thr
    print(f"PRE-REGISTERED flag threshold (train 90th pct of category score): {thr:.3f}; flagged train {sum(m['flag'] for m in train)}, test {sum(m['flag'] for m in test)}")

    print("\n== Feature medians (train), unflagged vs flagged ==")
    for f in FEATS + ["coverage", "fills"]:
        u = [m[f] for m in train if not m["flag"]]; fl = [m[f] for m in train if m["flag"]]
        print(f"  {f:<10} {statistics.median(u):>10.3f} {statistics.median(fl):>10.3f}")

    tradable = lambda m: m["P0"] is not None and 0.03 <= m["P0"] <= 0.97 and m["lean"] is not None and m["t0"] < (m["closed"] or m["end"])
    print("\n== Sanity: entry price vs outcome on all tradable markets (no signal) ==")
    for name, S in (("train", train), ("test", test)):
        T = [m for m in S if tradable(m)]
        print(f"  {name:<5} n={len(T)} mean entry price of outcome 0 {statistics.mean(m['P0'] for m in T):.3f}, outcome 0 won {statistics.mean(m['res'][0] for m in T):.3f}; "
              f"ROI buy outcome 0 {fmt(boot([(m['ev'], roi(m, 0)) for m in T], B=1000))}, buy outcome 1 {fmt(boot([(m['ev'], roi(m, 1)) for m in T], B=1000))}")

    print("\n== Q1: buy the early-flow side at first fill + 70 min, +1c spread, hold to resolution (ROI per $1) ==")
    for name, S in (("train", train), ("test", test)):
        for lab, sel in (("flagged", lambda m: m["flag"]), ("unflagged", lambda m: not m["flag"]), ("all", lambda m: True)):
            rows = [(m["ev"], roi(m, m["lean"])) for m in S if sel(m) and tradable(m)]
            print(f"  {name:<5} {lab:<9} {fmt(boot(rows))}")
    # flagged minus unflagged on test (difference in means, clustered)
    def diff_boot(S, B=2000):
        fl = collections.defaultdict(list); un = collections.defaultdict(list)
        for m in S:
            if tradable(m): (fl if m["flag"] else un)[m["ev"]].append(roi(m, m["lean"]))
        mean = lambda d: sum(map(sum, d.values())) / max(1, sum(map(len, d.values())))
        rnd = random.Random(5); out = []
        kf, ku = list(fl), list(un)
        for _ in range(B):
            a_ = [fl[kf[rnd.randrange(len(kf))]] for _ in kf]; b_ = [un[ku[rnd.randrange(len(ku))]] for _ in ku]
            out.append(sum(map(sum, a_)) / max(1, sum(map(len, a_))) - sum(map(sum, b_)) / max(1, sum(map(len, b_))))
        out.sort(); return mean(fl) - mean(un), out[int(B * .025)], out[int(B * .975)]
    for name, S in (("train", train), ("test", test)):
        dm, lo, hi = diff_boot(S); print(f"  {name:<5} flagged minus unflagged: {dm * 100:+.1f}% [{lo * 100:+.1f}, {hi * 100:+.1f}]")
    pre = boot([(m["ev"], roi(m, m["lean"])) for m in test if m["flag"] and tradable(m)])
    half = (pre[3] - pre[2]) / 2 if pre[0] else None
    if half: print(f"  PRIMARY (test, flagged): ROI {pre[1] * 100:+.1f}%, CI half-width {half * 100:.1f} points -> detectable effect (80% power, 5% two-sided) about {half / 1.96 * 2.8 * 100:.0f} points of ROI")
    # placebo: same-size random subsets of tradable test markets, same 'follow the lean' trade
    pool = [roi(m, m["lean"]) for m in test if tradable(m)]; k = pre[0]
    if k and len(pool) > k:
        rnd = random.Random(3); pl = sorted(sum(rnd.sample(pool, k)) / k for _ in range(2000))
        print(f"  placebo (random {k} of {len(pool)} tradable test markets, 2000 draws): 95% range [{pl[50] * 100:+.1f}%, {pl[1950] * 100:+.1f}%]; "
              f"share of draws >= primary {sum(x >= pre[1] for x in pl) / 2000:.3f}")
    # same trade in probability points (outcome minus entry price), less heavy-tailed than ROI
    for name, S in (("train", train), ("test", test)):
        pp = [(m["ev"], m["res"][m["lean"]] - (m["P0"] if m["lean"] == 0 else 1 - m["P0"]) - 0.01) for m in S if m["flag"] and tradable(m)]
        print(f"  {name:<5} flagged, edge in probability points after 1c: {fmt(boot(pp), unit='pp')}")
    # spread sensitivity of the primary rule
    for sp in (0.0, 0.02, 0.05):
        print(f"  test flagged ROI with {sp * 100:.0f}c spread: {fmt(boot([(m['ev'], roi(m, m['lean'], sp)) for m in test if m['flag'] and tradable(m)]))}")

    print("\n== Primary rule by category (exploratory split; flagged & tradable) ==")
    for c in sorted(cats):
        parts = []
        for name, S in (("train", train), ("test", test)):
            X = [m for m in S if m["cat"] == c and m["flag"] and tradable(m)]
            parts.append(f"{name} {fmt(boot([(m['ev'], roi(m, m['lean'])) for m in X], B=1000))}")
        print(f"  {c:<8} " + "  ".join(parts))

    print("\n== Variants (exploratory; train -> test, buy lean side unless noted) ==")
    variants = [("pre-registered: category score top decile", lambda m: m["score"] >= thr, "follow"),
                ("same flag, FADE the lean", lambda m: m["score"] >= thr, "fade"),
                ("global score top decile", lambda m: m["gscore"] >= gthr, "follow")]
    for f in FEATS:  # strict '>' so heavily tied features (one_sided=1, new_share=0) do not select everyone
        t = sorted(m[f] for m in train)[int(len(train) * 0.9)]
        variants.append((f"single feature {f} > train p90 ({t:.3g})", (lambda f, t: lambda m: m[f] > t)(f, t), "follow"))
    variants.append(("one-sided>=0.8 and vol top quartile", lambda m: m["one_sided"] >= 0.8 and m["pct_vol"] >= 0.75, "follow"))
    variants.append(("new-account share>=0.3", lambda m: m["new_share"] >= 0.3, "follow"))
    n_pos = 0
    for lab, sel, mode in variants:
        res = []
        for S in (train, test):
            rows = [(m["ev"], roi(m, m["lean"] if mode == "follow" else 1 - m["lean"])) for m in S if sel(m) and tradable(m)]
            res.append(boot(rows, B=1000))
        n_pos += res[0][2] is not None and res[0][2] > 0
        print(f"  {lab:<40} train {fmt(res[0])}  test {fmt(res[1])}")
    print(f"  variants tried: {len(variants)}; with train CI above zero: {n_pos} (chance ~{len(variants) * 0.025:.1f})")

    print("\n== Q2: price move after entry, signed in the direction of the early lean / the window drift (probability points) ==")
    for name, S in (("train", train), ("test", test)):
        for lab, sel in (("flagged", lambda m: m["flag"]), ("unflagged", lambda m: not m["flag"])):
            for dirn in ("lean", "drift"):
                parts = []
                for h in (3600, 6 * 3600, 24 * 3600):
                    rows = []
                    for m in S:
                        if not (sel(m) and tradable(m)): continue
                        sgn = (1 if m["lean"] == 0 else -1) if dirn == "lean" else (1 if m["drift_signed"] > 0 else -1 if m["drift_signed"] < 0 else 0)
                        if sgn == 0: continue
                        t = m["t0"] + h
                        cl = m["closed"] or m["end"]
                        px = m["res"][0] if t >= cl else price_at(m["hist"], t)
                        if px is None: continue
                        rows.append((m["ev"], sgn * (px - m["P0"])))
                    n, mu, lo, hi = boot(rows, B=1000)
                    parts.append(f"+{h // 3600}h {mu * 100:+5.1f} [{lo * 100:+5.1f},{hi * 100:+5.1f}] n={n}" if n else f"+{h // 3600}h n=0")
                print(f"  {name:<5} {lab:<9} by {dirn:<5}: " + " | ".join(parts))

    print("\n== Q3: how flagged markets resolve (test and train pooled, then test only) ==")
    for name, S in (("all", train + test), ("test", test)):
        for lab, sel in (("flagged", lambda m: m["flag"]), ("unflagged", lambda m: not m["flag"])):
            X = [m for m in S if sel(m)]
            T = [m for m in X if tradable(m)]
            void = sum(m["res"] == [0.5, 0.5] for m in X) / max(1, len(X))
            yes = [(m["ev"], m["res"][0] - m["P0"]) for m in T]
            lean = [(m["ev"], m["res"][m["lean"]] - (m["P0"] if m["lean"] == 0 else 1 - m["P0"])) for m in T]
            life = statistics.median(((m["closed"] or m["end"]) - m["F"]) / 86400 for m in X) if X else 0
            print(f"  {name:<4} {lab:<9} n={len(X):<5} void {void * 100:.1f}%  outcome-0 minus price {fmt(boot(yes, B=1000), unit='pp')}  "
                  f"lean side won minus price {fmt(boot(lean, B=1000), unit='pp')}  median days first fill->close {life:.1f}")

    print("\n== Case studies (descriptive only) ==")
    cs = [m for m in ms if m["cid"] in case_cids]
    print(f"case markets found: {len(cj['cases'])}; with usable early window: {len(cs)}")
    for m in sorted(cs, key=lambda m: m["created"]):
        when = "test" if m["created"] >= cut else "train"
        side = m["outs"][m["lean"]] if m["lean"] is not None else "-"
        print(f"  {m['slug'][:80]}")
        print(f"    {m['why']}; created {iso(m['created'])[:16]}, first fill +{m['delay_h']:.1f}h, period {when}, in random sample: {m['cid'] in sample_cids}")
        print(f"    vol ${m['vol']:,.0f}, wallets {m['wallets']}, top share {m['top_share']:.2f}, new<30d share {m['new_share']:.2f} (coverage {m['coverage']:.2f}), "
              f"one-sided {m['one_sided']:.2f} toward {side}, |drift| {m['drift'] * 100:.1f}pp, max print ${m['max_print']:,.0f}")
        print(f"    score {m['score']:.3f} vs threshold {thr:.3f} -> flag {'FIRES' if m['flag'] else 'no'}; price at +70m {m['P0'] if m['P0'] is None else round(m['P0'], 3)}; "
              f"{'resolved' if sorted(m['res']) in ([0.0, 1.0], [0.5, 0.5]) else 'OPEN, current price'} {dict(zip(m['outs'], m['res']))}")
        if m["lean"] is not None and m["P0"] is not None and sorted(m["res"]) == [0.0, 1.0]:
            print(f"    following the lean at +70m: ROI {roi(m, m['lean']) * 100:+.1f}% (1c spread)")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["fetch", "report"])
    ap.add_argument("--dir", default=os.path.expanduser("~/.hermes/cache/scratch/newmarkets"))
    ap.add_argument("--n", type=int, default=2600)
    args = ap.parse_args()
    {"fetch": cmd_fetch, "report": cmd_report}[args.cmd](args)
