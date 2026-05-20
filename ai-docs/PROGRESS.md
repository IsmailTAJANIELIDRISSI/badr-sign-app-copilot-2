# Change Log

_Populated as we work. Each entry = problem + solution + files changed._

---

## 2026-05-19 — Feature: LTA Priority Order (drag-to-reorder)

**Problem:** LTAs were processed in the order the filesystem returned them, with no way for the user to choose which LTA runs first.

**Solution:**

- Added `orderedFileNames` state (array of fileNames in user-defined order). On refresh, new files are appended and stale files removed while preserving existing order.
- Added "Set Priority Order" toggle button. Entering order mode:
  - Cards switch from a 3-column grid to a vertical list.
  - Each card shows a numbered amber badge, a braille drag-handle, and Up/Down arrow buttons + Include checkbox.
  - HTML5 drag-and-drop (`draggable`, `onDragStart/Over/Drop/End`) for mouse users; Up/Down arrows as keyboard-friendly fallback.
  - Amber highlight ring on the drop target during drag.
- In normal grid mode: a `#N` pill badge shows each selected LTA's processing position, plus a pill strip below the toolbar previewing the full order.
- `selectedFileNames` (sent to the API) is now `orderedFileNames.filter(fn => selected[fn])` — preserving priority order.
- **Backend fix (`server/index.js`):** Changed `parsed.filter(fn => ...)` to `fileNames.map(fn => parsed.find(...)).filter(Boolean)` so the API respects the received order.

**Files changed:** `src/App.jsx`, `server/index.js`.

---

**Problem:** When `fillDeclarationSearch` ran immediately after `openModifyDeclaration` clicked the menu link, the PrimeFaces iframe/form was sometimes not yet rendered. `fillFirst` found no matching element, threw `Could not fill Bureau field`, which was NOT matched by `isBadrInternalError` — so the retry loop re-threw immediately, marking the DUM as `failed` with no CSV entry. The missing-PDF recovery pass could not help (no CSV entry = nothing to reprint). The DUM was never signed.

**Solution:**

- Added `isFormNotReadyError(error)` helper — matches `"Could not fill (Bureau|Regime|Year|Serie|Key) field"` and `"Could not click Valider button"`.
- In the inner `catch (attemptError)` inside the retry loop, added `|| isFormNotReadyError(attemptError)` to the retry condition alongside `isBadrInternalError`.
- On this condition, calls `recoverFromBadrInternalError` (navigates back to Accueil) and retries the full DUM flow (up to `maxInternalErrorRetries = 3` attempts).
- New log: `"Form not ready (iframe not yet rendered) on DUM N — navigating to Accueil and retrying (attempt X/3)..."`

**Files changed:** `server/automation.js` — added `isFormNotReadyError`, updated inner catch retry condition.

---

**Problem:** After the signing loader ("Traitement en cours") disappeared, `waitForSigningReady` waited up to 60 s polling for IMPRIMER visibility before proceeding. In practice IMPRIMER was always available within 1–2 s after the loader hid, so ~58 s were wasted on every DUM signing. The signing loader disappearing IS the signing-complete signal; `printAndSave` already has its own DOM-attachment guard as a safety net.

**Solution:** Reduced `imprimerReadyMs` from 60 000 ms to 6 000 ms in `waitForSigningReady`. The 6 s window is enough to catch IMPRIMER visibility in the normal case; if it isn't visible within 6 s the function logs a warning and `printAndSave` finds it via `state: 'attached'` anyway.

**Files changed:** `server/automation.js` — `waitForSigningReady()`.

---

**Problem:** `waitForSigningReady` had a hard cap of `Math.min(config.timeout, 45000)` = 45 s shared across BOTH the loader-wait phase AND the IMPRIMER-readiness phase. When BADR's signing process took ≥45 s (DUM 11 of LTA 065-46084942), the loader hid at exactly t=45 s, leaving `remainingAfterLoader = 0`. The IMPRIMER stability check immediately exited. `printAndSave` then tried to click `#secure_imprimer` but BADR hadn't yet rebuilt the left-panel menu post-signing, so the element didn't exist in the DOM at all — all 3 JS-click attempts returned `false`.

**Solution — two changes in `server/automation.js`:**

1. **`waitForSigningReady` — split loader vs. IMPRIMER budgets**
   - Phase 1 (loader wait): uses `config.timeout` (no artificial cap) so 45 s+ signings are handled.
   - Phase 2 (IMPRIMER readiness): independent 60 s window starting AFTER the loader hides + overlay clears.
   - The two phases no longer share one shrinking budget.

