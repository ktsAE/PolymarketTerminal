import assert from "node:assert/strict";
import { buildOrderRequest } from "../electron/trading.mjs";

const base = {
  assetId: "123",
  marketTitle: "Test market",
  outcome: "Yes",
  price: "0.50",
  mode: "LIVE",
};

const marketBuy = buildOrderRequest({
  ...base,
  side: "BUY",
  size: "10",
  sizeUnit: "USD",
  execution: "FAK",
});
assert.equal(marketBuy.kind, "market");
assert.equal(marketBuy.request.amount, "10");
assert.equal(marketBuy.request.maxSpend, "10");
assert.equal(marketBuy.request.maxPrice, "0.50");

const marketSell = buildOrderRequest({
  ...base,
  side: "SELL",
  size: "10",
  sizeUnit: "USD",
  execution: "FAK",
});
assert.equal(marketSell.request.shares, "20");
assert.equal(marketSell.request.minPrice, "0.50");

const restingBuy = buildOrderRequest({
  ...base,
  side: "BUY",
  size: "8",
  sizeUnit: "SHARES",
  execution: "GTC",
});
assert.equal(restingBuy.kind, "limit");
assert.equal(restingBuy.request.size, "8");
assert.equal(restingBuy.request.postOnly, true);

assert.throws(
  () => buildOrderRequest({ ...base, side: "BUY", size: "26", sizeUnit: "USD", execution: "FAK" }),
  /between \$0 and \$25/,
);

process.stdout.write("order mapping and risk-cap checks passed\n");
