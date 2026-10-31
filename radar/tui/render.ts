import { gamePhase, type Anomaly, type WalletTag } from '../detect.ts';
import { peopleOnly, type HolderRow, type HoldersView } from '../holders.ts';
import type { NewsRow, PrintRow } from '../store.ts';
import { c, clip, fit, sparkline, vlen } from './ansi.ts';

export type Tab = 'anomalies' | 'games' | 'prints' | 'holders' | 'leads';
export const TABS: readonly Tab[] = ['anomalies', 'games', 'prints', 'holders', 'leads'];
const TAB_LABEL: Record<Tab, string> = { anomalies: '1 Anomalies', games: '2 Games', prints: '3 Big prints', holders: '4 Holders', leads: '5 Leads' };

export interface TaggedPrint extends PrintRow {
  tag: WalletTag;
}

export interface Model {
  anomalies: Anomaly[];
  games: Anomaly[];
  prints: TaggedPrint[];
  leads: NewsRow[];
  status: {
    lastPollAt: number | null; // epoch ms
    nextPollAt: number | null;
    busy: boolean;
    error: string | null;
    events: number;
    historySecs: number;
    printsWindowMin: number | null;
    message: string | null;
  };
  /** OI series (oldest first) for the currently selected event. */
  oiSeries: readonly number[];
  /** Active category filter (null = all) and the categories available to cycle through. */
  filter: string | null;
  /** Holders of the event the user opened with `h` (null until then). */
  holders: HoldersView | null;
  /** Show bots / market makers in the holders list (default: people only). */
  showBots: boolean;
}

export interface View {
  tab: Tab;
  sel: number;
  cols: number;
  rows: number;
}

export const visibleHolders = (m: Model): HolderRow[] => (m.holders ? (m.showBots ? m.holders.rows : peopleOnly(m.holders.rows)) : []);

export const usd = (n: number | null, signed = false): string => {
  if (n === null || !Number.isFinite(n)) return '-';
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : signed && n > 0 ? '+' : '';
  const body = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : `${Math.round(a)}`;
  return `${sign}$${body}`;
};
const pct = (x: number | null, signed = true): string => (x === null ? '-' : `${signed && x > 0 ? '+' : ''}${Math.abs(x) >= 0.995 ? Math.round(x * 100) : (x * 100).toFixed(Math.abs(x) < 0.1 ? 1 : 0)}%`);
const clock = (ms: number | null): string => (ms === null ? '--:--:--' : new Date(ms).toISOString().slice(11, 19));
const dur = (secs: number): string => (secs < 90 ? `${Math.round(secs)}s` : secs < 5_400 ? `${Math.round(secs / 60)}m` : secs < 172_800 ? `${(secs / 3600).toFixed(1)}h` : `${Math.round(secs / 86_400)}d`);

const WHY: Record<string, string> = {
  oi_surge: 'OI++', oi_jump: 'OI+', oi_drain: 'OI-', oi_move_24h: 'OI24', volume_spike: 'VOL++', volume_accel: 'VOL+', turnover: 'CHURN',
  price_move_1h: 'PX1H', line_move: 'LINE', price_move_1d: 'PX1D', thin_liquidity: 'THIN', big_prints: 'FILLS', fresh_money: 'NEW$', wallet_cluster: 'CLUSTER',
};

function levelCell(a: Anomaly): string {
  const t = fit(a.level === 'HOT' ? 'HOT' : a.level === 'WATCH' ? 'WATCH' : '', 5);
  return a.level === 'HOT' ? c.red(c.bold(t)) : a.level === 'WATCH' ? c.yellow(t) : t;
}
function tagCell(kind: WalletTag['kind'], w = 5): string {
  const t = fit(kind === '?' ? '?' : kind, w);
  return kind === 'NEW' ? c.magenta(c.bold(t)) : kind === 'THIN' ? c.magenta(t) : kind === 'WHALE' ? c.cyan(t) : c.gray(t);
}
const signColor = (x: number | null, s: string): string => (x === null ? c.gray(s) : x > 0 ? c.green(s) : x < 0 ? c.red(s) : s);

