# Change Log

_Populated as we work. Each entry = problem + solution + files changed._

---

## 2026-07-29 — Card status colours: PROBLEM = red, completed = green

**Goal:** after signing, a `PROBLEM` LTA should stand out (red) and a completed one (green) before emailing.

**Backend (`server/index.js`):** new `getOutputStatus(ltaRef)` checks the outputs dir — returns `"problem"` if `LTA N° <ref> PROBLEM` exists, `"ready"` if `… READY` exists, else `""`. `/api/lta-files` now includes `outputStatus` per item (computed via `Promise.all`). Verified against the real READY folder + a temp PROBLEM folder.

**Frontend (`src/App.jsx`):** `isProblem`/`isReady` from `outputStatus` → the card gets a **red** (PROBLEM) or **green** (READY/completed) background/border/ring, overriding the normal white + dimmed-unselected state so it's always visible, plus a header badge: **⚠ PROBLEM** or **✓ Terminé** (Terminé hidden while the LTA is actively signing).

**Files changed:** `server/index.js`, `src/App.jsx`.

---

## 2026-07-29 — Import: paste WhatsApp message + "Envoyer tous les LTA" bulk draft

**Import tab — paste a whole WhatsApp message:** `parseRefs` now extracts only LTA-ref-shaped tokens via `/\b\d{3}-\d{6,9}\b/g`, so a full message ("Bonsoir, Veuillez valider sans blocage: 235-96330754 …") can be pasted and the greeting/instructions are ignored (verified against the 3 sample messages). Bigger textarea (rows 10) with **📋 Coller** (reads clipboard via `navigator.clipboard.readText`, appends — for mobile/AnyDesk where Ctrl+V is awkward), **⧉ Copier** (copies detected refs), and **✕** (clear). The detected refs render live as **blue chips** under the box so the filtering is visible before searching. Results still show as cards (green = Enregistré). `src/App.jsx` only.

