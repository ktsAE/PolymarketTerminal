import { pickMarket } from '../../radar/tui/pick';
import { buildXray } from '../../radar/xray';
import { describe, expect, it } from 'vitest';
import { charWidth, clip, fit, sparkline, strip, truncate, vlen } from '../../radar/tui/ansi';
import { JUMPS_STANDING, LEDGER_STANDING, moveSelection, NEW_STANDING, render, type Model, type View } from '../../radar/tui/render';
import { scoreJumps, type JumpFlag } from '../../radar/jump';
import type { EdgeCandidate, ScanResult } from '../../radar/edges';
import type { EarlyFeatures, ScanRow, ScanSummary } from '../../radar/newmarkets';
import { scoreLedger } from '../../radar/ledger';
import type { Anomaly } from '../../radar/detect';
import type { HolderRow } from '../../radar/holders';
import { applyFilters } from '../../radar/collect';

const anomaly = (i: number, over: Partial<Anomaly> = {}): Anomaly => ({
  eventId: String(i), slug: `ev-${i}`, startsAt: null, title: i % 3 === 0 ? `日本語のイベント ${i} 🚀 with a really long title that must be cut cleanly` : `Event number ${i}`, cat: 'politics', isGame: false,
  score: 90 - i, level: i < 2 ? 'HOT' : i < 6 ? 'WATCH' : 'NONE',
  reasons: [{ code: 'oi_surge', points: 40, text: 'open interest +$120k (+18%) in 61m' }, { code: 'fresh_money', points: 20, text: '2 new/thin wallet(s) put $15k in' }], notes: [],
  m: { oi: 800_000, dOi1h: 120_000, dOi1hPct: 0.18, dOi1hSpanMin: 61, dOi15m: null, dOi15mPct: null, dOi24h: null, dOi24hPct: null, vol24: 2_400_000, accel: 4.2, turnover: 3, liq: 90_000, price: 0.42, ch1h: 0.12, ch1d: null, dPrice30m: null },
  flow: { usd1h: 80_000, prints1h: 5, biggestUsd: 30_000, freshUsd: 15_000, freshWallets: 2, cluster: false, top: { usd: 30_000, wallet: '0xabc', tag: 'NEW', outcome: 'Yes', side: 'BUY' } },
  ...over,
});
const model = (n = 40): Model => ({
  anomalies: Array.from({ length: n }, (_, i) => anomaly(i)),
  games: Array.from({ length: 6 }, (_, i) => anomaly(100 + i, { isGame: true, cat: 'sports', title: `Team ${i} vs. Team ${i + 1}`, startsAt: Math.floor(Date.now() / 1000) + (i - 1) * 1_800, m: { ...anomaly(0).m, dPrice30m: 0.07 } })),
  holders: null,
  showBots: false,
  prints: [{ key: 'k', ts: Date.now() / 1000 - 90, wallet: '0x1234567890abcdef1234567890abcdef12345678', cid: '0xc', eventSlug: 'ev', title: 'Some market', outcome: 'Yes', side: 'BUY', price: 0.41, size: 50_000, usd: 20_500, name: null, tag: { kind: 'NEW', ageDays: 2, traded: 1 } }],
  leads: [{ feedId: 'esic', url: 'https://esic.gg/x', title: 'ESIC Issues Interim Suspension to X', summary: 's', publishedAt: Date.now(), firstSeen: 1, relevant: true, category: 'sanction', matched: [], tierHint: 'INVESTIGATING', note: 'n', status: 'new', caseId: null }],
  status: { lastPollAt: Date.now(), nextPollAt: Date.now() + 90_000, busy: false, error: null, events: 300, historySecs: 3_000, printsWindowMin: 360, message: null },
  oiSeries: [1, 2, 3, 5, 8, 13, 21], filter: null,
});

