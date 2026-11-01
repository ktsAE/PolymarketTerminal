import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FetchText } from './poll.ts';

/**
 * Free logger of public X posts for a hand-picked list of accounts (the paid X API is not used).
 * Reads https://r.jina.ai/https://x.com/<handle>, which renders a profile page as markdown: a profile header,
 * an optional Pinned item, then only a handful of recent posts. Search pages are login-walled, so this sees
 * profiles only, and it misses anything posted and pushed off the profile between two polls.
 *
 * Evidence rule: `firstSeenAt` is the moment this logger first saw the text. Any scorer must use it as the time
 * a pick was public, never a time claimed in or inferred from the post.
 */

export interface XPost {
  handle: string;
  text: string;
  url?: string;
  /** Only when the markdown carries an explicit timestamp; informational, never used for scoring. */
  postedAt?: string;
  pinned: boolean;
}

/** One line of .radar/x/posts.jsonl. */
export interface XPostLine extends XPost {
  /** sha1 of the cleaned text; dedupe key together with the lower-cased handle. */
  textSha1: string;
  /** Epoch ms when this logger first saw the post. The only timestamp a scorer may trust. */
  firstSeenAt: number;
}

export interface XAccount {
  handle: string;
  note?: string;
}

export interface AccountPollResult {
  handle: string;
  parsed: number;
  added: number;
  error?: string;
}

export interface PollAccountsOptions {
  sleep?: (ms: number) => Promise<void>;
  /** Politeness pause between handles. */
  gapMs?: number;
}

export const DEFAULT_POSTS_PATH = '.radar/x/posts.jsonl';
export const DEFAULT_HANDLES_PATH = '.radar/x_accounts.json';

export const jinaProfileUrl = (handle: string): string => `https://r.jina.ai/https://x.com/${encodeURIComponent(cleanHandle(handle))}`;

export const cleanHandle = (h: string): string => h.trim().replace(/^@/, '');

export const textSha1 = (text: string): string => createHash('sha1').update(text).digest('hex');

const postKey = (handle: string, sha: string): string => `${cleanHandle(handle).toLowerCase()}|${sha}`;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes image markdown, turns links into their label, drops t.co titles and collapses whitespace. */
export function cleanPostText(raw: string): string {
  let t = raw;
  // linked images first ([![alt](img)](href)), then bare images
  t = t.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, ' ');
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  // [label](url "title") -> label
  t = t.replace(/\[([^\]]*)\]\((?:[^()\s]|\([^)]*\))*(?:\s+"[^"]*")?\)/g, '$1');
  t = t.replace(/https?:\/\/t\.co\/\S+/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

/**
 * Splits jina markdown of an X profile into posts. Posts are the top-level `*   ` list items after the header;
 * a `*   Pinned` item marks the next post as pinned. Header (bio, counts, banner) is never returned.
 */
export function parseProfileMarkdown(md: string, handle: string): XPost[] {
  const h = cleanHandle(handle);
  const body = md.includes('Markdown Content:') ? md.slice(md.indexOf('Markdown Content:') + 'Markdown Content:'.length) : md;
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex((l) => /^\*\s+/.test(l));
  if (first < 0) return [];

  const items: string[] = [];
  let cur: string[] | null = null;
  for (const line of lines.slice(first)) {
    if (/^\*\s+/.test(line)) {
      if (cur) items.push(cur.join('\n'));
      cur = [line.replace(/^\*\s+/, '')];
    } else if (cur) cur.push(line);
  }
  if (cur) items.push(cur.join('\n'));

  const statusRe = new RegExp(`https?://(?:x|twitter)\\.com/${escapeRe(h)}/status/(\\d+)`, 'i');
  const posts: XPost[] = [];
  let pinNext = false;
  for (const item of items) {
    let raw = item;
    let pinned = false;
    if (/^Pinned\b/i.test(raw.trim())) {
      raw = raw.trim().replace(/^Pinned\b/i, '');
      pinned = true;
      if (!cleanPostText(raw)) {
        pinNext = true;
        continue;
      }
    }
    if (pinNext) {
      pinned = true;
      pinNext = false;
    }
    const sm = statusRe.exec(raw);
    const url = sm ? `https://x.com/${h}/status/${sm[1]}` : undefined;
    const dm = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z)\b/.exec(raw);
    // drop "[Oct 30](.../status/..)" style timestamp links and "@handle · " bylines before cleaning
    const stripped = raw.replace(/\[[^\]]{1,20}\]\(https?:\/\/(?:x|twitter)\.com\/[^/\s]+\/status\/\d+[^)]*\)/gi, ' ');
    const text = cleanPostText(stripped);
    if (!text) continue;
    const post: XPost = { handle: h, text, pinned };
    if (url) post.url = url;
    if (dm) post.postedAt = dm[1];
    posts.push(post);
  }
  return posts;
}

async function readLines(storePath: string): Promise<XPostLine[]> {
  let body: string;
  try {
    body = await readFile(storePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const out: XPostLine[] = [];
  for (const l of body.split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l) as XPostLine);
    } catch {
      // a torn last line from an interrupted write is skipped, not fatal
    }
  }
  return out;
}

/** All logged posts, in file order. */
export const loadPosts = (storePath: string = DEFAULT_POSTS_PATH): Promise<XPostLine[]> => readLines(storePath);

