import { classify, FEEDS, parseFeed, parseWpJson, type FeedConfig, type NewsItem } from './news.ts';
import type { RadarStore } from './store.ts';

const MAX_FEED_BYTES = 2_000_000;
export type FetchText = (url: string) => Promise<string>;

export const httpFetchText: FetchText = async (url) => {
  const res = await fetch(url, { headers: { 'user-agent': 'polymarket-radar/0.1' }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  if (Number(res.headers?.get?.('content-length')) > MAX_FEED_BYTES) throw new Error('response too large');
  return (await res.text()).slice(0, MAX_FEED_BYTES);
};

export interface PollResult {
  feed: string;
  fetched: number;
  added: number;
  relevantNew: number;
  error?: string;
}

export interface PollOptions {
  feeds?: readonly FeedConfig[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Pause before each request (community hosts like Reddit rate-limit hard, so they get a longer one). */
  gapMs?: number;
  communityGapMs?: number;
}

export function parseFeedBody(feed: FeedConfig, body: string): NewsItem[] {
  return feed.format === 'wp-json' ? parseWpJson(JSON.parse(body), feed.id) : parseFeed(body, feed.id);
}

/** Fetches each feed once. A failing feed is reported in the result, never silently dropped, and does not stop the others. */
export async function pollFeeds(fetchText: FetchText, store: RadarStore, opts: PollOptions = {}): Promise<PollResult[]> {
  const feeds = opts.feeds ?? FEEDS;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const gapMs = opts.gapMs ?? 1500;
  const communityGapMs = opts.communityGapMs ?? 6000;
  const results: PollResult[] = [];
  for (const [i, feed] of feeds.entries()) {
    const gap = feed.kind === 'community' ? communityGapMs : gapMs;
    if (i > 0 && gap > 0) await sleep(gap);
    const r: PollResult = { feed: feed.name, fetched: 0, added: 0, relevantNew: 0 };
    try {
      const items = parseFeedBody(feed, await fetchText(feed.url));
      r.fetched = items.length;
      for (const item of items) {
        const c = classify(item, feed.kind);
        if (store.addNews(item, c, now())) {
          r.added++;
          if (c.relevant) r.relevantNew++;
        }
      }
    } catch (error) {
      r.error = error instanceof Error ? error.message : String(error);
    }
    results.push(r);
  }
  return results;
}
