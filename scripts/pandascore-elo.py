#!/usr/bin/env python3
"""Does an Elo rating built on years of PandaScore results beat Polymarket's esports closing line?

  python3 scripts/pandascore-elo.py fetch [--what pandascore|polymarket|prices|all] [--since 2023-01-01]
  python3 scripts/pandascore-elo.py report [--join-only]

Cache: $PS_CACHE or ~/.hermes/cache/scratch/pandascore/ (never the repo).
  raw/<game>/<YYYY-MM>-p<N>.json.gz  raw PandaScore /<game>/matches/past pages (status=finished, one month per window)
  pm_games.json                      resolved Polymarket esports moneylines (Gamma, weekly end_date windows)
  pm_px.json                         CLOB prices-history per market, startTs=start-9h .. endTs=start, fidelity=10
The PandaScore token is read from .radar/.env (PANDASCORE_KEY) inside this process only; it is never printed or written.

PRE-REGISTERED PROTOCOL (fixed before any test-set outcome was looked at):
  Elo      one rating table per game (CS, LoL, Dota 2, Valorant), keyed by PandaScore team id, start 1500, 400-point
           logistic scale, online (each match is predicted before it updates ratings). K is chosen per game from
           KGRID by log-loss on the OLDEST 50% of that game's PandaScore matches only.
  Join     Polymarket moneyline (Counter-Strike/LoL/Dota 2/Valorant "A vs B (BOn)") <-> PandaScore match of the same game
           whose begin_at is within 6h of gameStartTime and whose two team names match after normalisation
           (exact on name/acronym/slug, else one side exact and the other difflib ratio >= 0.85 or a >=4-char
           substring). Best name score, then closest in time, wins.
  Close    last prices-history point at least 5 min before gameStartTime and no older than 60 min before that;
           keep 0.03 <= close <= 0.97; both teams need >= MINPRIOR earlier PandaScore results in that game.
  Split    joined rows sorted by start: older 60% = train, newer 40% = test.
  Strategy bet $1 on the side whose Elo probability exceeds its close by >= T. Cost = close + 1 cent (spread penalty).
           T is chosen from TGRID on train only: highest train ROI among T with >= 40 train bets. Evaluated once on test.
  CI       95% bootstrap over UTC-day clusters (B=4000). Log-loss on test: close, Elo, and a logistic blend
           (intercept + logit(close) + logit(Elo)) fitted on train.
"""
import argparse, collections, concurrent.futures as cf, datetime as dt, difflib, gzip, json, math, os, random, re, sys, threading, time
import unicodedata, urllib.error, urllib.parse, urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.environ.get("PS_CACHE", os.path.expanduser("~/.hermes/cache/scratch/pandascore"))
OLD = os.path.expanduser("~/.hermes/cache/scratch/elo")  # earlier elo-vs-market.py cache, reused as a price seed
UA = "polymarket-radar/0.1"
PS_GAMES = {"csgo": "Counter-Strike", "lol": "LoL", "dota2": "Dota 2", "valorant": "Valorant"}
KGRID = [8, 12, 16, 24, 32, 40, 48, 64, 80, 96]  # widened from 8..48 after K hit the edge (oldest-50% PandaScore only)
TGRID = [0.03, 0.05, 0.07, 0.10, 0.13, 0.16, 0.20]
MINPRIOR = 10
TITLE = re.compile(r"^(Counter-Strike|LoL|Dota 2|Valorant): (.+?) vs\.? (.+?) \((BO\d)\)(?: - (.+))?$")


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- PandaScore
def _key():
    for line in open(os.path.join(REPO, ".radar", ".env")):
        if line.startswith("PANDASCORE_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise SystemExit("PANDASCORE_KEY missing in .radar/.env")


class Panda:
    def __init__(self):
        self.h = {"Authorization": "Bearer " + _key(), "User-Agent": UA, "Accept": "application/json"}
        self.calls = 0
        self.refusals = collections.Counter()

    def get(self, path):
        """Returns (json, headers). Waits out 429s; raises on other HTTP errors (recorded in self.refusals)."""
        wait = 30
        while True:
            time.sleep(0.35)
            try:
                with urllib.request.urlopen(urllib.request.Request("https://api.pandascore.co" + path, headers=self.h), timeout=60) as r:
                    self.calls += 1
                    hd = dict(r.headers)
                    body = json.load(r)
                    if int(hd.get("X-Rate-Limit-Remaining", "100")) <= 2:
                        log("  rate limit nearly used up; sleeping 5 min")
                        time.sleep(300)
                    return body, hd
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    ra = e.headers.get("Retry-After")
                    s = int(ra) if ra and ra.isdigit() else wait
                    log(f"  429 rate limited; sleeping {s}s")
                    time.sleep(s)
                    wait = min(wait * 2, 900)
                    continue
                self.refusals[f"HTTP {e.code} {path.split('?')[0]}"] += 1
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                log("  network error", e, "- retry in 20s")
                time.sleep(20)


def months(since, until):
    y, m = since.year, since.month
    while (y, m) <= (until.year, until.month):
        a = dt.datetime(y, m, 1, tzinfo=dt.timezone.utc)
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        yield a, dt.datetime(y, m, 1, tzinfo=dt.timezone.utc) - dt.timedelta(seconds=1)


def fetch_pandascore(a):
    ps = Panda()
    since = dt.datetime.fromisoformat(a.since).replace(tzinfo=dt.timezone.utc)
    now = dt.datetime.now(dt.timezone.utc)
    for g in PS_GAMES:
        d = os.path.join(CACHE, "raw", g)
        os.makedirs(d, exist_ok=True)
        for lo, hi in months(since, now):
            tag = lo.strftime("%Y-%m")
            done = os.path.join(d, tag + ".done")
            if os.path.exists(done):
                continue
            rng = f"{lo:%Y-%m-%dT%H:%M:%SZ},{min(hi, now):%Y-%m-%dT%H:%M:%SZ}"
            page, n = 1, 0
            while True:
                q = urllib.parse.urlencode({"filter[status]": "finished", "range[begin_at]": rng, "sort": "begin_at",
                                            "page[size]": 100, "page[number]": page}, safe="[],:")
                try:
                    body, hd = ps.get(f"/{g}/matches/past?{q}")
                except urllib.error.HTTPError as e:
                    log(f"  {g} {tag}: API refused with HTTP {e.code}; stopping this game")
                    break
                with gzip.open(os.path.join(d, f"{tag}-p{page}.json.gz"), "wt") as f:
                    json.dump(body, f)
                n += len(body)
                total = int(hd.get("X-Total", "0"))
                if len(body) < 100 or page * 100 >= total:
                    break
                page += 1
            if hi < now - dt.timedelta(days=3):
                open(done, "w").write(str(n))
            log(f"{g} {tag}: {n} matches ({ps.calls} calls so far)")
    log("PandaScore calls:", ps.calls, "refusals:", dict(ps.refusals) or "none")


# ---------------------------------------------------------------- Polymarket
_lock, _last = threading.Lock(), [0.0]


def pm_get(u, tries=4):
    for i in range(tries):
        with _lock:
            w = _last[0] + 0.05 - time.time()
            if w > 0:
                time.sleep(w)
            _last[0] = time.time()
        try:
            with urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": UA}), timeout=40) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 422:
                return "CAP"  # Gamma offset cap
            time.sleep(1 + 2 * i)
        except Exception:
            time.sleep(1 + 2 * i)
    return None


def _gst(s):
    return dt.datetime.fromisoformat(s.replace(" ", "T").replace("+00", "+00:00").replace("Z", "+00:00")).timestamp()


def fetch_polymarket(a):
    base = "https://gamma-api.polymarket.com/events?tag_slug=esports&closed=true&limit=100"
    out = {}

    def window(lo, hi):
        evs = []
        for off in range(0, 100000, 100):
            r = pm_get(base + f"&end_date_min={lo:%Y-%m-%dT%H:%M:%SZ}&end_date_max={hi:%Y-%m-%dT%H:%M:%SZ}&offset={off}")
            if r == "CAP" or r is None:
                if hi - lo < dt.timedelta(hours=2):
                    log("  cannot split window further", lo, r)
                    return evs
                mid = lo + (hi - lo) / 2
                return window(lo, mid) + window(mid, hi)
            evs += r
            if len(r) < 100:
                return evs

    lo = dt.datetime(2025, 6, 1, tzinfo=dt.timezone.utc)
    end = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=1)
    while lo < end:
        hi = min(lo + dt.timedelta(days=7), end)
        evs = window(lo, hi)
        k = 0
        for e in evs:
            m0 = TITLE.match(e.get("title", ""))
            if not m0:
                continue
            for m in e.get("markets", []):
                if m.get("sportsMarketType") != "moneyline" or not m.get("gameStartTime"):
                    continue
                try:
                    pr = [float(x) for x in json.loads(m["outcomePrices"])]
                    toks, outs = json.loads(m["clobTokenIds"]), json.loads(m["outcomes"])
                except Exception:
                    continue
                if sorted(pr) != [0.0, 1.0] or len(outs) != 2:
                    continue
                out[m["conditionId"]] = dict(cid=m["conditionId"], event=str(e.get("id")), game=m0.group(1), a=outs[0].strip(),
                                             b=outs[1].strip(), fmt=m0.group(4), tour=m0.group(5), start=_gst(m["gameStartTime"]),
                                             y0=1 if pr[0] == 1.0 else 0, tok=toks[0], vol=float(m.get("volumeNum") or m.get("volume") or 0))
                k += 1
        log(f"polymarket {lo:%Y-%m-%d}: {len(evs)} events, {k} resolved moneylines (total {len(out)})")
        lo = hi
    json.dump(list(out.values()), open(os.path.join(CACHE, "pm_games.json"), "w"))


