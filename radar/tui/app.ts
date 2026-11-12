import { applyFilters, buildModel, runCycle } from '../collect.ts';
import { loadDecision } from '../decide-data.ts';
import { scanJumps, type JumpScan } from '../jump.ts';
import { loadHolders } from '../holders.ts';
import { pickMarket } from './pick.ts';
import { loadXray } from '../xray.ts';
import { cycle, emptyBook, GROUPS, loadBookMeta, PERIODS, TAPE_MINS } from '../bookview.ts';
import { autoCenter } from '../dom.ts';
import { LiveBookFeed } from '../livebook.ts';
import { emptyFollow, loadFollowing } from '../following.ts';
import { parseWalletInput, resolveWalletInput } from '../walletinput.ts';
import { scanNewWallets } from '../newwallets.ts';
import { addWatched, describeTrade, isAddress, loadWatched, notify, removeWatched } from '../walletwatch.ts';
import { loadPeople, type Person } from '../people.ts';
import { httpFetchJson, NotFoundError, type PolymarketClient } from '../polymarket.ts';
import { loadRefs, type RefConfig } from '../refs.ts';
import type { RadarStore } from '../store.ts';
import { enterOpensDecision, listLength, moveSelection, opensFollowPrompt, render, visibleHolders, type Key, type Model, type View } from './render.ts';

const ESC = '\x1b';
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
  return v.tab === 'anomalies' ? m.anomalies[v.sel]?.slug : v.tab === 'games' ? m.games[v.sel]?.slug : v.tab === 'holders' ? m.holders?.slug : v.tab === 'decision' ? m.decision?.slug : v.tab === 'search' ? m.search?.results[v.sel]?.slug : undefined;
}

