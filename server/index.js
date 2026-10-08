import path from "path";
import fs from "fs-extra";
import express from "express";
import cors from "cors";
import { v4 as uuidv4 } from "uuid";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { parseLtaExcel } from "./excelParser.js";
import { createJob, pushJobLog, state } from "./state.js";
import { runSigningJob } from "./automation.js";
import { sendWhatsApp, notifyLtaFailure } from "./notifications.js";

await fs.ensureDir(config.directories.dums);
await fs.ensureDir(config.directories.outputs);
await fs.ensureDir(config.directories.logs);
await fs.ensureDir(config.directories.signedLtas);

const app = express();
app.use(cors());
app.use(express.json({ limit: "4mb" }));

const allowedExcel = new Set([".xlsx", ".xls", ".xlsm"]);

const scanDumFiles = async () => {
  const entries = await fs.readdir(config.directories.dums, {
    withFileTypes: true,
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(config.directories.dums, entry.name))
    .filter((filePath) =>
      allowedExcel.has(path.extname(filePath).toLowerCase()),
    );

  const parsed = [];
  for (const filePath of files) {
    try {
      parsed.push(parseLtaExcel(filePath));
    } catch (error) {
      logger.warn(
        { filePath, error: error.message },
        "Skipping invalid LTA Excel file",
      );
    }
  }

  state.ltaFiles = parsed;
  return parsed;
};

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/config", (_req, res) => {
  res.json({
    dumsFolder: config.directories.dums,
    outputsFolder: config.directories.outputs,
    isElectron: config.isElectron,
  });
});

// Output-folder status for an LTA after signing: "problem" if a
// "LTA N° <ref> PROBLEM" folder exists, "ready" if a "… READY" folder exists,
// else "". Lets the UI flag PROBLEM LTAs (red card) before they're emailed.
const getOutputStatus = async (ltaRef) => {
  const base = path.resolve(config.directories.signedLtas);
  if (await fs.pathExists(path.join(base, `LTA N° ${ltaRef} PROBLEM`)))
    return "problem";
  if (await fs.pathExists(path.join(base, `LTA N° ${ltaRef} READY`)))
    return "ready";
  return "";
};

app.get("/api/lta-files", async (_req, res) => {
  const parsed = await scanDumFiles();

  // Auto-persist Excel H1 shipper names to JSON for any LTA not yet saved by the user.
  if (parsed.some((item) => item.shipperName)) {
    const shippers = await loadShippers();
    let dirty = false;
    for (const item of parsed) {
      if (!item.shipperName) continue;
      const alreadySaved =
        shippers.byLtaRef[item.ltaRef] || shippers.byFileName[item.fileName];
      if (!alreadySaved) {
        shippers.byLtaRef[item.ltaRef] = item.shipperName;
        shippers.byFileName[item.fileName] = item.shipperName;
        dirty = true;
      }
    }
    if (dirty) await saveShippers(shippers);
  }

  const statuses = await Promise.all(
    parsed.map((item) => getOutputStatus(item.ltaRef)),
  );

  res.json(
    parsed.map((item, i) => ({
      fileName: item.fileName,
      filePath: path.resolve(item.filePath),
      ltaRef: item.ltaRef,
      dumsCount: item.dums.length,
      totalDums: item.totalDums,
      validDums: item.validDums,
      invalidDums: item.invalidDums,
      shipperName: item.shipperName || "",
      outputStatus: statuses[i],
      dums: item.dums,
    })),
  );
});

app.post("/api/jobs/run", async (req, res) => {
  const { shipperByFileName = {}, fileNames = [] } = req.body || {};

  const parsed = state.ltaFiles.length ? state.ltaFiles : await scanDumFiles();
  // Preserve the user-supplied fileNames order (priority order).
  const filtered = fileNames.length
    ? fileNames
        .map((fn) => parsed.find((item) => item.fileName === fn))
        .filter(Boolean)
    : parsed;

  const jobId = uuidv4();
  const job = createJob(jobId);
  job.progress.total = filtered.reduce(
    (sum, item) => sum + item.dums.length,
    0,
  );

  res.json({ jobId });

  (async () => {
    try {
      const results = await runSigningJob({
        parsedLtas: filtered,
        shipperByFileName,
        onLog: (level, message, meta) => {
          pushJobLog(jobId, level, message, meta);
          logger.info({ jobId, level, meta }, message);
        },
      });

      job.results = results;
      job.progress.done = results.length;
      job.progress.success = results.filter(
        (r) => r.status === "success",
      ).length;
      job.progress.skipped = results.filter(
        (r) => r.status === "skipped",
      ).length;
      job.progress.failed = results.filter((r) => r.status === "failed").length;
      job.status = "done";
      job.completedAt = new Date().toISOString();
      pushJobLog(jobId, "info", "Job completed", {
        total: job.progress.total,
        success: job.progress.success,
        skipped: job.progress.skipped,
        failed: job.progress.failed,
      });
    } catch (error) {
      pushJobLog(jobId, "error", "Job failed", { error: error.message });
      job.status = "failed";
      job.completedAt = new Date().toISOString();
      // Notify: the whole signing process errored out / was interrupted
      // (BADR crash, browser closed mid-run, unexpected exception, ...).
      const jobLog = (level, message) => pushJobLog(jobId, level, message);
      await sendWhatsApp(
        `❌ PROBLEM - Signing process stopped with an error: ${error.message}. ` +
          `Please check the app.`,
        jobLog,
      ).catch(() => {});
      await notifyLtaFailure({
        reason: `Signing process stopped with an error: ${error.message}`,
        onLog: jobLog,
      }).catch(() => {});
    }
  })();
});

