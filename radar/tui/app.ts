import { statSync } from 'node:fs';
import { applyFilters, buildModel, runCycle } from '../collect.ts';
import { loadDecision } from '../decide-data.ts';
import { EDGES_PATH, saveEdges, scanAll } from '../edges.ts';
import { readJsonl, RESULTS_PATH, SNAPSHOTS_PATH } from '../forward.ts';
import { scoreLedger } from '../ledger.ts';
import { JUMPS_PATH, scanJumps, scoreJumps, type JumpScan } from '../jump.ts';
import { logFlagged, scanNewMarkets } from '../newmarkets.ts';
import { loadHolders } from '../holders.ts';
import { pickMarket } from './pick.ts';
import { loadXray } from '../xray.ts';
import { loadBook, refreshBook } from '../bookview.ts';
import { emptyFollow, loadFollowing } from '../following.ts';
import { resolveWalletInput } from '../walletinput.ts';
import { scanNewWallets } from '../newwallets.ts';
import { addWatched, describeTrade, isAddress, loadWatched, notify, removeWatched } from '../walletwatch.ts';
import { loadNews } from '../newsview.ts';
import { loadPeople, type Person } from '../people.ts';
import { httpFetchJson, type PolymarketClient } from '../polymarket.ts';
import { httpFetchText, pollFeeds } from '../poll.ts';
import { loadRefs, type RefConfig } from '../refs.ts';
import type { RadarStore } from '../store.ts';
import { flaggedNew, jumpFlags, listLength, moveSelection, render, visibleHolders, type Key, type LedgerView, type Model, type View } from './render.ts';

const ESC = '\x1b';
/** Opening the New tab reuses a scan younger than this; pressing w on the tab always rescans. */
const NEW_TAB_RESCAN_MS = 10 * 60_000;
/** The TUI scans the 60 busiest new markets (~1.5 min) so the tab fills while you wait; `new-scan` and the daemon scan up to 150. */
const TUI_SCAN = { hours: 24, maxMarkets: 60 } as const;
/** Opening the Jumps tab reuses a scan younger than this; pressing j on the tab always rescans. */
const JUMPS_TAB_RESCAN_MS = 5 * 60_000;

/**
 * scanJumps with progress: scanJumps has no progress callback, so the client's event reads and the price-history fetches are
 * observed through a thin wrapper. Writes nothing, like scanJumps.
 */
export function scanJumpsWithProgress(client: PolymarketClient, onProgress: (stage: string) => void): Promise<JumpScan> {
  const tracked = Object.create(client) as PolymarketClient;
  let histories = 0;
  let books = 0;
  tracked.activeEventsRaw = (offset: number, limit?: number) => {
    onProgress(`reading events ${offset + 1}-${offset + (limit ?? 100)}`);
    return client.activeEventsRaw(offset, limit);
  };
  tracked.book = (token: string) => {
    books++;
    return client.book(token);
  };
  return scanJumps(tracked, {
    fetchJson: (url: string) => {
      if (url.includes('prices-history')) onProgress(`checking price history ${++histories}, ${Math.floor(books / 2)} jump(s) so far`);
      return httpFetchJson(url);
    },
  });
}

export interface TuiOptions {
  intervalSecs?: number;
  news?: boolean;
  once?: boolean;
  cols?: number;
  rows?: number;
  tab?: View['tab'];
  /** With `once` and the decision tab: the event to decide on. */
  slug?: string;
  /** Watchlist and reference config, read fresh from disk each time a decision or holder list is opened unless given. */
  people?: readonly Person[];
  refs?: readonly RefConfig[];
}

/** Reads the watchlist and reference config; a broken file is reported, not fatal. */
function readConfig(opts: TuiOptions): { people: readonly Person[]; refs: readonly RefConfig[]; problem: string | null } {
  let problem: string | null = null;
  let people = opts.people ?? [];
  let refs = opts.refs ?? [];
  try {
    if (!opts.people) people = loadPeople();
    if (!opts.refs) refs = loadRefs();
  } catch (error) {
    problem = error instanceof Error ? error.message : String(error);
  }
  return { people, refs, problem };
}

