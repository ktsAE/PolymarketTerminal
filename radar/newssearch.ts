import { decodeEntities, parseFeed, type NewsItem } from './news.ts';
import type { FetchText } from './poll.ts';

/**
 * Headline search for the market under the cursor. Keyless sources only (Google News RSS and Bing News RSS), so it works with no account.
 * Headlines are leads for you to read: nothing here decides a market, and a result's absence is not evidence that nothing happened.
 */

export interface NewsHit {
  title: string;
  source: string;
  url: string;
  publishedAt: number | null; // epoch ms
  via: 'google' | 'bing';
}

export interface NewsResult {
  query: string;
  hits: NewsHit[];
  /** One entry per source that failed ("google: HTTP 503"); the other source still answers. */
  errors: string[];
}

const LEAD = /^(will|who|what|which|when|how|is|are|does|do|can)\s+/i;

/** A search query from a market title: placeholders, dates and question words removed ("Will 1win launch a token by ___?" -> "1win launch a token"). */
export function buildNewsQuery(title: string): string {
  let q = title.replace(/\([^)]*\)/g, ' ').replace(/\bBO\d\b/gi, ' ');
  q = q.replace(/_{2,}|\.{2,}|…/g, ' ').replace(/\?/g, ' ');
  q = q.replace(/\b(by|before|until|in|on)\s*$/i, ' ');
  q = q.replace(/\s+(by|before|until)\s+(january|february|march|april|may|june|july|august|september|october|november|december)[^,]*(,?\s*\d{4})?/gi, ' ');
  q = q.replace(/\s+(by|before|until)\s+\d{4}\s*$/gi, ' ');
  q = q.replace(/\s+-\s+(group stage|playoffs|regular season|swiss stage|qualifier)[^-]*$/i, ' ');
  q = q.replace(/\s+/g, ' ').trim().replace(LEAD, '');
  return q.replace(/\s+(by|before|until)$/i, '').trim();
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 70);

/** Google News appends " - Publisher" to every title. */
function splitGoogleTitle(title: string): { title: string; source: string } {
  const i = title.lastIndexOf(' - ');
  if (i > 12 && title.length - i - 3 <= 40) return { title: title.slice(0, i).trim(), source: title.slice(i + 3).trim() };
  return { title, source: '' };
}

/** Bing wraps the real address in a redirect (`...apiclick.aspx?...&url=<real>&...`). */
function bingTarget(link: string): string {
  const m = /[?&]url=([^&]+)/i.exec(link);
  if (!m) return link;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return link;
  }
}
const host = (u: string): string => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export const googleUrl = (q: string, days: number): string => `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:${days}d`)}&hl=en-US&gl=US&ceid=US:en`;
export const bingUrl = (q: string): string => `https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`;

export function parseGoogle(xml: string): NewsHit[] {
  return parseFeed(xml, 'google').map((i: NewsItem) => {
    const t = splitGoogleTitle(i.title);
    return { title: decodeEntities(t.title), source: t.source, url: i.url, publishedAt: i.publishedAt, via: 'google' as const };
  });
}
export function parseBing(xml: string): NewsHit[] {
  return parseFeed(xml, 'bing').map((i: NewsItem) => {
    const url = bingTarget(i.url);
    return { title: i.title, source: host(url), url, publishedAt: i.publishedAt, via: 'bing' as const };
  });
}

export interface SearchOptions {
  now?: () => number;
  /** Drop dated headlines older than this many days (undated ones are kept). */
  windowDays?: number;
  limit?: number;
}

export async function searchNews(fetchText: FetchText, query: string, opts: SearchOptions = {}): Promise<NewsResult> {
  const now = opts.now ?? Date.now;
  const days = opts.windowDays ?? 7;
  const errors: string[] = [];
  const grab = async (name: string, url: string, parse: (x: string) => NewsHit[]): Promise<NewsHit[]> => {
    try {
      return parse(await fetchText(url));
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };
  const [g, b] = await Promise.all([grab('google', googleUrl(query, days), parseGoogle), grab('bing', bingUrl(query), parseBing)]);
  const cutoff = now() - days * 86_400_000;
  const seen = new Set<string>();
  const hits: NewsHit[] = [];
  for (const h of [...g, ...b]) {
    if (h.publishedAt !== null && h.publishedAt < cutoff) continue;
    const key = norm(h.title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    hits.push(h);
  }
  hits.sort((a, b2) => (b2.publishedAt ?? 0) - (a.publishedAt ?? 0));
  return { query, hits: hits.slice(0, opts.limit ?? 30), errors };
}
