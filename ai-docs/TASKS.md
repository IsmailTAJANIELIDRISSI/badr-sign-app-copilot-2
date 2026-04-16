# TASKS.md — Incomplete Areas and Next Steps

---

## Currently Incomplete or Broken

### 1. UI: No DUM Range Filtering

**Problem:** The UI runs ALL valid DUMs for every selected LTA. The original specification requires the user to specify a DUM range (e.g., DUM 1 to DUM 20).  
**Impact:** If a user only wants to sign a subset, there is no way to do it from the UI. Every run processes the full Excel.  
**Location:** `src/App.jsx` (no range inputs), `server/index.js` `/api/jobs/run` endpoint (no range filtering logic), `server/automation.js` `runSigningJob()`.

---

### 2. UI: No Folder Picker for Dums Directory

**Problem:** The `dums/` folder path is hardcoded via env config. Users cannot change it from the UI. In Electron, `window.electronAPI` could expose a folder dialog, but no such IPC handler exists.  
**Impact:** Non-technical users cannot change the input folder without editing `.env`.  
**Location:** `electron/main.js` (no `dialog.showOpenDialog` IPC), `electron/preload.js`, `src/App.jsx`.

---

### 3. UI: Previous Job Outputs Not Visible

**Problem:** The `GET /api/outputs` endpoint returns a list of output folder names, but the UI never calls it or displays completed LTA folders/PDFs.  
**Impact:** Users must open File Explorer manually to verify signed PDFs.  
**Location:** `src/App.jsx` (API endpoint exists but unused in UI), `server/index.js`.

---

### 4. `zod` and `chokidar` Imported But Unused

**Problem:** Both `zod` (runtime validation) and `chokidar` (file watching) are production dependencies but are not used anywhere in the current code.  
**Impact:** Unnecessary bundle weight. `chokidar` was likely intended to auto-refresh the LTA file list when files are added to `dums/`.  
**Location:** `package.json`.

---

### 5. Electron Packaged Build: API Server Spawn Issue

**Problem:** In `electron/main.js`, the packaged build spawns `server/index.js` via `process.execPath` with `ELECTRON_RUN_AS_NODE=1`. When packaged as an `.asar` archive, Node's `require`/`import` paths inside the asar may not resolve correctly for ESM modules (especially dynamic imports in Playwright, pino transports, etc.).  
**Impact:** The packaged `.exe` may fail to start the API backend.  
**Location:** `electron/main.js` `startApiServer()`.

---

### 6. `electron/main.js` `open-folder` IPC Uses `execSync`

**Problem:** The `open-folder` IPC handler uses `execSync('explorer.exe /select,"..."')` instead of the already-imported `shell.openPath()`. This is a security risk (command injection if folder path contains special characters) and is also less reliable.  
**Impact:** Minor security risk; `shell.openPath` is already available and preferred.  
**Location:** `electron/main.js` `ipcMain.handle("open-folder", ...)`.

---

### 7. No `.env.example` File

**Problem:** The README and `SETUP_CHECKLIST.md` reference copying `.env.example` to `.env`, but no `.env.example` file exists in the repository.  
**Impact:** New developers must manually construct the `.env` from README docs rather than a template.  
**Location:** Project root (file missing).

---

### 8. BADR_YEAR Hardcoded to Current Year

**Problem:** `config.badr.year` defaults to `String(new Date().getFullYear())`. When the year rolls over (e.g., from 2026 to 2027), all declarations from the old year would fail if the user has not set `BADR_YEAR` explicitly.  
**Impact:** Subtle runtime failure; not visible in UI.  
**Location:** `server/config.js`.

---

### 9. No Unit Tests

**Problem:** No test files exist anywhere in the project. The Excel parser (fixed-row vs label-based extraction), lot ref normalization logic, and shipper comparison logic are all complex enough to warrant unit tests.  
**Impact:** Regressions in parsing or matching logic are invisible until they cause silent failures in production automation runs.  
**Location:** Entire codebase — no test runner configured.

---

### 10. Job Progress `done` Counter Not Incremented Per DUM

**Problem:** In `server/index.js`, `job.progress.done` is set to `results.length` only **after** the entire job finishes. During a long run, the UI always shows `done: 0` until completion.  
**Impact:** Poor UX — the progress counters do not update live during the job.  
**Location:** `server/index.js` — the `onLog` callback updates logs in real time, but `job.progress.done` is only set after `runSigningJob()` resolves.