def fetch_prices(a):
    G = json.load(open(os.path.join(CACHE, "pm_games.json")))
    p = os.path.join(CACHE, "pm_px.json")
    px = json.load(open(p)) if os.path.exists(p) else {}
    if os.path.exists(os.path.join(OLD, "px.json")):  # same request shape as scripts/elo-vs-market.py
        for k, v in json.load(open(os.path.join(OLD, "px.json"))).items():
            px.setdefault(k, v)
    todo = [x for x in G if x["cid"] not in px]
    log(len(G), "markets,", len(todo), "price series to fetch")
    lk = threading.Lock()

    def one(x):
        r = pm_get(f"https://clob.polymarket.com/prices-history?market={x['tok']}&startTs={int(x['start'] - 9 * 3600)}"
                   f"&endTs={int(x['start'])}&fidelity=10")
        if isinstance(r, dict) and r.get("history") is not None:
            with lk:
                px[x["cid"]] = [[q["t"], q["p"]] for q in r["history"]]

    for i in range(0, len(todo), 1000):
        with cf.ThreadPoolExecutor(10) as ex:
            list(ex.map(one, todo[i:i + 1000]))
        json.dump(px, open(p, "w"))
        log(f"  prices {min(i + 1000, len(todo))}/{len(todo)}")
    log(len(px), "price series cached")