interface Col {
  key: string;
  head: string;
  w: number;
  align?: 'left' | 'right';
  /** Lower number = dropped first when the terminal is narrow. */
  keep: number;
  flex?: boolean;
}

/** Chooses columns that fit `cols`, dropping the least important first; flex columns absorb leftover width. */
function layout(all: readonly Col[], cols: number): Col[] {
  const gap = 1;
  let use = [...all];
  const need = (list: Col[]) => list.reduce((a, x) => a + x.w, 0) + gap * (list.length - 1);
  while (need(use) > cols && use.length > 1) {
    const drop = [...use].filter((x) => !x.flex).sort((a, b) => a.keep - b.keep)[0];
    if (!drop) break;
    use = use.filter((x) => x !== drop);
  }
  const spare = cols - need(use);
  const flex = use.filter((x) => x.flex);
  if (spare > 0 && flex.length) flex[0] = Object.assign(flex[0], { w: flex[0].w + spare });
  return use;
}

const rowOf = (cols: readonly Col[], cells: Record<string, string>, selected: boolean): string => {
  const line = cols.map((col) => cells[col.key] ?? ' '.repeat(col.w)).join(' ');
  return selected ? c.inverse(line) : line;
};
const headOf = (cols: readonly Col[]): string => c.dim(cols.map((col) => fit(col.head, col.w, col.align)).join(' '));

export function anomalyRows(m: Model, v: View, height: number): string[] {
  const cols = layout(
    [
      { key: 'lv', head: 'LEVEL', w: 5, keep: 9 },
      { key: 'sc', head: 'SC', w: 3, align: 'right', keep: 8 },
      { key: 'ev', head: 'EVENT', w: 30, keep: 10, flex: true },
      { key: 'cat', head: 'CAT', w: 8, keep: 2 },
      { key: 'oi', head: 'OI', w: 7, align: 'right', keep: 7 },
      { key: 'doi', head: 'ΔOI', w: 17, align: 'right', keep: 6 },
      { key: 'vol', head: 'VOL24H', w: 7, align: 'right', keep: 5 },
      { key: 'acc', head: 'ACCEL', w: 6, align: 'right', keep: 3 },
      { key: 'px', head: 'Δ1H', w: 6, align: 'right', keep: 2 },
      { key: 'fill', head: 'TOP FILL', w: 14, keep: 1 },
      { key: 'why', head: 'SIGNALS', w: 22, keep: 4 },
    ],
    v.cols,
  );
  const out = [headOf(cols)];
  const start = Math.max(0, Math.min(v.sel - Math.floor((height - 1) / 2), Math.max(0, m.anomalies.length - (height - 1))));
  for (const [i, a] of m.anomalies.slice(start, start + height - 1).entries()) {
    const idx = start + i;
    const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
    const dv = a.m.dOi1h ?? a.m.dOi15m;
    const dp = a.m.dOi1h !== null ? a.m.dOi1hPct : a.m.dOi15mPct;
    const doi = dv === null ? '(history)' : `${usd(dv, true)} ${pct(dp)} ${a.m.dOi1h !== null ? '1h' : '15m'}`;
    const top = a.flow?.top ? `${usd(a.flow.top.usd)} ${a.flow.top.tag}` : '';
    out.push(
      rowOf(
        cols,
        {
          lv: levelCell(a),
          sc: c.bold(fit(String(a.score), w('sc'), 'right')),
          ev: fit(a.title, w('ev')),
          cat: c.gray(fit(a.cat, w('cat'))),
          oi: fit(usd(a.m.oi), w('oi'), 'right'),
          doi: signColor(dv, fit(doi, w('doi'), 'right')),
          vol: fit(usd(a.m.vol24), w('vol'), 'right'),
          acc: a.m.accel === null || a.isGame ? c.gray(fit('-', w('acc'), 'right')) : a.m.accel >= 3 ? c.yellow(fit(`${a.m.accel.toFixed(1)}x`, w('acc'), 'right')) : fit(`${a.m.accel.toFixed(1)}x`, w('acc'), 'right'),
          px: signColor(a.m.ch1h, fit(a.m.ch1h === null ? '-' : pct(a.m.ch1h), w('px'), 'right')),
          fill: fit(top, w('fill')),
          why: c.cyan(fit(a.reasons.map((r) => WHY[r.code] ?? r.code).join(' '), w('why'))),
        },
        idx === v.sel,
      ),
    );
  }
  if (m.anomalies.length === 0) out.push(c.gray('  no anomalies yet; the first poll is loading or nothing is unusual'));
  return out;
}