app.get("/api/jobs/:id", (req, res) => {
  const job = state.jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

app.get("/api/outputs", async (_req, res) => {
  const entries = await fs.readdir(config.directories.outputs, {
    withFileTypes: true,
  });
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  res.json({ folders });
});

// Shipper name persistence
const shippersFile = path.join(config.directories.outputs, ".shippers.json");

const loadShippers = async () => {
  try {
    if (await fs.pathExists(shippersFile)) {
      const raw = await fs.readJson(shippersFile);
      // New format
      if (raw && (raw.byFileName || raw.byLtaRef)) {
        return {
          byFileName: raw.byFileName || {},
          byLtaRef: raw.byLtaRef || {},
        };
      }
      // Legacy flat map format: { "file.xlsx": "SHIPPER" }
      if (raw && typeof raw === "object") {
        return {
          byFileName: raw,
          byLtaRef: {},
        };
      }
    }
  } catch (e) {
    logger.warn({ error: e.message }, "Could not load shippers.json");
  }
  return { byFileName: {}, byLtaRef: {} };
};

const saveShippers = async (shippers) => {
  try {
    await fs.ensureDir(path.dirname(shippersFile));
    await fs.writeJson(shippersFile, shippers, { spaces: 2 });
  } catch (e) {
    logger.error({ error: e.message }, "Could not save shippers.json");
  }
};

app.get("/api/shippers", async (_req, res) => {
  const shippers = await loadShippers();
  res.json(shippers);
});

app.post("/api/shippers", express.json(), async (req, res) => {
  const { fileName, ltaRef, shipperName = "" } = req.body;

  if (!fileName && !ltaRef) {
    return res.status(400).json({ error: "Missing fileName and ltaRef" });
  }

  try {
    const shippers = await loadShippers();
    const value = String(shipperName).trim();

    if (value) {
      if (fileName) shippers.byFileName[fileName] = value;
      if (ltaRef) shippers.byLtaRef[ltaRef] = value;
    } else {
      if (fileName) delete shippers.byFileName[fileName];
      if (ltaRef) delete shippers.byLtaRef[ltaRef];
    }

    await saveShippers(shippers);
    logger.info({ fileName, ltaRef, shipperName: value }, "Saved shipper name");
    res.json({ success: true, fileName, ltaRef, shipperName: value });
  } catch (error) {
    logger.error({ error: error.message }, "Failed to save shipper");
    res.status(500).json({ error: error.message });
  }
});

// ── "Envoyer par email" — open an Outlook draft with the LTA's PDFs attached ──
//
// mailto: links can't carry attachments, so on Windows we drive classic Outlook
// via COM (PowerShell) to build a real draft: To + Subject + every DUM PDF
// attached, empty body, shown (not sent) for the user to review and send.

// Find the LTA output folder (READY / PROBLEM / plain) and its signed PDFs.
// Paths are ABSOLUTE (path.resolve): config.directories.signedLtas can be
// relative ("./outputs"), and Outlook's Attachments.Add resolves a relative
// path against its own working dir — not ours — so it fails with "path does
// not exist". Absolute paths are the only reliable input to COM/PowerShell.
const findLtaPdfs = async (ltaRef) => {
  const base = path.resolve(config.directories.signedLtas);
  for (const suffix of [" READY", " PROBLEM", ""]) {
    const folder = path.join(base, `LTA N° ${ltaRef}${suffix}`);
    if (!(await fs.pathExists(folder))) continue;
    const entries = await fs.readdir(folder);
    const pdfs = entries
      .filter((n) => /^DUM \d+ LTA .*\.pdf$/i.test(n))
      .sort((a, b) => {
        const na = Number(a.match(/DUM (\d+)/)?.[1] ?? 0);
        const nb = Number(b.match(/DUM (\d+)/)?.[1] ?? 0);
        return na - nb;
      })
      .map((n) => path.resolve(folder, n));
    if (pdfs.length) return { folder, pdfs };
  }
  return { folder: null, pdfs: [] };
};

// Single-quote a value for safe embedding in a PowerShell script.
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

// mailto path (new Outlook): how long to wait for the draft window to come to
// the front before giving up on the automatic Ctrl+V of the PDFs.
const MAILTO_PASTE_WAIT_SEC = Math.max(
  0,
  Number.parseInt(process.env.MAILTO_PASTE_WAIT_SEC || "20", 10) || 0,
);

app.post("/api/lta/outlook-email", async (req, res) => {
  // mode "new" = the user works in the NEW Outlook (chosen in the app, per
  // device): skip classic-Outlook COM entirely and go straight to the mailto +
  // clipboard path, which opens the default mail app (the new Outlook, if it is
  // the Windows default for e-mail). Otherwise COM first, as before.
  const { ltaRef, dumsCount, mode } = req.body || {};
  const useCom = mode !== "new";
  if (!ltaRef) {
    res.status(400).json({ ok: false, reason: "ltaRef is required" });
    return;
  }
  if (process.platform !== "win32") {
    res.status(400).json({
      ok: false,
      reason: "Outlook drafting is only available on Windows",
    });
    return;
  }

  try {
    const { folder, pdfs } = await findLtaPdfs(ltaRef);
    if (!pdfs.length) {
      res.status(404).json({
        ok: false,
        reason: `No signed PDFs found for LTA ${ltaRef} yet — sign it first.`,
      });
      return;
    }

    const to = config.outlookTo.join("; ");
    // Bare addresses (strip the "Name <…>" wrapper) for the mailto: fallback.
    // Joined with ";" — Outlook separates recipients by semicolons, and a
    // comma-joined list gets treated as a single malformed address.
    const mailtoTo = config.outlookTo
      .map((s) => (s.match(/<([^>]+)>/)?.[1] || s).trim())
      .join(";");
    const subject = `MAWB ${ltaRef} - (${dumsCount ?? pdfs.length} DUM)`;
    const filesArray = `@(${pdfs.map(psq).join(",")})`;

    // Universal open-in-mail script. Written as UTF-16LE with a BOM (see below)
    // so the "°" in "LTA N° …" paths and accented names survive the Node → temp
    // .ps1 → PowerShell handoff — a UTF-8 file was being misread on some
    // machines' code pages, corrupting "°" and making Attachments.Add fail with
    // "Ce chemin d'accès n'existe pas" (path not found).
    //
    //  1. Try classic Outlook via COM → opens a draft with the PDFs already
    //     attached (best UX, zero extra clicks).  METHOD=com
    //     Skipped when the app is set to the NEW Outlook (mode "new").
    //  2. If COM is skipped or unavailable (NEW Outlook / web has no COM, or a
    //     different elevation blocks it) → copy the PDFs to the clipboard as
    //     files AND open the default mail app's compose via mailto:. The user
    //     clicks in the message and presses Ctrl+V to attach.  METHOD=clipboard
    const script = `$ErrorActionPreference = 'Stop'
$files = ${filesArray}
$useCom = ${useCom ? "$true" : "$false"}
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$opened = $false
if ($useCom) {
  try {
    $ol = New-Object -ComObject Outlook.Application
    $mail = $ol.CreateItem(0)
    $mail.To = ${psq(to)}
    $mail.Subject = ${psq(subject)}
    $mail.Body = ''
    foreach ($f in $files) { if (Test-Path -LiteralPath $f) { [void]$mail.Attachments.Add($f) } }
    $mail.Display($false)
    # Bring the draft window to the foreground instead of opening it behind the app.
    $insp = $mail.GetInspector
    $insp.Activate()
    Write-Output 'METHOD=com'
    $opened = $true
  } catch {
    Write-Output ('COMERR=' + ($_.Exception.Message -replace "\\r?\\n"," "))
  }
}
if (-not $opened) {
  try { Set-Clipboard -LiteralPath $files } catch {}
  $subject = ${psq(subject)}
  $uri = 'mailto:' + ${psq(mailtoTo)} + '?subject=' + [uri]::EscapeDataString($subject)
  Start-Process $uri
  Write-Output 'METHOD=clipboard'
  Write-Output ('ELEVATED=' + $isAdmin)

  # Auto-paste: the new Outlook can't be given attachments by another program,
  # but it attaches files pasted into a message. Its compose window is titled
  # with the subject (unique per LTA), so: wait until THAT window is in front,
  # give it time to finish loading (the cursor lands in the body), then press
  # Ctrl+V. Never pastes unless the front window is this draft.
  $pasted = 'nowindow'
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class BadrFg {
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static string Title() { var sb = new StringBuilder(512); GetWindowText(GetForegroundWindow(), sb, 512); return sb.ToString(); }
}
"@
    $wsh = New-Object -ComObject WScript.Shell
    $pattern = '*' + [Management.Automation.WildcardPattern]::Escape($subject) + '*'
    $deadline = (Get-Date).AddSeconds(${MAILTO_PASTE_WAIT_SEC})
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
      if ([BadrFg]::Title() -like $pattern) {
        Start-Sleep -Milliseconds 2000
        if ([BadrFg]::Title() -like $pattern) {
          [System.Windows.Forms.SendKeys]::SendWait('^v')
          $pasted = 'sent'
        } else {
          $pasted = 'lostfocus'
        }
        break
      }
      # The draft exists but opened behind another window: bring it forward.
      try { [void]$wsh.AppActivate($subject) } catch {}
    }
  } catch {
    $pasted = 'error'
    Write-Output ('PASTEERR=' + ($_.Exception.Message -replace "\\r?\\n"," "))
  }
  Write-Output ('PASTE=' + $pasted)
}
`;

    const os = await import("os");
    const scriptPath = path.join(
      os.tmpdir(),
      `badr-outlook-${ltaRef}-${Date.now()}.ps1`,
    );
    // UTF-16LE + BOM ("﻿"): the encoding Windows PowerShell reads natively.
    // This is what makes the "°" and accented paths survive intact.
    await fs.writeFile(scriptPath, "﻿" + script, "utf16le");

    const { execFile } = await import("child_process");
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
      // 40 s for Outlook itself + the auto-paste wait (mailto path).
      { timeout: 40000 + MAILTO_PASTE_WAIT_SEC * 1000, windowsHide: true },
      (err, stdout, stderr) => {
        fs.remove(scriptPath).catch(() => {});
        const out = String(stdout || "");
        if (err && !out.includes("METHOD=")) {
          logger.warn(
            { ltaRef, err: err.message, stderr },
            "Outlook draft failed",
          );
          res.status(500).json({
            ok: false,
            reason:
              "Could not open a mail draft. No default mail app configured? " +
              (stderr || err.message || "").slice(0, 300),
            folder,
            count: pdfs.length,
          });
          return;
        }
        const method = out.includes("METHOD=com") ? "com" : "clipboard";
        const comErr = out.match(/COMERR=(.*)/)?.[1]?.trim();
        const elevated = /ELEVATED=True/i.test(out);
        // mailto path: did the app press Ctrl+V in the draft? "sent" | "nowindow"
        // (draft never came to the front) | "lostfocus" | "error" | null (COM).
        const pasted = out.match(/^PASTE=(\w+)/m)?.[1] || null;
        const pasteErr = out.match(/PASTEERR=(.*)/)?.[1]?.trim();
        logger.info(
          { ltaRef, count: pdfs.length, method, mode: useCom ? "classic" : "new", pasted, pasteErr, comErr, elevated },
          "Mail draft opened",
        );
        res.json({
          ok: true,
          count: pdfs.length,
          subject,
          folder,
          method,
          mode: useCom ? "classic" : "new",
          pasted,
          comErr,
          elevated,
        });
      },
    );
  } catch (error) {
    logger.error({ ltaRef, error: error.message }, "outlook-email failed");
    res.status(500).json({ ok: false, reason: error.message });
  }
});

// ── Fetch DUM .xlsx from the Outlook inbox by LTA ref ──────────────────────
// Classic-Outlook-only (COM), no SMTP/IMAP/Graph. The NEW Outlook has no COM;
// COM then drives the (still installed) classic Outlook, whose local copy of
// the mailbox only syncs while classic runs — see INBOX_SYNC_WAIT_SEC. For each ref, search the
// default Inbox for a mail whose sender SMTP == INBOX_SENDER and whose subject
// contains the ref, then save each .xlsx attachment into the dums input folder
// so the app auto-detects the LTA. Paths are absolute (same reason as the email
// feature — Outlook resolves relative paths against its own dir).
const INBOX_SENDER =
  process.env.INBOX_SENDER_EMAIL || "tajanielidrissi.ismail@gmail.com";
// Which Outlook account's Inbox to search. Matched against each account's SMTP
// by exact-equals OR endsWith, so "@medafrica-log.com" targets that account on
// any machine regardless of the exact local part. Override with a full address.
const INBOX_ACCOUNT =
  process.env.INBOX_ACCOUNT_EMAIL || "@medafrica-log.com";
// The completion email's subject keyword. The right email (the one carrying the
// generated .xlsx) always says "LTA Complet"; forwards keep it too. We match on
// this instead of the sender, because in the target mailbox the email usually
// arrives as a colleague's forward, not directly from the gmail.
const SUBJECT_KEYWORD = (
  process.env.INBOX_SUBJECT_KEYWORD || "complet"
).toLowerCase();
// COM only reaches CLASSIC Outlook's local copy of the mailbox. When the user
// works in the NEW Outlook, classic isn't running, so that copy stops syncing:
// COM starts classic in the background and would search a stale inbox at once.
// In that case (classic was not already running) and only if some refs are
// missing, keep re-searching for up to this many seconds while classic syncs.
const INBOX_SYNC_WAIT_SEC = Number.parseInt(
  process.env.INBOX_SYNC_WAIT_SEC || "45",
  10,
);

app.post("/api/lta/fetch-xlsx", async (req, res) => {
  const refs = Array.isArray(req.body?.refs)
    ? [...new Set(req.body.refs.map((r) => String(r).trim()).filter(Boolean))]
    : [];
  try {
    if (!refs.length) {
      res.status(400).json({ ok: false, reason: "No LTA refs provided." });
      return;
    }
    const dest = path.resolve(config.directories.dums);
    await fs.ensureDir(dest);

    const refsArray = `@(${refs.map(psq).join(",")})`;
    // PR_SENDER_SMTP_ADDRESS — the reliable SMTP of the sender (gmail), even
    // when Outlook stores an Exchange DN in SenderEmailAddress. [char]34/39 are
    // " and ' so the DASL filter string doesn't fight the surrounding quotes.
    const script = `$ErrorActionPreference = 'Stop'
$dest = ${psq(dest)}
$sender = ${psq(INBOX_SENDER)}.ToLower()
$acctMatch = ${psq(INBOX_ACCOUNT)}.ToLower()
$keyword = ${psq(SUBJECT_KEYWORD)}
$refs = ${refsArray}
$syncWaitSec = ${Math.max(0, INBOX_SYNC_WAIT_SEC) || 0}
$PR_SMTP = 'http://schemas.microsoft.com/mapi/proptag/0x5D01001F'

# Newest mail in the Inbox, as seen by classic Outlook. If it is hours/days old,
# classic Outlook's local copy is not up to date (typical with the new Outlook).
function Get-InboxNewest($inbox) {
  try {
    $all = $inbox.Items
    $all.Sort('[ReceivedTime]', $true)
    $first = $all.GetFirst()
    if ($first) { return $first.ReceivedTime.ToString('yyyy-MM-dd HH:mm') }
  } catch {}
  return ''
}

# Best mail for a ref: subject contains the ref AND the keyword ("complet") AND
# the mail carries an .xlsx whose name contains the ref. Sender is NOT a filter
# (the email often arrives as a colleague's forward) — but if Ismail's original
# copy is present we prefer it over a forward. $verbose = log the candidates.
# The result goes in $script:found, NOT a return value: the DEBUG lines are
# function output, so returning would mix them into the assigned value.
function Find-RefMail($inbox, $ref, $verbose) {
  $script:found = $null
  $safe = $ref -replace "'","''"
  $filter = '@SQL=' + [char]34 + 'urn:schemas:httpmail:subject' + [char]34 + ' LIKE ' + [char]39 + '%' + $safe + '%' + [char]39
  $usedRestrict = $true
  try { $items = $inbox.Items.Restrict($filter) } catch { $items = $inbox.Items; $usedRestrict = $false }
  try { $items.Sort('[ReceivedTime]', $true) } catch {}
  $matchCount = 0
  try { $matchCount = $items.Count } catch {}
  if ($verbose) { Write-Output ('DEBUG=[' + $ref + '] subject-restrict matched=' + $matchCount + ' restrictUsed=' + $usedRestrict) }
  $best = $null
  $bestGmail = $false
  $shown = 0
  foreach ($m in $items) {
    try { if ($m.Class -ne 43) { continue } } catch { continue }
    $subj = ''
    try { $subj = $m.Subject } catch {}
    if ($subj -notlike ('*' + $ref + '*')) { continue }
    $smtp = ''
    try { $smtp = $m.PropertyAccessor.GetProperty($PR_SMTP) } catch {}
    if (-not $smtp) { try { $smtp = $m.SenderEmailAddress } catch {} }
    $attCount = 0
    try { $attCount = $m.Attachments.Count } catch {}
    $hasXlsx = $false
    foreach ($att in $m.Attachments) {
      $fn = ''
      try { $fn = $att.FileName } catch {}
      if ($fn -match '\\.xlsx$' -and $fn.Contains($ref)) { $hasXlsx = $true; break }
    }
    $hasKeyword = $subj.ToLower().Contains($keyword)
    if ($verbose -and $shown -lt 15) {
      Write-Output ('DEBUG=[' + $ref + '] candidate sender=' + $smtp + ' atts=' + $attCount + ' xlsx=' + $hasXlsx + ' keyword=' + $hasKeyword + ' subj=' + $subj)
      $shown++
    }
    if (-not ($hasKeyword -and $hasXlsx)) { continue }
    $isGmail = ($smtp -and $smtp.ToLower() -eq $sender)
    if ($isGmail) { $best = $m; $bestGmail = $true; break }
    if ($best -eq $null) { $best = $m }
  }
  if ($best -ne $null) {
    Write-Output ('DEBUG=[' + $ref + '] chosen fromGmail=' + $bestGmail + ' subj=' + $best.Subject)
  }
  $script:found = $best
}

try {
  # Was classic Outlook already open? If not, COM starts it in the background
  # and its local mailbox copy may be stale until it has synced.
  $wasRunning = [bool](Get-Process -Name OUTLOOK -ErrorAction SilentlyContinue)
  $ol = New-Object -ComObject Outlook.Application
  $ns = $ol.GetNamespace('MAPI')
  Write-Output ('DEBUG=Outlook COM connected (classic Outlook already open: ' + $wasRunning + ')')
  # List every account so we can see whether the medafrica one exists.
  $accts = @()
  foreach ($a in $ns.Accounts) { try { if ($a.SmtpAddress) { $accts += $a.SmtpAddress } } catch {} }
  Write-Output ('DEBUG=Accounts in profile: ' + ($accts -join ', '))
  Write-Output ('DEBUG=Target account match: ' + $acctMatch + '  |  Target sender: ' + $sender)
  # Pick the Inbox of the account whose SMTP matches $acctMatch (equals or ends-with).
  $store = $null
  $acct = $null
  foreach ($a in $ns.Accounts) {
    $sm = ''
    try { $sm = $a.SmtpAddress } catch {}
    if ($sm) {
      $sm2 = $sm.ToLower()
      if ($sm2 -eq $acctMatch -or $sm2.EndsWith($acctMatch)) { $store = $a.DeliveryStore; $acct = $a; Write-Output ('DEBUG=Matched account: ' + $sm); break }
    }
  }
  if ($store -eq $null) { throw ('Aucun compte Outlook ne correspond a ' + $acctMatch) }

  # WHY a copy can be stale: the matched account's connection mode
  # (OlExchangeConnectionMode: 100/200 offline, 300/400 disconnected, 500-700
  # cached+connected, 800 online — per ACCOUNT, the namespace value only covers
  # the profile's default account), the "Work offline" flag, whether classic
  # has any window (0 = hidden background instance, which cannot show a
  # sign-in prompt), and since when the OUTLOOK.EXE process has been running.
  $mode = ''
  try { $mode = [string][int]$acct.ExchangeConnectionMode } catch {}
  $offline = ''
  try { $offline = [string]$ns.Offline } catch {}
  $windows = ''
  try { $windows = [string]$ol.Explorers.Count } catch {}
  $started = ''
  try { $started = (Get-Process -Name OUTLOOK -ErrorAction Stop | Sort-Object StartTime | Select-Object -First 1).StartTime.ToString('yyyy-MM-dd HH:mm') } catch {}
  Write-Output ('DEBUG=Classic Outlook state: connectionMode=' + $mode + ' workOffline=' + $offline + ' windowsOpen=' + $windows + ' processStarted=' + $started)
  Write-Output ('OUTLOOK_STATE=' + $mode + '|' + $offline + '|' + $windows + '|' + $started)
  $inbox = $store.GetDefaultFolder(6)
  $newest = Get-InboxNewest $inbox
  Write-Output ('DEBUG=Inbox store=' + $inbox.Store.DisplayName + ' totalItems=' + $inbox.Items.Count + ' newestMail=' + $newest)

  # Classic's local data file (.ost): a full one stops new mail from being
  # stored even while connected (device: connectionMode=700 yet stuck since
  # 02/10, plus "Éléments envoyés contient le nombre maximal d'éléments").
  # Size vs MaxLargeFileSize (MB, default 50 GB), and Sent Items / Outbox counts.
  $inv = [Globalization.CultureInfo]::InvariantCulture
  $ostPath = ''
  $ostGb = ''
  try {
    $ostPath = [string]$store.FilePath
    if ($ostPath -and (Test-Path -LiteralPath $ostPath)) { $ostGb = [math]::Round((Get-Item -LiteralPath $ostPath).Length / 1GB, 1).ToString($inv) }
  } catch {}
  $limitGb = ''
  foreach ($k in @('HKCU:\\Software\\Policies\\Microsoft\\Office\\16.0\\Outlook\\PST', 'HKCU:\\Software\\Microsoft\\Office\\16.0\\Outlook\\PST')) {
    try {
      $v = (Get-ItemProperty -Path $k -Name MaxLargeFileSize -ErrorAction Stop).MaxLargeFileSize
      if ($v) { $limitGb = [math]::Round($v / 1024, 1).ToString($inv); break }
    } catch {}
  }
  $sentCount = ''
  try { $sentCount = [string]$store.GetDefaultFolder(5).Items.Count } catch {}
  $outboxCount = ''
  try { $outboxCount = [string]$store.GetDefaultFolder(4).Items.Count } catch {}
  Write-Output ('DEBUG=Classic data file: ' + $ostPath + ' size=' + $ostGb + 'GB limit=' + $(if ($limitGb) { $limitGb + 'GB' } else { '50GB (default)' }) + ' | Sent Items=' + $sentCount + ' | Outbox=' + $outboxCount)
  Write-Output ('DATAFILE_STATE=' + $ostGb + '|' + $limitGb + '|' + $sentCount + '|' + $outboxCount)

  $foundByRef = @{}
  foreach ($ref in $refs) {
    Find-RefMail $inbox $ref $true
    if ($script:found -ne $null) { $foundByRef[$ref] = $script:found }
  }

  # Classic Outlook was started just now by COM (the user works in the new
  # Outlook): its local mailbox copy may be days behind. Ask it to sync, then
  # re-search the missing refs every 5 s until found or $syncWaitSec elapses.
  $missing = @($refs | Where-Object { -not $foundByRef.ContainsKey($_) })
  if ($missing.Count -gt 0 -and -not $wasRunning -and $syncWaitSec -gt 0) {
    Write-Output ('DEBUG=Classic Outlook was not open - syncing, re-searching ' + $missing.Count + ' ref(s) for up to ' + $syncWaitSec + 's')
    try { $ns.SendAndReceive($false) } catch {}
    $waitStart = Get-Date
    $deadline = $waitStart.AddSeconds($syncWaitSec)
    while ($missing.Count -gt 0 -and (Get-Date) -lt $deadline) {
      Start-Sleep -Seconds 5
      # Still offline/disconnected (<= 400) after 15 s: it is not going to
      # sync (seen on the device: hidden instance stuck at 400) — stop waiting.
      $nowMode = 0
      try { $nowMode = [int]$acct.ExchangeConnectionMode } catch {}
      if ($nowMode -gt 0 -and $nowMode -le 400 -and ((Get-Date) - $waitStart).TotalSeconds -ge 15) {
        Write-Output ('DEBUG=Classic Outlook still disconnected (connectionMode=' + $nowMode + ') after 15s - not waiting longer')
        break
      }
      foreach ($ref in $missing) {
        Find-RefMail $inbox $ref $false
        if ($script:found -ne $null) {
          $foundByRef[$ref] = $script:found
          Write-Output ('DEBUG=[' + $ref + '] found after sync')
        }
      }
      $missing = @($refs | Where-Object { -not $foundByRef.ContainsKey($_) })
    }
    $newest = Get-InboxNewest $inbox
    Write-Output ('DEBUG=After sync wait: newestMail=' + $newest + ' totalItems=' + $inbox.Items.Count + ' stillMissing=' + $missing.Count)
  }
  Write-Output ('INBOX_STATE=' + $wasRunning + '|' + $newest)

  foreach ($ref in $refs) {
    $best = $foundByRef[$ref]
    if ($best -ne $null) {
      $saved = @()
      foreach ($att in $best.Attachments) {
        $fn = ''
        try { $fn = $att.FileName } catch {}
        if ($fn -match '\\.xlsx$' -and $fn.Contains($ref)) {
          $att.SaveAsFile((Join-Path $dest $fn))
          $saved += $fn
        }
      }
      if ($saved.Count -gt 0) {
        Write-Output ('RESULT=' + $ref + '|saved|' + ($saved -join ' ; '))
      } else {
        Write-Output ('RESULT=' + $ref + '|no_xlsx|Email trouve mais aucune piece .xlsx nommee avec la ref')
      }
    } else {
      Write-Output ('RESULT=' + $ref + '|not_found|Aucun email "' + $keyword + '" avec piece .xlsx pour ' + $ref)
    }
  }
  Write-Output 'DONE=ok'
} catch {
  Write-Output ('FATAL=' + ($_.Exception.Message -replace "\\r?\\n"," "))
}
`;

    const os = await import("os");
    const scriptPath = path.join(os.tmpdir(), `badr-fetch-${Date.now()}.ps1`);
    // UTF-16LE + BOM: the encoding Windows PowerShell reads natively, so the
    // dest path and any accented attachment names survive intact.
    await fs.writeFile(scriptPath, "﻿" + script, "utf16le");

    const { execFile } = await import("child_process");
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-STA",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ],
      // 90 s for Outlook itself + the optional sync wait.
      { timeout: 90000 + Math.max(0, INBOX_SYNC_WAIT_SEC || 0) * 1000, windowsHide: true },
      (err, stdout, stderr) => {
        fs.remove(scriptPath).catch(() => {});
        const out = String(stdout || "");
        // Collect DEBUG lines and echo each into the log journal so the search
        // path is visible (account list, inbox reached, per-ref match counts,
        // candidate senders). Also returned to the UI for an inline detail view.
        const debug = [];
        for (const line of out.split(/\r?\n/)) {
          const dm = line.match(/^DEBUG=(.*)$/);
          if (dm) {
            debug.push(dm[1]);
            logger.info(`[fetch-xlsx] ${dm[1]}`);
          }
        }
        const fatal = out.match(/FATAL=(.*)/)?.[1]?.trim();
        if (fatal || (err && !out.includes("RESULT=") && !out.includes("DONE="))) {
          const reason = fatal || stderr || err?.message || "Outlook COM failed";
          logger.warn({ refs, reason }, "fetch-xlsx failed");
          res.status(500).json({
            ok: false,
            reason:
              "Impossible de lire la boîte Outlook (Outlook classique requis). " +
              String(reason).slice(0, 300),
            debug,
          });
          return;
        }
        const results = [];
        const seen = new Set();
        for (const line of out.split(/\r?\n/)) {
          const mm = line.match(/^RESULT=(.+?)\|([a-z_]+)\|(.*)$/i);
          if (mm) {
            results.push({ ref: mm[1], status: mm[2], detail: mm[3] });
            seen.add(mm[1]);
          }
        }
        for (const ref of refs) {
          if (!seen.has(ref))
            results.push({ ref, status: "not_found", detail: "Aucune réponse" });
        }
        const savedCount = results.filter((r) => r.status === "saved").length;
        // How fresh is the mailbox copy COM searched? Lets the UI say "the app
        // only sees mail up to <date>" when a ref is missing.
        const state = out.match(/^INBOX_STATE=(True|False)\|(.*)$/im);
        const inbox = state
          ? { outlookWasOpen: state[1] === "True", newestMail: state[2].trim() }
          : null;
        // ...and why classic Outlook may not be syncing (see OUTLOOK_STATE).
        const ol = out.match(/^OUTLOOK_STATE=(\d*)\|(\w*)\|(\d*)\|(.*)$/im);
        if (inbox && ol) {
          inbox.connectionMode = ol[1] ? Number(ol[1]) : null;
          inbox.workOffline = ol[2] === "True";
          inbox.windowsOpen = ol[3] === "" ? null : Number(ol[3]);
          inbox.processStarted = ol[4].trim();
        }
        // ...and how full classic's local data file is (see DATAFILE_STATE).
        const df = out.match(/^DATAFILE_STATE=([\d.]*)\|([\d.]*)\|(\d*)\|(\d*)\s*$/im);
        if (inbox && df) {
          const num = (s) => (s === "" ? null : Number(s));
          inbox.dataFileGb = num(df[1]);
          inbox.dataFileLimitGb = num(df[2]) ?? 50;
          inbox.sentItems = num(df[3]);
          inbox.outboxItems = num(df[4]);
        }
        logger.info({ count: refs.length, savedCount, inbox }, "fetch-xlsx done");
        res.json({ ok: true, dest, savedCount, results, debug, inbox });
      },
    );
  } catch (error) {
    logger.error({ refs, error: error.message }, "fetch-xlsx error");
    res.status(500).json({ ok: false, reason: error.message });
  }
});

