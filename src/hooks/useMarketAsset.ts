import { useSyncExternalStore } from 'react';
import { marketStore } from '../state/marketStore';
/** Subscribe to the stable published map, not freshly allocated analysis objects.
 * Idle timer publication refreshes time-based analysis even without book events. */
export function useMarketAsset(assetId: string) {
  const books = useSyncExternalStore(marketStore.subscribe, marketStore.getSnapshot, marketStore.getSnapshot);
  return { book: books.get(assetId), analysis: marketStore.getAnalysis(assetId) };
}
