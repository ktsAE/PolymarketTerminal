const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { WebSocket } = require("ws");
const { z } = require("zod");

const MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const GAMMA_EVENTS_URL =
  "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&order=volume24hr&ascending=false";

let mainWindow;
let marketSocket;
let heartbeat;
let reconnectTimer;
let reconnectAttempt = 0;
const subscriptions = new Set();

const orderDraftSchema = z.object({
  assetId: z.string().regex(/^\d+$/),
  marketTitle: z.string().min(1).max(500),
  outcome: z.string().min(1).max(100),
  side: z.enum(["BUY", "SELL"]),
  price: z.string().regex(/^0\.\d+$/),
  size: z.string().regex(/^\d+(\.\d+)?$/),
  sizeUnit: z.enum(["USD", "SHARES"]),
  execution: z.enum(["GTC", "FAK"]),
  mode: z.literal("DRY"),
});

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

function normalizeEvents(events) {
  const instruments = [];
  for (const event of Array.isArray(events) ? events : []) {
    for (const market of Array.isArray(event.markets) ? event.markets : []) {
      if (!market.acceptingOrders || market.closed) continue;
      const outcomes = parseStringArray(market.outcomes);
      const assetIds = parseStringArray(market.clobTokenIds);
      for (let index = 0; index < Math.min(outcomes.length, assetIds.length); index += 1) {
        instruments.push({
          assetId: assetIds[index],
          conditionId: String(market.conditionId || ""),
          eventTitle: String(event.title || market.question || "Untitled market"),
          marketTitle: String(market.question || event.title || "Untitled market"),
          outcome: outcomes[index],
          tickSize: String(market.orderPriceMinTickSize || "0.01"),
          minOrderSize: String(market.orderMinSize || "5"),
          volume24hr: Number(market.volume24hr || event.volume24hr || 0),
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
  const response = await fetch(GAMMA_EVENTS_URL, {
    headers: { accept: "application/json", "user-agent": "pm-orderbook-terminal/0.1" },
  });
  if (!response.ok) throw new Error(`Market discovery failed (${response.status})`);
  return normalizeEvents(await response.json());
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

ipcMain.handle("orders:submit", (_event, draft) => {
  const order = orderDraftSchema.parse(draft);
  const entry = {
    ...order,
    status: "DRY_ACCEPTED",
    createdAt: new Date().toISOString(),
  };
  const auditPath = path.join(app.getPath("userData"), "orders.jsonl");
  fs.appendFileSync(auditPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
  return entry;
});

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
