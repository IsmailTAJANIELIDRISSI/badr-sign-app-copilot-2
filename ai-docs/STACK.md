# STACK.md — Technical Stack and Structure

---

## Languages, Frameworks, Versions

| Layer                    | Technology                  | Version                                         |
| ------------------------ | --------------------------- | ----------------------------------------------- |
| Runtime                  | Node.js                     | ≥ 18 (ESM modules, `"type": "module"`)          |
| Desktop shell            | Electron                    | ^32.2.0                                         |
| Frontend framework       | React                       | ^18.3.1                                         |
| Frontend build           | Vite + @vitejs/plugin-react | ^5.4.20 / ^4.7.0                                |
| CSS                      | TailwindCSS                 | ^3.4.17                                         |
| Browser automation       | Playwright (chromium)       | ^1.55.1                                         |
| API server               | Express                     | ^4.21.2                                         |
| Excel parsing            | xlsx (SheetJS community)    | ^0.18.5                                         |
| Logging                  | pino + pino-pretty          | ^9.9.4 / ^13.1.2                                |
| Env config               | dotenv                      | ^16.6.1                                         |
| File system utils        | fs-extra                    | ^11.3.2                                         |
| UUID generation          | uuid (v4)                   | ^11.1.0                                         |
| Input validation         | zod                         | ^3.25.76 (imported but not yet used at runtime) |
| File watching            | chokidar                    | ^4.0.3 (imported in package.json, not yet used) |
| Packaging                | electron-builder            | ^25.0.6                                         |
| Dev server orchestration | concurrently                | ^9.2.1                                          |

---

## Key Libraries and Why They Exist

| Library             | Purpose                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Playwright**      | Drives the Edge browser via Chrome DevTools Protocol (CDP). Used instead of Puppeteer because it supports `connectOverCDP`, multi-frame access, and has better download handling.                                         |
| **xlsx (SheetJS)**  | Parses `.xlsx`/`.xls`/`.xlsm` files without requiring Excel to be installed. Used to extract LTA refs and DUM series from generated Excel reports.                                                                        |
| **Express**         | Lightweight HTTP API between the Electron main process and the React frontend. All automation is triggered via REST calls rather than direct Electron IPC, making the backend testable standalone (`npm run dev:server`). |
| **electron-is-dev** | Detects whether Electron is running from source (dev) or from a packaged installer, to branch load URLs and data paths accordingly.                                                                                       |
| **pino**            | Structured JSON logging to both console (pretty-printed) and `logs/app.log`. Chosen for performance and transport plugin support.                                                                                         |
| **fs-extra**        | Drop-in replacement for `fs` with promise-based operations, `ensureDir`, `move`, `pathExists`, `readJson`, `writeJson`. Avoids repetitive try-catch boilerplate.                                                          |
| **chokidar**        | Listed as a dependency for future file-watching (auto-detect new Excel files), currently unused.                                                                                                                          |
| **zod**             | Listed as a dependency for future runtime API validation, currently unused.                                                                                                                                               |
| **concurrently**    | Dev-only: runs Vite dev server and Express API server in parallel with labeled output in one terminal.                                                                                                                    |
| **wait-on**         | Dev-only: ensures Electron window doesn't open until the Vite dev server is ready at `http://localhost:5173`.                                                                                                             |

---

## Folder Structure

```
badr-sign-app-2/
│
├── index.html                  # HTML entry point for Vite; loads /src/main.jsx
├── vite.config.js              # Vite config: React plugin, proxy /api → localhost:3001
├── tailwind.config.js          # Tailwind: custom colors (ink, mist, mint, coral, steel), fonts, animations
├── postcss.config.js           # PostCSS: required by Tailwind
├── package.json                # Project manifest; type="module" (ESM)
├── electron-builder.json       # Packaging config for electron-builder
├── .env                        # NOT committed; contains secrets (BADR_PASSWORD, etc.)
│
├── electron/                   # Electron main process
│   ├── main.js                 # App lifecycle: createWindow, startApiServer (spawns server/index.js),
│   │                           #   IPC handlers (log-folder, output-folder, open-folder), app menu
│   └── preload.js              # Context bridge: exposes electronAPI to renderer (getLogFolder,
│                               #   getOutputFolder, openFolder, platform, isElectron)
│
├── src/                        # React frontend (renderer process)
│   ├── main.jsx                # React root: createRoot → <App />
│   ├── App.jsx                 # Single-page app component (entire UI)
│   └── main.css                # Global CSS imported by main.jsx
│
├── server/                     # Express API + automation backend (Node.js ESM)
│   ├── index.js                # Express app setup, all API routes, server startup
│   ├── config.js               # Central config object built from env vars + defaults
│   ├── state.js                # In-memory state: ltaFiles[], jobs Map, createJob(), pushJobLog()
│   ├── logger.js               # Pino logger with dual transports (console + file)
│   ├── excelParser.js          # parseLtaExcel(): extracts ltaRef + dums[] from .xlsx files
│   ├── badrConnection.js       # BADRConnection class: Edge spawn, CDP connect, BADR login, Accueil nav
│   └── automation.js           # runSigningJob(): full per-DUM workflow, all BADR page interactions
│
├── dums/                       # INPUT: user places LTA Excel files here
├── outputs/                    # OUTPUT: signed PDF folders, .shippers.json
├── logs/                       # Server logs (app.log, per-LTA .log files)
├── assets/                     # App icons (icon.ico, icon.png)
│
├── dist-electron/              # Build output (electron-builder artifacts)
│   └── win-unpacked/           # Unpacked Windows app
│
└── ai-docs/                    # This documentation folder
```

