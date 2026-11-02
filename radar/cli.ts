#!/usr/bin/env node
// Run with: node radar/cli.ts <command>   (Node >= 22.18 strips types natively)
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { SEED_CASES } from './cases.seed.ts';
import { TIER_TEXT, tierAsOf } from './evidence.ts';
import { flowSummary, INFORMATIVE_BAND, peakPositions } from './features.ts';
import { ingestEvent } from './ingest.ts';
import { loadDecision } from './decide-data.ts';
import { EDGES_PATH, KIND_TEXT, saveEdges, scanAll } from './edges.ts';
import { FORWARD_DIR, readJsonl, RESULTS_PATH, settleSnapshots, snapshotUpcoming, SNAPSHOTS_PATH, type SettleSummary, type SnapshotSummary } from './forward.ts';
import { formatLedger, scoreLedger } from './ledger.ts';
import { captureEntries, formatJumps, JUMPS_PATH, logJumps, scanJumps, scoreJumps, settleJumps, validFlagLine, type EntrySummary, type JumpScan, type JumpSettleSummary } from './jump.ts';
import { JUMPS_STANDING, LEDGER_STANDING, NEW_STANDING, unmappedNote } from './tui/render.ts';
import { logFlagged, NEWMARKET_THRESHOLDS, NEWMARKETS_PATH, NEWMARKETS_RESULTS_PATH, scanNewMarkets, scoreNewMarketLog, type NewMarketScore, type ScanSummary } from './newmarkets.ts';
import { cleanHandle, DEFAULT_HANDLES_PATH, DEFAULT_POSTS_PATH, loadHandles, loadPosts, pollAccounts, type AccountPollResult } from './xaccounts.ts';
import { loadHolders, peopleOnly } from './holders.ts';
import { loadNews } from './newsview.ts';
import { accountAge, identityFor } from './identity.ts';
import { addPerson, describePerson, loadPeople, matchPeople, PEOPLE_PATH, removePerson } from './people.ts';
import { loadRefs, REFS_PATH } from './refs.ts';
import { runTui, scanJumpsWithProgress } from './tui/app.ts';
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

const snapText = (r: SnapshotSummary) => `snapshots: ${r.series} series, ${r.events} events, ${r.upcoming} upcoming moneylines, ${r.due} due, ${r.written} written, ${r.skippedOneSided} one-sided skipped, ${r.holdersAbsent} without holders${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`;
const settleText = (r: SettleSummary) => `settle: ${r.pending} pending, ${r.settled} settled${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`;
const xText = (rs: AccountPollResult[]) => `x: ${rs.length} handle(s), ${rs.reduce((a, r) => a + r.added, 0)} new post(s)${rs.some((r) => r.error) ? `, failed: ${rs.filter((r) => r.error).map((r) => r.handle).join(',')}` : ''}`;
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function ledger(): void {
  const snaps = readJsonl(SNAPSHOTS_PATH);
  const report = scoreLedger(snaps, readJsonl(RESULTS_PATH));
  if (report.markets === 0) console.log(`no data yet: no forward snapshots in ${SNAPSHOTS_PATH}${snaps.length ? ` (${snaps.length} line(s), none valid)` : ''}. Start the logger with: npm run radar -- daemon\n`);
  for (const l of formatLedger(report)) console.log(l);
  console.log(`\n${LEDGER_STANDING}. An edge is claimed only by the ledger verdict above.`);
}

const newScanText = (s: ScanSummary, logged: { written: number; duplicates: number }) => `new: ${s.listed} listed, ${s.scanned} scanned, ${s.flagged} flagged, ${logged.written} logged${s.truncated ? `, ${s.truncated} too busy` : ''}${s.skipped ? `, ${s.skipped} failed` : ''}`;
const newScoreText = (r: NewMarketScore) => `new-score: ${r.logged} logged, ${r.written} result(s) written${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`;
const ratio = (a: number, n: number) => (n ? `${a}/${n} (${Math.round((a / n) * 100)}%)` : '0/0');

