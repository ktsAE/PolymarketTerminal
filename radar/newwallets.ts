import { accountAge, identityFor } from './identity.ts';
import type { GlobalTrade, PolymarketClient } from './polymarket.ts';
import type { RadarStore } from './store.ts';

/**
 * Which markets are getting money from NEW wallets right now.
 * Reads every fill on the platform for the last N minutes, looks up how old each trading wallet's profile is (cached for good once known), and ranks markets by the dollars
 * that new accounts put in. A market is compared with the platform: new accounts are always part of the crowd, so the "lift" says how much more new money a market got than
 * the platform's average share, which is the part that is not just normal newcomer traffic.
 * It describes who is trading, not why. Most new accounts are ordinary people, sign-up promotions and referral waves.
 */

export interface NewWalletEntry {
  wallet: string;
  name: string | null;
  ageDays: number;
  /** Dollars traded by the wallet in this market in the window (buys and sells). */
  usd: number;
  /** Net direction: the outcome it leaned to (bought, or sold the other one), with the dollars. */
  leanOutcome: string;
  trades: number;
}

export interface NewMarketRow {
  cid: string;
  eventSlug: string;
  question: string;
  /** Distinct wallets in the window whose age is known. */
  wallets: number;
  newWallets: number;
  /** Dollars traded by wallets whose age is known / by the new ones. */
  knownUsd: number;
  newUsd: number;
  newShare: number;
  /** newShare divided by the platform-wide new-wallet share of money. */
  lift: number;
  /** Outcome the new money leaned to, and the share of new money on it. */
  lean: { outcome: string; share: number } | null;
  /** Share of the new money that came from the single biggest new wallet. */
  topShare: number;
  top: NewWalletEntry[];
}

export interface NewWalletsResult {
  rows: NewMarketRow[];
  windowMins: number;
  maxAgeDays: number;
  trades: number;
  markets: number;
  wallets: number;
  /** Wallets whose age is known / that still have to be looked up (progress). */
  aged: number;
  toAge: number;
  /** Share of the money traded by wallets with a known age. */
  coverage: number;
  /** Platform-wide share of the money that came from new wallets. */
  platformNewShare: number;
  newWalletsTotal: number;
}

export interface AggregateOptions {
  maxAgeDays?: number;
  minNewWallets?: number;
  minNewUsd?: number;
  /** Wallets under this much traded in the window are not aged at all. */
  minWalletUsd?: number;
  top?: number;
}

const usdOf = (t: { size: number; price: number }): number => t.size * t.price;
/** Outcome a fill leans to: buying outcome i or selling the other one. */
const leanIndex = (t: GlobalTrade): number => (t.side === 'BUY' ? t.outcomeIndex : 1 - t.outcomeIndex);

/** Name of outcome `i`; when only the other outcome appeared in the fills (a sell), say so instead of guessing. */
export const labelOf = (labels: ReadonlyMap<number, string>, i: number): string => labels.get(i) ?? (labels.get(1 - i) ? `not ${labels.get(1 - i)}` : `#${i}`);

