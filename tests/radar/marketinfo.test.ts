import { describe, expect, it } from 'vitest';
import { formatInfo, parseInfo, summarizeBook, timeLeft } from '../../radar/marketinfo';

const book = { bids: [{ price: 0.48, size: 1000 }, { price: 0.45, size: 1000 }, { price: 0.3, size: 5000 }], asks: [{ price: 0.5, size: 400 }, { price: 0.54, size: 400 }, { price: 0.7, size: 9000 }] };

describe('market info', () => {
  it('summarizes the book: best prices, spread and depth within 5 cents', () => {
    const b = summarizeBook(book);
    expect(b).toMatchObject({ bid: 0.48, ask: 0.5 });
    expect(b.spreadCents).toBeCloseTo(2);
    expect(b.bidDepthUsd).toBeCloseTo(480 + 450); // 0.45 is 3c below the best bid, 0.30 is not
    expect(b.askDepthUsd).toBeCloseTo(200 + 216); // 0.54 is 4c above, 0.70 is not
    expect(summarizeBook({ bids: [], asks: [] })).toEqual({ bid: null, ask: null, spreadCents: null, bidDepthUsd: 0, askDepthUsd: 0 });
  });
  it('reads end date, oracle status and rules from the raw market, tolerating missing fields', () => {
    const i = parseInfo({ endDate: '2026-11-10T00:00:00Z', umaResolutionStatuses: '["proposed","disputed"]', acceptingOrders: true, description: 'Resolves   Yes\nif it rains.' }, book);
    expect(i).toMatchObject({ endsAt: Date.parse('2026-11-10T00:00:00Z') / 1000, uma: ['proposed', 'disputed'], acceptingOrders: true, rules: 'Resolves Yes if it rains.' });
    expect(parseInfo({ umaResolutionStatuses: 'garbage' }, null)).toMatchObject({ uma: [], book: null, endsAt: null, acceptingOrders: null });
    expect(parseInfo({ umaResolutionStatus: 'resolved' }, null).uma).toEqual(['resolved']);
    expect(parseInfo(undefined, null).rules).toBe('');
  });
  it('formats times, and says plainly when nothing was proposed or the market is closed to orders', () => {
    expect(timeLeft(1000 + 2 * 86_400 + 3 * 3_600, 1000)).toBe('ends in 2d 3h');
    expect(timeLeft(1000 - 90 * 60, 1000)).toBe('end date passed 1h 30m ago');
    const lines = formatInfo(parseInfo({ endDate: '2026-11-10T00:00:00Z', acceptingOrders: false, description: 'x'.repeat(300) }, book), 'Yes', Date.parse('2026-11-08T00:00:00Z') / 1000, 60);
    expect(lines[0]).toBe('Yes 48.0/50.0c, spread 2.0c  ·  within 5c: $930 bids / $416 asks  ·  ends in 2d 0h  ·  UMA: no resolution proposed  ·  NOT accepting orders');
    expect(lines[1]).toHaveLength('rules: '.length + 60);
    expect(formatInfo(parseInfo({ umaResolutionStatuses: ['proposed'] }, null), 'Yes', 0)[0]).toBe('UMA oracle: proposed');
  });
});
