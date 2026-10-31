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
  return new RadarStore(db);
}