**"✉ Envoyer tous" bulk button (global, blue, top bar):** creates an Outlook draft for every selected LTA in one click. Refactored the email logic into `sendEmailRequest(item, { silent })` (core, sets per-item state, returns result) reused by both the single per-card button (`sendByEmail`) and the new `sendAllEmails` (loops sequentially — COM can't be parallel — with a confirm() and one summary alert instead of N; reports failures, e.g. LTAs not yet signed). New `sendingAll` state. `src/App.jsx` only.

**Files changed:** `src/App.jsx`.

---

## 2026-07-29 — Feature: open .xlsx in Excel from the app (LTAs + Import tabs)

**Goal:** let the user open Excel files directly from the app instead of hunting in the folder.

**Electron (`electron/main.js`, `electron/preload.js`):** two new IPC handlers — `open-file` (`shell.openPath` a given path → opens in Excel) and `pick-xlsx` (`dialog.showOpenDialog` filtered to xlsx/xls/xlsm, defaulting to the DUMs folder, then `shell.openPath` the choice). Exposed on `window.electronAPI` as `openFile(path)` and `pickAndOpenXlsx(defaultPath)`. (Main-process change → needs a full app relaunch, not just server reload.)

**Backend (`server/index.js`):** `/api/lta-files` now returns `filePath` as an **absolute** path (`path.resolve`) so `shell.openPath` works regardless of cwd.

**Frontend (`src/App.jsx`):** `openXlsx(filePath)` and `pickXlsx()` helpers. Buttons: **📊 Ouvrir un Excel** (native picker → open any xlsx) in the **LTAs** toolbar and the **Import** tab; plus a per-card **📊 Ouvrir l'Excel** that opens that LTA's input file. All gated on `isElectron`.

**Files changed:** `electron/main.js`, `electron/preload.js`, `server/index.js`, `src/App.jsx`.

---

## 2026-07-29 — Feature: "Nettoyer" — delete DUM inputs, ARCHIVE signed outputs (all + per-LTA)

**Goal:** after signing a day's LTAs, the user had to hand-delete input `.xlsx` and the signed folders before the next batch. One-click reset — but signed outputs must be **preserved**, not deleted.

**Backend (`server/index.js`):** `POST /api/lta/clean`. Body `{}` = clean ALL; `{ fileName?, ltaRef? }` = one LTA. It **deletes** the Excel input(s) from `config.directories.dums` and **moves** each `LTA N° <ref> READY` folder from outputs into the archive `outputs/deja signé et envoyé` (= `C:\sign\outputs\deja signé et envoyé` on prod; override via env `ARCHIVE_DIR`) — nothing signed is deleted. `PROBLEM`/non-READY folders and non-Excel files are left untouched. Returns `{ dumsRemoved, movedFolders[], archive }`. Refuses 409 while a job is `running`. Verified in temp dirs for both scopes: READY moved to archive, PROBLEM stays, inputs removed, note.txt kept.

**Frontend (`src/App.jsx`):** `cleanLtas(item?)` — `item` omitted → all, else that one. Red **🗑 Nettoyer** in the top header bar (global) + a small **🗑** on each LTA card (hidden while that LTA is signing / in order mode). `window.confirm()` per scope, then `refresh()` + reports `dumsRemoved` / archived count.

**Files changed:** `server/index.js`, `src/App.jsx`.

---

## 2026-07-29 — Import tab: match by ".xlsx + LTA Complet", not by sender

**Problem:** the sender filter (`== tajanielidrissi.ismail@gmail.com`) matched nothing on the real mailbox (`savedCount: 0`). DEBUG output (added this session) showed why: in the target inbox the completion email arrives as a colleague's **forward** (`TR: [BLOCAGE] LTA Complet …`, sender `nouhaila.orfane@…`), not directly from the gmail — so the sender check rejected the very email that carries the `.xlsx`. The original from the gmail is often also present (duplicate).

**Fix (`server/index.js`):** dropped the sender **filter**. New rule per ref: subject contains the ref **AND** the keyword **"complet"** (env `INBOX_SUBJECT_KEYWORD`, default `complet`) **AND** the mail has an `.xlsx` attachment whose name contains the ref (`generated_excel - <ref>.xlsx`). Among qualifying mails it **prefers** the gmail original when present, else takes the most recent (the forward). Saves that ref-named `.xlsx`. Sender is now only a soft preference. Verified with a mock of the real candidates → chooses Ismail's original, saves `generated_excel - 157-55633642.xlsx`; falls back to the forward when the original is absent.

**Also this session:** DEBUG instrumentation across every layer (accounts list, matched account, inbox reached + item count, per-ref subject-restrict count, per-candidate sender/xlsx/keyword, chosen mail). Emitted as `DEBUG=` lines → logged to the API journal (`[fetch-xlsx] …`) and returned in the response, shown in the Import tab under "Détails du diagnostic".

**Files changed:** `server/index.js`, `src/App.jsx`.

---

## 2026-07-23 — Feature: "Import" tab — pull DUM .xlsx from Outlook inbox by ref

**Goal:** a tab where the user pastes one or more LTA refs (e.g. `123-12344556`) and clicks **Confirmer**; the app searches the Outlook **inbox** for emails sent by `tajanielidrissi.ismail@gmail.com` whose subject contains the ref, downloads the attached `.xlsx`, and saves it into the dums folder — **no SMTP / IMAP / Graph**, just the local classic-Outlook profile via COM.

**Backend (`server/index.js`):** new `POST /api/lta/fetch-xlsx` (`{ refs: [...] }`). PowerShell COM opens `Outlook.Application` → MAPI, then selects the **`medafrica-log.com` account's** Inbox specifically (not the default account — user has two accounts, default is `emsi-edu.ma`): loops `$ns.Accounts`, matches `SmtpAddress` by equals-or-endsWith against `INBOX_ACCOUNT` (env `INBOX_ACCOUNT_EMAIL`, default `@medafrica-log.com` so it works on any machine), uses `$account.DeliveryStore.GetDefaultFolder(6)`. Per ref: a DASL `Restrict` on `urn:schemas:httpmail:subject LIKE '%ref%'`, then matches the sender via `PR_SENDER_SMTP_ADDRESS` (0x5D01001F, falls back to `SenderEmailAddress`) against `INBOX_SENDER` (env `INBOX_SENDER_EMAIL`, default the gmail), and `SaveAsFile`s each `.xlsx` into `path.resolve(config.directories.dums)` (absolute — same Outlook-relative-path lesson). Emits `RESULT=<ref>|saved|no_xlsx|not_found|<detail>` lines parsed into a JSON `results[]`. Script written UTF-16LE+BOM; classic Outlook required (COM), returns a clear FR error otherwise.

**Frontend (`src/App.jsx`):** new **Import** tab — textarea (refs split on whitespace/`,`/`;`, de-duped), **Confirmer** button → `fetchXlsxFromInbox`, per-ref result rows with status badges (Enregistré / Sans .xlsx / Introuvable / Erreur). On any save it calls `refresh()` so the new LTAs appear in the LTAs tab.

**Verified:** JS `node --check` OK; generated PowerShell `PS_SYNTAX_OK`; live COM read on this machine returned `INBOX_OK items=409` (Inbox reachable). "saved" path not exercised here (dev account isn't the recipient) — validate on the real machine.

**Files changed:** `server/index.js`, `src/App.jsx`.

---

## 2026-07-23 — Fix: Outlook auto-attach failed — RELATIVE paths (not encoding)

**Problem:** The "Envoyer par email" button always fell back to clipboard/Ctrl+V. A diagnostic (surface the real COM error + elevation) showed: **not** elevation (`Administrator: no`), but `Ce chemin d'accès n'existe pas` ("path does not exist") from `Attachments.Add`.

**Root cause (the real one):** `findLtaPdfs` built paths with `path.join(config.directories.signedLtas, …)`, and `signedLtas` is **`./outputs` (relative)**. So Outlook received relative paths like `outputs\LTA N° … \DUM 1 ….pdf`. `Test-Path` passed (PowerShell's cwd was the project root) so the guard let it through, but **`Outlook.Attachments.Add` resolves a relative path against its OWN working directory**, not ours — so it couldn't find the file and threw "path does not exist". A misleading French error that looked like an encoding problem but wasn't: the `°` is a plain U+00B0 and was never corrupted.

**Fix (`server/index.js`):** `findLtaPdfs` now returns **absolute** paths (`path.resolve(config.directories.signedLtas)` for the base and `path.resolve(folder, n)` per file). Proven against the real folder: `ATTACHED=3`, `METHOD=com`.

**Also kept from the investigation** (defensive, not the fix): the temp `.ps1` is written **UTF-16LE + BOM** (the encoding Windows PowerShell reads natively), and the endpoint returns `comErr` + `elevated`, surfaced in the UI clipboard-fallback alert for future diagnosis.

**Operational note:** the app spawns its API as plain `node server/index.js` with **no hot-reload**, and it sometimes leaves the old server alive on exit (zombies seen 2 days old). Twice this caused a "fixed but still failing" illusion because the app was talking to a stale server on port 3001. Killing the stale `node …/server/index.js` processes + a full relaunch is required to load server changes. **Follow-up worth doing:** have `electron/main.js` free port 3001 before spawning its own server.

**Files changed:** `server/index.js` (+ diagnostic in `src/App.jsx`).

---

## 2026-07-22 — "Envoyer par email": make it work with BOTH classic AND new Outlook

**Problem:** The first version drove classic Outlook via COM only. On a machine where COM was unavailable (the **new Outlook / web app has no COM interface at all**, or classic runs at a different elevation than the app) the button failed with "Could not open an Outlook draft".

**Solution — the endpoint (`POST /api/lta/outlook-email`) now degrades in one script:**

1. **Try classic Outlook COM** → opens a draft with the PDFs already attached. `METHOD=com` (best UX, zero extra clicks).
2. **On any COM failure** → `Set-Clipboard -LiteralPath` copies the PDFs to the clipboard as files **and** `Start-Process 'mailto:…'` opens the default mail app's compose (new Outlook, classic, whatever is registered) with To + Subject filled. `METHOD=clipboard`. The UI then tells the user to click in the message and press **Ctrl+V** to attach, and (in Electron) opens the PDF folder as a drag-in fallback.

**Details:**
- mailto uses **bare** comma-separated addresses (RFC 6068) extracted from the `Name <addr>` entries; the COM path keeps the friendly `Name <addr>` form.
- If even the mailto launch fails (no default mail app), the real PowerShell/stderr is surfaced in the response instead of a generic message.
- Response now includes `method` so the UI shows the right guidance.

**Verified:** bare-address extraction correct (7 addresses); generated PowerShell parses (`PSParser` tokenize, both branches) — validated without executing so no mail windows popped.

**Trade-off:** new Outlook can't be fully automated by anyone, so the clipboard+Ctrl+V (or drag) step is the best achievable there. Classic Outlook still gets the fully-automatic attach.

**Files changed:** `server/index.js`, `src/App.jsx`.

---

## 2026-07-22 — Feature: "Envoyer par email" button → Outlook draft with PDFs attached

**Goal:** A blue button on each LTA card that opens Outlook prefilled with the agreed To list, subject `MAWB {ref} - ({n} DUM)`, empty body, and **every signed DUM PDF already attached** — so the user just reviews and hits Send.

**Key constraint:** `mailto:` links cannot carry attachments. So on Windows we drive **classic Outlook via COM** (PowerShell) instead.

**Backend — `POST /api/lta/outlook-email` (`server/index.js`):**
- `findLtaPdfs(ltaRef)` locates the LTA folder (`… READY` / `… PROBLEM` / plain) and returns its `DUM N …pdf` files sorted by DUM number.
- Generates a PowerShell script: `Outlook.Application` COM → `CreateItem(0)` → set `To`/`Subject` → `Attachments.Add` each PDF → `Display($false)` (shows the draft, never sends).
- **Encoding gotcha (found via test):** LTA folders are named `LTA N° …`. Passing the `°` (and accented recipient names) inline via `powershell -Command` corrupts them on a non-UTF-8 console code page (`N°` → `N�`), so `Attachments.Add` silently misses the files. Fix: write the script to a temp `.ps1` **with a UTF-8 BOM** and run it with `-File` + `Test-Path -LiteralPath`. Verified `ATTACHED=2` through a real `N°` path.
- Failure (no classic Outlook / new-Outlook-only machine) returns `{ ok:false, folder }` with a clear reason.

**Recipients:** new `config.outlookTo` — env-overridable (`OUTLOOK_TO`) with the agreed 7-name default, kept **out of the automated `email.to` list** (different audience). Follows the env-first rule so it never causes the tracked-file merge conflicts we hit before.

**Frontend (`src/App.jsx`):** blue Outlook-style button (`Envoyer par email`) per card with ⏳/✓/⚠ states; on failure it alerts the reason and, in Electron, opens the PDF folder so the user can drag them in manually.

**Verified:** Outlook COM present on this machine; endpoint returns proper JSON for unknown LTA; attach mechanism confirmed end-to-end (2 PDFs) with the `N°` path; frontend builds.

⚠️ Requires the **classic Outlook desktop** app (the "new Outlook" and web versions can't be COM-automated). ⚠️ Windows-only (returns 400 elsewhere).

**Files changed:** `server/config.js`, `server/index.js`, `src/App.jsx`.

---

## 2026-07-21 — Redesign: tabbed app shell, logs moved out of the page bottom

**Problem:** Everything lived on one long scrolling page with the live logs pinned underneath the LTA cards. During a run you had to scroll past every card to watch progress, and the log box was a fixed 420 px window inside a page that itself scrolled — awkward and cramped.

**Solution — `src/App.jsx` rebuilt as a fixed-height app shell (`h-screen flex flex-col`) with two tabs:**

- **LTAs tab** — setup only: search box, select-all/none, priority-order toggle, and a responsive card grid (up to 4 columns on wide screens). Cards show a checkbox + priority `#N`, DUM count, LTA ref, the copyable MAWB subject, and the shipper input. Unselected cards dim to 60 % opacity so the run set is obvious at a glance.
- **Activity tab** — the log console gets the whole viewport: 5 stat tiles, level filter (all/info/warn/error/debug), a text filter, auto-scroll toggle, "Copy logs", and a `filtered/total` counter. Lines are colour-coded per level with a status dot.

**Details worth keeping:**

- **Live progress derived from the log stream.** The backend only fills `job.progress` *after* the whole job finishes (known issue, TASKS #10), so a naive progress bar would sit at 0 for an entire run. The UI counts `✓ SUCCESS` / `↷ SKIPPED` / `✗ FAILED|ABORTED` lines while running and switches to the authoritative `job.progress` once the job ends. Caveat noted in code: `job.logs` is capped at 1000 entries server-side, so these can undercount on very long runs.
- **Progress bar + current LTA live in the header**, so they stay visible from either tab.
- The Activity tab auto-opens when a run starts; it shows a pulsing dot while running and a red failed-count badge afterwards.
- The card of the LTA currently being signed is highlighted (green ring + `● SIGNING`), parsed from the latest `Processing LTA …` log line.
- Order mode: fixed-width ↑/↓ buttons (they previously stretched the full row width in the vertical list layout).

**Verified** by running the real app (Vite + API) and screenshotting all three states — LTAs grid, Activity console, and priority-order mode — with live data from `dums/`.

**Files changed:** `src/App.jsx`.

---

## 2026-07-21 — Feature: one-click copyable mail subject

**Problem:** When sending an LTA's PDFs manually, the user had to retype the subject (`MAWB 607-54334361 - (18 DUM)`) by hand every time — tedious and typo-prone.

**Solution — the subject is produced in three places, so it can be copied from wherever the user already is:**

1. **`email_subject.txt`** written into the LTA output folder alongside the PDFs (`server/automation.js`) — the user is usually already in Explorer there.
2. **Copy button on each LTA card** (`src/App.jsx`): shows the subject in monospace with a `Copy` action that flashes `✓ Copied`. Available immediately, not only after a run, since the subject derives from `ltaRef` + `dumsCount`.
3. **Logged** (`📋 Mail subject ready to copy: …`) so it's also selectable from the app's log panel.

Clipboard writes try `navigator.clipboard.writeText` first and fall back to a hidden-textarea `execCommand("copy")` — Electron's `file://` origin is not a secure context, so the modern API can be unavailable there.

**Format is duplicated between server and client, so they must be kept in sync** — verified both render byte-identical `MAWB 607-54334361 - (18 DUM)`.

⚠️ Note: this copy text uses `MAWB {ref} - ({n} DUM)` (with a dash), while the **automated** email subject in `notifications.js` uses `MAWB {ref} ({n} DUM)` (no dash), per the original spec. Unify if that discrepancy is unintended.

**Files changed:** `server/automation.js`, `src/App.jsx`.

---

## 2026-07-21 — Feature: desktop screenshot fallback when the browser is gone

**Problem:** The failure email's screenshot comes from the Playwright page, so in the exact case you most want to see — Edge closed/crashed mid-run — it produced `(No screenshot available)`. No visibility into what was actually on screen.

**Solution (`server/notifications.js`):** `captureScreenshot()` now cascades — BADR page first, and if that's impossible, the **whole Windows desktop** (all monitors, virtual-screen bounds).

- Implemented with **PowerShell + .NET `System.Drawing`** (`Graphics.CopyFromScreen`), which ship with Windows. Deliberately **no npm package**: adding a dependency has repeatedly broken other machines that hadn't run `npm install` (see the nodemailer incident), and a screenshot helper must never be able to take the app down.
- Split into `captureBrowserScreenshot` / `captureDesktopScreenshot`; `captureScreenshot` returns `{ path, source: "browser"|"desktop" }` or `null`.
- The email labels which one it is ("Desktop at the time of failure (the browser was closed…)") so the reader isn't misled into thinking a desktop shot is the BADR page.
- Screenshots are named `…-browser-<ts>.png` / `…-desktop-<ts>.png` in `logs/screenshots/`.

**Caveat (documented in code):** desktop capture needs an interactive, unlocked session — a locked workstation or service-mode run yields a black image. If both captures fail the email still sends, saying the session may be locked.

**Verified** on Windows: real 176 KB PNG of the actual desktop in ~1.1 s, `source: "desktop"`, with the browser reported closed.

**Files changed:** `server/notifications.js`.

---

## 2026-07-21 — Fix: chrono counted already-signed DUMs + browser-closed cascade

**Problem 1 — chrono budgeted work that was already done.** The watchdog used `lta.dums.length`, so a resumed run with 12 of 18 DUMs already signed still budgeted ~23 min even though only 6 remained (~8 min of work). The alarm was ~15 min too loose to catch a real stall.

**Fix:** before arming the timer, count DUMs that have **no PDF on disk** (`pendingCount`) and budget `pendingCount × minutesPerDum`. If nothing is pending, the chrono is skipped entirely. Logs now read `⏱️ Chrono started …: expected finish in ~8 min (6 of 18 DUM remaining)`. `setCurrentLta` still records the LTA's **total** DUM count — that identifies the LTA in the email subject, and shouldn't shrink on resume.

**Problem 2 — a closed browser produced a cascade of phantom failures.** When Edge was closed mid-run, Playwright threw `Target page, context or browser has been closed` for every subsequent DUM. The loop ground through all of them in one second, marking DUMs that were **never attempted** as `failed`, then emitted a "no CSV entry" warning per DUM in the recovery passes. Observed twice: 17 phantom failures, then 6.

**Fix:** new `isBrowserClosedError()` (matches "target closed", "browser has been closed/disconnected", "websocket error"). On match the DUM loop records that one DUM as failed, sets `browserClosed`, and **breaks**. That flag also skips both reprint recovery passes (they need a live browser) and breaks the outer LTA loop, so untried DUMs/LTAs stay untouched and resume cleanly on the next run.

**Files changed:** `server/automation.js`.

---

## 2026-07-21 — Fix: per-machine recipient lists caused recurring git merge conflicts

**Problem:** Different machines need different email recipients (test inbox vs the real Medafrica team). Users were changing them by editing `server/config.js` — a **tracked** file. `electron/main.js` auto-pulls on every startup (`git stash` → `pull` → `stash pop`), so a local edit to `config.js` plus an upstream change to the same file produced a conflicted `stash pop`. That wrote `<<<<<<< Updated upstream` markers into `config.js`, making it invalid JS → the API server crashed on startup → `SyntaxError: Unexpected token '<<'` and a dead backend (`ECONNREFUSED` on every `/api/*` call).

**Solution — recipients live ONLY in `.env`; `config.js` has no list at all:**

- Removed `DEFAULT_EMAIL_TO` / `DEFAULT_EMAIL_CC` entirely. `config.email.to/cc` are now `toList(process.env.EMAIL_TO, [])` — env-only, **no hardcoded fallback**. With no list in the tracked file, there is nothing left to merge-conflict over.
- **No recipients ⇒ no email**, logged loudly (`EMAIL_TO is empty — set EMAIL_TO in .env`). Guard added at the single choke point `getTransporter()`, so it covers both the READY and the failure email. Deliberate: a missing list must never silently fall back to the real team, and every machine states its recipients explicitly.
- Reverted the `enabled: false` hard-disable back to `toBool(process.env.EMAIL_ENABLED, false)`; email is toggled per machine from `.env`, never by editing code.
- `toList()` improved: splits on `;` `,` or newline, keeps `Name <addr>` Outlook-paste entries, drops fragments without `@`.
- `.env.example` carries both ready-to-paste blocks (test inbox / full production list).

**Rule going forward:** shared *code* → tracked files; every machine-specific *value* → `.env` (gitignored). Never edit a tracked file to configure one machine.

**Recovery for an already-conflicted checkout:** `git checkout HEAD -- server/config.js`, then `git stash drop`.

**Files changed:** `server/config.js`, `.env.example`.

---

## 2026-07-21 — Fix: signing loader wait burned the full 120 s timeout on every DUM

**Problem:** After signing, BADR's "Traitement en cours" overlay disappears within seconds, but the app took ~2 min to notice. Log timing gave it away: `16:43:38 → 16:45:38` = **exactly 120 000 ms** = `config.timeout`. That wasn't detection, it was a timeout expiring.

**Root cause:** `waitForSigningReady` Phase 1b latched `waitFor({ state: "hidden" })` onto whatever `firstVisible(page, LOADING_SELECTORS)` returned. The third entry was the catch-all `div:has-text('Traitement en cours')`. Playwright's `:has-text()` matches any element whose **subtree** contains the text, and PrimeFaces hides its blockUI with `display:none` while **leaving the text in the DOM**. So once the real overlay hid, `firstVisible` fell through to that catch-all and `.first()` latched onto an always-visible outer page wrapper — which never becomes hidden. The wait burned the full timeout, the error was swallowed by `.catch(() => {})`, and it still logged `✓ Signing loader hidden`. Counter-intuitively, **the faster BADR signed, the more reliably the full 120 s was wasted.**

The same catch-all also made Phase 2 always "see" a loader, so IMPRIMER was never confirmed → the spurious `⚠ Signing readiness wait exceeded 6s post-loader` warning on every DUM.

**Solution (`server/automation.js`):**
1. New **`SIGNING_LOADER_SELECTORS`** — narrow, no catch-all (mirrors `DECL_SPINNER_SELECTORS`, which provably clears in 2-3 s). `LOADING_SELECTORS` is kept for *detection*, where a broad match is harmless.
2. New **`waitForSigningLoaderGone()`** — **polls** (re-evaluating selectors each time) until no *visible* loader, requiring 2 consecutive clear polls to ignore re-render blips. Returns `{ cleared, elapsedMs }`. Polling avoids latching onto an ancestor that never hides.
3. Phase 1b logs **truthfully**: `✓ Signing loader hidden after Xs` vs `⚠ Signing loader still visible after Xs (timeout)`.
4. Phase 2 now uses the narrow set, fixing the bogus 6 s warning.

**Verified** in a real headless Chromium reproducing the PrimeFaces DOM: after `display:none`, the broad selector still reported a visible loader and `waitFor` timed out, while the narrow poll cleared in **285 ms**.

**Impact:** ~2 min saved **per DUM** — roughly **30+ min on a 19-DUM LTA**.

**Files changed:** `server/automation.js`.

---

## 2026-07-21 — Feature: "Signature Failed" email with screenshot on every failure path

**Problem:** Only the happy path (LTA READY) sent an email. When an LTA failed, hung, the browser was closed, or the process stopped, there was no email — and no visual of what BADR was showing at the moment things broke.

**Solution — `server/notifications.js`:**

- **`sendLtaFailedEmail`** — Subject `Signature Failed LTA N°{ref} ({n} DUM)`; body is the failure reason plus the **screenshot of the current BADR screen embedded inline** (`cid:badrscreen`) and attached.
- **`captureScreenshot`** — screenshots the live page into `logs/screenshots/`. Returns `null` (never throws) when the browser is closed/unreachable; the email still goes out saying no screenshot was available.
- **`setActiveConnection(conn)`** — stores the **connection**, not the page, because `conn.page` is swapped during reprint popups, so screenshots always follow the current page.
- **`setCurrentLta` / `clearCurrentLta`** — tracks the in-progress LTA so job-level and process-level failures (which don't know the LTA) can still build the subject.
- **`notifyLtaFailure`** — one-stop notifier: screenshot + email, **deduped to one failure email per LTA per run** (so a chrono timeout followed by a PROBLEM finish doesn't double-send). Never throws.

**Wired into all failure paths:**

| Path | Location |
| --- | --- |
| LTA finishes PROBLEM | `automation.js` finalization |
| Chrono timeout (taking too long) | `automation.js` chrono `setTimeout` |
| Job crash / browser closed mid-run | `index.js` `/api/jobs/run` catch |
| Process stopped (SIGINT/SIGTERM) | `index.js` shutdown handler |

**Verified** with a stubbed transport: subject format, inline screenshot embed, dedup, browser-closed fallback, current-LTA fallback, and no-LTA skip.

⚠️ **Email is still hard-disabled** in `config.js` (`enabled: false`). Failure emails are logged as skipped until that's reverted to `toBool(process.env.EMAIL_ENABLED, false)`.

**Files changed:** `server/notifications.js`, `server/automation.js`, `server/index.js`.

---

## 2026-07-07 — Fix: LTA-READY email left no trace in the per-LTA log

**Problem:** The notification block runs *after* `fs.move()` renames the LTA folder to `… READY`. The per-LTA log (`{ltaRef}.log`) lives **inside** that folder, and `appendLtaLog` swallows all write errors. So every line emitted after the rename (the READY mark **and** the email attempt) tried to append to the now-missing old path, threw `ENOENT`, and was silently dropped. The log always cut off exactly at `Completed LTA … pdfs=N/N`, making it look like the email code never ran / failed silently.

**Solution (`server/automation.js`):**
- `ltaLogPath` changed from `const` → `let`; after `fs.move()` it's repointed to `path.join(targetFolder, "{ref}.log")` so post-rename lines land in the renamed folder's log.
- Email path now logs a reason in **every** branch: disabled (`EMAIL_ENABLED` not true), already-sent (`.email_sent` marker), sending…, sent/failed. No more silent "no email".
- **Diagnostic tell:** a `.email_sent` marker file is written in the READY folder **only on successful send** — its presence confirms the email went out.

**Files changed:** `server/automation.js`.

---

## 2026-07-06 — Feature: Email on LTA READY + WhatsApp alerts + per-LTA chrono

**Problem:** When an LTA finished (all DUMs signed → `READY` folder) there was no automatic hand-off — someone had to manually email the signed PDFs to the Medafrica team. There was also no alerting when an LTA landed in `PROBLEM`, when the job crashed, or when a run hung/took abnormally long.

**Solution — new `server/notifications.js` module + hooks:**

1. **Email on READY (`sendLtaReadyEmail`)** — When an LTA is finalized as READY, send an SMTP email (nodemailer) with:
   - Subject: `MAWB {ltaRef} ({n} DUM)` — e.g. `MAWB 157-53611950 (15 DUM)`.
   - Empty body; **all** signed DUM PDFs attached.
   - Recipients: real Medafrica To/CC lists hardcoded in `config.js` (`DEFAULT_EMAIL_TO` / `DEFAULT_EMAIL_CC`), overridable via `EMAIL_TO` / `EMAIL_CC` env for testing.
   - Sent once per LTA — guarded by a `.email_sent` marker file in the folder so re-runs of an already-READY LTA don't re-spam.
   - Trigger point: `runSigningJob()` finalization block in `automation.js` (`isReady === true`).

2. **WhatsApp alerts (`sendWhatsApp`, CallMeBot provider)** fired on:
   - **PROBLEM folder** — LTA finished with failures / missing PDFs.
   - **Chrono timeout** — per-LTA watchdog `setTimeout`. Rule: 16 DUMs ≈ 20 min ⇒ `LTA_MINUTES_PER_DUM = 1.25`. Timer = `dumCount × 1.25` min; if the LTA isn't done by then (stuck/stopped/missing DUMs) it fires independently. Timers held in a job-scoped `Map`, cleared on LTA completion and in a `finally` on job abort.
   - **Job error** — `catch` in `server/index.js` `/api/jobs/run`.
   - **Process stop** — best-effort `SIGINT`/`SIGTERM` handlers in `index.js` (only if a job is running; hard `kill -9` can't be caught).

3. **Config (`server/config.js`)** — new `email`, `whatsapp`, `ltaChrono` sections + `toBool`/`toFloat`/`toList` helpers. `.env.example` documents all new vars.

**Setup still required by the user:**
- Create/populate `.env` (none exists in the checkout) with the `EMAIL_*` block.
- Get a CallMeBot API key (message their WhatsApp number) and set `WHATSAPP_CALLMEBOT_APIKEY`. Until then WhatsApp is gated off and silently skipped.

**Interpretation note:** "LTA finished = all DUMs done + validated series replaced by signed definitive series" is exactly the existing READY condition (`allPdfsExist && ltaFailed === 0`), so the email triggers on READY.

**Files changed:** `server/notifications.js` (new), `server/config.js`, `server/automation.js`, `server/index.js`, `.env.example`, `package.json` (nodemailer dependency).

---

## 2026-05-22 — Fix: Series format validation too strict

**Problem:** `SERIES_REGEX = /^\d{7}[A-Z]$/i` required exactly 7 digits. Series like `76945B` (5 digits) caused `Invalid series format` and the DUM was skipped entirely.

**Solution:** Relaxed to `/^\d{4,7}[A-Z]$/i` — accepts 4–7 digit prefixes, covers all real-world BADR series lengths.

**Files:** `server/excelParser.js`

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
