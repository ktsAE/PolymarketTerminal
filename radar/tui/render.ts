import type { DecisionView } from '../decide-data.ts';
import { gamePhase, type Anomaly, type WalletTag } from '../detect.ts';
import type { Action, MarketDecision } from '../decide.ts';
import { formatClassFlow } from '../classflow.ts';
import { CLUSTER_CAVEAT, findClusters, formatCluster } from '../clusters.ts';
import { formatInfo } from '../marketinfo.ts';
import { costLines, formatCost } from '../cost.ts';
import { coverageNote, isSmallSample, liftText, NEWBIES_CAVEAT, SMALL_SAMPLE_NOTE, summarizeScan, usdShort, type NewWalletsResult } from '../newwallets.ts';
import type { FollowCard, FollowView } from '../following.ts';
import { costSummary, toBook, type BookView } from '../bookview.ts';
import { buildDom, tapeOf } from '../dom.ts';
import { formatXray, type XrayReport } from '../xray.ts';
import { peopleOnly, type HolderRow, type HoldersView } from '../holders.ts';
import { accountAge, dateOf } from '../identity.ts';
import type { NewsRow, PrintRow } from '../store.ts';
import { c, clip, fit, sanitizeDeep, sparkline, vlen } from './ansi.ts';

export type Tab = 'anomalies' | 'games' | 'holders' | 'decision' | 'search' | 'xray' | 'wallets' | 'book' | 'follow';
/** The tools that stay: the home list, games, the new-wallets screener, holders, the decision page, wallet X-ray and search. The removed experiments (news, edges, jumps, new markets, ledger) live on as CLI commands. */
export const TABS: readonly Tab[] = ['anomalies', 'games', 'wallets', 'holders', 'decision', 'xray', 'search', 'book', 'follow'];
export const LABS: readonly Tab[] = [];
export const MAIN_TABS: readonly Tab[] = TABS;
const TAB_LABEL: Record<Tab, string> = { anomalies: '1 Markets', games: '2 Games', wallets: '3 Newbies', holders: '4 Holders', decision: '5 Decision', xray: '6 X-ray', search: '7 Search', book: '8 Book', follow: '9 Following' };

export interface TaggedPrint extends PrintRow {
  tag: WalletTag;
}

export interface Model {
  anomalies: Anomaly[];
  games: Anomaly[];
  prints: TaggedPrint[];
  /** Still produced by collect.buildModel; no tab shows it (drop with that function's Pick). */
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
  /** Decision for the event the user opened with `p` (null until then). */
  decision?: DecisionView | null;
  /** When that decision finished loading (epoch ms). */
  decisionAt?: number | null;
  /** Search tab: the query (being typed when `typing`), its results and state. */
  search?: SearchState | null;
  /** X-ray tab: the record of one wallet (null until `x` on a holder, or a 0x address searched with `/`). */
  xray?: XrayView | null;
  /** New wallets tab: markets ranked by the money new accounts put in (null until `w`). */
  newWallets?: NewWalletsView | null;
  /** Book tab: live order book of one market (null until `8`). */
  book?: BookView | null;
  /** Following tab: the wallets you follow, with what they bet and hold. */
  follow?: FollowView | null;
}

export interface SearchHit {
  slug: string;
  title: string;
  volume: number;
  closed: boolean;
}
export interface XrayView {
  wallet: string;
  stage: string;
  done: boolean;
  error: string | null;
  report: XrayReport | null;
}

export interface SearchState {
  query: string;
  typing: boolean;
  loading: boolean;
  error: string | null;
  results: SearchHit[];
}

export interface View {
  tab: Tab;
  sel: number;
  cols: number;
  rows: number;
  /** The `?` key-map overlay is open. */
  help?: boolean;
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
/** Local HH:MM for the "as of" markers. */
const hhmm = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB').slice(0, 5);
const asOf = (ms: number | null | undefined): string => (ms ? `  as of ${hhmm(ms)}` : '');
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

/** Profile creation date; accounts under 30 days old stand out. */
const createdCell = (createdAt: number | null | undefined, nowSecs: number, w: number): string => {
  if (createdAt === null || createdAt === undefined) return c.gray(fit('?', w));
  const a = accountAge(createdAt, nowSecs);
  return a.isNew ? c.magenta(c.bold(fit(dateOf(createdAt), w))) : fit(dateOf(createdAt), w);
};

const classCell = (cls: HolderRow['cls'], w: number): string => {
  const t = fit(cls === 'LOW_DATA' ? 'NEW?' : cls, w);
  return cls === 'HUMAN' ? c.green(c.bold(t)) : cls === 'LOW_DATA' ? c.green(t) : cls === 'ALGO' ? c.yellow(t) : c.red(t);
};

/** Wallet names stay off rows that carry a NEW / flag / name-match label: the address is shown there, the name only on the wallet's own card. */
const labelled = (r: { flags: readonly string[]; matches?: readonly unknown[]; createdAt?: number | null }, nowSecs: number): boolean =>
  r.flags.length > 0 || (r.matches?.length ?? 0) > 0 || accountAge(r.createdAt ?? null, nowSecs).isNew;
export const HOLDERS_CAVEAT = 'labels (NEW, !, ≈) are screens from public data, not findings about a person: new accounts and shared names are common';

export function holderRows(m: Model, v: View, height: number): string[] {
  const h = m.holders;
  if (!h) return [c.gray('  select an event on Markets or Games and press h to load its top holders')];
  const rows = visibleHolders(m);
  const hidden = h.rows.length - peopleOnly(h.rows).length;
  const status = h.done ? (h.error ? c.red(`  error: ${h.error}`) : '') : c.yellow(`  profiling ${h.loaded}/${h.total}…`);
  const mi = h.markets.findIndex((x) => x.cid === h.cid);
  const picker = h.markets.length > 1 ? c.gray(`  market ${mi + 1}/${h.markets.length}${h.markets[mi]?.marketType ? ` · ${h.markets[mi].marketType}` : ''} ([ ] step · { } type)`) : '';
  const out = [clip(`${c.bold(h.question || h.eventTitle)}${picker}${status}${hidden > 0 ? c.gray(m.showBots ? `  (showing ${hidden} bots/market makers too, b hides)` : `  ${hidden} bots/market makers hidden (b shows)`) : ''}`, v.cols)];
  const clusters = findClusters(h.rows, Date.now() / 1000);
  const infoLines = h.info && height >= 14 ? formatInfo(h.info, h.flow?.yesLabel ?? 'Yes', Date.now() / 1000, Math.max(40, v.cols - 10)).slice(0, height >= 22 ? 2 : 1) : [];
  for (const l of infoLines) out.push(clip(` ${c.gray(l)}`, v.cols));
  if (clusters.length && height >= 16) out.push(clip(` ${c.magenta(c.bold('CLUSTER'))} ${c.magenta(formatCluster(clusters[0]))}${clusters.length > 1 ? c.gray(`  (+${clusters.length - 1} more)`) : ''}`, v.cols));
  // the caveat is on screen at every height: wallet names and the NEW / cluster / name-match labels never appear without it
  out.push(clip(` ${c.gray(clusters.length ? CLUSTER_CAVEAT : HOLDERS_CAVEAT)}`, v.cols));
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
      { key: 'cr', head: 'CREATED', w: 10, keep: 8 },
      { key: 'pd', head: '/DAY', w: 5, align: 'right', keep: 1 },
      { key: 'name', head: 'NAME', w: 20, keep: 9, flex: true },
    ],
    v.cols,
  );
  out.push(headOf(cols));
  const nowSecs = Date.now() / 1000;
  const flowLines = h.flow && height >= 19 + infoLines.length + (clusters.length ? 1 : 0) ? formatClassFlow(h.flow.data, h.flow.yesLabel, h.flow.noLabel).slice(0, 8) : [];
  const room = Math.max(1, height - 2 - infoLines.length - (clusters.length && height >= 16 ? 1 : 0) - 1 - (flowLines.length ? flowLines.length + 1 : 0));
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
          cr: createdCell(r.createdAt, nowSecs, w('cr')),
          pd: fit(r.perDay === null ? '-' : String(Math.round(r.perDay)), w('pd'), 'right'),
          name: (r.matches?.length ? c.yellow : (s: string) => s)(fit(`${r.flags.length ? '! ' : ''}${r.matches?.length ? '≈ ' : ''}${labelled(r, nowSecs) ? r.wallet.slice(0, 10) : (r.name ?? r.wallet.slice(0, 10))}`, w('name'))),
        },
        start + i === v.sel,
      ),
    );
  }
  if (rows.length === 0 && h.done) out.push(c.gray(hidden > 0 ? '  only bots/market makers hold this market; press b to see them' : '  no holders found'));
  if (flowLines.length) {
    while (out.length < height - flowLines.length) out.push('');
    flowLines.forEach((l, i) => out.push(clip(` ${i === 0 ? c.bold(l) : i === flowLines.length - 1 ? c.gray(l) : l}`, v.cols)));
  }
  return out;
}

