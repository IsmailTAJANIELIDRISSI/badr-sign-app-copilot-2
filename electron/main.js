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

/**
 * Run a git command in the project root and return { code, stdout, stderr }.
 * Never throws — always resolves so startup is never blocked.
 */
const runGit = (args, cwd) => {
  return new Promise((resolve) => {
    const proc = spawn("git", args, { cwd, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d;
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
    });
    proc.on("error", (err) =>
      resolve({ code: -1, stdout, stderr: err.message }),
    );
    proc.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
};

/**
 * Auto-pull from origin/main on every dev startup.
 *
 * Strategy:
 *  1. git stash --include-untracked   — saves any local tracked changes.
 *     Files in .gitignore (dums/, outputs/, logs/, .env) are NEVER touched.
 *  2. git pull origin main            — fast-forward to latest code.
 *  3. git stash pop                   — restore saved local changes.
 *
 * Any step failure is logged as a warning and startup continues normally.
 */
const gitPull = async () => {
  // Skip in packaged builds — no .git directory exists.
  if (!isDev) {
    console.log("[GIT] Skipping auto-pull in packaged build");
    return;
  }

  const cwd = path.join(__dirname, "..");

  // 1. Stash local tracked changes (gitignored files are left untouched).
  const stash = await runGit(["stash", "--include-untracked"], cwd);
  const stashed =
    stash.code === 0 && !stash.stdout.includes("No local changes");
  if (stash.code !== 0) {
    console.warn(
      `[GIT] stash failed (code=${stash.code}) — skipping pull to avoid data loss`,
    );
    if (stash.stderr) console.warn(`[GIT] stash stderr: ${stash.stderr.trim()}`);
    if (stash.stdout) console.warn(`[GIT] stash stdout: ${stash.stdout.trim()}`);
    return;
  }
  if (stashed) {
    console.log("[GIT] Local changes stashed temporarily");
  }

  // 2. Pull latest code.
  console.log("[GIT] Pulling latest from origin main...");
  const pull = await runGit(["pull", "origin", "main"], cwd);
  (pull.stdout + pull.stderr)
    .split("\n")
    .filter(Boolean)
    .forEach((line) => console.log(`[GIT] ${line}`));

  if (pull.code === 0) {
    console.log("[GIT] ✓ Pull succeeded");
  } else {
    console.warn(
      `[GIT] pull exited with code ${pull.code} — continuing startup anyway`,
    );
  }

  // 3. Restore stashed changes (only if we stashed something).
  if (stashed) {
    const pop = await runGit(["stash", "pop"], cwd);
    if (pop.code === 0) {
      console.log("[GIT] Local changes restored");
    } else {
      console.warn(
        `[GIT] stash pop failed (code=${pop.code}) — your changes are in git stash`,
      );
    }
  }
};

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
    const command = isDev ? "node" : process.execPath;
    const args = isDev ? [apiScript] : [apiScript];
    const startupTimeoutMs = 6000;

    // In packaged builds, run the backend with Electron's embedded Node runtime.
    apiProcess = spawn(command, args, {
      stdio: "pipe",
      cwd: path.join(__dirname, ".."),
      env: {
        ...process.env,
        NODE_ENV: isDev ? "development" : "production",
        ELECTRON_APP: "true",
        ...(isDev ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
      },
    });

    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        clearTimeout(startupTimer);
        resolve();
      }
    };

    const startupTimer = setTimeout(() => {
      console.warn(
        `[API] startup timeout after ${startupTimeoutMs}ms, continuing UI startup`,
      );
      settle();
    }, startupTimeoutMs);

    apiProcess.stdout.on("data", (data) => {
      console.log(`[API] ${data}`);
      if (String(data).includes("listening")) {
        settle();
      }
    });

    apiProcess.stderr.on("data", (data) => {
      console.error(`[API ERROR] ${data}`);
    });

    apiProcess.on("error", (err) => {
      console.error("Failed to start API server:", err);
      settle(); // Still proceed
    });

    apiProcess.on("exit", (code, signal) => {
      console.error(
        `[API] process exited before ready (code=${code}, signal=${signal})`,
      );
      settle();
    });
  });
};

app.on("ready", async () => {
  await gitPull();
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