const startLabel = (startsAt: number | null, nowSecs: number): string => {
  const phase = gamePhase(startsAt, nowSecs);
  if (startsAt === null || phase === 'UNKNOWN') return '?';
  return phase === 'PRE' ? `in ${dur(startsAt - nowSecs)}` : `LIVE ${dur(nowSecs - startsAt)}`;
};

export function gameRows(m: Model, v: View, height: number): string[] {
  const cols = layout(
    [
      { key: 'lv', head: 'LEVEL', w: 5, keep: 9 },
      { key: 'st', head: 'STARTS', w: 10, keep: 10 },
      { key: 'ev', head: 'GAME', w: 30, keep: 10, flex: true },
      { key: 'oi', head: 'OI', w: 7, align: 'right', keep: 6 },
      { key: 'doi', head: 'ΔOI', w: 17, align: 'right', keep: 7 },
      { key: 'vol', head: 'VOL24H', w: 7, align: 'right', keep: 5 },
      { key: 'px', head: 'PRICE', w: 5, align: 'right', keep: 4 },
      { key: 'dpx', head: 'Δ30M', w: 6, align: 'right', keep: 3 },
      { key: 'fill', head: 'TOP FILL', w: 14, keep: 2 },
      { key: 'why', head: 'SIGNALS', w: 18, keep: 8 },
    ],
    v.cols,
  );
  const out = [headOf(cols)];
  const nowSecs = Date.now() / 1000;
  const start = Math.max(0, Math.min(v.sel - Math.floor((height - 1) / 2), Math.max(0, m.games.length - (height - 1))));
  for (const [i, a] of m.games.slice(start, start + height - 1).entries()) {
    const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
    const dv = a.m.dOi1h ?? a.m.dOi15m;
    const dp = a.m.dOi1h !== null ? a.m.dOi1hPct : a.m.dOi15mPct;
    const doi = dv === null ? '(history)' : `${usd(dv, true)} ${pct(dp)} ${a.m.dOi1h !== null ? '1h' : '15m'}`;
    const live = gamePhase(a.startsAt, nowSecs) === 'LIVE';
    out.push(
      rowOf(
        cols,
        {
          lv: levelCell(a),
          st: live ? c.green(fit(startLabel(a.startsAt, nowSecs), w('st'))) : fit(startLabel(a.startsAt, nowSecs), w('st')),
          ev: fit(a.title, w('ev')),
          oi: fit(usd(a.m.oi), w('oi'), 'right'),
          doi: signColor(dv, fit(doi, w('doi'), 'right')),
          vol: fit(usd(a.m.vol24), w('vol'), 'right'),
          px: fit(a.m.price === null ? '-' : a.m.price.toFixed(2), w('px'), 'right'),
          dpx: signColor(a.m.dPrice30m, fit(a.m.dPrice30m === null ? '-' : `${a.m.dPrice30m >= 0 ? '+' : ''}${(a.m.dPrice30m * 100).toFixed(0)}pt`, w('dpx'), 'right')),
          fill: fit(a.flow?.top ? `${usd(a.flow.top.usd)} ${a.flow.top.tag}` : '', w('fill')),
          why: c.cyan(fit(a.reasons.map((r) => WHY[r.code] ?? r.code).join(' '), w('why'))),
        },
        start + i === v.sel,
      ),
    );
  }
  if (m.games.length === 0) out.push(c.gray('  no games starting in the next 24h or live right now in the top events'));
  return out;
}

const classCell = (cls: HolderRow['cls'], w: number): string => {
  const t = fit(cls === 'LOW_DATA' ? 'NEW?' : cls, w);
  return cls === 'HUMAN' ? c.green(c.bold(t)) : cls === 'LOW_DATA' ? c.green(t) : cls === 'ALGO' ? c.yellow(t) : c.red(t);
};

