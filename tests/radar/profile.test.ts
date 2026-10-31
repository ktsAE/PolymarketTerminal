import { describe, expect, it } from 'vitest';
import { classifyWallet, isPerson, summarizeActivity, type ActivityRec, type ActivitySummary, type Lifetime } from '../../radar/profile';

const S = (over: Partial<ActivitySummary>): ActivitySummary => ({
  events: 500, trades: 450, spanHours: 100, perDay: 120, medGapSecs: 60, medUsd: 100, flipShare: 0, distinctMarkets: 40, rewards: 0, mergeSplit: 0, ...over,
});
const L = (over: Partial<Lifetime> = {}): Lifetime => ({ traded: 50, vol: 100_000, ageDays: 200, ...over });

// Numbers below are real wallets seen in the top holders of one Senate market (Oct 31 2026).
describe('classification of real top holders', () => {
  const cases: Array<[string, ActivitySummary, Lifetime, string]> = [
    ['nigiri99: 11.5k events/day, 36k markets', S({ perDay: 11_566, medGapSecs: 2, medUsd: 111, mergeSplit: 14, flipShare: 0 }), L({ traded: 35_987, vol: 144_603_755 }), 'BOT'],
    ['cigarettes: 157k markets, $607M volume', S({ perDay: 6_423, medGapSecs: 0, medUsd: 15, mergeSplit: 12 }), L({ traded: 157_118, vol: 606_708_253 }), 'BOT'],
    ['Gaditima: 21k markets, merges', S({ perDay: 1_210, medGapSecs: 6, medUsd: 34, mergeSplit: 63 }), L({ traded: 20_917, vol: 32_240_778 }), 'BOT'],
    ['aenews2: 3.3k markets, $256M, rewards', S({ perDay: 100, medGapSecs: 8, medUsd: 49, flipShare: 0.29, rewards: 7, mergeSplit: 5 }), L({ traded: 3_320, vol: 256_373_457 }), 'BOT'],
    ['botbot: 1.1k markets, tiny fills, many rewards (automated either way)', S({ perDay: 40, medGapSecs: 134, medUsd: 15, rewards: 21 }), L({ traded: 1_154, vol: 22_741_607 }), 'BOT'],
    ['SwissMiss: 1k markets, $88M volume, 6s gaps, $8 fills', S({ perDay: 3.8, medGapSecs: 6, medUsd: 8, mergeSplit: 6 }), L({ traded: 1_054, vol: 88_499_519, ageDays: 849 }), 'BOT'],
    ['thoodr: 969 markets in 185 days, rewards', S({ perDay: 20.5, medGapSecs: 400, medUsd: 200, rewards: 12, trades: 300 }), L({ traded: 969, vol: 11_051_464, ageDays: 185 }), 'ALGO'],
    ['toosensitive: only 4 markets but 373 tiny two-sided fills + rewards', S({ perDay: 23, medGapSecs: 15, medUsd: 58, flipShare: 0.75, trades: 373, rewards: 24 }), L({ traded: 4, vol: 739_168, ageDays: 18 }), 'MM'],
    ['als255: two-sided small fills + rewards', S({ perDay: 21, medGapSecs: 282, medUsd: 22, flipShare: 0.89, trades: 461, rewards: 37 }), L({ traded: 255, vol: 321_928 }), 'MM'],
    ['grinder1011: tiny fills + rewards', S({ perDay: 92, medGapSecs: 56, medUsd: 28, trades: 442, rewards: 6 }), L({ traded: 628, vol: 1_295_346 }), 'MM'],
    ['awfully: 11 markets over 3 months', S({ events: 28, trades: 25, perDay: 0.3, medGapSecs: 176, medUsd: 104, flipShare: 0.45, rewards: 1 }), L({ traded: 11, vol: 146_515, ageDays: 150 }), 'HUMAN'],
  ];
  for (const [name, s, life, want] of cases) it(name, () => expect(classifyWallet(s, life).cls).toBe(want));

  it('does not call a big but slow human a bot (423 markets over ~4 months, $6M profit)', () => {
    const c = classifyWallet(S({ perDay: 12, medGapSecs: 900, medUsd: 4_000, trades: 200, flipShare: 0.05 }), L({ traded: 423, vol: 8_000_000, ageDays: 134 }));
    expect(c.cls).toBe('HUMAN');
  });

  it('marks wallets with almost no history as LOW_DATA and keeps them in the people list', () => {
    const c = classifyWallet(S({ events: 8, trades: 8, perDay: 44, medUsd: 502 }), L({ traded: 3, vol: null, ageDays: 1 }));
    expect(c.cls).toBe('LOW_DATA');
    expect(isPerson(c.cls)).toBe(true);
    expect(isPerson('BOT') || isPerson('MM') || isPerson('ALGO')).toBe(false);
  });

  it('gives reasons for every automated verdict', () => {
    const c = classifyWallet(S({ perDay: 6_423, medGapSecs: 0 }), L({ traded: 157_118 }));
    expect(c.reasons.join(' ')).toMatch(/157,118 markets/);
    expect(c.confidence).toBe('high');
  });

  it('treats many markets per day of account age as an automation sign, but not a verdict by itself', () => {
    const c = classifyWallet(S({ perDay: 60, medUsd: 300 }), L({ traded: 100, ageDays: 20 })); // 5 markets/day
    expect(c.cls).toBe('ALGO');
    expect(c.confidence).toBe('low');
  });

  it('does not call a patient human a bot for having 1,000+ markets over years', () => {
    const c = classifyWallet(S({ perDay: 5, medGapSecs: 3_000, medUsd: 400, trades: 120 }), L({ traded: 1_100, vol: 3_000_000, ageDays: 1_000 }));
    expect(c.cls).toBe('ALGO'); // flagged as possibly automated, never BOT
    expect(c.confidence).toBe('low');
  });
});

