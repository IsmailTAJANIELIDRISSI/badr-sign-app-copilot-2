const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  // Request folder paths from main process
  getLogFolder: () => ipcRenderer.invoke("log-folder"),
  getOutputFolder: () => ipcRenderer.invoke("output-folder"),
  openFolder: (folderPath) => ipcRenderer.invoke("open-folder", folderPath),
  // Open a specific file in its default app (xlsx → Excel).
  openFile: (filePath) => ipcRenderer.invoke("open-file", filePath),
  // Pick any .xlsx via a native dialog and open it. Returns the path or null.
  pickAndOpenXlsx: (defaultPath) => ipcRenderer.invoke("pick-xlsx", defaultPath),

  // Platform detection
  platform: process.platform,
  isElectron: true,
});
