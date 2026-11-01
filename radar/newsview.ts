import { buildNewsQuery, searchNews, type NewsHit } from './newssearch.ts';
import type { PolymarketClient } from './polymarket.ts';
import type { FetchText } from './poll.ts';

/** What the News tab shows for one event: the market's own state (deadline, oracle status, prices) next to fresh headlines. */

export interface MarketState {
  label: string;
  bid: number | null;
  ask: number | null;
  /** UMA proposal/dispute history as the API reports it, oldest first. */
  uma: string[];
  endsAt: number | null; // epoch seconds
  closed: boolean;
}

export interface NewsView {
  slug: string;
  title: string;
  query: string;
  stage: string;
  done: boolean;
  error: string | null;
  hits: NewsHit[];
  /** Failed sources, shown so a short list is not mistaken for a quiet news day. */
  sourceErrors: string[];
  markets: MarketState[];
  rules: string;
}

export interface NewsLoadOptions {
  now?: () => number;
  windowDays?: number;
  onProgress?: (v: NewsView) => void;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const list = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  try {
    const p = typeof v === 'string' ? JSON.parse(v) : [];
    return Array.isArray(p) ? p.map(String) : [];
  } catch {
    return [];
  }
};

export async function loadNews(client: PolymarketClient, fetchText: FetchText, slug: string, opts: NewsLoadOptions = {}): Promise<NewsView> {
  const view: NewsView = { slug, title: slug, query: '', stage: 'reading the market', done: false, error: null, hits: [], sourceErrors: [], markets: [], rules: '' };
  const emit = () => opts.onProgress?.({ ...view, hits: [...view.hits], markets: [...view.markets] });
  emit();
  try {
    const raw = await client.eventRaw(slug);
    if (!raw) throw new Error(`event not found: ${slug}`);
    view.title = String(raw.title ?? slug);
    view.query = buildNewsQuery(view.title) || view.title;
    view.rules = String(raw.description ?? '').replace(/\s+/g, ' ').trim();
    const markets = ((raw.markets ?? []) as Array<Record<string, any>>).filter((m) => m.conditionId);
    view.markets = markets
      .sort((a, b) => (num(b.volume24hr) ?? 0) - (num(a.volume24hr) ?? 0))
      .slice(0, 4)
      .map((m) => {
        const end = typeof m.endDate === 'string' ? Date.parse(m.endDate) : NaN;
        return { label: String(m.groupItemTitle || m.question || ''), bid: num(m.bestBid), ask: num(m.bestAsk), uma: list(m.umaResolutionStatuses), endsAt: Number.isFinite(end) ? Math.floor(end / 1000) : null, closed: Boolean(m.closed) };
      });
    view.stage = `searching news for "${view.query}"`;
    emit();
    const r = await searchNews(fetchText, view.query, { now: opts.now, windowDays: opts.windowDays });
    view.hits = r.hits;
    view.sourceErrors = r.errors;
    if (r.hits.length === 0 && r.errors.length === 2) view.error = `both news sources failed: ${r.errors.join('; ')}`;
    view.stage = 'done';
  } catch (error) {
    view.error = error instanceof Error ? error.message : String(error);
    view.stage = 'failed';
  }
  view.done = true;
  emit();
  return view;
}
