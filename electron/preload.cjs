const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("polymarketTerminal", {
  listMarkets: () => ipcRenderer.invoke("markets:list"),
  subscribeAssets: (assetIds) => ipcRenderer.invoke("books:subscribe", assetIds),
  unsubscribeAssets: (assetIds) => ipcRenderer.invoke("books:unsubscribe", assetIds),
  submitOrder: (draft) => ipcRenderer.invoke("orders:submit", draft),
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
