import { decide, type Decision, type DMarket, type DWallet, type Reference } from './decide.ts';
import { marketFlow, type MarketFlow } from './flow.ts';
import { profileWallet } from './holders.ts';
import { identityFor } from './identity.ts';
import { matchPeople, type Person } from './people.ts';
import { httpFetchJson, type Book, type FetchJson, type PolymarketClient } from './polymarket.ts';
import { fetchDexReference, refFor, type RefConfig } from './refs.ts';
import type { RadarStore } from './store.ts';

/**
 * Gathers everything the decision needs for one event and rebuilds the decision as data arrives:
 * quotes and books first (a first answer in a couple of seconds), then trades and flow, then wallet-by-wallet identity.
 */

export interface DecisionView {
  slug: string;
  title: string;
  stage: string;
  progress: { loaded: number; total: number };
  done: boolean;
  error: string | null;
  decision: Decision | null;
  /** Every wallet profiled, by market id. */
  wallets: Record<string, DWallet[]>;
}

export interface DecisionLoadOptions {
  now?: () => number;
  people?: readonly Person[];
  refs?: readonly RefConfig[];
  fetchJson?: FetchJson;
  /** Markets of the event to quote (busiest first). */
  maxMarkets?: number;
  /** Markets whose trades and wallets are read (busiest first). */
  flowMarkets?: number;
  walletsPerMarket?: number;
  concurrency?: number;
  /** Pause before the one retry of a failed reference read. */
  retryDelayMs?: number;
  onProgress?: (v: DecisionView) => void;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const json = <T>(v: unknown, fallback: T): T => {
  if (Array.isArray(v)) return v as T;
  try {
    return typeof v === 'string' ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
};

const DEPTH_BAND = 0.03;
export function bookQuote(b: Book): { bid: number | null; ask: number | null; bidDepthSh: number; askDepthSh: number } {
  const bid = b.bids[0]?.price ?? null;
  const ask = b.asks[0]?.price ?? null;
  return {
    bid,
    ask,
    bidDepthSh: bid === null ? 0 : b.bids.filter((l) => l.price >= bid - DEPTH_BAND).reduce((a, l) => a + l.size, 0),
    askDepthSh: ask === null ? 0 : b.asks.filter((l) => l.price <= ask + DEPTH_BAND).reduce((a, l) => a + l.size, 0),
  };
}

async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export async function loadDecision(client: PolymarketClient, store: RadarStore, slug: string, opts: DecisionLoadOptions = {}): Promise<DecisionView> {
  const now = opts.now ?? Date.now;
  const secs = () => Math.floor(now() / 1000);
  const people = opts.people ?? [];
  const view: DecisionView = { slug, title: slug, stage: 'reading the event', progress: { loaded: 0, total: 0 }, done: false, error: null, decision: null, wallets: {} };
  const emit = () => opts.onProgress?.({ ...view, wallets: { ...view.wallets } });
  try {
    const raw = await client.eventRaw(slug);
    if (!raw) throw new Error(`event not found: ${slug}`);
    view.title = String(raw.title ?? slug);
    const event = { slug, title: view.title, description: String(raw.description ?? '') };
    const rows = ((raw.markets ?? []) as Array<Record<string, any>>).filter((m) => m.conditionId);
    const live = rows.filter((m) => !m.closed).sort((a, b) => (num(b.volume24hr) ?? 0) - (num(a.volume24hr) ?? 0));
    const chosen = (live.length ? live : rows).slice(0, opts.maxMarkets ?? 10);
    // keep ladder order stable for display: ascending by the label as the API lists them
    const markets: DMarket[] = chosen.map((m) => ({
      cid: String(m.conditionId), label: String(m.groupItemTitle || m.question || ''), question: String(m.question ?? ''), outcomes: json<string[]>(m.outcomes, ['Yes', 'No']).map(String), closed: Boolean(m.closed),
      yesBid: num(m.bestBid), yesAsk: num(m.bestAsk), last: num(m.lastTradePrice), askDepthSh: null, bidDepthSh: null, liq: num(m.liquidityNum) ?? num(m.liquidity) ?? 0, vol24: num(m.volume24hr) ?? 0,
    }));
    const tokens = new Map(chosen.map((m) => [String(m.conditionId), json<string[]>(m.clobTokenIds, [])[0]]));
    view.progress = { loaded: 0, total: markets.length };
    view.stage = 'reading order books';
    emit();

    // Executable prices and depth from the real book (gamma's best bid/ask can lag).
    await pool(markets, opts.concurrency ?? 3, async (m) => {
      const token = tokens.get(m.cid);
      try {
        if (token) {
          const q = bookQuote(await client.book(token));
          m.yesBid = q.bid;
          m.yesAsk = q.ask;
          m.bidDepthSh = q.bidDepthSh;
          m.askDepthSh = q.askDepthSh;
        }
      } catch {
        // keep gamma's quote
      }
      view.progress.loaded++;
    });

    let reference: Reference | null = null;
    let referenceError: string | null = null;
    const cfg = refFor(slug, opts.refs ?? []);
    if (cfg) {
      view.stage = 'reading the reference price';
      emit();
      for (let attempt = 0; attempt < 2 && !reference; attempt++) {
        try {
          reference = await fetchDexReference(opts.fetchJson ?? httpFetchJson, cfg, view.title, secs());
          referenceError = reference ? null : 'no pool with liquidity was found for the configured mint';
        } catch (error) {
          referenceError = error instanceof Error ? error.message : String(error);
        }
        if (!reference && attempt === 0) await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 700));
      }
    }

    const flows: Record<string, MarketFlow | undefined> = {};
    const rebuild = () => {
      view.decision = decide({ event, markets, flows, wallets: view.wallets, reference, referenceError, now: secs() });
    };
    rebuild();
    emit();

    // Who is trading: the busiest markets only, to stay polite with the API.
    const focus = markets.filter((m) => !m.closed).slice(0, opts.flowMarkets ?? 2);
    for (const m of focus) {
      view.stage = `reading trades: ${m.label}`;
      emit();
      let flow: MarketFlow | undefined;
      try {
        flow = marketFlow(await client.marketTrades(m.cid, { maxFills: 4_000 }), secs());
        flows[m.cid] = flow;
      } catch (error) {
        view.error = `trades failed for ${m.label}: ${error instanceof Error ? error.message : String(error)}`;
      }
      rebuild();
      emit();

      const cands = new Map<string, { name: string | null; side: 0 | 1; shares: number }>();
      try {
        const per = new Map<number, number>();
        for (const h of await client.holders(m.cid, 20)) {
          const n = per.get(h.outcomeIndex) ?? 0;
          per.set(h.outcomeIndex, n + 1);
          if (n < 6 && (h.outcomeIndex === 0 || h.outcomeIndex === 1)) cands.set(h.wallet, { name: h.name, side: h.outcomeIndex, shares: h.shares });
        }
      } catch (error) {
        view.error = `holders failed for ${m.label}: ${error instanceof Error ? error.message : String(error)}`;
      }
      for (const n of [...(flow?.topYes.slice(0, 3) ?? []), ...(flow?.topNo.slice(0, 3) ?? [])]) {
        if (!cands.has(n.wallet)) cands.set(n.wallet, { name: null, side: n.netShares > 0 ? 0 : 1, shares: Math.abs(n.netShares) });
      }
      const picked = [...cands.entries()].slice(0, opts.walletsPerMarket ?? 16);
      view.progress = { loaded: 0, total: picked.length };
      view.stage = `profiling ${picked.length} wallets: ${m.label}`;
      emit();
      view.wallets[m.cid] = [];
      await pool(picked, opts.concurrency ?? 3, async ([wallet, c]) => {
        try {
          const [profile, identity, positions] = await Promise.all([
            profileWallet(client, store, wallet, now, 12 * 3_600, c.name),
            identityFor(client, store, wallet, now),
            client.positions(wallet, m.cid).catch(() => []),
          ]);
          const pos = positions.find((p) => p.outcomeIndex === c.side);
          const display = identity?.name ?? profile.name ?? c.name;
          (view.wallets[m.cid] as DWallet[]).push({
            wallet, name: display, side: c.side, shares: pos?.size ?? c.shares, posUsd: pos?.currentValue ?? null, createdAt: identity?.createdAt ?? null, cls: profile.cls, traded: profile.traded, pnlAll: profile.pnlAll,
            xUsername: identity?.xUsername ?? null,
            matches: matchPeople({ name: identity?.name ?? display, pseudonym: identity?.pseudonym ?? null, xUsername: identity?.xUsername ?? null, bio: identity?.bio ?? null }, people),
          });
        } catch (error) {
          view.error = error instanceof Error ? error.message : String(error);
        }
        view.progress.loaded++;
        (view.wallets[m.cid] as DWallet[]).sort((a, b) => (b.posUsd ?? 0) - (a.posUsd ?? 0));
        rebuild();
        emit();
      });
    }
    view.stage = 'done';
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
    view.stage = 'failed';
  }
  view.done = true;
  emit();
  return view;
}
