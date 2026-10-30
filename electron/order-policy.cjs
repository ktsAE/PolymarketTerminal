'use strict';
const { parseUnits, parseShares, formatShares } = require('../shared/decimal.cjs');
const SCALE = 1000000n;
function buildOrderRequest(order, metadata, maxOrderUsd = '25') {
  if (!metadata || metadata.acceptingOrders !== true || metadata.closed !== false) throw Error('Market unavailable');
  if (
    !['BUY', 'SELL'].includes(order.side) ||
    !['GTC', 'FAK'].includes(order.execution) ||
    !['USD', 'SHARES'].includes(order.sizeUnit) ||
    !['DRY', 'LIVE'].includes(order.mode)
  )
    throw Error('Invalid order policy');
  const p = BigInt(parseUnits(order.price)),
    tick = BigInt(parseUnits(metadata.tickSize));
  if (p <= 0n || p >= SCALE || tick <= 0n || p % tick !== 0n) throw Error('Price must be an exact valid tick');
  const size = parseShares(order.size),
    min = parseShares(metadata.minOrderSize);
  if (size <= 0n || min <= 0n) throw Error('Invalid size or minimum');
  if (order.sizeUnit === 'USD' && (size * SCALE) % p !== 0n) throw Error('USD conversion has unsafe share precision');
  const shares = order.sizeUnit === 'USD' ? (size * SCALE) / p : size;
  if (shares < min) throw Error('Order is below minimum shares');
  if ((shares * p) % SCALE !== 0n) throw Error('Notional has unsafe precision');
  const notional = (shares * p) / SCALE;
  if (order.mode === 'LIVE' && notional > parseShares(String(maxOrderUsd)))
    throw Error('Order notional exceeds configured live cap');
  const common = { assetId: order.assetId, side: order.side };
  if (order.execution === 'GTC')
    return {
      kind: 'limit',
      notional: formatShares(notional),
      request: { ...common, price: order.price, size: formatShares(shares), postOnly: true },
    };
  return {
    kind: 'market',
    notional: formatShares(notional),
    request:
      order.side === 'BUY'
        ? {
            ...common,
            amount: formatShares(notional),
            maxSpend: formatShares(notional),
            maxPrice: order.price,
            orderType: 'FAK',
          }
        : { ...common, shares: formatShares(shares), minPrice: order.price, orderType: 'FAK' },
  };
}
exports.buildOrderRequest = buildOrderRequest;