def fetch(a):
    os.makedirs(CACHE, exist_ok=True)
    if a.what in ("polymarket", "all"):
        fetch_polymarket(a)
    if a.what in ("prices", "all"):
        fetch_prices(a)
    if a.what in ("pandascore", "all"):
        fetch_pandascore(a)


# ---------------------------------------------------------------- report
def load_panda():
    by = collections.defaultdict(dict)
    stats = collections.Counter()
    for g, gname in PS_GAMES.items():
        d = os.path.join(CACHE, "raw", g)
        for fn in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if not fn.endswith(".json.gz"):
                continue
            for m in json.load(gzip.open(os.path.join(d, fn), "rt")):
                stats["raw"] += 1
                opp = [o.get("opponent") or {} for o in m.get("opponents") or []]
                ids = [o.get("id") for o in opp]
                t = m.get("begin_at") or m.get("scheduled_at")
                if len(opp) != 2 or None in ids or ids[0] == ids[1]:
                    stats["drop: not two teams"] += 1; continue
                if m.get("forfeit") or m.get("draw"):
                    stats["drop: forfeit/draw"] += 1; continue
                if m.get("winner_id") not in ids or not t:
                    stats["drop: no winner/time"] += 1; continue
                by[gname][m["id"]] = dict(id=m["id"], game=gname, t=_gst(t), A=opp[0], B=opp[1], y=1 if m["winner_id"] == ids[0] else 0,
                                          league=(m.get("league") or {}).get("name"))
    return {g: sorted(v.values(), key=lambda x: (x["t"], x["id"])) for g, v in by.items()}, stats


def run_elo(ms, K):
    r = collections.defaultdict(lambda: 1500.0)
    n = collections.Counter()
    for m in ms:
        a, b = m["A"]["id"], m["B"]["id"]
        p = 1 / (1 + 10 ** ((r[b] - r[a]) / 400))
        m["pe"], m["na"], m["nb"] = p, n[a], n[b]
        r[a] += K * (m["y"] - p); r[b] -= K * (m["y"] - p); n[a] += 1; n[b] += 1


