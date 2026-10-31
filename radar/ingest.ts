import { peakPositions } from './features.ts';
import type { PolymarketClient } from './polymarket.ts';
import type { RadarStore } from './store.ts';

export interface IngestOptions {
  /** Skip markets thinner than this (dollars of volume). */
  minVolume?: number;
  /** Profile the N largest wallet positions per market. */
  profileTop?: number;
  /** Re-profile wallets older than this many seconds. */
  profileMaxAgeSecs?: number;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface IngestResult {
  slug: string;
  markets: number;
  tradedMarkets: number;
  newTrades: number;
  profiled: number;
}

export async function ingestEvent(client: PolymarketClient, store: RadarStore, slug: string, opts: IngestOptions = {}): Promise<IngestResult | undefined> {
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => undefined);
  const minVolume = opts.minVolume ?? 1_000;
  const profileTop = opts.profileTop ?? 6;
  const maxAge = opts.profileMaxAgeSecs ?? 7 * 86_400;

  const event = await client.eventBySlug(slug);
  if (!event) return undefined;
  const result: IngestResult = { slug, markets: event.markets.length, tradedMarkets: 0, newTrades: 0, profiled: 0 };
  for (const m of event.markets) store.upsertMarket(m, now());

  const toProfile = new Set<string>();
  for (const m of event.markets) {
    if (m.volume < minVolume) continue;
    const trades = await client.marketTrades(m.cid);
    const added = store.insertTrades(trades);
    result.tradedMarkets++;
    result.newTrades += added;
    log(`${m.marketType ?? '?'} "${m.question.slice(0, 60)}": ${trades.length} fills (${added} new)`);
    for (const p of peakPositions(store.tradesFor(m.cid), m.gameStart).slice(0, profileTop)) toProfile.add(p.wallet);
  }

  const nowSecs = Math.floor(now() / 1000);
  for (const wallet of toProfile) {
    const known = store.getWallet(wallet);
    if (known && nowSecs - known.fetchedAt < maxAge) continue;
    store.upsertWallet({ ...(await client.walletProfile(wallet)), fetchedAt: nowSecs });
    result.profiled++;
    log(`profiled ${wallet.slice(0, 8)}…`);
  }
  return result;
}
