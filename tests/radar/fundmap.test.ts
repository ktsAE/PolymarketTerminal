import { describe, expect, it } from 'vitest';
import { blockAgeHours, parseTransfer, scanFunding, TRANSFER_TOPIC, type RpcCall } from '../../radar/chainfunding';
import { bubble, buildFundMap, formatFundMap, MAP_CAVEAT, type MapHolder } from '../../radar/fundmap';

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;
const holder = (n: number, posUsd: number, outcome = 'Yes', outcomeIndex = 0): MapHolder => ({ wallet: a(n), outcome, outcomeIndex, posUsd, cls: 'LOW_DATA' });
const tx = (from: number, to: number, usd: number) => ({ from: a(from), to: a(to), usd, block: 1 });

describe('bubble map links', () => {
  const holders = [holder(1, 10_000), holder(2, 6_000), holder(3, 5_000), holder(4, 900), holder(5, 100)];
  it('links holders funded by the same wallet and leaves the rest unlinked', () => {
    const m = buildFundMap(holders, [tx(100, 1, 500), tx(100, 2, 400), tx(100, 3, 300), tx(200, 4, 50)], []);
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0].members.map((x) => x.wallet)).toEqual([a(1), a(2), a(3)]);
    expect(m.groups[0]).toMatchObject({ funder: a(100), totalUsd: 21_000 });
    expect(m.groups[0].funded[a(2)]).toBe(400);
    expect(m.unlinked.map((x) => x.wallet)).toEqual([a(4), a(5)]);
    expect(m.seenFunded).toBe(4);
  });
  it('links through direct transfers between holders', () => {
    const m = buildFundMap(holders, [tx(1, 4, 800)], []);
    expect(m.groups[0].members.map((x) => x.wallet)).toEqual([a(1), a(4)]);
    expect(m.groups[0].funder).toBeNull();
    expect(m.groups[0].direct).toEqual([{ from: a(1), to: a(4), usd: 800 }]);
  });
  it('chains links across funders (A and B share one funder, B and C another)', () => {
    const m = buildFundMap(holders, [tx(100, 1, 50), tx(100, 2, 50), tx(101, 2, 50), tx(101, 3, 50)], []);
    expect(m.groups).toHaveLength(1);
    expect(m.groups[0].members).toHaveLength(3);
  });
  it('ignores funders that also pay several unrelated traders (services), dust, and self-transfers', () => {
    const control = [a(900), a(901), a(902), a(903)];
    const hub = [tx(100, 1, 20), tx(100, 2, 20), tx(100, 900, 20), tx(100, 901, 20), tx(100, 902, 20)];
    const m = buildFundMap(holders, [...hub, tx(300, 3, 2), tx(300, 4, 2), tx(5, 5, 100)], control);
    expect(m.groups).toEqual([]);
    expect(m.hubs).toEqual([a(100)]);
    expect(buildFundMap(holders, [tx(100, 1, 20), tx(100, 2, 20), tx(100, 900, 20)], control).groups).toHaveLength(1); // paying only one control wallet is not a hub
    expect(buildFundMap(holders, [tx(0, 1, 50), tx(0, 2, 50)], []).groups).toEqual([]); // the zero address (mints) is never a funder
  });
  it('shows when a group holds both sides, and always prints the caveat', () => {
    const hs = [holder(1, 1000, 'Yes', 0), holder(2, 900, 'No', 1)];
    const lines = formatFundMap(buildFundMap(hs, [tx(100, 1, 50), tx(100, 2, 50)], []), hs);
    expect(lines[0]).toMatch(/^GROUP 1: 2 wallets, \$1\.9k together {2}holds BOTH sides \(1 Yes, 1 No\)/);
    expect(lines.join('\n')).toMatch(/funded by 0x0000…0064/);
    expect(lines.at(-1)).toBe(MAP_CAVEAT);
    expect(formatFundMap(buildFundMap(holders, [], []), holders)[0]).toBe('no links found between the 5 holders (0 of them received USDC in the window)');
  });
  it('sizes bubbles by share of the biggest position', () => {
    expect([bubble(10_000, 10_000), bubble(5_000, 10_000), bubble(2_000, 10_000), bubble(100, 10_000), bubble(null, 10_000)]).toEqual(['⬤', '●', '◉', '○', '·']);
  });
});