describe('ansi helpers', () => {
  it('measures wide characters, emoji modifiers and ignores colour codes', () => {
    expect(charWidth('a'.codePointAt(0)!)).toBe(1);
    expect(charWidth('日'.codePointAt(0)!)).toBe(2);
    expect(vlen('\x1b[31m日本\x1b[39m')).toBe(4);
    expect(strip('\x1b[1mhi\x1b[22m')).toBe('hi');
  });
  it('fits plain text to an exact width', () => {
    for (const s of ['short', 'a much longer title than the column', '日本語タイトルが長い']) {
      expect(vlen(fit(s, 12))).toBe(12);
      expect(vlen(fit(s, 12, 'right'))).toBe(12);
    }
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abc', 0)).toBe('');
  });
  it('clips coloured lines without breaking escape sequences', () => {
    const line = `\x1b[31m${'x'.repeat(50)}\x1b[39m tail`;
    const out = clip(line, 20);
    expect(vlen(out)).toBeLessThanOrEqual(20);
    expect(out).toContain('\x1b[31m');
  });
  it('draws a sparkline', () => {
    expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8], 8)).toBe('▁▂▃▄▅▆▇█');
    expect(sparkline([5, 5, 5], 3)).toHaveLength(3);
    expect(sparkline([], 5)).toBe('');
  });
});

describe('rendering', () => {
  it('never overflows its box at any terminal size, on any tab', () => {
    for (const [cols, rows] of [[60, 16], [80, 24], [100, 30], [140, 40], [220, 60]]) {
      for (const tab of ['anomalies', 'games', 'prints', 'holders', 'leads', 'decision', 'search', 'news', 'edge', 'ledger', 'new', 'jumps'] as const) {
        const lines = render(model(), { tab, sel: 3, cols, rows }, Date.now());
        expect(lines, `${cols}x${rows} ${tab}`).toHaveLength(rows);
        for (const l of lines) expect(vlen(l), `${cols}x${rows} ${tab}`).toBeLessThanOrEqual(cols);
      }
    }
  });

  it('shows the selected row in the detail pane with its reasons and sparkline', () => {
    const text = strip(render(model(), { tab: 'anomalies', sel: 1, cols: 140, rows: 40 }, Date.now()).join('\n'));
    expect(text).toContain('Event number 1');
    expect(text).toContain('open interest +$120k (+18%) in 61m');
    expect(text).toMatch(/[▁▂▃▄▅▆▇█]{4,}/);
    expect(text).toContain('polymarket.com/event/ev-1');
  });

  it('keeps the selected row on screen when scrolling a long list', () => {
    const text = strip(render(model(200), { tab: 'anomalies', sel: 151, cols: 120, rows: 30 }, Date.now()).join('\n'));
    expect(text).toContain('Event number 151');
  });

  it('survives empty data and an error state', () => {
    const empty: Model = { ...model(), anomalies: [], games: [], prints: [], leads: [], status: { ...model().status, error: 'HTTP 500', lastPollAt: null, nextPollAt: null } };
    for (const tab of ['anomalies', 'games', 'prints', 'holders', 'leads', 'decision', 'search', 'news', 'edge', 'ledger', 'new', 'jumps'] as const) expect(() => render(empty, { tab, sel: 0, cols: 100, rows: 30 }, Date.now())).not.toThrow();
    expect(strip(render(empty, { tab: 'anomalies', sel: 0, cols: 100, rows: 30 }, Date.now()).join('\n'))).toContain('error');
  });

  it('says when OI history is still being collected', () => {
    const m = model();
    m.anomalies = [anomaly(0, { m: { ...anomaly(0).m, dOi1h: null, dOi1hPct: null } })];
    expect(strip(render(m, { tab: 'anomalies', sel: 0, cols: 140, rows: 30 }, Date.now()).join('\n'))).toContain('(history)');
  });
});

