import { describe, expect, it } from 'vitest';
import { charWidth, clip, fit, sparkline, strip, truncate, vlen } from '../../radar/tui/ansi';
import { moveSelection, render, type Model, type View } from '../../radar/tui/render';
import type { Anomaly } from '../../radar/detect';
import { applyFilters } from '../../radar/collect';

const anomaly = (i: number, over: Partial<Anomaly> = {}): Anomaly => ({
  eventId: String(i), slug: `ev-${i}`, title: i % 3 === 0 ? `日本語のイベント ${i} 🚀 with a really long title that must be cut cleanly` : `Event number ${i}`, cat: 'politics', isGame: false,
  score: 90 - i, level: i < 2 ? 'HOT' : i < 6 ? 'WATCH' : 'NONE',
  reasons: [{ code: 'oi_surge', points: 40, text: 'open interest +$120k (+18%) in 61m' }, { code: 'fresh_money', points: 20, text: '2 new/thin wallet(s) put $15k in' }], notes: [],
  m: { oi: 800_000, dOi1h: 120_000, dOi1hPct: 0.18, dOi1hSpanMin: 61, dOi15m: null, dOi15mPct: null, dOi24h: null, dOi24hPct: null, vol24: 2_400_000, accel: 4.2, turnover: 3, liq: 90_000, price: 0.42, ch1h: 0.12, ch1d: null },
  flow: { usd1h: 80_000, prints1h: 5, biggestUsd: 30_000, freshUsd: 15_000, freshWallets: 2, cluster: false, top: { usd: 30_000, wallet: '0xabc', tag: 'NEW', outcome: 'Yes', side: 'BUY' } },
  ...over,
});
const model = (n = 40): Model => ({
  anomalies: Array.from({ length: n }, (_, i) => anomaly(i)),
  prints: [{ key: 'k', ts: Date.now() / 1000 - 90, wallet: '0x1234567890abcdef1234567890abcdef12345678', cid: '0xc', eventSlug: 'ev', title: 'Some market', outcome: 'Yes', side: 'BUY', price: 0.41, size: 50_000, usd: 20_500, name: null, tag: { kind: 'NEW', ageDays: 2, traded: 1 } }],
  leads: [{ feedId: 'esic', url: 'https://esic.gg/x', title: 'ESIC Issues Interim Suspension to X', summary: 's', publishedAt: Date.now(), firstSeen: 1, relevant: true, category: 'sanction', matched: [], tierHint: 'INVESTIGATING', note: 'n', status: 'new', caseId: null }],
  status: { lastPollAt: Date.now(), nextPollAt: Date.now() + 90_000, busy: false, error: null, events: 300, historySecs: 3_000, printsWindowMin: 360, message: null },
  oiSeries: [1, 2, 3, 5, 8, 13, 21], filter: null, showGames: false,
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
      for (const tab of ['anomalies', 'prints', 'leads'] as const) {
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
    const empty: Model = { ...model(), anomalies: [], prints: [], leads: [], status: { ...model().status, error: 'HTTP 500', lastPollAt: null, nextPollAt: null } };
    for (const tab of ['anomalies', 'prints', 'leads'] as const) expect(() => render(empty, { tab, sel: 0, cols: 100, rows: 30 }, Date.now())).not.toThrow();
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
    expect(moveSelection({ ...v, sel: 4 }, '2', m)).toMatchObject({ tab: 'prints', sel: 0 });
    expect(moveSelection({ ...v, tab: 'leads' }, 'tab', m).tab).toBe('anomalies');
  });
  it('handles an empty list', () => {
    const m = { ...model(), anomalies: [] };
    expect(moveSelection(v, 'end', m).sel).toBe(0);
    expect(moveSelection(v, 'down', m).sel).toBe(0);
  });
});

describe('anomaly filters', () => {
  const list = [anomaly(1, { cat: 'politics' }), anomaly(2, { cat: 'sports', isGame: true }), anomaly(3, { cat: 'crypto' }), anomaly(4, { cat: 'esports', isGame: true })];
  it('hides games by default and can show them', () => {
    expect(applyFilters(list, { cat: null, showGames: false }).map((a) => a.eventId)).toEqual(['1', '3']);
    expect(applyFilters(list, { cat: null, showGames: true })).toHaveLength(4);
  });
  it('combines category and game filters', () => {
    expect(applyFilters(list, { cat: 'sports', showGames: false })).toHaveLength(0);
    expect(applyFilters(list, { cat: 'sports', showGames: true }).map((a) => a.eventId)).toEqual(['2']);
  });
  it('says in the header whether games are hidden', () => {
    const header = strip(render(model(), { tab: 'anomalies', sel: 0, cols: 160, rows: 30 }, Date.now()).join('\n'));
    expect(header).toContain('games hidden');
  });
});