/** Scores the forward logs; the bootstrap is only rerun when a log file changed since the last refresh. */
let ledgerCache: { key: string; view: LedgerView } | null = null;
function ledgerView(nowMs: number): LedgerView {
  const stamp = (p: string) => {
    try {
      const st = statSync(p);
      return `${st.size}:${st.mtimeMs}`;
    } catch {
      return 'none';
    }
  };
  const key = `${stamp(SNAPSHOTS_PATH)}|${stamp(RESULTS_PATH)}|${stamp(JUMPS_PATH)}`;
  if (ledgerCache?.key === key) return ledgerCache.view;
  let view: LedgerView;
  try {
    view = { at: nowMs, error: null, report: scoreLedger(readJsonl(SNAPSHOTS_PATH), readJsonl(RESULTS_PATH)) };
  } catch (error) {
    view = { at: nowMs, error: `ledger: ${error instanceof Error ? error.message : String(error)}`, report: null };
  }
  try {
    view.jumps = scoreJumps(readJsonl(JUMPS_PATH));
  } catch (error) {
    view.error = `${view.error ? `${view.error}; ` : ''}jumps: ${error instanceof Error ? error.message : String(error)}`;
  }
  ledgerCache = { key, view };
  return view;
}

function snapshotModel(store: RadarStore, prev: Model | null, nowMs: number, status: Model['status'], filter: string | null, showBots: boolean): Model {
  const b = buildModel(store, nowMs);
  return {
    filter,
    showBots,
    anomalies: applyFilters(b.anomalies, { cat: filter }),
    games: b.games,
    prints: b.prints,
    leads: b.leads,
    status: { ...status, events: b.events, historySecs: b.historySecs, printsWindowMin: b.prints.length ? 360 : null },
    oiSeries: prev?.oiSeries ?? [],
    holders: prev?.holders ?? null,
    decision: prev?.decision ?? null,
    search: prev?.search ?? null,
    news: prev?.news ?? null,
    edges: prev?.edges ?? null,
    ledger: ledgerView(nowMs),
    newMarkets: prev?.newMarkets ?? null,
    jumps: prev?.jumps ?? null,
    xray: prev?.xray ?? null,
    newWallets: prev?.newWallets ?? null,
    book: prev?.book ?? null,
    follow: prev?.follow ?? null,
  };
}

function seriesFor(store: RadarStore, m: Model, v: View, nowSecs: number): number[] {
  const a = v.tab === 'anomalies' ? m.anomalies[v.sel] : v.tab === 'games' ? m.games[v.sel] : undefined;
  return a ? store.snapshotSeries(a.eventId, nowSecs - 86_400).map((s) => s.oi) : [];
}

/** The event the user is looking at, for actions like "load holders" or "show link". */
function selectedSlug(m: Model, v: View): string | undefined {
  return v.tab === 'anomalies' ? m.anomalies[v.sel]?.slug : v.tab === 'games' ? m.games[v.sel]?.slug : v.tab === 'prints' ? m.prints[v.sel]?.eventSlug : v.tab === 'holders' ? m.holders?.slug : v.tab === 'decision' ? m.decision?.slug : v.tab === 'search' ? m.search?.results[v.sel]?.slug : v.tab === 'news' ? m.news?.slug : v.tab === 'edge' ? m.edges?.result?.candidates[v.sel]?.slug : v.tab === 'new' ? flaggedNew(m)[v.sel]?.eventSlug || undefined : v.tab === 'jumps' ? jumpFlags(m)[v.sel]?.eventSlug || undefined : undefined;
}

