import path from "path";
import dotenv from "dotenv";
import os from "os";

dotenv.config();

const workspaceRoot = process.cwd();
const isDev = process.env.NODE_ENV !== "production";
const isElectron = process.env.ELECTRON_APP === "true";

// In dev mode, use workspace root; in production (packaged), use AppData
const userDataDir = isDev && isElectron 
  ? workspaceRoot 
  : isElectron
  ? path.join(os.homedir(), "AppData", "Local", "badr-sign-app")
  : workspaceRoot;

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const config = {
  workspaceRoot,
  port: toInt(process.env.PORT, 3001),
  timeout: toInt(process.env.TIMEOUT, 120000),
  headless: String(process.env.HEADLESS ?? "false").toLowerCase() === "true",
  slowMo: toInt(process.env.SLOW_MO, 50),
  isElectron,
  directories: {
    dums: process.env.DUMS_DIR || path.join(userDataDir, "dums"),
    outputs: process.env.OUTPUTS_DIR || path.join(userDataDir, "outputs"),
    logs: process.env.LOGS_DIR || path.join(userDataDir, "logs"),
  },
  badr: {
    url: process.env.BADR_URL || "https://badr.douane.gov.ma:40444/badr/Login",
    password: process.env.BADR_PASSWORD || "",
    edgePath:
      process.env.EDGE_PATH ||
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    debuggingPort: toInt(process.env.BADR_CDP_PORT, 9222),
    userDataDir: process.env.BADR_PROFILE_DIR || "C:/Temp/badr-edge-profile",
    bureauCode: process.env.BADR_BUREAU_CODE || "301",
    regimeCode: process.env.BADR_REGIME_CODE || "010",
    year: process.env.BADR_YEAR || String(new Date().getFullYear()),
  },
};
