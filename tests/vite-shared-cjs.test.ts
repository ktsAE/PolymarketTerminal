import { describe, it, expect } from 'vitest';
import { createServer } from 'vite';

// Regression: the dev server serves shared/*.cjs untransformed, so named ESM imports failed in
// the browser and the whole app rendered as a black window.
describe('vite dev server', () => {
  it('exposes shared CommonJS modules as ES modules with named exports', async () => {
    const server = await createServer({ configFile: 'vite.config.ts', server: { middlewareMode: true }, appType: 'custom', logLevel: 'silent' });
    try {
      const result = await server.transformRequest('/shared/decimal.cjs');
      expect(result?.code).toMatch(/export \{[^}]*\bparseShares\b/);
      const mod = await server.ssrLoadModule('/shared/decimal.cjs');
      expect(mod.parseShares('1.5')).toBe(1500000n);
      expect(mod.formatShares(1500000n)).toBe('1.5');
    } finally {
      await server.close();
    }
  });
});
