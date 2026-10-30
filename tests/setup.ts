import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { terminalFixture } from './fixtures/terminal';
import { marketStore } from '../src/state/marketStore';

// App captures its bridge at module evaluation, so install before test imports.
if (typeof window !== 'undefined') window.polymarketTerminal = terminalFixture.bridge;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(terminalFixture.now));
  terminalFixture.reset();
  vi.spyOn(terminalFixture.bridge, 'submitOrder');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in unit tests'); }));
  vi.stubGlobal('WebSocket', class { constructor() { throw new Error('WebSocket forbidden in unit tests'); } });
  if (typeof window !== 'undefined') {
    localStorage.clear();
    sessionStorage.clear();
    vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => { throw new Error('XHR forbidden in unit tests'); });
  }
});

afterEach(async () => {
  if (typeof window !== 'undefined') {
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
  }
  marketStore.setActive([]);
  marketStore.reset();
  // Let App's serialized unsubscribe queue finish before resetting the bridge.
  await Promise.resolve();
  await Promise.resolve();
  terminalFixture.reset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
