import path from "path";
import fs from "fs-extra";
import { config } from "./config.js";

// NOTE: `nodemailer` is imported LAZILY (dynamic import inside getTransporter),
// NOT at the top of this file. If it were a static import and the package were
// missing on a machine (npm install not run), the whole automation import graph
// would fail to load and the API server would crash on startup — which also
// prevents Edge from ever launching. Lazy-loading means a missing/broken
// nodemailer only disables email; the rest of the app keeps working.

// A no-op logger so callers may omit onLog.
const noopLog = () => {};

let _transporter = null;

/**
 * Lazily build (and cache) the nodemailer SMTP transporter from config.email.
 * Returns null when email is disabled, credentials are missing, or nodemailer
 * is not installed.
 */
const getTransporter = async (onLog = noopLog) => {
  if (!config.email.enabled) return null;
  if (!config.email.host || !config.email.user || !config.email.pass) {
    onLog("warn", "Email enabled but EMAIL_HOST/EMAIL_USER/EMAIL_PASS incomplete — skipping email");
    return null;
  }
  if (_transporter) return _transporter;

  let nodemailer;
  try {
    nodemailer = (await import("nodemailer")).default;
  } catch {
    onLog(
      "warn",
      "Email enabled but 'nodemailer' is not installed — run `npm install nodemailer`. Skipping email.",
    );
    return null;
  }

  _transporter = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: { user: config.email.user, pass: config.email.pass },
  });
  return _transporter;
};

/**
 * Send the "LTA READY" notification email.
 *
 * Subject:  MAWB {ltaRef} ({dumCount} DUM)     e.g. "MAWB 157-53611950 (15 DUM)"
 * Body:     empty
 * Attach:   every signed PDF for the LTA.
 *
 * @returns {Promise<boolean>} true if the email was actually sent.
 */
export const sendLtaReadyEmail = async ({ ltaRef, dumCount, pdfPaths, onLog = noopLog }) => {
  const transporter = await getTransporter(onLog);
  if (!transporter) return false;

  // Keep only attachments that really exist on disk.
  const attachments = [];
  for (const p of pdfPaths || []) {
    if (p && (await fs.pathExists(p))) {
      attachments.push({ filename: path.basename(p), path: p });
    }
  }

  if (attachments.length === 0) {
    onLog("warn", `Email skipped for LTA ${ltaRef}: no PDF attachments found on disk`);
    return false;
  }

  const subject = `MAWB ${ltaRef} (${dumCount} DUM)`;

  try {
    await transporter.sendMail({
      from: config.email.from,
      to: config.email.to,
      cc: config.email.cc,
      subject,
      text: "",
      attachments,
    });
    onLog(
      "info",
      `📧 Email sent for LTA ${ltaRef} — "${subject}" (${attachments.length} PDF attached) to ${config.email.to.length} recipient(s)`,
    );
    return true;
  } catch (err) {
    onLog("error", `📧 Email FAILED for LTA ${ltaRef}: ${err.message}`);
    return false;
  }
};

// ── Failure notification state ───────────────────────────────────────────────
// The live BADR connection, so ANY failure path (chrono timeout, job crash,
// SIGINT) can grab a screenshot of whatever is currently on screen. We store the
// connection (not the page) because `conn.page` is swapped during reprint popups.
let _activeConn = null;
// The LTA currently being processed — lets job-level/process-level failures
// build the "Signature Failed LTA N°{ref} ({n} DUM)" subject.
let _currentLta = null;
// LTAs already notified this run, so a chrono timeout followed by a PROBLEM
// finish doesn't send two failure emails for the same LTA.
const _failureNotified = new Set();

export const setActiveConnection = (conn) => {
  _activeConn = conn;
};
export const setCurrentLta = (ltaRef, dumCount) => {
  _currentLta = ltaRef ? { ltaRef, dumCount } : null;
};
export const clearCurrentLta = () => {
  _currentLta = null;
};
export const getCurrentLta = () => _currentLta;
export const resetFailureNotifications = () => {
  _failureNotified.clear();
};

/**
 * Screenshot whatever the BADR browser is currently showing.
 * Returns the PNG path, or null if no live page (e.g. browser was closed).
 */
export const captureScreenshot = async (label, onLog = noopLog) => {
  const page = _activeConn?.page;
  if (!page) return null;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) {
      onLog("warn", "Screenshot skipped: browser page is already closed");
      return null;
    }
    const shotDir = path.join(config.directories.logs, "screenshots");
    await fs.ensureDir(shotDir);
    const safe = String(label || "failure")
      .replace(/[^a-zA-Z0-9_-]+/g, "_")
      .slice(0, 60);
    const file = path.join(shotDir, `${safe}-${Date.now()}.png`);
    await page.screenshot({ path: file, timeout: 15000 });
    return file;
  } catch (err) {
    // Browser closed / crashed / detached — expected in several failure modes.
    onLog("warn", `Screenshot unavailable: ${err.message}`);
    return null;
  }
};

