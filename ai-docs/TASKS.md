# TASKS.md — Incomplete Areas and Next Steps

---

## Recently Completed

### ✅ Card status colours — PROBLEM red / completed green (2026-07-29)

`/api/lta-files` now returns `outputStatus` (`problem`/`ready`/`""`) from the signed output folder name; cards render **red** with ⚠ PROBLEM (PROBLEM folder) or **green** with ✓ Terminé (READY folder) so they're caught before emailing. `server/index.js` + `src/App.jsx`. See PROGRESS.md.

### ✅ Import paste-WhatsApp + "Envoyer tous" bulk drafts (2026-07-29)

Import tab now accepts a pasted WhatsApp message and extracts only ref-shaped tokens (`\d{3}-\d{6,9}`), ignoring the greeting text; bigger textarea + **📋 Coller / ⧉ Copier / ✕** buttons (clipboard API, for mobile/AnyDesk); detected refs shown as live blue chips. New global blue **✉ Envoyer tous** button (top bar) creates an Outlook draft for every selected LTA sequentially (refactored `sendEmailRequest` core shared with the per-card button). Frontend only. See PROGRESS.md.

### ✅ "Import" tab — fetch DUM .xlsx from Outlook inbox by ref (2026-07-23)

New Import tab: paste LTA refs → **Confirmer** → `POST /api/lta/fetch-xlsx` runs Outlook COM to search the default Inbox for mail from `tajanielidrissi.ismail@gmail.com` (override via `INBOX_SENDER_EMAIL`) whose subject contains the ref, and saves the `.xlsx` attachment into the dums folder (auto-refreshes the LTA list). Classic-Outlook-only, no SMTP/Graph. Verified COM Inbox read (`items=409`) + PS/JS syntax; the "saved" path needs validation on the real recipient machine. See PROGRESS.md.

### ✅ Outlook auto-attach "path not found" fixed — ABSOLUTE paths (2026-07-23)

The COM path failed with `Ce chemin d'accès n'existe pas` because `findLtaPdfs` handed Outlook **relative** paths (`config.directories.signedLtas` = `./outputs`), and `Attachments.Add` resolves relative paths against its own dir. Now returns **absolute** paths (`path.resolve`). Verified `ATTACHED=3` / `METHOD=com` against the real `157-55633583` folder. (The `°` was a red herring — plain U+00B0, never corrupted; UTF-16LE temp-script write kept as defensive hardening.) Classic Outlook (non-elevated) now auto-attaches. See PROGRESS.md.

### ⚠️ App leaves stale API servers on port 3001 (follow-up)

`electron/main.js` spawns `node server/index.js` with no hot-reload and doesn't reliably kill it on exit (zombies seen 2 days old). This repeatedly caused "fixed but still failing" because the app talked to an old server. **Fix to do:** free port 3001 (kill any listener) before `startApiServer` spawns its own.

### ✅ "Envoyer par email" — Outlook draft with PDFs attached (2026-07-22)

