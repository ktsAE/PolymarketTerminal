import { applyFilters, buildModel, runCycle } from '../collect.ts';
import { loadHolders } from '../holders.ts';
import type { PolymarketClient } from '../polymarket.ts';
import { httpFetchText, pollFeeds } from '../poll.ts';
import type { RadarStore } from '../store.ts';
import { listLength, moveSelection, render, visibleHolders, type Key, type Model, type View } from './render.ts';

const ESC = '\x1b';

export interface TuiOptions {
  intervalSecs?: number;
  news?: boolean;
  once?: boolean;
  cols?: number;
  rows?: number;
  tab?: View['tab'];
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
  };
}

function seriesFor(store: RadarStore, m: Model, v: View, nowSecs: number): number[] {
  const a = v.tab === 'anomalies' ? m.anomalies[v.sel] : v.tab === 'games' ? m.games[v.sel] : undefined;
  return a ? store.snapshotSeries(a.eventId, nowSecs - 86_400).map((s) => s.oi) : [];
}

/** The event the user is looking at, for actions like "load holders" or "show link". */
function selectedSlug(m: Model, v: View): string | undefined {
  return v.tab === 'anomalies' ? m.anomalies[v.sel]?.slug : v.tab === 'games' ? m.games[v.sel]?.slug : v.tab === 'prints' ? m.prints[v.sel]?.eventSlug : v.tab === 'holders' ? m.holders?.slug : undefined;
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
  const openHolders = (slug: string) => {
    const token = ++holdersToken;
    model = { ...model, holders: { slug, eventTitle: slug, question: 'loading…', cid: '', rows: [], total: 0, loaded: 0, done: false, error: null } };
    view = { ...view, tab: 'holders', sel: 0 };
    paint();
    void loadHolders(client, store, slug, {
      onProgress: (hv) => {
        if (token !== holdersToken) return;
        model = { ...model, holders: hv };
        view = { ...view, sel: Math.min(view.sel, Math.max(0, listLength(model, 'holders') - 1)) };
        paint();
      },
    });
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
        '\t': 'tab', k: 'up', j: 'down', g: 'home', G: 'end', '1': '1', '2': '2', '3': '3', '4': '4', '5': '5',
      };
      if (d === 'q' || d === '\x03') return quit();
      if (d === 'r') {
        void poll().then(() => paint());
        paint();
        return;
      }
      if (d === 'h') {
        const slug = selectedSlug(model, view);
        if (!slug) {
          setStatus({ message: 'select an event first' });
          return paint();
        }
        return openHolders(slug);
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
        const url = view.tab === 'leads' ? model.leads[view.sel]?.url : holder ? `https://polymarket.com/profile/${holder.wallet}` : slug ? `https://polymarket.com/event/${slug}` : undefined;
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