def ll(y, p):
    p = min(max(p, 1e-6), 1 - 1e-6)
    return -(y * math.log(p) + (1 - y) * math.log(1 - p))


STOP = {"team", "esports", "esport", "gaming", "club", "the", "gg", "cs", "cs2", "csgo", "lol", "dota", "dota2", "valorant", "val", "e", "sports"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z0-9]+", " ", s)
    toks = [w for w in s.split() if w not in STOP]
    return "".join(toks) or s.replace(" ", "")


def keys(o):
    return {k for k in (norm(o.get("name")), norm(o.get("acronym")), norm((o.get("slug") or "").replace("-", " "))) if k}


def side_match(pm_name, o):
    k = norm(pm_name)
    if k in keys(o):
        return 2
    if max(difflib.SequenceMatcher(None, k, x).ratio() for x in keys(o)) >= 0.85:
        return 1
    if len(k) >= 4 and any(len(x) >= 4 and (k in x or x in k) for x in keys(o)):
        return 1  # "FOKUS" ~ "FOKUS REALITY"; only ever accepted when the other side matches exactly
    return 0


def join(PM, PS):
    idx = {g: ms for g, ms in PS.items()}
    starts = {g: [m["t"] for m in ms] for g, ms in PS.items()}
    import bisect
    out, why = [], collections.Counter()
    for x in PM:
        ms = idx.get(x["game"], [])
        if not ms:
            why["no PandaScore data for game"] += 1; continue
        i0, i1 = bisect.bisect_left(starts[x["game"]], x["start"] - 6 * 3600), bisect.bisect_right(starts[x["game"]], x["start"] + 6 * 3600)
        best = None
        for m in ms[i0:i1]:
            for flip in (False, True):
                A, B = (m["B"], m["A"]) if flip else (m["A"], m["B"])
                sa, sb = side_match(x["a"], A), side_match(x["b"], B)
                if (sa == 2 and sb == 2) or (sa + sb == 3):
                    c = (sa + sb, -abs(m["t"] - x["start"]))
                    if best is None or c > best[0]:
                        best = (c, m, flip)
        if not best:
            why["no name+time match"] += 1; continue
        why["joined exact" if best[0][0] == 4 else "joined fuzzy"] += 1
        m, flip = best[1], best[2]
        out.append(dict(x, pe=1 - m["pe"] if flip else m["pe"], na=m["nb"] if flip else m["na"], nb=m["na"] if flip else m["nb"],
                        ps_y=(1 - m["y"]) if flip else m["y"], ps_id=m["id"], dtmin=(m["t"] - x["start"]) / 60))
    return out, why


def roi(r, T):
    """Bet the side whose Elo probability beats its close by >= T; pay close + 1 cent. None if no bet."""
    if r["pe"] - r["pm"] >= T:
        return r["y0"] / (r["pm"] + 0.01) - 1
    if (1 - r["pe"]) - (1 - r["pm"]) >= T:
        return (1 - r["y0"]) / (1 - r["pm"] + 0.01) - 1
    return None


