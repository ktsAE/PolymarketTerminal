import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// shared/*.cjs is consumed by the Electron main process via require(). The dev server serves
// files untransformed, so named ESM imports from CommonJS fail in the browser and React never
// mounts. Re-export the CommonJS `exports.X = ...` names as real ES exports.
function sharedCjsAsEsm(): Plugin {
  return {
    name: 'shared-cjs-as-esm',
    apply: 'serve',
    enforce: 'pre',
    transform(code, id) {
      const file = id.split('?')[0].replace(/\\/g, '/');
      if (!/\/shared\/[^/]+\.cjs$/.test(file)) return null;
      const names = [...new Set([...code.matchAll(/^exports\.(\w+)\s*=/gm)].map((match) => match[1]))];
      const aliases = names.map((name) => `const __cjs_${name} = exports.${name};`).join('\n');
      const reexports = names.map((name) => `__cjs_${name} as ${name}`).join(', ');
      return {
        code: `const exports = {};\nconst module = { exports };\n${code}\n${aliases}\nexport { ${reexports} };\n`,
        map: null,
      };
    },
  };
}

export default defineConfig({
  plugins: [sharedCjsAsEsm(), react()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
  },
});
