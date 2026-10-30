'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const path = require('node:path');

function setup(fetcher = async () => { throw Error('Unexpected network'); }) {
  const file = path.resolve('electron/main.cjs');
  const realRequire = createRequire(file);
  const handlers = new Map(), sent = [];
  let registry, socket;
  class Socket extends EventEmitter {
    static OPEN = 1; static CONNECTING = 0;
    constructor() { super(); this.readyState = Socket.CONNECTING; socket = this; }
    send() {} close() {}
  }
  const webContents = { mainFrame: {}, send: (channel, payload) => sent.push({ channel, payload }) };
  const window = { webContents, isDestroyed: () => false };
  const fakeRequire = name => {
    if (name === 'electron') return { app: { whenReady: () => new Promise(() => {}), on() {} }, BrowserWindow: {}, ipcMain: { handle: (key, fn) => handlers.set(key, fn) } };
    if (name === 'ws') return { WebSocket: Socket };
    if (name === './safety.cjs') { const safety = realRequire(name); return { ...safety, createRegistry: options => (registry = safety.createRegistry(options)) }; }
    return realRequire(name);
  };
  const context = vm.createContext({ require: fakeRequire, process, console, fetch: fetcher, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  context.testWindow = window;
  vm.runInContext('mainWindow = testWindow', context);
  const call = (name, arg) => handlers.get(name)({ sender: webContents, senderFrame: webContents.mainFrame }, arg);
  registry.cache([{ assetId: '1', tickSize: '0.01', minOrderSize: '1' }, { assetId: '2', tickSize: '0.01', minOrderSize: '1' }]);
  call('books:subscribe', ['1']);
  return { registry, sent, call, socket: () => socket };
}
const book = (id = '1', timestamp = Date.now() - 100) => ({ event_type: 'book', asset_id: id, timestamp, bids: [], asks: [] });
const events = env => env.sent.filter(x => x.channel === 'market:event').map(x => x.payload);

test('socket forwards only accepted canonical books and filtered price changes', () => {
  const env = setup();
  const emit = value => env.socket().emit('message', Buffer.from(JSON.stringify(value)));
  emit(book('2'));
  assert.equal(events(env).length, 0);
  emit(book());
  assert.equal(events(env)[0].generation, env.registry.health('1').generation);
  assert.equal(events(env)[0].tick_size, '0.01');
  emit({ event_type: 'price_change', timestamp: Date.now(), price_changes: [
    { asset_id: '1', price: '0.5', size: '1', side: 'BUY' },
    { asset_id: '2', price: '0.5', size: '1', side: 'BUY' },
  ] });
  assert.equal(events(env)[1].price_changes.length, 1);
  assert.equal(events(env)[1].price_changes[0].tickVersion, env.registry.health('1').tickVersion);
});

test('unidentified malformed delta member invalidates all active books', () => {
  const env = setup();
  const emit = value => env.socket().emit('message', Buffer.from(JSON.stringify(value)));
  emit(book());
  const before = env.registry.health('1').generation;
  emit({ event_type: 'price_change', timestamp: Date.now(), price_changes: [
    { asset_id: '1', price: '0.5', size: '1', side: 'BUY' }, null,
  ] });
  assert.equal(events(env).length, 1);
  assert.equal(env.registry.health('1').initialized, false);
  assert.ok(env.registry.health('1').generation > before);
});

test('malformed identified member does not suppress an independent following book', () => {
  const env = setup(); env.call('books:subscribe', ['2']);
  env.socket().emit('message', Buffer.from(JSON.stringify([{asset_id: '1'}, book('2')])));
  assert.equal(events(env).length, 1);
  assert.equal(env.registry.health('1').initialized, false);
  assert.equal(env.registry.health('2').initialized, true);
});

test('unorderable and malformed deltas invalidate affected books', () => {
  for (const payload of [
    { event_type: 'price_change', asset_id: '1', price_changes: 'bad' },
    { event_type: 'price_change', price_changes: [{ asset_id: '1', price: '0.5', size: '1', side: 'BUY' }] },
    { event_type: 'price_change', timestamp: 1, price_changes: [{ asset_id: '1', price: '0.5', size: '1', side: 'BUY' }] },
  ]) {
    const env = setup();
    const emit = value => env.socket().emit('message', Buffer.from(JSON.stringify(value)));
    emit(book()); const before = env.registry.health('1').generation;
    emit(payload);
    assert.equal(env.registry.health('1').initialized, false);
    assert.ok(env.registry.health('1').generation > before);
  }
});

test('refresh after fence rejects missing and pre-fence timestamps', async () => {
  for (const timestamp of [undefined, 1]) {
    const env = setup(async () => ({ ok: true, json: async () => ({ ...book(), timestamp }) }));
    env.registry.invalidate(['1']);
    await assert.rejects(env.call('books:refresh', { assetId: '1' }), /snapshot/i);
    assert.equal(env.registry.health('1').initialized, false);
    assert.equal(events(env).length, 0);
  }
});

test('refresh rejects rejected snapshots without forwarding', async () => {
  const env = setup(async () => ({ ok: true, json: async () => ({ ...book(), bids: 'bad' }) }));
  await assert.rejects(env.call('books:refresh', { assetId: '1' }), /snapshot/i);
  assert.equal(events(env).length, 0);
});

test('refresh forwards accepted tagged snapshot and rejects superseded fetch', async () => {
  let resolve;
  const env = setup(() => new Promise(r => { resolve = r; }));
  const pending = env.call('books:refresh', { assetId: '1' });
  env.registry.invalidate(['1']);
  resolve({ ok: true, json: async () => book() });
  await assert.rejects(pending, /superseded/i);
  assert.equal(events(env).length, 0);
});

test('refresh rejects a snapshot superseded by an accepted same-timestamp price update', async () => {
  let resolve;
  const env = setup(() => new Promise(r => { resolve = r; }));
  const timestamp = Date.now() - 100;
  const emit = value => env.socket().emit('message', Buffer.from(JSON.stringify(value)));
  emit(book('1', timestamp));
  const pending = env.call('books:refresh', { assetId: '1' });
  emit({ event_type: 'price_change', timestamp, price_changes: [
    { asset_id: '1', price: '0.5', size: '1', side: 'BUY' },
  ] });
  assert.equal(events(env).length, 2);
  resolve({ ok: true, json: async () => ({ ...book(), timestamp }) });
  await assert.rejects(pending, /superseded/i);
  assert.equal(events(env).length, 2);
});

test('refresh forwards registry canonical snapshot', async () => {
  const env = setup(async () => ({ ok: true, json: async () => book() }));
  await env.call('books:refresh', { assetId: '1' });
  assert.equal(events(env).length, 1);
  assert.equal(events(env)[0].generation, env.registry.health('1').generation);
  assert.equal(events(env)[0].tickVersion, env.registry.health('1').tickVersion);
  assert.equal(events(env)[0].tick_size, '0.01');
});

test('invalid identified delta only fences that asset and suppresses its whole batch', () => {
  const env = setup(); env.call('books:subscribe', ['2']);
  const emit = value => env.socket().emit('message', Buffer.from(JSON.stringify(value)));
  emit([book('1'), book('2')]);
  const first = env.registry.health('1'), second = env.registry.health('2');
  emit({ event_type: 'price_change', timestamp: Date.now(), price_changes: [
    { asset_id: '1', price: '0.5', size: '1', side: 'BUY' },
    { asset_id: '1', price: 'bad', size: '1', side: 'BUY' },
    { asset_id: '2', price: '0.6', size: '1', side: 'SELL' },
  ] });
  assert.equal(env.registry.health('1').initialized, false);
  assert.ok(env.registry.health('1').generation > first.generation);
  assert.equal(env.registry.health('2').generation, second.generation);
  assert.equal(env.registry.health('2').initialized, true);
  assert.deepEqual(events(env).at(-1).price_changes.map(c => c.asset_id), ['2']);
});

test('timestamped post-fence snapshot restores readiness, pre-fence does not', () => {
  const { createRegistry } = require('../electron/safety.cjs');
  let time = 1000;
  const registry = createRegistry({ now: () => time });
  registry.cache([{ assetId: '1', tickSize: '0.01', minOrderSize: '1' }]);
  registry.subscribe(['1']);
  assert.ok(registry.event(book('1', 900)));
  registry.invalidate(['1']); const generation = registry.health('1').generation;
  assert.equal(registry.event(book('1', 999)), false);
  assert.equal(registry.health('1').initialized, false);
  time = 1001;
  assert.ok(registry.event(book('1', 1001)));
  assert.equal(registry.health('1').generation, generation);
  assert.equal(registry.health('1').initialized, true);
});


test('uninitialized observed delta supersedes in-flight refresh', async () => {
  let resolve;
  const env = setup(() => new Promise(r => { resolve = r; }));
  const pending = env.call('books:refresh', { assetId: '1' });
  const timestamp = Date.now() - 100;
  env.socket().emit('message', Buffer.from(JSON.stringify({ event_type: 'price_change', timestamp, price_changes: [
    { asset_id: '1', price: '0.5', size: '1', side: 'BUY' },
  ] })));
  resolve({ ok: true, json: async () => book('1', timestamp) });
  await assert.rejects(pending, /superseded/i);
  assert.equal(env.registry.health('1').initialized, false);
});

test('invalid JSON and malformed members fence books without losing later valid messages', () => {
  for (const bad of ['{bad', JSON.stringify(null), JSON.stringify([null, book('2', Date.now() + 1000)]), JSON.stringify({foo: 1})]) {
    const env = setup(); env.call('books:subscribe', ['2']);
    const emit = text => env.socket().emit('message', Buffer.from(text));
    emit(JSON.stringify([book('1'), book('2')]));
    const generations = ['1', '2'].map(id => env.registry.health(id).generation);
    emit(bad);
    for (const [i,id] of ['1','2'].entries()) {
      assert.equal(env.registry.health(id).initialized, false);
      assert.ok(env.registry.health(id).generation > generations[i]);
    }
  }
  const env = setup(); env.call('books:subscribe', ['2']);
  const emit = value => env.socket().emit('message', Buffer.from(JSON.stringify(value)));
  emit([book('1'), book('2')]);
  const before = env.registry.health('2').generation;
  emit([null, {event_type:'book', asset_id:'2', timestamp: Date.now()+1000, bids:[], asks:[]}]);
  assert.ok(env.registry.health('2').generation > before);
  assert.equal(env.registry.health('2').initialized, false);
  assert.equal(events(env).length, 2);
});

test('malformed identifiable event fences only its asset and preserves following valid delta', () => {
  const env = setup(); env.call('books:subscribe', ['2']);
  const emit = value => env.socket().emit('message', Buffer.from(JSON.stringify(value)));
  emit([book('1'), book('2')]);
  const before = env.registry.health('2').generation;
  emit([{asset_id:'1'}, {event_type:'price_change', timestamp:Date.now(), price_changes:[{asset_id:'2',price:'0.5',size:'1',side:'BUY'}]}]);
  assert.equal(env.registry.health('1').initialized, false);
  assert.equal(env.registry.health('2').generation, before);
  assert.equal(env.registry.health('2').initialized, true);
  assert.equal(events(env).at(-1).price_changes[0].asset_id, '2');
});
