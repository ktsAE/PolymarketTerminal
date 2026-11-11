import type { PolymarketClient } from './polymarket.ts';

/**
 * Turns whatever a person pastes into a wallet address: a 0x address, a polymarket.com/profile/0x… link, or a polymarket.com/@name link (or just @name).
 * Names are looked up through Polymarket's public profile search and must match exactly (case-insensitive), so a typo never follows a stranger.
 */

export type WalletInput = { wallet: string } | { handle: string } | null;

export function parseWalletInput(text: string): WalletInput {
  const t = text.trim();
  const addr = t.match(/0x[0-9a-fA-F]{40}/);
  if (addr) return { wallet: addr[0].toLowerCase() };
  const h = t.match(/polymarket\.com\/@([A-Za-z0-9_.-]+)/i) ?? t.match(/^@([A-Za-z0-9_.-]+)$/);
  return h ? { handle: h[1] } : null;
}

export async function resolveWalletInput(client: PolymarketClient, text: string): Promise<{ wallet: string; name: string | null }> {
  const p = parseWalletInput(text);
  if (!p) throw new Error('not a wallet: paste a 0x address, a polymarket.com/profile/0x… link or a polymarket.com/@name link');
  if ('wallet' in p) return { wallet: p.wallet, name: null };
  const hits = await client.searchProfiles(p.handle);
  const exact = hits.find((x) => x.name?.toLowerCase() === p.handle.toLowerCase() || x.pseudonym?.toLowerCase() === p.handle.toLowerCase());
  if (!exact) throw new Error(`no Polymarket profile named @${p.handle}${hits.length ? ` (closest: ${hits.slice(0, 3).map((x) => x.name ?? x.pseudonym).join(', ')})` : ''}`);
  return { wallet: exact.wallet, name: exact.name ?? exact.pseudonym };
}
