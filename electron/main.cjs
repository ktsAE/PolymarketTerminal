const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocket } = require("ws");
const { z } = require("zod");

const MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GAMMA_EVENTS_URL =
  "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=volume24hr&ascending=false";
const GAMMA_SPORTS_URL = "https://gamma-api.polymarket.com/sports";
const GAMMA_EVENT_PAGES = 5;
const GAMMA_LEAGUE_EVENT_PAGES = 3;

let mainWindow;
let marketSocket;
let heartbeat;
let reconnectTimer;
let reconnectAttempt = 0;
const subscriptions = new Set();
let tradingModulePromise;
const { createRegistry, createTradingService, assertMainSender } = require('./safety.cjs');
const { createDiscovery } = require('./discovery.cjs');
const publish = (channel, payload) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
};
const registry = createRegistry({ publish: health => publish('asset:health', health) });
const maxUsd = process.env.PM_TERMINAL_MAX_ORDER_USD || '25';
const tradingService = createTradingService({
  registry,
  liveEnabled: process.env.PM_TERMINAL_ENABLE_REVIEWED_LIVE === '1',
  maxOrderUsd: /^\d+(\.\d{1,6})?$/.test(maxUsd) && Number(maxUsd) > 0 ? maxUsd : '25',
  createClient: async input => (await getTradingModule()).createAccountClient(input),
  publish: status => publish('account:status', status),
});
const discovery = createDiscovery({ fetchJson, cache: items => registry.cache(items) });
function handle(channel, listener) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Unauthorized IPC sender');
    return listener(event, ...args);
  });
}

const authRequestSchema = z.object({
  privateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "Private key must be 0x plus 64 hex characters"),
  walletAddress: z
    .string()
    .trim()
    .refine((value) => value === "" || /^0x[0-9a-fA-F]{40}$/.test(value), "Wallet address is invalid")
    .optional(),
});

const orderDraftSchema = z.object({
  assetId: z.string().regex(/^\d+$/),
  marketTitle: z.string().min(1).max(500),
  outcome: z.string().min(1).max(100),
  side: z.enum(["BUY", "SELL"]),
  price: z.string().regex(/^0\.\d+$/).refine((value) => Number(value) > 0 && Number(value) < 1),
  size: z.string().regex(/^\d+(\.\d+)?$/).refine((value) => Number(value) > 0),
  sizeUnit: z.enum(["USD", "SHARES"]),
  execution: z.enum(["GTC", "FAK"]),
  mode: z.enum(["DRY", "LIVE"]),
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  bookGeneration: z.number().int().nonnegative(),
  tickVersion: z.number().int().nonnegative(),
  armEpoch: z.number().int().nonnegative(),
});

function getTradingModule() {
  tradingModulePromise ??= import("./trading.mjs");
  return tradingModulePromise;
}

function appendOrderAudit(entry) {
  const auditPath = path.join(app.getPath("userData"), "orders.jsonl");
  fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("market:status", status);
  }
}

function stopHeartbeat() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = undefined;
}

function scheduleReconnect() {
  if (reconnectTimer || subscriptions.size === 0) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
  reconnectAttempt += 1;
  sendStatus("reconnecting");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connectMarketSocket();
  }, delay);
}

function sendSubscription(operation, assetIds) {
  if (!marketSocket || marketSocket.readyState !== WebSocket.OPEN || assetIds.length === 0) return;
  if (operation === "initial") {
    marketSocket.send(
      JSON.stringify({
        assets_ids: assetIds,
        type: "market",
        custom_feature_enabled: true,
      }),
    );
    return;
  }
  marketSocket.send(JSON.stringify({ operation, assets_ids: assetIds }));
}

