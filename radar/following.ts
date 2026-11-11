import { identityFor } from './identity.ts';
import type { PnlPoint, PolymarketClient, PositionLine, TradeLine } from './polymarket.ts';
import type { RadarStore } from './store.ts';
import { windowOf } from './xray.ts';
import type { WatchedWallet } from './walletwatch.ts';

/**
 * Cards for the wallets you follow: what each one has been betting on lately, what it holds, how it has done, and what it did since you last looked.
 * Everything here is that wallet's own record at its own prices: a follower would not get the same fills, and none of it says why the wallet traded.
 */

export interface FollowTrade extends TradeLine {
  /** Newer than the latest trade seen at the previous refresh. */
  isNew: boolean;
}

export interface FollowStyle {
  trades: number;
  buyShare: number;
  avgUsd: number;
  medianUsd: number;
  markets: number;
  /** Average price paid on buys: low = long shots, high = near-certainties. */
  avgBuyPrice: number | null;
}

export interface FollowCard {
  wallet: string;
  name: string | null;
  note: string | null;
  error: string | null;
  loadedAt: number;
  pnl7d: number | null;
  pnl30d: number | null;
  pnlAll: number | null;
  volume: number | null;
  openCount: number;
  openValue: number;
  unrealized: number;
  positions: PositionLine[];
  trades: FollowTrade[];
  style: FollowStyle | null;
  newTrades: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

export function styleOf(trades: readonly TradeLine[]): FollowStyle | null {
  if (trades.length < 3) return null;
  const usd = trades.map((t) => t.size * t.price);
  const buys = trades.filter((t) => t.side === 'BUY');
  return {
    trades: trades.length, buyShare: buys.length / trades.length, avgUsd: usd.reduce((a, b) => a + b, 0) / usd.length, medianUsd: median(usd),
    markets: new Set(trades.map((t) => t.cid)).size, avgBuyPrice: buys.length ? buys.reduce((a, t) => a + t.price, 0) / buys.length : null,
  };
}

export function buildCard(entry: WatchedWallet, name: string | null, series: readonly PnlPoint[], open: readonly PositionLine[], trades: readonly TradeLine[], seenTs: number | null, nowSecs: number): FollowCard {
  const last = series[series.length - 1];
  const sorted = [...trades].sort((a, b) => b.ts - a.ts);
  const positions = [...open].sort((a, b) => b.value - a.value);
  const tagged = sorted.map((t): FollowTrade => ({ ...t, isNew: seenTs !== null && t.ts > seenTs }));
  return {
    wallet: entry.wallet, name, note: entry.note ?? null, error: null, loadedAt: nowSecs,
    pnl7d: series.length ? windowOf(series, 7, nowSecs).pnl : null, pnl30d: series.length ? windowOf(series, 30, nowSecs).pnl : null, pnlAll: last?.economicPnl ?? null, volume: last?.volume ?? null,
    openCount: open.length, openValue: open.reduce((a, p) => a + p.value, 0), unrealized: open.reduce((a, p) => a + p.unrealizedPnl, 0),
    positions: positions.slice(0, 12), trades: tagged.slice(0, 30), style: styleOf(sorted), newTrades: tagged.filter((t) => t.isNew).length,
  };
}

/** Loads one card. Never throws: a failure comes back as a card with `error`, so one broken wallet never hides the others. */
export async function loadCard(client: PolymarketClient, store: RadarStore, entry: WatchedWallet, seenTs: number | null, now: () => number = Date.now): Promise<FollowCard> {
  const nowSecs = Math.floor(now() / 1000);
  try {
    const [id, series, open, trades] = await Promise.all([
      identityFor(client, store, entry.wallet, now).catch(() => null),
      client.userPnlSeries(entry.wallet).catch(() => [] as PnlPoint[]),
      client.userPositions(entry.wallet, 'OPEN', 300),
      client.recentTrades(entry.wallet, 40),
    ]);
    return buildCard(entry, id?.name ?? id?.pseudonym ?? null, series, open, trades, seenTs, nowSecs);
  } catch (error) {
    return { wallet: entry.wallet, name: null, note: entry.note ?? null, error: error instanceof Error ? error.message.slice(0, 120) : String(error), loadedAt: nowSecs, pnl7d: null, pnl30d: null, pnlAll: null, volume: null, openCount: 0, openValue: 0, unrealized: 0, positions: [], trades: [], style: null, newTrades: 0 };
  }
}

export interface FollowView {
  cards: FollowCard[];
  /** Latest trade timestamp seen per wallet (drives the "new" marks and the notifications). */
  seen: Record<string, number>;
  loading: boolean;
  loadedAt: number | null;
  /** The add-by-link prompt: null when closed, the text typed so far when open. */
  input: string | null;
  message: string | null;
}

export const emptyFollow = (): FollowView => ({ cards: [], seen: {}, loading: false, loadedAt: null, input: null, message: null });

/** Loads every followed wallet (3 at a time). Returns the cards plus the trades that are new since the last look, for notifications. */
export async function loadFollowing(client: PolymarketClient, store: RadarStore, list: readonly WatchedWallet[], prevSeen: Record<string, number>, now: () => number = Date.now): Promise<{ cards: FollowCard[]; seen: Record<string, number>; fresh: Array<{ card: FollowCard; trade: FollowTrade }> }> {
  const cards: FollowCard[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < list.length; i = next++) cards[i] = await loadCard(client, store, list[i], prevSeen[list[i].wallet] ?? null, now);
  };
  await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
  const seen = { ...prevSeen };
  const fresh: Array<{ card: FollowCard; trade: FollowTrade }> = [];
  for (const card of cards) {
    if (card.error) continue;
    const top = card.trades.reduce((m, t) => Math.max(m, t.ts), 0);
    if (top > 0) seen[card.wallet] = Math.max(seen[card.wallet] ?? 0, top);
    for (const t of card.trades) if (t.isNew) fresh.push({ card, trade: t });
  }
  return { cards, seen, fresh };
}
