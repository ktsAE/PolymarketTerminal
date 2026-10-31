#!/usr/bin/env node
// Run with: node radar/cli.ts <command>   (Node >= 22.18 strips types natively)
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SEED_CASES } from './cases.seed.ts';
import { TIER_TEXT, tierAsOf } from './evidence.ts';
import { flowSummary, INFORMATIVE_BAND, peakPositions } from './features.ts';
import { ingestEvent } from './ingest.ts';
import { loadHolders, peopleOnly } from './holders.ts';
import { runTui } from './tui/app.ts';
import { FEEDS } from './news.ts';
import { httpFetchText, pollFeeds } from './poll.ts';
import { PolymarketClient, httpFetchJson } from './polymarket.ts';
import { scoreMarket, short, SCORE_VERSION, type WalletProfile } from './score.ts';
import { openStore, type RadarStore } from './store.ts';

const DB_PATH = process.env.RADAR_DB ?? '.radar/radar.db';
const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const iso = (secs: number | null) => (secs === null ? 'unknown' : new Date(secs * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');

function open(): RadarStore {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  return openStore(DB_PATH);
}

function flag(args: string[], name: string, fallback: number): number {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && Number.isFinite(Number(args[i + 1])) ? Number(args[i + 1]) : fallback;
}

function seed(store: RadarStore): void {
  for (const c of SEED_CASES) {
    store.upsertCase(c.row);
    for (const ev of c.events) store.addCaseEvent(c.row.id, ev);
  }
  console.log(`seeded ${SEED_CASES.length} cases`);
}

function cases(store: RadarStore): void {
  for (const c of store.listCases()) {
    const now = tierAsOf(c.events, Date.now());
    console.log(`\n${c.id}  [${now ? now.tier : 'NO EVIDENCE'}]${now?.approx ? ' (date approx)' : ''}`);
    console.log(`  ${c.title}`);
    if (now) console.log(`  ${TIER_TEXT[now.tier]} since ${new Date(now.at).toISOString().slice(0, 10)}`);
    if (c.polymarketSlug) console.log(`  polymarket: ${c.polymarketSlug.split(',').join(' | ')}`);
    for (const ev of c.events) for (const cl of ev.claims) if (cl.verified !== 'none') console.log(`  claim verified (${cl.verified}): ${cl.text}`);
  }
}

function profilesFor(store: RadarStore, wallets: string[]): Map<string, WalletProfile> {
  const map = new Map<string, WalletProfile>();
  for (const w of wallets) {
    const r = store.getWallet(w);
    if (r) map.set(w, { firstSeen: r.firstSeen, traded: r.traded, bigPositions: r.bigPositions, skillZ: r.skillZ });
  }
  return map;
}

function report(store: RadarStore, slug: string): void {
  const markets = store.marketsForEvent(slug);
  if (markets.length === 0) return void console.log(`nothing stored for ${slug}; run: node radar/cli.ts ingest ${slug}`);
  console.log(`\n${markets[0].eventTitle}`);
  const linked = store.listCases().find((c) => (c.polymarketSlug ?? '').split(',').includes(slug));
  if (linked) {
    const now = tierAsOf(linked.events, Date.now());
    console.log(`CASE ${linked.id}: ${now ? TIER_TEXT[now.tier] : 'no evidence recorded'}`);
    if (linked.notes) console.log(`  ${linked.notes}`);
  }
  const traded = markets.filter((m) => store.tradesFor(m.cid).length > 0).slice(0, 4);
  if (traded.length === 0) console.log('\nno stored trades for any market (volume too low or not ingested).');
  for (const m of traded) {
    const trades = store.tradesFor(m.cid);
    const flow = flowSummary(trades, m.gameStart);
    const positions = peakPositions(trades, m.gameStart, INFORMATIVE_BAND);
    const wallets = profilesFor(store, positions.slice(0, 12).map((p) => p.wallet));
    const result = scoreMarket({ market: m, trades, wallets, baseline: m.marketType ? store.volumeBaseline(m.marketType) : undefined });
    store.saveSignal({ cid: m.cid, version: SCORE_VERSION, computedAt: Date.now(), score: result.score, level: result.level, reasons: result.reasons });
    console.log(`\n== ${m.marketType ?? '?'}: ${m.question}`);
    console.log(`   volume ${usd(m.volume)} | ${flow.trades} fills, ${flow.wallets} wallets | pre-start share ${flow.preStartShare === null ? 'n/a' : Math.round(flow.preStartShare * 100) + '%'} | top wallet ${Math.round(flow.topWalletShare * 100)}% | start ${iso(m.gameStart)} | result ${m.result ? m.result.join('/') : 'open'}`);
    console.log(`   indicator score ${result.score} (${result.level}) [${result.version}]`);
    for (const r of result.reasons) console.log(`     ${r.points >= 0 ? '+' : ''}${r.points} ${r.code}: ${r.text}`);
    for (const g of result.gaps) console.log(`     gap: ${g}`);
    console.log(`   largest positions (fills priced outside ${INFORMATIVE_BAND.min}-${INFORMATIVE_BAND.max} ignored as settlement sweeping):`);
    for (const p of positions.slice(0, 4)) {
      const w = wallets.get(p.wallet);
      const prof = w ? `first seen ${iso(w.firstSeen)}, ${w.traded ?? '?'} markets, ${w.bigPositions ?? '?'} big positions${w.skillZ !== null ? `, profit-rate z ${w.skillZ.toFixed(1)}` : ''}` : 'not profiled';
      console.log(`     ${short(p.wallet)} ${m.outcomes[p.outcomeIndex] ?? p.outcomeIndex}: peak ${usd(p.peakCost)} @ ${p.vwap.toFixed(3)} (${p.fills} fills, ${p.liveShare === null ? 'n/a' : Math.round(p.liveShare * 100)}% in play) | ${prof}`);
    }
  }
  console.log('\nNote: profit-rate z compares realized profit with entry prices; it is inflated for scalpers and market makers. Indicators, not findings. Wallet identity is unknown; a flag means "look", never "fixed".');
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const store = open();
  const client = new PolymarketClient(httpFetchJson);
  try {
    switch (cmd) {
      case 'seed':
        return seed(store);
      case 'cases':
        return cases(store);
      case 'ingest': {
        if (!args[0]) throw new Error('usage: ingest <event-slug> [--profiles N] [--min-volume USD]');
        const r = await ingestEvent(client, store, args[0], { profileTop: flag(args, 'profiles', 6), minVolume: flag(args, 'min-volume', 1000), log: (m) => console.log('  ' + m) });
        console.log(r ? `ingested ${JSON.stringify(r)}` : `event not found: ${args[0]}`);
        return;
      }
      case 'report':
        if (!args[0]) throw new Error('usage: report <event-slug>');
        return report(store, args[0]);
      case 'link': {
        if (args.length < 2) throw new Error('usage: link <case-id> <event-slug>');
        const c = store.listCases().find((x) => x.id === args[0]);
        if (!c) throw new Error(`unknown case ${args[0]}`);
        const slugs = new Set([...(c.polymarketSlug ?? '').split(',').filter(Boolean), args[1]]);
        store.upsertCase({ ...c, polymarketSlug: [...slugs].join(',') });
        console.log(`linked ${c.id} -> ${[...slugs].join(', ')}`);
        return;
      }
      case 'find': {
        if (!args[0]) throw new Error('usage: find <search text>');
        for (const e of await client.searchEvents(args.join(' '))) console.log(`${e.slug}  ${usd(e.volume)}  ${e.title}`);
        return;
      }
      case 'holders': {
        if (!args[0]) throw new Error('usage: holders <event-slug> [--all]   (--all also lists bots and market makers)');
        const v = await loadHolders(client, store, args[0]);
        if (v.error && v.rows.length === 0) throw new Error(v.error);
        const rows = args.includes('--all') ? v.rows : peopleOnly(v.rows);
        console.log(`${v.eventTitle}\n${v.question}  (${v.loaded}/${v.total} top holders profiled${v.error ? `, last error: ${v.error}` : ''})\n`);
        console.log(['CLASS'.padEnd(8), 'OUTCOME'.padEnd(10), 'POSITION'.padStart(9), 'AVG'.padStart(5), 'uPNL'.padStart(9), 'ALL-TIME'.padStart(10), '7D'.padStart(9), 'MKTS'.padStart(6), '/DAY'.padStart(6), 'NAME'].join(' '));
        for (const r of rows) console.log([r.cls.padEnd(8), r.outcome.slice(0, 10).padEnd(10), usd(r.posUsd ?? 0).padStart(9), (r.avgPrice === null ? '-' : r.avgPrice.toFixed(2)).padStart(5), usd(r.uPnl ?? 0).padStart(9), (r.pnlAll === null ? '-' : usd(r.pnlAll)).padStart(10), (r.pnlWeek === null ? '-' : usd(r.pnlWeek)).padStart(9), String(r.traded ?? '-').padStart(6), (r.perDay === null ? '-' : String(Math.round(r.perDay))).padStart(6), r.name ?? r.wallet.slice(0, 10)].join(' '));
        const hidden = v.rows.length - rows.length;
        if (hidden > 0) console.log(`\n${hidden} bot/market-maker wallets hidden (use --all). Reasons for the last few:`);
        for (const r of v.rows.filter((x) => !rows.includes(x)).slice(0, 6)) console.log(`  ${r.cls} ${r.name ?? r.wallet.slice(0, 10)}: ${r.reasons.join('; ')}`);
        return;
      }
      case 'tui':
      case 'scan': {
        const cols = flag(args, 'cols', 0);
        const rows = flag(args, 'rows', 0);
        await runTui(store, client, {
          once: cmd === 'scan' || args.includes('--once'),
          news: !args.includes('--no-news'),
          intervalSecs: flag(args, 'interval', 120),
          cols: cols || undefined,
          rows: rows || undefined,
          tab: (['anomalies', 'games', 'prints', 'holders', 'leads'] as const).find((t) => t === args[args.indexOf('--tab') + 1]),
        });
        return;
      }
      case 'news': {
        const [sub, ...rest] = args;
        if (sub === 'poll') {
          for (const r of await pollFeeds(httpFetchText, store)) console.log(`${r.error ? 'FAIL' : 'ok  '} ${r.feed.padEnd(18)} fetched ${String(r.fetched).padStart(3)}, new ${String(r.added).padStart(3)}, relevant new ${r.relevantNew}${r.error ? `  (${r.error})` : ''}`);
          console.log(`feeds: ${FEEDS.map((f) => f.id).join(', ')}`);
          return;
        }
        if (sub === 'dismiss') {
          if (!rest[0]) throw new Error('usage: news dismiss <url>');
          console.log(store.setNewsStatus(rest[0], 'dismissed') ? 'dismissed' : 'no such item');
          return;
        }
        for (const n of store.listNews({ relevantOnly: !rest.includes('--all'), limit: flag(rest, 'limit', 25) })) {
          console.log(`\n[${n.category}] ${n.title}`);
          console.log(`  ${n.feedId} | ${n.publishedAt ? new Date(n.publishedAt).toISOString().slice(0, 16) : 'undated'} | matched: ${n.matched.join(', ') || '-'}${n.tierHint ? ` | hint: ${n.tierHint}` : ''}`);
          console.log(`  ${n.url}`);
          if (n.note) console.log(`  -> ${n.note}`);
        }
        return;
      }
      case 'case-add': {
        if (!args[0]) throw new Error('usage: case-add <file.json>   (file: { row, events[] }, see radar/cases.seed.ts)');
        const c = JSON.parse(readFileSync(args[0], 'utf8')) as { row: Parameters<RadarStore['upsertCase']>[0]; events: Parameters<RadarStore['addCaseEvent']>[1][] };
        store.upsertCase(c.row);
        for (const ev of c.events) store.addCaseEvent(c.row.id, ev);
        console.log(`recorded ${c.row.id} (${c.events.length} event(s), tiers validated)`);
        return;
      }
      case 'backfill': {
        const max = flag(args, 'max', 20);
        const minVolume = flag(args, 'min-volume', 20_000);
        let done = 0;
        for (let offset = 0; done < max && offset < 1000; offset += 100) {
          const page = await client.esportsEvents({ closed: true, limit: 100, offset });
          if (page.length === 0) break;
          for (const e of page) {
            if (done >= max) break;
            if (e.volume < minVolume) continue;
            const r = await ingestEvent(client, store, e.slug, { profileTop: flag(args, 'profiles', 3), minVolume: 5_000 });
            if (r) console.log(`${++done}/${max} ${e.slug}: ${r.newTrades} new fills, ${r.profiled} profiled`);
          }
        }
        return;
      }
      default:
        console.log('commands: tui [--interval S --no-news] | holders <slug> [--all] | scan [--cols N --rows N --tab games|prints|leads] | seed | cases | news poll|list|dismiss | case-add <file> | find <text> | ingest <slug> | report <slug> | link <case> <slug> | backfill [--max N --min-volume USD]');
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
