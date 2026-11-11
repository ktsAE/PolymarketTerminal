import type { DecisionView } from '../decide-data.ts';
import type { NewsView } from '../newsview.ts';
import { KIND_TEXT, type EdgeCandidate, type ScanResult } from '../edges.ts';
import { NO_EDGE, type LedgerReport } from '../ledger.ts';
import { formatJumps, type JumpFlag, type JumpReport, type JumpScan } from '../jump.ts';
import { NEWMARKET_THRESHOLDS, type ScanRow, type ScanSummary } from '../newmarkets.ts';
import { gamePhase, type Anomaly, type WalletTag } from '../detect.ts';
import type { Action, MarketDecision } from '../decide.ts';
import { formatClassFlow } from '../classflow.ts';
import { CLUSTER_CAVEAT, findClusters, formatCluster } from '../clusters.ts';
import { formatInfo } from '../marketinfo.ts';
import { costLines, formatCost } from '../cost.ts';
import { summarizeScan, usdShort, type NewWalletsResult } from '../newwallets.ts';
import { costSummary, ladder, type BookView } from '../bookview.ts';
import { formatXray, type XrayReport } from '../xray.ts';
import { peopleOnly, type HolderRow, type HoldersView } from '../holders.ts';
import { accountAge, dateOf } from '../identity.ts';
import type { NewsRow, PrintRow } from '../store.ts';
import { c, clip, fit, sparkline, vlen } from './ansi.ts';

export type Tab = 'anomalies' | 'games' | 'prints' | 'holders' | 'leads' | 'decision' | 'search' | 'news' | 'edge' | 'ledger' | 'new' | 'jumps' | 'xray' | 'wallets' | 'book';
/** The tools that stay: the home list, games, the new-wallets screener, holders, the decision page, wallet X-ray and search. The removed experiments (news, edges, jumps, new markets, leads, ledger, big prints) live on as CLI commands. */
export const TABS: readonly Tab[] = ['anomalies', 'games', 'wallets', 'holders', 'decision', 'xray', 'search', 'book'];
export const LABS: readonly Tab[] = [];
export const MAIN_TABS: readonly Tab[] = TABS;
const TAB_LABEL: Record<Tab, string> = { anomalies: '1 Markets', games: '2 Games', wallets: '3 Newbies', holders: '4 Holders', decision: '5 Decision', xray: '6 X-ray', search: '7 Search', book: '8 Book', prints: 'Big prints', leads: 'Leads', news: 'News', edge: 'Edge', ledger: 'Ledger', new: 'New markets', jumps: 'Jumps' };

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
  /** Decision for the event the user opened with `p` (null until then). */
  decision?: DecisionView | null;
  /** Search tab: the query (being typed when `typing`), its results and state. */
  search?: SearchState | null;
  /** News tab: headlines and market state for the event the user opened with `n`. */
  news?: NewsView | null;
  /** Edge tab: the last scan of every active event (null until `e`). */
  edges?: EdgeView | null;
  /** Ledger tab: the pre-registered paper ledger scored from the forward logs at the last refresh. */
  ledger?: LedgerView | null;
  /** New tab: the last new-market scan (null until `w`). */
  newMarkets?: NewMarketsView | null;
  /** Jumps tab: the last calm-then-jump scan (null until `j`). */
  jumps?: JumpsView | null;
  /** X-ray tab: the record of one wallet (null until `x` on a holder, or a 0x address searched with `/`). */
  xray?: XrayView | null;
  /** New wallets tab: markets ranked by the money new accounts put in (null until `w`). */
  newWallets?: NewWalletsView | null;
  /** Book tab: live order book of one market (null until `8`). */
  book?: BookView | null;
}

export interface JumpsView {
  stage: string;
  done: boolean;
  error: string | null;
  /** Epoch ms the scan finished (null while running or never). */
  at: number | null;
  scan: JumpScan | null;
}

/** Standing line of the Jumps tab: a flag is a lead to look at, never a trade signal. */
export const JUMPS_STANDING = 'leads, not signals; no edge shown';

/** Flags of the last jump scan, biggest move first. */
export const jumpFlags = (m: Model): JumpFlag[] => [...(m.jumps?.scan?.flags ?? [])].sort((a, b) => Math.abs(b.move) - Math.abs(a.move));

/** One line for the Edge tab when token ladders were seen that no refs.json entry prices. */
export const unmappedNote = (n: number): string => `${n} token markets have no reference price (add to .radar/refs.json)`;

export interface NewMarketsView {
  stage: string;
  done: boolean;
  error: string | null;
  /** Epoch ms the scan finished (null while running or never). */
  at: number | null;
  summary: ScanSummary | null;
  /** Flagged lines written to the forward log by this scan (null when not logged). */
  logged: { written: number; duplicates: number } | null;
}

/** Standing line of the New tab: flags describe trading behavior only. */
export const NEW_STANDING = 'behavior flags only: not evidence of insider trading; no edge proven until the forward log says so';

/** Flagged rows of the last new-market scan, best score first. */
export const flaggedNew = (m: Model): ScanRow[] => (m.newMarkets?.summary?.rows ?? []).filter((r) => r.flagged).sort((a, b) => b.score - a.score);