describe('keyboard reducer', () => {
  const v: View = { tab: 'anomalies', sel: 0, cols: 120, rows: 40 };
  it('moves within bounds and switches tabs', () => {
    const m = model(10);
    expect(moveSelection(v, 'up', m).sel).toBe(0);
    expect(moveSelection({ ...v, sel: 9 }, 'down', m).sel).toBe(9);
    expect(moveSelection(v, 'end', m).sel).toBe(9);
    expect(moveSelection({ ...v, sel: 9 }, 'home', m).sel).toBe(0);
    expect(moveSelection(v, 'pagedown', m).sel).toBe(9);
    expect(moveSelection({ ...v, sel: 4 }, '2', m)).toMatchObject({ tab: 'games', sel: 0 });
    expect(moveSelection({ ...v, sel: 4 }, '3', m)).toMatchObject({ tab: 'wallets', sel: 0 });
    const cycle = ['anomalies', 'games', 'wallets', 'holders', 'decision', 'xray', 'search', 'book', 'follow', 'anomalies'] as const;
    for (let k = 0; k < cycle.length - 1; k++) expect(moveSelection({ ...v, tab: cycle[k] }, 'tab', m).tab).toBe(cycle[k + 1]);
    for (const [key, tab] of [['4', 'holders'], ['5', 'decision'], ['6', 'xray'], ['7', 'search'], ['8', 'book'], ['9', 'follow'], ['w', 'wallets'], ['x', 'xray']] as const) expect(moveSelection(v, key, m).tab).toBe(tab);
    for (const gone of ['0', 'j', 'u']) expect(moveSelection(v, gone as never, m).tab).toBe('anomalies'); // removed tools no longer have keys
    expect(strip(render(m, v, Date.now())[1])).not.toMatch(/News|Edge|Jumps|Ledger|Leads|Big prints/);
    expect(moveSelection({ ...v, tab: 'anomalies' }, 'tab', m).tab).toBe('games');
  });
  it('handles an empty list', () => {
    const m = { ...model(), anomalies: [] };
    expect(moveSelection(v, 'end', m).sel).toBe(0);
    expect(moveSelection(v, 'down', m).sel).toBe(0);
  });
});

describe('anomaly filters', () => {
  const list = [anomaly(1, { cat: 'politics' }), anomaly(3, { cat: 'crypto' }), anomaly(5, { cat: 'politics' })];
  it('filters by category and passes everything when none is chosen', () => {
    expect(applyFilters(list, { cat: null })).toHaveLength(3);
    expect(applyFilters(list, { cat: 'politics' }).map((a) => a.eventId)).toEqual(['1', '5']);
    expect(applyFilters(list, { cat: 'sports' })).toHaveLength(0);
  });
});