/**
 * Send the "Signature Failed" email with a screenshot of the current interface.
 *
 * Subject: Signature Failed LTA N°{ref} ({n} DUM)
 * Body:    the screenshot, inline (plus the failure reason).
 *
 * @returns {Promise<boolean>} true if the email was actually sent.
 */
export const sendLtaFailedEmail = async ({
  ltaRef,
  dumCount,
  reason,
  screenshotPath,
  onLog = noopLog,
}) => {
  const transporter = await getTransporter(onLog);
  if (!transporter) return false;

  const subject = `Signature Failed LTA N°${ltaRef} (${dumCount} DUM)`;
  const attachments = [];
  let html = `<p>${reason || "Signing did not complete."}</p>`;

  if (screenshotPath && (await fs.pathExists(screenshotPath))) {
    attachments.push({
      filename: path.basename(screenshotPath),
      path: screenshotPath,
      cid: "badrscreen",
    });
    html += `<p><img src="cid:badrscreen" alt="BADR screen" style="max-width:100%;border:1px solid #ccc"/></p>`;
  } else {
    html += `<p><i>(No screenshot available — the browser was closed or unreachable.)</i></p>`;
  }

  try {
    await transporter.sendMail({
      from: config.email.from,
      to: config.email.to,
      cc: config.email.cc,
      subject,
      html,
      attachments,
    });
    onLog(
      "info",
      `📧 Failure email sent — "${subject}"${attachments.length ? " (screenshot attached)" : " (no screenshot)"}`,
    );
    return true;
  } catch (err) {
    onLog("error", `📧 Failure email FAILED for LTA ${ltaRef}: ${err.message}`);
    return false;
  }
};

/**
 * One-stop failure notifier: screenshot + "Signature Failed" email, deduped so
 * each LTA raises at most one failure email per run. Falls back to the current
 * LTA when the caller doesn't know it (job crash, process stop).
 * Never throws — notification problems must not break automation.
 */
export const notifyLtaFailure = async ({
  ltaRef,
  dumCount,
  reason,
  onLog = noopLog,
}) => {
  try {
    const ref = ltaRef || _currentLta?.ltaRef;
    const count = dumCount ?? _currentLta?.dumCount ?? 0;
    if (!ref) {
      onLog("warn", `📧 Failure email skipped: no LTA in progress (${reason})`);
      return false;
    }
    if (_failureNotified.has(ref)) {
      onLog("info", `📧 Failure email already sent for LTA ${ref} — skipping`);
      return false;
    }
    if (!config.email.enabled) {
      onLog(
        "warn",
        `📧 Failure email NOT sent for LTA ${ref}: email disabled (set EMAIL_ENABLED=true / re-enable in config.js)`,
      );
      return false;
    }
    _failureNotified.add(ref);
    const shot = await captureScreenshot(`failed-${ref}`, onLog);
    return await sendLtaFailedEmail({
      ltaRef: ref,
      dumCount: count,
      reason,
      screenshotPath: shot,
      onLog,
    });
  } catch (err) {
    onLog("error", `📧 Failure notification error: ${err.message}`);
    return false;
  }
};

/**
 * Send a WhatsApp notification to the configured personal number.
 * Currently uses CallMeBot (free, text-only, self-notifications).
 *
 * @returns {Promise<boolean>} true if the message was accepted by the provider.
 */
export const sendWhatsApp = async (message, onLog = noopLog) => {
  if (!config.whatsapp.enabled) return false;

  const provider = String(config.whatsapp.provider || "callmebot").toLowerCase();
  if (provider !== "callmebot") {
    onLog("warn", `WhatsApp provider "${provider}" not implemented — only "callmebot" is supported`);
    return false;
  }

  if (!config.whatsapp.phone || !config.whatsapp.callmebotApiKey) {
    onLog(
      "warn",
      "WhatsApp enabled but WHATSAPP_PHONE / WHATSAPP_CALLMEBOT_APIKEY missing — skipping WhatsApp",
    );
    return false;
  }

  const url =
    `https://api.callmebot.com/whatsapp.php` +
    `?phone=${encodeURIComponent(config.whatsapp.phone)}` +
    `&text=${encodeURIComponent(message)}` +
    `&apikey=${encodeURIComponent(config.whatsapp.callmebotApiKey)}`;

  try {
    const res = await fetch(url, { method: "GET" });
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      onLog("error", `📱 WhatsApp FAILED (HTTP ${res.status}): ${body.slice(0, 200)}`);
      return false;
    }
    onLog("info", `📱 WhatsApp sent: ${message}`);
    return true;
  } catch (err) {
    onLog("error", `📱 WhatsApp FAILED: ${err.message}`);
    return false;
  }
};