async function newScan(client: PolymarketClient, hours: number, top: number): Promise<void> {
  const t0 = Date.now();
  process.stderr.write(`scanning markets created in the last ${hours}h (taker fills, first hour)…`);
  const s = await scanNewMarkets(client, { hours });
  process.stderr.write('\r' + ' '.repeat(72) + '\r');
  const logged = logFlagged(s.lines);
  console.log(`listed ${s.listed}, excluded ${s.excluded} (crypto candles), considered ${s.considered}, scanned ${s.scanned}, no trades ${s.noTrades}, too busy ${s.truncated}, failed ${s.skipped}, age lookups ${s.ageLookups}, flagged ${s.flagged} (score >= ${NEWMARKET_THRESHOLDS.flagScore}) in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  console.log(`forward log: ${logged.written} new line(s), ${logged.duplicates} already logged this hour -> ${NEWMARKETS_PATH}`);
  for (const e of s.errors.slice(0, 5)) console.log(`  error: ${e}`);
  const nowSecs = Date.now() / 1000;
  const pctOf = (x: number | null) => (x === null ? '-' : `${Math.round(x * 100)}%`);
  console.log('');
  for (const r of s.rows.slice(0, top)) {
    const f = r.features;
    const lean = f.leanIdx === null ? '-' : `${r.outcomes[f.leanIdx] ?? f.leanIdx} ${pctOf(f.oneSided)}`;
    const age = r.createdAt ? `${((nowSecs - r.createdAt) / 3600).toFixed(1)}h` : '?';
    console.log(`${r.flagged ? 'FLAG' : '    '} score ${r.score}  age ${age.padStart(5)}  1h ${usd(f.usd).padStart(8)}  fills ${String(f.fills).padStart(4)}  top wallet ${pctOf(f.topWalletShare).padStart(4)}  new accts ${pctOf(f.newAcctShare).padStart(4)}  lean ${lean}  | ${r.title.slice(0, 70)}`);
    for (const why of r.reasons) console.log(`       · ${why}`);
    console.log(`       https://polymarket.com/event/${r.eventSlug}`);
  }
  if (s.rows.length === 0) console.log('no scorable new markets in the window.');
  console.log(`\n${NEW_STANDING}.`);
}

async function newScore(client: PolymarketClient): Promise<void> {
  const r = await scoreNewMarketLog(client);
  console.log(newScoreText(r));
  if (r.logged === 0) console.log(`no data yet: nothing logged in ${NEWMARKETS_PATH}. Fill it with: npm run radar -- new-scan (or daemon)`);
  for (const [k, t] of Object.entries(r.horizons)) console.log(`  ${k.padEnd(10)} n=${t.n}  continuation ${ratio(t.continuation, t.n)}  reversal ${ratio(t.reversal, t.n)}  flat ${t.flat}   (leaning-side price vs capture mid)`);
  console.log(`  resolution n=${r.resolution.n}  continuation ${ratio(r.resolution.continuation, r.resolution.n)}  reversal ${ratio(r.resolution.reversal, r.resolution.n)}  void ${r.resolution.void}`);
  console.log(`  paper ROI  n=${r.roi.n}  stake ${r.roi.stake.toFixed(2)}  pnl ${r.roi.pnl >= 0 ? '+' : ''}${r.roi.pnl.toFixed(2)}  roi ${r.roi.roi === null ? '-' : `${(r.roi.roi * 100).toFixed(1)}%`}   (1 share of the leaning side at the capture ask, held to resolution, before fees)`);
  for (const e of r.errors.slice(0, 5)) console.log(`  error: ${e}`);
  console.log(`results: ${NEWMARKETS_RESULTS_PATH}\n${NEW_STANDING}.`);
}

const jumpScanText = (s: JumpScan, logged: number) => `jumps: ${s.markets} markets, ${s.screened} screened, ${s.flags.length} flag(s), ${logged} logged${s.errors.length ? `, ${s.errors.length} error(s)` : ''}`;
const entryText = (r: EntrySummary) => `jump-entries: ${r.due} due, ${r.written} written${r.skippedOneSided ? `, ${r.skippedOneSided} one-sided` : ''}${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`;
const jumpSettleText = (r: JumpSettleSummary) => `jump-settle: ${r.pending} pending, ${r.settled} settled${r.errors.length ? `, ${r.errors.length} error(s)` : ''}`;
const share = (x: number | null) => (x === null ? '-' : `${Math.round(x * 100)}%`);

