# Render-load benchmark

Measures main-thread CPU, script time, DOM mutations and JS heap while the real `marketStore`
receives synthetic order-book traffic (100 events/s). Dev-only: `src/main.tsx` exposes
`window.__marketStore` when `import.meta.env.DEV`.

1. `npx vite --host 127.0.0.1` and open http://127.0.0.1:5173 (wait until books are visible).
2. Sample `Performance.getMetrics` (CDP) before/after 10 s of this load in the page:

```js
const s = window.__marketStore, ids = [...s.getSnapshot().keys()]; let n = 0;
setInterval(() => { n++; const id = ids[n % ids.length]; const p = (0.30 + Math.random() * 0.4).toFixed(2);
  s.ingest({ event_type: 'price_change', timestamp: String(Date.now()),
    price_changes: [{ asset_id: id, price: p, size: String(1 + Math.floor(Math.random() * 500)), side: n % 2 ? 'BUY' : 'SELL' }] });
  if (n % 5 === 0) s.ingest({ event_type: 'last_trade_price', asset_id: id, price: p, size: String(1 + n % 50), side: 'BUY', timestamp: String(Date.now()) });
}, 10);
```

Reference result (dev build, 2 books): before optimisation 54.6 % main-thread CPU, 3410 DOM mutations,
33.7 MB heap; after memoized panels + cached Intl formatters + 10 Hz publish + lazy tape: 6.9 % CPU,
227 mutations, 9.3 MB heap. A production build (`npm start`) is lighter still (no dev-mode JSX overhead).
