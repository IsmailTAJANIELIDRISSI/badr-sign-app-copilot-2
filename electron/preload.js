const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Request folder paths from main process
  getLogFolder: () => ipcRenderer.invoke("log-folder"),
  getOutputFolder: () => ipcRenderer.invoke("output-folder"),
  openFolder: (folderPath) => ipcRenderer.invoke("open-folder", folderPath),

  // Platform detection
  platform: process.platform,
  isElectron: true,
});