export function holderRows(m: Model, v: View, height: number): string[] {
  const h = m.holders;
  if (!h) return [c.gray('  select an event on Anomalies, Games or Big prints and press h to load its top holders')];
  const rows = visibleHolders(m);
  const hidden = h.rows.length - peopleOnly(h.rows).length;
  const status = h.done ? (h.error ? c.red(`  error: ${h.error}`) : '') : c.yellow(`  profiling ${h.loaded}/${h.total}…`);
  const out = [clip(`${c.bold(h.question || h.eventTitle)}${status}${hidden > 0 ? c.gray(m.showBots ? `  (showing ${hidden} bots/market makers too, b hides)` : `  ${hidden} bots/market makers hidden (b shows)`) : ''}`, v.cols)];
  const cols = layout(
    [
      { key: 'cls', head: 'WHO', w: 5, keep: 10 },
      { key: 'out', head: 'SIDE', w: 8, keep: 9 },
      { key: 'pos', head: 'POSITION', w: 9, align: 'right', keep: 8 },
      { key: 'avg', head: 'AVG', w: 5, align: 'right', keep: 6 },
      { key: 'up', head: 'uPNL', w: 8, align: 'right', keep: 7 },
      { key: 'all', head: 'ALL-TIME', w: 9, align: 'right', keep: 5 },
      { key: 'wk', head: '7D', w: 8, align: 'right', keep: 3 },
      { key: 'mk', head: 'MKTS', w: 6, align: 'right', keep: 2 },
      { key: 'pd', head: '/DAY', w: 5, align: 'right', keep: 1 },
      { key: 'name', head: 'NAME', w: 20, keep: 9, flex: true },
    ],
    v.cols,
  );
  out.push(headOf(cols));
  const room = Math.max(1, height - 2);
  const start = Math.max(0, Math.min(v.sel - Math.floor(room / 2), Math.max(0, rows.length - room)));
  for (const [i, r] of rows.slice(start, start + room).entries()) {
    const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
    out.push(
      rowOf(
        cols,
        {
          cls: classCell(r.cls, w('cls')),
          out: fit(r.outcome, w('out')),
          pos: c.bold(fit(r.posUsd === null ? '-' : usd(r.posUsd), w('pos'), 'right')),
          avg: fit(r.avgPrice === null ? '-' : r.avgPrice.toFixed(2), w('avg'), 'right'),
          up: signColor(r.uPnl, fit(r.uPnl === null ? '-' : usd(r.uPnl, true), w('up'), 'right')),
          all: signColor(r.pnlAll, fit(r.pnlAll === null ? '-' : usd(r.pnlAll, true), w('all'), 'right')),
          wk: signColor(r.pnlWeek, fit(r.pnlWeek === null ? '-' : usd(r.pnlWeek, true), w('wk'), 'right')),
          mk: fit(r.traded === null ? '-' : String(r.traded), w('mk'), 'right'),
          pd: fit(r.perDay === null ? '-' : String(Math.round(r.perDay)), w('pd'), 'right'),
          name: fit(`${r.flags.length ? '! ' : ''}${r.name ?? r.wallet.slice(0, 10)}`, w('name')),
        },
        start + i === v.sel,
      ),
    );
  }
  if (rows.length === 0 && h.done) out.push(c.gray(hidden > 0 ? '  only bots/market makers hold this market; press b to see them' : '  no holders found'));
  return out;
}

