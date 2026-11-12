import type { PolymarketClient } from './polymarket.ts';

/**
 * Turns whatever a person pastes into a wallet address: a 0x address, a polymarket.com/profile/0x… link, or a polymarket.com/@name link (or just @name).
 * Names are looked up through Polymarket's public profile search and must match exactly (case-insensitive), so a typo never follows a stranger.
 */

export type WalletInput = { wallet: string } | { handle: string } | null;

export function parseWalletInput(text: string): WalletInput {
  const t = text.trim();
  // an address counts only as the whole input or as the profile path of a polymarket.com link: an unrelated address inside pasted text must not win
  const addr = t.match(/^(0x[0-9a-fA-F]{40})$/) ?? t.match(/polymarket\.com\/profile\/(0x[0-9a-fA-F]{40})(?![0-9a-fA-F])/i);
  if (addr) return { wallet: addr[1].toLowerCase() };
  const h = t.match(/polymarket\.com\/@([A-Za-z0-9_.-]+)/i) ?? t.match(/^@([A-Za-z0-9_.-]+)$/);
  return h ? { handle: h[1] } : null;
}

export async function resolveWalletInput(client: PolymarketClient, text: string): Promise<{ wallet: string; name: string | null }> {
  const p = parseWalletInput(text);
  if (!p) throw new Error('not a wallet: paste a 0x address, a polymarket.com/profile/0x… link or a polymarket.com/@name link');
  if ('wallet' in p) return { wallet: p.wallet, name: null };
  const hits = await client.searchProfiles(p.handle);
  const same = hits.filter((x) => x.name?.toLowerCase() === p.handle.toLowerCase() || x.pseudonym?.toLowerCase() === p.handle.toLowerCase());
  // names are not unique: refuse rather than follow whichever came first
  if (new Set(same.map((x) => x.wallet)).size > 1) throw new Error(`@${p.handle} matches ${same.length} profiles (${same.slice(0, 3).map((x) => x.wallet.slice(0, 10)).join(', ')}…): paste the 0x address instead`);
  const exact = same[0];
  if (!exact) throw new Error(`no Polymarket profile named @${p.handle}${hits.length ? ` (closest: ${hits.slice(0, 3).map((x) => x.name ?? x.pseudonym).join(', ')})` : ''}`);
  return { wallet: exact.wallet, name: exact.name ?? exact.pseudonym };
}