/** Greedy word wrap of plain text. */
function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out.length ? out : [''];
}

/** Model verdicts worded as estimates, not orders: the decide module's BUY/ARB are the model's lean, not an instruction. */
export const actionWord = (a: Action): string => (a === 'BUY YES' ? 'leans YES' : a === 'BUY NO' ? 'leans NO' : a === 'ARB' ? 'ARB (est.)' : a);
export const DECISION_DISCLAIMER = 'model estimate, not advice: edges come from a model and can be wrong; fees, slippage and your own limits are not included';

function actionCell(d: MarketDecision, w: number): string {
  const label = d.action === 'BUY YES' || d.action === 'BUY NO' ? `LEANS ${d.outcomes[d.side ?? 0] ?? d.action.slice(4)}`.toUpperCase() : d.action === 'ARB' ? 'ARB (est.)' : d.action;
  const t = fit(label, w);
  return d.action === 'ARB' || d.action === 'BUY YES' || d.action === 'BUY NO' ? c.green(c.bold(t)) : d.action === 'WATCH' ? c.yellow(t) : c.gray(t);
}
const actionColor = (a: Action, s: string): string => (a === 'ARB' || a === 'BUY YES' || a === 'BUY NO' ? c.green(c.bold(s)) : a === 'WATCH' ? c.yellow(s) : c.gray(s));
const px2 = (x: number | null): string => (x === null ? '-' : x.toFixed(2));

