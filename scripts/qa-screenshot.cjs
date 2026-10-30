// Standalone offline Electron entrypoint. Never import electron/main.cjs or its preload.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { stripTypeScriptTypes } = require('node:module');
const { app, BrowserWindow, protocol, session } = require('electron');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'artifacts/qa/screenshots');
const profile = path.join(root, 'artifacts/qa/profile');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(profile, { recursive: true });
// Set these before ready: no normal desktop profile, credentials, sessions, or temp output.
for (const key of ['appData', 'userData', 'sessionData', 'logs', 'crashDumps', 'temp']) {
  const directory = path.join(profile, key === 'userData' || key === 'sessionData' ? '' : key);
  fs.mkdirSync(directory, { recursive: true });
  app.setPath(key, directory);
}
app.commandLine.appendSwitch('headless');
app.commandLine.appendSwitch('ozone-platform', 'headless');
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('force-device-scale-factor', '1');
protocol.registerSchemesAsPrivileged([{ scheme: 'qa', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// Transpile the shared, self-contained fixture in memory (no generated preload files).
const source = fs.readFileSync(path.join(root, 'tests/fixtures/terminal.ts'), 'utf8');
const compiled = stripTypeScriptTypes(source).replace(/^export /gm, '');
const fixtureExports = { createTerminalFixture: new Function(`${compiled}\nreturn createTerminalFixture;`)() };
const bootstrap = `(() => {
  const fixture = (${fixtureExports.createTerminalFixture.toString()})();
  window.__qa = { fixture, networkCalls: 0 };
  window.polymarketTerminal = fixture.bridge;
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('pm-terminal:workspace:SCALP 2', JSON.stringify(fixture.instruments.map(item => item.assetId)));
  const NativeDate = Date;
  window.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [fixture.now])); }
    static now() { return NativeDate.parse(fixture.now); }
  };
  Math.random = () => 0.5;
  const denied = () => { window.__qa.networkCalls++; throw new Error('Network forbidden in QA'); };
  window.fetch = denied;
  window.WebSocket = class { constructor() { denied(); } };
  window.EventSource = class { constructor() { denied(); } };
  XMLHttpRequest.prototype.open = denied;
  navigator.sendBeacon = denied;
})();`;
const report = { fixture: 'offline deterministic; no main/auth preload', profile, networkCalls: 0, accountLiveCalls: 0, orderLiveCalls: 0, screenshots: [], errors: [] };
let window;
const watchdog = setTimeout(() => {
  report.ok = false;
  report.errors.push('QA timed out after 45 seconds');
  fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stderr.write('QA timed out after 45 seconds\n');
  app.exit(1);
}, 45000);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function evaluate(source) { return window.webContents.executeJavaScript(source); }
async function waitFor(source, label) {
  for (let tries = 0; tries < 100; tries++) {
    if (await evaluate(`Boolean(${source})`)) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
async function capture(name, width, height, expectedBooks = 6) {
  window.setContentSize(width, height);
  await delay(200);
  const stats = await evaluate(`(() => ({
    width: innerWidth, height: innerHeight,
    books: document.querySelectorAll('.book-panel').length,
    domRows: document.querySelectorAll('.dom-row').length,
    dry: document.querySelector('.mode-pill')?.textContent?.includes('DRY'),
    networkCalls: window.__qa.networkCalls,
    liveCalls: window.__qa.fixture.liveCalls(),
    orders: window.__qa.fixture.orders,
    public: [...document.querySelectorAll('.status')].some(node => node.textContent.includes('PUBLIC')),
    panelBounds: [...document.querySelectorAll('.book-panel')].map(panel => {
      const { x, y, width, height, bottom, right } = panel.getBoundingClientRect();
      const rows = [...panel.querySelectorAll('.dom-row')];
      const settings = panel.querySelector('.terminal-settings-trigger');
      const trigger = settings.getBoundingClientRect();
      return { x, y, width, height, bottom, right, rows: rows.length,
        rowHeights: [...new Set(rows.map(row => row.getBoundingClientRect().height))],
        pricesDefined: rows.every(row => { const text = row.querySelector('.price-cell')?.textContent || ''; return /[0-9]/.test(text) && !/undefined|NaN/.test(text); }),
        settingsReachable: trigger.width > 0 && trigger.height > 0 && trigger.left >= x && trigger.right <= right + 1,
        fontMin: Math.min(...rows.flatMap(row => [...row.querySelectorAll('.price-cell, .terminal-cluster-cell, .terminal-executed-bubble')].map(node => parseFloat(getComputedStyle(node).fontSize)))),
        bubbles: [...panel.querySelectorAll('.terminal-executed-bubble')].map(bubble => {
          const b = bubble.getBoundingClientRect(), r = bubble.closest('.dom-row').getBoundingClientRect();
          return { width: b.width, height: b.height, withinRow: b.top >= r.top - 0.5 && b.bottom <= r.bottom + 0.5 && b.left >= r.left - 0.5 && b.right <= r.right + 0.5 };
        }),
        overflow: { scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight },
      };
    }),
  }))()`);
  const image = await window.webContents.capturePage();
  assert.deepEqual(image.getSize(), { width, height });
  const filename = `${name}-${width}x${height}.png`;
  fs.writeFileSync(path.join(output, filename), image.toPNG());
  report.screenshots.push({ filename, ...stats });
  const check = (valid, message) => { if (!valid) report.errors.push(`${filename}: ${message}`); };
  check(stats.width === width && stats.height === height, 'viewport must match requested dimensions');
  check(stats.books === expectedBooks, 'book count must match requested workspace');
  check(stats.domRows > 0, 'must render DOM rows');
  check(stats.dry, 'must remain DRY');
  check(stats.public, 'public feed must be labeled PUBLIC, not account LIVE');
  for (const [index, panel] of stats.panelBounds.entries()) {
    check(panel.rows >= 7, `panel ${index}: needs at least seven rows`);
    check(panel.pricesDefined, `panel ${index}: every row must have a defined price`);
    check(panel.settingsReachable, `panel ${index}: Settings must remain reachable`);
    check(panel.fontMin >= 9, `panel ${index}: row fonts must be at least 9px`);
    check(panel.bubbles.length > 0, `panel ${index}: deterministic prints must produce bubbles`);
    check(panel.bubbles.every(bubble => bubble.withinRow), `panel ${index}: bubbles must fit their own row`);
    const expectedRowHeight = /row(18|22|26)/.exec(name)?.[1];
    if (expectedRowHeight) check(panel.rowHeights.every(height => Math.abs(height - Number(expectedRowHeight)) < 0.5), `panel ${index}: Settings must apply row height ${expectedRowHeight}`);
  }
  check(stats.networkCalls === 0 && stats.liveCalls === 0, 'no network/account/live calls permitted');
  check(stats.orders.every(order => order.mode === 'DRY'), 'only DRY orders permitted');
}

app.whenReady().then(async () => {
  const qaSession = session.fromPartition('qa-offline'); // In-memory session, no real account state.
  qaSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  qaSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith('qa://terminal/') || details.url.startsWith('data:');
    if (!allowed) report.networkCalls++;
    callback({ cancel: !allowed });
  });
  qaSession.protocol.handle('qa', request => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const dist = path.join(root, 'dist');
    const filename = path.resolve(dist, relative);
    if (url.host !== 'terminal' || !filename.startsWith(`${dist}${path.sep}`)) return new Response('', { status: 403 });
    let content = fs.readFileSync(filename);
    const extension = path.extname(filename);
    const contentType = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extension] || 'application/octet-stream';
    if (extension === '.html') content = Buffer.from(content.toString().replace('<head>', `<head><script>${bootstrap}</script>`));
    return new Response(content, { headers: { 'content-type': contentType } });
  });
  window = new BrowserWindow({ show: false, width: 1440, height: 960, useContentSize: true,
    webPreferences: { offscreen: true, session: qaSession, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  window.webContents.on('preload-error', (_event, _path, error) => report.errors.push(String(error)));
  window.webContents.on('render-process-gone', (_event, details) => report.errors.push(JSON.stringify(details)));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadURL('qa://terminal/index.html');
  await waitFor(`document.querySelectorAll('.book-panel').length === 2`, 'initial books');
  await evaluate(`[...document.querySelectorAll('.workspace-tabs button')].find(button => button.textContent === 'SCALP 2').click()`);
  await waitFor(`document.querySelectorAll('.book-panel').length === 6 && document.querySelector('.ask-size:not([disabled])')`, 'six ready books');
  await evaluate(`document.querySelector('.ask-size:not([disabled])').click()`);
  await waitFor(`window.__qa.fixture.orders.length === 1`, 'offline BUY');
  await evaluate(`document.querySelector('.bid-size:not([disabled])').click()`);
  await waitFor(`window.__qa.fixture.orders.length === 2`, 'offline SELL');
  assert.deepEqual(await evaluate(`window.__qa.fixture.orders.map(order => order.side)`), ['BUY', 'SELL']);
  for (const [width, height] of [[980, 680], [1100, 800], [1440, 960], [1920, 1080]]) await capture('terminal', width, height);
  await evaluate(`document.querySelector('.dock-toggle')?.click()`);
  await waitFor(`Boolean(document.querySelector('.orders-table'))`, 'orders blotter');
  await capture('blotter', 1440, 960);
  if (!await evaluate(`document.querySelector('.session-orders-note')?.textContent.includes('Accepted is not a fill')`)) report.errors.push('SessionOrders must disclose Accepted is not a fill');
  await evaluate(`document.querySelector('.dock-toggle').click()`);
  // Exercise real Settings controls, not CSS overrides, for every remaining book.
  for (const count of [6, 4, 2, 1]) {
    while (await evaluate(`document.querySelectorAll('.book-panel').length`) > count) {
      await evaluate(`[...document.querySelectorAll('[aria-label="Close order book"]')].at(-1).click()`);
      await delay(50);
    }
    for (const rowHeight of [18, 22, 26]) {
      for (let index = 0; index < count; index++) {
        await evaluate(`document.querySelectorAll('.terminal-settings-trigger')[${index}].click()`);
        await waitFor(`document.querySelector('[aria-label="Row height"]')`, 'row Settings');
        await evaluate(`(() => { const control = document.querySelector('[aria-label="Row height"]'); control.value = '${rowHeight}'; control.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent === 'Close settings').click()`);
      }
      await capture('matrix-' + count + 'books-row' + rowHeight, 1100, 800, count);
    }
  }
  report.accountLiveCalls = await evaluate('window.__qa.fixture.liveCalls()');
  report.orderLiveCalls = await evaluate("window.__qa.fixture.orders.filter(order => order.mode !== 'DRY').length");
  report.networkCalls += await evaluate('window.__qa.networkCalls');
  assert.equal(report.networkCalls, 0);
  assert.equal(report.accountLiveCalls, 0);
  assert.equal(report.orderLiveCalls, 0);
  assert.deepEqual(report.errors, []);
  report.ok = true;
}).catch(error => {
  report.ok = false;
  report.errors.push(error.stack || String(error));
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(watchdog);
  fs.writeFileSync(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: report.ok, networkCalls: report.networkCalls, accountLiveCalls: report.accountLiveCalls, orderLiveCalls: report.orderLiveCalls, screenshots: report.screenshots.map(item => item.filename), errors: report.errors, report: path.join(output, 'report.json') }, null, 2)}\n`);
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(report.ok ? 0 : 1);
});
