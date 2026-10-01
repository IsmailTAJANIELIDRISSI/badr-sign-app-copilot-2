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
  // Recipients come only from .env — refuse to send to nobody, and say so.
  if (!config.email.to.length) {
    onLog(
      "warn",
      "Email enabled but EMAIL_TO is empty — set EMAIL_TO in .env (see .env.example). Skipping email.",
    );
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

const MB = 1024 * 1024;
const toMb = (bytes) => (bytes / MB).toFixed(1);

/**
 * Pack attachments, in order, into groups whose total size stays under
 * `maxBytes`. A single file bigger than the budget gets a group of its own.
 */
export const splitAttachmentsBySize = (attachments, maxBytes) => {
  const parts = [];
  let current = [];
  let currentBytes = 0;
  for (const att of attachments) {
    if (current.length && currentBytes + att.size > maxBytes) {
      parts.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(att);
    currentBytes += att.size;
  }
  if (current.length) parts.push(current);
  return parts;
};

/**
 * Send the "LTA READY" notification email.
 *
 * Subject:  MAWB {ltaRef} ({dumCount} DUM)     e.g. "MAWB 157-53611950 (15 DUM)"
 * Body:     empty
 * Attach:   every signed PDF for the LTA.
 *
 * SMTP servers cap the message size (Gmail: ~25 MB of attachments) and answer
 * "552 5.3.4 message exceeded size limits" above it. So when the PDFs total more
 * than config.email.maxAttachMb the LTA goes out as several emails, subject
 * suffixed "[1/N]" ... "[N/N]". Each part that is sent leaves a marker file in
 * the LTA folder, so a re-run after a partial failure only sends what is missing.
 *
 * @returns {Promise<boolean>} true if the email (every part of it) was sent.
 */
export const sendLtaReadyEmail = async ({ ltaRef, dumCount, pdfPaths, onLog = noopLog }) => {
  const transporter = await getTransporter(onLog);
  if (!transporter) return false;

  // Keep only attachments that really exist on disk.
  const attachments = [];
  for (const p of pdfPaths || []) {
    if (p && (await fs.pathExists(p))) {
      const { size } = await fs.stat(p);
      attachments.push({ filename: path.basename(p), path: p, size });
    }
  }

  if (attachments.length === 0) {
    onLog("warn", `Email skipped for LTA ${ltaRef}: no PDF attachments found on disk`);
    return false;
  }

  const baseSubject = `MAWB ${ltaRef} (${dumCount} DUM)`;
  const maxBytes = config.email.maxAttachMb * MB;
  const totalBytes = attachments.reduce((sum, a) => sum + a.size, 0);
  const parts = splitAttachmentsBySize(attachments, maxBytes);
  const isSplit = parts.length > 1;
  const folder = path.dirname(attachments[0].path);

  if (isSplit) {
    onLog(
      "info",
      `📧 LTA ${ltaRef}: ${attachments.length} PDF = ${toMb(totalBytes)} MB, over the ${config.email.maxAttachMb} MB per-email limit — sending as ${parts.length} emails`,
    );
  }

  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    const partBytes = part.reduce((sum, a) => sum + a.size, 0);
    const label = `${i + 1}/${parts.length}`;
    const subject = isSplit ? `${baseSubject} [${label}]` : baseSubject;
    const partMarker = path.join(folder, `.email_sent_part_${i + 1}of${parts.length}`);

    if (isSplit && (await fs.pathExists(partMarker))) {
      onLog("info", `📧 Email part ${label} for LTA ${ltaRef} already sent previously — skipping`);
      continue;
    }
    if (partBytes > maxBytes) {
      onLog(
        "warn",
        `📧 "${part[0].filename}" alone is ${toMb(partBytes)} MB, over the ${config.email.maxAttachMb} MB per-email limit — the mail server may refuse it`,
      );
    }

    try {
      await transporter.sendMail({
        from: config.email.from,
        to: config.email.to,
        cc: config.email.cc,
        subject,
        text: isSplit
          ? `Partie ${label} — ${part.length} PDF sur ${attachments.length} (de « ${part[0].filename} » à « ${part[part.length - 1].filename} »).`
          : "",
        attachments: part.map(({ filename, path: filePath }) => ({ filename, path: filePath })),
      });
      onLog(
        "info",
        `📧 Email sent for LTA ${ltaRef} — "${subject}" (${part.length} PDF attached, ${toMb(partBytes)} MB) to ${config.email.to.length} recipient(s)`,
      );
      if (isSplit) {
        await fs.writeFile(partMarker, new Date().toISOString()).catch(() => {});
      }
    } catch (err) {
      const tooBig = err.responseCode === 552 || /5\.3\.4|size limit/i.test(err.message);
      onLog(
        "error",
        `📧 Email FAILED for LTA ${ltaRef}${isSplit ? ` (part ${label})` : ""}: ${err.message}` +
          (tooBig
            ? ` — message too big for the mail server (${toMb(partBytes)} MB of PDFs); lower EMAIL_MAX_ATTACH_MB in .env and re-run`
            : ""),
      );
      return false;
    }
  }
  return true;
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

const shotPath = async (label, suffix) => {
  const shotDir = path.join(config.directories.logs, "screenshots");
  await fs.ensureDir(shotDir);
  const safe = String(label || "failure")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .slice(0, 60);
  return path.join(shotDir, `${safe}-${suffix}-${Date.now()}.png`);
};

/** Screenshot the BADR page. Null if the page/browser is gone. */
const captureBrowserScreenshot = async (label, onLog) => {
  const page = _activeConn?.page;
  if (!page) return null;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return null;
    const file = await shotPath(label, "browser");
    await page.screenshot({ path: file, timeout: 15000 });
    return file;
  } catch {
    // Browser closed / crashed / detached — caller falls back to the desktop.
    return null;
  }
};

/**
 * Screenshot the whole Windows desktop — the fallback for when the browser is
 * gone and a page screenshot is impossible, so we can still see what was on
 * screen (an error dialog, a crash, the closed window, ...).
 *
 * Uses PowerShell + .NET System.Drawing, which ship with Windows — deliberately
 * no npm package, so nothing extra has to be installed on each machine.
 * Captures the full virtual screen (all monitors).
 *
 * Caveat: needs an interactive, unlocked desktop session. A locked workstation
 * or a service-mode run yields a black image.
 */
const captureDesktopScreenshot = async (label, onLog) => {
  if (process.platform !== "win32") return null;
  try {
    const file = await shotPath(label, "desktop");
    const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b   = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$bmp.Save(${JSON.stringify(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()`;

    const { execFile } = await import("child_process");
    await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", ps],
        { timeout: 20000, windowsHide: true },
        (err) => (err ? reject(err) : resolve()),
      );
    });

    if (await fs.pathExists(file)) return file;
    return null;
  } catch (err) {
    onLog("warn", `Desktop screenshot failed: ${err.message}`);
    return null;
  }
};

/**
 * Best available screenshot: the BADR page if the browser is alive, otherwise
 * the desktop. Returns { path, source: "browser"|"desktop" } or null.
 */
export const captureScreenshot = async (label, onLog = noopLog) => {
  const browserShot = await captureBrowserScreenshot(label, onLog);
  if (browserShot) return { path: browserShot, source: "browser" };

  onLog(
    "warn",
    "Browser screenshot unavailable (page/browser closed) — capturing the desktop instead",
  );
  const desktopShot = await captureDesktopScreenshot(label, onLog);
  if (desktopShot) {
    onLog("info", "📸 Desktop screenshot captured");
    return { path: desktopShot, source: "desktop" };
  }
  return null;
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
  screenshotSource,
  onLog = noopLog,
}) => {
  const transporter = await getTransporter(onLog);
  if (!transporter) return false;

  const subject = `Signature Failed LTA N°${ltaRef} (${dumCount} DUM)`;
  const attachments = [];
  let html = `<p>${reason || "Signing did not complete."}</p>`;

  if (screenshotPath && (await fs.pathExists(screenshotPath))) {
    const isDesktop = screenshotSource === "desktop";
    const caption = isDesktop
      ? "Desktop at the time of failure (the browser was closed, so the BADR page could not be captured):"
      : "BADR screen at the time of failure:";
    attachments.push({
      filename: path.basename(screenshotPath),
      path: screenshotPath,
      cid: "badrscreen",
    });
    html +=
      `<p>${caption}</p>` +
      `<p><img src="cid:badrscreen" alt="${isDesktop ? "Desktop" : "BADR screen"}" style="max-width:100%;border:1px solid #ccc"/></p>`;
  } else {
    html += `<p><i>(No screenshot available — the browser was closed and the desktop could not be captured either; the session may be locked.)</i></p>`;
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
      screenshotPath: shot?.path,
      screenshotSource: shot?.source,
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