export function decisionRows(m: Model, v: View, height: number): string[] {
  const dv = m.decision;
  if (!dv) return [c.gray('  select an event on Markets, Games or Holders and press p to see the model estimate for it')];
  const busy = dv.done ? (dv.error ? c.red(`  ${dv.error}`) : '') : c.yellow(`  ${dv.stage}${dv.progress.total ? ` ${dv.progress.loaded}/${dv.progress.total}` : ''}…`);
  const out = [clip(`${c.bold(dv.title)}${dv.done && !dv.error ? c.gray(asOf(m.decisionAt)) : ''}${busy}`, v.cols)];
  const d = dv.decision;
  if (!d) return out;
  out.push(clip(`  ${c.bold(d.headline)}  ${c.gray(`${d.version}, edges are model/structure based, never from following wallets`)}`, v.cols));
  out.push(clip(`  ${c.yellow(DECISION_DISCLAIMER)}`, v.cols));
  const cols = layout(
    [
      { key: 'act', head: 'ACTION', w: 9, keep: 10 },
      { key: 'mk', head: 'MARKET', w: 22, keep: 9, flex: true },
      { key: 'q', head: 'BID/ASK', w: 9, keep: 8 },
      { key: 'fair', head: 'MODEL', w: 7, keep: 5 },
      { key: 'edge', head: 'EST.EDGE', w: 8, align: 'right', keep: 7 },
      { key: 'cap', head: 'DEPTH', w: 6, align: 'right', keep: 4 },
      { key: 'fl', head: '1H FLOW 1st/2nd', w: 15, keep: 3 },
      { key: 'ld', head: 'LEADS', w: 6, keep: 6 },
    ],
    v.cols,
  );
  out.push(headOf(cols));
  const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
  d.markets.forEach((x, i) => {
    const nNew = x.leads.filter((l) => l.kind === 'NEW').length;
    const nMatch = x.leads.filter((l) => l.kind === 'MATCH').length;
    out.push(
      rowOf(
        cols,
        {
          act: actionCell(x, w('act')),
          mk: fit(x.label, w('mk')),
          q: fit(`${px2(x.yesBid)}/${px2(x.yesAsk)}`, w('q')),
          fair: fit(x.fair ? `${(x.fair.lo * 100).toFixed(0)}-${(x.fair.hi * 100).toFixed(0)}%` : '-', w('fair')),
          edge: x.edgePts === null ? c.gray(fit('-', w('edge'), 'right')) : c.green(fit(`~+${x.edgePts.toFixed(0)}pt`, w('edge'), 'right')),
          cap: fit(x.capacityUsd === null ? '-' : usd(x.capacityUsd), w('cap'), 'right'),
          fl: fit(x.flow1h ? `${usd(x.flow1h.first)}/${usd(x.flow1h.second)}` : '-', w('fl')),
          ld: nMatch ? c.yellow(fit(`${nMatch}≈${nNew ? ` ${nNew}N` : ''}`, w('ld'))) : nNew ? c.magenta(fit(`${nNew}N`, w('ld'))) : fit('', w('ld')),
        },
        i === v.sel,
      ),
    );
  });
  const sel = d.markets[Math.min(v.sel, d.markets.length - 1)];
  const width = Math.max(30, v.cols - 12);
  const room = () => height - out.length;
  const block = (tag: string, items: readonly string[], color: (s: string) => string = (s) => s) => {
    for (const item of items) {
      for (const [i, line] of wrap(item, width).entries()) {
        if (room() <= 0) return;
        out.push(clip(`  ${i === 0 ? c.dim(tag.padEnd(7)) : ' '.repeat(7)}${color(line)}`, v.cols));
      }
    }
  };
  if (sel && room() > 2) {
    out.push(clip(`${c.dim('─'.repeat(2))} ${c.bold(sel.label)}  ${actionColor(sel.action, actionWord(sel.action))}${sel.edgePts !== null ? c.green(`  est. +${sel.edgePts.toFixed(1)} points`) : ''}  confidence ${sel.confidence}${sel.capacityUsd !== null ? `  room for ~${usd(sel.capacityUsd)} near that price` : ''}`, v.cols));
    block('WHY', sel.reasons);
    block('LEADS', sel.leads.map((l) => `${l.kind === 'MATCH' ? '≈' : 'NEW'} ${l.text}`), c.yellow);
    block('FLOW', sel.context, c.gray);
    block('RISK', sel.risks, c.gray);
    block('CHECK', sel.invalidates, c.gray);
    const book = dv.books?.[sel.cid];
    if (book && dv.fee && room() > 3) {
      block('COST', [`taker fee rate ${(dv.fee.rate * 100).toFixed(0)}% (${dv.fee.category}, estimated from the event's tags; resting orders pay none): fee = shares x rate x p x (1-p)`], c.gray);
      for (const usdSize of [50, 500]) block('', costLines(book, usdSize, dv.fee.rate).map(formatCost));
    }
    const ws = dv.wallets[sel.cid] ?? [];
    if (ws.length && room() > 3) {
      out.push(clip(c.dim(`  ${'WHO'.padEnd(5)} ${'SIDE'.padEnd(8)} ${'POSITION'.padStart(8)} ${'CREATED'.padEnd(10)} ${'MKTS'.padStart(5)} ${'X HANDLE'.padEnd(16)} NAME`), v.cols));
      const nowSecs = Date.now() / 1000;
      for (const x of ws) {
        if (room() <= 0) break;
        const age = accountAge(x.createdAt, nowSecs);
        const created = x.createdAt === null ? c.gray('?'.padEnd(10)) : age.isNew ? c.magenta(c.bold(dateOf(x.createdAt).padEnd(10))) : dateOf(x.createdAt).padEnd(10);
        out.push(clip(`  ${(x.cls === 'LOW_DATA' ? 'NEW?' : x.cls).padEnd(5)} ${(x.side === null ? '?' : (sel.outcomes[x.side] ?? '?')).slice(0, 8).padEnd(8)} ${(x.posUsd === null ? '-' : usd(x.posUsd)).padStart(8)} ${created} ${String(x.traded ?? '-').padStart(5)} ${(x.xUsername ? `@${x.xUsername}` : '').slice(0, 16).padEnd(16)} ${x.matches.length ? c.yellow('≈ ') : ''}${x.matches.length || accountAge(x.createdAt, nowSecs).isNew ? x.wallet.slice(0, 10) : (x.name ?? x.wallet.slice(0, 10))}`, v.cols));
      }
    }
    if (room() > 1) block('NOTE', d.notes, c.gray);
  }
  return out;
}

export function searchRows(m: Model, v: View, height: number): string[] {
  const s = m.search;
  const prompt = `${c.bold(' Search ')} ${s?.query ?? ''}${s?.typing ? c.inverse(' ') : ''}`;
  const hint = s?.typing ? c.gray('  Enter search · Esc cancel') : c.gray('  press / to type a search');
  const out = [clip(prompt + (s?.loading ? c.yellow('  searching…') : hint), v.cols)];
  if (!s) return [...out, c.gray('  press /, type part of a market name (e.g. 1win, bitcoin, lakers), then Enter. Select a result and press Enter or p for its decision, h for holders')];
  if (s.error) out.push(c.red(`  ${s.error}`));
  const cols = layout(
    [
      { key: 'vol', head: 'VOLUME', w: 8, align: 'right', keep: 9 },
      { key: 'st', head: 'STATE', w: 6, keep: 6 },
      { key: 'title', head: 'EVENT', w: 40, keep: 10, flex: true },
      { key: 'slug', head: 'SLUG', w: 30, keep: 2 },
    ],
    v.cols,
  );
  out.push(headOf(cols));
  const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
  const room = Math.max(1, height - out.length);
  const start = Math.max(0, Math.min(v.sel - Math.floor(room / 2), Math.max(0, s.results.length - room)));
  for (const [i, r] of s.results.slice(start, start + room).entries()) {
    out.push(rowOf(cols, { vol: fit(usd(r.volume), w('vol'), 'right'), st: r.closed ? c.gray(fit('closed', w('st'))) : c.green(fit('open', w('st'))), title: fit(r.title, w('title')), slug: c.gray(fit(r.slug, w('slug'))) }, start + i === v.sel));
  }
  if (!s.loading && !s.typing && s.query && s.results.length === 0 && !s.error) out.push(c.gray('  no events matched'));
  return out;
}

export function xrayRows(m: Model, v: View, height: number): string[] {
  const x = m.xray;
  if (!x) return [c.gray('  on Holders select a wallet and press x, or press / and paste a 0x… wallet address, to see its real record: closed AND open positions, PnL and volume, maker share')];
  const out = [clip(`${c.bold(' Wallet X-ray')}  ${c.gray(x.wallet)}${c.gray(asOf(x.report ? x.report.asOf * 1000 : null))}${x.done ? (x.error ? c.red(`  ${x.error}`) : '') : c.yellow(`  ${x.stage}…`)}`, v.cols)];
  if (!x.report) return out;
  for (const l of formatXray(x.report)) {
    const colored = l.startsWith('NOTE') ? c.yellow(l) : l.startsWith('LIMIT') || l.startsWith('A record') ? c.gray(l) : l.startsWith('ALL-IN') ? c.bold(l) : l;
    out.push(clip(` ${colored}`, v.cols));
  }
  return out.slice(0, Math.max(1, height));
}