function connectMarketSocket() {
  if (subscriptions.size === 0) return;
  if (
    marketSocket &&
    (marketSocket.readyState === WebSocket.OPEN || marketSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  sendStatus("connecting");
  marketSocket = new WebSocket(MARKET_WS_URL);
  const socket = marketSocket;
  marketSocket.on("open", () => {
    if (marketSocket !== socket) return;
    reconnectAttempt = 0;
    sendStatus("live");
    sendSubscription("initial", [...subscriptions]);
    stopHeartbeat();
    heartbeat = setInterval(() => {
      if (marketSocket?.readyState === WebSocket.OPEN) marketSocket.send("PING");
    }, 10000);
  });

  marketSocket.on("message", (raw) => {
    if (marketSocket !== socket) return;
    const text = raw.toString();
    if (text === "PONG") return;
    try {
      const decoded = JSON.parse(text);
      const messages = Array.isArray(decoded) ? decoded : [decoded];
      if (!messages.length) registry.invalidate();
      for (const message of messages) {
        const validAsset = typeof message?.asset_id === 'string' && /^\d{1,100}$/.test(message.asset_id);
        const invalidateMessage = () => registry.invalidate(validAsset ? [message.asset_id] : undefined);
        if (!message || typeof message !== 'object' || Array.isArray(message) ||
            typeof message.event_type !== 'string' || !message.event_type ||
            (['book', 'tick_size_change'].includes(message.event_type) && !validAsset)) {
          invalidateMessage();
          continue;
        }
        try {
          const accepted = registry.event(message);
          if (accepted) publish("market:event", accepted);
        } catch {
          // A malformed member must not suppress subsequent independent events.
          if (message.event_type === 'price_change') registry.invalidate();
          else invalidateMessage();
        }
      }
    } catch {
      // Unparseable frames have no trustworthy asset identity.
      registry.invalidate();
    }
  });

  marketSocket.on("close", () => {
    if (marketSocket !== socket) return;
    registry.invalidate(); tradingService.disarm();
    stopHeartbeat();
    marketSocket = undefined;
    scheduleReconnect();
  });

  marketSocket.on("error", () => {
    if (marketSocket !== socket) return;
    registry.invalidate(); tradingService.disarm();
    sendStatus("error");
  });
}

function parseStringArray(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function normalizeDate(value) {
  if (!value) return undefined;
  const raw = String(value).trim();
  const normalized = raw.includes(" ") ? raw.replace(" ", "T").replace(/\+00$/, "Z") : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeLeague(item) {
  const seriesId = String(item?.series || "");
  if (!seriesId || !/^\d+$/.test(seriesId)) return undefined;
  return {
    id: String(item?.id || seriesId),
    slug: String(item?.sport || item?.name || seriesId).toLowerCase(),
    name: String(item?.name || item?.sport || `League ${seriesId}`),
    image: item?.image ? String(item.image) : undefined,
    seriesId,
    primaryTagId: item?.primaryTagId ? String(item.primaryTagId) : undefined,
    ordering: item?.ordering === "away" ? "away" : "home",
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { accept: "application/json", "user-agent": "pm-orderbook-terminal/0.2" },
  });
  if (!response.ok) throw new Error(`Market discovery failed (${response.status})`);
  return response.json();
}

async function listLeagues() {
  const payload = await fetchJson(GAMMA_SPORTS_URL);
  const normalized = (Array.isArray(payload) ? payload : [])
    .map(normalizeLeague)
    .filter(Boolean);
  const unique = new Map();
  normalized.forEach((league) => {
    if (!unique.has(league.seriesId)) unique.set(league.seriesId, league);
  });
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const categoryRules = [
  ["Politics", ["politics", "elections", "global-elections", "us-politics"]],
  ["Crypto", ["crypto", "bitcoin", "ethereum", "solana"]],
  ["Sports", ["sports", "nba", "nfl", "mlb", "nhl", "soccer", "ufc"]],
  ["Economy", ["economy", "finance", "business", "fed", "stocks"]],
  ["Tech & AI", ["tech", "technology", "artificial-intelligence", "ai", "science"]],
  ["World", ["geopolitics", "world", "middle-east", "ukraine", "china"]],
  ["Culture", ["culture", "entertainment", "movies", "music", "awards"]],
];

function marketCategory(tags) {
  const slugs = new Set(tags.map((tag) => String(tag?.slug || "").toLowerCase()));
  for (const [label, matches] of categoryRules) {
    if (matches.some((match) => slugs.has(match))) return label;
  }
  return "Other";
}

function normalizeEvents(events, requestedLeague, leaguesBySeries = new Map()) {
  const instruments = [];
  for (const event of Array.isArray(events) ? events : []) {
    const tags = Array.isArray(event.tags) ? event.tags : [];
    const tagLabels = tags.map((tag) => String(tag?.label || "")).filter(Boolean);
    const category = marketCategory(tags);
    const eventSeries = Array.isArray(event.series) ? event.series[0] : undefined;
    const league = requestedLeague || leaguesBySeries.get(String(eventSeries?.id || ""));
    for (const market of Array.isArray(event.markets) ? event.markets : []) {
      if (!market.acceptingOrders || market.closed) continue;
      const outcomes = parseStringArray(market.outcomes);
      const assetIds = parseStringArray(market.clobTokenIds);
      for (let index = 0; index < Math.min(outcomes.length, assetIds.length); index += 1) {
        instruments.push({
          assetId: assetIds[index],
          conditionId: String(market.conditionId || ""),
          eventId: String(event.id || ""),
          eventSlug: String(event.slug || ""),
          eventTitle: String(event.title || market.question || "Untitled market"),
          marketTitle: String(market.question || event.title || "Untitled market"),
          outcome: outcomes[index],
          tickSize: String(market.orderPriceMinTickSize ?? ''),
          minOrderSize: String(market.orderMinSize ?? ''),
          acceptingOrders: market.acceptingOrders === true,
          closed: market.closed !== false,
          metadataAt: Date.now(),
          volume24hr: Number(market.volume24hr || event.volume24hr || 0),
          category,
          tags: tagLabels,
          leagueId: league?.seriesId,
          leagueSlug: league?.slug,
          leagueName: league?.name,
          leagueImage: league?.image,
          startTime: normalizeDate(market.gameStartTime || event.gameStartTime),
          sportsMarketType: market.sportsMarketType ? String(market.sportsMarketType) : undefined,
        });
      }
    }
  }
  return instruments;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#080b10",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) { tradingService.disarm(); registry.invalidate(); }
  });
  mainWindow.webContents.on('render-process-gone', () => { tradingService.disarm(); registry.invalidate(); });
  mainWindow.on('closed', () => { tradingService.disarm(); registry.invalidate(); });
  if (process.argv.includes("--dev")) {
    mainWindow.loadURL("http://127.0.0.1:5173");
    return;
  }
  mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

handle("markets:list", async () => {
  const [pages, leagues] = await Promise.all([
    Promise.all(
      Array.from({ length: GAMMA_EVENT_PAGES }, (_, page) =>
        fetchJson(`${GAMMA_EVENTS_URL}&offset=${page * 100}`),
      ),
    ),
    listLeagues().catch(() => []),
  ]);
  const leaguesBySeries = new Map(leagues.map((league) => [league.seriesId, league]));
  const items = normalizeEvents(pages.flat(), undefined, leaguesBySeries);
  registry.cache(items);
  return items;
});

handle("markets:leagues", async () => listLeagues());

handle('markets:league', async (_event, seriesId) => {
  const items = []; let cursor = null;
  do {
    const page = await discovery.page({ seriesId, cursor });
    if (page.completeness === 'UNKNOWN') throw new Error('League discovery incomplete');
    items.push(...page.items); cursor = page.nextCursor;
  } while (cursor);
  return [...new Map(items.map(item => [item.assetId, item])).values()];
});

handle("books:subscribe", (_event, assetIds) => {
  const validated = z.array(z.string().regex(/^\d+$/)).max(24).parse(assetIds);
  registry.subscribe(validated);
  const added = validated.filter((assetId) => !subscriptions.has(assetId));
  added.forEach((assetId) => subscriptions.add(assetId));
  if (!marketSocket || marketSocket.readyState !== WebSocket.OPEN) connectMarketSocket();
  else sendSubscription("subscribe", added);
  return { subscribed: [...subscriptions] };
});

handle("books:unsubscribe", (_event, assetIds) => {
  const validated = z.array(z.string().regex(/^\d+$/)).max(24).parse(assetIds);
  registry.unsubscribe(validated);
  const removed = validated.filter((assetId) => subscriptions.delete(assetId));
  sendSubscription("unsubscribe", removed);
  if (subscriptions.size === 0) {
    stopHeartbeat();
    marketSocket?.close();
  }
  return { subscribed: [...subscriptions] };
});

handle('orders:submit', async (_event, draft) => {
  const entry = await tradingService.submit(orderDraftSchema.parse(draft));
  appendOrderAudit(entry);
  return entry;
});
handle('auth:status', () => tradingService.status());
handle('auth:connect', (_event, request) => tradingService.connect(authRequestSchema.parse(request)));
handle('auth:disconnect', () => tradingService.disconnect());
handle('trading:arm', (_event, armed) => tradingService.arm(z.boolean().parse(armed)));
handle('account:snapshot', () => tradingService.snapshot());
handle('orders:cancel-all', () => tradingService.cancelAll());
handle('markets:resolve', (_event, request) => discovery.resolve(request));
handle('markets:league-page', (_event, request) => discovery.page(request));
const refreshTimes = new Map();
handle('books:refresh', async (_event, request) => {
  const assetId = z.string().regex(/^\d+$/).parse(request?.assetId);
  if (!registry.health(assetId).active) throw new Error('Asset is not ACTIVE');
  const now = Date.now();
  if (now - (refreshTimes.get(assetId) ?? -Infinity) < 5000) throw new Error('Snapshot refresh rate limited');
  refreshTimes.set(assetId, now);
  const { generation, tickVersion } = registry.health(assetId);
  const bookRevision = registry.bookRevision(assetId);
  const book = await fetchJson(`https://clob.polymarket.com/book?token_id=${assetId}`);
  const health = registry.health(assetId);
  if (!health.active || health.generation !== generation || health.tickVersion !== tickVersion || registry.bookRevision(assetId) !== bookRevision) throw new Error('Snapshot superseded');
  if (String(book.asset_id) !== assetId) throw new Error('Snapshot identity mismatch');
  const accepted = registry.event({ ...book, event_type: 'book', asset_id: assetId });
  if (!accepted) throw new Error('Snapshot rejected');
  publish('market:event', accepted);
});

app.whenReady().then(() => {
  createWindow();
  const healthTimer = setInterval(() => {
    for (const assetId of registry.active()) publish('asset:health', registry.health(assetId));
  }, 1000);
  healthTimer.unref();
  app.once('before-quit', () => { clearInterval(healthTimer); tradingService.disarm(); registry.invalidate(); });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopHeartbeat();
  if (process.platform !== "darwin") app.quit();
});