/** `createdAt` maps a wallet to its profile creation time (epoch seconds), or null when it has no profile; wallets absent from the map are not aged yet. */
export function aggregateNewWallets(trades: readonly GlobalTrade[], createdAt: ReadonlyMap<string, number | null>, nowSecs: number, windowMins: number, opts: AggregateOptions = {}): NewWalletsResult {
  const maxAge = opts.maxAgeDays ?? 14;
  const isNew = (w: string): number | null => {
    const c = createdAt.get(w);
    if (c === null || c === undefined) return null;
    const a = accountAge(c, nowSecs);
    return a.days !== null && a.days < maxAge ? a.days : null;
  };
  interface MarketAcc {
    cid: string;
    eventSlug: string;
    question: string;
    all: Set<string>;
    knownUsd: number;
    labels: Map<number, string>;
    byWallet: Map<string, { name: string | null; usd: number; lean: Map<number, number>; trades: number }>;
  }
  const markets = new Map<string, MarketAcc>();
  let totalUsd = 0;
  let knownUsd = 0;
  let newUsd = 0;
  const wallets = new Set<string>();
  const newWallets = new Set<string>();
  const knownWallets = new Set<string>();
  for (const t of trades) {
    const usd = usdOf(t);
    totalUsd += usd;
    wallets.add(t.wallet);
    const known = createdAt.has(t.wallet) && createdAt.get(t.wallet) !== null;
    const age = isNew(t.wallet);
    if (known) {
      knownUsd += usd;
      knownWallets.add(t.wallet);
    }
    const m = markets.get(t.cid) ?? { cid: t.cid, eventSlug: t.eventSlug, question: t.title, all: new Set<string>(), knownUsd: 0, labels: new Map<number, string>(), byWallet: new Map() };
    markets.set(t.cid, m);
    if (t.outcome) m.labels.set(t.outcomeIndex, t.outcome);
    if (known) {
      m.all.add(t.wallet);
      m.knownUsd += usd;
    }
    if (age !== null) {
      newUsd += usd;
      newWallets.add(t.wallet);
      const w = m.byWallet.get(t.wallet) ?? { name: t.name, usd: 0, lean: new Map<number, number>(), trades: 0 };
      w.usd += usd;
      w.trades++;
      w.lean.set(leanIndex(t), (w.lean.get(leanIndex(t)) ?? 0) + usd);
      m.byWallet.set(t.wallet, w);
    }
  }
  const platformShare = knownUsd > 0 ? newUsd / knownUsd : 0;
  const rows: NewMarketRow[] = [];
  for (const m of markets.values()) {
    if (m.byWallet.size < (opts.minNewWallets ?? 3)) continue;
    const entries = [...m.byWallet.entries()].map(([wallet, w]): NewWalletEntry => {
      const best = [...w.lean.entries()].sort((a, b) => b[1] - a[1])[0];
      return { wallet, name: w.name, ageDays: accountAge(createdAt.get(wallet) as number, nowSecs).days ?? 0, usd: w.usd, leanOutcome: labelOf(m.labels, best?.[0] ?? 0), trades: w.trades };
    });
    const mNewUsd = entries.reduce((a, e) => a + e.usd, 0);
    if (mNewUsd < (opts.minNewUsd ?? 100)) continue;
    const leanTotals = new Map<number, number>();
    for (const w of m.byWallet.values()) for (const [i, u] of w.lean) leanTotals.set(i, (leanTotals.get(i) ?? 0) + u);
    const leanBest = [...leanTotals.entries()].sort((a, b) => b[1] - a[1])[0];
    const share = m.knownUsd > 0 ? mNewUsd / m.knownUsd : 0;
    entries.sort((a, b) => b.usd - a.usd);
    rows.push({
      cid: m.cid, eventSlug: m.eventSlug, question: m.question, wallets: m.all.size, newWallets: m.byWallet.size, knownUsd: m.knownUsd, newUsd: mNewUsd, newShare: share,
      lift: platformShare > 0 ? share / platformShare : 0, lean: leanBest ? { outcome: labelOf(m.labels, leanBest[0]), share: leanBest[1] / mNewUsd } : null,
      topShare: entries[0] ? entries[0].usd / mNewUsd : 0, top: entries.slice(0, opts.top ?? 8),
    });
  }
  rows.sort((a, b) => b.newUsd - a.newUsd);
  const toAge = [...wallets].filter((w) => !createdAt.has(w)).length;
  return {
    rows, windowMins, maxAgeDays: maxAge, trades: trades.length, markets: markets.size, wallets: wallets.size, aged: wallets.size - toAge, toAge,
    coverage: totalUsd > 0 ? knownUsd / totalUsd : 0, platformNewShare: platformShare, newWalletsTotal: newWallets.size,
  };
}

export interface ScanOptions extends AggregateOptions {
  windowMins?: number;
  maxPages?: number;
  concurrency?: number;
  now?: () => number;
  cancelled?: () => boolean;
  onProgress?: (stage: string, partial: NewWalletsResult | null) => void;
}

