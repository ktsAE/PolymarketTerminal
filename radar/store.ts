import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validateEvent, type CaseEvent, type EvidenceTier } from './evidence.ts';
import type { Classification, NewsItem } from './news.ts';

export interface MarketRow {
  cid: string;
  eventSlug: string;
  eventTitle: string;
  game: string | null;
  marketType: string | null;
  question: string;
  outcomes: string[];
  tokenIds: string[];
  gameStart: number | null; // epoch seconds
  result: number[] | null; // outcome prices when resolved, e.g. [0,1] or [0.5,0.5] when voided
  volume: number;
  closed: boolean;
}

export interface TradeRow {
  cid: string;
  wallet: string;
  side: 'BUY' | 'SELL';
  outcomeIndex: number;
  price: number;
  size: number;
  ts: number; // epoch seconds
  tx: string | null;
}

export interface WalletRow {
  wallet: string;
  firstSeen: number | null; // epoch seconds
  traded: number | null;
  bigPositions: number | null;
  skillZ: number | null;
  fetchedAt: number;
}

export interface CaseRow {
  id: string;
  title: string;
  game: string | null;
  tournament: string | null;
  teams: string[];
  matchAt: number | null; // epoch ms
  polymarketSlug: string | null;
  notes: string | null;
}

export interface NewsRow extends NewsItem {
  firstSeen: number;
  relevant: boolean;
  category: string;
  matched: string[];
  tierHint: EvidenceTier | null;
  note: string;
  status: 'new' | 'dismissed' | 'promoted';
  caseId: string | null;
}

export interface SnapRow {
  eventId: string;
  ts: number; // epoch seconds
  slug: string;
  title: string;
  oi: number;
  vol24: number;
  vol1w: number;
  liq: number;
  price: number | null;
  ch1h: number | null;
  ch1d: number | null;
  created: number | null; // epoch seconds
  endDate: number | null; // epoch seconds
  isGame: boolean;
  cat: string;
  /** Earliest scheduled start of any market in the event (epoch seconds), for games. */
  startsAt: number | null;
}

export interface PrintRow {
  key: string;
  ts: number;
  wallet: string;
  cid: string;
  eventSlug: string;
  title: string;
  outcome: string | null;
  side: 'BUY' | 'SELL';
  price: number;
  size: number;
  usd: number;
  name: string | null;
}

/** Cached public-profile data. A wallet without a profile is cached too (every field null) so it is not asked about again for a day. */
export interface WalletIdentity {
  wallet: string;
  fetchedAt: number; // epoch seconds
  createdAt: number | null; // epoch seconds, when the profile was created
  name: string | null;
  pseudonym: string | null;
  xUsername: string | null;
  bio: string | null;
  verified: boolean;
}

export interface HolderProfile {
  wallet: string;
  fetchedAt: number; // epoch seconds
  name: string | null;
  cls: 'BOT' | 'ALGO' | 'MM' | 'HUMAN' | 'LOW_DATA';
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  perDay: number | null;
  traded: number | null;
  vol: number | null;
  ageDays: number | null;
  pnlAll: number | null;
  pnlWeek: number | null;
}