---

### 11. No Graceful Handling of Excel Files With Zero Valid DUMs

**Problem:** If an Excel file is parsed and all DUMs are `isValid=false`, the job still creates an output folder and runs through the LTA loop, just marking everything as failed. There is no early exit or pre-check warning shown to the user before running.  
**Impact:** Minor inefficiency; confusing logs.  
**Location:** `server/automation.js` `runSigningJob()`.

---

### 12. `src/main.css` Contents Unknown

**Problem:** The global CSS file `src/main.css` was not inspected during this analysis.  
**Impact:** Unknown — may contain important base resets or custom styles. Should be reviewed.  
**Location:** `src/main.css`.

---

## Logical Next Steps (Priority Order)

### High Priority (Core Functionality)

1. ✅ **~~FIXED~~ Declaration load wait in fillDeclarationSearch** — Replaced `waitForNavigation + fixed 2500ms` with active DOM polling for declaration tab indicators. (`server/automation.js`)

   _Updated 2026-04-16:_ Further strengthened with 3-phase spinner-aware wait using `waitFor({state:'hidden'})` + full `config.timeout` polling cap.

2. ✅ **~~FIXED~~ IMPRIMER print failure ("No PDF download event captured")** — Root cause: 60-s download-promise timeout raced against `waitForNoBlockingOverlay` (which can take 67+ s). Fixed by: moving overlay-clear call before the download listener loop, adding `clickImprimerDirect` (no internal overlay wait), raising timeout to 90 s, and adding `waitForNewPdfInDownloads` fallback that monitors `~/Downloads` for the PDF in CDP mode. (`server/automation.js`)

2. **Fix live progress counter** — Increment `job.progress.done` (and success/failed/skipped sub-counts) inside the `onLog` callback in `server/index.js` after each DUM result is pushed. This requires either emitting a structured progress event or tracking incrementally.

3. **Add DUM range selector to UI** — Add two number inputs per LTA card (`From DUM` / `To DUM`). Pass them in the `POST /api/jobs/run` body. Filter `lta.dums` in `runSigningJob()` before iterating.

4. **Fix Electron `open-folder` IPC** — Replace `execSync` with `shell.openPath(folderPath)` in `electron/main.js`.

5. **Create `.env.example`** — Document all env vars with safe placeholder values so new developers have a complete template.

### Medium Priority (UX Improvements)

5. **Implement chokidar file watching** — Watch `dums/` for new/changed Excel files and auto-update `state.ltaFiles`, pushing an update notification to the frontend (SSE or polling unchanged). Removes need for manual "Refresh Files" click.

6. **Show output folders in UI** — Call `GET /api/outputs` on job completion and display a list of produced LTA folders with PDF counts and READY/PROBLEM status.

7. **Add folder picker IPC** — Add `dialog.showOpenDialog({ properties: ['openDirectory'] })` IPC in `electron/main.js` + expose via `preload.js`. Add a "Change Folder" button to the UI dums folder banner.

8. **Increment job progress live** — Change `runSigningJob` to accept an `onDumResult(result)` callback; call it after each DUM so `job.progress` updates in real time.

### Lower Priority (Reliability / Maintenance)

9. **Add unit tests** for:
   - `excelParser.js` — fixed-row extraction, label extraction, LTA ref detection
   - `automation.js` utility functions — `parseLotRef`, `normalizeLotRef`, `lotMatchesExpectedDum`, `isShipperEquivalent`

10. **Validate API inputs with zod** — Use the already-installed `zod` to validate `POST /api/jobs/run` body and `POST /api/shippers` body.

11. **Fix packaged Electron API spawn** — Test the NSIS installer; likely needs to extract `server/` to an unpacked directory (via `electron-builder` `extraResources`) instead of packing inside `.asar`.

12. **Handle BADR_YEAR rollover** — Add UI option or config note to update the year; or detect the year from the DUM series row in the Excel (the `Année` field in the search form).

13. **Early-exit LTA if zero valid DUMs** — Before the DUM loop, check `lta.validDums === 0` and emit a warning + skip the LTA entirely.
