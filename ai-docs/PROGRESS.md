# Change Log

_Populated as we work. Each entry = problem + solution + files changed._

---

## 2026-10-08 — Import tab: reads the "LTA Complet" emails from GMAIL over IMAP (Outlook only as fallback)

**Why:** the import depended on classic Outlook's local mailbox copy, which on the device is stuck (data file 47.7 / 50 GB, stopped 02/10 13:10) and can't be relied on for a user who lives in the new Outlook. The user confirmed the "LTA Complet" mails are also in the sending Gmail account (`tajanielidrissi.ismail@gmail.com`), so the app now reads them there — live, no local copy, same result whichever Outlook the PC uses.

**New `server/gmailImport.js`** (`imapflow`, **lazy-imported** like nodemailer so a PC that hasn't run `npm install` can't crash the server; pinned `^1.7.8` = Node 16+, because 2.x needs Node 20 and the device's Node version is unknown):
- connects to `imap.gmail.com:993` with `EMAIL_USER`/`EMAIL_PASS` (override `IMAP_USER`/`IMAP_PASS`/`IMAP_HOST`/`IMAP_PORT`; independent of `EMAIL_ENABLED`; a "abcd efgh ijkl mnop"-style app password has its cosmetic spaces stripped);
- opens **All Mail found by its `\All` special-use flag** (so it works in any account language; falls back to `\Sent`, then INBOX), read-only;
- per ref: `SEARCH SUBJECT <ref>` → fetch envelope + bodyStructure of up to 30 newest hits → keep subject contains the ref **and** `complet` (`INBOX_SUBJECT_KEYWORD`) **and** an `.xlsx` part named with the ref → most recent wins (an "Updated" resend beats the original). Speedaf "IMPORT PRE-ALERT" mails are ignored (no keyword). `no_xlsx` when a matching email exists without such an attachment;
- downloads the part (`client.download`, decoded), writes `generated_excel - <ref>.xlsx` into the dums folder (name sanitised) and verifies it starts with `PK` (zip) so an undecoded body can't be saved as an xlsx;
- throws `GmailImportError` with a `code` (`NO_CREDENTIALS` / `NO_PACKAGE` / `AUTH` / `NETWORK`) when the account itself can't be used.

**Route (`server/index.js`):** `IMPORT_SOURCE` env — `auto` (default) = Gmail when credentials exist, **Outlook COM only as a fallback when Gmail can't be used** (never just because a ref wasn't found); `gmail` = Gmail only (clear error, no fallback); `outlook` = previous behaviour. Response adds `source` (`gmail`/`outlook`), `account`, and `gmailNote` (why Gmail was skipped). `/api/config` adds `importSource` + `importAccount`.

**Frontend (`src/App.jsx`):** the tab title/description say Gmail + the account when that's the source; the red "pas trouvé en mail" toast says `Cherché dans Gmail (<account>) : aucun email « LTA Complet » avec un fichier .xlsx pour cette référence…` (a Gmail miss is real — no stale-copy logic), and shows `Gmail non utilisé : <reason>` if it fell back to Outlook and Outlook found nothing.