describe('activity summary', () => {
  const rec = (ts: number, over: Partial<ActivityRec> = {}): ActivityRec => ({ ts, type: 'TRADE', side: 'BUY', usd: 100, cid: 'a', ...over });
  it('computes cadence, gaps, flips, rewards and merges', () => {
    const recs = [
      rec(0), rec(60, { side: 'SELL' }), rec(3_600, { cid: 'b' }), rec(3_660, { cid: 'b', side: 'SELL' }), rec(7_200, { type: 'REWARD', usd: 1, cid: '' }),
      rec(7_300, { type: 'MERGE', cid: 'c' }),
    ];
    const s = summarizeActivity(recs);
    expect(s).toMatchObject({ events: 6, trades: 4, distinctMarkets: 2, rewards: 1, mergeSplit: 1, flipShare: 1 });
    expect(s.medGapSecs).toBe(100);
    expect(s.spanHours).toBeCloseTo(7_300 / 3_600);
    expect(s.perDay).toBeCloseTo(6 / (7_300 / 3_600 / 24));
  });
  it('does not call opposite trades hours apart a flip', () => {
    expect(summarizeActivity([rec(0), rec(7_200, { side: 'SELL' })]).flipShare).toBe(0);
  });
  it('floors the window at one hour and handles empty input', () => {
    expect(summarizeActivity([rec(0), rec(1), rec(2)]).perDay).toBeCloseTo(3 / (1 / 24));
    expect(summarizeActivity([])).toMatchObject({ events: 0, perDay: 0, medGapSecs: null, medUsd: null });
  });
});

import { positionFlags } from '../../radar/holders';
describe('position flags', () => {
  it('flags large holdings that were never bought', () => {
    expect(positionFlags(0, 110_990)[0]).toMatch(/never bought/);
    expect(positionFlags(0.5, 110_990)).toEqual([]);
    expect(positionFlags(0, 50)).toEqual([]);
    expect(positionFlags(null, null)).toEqual([]);
  });
});