---

## Naming Conventions

| Convention                                                    | Where used                                                                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `camelCase`                                                   | All JS variables, functions, and object properties                                            |
| `PascalCase`                                                  | Classes (`BADRConnection`), React components (`App`)                                          |
| `SCREAMING_SNAKE_CASE`                                        | Module-level constants (`REQUIRED_DOC_HINTS`, `PRINT_ATTEMPTS`, `BADR_INTERNAL_ERROR_PREFIX`) |
| `kebab-case`                                                  | Package name, CSS class names (via Tailwind), file names in `dist-electron/`                  |
| Output folders: `LTA N° {ref}`                                | Uses `N°` symbol + space + LTA ref                                                            |
| Output folders: `LTA N° {ref} READY` / `LTA N° {ref} PROBLEM` | Suffix appended after job completion                                                          |
| Output PDFs: `DUM {N} LTA N°{ref}.pdf`                        | Pattern for every signed DUM PDF                                                              |
| Log files: `{ltaRef}.log`                                     | Plain text append-only, inside the LTA output folder                                          |

### Selector naming convention in automation.js

- `*_SELECTORS` arrays: named constants listing CSS selectors with fallbacks (e.g. `IMPRIMER_SELECTORS`, `LOADING_SELECTORS`)
- Helper functions named `click*`, `fill*`, `check*`, `open*`, `navigate*`, `wait*`

---

## Environment Variables and Config

All env vars are read in `server/config.js`. The config object is imported by all server-side modules.

| Variable           | Default                                                        | Description                                                              |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `PORT`             | `3001`                                                         | Express API listen port                                                  |
| `NODE_ENV`         | `development`                                                  | `production` in packaged Electron build                                  |
| `ELECTRON_APP`     | unset                                                          | Set to `"true"` by `electron/main.js` when spawning the API process      |
| `TIMEOUT`          | `120000`                                                       | Global Playwright selector/nav timeout in ms                             |
| `HEADLESS`         | `"false"`                                                      | Whether to run Edge in headless mode (normally false; USB cert needs UI) |
| `SLOW_MO`          | `50`                                                           | Playwright slow-motion delay in ms                                       |
| `BADR_URL`         | `https://badr.douane.gov.ma:40444/badr/Login`                  | BADR login URL                                                           |
| `BADR_PASSWORD`    | `""`                                                           | BADR account password (mandatory)                                        |
| `EDGE_PATH`        | `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe` | Path to msedge.exe                                                       |
| `BADR_CDP_PORT`    | `9222`                                                         | Chrome DevTools Protocol port for Edge remote debugging                  |
| `BADR_PROFILE_DIR` | `C:/Temp/badr-edge-profile`                                    | Edge user-data directory (holds USB cert profile)                        |
| `BADR_BUREAU_CODE` | `"301"`                                                        | Bureau code filled in every DUM search form                              |
| `BADR_REGIME_CODE` | `"010"`                                                        | Regime code filled in every DUM search form                              |
| `BADR_YEAR`        | current year (`new Date().getFullYear()`)                      | Declaration year filled in every DUM search form                         |
| `DUMS_DIR`         | `./dums` (relative to CWD)                                     | Folder scanned for LTA Excel files                                       |
| `OUTPUTS_DIR`      | `./outputs`                                                    | Root output folder for PDFs                                              |
| `LOGS_DIR`         | `./logs`                                                       | Server log folder                                                        |
| `SIGNED_LTAS_DIR`  | same as `OUTPUTS_DIR`                                          | Where LTA subfolders are created (default = outputs)                     |

### Data directory resolution logic

```
isDev && isElectron  → workspaceRoot (project root)
isElectron only      → ~/AppData/Local/badr-sign-app/
neither              → workspaceRoot (dev:server mode)
```

---

## Dev Scripts

```bash
npm run dev              # Vite frontend + Express backend (no Electron)
npm run dev:web          # Vite only (port 5173)
npm run dev:server       # Express + tsx watch (port 3001)
npm run dev:electron     # Vite + Electron (waits for Vite to be ready)
npm run build            # Vite production build → dist/
npm run build:electron   # Vite build + electron-builder NSIS installer
npm run build:electron:portable  # Portable .exe
npm run start            # node server/index.js (production API only)
```

---

## Build / Packaging

- `electron-builder.json` configures Windows NSIS installer and portable builds.
- In packaged mode, Electron spawns `server/index.js` using `process.execPath` (Electron's Node runtime) with `ELECTRON_RUN_AS_NODE=1`.
- Output artifacts go to `dist-electron/`.
- Vite outputs to `dist/` (loaded by `file://` in packaged Electron).
- Playwright's Chromium is **not** bundled; Edge is expected to be pre-installed on the target machine (CDP over existing Edge process).