2. **`printAndSave` — DOM-attached guard before click attempts**
   After `waitForNoBlockingOverlay`, wait up to 30 s for `#secure_imprimer` (or any IMPRIMER link) to be **attached** to the DOM (`state: 'attached'`). This catches the BADR async menu-rebuild that happens after a long signing. Logs a warning if not found so the JS-fallback still runs.

**Files changed:** `server/automation.js` — `waitForSigningReady()`, `printAndSave()`.

---

## 2026-06 — Feature: Handle "already signed" DUMs + definitive-ref CSV + recovery reprint

**Problem:** When a DUM was signed in a previous session but the PDF was never saved (app crash, network cut, etc.), relaunching the job caused `fillDeclarationSearch` to receive the BADR error banner "La déclaration est enregistrée, veuillez fournir sa référence définitive". The app treated this as a hard failure, logging `✗ FAILED` and never attempting to retrieve the already-signed PDF.

**Solution – three coordinated changes in `server/automation.js`:**

1. **ALREADY_SIGNED detection (`fillDeclarationSearch`)**
   After the AJAX spinner clears, scan for `.ui-messages-error` banners whose text contains "ENREGISTR" or "RÉFÉRENCE DÉFINITIVE". If found, throw a sentinel `ALREADY_SIGNED_PREFIX` error instead of the generic failure path. Added `isAlreadySignedError(e)` helper alongside `isBadrInternalError`.

2. **Definitive reference extraction + CSV (`runSigningJob`)**
   Immediately after `signDeclaration` succeeds, call `extractDefinitiveRef(page)` which locates the declaration header table (`table.reference`) and reads Bureau/Régime/Année/Série/Clé from its second row. Result is appended to `<ltaFolder>/signed_series.csv` via `appendSignedSerieCsv`. Format: `dumNumber,serie,key,ltaRef,timestamp`. File is created on first write (with header row). `loadSignedSeriesCsv` returns a `Map<dumNumber, {serie, key}>` for the recovery pass.

3. **Recovery reprint pass (`runSigningJob` + `reprintBySerieRef`)**
   After the main DUM loop, find all `already_signed` results. For each:
   - If PDF already on disk → mark `skipped`.
   - If no CSV entry for that DUM → mark `failed` with message "manual reprint needed".
   - Otherwise → call `reprintBySerieRef`: navigate DEDOUANEMENT → Services → Rechercher par référence → fill Bureau/Régime/Année/Série/Clé → Valider → wait for declaration → `printAndSave` → `verifyPdfSaved`. Success → mark `success`.

   In the retry-loop catch, `ALREADY_SIGNED` errors propagate immediately (no retries). The outer DUM-loop catch marks the result `already_signed` and uses `continue` to skip to the recovery pass rather than incrementing `failed`.

**Files changed:** `server/automation.js`

- New constants: `ALREADY_SIGNED_PREFIX`
- New helpers: `isAlreadySignedError`, `extractDefinitiveRef`, `appendSignedSerieCsv`, `loadSignedSeriesCsv`, `reprintBySerieRef`
- Modified: `fillDeclarationSearch` (already-signed detection), `runSigningJob` (ALREADY_SIGNED catch, CSV step, recovery pass)

---

## 2026-05-06 — Fix: Shipper update always fails when name exceeds BADR maxlength=50

**Problem:** The BADR shipper input (`nomOperateurExpediteur`) has `maxlength="50"`. When the expected shipper name was longer than 50 chars (e.g. `XIAMEN JINGAO HAIKONG UNION SUPPLY CHAIN MANAGEMENTCO.,LTD` = 58 chars), Playwright's `fill()` respected the browser's `maxlength` and stored only the first 50 chars. The post-fill verification then compared the original 58-char expected against the 50-char stored value → always a mismatch → every DUM for that LTA failed with `Could not update BADR shipper field`.

**Solution:** In `checkShipper`, after locating the field, read the `maxlength` attribute via `.evaluate((el) => el.maxLength)` (fallback 50). Compute `effectiveExpected = expectedShipper.slice(0, maxLen)`. Use `effectiveExpected` for: (a) initial comparison (covers the case where BADR already has the truncated value), (b) the `fill()` call, (c) the post-fill verification. Original `expectedShipper` is preserved in logs and return values for traceability.

**Files changed:** `server/automation.js` — `checkShipper()`.

---

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