// ── Clean / reset: remove DUM inputs + ARCHIVE the signed outputs ───────────
// Deletes the Excel input(s) from the dums folder and MOVES each signed "…READY"
// LTA folder from outputs into the archive (`outputs/deja signé et envoyé`, i.e.
// C:\sign\outputs\deja signé et envoyé on the prod machine) instead of deleting
// it — nothing signed is lost. Body: {} cleans ALL; { fileName?, ltaRef? } cleans
// just that one LTA. Blocked while a signing job is running.
const ARCHIVE_SUBDIR = "deja signé et envoyé";

app.post("/api/lta/clean", async (req, res) => {
  try {
    const active = [...state.jobs.values()].some((j) => j.status === "running");
    if (active) {
      res.status(409).json({
        ok: false,
        reason: "Un traitement est en cours — impossible de nettoyer.",
      });
      return;
    }
    const { fileName, ltaRef } = req.body || {};
    const dumsDir = path.resolve(config.directories.dums);
    const outDir = path.resolve(config.directories.outputs);
    const archive = process.env.ARCHIVE_DIR
      ? path.resolve(process.env.ARCHIVE_DIR)
      : path.join(outDir, ARCHIVE_SUBDIR);
    await fs.ensureDir(archive);

    let dumsRemoved = 0;
    const movedFolders = [];

    // Move a single "LTA N° <ref> READY" folder into the archive (overwrite an
    // older archived copy of the same LTA).
    const archiveReady = async (ref) => {
      const folder = path.join(outDir, `LTA N° ${ref} READY`);
      if (!(await fs.pathExists(folder))) return;
      const target = path.join(archive, path.basename(folder));
      await fs.remove(target).catch(() => {});
      await fs.move(folder, target, { overwrite: true });
      movedFolders.push(path.basename(folder));
    };

    if (fileName || ltaRef) {
      // ── Single LTA ──
      if (fileName) {
        const full = path.join(dumsDir, path.basename(fileName));
        if (await fs.pathExists(full)) {
          await fs.remove(full);
          dumsRemoved++;
        }
      }
      if (ltaRef) await archiveReady(ltaRef);
    } else {
      // ── All ──
      for (const name of await fs.readdir(dumsDir).catch(() => [])) {
        const full = path.join(dumsDir, name);
        const st = await fs.stat(full).catch(() => null);
        if (st?.isFile() && allowedExcel.has(path.extname(name).toLowerCase())) {
          await fs.remove(full);
          dumsRemoved++;
        }
      }
      for (const name of await fs.readdir(outDir).catch(() => [])) {
        if (name === ARCHIVE_SUBDIR || !/ READY$/.test(name)) continue;
        const src = path.join(outDir, name);
        const st = await fs.stat(src).catch(() => null);
        if (!st?.isDirectory()) continue;
        const target = path.join(archive, name);
        await fs.remove(target).catch(() => {});
        await fs.move(src, target, { overwrite: true });
        movedFolders.push(name);
      }
    }
    logger.info(
      { scope: fileName || ltaRef ? "one" : "all", dumsRemoved, moved: movedFolders.length },
      "clean done",
    );
    res.json({ ok: true, dumsRemoved, movedFolders, archive });
  } catch (error) {
    logger.error({ error: error.message }, "clean failed");
    res.status(500).json({ ok: false, reason: error.message });
  }
});

app.listen(config.port, () => {
  logger.info(
    `API listening on http://localhost:${config.port} | Dums folder: ${config.directories.dums}`,
  );
});

// Best-effort: if the process is stopped/killed while a job is still running,
// fire a WhatsApp alert before we exit. (Only fires on graceful signals; a hard
// kill -9 cannot be caught. The per-LTA chrono covers hangs while alive.)
let _shuttingDown = false;
const notifyOnShutdown = async (signal) => {
  if (_shuttingDown) return;
  _shuttingDown = true;
  const running = [...state.jobs.values()].some((j) => j.status === "running");
  if (running) {
    const sigLog = (level, message) => logger.info({ signal }, message);
    await sendWhatsApp(
      `🛑 PROBLEM - Signing process was stopped (${signal}) while a job was still running. ` +
        `Some LTAs may be incomplete — please check.`,
      sigLog,
    ).catch(() => {});
    await notifyLtaFailure({
      reason: `Signing process was stopped (${signal}) while the job was still running.`,
      onLog: sigLog,
    }).catch(() => {});
  }
  process.exit(0);
};
process.on("SIGINT", () => notifyOnShutdown("SIGINT"));
process.on("SIGTERM", () => notifyOnShutdown("SIGTERM"));