export interface NewWalletsView {
  stage: string;
  done: boolean;
  error: string | null;
  result: NewWalletsResult | null;
  /** When the scan finished (epoch ms). */
  at: number | null;
  /** The user pressed Esc: `result` is whatever had been aged by then. */
  cancelled?: boolean;
}

export const newWalletRows = (m: Model): NewWalletsResult['rows'] => m.newWallets?.result?.rows ?? [];

export function walletsRows(m: Model, v: View, height: number): string[] {
  const x = m.newWallets;
  if (!x) return [c.gray('  press w: lists the markets that new accounts are putting money into right now; Enter opens a market\'s holders'), c.gray(`  ${NEWBIES_CAVEAT}`)];
  const r = x.result;
  const state = x.done ? (x.error ? c.red(x.error) : x.cancelled ? c.yellow('scan cancelled: partial result') : '') : c.yellow(`${x.stage}…  Esc cancels`);
  const out = [clip(`${c.bold(' New wallets')}${c.gray(asOf(x.at))}  ${state}${r && r.toAge ? c.yellow(`  ${r.toAge} wallets not aged yet`) : ''}`, v.cols)];
  // the standing caveat is never dropped, at any height
  out.push(clip(` ${c.yellow(NEWBIES_CAVEAT)}`, v.cols));
  if (!r) return out;
  if (height >= 12) out.push(clip(` ${c.gray(summarizeScan(r))}`, v.cols));
  else if (v.rows >= 8) out.push(clip(` ${c.gray(coverageNote(r))}`, v.cols));
  const rows = r.rows;
  if (v.rows >= 10 && rows.some(isSmallSample)) out.push(clip(` ${c.yellow(SMALL_SAMPLE_NOTE)}`, v.cols));
  const cols = layout(
    [
      { key: 'usd', head: 'NEW$', w: 7, align: 'right', keep: 10 },
      { key: 'n', head: 'NEW', w: 4, align: 'right', keep: 9 },
      { key: 'all', head: '/ALL', w: 5, align: 'right', keep: 4 },
      { key: 'sh', head: 'SHARE', w: 5, align: 'right', keep: 6 },
      { key: 'lift', head: 'LIFT', w: 6, align: 'right', keep: 8 },
      { key: 'lean', head: 'LEANS TO', w: 18, keep: 5 },
      { key: 'q', head: 'MARKET', w: 40, keep: 11, flex: true },
    ],
    v.cols,
  );
  out.push(headOf(cols));
  const detail = rows[v.sel];
  const detailH = detail && height >= 20 ? Math.min(detail.top.length, 6) + 3 : 0;
  const room = Math.max(1, height - out.length - detailH);
  const start = Math.max(0, Math.min(v.sel - Math.floor(room / 2), Math.max(0, rows.length - room)));
  const w = (k: string) => cols.find((c2) => c2.key === k)?.w ?? 0;
  for (const [i, row] of rows.slice(start, start + room).entries()) {
    const small = isSmallSample(row);
    const lift = fit(liftText(row), w('lift'), 'right');
    out.push(
      rowOf(
        cols,
        {
          usd: c.bold(fit(usdShort(row.newUsd), w('usd'), 'right')),
          n: fit(String(row.newWallets), w('n'), 'right'),
          all: fit(String(row.wallets), w('all'), 'right'),
          sh: fit(`${Math.round(row.newShare * 100)}%`, w('sh'), 'right'),
          lift: small ? c.gray(lift) : (row.lift >= 3 ? c.green : row.lift >= 1.5 ? c.yellow : (t: string) => t)(lift),
          lean: fit(row.lean ? `${row.lean.outcome} ${Math.round(row.lean.share * 100)}%` : '-', w('lean')),
          q: fit(row.question, w('q')),
        },
        start + i === v.sel,
      ),
    );
  }
  if (rows.length === 0 && x.done) out.push(c.gray(`  no market had ${3}+ new wallets with $100+ in this window`));
  if (detail && detailH) {
    while (out.length < height - detailH) out.push('');
    out.push(clip(` ${c.bold(detail.question)}  ${c.gray(`polymarket.com/event/${detail.eventSlug}`)}`, v.cols));
    for (const e of detail.top.slice(0, 6)) out.push(clip(`   ${fit(e.wallet.slice(0, 6) + '…' + e.wallet.slice(-4), 12)} ${fit(e.name ?? '', 16)} ${fit(`${e.ageDays}d old`, 8)} ${fit(usdShort(e.usd), 7, 'right')}  leans ${e.leanOutcome}  ${c.gray(`${e.trades} fill(s)`)}`, v.cols));
    out.push(clip(` ${c.gray(`${Math.round(detail.topShare * 100)}% of the new money is the biggest wallet. LIFT = this market's new-money share vs the platform's ${(r.platformNewShare * 100).toFixed(1)}%${isSmallSample(detail) ? ' (small sample, not meaningful)' : ''}. Enter: holders. ${NEWBIES_CAVEAT}.`)}`, v.cols));
  }
  return out.slice(0, height);
}

