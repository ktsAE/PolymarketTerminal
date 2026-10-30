'use strict';
const { parseUnits, parseShares } = require('../shared/decimal.cjs');
// Read-only route/filter contracts verified against local @polymarket/client 0.14
// dist/chunk-IRLMIGOU.js: listMarkets clobTokenIds, listEvents seriesIds,
// camelCase -> snake_case query mapper, fetchOrderBook GET /book tokenId.
const GAMMA = 'https://gamma-api.polymarket.com';
function array(v) {
  try {
    const a = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}
function normalizeEvents(events, league) {
  const items = [];
  for (const e of events) {
    for (const m of Array.isArray(e.markets) ? e.markets : []) {
      const ids = array(m.clobTokenIds),
        outcomes = array(m.outcomes);
      let tick, min;
      try {
        tick = String(m.orderPriceMinTickSize);
        min = String(m.orderMinSize);
        if (parseUnits(tick) <= 0 || parseShares(min) <= 0n) continue;
      } catch {
        continue;
      }
      for (let i = 0; i < ids.length; i++) {
        if (!/^\d+$/.test(ids[i]) || !outcomes[i]) continue;
        items.push({
          assetId: ids[i],
          conditionId: String(m.conditionId || ''),
          eventId: String(e.id || ''),
          eventSlug: String(e.slug || ''),
          eventTitle: String(e.title || m.question || ''),
          marketTitle: String(m.question || e.title || ''),
          outcome: outcomes[i],
          tickSize: tick,
          minOrderSize: min,
          volume24hr: Number(m.volume24hr || e.volume24hr || 0),
          category: league ? 'Sports' : 'Other',
          tags: (e.tags || []).map((t) => String(t.label || '')),
          leagueId: league?.seriesId,
          leagueSlug: league?.slug,
          leagueName: league?.name,
          leagueImage: league?.image,
          startTime: m.gameStartTime || e.gameStartTime || undefined,
          sportsMarketType: m.sportsMarketType,
          acceptingOrders: m.acceptingOrders === true,
          closed: m.closed !== false,
        });
      }
    }
  }
  return items;
}
function createDiscovery({ fetchJson, cache = () => {}, now = Date.now } = {}) {
  const cursors = new Map();
  let counter = 0;
  return {
    async page({ seriesId, cursor = null }) {
      if (typeof seriesId !== 'string' || !/^\d+$/.test(seriesId)) throw Error('Invalid series ID');
      let offset = 0;
      if (cursor !== null) {
        const state = cursors.get(cursor);
        if (!state || state.seriesId !== seriesId) throw Error('Invalid cursor');
        offset = state.offset;
      }
      const events = await fetchJson(
        `${GAMMA}/events?active=true&closed=false&series_id=${seriesId}&limit=100&offset=${offset}`,
      );
      if (!Array.isArray(events)) return { items: [], nextCursor: null, completeness: 'UNKNOWN', eventCount: 0 };
      const items = normalizeEvents(events, { seriesId });
      cache(items);
      let nextCursor = null;
      if (events.length === 100) {
        nextCursor = Buffer.from(`${seriesId}:${offset + 100}:${++counter}`).toString('base64url');
        cursors.set(nextCursor, { seriesId, offset: offset + 100 });
      }
      return {
        items: items.filter((m) => m.acceptingOrders && !m.closed),
        nextCursor,
        completeness: nextCursor ? 'MORE' : 'EXHAUSTED',
        eventCount: events.length,
      };
    },
    async resolve({ assetIds }) {
      if (
        !Array.isArray(assetIds) ||
        assetIds.length > 100 ||
        assetIds.some((id) => typeof id !== 'string' || !/^\d{1,100}$/.test(id))
      )
        throw Error('Invalid asset IDs');
      let items = [];
      try {
        const url = new URL(`${GAMMA}/markets`);
        for (const id of assetIds) url.searchParams.append('clob_token_ids', id);
        const markets = await fetchJson(url.toString());
        if (Array.isArray(markets)) items = normalizeEvents([{ markets }]);
        cache(items);
      } catch {
        /* Unverified identity is never guessed. */
      }
      return assetIds.map((assetId) => {
        const instrument = items.find((i) => i.assetId === assetId);
        return instrument
          ? {
              assetId,
              status: instrument.acceptingOrders && !instrument.closed ? 'RESOLVED' : 'UNAVAILABLE',
              instrument: { ...instrument, metadataAt: now() },
            }
          : { assetId, status: 'UNRESOLVED' };
      });
    },
  };
}
exports.createDiscovery = createDiscovery;
exports.normalizeEvents = normalizeEvents;