export interface LedgerView {
  /** Epoch ms of the scoring run. */
  at: number;
  error: string | null;
  report: LedgerReport | null;
  /** Calm-then-jump forward log scored at the same refresh (null when unread or empty). */
  jumps?: JumpReport | null;
}

/** Standing line of the Ledger tab: paper results never count as an edge until the ledger verdict says so. */
export const LEDGER_STANDING = 'paper results only; NO EDGE PROVEN until n>=300 and CI>0';

export interface EdgeView {
  stage: string;
  done: boolean;
  error: string | null;
  result: ScanResult | null;
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

export function holderRows(m: Model, v: View, height: number): string[] {
  const h = m.holders;
  if (!h) return [c.gray('  select an event on Anomalies, Games or Big prints and press h to load its top holders')];
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
  if (clusters.length && height >= 26) out.push(clip(` ${c.gray(CLUSTER_CAVEAT)}`, v.cols));
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
  const flowLines = h.flow && height >= 18 + infoLines.length + (clusters.length ? 1 : 0) ? formatClassFlow(h.flow.data, h.flow.yesLabel, h.flow.noLabel).slice(0, 8) : [];
  const room = Math.max(1, height - 2 - infoLines.length - (clusters.length && height >= 16 ? 1 + (height >= 26 ? 1 : 0) : 0) - (flowLines.length ? flowLines.length + 1 : 0));
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
          name: (r.matches?.length ? c.yellow : (s: string) => s)(fit(`${r.flags.length ? '! ' : ''}${r.matches?.length ? '≈ ' : ''}${r.name ?? r.wallet.slice(0, 10)}`, w('name'))),
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

function actionCell(d: MarketDecision, w: number): string {
  const label = d.action === 'BUY YES' || d.action === 'BUY NO' ? `BUY ${d.outcomes[d.side ?? 0] ?? d.action.slice(4)}`.toUpperCase() : d.action;
  const t = fit(label, w);
  return d.action === 'ARB' || d.action === 'BUY YES' || d.action === 'BUY NO' ? c.green(c.bold(t)) : d.action === 'WATCH' ? c.yellow(t) : c.gray(t);
}
const actionColor = (a: Action, s: string): string => (a === 'ARB' || a === 'BUY YES' || a === 'BUY NO' ? c.green(c.bold(s)) : a === 'WATCH' ? c.yellow(s) : c.gray(s));
const px2 = (x: number | null): string => (x === null ? '-' : x.toFixed(2));

export function decisionRows(m: Model, v: View, height: number): string[] {
  const dv = m.decision;
  if (!dv) return [c.gray('  select an event on Anomalies, Games, Big prints or Holders and press p to decide what to do about it')];
  const busy = dv.done ? (dv.error ? c.red(`  ${dv.error}`) : '') : c.yellow(`  ${dv.stage}${dv.progress.total ? ` ${dv.progress.loaded}/${dv.progress.total}` : ''}…`);
  const out = [clip(`${c.bold(dv.title)}${busy}`, v.cols)];
  const d = dv.decision;
  if (!d) return out;
  out.push(clip(`  ${c.bold(d.headline)}  ${c.gray(`${d.version}, edges are model/structure based, never from following wallets`)}`, v.cols));
  const cols = layout(
    [
      { key: 'act', head: 'ACTION', w: 9, keep: 10 },
      { key: 'mk', head: 'MARKET', w: 22, keep: 9, flex: true },
      { key: 'q', head: 'BID/ASK', w: 9, keep: 8 },
      { key: 'fair', head: 'MODEL', w: 7, keep: 5 },
      { key: 'edge', head: 'EDGE', w: 6, align: 'right', keep: 7 },
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
          edge: x.edgePts === null ? c.gray(fit('-', w('edge'), 'right')) : c.green(fit(`+${x.edgePts.toFixed(0)}pt`, w('edge'), 'right')),
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
    out.push(clip(`${c.dim('─'.repeat(2))} ${c.bold(sel.label)}  ${actionColor(sel.action, sel.action)}${sel.edgePts !== null ? c.green(`  +${sel.edgePts.toFixed(1)} points`) : ''}  confidence ${sel.confidence}${sel.capacityUsd !== null ? `  room for ~${usd(sel.capacityUsd)} near that price` : ''}`, v.cols));
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
        out.push(clip(`  ${(x.cls === 'LOW_DATA' ? 'NEW?' : x.cls).padEnd(5)} ${(x.side === null ? '?' : (sel.outcomes[x.side] ?? '?')).slice(0, 8).padEnd(8)} ${(x.posUsd === null ? '-' : usd(x.posUsd)).padStart(8)} ${created} ${String(x.traded ?? '-').padStart(5)} ${(x.xUsername ? `@${x.xUsername}` : '').slice(0, 16).padEnd(16)} ${x.matches.length ? c.yellow('≈ ') : ''}${x.name ?? x.wallet.slice(0, 10)}`, v.cols));
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
  if (!s) return [...out, c.gray('  press /, type part of a market name (e.g. 1win, bitcoin, lakers), then Enter. Select a result and press p to decide on it, h for holders')];
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

const ageLabel = (ms: number | null, nowMs: number): string => {
  if (ms === null) return '?';
  const s = Math.max(0, (nowMs - ms) / 1000);
  return s < 5_400 ? `${Math.max(1, Math.round(s / 60))}m` : s < 172_800 ? `${(s / 3600).toFixed(0)}h` : `${Math.round(s / 86_400)}d`;
};

export function newsRows(m: Model, v: View, height: number): string[] {
  const nv = m.news;
  if (!nv) return [c.gray('  select an event on any tab and press n to search news about it (headlines + the market\'s deadline, oracle status and prices)')];
  const busy = nv.done ? (nv.error ? c.red(`  ${nv.error}`) : '') : c.yellow(`  ${nv.stage}…`);
  const out = [clip(`${c.bold(nv.title)}${busy}`, v.cols)];
  const nowMs = Date.now();
  for (const mk of nv.markets.slice(0, 3)) {
    const ends = mk.endsAt === null ? '' : `  ends ${new Date(mk.endsAt * 1000).toISOString().slice(5, 16).replace('T', ' ')}Z (${dur(Math.abs(mk.endsAt - nowMs / 1000))} ${mk.endsAt * 1000 < nowMs ? 'ago' : 'left'})`;
    const uma = mk.uma.length ? `  oracle: ${mk.uma.join('>')}` : '';
    out.push(clip(`  ${fit(mk.label, 18)} ${px2(mk.bid)}/${px2(mk.ask)}${mk.closed ? c.gray('  closed') : ''}${ends}${c.cyan(uma)}`, v.cols));
  }
  if (nv.query) out.push(clip(c.gray(`  searched: ${nv.query}${nv.sourceErrors.length ? `   (${nv.sourceErrors.join('; ')})` : ''}`), v.cols));
  const cols = layout(
    [
      { key: 'age', head: 'AGO', w: 4, align: 'right', keep: 9 },
      { key: 'src', head: 'SOURCE', w: 18, keep: 4 },
      { key: 'title', head: 'HEADLINE', w: 60, keep: 10, flex: true },
    ],
    v.cols,
  );
  out.push(headOf(cols));
  const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
  const room = Math.max(1, height - out.length);
  const start = Math.max(0, Math.min(v.sel - Math.floor(room / 2), Math.max(0, nv.hits.length - room)));
  for (const [i, h] of nv.hits.slice(start, start + room).entries()) {
    out.push(rowOf(cols, { age: c.gray(fit(ageLabel(h.publishedAt, nowMs), w('age'), 'right')), src: c.cyan(fit(h.source, w('src'))), title: fit(h.title, w('title')) }, start + i === v.sel));
  }
  if (nv.done && !nv.error && nv.hits.length === 0) out.push(c.gray('  no headlines in the last 7 days (this is not evidence that nothing happened)'));
  return out;
}

const edgeLive = (c: EdgeCandidate): string => (c.kind === 'REF' ? `~+${(c.liveEdgePts ?? c.edgePts).toFixed(1)}pt` : c.verified === null ? (c.note ? 'unchecked' : 'not checked') : c.verified ? `+${(c.liveEdgePts ?? 0).toFixed(1)}pt` : 'STALE');

export function edgeRows(m: Model, v: View, height: number): string[] {
  const ev = m.edges;
  if (!ev) return [c.gray('  press e to scan every active market for structural edges (prices that contradict each other), then check the best ones on live order books')];
  const r = ev.result;
  const busy = ev.done ? (ev.error ? c.red(`  ${ev.error}`) : '') : c.yellow(`  ${ev.stage}…`);
  const out = [clip(`${c.bold(' Edge scan')}${r ? c.gray(`  ${r.eventsScanned} events, ${r.marketsScanned} markets, ${r.candidates.length} candidate(s)  ${new Date(r.at).toISOString().slice(11, 16)}Z`) : ''}${busy}`, v.cols)];
  out.push(clip(c.gray('  structural rows before fees, every leg must fill; REF = model call, low confidence; no forecasting edge is claimed. p decide · n news · o link'), v.cols));
  const unmapped = r?.unmapped?.length ?? 0;
  if (unmapped > 0) out.push(clip(c.dim(`  ${unmappedNote(unmapped)}`), v.cols));
  const cols = layout(
    [
      { key: 'kind', head: 'TYPE', w: 7, keep: 10 },
      { key: 'live', head: 'LIVE', w: 8, align: 'right', keep: 9 },
      { key: 'scr', head: 'SCREEN', w: 8, align: 'right', keep: 4 },
      { key: 'pro', head: '$@DEPTH', w: 8, align: 'right', keep: 8 },
      { key: 'conf', head: 'CONF', w: 6, keep: 5 },
      { key: 'liq', head: 'LIQ', w: 7, align: 'right', keep: 3 },
      { key: 'ev', head: 'EVENT', w: 40, keep: 10, flex: true },
    ],
    v.cols,
  );
  out.push(headOf(cols));
  const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
  const list = r?.candidates ?? [];
  const room = Math.max(1, height - out.length);
  const start = Math.max(0, Math.min(v.sel - Math.floor(room / 2), Math.max(0, list.length - room)));
  for (const [i, x] of list.slice(start, start + room).entries()) {
    const live = edgeLive(x);
    const ref = x.kind === 'REF';
    out.push(
      rowOf(
        cols,
        {
          kind: x.confidence === 'low' ? c.yellow(fit(KIND_TEXT[x.kind], w('kind'))) : fit(KIND_TEXT[x.kind], w('kind')),
          live: ref ? c.yellow(fit(live, w('live'), 'right')) : x.verified ? c.green(c.bold(fit(live, w('live'), 'right'))) : x.verified === false ? c.red(fit(live, w('live'), 'right')) : c.gray(fit(live, w('live'), 'right')),
          scr: fit(`+${x.edgePts.toFixed(0)}pt`, w('scr'), 'right'),
          pro: x.profitUsd === null ? c.gray(fit('-', w('pro'), 'right')) : fit(`$${Math.round(x.profitUsd)}`, w('pro'), 'right'),
          conf: x.confidence === 'low' ? c.yellow(fit('low', w('conf'))) : fit(x.confidence, w('conf')),
          liq: fit(usd(x.liqMin), w('liq'), 'right'),
          ev: ref ? c.yellow(fit(x.title, w('ev'))) : fit(x.title, w('ev')),
        },
        start + i === v.sel,
      ),
    );
  }
  if (ev.done && !ev.error && list.length === 0) out.push(c.gray('  nothing structural right now. That is the normal state of an efficient market, not a bug.'));
  return out;
}

const ledgerPct = (x: number | null): string => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
const ledgerSigned = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(3)}`;

export function ledgerRows(m: Model, v: View, height: number): string[] {
  const lv = m.ledger;
  const r = lv?.report ?? null;
  const out = [clip(`${c.bold(' Paper ledger')}${r ? c.gray(`  ${r.settled}/${r.markets} logged markets settled, ${r.skippedSnapshots} lines skipped${lv ? `  scored ${new Date(lv.at).toISOString().slice(11, 16)}Z` : ''}`) : ''}${lv?.error ? c.red(`  ${lv.error}`) : ''}`, v.cols)];
  out.push(clip(c.yellow(`  ${LEDGER_STANDING}`), v.cols));
  if (!r || r.markets === 0) {
    out.push(c.gray('  no data yet: run `npm run radar -- daemon` (or forward-log, then forward-settle) to fill .radar/forward'));
    if (!r) return out;
  }
  const cols = layout(
    [
      { key: 'id', head: 'STRATEGY', w: 17, keep: 10 },
      { key: 'n', head: 'N', w: 5, align: 'right', keep: 9 },
      { key: 'hit', head: 'HIT', w: 6, align: 'right', keep: 7 },
      { key: 'be', head: 'B/E', w: 6, align: 'right', keep: 6 },
      { key: 'roi', head: 'ROI/$1', w: 7, align: 'right', keep: 8 },
      { key: 'ci', head: `${Math.round(r.ciLevel * 100)}% CI`, w: 17, keep: 5 },
      { key: 'vd', head: 'VERDICT', w: 16, keep: 9, flex: true },
    ],
    v.cols,
  );
  out.push(headOf(cols));
  const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
  const room = Math.max(1, height - out.length);
  const start = Math.max(0, Math.min(v.sel - Math.floor(room / 2), Math.max(0, r.strategies.length - room)));
  for (const [i, s] of r.strategies.slice(start, start + room).entries()) {
    const edge = s.verdict !== NO_EDGE;
    out.push(
      rowOf(
        cols,
        {
          id: fit(s.id, w('id')),
          n: fit(String(s.n), w('n'), 'right'),
          hit: fit(ledgerPct(s.hitRate), w('hit'), 'right'),
          be: c.gray(fit(ledgerPct(s.breakEven), w('be'), 'right')),
          roi: signColor(s.roi, fit(s.roi === null ? '-' : ledgerSigned(s.roi), w('roi'), 'right')),
          ci: fit(s.ci ? `[${ledgerSigned(s.ci[0])},${ledgerSigned(s.ci[1])}]` : '-', w('ci')),
          vd: edge ? c.green(c.bold(fit(s.verdict, w('vd')))) : c.gray(fit(s.verdict, w('vd'))),
        },
        start + i === v.sel,
      ),
    );
  }
  if (lv?.jumps) out.push(...jumpLedgerBlock(lv.jumps, v.cols, height - out.length));
  return out;
}

/** Second Ledger block: the calm-then-jump forward test, as formatJumps prints it (wrapped), within the rows left. */
function jumpLedgerBlock(report: JumpReport, cols: number, room: number): string[] {
  if (room < 3) return [];
  const out = ['', clip(c.bold(' Calm-then-jump forward test'), cols)];
  if (report.flags === 0) out.push(clip(c.gray('  no jump flags logged yet: the daemon logs them to .radar/forward/jumps.jsonl'), cols));
  const width = Math.max(20, cols - 4);
  for (const l of formatJumps(report)) {
    const edge = l.includes(' EDGE:');
    for (const [i, part] of wrap(l, width).entries()) {
      const text = `  ${i ? '  ' : ''}${part}`;
      out.push(clip(edge ? c.green(text) : l === report.caveat ? c.gray(text) : text, cols));
    }
  }
  return out.slice(0, room);
}

const share = (x: number | null): string => (x === null ? '-' : `${Math.round(x * 100)}%`);

export function newRows(m: Model, v: View, height: number): string[] {
  const nv = m.newMarkets;
  const sm = nv?.summary ?? null;
  const busy = !nv ? '' : nv.done ? (nv.error ? c.red(`  ${nv.error}`) : '') : c.yellow(`  ${nv.stage}…`);
  const counts = sm ? c.gray(`  ${sm.scanned} of ${sm.listed} new scanned, ${sm.flagged} flagged${sm.truncated ? `, ${sm.truncated} too busy` : ''}${sm.skipped ? `, ${sm.skipped} failed` : ''}${nv?.logged ? `, ${nv.logged.written} logged` : ''}${nv?.at ? `  ${new Date(nv.at).toISOString().slice(11, 16)}Z` : ''}`) : '';
  const out = [clip(`${c.bold(' New markets')}${counts}${busy}`, v.cols)];
  out.push(clip(c.yellow(`  ${NEW_STANDING}`), v.cols));
  if (!nv) {
    out.push(c.gray('  press w to scan markets created in the last 24h for unusual first-hour trading (one-sided flow, one wallet, young accounts)'));
    return out;
  }
  const cols = layout(
    [
      { key: 'age', head: 'AGE', w: 5, align: 'right', keep: 8 },
      { key: 'sc', head: 'SC', w: 3, align: 'right', keep: 10 },
      { key: 'vol', head: 'VOL60M', w: 7, align: 'right', keep: 9 },
      { key: 'top', head: 'TOPWAL', w: 6, align: 'right', keep: 6 },
      { key: 'na', head: 'NEWACC', w: 6, align: 'right', keep: 5 },
      { key: 'lean', head: 'LEAN', w: 12, keep: 7 },
      { key: 'mk', head: 'MARKET', w: 30, keep: 10, flex: true },
    ],
    v.cols,
  );
  out.push(headOf(cols));
  const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
  const list = flaggedNew(m);
  const nowSecs = Date.now() / 1000;
  const room = Math.max(1, height - out.length);
  const start = Math.max(0, Math.min(v.sel - Math.floor(room / 2), Math.max(0, list.length - room)));
  for (const [i, r] of list.slice(start, start + room).entries()) {
    const f = r.features;
    const lean = f.leanIdx === null ? '-' : `${r.outcomes[f.leanIdx] ?? (f.leanIdx ? 'No' : 'Yes')} ${share(f.oneSided)}`;
    out.push(
      rowOf(
        cols,
        {
          age: c.gray(fit(r.createdAt ? dur(Math.max(0, nowSecs - r.createdAt)) : '?', w('age'), 'right')),
          sc: c.bold(fit(String(r.score), w('sc'), 'right')),
          vol: fit(usd(f.usd), w('vol'), 'right'),
          top: fit(share(f.topWalletShare), w('top'), 'right'),
          na: f.newAcctShare !== null && f.newAcctShare >= NEWMARKET_THRESHOLDS.newAcctShare ? c.magenta(fit(share(f.newAcctShare), w('na'), 'right')) : fit(share(f.newAcctShare), w('na'), 'right'),
          lean: c.cyan(fit(lean, w('lean'))),
          mk: fit(r.title, w('mk')),
        },
        start + i === v.sel,
      ),
    );
  }
  if (nv.done && list.length === 0 && sm) out.push(c.gray(`  no new market crossed the flag score (${sm.scanned} scanned). Quiet first hours are the normal case.`));
  return out;
}

export function jumpRows(m: Model, v: View, height: number): string[] {
  const jv = m.jumps;
  const sc = jv?.scan ?? null;
  const busy = !jv ? '' : jv.done ? (jv.error ? c.red(`  ${jv.error}`) : '') : c.yellow(`  ${jv.stage}…`);
  const counts = sc ? c.gray(`  ${sc.markets} markets, ${sc.screened} screened, ${sc.checked} checked, ${sc.flags.length} flag(s)${sc.errors.length ? `, ${sc.errors.length} error(s)` : ''}${jv?.at ? `  ${new Date(jv.at).toISOString().slice(11, 16)}Z` : ''}`) : '';
  const out = [clip(`${c.bold(' Calm-then-jump')}${counts}${busy}`, v.cols)];
  out.push(clip(c.yellow(`  ${JUMPS_STANDING}`), v.cols));
  if (!jv) {
    out.push(c.gray('  press j to scan the busiest ~400 markets for a price jump of 15+ points in 30 minutes (calm or loose rule)'));
    return out;
  }
  const cols = layout(
    [
      { key: 'dir', head: 'DIR', w: 4, keep: 10 },
      { key: 'px', head: 'PRICE 30M', w: 11, keep: 9 },
      { key: 'rule', head: 'RULE', w: 5, keep: 5 },
      { key: 'vol', head: 'VOL30M', w: 7, align: 'right', keep: 7 },
      { key: 'fresh', head: 'FRESH', w: 5, align: 'right', keep: 4 },
      { key: 'mk', head: 'MARKET', w: 30, keep: 10, flex: true },
    ],
    v.cols,
  );
  out.push(headOf(cols));
  const w = (k: string) => cols.find((x) => x.key === k)?.w ?? 0;
  const list = jumpFlags(m);
  const room = Math.max(1, height - out.length);
  const start = Math.max(0, Math.min(v.sel - Math.floor(room / 2), Math.max(0, list.length - room)));
  for (const [i, f] of list.slice(start, start + room).entries()) {
    out.push(
      rowOf(
        cols,
        {
          dir: f.direction === 'up' ? c.green(fit('UP', w('dir'))) : c.red(fit('DOWN', w('dir'))),
          px: fit(`${f.pRef.toFixed(2)}->${f.pNow.toFixed(2)}`, w('px')),
          rule: f.calm ? c.cyan(fit('calm', w('rule'))) : c.gray(fit('loose', w('rule'))),
          vol: fit(usd(f.vol30m), w('vol'), 'right'),
          fresh: fit(share(f.freshShare), w('fresh'), 'right'),
          mk: fit(`${f.title}${f.outcomes[0] && f.outcomes[0] !== 'Yes' ? ` (${f.outcomes[0]})` : ''}`, w('mk')),
        },
        start + i === v.sel,
      ),
    );
  }
  if (jv.done && sc && list.length === 0) out.push(c.gray(`  no market jumped 15+ points in the last 30 minutes (${sc.checked} checked). That is the normal case.`));
  return out;
}

export function xrayRows(m: Model, v: View, height: number): string[] {
  const x = m.xray;
  if (!x) return [c.gray('  on Holders select a wallet and press x, or press / and paste a 0x… wallet address, to see its real record: closed AND open positions, PnL and volume, maker share')];
  const out = [clip(`${c.bold(' Wallet X-ray')}  ${c.gray(x.wallet)}${x.done ? (x.error ? c.red(`  ${x.error}`) : '') : c.yellow(`  ${x.stage}…`)}`, v.cols)];
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
  at: number | null;
}

export const newWalletRows = (m: Model): NewWalletsResult['rows'] => m.newWallets?.result?.rows ?? [];

export function walletsRows(m: Model, v: View, height: number): string[] {
  const x = m.newWallets;
  if (!x) return [c.gray('  press w: lists the markets that new accounts are putting money into right now; Enter opens a market\'s holders')];
  const r = x.result;
  const out = [clip(`${c.bold(' New wallets')}  ${x.done ? (x.error ? c.red(x.error) : '') : c.yellow(`${x.stage}…`)}${r && r.toAge ? c.yellow(`  ${r.toAge} wallets not aged yet`) : ''}`, v.cols)];
  if (!r) return out;
  if (height >= 12) out.push(clip(` ${c.gray(summarizeScan(r))}`, v.cols));
  const rows = r.rows;
  const cols = layout(
    [
      { key: 'usd', head: 'NEW$', w: 7, align: 'right', keep: 10 },
      { key: 'n', head: 'NEW', w: 4, align: 'right', keep: 9 },
      { key: 'all', head: '/ALL', w: 5, align: 'right', keep: 4 },
      { key: 'sh', head: 'SHARE', w: 5, align: 'right', keep: 6 },
      { key: 'lift', head: 'LIFT', w: 5, align: 'right', keep: 8 },
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
    const liftTxt = `x${row.lift.toFixed(1)}`;
    out.push(
      rowOf(
        cols,
        {
          usd: c.bold(fit(usdShort(row.newUsd), w('usd'), 'right')),
          n: fit(String(row.newWallets), w('n'), 'right'),
          all: fit(String(row.wallets), w('all'), 'right'),
          sh: fit(`${Math.round(row.newShare * 100)}%`, w('sh'), 'right'),
          lift: (row.lift >= 3 ? c.green : row.lift >= 1.5 ? c.yellow : (s: string) => s)(fit(liftTxt, w('lift'), 'right')),
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
    out.push(clip(` ${c.gray(`${Math.round(detail.topShare * 100)}% of the new money is the biggest wallet. LIFT = this market's new-money share vs the platform's ${(r.platformNewShare * 100).toFixed(1)}%. Enter: holders. New accounts are mostly ordinary people.`)}`, v.cols));
  }
  return out.slice(0, height);
}

export function bookRows(m: Model, v: View, height: number): string[] {
  const b = m.book;
  if (!b) return [c.gray('  press 8 on a market (Holders, Decision or Newbies row) to see its live order book; [ ] switch market')];
  const age = b.fetchedAt ? `${Math.max(0, Math.round((Date.now() - b.fetchedAt) / 1000))}s ago` : 'loading…';
  const out = [clip(`${c.bold(' Order book')}  ${b.question || b.slug}  ${b.error ? c.red(b.error) : c.gray(`updated ${age}, refreshes every 3s`)}`, v.cols)];
  if (!b.book || !b.summary) return out;
  const s = b.summary;
  out.push(clip(` ${c.gray(`${b.outcomes[0]} ${s.bid === null ? '-' : (s.bid * 100).toFixed(1)}/${s.ask === null ? '-' : (s.ask * 100).toFixed(1)}c · within 5c: ${s.bidDepthUsd >= 1000 ? `$${(s.bidDepthUsd / 1000).toFixed(1)}k` : `$${Math.round(s.bidDepthUsd)}`} bids / ${s.askDepthUsd >= 1000 ? `$${(s.askDepthUsd / 1000).toFixed(1)}k` : `$${Math.round(s.askDepthUsd)}`} asks`)}`, v.cols));
  const costs = height >= 22 ? costSummary(b.book, b.outcomes, b.feeRate) : [];
  const depth = Math.max(2, Math.floor((height - out.length - 2 - (costs.length ? costs.length + 1 : 0)) / 2));
  out.push(c.gray(`  ${(b.outcomes[0] + ' px').padStart(7)} ${(b.outcomes[1] + ' px').padStart(8)}  ${'SHARES'.padStart(10)}  ${'CUM $'.padStart(7)}`));
  const lines = ladder(b.book, b.outcomes, depth);
  for (const l of lines) {
    const bar = '█'.repeat(Math.round(l.frac * 18));
    out.push(clip(l.side === 'spread' ? `  ${c.yellow(l.text)}` : `  ${l.side === 'ask' ? c.red(l.text) : c.green(l.text)} ${l.side === 'ask' ? c.red(bar) : c.green(bar)}`, v.cols));
  }
  if (costs.length) {
    out.push(c.gray(`  cost of a trade (taker fee ${(b.feeRate * 100).toFixed(0)}% x p x (1-p), estimated from tags):`));
    for (const l of costs) out.push(clip(`  ${l}`, v.cols));
  }
  return out.slice(0, height);
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
    const age = accountAge(r.createdAt, Date.now() / 1000);
    out.push(line(`  profile created ${age.label}${age.isNew ? c.magenta(c.bold('  NEW ACCOUNT')) : ''}${r.xUsername ? `  linked X @${r.xUsername}` : ''}`));
    for (const mt of r.matches ?? []) out.push(line(`  ${c.yellow('≈')} ${mt.why}; the watchlist has ${mt.person.name}${mt.person.org ? ` (${mt.person.org})` : ''}. Name match only, unverified (${mt.kind} ${mt.score})`));
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
  if (v.tab === 'edge') {
    const x = m.edges?.result?.candidates[v.sel];
    if (!x) return [];
    const out = [line(`${c.bold(x.title)}  ${c.gray(`polymarket.com/event/${x.slug}`)}`)];
    out.push(line(`  ${x.legs.map((l) => `${l.action} "${l.label}" @${l.price.toFixed(3)}`).join('  +  ')}`));
    if (x.kind === 'REF') out.push(line(`  ${c.yellow('model call, low confidence:')} fair range edge $${x.payoff.toFixed(2)} for $${x.cost.toFixed(3)} (${x.edgePts.toFixed(1)}pt, NOT guaranteed)${x.depthUsd !== null ? `, ${usd(x.depthUsd)} at the top of the book` : ''}`));
    else out.push(line(`  pays at least $${x.payoff.toFixed(2)} for $${x.cost.toFixed(3)} (screen ${x.edgePts.toFixed(1)}pt)${x.verified !== null && x.liveEdgePts !== null ? `; live books ${x.liveEdgePts.toFixed(1)}pt, ${usd(x.depthUsd)} of depth, ~${usd(x.profitUsd)} profit at that size` : ''}`));
    if (x.note) out.push(line(`  ${c.yellow('!')} ${x.note}`));
    for (const cv of x.caveats) out.push(line(`  ${c.gray('·')} ${cv}`));
    return out;
  }
  if (v.tab === 'new') {
    const r = flaggedNew(m)[v.sel];
    if (!r) return [];
    const f = r.features;
    const out = [line(`${c.bold(r.title)}  ${c.gray(`polymarket.com/event/${r.eventSlug}`)}`)];
    for (const why of r.reasons) out.push(line(`  ${c.cyan('·')} ${why}`));
    out.push(line(`  first ${dur(f.windowSecs)}${f.windowComplete ? '' : ' (window still open)'}: ${f.fills} taker fills, ${f.wallets} wallets, ${usd(f.usd)}; price ${f.firstPrice === null ? '-' : f.firstPrice.toFixed(2)} -> ${f.lastPrice === null ? '-' : f.lastPrice.toFixed(2)}; ages known for ${share(f.ageCoverage)} of volume`));
    out.push(line(c.gray('  p decide · n news · o link. Labels describe trading behavior, not who traded or why.')));
    return out;
  }
  if (v.tab === 'jumps') {
    const f = jumpFlags(m)[v.sel];
    if (!f) return [];
    const q = f.quotes.map((x) => `${x.outcome} ${px2(x.bid)}/${px2(x.ask)}`).join('  ');
    return [
      line(`${c.bold(f.title)}  ${c.gray(`polymarket.com/event/${f.eventSlug}`)}`),
      line(`  ${f.outcomes[0]} ${f.direction} ${f.pRef.toFixed(3)} -> ${f.pNow.toFixed(3)} (${f.move >= 0 ? '+' : ''}${(f.move * 100).toFixed(1)} pts in 30 min); ${f.calm ? 'calm rule' : 'loose rule only'}: prior 24h range ${(f.calmRange * 100).toFixed(1)} pts over ${f.calmPoints} points`),
      line(`  taker volume 30m ${usd(f.vol30m)}, fresh-wallet share ${share(f.freshShare)}; books at detection: ${q}`),
      line(c.gray(`  p decide · n news · o link. ${JUMPS_STANDING}: scored only by the forward test (jumps-score, Ledger tab)`)),
    ];
  }
  if (v.tab === 'ledger') {
    const r = m.ledger?.report;
    const s = r?.strategies[v.sel];
    if (!r || !s) return [];
    return [
      line(`${c.bold(s.id)}  ${s.description}`),
      line(`  n=${s.n} bets on ${s.events} events over ${s.days} days, ${s.wins} wins, ${s.voids} voids; fill = T-5m ask, return = payout/ask - 1`),
      line(`  hit rate is read against break-even (mean fill price), never alone. Verdict needs n>=${r.minBets} and the ${Math.round(r.ciLevel * 100)}% day-clustered bootstrap CI above 0 (${r.iterations} resamples, seed ${r.seed})`),
      line(c.gray('  strategies are fixed in radar/ledger.ts before the data; tuning them on these logs voids the test')),
    ];
  }
  if (v.tab === 'news') {
    const h = m.news?.hits[v.sel];
    if (!h) return m.news?.rules ? [line(c.gray(`  rules: ${m.news.rules.slice(0, Math.max(40, width * 3))}`))] : [];
    return [line(c.bold(h.title)), line(`  ${h.source || '?'}  ${h.publishedAt === null ? 'undated' : new Date(h.publishedAt).toISOString().slice(0, 16).replace('T', ' ') + 'Z'}  via ${h.via}`), line(`  ${c.gray(h.url)}`), line(c.gray('  o shows the link in the footer · p decide · h holders'))];
  }
  if (v.tab === 'decision') return [];
  if (v.tab === 'search') {
    const r = m.search?.results[v.sel];
    return r ? [line(`${c.bold(r.title)}  ${c.gray(`polymarket.com/event/${r.slug}`)}`), line(c.gray('  p decide · h holders · o link'))] : [];
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
  const tabBar = ' ' + [...MAIN_TABS, ...(LABS.includes(v.tab) ? [v.tab] : [])].map((t) => (t === v.tab ? c.inverse(` ${TAB_LABEL[t]} `) : c.gray(` ${TAB_LABEL[t]} `))).join('');
  // the counters and the labs hint only fit when there is room: the tabs themselves always win
  const extras = c.gray(`${LABS.includes(v.tab) ? '' : ''}   ${[...m.anomalies, ...m.games].filter((a) => a.level === 'HOT').length} hot · ${[...m.anomalies, ...m.games].filter((a) => a.level === 'WATCH').length} watch`) + (m.filter ? c.yellow(`   filter: ${m.filter}`) : '');
  const tabs = clip(vlen(tabBar) + vlen(extras) <= cols ? tabBar + extras : tabBar, cols);
  const detailH = rows >= 30 && v.tab !== 'decision' ? 8 : 0;
  const bodyH = Math.max(3, rows - 3 - detailH - (detailH ? 1 : 0));
  const body = (v.tab === 'anomalies' ? anomalyRows(m, v, bodyH) : v.tab === 'games' ? gameRows(m, v, bodyH) : v.tab === 'prints' ? printRows(m, v, bodyH) : v.tab === 'holders' ? holderRows(m, v, bodyH) : v.tab === 'decision' ? decisionRows(m, v, bodyH) : v.tab === 'search' ? searchRows(m, v, bodyH) : v.tab === 'news' ? newsRows(m, v, bodyH) : v.tab === 'edge' ? edgeRows(m, v, bodyH) : v.tab === 'ledger' ? ledgerRows(m, v, bodyH) : v.tab === 'new' ? newRows(m, v, bodyH) : v.tab === 'jumps' ? jumpRows(m, v, bodyH) : v.tab === 'xray' ? xrayRows(m, v, bodyH) : v.tab === 'wallets' ? walletsRows(m, v, bodyH) : v.tab === 'book' ? bookRows(m, v, bodyH) : leadRows(m, v, bodyH)).map((l) => clip(l, cols));
  const lines = [header, tabs, ...body];
  while (lines.length < 2 + bodyH) lines.push('');
  if (detailH) {
    lines.push(c.gray('─'.repeat(cols)));
    const d = detailLines(m, v, cols - 1);
    for (let i = 0; i < detailH; i++) lines.push(d[i] ?? '');
  }
  while (lines.length < rows - 1) lines.push('');
  const hint = c.gray(' ↑↓ move · 1-8 tabs · 8 order book · h holders (on 5: the selected row) · p decision · w newbies · x x-ray · a watch wallet · / search (or paste a 0x wallet) · enter open · f category · b bots · o link · r refresh · q quit');
  // the status message goes first: the key hint is long and would push a trailing message off a narrow screen
  lines.push(clip(s.message ? `${c.yellow(` ${s.message}`)}  ${hint}` : hint, cols));
  return lines.slice(0, rows).map((l) => (vlen(l) > cols ? clip(l, cols) : l));
}

export type Key = 'up' | 'down' | 'pageup' | 'pagedown' | 'home' | 'end' | 'tab' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '0' | 'w' | 'j' | 'x' | 'u';
export function listLength(m: Model, tab: Tab): number {
  return tab === 'anomalies' ? m.anomalies.length : tab === 'games' ? m.games.length : tab === 'prints' ? m.prints.length : tab === 'holders' ? visibleHolders(m).length : tab === 'decision' ? (m.decision?.decision?.markets.length ?? 0) : tab === 'search' ? (m.search?.results.length ?? 0) : tab === 'news' ? (m.news?.hits.length ?? 0) : tab === 'edge' ? (m.edges?.result?.candidates.length ?? 0) : tab === 'ledger' ? (m.ledger?.report?.strategies.length ?? 0) : tab === 'new' ? flaggedNew(m).length : tab === 'jumps' ? jumpFlags(m).length : tab === 'xray' ? 0 : tab === 'wallets' ? newWalletRows(m).length : tab === 'book' ? 0 : m.leads.length;
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
    default: return v;
  }
}
