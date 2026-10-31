import type { EvidenceTier } from './evidence.ts';

/**
 * News inbox: free feeds -> keyword classification -> a human-reviewed queue.
 * Items never become case events automatically. A feed item is a lead; the case registry
 * (evidence.ts) is where a lead earns a tier by citing sources that justify it.
 */

export type FeedKind = 'authority' | 'journalism' | 'community';
export type FeedFormat = 'rss' | 'wp-json';

export interface FeedConfig {
  id: string;
  name: string;
  url: string;
  format: FeedFormat;
  kind: FeedKind;
}

/** All verified reachable with a descriptive User-Agent on 2026-10-31. Reddit's search endpoints and several news sites return 403. */
export const FEEDS: FeedConfig[] = [
  { id: 'esic', name: 'ESIC', url: 'https://esic.gg/wp-json/wp/v2/posts?per_page=30', format: 'wp-json', kind: 'authority' },
  { id: 'hltv', name: 'HLTV news', url: 'https://www.hltv.org/rss/news', format: 'rss', kind: 'journalism' },
  { id: 'dust2us', name: 'Dust2.us', url: 'https://www.dust2.us/rss', format: 'rss', kind: 'journalism' },
  { id: 'dexerto', name: 'Dexerto', url: 'https://www.dexerto.com/feed', format: 'rss', kind: 'journalism' },
  { id: 'esportsinsider', name: 'Esports Insider', url: 'https://esportsinsider.com/feed', format: 'rss', kind: 'journalism' },
  { id: 'reddit-go', name: 'r/GlobalOffensive', url: 'https://www.reddit.com/r/GlobalOffensive/.rss', format: 'rss', kind: 'community' },
  { id: 'reddit-dota', name: 'r/DotA2', url: 'https://www.reddit.com/r/DotA2/.rss', format: 'rss', kind: 'community' },
];

