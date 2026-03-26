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
  res.json(
    parsed.map((item) => ({
      fileName: item.fileName,
      filePath: item.filePath,
      ltaRef: item.ltaRef,
      dumsCount: item.dums.length,
      dums: item.dums,
    })),
  );
});

app.post("/api/jobs/run", async (req, res) => {
  const { shipperByFileName = {}, fileNames = [] } = req.body || {};

  const parsed = state.ltaFiles.length ? state.ltaFiles : await scanDumFiles();
  const filtered = fileNames.length
    ? parsed.filter((item) => fileNames.includes(item.fileName))
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
        onShipperAutofix: async ({ fileName, ltaRef, shipperName }) => {
          const shippers = await loadShippers();
          const value = String(shipperName || "").trim();
          if (!value) return;

          if (fileName) shippers.byFileName[fileName] = value;
          if (ltaRef) shippers.byLtaRef[ltaRef] = value;
          await saveShippers(shippers);

          pushJobLog(jobId, "info", "Expected shipper updated from BADR", {
            fileName,
            ltaRef,
            shipperName: value,
          });
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

app.listen(config.port, () => {
  logger.info(
    `API listening on http://localhost:${config.port} | Dums folder: ${config.directories.dums}`,
  );
});