const agoText = (secs: number): string => (secs < 90 ? `${Math.max(0, Math.round(secs))}s` : secs < 5_400 ? `${Math.round(secs / 60)}m` : secs < 172_800 ? `${Math.round(secs / 3_600)}h` : `${Math.round(secs / 86_400)}d`);
const px1 = (p: number): string => (p * 100).toFixed(1);
const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const compact = (x: number): string => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1e5 ? `${Math.round(x / 1e3)}k` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}k` : `${Math.round(x)}`);

/** Live DOM ("glass") like Tiger.com / CScalp: price ladder with resting sizes either side of the price (shaded depth), trade clusters per time bucket, print bubbles, and the trade feed beside it. */
const SGR = (code: string, text: string): string => `\x1b[${code}m${text}\x1b[0m`;
const shade = (color: number, text: string): string => SGR(`48;5;${color};97`, text);
const bubbleGlyph = (x: number): string => (x >= 1000 ? '⬤' : x >= 200 ? '●' : x >= 50 ? '◉' : '•');
const depthCell = (value: number, max: number, w: number, side: 'bid' | 'ask', best: boolean): string => {
  if (value <= 0) return ' '.repeat(w);
  const txt = compact(value);
  const n = Math.max(1, Math.round(Math.min(1, value / max) * w));
  const chars = [...(side === 'bid' ? txt.padStart(w) : txt.padEnd(w))];
  const color = side === 'bid' ? (best ? 34 : 22) : best ? 160 : 52;
  return side === 'bid' ? chars.slice(0, w - n).join('') + shade(color, chars.slice(w - n).join('')) : shade(color, chars.slice(0, n).join('')) + chars.slice(n).join('');
};
const clusterCell = (cl: { buy: number; sell: number }, max: number, w: number): string => {
  const tot = Math.max(cl.buy, cl.sell);
  if (tot <= 0) return ' '.repeat(w);
  const level = tot / max > 0.6 ? 2 : tot / max > 0.2 ? 1 : 0;
  return shade((cl.buy >= cl.sell ? [22, 28, 34] : [52, 88, 124])[level], compact(tot).padStart(w));
};

export function bookRows(m: Model, v: View, height: number): string[] {
  const b = m.book;
  if (!b) return [c.gray('  press 8 on a market (Holders, Decision or a Newbies row) to open its live order book; [ ] switch market')];
  const s = b.live;
  const ui = b.ui;
  const status = !s ? c.yellow('◌ CONNECTING') : s.status === 'live' ? c.green('● LIVE') : s.status === 'polling' ? c.yellow('◐ POLLING (socket down, refreshing every 3s)') : s.status === 'connecting' ? c.yellow('◌ CONNECTING') : c.red('○ DOWN');
  const out = [clip(`${c.bold(' ORDER BOOK')}  ${b.question}  ${status}${s?.error ? c.red(`  ${s.error.slice(0, 60)}`) : ''}${b.error ? c.red(`  ${b.error}`) : ''}`, v.cols)];
  if (!s || (s.bids.size === 0 && s.asks.size === 0)) {
    out.push(c.gray(b.error ? '' : '  waiting for the book…'));
    return out.slice(0, height);
  }
  const nC = v.cols >= 128 ? 3 : v.cols >= 100 ? 2 : v.cols >= 84 ? 1 : 0;
  const core = nC * 8 + 38;
  const tapeW = Math.min(64, v.cols - core - 3);
  const withTape = tapeW >= 40;
  const costs = height >= 28 ? costSummary(toBook(s, ui.flip), b.outcomes, b.feeRate) : [];
  const fixed = 3 + 1 + 1 + 1 + (costs.length ? costs.length + 1 : 0);
  const nRows = Math.max(3, height - fixed);
  const d = buildDom({ ...s }, { rows: nRows % 2 ? nRows : nRows - 1, group: ui.group, unit: ui.unit, flip: ui.flip, periodSecs: ui.periodSecs, clusterCols: nC, scroll: ui.scroll, manualCenter: ui.manualCenter, nowMs: Date.now() });
  const unitTag = ui.unit === 'USD' ? '$' : 'sh';
  const outcome = b.outcomes[ui.flip ? 1 : 0];
  const nowSecs = Date.now() / 1000;
  const tape = tapeOf(s, ui.flip, ui.tapeMin, nRows + 2);
  const px = (mm: number | null): string => (mm === null ? '--' : (mm / 10).toFixed(d.stepMills % 10 ? 1 : 1));
  const spread = d.bestBid !== null && d.bestAsk !== null ? (d.bestAsk - d.bestBid) / 10 : null;
  out.push(clip(
    ` ${c.green(c.bold(`BID ${px(d.bestBid)}`))}  ${c.red(c.bold(`ASK ${px(d.bestAsk)}`))}  ${c.bold(`MID ${d.mid === null ? '--' : (d.mid / 10).toFixed(2)}`)}  ${c.yellow(`SPR ${spread === null ? '--' : spread.toFixed(1)}c`)}`
    + `  ${c.gray('│')} LAST ${d.last ? `${(d.last.price * 100).toFixed(1)}c ${d.last.side} ${agoText(nowSecs - d.last.ts)}` : '--'}`
    + `  ${c.gray('│')} ${c.bold(outcome)} view · ${ui.group}T · ${unitTag} · ${ui.periodSecs >= 60 ? `${ui.periodSecs / 60}m` : `${ui.periodSecs}s`} clusters${ui.scroll || ui.manualCenter !== null ? c.yellow('  (scrolled: c re-centres)') : ''}`, v.cols));
  const near = d.bidNear + d.askNear;
  if (near > 0) {
    const W = 22;
    const n = Math.round((d.bidNear / near) * W);
    out.push(clip(` ${c.gray('±5c depth')} ${c.green(compact(d.bidNear).padStart(7))} ${c.green('█'.repeat(n))}${c.red('█'.repeat(W - n))} ${c.red(compact(d.askNear))}  ${c.gray(`${Math.round((d.bidNear / near) * 100)}% bids · ${s.trades.length} fills in memory · ${s.frames.toLocaleString('en-US')} msgs`)}`, v.cols));
  } else out.push(c.gray(' ±5c depth: none'));
  const timeLab = (t: number): string => new Date(t * 1000).toLocaleTimeString('en-GB').slice(0, ui.periodSecs < 60 ? 8 : 5);
  const head = (nC ? d.colStarts.map((t) => timeLab(t).padStart(7)).join(' ') + ' ' : '') + `${'BID'.padStart(11)} ${'PRICE'.padStart(6)} ${'ASK'.padEnd(11)} ${'PRINTS'.padEnd(8)}`;
  out.push(clip(c.dim(head) + (withTape ? `   ${c.dim(`${'TIME'.padEnd(8)} ${'SIDE'.padEnd(4)} ${'PRICE'.padStart(6)} ${'SIZE'.padStart(8)}  WALLET`)}` : ''), v.cols));
  for (const [i, r] of d.rows.entries()) {
    const label = (r.mills / 10).toFixed(d.stepMills % 10 ? 1 : 0).padStart(5);
    const priceCell = r.isLast ? SGR('30;43', ` ${label} `) : r.isBestBid ? c.green(c.bold(` ${label} `)) : r.isBestAsk ? c.red(c.bold(` ${label} `)) : c.bold(` ${label} `);
    const pr = r.print.buy + r.print.sell;
    const printCell = pr > 0 ? (r.print.buy >= r.print.sell ? c.green : c.red)(`${bubbleGlyph(pr)}${compact(pr)}`.padEnd(8)) : ' '.repeat(8);
    const left = (nC ? r.clusters.map((cl) => clusterCell(cl, d.clusterMax, 7)).join(' ') + ' ' : '') + `${depthCell(r.bid, d.maxDepth, 11, 'bid', r.isBestBid)} ${priceCell} ${depthCell(r.ask, d.maxDepth, 11, 'ask', r.isBestAsk)} ${printCell}`;
    const t = withTape ? tape[i] : undefined;
    const tapeCell = t ? `${new Date(t.ts * 1000).toLocaleTimeString('en-GB')} ${(t.side === 'BUY' ? c.green : c.red)(t.side.padEnd(4))} ${(t.price * 100).toFixed(1).padStart(6)} ${(t.size * t.price >= 1000 ? c.bold : (x: string) => x)(`${bubbleGlyph(t.size * t.price)}$${compact(t.size * t.price)}`.padStart(8))}  ${c.gray(t.wallet ? shortAddr(t.wallet) : '·')}` : '';
    out.push(clip(`${left}${withTape ? `   ${tapeCell}` : ''}`, v.cols));
  }
  const deltaCells = nC ? d.colDelta.map((x) => (x >= 0 ? c.green : c.red)(`${x >= 0 ? '+' : '-'}${compact(Math.abs(x))}`.padStart(7))).join(' ') + ' ' : '';
  out.push(clip(`${deltaCells}${c.gray(`${'Δ buy−sell'.padStart(11)}`)}`, v.cols));
  if (costs.length) {
    out.push(c.gray(`  COST OF A TRADE (taker fee ${(b.feeRate * 100).toFixed(0)}% x p x (1-p), estimated from tags)`));
    for (const l of costs) out.push(clip(`  ${l}`, v.cols));
  }
  out.push(clip(c.gray(' + / - compress ticks · ↑↓ scroll · c centre · m shares/$ · t cluster period · i flip outcome · s tape filter · [ ] market'), v.cols));
  return out.slice(0, height);
}

export function followRows(m: Model, v: View, height: number): string[] {
  const f = m.follow;
  const cards = f?.cards ?? [];
  const nowSecs = Date.now() / 1000;
  const head = `${c.bold(' FOLLOWING')}  ${c.gray(`${cards.length} wallet${cards.length === 1 ? '' : 's'}${f?.loadedAt ? ` · updated ${agoText(nowSecs - f.loadedAt / 1000)} ago` : ''} · refresh 90s`)}${f?.loading ? c.yellow('  loading…') : ''}  ${c.gray('n add by link · - unfollow · enter x-ray')}`;
  const out = [clip(head, v.cols)];
  if (f?.input !== null && f?.input !== undefined) out.push(clip(` ${c.yellow('Follow:')} paste a 0x wallet, polymarket.com/profile/0x… or polymarket.com/@name   ${c.bold(f.input)}${c.inverse(' ')}  ${c.gray('Enter follows · Esc cancels')}`, v.cols));
  else if (f?.message) out.push(clip(` ${c.yellow(f.message)}`, v.cols));
  if (cards.length === 0) {
    out.push(c.gray('  nobody followed yet: press n (or + on another tab) and paste a wallet address or a polymarket.com profile link (also: a on a holder, or in an X-ray)'));
    return out.slice(0, height);
  }
  const cols = layout(
    [
      { key: 'new', head: 'NEW', w: 3, align: 'right', keep: 9 },
      { key: 'name', head: 'ACCOUNT', w: 24, keep: 10 },
      { key: 'd7', head: '7D', w: 8, align: 'right', keep: 8 },
      { key: 'd30', head: '30D', w: 8, align: 'right', keep: 4 },
      { key: 'all', head: 'ALL-IN', w: 9, align: 'right', keep: 5 },
      { key: 'open', head: 'OPEN', w: 8, align: 'right', keep: 6 },
      { key: 'up', head: 'uPNL', w: 8, align: 'right', keep: 3 },
      { key: 'last', head: 'LAST BET', w: 8, align: 'right', keep: 7 },
      { key: 'avg', head: 'AVG BET', w: 8, align: 'right', keep: 2 },
      { key: 'buy', head: 'BUYS', w: 5, align: 'right', keep: 1 },
      { key: 'top', head: 'BIGGEST POSITION', w: 30, keep: 0, flex: true },
    ],
    v.cols,
  );
  out.push(headOf(cols));
  const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
  const listMax = Math.max(2, Math.min(cards.length, Math.floor(height * 0.3)));
  const sel = Math.min(v.sel, cards.length - 1);
  const start = Math.max(0, Math.min(sel - Math.floor(listMax / 2), cards.length - listMax));
  for (const [i, k] of cards.slice(start, start + listMax).entries()) {
    const lastTs = k.trades[0]?.ts;
    out.push(rowOf(cols, {
      new: k.newTrades ? c.yellow(c.bold(fit(`●${k.newTrades}`, w('new'), 'right'))) : fit('', w('new')),
      name: k.error ? c.red(fit(`${k.note ?? shortAddr(k.wallet)} ${k.error}`, w('name'))) : fit(k.note ?? k.name ?? shortAddr(k.wallet), w('name')),
      d7: signColor(k.pnl7d, fit(k.pnl7d === null ? '-' : usd(k.pnl7d, true), w('d7'), 'right')),
      d30: signColor(k.pnl30d, fit(k.pnl30d === null ? '-' : usd(k.pnl30d, true), w('d30'), 'right')),
      all: signColor(k.pnlAll, fit(k.pnlAll === null ? '-' : usd(k.pnlAll, true), w('all'), 'right')),
      open: fit(k.openCount ? usd(k.openValue) : '-', w('open'), 'right'),
      up: signColor(k.openCount ? k.unrealized : null, fit(k.openCount ? usd(k.unrealized, true) : '-', w('up'), 'right')),
      last: fit(lastTs ? agoText(nowSecs - lastTs) : '-', w('last'), 'right'),
      avg: fit(k.style ? usd(k.style.avgUsd) : '-', w('avg'), 'right'),
      buy: fit(k.style ? `${Math.round(k.style.buyShare * 100)}%` : '-', w('buy'), 'right'),
      top: c.gray(fit(k.positions[0] ? `${usd(k.positions[0].value)} ${k.positions[0].outcome} · ${k.positions[0].title}` : '', w('top'))),
    }, start + i === sel));
  }
  const k: FollowCard = cards[sel];
  const room = height - out.length;
  if (room < 5 || k.error) return out.slice(0, height);
  out.push(clip(` ${c.bold(k.note ?? k.name ?? shortAddr(k.wallet))}  ${c.gray(`${k.wallet}  polymarket.com/profile/${k.wallet}`)}`, v.cols));
  if (k.style) out.push(clip(` ${c.gray(`last ${k.style.trades} bets: avg ${usd(k.style.avgUsd)}, median ${usd(k.style.medianUsd)}, ${Math.round(k.style.buyShare * 100)}% buys, ${k.style.markets} markets${k.style.avgBuyPrice === null ? '' : `, buys at ${(k.style.avgBuyPrice * 100).toFixed(0)}c on average`} · their own prices, not what a follower would get`)}`, v.cols));
  const left = height - out.length;
  const betRows = Math.max(1, Math.min(k.trades.length, Math.ceil((left - 4) * 0.6)));
  const betCols = layout(
    [
      { key: 'age', head: 'AGO', w: 5, align: 'right', keep: 10 },
      { key: 'side', head: 'SIDE', w: 5, keep: 9 },
      { key: 'out', head: 'BET ON', w: 14, keep: 8 },
      { key: 'px', head: 'PRICE', w: 6, align: 'right', keep: 7 },
      { key: 'usd', head: '$', w: 7, align: 'right', keep: 6 },
      { key: 'q', head: 'MARKET', w: 40, keep: 11, flex: true },
    ],
    v.cols - 2,
  );
  const bw = (key: string) => betCols.find((x) => x.key === key)?.w ?? 0;
  out.push(c.dim(` RECENT BETS`) + c.gray(k.trades.length ? '' : '  none in the feed'));
  if (k.trades.length) out.push(` ${headOf(betCols)}`);
  for (const t of k.trades.slice(0, betRows))
    out.push(clip(` ${rowOf(betCols, {
      age: (t.isNew ? c.yellow : (x: string) => x)(fit(agoText(nowSecs - t.ts), bw('age'), 'right')),
      side: (t.side === 'BUY' ? c.green : c.red)(fit(t.side, bw('side'))),
      out: fit(t.outcome, bw('out')),
      px: fit(`${(t.price * 100).toFixed(0)}c`, bw('px'), 'right'),
      usd: c.bold(fit(usd(t.size * t.price), bw('usd'), 'right')),
      q: fit(`${t.isNew ? '● ' : ''}${t.title}`, bw('q')),
    }, false)}`, v.cols));
  const posRoom = height - out.length - 2;
  if (posRoom >= 2 && k.positions.length) {
    const pc = layout(
      [
        { key: 'val', head: 'VALUE', w: 8, align: 'right', keep: 10 },
        { key: 'up', head: 'uPNL', w: 8, align: 'right', keep: 9 },
        { key: 'out', head: 'HOLDS', w: 14, keep: 8 },
        { key: 'q', head: 'MARKET', w: 40, keep: 11, flex: true },
      ],
      v.cols - 2,
    );
    const pw = (key: string) => pc.find((x) => x.key === key)?.w ?? 0;
    out.push(c.dim(` HOLDING NOW`) + c.gray(`  ${k.openCount} open position${k.openCount === 1 ? '' : 's'}, ${usd(k.openValue)}`));
    out.push(` ${headOf(pc)}`);
    for (const p of k.positions.slice(0, Math.max(1, posRoom - 1)))
      out.push(clip(` ${rowOf(pc, { val: c.bold(fit(usd(p.value), pw('val'), 'right')), up: signColor(p.unrealizedPnl, fit(usd(p.unrealizedPnl, true), pw('up'), 'right')), out: fit(p.outcome, pw('out')), q: fit(p.title, pw('q')) }, false)}`, v.cols));
  }
  return out.slice(0, height);
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
    const age = accountAge(r.createdAt, Date.now() / 1000);
    out.push(line(`  profile created ${age.label}${age.isNew ? c.magenta(c.bold('  NEW ACCOUNT')) : ''}${r.xUsername ? `  linked X @${r.xUsername}` : ''}`));
    for (const mt of r.matches ?? []) out.push(line(`  ${c.yellow('≈')} ${mt.why}; the watchlist has ${mt.person.name}${mt.person.org ? ` (${mt.person.org})` : ''}. Name match only, unverified (${mt.kind} ${mt.score}); many people share names, this is not an identification`));
    if (age.isNew || r.matches?.length) out.push(line(c.gray(`  ${NEWBIES_CAVEAT}`)));
    for (const f of r.flags) out.push(line(`  ${c.yellow('!')} ${f}`));
    out.push(line(c.gray('  Classification is a screen from activity patterns, not an identification. PnL is Polymarket\'s own all-time/7-day figure.')));
    return out;
  }
  if (v.tab === 'decision') return [];
  if (v.tab === 'search') {
    const r = m.search?.results[v.sel];
    return r ? [line(`${c.bold(r.title)}  ${c.gray(`polymarket.com/event/${r.slug}`)}`), line(c.gray('  Enter/p decide · h holders · o link'))] : [];
  }
  return [];
}

/** The always-visible key hint: short enough for 100 columns. Everything else lives behind `?`. */
export const FOOTER = ' ↑↓ move · 1-9 tabs · Enter open · p decide · h holders · / search · ? all keys · r refresh · q quit';

const GLOBAL_HELP = [
  'EVERYWHERE',
  '  1-9 / Tab   switch tab (1 Markets 2 Games 3 Newbies 4 Holders 5 Decision 6 X-ray 7 Search 8 Book 9 Following)',
  '  ↑ ↓ k       move · PgUp PgDn page · g / G first / last',
  '  /           search a market by name, or paste a 0x wallet to open its X-ray',
  '  r           refresh the market data now      o   show the link of the selected row',
  '  n           follow a wallet (paste a 0x address or a polymarket.com profile link)',
  '  ?           this help · Esc closes it        q   quit',
];
const TAB_HELP: Record<Tab, string[]> = {
  anomalies: ['1 MARKETS', '  Enter / p   open the Decision for the selected event      h   its top holders', '  f           cycle the category filter         o   link', '  8           order book (after opening Holders or Decision first)'],
  games: ['2 GAMES', '  Enter / p   open the Decision for the selected game       h   its top holders', '  o           link'],
  wallets: ['3 NEWBIES  (scans on first open, about 1-4 minutes; Esc cancels a running scan)', '  Enter / h   holders of the selected market      8   its order book', '  w           scan again    Esc  cancel the scan and keep what is aged so far', '  * after LIFT marks a small sample (under 5 new wallets or under $500): not meaningful'],
  holders: ['4 HOLDERS', '  [ ] / { }   step market / market type      b   show or hide bots and market makers', '  x           X-ray of the selected wallet      a   follow the selected wallet', '  8           order book      p   decision      o   wallet link'],
  decision: ['5 DECISION  (a model estimate, not advice)', '  ↑ ↓         select a market row      h   holders of that market      8   its order book'],
  xray: ['6 X-RAY', '  a           follow this wallet      /   paste another 0x address      o   profile link', '  OPEN figures are partial: they depend on the positions feed'],
  search: ['7 SEARCH', '  /           type a query, Enter runs it, Esc cancels', '  Enter / p   Decision for the selected result      h   holders      o   link'],
  book: ['8 BOOK', '  + / -       compress / expand price ticks      ↑ ↓   scroll      c   re-centre', '  m           shares or dollars      t   cluster period      s   tape filter      i   flip outcome', '  [ ]         step market (when opened from Holders)'],
  follow: ['9 FOLLOWING', '  n           add a wallet by address or link      -   unfollow the selected one', '  Enter / x   X-ray of the selected wallet      refreshes every 90s'],
};
/** Full key map for the tab you are on, then the global keys. */
export function helpRows(tab: Tab, height: number, cols: number): string[] {
  const lines = [c.bold(' KEYS'), ...TAB_HELP[tab].map((l, i) => (i === 0 ? c.cyan(` ${l}`) : ` ${l}`)), '', ...GLOBAL_HELP.map((l, i) => (i === 0 ? c.cyan(` ${l}`) : ` ${l}`))];
  return lines.slice(0, Math.max(1, height)).map((l) => clip(l, cols));
}

export function render(m: Model, v: View, nowMs: number): string[] {
  return renderPlain(sanitizeDeep(m), v, nowMs);
}

function renderPlain(m: Model, v: View, nowMs: number): string[] {
  const { cols, rows } = v;
  const s = m.status;
  const live = s.error ? c.red('● error') : s.busy ? c.yellow('● polling') : c.green('● live');
  const next = s.nextPollAt === null ? '--' : dur(Math.max(0, (s.nextPollAt - nowMs) / 1000));
  const hist = m.status.historySecs < 120 ? c.yellow('collecting') : dur(m.status.historySecs);
  const header = clip(
    `${c.bold(c.cyan(' POLYRADAR '))} ${live}  polled ${clock(s.lastPollAt)}  next ${next}  events ${s.events}  history ${hist}  fills ${m.prints.length}${s.printsWindowMin ? ` (${s.printsWindowMin}m)` : ''}${s.error ? `  ${c.red(s.error.slice(0, 60))}` : ''}`,
    cols,
  );
  const tabBar = ' ' + [...MAIN_TABS, ...(LABS.includes(v.tab) ? [v.tab] : [])].map((t) => (t === v.tab ? c.inverse(` ${TAB_LABEL[t]} `) : c.gray(` ${TAB_LABEL[t]} `))).join('');
  // the counters and the labs hint only fit when there is room: the tabs themselves always win
  const extras = c.gray(`${LABS.includes(v.tab) ? '' : ''}   ${[...m.anomalies, ...m.games].filter((a) => a.level === 'HOT').length} hot · ${[...m.anomalies, ...m.games].filter((a) => a.level === 'WATCH').length} watch`) + (m.filter ? c.yellow(`   filter: ${m.filter}`) : '');
  const tabs = clip(vlen(tabBar) + vlen(extras) <= cols ? tabBar + extras : tabBar, cols);
  const detailH = rows >= 30 && v.tab !== 'decision' && !v.help ? 8 : 0;
  const bodyH = Math.max(3, rows - 3 - detailH - (detailH ? 1 : 0));
  const bodyRows: Record<Tab, (m: Model, v: View, h: number) => string[]> = { anomalies: anomalyRows, games: gameRows, holders: holderRows, decision: decisionRows, search: searchRows, xray: xrayRows, wallets: walletsRows, book: bookRows, follow: followRows };
  const body = (v.help ? helpRows(v.tab, bodyH, cols) : bodyRows[v.tab](m, v, bodyH)).map((l) => clip(l, cols));
  const lines = [header, tabs, ...body];
  while (lines.length < 2 + bodyH) lines.push('');
  if (detailH) {
    lines.push(c.gray('─'.repeat(cols)));
    const d = detailLines(m, v, cols - 1);
    for (let i = 0; i < detailH; i++) lines.push(d[i] ?? '');
  }
  while (lines.length < rows - 1) lines.push('');
  const hint = c.gray(v.help ? ' Esc or ? closes help · q quit' : FOOTER);
  // the status message goes first: the key hint would push a trailing message off a narrow screen
  lines.push(clip(s.message ? `${c.yellow(` ${s.message}`)}  ${hint}` : hint, cols));
  return lines.slice(0, rows).map((l) => (vlen(l) > cols ? clip(l, cols) : l));
}

/** `n` opens the follow prompt anywhere; `+`/`=` only off Book (where they compress ticks) and Following (which has its own add box). */
export const opensFollowPrompt = (d: string, tab: Tab): boolean => d === 'n' || ((d === '+' || d === '=') && tab !== 'book' && tab !== 'follow');
/** Tabs whose rows are events: Enter opens the Decision for the selected one. */
export const enterOpensDecision = (tab: Tab): boolean => tab === 'anomalies' || tab === 'games' || tab === 'search';

export type Key = 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end' | 'tab' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '0' | 'w' | 'x';
export function listLength(m: Model, tab: Tab): number {
  switch (tab) {
    case 'anomalies': return m.anomalies.length;
    case 'games': return m.games.length;
    case 'holders': return visibleHolders(m).length;
    case 'decision': return m.decision?.decision?.markets.length ?? 0;
    case 'search': return m.search?.results.length ?? 0;
    case 'wallets': return newWalletRows(m).length;
    case 'follow': return m.follow?.cards.length ?? 0;
    case 'xray': case 'book': return 0;
  }
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
    case 'tab': return { ...v, tab: MAIN_TABS[(MAIN_TABS.indexOf(v.tab) + 1) % MAIN_TABS.length], sel: 0 }; // from a lab tab this goes back to the first main tab
    case '1': return { ...v, tab: 'anomalies', sel: 0 };
    case '2': return { ...v, tab: 'games', sel: 0 };
    case '3': case 'w': return { ...v, tab: 'wallets', sel: 0 };
    case '4': return { ...v, tab: 'holders', sel: 0 };
    case '5': return { ...v, tab: 'decision', sel: 0 };
    case '6': case 'x': return { ...v, tab: 'xray', sel: 0 };
    case '7': return { ...v, tab: 'search', sel: 0 };
    case '8': return { ...v, tab: 'book', sel: 0 };
    case '9': return { ...v, tab: 'follow', sel: 0 };
    default: return v;
  }
}