describe('games and holders tabs', () => {
  const holder = (over: Partial<HolderRow> = {}): HolderRow => ({
    wallet: '0xabcdef0123456789abcdef0123456789abcdef01', name: 'dubdubdub2', outcomeIndex: 0, outcome: 'Yes', shares: 476_000, avgPrice: 0.77, curPrice: 0.81, posUsd: 366_851, uPnl: 17_716,
    pnlAll: 147_399, pnlWeek: null, vol: 900_000, traded: 7, ageDays: 120, perDay: 0, cls: 'HUMAN', confidence: 'medium', reasons: ['low cadence, few markets, no reward/rebate payouts'], flags: [], ...over,
  });
  const withHolders = (showBots: boolean): Model => ({
    ...model(),
    showBots,
    holders: {
      slug: 'mi', eventTitle: 'Michigan Senate', question: 'Will the Democrats win Michigan?', cid: '0xc', markets: [], total: 4, loaded: 4, done: true, error: null,
      rows: [holder(), holder({ name: 'cigarettes', cls: 'BOT', confidence: 'high', traded: 157_118, posUsd: 11_659, reasons: ['157,118 markets traded lifetime'] }), holder({ name: 'toosensitive', cls: 'MM', posUsd: 5_000 }), holder({ name: 'newcomer', cls: 'LOW_DATA', posUsd: 30_000, avgPrice: 0, flags: ['holds shares it never bought'] })],
    },
  });
  const text = (m: Model, tab: View['tab'], sel = 0) => strip(render(m, { tab, sel, cols: 150, rows: 40 }, Date.now()).join('\n'));

  it('lists only people by default and says how many machines are hidden', () => {
    const t = text(withHolders(false), 'holders');
    expect(t).toContain('dubdubdub2');
    expect(t).toContain('newcomer');
    expect(t).not.toContain('cigarettes');
    expect(t).not.toContain('toosensitive');
    expect(t).toContain('2 bots/market makers hidden');
  });

  it('shows machines when asked, with their reasons in the detail pane', () => {
    const m = withHolders(true);
    const t = text(m, 'holders', 2);
    expect(t).toContain('cigarettes');
    expect(t).toContain('showing 2 bots/market makers too');
    expect(text(m, 'holders', 1)).toContain('157,118 markets traded lifetime');
  });

  it('flags positions that were never bought', () => {
    expect(text(withHolders(false), 'holders', 1)).toContain('never bought');
  });

  it('shows a progress note while wallets are still being profiled', () => {
    const m = withHolders(false);
    m.holders = { ...m.holders!, done: false, loaded: 1 };
    expect(text(m, 'holders')).toContain('profiling 1/4');
  });

  it('prompts for h when nothing is loaded', () => {
    expect(text({ ...model(), holders: null }, 'holders')).toContain('press h');
  });

  it('shows start countdowns, live games and line moves on the games tab', () => {
    const t = text(model(), 'games');
    expect(t).toMatch(/in \d+m/);
    expect(t).toMatch(/LIVE \d+m/);
    expect(t).toContain('+7pt');
  });

  it('navigates the holders list within the visible rows only', () => {
    const m = withHolders(false);
    expect(moveSelection({ tab: 'holders', sel: 0, cols: 120, rows: 40 }, 'end', m).sel).toBe(1);
    expect(moveSelection({ tab: 'holders', sel: 0, cols: 120, rows: 40 }, 'end', { ...m, showBots: true }).sel).toBe(3);
    expect(moveSelection({ tab: 'anomalies', sel: 0, cols: 120, rows: 40 }, '4', m).tab).toBe('holders');
    expect(moveSelection({ tab: 'anomalies', sel: 0, cols: 120, rows: 40 }, '5', m).tab).toBe('decision');
  });
});




