import { identityFor } from './identity.ts';
import { matchPeople, type NameMatch, type Person } from './people.ts';
import { classifyWallet, isPerson, summarizeActivity, type WalletClass } from './profile.ts';
import type { PolymarketClient } from './polymarket.ts';
import type { HolderProfile, RadarStore } from './store.ts';

/**
 * Top holders of a market with their PnL, and whether each looks like a person or automation.
 * Profiles are cached (12h): a wallet's character changes slowly, its position does not.
 */

export interface HolderRow {
  wallet: string;
  name: string | null;
  outcomeIndex: number;
  outcome: string;
  shares: number;
  avgPrice: number | null;
  curPrice: number | null;
  posUsd: number | null;
  /** Unrealized PnL on this position. */
  uPnl: number | null;
  pnlAll: number | null;
  pnlWeek: number | null;
  vol: number | null;
  traded: number | null;
  ageDays: number | null;
  perDay: number | null;
  cls: WalletClass;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  /** Things worth knowing about this position specifically (e.g. shares that were never bought). */
  flags: string[];
  /** When the wallet's Polymarket profile was created (epoch seconds), and its linked X handle, from the public profile. */
  createdAt?: number | null;
  xUsername?: string | null;
  /** Watchlist names this profile resembles (a lead, never an identification). */
  matches?: NameMatch[];
}

export interface HoldersView {
  slug: string;
  eventTitle: string;
  question: string;
  cid: string;
  rows: HolderRow[];
  /** Wallets to profile in total, and how many are done. */
  total: number;
  loaded: number;
  done: boolean;
  error: string | null;
}

export interface LoadOptions {
  perSide?: number;
  concurrency?: number;
  maxAgeSecs?: number;
  now?: () => number;
  onProgress?: (view: HoldersView) => void;
  /** Watchlist to compare each holder's profile against. */
  people?: readonly Person[];
}

export async function profileWallet(client: PolymarketClient, store: RadarStore, wallet: string, now: () => number, maxAgeSecs: number, name: string | null): Promise<HolderProfile> {
  const cached = store.getHolderProfile(wallet);
  const nowSecs = Math.floor(now() / 1000);
  if (cached && nowSecs - cached.fetchedAt < maxAgeSecs) return cached;
  const [recs, first, traded, all, week] = await Promise.all([
    client.activityRecords(wallet, 500),
    client.firstActivityTs(wallet),
    client.marketsTraded(wallet),
    client.leaderboard(wallet, 'all'),
    client.leaderboard(wallet, 'week'),
  ]);
  const ageDays = first !== null ? Math.max(0, (nowSecs - first) / 86_400) : null;
  const summary = summarizeActivity(recs);
  const c = classifyWallet(summary, { traded, vol: all?.vol ?? null, ageDays });
  const profile: HolderProfile = {
    wallet, fetchedAt: nowSecs, name: name ?? all?.name ?? null, cls: c.cls, confidence: c.confidence, reasons: c.reasons, perDay: summary.events > 0 ? summary.perDay : null,
    traded, vol: all?.vol ?? null, ageDays, pnlAll: all?.pnl ?? null, pnlWeek: week?.pnl ?? null,
  };
  store.upsertHolderProfile(profile);
  return profile;
}

async function pool<T>(items: readonly T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(size, items.length)) }, async () => {
      while (next < items.length) await fn(items[next++]);
    }),
  );
}

export async function loadHolders(client: PolymarketClient, store: RadarStore, slug: string, opts: LoadOptions = {}): Promise<HoldersView> {
  const now = opts.now ?? Date.now;
  const view: HoldersView = { slug, eventTitle: slug, question: '', cid: '', rows: [], total: 0, loaded: 0, done: false, error: null };
  const emit = () => opts.onProgress?.({ ...view, rows: [...view.rows] });
  try {
    const event = await client.eventBySlug(slug);
    if (!event) throw new Error(`event not found: ${slug}`);
    view.eventTitle = event.title;
    const market = [...event.markets].filter((m) => !m.closed).sort((a, b) => b.volume - a.volume)[0] ?? event.markets[0];
    if (!market) throw new Error('event has no markets');
    view.question = market.question;
    view.cid = market.cid;
    const holders = await client.holders(market.cid, 20);
    const perSide = opts.perSide ?? 12;
    const taken = new Map<number, number>();
    const picked = holders.filter((h) => {
      const n = taken.get(h.outcomeIndex) ?? 0;
      taken.set(h.outcomeIndex, n + 1);
      return n < perSide;
    });
    view.total = picked.length;
    emit();
    await pool(picked, opts.concurrency ?? 3, async (h) => {
      try {
        const [profile, positions, identity] = await Promise.all([
          profileWallet(client, store, h.wallet, now, opts.maxAgeSecs ?? 12 * 3_600, h.name),
          client.positions(h.wallet, market.cid),
          identityFor(client, store, h.wallet, now),
        ]);
        const pos = positions.find((p) => p.outcomeIndex === h.outcomeIndex);
        view.rows.push({
          wallet: h.wallet, name: profile.name ?? h.name, outcomeIndex: h.outcomeIndex, outcome: market.outcomes[h.outcomeIndex] ?? `#${h.outcomeIndex}`, shares: h.shares,
          avgPrice: pos?.avgPrice ?? null, curPrice: pos?.curPrice ?? null, posUsd: pos?.currentValue ?? null, uPnl: pos?.cashPnl ?? null,
          pnlAll: profile.pnlAll, pnlWeek: profile.pnlWeek, vol: profile.vol, traded: profile.traded, ageDays: profile.ageDays, perDay: profile.perDay,
          cls: profile.cls, confidence: profile.confidence, reasons: profile.reasons, flags: positionFlags(pos?.avgPrice ?? null, pos?.currentValue ?? null),
          createdAt: identity?.createdAt ?? null, xUsername: identity?.xUsername ?? null,
          matches: opts.people?.length ? matchPeople({ name: identity?.name ?? profile.name ?? h.name, pseudonym: identity?.pseudonym ?? null, xUsername: identity?.xUsername ?? null, bio: identity?.bio ?? null }, opts.people) : [],
        });
      } catch (error) {
        view.error = error instanceof Error ? error.message : String(error);
      }
      view.loaded++;
      view.rows.sort((a, b) => (b.posUsd ?? b.shares * (b.curPrice ?? 0)) - (a.posUsd ?? a.shares * (a.curPrice ?? 0)));
      emit();
    });
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
  }
  view.done = true;
  emit();
  return view;
}

export function positionFlags(avgPrice: number | null, valueUsd: number | null): string[] {
  const flags: string[] = [];
  if (avgPrice !== null && avgPrice < 0.01 && (valueUsd ?? 0) >= 1_000) flags.push('holds shares it never bought at a price (transferred in, or from a split/merge)');
  return flags;
}

/** What the "people only" filter keeps. */
export const peopleOnly = (rows: readonly HolderRow[]): HolderRow[] => rows.filter((r) => isPerson(r.cls));