/** Live calm-then-jump scan, printed only: the daemon is what logs flags (with entries captured 5-15 min later). */
async function jumps(client: PolymarketClient, top: number): Promise<void> {
  const t0 = Date.now();
  const s = await scanJumpsWithProgress(client, (stage) => process.stderr.write(`\r${stage.slice(0, 70).padEnd(70)}`));
  process.stderr.write('\r' + ' '.repeat(72) + '\r');
  const reasons = Object.entries(s.reasons).map(([k, n]) => `${k} ${n}`).join(', ');
  console.log(`read ${s.events} events: ${s.markets} busiest markets, ${s.screened} moved 5+ pts in 1h, ${s.checked} checked on price history, ${s.flags.length} flag(s) in ${((Date.now() - t0) / 1000).toFixed(0)}s${reasons ? ` (rejected: ${reasons})` : ''}`);
  for (const e of s.errors.slice(0, 5)) console.log(`  error: ${e}`);
  console.log('');
  const flags = [...s.flags].sort((a, b) => Math.abs(b.move) - Math.abs(a.move));
  for (const f of flags.slice(0, top)) {
    console.log(`${f.direction === 'up' ? 'UP  ' : 'DOWN'} ${f.outcomes[0]} ${f.pRef.toFixed(2)}->${f.pNow.toFixed(2)} in 30m  ${f.calm ? 'calm ' : 'loose'}  vol30m ${usd(f.vol30m).padStart(8)}  freshShare ${share(f.freshShare).padStart(4)}  | ${f.title.slice(0, 70)}`);
    console.log(`       https://polymarket.com/event/${f.eventSlug}`);
  }
  if (flags.length === 0) console.log('no market jumped 15+ points in the last 30 minutes: that is the normal case.');
  console.log(`\nnot logged here: the daemon logs flags to ${JUMPS_PATH}.\n${JUMPS_STANDING}.`);
}

/**
 * `watch`: a terminal-only alert loop. Scans for jumps every few minutes and prints a line plus a desktop notification (notify-send)
 * for each NEW flag. Writes nothing to disk, needs no daemon and no extra keys. A flag is a lead to inspect, never a trade signal.
 */
/** Game-style slugs end in a date (nba-bkn-ind-2026-11-01) or start with a league code. */
const SPORTS_SLUG = /(-20\d\d-\d\d-\d\d)|^(nba|nfl|nhl|mlb|cbb|cfb|epl|lal|bun|sea|fl1|ucl|mls|wta|atp|ufc|cs2|csgo|dota2|lol|val|cricket|f1)-/;