/**
 * Fetches each handle's profile, appends posts not seen before (handle + sha1 of text) with firstSeenAt=now().
 * A failing handle is reported in its result and does not stop the others.
 */
export async function pollAccounts(
  fetchText: FetchText,
  handles: ReadonlyArray<string | XAccount>,
  storePath: string = DEFAULT_POSTS_PATH,
  now: () => number = Date.now,
  opts: PollAccountsOptions = {},
): Promise<AccountPollResult[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gapMs = opts.gapMs ?? 3000;
  const seen = new Set((await readLines(storePath)).map((p) => postKey(p.handle, p.textSha1)));
  await mkdir(dirname(storePath), { recursive: true });

  const results: AccountPollResult[] = [];
  let i = 0;
  for (const entry of handles) {
    const handle = cleanHandle(typeof entry === 'string' ? entry : entry.handle);
    if (!handle) continue;
    if (i++ > 0 && gapMs > 0) await sleep(gapMs);
    try {
      const md = await fetchText(jinaProfileUrl(handle));
      const posts = parseProfileMarkdown(md, handle);
      const fresh: XPostLine[] = [];
      for (const p of posts) {
        const sha = textSha1(p.text);
        const key = postKey(handle, sha);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push({ ...p, textSha1: sha, firstSeenAt: now() });
      }
      if (fresh.length) await appendFile(storePath, fresh.map((f) => JSON.stringify(f)).join('\n') + '\n');
      results.push({ handle, parsed: posts.length, added: fresh.length });
    } catch (error) {
      results.push({ handle, parsed: 0, added: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

/** Reads .radar/x_accounts.json ([{handle, note}]). Missing file -> []. Bare strings are accepted too. */
export async function loadHandles(path: string = DEFAULT_HANDLES_PATH): Promise<XAccount[]> {
  let body: string;
  try {
    body = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const data: unknown = JSON.parse(body);
  if (!Array.isArray(data)) throw new Error(`${path}: expected a JSON array of {handle, note}`);
  const out: XAccount[] = [];
  const dup = new Set<string>();
  for (const d of data) {
    const raw = typeof d === 'string' ? d : d && typeof d === 'object' && typeof (d as XAccount).handle === 'string' ? (d as XAccount).handle : '';
    const handle = cleanHandle(raw);
    if (!handle || dup.has(handle.toLowerCase())) continue;
    dup.add(handle.toLowerCase());
    const note = typeof d === 'object' && d && typeof (d as XAccount).note === 'string' ? (d as XAccount).note : undefined;
    out.push(note ? { handle, note } : { handle });
  }
  return out;
}

export type PickHintKind = 'to-win' | 'moneyline' | 'spread' | 'over-under' | 'odds-pct' | 'american-odds' | 'team';

export interface PickHint {
  kind: PickHintKind;
  /** The matched fragment. */
  match: string;
  /** Team name from `teams` when the hint names one. */
  team?: string;
  /** Percent (0-100) for odds-pct, the signed number for american-odds/spread, the line for over-under. */
  value?: number;
}

/**
 * Cheap regex hints that a post might contain a pick. Hints only: they are never verified picks, carry no
 * direction certainty, and must be confirmed by a human or a stricter parser before anything is scored.
 */
export function extractPickHints(text: string, teams: readonly string[] = []): PickHint[] {
  const hints: PickHint[] = [];
  const lower = text.toLowerCase();
  const teamAt = (frag: string): string | undefined => {
    const f = frag.toLowerCase();
    return teams.find((t) => t && f.includes(t.toLowerCase()));
  };

  for (const m of text.matchAll(/([A-Z0-9][\w.&' -]{0,40}?)\s+(?:to win|ML\b|moneyline\b)/gi)) {
    const kind: PickHintKind = /to win/i.test(m[0]) ? 'to-win' : 'moneyline';
    hints.push({ kind, match: m[0].trim(), team: teamAt(m[1]) });
  }
  if (!hints.some((h) => h.kind === 'moneyline') && /\bmoney ?line\b/i.test(text)) hints.push({ kind: 'moneyline', match: 'moneyline' });

  for (const m of text.matchAll(/(?:^|[\s(])([A-Za-z][\w.&' ]{0,30}?)\s+([+-]\d{1,2}(?:\.5)?)(?![\d%])/g)) {
    const team = teamAt(m[1]);
    if (team) hints.push({ kind: 'spread', match: `${m[1].trim()} ${m[2]}`, team, value: Number(m[2]) });
  }
  for (const m of text.matchAll(/\b(over|under|o|u)\s?(\d{1,3}(?:\.5)?)\b/gi)) {
    if (m[1].length === 1 && !/^[ou]\d/i.test(m[0])) continue;
    hints.push({ kind: 'over-under', match: m[0], value: Number(m[2]) });
  }
  for (const m of text.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)) {
    const v = Number(m[1]);
    if (v <= 100) hints.push({ kind: 'odds-pct', match: m[0], value: v });
  }
  for (const m of text.matchAll(/(?:^|[\s(])([+-]\d{3,4})\b/g)) {
    const v = Number(m[1]);
    if (Math.abs(v) >= 100) hints.push({ kind: 'american-odds', match: m[1], value: v });
  }
  for (const t of teams) {
    if (t && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRe(t.toLowerCase())}(?:$|[^\\p{L}\\p{N}])`, 'u').test(lower)) {
      hints.push({ kind: 'team', match: t, team: t });
    }
  }
  return hints;
}