export function printRows(m: Model, v: View, height: number): string[] {
  const cols = layout(
    [
      { key: 'age', head: 'AGO', w: 5, align: 'right', keep: 8 },
      { key: 'usd', head: 'USD', w: 7, align: 'right', keep: 10 },
      { key: 'side', head: 'SIDE', w: 4, keep: 7 },
      { key: 'out', head: 'OUTCOME', w: 12, keep: 4 },
      { key: 'px', head: 'PRICE', w: 5, align: 'right', keep: 3 },
      { key: 'ev', head: 'MARKET', w: 30, keep: 9, flex: true },
      { key: 'tag', head: 'WALLET', w: 5, keep: 6 },
      { key: 'wa', head: 'AGE', w: 6, align: 'right', keep: 2 },
      { key: 'wm', head: 'MKTS', w: 6, align: 'right', keep: 1 },
      { key: 'addr', head: 'ADDRESS', w: 11, keep: 5 },
    ],
    v.cols,
  );
  const out = [headOf(cols)];
  const now = Date.now() / 1000;
  const start = Math.max(0, Math.min(v.sel - Math.floor((height - 1) / 2), Math.max(0, m.prints.length - (height - 1))));
  for (const [i, p] of m.prints.slice(start, start + height - 1).entries()) {
    const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
    out.push(
      rowOf(
        cols,
        {
          age: c.gray(fit(dur(Math.max(0, now - p.ts)), w('age'), 'right')),
          usd: c.bold(fit(usd(p.usd), w('usd'), 'right')),
          side: p.side === 'BUY' ? c.green(fit('BUY', w('side'))) : c.red(fit('SELL', w('side'))),
          out: fit(p.outcome ?? '', w('out')),
          px: fit(p.price.toFixed(2), w('px'), 'right'),
          ev: fit(p.title, w('ev')),
          tag: tagCell(p.tag.kind, w('tag')),
          wa: fit(p.tag.ageDays === null ? '-' : p.tag.ageDays < 1 ? '<1d' : `${Math.round(p.tag.ageDays)}d`, w('wa'), 'right'),
          wm: fit(p.tag.traded === null ? '-' : String(p.tag.traded), w('wm'), 'right'),
          addr: c.gray(fit(`${p.wallet.slice(0, 6)}…${p.wallet.slice(-4)}`, w('addr'))),
        },
        start + i === v.sel,
      ),
    );
  }
  if (m.prints.length === 0) out.push(c.gray('  no large fills captured yet'));
  return out;
}

export function leadRows(m: Model, v: View, height: number): string[] {
  const cols = layout(
    [
      { key: 'date', head: 'DATE', w: 10, keep: 5 },
      { key: 'hint', head: 'SUGGESTS', w: 13, keep: 6 },
      { key: 'src', head: 'SOURCE', w: 10, keep: 3 },
      { key: 'cat', head: 'TYPE', w: 13, keep: 2 },
      { key: 'title', head: 'HEADLINE', w: 40, keep: 9, flex: true },
    ],
    v.cols,
  );
  const out = [headOf(cols)];
  const start = Math.max(0, Math.min(v.sel - Math.floor((height - 1) / 2), Math.max(0, m.leads.length - (height - 1))));
  for (const [i, n] of m.leads.slice(start, start + height - 1).entries()) {
    const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
    const hint = n.tierHint ?? '';
    out.push(
      rowOf(
        cols,
        {
          date: c.gray(fit(n.publishedAt ? new Date(n.publishedAt).toISOString().slice(0, 10) : 'undated', w('date'))),
          hint: hint === 'SANCTIONED' ? c.red(c.bold(fit(hint, w('hint')))) : hint === 'INVESTIGATING' ? c.yellow(fit(hint, w('hint'))) : c.gray(fit(hint || 'review', w('hint'))),
          src: fit(n.feedId, w('src')),
          cat: c.cyan(fit(n.category, w('cat'))),
          title: fit(n.title, w('title')),
        },
        start + i === v.sel,
      ),
    );
  }
  if (m.leads.length === 0) out.push(c.gray('  inbox empty: run "news poll" or wait for the background poll'));
  return out;
}

