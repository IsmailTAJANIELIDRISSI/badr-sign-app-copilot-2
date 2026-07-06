import path from "path";
import fs from "fs-extra";
import nodemailer from "nodemailer";
import { config } from "./config.js";

// A no-op logger so callers may omit onLog.
const noopLog = () => {};

let _transporter = null;

/**
 * Lazily build (and cache) the nodemailer SMTP transporter from config.email.
 * Returns null when email is disabled or credentials are missing.
 */
const getTransporter = (onLog = noopLog) => {
  if (!config.email.enabled) return null;
  if (!config.email.host || !config.email.user || !config.email.pass) {
    onLog("warn", "Email enabled but EMAIL_HOST/EMAIL_USER/EMAIL_PASS incomplete — skipping email");
    return null;
  }
  if (_transporter) return _transporter;
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
  const transporter = getTransporter(onLog);
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
