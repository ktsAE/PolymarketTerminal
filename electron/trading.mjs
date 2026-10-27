import {
  createSecureClient,
  OrderSide,
  OrderType,
} from "@polymarket/client";
import { privateKey as privateKeySigner } from "@polymarket/client/viem";

const GEOBLOCK_URL = "https://polymarket.com/api/geoblock";
const GEOBLOCK_MAX_AGE_MS = 60_000;
const configuredMaxOrderUsd = Number(process.env.PM_TERMINAL_MAX_ORDER_USD || "25");
const MAX_ORDER_USD = Number.isFinite(configuredMaxOrderUsd) && configuredMaxOrderUsd > 0
  ? configuredMaxOrderUsd
  : 25;

let secureClient;
let armed = false;
let geoblock = {
  blocked: null,
  country: "",
  region: "",
  checkedAt: null,
  error: "Not checked",
};
let geoblockCheckedAt = 0;
let closedOnly = null;

function requireClient() {
  if (!secureClient) throw new Error("Connect a Polymarket account first");
  return secureClient;
}

function publicStatus() {
  return {
    connected: Boolean(secureClient),
    armed,
    maxOrderUsd: MAX_ORDER_USD,
    geoblock,
    closedOnly,
    account: secureClient
      ? {
          signer: secureClient.account.signer,
          signerType: String(secureClient.account.signerType),
          wallet: secureClient.account.wallet,
          walletType: String(secureClient.account.walletType),
        }
      : undefined,
  };
}

async function checkGeoblock(force = false) {
  if (!force && Date.now() - geoblockCheckedAt < GEOBLOCK_MAX_AGE_MS) return geoblock;
  try {
    const response = await fetch(GEOBLOCK_URL, {
      headers: { accept: "application/json", "user-agent": "pm-orderbook-terminal/0.2" },
    });
    if (!response.ok) throw new Error(`Geoblock check failed (${response.status})`);
    const result = await response.json();
    geoblock = {
      blocked: Boolean(result.blocked),
      country: String(result.country || ""),
      region: String(result.region || ""),
      checkedAt: new Date().toISOString(),
      error: "",
    };
  } catch (error) {
    geoblock = {
      blocked: null,
      country: "",
      region: "",
      checkedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : "Geoblock check failed",
    };
  }
  geoblockCheckedAt = Date.now();
  if (geoblock.blocked !== false) armed = false;
  return geoblock;
}

export async function connectAccount({ privateKey, walletAddress }) {
  await disconnectAccount();
  await checkGeoblock(true);

  secureClient = await createSecureClient({
    signer: privateKeySigner(privateKey),
    ...(walletAddress ? { wallet: walletAddress } : {}),
  });

  try {
    closedOnly = await secureClient.fetchClosedOnlyMode();
  } catch {
    closedOnly = null;
  }
  armed = false;
  return publicStatus();
}

export async function disconnectAccount() {
  armed = false;
  closedOnly = null;
  if (secureClient) {
    await secureClient.closeSubscriptions().catch(() => undefined);
  }
  secureClient = undefined;
  return publicStatus();
}

export function getAccountStatus() {
  return publicStatus();
}

export async function setTradingArmed(nextArmed) {
  requireClient();
  if (!nextArmed) {
    armed = false;
    return publicStatus();
  }
  await checkGeoblock(true);
  if (geoblock.blocked === true) throw new Error("Live trading is unavailable in this location");
  if (geoblock.blocked !== false) throw new Error("Live trading cannot arm until location is verified");
  try {
    closedOnly = await secureClient.fetchClosedOnlyMode();
  } catch {
    closedOnly = null;
    throw new Error("Live trading cannot arm until account restrictions are verified");
  }
  if (closedOnly === true) throw new Error("This account is currently restricted to closing positions");
  armed = true;
  return publicStatus();
}