export function detailLines(m: Model, v: View, width: number): string[] {
  const line = (s: string) => clip(s, width);
  if (v.tab === 'anomalies') {
    const a = m.anomalies[v.sel];
    if (!a) return [];
    const out = [line(`${c.bold(a.title)}  ${c.gray(`polymarket.com/event/${a.slug}`)}`)];
    for (const r of a.reasons) out.push(line(`  ${c.cyan(`+${r.points}`.padStart(3))} ${r.text}`));
    for (const n of a.notes) out.push(line(`  ${c.gray(n)}`));
    const spark = sparkline(m.oiSeries, Math.min(40, width - 30));
    out.push(line(`  OI ${usd(a.m.oi)}  24h Δ ${a.m.dOi24h === null ? c.gray('(history)') : `${usd(a.m.dOi24h, true)} ${pct(a.m.dOi24hPct)}`}  liq ${usd(a.m.liq)}  price ${a.m.price === null ? '-' : a.m.price.toFixed(2)}  ${spark ? c.cyan(spark) : ''}`));
    return out;
  }
  if (v.tab === 'games') {
    const a = m.games[v.sel];
    if (!a) return [];
    const nowSecs = Date.now() / 1000;
    const out = [line(`${c.bold(a.title)}  ${c.gray(`polymarket.com/event/${a.slug}`)}  ${c.gray(startLabel(a.startsAt, nowSecs))}`)];
    for (const r of a.reasons) out.push(line(`  ${c.cyan(`+${r.points}`.padStart(3))} ${r.text}`));
    if (a.reasons.length === 0) out.push(line(c.gray('  nothing unusual yet')));
    for (const n of a.notes) out.push(line(`  ${c.gray(n)}`));
    out.push(line(`  OI ${usd(a.m.oi)}  liq ${usd(a.m.liq)}  price ${a.m.price === null ? '-' : a.m.price.toFixed(2)}  ${m.oiSeries.length ? c.cyan(sparkline(m.oiSeries, Math.min(40, width - 40))) : ''}`));
    return out;
  }
  if (v.tab === 'holders') {
    const r = visibleHolders(m)[v.sel];
    if (!r) return [];
    const out = [line(`${c.bold(r.name ?? r.wallet)}  ${c.gray(`polymarket.com/profile/${r.wallet}`)}`)];
    out.push(line(`  ${r.cls} (${r.confidence} confidence): ${r.reasons.join('; ') || 'no automation signs'}`));
    out.push(line(`  holds ${Math.round(r.shares).toLocaleString('en-US')} sh of ${r.outcome}${r.avgPrice !== null ? ` bought at avg ${r.avgPrice.toFixed(3)}` : ''}${r.curPrice !== null ? `, now ${r.curPrice.toFixed(3)}` : ''}; lifetime volume ${r.vol === null ? '-' : usd(r.vol)}, account ${r.ageDays === null ? '?' : `${Math.round(r.ageDays)}d`} old`));
    for (const f of r.flags) out.push(line(`  ${c.yellow('!')} ${f}`));
    out.push(line(c.gray('  Classification is a screen from activity patterns, not an identification. PnL is Polymarket\'s own all-time/7-day figure.')));
    return out;
  }
  if (v.tab === 'prints') {
    const p = m.prints[v.sel];
    if (!p) return [];
    return [
      line(`${c.bold(p.title)}  ${c.gray(`polymarket.com/event/${p.eventSlug}`)}`),
      line(`  ${p.side} ${p.outcome ?? ''} @ ${p.price.toFixed(3)}  size ${Math.round(p.size).toLocaleString('en-US')} sh = ${usd(p.usd)}${p.name ? `  as "${p.name}"` : ''}`),
      line(`  wallet ${p.wallet}  [${p.tag.kind}] first seen ${p.tag.ageDays === null ? 'unknown' : `${p.tag.ageDays.toFixed(0)} days before this fill`}, ${p.tag.traded ?? '?'} markets traded`),
      line(c.gray('  A wallet tag describes history, not intent. NEW/THIN = little history; WHALE = 200+ markets.')),
    ];
  }
  const n = m.leads[v.sel];
  if (!n) return [];
  const out = [line(c.bold(n.title)), line(`  ${c.gray(n.url)}`)];
  if (n.summary) out.push(line(`  ${n.summary.slice(0, Math.max(20, width * 2 - 4))}`));
  if (n.note) out.push(line(`  ${c.yellow('->')} ${n.note}`));
  return out;
}