async function watchJumps(client: PolymarketClient, everyMin: number, notify: boolean, calmOnly: boolean, noSports: boolean): Promise<void> {
  let stopping = false;
  let wake: (() => void) | null = null;
  const onSig = () => {
    if (stopping) process.exit(130);
    stopping = true;
    wake?.();
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  const seen = new Map<string, number>();
  const REALERT_MS = 6 * 3600_000;
  const stamp = () => new Date().toISOString().slice(11, 16) + 'Z';
  console.log(`watching for 15-point jumps every ${everyMin} min${calmOnly ? ' (calm-rule flags only)' : ''}${noSports ? ' (sports and esports skipped)' : ''}; markets already at 0.97+/0.03- are skipped; ${notify ? 'desktop notifications on' : 'notifications off'}; Ctrl-C stops. Leads, not trade signals.`);
  while (!stopping) {
    try {
      const sc = await scanJumpsWithProgress(client, () => undefined);
      const now = Date.now();
      for (const [k, t] of seen) if (now - t > REALERT_MS) seen.delete(k);
      // a price that ended at 0.97+ or 0.03- is a market that has already decided (e.g. a game finishing), not a surprise
      const fresh = sc.flags.filter((f) => (!calmOnly || f.calm) && !seen.has(f.cid) && f.pNow > 0.03 && f.pNow < 0.97 && (!noSports || !SPORTS_SLUG.test(f.eventSlug)));
      for (const f of fresh) {
        seen.set(f.cid, now);
        const line = `${f.direction === 'up' ? 'UP' : 'DOWN'} ${f.title.slice(0, 60)} | ${f.outcomes[0]} ${f.pRef.toFixed(2)}->${f.pNow.toFixed(2)} in 30m | ${f.calm ? 'calm' : 'loose'} | vol30m ${usd(f.vol30m)}`;
        console.log(`${stamp()} ${line}\n       https://polymarket.com/event/${f.eventSlug}`);
        if (notify) execFile('notify-send', ['-a', 'polymarket-radar', 'Price jump (a lead, not a signal)', `${line}\nhttps://polymarket.com/event/${f.eventSlug}`], () => undefined);
      }
      console.log(`${stamp()} scanned ${sc.markets} markets: ${sc.flags.length} flag(s), ${fresh.length} new${sc.errors.length ? `, ${sc.errors.length} error(s): ${sc.errors[0].slice(0, 80)}` : ''}`);
    } catch (error) {
      console.log(`${stamp()} scan failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise<void>((resolve) => {
      wake = resolve;
      setTimeout(resolve, everyMin * 60_000);
    });
    wake = null;
  }
  process.off('SIGINT', onSig);
  process.off('SIGTERM', onSig);
  console.log('watch stopped');
}

function jumpsScore(): void {
  const lines = readJsonl(JUMPS_PATH);
  if (!lines.some(validFlagLine)) console.log(`no data yet: no jump flags in ${JUMPS_PATH}${lines.length ? ` (${lines.length} line(s), none a valid flag)` : ''}. Start the logger with: npm run radar -- daemon\n`);
  for (const l of formatJumps(scoreJumps(lines))) console.log(l);
  if (lines.some((l) => validFlagLine(l) && l.pregame === true)) {
    console.log('\npre-game match-winner markets of sports/esports games (scored separately; spreads, totals, props and in-play are never read):');
    for (const l of formatJumps(scoreJumps(lines, { pregame: true }))) console.log(l);
  }
  console.log(`\n${JUMPS_STANDING}. An edge is claimed only by a score verdict above.`);
}

/** Settling and X polling hit the network per item; they run on their own slower cadence inside the daemon loop. */
const SETTLE_EVERY_MS = 5 * 60_000;
const X_EVERY_MS = 15 * 60_000;
/** The new-market scan costs ~100+ requests, and scoring walks the whole log; both run far less often than snapshots. */
const NEW_SCAN_EVERY_MS = 10 * 60_000;
const NEW_SCORE_EVERY_MS = 30 * 60_000;
/** The jump scan reads ~400 markets plus price histories; entries are captured every cycle (5-15 min window), results settled slowly. */
const JUMP_SCAN_EVERY_MS = 5 * 60_000;
const JUMP_SETTLE_EVERY_MS = 15 * 60_000;

/**
 * Forward logger loop: snapshot every cycle (the T-5m window is only 10 minutes wide), settle and poll X less often.
 * One status line per cycle; a failing step is reported on that line and the loop goes on. Ctrl-C stops after the current step.
 */
async function daemon(client: PolymarketClient, everySecs: number): Promise<void> {
  let stopping = false;
  let wake: (() => void) | null = null;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\nstopping after the current step (Ctrl-C again to force)');
    wake?.();
  };
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigint);
  console.log(`forward daemon: snapshot every ${everySecs}s, settle every ${SETTLE_EVERY_MS / 60_000}m, X every ${X_EVERY_MS / 60_000}m, new-market scan every ${NEW_SCAN_EVERY_MS / 60_000}m, new-market scoring every ${NEW_SCORE_EVERY_MS / 60_000}m, jump scan every ${JUMP_SCAN_EVERY_MS / 60_000}m (entries each cycle, settle every ${JUMP_SETTLE_EVERY_MS / 60_000}m); logs in ${FORWARD_DIR} and ${DEFAULT_POSTS_PATH}. Ctrl-C stops.`);
  let lastSettle = 0;
  let lastX = 0;
  let lastNewScan = 0;
  let lastNewScore = 0;
  let lastJumpScan = 0;
  let lastJumpSettle = 0;
  for (let cycle = 1; !stopping; cycle++) {
    const t0 = Date.now();
    const parts: string[] = [];
    const step = async (name: string, fn: () => Promise<string>) => {
      if (stopping) return;
      try {
        parts.push(await fn());
      } catch (e) {
        parts.push(`${name} FAILED: ${errMsg(e)}`);
      }
    };
    await step('snapshots', async () => snapText(await snapshotUpcoming(client)));
    if (Date.now() - lastSettle >= SETTLE_EVERY_MS) {
      lastSettle = Date.now();
      await step('settle', async () => settleText(await settleSnapshots(client)));
    }
    if (Date.now() - lastX >= X_EVERY_MS) {
      lastX = Date.now();
      await step('x', async () => {
        const handles = await loadHandles();
        return handles.length ? xText(await pollAccounts(httpFetchText, handles)) : 'x: no handles';
      });
    }
    if (Date.now() - lastNewScan >= NEW_SCAN_EVERY_MS) {
      lastNewScan = Date.now();
      await step('new', async () => {
        const s = await scanNewMarkets(client, { hours: 24 });
        return newScanText(s, logFlagged(s.lines));
      });
    }
    if (Date.now() - lastNewScore >= NEW_SCORE_EVERY_MS) {
      lastNewScore = Date.now();
      await step('new-score', async () => newScoreText(await scoreNewMarketLog(client)));
    }
    if (Date.now() - lastJumpScan >= JUMP_SCAN_EVERY_MS) {
      lastJumpScan = Date.now();
      await step('jumps', async () => {
        const s = await scanJumps(client);
        return jumpScanText(s, logJumps(s.flags).length);
      });
    }
    await step('jump-entries', async () => entryText(await captureEntries(client)));
    if (Date.now() - lastJumpSettle >= JUMP_SETTLE_EVERY_MS) {
      lastJumpSettle = Date.now();
      await step('jump-settle', async () => jumpSettleText(await settleJumps(client)));
    }
    console.log(`${new Date().toISOString().slice(0, 19).replace('T', ' ')}Z #${cycle} ${((Date.now() - t0) / 1000).toFixed(0)}s | ${parts.join(' | ')}`);
    const wait = Math.max(0, everySecs * 1000 - (Date.now() - t0));
    if (!stopping && wait > 0) await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    wake = null;
  }
  process.off('SIGINT', onSigint);
  process.off('SIGTERM', onSigint);
  console.log('daemon stopped');
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
      case 'decide': {
        if (!args[0]) throw new Error('usage: decide <event-slug>   (add --wallets to list every profiled wallet)');
        const v = await loadDecision(client, store, args[0], { people: loadPeople(), refs: loadRefs(), onProgress: (x) => !x.done && process.stderr.write(`\r${x.stage}${x.progress.total ? ` ${x.progress.loaded}/${x.progress.total}` : ''}…   `) });
        process.stderr.write('\r' + ' '.repeat(70) + '\r');
        if (!v.decision) throw new Error(v.error ?? 'no decision');
        const d = v.decision;
        console.log(`${d.title}\n${d.headline}  [${d.version}]${v.error ? `\n(partial: ${v.error})` : ''}\n`);
        for (const m of d.markets) {
          const label = m.action === 'BUY YES' || m.action === 'BUY NO' ? `BUY ${(m.outcomes[m.side ?? 0] ?? '').toUpperCase()}` : m.action;
          console.log(`${label.padEnd(8)} ${m.label.slice(0, 34).padEnd(34)} bid/ask ${(m.yesBid?.toFixed(2) ?? '-')}/${(m.yesAsk?.toFixed(2) ?? '-')}  ${m.fair ? `model ${(m.fair.lo * 100).toFixed(0)}-${(m.fair.hi * 100).toFixed(0)}%  ` : ''}${m.edgePts !== null ? `edge +${m.edgePts.toFixed(1)}pt  ` : ''}${m.capacityUsd !== null ? `room ~${usd(m.capacityUsd)}  ` : ''}[${m.confidence} confidence]`);
          for (const r of m.reasons) console.log(`    why:   ${r}`);
          for (const l of m.leads) console.log(`    lead:  ${l.kind === 'MATCH' ? '≈' : 'NEW'} ${l.text}`);
          for (const r of m.context) console.log(`    flow:  ${r}`);
          for (const r of m.risks) console.log(`    risk:  ${r}`);
          for (const r of m.invalidates) console.log(`    check: ${r}`);
        }
        console.log('');
        for (const n of d.notes) console.log(`note: ${n}`);
        const nowSecs = Math.floor(Date.now() / 1000);
        for (const m of d.markets) {
          const ws = v.wallets[m.cid];
          if (!ws?.length) continue;
          console.log(`\nwallets around "${m.label}" (top holders and net buyers; CREATED is when the Polymarket profile was made):`);
          console.log(['WHO'.padEnd(5), 'SIDE'.padEnd(8), 'POSITION'.padStart(9), 'CREATED'.padEnd(18), 'MKTS'.padStart(6), 'X HANDLE'.padEnd(18), 'NAME'].join(' '));
          for (const w of args.includes('--wallets') ? ws : ws.slice(0, 12)) console.log([(w.cls === 'LOW_DATA' ? 'NEW?' : w.cls).padEnd(5), (w.side === null ? '?' : (m.outcomes[w.side] ?? '?')).slice(0, 8).padEnd(8), (w.posUsd === null ? '-' : usd(w.posUsd)).padStart(9), accountAge(w.createdAt, nowSecs).label.padEnd(18), String(w.traded ?? '-').padStart(6), (w.xUsername ? `@${w.xUsername}` : '').padEnd(18), `${w.matches.length ? '≈ ' : ''}${w.name ?? w.wallet}`].join(' '));
        }
        console.log('\nA decision is a reading of public data, not advice. ARB needs both legs filled; model calls are low confidence; wallet leads are never a trade signal.');
        return;
      }
      case 'edges': {
        const res = await scanAll(client, { events: flag(args, 'events', 400), minEdge: flag(args, 'min-edge', 0.02), minLiq: flag(args, 'min-liq', 500), verifyTop: args.includes('--no-verify') ? 0 : flag(args, 'verify', 12), onProgress: (stage) => process.stderr.write(`\r${stage.padEnd(70)}`) });
        process.stderr.write('\r' + ' '.repeat(72) + '\r');
        saveEdges(res, EDGES_PATH);
        const top = flag(args, 'top', 25);
        const nRef = res.candidates.filter((c) => c.kind === 'REF').length;
        console.log(`scanned ${res.eventsScanned} events / ${res.marketsScanned} markets: ${res.candidates.length - nRef} structural candidate(s), ${nRef} REF model call(s); list saved to ${EDGES_PATH}${res.errors.length ? `\n(errors: ${res.errors.join('; ')})` : ''}\n`);
        for (const c of res.candidates.slice(0, top)) {
          const live = c.kind === 'REF' ? `MODEL ~+${(c.liveEdgePts ?? c.edgePts).toFixed(1)}pt${c.verified ? ' on live books' : ' on screen quotes'}` : c.verified === null ? (c.note ? 'unchecked' : 'not checked') : c.verified ? `LIVE +${(c.liveEdgePts ?? 0).toFixed(1)}pt, ~$${Math.round(c.profitUsd ?? 0)} at $${Math.round(c.depthUsd ?? 0)} depth` : 'STALE (gone on live books)';
          console.log(`${KIND_TEXT[c.kind].padEnd(7)} +${c.edgePts.toFixed(1).padStart(5)}pt screen | ${live.padEnd(34)} | ${c.confidence.padEnd(6)} | liq $${Math.round(c.liqMin)} | ${c.title.slice(0, 60)}`);
          console.log(`        ${c.legs.map((l) => `${l.action} "${l.label.slice(0, 22)}" @${l.price.toFixed(3)}`).join('  +  ')}  -> ${c.kind === 'REF' ? `fair range edge $${c.payoff.toFixed(2)} (NOT guaranteed)` : `pays >= $${c.payoff.toFixed(2)}`} for ${c.cost.toFixed(3)}`);
          if (c.note) console.log(`        note: ${c.note}`);
          console.log(`        https://polymarket.com/event/${c.slug}`);
        }
        if (res.candidates.length === 0) console.log('nothing structural right now: that is the normal state of an efficient market, not a bug.');
        if (res.unmapped.length) console.log(`\n${unmappedNote(res.unmapped.length)}: ${res.unmapped.slice(0, 5).join(' | ')}${res.unmapped.length > 5 ? ' | …' : ''}`);
        console.log('\nStructural edges before fees; each leg must fill. REF rows are low-confidence model calls from an external price, not guaranteed. No forecasting edge is claimed (see docs/research/radar/HOLDERS_STUDY.md).');
        return;
      }
      case 'research': {
        if (!args[0]) throw new Error('usage: research <event-slug>   (market state + recent headlines; find slugs with: find <text>)');
        const nv = await loadNews(client, httpFetchText, args[0]);
        if (nv.error && nv.hits.length === 0) throw new Error(nv.error);
        console.log(`${nv.title}\nsearched: ${nv.query}${nv.sourceErrors.length ? `   (${nv.sourceErrors.join('; ')})` : ''}\n`);
        for (const mk of nv.markets) console.log(`  ${mk.label.slice(0, 24).padEnd(24)} bid/ask ${mk.bid ?? '-'}/${mk.ask ?? '-'}${mk.endsAt ? `  ends ${iso(mk.endsAt)}` : ''}${mk.uma.length ? `  oracle: ${mk.uma.join(' > ')}` : ''}${mk.closed ? '  (closed)' : ''}`);
        console.log('');
        for (const h of nv.hits) console.log(`${(h.publishedAt === null ? 'undated' : new Date(h.publishedAt).toISOString().slice(5, 16).replace('T', ' ')).padEnd(11)} ${(h.source || '?').slice(0, 22).padEnd(22)} ${h.title}\n${' '.repeat(34)}${h.url}`);
        if (nv.hits.length === 0) console.log('no headlines in the last 7 days (this is not evidence that nothing happened)');
        return;
      }
      case 'people': {
        const [sub, ...rest] = args;
        if (sub === 'add') {
          if (!rest[0]) throw new Error('usage: people add "Full Name" [--org X --role Y --handle xhandle --alias "Other Name" --note "..."]');
          const opt = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
          const all = (n: string) => rest.flatMap((x, i) => (x === `--${n}` && rest[i + 1] ? [rest[i + 1]] : []));
          const people = addPerson({ name: rest[0], org: opt('org'), role: opt('role'), handles: all('handle'), aliases: all('alias'), note: opt('note') });
          console.log(`watchlist now has ${people.length} people (${PEOPLE_PATH})`);
          return;
        }
        if (sub === 'remove') {
          if (!rest[0]) throw new Error('usage: people remove "Full Name"');
          console.log(removePerson(rest[0]) ? 'removed' : 'no such person');
          return;
        }
        if (sub === 'check') {
          // people check <wallet>: how does this wallet's public profile compare with the watchlist
          if (!rest[0]) throw new Error('usage: people check <wallet>');
          const id = await identityFor(client, store, rest[0].toLowerCase(), Date.now, 0);
          if (!id) return void console.log('profile lookup failed');
          const hits = matchPeople(id, loadPeople());
          console.log(`${id.name ?? id.pseudonym ?? '(no name)'}${id.xUsername ? `  X @${id.xUsername}` : ''}  profile created ${accountAge(id.createdAt, Date.now() / 1000).label}`);
          if (id.bio) console.log(`bio: ${id.bio}`);
          console.log(hits.length ? hits.map((h) => `  ≈ ${h.why} -> ${describePerson(h.person)} (${h.kind} ${h.score}); name match only, unverified`).join('\n') : '  no watchlist matches');
          return;
        }
        const people = loadPeople();
        console.log(`${people.length} people on ${PEOPLE_PATH}${people.length ? '' : '  (empty: add with  people add "Full Name" --org 1win --role "Head of X" --handle theirhandle)'}`);
        for (const p of people) console.log(`  ${describePerson(p)}${p.handles?.length ? `  ${p.handles.map((h) => `@${h.replace(/^@/, '')}`).join(' ')}` : ''}${p.aliases?.length ? `  aka ${p.aliases.join(', ')}` : ''}`);
        console.log(`reference config: ${REFS_PATH} (${loadRefs().length} entries). Matching uses display name, pseudonym, linked X handle and bio only: Polymarket exposes no e-mail.`);
        return;
      }
      case 'tui':
      case 'scan': {
        const cols = flag(args, 'cols', 0);
        const rows = flag(args, 'rows', 0);
        const val = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
        await runTui(store, client, {
          once: cmd === 'scan' || args.includes('--once'),
          news: !args.includes('--no-news'),
          intervalSecs: flag(args, 'interval', 120),
          cols: cols || undefined,
          rows: rows || undefined,
          tab: (['anomalies', 'games', 'prints', 'holders', 'leads', 'decision', 'search', 'news', 'edge', 'ledger', 'new', 'jumps'] as const).find((t) => t === val('tab')),
          slug: val('slug'),
        });
        return;
      }
      case 'forward-log': {
        const r = await snapshotUpcoming(client);
        console.log(snapText(r));
        for (const e of r.errors) console.log(`  error: ${e}`);
        console.log(`log: ${SNAPSHOTS_PATH}`);
        return;
      }
      case 'forward-settle': {
        const r = await settleSnapshots(client);
        console.log(settleText(r));
        for (const e of r.errors) console.log(`  error: ${e}`);
        console.log(`log: ${RESULTS_PATH}`);
        return;
      }
      case 'ledger':
        return ledger();
      case 'new-scan':
        return newScan(client, Math.max(1, flag(args, 'hours', 24)), Math.max(1, flag(args, 'top', 20)));
      case 'new-score':
        return newScore(client);
      case 'jumps':
        return jumps(client, Math.max(1, flag(args, 'top', 25)));
      case 'jumps-settle': {
        const r = await settleJumps(client);
        console.log(jumpSettleText(r));
        for (const e of r.errors.slice(0, 5)) console.log(`  error: ${e}`);
        console.log(`log: ${JUMPS_PATH}`);
        return;
      }
      case 'jumps-score':
        return jumpsScore();
      case 'watch':
        return watchJumps(client, Math.max(1, flag(args, 'every', 5)), !args.includes('--no-notify'), args.includes('--calm-only'), args.includes('--no-sports'));
      case 'daemon':
        return daemon(client, Math.max(5, flag(args, 'every', 30)));
      case 'x-add': {
        const handle = cleanHandle(args[0] ?? '');
        if (!handle) throw new Error('usage: x-add <handle> [note]');
        const list = await loadHandles();
        const note = args.slice(1).join(' ').trim();
        const i = list.findIndex((a) => a.handle.toLowerCase() === handle.toLowerCase());
        const entry = note ? { handle, note } : { handle };
        if (i >= 0) list[i] = note ? entry : list[i];
        else list.push(entry);
        mkdirSync(dirname(DEFAULT_HANDLES_PATH), { recursive: true });
        writeFileSync(DEFAULT_HANDLES_PATH, JSON.stringify(list, null, 2) + '\n');
        console.log(`${i < 0 ? 'added' : note ? 'updated note of' : 'already listed:'} @${handle}; ${list.length} handle(s) in ${DEFAULT_HANDLES_PATH}`);
        return;
      }
      case 'x-list': {
        const list = await loadHandles();
        const posts = await loadPosts();
        const count = new Map<string, number>();
        for (const p of posts) count.set(p.handle.toLowerCase(), (count.get(p.handle.toLowerCase()) ?? 0) + 1);
        console.log(`${list.length} handle(s) in ${DEFAULT_HANDLES_PATH}${list.length ? '' : '  (add with: x-add <handle> [note])'}; ${posts.length} post(s) logged in ${DEFAULT_POSTS_PATH}`);
        for (const a of list) console.log(`  @${a.handle.padEnd(20)} ${String(count.get(a.handle.toLowerCase()) ?? 0).padStart(5)} posts${a.note ? `  ${a.note}` : ''}`);
        return;
      }
      case 'x-poll': {
        const list = await loadHandles();
        if (list.length === 0) return void console.log(`no handles in ${DEFAULT_HANDLES_PATH}; add with: x-add <handle> [note]`);
        for (const r of await pollAccounts(httpFetchText, list)) console.log(`${r.error ? 'FAIL' : 'ok  '} @${r.handle.padEnd(20)} parsed ${String(r.parsed).padStart(3)}, new ${String(r.added).padStart(3)}${r.error ? `  (${r.error})` : ''}`);
        console.log(`log: ${DEFAULT_POSTS_PATH} (firstSeenAt is the only time a scorer may trust)`);
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
        console.log('commands: tui [--interval S --no-news] | daemon [--every SECS] | forward-log | forward-settle | ledger | new-scan [--hours N --top K] | new-score | jumps [--top N] | jumps-settle | jumps-score | x-add <handle> [note] | x-list | x-poll | decide <slug> [--wallets] | research <slug> | edges [--top N --events N --min-edge D --min-liq USD --verify K --no-verify] | people list|add|remove|check <wallet> | holders <slug> [--all] | scan [--cols N --rows N --tab games|prints|leads|decision|edge|ledger|new|jumps --slug S] | seed | cases | news poll|list|dismiss | case-add <file> | find <text> | ingest <slug> | report <slug> | link <case> <slug> | backfill [--max N --min-volume USD]');
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