/** Fetches the window's fills, ages the wallets (cache first), and aggregates; reports partial results while the lookups run. Never throws: errors come back in `error`. */
export async function scanNewWallets(client: PolymarketClient, store: RadarStore, opts: ScanOptions = {}): Promise<{ result: NewWalletsResult | null; error: string | null }> {
  const now = opts.now ?? Date.now;
  const windowMins = opts.windowMins ?? 30;
  try {
    const nowSecs = Math.floor(now() / 1000);
    opts.onProgress?.('reading the last trades on the platform', null);
    const trades = await client.globalTrades({ sinceTs: nowSecs - windowMins * 60, maxPages: opts.maxPages ?? 60, onPage: (p, n) => opts.onProgress?.(`reading trades: page ${p}, ${n.toLocaleString('en-US')} fills`, null) });
    const spent = new Map<string, number>();
    for (const t of trades) spent.set(t.wallet, (spent.get(t.wallet) ?? 0) + usdOf(t));
    const created = new Map<string, number | null>();
    const todo: string[] = [];
    const minUsd = opts.minWalletUsd ?? 25;
    for (const [wallet, usd] of spent) {
      if (usd < minUsd) continue;
      const id = store.getIdentity(wallet);
      if (id && id.createdAt !== null) created.set(wallet, id.createdAt); // a creation date never changes: cached for good
      else if (id && nowSecs - id.fetchedAt < 86_400) created.set(wallet, null); // looked up today and has no profile
      else todo.push(wallet);
    }
    todo.sort((a, b) => (spent.get(b) ?? 0) - (spent.get(a) ?? 0));
    const partial = () => aggregateNewWallets(trades, created, nowSecs, windowMins, opts);
    opts.onProgress?.(`looking up wallet ages: 0/${todo.length.toLocaleString('en-US')} (${created.size.toLocaleString('en-US')} cached)`, partial());
    let next = 0;
    let doneN = 0;
    const startedAt = now();
    const worker = async () => {
      while (!opts.cancelled?.()) {
        const w = todo[next++];
        if (w === undefined) return;
        const id = await identityFor(client, store, w, now);
        created.set(w, id?.createdAt ?? null);
        if (++doneN % 10 === 0 && doneN < todo.length) opts.onProgress?.(`looking up wallet ages: ${doneN}/${todo.length}, ${etaText(((now() - startedAt) / 1000 / doneN) * (todo.length - doneN))}`, partial());
      }
    };
    await Promise.all(Array.from({ length: opts.concurrency ?? 10 }, worker));
    const result = partial();
    opts.onProgress?.('done', result);
    return { result, error: null };
  } catch (error) {
    return { result: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const usd0 = (x: number): string => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${Math.round(x)}`);

/** One-line summary of a scan for the tab header. */
export function summarizeScan(r: NewWalletsResult): string {
  return `last ${r.windowMins} min: ${r.trades.toLocaleString('en-US')} fills, ${r.markets.toLocaleString('en-US')} markets, ${r.wallets.toLocaleString('en-US')} wallets (age known for ${Math.round(r.coverage * 100)}% of the money) · accounts under ${r.maxAgeDays} days put in ${(r.platformNewShare * 100).toFixed(1)}% of it, ${r.newWalletsTotal.toLocaleString('en-US')} wallets`;
}

export const usdShort = usd0;

/** "~2m left" style estimate for a progress line. */
export function etaText(secs: number): string {
  if (!Number.isFinite(secs) || secs < 0) return 'ETA unknown';
  if (secs < 5) return 'a few seconds left';
  if (secs < 90) return `~${Math.round(secs)}s left`;
  return `~${Math.round(secs / 60)}m left`;
}

/** The standing line for every place that shows this screener (the TUI tab and the `newbies` command). */
export const NEWBIES_CAVEAT = 'new accounts are mostly ordinary people; not evidence of wrongdoing';
export const SMALL_SAMPLE_WALLETS = 5;
export const SMALL_SAMPLE_USD = 500;
export const SMALL_SAMPLE_NOTE = `* small sample (under ${SMALL_SAMPLE_WALLETS} new wallets or under $${SMALL_SAMPLE_USD} of new money): LIFT is not meaningful`;
export const isSmallSample = (row: Pick<NewMarketRow, 'newWallets' | 'newUsd'>): boolean => row.newWallets < SMALL_SAMPLE_WALLETS || row.newUsd < SMALL_SAMPLE_USD;
/** LIFT as shown to the user: a trailing `*` marks a small sample. */
export const liftText = (row: Pick<NewMarketRow, 'lift' | 'newWallets' | 'newUsd'>): string => `x${row.lift.toFixed(1)}${isSmallSample(row) ? '*' : ''}`;
/** What "new" means here, and how much of the money it covers. */
export const coverageNote = (r: Pick<NewWalletsResult, 'coverage' | 'maxAgeDays'>): string => `age known for ${Math.round(r.coverage * 100)}% of the money; "new" = profile created under ${r.maxAgeDays} days ago, not a funding trace`;
/** Lines the CLI `newbies` command should print under the summary: the caveat always, the small-sample note when a listed row has one. */
export function newbiesNotes(r: NewWalletsResult, shown: readonly NewMarketRow[] = r.rows): string[] {
  return [NEWBIES_CAVEAT, ...(shown.some(isSmallSample) ? [SMALL_SAMPLE_NOTE] : []), coverageNote(r)];
}

/** The whole `newbies` command output under the scan line: caveat notes, header, one line per shown market. */
export function newbiesLines(r: NewWalletsResult, top: number): string[] {
  const shown = r.rows.slice(0, top);
  return [
    ...newbiesNotes(r, shown),
    `${'NEW$'.padStart(8)} ${'NEW'.padStart(4)} ${'/ALL'.padStart(5)} ${'SHARE'.padStart(6)} ${'LIFT'.padStart(6)}  LEANS TO              MARKET`,
    ...shown.map((x) => `${usd0(x.newUsd).padStart(8)} ${String(x.newWallets).padStart(4)} ${String(x.wallets).padStart(5)} ${(x.newShare * 100).toFixed(0).padStart(5)}% ${liftText(x).padStart(6)}  ${(x.lean ? `${x.lean.outcome.slice(0, 14)} ${Math.round(x.lean.share * 100)}%` : '-').padEnd(20)}  ${x.question.slice(0, 60)}  [${x.eventSlug}]`),
  ];
}