export async function runTui(store: RadarStore, client: PolymarketClient, opts: TuiOptions = {}): Promise<void> {
  const out = process.stdout;
  const interval = (opts.intervalSecs ?? 120) * 1000;
  let status: Model['status'] = { lastPollAt: null, nextPollAt: null, busy: false, error: null, events: 0, historySecs: 0, printsWindowMin: null, message: null };
  let view: View = { tab: opts.tab ?? 'anomalies', sel: 0, cols: opts.cols ?? out.columns ?? 120, rows: opts.rows ?? out.rows ?? 40 };
  let filter: string | null = null;
  let showBots = false;
  let model = snapshotModel(store, null, Date.now(), status, filter, showBots);

  /** Update status and the already-built model together, so the next paint shows it. */
  const setStatus = (patch: Partial<Model['status']>) => {
    status = { ...status, ...patch };
    model = { ...model, status: { ...model.status, ...patch } };
  };

  const refresh = () => {
    const selectedId = view.tab === 'anomalies' ? model.anomalies[view.sel]?.eventId : view.tab === 'games' ? model.games[view.sel]?.eventId : undefined;
    model = snapshotModel(store, model, Date.now(), status, filter, showBots);
    if (selectedId) {
      const list = view.tab === 'games' ? model.games : model.anomalies;
      const i = list.findIndex((a) => a.eventId === selectedId);
      if (i >= 0) view = { ...view, sel: i };
    }
    view = { ...view, sel: Math.min(view.sel, Math.max(0, listLength(model, view.tab) - 1)) };
    model = { ...model, oiSeries: seriesFor(store, model, view, Math.floor(Date.now() / 1000)) };
  };

  const poll = async () => {
    status = { ...status, busy: true, error: null };
    refresh();
    try {
      const r = await runCycle(client, store, {
        onStage: () => {
          refresh();
          if (!opts.once) paint();
        },
      });
      status = { ...status, busy: false, lastPollAt: Date.now(), nextPollAt: Date.now() + interval, error: null, message: r.profileErrors ? `${r.profileErrors} wallet profile(s) failed; retrying next poll` : null };
    } catch (error) {
      status = { ...status, busy: false, nextPollAt: Date.now() + interval, error: error instanceof Error ? error.message : String(error) };
    }
    refresh();
  };

  if (opts.once) {
    await poll();
    if (opts.slug && view.tab === 'decision') {
      const cfg = readConfig(opts);
      const dv = await loadDecision(client, store, opts.slug, { people: cfg.people, refs: cfg.refs });
      model = { ...model, decision: dv };
    }
    if (view.tab === 'jumps') {
      const scan = await scanJumps(client);
      model = { ...model, jumps: { stage: 'done', done: true, error: scan.errors.length ? `${scan.errors.length} error(s): ${scan.errors[0]}` : null, at: Date.now(), scan } };
    }
    if (view.tab === 'new') {
      const sum = await scanNewMarkets(client, TUI_SCAN);
      model = { ...model, newMarkets: { stage: 'done', done: true, error: sum.errors.length ? `${sum.errors.length} error(s): ${sum.errors[0]}` : null, at: Date.now(), summary: sum, logged: logFlagged(sum.lines) } };
    }
    process.stdout.write(render(model, view, Date.now()).join('\n') + '\n');
    return;
  }

  // ---- interactive ----
  let prev: string[] = [];
  const paint = (full = false) => {
    const lines = render(model, view, Date.now());
    let buf = '';
    for (let i = 0; i < lines.length; i++) if (full || lines[i] !== prev[i]) buf += `${ESC}[${i + 1};1H${lines[i]}${ESC}[K`;
    if (buf) out.write(buf);
    prev = lines;
  };
  const restore = () => {
    out.write(`${ESC}[?25h${ESC}[?1049l`);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  };
  const timers: NodeJS.Timeout[] = [];
  let pollTimer: NodeJS.Timeout | undefined;
  const quit = () => {
    for (const t of timers) clearInterval(t);
    if (pollTimer) clearTimeout(pollTimer);
    restore();
    process.exit(0);
  };

  const schedule = () => {
    pollTimer = setTimeout(async () => {
      await poll();
      paint();
      schedule();
    }, Math.max(1_000, (status.nextPollAt ?? Date.now() + interval) - Date.now()));
  };

  // Holders load in the background; a newer request makes older progress callbacks irrelevant.
  let holdersToken = 0;
  const openHolders = (slug: string, cid?: string) => {
    const token = ++holdersToken;
    const keep = model.holders?.slug === slug ? model.holders.markets : [];
    model = { ...model, holders: { slug, eventTitle: slug, question: 'loading…', cid: cid ?? '', rows: [], markets: keep, total: 0, loaded: 0, done: false, error: null } };
    view = { ...view, tab: 'holders', sel: 0 };
    const cfg = readConfig(opts);
    if (cfg.problem) setStatus({ message: cfg.problem });
    paint();
    void loadHolders(client, store, slug, {
      cid,
      people: cfg.people,
      onProgress: (hv) => {
        if (token !== holdersToken) return;
        model = { ...model, holders: hv };
        view = { ...view, sel: Math.min(view.sel, Math.max(0, listLength(model, 'holders') - 1)) };
        paint();
      },
    });
  };

  // Same idea for decisions: a newer request makes older progress callbacks irrelevant.
  let decisionToken = 0;
  const openDecision = (slug: string) => {
    const token = ++decisionToken;
    const cfg = readConfig(opts);
    model = { ...model, decision: { slug, title: slug, stage: 'reading the event', progress: { loaded: 0, total: 0 }, done: false, error: null, decision: null, wallets: {} } };
    view = { ...view, tab: 'decision', sel: 0 };
    setStatus({ message: cfg.problem });
    paint();
    void loadDecision(client, store, slug, {
      people: cfg.people,
      refs: cfg.refs,
      onProgress: (dv) => {
        if (token !== decisionToken) return;
        model = { ...model, decision: dv };
        view = { ...view, sel: Math.min(view.sel, Math.max(0, listLength(model, 'decision') - 1)) };
        paint();
      },
    });
  };

  // Edge scan: `e` screens every active event, then checks the best candidates on live books. A newer scan supersedes an older one.
  let edgeToken = 0;
  const startEdgeScan = () => {
    const token = ++edgeToken;
    model = { ...model, edges: { stage: 'starting', done: false, error: null, result: model.edges?.result ?? null } };
    view = { ...view, tab: 'edge', sel: 0 };
    paint();
    scanAll(client, {
      onProgress: (stage, partial) => {
        if (token !== edgeToken) return;
        model = { ...model, edges: { stage, done: false, error: null, result: partial } };
        view = { ...view, sel: Math.min(view.sel, Math.max(0, listLength(model, 'edge') - 1)) };
        paint();
      },
    }).then(
      (res) => {
        if (token !== edgeToken) return;
        let error: string | null = res.errors.length ? res.errors.join('; ') : null;
        try {
          saveEdges(res, EDGES_PATH);
        } catch (e) {
          error = `could not save ${EDGES_PATH}: ${e instanceof Error ? e.message : String(e)}`;
        }
        model = { ...model, edges: { stage: 'done', done: true, error, result: res } };
        paint();
      },
      (error) => {
        if (token !== edgeToken) return;
        model = { ...model, edges: { stage: 'failed', done: true, error: error instanceof Error ? error.message : String(error), result: model.edges?.result ?? null } };
        paint();
      },
    );
  };

  // New markets: `w` opens the tab and scans when there is no recent scan; `w` on the tab rescans. Flagged lines go to the forward log.
  let newToken = 0;
  const startNewScan = () => {
    const token = ++newToken;
    model = { ...model, newMarkets: { stage: 'scanning the 60 busiest markets created in the last 24h', done: false, error: null, at: null, summary: model.newMarkets?.summary ?? null, logged: null } };
    paint();
    scanNewMarkets(client, TUI_SCAN).then(
      (sum) => {
        if (token !== newToken) return;
        let error: string | null = sum.errors.length ? `${sum.errors.length} error(s): ${sum.errors[0]}` : null;
        let logged: { written: number; duplicates: number } | null = null;
        try {
          logged = logFlagged(sum.lines);
        } catch (e) {
          error = `could not write the forward log: ${e instanceof Error ? e.message : String(e)}`;
        }
        model = { ...model, newMarkets: { stage: 'done', done: true, error, at: Date.now(), summary: sum, logged } };
        view = { ...view, sel: Math.min(view.sel, Math.max(0, listLength(model, 'new') - 1)) };
        paint();
      },
      (error) => {
        if (token !== newToken) return;
        model = { ...model, newMarkets: { stage: 'failed', done: true, error: error instanceof Error ? error.message : String(error), at: null, summary: model.newMarkets?.summary ?? null, logged: null } };
        paint();
      },
    );
  };
  const openNew = () => {
    const nv = model.newMarkets;
    const wasOn = view.tab === 'new';
    press('u');
    const stale = !nv || (nv.done && (wasOn || nv.at === null || Date.now() - nv.at > NEW_TAB_RESCAN_MS));
    if (stale) startNewScan();
  };

  // Jumps: `j` opens the tab and scans when there is no recent scan; `j` on the tab rescans. A newer scan supersedes an older one. Nothing is logged here (the daemon logs).
  let jumpsToken = 0;
  const startJumpScan = () => {
    const token = ++jumpsToken;
    model = { ...model, jumps: { stage: 'starting', done: false, error: null, at: null, scan: model.jumps?.scan ?? null } };
    paint();
    scanJumpsWithProgress(client, (stage) => {
      if (token !== jumpsToken || !model.jumps) return;
      model = { ...model, jumps: { ...model.jumps, stage } };
      paint();
    }).then(
      (scan) => {
        if (token !== jumpsToken) return;
        model = { ...model, jumps: { stage: 'done', done: true, error: scan.errors.length ? `${scan.errors.length} error(s): ${scan.errors[0]}` : null, at: Date.now(), scan } };
        view = { ...view, sel: Math.min(view.sel, Math.max(0, listLength(model, 'jumps') - 1)) };
        paint();
      },
      (error) => {
        if (token !== jumpsToken) return;
        model = { ...model, jumps: { stage: 'failed', done: true, error: error instanceof Error ? error.message : String(error), at: null, scan: model.jumps?.scan ?? null } };
        paint();
      },
    );
  };
  const openJumps = () => {
    const jv = model.jumps;
    const wasOn = view.tab === 'jumps';
    press('j');
    const stale = !jv || (jv.done && (wasOn || jv.at === null || Date.now() - jv.at > JUMPS_TAB_RESCAN_MS));
    if (stale) startJumpScan();
  };

  // News: `n` searches headlines for the selected event; a newer request makes older progress irrelevant.
  let newsToken = 0;
  const openNews = (slug: string) => {
    const token = ++newsToken;
    model = { ...model, news: { slug, title: slug, query: '', stage: 'reading the market', done: false, error: null, hits: [], sourceErrors: [], markets: [], rules: '' } };
    view = { ...view, tab: 'news', sel: 0 };
    paint();
    void loadNews(client, httpFetchText, slug, {
      onProgress: (nv) => {
        if (token !== newsToken) return;
        model = { ...model, news: nv };
        view = { ...view, sel: Math.min(view.sel, Math.max(0, listLength(model, 'news') - 1)) };
        paint();
      },
    });
  };

  // Search: `/` starts typing, Enter runs it, Esc cancels. Typing is handled here so letters like q or p are text while typing.
  let searchToken = 0;
  const putSearch = (patch: Partial<NonNullable<Model['search']>>) => {
    const cur = model.search ?? { query: '', typing: false, loading: false, error: null, results: [] };
    model = { ...model, search: { ...cur, ...patch } };
  };
  const beginSearch = () => {
    putSearch({ typing: true, error: null });
    view = { ...view, tab: 'search', sel: 0 };
    paint();
  };
  let xrayToken = 0;
  let followToken = 0;
  const putFollow = (patch: Partial<ReturnType<typeof emptyFollow>>) => {
    model = { ...model, follow: { ...(model.follow ?? emptyFollow()), ...patch } };
  };
  const refreshFollow = (notifyNew = true) => {
    const list = loadWatched();
    const token = ++followToken;
    if (list.length === 0) {
      putFollow({ cards: [], loading: false });
      return paint();
    }
    putFollow({ loading: true });
    paint();
    void loadFollowing(client, store, list, model.follow?.seen ?? {}).then(({ cards, seen, fresh }) => {
      if (token !== followToken) return;
      putFollow({ cards, seen, loading: false, loadedAt: Date.now() });
      view = { ...view, sel: Math.min(view.sel, Math.max(0, cards.length - 1)) };
      if (notifyNew) for (const { card, trade } of fresh.slice(0, 5)) notify('Followed wallet traded', `${describeTrade({ wallet: card.wallet, note: card.note ?? card.name ?? undefined }, trade)}\nhttps://polymarket.com/event/${trade.slug}`);
      paint();
    });
  };
  const typeFollow = (d: string) => {
    const text = model.follow?.input ?? '';
    if (d === '\x03') return quit();
    if (d === ESC) {
      putFollow({ input: null });
      return paint();
    }
    if (d === '\r' || d === '\n') {
      if (!text.trim()) {
        putFollow({ input: null });
        return paint();
      }
      putFollow({ input: null, message: 'looking that up…' });
      paint();
      void resolveWalletInput(client, text.trim()).then(
        (r) => {
          try {
            const res = addWatched(r.wallet, r.name ?? undefined);
            putFollow({ message: `${res.added ? 'now following' : 'already following'} ${r.name ?? `${r.wallet.slice(0, 10)}…`} (${res.list.length} total)` });
            refreshFollow(false);
          } catch (error) {
            putFollow({ message: error instanceof Error ? error.message : String(error) });
            paint();
          }
        },
        (error) => {
          putFollow({ message: error instanceof Error ? error.message : String(error) });
          paint();
        },
      );
      return;
    }
    if (d === '\x7f' || d === '\b') putFollow({ input: text.slice(0, -1) });
    else if (!d.startsWith(ESC) && !/[\x00-\x1f]/.test(d)) putFollow({ input: (text + d).slice(0, 300) });
    paint();
  };
  timers.push(setInterval(() => {
    if (!model.follow || loadWatched().length === 0) return;
    refreshFollow(true);
  }, 90_000));
  let bookToken = 0;
  let bookTokenId: string | null = null;
  const openBook = (slug: string, cid: string) => {
    const token = ++bookToken;
    bookTokenId = null;
    model = { ...model, book: { slug, cid, question: 'loading…', outcomes: ['Yes', 'No'], book: null, summary: null, feeRate: 0.05, fetchedAt: null, error: null, trades: [] } };
    view = { ...view, tab: 'book', sel: 0 };
    paint();
    void loadBook(client, slug, cid).then(async (bv) => {
      if (token !== bookToken) return;
      model = { ...model, book: bv };
      paint();
      try {
        const ev = await client.eventBySlug(slug);
        bookTokenId = ev?.markets.find((x) => x.cid === cid)?.tokenIds[0] ?? null;
      } catch {
        /* the next manual open retries */
      }
    });
  };
  timers.push(setInterval(() => {
    const bk = model.book;
    if (view.tab !== 'book' || !bk || !bookTokenId) return;
    const token = bookToken;
    void refreshBook(client, bookTokenId, bk).then((patch) => {
      if (token !== bookToken || !model.book) return;
      model = { ...model, book: { ...model.book, ...patch } };
      paint();
    });
  }, 3_000));
  let walletsToken = 0;
  const startWalletScan = () => {
    const token = ++walletsToken;
    const prevResult = model.newWallets?.result ?? null;
    model = { ...model, newWallets: { stage: 'starting', done: false, error: null, result: prevResult, at: null } };
    paint();
    void scanNewWallets(client, store, {
      cancelled: () => token !== walletsToken,
      onProgress: (stage, partial) => {
        if (token !== walletsToken) return;
        model = { ...model, newWallets: { stage, done: false, error: null, result: partial ?? prevResult, at: null } };
        paint();
      },
    }).then(({ result, error }) => {
      if (token !== walletsToken) return;
      model = { ...model, newWallets: { stage: 'done', done: true, error, result: result ?? prevResult, at: Date.now() } };
      view = { ...view, sel: Math.min(view.sel, Math.max(0, listLength(model, 'wallets') - 1)) };
      paint();
    });
  };
  const openWallets = () => {
    const nw = model.newWallets;
    const wasOn = view.tab === 'wallets';
    press('w');
    if (!nw || (nw.done && (wasOn || nw.at === null || Date.now() - nw.at > 5 * 60_000))) startWalletScan();
  };
  const openXray = (wallet: string) => {
    const token = ++xrayToken;
    model = { ...model, xray: { wallet, stage: 'starting', done: false, error: null, report: null } };
    view = { ...view, tab: 'xray', sel: 0 };
    paint();
    void loadXray(client, wallet, {
      onProgress: (x) => {
        if (token !== xrayToken) return;
        model = { ...model, xray: { wallet, stage: x.stage, done: x.done, error: x.error, report: x.report } };
        paint();
      },
    });
  };
  const runSearch = (query: string) => {
    const address = query.match(/0x[0-9a-fA-F]{40}/)?.[0]; // a pasted wallet address anywhere in the box (the box keeps the previous query)
    if (address) {
      putSearch({ typing: false });
      return openXray(address);
    }
    const token = ++searchToken;
    putSearch({ typing: false, loading: true, error: null, results: [] });
    paint();
    client.searchEvents(query, 25).then(
      (hits) => {
        if (token !== searchToken) return;
        putSearch({ loading: false, results: [...hits].sort((a, b) => b.volume - a.volume) });
        view = { ...view, sel: 0 };
        paint();
      },
      (error) => {
        if (token !== searchToken) return;
        putSearch({ loading: false, error: error instanceof Error ? error.message : String(error) });
        paint();
      },
    );
  };
  const typeSearch = (d: string) => {
    const q = model.search?.query ?? '';
    if (d === '\x03') return quit();
    if (d === ESC) {
      putSearch({ typing: false });
      return paint();
    }
    if (d === '\r' || d === '\n') {
      if (q.trim()) return runSearch(q.trim());
      putSearch({ typing: false });
      return paint();
    }
    if (d === '\x7f' || d === '\b') putSearch({ query: q.slice(0, -1) });
    else if (!d.startsWith(ESC) && !/[\x00-\x1f]/.test(d)) putSearch({ query: (q + d).slice(0, 80) });
    paint();
  };

  out.write(`${ESC}[?1049h${ESC}[?25l${ESC}[2J`);
  process.on('exit', restore);
  process.on('uncaughtException', (e) => {
    restore();
    console.error(e);
    process.exit(1);
  });
  out.on('resize', () => {
    view = { ...view, cols: out.columns ?? view.cols, rows: out.rows ?? view.rows };
    paint(true);
  });
  paint(true);

  const press = (key: Key) => {
    view = moveSelection(view, key, model);
    model = { ...model, oiSeries: seriesFor(store, model, view, Math.floor(Date.now() / 1000)) };
    setStatus({ message: null });
    paint();
  };
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', (d: string) => {
      const map: Record<string, Key> = {
        [`${ESC}[A`]: 'up', [`${ESC}[B`]: 'down', [`${ESC}[5~`]: 'pageup', [`${ESC}[6~`]: 'pagedown', [`${ESC}[H`]: 'home', [`${ESC}[1~`]: 'home', [`${ESC}[F`]: 'end', [`${ESC}[4~`]: 'end',
        '\t': 'tab', k: 'up', g: 'home', G: 'end', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5', '6': '6', '7': '7', '8': '8', '9': '9', '0': '0',
      };
      if (model.search?.typing) return typeSearch(d);
      if (model.follow?.input !== null && model.follow?.input !== undefined) return typeFollow(d);
      if (d === '/') return beginSearch();
      if (d === 'w') return openWallets();
      if ((d === '\r' || d === '\n') && view.tab === 'wallets') {
        const row = model.newWallets?.result?.rows[view.sel];
        if (!row) return;
        return openHolders(row.eventSlug, row.cid);
      }
      if (d === 'a') {
        const holder = view.tab === 'holders' ? visibleHolders(model)[view.sel] : undefined;
        const wallet = holder?.wallet ?? (view.tab === 'xray' ? model.xray?.wallet : undefined);
        if (!wallet || !isAddress(wallet)) {
          setStatus({ message: 'select a holder (or open an x-ray) and press a to watch that wallet' });
          return paint();
        }
        try {
          const r = addWatched(wallet, holder?.name ?? undefined);
          setStatus({ message: `${r.added ? 'watching' : 'already watching'} ${wallet.slice(0, 10)}…: run  npm run radar -- wallet-watch  to get a notice when it trades (${r.list.length} on the list)` });
        } catch (error) {
          setStatus({ message: `could not save the watchlist: ${error instanceof Error ? error.message : String(error)}` });
        }
        return paint();
      }
      if (d === 'x') {
        const holder = view.tab === 'holders' ? visibleHolders(model)[view.sel] : undefined;
        if (holder) return openXray(holder.wallet);
        const followed = view.tab === 'follow' ? model.follow?.cards[view.sel] : undefined;
        if (followed) return openXray(followed.wallet);
        if (model.xray) {
          view = { ...view, tab: 'xray', sel: 0 };
          return paint();
        }
        setStatus({ message: 'on Holders select a wallet and press x, or / and paste a 0x… address' });
        return paint();
      }
      if (d === 'q' || d === '\x03') return quit();
      if (d === 'r') {
        void poll().then(() => paint());
        paint();
        return;
      }
      if ((d === '[' || d === ']' || d === '{' || d === '}') && view.tab === 'holders' && model.holders && model.holders.markets.length > 1) {
        const next = pickMarket(model.holders.markets, model.holders.cid, d);
        return next ? openHolders(model.holders.slug, next.cid) : paint();
      }
      if (d === '+' || d === '=') {
        putFollow({ input: '', message: null });
        view = { ...view, tab: 'follow', sel: 0 };
        if (!model.follow?.loadedAt) refreshFollow(false);
        return paint();
      }
      if (d === '-' && view.tab === 'follow') {
        const card = model.follow?.cards[Math.min(view.sel, (model.follow?.cards.length ?? 1) - 1)];
        if (!card) return;
        removeWatched(card.wallet);
        putFollow({ cards: (model.follow?.cards ?? []).filter((k) => k.wallet !== card.wallet), message: `unfollowed ${card.note ?? card.name ?? card.wallet.slice(0, 10)}` });
        view = { ...view, sel: Math.max(0, view.sel - 1) };
        return paint();
      }
      if (d === '9') {
        press('9');
        const f = model.follow;
        if (!f || !f.loadedAt || Date.now() - f.loadedAt > 45_000) refreshFollow(false);
        return paint();
      }
      if ((d === '\r' || d === '\n') && view.tab === 'follow') {
        const card = model.follow?.cards[Math.min(view.sel, (model.follow?.cards.length ?? 1) - 1)];
        return card ? openXray(card.wallet) : undefined;
      }
      if (d === '8') {
        const h = model.holders;
        const row = view.tab === 'wallets' ? model.newWallets?.result?.rows[view.sel] : undefined;
        const dm = view.tab === 'decision' ? model.decision?.decision?.markets[Math.min(view.sel, (model.decision?.decision?.markets.length ?? 1) - 1)] : undefined;
        if (row) return openBook(row.eventSlug, row.cid);
        if (dm && model.decision) return openBook(model.decision.slug, dm.cid);
        if (view.tab !== 'book' && h?.cid) return openBook(h.slug, h.cid);
        if (model.book) {
          view = { ...view, tab: 'book', sel: 0 };
          return paint();
        }
        setStatus({ message: 'open Holders, Decision or a Newbies row first, then press 8' });
        return paint();
      }
      if ((d === '[' || d === ']' || d === '{' || d === '}') && view.tab === 'book' && model.book && model.holders?.slug === model.book.slug && model.holders.markets.length > 1) {
        const next = pickMarket(model.holders.markets, model.book.cid, d);
        return next ? openBook(model.book.slug, next.cid) : paint();
      }
      if (d === 'h' && view.tab === 'wallets') {
        const row = model.newWallets?.result?.rows[view.sel];
        if (!row) return;
        return openHolders(row.eventSlug, row.cid);
      }
      if (d === 'h' && view.tab === 'decision' && model.decision?.decision) {
        // on the Decision tab, h opens the holders of the exact market row selected with the arrows (spread, total, game 1...)
        const ms = model.decision.decision.markets;
        const cid = ms[Math.min(view.sel, ms.length - 1)]?.cid;
        return openHolders(model.decision.slug, cid);
      }
      if (d === 'h') {
        const slug = selectedSlug(model, view);
        if (!slug) {
          setStatus({ message: 'select an event first' });
          return paint();
        }
        return openHolders(slug);
      }
      if (d === 'p') {
        const slug = selectedSlug(model, view);
        if (!slug) {
          setStatus({ message: 'select an event first' });
          return paint();
        }
        return openDecision(slug);
      }
      if (d === 'b') {
        showBots = !showBots;
        model = { ...model, showBots };
        view = { ...view, sel: 0 };
        setStatus({ message: showBots ? 'showing bots and market makers' : 'people only' });
        return paint();
      }
      if (d === 'f') {
        const cats = ['', ...[...new Set(buildModel(store, Date.now()).anomalies.map((a) => a.cat).filter(Boolean))].sort()];
        filter = cats[(cats.indexOf(filter ?? '') + 1) % cats.length] || null;
        view = { ...view, sel: 0 };
        refresh();
        return paint();
      }
      if (d === 'o') {
        const slug = selectedSlug(model, view);
        const holder = view.tab === 'holders' ? visibleHolders(model)[view.sel] : undefined;
        const url = view.tab === 'leads' ? model.leads[view.sel]?.url : view.tab === 'news' ? model.news?.hits[view.sel]?.url : holder ? `https://polymarket.com/profile/${holder.wallet}` : slug ? `https://polymarket.com/event/${slug}` : undefined;
        setStatus({ message: url ?? 'nothing selected' });
        return paint();
      }
      const k = map[d];
      if (k) press(k);
    });
  }

  timers.push(setInterval(() => paint(), 1_000));
  if (opts.news ?? true) {
    const newsPoll = async () => {
      try {
        await pollFeeds(httpFetchText, store);
        refresh();
      } catch {
        // news is a side feed; its failures are visible per-feed in `news poll`
      }
    };
    setTimeout(newsPoll, 5_000);
    timers.push(setInterval(newsPoll, 15 * 60_000));
  }
  await poll();
  paint();
  schedule();
  // The shell is event-driven: stay pending (so the caller does not close the store) until quit() exits the process.
  await new Promise<void>(() => undefined);
}