export function render(m: Model, v: View, nowMs: number): string[] {
  const { cols, rows } = v;
  const s = m.status;
  const live = s.error ? c.red('● error') : s.busy ? c.yellow('● polling') : c.green('● live');
  const next = s.nextPollAt === null ? '--' : dur(Math.max(0, (s.nextPollAt - nowMs) / 1000));
  const hist = m.status.historySecs < 120 ? c.yellow('collecting') : dur(m.status.historySecs);
  const header = clip(
    `${c.bold(c.cyan(' POLYRADAR '))} ${live}  polled ${clock(s.lastPollAt)}  next ${next}  events ${s.events}  history ${hist}  fills ${m.prints.length}${s.printsWindowMin ? ` (${s.printsWindowMin}m)` : ''}${s.error ? `  ${c.red(s.error.slice(0, 60))}` : ''}`,
    cols,
  );
  const tabs = clip(
    ' ' + TABS.map((t) => (t === v.tab ? c.inverse(` ${TAB_LABEL[t]} `) : c.gray(` ${TAB_LABEL[t]} `))).join(' ') + c.gray(`   ${[...m.anomalies, ...m.games].filter((a) => a.level === 'HOT').length} hot · ${[...m.anomalies, ...m.games].filter((a) => a.level === 'WATCH').length} watch`) + (m.filter ? c.yellow(`   filter: ${m.filter}`) : ''),
    cols,
  );
  const detailH = rows >= 30 ? 8 : 0;
  const bodyH = Math.max(3, rows - 3 - detailH - (detailH ? 1 : 0));
  const body = (v.tab === 'anomalies' ? anomalyRows(m, v, bodyH) : v.tab === 'games' ? gameRows(m, v, bodyH) : v.tab === 'prints' ? printRows(m, v, bodyH) : v.tab === 'holders' ? holderRows(m, v, bodyH) : leadRows(m, v, bodyH)).map((l) => clip(l, cols));
  const lines = [header, tabs, ...body];
  while (lines.length < 2 + bodyH) lines.push('');
  if (detailH) {
    lines.push(c.gray('─'.repeat(cols)));
    const d = detailLines(m, v, cols - 1);
    for (let i = 0; i < detailH; i++) lines.push(d[i] ?? '');
  }
  while (lines.length < rows - 1) lines.push('');
  const msg = s.message ? `  ${c.yellow(s.message)}` : '';
  lines.push(clip(c.gray(' ↑↓ move · 1-5 tabs · r refresh · f category · h holders · b people/bots · o link · q quit') + msg, cols));
  return lines.slice(0, rows).map((l) => (vlen(l) > cols ? clip(l, cols) : l));
}

export type Key = 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end' | 'tab' | '1' | '2' | '3' | '4' | '5';
export function listLength(m: Model, tab: Tab): number {
  return tab === 'anomalies' ? m.anomalies.length : tab === 'games' ? m.games.length : tab === 'prints' ? m.prints.length : tab === 'holders' ? visibleHolders(m).length : m.leads.length;
}

/** Pure keyboard reducer; the shell only translates raw input into these keys. */
export function moveSelection(v: View, key: Key, m: Model): View {
  const n = listLength(m, v.tab);
  const page = Math.max(1, v.rows - 12);
  switch (key) {
    case 'up': return { ...v, sel: Math.max(0, v.sel - 1) };
    case 'down': return { ...v, sel: Math.min(Math.max(0, n - 1), v.sel + 1) };
    case 'pageup': return { ...v, sel: Math.max(0, v.sel - page) };
    case 'pagedown': return { ...v, sel: Math.min(Math.max(0, n - 1), v.sel + page) };
    case 'home': return { ...v, sel: 0 };
    case 'end': return { ...v, sel: Math.max(0, n - 1) };
    case 'tab': return { ...v, tab: TABS[(TABS.indexOf(v.tab) + 1) % TABS.length], sel: 0 };
    case '1': return { ...v, tab: 'anomalies', sel: 0 };
    case '2': return { ...v, tab: 'games', sel: 0 };
    case '3': return { ...v, tab: 'prints', sel: 0 };
    case '4': return { ...v, tab: 'holders', sel: 0 };
    case '5': return { ...v, tab: 'leads', sel: 0 };
  }
}