const errText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 100);

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
      model = { ...model, decision: dv, decisionAt: Date.now() };
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
    bookFeed?.stop();
    for (const t of timers) clearInterval(t);
    if (pollTimer) clearTimeout(pollTimer);
    restore();
    process.exit(0);
  };

  const schedule = () => {
    pollTimer = setTimeout(async () => {
      try {
        await poll();
        paint();
      } catch (error) {
        // a throwing poll must not end the polling: report it and try again next time
        status = { ...status, busy: false, nextPollAt: Date.now() + interval };
        setStatus({ message: `poll failed: ${errText(error)}; retrying` });
        paint();
      } finally {
        schedule();
      }
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
    loadHolders(client, store, slug, {
      cid,
      people: cfg.people,
      onProgress: (hv) => {
        if (token !== holdersToken) return;
        model = { ...model, holders: hv };
        view = { ...view, sel: Math.min(view.sel, Math.max(0, listLength(model, 'holders') - 1)) };
        paint();
      },
    }).catch((error: unknown) => {
      if (token !== holdersToken) return;
      if (model.holders) model = { ...model, holders: { ...model.holders, done: true, error: errText(error) } };
      setStatus({ message: `holders failed: ${errText(error)}` });
      paint();
    });
  };

  // Same idea for decisions: a newer request makes older progress callbacks irrelevant.
  let decisionToken = 0;
  const openDecision = (slug: string) => {
    const token = ++decisionToken;
    const cfg = readConfig(opts);
    model = { ...model, decisionAt: null, decision: { slug, title: slug, stage: 'reading the event', progress: { loaded: 0, total: 0 }, done: false, error: null, decision: null, wallets: {} } };
    view = { ...view, tab: 'decision', sel: 0 };
    setStatus({ message: cfg.problem });
    paint();
    loadDecision(client, store, slug, {
      people: cfg.people,
      refs: cfg.refs,
      onProgress: (dv) => {
        if (token !== decisionToken) return;
        model = { ...model, decision: dv, decisionAt: dv.done ? Date.now() : (model.decisionAt ?? null) };
        view = { ...view, sel: Math.min(view.sel, Math.max(0, listLength(model, 'decision') - 1)) };
        paint();
      },
    }).catch((error: unknown) => {
      if (token !== decisionToken) return;
      if (model.decision) model = { ...model, decision: { ...model.decision, done: true, error: errText(error) } };
      setStatus({ message: `decision failed: ${errText(error)}` });
      paint();
    });
  };

  // Search: `/` starts typing, Enter runs it, Esc cancels. Typing is handled here so letters like q or p are text while typing.
  let searchToken = 0;
  const putSearch = (patch: Partial<NonNullable<Model['search']>>) => {
    const cur = model.search ?? { query: '', typing: false, loading: false, error: null, results: [] };
    model = { ...model, search: { ...cur, ...patch } };
  };
  const beginSearch = () => {
    putSearch({ typing: true, query: '', error: null }); // a new search starts empty, so a pasted wallet or link is the whole input
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
    loadFollowing(client, store, list, model.follow?.seen ?? {})
      .then(({ cards, seen, fresh }) => {
        if (token !== followToken) return;
        putFollow({ cards, seen, loading: false, loadedAt: Date.now() });
        view = { ...view, sel: Math.min(view.sel, Math.max(0, cards.length - 1)) };
        if (notifyNew) for (const { card, trade } of fresh.slice(0, 5)) notify('Followed wallet traded', `${describeTrade({ wallet: card.wallet, note: card.note ?? card.name ?? undefined }, trade)}\nhttps://polymarket.com/event/${trade.slug}`);
        paint();
      })
      .catch((error: unknown) => {
        if (token !== followToken) return;
        putFollow({ loading: false, message: `following failed: ${errText(error)}` });
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
  // ---- live order book: the feed (WebSocket, REST fallback) runs only while the Book tab is on screen
  let bookToken = 0;
  let bookFeed: LiveBookFeed | null = null;
  const stopBookFeed = () => {
    bookFeed?.stop();
    bookFeed = null;
  };
  const startBookFeed = (token: number) => {
    const bv = model.book;
    if (!bv || !bv.tokenIds[0] || bookFeed) return;
    const tokenId = bv.tokenIds[0];
    const feed = new LiveBookFeed({
      tokenId,
      tokenIndex: 0,
      tickMills: bv.tickMills,
      fetchBook: () => client.book(tokenId).catch((e: unknown) => { throw e instanceof NotFoundError ? new Error('no order book: this market is closed or not trading') : e; }),
      fetchTrades: () => client.tradesPage(bv.cid, { limit: 200 }),
      onUpdate: (st) => {
        if (token !== bookToken || !model.book) return;
        model = { ...model, book: { ...model.book, live: st } };
        paint();
      },
    });
    bookFeed = feed;
    model = { ...model, book: { ...bv, live: feed.state } };
    feed.start();
  };
  const openBook = (slug: string, cid: string) => {
    const token = ++bookToken;
    stopBookFeed();
    model = { ...model, book: emptyBook(slug, cid) };
    view = { ...view, tab: 'book', sel: 0 };
    paint();
    loadBookMeta(client, slug, cid)
      .then((bv) => {
        if (token !== bookToken) return;
        model = { ...model, book: { ...bv, ui: model.book?.ui ?? bv.ui } };
        if (!bv.error) startBookFeed(token);
        paint();
      })
      .catch((error: unknown) => {
        if (token !== bookToken) return;
        if (model.book) model = { ...model, book: { ...model.book, error: errText(error) } };
        setStatus({ message: `order book failed: ${errText(error)}` });
        paint();
      });
  };
  timers.push(setInterval(() => {
    // leave the tab: stop the socket; come back: resume (a fresh snapshot is fetched)
    if (view.tab !== 'book' && bookFeed) stopBookFeed();
    else if (view.tab === 'book' && !bookFeed && model.book && !model.book.error && model.book.tokenIds[0]) startBookFeed(bookToken);
  }, 1_000));
  const bookKey = (d: string): boolean => {
    const bv = model.book;
    if (view.tab !== 'book' || !bv) return false;
    const ui = bv.ui;
    const set = (patch: Partial<typeof ui>) => {
      model = { ...model, book: { ...bv, ui: { ...ui, ...patch } } };
      paint();
      return true;
    };
    const rows = Math.max(5, view.rows - 14);
    const scroll = (delta: number) => {
      const centre = ui.manualCenter ?? (bv.live ? autoCenter(bv.live, ui.flip, ui.group) : null);
      return set({ manualCenter: centre, scroll: ui.scroll + delta });
    };
    if (d === '+' || d === '=') return set({ group: cycle(GROUPS, ui.group, 1) === GROUPS[0] ? GROUPS[GROUPS.length - 1] : cycle(GROUPS, ui.group, 1), scroll: 0, manualCenter: null });
    if (d === '-' || d === '_') return set({ group: ui.group === GROUPS[0] ? GROUPS[0] : cycle(GROUPS, ui.group, -1), scroll: 0, manualCenter: null });
    if (d === 'm') return set({ unit: ui.unit === 'SH' ? 'USD' : 'SH' });
    if (d === 't') return set({ periodSecs: cycle(PERIODS, ui.periodSecs as (typeof PERIODS)[number], 1) });
    if (d === 's') return set({ tapeMin: cycle(TAPE_MINS, ui.tapeMin as (typeof TAPE_MINS)[number], 1) });
    if (d === 'i') return set({ flip: !ui.flip, scroll: 0, manualCenter: null });
    if (d === 'c') return set({ scroll: 0, manualCenter: null });
    if (d === `${ESC}[A` || d === 'k') return scroll(1);
    if (d === `${ESC}[B` || d === 'j') return scroll(-1);
    if (d === `${ESC}[5~`) return scroll(rows);
    if (d === `${ESC}[6~`) return scroll(-rows);
    return false;
  };
  let walletsToken = 0;
  const startWalletScan = () => {
    const token = ++walletsToken;
    const prevResult = model.newWallets?.result ?? null;
    model = { ...model, newWallets: { stage: 'starting', done: false, error: null, result: prevResult, at: null } };
    paint();
    scanNewWallets(client, store, {
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
    }).catch((error: unknown) => {
      if (token !== walletsToken) return;
      model = { ...model, newWallets: { stage: 'failed', done: true, error: errText(error), result: prevResult, at: null } };
      setStatus({ message: `new-wallet scan failed: ${errText(error)}` });
      paint();
    });
  };
  /** Esc during a scan: stop the lookups and keep the partial table. */
  const cancelWalletScan = (): boolean => {
    const nw = model.newWallets;
    if (view.tab !== 'wallets' || !nw || nw.done) return false;
    walletsToken++;
    model = { ...model, newWallets: { ...nw, stage: 'cancelled', done: true, cancelled: true, at: Date.now() } };
    setStatus({ message: 'scan cancelled: showing the wallets aged so far (w scans again)' });
    paint();
    return true;
  };
  /** `w` on the tab rescans; arriving on it (3, w, Tab) scans when there is no result yet or it is over 5 minutes old (press() starts the first scan). */
  const openWallets = () => {
    const nw = model.newWallets;
    const wasOn = view.tab === 'wallets';
    press('w');
    if (nw && nw.done && (wasOn || nw.at === null || Date.now() - nw.at > 5 * 60_000)) startWalletScan();
  };
  const openXray = (wallet: string) => {
    const token = ++xrayToken;
    model = { ...model, xray: { wallet, stage: 'starting', done: false, error: null, report: null } };
    view = { ...view, tab: 'xray', sel: 0 };
    paint();
    loadXray(client, wallet, {
      onProgress: (x) => {
        if (token !== xrayToken) return;
        model = { ...model, xray: { wallet, stage: x.stage, done: x.done, error: x.error, report: x.report } };
        paint();
      },
    }).catch((error: unknown) => {
      if (token !== xrayToken) return;
      model = { ...model, xray: { wallet, stage: 'failed', done: true, error: errText(error), report: null } };
      setStatus({ message: `x-ray failed: ${errText(error)}` });
      paint();
    });
  };
  const runSearch = (query: string) => {
    const parsed = parseWalletInput(query);
    const address = parsed && 'wallet' in parsed ? parsed.wallet : undefined; // only a whole address or a profile link counts, not any address inside pasted text
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
  // last resort: leave the alternate screen first so the error is readable, then exit non-zero
  const die = (e: unknown) => {
    bookFeed?.stop();
    restore();
    console.error(e);
    process.exit(1);
  };
  process.on('uncaughtException', die);
  process.on('unhandledRejection', die);
  out.on('resize', () => {
    view = { ...view, cols: out.columns ?? view.cols, rows: out.rows ?? view.rows };
    paint(true);
  });
  paint(true);

  const press = (key: Key) => {
    view = moveSelection(view, key, model);
    model = { ...model, oiSeries: seriesFor(store, model, view, Math.floor(Date.now() / 1000)) };
    setStatus({ message: null });
    if (view.tab === 'wallets' && !model.newWallets) return startWalletScan(); // first visit: scan right away (it paints)
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
      if (view.help) {
        // the overlay swallows everything except closing it and quitting
        if (d === '?' || d === ESC) {
          view = { ...view, help: false };
          return paint(true);
        }
        if (d === 'q' || d === '\x03') return quit();
        return;
      }
      if (d === '?') {
        view = { ...view, help: true };
        return paint(true);
      }
      if (d === ESC && cancelWalletScan()) return;
      if (d === '/') return beginSearch();
      if (d === 'w') return openWallets();
      if ((d === '\r' || d === '\n') && enterOpensDecision(view.tab)) {
        const slug = selectedSlug(model, view);
        if (!slug) {
          setStatus({ message: view.tab === 'search' ? 'press / and search first, then Enter on a result' : 'nothing selected yet' });
          return paint();
        }
        return openDecision(slug);
      }
      if ((d === '\r' || d === '\n') && view.tab === 'wallets') {
        const row = model.newWallets?.result?.rows[view.sel];
        if (!row) return;
        return openHolders(row.eventSlug, row.cid);
      }
      if (d === 'a') {
        const holder = view.tab === 'holders' ? visibleHolders(model)[view.sel] : undefined;
        const wallet = holder?.wallet ?? (view.tab === 'xray' ? model.xray?.wallet : undefined);
        if (!wallet || !isAddress(wallet)) {
          setStatus({ message: 'a follows a wallet: select a holder on tab 4 (or open an X-ray on tab 6) first' });
          return paint();
        }
        try {
          const r = addWatched(wallet, holder?.name ?? undefined);
          setStatus({ message: `${r.added ? 'following' : 'already following'} ${wallet.slice(0, 10)}… (${r.list.length} on the list): its bets are on tab 9 Following` });
          if (r.added) refreshFollow(false);
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
        poll()
          .then(() => paint())
          .catch((error: unknown) => {
            setStatus({ message: `refresh failed: ${errText(error)}` });
            paint();
          });
        paint();
        return;
      }
      if ((d === '[' || d === ']' || d === '{' || d === '}') && view.tab === 'holders' && model.holders && model.holders.markets.length > 1) {
        const next = pickMarket(model.holders.markets, model.holders.cid, d);
        return next ? openHolders(model.holders.slug, next.cid) : paint();
      }
      if (bookKey(d)) return;
      // `+` is a Book key (compress ticks) and Following has its own add box: there only n opens the prompt
      if (opensFollowPrompt(d, view.tab)) {
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
      if (d === 'b' && view.tab !== 'holders') {
        setStatus({ message: 'b shows or hides bots and market makers on tab 4 Holders' });
        return paint();
      }
      if (d === 'b') {
        showBots = !showBots;
        model = { ...model, showBots };
        view = { ...view, sel: 0 };
        setStatus({ message: showBots ? 'showing bots and market makers' : 'people only' });
        return paint();
      }
      if (d === 'f' && view.tab !== 'anomalies') {
        setStatus({ message: 'f filters tab 1 Markets by category' });
        return paint();
      }
      if (d === 'f') {
        const cats = ['', ...[...new Set(buildModel(store, Date.now()).anomalies.map((a) => a.cat).filter(Boolean))].sort()];
        filter = cats[(cats.indexOf(filter ?? '') + 1) % cats.length] || null;
        view = { ...view, sel: 0 };
        refresh();
        setStatus({ message: filter ? `category: ${filter} (f cycles)` : cats.length > 1 ? 'all categories' : 'no categories to filter yet' });
        return paint();
      }
      if (d === 'o') {
        const slug = selectedSlug(model, view);
        const holder = view.tab === 'holders' ? visibleHolders(model)[view.sel] : undefined;
        const wslug = view.tab === 'wallets' ? model.newWallets?.result?.rows[view.sel]?.eventSlug : undefined;
        const profile = view.tab === 'xray' ? model.xray?.wallet : view.tab === 'follow' ? model.follow?.cards[view.sel]?.wallet : holder?.wallet;
        const url = profile ? `https://polymarket.com/profile/${profile}` : slug || wslug ? `https://polymarket.com/event/${slug ?? wslug}` : undefined;
        // the terminal cannot open a browser: show the link to copy
        setStatus({ message: url ? `link (copy it into a browser): ${url}` : 'o shows a link: select an event, holder or wallet row first' });
        return paint();
      }
      const k = map[d];
      if (k) press(k);
    });
  }

  timers.push(setInterval(() => paint(), 1_000));
  await poll();
  paint();
  schedule();
  // The shell is event-driven: stay pending (so the caller does not close the store) until quit() exits the process.
  await new Promise<void>(() => undefined);
}
