/**
 * Next market in the holders picker: `]`/`[` step one market, `}`/`{` jump to the next/previous market TYPE (moneyline, spreads, totals, props...),
 * which is what makes a game with hundreds of markets navigable.
 */
export function pickMarket<T extends { cid: string; marketType: string | null }>(markets: readonly T[], currentCid: string, key: string): T | undefined {
  if (markets.length < 2) return undefined;
  const i = Math.max(0, markets.findIndex((x) => x.cid === currentCid));
  const dir = key === ']' || key === '}' ? 1 : -1;
  if (key === ']' || key === '[') return markets[(i + dir + markets.length) % markets.length];
  const type = markets[i].marketType;
  for (let step = 1; step < markets.length; step++) {
    const m = markets[(i + dir * step + markets.length * step) % markets.length];
    if (m.marketType !== type) return dir === 1 ? m : markets.find((x) => x.marketType === m.marketType) ?? m;
  }
  return undefined;
}
