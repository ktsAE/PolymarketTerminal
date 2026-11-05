import type { Transfer } from './chainfunding.ts';

/**
 * Bubble map for one market: the holders as bubbles, joined when the chain shows they are connected.
 * Two holders are linked when (a) the same funder sent USDC to both, or (b) one sent USDC to the other.
 * Funders that also pay several unrelated traders of the market (the control sample) are services, a bridge, a relayer or an exchange, and are not links.
 * A link says the money came through the same place. It does not say the same person owns the wallets: friends, a shared deposit service or a payout from one
 * employer link too. Only transfers inside the scanned window are seen, so "no link" means none was found, not that none exists.
 */

export interface MapHolder {
  wallet: string;
  outcome: string;
  outcomeIndex: number;
  posUsd: number | null;
  cls: string;
  createdAt?: number | null;
  name?: string | null;
}

export interface MapGroup {
  /** The funder when the group is joined by a shared funder; null when joined by direct holder-to-holder transfers only. */
  funder: string | null;
  /** True when the funder is itself one of the holders. */
  funderIsHolder: boolean;
  members: MapHolder[];
  /** Dollars each member received from the group's funder(s), by wallet. */
  funded: Record<string, number>;
  /** Direct holder-to-holder transfers inside the group. */
  direct: Array<{ from: string; to: string; usd: number }>;
  totalUsd: number;
  /** Members by outcome, so a group that holds both sides is visible. */
  sides: Record<string, number>;
}

export interface FundMap {
  groups: MapGroup[];
  unlinked: MapHolder[];
  hubs: string[];
  /** Holders that received any USDC in the scanned window (the rest had no funding in view). */
  seenFunded: number;
}

export interface MapOptions {
  /** A funder paying this many control wallets or more is a service. */
  hubThreshold?: number;
  /** Ignore transfers below this many dollars (dust that anyone can send). */
  minUsd?: number;
  /** Ignore funders known to be protocol contracts. */
  ignore?: readonly string[];
  /** Funders already found to be services by another test (counted in `hubs`). */
  markHubs?: readonly string[];
}

export function buildFundMap(holders: readonly MapHolder[], transfers: readonly Transfer[], control: readonly string[], opts: MapOptions = {}): FundMap {
  const minUsd = opts.minUsd ?? 5;
  const hubAt = opts.hubThreshold ?? 3;
  const ignore = new Set((opts.ignore ?? []).map((a) => a.toLowerCase()));
  const byWallet = new Map<string, MapHolder>();
  for (const h of holders) if (!byWallet.has(h.wallet.toLowerCase())) byWallet.set(h.wallet.toLowerCase(), { ...h, wallet: h.wallet.toLowerCase() });
  const ctrl = new Set(control.map((c) => c.toLowerCase()).filter((c) => !byWallet.has(c)));
  const real = transfers.filter((t) => t.usd >= minUsd && t.from !== t.to).map((t) => ({ ...t, from: t.from.toLowerCase(), to: t.to.toLowerCase() }));

  // funders that pay many unrelated traders are services
  const paidCtrl = new Map<string, Set<string>>();
  for (const t of real) if (ctrl.has(t.to)) paidCtrl.set(t.from, (paidCtrl.get(t.from) ?? new Set()).add(t.to));
  const hubs = new Set<string>([...paidCtrl.entries()].filter(([, s]) => s.size >= hubAt).map(([f]) => f));
  for (const a of ignore) hubs.add(a);
  hubs.add('0x0000000000000000000000000000000000000000');

  const funderTo = new Map<string, Map<string, number>>(); // funder -> holder -> usd
  const direct: Array<{ from: string; to: string; usd: number }> = [];
  const funded = new Set<string>();
  for (const t of real) {
    if (!byWallet.has(t.to)) continue;
    funded.add(t.to);
    if (byWallet.has(t.from)) {
      direct.push({ from: t.from, to: t.to, usd: t.usd });
      continue;
    }
    if (hubs.has(t.from)) continue;
    const m = funderTo.get(t.from) ?? new Map<string, number>();
    m.set(t.to, (m.get(t.to) ?? 0) + t.usd);
    funderTo.set(t.from, m);
  }

  // union-find over holders
  const parent = new Map<string, string>([...byWallet.keys()].map((k) => [k, k]));
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const [, m] of funderTo) {
    const ws = [...m.keys()];
    for (let i = 1; i < ws.length; i++) union(ws[0], ws[i]);
  }
  for (const d of direct) union(d.from, d.to);

  const comps = new Map<string, string[]>();
  for (const k of byWallet.keys()) comps.set(find(k), [...(comps.get(find(k)) ?? []), k]);
  const groups: MapGroup[] = [];
  const unlinked: MapHolder[] = [];
  for (const members of comps.values()) {
    if (members.length < 2) {
      unlinked.push(byWallet.get(members[0])!);
      continue;
    }
    const set = new Set(members);
    const funders = [...funderTo.entries()].filter(([, m]) => [...m.keys()].filter((w) => set.has(w)).length >= 2).sort((a, b) => b[1].size - a[1].size);
    const top = funders[0];
    const fundedBy: Record<string, number> = {};
    for (const [, m] of funders) for (const [w, usd] of m) if (set.has(w)) fundedBy[w] = (fundedBy[w] ?? 0) + usd;
    const hs = members.map((k) => byWallet.get(k)!).sort((a, b) => (b.posUsd ?? 0) - (a.posUsd ?? 0));
    const sides: Record<string, number> = {};
    for (const h of hs) sides[h.outcome] = (sides[h.outcome] ?? 0) + 1;
    groups.push({
      funder: top ? top[0] : null, funderIsHolder: false, members: hs, funded: fundedBy, direct: direct.filter((d) => set.has(d.from) && set.has(d.to)),
      totalUsd: hs.reduce((a, h) => a + (h.posUsd ?? 0), 0), sides,
    });
  }
  groups.sort((a, b) => b.totalUsd - a.totalUsd);
  unlinked.sort((a, b) => (b.posUsd ?? 0) - (a.posUsd ?? 0));
  return { groups, unlinked, hubs: [...new Set([...[...hubs].filter((h) => paidCtrl.has(h)), ...(opts.markHubs ?? []).map((h) => h.toLowerCase())])], seenFunded: funded.size };
}

