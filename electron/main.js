import { app, BrowserWindow, Menu, ipcMain, dialog, shell } from "electron";
import isDev from "electron-is-dev";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import fs from "fs-extra";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let apiProcess;

const createWindow = () => {
  const appIcon =
    process.platform === "win32"
      ? path.join(__dirname, "..", "assets", "icon.ico")
      : path.join(__dirname, "..", "assets", "icon.png");

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
    },
    icon: appIcon,
  });

  const startUrl = isDev
    ? "http://localhost:5173"
    : `file://${path.join(__dirname, "..", "dist", "index.html")}`;

  mainWindow.loadURL(startUrl);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
};

const startApiServer = () => {
  return new Promise((resolve) => {
    const apiScript = path.join(__dirname, "..", "server", "index.js");
    apiProcess = spawn("node", [apiScript], {
      stdio: "pipe",
      env: {
        ...process.env,
        NODE_ENV: isDev ? "development" : "production",
        ELECTRON_APP: "true",
      },
    });

    apiProcess.stdout.on("data", (data) => {
      console.log(`[API] ${data}`);
      if (String(data).includes("listening")) {
        resolve();
      }
    });

    apiProcess.stderr.on("data", (data) => {
      console.error(`[API ERROR] ${data}`);
    });

    apiProcess.on("error", (err) => {
      console.error("Failed to start API server:", err);
      resolve(); // Still proceed
    });
  });
};

app.on("ready", async () => {
  await startApiServer();
  createWindow();
  setupMenu();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on("before-quit", () => {
  if (apiProcess) {
    apiProcess.kill();
  }
});

// IPC Handlers for main process
ipcMain.handle("log-folder", async () => {
  const logsDir = path.join(app.getPath("userData"), "logs");
  await fs.ensureDir(logsDir);
  return logsDir;
});

ipcMain.handle("output-folder", async () => {
  const outputDir = path.join(app.getPath("userData"), "outputs");
  await fs.ensureDir(outputDir);
  return outputDir;
});

ipcMain.handle("open-folder", async (_event, folderPath) => {
  try {
    const { execSync } = await import("child_process");
    if (process.platform === "win32") {
      execSync(`explorer.exe /select,"${folderPath}"`);
    } else if (process.platform === "darwin") {
      execSync(`open -R "${folderPath}"`);
    } else {
      execSync(`xdg-open "${path.dirname(folderPath)}"`);
    }
    return true;
  } catch (error) {
    console.error("Error opening folder:", error);
    return false;
  }
});

const setupMenu = () => {
  const template = [
    {
      label: "File",
      submenu: [
        {
          label: "Open Outputs Folder",
          accelerator: "Ctrl+O",
          click: async () => {
            const outputDir = path.join(app.getPath("userData"), "outputs");
            await fs.ensureDir(outputDir);
            await shell.openPath(outputDir);
          },
        },
        {
          label: "Open Logs Folder",
          accelerator: "Ctrl+L",
          click: async () => {
            const logsDir = path.join(app.getPath("userData"), "logs");
            await fs.ensureDir(logsDir);
            await shell.openPath(logsDir);
          },
        },
        { type: "separator" },
        {
          label: "Exit",
          accelerator: "Alt+F4",
          click: () => {
            app.quit();
          },
        },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "About",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "BADR DUM Signing Automation",
              message: "BADR DUM Signing Automation v0.1.0",
              detail:
                "Automates DUM signing process through BADR system.\n\nPlace Excel files in ./dums folder to begin.",
            });
          },
        },
      ],
    },
  ];

  if (isDev) {
    template.push({
      label: "Developer",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

export default app;
