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

// Split a "a@x.com; b@y.com , c@z.com" string into a clean array.
const toList = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value)
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
};

// Real Medafrica recipients for the LTA-READY notification email.
// Overridable via EMAIL_TO / EMAIL_CC env vars (e.g. for testing).
const DEFAULT_EMAIL_TO = [
  // "Abderazzak.tamraoui@medafrica-log.com",
  // "abdelhak.tachrify@medafrica-log.com",
  "nouhaila.elallali@medafrica-log.com",
  "nouhaila.orfane@medafrica-log.com",
  "OUSSAMA.FARIS@medafrica-log.com",
  // "ahmed.baazzouz@medafrica-log.com",
  // "imane.hamadi@medafrica-log.com",
];
const DEFAULT_EMAIL_CC = [
  // "imad.amoudi@medafrica-log.com",
  // "hamza.kninis@medafrica-log.com",
  "cursorcompte06@gmail.com",
  "ismail.tajani@medafrica-log.com",
];

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
    // ⛔ TEMP HARD-DISABLE: email is force-OFF regardless of EMAIL_ENABLED in .env.
    // To re-enable later: delete this `enabled: false,` line and uncomment the
    // toBool line below, then restart the app.
    enabled: false,
    // enabled: toBool(process.env.EMAIL_ENABLED, false),
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
    to: toList(process.env.EMAIL_TO, DEFAULT_EMAIL_TO),
    cc: toList(process.env.EMAIL_CC, DEFAULT_EMAIL_CC),
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
