import type { PolymarketClient } from './polymarket.ts';
import type { RadarStore, WalletIdentity } from './store.ts';

/** Accounts younger than this are called NEW. */
export const NEW_ACCOUNT_DAYS = 30;

/**
 * The wallet's public profile (creation date, display name, linked X handle, bio), cached for a day.
 * Best effort: a failed lookup returns null and is not cached, so one flaky call never hides the wallet.
 */
export async function identityFor(client: PolymarketClient, store: RadarStore, wallet: string, now: () => number, maxAgeSecs = 86_400): Promise<WalletIdentity | null> {
  const nowSecs = Math.floor(now() / 1000);
  const cached = store.getIdentity(wallet);
  if (cached && nowSecs - cached.fetchedAt < maxAgeSecs) return cached;
  try {
    const p = await client.publicProfile(wallet);
    const id: WalletIdentity = p
      ? { wallet, fetchedAt: nowSecs, createdAt: p.createdAt, name: p.name, pseudonym: p.pseudonym, xUsername: p.xUsername, bio: p.bio, verified: p.verified }
      : { wallet, fetchedAt: nowSecs, createdAt: null, name: null, pseudonym: null, xUsername: null, bio: null, verified: false };
    store.upsertIdentity(id);
    return id;
  } catch {
    return cached ?? null;
  }
}

export interface AccountAge {
  /** Whole days since the profile was created; null when unknown. */
  days: number | null;
  /** "2026-10-12 (19d)" or "?" */
  label: string;
  isNew: boolean;
}

export const dateOf = (epochSecs: number): string => new Date(epochSecs * 1000).toISOString().slice(0, 10);

export function accountAge(createdAt: number | null | undefined, nowSecs: number): AccountAge {
  if (createdAt === null || createdAt === undefined) return { days: null, label: '?', isNew: false };
  const days = Math.max(0, Math.floor((nowSecs - createdAt) / 86_400));
  return { days, label: `${dateOf(createdAt)} (${days}d)`, isNew: days < NEW_ACCOUNT_DAYS };
}
