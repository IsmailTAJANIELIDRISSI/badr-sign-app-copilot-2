# Change Log

_Populated as we work. Each entry = problem + solution + files changed._

---

## 2026-04-21 — Feature: Auto-detect shipper name from Excel H1

**What changed:** The shipper name (Nom ou raison sociale of the exporter) is always stored in cell `H1` of each generated LTA Excel file. Previously the user had to type it manually into the UI input for every LTA. Now the app reads `H1` on scan and pre-fills the shipper input automatically.

**Logic:**
1. `extractShipperName(sheet)` reads cell `H1` via the existing `getCell()` helper.
2. `parseLtaExcel` returns a new `shipperName` field alongside `ltaRef` and `dums`.
3. `/api/lta-files` exposes `shipperName` in each item and auto-persists it to `.shippers.json` (only when no user-saved value already exists for that LTA — user overrides are never overwritten).
4. `App.jsx` `refresh()` resolution priority: **JSON saved value → Excel H1 value → empty** (user must type).

**Files changed:** `server/excelParser.js`, `server/index.js`, `src/App.jsx`.

---
## 2026-04-09 — Fix: Declaration form not fully loaded before shipper check

**Problem:** After clicking Valider on the "Modifier une déclaration" search form, BADR loads the full declaration via a PrimeFaces AJAX partial update — not a full page navigation. The previous code did `waitForNavigation (3s)` + `waitForTimeout(2500ms)`, which is unreliable: `waitForNavigation` never fires for AJAX updates, and 2500ms wasn't enough for slower BADR responses. Result: `checkShipper` ran while the page was still loading, found no shipper field after 6 retries, and marked the DUM as failed with `Shipper mismatch. expected='...' actual=''`.

**Solution:** Replaced the blind fixed-wait block in `fillDeclarationSearch()` with an active polling loop that waits up to 30s (capped at `config.timeout`) for any of these declaration-presence indicators to appear in the DOM (across page + all frames): `a[href='#mainTab:tab0']`, `input[id$=':nomOperateurExpediteur']`, `#mainTab`, `a[href='#mainTab:tab7']`, `div.ui-tabs`. Only proceeds (with a 600ms stabilisation pause) once the indicator is found or the timeout is exceeded.

**Files changed:** `server/automation.js` — `fillDeclarationSearch()` function.

---

## 2026-04-16 — Fix: IMPRIMER print always fails with "No PDF download event captured"

**Problem (root cause A — download promise race):** `printAndSave` set up `page.waitForEvent('download', {timeout: 60000})` at the top of each attempt loop, then called `clickImprimer(page)`. Inside `clickImprimer`, `waitForNoBlockingOverlay(page, 90000)` waits for BADR's signing overlay to disappear — which can take 60-90 s after a long signing operation. Because the 60-s download-promise timeout was ticking during this wait, it expired before the click ever fired. `await downloadPromise` then resolved to `null` instantly, logging "No PDF download event captured after IMPRIMER (attempt 1)". Attempts 2 and 3 then failed quickly because the button had hidden itself via its own `onclick` handler (`$('#secure_imprimer').hide()`) and could not be re-found.

**Problem (root cause B — CDP download events):** Playwright is connected to Edge via CDP (`chromium.connectOverCDP`). In this mode Playwright does not manage the browser's download pipeline, so the `'download'` event may never fire at all — the PDF simply lands in the OS `~/Downloads` folder.

**Solution:**

1. `PRINT_DOWNLOAD_TIMEOUT_MS` raised from 60 000 ms to 90 000 ms.
2. New `printAndSave` Phase 0 (outside the retry loop): `waitForNoBlockingOverlay` is called **before** any download listener is registered, so the download-promise timer starts only after the overlay is confirmed clear.
3. New `clickImprimerDirect` helper: identical click logic to `clickImprimer` but **without** an internal `waitForNoBlockingOverlay` call, eliminating the double-wait on retries.
4. New `waitForNewPdfInDownloads` helper: polls `~/Downloads` for 35 s after each click, looking for a PDF that was not there before the attempt began. Copies it to `targetPath` and cleans up the original. This acts as a parallel fallback for the case where Playwright events do not fire in CDP mode.
5. Inside the loop: `waitForNewPdfInDownloads` starts **before** the click (in background), `downloadPromise` races both `page` and `context` events. Whichever mechanism delivers the file first wins; if neither fires, the fallback result is awaited.

**Files changed:** `server/automation.js` — new `import os from "os"`, `PRINT_DOWNLOAD_TIMEOUT_MS` constant, new `clickImprimerDirect`, new `waitForNewPdfInDownloads`, rewritten `printAndSave`.
