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
    expect(moveSelection({ ...v, sel: 4 }, '3', m)).toMatchObject({ tab: 'prints', sel: 0 });
    expect(moveSelection({ ...v, tab: 'leads' }, 'tab', m).tab).toBe('decision');
    expect(moveSelection({ ...v, tab: 'decision' }, 'tab', m).tab).toBe('search');
    expect(moveSelection({ ...v, tab: 'search' }, 'tab', m).tab).toBe('ledger'); // the lab tabs (news, edge, jumps, new) are not in the cycle
    expect(moveSelection({ ...v, tab: 'ledger' }, 'tab', m).tab).toBe('xray');
    expect(moveSelection({ ...v, tab: 'xray' }, 'tab', m).tab).toBe('anomalies');
    for (const lab of ['news', 'edge', 'jumps', 'new'] as const) expect(moveSelection({ ...v, tab: lab }, 'tab', m).tab).toBe('anomalies');
    expect(moveSelection(v, '8', m).tab).toBe('news'); // lab keys still open them
    expect(moveSelection(v, '9', m).tab).toBe('edge');
    expect(moveSelection(v, 'j', m).tab).toBe('jumps');
    expect(strip(render(m, v, Date.now())[1])).not.toMatch(/News|Edge|Jumps/);
    expect(strip(render(m, { ...v, tab: 'jumps' }, Date.now())[1])).toMatch(/j Jumps/);
    expect(moveSelection({ ...v, tab: 'anomalies' }, 'x', m).tab).toBe('xray');
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
    expect(moveSelection({ tab: 'anomalies', sel: 0, cols: 120, rows: 40 }, '5', m).tab).toBe('leads');
    expect(moveSelection({ tab: 'anomalies', sel: 0, cols: 120, rows: 40 }, '6', m).tab).toBe('decision');
  });
});

