import { memo, useMemo } from 'react';
import type { AccountPosition, AccountStatus, BookState, ConnectionStatus, Instrument, OrderDraft, OrderResult } from '../types';
import { BookPanel } from './BookPanel';

/** Stable callbacks (identity never changes) so memoized panels skip unrelated App re-renders. */
export interface BookPanelHandlers {
  close(instrument: Instrument): void;
  toggleLeagueFavorite(leagueId: string): void;
  toggleFocus(assetId: string): void;
  order(draft: OrderDraft): Promise<OrderResult | void>;
  dragStart(index: number): void;
  drop(index: number): void;
}

export function freshBook(instrument: Instrument): BookState {
  return {
    assetId: instrument.assetId,
    bids: new Map(),
    asks: new Map(),
    tickSize: instrument.tickSize,
    recentTrades: [],
    ready: false,
  };
}

interface SlotProps {
  workspace: string;
  index: number;
  layoutGeneration: string;
  instrument: Instrument;
  book?: BookState;
  connection: ConnectionStatus;
  accountStatus: AccountStatus;
  position?: AccountPosition;
  sessionOrders: OrderResult[];
  leagueFavorite: boolean;
  focused: boolean;
  handlers: BookPanelHandlers;
  onGeometry(assetId: string, chrome: number, rowHeight: 18 | 22 | 26): void;
}

export const BookPanelSlot = memo(function BookPanelSlot({ index, handlers, book, instrument, ...rest }: SlotProps) {
  const effectiveBook = useMemo(() => book ?? freshBook(instrument), [book, instrument]);
  return (
    <BookPanel
      {...rest}
      instrument={instrument}
      book={effectiveBook}
      onClose={() => handlers.close(instrument)}
      onToggleLeagueFavorite={() => instrument.leagueId && handlers.toggleLeagueFavorite(instrument.leagueId)}
      onToggleFocus={() => handlers.toggleFocus(instrument.assetId)}
      onOrder={handlers.order}
      onDragStart={() => handlers.dragStart(index)}
      onDrop={() => handlers.drop(index)}
    />
  );
});
