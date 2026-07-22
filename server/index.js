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

  res.json(
    parsed.map((item) => ({
      fileName: item.fileName,
      filePath: item.filePath,
      ltaRef: item.ltaRef,
      dumsCount: item.dums.length,
      totalDums: item.totalDums,
      validDums: item.validDums,
      invalidDums: item.invalidDums,
      shipperName: item.shipperName || "",
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
const findLtaPdfs = async (ltaRef) => {
  const base = config.directories.signedLtas;
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
      .map((n) => path.join(folder, n));
    if (pdfs.length) return { folder, pdfs };
  }
  return { folder: null, pdfs: [] };
};

// Single-quote a value for safe embedding in a PowerShell script.
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

app.post("/api/lta/outlook-email", async (req, res) => {
  const { ltaRef, dumsCount } = req.body || {};
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

    // Universal open-in-mail script. Runs from a UTF-8-BOM temp .ps1 via -File so
    // the "°" in "LTA N° …" paths and accented names aren't corrupted by the
    // console code page.
    //
    //  1. Try classic Outlook via COM → opens a draft with the PDFs already
    //     attached (best UX, zero extra clicks).  METHOD=com
    //  2. If COM is unavailable (NEW Outlook / web has no COM, or a different
    //     elevation blocks it) → copy the PDFs to the clipboard as files AND
    //     open the default mail app's compose via mailto:. The user clicks in
    //     the message and presses Ctrl+V to attach.  METHOD=clipboard
    const script = `﻿$ErrorActionPreference = 'Stop'
$files = ${filesArray}
try {
  $ol = New-Object -ComObject Outlook.Application
  $mail = $ol.CreateItem(0)
  $mail.To = ${psq(to)}
  $mail.Subject = ${psq(subject)}
  $mail.Body = ''
  foreach ($f in $files) { if (Test-Path -LiteralPath $f) { [void]$mail.Attachments.Add($f) } }
  $mail.Display($false)
  Write-Output 'METHOD=com'
} catch {
  $comError = $_.Exception.Message
  try { Set-Clipboard -LiteralPath $files } catch {}
  $uri = 'mailto:' + ${psq(mailtoTo)} + '?subject=' + [uri]::EscapeDataString(${psq(subject)})
  Start-Process $uri
  Write-Output 'METHOD=clipboard'
  Write-Output ('COMERR=' + $comError)
}
`;

    const os = await import("os");
    const scriptPath = path.join(
      os.tmpdir(),
      `badr-outlook-${ltaRef}-${Date.now()}.ps1`,
    );
    await fs.writeFile(scriptPath, script, "utf8");

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
      { timeout: 40000, windowsHide: true },
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
        logger.info(
          { ltaRef, count: pdfs.length, method, comErr },
          "Mail draft opened",
        );
        res.json({ ok: true, count: pdfs.length, subject, folder, method });
      },
    );
  } catch (error) {
    logger.error({ ltaRef, error: error.message }, "outlook-email failed");
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
