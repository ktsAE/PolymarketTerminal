import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PolymarketClient, TradeLine } from './polymarket.ts';

/**
 * Wallet watchlist: wallets you chose to keep an eye on, and a notice when one of them trades. Awareness only. Backtests found that following wallets does not
 * pay (docs/research/radar/HOLDERS_STUDY.md), so a notice here is a prompt to look at the market, never a trade signal.
 */

export const WALLETS_PATH = process.env.RADAR_WALLETS ?? '.radar/wallets.json';

export interface WatchedWallet {
  wallet: string;
  note?: string;
}

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isAddress = (s: string): boolean => ADDR.test(s);

export function loadWatched(path: string = WALLETS_PATH): WatchedWallet[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A file that exists but does not parse is moved aside, so the next save cannot overwrite what is left of it.
    if (existsSync(path)) {
      try {
        renameSync(path, `${path}.corrupt-${Date.now()}`);
      } catch {
        /* read-only dir: nothing more to do */
      }
    }
    return [];
  }
  const seen = new Set<string>();
  const out: WatchedWallet[] = [];
  for (const x of Array.isArray(raw) ? raw : []) {
    const wallet = typeof x === 'string' ? x : typeof x?.wallet === 'string' ? x.wallet : '';
    if (!isAddress(wallet) || seen.has(wallet.toLowerCase())) continue;
    seen.add(wallet.toLowerCase());
    out.push({ wallet: wallet.toLowerCase(), ...(typeof x?.note === 'string' && x.note ? { note: x.note } : {}) });
  }
  return out;
}

export function saveWatched(list: readonly WatchedWallet[], path: string = WALLETS_PATH): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 2) + '\n');
  renameSync(tmp, path);
}

/** Adds (or updates the note of) a wallet. Returns whether it was new. */
export function addWatched(wallet: string, note: string | undefined, path: string = WALLETS_PATH): { added: boolean; list: WatchedWallet[] } {
  if (!isAddress(wallet)) throw new Error('not a wallet address (expected 0x followed by 40 hex characters)');
  const list = loadWatched(path);
  const w = wallet.toLowerCase();
  const i = list.findIndex((x) => x.wallet === w);
  if (i >= 0) {
    if (note) list[i] = { wallet: w, note };
  } else list.push({ wallet: w, ...(note ? { note } : {}) });
  saveWatched(list, path);
  return { added: i < 0, list };
}

export function removeWatched(wallet: string, path: string = WALLETS_PATH): boolean {
  const list = loadWatched(path);
  const next = list.filter((x) => x.wallet !== wallet.toLowerCase());
  if (next.length === list.length) return false;
  saveWatched(next, path);
  return true;
}

export const tradeKey = (t: TradeLine): string => `${t.tx}|${t.token}|${t.side}|${t.price}|${t.size}|${t.ts}`;

/** Trades not seen before, oldest first. `seen` is updated. The first call for a wallet (`baseline`) only records what is there so old trades never alert. */
export function freshTrades(trades: readonly TradeLine[], seen: Set<string>, baseline: boolean): TradeLine[] {
  const out: TradeLine[] = [];
  for (const t of [...trades].sort((a, b) => a.ts - b.ts)) {
    const k = tradeKey(t);
    if (seen.has(k)) continue;
    seen.add(k);
    if (!baseline) out.push(t);
  }
  return out;
}

export function describeTrade(w: WatchedWallet, t: TradeLine): string {
  const usd = t.size * t.price;
  const who = w.note ?? `${w.wallet.slice(0, 8)}…`;
  return `${who}: ${t.side} ${t.outcome || '?'} $${usd >= 100 ? Math.round(usd).toLocaleString('en-US') : usd.toFixed(0)} at ${(t.price * 100).toFixed(1)}c on "${t.title}"`;
}

export interface WatchPoll {
  wallet: string;
  trades: TradeLine[];
  error?: string;
}

/** One pass over the watchlist. `seen` and `primed` persist between passes (kept by the caller). Errors are per wallet and never thrown. */
export async function pollWatched(client: PolymarketClient, list: readonly WatchedWallet[], seen: Map<string, Set<string>>, primed: Set<string>): Promise<WatchPoll[]> {
  const out: WatchPoll[] = [];
  for (const w of list) {
    try {
      const trades = await client.recentTrades(w.wallet, 60);
      const set = seen.get(w.wallet) ?? new Set<string>();
      seen.set(w.wallet, set);
      const fresh = freshTrades(trades, set, !primed.has(w.wallet));
      primed.add(w.wallet);
      out.push({ wallet: w.wallet, trades: fresh });
    } catch (error) {
      out.push({ wallet: w.wallet, trades: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  return out;
}

/** Untrusted text for a notification daemon: no control characters, no markup (many daemons render Pango/HTML). */
export const notifyText = (s: string): string =>
  s.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').slice(0, 500);

export function notify(title: string, body: string): void {
  // `--` ends option parsing, so a body that starts with `-` stays text
  execFile('notify-send', ['-a', 'polymarket-radar', '--', notifyText(title), notifyText(body)], { timeout: 5_000 }, () => undefined);
}
