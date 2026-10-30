import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: 'unit', environment: 'node', include: ['tests/**/*.test.ts'], setupFiles: ['tests/setup.ts'] },
      },
      {
        extends: true,
        test: { name: 'ui', environment: 'jsdom', include: ['tests/**/*.test.tsx'], setupFiles: ['tests/setup.ts'], environmentOptions: { jsdom: { url: 'http://qa.local/' } } },
      },
    ],
  },
});