export interface SignalRow {
  cid: string;
  version: string;
  computedAt: number;
  score: number;
  level: string;
  reasons: unknown;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS markets(
  cid TEXT PRIMARY KEY, event_slug TEXT NOT NULL, event_title TEXT NOT NULL, game TEXT, market_type TEXT,
  question TEXT NOT NULL, outcomes TEXT NOT NULL, token_ids TEXT NOT NULL, game_start INTEGER, result TEXT,
  volume REAL NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS markets_event ON markets(event_slug);
CREATE INDEX IF NOT EXISTS markets_type ON markets(market_type);
CREATE TABLE IF NOT EXISTS trades(
  key TEXT PRIMARY KEY, cid TEXT NOT NULL, wallet TEXT NOT NULL, side TEXT NOT NULL, outcome_index INTEGER NOT NULL,
  price REAL NOT NULL, size REAL NOT NULL, ts INTEGER NOT NULL, tx TEXT);
CREATE INDEX IF NOT EXISTS trades_cid_ts ON trades(cid, ts);
CREATE INDEX IF NOT EXISTS trades_wallet ON trades(wallet);
CREATE TABLE IF NOT EXISTS wallets(
  wallet TEXT PRIMARY KEY, first_seen INTEGER, traded INTEGER, big_positions INTEGER, skill_z REAL, fetched_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cases(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, game TEXT, tournament TEXT, teams TEXT NOT NULL, match_at INTEGER,
  polymarket_slug TEXT, notes TEXT);
CREATE TABLE IF NOT EXISTS case_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL REFERENCES cases(id), at INTEGER NOT NULL,
  approx INTEGER NOT NULL DEFAULT 0, tier TEXT NOT NULL, summary TEXT NOT NULL, sources TEXT NOT NULL, claims TEXT NOT NULL,
  UNIQUE(case_id, at, tier, summary));
CREATE TABLE IF NOT EXISTS signals(
  id INTEGER PRIMARY KEY AUTOINCREMENT, cid TEXT NOT NULL, version TEXT NOT NULL, computed_at INTEGER NOT NULL,
  score REAL NOT NULL, level TEXT NOT NULL, reasons TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS signals_cid ON signals(cid, computed_at);
CREATE TABLE IF NOT EXISTS snapshots(
  event_id TEXT NOT NULL, ts INTEGER NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, oi REAL NOT NULL, vol24 REAL NOT NULL,
  vol1w REAL NOT NULL, liq REAL NOT NULL, price REAL, ch1h REAL, ch1d REAL, created INTEGER, end_date INTEGER,
  is_game INTEGER NOT NULL DEFAULT 0, cat TEXT NOT NULL DEFAULT '', starts_at INTEGER,
  PRIMARY KEY(event_id, ts));
CREATE TABLE IF NOT EXISTS prints(
  key TEXT PRIMARY KEY, ts INTEGER NOT NULL, wallet TEXT NOT NULL, cid TEXT NOT NULL, event_slug TEXT NOT NULL, title TEXT NOT NULL,
  outcome TEXT, side TEXT NOT NULL, price REAL NOT NULL, size REAL NOT NULL, usd REAL NOT NULL, name TEXT);
CREATE INDEX IF NOT EXISTS prints_ts ON prints(ts);
CREATE INDEX IF NOT EXISTS prints_slug ON prints(event_slug, ts);
CREATE TABLE IF NOT EXISTS holder_profiles(
  wallet TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, name TEXT, cls TEXT NOT NULL, confidence TEXT NOT NULL, reasons TEXT NOT NULL,
  per_day REAL, traded INTEGER, vol REAL, age_days REAL, pnl_all REAL, pnl_week REAL);
CREATE TABLE IF NOT EXISTS wallet_identity(
  wallet TEXT PRIMARY KEY, fetched_at INTEGER NOT NULL, created_at INTEGER, name TEXT, pseudonym TEXT, x_username TEXT, bio TEXT, verified INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS news_items(
  url TEXT PRIMARY KEY, feed_id TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL, published_at INTEGER, first_seen INTEGER NOT NULL,
  relevant INTEGER NOT NULL, category TEXT NOT NULL, matched TEXT NOT NULL, tier_hint TEXT, note TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new', case_id TEXT);
CREATE INDEX IF NOT EXISTS news_status ON news_items(status, relevant, published_at);
`;

export function tradeKey(t: TradeRow): string {
  return createHash('sha1')
    .update([t.tx ?? '', t.cid, t.wallet, t.side, t.outcomeIndex, t.size, t.price, t.ts].join('|'))
    .digest('hex');
}

const plain = <T>(row: unknown): T => ({ ...(row as object) }) as T;
const jsonOr = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== 'string') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export class RadarStore {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  upsertMarket(m: MarketRow, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO markets(cid,event_slug,event_title,game,market_type,question,outcomes,token_ids,game_start,result,volume,closed,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(cid) DO UPDATE SET event_slug=excluded.event_slug,event_title=excluded.event_title,game=excluded.game,
           market_type=excluded.market_type,question=excluded.question,outcomes=excluded.outcomes,token_ids=excluded.token_ids,
           game_start=excluded.game_start,result=excluded.result,volume=excluded.volume,closed=excluded.closed,updated_at=excluded.updated_at`,
      )
      .run(
        m.cid, m.eventSlug, m.eventTitle, m.game, m.marketType, m.question, JSON.stringify(m.outcomes), JSON.stringify(m.tokenIds),
        m.gameStart, m.result ? JSON.stringify(m.result) : null, m.volume, m.closed ? 1 : 0, now,
      );
  }

  private marketFrom(r: Record<string, unknown>): MarketRow {
    return {
      cid: r.cid as string, eventSlug: r.event_slug as string, eventTitle: r.event_title as string,
      game: (r.game as string | null) ?? null, marketType: (r.market_type as string | null) ?? null, question: r.question as string,
      outcomes: jsonOr<string[]>(r.outcomes, []), tokenIds: jsonOr<string[]>(r.token_ids, []),
      gameStart: (r.game_start as number | null) ?? null, result: jsonOr<number[] | null>(r.result, null),
      volume: r.volume as number, closed: r.closed === 1,
    };
  }

  getMarket(cid: string): MarketRow | undefined {
    const r = this.db.prepare('SELECT * FROM markets WHERE cid=?').get(cid);
    return r ? this.marketFrom(plain(r)) : undefined;
  }

  marketsForEvent(slug: string): MarketRow[] {
    return this.db
      .prepare('SELECT * FROM markets WHERE event_slug=? ORDER BY volume DESC')
      .all(slug)
      .map((r) => this.marketFrom(plain(r)));
  }

  /** Inserts new trades, ignoring ones already stored; returns how many were new. */
  insertTrades(rows: readonly TradeRow[]): number {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO trades(key,cid,wallet,side,outcome_index,price,size,ts,tx) VALUES(?,?,?,?,?,?,?,?,?)',
    );
    return this.tx(() => {
      let added = 0;
      for (const t of rows) added += Number(stmt.run(tradeKey(t), t.cid, t.wallet, t.side, t.outcomeIndex, t.price, t.size, t.ts, t.tx).changes);
      return added;
    });
  }

  tradesFor(cid: string): TradeRow[] {
    return this.db
      .prepare('SELECT cid,wallet,side,outcome_index,price,size,ts,tx FROM trades WHERE cid=? ORDER BY ts, key')
      .all(cid)
      .map((r) => {
        const x = plain<Record<string, unknown>>(r);
        return {
          cid: x.cid as string, wallet: x.wallet as string, side: x.side as 'BUY' | 'SELL', outcomeIndex: x.outcome_index as number,
          price: x.price as number, size: x.size as number, ts: x.ts as number, tx: (x.tx as string | null) ?? null,
        };
      });
  }

  upsertWallet(w: WalletRow): void {
    this.db
      .prepare(
        `INSERT INTO wallets(wallet,first_seen,traded,big_positions,skill_z,fetched_at) VALUES(?,?,?,?,?,?)
         ON CONFLICT(wallet) DO UPDATE SET first_seen=excluded.first_seen,traded=excluded.traded,big_positions=excluded.big_positions,
           skill_z=excluded.skill_z,fetched_at=excluded.fetched_at`,
      )
      .run(w.wallet, w.firstSeen, w.traded, w.bigPositions, w.skillZ, w.fetchedAt);
  }

  getWallet(wallet: string): WalletRow | undefined {
    const r = this.db.prepare('SELECT * FROM wallets WHERE wallet=?').get(wallet);
    if (!r) return undefined;
    const x = plain<Record<string, unknown>>(r);
    return {
      wallet: x.wallet as string, firstSeen: (x.first_seen as number | null) ?? null, traded: (x.traded as number | null) ?? null,
      bigPositions: (x.big_positions as number | null) ?? null, skillZ: (x.skill_z as number | null) ?? null, fetchedAt: x.fetched_at as number,
    };
  }

  upsertCase(c: CaseRow): void {
    this.db
      .prepare(
        `INSERT INTO cases(id,title,game,tournament,teams,match_at,polymarket_slug,notes) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title,game=excluded.game,tournament=excluded.tournament,teams=excluded.teams,
           match_at=excluded.match_at,polymarket_slug=excluded.polymarket_slug,notes=excluded.notes`,
      )
      .run(c.id, c.title, c.game, c.tournament, JSON.stringify(c.teams), c.matchAt, c.polymarketSlug, c.notes);
  }

  /** Validates the tier against its sources; throws if the evidence does not justify it. */
  addCaseEvent(caseId: string, ev: CaseEvent): void {
    const errors = validateEvent(ev);
    if (errors.length) throw new Error(`case ${caseId}: ${errors.join('; ')}`);
    this.db
      .prepare('INSERT OR IGNORE INTO case_events(case_id,at,approx,tier,summary,sources,claims) VALUES(?,?,?,?,?,?,?)')
      .run(caseId, ev.at, ev.approx ? 1 : 0, ev.tier, ev.summary, JSON.stringify(ev.sources), JSON.stringify(ev.claims));
  }

  caseEvents(caseId: string): CaseEvent[] {
    return this.db
      .prepare('SELECT * FROM case_events WHERE case_id=? ORDER BY at, id')
      .all(caseId)
      .map((r) => {
        const x = plain<Record<string, unknown>>(r);
        return {
          at: x.at as number, approx: x.approx === 1, tier: x.tier as CaseEvent['tier'], summary: x.summary as string,
          sources: jsonOr(x.sources, []), claims: jsonOr(x.claims, []),
        };
      });
  }

  listCases(): Array<CaseRow & { events: CaseEvent[] }> {
    return this.db
      .prepare('SELECT * FROM cases ORDER BY match_at DESC, id')
      .all()
      .map((r) => {
        const x = plain<Record<string, unknown>>(r);
        const id = x.id as string;
        return {
          id, title: x.title as string, game: (x.game as string | null) ?? null, tournament: (x.tournament as string | null) ?? null,
          teams: jsonOr<string[]>(x.teams, []), matchAt: (x.match_at as number | null) ?? null,
          polymarketSlug: (x.polymarket_slug as string | null) ?? null, notes: (x.notes as string | null) ?? null,
          events: this.caseEvents(id),
        };
      });
  }

  /** Stores a feed item once (by URL). Returns true when it was new. */
  addNews(item: NewsItem, c: Classification, now = Date.now()): boolean {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO news_items(url,feed_id,title,summary,published_at,first_seen,relevant,category,matched,tier_hint,note) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(item.url, item.feedId, item.title, item.summary, item.publishedAt, now, c.relevant ? 1 : 0, c.category, JSON.stringify(c.matched), c.tierHint, c.note);
    return Number(r.changes) > 0;
  }

  listNews(opts: { status?: NewsRow['status']; relevantOnly?: boolean; limit?: number } = {}): NewsRow[] {
    const where = ['status = ?'];
    if (opts.relevantOnly ?? true) where.push('relevant = 1');
    return this.db
      .prepare(`SELECT * FROM news_items WHERE ${where.join(' AND ')} ORDER BY COALESCE(published_at, first_seen) DESC LIMIT ?`)
      .all(opts.status ?? 'new', opts.limit ?? 50)
      .map((r) => {
        const x = plain<Record<string, unknown>>(r);
        return {
          feedId: x.feed_id as string, url: x.url as string, title: x.title as string, summary: x.summary as string,
          publishedAt: (x.published_at as number | null) ?? null, firstSeen: x.first_seen as number, relevant: x.relevant === 1,
          category: x.category as string, matched: jsonOr<string[]>(x.matched, []), tierHint: (x.tier_hint as EvidenceTier | null) ?? null,
          note: x.note as string, status: x.status as NewsRow['status'], caseId: (x.case_id as string | null) ?? null,
        };
      });
  }

  setNewsStatus(url: string, status: NewsRow['status'], caseId: string | null = null): boolean {
    return Number(this.db.prepare('UPDATE news_items SET status=?, case_id=? WHERE url=?').run(status, caseId, url).changes) > 0;
  }

  insertSnapshots(rows: readonly SnapRow[]): number {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO snapshots(event_id,ts,slug,title,oi,vol24,vol1w,liq,price,ch1h,ch1d,created,end_date,is_game,cat,starts_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    return this.tx(() => {
      let n = 0;
      for (const r of rows) n += Number(stmt.run(r.eventId, r.ts, r.slug, r.title, r.oi, r.vol24, r.vol1w, r.liq, r.price, r.ch1h, r.ch1d, r.created, r.endDate, r.isGame ? 1 : 0, r.cat, r.startsAt).changes);
      return n;
    });
  }

  private snapFrom(x: Record<string, unknown>): SnapRow {
    return {
      eventId: x.event_id as string, ts: x.ts as number, slug: x.slug as string, title: x.title as string, oi: x.oi as number, vol24: x.vol24 as number,
      vol1w: x.vol1w as number, liq: x.liq as number, price: (x.price as number | null) ?? null, ch1h: (x.ch1h as number | null) ?? null,
      ch1d: (x.ch1d as number | null) ?? null, created: (x.created as number | null) ?? null, endDate: (x.end_date as number | null) ?? null,
      isGame: x.is_game === 1, cat: (x.cat as string | null) ?? '', startsAt: (x.starts_at as number | null) ?? null,
    };
  }

  /** Nearest snapshot at or before `ts`; if none exists, the earliest one we have. */
  snapshotNear(eventId: string, ts: number): SnapRow | undefined {
    const before = this.db.prepare('SELECT * FROM snapshots WHERE event_id=? AND ts<=? ORDER BY ts DESC LIMIT 1').get(eventId, ts);
    if (before) return this.snapFrom(plain(before));
    const first = this.db.prepare('SELECT * FROM snapshots WHERE event_id=? ORDER BY ts ASC LIMIT 1').get(eventId);
    return first ? this.snapFrom(plain(first)) : undefined;
  }

  snapshotSeries(eventId: string, since: number): SnapRow[] {
    return this.db.prepare('SELECT * FROM snapshots WHERE event_id=? AND ts>=? ORDER BY ts').all(eventId, since).map((r) => this.snapFrom(plain(r)));
  }

  latestSnapshots(): SnapRow[] {
    return this.db
      .prepare('SELECT s.* FROM snapshots s JOIN (SELECT event_id, MAX(ts) m FROM snapshots GROUP BY event_id) l ON s.event_id=l.event_id AND s.ts=l.m ORDER BY s.vol24 DESC')
      .all()
      .map((r) => this.snapFrom(plain(r)));
  }

  /** Seconds covered by stored snapshots (null when empty). */
  snapshotSpan(): { first: number; last: number } | null {
    const r = plain<{ a: number | null; b: number | null }>(this.db.prepare('SELECT MIN(ts) a, MAX(ts) b FROM snapshots').get());
    return r.a === null || r.b === null ? null : { first: r.a, last: r.b };
  }

  pruneOld(snapshotsBefore: number, printsBefore: number): void {
    this.db.prepare('DELETE FROM snapshots WHERE ts<?').run(snapshotsBefore);
    this.db.prepare('DELETE FROM prints WHERE ts<?').run(printsBefore);
  }

  insertPrints(rows: readonly PrintRow[]): number {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO prints(key,ts,wallet,cid,event_slug,title,outcome,side,price,size,usd,name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
    return this.tx(() => {
      let n = 0;
      for (const r of rows) n += Number(stmt.run(r.key, r.ts, r.wallet, r.cid, r.eventSlug, r.title, r.outcome, r.side, r.price, r.size, r.usd, r.name).changes);
      return n;
    });
  }

  printsSince(ts: number, limit = 500): PrintRow[] {
    return this.db
      .prepare('SELECT * FROM prints WHERE ts>=? ORDER BY ts DESC LIMIT ?')
      .all(ts, limit)
      .map((r) => {
        const x = plain<Record<string, unknown>>(r);
        return {
          key: x.key as string, ts: x.ts as number, wallet: x.wallet as string, cid: x.cid as string, eventSlug: x.event_slug as string,
          title: x.title as string, outcome: (x.outcome as string | null) ?? null, side: x.side as 'BUY' | 'SELL', price: x.price as number,
          size: x.size as number, usd: x.usd as number, name: (x.name as string | null) ?? null,
        };
      });
  }

  upsertHolderProfile(h: HolderProfile): void {
    this.db
      .prepare(
        `INSERT INTO holder_profiles(wallet,fetched_at,name,cls,confidence,reasons,per_day,traded,vol,age_days,pnl_all,pnl_week) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(wallet) DO UPDATE SET fetched_at=excluded.fetched_at,name=excluded.name,cls=excluded.cls,confidence=excluded.confidence,reasons=excluded.reasons,
           per_day=excluded.per_day,traded=excluded.traded,vol=excluded.vol,age_days=excluded.age_days,pnl_all=excluded.pnl_all,pnl_week=excluded.pnl_week`,
      )
      .run(h.wallet, h.fetchedAt, h.name, h.cls, h.confidence, JSON.stringify(h.reasons), h.perDay, h.traded, h.vol, h.ageDays, h.pnlAll, h.pnlWeek);
  }

  getHolderProfile(wallet: string): HolderProfile | undefined {
    const r = this.db.prepare('SELECT * FROM holder_profiles WHERE wallet=?').get(wallet);
    if (!r) return undefined;
    const x = plain<Record<string, unknown>>(r);
    return {
      wallet: x.wallet as string, fetchedAt: x.fetched_at as number, name: (x.name as string | null) ?? null, cls: x.cls as HolderProfile['cls'],
      confidence: x.confidence as HolderProfile['confidence'], reasons: jsonOr<string[]>(x.reasons, []), perDay: (x.per_day as number | null) ?? null,
      traded: (x.traded as number | null) ?? null, vol: (x.vol as number | null) ?? null, ageDays: (x.age_days as number | null) ?? null,
      pnlAll: (x.pnl_all as number | null) ?? null, pnlWeek: (x.pnl_week as number | null) ?? null,
    };
  }

  upsertIdentity(i: WalletIdentity): void {
    this.db
      .prepare(
        `INSERT INTO wallet_identity(wallet,fetched_at,created_at,name,pseudonym,x_username,bio,verified) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT(wallet) DO UPDATE SET fetched_at=excluded.fetched_at,created_at=excluded.created_at,name=excluded.name,pseudonym=excluded.pseudonym,x_username=excluded.x_username,bio=excluded.bio,verified=excluded.verified`,
      )
      .run(i.wallet, i.fetchedAt, i.createdAt, i.name, i.pseudonym, i.xUsername, i.bio, i.verified ? 1 : 0);
  }

  getIdentity(wallet: string): WalletIdentity | undefined {
    const r = this.db.prepare('SELECT * FROM wallet_identity WHERE wallet=?').get(wallet);
    if (!r) return undefined;
    const x = plain<Record<string, unknown>>(r);
    const s = (v: unknown) => (v as string | null) ?? null;
    return { wallet: x.wallet as string, fetchedAt: x.fetched_at as number, createdAt: (x.created_at as number | null) ?? null, name: s(x.name), pseudonym: s(x.pseudonym), xUsername: s(x.x_username), bio: s(x.bio), verified: x.verified === 1 };
  }

  saveSignal(s: SignalRow): void {
    this.db
      .prepare('INSERT INTO signals(cid,version,computed_at,score,level,reasons) VALUES(?,?,?,?,?,?)')
      .run(s.cid, s.version, s.computedAt, s.score, s.level, JSON.stringify(s.reasons));
  }

  /** Volume distribution of stored markets of one type, used to judge whether activity is abnormal. */
  volumeBaseline(marketType: string): { n: number; median: number; p90: number } {
    const rows = this.db
      .prepare('SELECT volume FROM markets WHERE market_type=? ORDER BY volume')
      .all(marketType)
      .map((r) => (r as { volume: number }).volume);
    if (rows.length === 0) return { n: 0, median: 0, p90: 0 };
    return { n: rows.length, median: rows[Math.floor(rows.length / 2)], p90: rows[Math.min(rows.length - 1, Math.floor(rows.length * 0.9))] };
  }
}

export function openStore(path = ':memory:'): RadarStore {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  // additive migrations for databases created by earlier versions
  const cols = db.prepare('PRAGMA table_info(snapshots)').all().map((r) => (r as { name: string }).name);
  if (!cols.includes('is_game')) db.exec('ALTER TABLE snapshots ADD COLUMN is_game INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('cat')) db.exec("ALTER TABLE snapshots ADD COLUMN cat TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('starts_at')) db.exec('ALTER TABLE snapshots ADD COLUMN starts_at INTEGER');
  return new RadarStore(db);
}
