# PROJECT.md — BADR DUM Signing Automation

---

## What This App Does

A desktop automation tool (Electron + React + Playwright) that reads LTA (Lettre de Transport Aérien) Excel files produced by an external validation process, interprets each DUM (Déclaration d'Unité de Manifeste) series reference, then drives a real Microsoft Edge browser over CDP to locate each declaration on the Moroccan customs portal (BADR), verify its shipper name and annexes, validate it, digitally sign it via the BADR USB-certificate flow, and finally download the signed declaration PDF — naming and organizing each PDF by LTA reference and DUM number into output folders.

---

## Business Logic and Core Rules

### Excel Input Convention

- Each file in `dums/` corresponds to one LTA.
- The LTA reference appears anywhere in the first 60 rows / 8 columns as a `\d{3}-\d{8}` pattern (e.g. `235-97223803`).
- DUM series are in column C starting from row 12, stepping every 7 rows, or discoverable by scanning for `DUM N` label cells. The label-based extractor is preferred.
- A series value must be exactly 7 characters: 6 digits + 1 uppercase letter (regex `\d{7}[A-Z]`). Anything else is marked invalid.
- The numeric part of the series has leading zeros stripped when filling the BADR search form (e.g. `0042192B` → serie=`42192`, key=`B`).

### Per-DUM BADR Workflow (must pass ALL gates in order)

1. **Navigate to Accueil** — ensures clean DOM state before each DUM.
2. **Open Modifier une déclaration** — expand DEDOUANEMENT menu → click item.
3. **Fill search form** — Bureau=`301`, Regime=`010`, Année=current year (from config), Série=numeric, Clé=letter → click Valider.
4. **Shipper check** — compare `Nom ou raison sociale` field value against the user-supplied expected shipper name:
   - Comparison is tolerant: tries strict Unicode-normalized match first, then strip-punctuation match, then token-based (ignoring legal noise words: CO, LTD, LIMITED, INC, LLC, SARL, SA, SAS, BV, PLC).
   - If mismatch and field is editable: auto-correct the BADR field value → re-verify.
   - If mismatch and field is disabled: fatal error for this DUM.
   - If no expected shipper configured: gate is skipped (passes).
5. **Documents check** — Documents tab must contain **both** a TRANSPORT document (`TITRE DE PROPRIÉTÉ ET/OU DE TRANSPORT` / `A0004`) and a FACTURE (`A0006`). If either is absent → skip DUM with error.
6. **Préapurement DS check** — Tab must contain a lot reference matching `{ltaNumericRef}/{dumNumber}` (e.g. `23597223803/5`). LTA numeric ref = LTA ref with `-` removed. Matching uses 3 strategies: exact variant text match, normalized lot match, semantic (base + suffix) match. Wildcard suffix `*` in BADR is accepted. If not found → skip DUM with error.
7. **VALIDER** — Click the second VALIDER action from the left menu. If an error banner appears → throw.
8. **SIGNER** → confirm dialog (click Oui) → wait for `Traitement en cours...` block UI overlay to disappear and IMPRIMER button to appear.
9. **IMPRIMER** → capture Playwright `download` event → save to `DUM {N} LTA N°{ref}.pdf`. PDF is verified ≥ 1024 bytes.

### Critical Skip/Abort Rules

- If DUM series is invalid/missing in Excel → mark `failed`, do not touch BADR.
- If the PDF already exists on disk → mark `skipped` (resume mode).
- If required documents gate fails → mark `failed`, do not proceed to VALIDER/SIGNER.
- If préapurement lot gate fails → mark `failed`, do not proceed to VALIDER/SIGNER.
- Validation errors (error banner after VALIDER click) → throw immediately, do not try to sign.

### BADR Internal Error Recovery

- BADR occasionally shows a system exception page or error banner that blocks all navigation.
- Detected by: URL containing `exception_erreur.xhtml`, visible `.ui-messages-error` containing specific strings, or body text matching error keywords.
- Recovery: reload page → navigate to Accueil.
- Each DUM gets up to 3 attempts; a BADR internal error triggers recovery and re-attempts the full flow.

### Output Organization

- All PDFs for one LTA go into `outputs/LTA N° {ref}/`.
- After all DUMs in an LTA are processed:
  - If all PDFs exist AND zero failures → folder renamed to `LTA N° {ref} READY`.
  - Otherwise → folder renamed to `LTA N° {ref} PROBLEM`.
  - If the target suffix folder already exists, the rename is skipped.
- A per-LTA log file is written to `{ltaFolder}/{ltaRef}.log`.

---

## Data Flow

```
dums/
  *.xlsx
     │
     ▼ excelParser.parseLtaExcel()
     │  - Extracts ltaRef (LTA reference)
     │  - Extracts dums[] array (series, key per DUM)
     │
     ▼ GET /api/lta-files  → React UI
     │  - User sees one card per LTA
     │  - User types expected shipper name per LTA
     │  - Shipper names auto-saved to outputs/.shippers.json
     │
     ▼ POST /api/jobs/run { shipperByFileName, fileNames[] }
     │
     ▼ runSigningJob()  [automation.js]
     │
     ├── BADRConnection.connect()  [badrConnection.js]
     │    - Try CDP on port 9222 → existing Edge
     │    - Fallback: spawn Edge with USB cert profile
     │    - Login: fill password → click login → handle session popup
     │
     ├── FOR EACH LTA:
     │   └── FOR EACH DUM:
     │         navigateToAccueil()
     │         openModifyDeclaration()
     │         fillDeclarationSearch()
     │         checkShipper()         → gate: fail if mismatch
     │         checkRequiredDocuments() → gate: fail if missing
     │         checkPreapLot()         → gate: fail if not found
     │         clickSecondValidate()
     │         signDeclaration()
     │         printAndSave()          → PDF download
     │         PDF verification
     │
     ▼ Job result stored in state.jobs (in-memory)
     │  Emitted logs streamed via polling GET /api/jobs/:id
     │
     ▼ outputs/
         LTA N° 235-97223803 READY/
           DUM 1 LTA N°235-97223803.pdf
           DUM 2 LTA N°235-97223803.pdf
           ...
           235-97223803.log
```

---

## All Entities / Models

### LtaFile (parsed Excel)

```js
{
  filePath: string,        // absolute path to .xlsx
  fileName: string,        // basename
  ltaRef: string,          // e.g. "235-97223803"
  ltaNumericRef: string,   // e.g. "23597223803" (no dash)
  dums: DUM[],
  totalDums: number,
  validDums: number,
  invalidDums: number
}
```

### DUM

```js
{
  dumNumber: number,       // 1-based sequential index
  rawSerie: string,        // e.g. "0042192B"
  serie: string,           // numeric portion without leading zeros "42192"
  key: string,             // last letter "B"
  sourceCell: string,      // e.g. "C12" — for debugging
  isValid: boolean,        // true if series format valid
  invalidReason: string    // populated if isValid=false
}
```

### Job

```js
{
  id: string,              // UUID v4
  status: "running" | "done" | "failed",
  startedAt: ISO string,
  completedAt: ISO string | null,
  progress: {
    total: number,         // total DUMs across all selected LTAs
    done: number,
    success: number,
    failed: number,
    skipped: number
  },
  logs: LogEntry[],        // capped at 1000 entries
  results: DumResult[]
}
```

### DumResult

```js
{
  ltaRef: string,
  fileName: string,
  dumNumber: number,
  rawSerie: string,
  status: "success" | "failed" | "skipped",
  reason: string,
  outputPdf: string        // absolute path to PDF (may not exist if failed)
}
```

### LogEntry

```js
{
  at: ISO string,
  level: "debug" | "info" | "warn" | "error",
  message: string,
  meta: object
}
```

### Shippers Persistence File (`.shippers.json`)

```js
{
  byFileName: { "filename.xlsx": "SHIPPER NAME" },
  byLtaRef:   { "235-97223803": "SHIPPER NAME" }
}
```

---

## Session and Auth Logic

- **BADR authentication** uses a USB certificate loaded in a dedicated Edge profile (`BADR_PROFILE_DIR`). The certificate is presented automatically by Edge; no programmatic certificate handling is done.
- **Password** is filled programmatically via `BADR_PASSWORD` env var into `#connexionForm:pwdConnexionId`, then the Connexion button is clicked.
- **Session conflict popup**: if an active session exists on BADR for the same account, a confirmation link appears (`#connexionForm:sessionConnexionId`); the automation clicks it to terminate the old session and continue.
- The `BADRConnection` object is created **once per job run** and reused across all LTAs/DUMs. There is no re-login between DUMs; if the page is lost, recovery navigates to Accueil using the same Playwright browser instance.
- No application-level authentication. The API server is local only (`localhost:3001`).

---

## External APIs / Services

| Service                                       | How used                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BADR** (`https://badr.douane.gov.ma:40444`) | Target automation site. PrimeFaces JSF application. Accessed via Playwright over Chrome DevTools Protocol to an Edge browser process. All BADR interaction is driven via DOM selectors with multiple fallback strategies. |
| **Microsoft Edge**                            | Launched as a child process with `--remote-debugging-port` flag, connecting Playwright via CDP at `http://localhost:{BADR_CDP_PORT}`. The USB certificate must already be installed in the Edge profile.                  |
| **Google Fonts**                              | `index.html` loads Manrope and Space Grotesk fonts at runtime. No API key required.                                                                                                                                       |

---

## Selector Robustness Strategy

All BADR DOM interaction uses multi-selector fallback arrays. Every `clickFirst()` / `fillFirst()` / `firstVisible()` call tries up to N selectors across both the main page and all its iframes (via `page.frames()`). ID-based selectors (e.g. `#rootForm:_bureauId`) use escaped colons (`\\:`). Fallback selectors use attribute contains (`[id$=':_bureauId']`), text content (`:has-text()`), and role-based selectors to survive PrimeFaces dynamic ID changes.
