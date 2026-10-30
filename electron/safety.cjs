'use strict';
const { parseUnits, parseShares } = require('../shared/decimal.cjs');
const { buildOrderRequest } = require('./order-policy.cjs');
const validId = (id) => typeof id === 'string' && /^\d+$/.test(id) && id.length <= 100;
function createRegistry({ now = Date.now, publish = () => {} } = {}) {
  const entries = new Map(),
    metadata = new Map(),
    history = new Map();
  let serial = 0;
  // Provider timestamps are integer epoch milliseconds. Unknown clocks fail closed at
  // local fences; no clock conversion or raw provider generation is guessed.
  const timestamp = (value) =>
    /^[0-9]+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= now()
      ? Number(value)
      : null;
  function record(id) {
    if (!history.has(id)) history.set(id, { last: null, fence: null, tickVersion: 1, tickAuthority: false });
    return history.get(id);
  }
  function health(assetId) {
    const e = entries.get(assetId);
    return {
      assetId,
      active: !!e,
      generation: e?.generation ?? 0,
      tickVersion: e?.tickVersion ?? record(assetId).tickVersion,
      initialized: e?.initialized ?? false,
      bookReceivedAt: e?.bookReceivedAt ?? null,
      fresh: !!e?.initialized && now() - e.bookReceivedAt <= 10000,
      tickSize: metadata.get(assetId)?.tickSize,
    };
  }
  function emit(id) {
    publish(health(id));
  }
  function invalidate(ids = [...entries.keys()], fence = now()) {
    for (const id of ids) {
      const r = record(id);
      r.fence = Math.max(r.fence ?? 0, fence, r.last ?? 0);
      const e = entries.get(id);
      if (e) {
        e.generation = ++serial;
        e.initialized = false;
        e.bookReceivedAt = null;
        emit(id);
      }
    }
  }
  function ordered(id, ts, proof = false) {
    const r = record(id);
    return (
      (ts !== null && (r.last === null || ts >= r.last) && (r.fence === null || ts > r.fence)) || (proof && ts === null)
    );
  }
  function stamp(id, ts) {
    const r = record(id);
    if (ts !== null) r.last = Math.max(r.last ?? 0, ts);
  }
  function tags(id) {
    const e = entries.get(id);
    return { generation: e.generation, tickVersion: e.tickVersion };
  }
  return {
    cache(items) {
      for (const item of items) {
        if (!validId(item.assetId)) continue;
        const old = metadata.get(item.assetId),
          r = record(item.assetId),
          e = entries.get(item.assetId);
        const next = { ...item, metadataAt: now() };
        if (old && r.tickAuthority) next.tickSize = old.tickSize;
        metadata.set(item.assetId, next);
        if (e && old?.tickSize !== next.tickSize) {
          e.tickVersion = ++r.tickVersion;
          invalidate([item.assetId]);
        }
      }
    },
    metadata: (id) => metadata.get(id),
    active: () => [...entries.keys()],
    health,
    invalidate,
    bookRevision: (id) => entries.get(id)?.bookRevision ?? 0,
    subscribe(ids) {
      if (!Array.isArray(ids) || ids.some((id) => !validId(id))) throw Error('Invalid asset IDs');
      const all = new Set([...entries.keys(), ...ids]);
      if (all.size > 6) throw Error('At most six ACTIVE assets');
      for (const id of ids)
        if (!entries.has(id)) {
          const r = record(id);
          entries.set(id, {
            generation: ++serial,
            tickVersion: r.tickVersion,
            initialized: false,
            bookReceivedAt: null,
          });
          emit(id);
        }
      return [...entries.keys()];
    },
    unsubscribe(ids) {
      invalidate(ids);
      for (const id of ids) {
        entries.delete(id);
        emit(id);
      }
      return [...entries.keys()];
    },
    event(message, proof) {
      const id = message.asset_id,
        e = entries.get(id),
        ts = timestamp(message.timestamp);
      if (message.event_type === 'tick_size_change') {
        if (!e) return false;
        const r = record(id);
        if (ts !== null && ((r.last !== null && ts < r.last) || (r.fence !== null && ts < r.fence))) return false;
        let tick = '';
        try {
          if (parseUnits(message.new_tick_size) <= 0) throw Error();
          tick = message.new_tick_size;
        } catch {}
        const m = metadata.get(id);
        if (m) metadata.set(id, { ...m, tickSize: tick });
        r.tickAuthority = true;
        e.tickVersion = ++r.tickVersion;
        stamp(id, ts);
        invalidate([id], ts ?? now());
        return { ...message, ...tags(id) };
      }
      if (message.event_type === 'book') {
        if (!e) return false;
        const trusted = proof && proof.generation === e.generation && proof.tickVersion === e.tickVersion;
        if (proof && !trusted) return false;
        if (!ordered(id, ts, trusted)) return false;
        try {
          const m = metadata.get(id);
          if (!m) throw Error();
          const tick = String(message.tick_size ?? m.tickSize),
            min = String(message.min_order_size ?? m.minOrderSize);
          if (parseUnits(tick) <= 0 || parseShares(min) <= 0n) throw Error();
          if (!Array.isArray(message.bids) || !Array.isArray(message.asks)) throw Error();
          for (const level of [...message.bids, ...message.asks]) {
            parseUnits(level.price);
            parseShares(level.size);
          }
          const r = record(id);
          if (tick !== m.tickSize) {
            e.tickVersion = ++r.tickVersion;
            invalidate([id], ts ?? now());
          }
          if (message.tick_size !== undefined) r.tickAuthority = true;
          metadata.set(id, { ...m, tickSize: tick, minOrderSize: min });
          stamp(id, ts);
          e.initialized = true;
          e.bookReceivedAt = now();
          e.bookRevision = (e.bookRevision ?? 0) + 1;
          emit(id);
          return { ...message, ...tags(id), tick_size: tick, min_order_size: min };
        } catch {
          invalidate([id]);
          return false;
        }
      }
      if (message.event_type === 'price_change') {
        // An unidentifiable change could belong to any active book. Never apply a
        // partial batch before determining which books have lost depth continuity.
        if (!Array.isArray(message.price_changes)) {
          invalidate(validId(id) ? (e ? [id] : []) : undefined);
          return false;
        }
        const bad = new Set();
        let unknown = false;
        for (const c of message.price_changes) {
          if (!c || typeof c !== 'object' || Array.isArray(c) || !validId(c.asset_id)) {
            unknown = true;
            continue;
          }
          const entry = entries.get(c.asset_id);
          if (!entry) continue;
          if (!ordered(c.asset_id, ts)) {
            bad.add(c.asset_id);
            continue;
          }
          try {
            parseUnits(c.price);
            parseShares(c.size);
            if (!['BUY', 'SELL'].includes(c.side)) throw Error();
          } catch {
            bad.add(c.asset_id);
          }
        }
        if (unknown) {
          invalidate();
          return false;
        }
        if (bad.size) invalidate([...bad]);
        const accepted = [];
        for (const c of message.price_changes) {
          const entry = entries.get(c.asset_id);
          if (!entry || bad.has(c.asset_id)) continue;
          // Even an unapplied delta supersedes an in-flight snapshot for this asset.
          stamp(c.asset_id, ts);
          entry.bookRevision = (entry.bookRevision ?? 0) + 1;
          if (!entry.initialized) continue;
          entry.bookReceivedAt = now();
          emit(c.asset_id);
          accepted.push({ ...c, ...tags(c.asset_id) });
        }
        return accepted.length ? { ...message, price_changes: accepted } : false;
      }
      // BBO and executions are display data, never depth freshness evidence.
      return message;
    },
    validate(order, live = false) {
      const h = health(order.assetId),
        m = metadata.get(order.assetId);
      if (!h.active || !m) throw Error('Asset is not ACTIVE and resolved');
      if (order.bookGeneration !== h.generation || order.tickVersion !== h.tickVersion)
        throw Error('Book generation or tick version changed');
      if (!h.initialized) throw Error('Fresh snapshot required');
      if (live && !h.fresh) throw Error('Book is stale');
      if (now() - m.metadataAt > 60000) throw Error('Metadata is stale');
      return m;
    },
  };
}
function createTradingService({
  registry,
  now = Date.now,
  createClient,
  fetch: fetcher = globalThis.fetch,
  liveEnabled = false,
  maxOrderUsd = '25',
  publish = () => {},
  maxRequests = 5000,
} = {}) {
  let client,
    armed = false,
    armEpoch = 0,
    closedOnly = null;
  let geoblock = { blocked: null, country: '', region: '', checkedAt: null, error: 'Not checked' };
  const requests = new Map();
  function status() {
    return {
      connected: !!client,
      armed,
      armEpoch,
      liveEnabled,
      maxOrderUsd: Number(maxOrderUsd),
      closedOnly,
      geoblock,
      account: client
        ? {
            signer: String(client.account.signer || ''),
            signerType: String(client.account.signerType || ''),
            wallet: String(client.account.wallet || ''),
            walletType: String(client.account.walletType || ''),
          }
        : undefined,
    };
  }
  function emit() {
    publish(status());
    return status();
  }
  function disarm() {
    armed = false;
    armEpoch++;
    return emit();
  }
  async function geo() {
    try {
      const r = await fetcher('https://polymarket.com/api/geoblock', { signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw Error();
      const v = await r.json();
      geoblock = {
        blocked: typeof v.blocked === 'boolean' ? v.blocked : null,
        country: String(v.country || ''),
        region: String(v.region || ''),
        checkedAt: new Date(now()).toISOString(),
        error: '',
      };
    } catch {
      geoblock = { ...geoblock, blocked: null, error: 'Location check failed' };
    }
    if (geoblock.blocked !== false) {
      disarm();
      throw Error('Location is not verified');
    }
  }
  function requireLive() {
    if (!liveEnabled) throw Error('LIVE disabled pending release review');
    if (!client) throw Error('Connect account first');
  }
  function recheck(order, identity, epoch) {
    requireLive();
    if (!armed || client !== identity || armEpoch !== epoch || order.armEpoch !== armEpoch)
      throw Error('Arm epoch or account changed');
    return registry.validate(order, true);
  }
  async function run(order) {
    if (
      !validId(order.assetId) ||
      !Number.isSafeInteger(order.bookGeneration) ||
      !Number.isSafeInteger(order.tickVersion) ||
      !Number.isSafeInteger(order.armEpoch)
    )
      throw Error('Missing order identity');
    if (order.armEpoch !== armEpoch) throw Error('Arm epoch changed');
    const m = registry.validate(order, order.mode === 'LIVE');
    let built = buildOrderRequest(order, m, maxOrderUsd);
    const canonical = { ...order, marketTitle: m.marketTitle, outcome: m.outcome };
    if (order.mode === 'DRY')
      return {
        ...canonical,
        status: 'DRY_ACCEPTED',
        message:
          parseShares(built.notional) > parseShares(String(maxOrderUsd))
            ? 'Warning: exceeds configured LIVE notional cap'
            : undefined,
        createdAt: new Date(now()).toISOString(),
      };
    const identity = client,
      epoch = armEpoch;
    recheck(order, identity, epoch);
    await geo();
    let restriction;
    try {
      restriction = await identity.fetchClosedOnlyMode();
    } catch (error) {
      if (client === identity && armEpoch === epoch) {
        closedOnly = null;
        disarm();
      }
      throw error;
    }
    recheck(order, identity, epoch);
    closedOnly = restriction;
    if (restriction !== false) {
      disarm();
      throw Error('Account restrictions not verified');
    }
    // No await may be added between the following recheck and SDK invocation.
    const latest = recheck(order, identity, epoch);
    built = buildOrderRequest(order, latest, maxOrderUsd);
    try {
      const response = await (built.kind === 'limit'
        ? identity.placeLimitOrder(built.request)
        : identity.placeMarketOrder(built.request));
      return {
        ...canonical,
        status: response.ok ? 'LIVE_ACCEPTED' : 'LIVE_REJECTED',
        orderId: response.orderId ? String(response.orderId) : undefined,
        createdAt: new Date(now()).toISOString(),
      };
    } catch {
      return {
        ...canonical,
        status: 'UNKNOWN_SUBMISSION',
        message: 'Submission outcome unknown; do not retry with a new request ID',
        createdAt: new Date(now()).toISOString(),
      };
    }
  }
  return {
    status,
    disarm,
    async connect(input) {
      const old = client;
      client = undefined;
      closedOnly = null;
      disarm();
      const epoch = armEpoch;
      try {
        await old?.closeSubscriptions?.();
        if (epoch !== armEpoch) throw Error('Connection superseded');
        if (!liveEnabled) throw Error('LIVE disabled pending release review');
        const next = await createClient(input);
        if (epoch !== armEpoch) {
          await next.closeSubscriptions?.();
          throw Error('Connection superseded');
        }
        client = next;
        return emit();
      } catch (error) {
        // Publish current state, never restore an old client or overwrite a newer session.
        emit();
        throw error;
      }
    },
    async disconnect() {
      const old = client;
      client = undefined;
      closedOnly = null;
      disarm();
      try {
        await old?.closeSubscriptions?.();
      } finally {
        emit();
      }
      return status();
    },
    async arm(next) {
      if (!next) return disarm();
      // Reverification revokes the previous authorization before any async work.
      disarm();
      requireLive();
      const identity = client;
      const epoch = armEpoch;
      await geo();
      if (client !== identity || armEpoch !== epoch) throw Error('Account changed while arming');
      const restriction = await identity.fetchClosedOnlyMode();
      if (client !== identity || armEpoch !== epoch) throw Error('Account changed while arming');
      closedOnly = restriction;
      if (restriction !== false) throw Error('Account restrictions not verified');
      armed = true;
      armEpoch++;
      return emit();
    },
    submit(order) {
      if (!order || typeof order.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(order.requestId))
        return Promise.reject(Error('requestId required'));
      const body = JSON.stringify(
        Object.keys(order)
          .sort()
          .map((k) => [k, order[k]]),
      );
      const old = requests.get(order.requestId);
      if (old) return old.body === body ? old.promise : Promise.reject(Error('requestId body changed'));
      if (requests.size >= maxRequests) return Promise.reject(Error('Session request limit reached'));
      const promise = Promise.resolve().then(() => run(order));
      requests.set(order.requestId, { body, promise });
      return promise;
    },
    async cancelAll() {
      disarm();
      try {
        if (!client) throw Error('Connect account first');
        const response = await client.cancelAll();
        return {
          canceled: Array.isArray(response.canceled) ? response.canceled.map(String) : [],
          status: 'CANCEL_ALL_SENT',
        };
      } finally {
        emit();
      }
    },
    async snapshot() {
      if (!client) throw Error('Connect account first');
      const identity = client;
      const [portfolio, openPage, closedPage, ordersPage] = await Promise.all([
        identity.fetchPortfolioValue(),
        identity.listPositions({ status: 'OPEN', pageSize: 100 }).firstPage(),
        identity.listPositions({ status: 'CLOSED', pageSize: 30 }).firstPage(),
        identity.listOpenOrders().firstPage(),
      ]);
      if (client !== identity) throw Error('Account changed');
      return {
        wallet: identity.account.wallet,
        portfolioValue: String(portfolio.value),
        openPositions: openPage.items,
        closedPositions: closedPage.items,
        openOrderCount: ordersPage.items.length,
        refreshedAt: new Date(now()).toISOString(),
      };
    },
  };
}
function assertMainSender(event, window) {
  if (
    !window ||
    window.isDestroyed() ||
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw Error('Unauthorized IPC sender');
}
// The exchange outcome is already known when the audit is written. A persistence failure
// must never hide that acknowledgment from the caller (it would invite a duplicate order).
function persistAuditResult(result, persist, log = () => {}) {
  try {
    persist(result);
    return result;
  } catch {
    // Deliberately do not forward the raw error: it may contain paths or other local detail.
    try {
      log('Order audit persistence failed');
    } catch {}
    return { ...result, auditWarning: 'Order result could not be written to the local audit log' };
  }
}
exports.persistAuditResult = persistAuditResult;
exports.assertMainSender = assertMainSender;
exports.createRegistry = createRegistry;
exports.createTradingService = createTradingService;