function positionView(position) {
  return {
    assetId: String(position.assetId),
    conditionId: String(position.conditionId),
    title: String(position.title || "Untitled market"),
    outcome: String(position.outcome || "Outcome"),
    currentSize: String(position.currentSize),
    avgPrice: String(position.avgPrice),
    currentPrice: String(position.currentPrice),
    currentValue: String(position.currentValue),
    realizedPnl: String(position.realizedPnl),
    unrealizedPnl: String(position.unrealizedPnl),
    totalPnl: String(position.totalPnl),
    percentPnl: String(position.percentPnl),
    status: String(position.status),
    redeemable: Boolean(position.redeemable),
  };
}

export async function getAccountSnapshot() {
  const client = requireClient();
  const [portfolio, openPage, closedPage, ordersPage] = await Promise.all([
    client.fetchPortfolioValue(),
    client.listPositions({ status: "OPEN", pageSize: 100 }).firstPage(),
    client.listPositions({ status: "CLOSED", pageSize: 30 }).firstPage(),
    client.listOpenOrders().firstPage(),
  ]);

  return {
    wallet: client.account.wallet,
    portfolioValue: String(portfolio.value),
    openPositions: openPage.items.map(positionView),
    closedPositions: closedPage.items.map(positionView),
    openOrderCount: ordersPage.items.length,
    refreshedAt: new Date().toISOString(),
  };
}

function round(value, decimals = 6) {
  return Number(value.toFixed(decimals)).toString();
}

function orderNotional(order) {
  const size = Number(order.size);
  const price = Number(order.price);
  return order.sizeUnit === "USD" ? size : size * price;
}

export function buildOrderRequest(order) {
  const size = Number(order.size);
  const price = Number(order.price);
  const notional = orderNotional(order);
  if (!Number.isFinite(notional) || notional <= 0 || notional > MAX_ORDER_USD) {
    throw new Error(`Order notional must be between $0 and $${MAX_ORDER_USD}`);
  }

  if (order.execution === "GTC") {
    const shares = order.sizeUnit === "SHARES" ? size : size / price;
    return {
      kind: "limit",
      notional,
      request: {
        assetId: order.assetId,
        price: order.price,
        size: round(shares),
        side: order.side === "BUY" ? OrderSide.BUY : OrderSide.SELL,
        postOnly: true,
      },
    };
  }
  if (order.side === "BUY") {
    const amount = order.sizeUnit === "USD" ? size : size * price;
    return {
      kind: "market",
      notional,
      request: {
        assetId: order.assetId,
        side: OrderSide.BUY,
        amount: round(amount),
        maxSpend: round(amount),
        maxPrice: order.price,
        orderType: OrderType.FAK,
      },
    };
  }
  const shares = order.sizeUnit === "SHARES" ? size : size / price;
  return {
    kind: "market",
    notional,
    request: {
      assetId: order.assetId,
      side: OrderSide.SELL,
      shares: round(shares),
      minPrice: order.price,
      orderType: OrderType.FAK,
    },
  };
}

export async function submitLiveOrder(order) {
  const client = requireClient();
  if (!armed) throw new Error("Live trading is not armed");
  await checkGeoblock();
  if (geoblock.blocked !== false) throw new Error("Location verification does not allow live orders");
  if (closedOnly === true) throw new Error("Account is in close-only mode");

  const built = buildOrderRequest(order);
  const response = built.kind === "limit"
    ? await client.placeLimitOrder(built.request)
    : await client.placeMarketOrder(built.request);

  return {
    ...order,
    status: response.ok ? "LIVE_ACCEPTED" : "LIVE_REJECTED",
    orderId: response.orderId ? String(response.orderId) : undefined,
    message: response.message ? String(response.message) : undefined,
    createdAt: new Date().toISOString(),
  };
}

export async function cancelAllOrders() {
  const client = requireClient();
  const response = await client.cancelAll();
  armed = false;
  return {
    canceled: Array.isArray(response.canceled) ? response.canceled.map(String) : [],
    status: "CANCEL_ALL_SENT",
  };
}