const usd = (x: number): string => (x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${Math.round(x)}`);
export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Bubble glyph by share of the largest position on the map. */
export const bubble = (posUsd: number | null, max: number): string => {
  const r = max > 0 && posUsd ? posUsd / max : 0;
  return r > 0.66 ? '⬤' : r > 0.33 ? '●' : r > 0.1 ? '◉' : r > 0 ? '○' : '·';
};

export const MAP_CAVEAT = 'A link means the money came through the same wallet. It does not prove one owner: friends, a shared service or one employer link too. Only the scanned window is seen.';

/** Plain-text lines (no colour) describing the map; the TUI colours them. */
export function formatFundMap(map: FundMap, holders: readonly MapHolder[]): string[] {
  const max = Math.max(0, ...holders.map((h) => h.posUsd ?? 0));
  const out: string[] = [];
  if (map.groups.length === 0) out.push(`no links found between the ${holders.length} holders (${map.seenFunded} of them received USDC in the window)`);
  map.groups.forEach((g, i) => {
    const both = Object.keys(g.sides).length > 1 ? `  holds BOTH sides (${Object.entries(g.sides).map(([k, n]) => `${n} ${k}`).join(', ')})` : '';
    out.push(`GROUP ${i + 1}: ${g.members.length} wallets, ${usd(g.totalUsd)} together${both}`);
    out.push(g.funder ? `  funded by ${short(g.funder)}${g.members.some((m) => m.wallet === g.funder) ? ' (a holder)' : ''}` : '  linked by transfers between the holders');
    for (const m of g.members) {
      const f = g.funded[m.wallet];
      out.push(`  ${bubble(m.posUsd, max)} ${short(m.wallet)}  ${m.outcome.padEnd(6)} ${usd(m.posUsd ?? 0).padStart(7)}  ${m.cls.padEnd(8)}${f ? ` got ${usd(f)}` : ''}${m.name ? `  ${m.name}` : ''}`);
    }
    for (const d of g.direct.slice(0, 4)) out.push(`  ${short(d.from)} → ${short(d.to)} ${usd(d.usd)}`);
  });
  if (map.unlinked.length) out.push(`UNLINKED: ${map.unlinked.length} holders, ${usd(map.unlinked.reduce((a, h) => a + (h.posUsd ?? 0), 0))} (${map.unlinked.slice(0, 5).map((h) => `${bubble(h.posUsd, max)}${short(h.wallet)}`).join(' ')}${map.unlinked.length > 5 ? ' …' : ''})`);
  if (map.hubs.length) out.push(`ignored ${map.hubs.length} service wallet(s) that fund many unrelated traders (bridge, relayer or exchange)`);
  out.push(MAP_CAVEAT);
  return out;
}
