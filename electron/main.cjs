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

  marketSocket.on("open", () => {
    reconnectAttempt = 0;
    sendStatus("live");
    sendSubscription("initial", [...subscriptions]);
    stopHeartbeat();
    heartbeat = setInterval(() => {
      if (marketSocket?.readyState === WebSocket.OPEN) marketSocket.send("PING");
    }, 10000);
  });

  marketSocket.on("message", (raw) => {
    const text = raw.toString();
    if (text === "PONG") return;
    try {
      const decoded = JSON.parse(text);
      const messages = Array.isArray(decoded) ? decoded : [decoded];
      for (const message of messages) {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("market:event", message);
        }
      }
    } catch {
      // Ignore non-JSON protocol frames.
    }
  });

  marketSocket.on("close", () => {
    stopHeartbeat();
    marketSocket = undefined;
    scheduleReconnect();
  });

  marketSocket.on("error", () => {
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
          tickSize: String(market.orderPriceMinTickSize || "0.01"),
          minOrderSize: String(market.orderMinSize || "5"),
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

  if (process.argv.includes("--dev")) {
    mainWindow.loadURL("http://127.0.0.1:5173");
    return;
  }
  mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
}

ipcMain.handle("markets:list", async () => {
  const [pages, leagues] = await Promise.all([
    Promise.all(
      Array.from({ length: GAMMA_EVENT_PAGES }, (_, page) =>
        fetchJson(`${GAMMA_EVENTS_URL}&offset=${page * 100}`),
      ),
    ),
    listLeagues().catch(() => []),
  ]);
  const leaguesBySeries = new Map(leagues.map((league) => [league.seriesId, league]));
  return normalizeEvents(pages.flat(), undefined, leaguesBySeries);
});

ipcMain.handle("markets:leagues", async () => listLeagues());

ipcMain.handle("markets:league", async (_event, rawSeriesId) => {
  const seriesId = z.string().regex(/^\d+$/).parse(rawSeriesId);
  const leagues = await listLeagues();
  const league = leagues.find((item) => item.seriesId === seriesId);
  if (!league) throw new Error("Unknown sports league");
  const base = `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&series_id=${seriesId}`;
  const pages = await Promise.all(
    Array.from({ length: GAMMA_LEAGUE_EVENT_PAGES }, (_, page) =>
      fetchJson(`${base}&offset=${page * 100}`),
    ),
  );
  return normalizeEvents(pages.flat(), league).sort((a, b) => {
    const aTime = a.startTime ? new Date(a.startTime).getTime() : Number.MAX_SAFE_INTEGER;
    const bTime = b.startTime ? new Date(b.startTime).getTime() : Number.MAX_SAFE_INTEGER;
    return aTime - bTime || b.volume24hr - a.volume24hr;
  });
});

ipcMain.handle("books:subscribe", (_event, assetIds) => {
  const validated = z.array(z.string().regex(/^\d+$/)).max(24).parse(assetIds);
  const added = validated.filter((assetId) => !subscriptions.has(assetId));
  added.forEach((assetId) => subscriptions.add(assetId));
  if (!marketSocket || marketSocket.readyState !== WebSocket.OPEN) connectMarketSocket();
  else sendSubscription("subscribe", added);
  return { subscribed: [...subscriptions] };
});

ipcMain.handle("books:unsubscribe", (_event, assetIds) => {
  const validated = z.array(z.string().regex(/^\d+$/)).max(24).parse(assetIds);
  const removed = validated.filter((assetId) => subscriptions.delete(assetId));
  sendSubscription("unsubscribe", removed);
  if (subscriptions.size === 0) {
    stopHeartbeat();
    marketSocket?.close();
  }
  return { subscribed: [...subscriptions] };
});

ipcMain.handle("orders:submit", async (_event, draft) => {
  const order = orderDraftSchema.parse(draft);
  if (order.mode === "LIVE") {
    const trading = await getTradingModule();
    const entry = await trading.submitLiveOrder(order);
    appendOrderAudit(entry);
    return entry;
  }
  const entry = {
    ...order,
    status: "DRY_ACCEPTED",
    createdAt: new Date().toISOString(),
  };
  appendOrderAudit(entry);
  return entry;
});

ipcMain.handle("auth:status", async () => (await getTradingModule()).getAccountStatus());

ipcMain.handle("auth:connect", async (_event, request) => {
  const input = authRequestSchema.parse(request);
  const trading = await getTradingModule();
  return trading.connectAccount({
    privateKey: input.privateKey,
    walletAddress: input.walletAddress || undefined,
  });
});

ipcMain.handle("auth:disconnect", async () => (await getTradingModule()).disconnectAccount());

ipcMain.handle("trading:arm", async (_event, nextArmed) => {
  const armed = z.boolean().parse(nextArmed);
  return (await getTradingModule()).setTradingArmed(armed);
});

ipcMain.handle("account:snapshot", async () => (await getTradingModule()).getAccountSnapshot());

ipcMain.handle("orders:cancel-all", async () => (await getTradingModule()).cancelAllOrders());

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  stopHeartbeat();
  if (process.platform !== "darwin") app.quit();
});