describe('edge tab REF rows', () => {
  const cand = (over: Partial<EdgeCandidate> = {}): EdgeCandidate => ({
    kind: 'LADDER', slug: 'ev-ladder', title: 'Structural ladder', legs: [{ cid: '0x1', label: '>$30M', action: 'BUY YES', price: 0.4, yesToken: '1', noToken: '2' }], payoff: 1, cost: 0.95, edgePts: 5,
    confidence: 'medium', liqMin: 5_000, vol24: 20_000, caveats: [], verified: true, liveEdgePts: 4, depthUsd: 300, profitUsd: 12, note: null, ...over,
  });
  const ref = cand({ kind: 'REF', slug: 'onewin-fdv', title: 'Onewin FDV above $70M?', payoff: 0.62, cost: 0.5, edgePts: 12, confidence: 'low', verified: true, liveEdgePts: 12, caveats: ['model range from a DEX price; confirm: official mint'] });
  const result = (unmapped: string[]): ScanResult => ({ at: Date.now(), eventsScanned: 400, marketsScanned: 2_000, candidates: [cand(), ref], errors: [], unmapped });
  const withEdges = (unmapped: string[]): Model => ({ ...model(), edges: { stage: 'done', done: true, error: null, result: result(unmapped) } });
  const text = (m: Model, cols = 150, rows = 40, sel = 0) => strip(render(m, { tab: 'edge', sel, cols, rows }, Date.now()).join('\n'));

  it('shows REF rows with their type label, a model edge and low confidence, plus the unmapped note', () => {
    const m = withEdges(['Predict.fun FDV above ___ one day after launch?', 'Other token FDV?']);
    const t = text(m);
    expect(t).toMatch(/REF\s+~\+12\.0pt\s+\+12pt\s+\$\d+\s+low\s+.*Onewin FDV above \$70M\?/);
    expect(t).toMatch(/LADDER\s+\+4\.0pt/);
    expect(t).toContain('2 token markets have no reference price (add to .radar/refs.json)');
    expect(t).toContain('no forecasting edge is claimed');
    const raw = render(m, { tab: 'edge', sel: 0, cols: 150, rows: 40 }, Date.now()).join('\n');
    expect(raw).toContain('\x1b[33mREF'); // yellow = low confidence styling
    expect(text(m, 150, 40, 1)).toContain('NOT guaranteed');
  });

  it('prints no unmapped line when every token ladder is mapped, and never overflows', () => {
    expect(text(withEdges([]))).not.toContain('no reference price');
    for (const m of [withEdges([]), withEdges(['x'])]) {
      for (const [cols, rows] of [[40, 10], [80, 24], [220, 60]]) {
        const lines = render(m, { tab: 'edge', sel: 1, cols, rows }, Date.now());
        expect(lines).toHaveLength(rows);
        for (const l of lines) expect(vlen(l), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
      }
    }
  });
});

describe('holders market picker', () => {
  const ms = [
    { cid: 'a', marketType: 'moneyline' }, { cid: 'b', marketType: 'spreads' }, { cid: 'c', marketType: 'spreads' }, { cid: 'd', marketType: 'totals' }, { cid: 'e', marketType: 'totals' },
  ];
  it('steps one market and wraps', () => {
    expect(pickMarket(ms, 'a', ']')?.cid).toBe('b');
    expect(pickMarket(ms, 'e', ']')?.cid).toBe('a');
    expect(pickMarket(ms, 'a', '[')?.cid).toBe('e');
  });
  it('jumps to the next and previous market type', () => {
    expect(pickMarket(ms, 'a', '}')?.cid).toBe('b');
    expect(pickMarket(ms, 'b', '}')?.cid).toBe('d'); // skips the rest of spreads
    expect(pickMarket(ms, 'd', '{')?.cid).toBe('b'); // first market of the previous type
    expect(pickMarket(ms, 'e', '}')?.cid).toBe('a');
  });
  it('does nothing with a single market', () => {
    expect(pickMarket([ms[0]], 'a', ']')).toBeUndefined();
  });
});

describe('x-ray tab', () => {
  const base = (m: Partial<Model> = {}): Model => ({
    anomalies: [], games: [], prints: [], leads: [], holders: null, showBots: false, oiSeries: [], filter: null,
    status: { lastPollAt: 1, nextPollAt: null, busy: false, error: null, events: 0, historySecs: 0, printsWindowMin: null, message: null }, ...m,
  });
  const view = (cols = 120, rows = 30): View => ({ tab: 'xray', sel: 0, cols, rows });
  const report = buildXray('0xabc', [{ ts: 1, economicPnl: 0, positionPnl: 0, realizedPnl: 0, referralIncome: 0, rewardIncome: 0, yieldIncome: 0, makerRebate: 0, takerRebate: 0, volume: 0, tradeCount: 0 }, { ts: 2_000_000, economicPnl: -500, positionPnl: -500, realizedPnl: -500, referralIncome: 0, rewardIncome: 0, yieldIncome: 0, makerRebate: 0, takerRebate: 0, volume: 10_000, tradeCount: 50 }], [], Array.from({ length: 13 }, () => ({ cid: 'c', title: 't', slug: 's', outcome: 'Yes', status: 'CLOSED', cost: 100, value: 0, totalPnl: 100, realizedPnl: 100, unrealizedPnl: 0, firstEntryAt: null })), { all: [], takerOnly: [] }, 2_000_000);
  it('explains how to open it before any wallet is chosen', () => {
    expect(strip(render(base(), view(), Date.now()).join('\n'))).toMatch(/select a wallet and press x/);
  });
  it('shows progress, then the record with the closed-versus-all-in contrast', () => {
    const loading = strip(render(base({ xray: { wallet: '0xabc', stage: 'reading closed positions', done: false, error: null, report: null } }), view(), Date.now()).join('\n'));
    expect(loading).toMatch(/Wallet X-ray\s+0xabc\s+reading closed positions/);
    const done = strip(render(base({ xray: { wallet: '0xabc', stage: 'done', done: true, error: null, report }, }), view(), Date.now()).join('\n'));
    expect(done).toMatch(/ALL-IN PnL -\$500/);
    expect(done).toMatch(/CLOSED\s+13 positions/);
    expect(done).toMatch(/does not say a copier would earn the same/);
    expect(strip(render(base({ xray: { wallet: '0xabc', stage: 'done', done: true, error: 'down', report: null } }), view(), Date.now()).join('\n'))).toMatch(/down/);
  });
  it('never overflows its box', () => {
    const m = base({ xray: { wallet: '0xabc', stage: 'done', done: true, error: null, report } });
    for (const [cols, rows] of [[40, 10], [60, 14], [80, 24], [140, 40], [220, 60]]) {
      const lines = render(m, view(cols, rows), Date.now());
      expect(lines, `${cols}x${rows}`).toHaveLength(rows);
      for (const l of lines) expect(vlen(l), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
    }
  });
});

describe('holders tab: cluster, market strip and flow blocks', () => {
  const row = (NOWS: number, wallet: string, createdAgoH: number) => ({
    wallet, name: null, outcomeIndex: 0, outcome: 'Yes', shares: 1000, avgPrice: 0.5, curPrice: 0.5, posUsd: 500, uPnl: 0, pnlAll: 0, pnlWeek: 0, vol: 1, traded: 1, ageDays: 1, perDay: 1,
    cls: 'LOW_DATA' as const, confidence: 'low' as const, reasons: [], flags: [], createdAt: NOWS - createdAgoH * 3_600,
  });
  const build = (): Model => {
  const NOWS = Math.floor(Date.now() / 1000);
  const holders = {
    slug: 's', eventTitle: 'E', question: 'Will X happen?', cid: 'c', rows: [row(NOWS, '0xa', 30), row(NOWS, '0xb', 28), row(NOWS, '0xc', 26)], markets: [], total: 3, loaded: 3, done: true, error: null,
    info: { book: { bid: 0.48, ask: 0.5, spreadCents: 2, bidDepthUsd: 900, askDepthUsd: 400 }, endsAt: NOWS + 86_400, acceptingOrders: true, uma: ['proposed'], rules: 'Resolves Yes if X.' },
    flow: { yesLabel: 'Yes', noLabel: 'No', data: { fills: 1, profiled: 1, windows: [0, 1, 2].map((i) => ({ secs: [3600, 21600, 86400][i], totalUsd: 100, coverage: 1, buckets: [{ cls: 'HUMAN' as const, yesUsd: 100, noUsd: 0, fills: 1, wallets: 1 }] })) } },
  };
  return { anomalies: [], games: [], prints: [], leads: [], holders, showBots: false, oiSeries: [], filter: null, status: { lastPollAt: 1, nextPollAt: null, busy: false, error: null, events: 0, historySecs: 0, printsWindowMin: null, message: null } } as unknown as Model;
  };
  it('shows the new-account cluster, the market strip and the flow by class, within the box', () => {
    const m = build();
    for (const [cols, rows] of [[100, 30], [140, 40], [60, 14], [220, 60]]) {
      const lines = render(m, { tab: 'holders', sel: 0, cols, rows }, Date.now());
      expect(lines, `${cols}x${rows}`).toHaveLength(rows);
      for (const l of lines) expect(vlen(l)).toBeLessThanOrEqual(cols);
    }
    const text = render(m, { tab: 'holders', sel: 0, cols: 140, rows: 40 }, Date.now()).map(strip).join('\n');
    expect(text).toMatch(/CLUSTER 3 new accounts created within 4\.0 h of each other/);
    expect(text).toMatch(/not proof of common control/);
    expect(text).toMatch(/Yes 48\.0\/50\.0c, spread 2\.0c/);
    expect(text).toMatch(/UMA oracle: proposed/);
    expect(text).toMatch(/FLOW BY WHO, last 24h/);
    expect(text).toMatch(/HUMAN\s+Yes\s+\$100/);
  });
});

describe('new wallets tab', () => {
  const top = [
    { wallet: `0x${'a'.repeat(40)}`, name: 'fresh1', ageDays: 2, usd: 4200, leanOutcome: 'Yes', trades: 3 },
    { wallet: `0x${'b'.repeat(40)}`, name: null, ageDays: 5, usd: 800, leanOutcome: 'Yes', trades: 1 },
  ];
  const rows = [
    { cid: 'c1', eventSlug: 'some-event', question: 'Will the thing happen by Friday?', wallets: 40, newWallets: 9, knownUsd: 30_000, newUsd: 12_500, newShare: 0.42, lift: 4.6, lean: { outcome: 'Yes', share: 0.88 }, topShare: 0.34, top },
    { cid: 'c2', eventSlug: 'other', question: 'Second market', wallets: 90, newWallets: 4, knownUsd: 50_000, newUsd: 900, newShare: 0.02, lift: 0.7, lean: null, topShare: 0.5, top: [] },
  ];
  const result = { rows, windowMins: 30, maxAgeDays: 14, trades: 22_000, markets: 900, wallets: 3_100, aged: 3_000, toAge: 100, coverage: 0.93, platformNewShare: 0.09, newWalletsTotal: 210 };
  const m = { anomalies: [], games: [], prints: [], leads: [], holders: null, showBots: false, oiSeries: [], filter: null, status: { lastPollAt: 1, nextPollAt: null, busy: false, error: null, events: 0, historySecs: 0, printsWindowMin: null, message: null }, newWallets: { stage: 'done', done: true, error: null, result, at: 1 } } as unknown as Model;
  it('lists markets by new money with share, lift and lean, and details the selected one', () => {
    const text = render(m, { tab: 'wallets', sel: 0, cols: 140, rows: 40 }, Date.now()).map(strip).join('\n');
    expect(text).toMatch(/New wallets/);
    expect(text).toMatch(/last 30 min: 22,000 fills/);
    expect(text).toMatch(/100 wallets not aged yet/);
    expect(text).toMatch(/\$12\.5k\s+9\s+40\s+42%\s+x4\.6\s+Yes 88%\s+Will the thing happen by Friday\?/);
    expect(text).toMatch(/0xaaaa…aaaa\s+fresh1\s+2d old\s+\$4\.2k\s+leans Yes/);
    expect(text).toMatch(/34% of the new money is the biggest wallet.*platform's 9\.0%.*Enter: holders/);
  });
  it('explains itself before the first scan, shows progress, and stays inside its box', () => {
    const none = { ...m, newWallets: null } as Model;
    expect(strip(render(none, { tab: 'wallets', sel: 0, cols: 120, rows: 30 }, Date.now()).join('\n'))).toMatch(/press w: lists the markets that new accounts/);
    const busy = { ...m, newWallets: { stage: 'looking up wallet ages: 50/900', done: false, error: null, result: null, at: null } } as unknown as Model;
    expect(strip(render(busy, { tab: 'wallets', sel: 0, cols: 120, rows: 30 }, Date.now()).join('\n'))).toMatch(/looking up wallet ages: 50\/900…/);
    for (const [cols, rowsN] of [[40, 10], [60, 14], [80, 24], [140, 40], [220, 60]]) {
      for (const sel of [0, 1]) {
        const lines = render(m, { tab: 'wallets', sel, cols, rows: rowsN }, Date.now());
        expect(lines, `${cols}x${rowsN}`).toHaveLength(rowsN);
        for (const l of lines) expect(vlen(l)).toBeLessThanOrEqual(cols);
      }
    }
    expect(moveSelection({ tab: 'anomalies', sel: 0, cols: 120, rows: 40 }, 'w', m).tab).toBe('wallets');
    expect(moveSelection({ tab: 'wallets', sel: 0, cols: 120, rows: 40 }, 'end', m).sel).toBe(1);
  });
});

describe('following tab', () => {
  const NOWS = () => Math.floor(Date.now() / 1000);
  const trade = (ago: number, isNew = false) => ({ ts: NOWS() - ago, tx: `0x${ago}`, token: 't', side: 'BUY', price: 0.62, size: 500, outcome: 'Yes', title: 'Will the thing happen?', slug: 's', cid: 'c', isNew });
  const card = (over = {}) => ({
    wallet: `0x${'a'.repeat(40)}`, name: 'Sonix', note: null, error: null, loadedAt: NOWS(), pnl7d: -84_000, pnl30d: 13_000, pnlAll: 75_900, volume: 1e7, openCount: 2, openValue: 28_600, unrealized: -11_800,
    positions: [{ cid: 'c', title: 'Big open market', slug: 's', outcome: 'No', status: 'OPEN', cost: 20_000, value: 18_000, totalPnl: -2_000, realizedPnl: 0, unrealizedPnl: -2_000, firstEntryAt: null }],
    trades: [trade(30, true), trade(4_000)], style: { trades: 40, buyShare: 0.8, avgUsd: 310, medianUsd: 120, markets: 12, avgBuyPrice: 0.55 }, newTrades: 1, ...over,
  });
  const base = (follow: unknown) => ({ anomalies: [], games: [], prints: [], leads: [], holders: null, showBots: false, oiSeries: [], filter: null, status: { lastPollAt: 1, nextPollAt: null, busy: false, error: null, events: 0, historySecs: 0, printsWindowMin: null, message: null }, follow }) as unknown as Model;
  const fv = (cards: unknown[], extra = {}) => ({ cards, seen: {}, loading: false, loadedAt: Date.now(), input: null, message: null, ...extra });
  it('lists accounts with PnL, open size, last bet and style, and details the selected one: bets, holdings, new marks', () => {
    const text = render(base(fv([card(), card({ wallet: `0x${'b'.repeat(40)}`, name: null, note: 'whale', newTrades: 0 })])), { tab: 'follow', sel: 0, cols: 150, rows: 40 }, Date.now()).map(strip).join('\n');
    expect(text).toMatch(/FOLLOWING\s+2 wallets/);
    expect(text).toMatch(/●1\s+Sonix\s+-\$84k\s+\+\$13k\s+\+\$76k\s+\$29k/);
    expect(text).toMatch(/whale/);
    expect(text).toMatch(/last 40 bets: avg \$310, median \$120, 80% buys, 12 markets, buys at 55c on average/);
    expect(text).toMatch(/RECENT BETS/);
    expect(text).toMatch(/BUY\s+Yes\s+62c\s+\$310\s+● Will the thing happen\?/);
    expect(text).toMatch(/HOLDING NOW\s+2 open positions, \$29k/);
    expect(text).toMatch(/Big open market/);
  });
  it('shows the add-by-link prompt, a message, the empty state and a failed wallet', () => {
    const prompt = strip(render(base(fv([card()], { input: 'https://polymarket.com/@tech' })), { tab: 'follow', sel: 0, cols: 140, rows: 30 }, Date.now()).join('\n'));
    expect(prompt).toMatch(/Follow: paste a 0x wallet, polymarket\.com\/profile\/0x… or polymarket\.com\/@name\s+https:\/\/polymarket\.com\/@tech/);
    expect(strip(render(base(fv([card()], { message: 'now following Sonix (1 total)' })), { tab: 'follow', sel: 0, cols: 140, rows: 30 }, Date.now()).join('\n'))).toMatch(/now following Sonix/);
    expect(strip(render(base(fv([])), { tab: 'follow', sel: 0, cols: 140, rows: 30 }, Date.now()).join('\n'))).toMatch(/nobody followed yet: press \+ and paste/);
    expect(strip(render(base(fv([card({ error: 'HTTP 500', trades: [], positions: [], style: null, newTrades: 0 })])), { tab: 'follow', sel: 0, cols: 140, rows: 30 }, Date.now()).join('\n'))).toMatch(/HTTP 500/);
  });
  it('stays inside its box at every size', () => {
    const m = base(fv([card(), card({ name: 'B' }), card({ name: 'C' })]));
    for (const [cols, rows] of [[40, 10], [60, 14], [80, 24], [140, 40], [220, 60]])
      for (const sel of [0, 2]) {
        const lines = render(m, { tab: 'follow', sel, cols, rows }, Date.now());
        expect(lines, `${cols}x${rows}`).toHaveLength(rows);
        for (const l of lines) expect(vlen(l)).toBeLessThanOrEqual(cols);
      }
  });
});