export interface NewsItem {
  feedId: string;
  url: string;
  title: string;
  summary: string;
  publishedAt: number | null; // epoch ms
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

const stripTags = (s: string): string => s.replace(/<[^>]+>/g, ' ');
const clean = (s: string): string =>
  // strip real tags, decode entities, then strip again: feeds often ship HTML as escaped text
  stripTags(decodeEntities(stripTags(s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'))))
    .replace(/\s+/g, ' ')
    .trim();

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1] : '';
}

const time = (s: string): number | null => {
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? t : null;
};

/** Minimal RSS 2.0 / Atom reader (no dependency); good enough for headline feeds. */
export function parseFeed(xml: string, feedId: string): NewsItem[] {
  const out: NewsItem[] = [];
  const atom = /<feed[\s>]/i.test(xml);
  const blocks = xml.match(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  for (const b of blocks) {
    const url = atom ? (/<link[^>]*href="([^"]+)"/i.exec(b)?.[1] ?? '') : clean(tag(b, 'link')) || clean(tag(b, 'guid'));
    const title = clean(tag(b, 'title'));
    if (!url || !title) continue;
    out.push({
      feedId,
      url: decodeEntities(url),
      title,
      summary: clean(atom ? tag(b, 'summary') || tag(b, 'content') : tag(b, 'description')).slice(0, 600),
      publishedAt: time(atom ? clean(tag(b, 'published')) || clean(tag(b, 'updated')) : clean(tag(b, 'pubDate'))),
    });
  }
  return out;
}

export function parseWpJson(json: unknown, feedId: string): NewsItem[] {
  if (!Array.isArray(json)) return [];
  const out: NewsItem[] = [];
  for (const p of json as Array<Record<string, any>>) {
    const url = typeof p.link === 'string' ? p.link : '';
    const title = clean(String(p.title?.rendered ?? ''));
    if (!url || !title) continue;
    out.push({ feedId, url, title, summary: clean(String(p.excerpt?.rendered ?? '')).slice(0, 600), publishedAt: time(String(p.date_gmt ? `${p.date_gmt}Z` : p.date ?? '')) });
  }
  return out;
}

export type Category = 'fixing' | 'sanction' | 'investigation' | 'cheating' | 'betting' | 'other';

export interface Classification {
  relevant: boolean;
  category: Category;
  matched: string[];
  /** A suggestion for a human, never applied automatically. */
  tierHint: EvidenceTier | null;
  note: string;
}

const RULES: Array<{ code: string; re: RegExp; core: boolean }> = [
  { code: '322', re: /(?<![\d$€£.,])322(?![\d%.,]|\s?(?:viewers?|k\b|m\b|players?|points?|kills?|damage|usd|ms\b|fps))/i, core: true },
  { code: 'match_fixing', re: /match[\s-]?fixing|fixed match(?:es)?|match manipulation|spot[\s-]?fixing|manipulat(?:ed|ing) (?:the )?(?:outcome|match|markets?)|throw(?:ing)? (?:a |the )?(?:match|game|map|series)/i, core: true },
  { code: 'betting_corruption', re: /betting[\s-]related corruption|suspicious bet|unusual bet|betting (?:irregularit|anomal|pattern|spike)|\bSBAN\b|corrupt approach/i, core: true },
  { code: 'integrity_body', re: /\bESIC\b|integrity commission|anti-corruption code/i, core: false },
  { code: 'sanction', re: /\b(?:banned|bans?\b|lifetime ban|sanction(?:ed|s)?|suspend(?:ed|s)|suspension|disqualif(?:ied|ication|ies|y)|forfeit(?:ed|s)?)/i, core: false },
  { code: 'investigation', re: /investigat(?:e|es|ed|ion|ing)/i, core: false },
  { code: 'cheating', re: /radar ?hack|wall ?hack|\bcheat(?:s|ing|ers?)?\b|spectator bug/i, core: false },
];

export function classify(item: Pick<NewsItem, 'title' | 'summary'>, kind: FeedKind): Classification {
  const text = `${item.title}. ${item.summary}`;
  const matched = RULES.filter((r) => r.re.test(text)).map((r) => r.code);
  const has = (c: string) => matched.includes(c);
  const core = RULES.some((r) => r.core && has(r.code));
  const integrity = has('integrity_body') && (has('sanction') || has('investigation'));
  // on an authority feed the source supplies the "integrity body" context itself
  const authorityNews = kind === 'authority' && (has('sanction') || has('investigation'));
  const relevant = core || integrity || authorityNews || (has('cheating') && has('sanction'));
  const category: Category = !relevant
    ? 'other'
    : has('sanction') && (core || has('integrity_body') || authorityNews)
      ? 'sanction'
      : has('investigation')
        ? 'investigation'
        : has('cheating') && !core
          ? 'cheating'
          : core && has('betting_corruption')
            ? 'betting'
            : 'fixing';

  let tierHint: EvidenceTier | null = null;
  let note = '';
  if (relevant) {
    const interim = /\binterim\b|\bprovisional/i.test(text);
    const appeal = /\bappeal\b|\baward\b|\bv\.\s+esports integrity/i.test(text);
    if (kind === 'authority' && appeal) {
      note = 'authoritative appeal/arbitration ruling: read it to see whether it upholds, reduces or clears';
    } else if (kind === 'authority' && (interim || category === 'investigation')) {
      tierHint = 'INVESTIGATING';
      note = 'authoritative source: interim measure or investigation, no final finding yet';
    } else if (kind === 'authority' && category === 'sanction') {
      tierHint = 'SANCTIONED';
      note = 'authoritative source: read the full ruling and confirm findings are published before recording SANCTIONED';
    } else if (kind === 'community') {
      tierHint = 'RUMOR';
      note = 'community post: a lead, not evidence';
    } else {
      note = 'journalism: find the primary source (ESIC, organizer, court) before assigning a tier';
    }
  }
  return { relevant, category, matched, tierHint, note };
}
