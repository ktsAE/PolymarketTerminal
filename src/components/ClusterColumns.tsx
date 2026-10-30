import { sharesNumber } from '../domain/scales';
import type { ShareAmount } from '../domain/scales';
import type { PanelSettingsValue } from './PanelSettings';
import './terminal.css';

export type ClusterMode = PanelSettingsValue['mode'];
export interface ClusterAmounts { buy: ShareAmount; sell: ShareAmount; unknown?: ShareAmount }
export interface ClusterCellProps extends ClusterAmounts {
  mode: ClusterMode;
  scale: number;
  poc?: boolean;
  coverage?: string;
  unavailable?: boolean;
  priceLabel?: string;
}
const format = (value: number) => Number(value.toFixed(6)).toString();
export function clusterMagnitude(amounts: ClusterAmounts, mode: ClusterMode): number {
  const buy = sharesNumber(amounts.buy), sell = sharesNumber(amounts.sell);
  return mode === 'DELTA' ? Math.abs(buy - sell) : buy + sell + sharesNumber(amounts.unknown ?? 0);
}
export function ClusterCell({ buy, sell, unknown = 0, mode, scale, poc = false, coverage = 'Coverage not supplied', unavailable = false, priceLabel }: ClusterCellProps) {
  const b = sharesNumber(buy), s = sharesNumber(sell), u = sharesNumber(unknown);
  const delta = b - s;
  const direction = delta > 0 ? 'buy' : delta < 0 ? 'sell' : 'neutral';
  const text = unavailable ? '—' : mode === 'DELTA' ? `${delta > 0 ? '+' : ''}${format(delta)}${u ? '*' : ''}` : mode === 'BUYSELL' ? `${format(b)}×${format(s)}${u ? '*' : ''}` : format(b + s + u);
  const detail = unavailable ? `${priceLabel ? `${priceLabel}; ` : ''}UNAVAILABLE; ${coverage}` : `${priceLabel ? `${priceLabel}; ` : ''}BUY ${b}; SELL ${s}; UNKNOWN ${u}; total ${format(b + s + u)}; Reported Δ ${format(delta)}${u ? '; * unknown direction excluded from delta' : ''}; ${unavailable ? 'UNAVAILABLE; ' : ''}${coverage}${poc ? '; highest total volume (POC)' : ''}`;
  const intensity = unavailable ? 0 : Math.min(1, clusterMagnitude({ buy, sell, unknown }, mode) / Math.max(1, scale));
  return <span role="cell" tabIndex={0} className="terminal-cluster-cell" data-direction={direction} data-poc={poc} data-quality={coverage} aria-label={detail} title={detail} style={{ backgroundSize: `${intensity * 100}% 100%` }}>{text}</span>;
}
export interface ClusterColumn {
  id: string;
  label: string;
  startMs: number;
  endMs: number;
  current?: boolean;
  corrected?: boolean;
  coverage: string;
  unavailable?: boolean;
  cells: readonly (ClusterAmounts & { priceLabel?: string })[];
}
export interface ClusterColumnsProps {
  /** Oldest first; columns render in the supplied order. */
  columns: readonly ClusterColumn[];
  mode: ClusterMode;
  scale?: PanelSettingsValue['clusterScale'];
  rowHeight?: 18 | 22 | 26;
}
export function ClusterColumns({ columns, mode, scale = 'SHARED', rowHeight = 22 }: ClusterColumnsProps) {
  const maxima = columns.map(column => Math.max(1, ...column.cells.map(cell => clusterMagnitude(cell, mode))));
  const shared = Math.max(1, ...maxima);
  return <div className="terminal-cluster-columns" role="table" aria-label={mode === 'DELTA' ? 'Reported Δ clusters' : mode === 'BUYSELL' ? 'BUY×SELL clusters' : 'Executed volume clusters'}>
    {columns.map((column, index) => {
      const maximum = Math.max(0, ...column.cells.map(cell => clusterMagnitude(cell, 'VOLUME')));
      const denominator = typeof scale === 'number' ? scale : scale === 'COLUMN' ? maxima[index] : shared;
      return <div className="terminal-cluster-column" role="rowgroup" key={column.id}>
        <div className="terminal-cluster-heading" role="columnheader" data-quality={column.coverage} title={`${new Date(column.startMs).toString()} — ${new Date(column.endMs).toString()} [start,end); ${column.coverage}`}>
          {column.label}{column.current ? ' LIVE' : ''}{column.corrected ? ' CORRECTED' : ''} · {column.coverage}
        </div>
        {column.cells.map((cell, cellIndex) => <div role="row" key={cell.priceLabel ?? cellIndex} style={{ height: rowHeight }}><ClusterCell {...cell} mode={mode} scale={denominator} poc={maximum > 0 && clusterMagnitude(cell, 'VOLUME') === maximum} coverage={column.coverage} unavailable={column.unavailable} /></div>)}
      </div>;
    })}
  </div>;
}