describe('chain scan', () => {
  const log = (from: number, to: number, usdMicro: number, block: number) => ({ topics: [TRANSFER_TOPIC, `0x${'0'.repeat(24)}${a(from).slice(2)}`, `0x${'0'.repeat(24)}${a(to).slice(2)}`], data: `0x${usdMicro.toString(16)}`, blockNumber: `0x${block.toString(16)}` });
  it('parses a transfer log and ignores other events', () => {
    expect(parseTransfer(log(7, 8, 12_500_000, 255))).toEqual({ from: a(7), to: a(8), usd: 12.5, block: 255 });
    expect(parseTransfer({ topics: ['0xdead', '0x1', '0x2'], data: '0x1' })).toBeNull();
    expect(parseTransfer({ topics: [TRANSFER_TOPIC], data: '0x1' })).toBeNull();
  });
  it('walks back in 10,000-block windows, filters on every recipient, retries, and counts windows that kept failing', async () => {
    const calls: Array<{ from: number; to: number; topics: unknown[]; address: unknown }> = [];
    let flaky = 0;
    const rpc: RpcCall = async (method, params) => {
      if (method === 'eth_blockNumber') return '0x186a0'; // 100000
      const f = params[0] as { fromBlock: string; toBlock: string; topics: unknown[]; address: unknown };
      const from = Number.parseInt(f.fromBlock, 16);
      calls.push({ from, to: Number.parseInt(f.toBlock, 16), topics: f.topics, address: f.address });
      if (from === 80_001 && flaky++ < 1) throw new Error('rate limit');
      if (from === 60_001) throw new Error('always fails');
      return from === 90_001 ? [log(1, 2, 5_000_000, 95_000)] : [];
    };
    const prog: number[] = [];
    const r = await scanFunding(rpc, [a(2), a(3), a(2)], { days: 1, concurrency: 1, retries: 1, sleep: async () => undefined, onProgress: (p) => prog.push(p.done) });
    expect(calls[0]).toMatchObject({ from: 90_001, to: 100_000 });
    expect(r.transfers).toEqual([{ from: a(1), to: a(2), usd: 5, block: 95_000 }]);
    expect((calls[0].topics[2] as string[]).length).toBe(2); // duplicates removed
    expect(Array.isArray(calls[0].address) && (calls[0].address as string[]).length).toBe(2); // both USDC contracts
    expect(r.head).toBe(100_000);
    expect(prog.at(-1)).toBeGreaterThan(0);
    expect(blockAgeHours(100_000 - 1714, 100_000)).toBeCloseTo(1, 0);
  });
  it('stops when cancelled and returns what it has', async () => {
    let n = 0;
    const rpc: RpcCall = async (m) => (m === 'eth_blockNumber' ? '0x186a0' : []);
    const r = await scanFunding(rpc, [a(2)], { days: 30, concurrency: 1, cancelled: () => n++ >= 2, sleep: async () => undefined });
    expect(r.failed).toBe(0);
  });
});

describe('service check on funders', () => {
  it('counts distinct recipients, and treats an RPC failure as a busy service', async () => {
    const { funderFanOut } = await import('../../radar/chainfunding');
    const t = (to: number) => ({ topics: [TRANSFER_TOPIC, `0x${'0'.repeat(24)}${a(5).slice(2)}`, `0x${'0'.repeat(24)}${a(to).slice(2)}`] });
    expect(await funderFanOut(async () => [t(1), t(2), t(2), t(3)], a(5), 100_000)).toBe(3);
    expect(await funderFanOut(async () => [], a(5), 100_000)).toBe(0);
    expect(await funderFanOut(async () => { throw new Error('query returned more than 10000 results'); }, a(5), 100_000)).toBe(Infinity);
  });
  it('reports funders marked as services', () => {
    const hs = [holder(1, 10), holder(2, 10)];
    const m = buildFundMap(hs, [tx(100, 1, 50), tx(100, 2, 50)], [], { ignore: [a(100)], markHubs: [a(100)] });
    expect(m.groups).toEqual([]);
    expect(m.hubs).toEqual([a(100)]);
  });
});
