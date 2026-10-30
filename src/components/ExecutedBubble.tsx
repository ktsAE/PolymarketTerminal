import { bubbleDiameter, sharesNumber } from '../domain/scales';
import type { ShareAmount } from '../domain/scales';
import './terminal.css';

export interface ExecutedBubbleProps {
  buy: ShareAmount;
  sell: ShareAmount;
  unknown?: ShareAmount;
  scale: number;
  rowHeight: number;
  labels?: 'Auto' | 'Off';
  count?: number;
  coverage?: string;
  priceLabel?: string;
}
export function ExecutedBubble({ buy, sell, unknown = 0, scale, rowHeight, labels = 'Auto', count, coverage = 'Coverage not supplied', priceLabel }: ExecutedBubbleProps) {
  const b = sharesNumber(buy), s = sharesNumber(sell), u = sharesNumber(unknown);
  const total = b + s + u;
  if (!total) return null;
  const diameter = bubbleDiameter(total, scale, rowHeight);
  const buyEnd = b / total * 100;
  const sellEnd = (b + s) / total * 100;
  const detail = `Executed · 10s${priceLabel ? ` · ${priceLabel}` : ''}; BUY ${b}; SELL ${s}; UNKNOWN ${u}; total ${total} shares${count === undefined ? '' : `; ${count} prints`}; ${coverage}. Bounded relative area.`;
  return <span className="terminal-executed-bubble" role="img" tabIndex={0} aria-label={detail} title={detail} style={{
    width: diameter, height: diameter,
    background: `conic-gradient(var(--terminal-buy) 0% ${buyEnd}%, var(--terminal-sell) ${buyEnd}% ${sellEnd}%, var(--terminal-neutral) ${sellEnd}% 100%)`,
    borderStyle: u > 0 ? 'dashed' : 'solid',
  }}>{labels === 'Auto' && diameter >= 16 ? Number(total.toFixed(2)).toString() : null}</span>;
}