def boot(rows, f, B=4000, seed=7):
    """Day-clustered bootstrap of mean(f(row)) over rows where f is not None."""
    cl = collections.defaultdict(list)
    for r in rows:
        v = f(r)
        if v is not None:
            cl[int(r["start"] // 86400)].append(v)
    keys_ = list(cl)
    if not keys_:
        return None
    rnd = random.Random(seed)
    est = []
    for _ in range(B):
        s = n = 0
        for _k in range(len(keys_)):
            v = cl[keys_[rnd.randrange(len(keys_))]]
            s += sum(v); n += len(v)
        est.append(s / n)
    est.sort()
    allv = [v for k in keys_ for v in cl[k]]
    sd = (sum((e - sum(est) / B) ** 2 for e in est) / (B - 1)) ** 0.5
    return dict(n=len(allv), days=len(keys_), mean=sum(allv) / len(allv), lo=est[int(B * .025)], hi=est[int(B * .975)], se=sd)


def logit(p):
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def fit_logistic(X, y, iters=50):
    k = len(X[0]); w = [0.0] * k
    for _ in range(iters):
        g = [0.0] * k; H = [[1e-6 * (i == j) for j in range(k)] for i in range(k)]
        for xi, yi in zip(X, y):
            p = 1 / (1 + math.exp(-sum(a * b for a, b in zip(w, xi))))
            for i in range(k):
                g[i] += (yi - p) * xi[i]
                for j in range(k):
                    H[i][j] += p * (1 - p) * xi[i] * xi[j]
        # solve H d = g (Gauss)
        M = [H[i][:] + [g[i]] for i in range(k)]
        for c in range(k):
            piv = max(range(c, k), key=lambda r: abs(M[r][c])); M[c], M[piv] = M[piv], M[c]
            for r in range(k):
                if r != c:
                    f = M[r][c] / M[c][c]
                    M[r] = [a - f * b for a, b in zip(M[r], M[c])]
        d = [M[i][k] / M[i][i] for i in range(k)]
        w = [a + b for a, b in zip(w, d)]
        if max(abs(v) for v in d) < 1e-9:
            break
    return w


def report(a):
    PS, st = load_panda()
    if not PS:
        raise SystemExit("no PandaScore cache; run fetch first")
    print("## PandaScore sample")
    print("| game | matches | first | last | K (tuned on oldest 50%) | Elo log-loss oldest 50% | newest 50% |")
    print("| --- | --- | --- | --- | --- | --- | --- |")
    variants = 0
    for g, ms in PS.items():
        half = len(ms) // 2
        best = None
        for K in KGRID:
            variants += 1
            run_elo(ms, K)
            L = sum(ll(m["y"], m["pe"]) for m in ms[:half]) / half
            if best is None or L < best[1]:
                best = (K, L)
        run_elo(ms, best[0])
        L2 = sum(ll(m["y"], m["pe"]) for m in ms[half:]) / (len(ms) - half)
        f = lambda t: dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d")
        print(f"| {g} | {len(ms)} | {f(ms[0]['t'])} | {f(ms[-1]['t'])} | {best[0]} | {best[1]:.4f} | {L2:.4f} |")
    print(f"\nraw rows {st['raw']}; dropped: " + ", ".join(f"{k[6:]} {v}" for k, v in st.items() if k.startswith("drop")))

    PM = json.load(open(os.path.join(CACHE, "pm_games.json")))
    PX = json.load(open(os.path.join(CACHE, "pm_px.json")))
    # one market per match: keep the highest-volume market for (game, teams, start)
    dd = {}
    for x in PM:
        k = (x["game"], tuple(sorted((norm(x["a"]), norm(x["b"])))), int(x["start"] // 3600))
        if k not in dd or x["vol"] > dd[k]["vol"]:
            dd[k] = x
    PM = sorted(dd.values(), key=lambda x: x["start"])
    J, why = join(PM, PS)
    print(f"\n## Join\nPolymarket resolved moneylines {len(PM)} (after de-dup); " + ", ".join(f"{k} {v}" for k, v in sorted(why.items())))
    rows, drop = [], collections.Counter()
    for r in J:
        c = [(t, p) for t, p in PX.get(r["cid"]) or [] if t <= r["start"] - 300]
        if r["cid"] not in PX:
            drop["no price series"] += 1; continue
        if not c or c[-1][0] < r["start"] - 300 - 3600:
            drop["no point in the 60 min before close"] += 1; continue
        r["pm"] = c[-1][1]
        if not 0.03 <= r["pm"] <= 0.97:
            drop["close outside 0.03-0.97"] += 1; continue
        if min(r["na"], r["nb"]) < MINPRIOR:
            drop[f"a team with < {MINPRIOR} prior results"] += 1; continue
        rows.append(r)
    agree = sum(r["ps_y"] == r["y0"] for r in J)
    print(f"Joined {len(J)}; winner agrees between PandaScore and Polymarket in {agree} ({agree / max(len(J), 1):.1%}); "
          f"median |start diff| {sorted(abs(r['dtmin']) for r in J)[len(J) // 2] if J else 0:.0f} min")
    print("Dropped after join: " + ", ".join(f"{k} {v}" for k, v in drop.items()) + f"; usable {len(rows)}")
    print("Usable by game: " + ", ".join(f"{g} {n}" for g, n in collections.Counter(r["game"] for r in rows).most_common()))
    if a.join_only or len(rows) < 50:
        return
    rows.sort(key=lambda r: r["start"])
    cut = int(len(rows) * 0.6)
    tr, te = rows[:cut], rows[cut:]
    f = lambda t: dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d")
    print(f"\n## Split\ntrain {len(tr)} ({f(tr[0]['start'])} .. {f(tr[-1]['start'])}), test {len(te)} ({f(te[0]['start'])} .. {f(te[-1]['start'])})")
    # sanity on train: close calibration
    print("\n## Train: threshold selection (ROI per $1 at close + 1c)")
    print("| T | bets | ROI | 95% CI (day clusters) |\n| --- | --- | --- | --- |")
    pick = None
    for T in TGRID:
        variants += 1
        b = boot(tr, lambda r: roi(r, T), B=1000)
        if b is None:
            print(f"| {T:.2f} | 0 | - | - |"); continue
        print(f"| {T:.2f} | {b['n']} | {b['mean'] * 100:+.1f}% | [{b['lo'] * 100:+.1f}, {b['hi'] * 100:+.1f}] |")
        if b["n"] >= 40 and (pick is None or b["mean"] > pick[1]):
            pick = (T, b["mean"])
    if pick is None:
        print("no T with >= 40 train bets"); return
    T = pick[0]
    print(f"\nPicked T = {T:.2f} on train.")
    # blend fitted on train
    X = lambda r: [1.0, logit(r["pm"]), logit(r["pe"])]
    w = fit_logistic([X(r) for r in tr], [r["y0"] for r in tr]); variants += 1
    blend = lambda r: 1 / (1 + math.exp(-sum(p * q for p, q in zip(w, X(r)))))
    print(f"Blend (train fit): logit p = {w[0]:+.3f} {w[1]:+.3f}*logit(close) {w[2]:+.3f}*logit(Elo)")

    print("\n## TEST (newer 40%, evaluated once)")
    bt = boot(te, lambda r: roi(r, T))
    fav = boot(te, lambda r: (r["y0"] / (r["pm"] + 0.01) - 1) if r["pm"] >= 0.5 else ((1 - r["y0"]) / (1 - r["pm"] + 0.01) - 1))
    dog = boot(te, lambda r: (r["y0"] / (r["pm"] + 0.01) - 1) if r["pm"] < 0.5 else ((1 - r["y0"]) / (1 - r["pm"] + 0.01) - 1))
    print("| strategy | bets | days | ROI | 95% CI | detectable ROI (80% power) |\n| --- | --- | --- | --- | --- | --- |")
    for nm, b in ((f"Elo edge >= {T:.2f}", bt), ("always favourite (reference)", fav), ("always underdog (reference)", dog)):
        if b:
            print(f"| {nm} | {b['n']} | {b['days']} | {b['mean'] * 100:+.1f}% | [{b['lo'] * 100:+.1f}, {b['hi'] * 100:+.1f}] | +/-{2.8 * b['se'] * 100:.1f}% |")
    print("\n| model | test log-loss | 95% CI of (model - close) |\n| --- | --- | --- |")
    for nm, fn in (("close", lambda r: r["pm"]), ("Elo", lambda r: r["pe"]), ("blend", blend)):
        L = sum(ll(r["y0"], fn(r)) for r in te) / len(te)
        d = boot(te, lambda r: ll(r["y0"], fn(r)) - ll(r["y0"], r["pm"]))
        print(f"| {nm} | {L:.4f} | " + ("-" if nm == "close" else f"{d['mean']:+.4f} [{d['lo']:+.4f}, {d['hi']:+.4f}]") + " |")
    br = lambda fn: sum((fn(r) - r["y0"]) ** 2 for r in te) / len(te)
    print(f"\nBrier on test: close {br(lambda r: r['pm']):.4f}, Elo {br(lambda r: r['pe']):.4f}, blend {br(blend):.4f}")
    # calibration of the close on test (sanity gate: win rate ~= price)
    print("\nClose calibration on test (favourite side): " + ", ".join(
        f"{lo:.1f}-{lo + .1:.1f}: n={len(s)} win {sum(s) / len(s):.2f}" for lo in (0.5, 0.6, 0.7, 0.8, 0.9)
        for s in [[(r['y0'] if r['pm'] >= .5 else 1 - r['y0']) for r in te if lo <= max(r['pm'], 1 - r['pm']) < lo + .1]] if s))
    print(f"\nVariants tried: {variants} (K grid {len(KGRID)} x {len(PS)} games on PandaScore oldest half, T grid {len(TGRID)} on train, "
          f"1 blend fit); the test set was scored once with T={T:.2f}.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["fetch", "report"])
    ap.add_argument("--what", default="all", choices=["pandascore", "polymarket", "prices", "all"])
    ap.add_argument("--since", default="2023-01-01")
    ap.add_argument("--join-only", action="store_true", help="print sample/join diagnostics only (no outcomes)")
    a = ap.parse_args()
    {"fetch": fetch, "report": report}[a.cmd](a)