describe('ledger tab', () => {
  // A synthetic world: one 2-outcome market per day, each with T-8h and T-5m snapshots and a result.
  const day0 = Date.UTC(2026, 10, 1) / 1000;
  const snaps = Array.from({ length: 12 }, (_, i) => {
    const startTs = day0 + i * 86_400;
    const q = (mid: number) => [{ outcome: 'A', bid: mid - 0.01, ask: mid + 0.01, mid, bidUsd: 50, askUsd: 50 }, { outcome: 'B', bid: 1 - mid - 0.01, ask: 1 - mid + 0.01, mid: 1 - mid, bidUsd: 50, askUsd: 50 }];
    const base = { v: 1, cid: `0x${i}`, slug: `game-${i}`, title: `Game ${i}`, event: `Game ${i}`, sport: 'nba', outcomes: ['A', 'B'], startTs, vol24: 1000, holders: null, holdersAbsent: true };
    return [{ ...base, label: 'T-8h', capturedAt: startTs - 28_800, quotes: q(0.5) }, { ...base, label: 'T-5m', capturedAt: startTs - 300, quotes: q(0.6) }];
  }).flat();
  const results = Array.from({ length: 12 }, (_, i) => ({ cid: `0x${i}`, winnerIdx: i % 2, payout: i % 2 ? [0, 1] : [1, 0], settledAt: day0 + i * 86_400 + 10_000 }));
  const withLedger = (report = scoreLedger(snaps, results, { iterations: 200 })): Model => ({ ...model(), ledger: { at: Date.now(), error: null, report } });
  const text = (m: Model, cols = 150, rows = 40, sel = 0) => strip(render(m, { tab: 'ledger', sel, cols, rows }, Date.now()).join('\n'));

  it('lists every strategy with n, hit vs break-even, ROI, CI and verdict, under the standing line', () => {
    const t = text(withLedger());
    expect(t).toContain('0 Ledger');
    expect(t).toContain(LEDGER_STANDING);
    expect(t).toMatch(/STRATEGY\s+N\s+HIT\s+B\/E\s+ROI\/\$1\s+99% CI\s+VERDICT/);
    for (const id of ['fade-move', 'follow-move', 'favorite', 'underdog', 'top-holders-lean']) expect(t).toContain(id);
    expect(t).toMatch(/favorite\s+12\s+50\.0%\s+61\.0%/);
    expect(t).toContain('NO EDGE PROVEN');
    expect(t).toContain('1-9,0 tabs');
    expect(t).toContain('j jumps');
  });

  it('says there is no data yet on empty logs, and survives no ledger at all', () => {
    expect(text(withLedger(scoreLedger([], [])))).toContain('no data yet');
    expect(text({ ...model(), ledger: null })).toContain(LEDGER_STANDING);
    expect(text({ ...model(), ledger: { at: Date.now(), error: 'ledger: boom', report: null } })).toContain('ledger: boom');
  });

  it('shows the selected strategy rule in the detail pane', () => {
    expect(text(withLedger(), 150, 40, 2)).toContain('fill = T-5m ask');
  });

  it('never overflows its box at any terminal size', () => {
    for (const m of [withLedger(), withLedger(scoreLedger([], [])), { ...model(), ledger: null }]) {
      for (const [cols, rows] of [[40, 10], [60, 16], [80, 24], [100, 30], [140, 40], [220, 60]]) {
        for (const sel of [0, 4]) {
          const lines = render(m, { tab: 'ledger', sel, cols, rows }, Date.now());
          expect(lines, `${cols}x${rows}`).toHaveLength(rows);
          for (const l of lines) expect(vlen(l), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
        }
      }
    }
  });

  it('appends the calm-then-jump block from the jump log, standing line unchanged', () => {
    const t0 = Date.UTC(2026, 10, 1, 12) / 1000;
    const jl = [
      { v: 1, kind: 'flag', id: `0xj|${t0}`, cid: '0xj', slug: 'm', eventSlug: 'ev-j', title: 'Jumped', outcomes: ['Yes', 'No'], tokenIds: ['1', '2'], direction: 'up', upIdx: 0, pRef: 0.3, pNow: 0.5, move: 0.2, calmRange: 0.05, calmPoints: 20, calm: true, vol30m: 900, freshShare: 0.6, quotes: [], detectedAt: t0, flaggedAt: t0 },
      { v: 1, kind: 'entry', id: `0xj|${t0}`, cid: '0xj', capturedAt: t0 + 400, lagSecs: 400, quotes: [{ outcome: 'Yes', bid: 0.49, ask: 0.51, mid: 0.5, bidUsd: 10, askUsd: 10 }, { outcome: 'No', bid: 0.49, ask: 0.51, mid: 0.5, bidUsd: 10, askUsd: 10 }] },
      { v: 1, kind: 'result', cid: '0xj', winnerIdx: 1, payout: [0, 1], settledAt: t0 + 9000 },
    ];
    const m: Model = { ...model(), ledger: { at: Date.now(), error: null, report: scoreLedger(snaps, results, { iterations: 200 }), jumps: scoreJumps(jl, { iterations: 200 }) } };
    const t = text(m, 200, 60);
    expect(t).toContain(LEDGER_STANDING);
    expect(t).toContain('Calm-then-jump forward test');
    expect(t).toContain('Calm-then-jump forward log: 1 flags (1 calm, 0 loose-only), 1 entries, 1 scorable');
    expect(t).toMatch(/jump-fade\s+n=1 /);
    expect(t).toContain('NO EDGE PROVEN');
    expect(t.indexOf('fade-move')).toBeLessThan(t.indexOf('Calm-then-jump'));
    const empty = text({ ...model(), ledger: { at: Date.now(), error: null, report: scoreLedger([], []), jumps: scoreJumps([]) } }, 200, 60);
    expect(empty).toContain('no jump flags logged yet');
    expect(empty).toContain(LEDGER_STANDING);
    for (const [cols, rows] of [[40, 10], [60, 16], [80, 24], [140, 40], [220, 60]]) {
      const lines = render(m, { tab: 'ledger', sel: 0, cols, rows }, Date.now());
      expect(lines).toHaveLength(rows);
      for (const l of lines) expect(vlen(l), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
    }
  });

  it('opens with key 0 and moves within the strategies', () => {
    const m = withLedger();
    const v: View = { tab: 'anomalies', sel: 3, cols: 120, rows: 40 };
    expect(moveSelection(v, '0', m)).toMatchObject({ tab: 'ledger', sel: 0 });
    expect(moveSelection({ ...v, tab: 'ledger', sel: 0 }, 'end', m).sel).toBe(4);
    expect(moveSelection({ ...v, tab: 'ledger', sel: 0 }, 'end', { ...m, ledger: null }).sel).toBe(0);
  });
});

describe('new-markets tab', () => {
  // Date is faked per test (tests/setup.ts), so times are read inside each builder, never at describe time.
  const nowSecs = () => Math.floor(Date.now() / 1000);
  const features = (over: Partial<EarlyFeatures> = {}): EarlyFeatures => ({
    firstTs: nowSecs() - 7_200, windowSecs: 3_600, windowComplete: true, fills: 9, usd: 4_769, wallets: 3, topWalletShare: 0.96, newAcctShare: 0.45, ageCoverage: 0.9,
    yesUsd: 4_700, noUsd: 69, oneSided: 0.97, leanIdx: 0, firstPrice: 0.5, lastPrice: 0.64, drift: 0.14, largestUsd: 3_000, largestShare: 0.63, tradesPerMin: 0.15, ...over,
  });
  const row = (i: number, over: Partial<ScanRow> = {}): ScanRow => ({
    cid: `0x${i}`, slug: `mk-${i}`, eventSlug: `ev-new-${i}`, title: i % 4 === 0 ? `日本語 新市場 ${i} 🚀 with a really long market question that must be cut cleanly` : `New market number ${i}`,
    outcomes: ['Yes', 'No'], tokenIds: ['1', '2'], createdAt: nowSecs() - 3 * 3600 - i * 60, features: features(), score: 4 + (i % 3),
    reasons: ['one-sided flow 97% to Yes', 'top wallet 96% of volume', 'accounts under 30d old 45% of volume'], flagged: true, ...over,
  });
  const summary = (rows: ScanRow[], over: Partial<ScanSummary> = {}): ScanSummary => ({
    listed: 169, excluded: 0, considered: 60, scanned: 60, noTrades: 0, skipped: 0, truncated: 0, ageLookups: 40, flagged: rows.filter((r) => r.flagged).length, rows, lines: [], errors: [], ...over,
  });
  const withNew = (rows: ScanRow[], over: Partial<NonNullable<Model['newMarkets']>> = {}): Model => ({ ...model(), newMarkets: { stage: 'done', done: true, error: null, at: Date.now(), summary: summary(rows), logged: { written: 2, duplicates: 0 }, ...over } });
  const many = () => Array.from({ length: 40 }, (_, i) => row(i));
  const text = (m: Model, cols = 150, rows = 40, sel = 0) => strip(render(m, { tab: 'new', sel, cols, rows }, Date.now()).join('\n'));

  it('ranks flagged markets with age, score, 60-min volume, shares and lean, under the standing line', () => {
    const m = withNew([row(1, { score: 4 }), row(2, { score: 6, title: 'Top scorer' }), row(3, { flagged: false, score: 1, title: 'Quiet market' })]);
    const t = text(m);
    expect(t).toContain('W New');
    expect(t).toContain(NEW_STANDING);
    expect(t).toContain('not evidence of insider trading');
    expect(t).toMatch(/AGE\s+SC\s+VOL60M\s+TOPWAL\s+NEWACC\s+LEAN\s+MARKET/);
    expect(t).toMatch(/3\.0h\s+6\s+\$5k\s+96%\s+45%\s+Yes 97%\s+Top scorer/);
    expect(t.indexOf('Top scorer')).toBeLessThan(t.indexOf('New market number 1'));
    expect(t).not.toContain('Quiet market');
    expect(t).toContain('60 of 169 new scanned, 2 flagged, 2 logged');
    expect(t).toContain('w new');
    expect(t).toContain('j jumps');
  });

  it('lists the selected market reasons and link in the detail pane', () => {
    const t = text(withNew([row(1, { score: 6 }), row(2, { score: 4, reasons: ['price drift 14 pts toward Yes'] })]), 150, 40, 1);
    expect(t).toContain('price drift 14 pts toward Yes');
    expect(t).toContain('polymarket.com/event/ev-new-2');
    expect(t).toContain('p decide · n news');
  });

  it('prompts for w before a scan, shows progress, the empty result and errors', () => {
    expect(text({ ...model(), newMarkets: null })).toContain('press w to scan');
    expect(text({ ...model(), newMarkets: null })).toContain(NEW_STANDING);
    expect(text(withNew([], { done: false, stage: 'scanning', summary: null, at: null, logged: null }))).toContain('scanning…');
    expect(text(withNew([row(1, { flagged: false })]))).toContain('no new market crossed the flag score (60 scanned)');
    const failed = text(withNew([], { error: 'HTTP 429', summary: null, at: null, logged: null }));
    expect(failed).toContain('HTTP 429');
    expect(failed).toContain(NEW_STANDING);
  });

  it('never overflows its box at any terminal size', () => {
    for (const m of [withNew(many()), withNew([]), withNew([], { done: false, summary: null }), { ...model(), newMarkets: null }, withNew([row(1, { features: features({ newAcctShare: null, leanIdx: null, ageCoverage: null, firstPrice: null, lastPrice: null }) })])]) {
      for (const [cols, rows] of [[40, 10], [60, 16], [80, 24], [100, 30], [140, 40], [220, 60]]) {
        for (const sel of [0, 4, 39]) {
          const lines = render(m, { tab: 'new', sel, cols, rows }, Date.now());
          expect(lines, `${cols}x${rows}`).toHaveLength(rows);
          for (const l of lines) expect(vlen(l), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
        }
      }
    }
  });

  it('opens with key w and moves within the flagged markets only', () => {
    const m = withNew([...many(), row(99, { flagged: false })]);
    const v: View = { tab: 'anomalies', sel: 3, cols: 120, rows: 40 };
    expect(moveSelection(v, 'w', m)).toMatchObject({ tab: 'new', sel: 0 });
    expect(moveSelection({ ...v, tab: 'new', sel: 0 }, 'end', m).sel).toBe(39);
    expect(moveSelection({ ...v, tab: 'new', sel: 0 }, 'end', { ...m, newMarkets: null }).sel).toBe(0);
  });

  it('keeps the selected row on screen when scrolling', () => {
    expect(text(withNew(many()), 120, 30, 37)).toContain('New market number 37');
  });
});

describe('jumps tab', () => {
  const flag = (i: number, over: Partial<JumpFlag> = {}): JumpFlag => ({
    cid: `0xj${i}`, slug: `mk-${i}`, eventSlug: `ev-jump-${i}`, title: i % 4 === 0 ? `日本語 ジャンプ ${i} 🚀 with a really long market question that must be cut cleanly` : `Jump market ${i}`,
    outcomes: ['Yes', 'No'], tokenIds: ['1', '2'], direction: i % 2 ? 'down' : 'up', upIdx: i % 2, pRef: 0.3, pNow: 0.3 + (i % 2 ? -0.16 : 0.16) - i * 0.001, move: (i % 2 ? -0.16 : 0.16) - i * 0.001,
    calmRange: 0.05, calmPoints: 30, calm: i % 3 !== 0, vol30m: 12_000, freshShare: i % 5 ? 0.42 : null,
    quotes: [{ outcome: 'Yes', bid: 0.45, ask: 0.47 }, { outcome: 'No', bid: 0.53, ask: 0.55 }], detectedAt: Math.floor(Date.now() / 1000), ...over,
  });
  const withJumps = (flags: JumpFlag[], over: Partial<NonNullable<Model['jumps']>> = {}): Model => ({
    ...model(), jumps: { stage: 'done', done: true, error: null, at: Date.now(), scan: { events: 500, markets: 400, screened: 61, checked: 61, flags, reasons: { 'small-move': 18 }, errors: [] }, ...over },
  });
  const many = () => Array.from({ length: 40 }, (_, i) => flag(i));
  const text = (m: Model, cols = 150, rows = 40, sel = 0) => strip(render(m, { tab: 'jumps', sel, cols, rows }, Date.now()).join('\n'));

  it('lists live flags with direction, pRef->pNow, rule, volume and fresh share, under the standing line', () => {
    const t = text(withJumps([flag(1, { title: 'Small mover', move: -0.15, pNow: 0.15 }), flag(2, { title: 'Big mover', move: 0.3, pRef: 0.2, pNow: 0.5, calm: false })]));
    expect(t).toContain('j Jumps');
    expect(t).toContain(JUMPS_STANDING);
    expect(t).toContain('leads, not signals; no edge shown');
    expect(t).toMatch(/DIR\s+PRICE 30M\s+RULE\s+VOL30M\s+FRESH\s+MARKET/);
    expect(t).toMatch(/UP\s+0\.20->0\.50\s+loose\s+\$12k\s+42%\s+Big mover/);
    expect(t).toMatch(/DOWN\s+0\.30->0\.15\s+calm\s+\$12k/);
    expect(t.indexOf('Big mover')).toBeLessThan(t.indexOf('Small mover'));
    expect(t).toContain('400 markets, 61 screened, 61 checked, 2 flag(s)');
    expect(t).toContain('j jumps');
  });

  it('shows the selected flag with its link and actions in the detail pane', () => {
    const t = text(withJumps([flag(2), flag(1)]), 150, 40, 1); // sorted by |move|: flag 1 (16.1 pts) first, so row 1 is flag 2
    expect(t).toContain('polymarket.com/event/ev-jump-2');
    expect(t).toContain('p decide · n news · o link');
    expect(t).toContain('Yes 0.45/0.47');
  });

  it('prompts for j before a scan, shows progress, the empty result and errors', () => {
    expect(text({ ...model(), jumps: null })).toContain('press j to scan');
    expect(text({ ...model(), jumps: null })).toContain(JUMPS_STANDING);
    expect(text(withJumps([], { done: false, stage: 'checking price history 3, 0 jump(s) so far', scan: null, at: null }))).toContain('checking price history 3, 0 jump(s) so far…');
    expect(text(withJumps([]))).toContain('no market jumped 15+ points in the last 30 minutes (61 checked)');
    const failed = text(withJumps([], { error: 'HTTP 429', scan: null, at: null }));
    expect(failed).toContain('HTTP 429');
    expect(failed).toContain(JUMPS_STANDING);
  });

  it('never overflows its box at any terminal size', () => {
    for (const m of [withJumps(many()), withJumps([]), withJumps([], { done: false, scan: null }), { ...model(), jumps: null }, withJumps([flag(1, { freshShare: null, outcomes: ['Team Spirit', 'NAVI'] })])]) {
      for (const [cols, rows] of [[40, 10], [60, 16], [80, 24], [100, 30], [140, 40], [220, 60]]) {
        for (const sel of [0, 4, 39]) {
          const lines = render(m, { tab: 'jumps', sel, cols, rows }, Date.now());
          expect(lines, `${cols}x${rows}`).toHaveLength(rows);
          for (const l of lines) expect(vlen(l), `${cols}x${rows}`).toBeLessThanOrEqual(cols);
        }
      }
    }
  });

  it('opens with key j and moves within the flags', () => {
    const m = withJumps(many());
    const v: View = { tab: 'anomalies', sel: 3, cols: 120, rows: 40 };
    expect(moveSelection(v, 'j', m)).toMatchObject({ tab: 'jumps', sel: 0 });
    expect(moveSelection({ ...v, tab: 'jumps', sel: 0 }, 'end', m).sel).toBe(39);
    expect(moveSelection({ ...v, tab: 'jumps', sel: 0 }, 'end', { ...m, jumps: null }).sel).toBe(0);
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
