const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("polymarketTerminal", {
  listMarkets: () => ipcRenderer.invoke("markets:list"),
  subscribeAssets: (assetIds) => ipcRenderer.invoke("books:subscribe", assetIds),
  unsubscribeAssets: (assetIds) => ipcRenderer.invoke("books:unsubscribe", assetIds),
  submitOrder: (draft) => ipcRenderer.invoke("orders:submit", draft),
  getAccountStatus: () => ipcRenderer.invoke("auth:status"),
  connectAccount: (request) => ipcRenderer.invoke("auth:connect", request),
  disconnectAccount: () => ipcRenderer.invoke("auth:disconnect"),
  setTradingArmed: (armed) => ipcRenderer.invoke("trading:arm", armed),
  getAccountSnapshot: () => ipcRenderer.invoke("account:snapshot"),
  cancelAllOrders: () => ipcRenderer.invoke("orders:cancel-all"),
  onMarketEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("market:event", listener);
    return () => ipcRenderer.removeListener("market:event", listener);
  },
  onConnectionStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("market:status", listener);
    return () => ipcRenderer.removeListener("market:status", listener);
  },
});
