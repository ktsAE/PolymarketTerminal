import { parseUnits } from '../../shared/decimal.cjs';

export function money(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 1,
  }).format(value);
}

export function compactNumber(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function priceLabel(value: string) {
  return `${(parseUnits(value) / 10_000).toFixed(4).replace(/\.?0+$/, '')}¢`;
}

export function shortAddress(value?: string) {
  if (!value) return "not connected";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

export function signedMoney(value: number) {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(value)}`;
}

export function tradeTime(value: string) {
  const numeric = Number(value);
  const millis = Number.isFinite(numeric)
    ? numeric > 10_000_000_000 ? numeric : numeric * 1000
    : new Date(value).getTime();
  return Number.isFinite(millis) ? millis : Date.now();
}