**Verified (no real Gmail, no real mail read):** a local fake IMAP server laid out like Gmail (`[Gmail]/Tous les messages` with `\All`): found the right email among a Speedaf pre-alert, a no-xlsx mail and a newer resend; the saved file is byte-identical to the original and parses as a real xlsx; not-found ref → `not_found`; `no_xlsx` case; wrong password → `AUTH`, nothing listening → `NETWORK`, no creds → `NO_CREDENTIALS`. The **real server over HTTP**: Gmail hit + miss (`source=gmail`, file saved, **no Outlook fallback on a miss**), `auto` + wrong password → falls back to Outlook with `gmailNote`, `IMPORT_SOURCE=gmail` + wrong password → HTTP 500 + clear reason, no credentials → `importSource: outlook`. UI screenshot/text checked; `vite build` OK; dums folder untouched. **Real Gmail test (read-only, with the user's rotated app password, files to a temp folder then deleted):** login OK, `[Gmail]/Tous les messages` found via `\All`, `SEARCH SUBJECT` on the hyphenated refs works (4/2/4 hits), the 3 test refs (`235-98029853`, `065-45991864`, `235-98102233`) all **saved** as valid xlsx (zip header, parsed, sheet `Summary` 122–143 rows, 7.6–8.3 KB — matches the "8 Ko" seen in Outlook), the app's own `MAWB … (n DUM)` sends and the unrelated "2éme acheminement" mails are correctly ignored. ~3 s for 3 refs.

**Two real-world findings, both fixed in `server/gmailImport.js`:**
1. **Malformed attachment header.** The generator of the "LTA Complet" emails writes `Content-Disposition: attachment; filename= generated_excel - 065-45991864.xlsx` (unquoted, spaces) with `Content-Type: application/octet-stream`. Outlook tolerates it; **Gmail's BODYSTRUCTURE parser drops it, so the parts arrive nameless** and the first real run answered `no_xlsx` for all three refs. Fix: for plausible mails (ref + keyword in the subject) whose non-text parts have no name, fetch each part's MIME header (`bodyParts: ["N.mime"]`) and read the name leniently — `filenameFromMimeHeader` handles unquoted/quoted values, folded lines, `filename*=utf-8''…` (RFC 2231), RFC 2047 encoded words, and falls back to the Content-Type `name`.
2. **"[ERREUR DUM]" emails.** For `235-98029853` Gmail holds two `[ERREUR DUM] LTA Complet - 14eme LTA …` mails (05/10 16:44, 18:04) and then the clean one (18:44). `pickCandidate` now prefers a mail **not** flagged `[ERREUR…]` even when older (importing a faulty Excel = signing wrong DUMs), newest among equals; if only flagged mails exist the file is still imported but the result carries `⚠ seul un email « [ERREUR DUM] … » existe : vérifiez le fichier avant de signer`. _Decision worth confirming with the team: is an `[ERREUR DUM]` Excel ever the right one to sign?_

**Regression tests (fake IMAP):** header parsing (9 forms), malformed-header mails, error-vs-clean ordering both ways, error-only → warning, well-formed headers; earlier suites re-run green.

**Device rollout:** commit + push, then on the device run **`npm install` once** in the app folder (auto-pull doesn't run it; `package.json` gained `imapflow`), then fully relaunch. Without it the app falls back to Outlook and says so (`Gmail non utilisé : Le paquet « imapflow » n'est pas installé…`). The device's `.env` needs `EMAIL_USER` + `EMAIL_PASS` (Gmail app password). First real test: Import tab → the 3 refs; the log shows `[fetch-xlsx] Gmail IMAP connected as … / Searching mailbox: … / [ref] candidate …`.

**Security note (still open):** the OLD app password is on GitHub (`origin/main:.env.example`, same value as this PC's `.env`) — now revoked by the user. The user then put the **NEW** password into the working copy of `.env.example` (tracked, uncommitted, unstaged) — committing it would leak the new one the same way. It must live only in each PC's `.env` (gitignored); `.env.example` should carry a placeholder. This PC's `.env` still holds the old (revoked) password, so the app here can't log into Gmail until it is updated (the real test above injected the new one for one process only). An app password also grants IMAP read access to that whole account, not only SMTP sending. Also: while masking passwords in a check, a bug of mine printed one 4-letter group of each (old and new) into the tool output — negligible for the revoked one, but another reason to rotate if that transcript is shared.

**Files changed:** `server/gmailImport.js` (new), `server/index.js`, `server/config.js`, `src/App.jsx`, `package.json`, `.env.example`.

---

## 2026-10-08 — Device confirmed: .eml drafts work; Import blocked by classic Outlook's full data file

**.eml method validated on the device:** log `method: "eml"`, 16 PDFs; toast "Brouillon ouvert — 16 PDF joints". (Earlier `Start-Process -LiteralPath` bug fixed.)

**Import still fails — now fully diagnosed (device log):** `connectionMode=400` (not connected), `windowsOpen=0` (the app starts classic hidden; `processStarted` is 19:18/19:20 → it is relaunched each import), `newestMail=2026-10-02 13:10`, **`size=47.7GB limit=50GB`**, **`Sent Items=2721`**, **`Outbox=29`**. Classic's local `.ost` is at 95 % of its limit: every LTA email carries ~10–30 MB of PDFs, and 2721 of them sit in Sent Items. That explains why classic stopped taking in mail on 02/10 and why its "Éléments envoyés" dialog appeared. The 3 refs (`235-98029853`, `065-45991864`, `235-98102233`) exist in the new Outlook, but the import can only read classic's copy. The Windows "default app" setting is irrelevant to the import (it never uses the default mail app, only classic COM); it only mattered for the email buttons.

**Change (`src/App.jsx`):** the red toast now lists **every** cause found, as bullets, instead of the first one — on the device it had only said "déconnecté" and hidden the full data file. Causes: offline / disconnected, data file ≥ 90 % (with the Sent Items count), N mails stuck in the Outbox ("à vérifier avant tout nettoyage"), and the previous fallbacks only when nothing else applies. Toast detail text uses `whitespace-pre-line`. Verified in the real UI with the device's numbers (mocked response); `vite build` OK.

**Warning for the device:** the 29 items in classic's Outbox exist only in classic's local file. Rebuilding/renaming the `.ost` loses them. They are probably "Envoyer par email" mails created through classic that never left — check which ones the team actually received before wiping.

**Options (user to choose):** (A) repair classic — empty/archive Sent Items and rebuild the `.ost` with a 3-month sync window; fragile, it will fill again (each LTA mail adds ~30 MB). (B) Gmail IMAP import — the "LTA Complet" mails come from `tajanielidrissi.ismail@gmail.com`; if they are in that account's Sent Mail the app can fetch the `.xlsx` from there, independent of any Outlook. Needs one npm package (`imapflow`) + `npm install` on the device (auto-pull doesn't run it), and IMAP credentials in that PC's `.env`. Gate: confirm the mails are in Gmail's Sent folder.

**Files changed:** `src/App.jsx`.

---

## 2026-10-08 — New Outlook: drafts opened as .eml with the PDFs really attached (paste kept as fallback)

**Why:** the auto-paste (entry below) depends on the draft window being in front at the right moment and on the new Outlook accepting pasted files. The user found a better route: an `.eml` file whose first line is `X-Unsent: 1` opens in Outlook as an **editable draft**, attachments included. Reported flaky in some new-Outlook builds (2024: opened read-only; late 2025: couldn't save as draft without a `Message-ID`, fixed later) — hence the explicit Message-ID and the fallback.

**Change (`server/index.js`):**
- `NEW_OUTLOOK_METHOD` (env, default `eml`; `paste` = previous behaviour), exposed in `/api/config` as `newOutlookMethod`.
- `writeDraftEml({ to, subject, pdfs })` builds the message with nodemailer's **`streamTransport` (`buffer: true`, `newline: "windows"`) — builds, sends nothing** — To = `config.outlookTo`, the usual subject, every PDF attached, `messageId <uuid@badr-sign.local>`, then prepends `X-Unsent: 1\r\n` and writes `<tmp>/badr-drafts/<subject> <timestamp>.eml` (files > 2 days old are cleaned up). **Gotcha found while testing:** with an empty `text` body nodemailer makes a 1-PDF email *be* the PDF (no body part, not an editable draft) — so it uses `html: "<p></p>"` to always get `multipart/mixed` [html body + PDFs].
- `openWithDefaultApp(file)` → `Start-Process -LiteralPath` (ShellExecute → the Windows default app for `.eml`).
- In the endpoint, `mode: "new"` + `eml` → write + open → `{ method: "eml" }`. Any error → logged and falls through to the mailto + paste script.

**Frontend (`src/App.jsx`):** `method: "eml"` → green toast "Brouillon ouvert — N PDF joints — vérifiez avant d'envoyer". `sendEmailRequest` returns `attached` (true for `com`, `eml`, or a successful paste); **Envoyer tous** only pauses for a draft with `!attached`, and its confirm text no longer tells the user to keep hands off the keyboard unless the paste method is configured. Summary: "Avec leurs PDF joints automatiquement : x / n".

**Verified:** `writeDraftEml` extracted verbatim from `server/index.js` and run on dummy PDFs (1 and 3): first line `X-Unsent: 1`, Message-ID present, both recipients, `multipart/mixed` with an HTML body part, the right number of PDF attachments, CRLF line endings. `node --check` + `vite build` OK. A standalone test file `outputs/TEST-brouillon-nouvel-outlook.eml` (gitignored; 2 dummy PDFs, To = the user's own Gmail) was generated for a double-click check. **Not verified:** how the device's new-Outlook build opens it — editable draft? attachments? "Enregistrer" works? signature present?

**Device prerequisite (done by the user):** `.eml` → Outlook (new) in Windows default apps.

**Bug on first device run (fixed):** `eml draft failed — Start-Process : Impossible de trouver un paramètre correspondant au nom « LiteralPath »` — Windows PowerShell 5.1's `Start-Process` has no `-LiteralPath` (only `-FilePath`); I hadn't checked the parameter binding. Now `Invoke-Item -LiteralPath` (exists in 5.1, opens with the default app, no wildcard parsing of the `(16 DUM)` parentheses). Verified on PS 5.1: `Start-Process` lacks the parameter, `Invoke-Item` has it, and the exact server command binds and runs in `-WhatIf` on a draft-named file (exit 0). The fallback did its job on that run: `method: "clipboard" … pasted: "sent"`.

**Learned from that run — the new Outlook accepts pasted files:** after the auto-paste it asked _« Comment voulez-vous partager ces fichiers ? Vos fichiers sont assez volumineux (14 Mo)… »_ → "Charger et partager sous la forme de liens OneDrive" / **"Joindre une copie"**. The right choice is **Joindre une copie** (the team receives the PDFs themselves; OneDrive links point into the sender's OneDrive). With the .eml method the PDFs are already inside the message, so this prompt shouldn't appear.

**Files changed:** `server/index.js`, `src/App.jsx`, `.env.example`.

---

## 2026-10-08 — New Outlook: the app pastes the PDFs into the draft itself + "open folder" error fixed

**Context:** on the device the new Outlook is now the Windows default mail app, so the "Nouvel Outlook" mode opens the draft there (To + subject filled). The user wants the PDFs attached automatically instead of pressing Ctrl+V.

**Constraint:** the new Outlook offers no way for another program to attach files (no COM, no command-line attach, `mailto:` can't carry attachments). Truly server-side attachments would need Microsoft Graph (Entra ID app registration on medafrica-log.com). What *is* possible locally: the PDFs are already on the clipboard as files, and the draft window is titled with the subject.

**Fix — auto-paste (`server/index.js`, mailto path):** after `Start-Process mailto:` the script waits (up to `MAILTO_PASTE_WAIT_SEC`, default 20 s) until the **foreground** window's title contains the subject (`MAWB {ref} - ({n} DUM)`, unique per LTA; matched with `WildcardPattern.Escape`, read via a small `user32` `GetForegroundWindow`/`GetWindowText` helper). It nudges the draft forward with `WScript.Shell.AppActivate` if it opened behind, waits 2 s for the compose to finish loading (cursor lands in the body), re-checks the draft is still in front, then `SendKeys ^v`. It never pastes into any other window. Reports `PASTE=sent|nowindow|lostfocus|error` → JSON `pasted`. `execFile` timeout = 40 s + the wait.

**Frontend (`src/App.jsx`):**
- single LTA, pasted → green toast "Email ouvert — N PDF collés automatiquement — vérifiez les pièces jointes…"; not pasted → the previous manual path (folder opened + Ctrl+V alert).
- **Envoyer tous**, new mode → runs on its own (each draft opened + pasted before the next overwrites the clipboard); pauses with the manual "Ctrl+V puis OK" confirm only for an email that couldn't be pasted. The opening confirm warns not to touch keyboard/mouse during the run; the summary shows `PDF collés automatiquement : x / n`.

**Fix — "Error opening folder" (`electron/main.js`):** the device log showed `Command failed: explorer.exe /select,"C:\sign\outputs\LTA N° … READY"` on every call. `explorer.exe` always exits with code 1, so `execSync` threw even though the window opened (and building a shell command from a path was an injection risk — old TASKS item #6). Now `shell.openPath(path.resolve(folder))`, which opens the folder itself (PDFs visible, ready to drag). **Main-process change → full app relaunch needed.**

**Verified:** both email scripts (classic + new) parse; a probe compiles the window-title helper and confirms the subject pattern matches its own title (also with an app suffix) but not another LTA's; `node --check` server + electron main; `vite build` OK. **Not verified (needs the device):** that the new Outlook attaches files pasted with Ctrl+V, and that the draft gets focus in time — check the log line `Mail draft opened … pasted: "sent"` and the attachments in the draft.

**Files changed:** `server/index.js`, `src/App.jsx`, `electron/main.js`.

---

## 2026-10-06 — Device: classic Outlook CONNECTED (700) but still stuck → diagnostic now reports its data file

**Data from the device:** `connectionMode=700 workOffline=False windowsOpen=0`, `newestMail=2026-10-02 13:10`, `totalItems=6458` (identical on every run). So classic **is connected to Exchange** and still stores no new mail → not a sign-in/connection problem. It fits classic's own dialog ("Éléments envoyés contient le nombre maximal d'éléments… les messages envoyés seront enregistrés dans la Boîte d'envoi"): classic can't write new items locally.

**Bug fixed (`src/App.jsx`):** the toast's "Cause probable" checked `windowsOpen=0` before the connection mode, so it told the operator classic was hidden and couldn't show a sign-in prompt — wrong for a connected Outlook. New order: work-offline → offline (100/200) → disconnected (300/400) → **data file ≥ 95 % of its limit** → **connected (≥ 500) but not storing new mail** (points to classic's own error dialog, e.g. Éléments envoyés full) → hidden window → fallback. Appends "N email(s) bloqués dans sa Boîte d'envoi" when the Outbox isn't empty.

**New diagnostic (`server/index.js`):** `DEBUG=Classic data file: <.ost path> size=<GB> limit=<GB> | Sent Items=<n> | Outbox=<n>` + `DATAFILE_STATE=` → `inbox.dataFileGb / dataFileLimitGb (MaxLargeFileSize, default 50) / sentItems / outboxItems`. Sizes formatted with the invariant culture (a French locale would print `4,1`). Verified on this PC (read-only, fake ref): `size=4.1GB limit=50GB (default) | Sent Items=5 | Outbox=0`, parsed by the server regex; script parses; `vite build` OK.

**Next on the device:** pull + relaunch, one import, read the `Classic data file` line. If the .ost is near its limit or Sent Items is huge: free space / archive Sent Items, or rebuild the .ost (close Outlook, rename the .ost, reopen → fresh download from the server; anything only in the local Outbox is lost). The Gmail-IMAP import (no Outlook dependency) remains the durable option — awaiting the user's go-ahead.

**Files changed:** `server/index.js`, `src/App.jsx`.

---

## 2026-10-06 — "Outlook classique / Nouvel Outlook" switch for the email buttons + shorter futile sync wait

**Problem:** on the device the user works in the **new** Outlook, but "Envoyer par email" / "Envoyer tous" always opened a **classic** Outlook draft. Changing the Windows default mail app doesn't help: the endpoint drives classic Outlook directly through COM (which succeeds as long as classic is installed) and only used the default mail app (`mailto:`) as a fallback when COM failed. The new Outlook has no automation interface (no COM, no command-line attach), so it can never get a draft with the PDFs pre-attached.

**Fix:**

- **`src/App.jsx`** — segmented switch **Outlook classique | Nouvel Outlook** in the header next to "Envoyer tous", saved per device in `localStorage` (`outlookMode`), sent as `mode` to `/api/lta/outlook-email`. Tooltip explains both modes and that the new Outlook must be the Windows default e-mail app.
  - Single LTA, new mode: opens the PDF folder (drag-and-drop fallback) + an alert "Les N PDF sont copiés — Ctrl+V…".
  - **Envoyer tous**, new mode: one email at a time — the clipboard only holds one LTA's PDFs, so after each email a `confirm()` waits until the user has pasted and clicks OK (Annuler stops); the summary says how many were opened / where it stopped.
- **`server/index.js`** — `mode: "new"` → `$useCom = $false`: COM is skipped and the script goes straight to `Set-Clipboard -LiteralPath` (PDFs as files) + `Start-Process mailto:` (default mail app). Classic mode unchanged (COM first, same fallback on COM failure). The response includes `mode`.
- **Import sync wait:** the device's diagnostic showed a hidden COM-started classic (`windowsOpen=0`) stuck at `connectionMode=400` for the full 45 s. The wait loop now re-reads the account's connection mode and gives up after 15 s if it is still ≤ 400 (offline/disconnected).

**Verified:** both email scripts parse (classic + new; not executed — it would pop a mail window and overwrite the clipboard); disconnected-wait test against this PC's Outlook with a 40 s allowance and forced mode 400 → stopped at ~15 s (17.4 s total), nothing saved; header screenshot in both states, choice persists across reload, no page errors; `vite build` OK. **Not verified:** whether the new Outlook attaches files pasted with Ctrl+V (drag from the opened folder is the fallback).

**Import is unchanged in principle:** it can only read classic Outlook's copy. No setting makes it read the new Outlook.

**Files changed:** `server/index.js`, `src/App.jsx`.

---

## 2026-10-06 — Import tab: diagnosis confirmed on the device — classic Outlook stuck since 02/10 13:10

**Data from the device (Détails du diagnostic):** `classic Outlook already open: True`, account `mohamed.tyaybi@medafrica-log.com`, `totalItems=6458`, **`newestMail=2026-10-02 13:10`** — on 06/10. Refs `607-52812966`, `235-99203156`, `607-52812970` only matched Speedaf "IMPORT PRE-ALERT" mails from 29–30/09 (`keyword=False`). The `LTA Complet - 3eme LTA - 607-52812966` mail the user sees in the **new** Outlook arrived **02/10 22:45** — after classic's cut-off, so classic's copy doesn't have it.

**Conclusion:** the search logic is fine; classic Outlook on that device **is running but no longer syncing** (stopped 02/10 13:10, around the switch to the new Outlook — likely disconnected / needs sign-in / offline, unconfirmed). The sync-wait added earlier doesn't apply (it only runs when classic wasn't open) and couldn't fix a disconnected classic anyway.

**Also spotted in the user's screenshot:** `[File d'attente] MAWB 607-52812966 - (30 DUM)`, Lun 21:22, in **Boîte d'envoi** — queued, apparently never delivered. The `- (` subject format is the app's "Envoyer par email" button, which drafts through classic Outlook. To check on the device.

**Change (`src/App.jsx`):** the not-found toast now states the age of classic's newest mail and, when it's > 12 h old, says plainly `⚠ Outlook classique n'est plus à jour : le dernier email qu'il voit date du 2026-10-02 13:10 (il y a 4 jours)…` instead of only giving a date the operator has to compare. `vite build` OK.

**Follow-up — the diagnostic now says WHY classic is stale (`server/index.js` + `src/App.jsx`):** after the account match the script reports `DEBUG=Classic Outlook state: connectionMode=… workOffline=… windowsOpen=… processStarted=…` and an `OUTLOOK_STATE=` line → `inbox.connectionMode / workOffline / windowsOpen / processStarted` in the JSON. `connectionMode` is read from the **matched account** (`Account.ExchangeConnectionMode`), not `Namespace.ExchangeConnectionMode`: on this dev PC the namespace value said 400 (disconnected) because it describes the profile's default account (emsi), while the medafrica account was 700 (connected). The stale toast now adds `Cause probable : …` — "Travailler hors connexion" on / offline (100/200) / disconnected, waiting for reconnection or password (300/400) / running hidden with no window since <date> (close OUTLOOK.EXE, reopen normally) / otherwise "close completely and reopen". Verified on this PC (read-only, fake ref): `connectionMode=700 workOffline=False windowsOpen=1`. Not yet seen on the device.

**Root cause found by the user (classic Outlook dialog on the device):** _« Le dossier Éléments envoyés contient le nombre maximal d'éléments autorisé. Archivez des éléments ou déplacez-les vers un autre dossier. En attendant que l'espace se libère, les messages envoyés seront enregistrés dans le dossier Boîte d'envoi mais ne seront pas renvoyés. »_ Status bar: `Connecté à Microsoft Exchange`. So classic is connected but its Sent Items is at the item limit — which explains the mail stuck `[File d'attente]` in the Outbox, and very likely why classic stopped taking in new mail on 02/10 13:10. The new Outlook still sends and receives (e.g. `MAWB 065-45991816 (24 DUM)` sent 06/10 17:14), so the problem is on classic's side, not the server mailbox. **Fix on the device:** archive/move old Sent Items (what the dialog asks), and if classic still doesn't catch up, reduce the cached-mode window or rebuild its local data file. The toast's fallback "Cause probable" now says "connected but not receiving — open classic Outlook, it shows the reason (e.g. Sent Items full)".

**Open decision (user):** keep depending on classic Outlook on a device whose user lives in the new Outlook (Import + Envoyer par email both break silently when classic stops syncing), or read the "LTA Complet" mails from the sending Gmail account over IMAP (credentials already in `.env`; needs an IMAP npm package — note `electron/main.js` auto-pulls but does **not** run `npm install`), or Microsoft Graph (Azure app registration).

**Files changed:** `src/App.jsx`.

---

## 2026-10-06 — Import tab: "pas trouvé en mail" for a mail that IS in the inbox (new Outlook)

**Problem:** ref `065-45991816` → `Aucun email "complet" avec piece .xlsx … Pas trouvé en mail`, yet the mail (`LTA Complet - 7eme LTA - 065-45991816`, `generated_excel - 065-45991816.xlsx` attached, received 06/10 15:25) is in the Inbox as shown by the **new Outlook**. The user had just switched from classic to new Outlook on that machine.

**Root cause (inferred — that machine's diagnostic wasn't available):** the import reads the mailbox through **COM, which only exists in classic Outlook**. The new Outlook (`olk.exe`) has no COM and its own storage. Once classic Outlook isn't run any more, **its local copy of the mailbox (OST) stops syncing**. COM then starts classic Outlook in the background and searches that stale copy immediately → recent mail is missing. The result was `not_found` (not `FATAL`/"Import impossible"), so COM, the account match and the Inbox all worked — the search just ran on a copy without that mail. The mail itself matches every rule (subject has the ref + "Complet", `.xlsx` named with the ref).

**Fix (`server/index.js` — fetch-xlsx script):**

- Records whether classic Outlook **was already open** before COM connects.
- If it wasn't **and** some refs are missing: `SendAndReceive`, then re-searches the missing refs every 5 s for up to `INBOX_SYNC_WAIT_SEC` (default 45; `0` = off) while classic syncs. No wait when classic is already open (its copy is current) or when every ref is found.
- Reports how fresh the searched copy is: `DEBUG … newestMail=<date>` and a new `INBOX_STATE=<wasOpen>|<newest>` line → JSON `inbox: { outlookWasOpen, newestMail }`. `execFile` timeout raised to 90 s + the wait.
- Refactor: per-ref search moved into PS functions `Find-RefMail` / `Get-InboxNewest`. The match result goes through `$script:found`, not a return value — a PS function's `Write-Output` DEBUG lines would otherwise be mixed into the returned value.

**Frontend (`src/App.jsx`):** the red "pas trouvé en mail" toast now adds `Dernier email visible par l'app : <date>` + "if the mail is newer, open classic Outlook, let it sync, retry" — a stale copy is obvious at a glance.

**Verified:** the generated script against a mocked inbox (forward + gmail original + unrelated MAWB mail → picks the gmail original; only DEBUG lines in the output; missing ref → null; newest = 17:14); against this machine's real classic Outlook (read-only, fake ref, already open → no wait, `INBOX_STATE=True|2026-10-06 16:15`, 2.6 s); and the wait path forced (`wasRunning=$false`, SendAndReceive stubbed, 10 s → loop ran, `stillMissing=1`, 12.1 s). Nothing was saved. `vite build` OK. **Not verified:** that a background-started classic Outlook syncs within 45 s on the new-Outlook machine — check "Détails du diagnostic" there (`classic Outlook already open: False`, `newestMail=…`, `found after sync`).

**If it still says not found there:** if `newestMail` is old, switch that machine back to classic Outlook once (turn off the "Nouvel Outlook" toggle), let it sync, retry; keeping classic open is the reliable setup. The only client-independent alternative is Microsoft Graph (needs an Azure app registration) — not done.

**Files changed:** `server/index.js`, `src/App.jsx`, `.env.example`.

---

## 2026-09-30 — Fix: false "Signature Failed" email mid-LTA (chrono fired on a slow but healthy run)

**Problem:** LTA `607-54315402` (17 DUM) sent `Signature Failed LTA N°607-54315402 (17 DUM)` at 16:56:25 while DUM 16 was being signed normally — nothing had failed and the run carried on.

**Root cause:** the per-LTA chrono was a **fixed deadline**: `pendingDums × 1.25 min` = **21.25 min** for 17 DUM. That day BADR's signing loader alone took ~57 s per DUM, so a DUM cycle was ~1.4–1.5 min and the LTA needed ~25 min. The `setTimeout` expired after DUM 15 and called `notifyLtaFailure` — it never looked at whether the LTA was still advancing. The subject says "Failed" because the chrono reuses the failure email. It also left no log line explaining itself (WhatsApp disabled → only `📧 Failure email sent` showed). Same bug hit any resumed LTA with 1 DUM left (budget 1.25 min < one slow DUM).

**Fix (`server/automation.js`):** new `createLtaWatchdog({ budgetMs, stallMs, onSlow, onStuck })`. The budget rule is unchanged, but past the budget the LTA is reported **only if no DUM has been completed for `stallMinutes`** (default 5):

- over budget + a DUM completed recently → one `warn` log (`⏱️ … slower than expected … no alert`), then re-checks when the idle time would reach the stall limit;
- over budget + idle ≥ stall → logs `⏱️ Chrono alert …` (so the email is now explained in the journal) and sends WhatsApp + failure email, reason reworded to "looks stuck … no DUM completed for N min".
- Progress signal: `emit` marks progress on log lines matching `(SUCCESS|SKIPPED) - DUM N` (main pass + both recovery passes). `FAILED` deliberately doesn't count — an LTA whose DUMs keep failing must still be reported.
- `chronoTimers` now holds watchdog objects (`.clear()`), in `clearChrono` and the job `finally`.

**Config:** `config.ltaChrono.stallMinutes` = env `LTA_STALL_MINUTES`, default 5. Documented in `.env.example`.

**Verified** with scaled timings: the real case (budget 21.25, a DUM every 1.5 min, done at 25.5) → one "slow" log, **no alert**; hang at minute 18 → alert at ~23; hang at minute 24 → alert at ~29; nothing ever completes → alert at the budget; 1-DUM resume taking 1.6 min → no alert; fast LTA → nothing. Progress regex checked against 9 real log lines. Not run against BADR.

**Note:** needs a full app relaunch to load (no hot-reload). Unchanged: a genuine stall alert still uses the "Signature Failed" subject, and one failure email per LTA per run (dedupe).

**Files changed:** `server/automation.js`, `server/config.js`, `.env.example`.

---

## 2026-09-30 — Import tab: styled notifications — "[ref] pas trouvé en mail"

**Goal:** after **Confirmer**, a ref with no matching email was only a grey "Introuvable" row, easy to miss in a long list. Refs that are found need nothing special; the missing ones must be obvious.

**Frontend (`src/App.jsx`), no backend change:**

- **Toast system** (new, reusable): `toasts` state + `pushToast({ tone, title, lines?, detail? })` / `dismissToast(id)`. Rendered once at the app root, **bottom-right** (top-right would cover the header's Run / Envoyer tous / Nettoyer buttons), visible from any tab. White card, coloured accent bar + icon, ✕ to close, `animate-floatIn`. Auto-closes after 5 s (success) or 15 s (warning/error). `role="alert"` / `role="status"`.
- **`notifyImportResults(results)`** — one toast per outcome, so 1 or 20 missing refs never flood the screen:
  - **red** — `N références pas trouvées en mail`, listing each as `235-97644562 pas trouvé en mail` (scrolls if long);
  - **amber** — email found but no `.xlsx` attached;
  - **green** — `N fichier(s) Excel importé(s)`.
  - A global failure (Outlook unreachable, network) → red `Import impossible` + the reason.
- **Result rows:** not-found rows are now **red** (tinted background + border) and labelled **Pas trouvé en mail** instead of grey "Introuvable"; "Sans .xlsx" rows are amber-tinted. `importStatusOf(res)` is the single place that maps a result to its bucket (shared by rows and toasts).

**Verified** in the real UI (Vite + headless Edge, `/api/lta/fetch-xlsx` mocked with 1 saved / 2 not found / 1 without xlsx, then a 500): all three toasts and the `Import impossible` toast render, ✕ dismisses, no page errors, `vite build` OK. Not exercised against the real Outlook inbox.

**Files changed:** `src/App.jsx`.

---

## 2026-09-30 — Fix: LTA-READY email refused by Gmail (552 5.3.4 size limit) on big LTAs

**Problem:** LTA `235-98029514` (37 DUM) signed fine and was marked READY, but the email failed with `552-5.3.4 Your message exceeded Google's message size limits`. `sendLtaReadyEmail` attached **all** PDFs to **one** message. The folder is 30.1 MB (31 638 115 bytes); attachments are base64-encoded for SMTP, which adds ~37 %, so the message was **~43 MB on the wire**. `smtp.gmail.com` advertises `SIZE 35882577` (≈ 35.9 MB encoded = the "25 MB of attachments" limit; confirmed live via EHLO). 43 > 35.9 → rejected. Not a bug in signing, not credentials — purely size; any LTA above ~26 MB of PDFs would hit it.

**Fix (`server/notifications.js`):** `sendLtaReadyEmail` now stats each PDF and packs them, in DUM order, into groups of at most `config.email.maxAttachMb` (new `splitAttachmentsBySize`).

- **One group (normal LTA):** behaviour unchanged — same subject `MAWB {ref} ({n} DUM)`, empty body.
- **Several groups:** one email per group, subject `MAWB {ref} ({n} DUM) [1/2]`, `[2/2]`…, and a one-line body saying which PDFs are in that part.
- **Resume-safe:** each sent part writes `.email_sent_part_{i}of{N}` in the LTA folder; a re-run after a partial failure sends only the missing parts (no duplicate to the team). The existing `.email_sent` marker is still written by `automation.js` only when every part went out.
- Stops at the first failing part; on a 552 / size error the log now says so and points at `EMAIL_MAX_ATTACH_MB`.

**Config:** `config.email.maxAttachMb` = env `EMAIL_MAX_ATTACH_MB`, default **18** (≈ 25 MB encoded). Documented in `.env.example`.

**Verified** against a local fake SMTP server enforcing Gmail's `SIZE 35882577`, with 37 files totalling 31 638 115 bytes: unsplit → `552 5.3.4` reproduced (43.3 MB on the wire); default → 2 emails accepted (22 PDF / 25.7 MB and 15 PDF / 17.6 MB on the wire); part 2 forced to fail then re-run → part 1 skipped, only part 2 resent. Not yet exercised against real Gmail / the real folder.

**To send the email for `235-98029514`:** fully relaunch the app (no hot-reload — see the stale-server note below), then re-run that LTA: every DUM is skipped as already signed, there is no `.email_sent` marker, so the email goes out in 2 parts.

**Files changed:** `server/notifications.js`, `server/config.js`, `.env.example`.

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
