import path from "path";
import dotenv from "dotenv";
import os from "os";

dotenv.config();

const workspaceRoot = process.cwd();
const isDev = process.env.NODE_ENV !== "production";
const isElectron = process.env.ELECTRON_APP === "true";

// In dev mode, use workspace root; in production (packaged), use AppData
const userDataDir =
  isDev && isElectron
    ? workspaceRoot
    : isElectron
      ? path.join(os.homedir(), "AppData", "Local", "badr-sign-app")
      : workspaceRoot;

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toFloat = (value, fallback) => {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
};

// Parse a recipient list from an env var.
// Accepts plain addresses and Outlook-style paste, separated by ; , or newline:
//   "a@x.com; b@y.com"
//   "Nouhaila ELALLALI <nouhaila.elallali@medafrica-log.com>; Imad <imad@x.com>"
// Entries without "@" are dropped (e.g. the "Surname" half of a name split on a
// comma), which keeps a pasted Outlook list usable.
const toList = (value, fallback = []) => {
  if (value === undefined || value === null || String(value).trim() === "")
    return fallback;
  return String(value)
    .split(/[;,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));
};

// ─────────────────────────────────────────────────────────────────────────────
// Email recipients live ONLY in .env (EMAIL_TO / EMAIL_CC) — never in this file.
//
// This file is tracked by git and the app auto-pulls on startup, so hardcoding
// per-machine recipients here caused merge conflicts that broke the app. `.env`
// is gitignored: each machine sets its own list, nothing to conflict over.
//
// Consequence: a machine with no EMAIL_TO sends NO email (logged loudly). That
// is deliberate — better a visible no-send than silently mailing wrong people.
// The production list to paste into .env is in .env.example.
// ─────────────────────────────────────────────────────────────────────────────

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
    signedLtas:
      process.env.SIGNED_LTAS_DIR ||
      process.env.OUTPUTS_DIR ||
      path.join(userDataDir, "outputs"),
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
  email: {
    // Off unless the machine's .env opts in with EMAIL_ENABLED=true.
    // Toggle email per machine from .env — never by editing this file.
    enabled: toBool(process.env.EMAIL_ENABLED, false),
    host: process.env.EMAIL_HOST || "smtp.gmail.com",
    port: toInt(process.env.EMAIL_PORT, 587),
    // 465 = implicit TLS (secure), 587 = STARTTLS (secure=false).
    secure: toBool(
      process.env.EMAIL_SECURE,
      toInt(process.env.EMAIL_PORT, 587) === 465,
    ),
    user: process.env.EMAIL_USER || "",
    pass: process.env.EMAIL_PASS || "",
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER || "",
    // Env-only. No hardcoded fallback: unset EMAIL_TO => no email is sent.
    to: toList(process.env.EMAIL_TO, []),
    cc: toList(process.env.EMAIL_CC, []),
  },
  whatsapp: {
    enabled: toBool(process.env.WHATSAPP_ENABLED, false),
    provider: process.env.WHATSAPP_PROVIDER || "callmebot",
    // International format, no "+" and no leading 0 (0688711066 -> 212688711066).
    phone: process.env.WHATSAPP_PHONE || "212688711066",
    callmebotApiKey: process.env.WHATSAPP_CALLMEBOT_APIKEY || "",
  },
  // Chrono rule: an LTA of 16 DUMs is expected to finish in 20 min => 1.25 min/DUM.
  // If an LTA is not finished within (dumCount * minutesPerDum) it triggers a
  // WhatsApp "taking too long" alert. Overridable via LTA_MINUTES_PER_DUM.
  ltaChrono: {
    minutesPerDum: toFloat(process.env.LTA_MINUTES_PER_DUM, 20 / 16),
  },
};