Blue button per LTA card → `POST /api/lta/outlook-email` drives classic Outlook via COM (PowerShell) to open a draft with the `config.outlookTo` list, subject `MAWB {ref} - ({n} DUM)`, empty body, and every signed PDF attached (mailto: can't attach). Recipients env-overridable via `OUTLOOK_TO`. **Requires classic Outlook desktop; Windows-only.** Script is run from a UTF-8-BOM temp `.ps1` via `-File` so the `N°` in folder paths isn't corrupted. See PROGRESS.md.

### ✅ UI redesign — tabbed shell, logs in their own tab (2026-07-21)

`src/App.jsx` rebuilt as a fixed-height shell with **LTAs** (setup) and **Activity** (full-viewport log console with level/text filters, auto-scroll, copy) tabs. Header keeps a live progress bar + current LTA visible from either tab. Live counters are derived from the log stream, which **also works around TASKS #10** (`job.progress.done` only being filled after the job ends) — see the caveat about the 1000-line log cap in PROGRESS.md. Verified against the running app with screenshots.

### ✅ One-click copyable mail subject (2026-07-21)

`MAWB {ref} - ({n} DUM)` is now available three ways: `email_subject.txt` in the LTA output folder, a **Copy** button on each LTA card in the UI, and a `📋` log line. Clipboard falls back to `execCommand` because Electron's `file://` origin isn't a secure context. The string is duplicated in `server/automation.js` and `src/App.jsx` — **keep them in sync**. See PROGRESS.md.

### ✅ Desktop screenshot fallback when the browser is closed (2026-07-21)

`captureScreenshot()` cascades: BADR page → whole Windows desktop → none. Desktop capture uses PowerShell + .NET `System.Drawing` (no npm dependency, so it can't break machines that haven't run `npm install`). The failure email labels which kind it is. Needs an unlocked interactive session; a locked workstation gives a black image. Verified: real desktop PNG in ~1.1 s. See PROGRESS.md.

### ✅ Chrono now budgets only remaining DUMs; browser-closed aborts cleanly (2026-07-21)

Chrono counts DUMs with no PDF on disk, so a resumed run budgets `~8 min (6 of 18 DUM remaining)` instead of a useless `~23 min`; skipped entirely when nothing is pending. A closed browser (`isBrowserClosedError`) now aborts the DUM loop, both recovery passes and the outer LTA loop, instead of instantly marking every untried DUM as `failed`. See PROGRESS.md.

### ✅ Per-machine recipient lists — no more config.js merge conflicts (2026-07-21)

**Rule: shared/production values → `config.js` (committed). Machine-specific values → `.env` (gitignored). Never edit a tracked file to configure one machine** — `electron/main.js` auto-pulls on startup (stash → pull → stash pop), so local edits to tracked files conflict and leave `<<<<<<<` markers that break the app.

Recipients now live **only** in `.env` (`EMAIL_TO` / `EMAIL_CC` / `EMAIL_ENABLED`) — `config.js` has no list at all, so there is nothing to conflict over. If `EMAIL_TO` is empty, no email is sent and it's logged loudly (never falls back to the real team). Ready-to-paste test and production blocks are in `.env.example`. See PROGRESS.md.

### ✅ "Signature Failed" email with screenshot on all failure paths (2026-07-21)

Subject `Signature Failed LTA N°{ref} ({n} DUM)`, body = failure reason + inline screenshot of the current BADR screen. Fires on: LTA → PROBLEM, chrono timeout, job crash / browser closed, and process stop (SIGINT/SIGTERM). Deduped to one email per LTA per run; degrades gracefully (still emails) when the browser is closed and no screenshot can be taken. See PROGRESS.md.

**Blocked on:** email is hard-disabled in `config.js` (`enabled: false`) — revert that line to re-enable both READY and failure emails.

### ✅ Signing loader wait burned the full 120 s timeout (2026-07-21)

`waitForSigningReady` latched `waitFor({state:'hidden'})` onto the catch-all `div:has-text('Traitement en cours')`, which matches any **ancestor** div containing the text. PrimeFaces hides the blockUI but leaves the text in the DOM, so `.first()` resolved to an always-visible page wrapper that never hides → full `config.timeout` (120 s) burned per DUM, swallowed by `.catch(() => {})`, still logged `✓ Signing loader hidden`.

Fixed with a narrow `SIGNING_LOADER_SELECTORS` + a polling `waitForSigningLoaderGone()` + truthful logging, and the narrow set in Phase 2 (which also removes the bogus `⚠ Signing readiness wait exceeded 6s` warning). Verified in real Chromium: **120 000 ms → 285 ms**. Saves ~2 min per DUM (~30 min on a 19-DUM LTA). See PROGRESS.md.

### ✅ Email + WhatsApp notifications + per-LTA chrono (2026-07-06)

New `server/notifications.js`. On LTA **READY** → email (`MAWB {ref} ({n} DUM)`, empty body, all signed PDFs attached) to the Medafrica To/CC lists, sent once per LTA (`.email_sent` marker). WhatsApp (CallMeBot) alerts on **PROBLEM** folders, job errors, process stop (`SIGINT`/`SIGTERM`), and a per-LTA **chrono** watchdog (`LTA_MINUTES_PER_DUM = 1.25`, i.e. 16 DUMs ≈ 20 min). Config in `server/config.js` (`email`, `whatsapp`, `ltaChrono`); vars in `.env.example`. See PROGRESS.md.

**Outstanding user setup:** create `.env` with the `EMAIL_*` values, and obtain + set `WHATSAPP_CALLMEBOT_APIKEY` (WhatsApp is gated off until then).

### ✅ Series regex too strict — short series rejected (2026-05-22)

`SERIES_REGEX` now accepts 4–7 digits (`/^\d{4,7}[A-Z]$/i`). Previously only 7-digit series were valid, causing DUMs like `76945B` to fail with "Invalid series format".

### ✅ LTA priority order — drag-to-reorder UI (2026-05-19)

"Set Priority Order" mode: drag-and-drop + arrow buttons. Normal mode shows `#N` position badges and a pill strip. Backend now respects `fileNames` array order.

### ✅ DUM skipped on "Could not fill Bureau field" (form not ready) (2026-05-15)

Added `isFormNotReadyError` helper. Inner catch now also retries (with Accueil recovery) when the form fields are not found — same 3-attempt budget as BADR internal errors.

### ✅ Post-loader wait reduced from 60 s to 6 s (2026-05-14)

Signing loader disappearing = signing complete. `waitForSigningReady` now checks for IMPRIMER for at most 6 s post-loader. `printAndSave` DOM-attachment guard is the safety net.

### ✅ IMPRIMER fails after slow signing (45 s+ BADR loader) (2026-05-11)

`waitForSigningReady` now uses `config.timeout` for the loader-wait phase and an independent 60 s window for IMPRIMER readiness. `printAndSave` waits for IMPRIMER DOM attachment before starting click attempts. See PROGRESS.md for details.

### ✅ Shipper update fails when name > 50 chars (BADR maxlength) (2026-05-06)

`checkShipper` now reads the field's `maxlength` and truncates `expectedShipper` before filling and verification. See PROGRESS.md for details.

### ✅ Auto-detect shipper name from Excel H1 (2026-04-21)

Cell `H1` of each generated Excel now provides the shipper name. The app reads it on scan, pre-fills the UI input, and auto-persists to `.shippers.json` (without overwriting user overrides). See PROGRESS.md for details.

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

3. **Fix live progress counter** — Increment `job.progress.done` (and success/failed/skipped sub-counts) inside the `onLog` callback in `server/index.js` after each DUM result is pushed. This requires either emitting a structured progress event or tracking incrementally.

4. **Add DUM range selector to UI** — Add two number inputs per LTA card (`From DUM` / `To DUM`). Pass them in the `POST /api/jobs/run` body. Filter `lta.dums` in `runSigningJob()` before iterating.

5. **Fix Electron `open-folder` IPC** — Replace `execSync` with `shell.openPath(folderPath)` in `electron/main.js`.

6. **Create `.env.example`** — Document all env vars with safe placeholder values so new developers have a complete template.

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
