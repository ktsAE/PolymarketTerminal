import { describe, expect, it } from 'vitest';
import { buyQuote, costLines, FEE_RATES, feeCategory, formatCost, invert, sellProceeds, takerFee } from '../../radar/cost';

describe('fee schedule', () => {
  it('follows fee = shares x rate x p x (1 - p)', () => {
    expect(takerFee(100, 0.5, 0.07)).toBeCloseTo(1.75);
    expect(takerFee(100, 0.9, 0.04)).toBeCloseTo(0.36);
    expect(takerFee(100, 0.5, 0)).toBe(0);
    expect(takerFee(100, 0.999, 0.07)).toBeLessThan(0.01); // near-certain outcomes are almost free
  });
  it('maps tags to a category, first match winning, defaulting to other', () => {
    expect(feeCategory(['Crypto', 'bitcoin'])).toBe('crypto');
    expect(feeCategory(['sports', 'nba'])).toBe('sports');
    expect(feeCategory(['esports', 'counter-strike-2', 'games'])).toBe('sports');
    expect(feeCategory(['politics', 'elections'])).toBe('politics');
    expect(feeCategory(['geopolitics', 'world'])).toBe('geopolitics');
    expect(feeCategory(['weather', 'daily-temperature'])).toBe('weather');
    expect(feeCategory(['recurring', 'hide-from-new'])).toBe('other');
    expect(feeCategory([])).toBe('other');
    expect(FEE_RATES.geopolitics).toBe(0);
  });
});

describe('buying from the book', () => {
  const asks = [{ price: 0.5, size: 100 }, { price: 0.52, size: 200 }, { price: 0.6, size: 1000 }];
  it('fills a small order at the best price', () => {
    const q = buyQuote(asks, 25, 0.05)!;
    expect(q.shares).toBeCloseTo(50);
    expect(q.avgPrice).toBeCloseTo(0.5);
    expect(q.slippageCents).toBeCloseTo(0);
    expect(q.fee).toBeCloseTo(50 * 0.05 * 0.25);
    expect(q.breakEven).toBeCloseTo((25 + q.fee) / 50);
    expect(q.thin).toBe(false);
  });
  it('walks up the book and pays slippage when the order is bigger than the best level', () => {
    const q = buyQuote(asks, 154, 0.05)!; // 100 sh at .50 = 50, then 104 / .52 = 200 sh
    expect(q.shares).toBeCloseTo(300);
    expect(q.spent).toBeCloseTo(154);
    expect(q.avgPrice).toBeCloseTo(154 / 300);
    expect(q.slippageCents).toBeCloseTo((154 / 300 - 0.5) * 100);
  });
  it('reports a thin book and an empty one', () => {
    const q = buyQuote([{ price: 0.5, size: 10 }], 1000, 0.05)!;
    expect(q.spent).toBeCloseTo(5);
    expect(q.thin).toBe(true);
    expect(buyQuote([], 100, 0.05)).toBeNull();
    expect(buyQuote([{ price: 1, size: 100 }], 100, 0.05)).toBeNull(); // a price of 1 is not a buy
  });
});

describe('both sides and leaving at once', () => {
  const book = { bids: [{ price: 0.48, size: 500 }, { price: 0.45, size: 500 }], asks: [{ price: 0.5, size: 500 }, { price: 0.53, size: 500 }] };
  it('derives the NO book from the YES book', () => {
    expect(invert(book.bids)).toEqual([{ price: 0.52, size: 500 }, { price: 0.55, size: 500 }]); // best (lowest) NO ask first
  });
  it('prices YES and NO, with the loss of selling straight back', () => {
    const [yes, no] = costLines(book, 100, 0.05);
    expect(yes.quote?.bestPrice).toBeCloseTo(0.5);
    expect(no.quote?.bestPrice).toBeCloseTo(0.52); // NO ask = 1 - best YES bid
    expect(yes.quote?.avgPrice).toBeCloseTo(0.5);
    // spread of 2c on a 50c price: about 4% plus two fees of 0.0125 per share
    expect(yes.exitLoss).toBeGreaterThan(0.04);
    expect(yes.exitLoss).toBeLessThan(0.1);
    expect(formatCost(yes)).toMatch(/^YES \$100: 200 shares at avg 50\.0c \(best 50\.0c, slippage 0\.0c\), fee 1\.25c a share, needs a 51\.2% chance to break even; selling straight back would lose 8\.8%/);
  });
  it('says so when there is nothing to buy or sell', () => {
    const [yes, no] = costLines({ bids: [], asks: [{ price: 0.9, size: 100 }] }, 50, 0.05);
    expect(yes.quote).not.toBeNull();
    expect(yes.exitLoss).toBeNull(); // no bids to sell into
    expect(formatCost(yes)).toMatch(/selling straight back is not possible/);
    expect(no.quote).toBeNull();
    expect(formatCost(no)).toBe('NO: nothing to buy at this size');
  });
  it('sellProceeds takes fees and stops at the depth available', () => {
    const r = sellProceeds([{ price: 0.5, size: 10 }], 20, 0.05);
    expect(r.sold).toBe(10);
    expect(r.proceeds).toBeCloseTo(5 - 10 * 0.05 * 0.25);
  });
});
