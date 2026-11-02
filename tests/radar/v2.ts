/**
 * Test helpers that speak Data API v2 (v1 was retired on 2026-11-02). Fixtures stay in the camelCase shape the radar reads;
 * these wrap them the way the real API answers: `{ data, pagination }` with snake_case keys and an opaque `next_cursor`.
 */
const snakeKey = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function snake(x: unknown): any {
  if (Array.isArray(x)) return x.map(snake);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x as Record<string, unknown>).map(([k, v]) => [snakeKey(k), snake(v)]));
  return x;
}

/** A v2 response. `next` is the cursor of the following page, or null on the last one. */
export function v2(data: unknown, next: string | null = null): { data: unknown; pagination: { limit: number; offset: number; has_more: boolean; next_cursor: string | null } } {
  return { data: snake(data), pagination: { limit: 0, offset: 0, has_more: next !== null, next_cursor: next } };
}

/**
 * Serves `rows` (already newest first) as v2 cursor pages. The cursor is the index of the next row. Like the real API it rejects the v1
 * `offset` and `market` parameters with HTTP 400, so a client that still sends them fails the test.
 */
export function cursorPage(rows: readonly unknown[], params: URLSearchParams): ReturnType<typeof v2> {
  for (const bad of ['offset', 'market']) if (params.has(bad)) throw new Error(`HTTP 400: '${bad}' is not a query param on this API`);
  const limit = Number(params.get('limit') ?? 100);
  const start = params.get('cursor') ? Number(String(params.get('cursor')).slice(1)) : 0;
  const end = start + limit;
  return v2(rows.slice(start, end), end < rows.length ? `c${end}` : null);
}
