const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('polymarketTerminal', {
  resolveInstruments: (request) => ipcRenderer.invoke('markets:resolve', request),
  listLeagueMarketsPage: (request) => ipcRenderer.invoke('markets:league-page', request),
  refreshBook: (request) => ipcRenderer.invoke('books:refresh', request),
  onAccountStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('account:status', listener);
    return () => ipcRenderer.removeListener('account:status', listener);
  },
  onAssetHealth: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('asset:health', listener);
    return () => ipcRenderer.removeListener('asset:health', listener);
  },
  listMarkets: () => ipcRenderer.invoke('markets:list'),
  listLeagues: () => ipcRenderer.invoke('markets:leagues'),
  listLeagueMarkets: (seriesId) => ipcRenderer.invoke('markets:league', seriesId),
  subscribeAssets: (assetIds) => ipcRenderer.invoke('books:subscribe', assetIds),
  unsubscribeAssets: (assetIds) => ipcRenderer.invoke('books:unsubscribe', assetIds),
  submitOrder: (draft) => ipcRenderer.invoke('orders:submit', draft),
  getAccountStatus: () => ipcRenderer.invoke('auth:status'),
  connectAccount: (request) => ipcRenderer.invoke('auth:connect', request),
  disconnectAccount: () => ipcRenderer.invoke('auth:disconnect'),
  setTradingArmed: (armed) => ipcRenderer.invoke('trading:arm', armed),
  getAccountSnapshot: () => ipcRenderer.invoke('account:snapshot'),
  cancelAllOrders: () => ipcRenderer.invoke('orders:cancel-all'),
  onMarketEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('market:event', listener);
    return () => ipcRenderer.removeListener('market:event', listener);
  },
  onConnectionStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('market:status', listener);
    return () => ipcRenderer.removeListener('market:status', listener);
  },
});
