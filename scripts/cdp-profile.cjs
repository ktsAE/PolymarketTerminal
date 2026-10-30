// Attach to a running `npm run start:debug` Electron window and profile it with live data.
// Usage: node scripts/cdp-profile.cjs [seconds]
const WebSocket = require('ws');
const http = require('node:http');
const seconds = Number(process.argv[2] || 15);
const get = (url) => new Promise((res, rej) => http.get(url, (r) => { let d = ''; r.on('data', (c) => (d += c)); r.on('end', () => res(JSON.parse(d))); }).on('error', rej));
(async () => {
  const target = (await get('http://127.0.0.1:9222/json')).find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.on('open', r));
  let id = 0; const pending = new Map();
  ws.on('message', (m) => { const msg = JSON.parse(m); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); } });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  const metrics = async () => Object.fromEntries((await send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
  await send('Performance.enable'); await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 500 });
  const ev = async (e) => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result?.value;
  console.log('state:', await ev(`JSON.stringify({books:document.querySelectorAll('.book-panel').length,nodes:document.getElementsByTagName('*').length,status:document.querySelector('.status')?.textContent})`));
  const a = await metrics(); await send('Profiler.start'); const t0 = Date.now();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  const { profile } = await send('Profiler.stop'); const b = await metrics(); const dt = (Date.now() - t0) / 1000;
  const nodes = new Map(profile.nodes.map((n) => [n.id, n])); const self = new Map(); let total = 0;
  profile.samples.forEach((s, i) => { const cf = nodes.get(s).callFrame; const k = `${cf.functionName || '(anon)'} ${cf.url.split('/').pop().split('?')[0]}:${cf.lineNumber}`; self.set(k, (self.get(k) || 0) + profile.timeDeltas[i]); total += profile.timeDeltas[i]; });
  console.log(`main-thread CPU ${(100 * (b.TaskDuration - a.TaskDuration) / dt).toFixed(1)}%  script ${(b.ScriptDuration - a.ScriptDuration).toFixed(2)}s  layouts ${b.LayoutCount - a.LayoutCount}  style recalcs ${b.RecalcStyleCount - a.RecalcStyleCount}  heap ${(b.JSHeapUsedSize / 1e6).toFixed(1)}MB  nodes ${b.Nodes}`);
  [...self].sort((x, y) => y[1] - x[1]).slice(0, 14).forEach(([k, v]) => console.log(`${(100 * v / total).toFixed(1).padStart(5)}%  ${k}`));
  console.log('screenshot:', (await send('Page.captureScreenshot', { format: 'png' })).data.length, 'bytes');
  require('node:fs').writeFileSync(process.env.TMPDIR + '/electron-shot.png', Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  ws.close();
})();
