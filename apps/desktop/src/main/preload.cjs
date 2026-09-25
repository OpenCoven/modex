// Preload: the only bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("modex", {
  platform: process.platform,
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  onEvent: (cb) => {
    const listener = (_e, event) => cb(event);
    ipcRenderer.on("thread:event", listener);
    return () => ipcRenderer.removeListener("thread:event", listener);
  },
});
