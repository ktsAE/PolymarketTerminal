import { describe, expect, it } from 'vitest';
import { buildCard, loadFollowing, styleOf } from '../../radar/following';
import { PolymarketClient, type PnlPoint, type PositionLine, type TradeLine } from '../../radar/polymarket';
import { openStore } from '../../radar/store';
import { parseWalletInput, resolveWalletInput } from '../../radar/walletinput';
import { v2 } from './v2';

const A = `0x${'a'.repeat(40)}`;
const NOW = 1_800_000_000;
const fast = { minIntervalMs: 0, sleep: async () => undefined, now: () => 0, retries: 0 };
const tr = (ts: number, over: Partial<TradeLine> = {}): TradeLine => ({ ts, tx: `0x${ts}`, token: 't', side: 'BUY', price: 0.4, size: 100, outcome: 'Yes', title: 'Q?', slug: 's', cid: `c${ts % 3}`, ...over });
const pos = (value: number, unrealizedPnl: number): PositionLine => ({ cid: 'c', title: 't', slug: 's', outcome: 'Yes', status: 'OPEN', cost: value, value, totalPnl: unrealizedPnl, realizedPnl: 0, unrealizedPnl, firstEntryAt: null });
const pt = (daysAgo: number, pnl: number): PnlPoint => ({ ts: NOW - daysAgo * 86_400, economicPnl: pnl, positionPnl: pnl, realizedPnl: pnl, referralIncome: 0, rewardIncome: 0, yieldIncome: 0, makerRebate: 0, takerRebate: 0, volume: pnl * 10, tradeCount: 1 });

describe('pasting a wallet or a link', () => {
  it('accepts an address, a profile link, an @name link and a bare @name', () => {
    expect(parseWalletInput(` ${A.toUpperCase().replace('0X', '0x')} `)).toEqual({ wallet: A });
    expect(parseWalletInput(`https://polymarket.com/profile/${A}?via=polyhelper`)).toEqual({ wallet: A });
    expect(parseWalletInput('https://polymarket.com/@technician2')).toEqual({ handle: 'technician2' });
    expect(parseWalletInput('@sonix.trader')).toEqual({ handle: 'sonix.trader' });
    expect(parseWalletInput('hello')).toBeNull();
    expect(parseWalletInput('0x123')).toBeNull();
  });
  it('resolves an @name through profile search, exact match only', async () => {
    const f = async () => ({ profiles: [{ name: 'technician22', proxyWallet: `0x${'b'.repeat(40)}` }, { name: 'Technician2', pseudonym: 'Misty', proxyWallet: `0x${'c'.repeat(40)}` }, { name: 'x', proxyWallet: 'bad' }] });
    const c = new PolymarketClient(f as never, fast);
    expect(await resolveWalletInput(c, 'https://polymarket.com/@technician2')).toEqual({ wallet: `0x${'c'.repeat(40)}`, name: 'Technician2' });
    await expect(resolveWalletInput(c, '@nobodyhere')).rejects.toThrow(/no Polymarket profile named @nobodyhere \(closest: technician22, Technician2\)/);
    await expect(resolveWalletInput(c, 'nonsense')).rejects.toThrow(/not a wallet/);
    expect(await resolveWalletInput(c, A)).toEqual({ wallet: A, name: null });
  });
});

describe('follow cards', () => {
  it('summarizes style from recent trades', () => {
    const s = styleOf([tr(1), tr(2), tr(3, { side: 'SELL', price: 0.9, size: 10 }), tr(4)])!;
    expect(s).toMatchObject({ trades: 4, buyShare: 0.75, markets: 3 });
    expect(s.avgBuyPrice).toBeCloseTo(0.4);
    expect(s.medianUsd).toBeCloseTo(40);
    expect(styleOf([tr(1)])).toBeNull();
  });
  it('builds PnL windows, open totals, biggest positions first and marks trades newer than the last look', () => {
    const card = buildCard({ wallet: A, note: 'whale' }, 'Sonix', [pt(100, 0), pt(10, 500), pt(0, 800)], [pos(10, -2), pos(500, 30)], [tr(100), tr(300), tr(200)], 150, NOW);
    expect(card).toMatchObject({ name: 'Sonix', note: 'whale', pnl7d: 300, pnlAll: 800, openCount: 2, openValue: 510, unrealized: 28, newTrades: 2 });
    expect(card.positions[0].value).toBe(500);
    expect(card.trades.map((t) => [t.ts, t.isNew])).toEqual([[300, true], [200, true], [100, false]]);
    expect(buildCard({ wallet: A }, null, [], [], [tr(1)], null, NOW).newTrades).toBe(0); // first look: nothing is "new"
  });
});

describe('loading the followed wallets', () => {
  const act = (ts: number) => ({ proxyWallet: A, timestamp: ts, type: 'TRADE', side: 'BUY', price: 0.5, size: 100, outcome: 'Yes', title: 'Q', eventSlug: 'e', conditionId: 'c', transactionHash: `0x${ts}`, tokenId: 't' });
  it('keeps going when one wallet fails, and returns the fresh trades for notifications', async () => {
    const B = `0x${'b'.repeat(40)}`;
    let round = 0;
    const f = async (url: string) => {
      const u = new URL(url);
      if (url.includes(B.slice(2))) throw new Error('HTTP 500');
      if (u.pathname === '/public-profile') return { name: 'Alpha', createdAt: '2025-01-01T00:00:00Z' };
      if (u.pathname === '/v2/user-pnl') return v2({ points: [{ timestamp: NOW, economicPnl: 5, volumeUsdc: 50 }] });
      if (u.pathname === '/v2/positions') return v2([]);
      if (u.pathname === '/v2/activity') return v2(round === 0 ? [act(10)] : [act(20), act(10)]);
      throw new Error(`unexpected ${url}`);
    };
    const store = openStore();
    const client = new PolymarketClient(f as never, fast);
    const list = [{ wallet: A }, { wallet: B }];
    const first = await loadFollowing(client, store, list, {}, () => NOW * 1000);
    expect(first.cards[0]).toMatchObject({ name: 'Alpha', error: null });
    expect(first.cards[1].error).toMatch(/failed after 1 attempts/);
    expect(first.fresh).toEqual([]);
    expect(first.seen[A]).toBe(10);
    round = 1;
    const second = await loadFollowing(client, store, list, first.seen, () => NOW * 1000);
    expect(second.fresh.map((x) => x.trade.ts)).toEqual([20]);
    expect(second.seen[A]).toBe(20);
  });
});
