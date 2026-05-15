import path from "path";
import os from "os";
import fs from "fs-extra";
import { config } from "./config.js";
import { BADRConnection } from "./badrConnection.js";

const REQUIRED_DOC_HINTS = ["TRANSPORT", "FACTURE"];
const BADR_INTERNAL_ERROR_HINTS = [
  "UNE ERREUR INTERNE AU SYSTEME BADR",
  "EXCEPTION_ERREUR.XHTML",
  "COMMUNIQUER LA REFERENCE SUIVANTE A VOTRE SUPPORT",
];
const BADR_INTERNAL_ERROR_PREFIX = "BADR_INTERNAL_ERROR";
// Thrown when BADR says the declaration is "enregistrée" (already definitively signed).
const ALREADY_SIGNED_PREFIX = "BADR_ALREADY_SIGNED";
const SHIPPER_LEGAL_NOISE = new Set([
  "CO",
  "COMPANY",
  "LTD",
  "LIMITED",
  "INC",
  "LLC",
  "SARL",
  "SA",
  "SAS",
  "BV",
  "PLC",
]);

const normalize = (value) => String(value ?? "").trim();

const toUpperCompact = (value) =>
  normalize(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();

const normalizeLotSegment = (segment) => {
  const raw = String(segment ?? "").trim();
  if (!raw) return "";
  if (raw === "*") return "*";
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";
  return digits.replace(/^0+(?=\d)/, "") || "0";
};

const parseLotRef = (value) => {
  const source = String(value ?? "").trim();
  if (!source) return null;

  const parts = source
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length < 2) return null;

  const baseDigits = parts[0].replace(/[^\d]/g, "");
  if (!baseDigits) return null;
  const base = baseDigits.replace(/^0+(?=\d)/, "") || "0";

  const suffixes = parts.slice(1).map(normalizeLotSegment).filter(Boolean);

  if (!suffixes.length) return null;

  return {
    base,
    suffixes,
    normalized: `${base}/${suffixes.join("/")}`,
  };
};

const normalizeLotRef = (value) => parseLotRef(value)?.normalized || "";

const extractLotRefs = (text) => {
  const source = String(text ?? "");
  const hits = source.match(/[0-9.\-\s]{3,}(?:\s*\/\s*(?:\d+|\*))+/g) || [];
  const normalized = new Set();
  for (const hit of hits) {
    const parsed = parseLotRef(hit);
    if (parsed) normalized.add(parsed.normalized);
  }
  return [...normalized];
};

const lotMatchesExpectedDum = (lotValue, expectedBase, expectedDum) => {
  const parsed = parseLotRef(lotValue);
  if (!parsed) return false;
  if (parsed.base !== expectedBase) return false;

  if (parsed.suffixes.includes("*")) return true;

  const expected = normalizeLotSegment(expectedDum);
  if (!expected) return false;

  const last = parsed.suffixes[parsed.suffixes.length - 1];
  if (last === expected) return true;

  // Some BADR patterns include intermediate numbering (e.g. base/1/2).
  return parsed.suffixes.includes(expected);
};

const isBadrInternalErrorText = (text) => {
  const normalized = toUpperCompact(text);
  return BADR_INTERNAL_ERROR_HINTS.some((hint) => normalized.includes(hint));
};

const normalizeShipperLoose = (value) =>
  toUpperCompact(value)
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Truncate a shipper name to fit within BADR's maxlength.
 * Cuts at the last word boundary (space) before the limit so no word
 * is split mid-character (e.g. "MANAGEMEN" → "MANAGEMENT" is avoided).
 * Falls back to a hard slice only when no space exists within the limit.
 */
const truncateShipperToMaxLen = (value, maxLen) => {
  const s = normalize(value);
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd();
};

const shipperBaseTokens = (value) =>
  normalizeShipperLoose(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => !SHIPPER_LEGAL_NOISE.has(token));

const isShipperEquivalent = (expected, actual) => {
  const eStrict = toUpperCompact(expected);
  const aStrict = toUpperCompact(actual);
  if (eStrict === aStrict) return true;

  const eLoose = normalizeShipperLoose(expected);
  const aLoose = normalizeShipperLoose(actual);
  if (eLoose === aLoose) return true;

  const eBase = shipperBaseTokens(expected).join(" ");
  const aBase = shipperBaseTokens(actual).join(" ");
  if (!eBase || !aBase) return false;

  return eBase === aBase;
};

const contextsFor = (page) => [page, ...page.frames()];

const firstVisible = async (page, selectors, timeout = 1500) => {
  const contexts = contextsFor(page);
  for (const selector of selectors) {
    for (const ctx of contexts) {
      const loc = ctx.locator(selector).first();
      if (await loc.isVisible({ timeout }).catch(() => false)) {
        return { ctx, loc, selector };
      }
    }
  }
  return null;
};

const firstPresent = async (page, selectors) => {
  const contexts = contextsFor(page);
  for (const selector of selectors) {
    for (const ctx of contexts) {
      const loc = ctx.locator(selector).first();
      const exists = (await loc.count().catch(() => 0)) > 0;
      if (exists) {
        return { ctx, loc, selector };
      }
    }
  }
  return null;
};

const detectBadrInternalError = async (conn) => {
  const page = conn.page;
  if (!page || page.isClosed()) {
    return { detected: false };
  }

  const currentUrl = page.url() || "";
  if (/\/views\/commun\/exception_erreur\.xhtml/i.test(currentUrl)) {
    return {
      detected: true,
      source: "url",
      details: `Exception page detected: ${currentUrl}`,
    };
  }

  const errorHit = await firstVisible(
    page,
    [
      "#rapportMsg .ui-messages-error",
      "#form1\\:messages .ui-messages-error",
      ".ui-messages-error-detail",
      "span.color-black",
    ],
    200,
  );

  if (errorHit) {
    const message = await errorHit.loc.innerText().catch(() => "");
    if (isBadrInternalErrorText(message)) {
      return {
        detected: true,
        source: "error-banner",
        details: normalize(message).slice(0, 280),
      };
    }
  }

  const bodyText = await page
    .locator("body")
    .innerText()
    .catch(() => "");
  if (isBadrInternalErrorText(bodyText)) {
    return {
      detected: true,
      source: "body-text",
      details: "Internal BADR error text found in page body",
    };
  }

  return { detected: false };
};

const ensureNoBadrInternalError = async (conn, onLog, stage = "") => {
  const detection = await detectBadrInternalError(conn);
  if (!detection.detected) return;

  const where = stage ? ` during ${stage}` : "";
  onLog(
    "warn",
    `Detected BADR internal error${where}. Triggering recovery...`,
    { source: detection.source, details: detection.details },
  );

  throw new Error(
    `${BADR_INTERNAL_ERROR_PREFIX}:${detection.source}:${detection.details}`,
  );
};

const isBadrInternalError = (error) =>
  String(error?.message || "").includes(BADR_INTERNAL_ERROR_PREFIX);

const isAlreadySignedError = (error) =>
  String(error?.message || "").includes(ALREADY_SIGNED_PREFIX);

/**
 * True when the declaration search form fields were not reachable — typically
 * because the iframe / PrimeFaces form was not yet rendered when we tried to
 * fill it.  These errors are transient and the whole DUM flow should be
 * retried after navigating back to Accueil.
 */
const isFormNotReadyError = (error) =>
  /Could not fill (Bureau|Regime|Year|Serie|Key) field|Could not click Valider button/.test(
    String(error?.message || ""),
  );

/**
 * Extract the definitive reference from the declaration header table.
 * Returns { bureau, regime, year, serie, key } or null if not found.
 * The table has two rows: headers then values.
 */
const extractDefinitiveRef = async (page) => {
  const contexts = contextsFor(page);
  const tableSelectors = [
    "table.reference",
    "table[id*='j_id_3p_d']",
    "#mainTab\\:form0\\:j_id_3p_d",
  ];
  for (const ctx of contexts) {
    for (const sel of tableSelectors) {
      try {
        const table = ctx.locator(sel).first();
        if (!(await table.isVisible({ timeout: 800 }).catch(() => false)))
          continue;
        const cells = await table.locator("tbody tr:nth-child(2) td").all();
        if (cells.length < 5) continue;
        const vals = await Promise.all(
          cells.slice(0, 5).map((c) => c.innerText().catch(() => "")),
        );
        const [bureau, regime, year, serie, key] = vals.map((v) =>
          v.trim().replace(/^0+/, ""),
        );
        if (serie && key) return { bureau, regime, year, serie, key };
      } catch {
        // try next
      }
    }
  }
  return null;
};

/**
 * Append a signed-series record to the LTA CSV traceability file.
 * Format: dumNumber,serie,key,ltaRef,timestamp
 */
const appendSignedSerieCsv = async (
  csvPath,
  dumNumber,
  definitiveRef,
  ltaRef,
) => {
  const header = "dumNumber,serie,key,ltaRef,timestamp\n";
  const line = `${dumNumber},${definitiveRef.serie},${definitiveRef.key},${ltaRef},${new Date().toISOString()}\n`;
  const exists = await fs.pathExists(csvPath);
  if (!exists) await fs.outputFile(csvPath, header + line);
  else await fs.appendFile(csvPath, line);
};

/**
 * Read the signed_series.csv for an LTA folder and return a Map:
 *   dumNumber (Number) → { serie, key }
 */
const loadSignedSeriesCsv = async (csvPath) => {
  const map = new Map();
  if (!(await fs.pathExists(csvPath))) return map;
  const text = await fs.readFile(csvPath, "utf8");
  for (const line of text.split("\n").slice(1)) {
    const parts = line.trim().split(",");
    if (parts.length < 3) continue;
    const [dumNum, serie, key] = parts;
    const n = Number(dumNum);
    if (n && serie && key) map.set(n, { serie, key });
  }
  return map;
};

const recoverFromBadrInternalError = async (conn, onLog) => {
  const page = conn.page;
  if (!page || page.isClosed()) return;

  onLog("warn", "Recovering from BADR internal error: refreshing page...");

  await page
    .reload({ waitUntil: "domcontentloaded", timeout: config.timeout })
    .catch(() => null);
  await page.waitForTimeout(800);

  onLog("warn", "Returning to BADR Accueil after internal error...");
  await conn.navigateToAccueil();
  await page.waitForTimeout(600);
  onLog("info", "✓ Recovery complete - back to BADR Accueil");
};

const clickFirst = async (page, selectors) => {
  const hit = await firstVisible(page, selectors);
  if (!hit) return false;
  await hit.loc.click();
  return true;
};

const fillFirst = async (page, selectors, value) => {
  const hit = await firstVisible(page, selectors);
  if (!hit) return false;
  await hit.loc.fill("");
  await hit.loc.fill(String(value));
  return true;
};

const textInTable = async (page, tableSelector) => {
  const hit = await firstPresent(page, [tableSelector]);
  if (!hit) return "";
  const text = await hit.loc
    .innerText()
    .catch(async () => (await hit.loc.textContent().catch(() => "")) || "");
  return toUpperCompact(text);
};

const openEnteteTab = async (page) => {
  await clickFirst(page, [
    "a[href='#mainTab:tab0']",
    "li[role='tab'] a:has-text('Entête')",
    "li[role='tab'] a:has-text('Entete')",
  ]).catch(() => false);
  await page.waitForTimeout(350);
};

const IMPRIMER_SELECTORS = [
  "#secure_imprimer",
  "a.ui-menuitem-link:has-text('IMPRIMER')",
  "span.ui-menuitem-text:has-text('IMPRIMER')",
];

/** Prefer real links for clicks (span is only a visibility hint). */
const IMPRIMER_CLICK_SELECTORS = [
  "#secure_imprimer",
  "a.ui-menuitem-link:has-text('IMPRIMER')",
];

/** PrimeFaces block UI / overlay can sit on top with pointer events even when classes look "hidden". */
const waitForNoBlockingOverlay = async (page, timeoutMs = 90000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const blocking = await page.evaluate(() => {
      const candidates = document.querySelectorAll(
        "#j_id_9_blocker, .ui-widget-overlay.ui-blockui, .ui-blockui.ui-widget-overlay",
      );
      for (const el of candidates) {
        const st = window.getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden") continue;
        if (st.pointerEvents === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        return true;
      }
      return false;
    });
    if (!blocking) return true;
    await page.waitForTimeout(200);
  }
  return false;
};

/** BADR hides #secure_imprimer after first click; retries must undo that. */
const unhideImprimerButton = async (page) => {
  await page.evaluate(() => {
    const el = document.querySelector("#secure_imprimer");
    if (!el) return;
    el.removeAttribute("hidden");
    el.style.removeProperty("display");
    el.style.removeProperty("visibility");
    if (typeof window.$ === "function") {
      try {
        window.$("#secure_imprimer").show();
      } catch {
        /* ignore */
      }
    }
  });
};

const clickImprimer = async (page) => {
  await unhideImprimerButton(page);
  await waitForNoBlockingOverlay(page, Math.min(config.timeout, 90000));

  const hit = await firstVisible(page, IMPRIMER_CLICK_SELECTORS, 8000);
  if (!hit) {
    const viaJs = await page.evaluate(() => {
      const a =
        document.querySelector("#secure_imprimer") ||
        [...document.querySelectorAll("a.ui-menuitem-link")].find((el) =>
          (el.textContent || "").includes("IMPRIMER"),
        );
      if (!a) return false;
      a.click();
      return true;
    });
    return viaJs;
  }

  try {
    await hit.loc.click({
      timeout: Math.min(config.timeout, 120000),
    });
    return true;
  } catch {
    await page.evaluate(() => {
      document
        .querySelectorAll(
          "#j_id_9_blocker, .ui-widget-overlay.ui-blockui, .ui-blockui.ui-widget-overlay",
        )
        .forEach((el) => {
          el.style.pointerEvents = "none";
        });
    });
    await unhideImprimerButton(page);
    const again = await firstVisible(page, IMPRIMER_CLICK_SELECTORS, 5000);
    if (again) {
      await again.loc.click({ force: true, timeout: 20000 });
      return true;
    }
    return await page.evaluate(() => {
      const a = document.querySelector("#secure_imprimer");
      if (a) {
        a.click();
        return true;
      }
      return false;
    });
  }
};

const LOADING_SELECTORS = [
  "#j_id_9:has-text('Traitement en cours')",
  "div.ui-blockui-content:has-text('Traitement en cours')",
  "div:has-text('Traitement en cours')",
];

const PRINT_DOWNLOAD_TIMEOUT_MS = 90000;
const PRINT_ATTEMPTS = 3;

const appendLtaLog = (logPath, level, message, meta = {}) => {
  try {
    const ts = new Date().toISOString();
    const metaText = Object.keys(meta).length
      ? ` | ${JSON.stringify(meta)}`
      : "";
    fs.appendFileSync(
      logPath,
      `[${ts}] ${String(level).toUpperCase()} - ${message}${metaText}\n`,
    );
  } catch {
    // Non-blocking: file logging should never stop automation flow.
  }
};

const waitForSigningReady = async (conn, onLog) => {
  const page = conn.page;
  // Phase 1: loader detection + wait — uses the full config timeout so
  // long-running signings (45 s+) are not cut short.
  const loaderDetectWindowMs = 4000;
  const loaderWaitMs = config.timeout; // e.g. 120 000 ms
  // Phase 2: after loader clears, short window to confirm IMPRIMER is visible.
  // printAndSave has its own DOM-attachment guard, so this is just a quick
  // sanity check — the loader disappearing IS the signing-complete signal.
  const imprimerReadyMs = 6000;

  const start = Date.now();

  // ── Phase 1a: detect signing loader ──────────────────────────────────────
  let sawLoading = false;
  while (Date.now() - start < loaderDetectWindowMs) {
    await ensureNoBadrInternalError(conn, onLog, "signing wait bootstrap");
    const loading = await firstVisible(page, LOADING_SELECTORS, 120);
    if (loading) {
      sawLoading = true;
      onLog("debug", "Signing loader detected (Traitement en cours)...");
      break;
    }
    await page.waitForTimeout(200);
  }

  // ── Phase 1b: wait for loader to disappear (no shared budget) ────────────
  if (sawLoading) {
    const loadingHit = await firstVisible(page, LOADING_SELECTORS, 500);
    if (loadingHit) {
      await loadingHit.loc
        .waitFor({ state: "hidden", timeout: loaderWaitMs })
        .catch(() => {});
      onLog("debug", "✓ Signing loader hidden");
    }
  }

  // ── Phase 2: wait for overlay then confirm IMPRIMER is in the menu ───────
  await waitForNoBlockingOverlay(page, 30000);

  let stableVisibleCount = 0;
  const imprimerStart = Date.now();
  while (Date.now() - imprimerStart < imprimerReadyMs) {
    await ensureNoBadrInternalError(conn, onLog, "signing wait loop");

    const loading = await firstVisible(page, LOADING_SELECTORS, 120);
    if (loading) {
      stableVisibleCount = 0;
      await page.waitForTimeout(250);
      continue;
    }

    const imprimer = await firstVisible(page, IMPRIMER_SELECTORS, 120);
    if (imprimer) {
      stableVisibleCount += 1;
      if (stableVisibleCount >= 2) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        onLog("debug", `✓ IMPRIMER ready after ${elapsed}s`);
        return true;
      }
    } else {
      stableVisibleCount = 0;
    }

    await page.waitForTimeout(250);
  }

  onLog(
    "warn",
    `⚠ Signing readiness wait exceeded ${Math.round(imprimerReadyMs / 1000)}s post-loader; continuing to IMPRIMER retries`,
  );
  return false;
};

const openModifyDeclaration = async (conn, onLog) => {
  const page = conn.page;

  await ensureNoBadrInternalError(conn, onLog, "open modify declaration");

  onLog("debug", "Opening DEDOUANEMENT menu...");
  const openedMenu =
    (await clickFirst(page, [
      "h3.ui-panelmenu-header:has-text('DEDOUANEMENT')",
      "h3:has-text('DEDOUANEMENT')",
      ".ui-panelmenu-header a:has-text('DEDOUANEMENT')",
    ])) ||
    (await clickFirst(page, [
      "h3.ui-panelmenu-header:has-text('MISE EN DOUANE')",
    ]));

  if (!openedMenu) {
    throw new Error("Could not open DEDOUANEMENT menu");
  }
  onLog("debug", "✓ DEDOUANEMENT menu expanded");

  onLog("debug", "Clicking 'Modifier une déclaration'...");
  const clicked = await clickFirst(page, [
    "a#_2008",
    "a[title*='cf2008']",
    "a.ui-menuitem-link:has-text('Modifier une déclaration')",
    "span.ui-menuitem-text:has-text('Modifier une déclaration')",
  ]);

  if (!clicked) {
    throw new Error("Could not open 'Modifier une déclaration'");
  }
  onLog("debug", "✓ 'Modifier une déclaration' clicked");

  await page.waitForTimeout(1200);
  await ensureNoBadrInternalError(conn, onLog, "open modify declaration done");
};

const fillDeclarationSearch = async (conn, dum, onLog) => {
  const page = conn.page;

  await ensureNoBadrInternalError(conn, onLog, "fill declaration search start");

  onLog("debug", "Filling declaration search form...", {
    bureau: config.badr.bureauCode,
    regime: config.badr.regimeCode,
    year: config.badr.year,
    serie: dum.serie,
    key: dum.key,
  });

  const okBureau = await fillFirst(
    page,
    ["#rootForm\\:_bureauId", "input[id$=':_bureauId']"],
    config.badr.bureauCode,
  );
  if (!okBureau) throw new Error("Could not fill Bureau field");
  onLog("debug", "✓ Bureau filled: " + config.badr.bureauCode);

  const okRegime = await fillFirst(
    page,
    ["#rootForm\\:_regimeId", "input[id$=':_regimeId']"],
    config.badr.regimeCode,
  );
  if (!okRegime) throw new Error("Could not fill Regime field");
  onLog("debug", "✓ Regime filled: " + config.badr.regimeCode);

  const okYear = await fillFirst(
    page,
    ["#rootForm\\:_anneeId", "input[id$=':_anneeId']"],
    config.badr.year,
  );
  if (!okYear) throw new Error("Could not fill Year field");
  onLog("debug", "✓ Year filled: " + config.badr.year);

  const okSerie = await fillFirst(
    page,
    ["#rootForm\\:_serieId", "input[id$=':_serieId']"],
    dum.serie,
  );
  if (!okSerie) throw new Error("Could not fill Serie field");
  onLog("debug", "✓ Serie filled: " + dum.serie);

  const okKey = await fillFirst(
    page,
    ["#rootForm\\:_cleId", "input[id$=':_cleId']"],
    dum.key,
  );
  if (!okKey) throw new Error("Could not fill Key field");
  onLog("debug", "✓ Key filled: " + dum.key);

  onLog("debug", "Clicking Valider button...");
  const clicked = await clickFirst(page, [
    "#rootForm\\:btnConfirmer",
    "button[id$=':btnConfirmer']",
    "button:has-text('Valider')",
  ]);
  if (!clicked) {
    throw new Error("Could not click Valider button");
  }
  onLog("debug", "✓ Valider clicked - waiting for declaration to load...");

  // BADR loads the declaration via PrimeFaces AJAX (no full navigation).
  // Some responses arrive in <1s; others take 60-90s depending on BADR load.
  //
  // Three-phase wait:
  //   Phase 1 – 5s detection window: look for the "Traitement en cours..."
  //             overlay OR for declaration tabs already rendered.
  //   Phase 2 – if overlay detected, wait for it to disappear (full timeout).
  //   Phase 3 – poll for declaration tab indicators (remaining timeout).

  const DECL_SPINNER_SELECTORS = [
    "div.ui-blockui-content:has-text('Traitement en cours')",
    "div.ui-blockui-content img[src*='ajax-loading']",
  ];

  const DECLARATION_LOADED_SELECTORS = [
    "a[href='#mainTab:tab0']", // Entête tab link
    "input[id$=':nomOperateurExpediteur']", // shipper field
    "#mainTab", // main tab container
    "a[href='#mainTab:tab7']", // Documents tab link
    "div.ui-tabs", // any PrimeFaces tab panel
  ];

  const maxWaitMs = config.timeout; // default 120 000 ms
  const loadStart = Date.now();
  let declarationLoaded = false;

  // Phase 1 — 5s detection window.
  const detectDeadline = loadStart + 5000;
  let sawSpinner = false;
  while (Date.now() < detectDeadline) {
    await ensureNoBadrInternalError(conn, onLog, "declaration load phase 1");
    // Check if declaration already appeared before spinner.
    const ready = await firstPresent(page, DECLARATION_LOADED_SELECTORS);
    if (ready) {
      declarationLoaded = true;
      break;
    }
    // Check for loading overlay.
    const spinner = await firstVisible(page, DECL_SPINNER_SELECTORS, 200);
    if (spinner) {
      sawSpinner = true;
      break;
    }
    await page.waitForTimeout(300);
  }

  // Phase 2 — wait for overlay to disappear.
  if (sawSpinner && !declarationLoaded) {
    onLog(
      "debug",
      "Detected BADR loading spinner — waiting for it to finish...",
    );
    const spinnerStill = await firstVisible(page, DECL_SPINNER_SELECTORS, 300);
    if (spinnerStill) {
      await spinnerStill.loc
        .waitFor({ state: "hidden", timeout: maxWaitMs })
        .catch(() => {});
    }
    onLog("debug", "✓ BADR loading spinner gone");
  }

  // Phase 3 — poll for declaration indicators with remaining timeout.
  if (!declarationLoaded) {
    while (Date.now() - loadStart < maxWaitMs) {
      await ensureNoBadrInternalError(conn, onLog, "declaration load phase 3");
      const hit = await firstPresent(page, DECLARATION_LOADED_SELECTORS);
      if (hit) {
        declarationLoaded = true;
        break;
      }
      await page.waitForTimeout(400);
    }
  }

  const elapsed = Math.round((Date.now() - loadStart) / 1000);
  if (!declarationLoaded) {
    onLog(
      "warn",
      `Declaration form not detected after ${elapsed}s — continuing anyway`,
    );
  } else {
    onLog("debug", `✓ Declaration page loaded (${elapsed}s)`);
  }

  // Brief stabilisation pause for dynamic fields to finish rendering.
  await page.waitForTimeout(600);

  // ── "Already Signed" detection ─────────────────────────────────────────────
  // When a declaration was already definitively registered (enregistrée),
  // BADR shows an error banner containing "enregistrée" and asks for the
  // definitive reference.  This is NOT a BADR internal error — we handle it
  // separately so the caller can switch to the recovery print flow.
  const alreadySignedSelectors = [
    "#rapportMsg .ui-messages-error",
    "#form1\\:messages .ui-messages-error",
    ".ui-messages-error",
  ];
  for (const sel of alreadySignedSelectors) {
    const contexts = contextsFor(page);
    for (const ctx of contexts) {
      try {
        const el = ctx.locator(sel).first();
        if (!(await el.isVisible({ timeout: 600 }).catch(() => false)))
          continue;
        const text = normalize(
          await el.innerText().catch(() => ""),
        ).toUpperCase();
        if (
          text.includes("ENREGISTR") ||
          text.includes("R\u00C9F\u00C9RENCE D\u00C9FINITIVE") ||
          text.includes("REFERENCE DEFINITIVE")
        ) {
          onLog(
            "warn",
            "BADR reports declaration is already definitively registered — skipping to reprint flow",
            { errorText: text.slice(0, 200) },
          );
          throw new Error(`${ALREADY_SIGNED_PREFIX}:${text.slice(0, 200)}`);
        }
      } catch (e) {
        if (isAlreadySignedError(e)) throw e;
        // other inspection errors — ignore and continue
      }
    }
  }

  await ensureNoBadrInternalError(conn, onLog, "fill declaration search done");
};

const checkShipper = async (conn, expectedShipper, onLog) => {
  await ensureNoBadrInternalError(conn, onLog, "check shipper start");

  onLog("debug", "Checking shipper name...", { expected: expectedShipper });

  if (!normalize(expectedShipper)) {
    onLog("debug", "✓ No shipper to validate (empty expected value)");
    return { ok: true, actual: "", expected: "" };
  }

  const page = conn.page;
  let hit = null;
  const shipperSelectors = [
    "#mainTab\\:form0\\:nomOperateurExpediteur",
    "input[id$=':nomOperateurExpediteur']",
    "div[id$=':panelExpeexpoced_content'] input[id*='nomOperateurExpediteur']",
  ];

  for (let attempt = 1; attempt <= 6; attempt++) {
    await openEnteteTab(page);
    hit = await firstVisible(page, shipperSelectors, 1000);
    if (!hit) {
      hit = await firstPresent(page, shipperSelectors);
    }
    if (hit) break;

    onLog(
      "debug",
      `Shipper field not found yet (attempt ${attempt}/4), retrying...`,
    );
    await page.waitForTimeout(700);
  }

  if (!hit) {
    onLog("warn", "✗ Could not find shipper field on page");
    return { ok: false, actual: "", expected: expectedShipper };
  }

  const actual = await hit.loc.inputValue().catch(async () => {
    return hit.loc.evaluate((el) => el.value || el.getAttribute("value") || "");
  });

  // Respect the BADR field's maxlength: truncate expectedShipper to the limit
  // the browser enforces so comparisons and fills stay consistent.
  // Truncation is done at the last word boundary so no word is cut mid-character.
  const maxLen = await hit.loc
    .evaluate((el) => (el.maxLength > 0 ? el.maxLength : 50))
    .catch(() => 50);
  const effectiveExpected = truncateShipperToMaxLen(expectedShipper, maxLen);

  const ok =
    isShipperEquivalent(effectiveExpected, actual) ||
    isShipperEquivalent(expectedShipper, actual);

  if (ok) {
    const strictEqual =
      toUpperCompact(actual) === toUpperCompact(effectiveExpected);
    onLog(
      "debug",
      strictEqual
        ? "✓ Shipper matches: " + actual
        : "✓ Shipper matches (tolerant compare): " + actual,
    );
    await ensureNoBadrInternalError(conn, onLog, "check shipper done");
    return { ok: true, actual, expected: expectedShipper, updated: false };
  }

  onLog(
    "warn",
    `✗ Shipper mismatch - expected: '${effectiveExpected}' actual: '${actual}'. Updating BADR field...`,
  );

  const isDisabled = await hit.loc.isDisabled().catch(() => false);
  if (isDisabled) {
    onLog(
      "error",
      "✗ Shipper field is disabled and value mismatched; cannot auto-correct",
    );
    return { ok: false, actual, expected: expectedShipper, disabled: true };
  }

  await hit.loc.fill("");
  await hit.loc.fill(effectiveExpected);
  await conn.page.waitForTimeout(300);

  const after = await hit.loc.inputValue().catch(() => "");
  const updatedOk = isShipperEquivalent(effectiveExpected, after);

  if (updatedOk) {
    onLog(
      "info",
      `✓ BADR shipper field updated: '${after}'${effectiveExpected !== normalize(expectedShipper) ? ` (truncated to ${maxLen} chars)` : ""}`,
    );
    await ensureNoBadrInternalError(conn, onLog, "check shipper updated");
    return {
      ok: true,
      actual,
      expected: expectedShipper,
      updated: true,
      after,
    };
  }

  onLog(
    "error",
    `✗ Could not update BADR shipper field. expected='${effectiveExpected}' after='${after}'`,
  );
  return { ok: false, actual, expected: expectedShipper, updated: true, after };
};

const checkRequiredDocuments = async (conn, onLog) => {
  const page = conn.page;

  await ensureNoBadrInternalError(
    conn,
    onLog,
    "check required documents start",
  );

  onLog("debug", "Navigating to Documents tab...");
  await clickFirst(page, [
    "a[href='#mainTab:tab7']",
    "li[role='tab'] a:has-text('Documents')",
  ]);
  await page.waitForTimeout(1000);
  onLog("debug", "✓ Documents tab opened");

  onLog("debug", "Checking for required documents (TRANSPORT + FACTURE)...");
  let body = "";
  let hasTransport = false;
  let hasFacture = false;
  const TRANSPORT_PATTERNS = [/TRANSPORT/, /\bA0004\b/];
  const FACTURE_PATTERNS = [/FACTURE/, /\bA0006\b/];
  let docLinkBody = "";
  let rowCount = 0;

  for (let attempt = 1; attempt <= 6; attempt++) {
    await ensureNoBadrInternalError(
      conn,
      onLog,
      `documents table read attempt ${attempt}`,
    );

    const strictBody = await textInTable(
      page,
      "#mainTab\\:form7\\:listeDocumentsAnnexes_data",
    );
    const fallbackBody =
      strictBody ||
      (await textInTable(
        page,
        "tbody[id*='listeDocumentsAnnexes_data'], div[id*='listeDocumentsAnnexes'] tbody.ui-datatable-data, div[id*='listeDocumentsAnnexes']",
      ));

    const docsContainer = await firstPresent(page, [
      "div[id*='listeDocumentsAnnexes']",
    ]);
    if (docsContainer) {
      rowCount = await docsContainer.ctx
        .locator("tbody[id*='listeDocumentsAnnexes_data'] tr[role='row']")
        .count()
        .catch(() => 0);

      docLinkBody = toUpperCompact(
        await docsContainer.ctx
          .locator("div[id*='listeDocumentsAnnexes'] td[role='gridcell'] a")
          .allInnerTexts()
          .then((texts) => texts.join(" | "))
          .catch(() => ""),
      );
    } else {
      rowCount = 0;
      docLinkBody = "";
    }

    body = fallbackBody;
    const combinedBody = `${body} ${docLinkBody}`;
    hasTransport = TRANSPORT_PATTERNS.some((re) => re.test(combinedBody));
    hasFacture = FACTURE_PATTERNS.some((re) => re.test(combinedBody));
    if (hasTransport && hasFacture) break;

    if (attempt < 6) {
      onLog(
        "debug",
        `Documents not fully detected on attempt ${attempt}/6 (rows=${rowCount}), retrying...`,
      );
      await page.waitForTimeout(700 + attempt * 120);
    }
  }

  const hasAll = hasTransport && hasFacture;

  onLog(
    hasAll ? "debug" : "error",
    `✓ Documents found: ${hasTransport ? "✓TRANSPORT " : "✗TRANSPORT "}${hasFacture ? "✓FACTURE" : "✗FACTURE"}`,
    hasAll ? undefined : { rowCount },
  );

  await ensureNoBadrInternalError(conn, onLog, "check required documents done");

  return { ok: hasAll, body };
};

const checkPreapLot = async (conn, expectedLot, onLog) => {
  const page = conn.page;

  await ensureNoBadrInternalError(conn, onLog, "preapurement start");

  onLog("debug", "Navigating to Preapurement DS tab...");
  await clickFirst(page, [
    "a[href='#mainTab:tab3']",
    "li[role='tab'] a:has-text('Preapurement DS')",
    "li[role='tab'] a:has-text('Apurement DS')",
  ]);
  await page.waitForTimeout(1000);
  onLog("debug", "✓ Preapurement tab opened");

  onLog("debug", "Checking for preapurement lot...", { expected: expectedLot });

  const expectedParsed = parseLotRef(expectedLot);
  const expectedNormalized =
    expectedParsed?.normalized || normalizeLotRef(expectedLot);
  const expectedBase = expectedParsed?.base || "";
  const expectedDum =
    expectedParsed?.suffixes?.[expectedParsed.suffixes.length - 1] || "";

  if (!expectedBase || !expectedDum) {
    onLog("error", "Invalid expected preapurement lot format", {
      expectedLot,
    });
    return {
      ok: false,
      body: "",
      normalizedExpected: expectedNormalized,
      lotRefs: [],
      totalPreap: 0,
    };
  }

  const [leftPart = "", rightPart = ""] = String(expectedLot).split("/");
  const leftNoZeros = String(leftPart).replace(/^0+(?=\d)/, "") || "0";
  const rightNoZeros = String(rightPart).replace(/^0+(?=\d)/, "") || "0";
  const expectedVariants = new Set([
    toUpperCompact(expectedLot),
    toUpperCompact(`${leftNoZeros}/${rightPart}`),
    toUpperCompact(`${leftPart}/${rightNoZeros}`),
    toUpperCompact(`${leftNoZeros}/${rightNoZeros}`),
    toUpperCompact(expectedNormalized),
    toUpperCompact(`${expectedBase}/1/${expectedDum}`),
    toUpperCompact(`${expectedBase}/1/*`),
  ]);

  let lastBody = "";
  let lotRefs = [];

  for (let attempt = 1; attempt <= 6; attempt++) {
    await ensureNoBadrInternalError(
      conn,
      onLog,
      `preapurement table read attempt ${attempt}`,
    );

    const body = await textInTable(page, "#mainTab\\:form3\\:table_preap_data");
    const fallbackBody =
      body ||
      (await textInTable(
        page,
        "tbody[id*='table_preap_data'], div[id*='table_preap'] tbody.ui-datatable-data",
      ));

    lastBody = fallbackBody;
    lotRefs = extractLotRefs(fallbackBody);
    const bodyCompact = toUpperCompact(fallbackBody);

    const variantMatched = [...expectedVariants].some((v) =>
      bodyCompact.includes(v),
    );
    const normalizedMatched = lotRefs.includes(expectedNormalized);
    const semanticMatched = lotRefs.some((lot) =>
      lotMatchesExpectedDum(lot, expectedBase, expectedDum),
    );

    if (variantMatched || normalizedMatched || semanticMatched) {
      onLog(
        "debug",
        `✓ Found preapurement lot: ${expectedLot} (normalized=${expectedNormalized})`,
        {
          matchedBy: semanticMatched
            ? "semantic"
            : normalizedMatched
              ? "normalized"
              : "variant",
          lotRefs,
        },
      );
      return {
        ok: true,
        body: fallbackBody,
        normalizedExpected: expectedNormalized,
        lotRefs,
      };
    }

    if (attempt < 6) {
      onLog(
        "debug",
        `Preapurement lot not matched on attempt ${attempt}/6, retrying...`,
      );
      await page.waitForTimeout(900 + attempt * 150);
    }
  }

  const preapCountText =
    (await page
      .locator("td:has-text('Nombre total des préapurements')")
      .first()
      .innerText()
      .catch(() => "")) ||
    (await page
      .locator("body")
      .innerText()
      .then((text) => {
        const normalizedBody = toUpperCompact(text);
        const m = normalizedBody.match(
          /NOMBRE TOTAL DES PREAPUREMENTS[^0-9]*(\d+)/,
        );
        return m ? m[1] : "";
      })
      .catch(() => ""));
  const preapCountMatch = String(preapCountText).match(/(\d+)/);
  const totalPreap = preapCountMatch ? Number(preapCountMatch[1]) : 0;

  const sameDumSuffix = String(expectedNormalized).split("/")[1] || "";
  const suffixMatched = lotRefs.some((lot) =>
    lotMatchesExpectedDum(lot, expectedBase, sameDumSuffix),
  );

  if (totalPreap > 0 && suffixMatched) {
    onLog(
      "warn",
      `⚠ Preapurement exact lot not found, but fallback accepted (total=${totalPreap}, suffix=/${sameDumSuffix})`,
      { expectedLot, normalizedExpected: expectedNormalized, lotRefs },
    );
    return {
      ok: true,
      body: lastBody,
      normalizedExpected: expectedNormalized,
      lotRefs,
      fallbackAccepted: true,
    };
  }

  onLog("error", `✗ Preapurement lot not found: ${expectedLot}`, {
    normalizedExpected: expectedNormalized,
    lotRefs,
    totalPreap,
  });

  return {
    ok: false,
    body: lastBody,
    normalizedExpected: expectedNormalized,
    lotRefs,
    totalPreap,
  };
};

const clickSecondValidate = async (conn, onLog) => {
  const page = conn.page;

  await ensureNoBadrInternalError(conn, onLog, "second validate start");

  onLog("debug", "Clicking VALIDER button...");
  const clicked = await clickFirst(page, [
    "#secure__2003",
    "a[id*='2003']:has-text('VALIDER')",
    "a.ui-menuitem-link:has-text('VALIDER')",
  ]);

  if (!clicked) {
    throw new Error("Could not click declaration VALIDER action");
  }
  onLog("debug", "✓ VALIDER clicked");

  await page.waitForTimeout(1500);

  const errorMessage = await firstVisible(page, [
    ".ui-messages-error",
    ".ui-message-error",
    "#msg-error .ui-messages-error",
  ]);

  if (errorMessage) {
    const errorText = await errorMessage.loc
      .innerText()
      .catch(() => "Unknown error");
    onLog("error", `✗ Validation error: ${errorText}`);
    throw new Error("Validation returned an error message: " + errorText);
  }

  await ensureNoBadrInternalError(conn, onLog, "second validate done");
  onLog("debug", "✓ Validation successful");
};

const signDeclaration = async (conn, onLog) => {
  const page = conn.page;

  await ensureNoBadrInternalError(conn, onLog, "sign declaration start");

  onLog("debug", "Clicking SIGNER menu item...");
  const signClicked = await clickFirst(page, [
    "#secure_2018",
    "a[id*='2018']:has-text('SIGNER')",
    "a.ui-menuitem-link:has-text('SIGNER')",
  ]);
  if (!signClicked) {
    throw new Error("Could not click SIGNER");
  }
  onLog("debug", "✓ SIGNER menu clicked");

  await page.waitForTimeout(600);

  onLog("debug", "Confirming signature dialog (clicking Oui)...");
  const yesClicked = await clickFirst(page, [
    "#j_id_47_1\\:j_id_47_5",
    "button.ui-confirmdialog-yes",
    "button:has-text('Oui')",
  ]);
  if (!yesClicked) {
    throw new Error("Could not confirm SIGNER dialog");
  }
  onLog("debug", "✓ Signature confirmed");

  onLog("debug", "Waiting for signing process to complete...");
  await waitForSigningReady(conn, onLog);

  // Extra wait to ensure page is fully stable
  await page.waitForTimeout(600);
  await ensureNoBadrInternalError(conn, onLog, "sign declaration done");
  onLog("debug", "✓ Page stabilized");
};

const verifyPdfSaved = async (targetPath) => {
  const exists = await fs.pathExists(targetPath);
  if (!exists) {
    return { ok: false, reason: "PDF file not found on disk after print" };
  }

  const stats = await fs.stat(targetPath).catch(() => null);
  const size = stats?.size || 0;
  if (size < 1024) {
    return {
      ok: false,
      reason: `PDF file is too small (${size} bytes), likely invalid`,
      size,
    };
  }

  return { ok: true, size };
};

/**
 * Click IMPRIMER assuming the blocking overlay has already been cleared
 * externally.  Does NOT call waitForNoBlockingOverlay – the caller must do
 * that before setting up the download listener to avoid a timeout race.
 */
const clickImprimerDirect = async (page) => {
  await unhideImprimerButton(page);
  const hit = await firstVisible(page, IMPRIMER_CLICK_SELECTORS, 4000);
  if (hit) {
    try {
      await hit.loc.click({ timeout: 8000 });
      return true;
    } catch {
      // fall through to JS click
    }
  }
  // Direct JS invocation (most reliable; avoids pointer-event checks)
  return page.evaluate(() => {
    const a =
      document.querySelector("#secure_imprimer") ||
      [...document.querySelectorAll("a.ui-menuitem-link")].find((el) =>
        (el.textContent || "").trim().startsWith("IMPRIMER"),
      );
    if (!a) return false;
    a.removeAttribute("hidden");
    a.style.removeProperty("display");
    a.click();
    return true;
  });
};

/**
 * Poll ~/Downloads for a new PDF that was not in `knownFiles` at the time
 * the snapshot was taken.  Copies it to `targetPath` and removes the
 * original.  Returns true when a valid file is saved, false after timeout.
 *
 * Rationale: when Playwright is connected via CDP to a user-opened Edge
 * instance, the browser's download pipe is not managed by Playwright, so
 * the 'download' event is never emitted.  The file still lands in the OS
 * Downloads directory however.
 */
const waitForNewPdfInDownloads = async (knownFiles, targetPath, onLog) => {
  const downloadsDir = path.join(os.homedir(), "Downloads");
  const deadline = Date.now() + 35000; // 35 s window

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 900));

    let files;
    try {
      files = await fs.readdir(downloadsDir);
    } catch {
      continue;
    }

    const newPdfs = files.filter(
      (f) =>
        !knownFiles.has(f) &&
        f.toLowerCase().endsWith(".pdf") &&
        !f.toLowerCase().endsWith(".crdownload"),
    );

    for (const filename of newPdfs) {
      const srcPath = path.join(downloadsDir, filename);
      // Confirm download is complete (file size stable over ~1 s)
      const stat1 = await fs.stat(srcPath).catch(() => null);
      if (!stat1 || stat1.size < 1024) continue;
      await new Promise((r) => setTimeout(r, 1000));
      const stat2 = await fs.stat(srcPath).catch(() => null);
      if (!stat2 || stat2.size !== stat1.size) continue;

      onLog("debug", `✓ New PDF detected in Downloads folder: ${filename}`);
      await fs.ensureDir(path.dirname(targetPath));
      await fs.copy(srcPath, targetPath, { overwrite: true });
      await fs.remove(srcPath).catch(() => {});
      return true;
    }
  }
  return false;
};

const printAndSave = async (conn, targetPath, onLog) => {
  const page = conn.page;
  await fs.ensureDir(path.dirname(targetPath));

  await ensureNoBadrInternalError(conn, onLog, "print start");

  onLog("debug", "Waiting for IMPRIMER button to be ready...");

  // ── Phase 0: clear the blocking overlay BEFORE registering any download
  // listener.  The overlay can take 60-90 s to disappear after signing; if
  // the download promise were started now it would expire while we wait.
  await page.waitForTimeout(1200);
  await waitForNoBlockingOverlay(page, Math.min(config.timeout, 90000));
  onLog(
    "debug",
    "✓ Overlay cleared – waiting for IMPRIMER to appear in DOM...",
  );

  // After a long signing, BADR rebuilds the left-panel menu asynchronously.
  // Wait for #secure_imprimer to be attached to the DOM before starting
  // click attempts — otherwise all JS evaluate() calls return false.
  const imprimerAttached = await page
    .locator('#secure_imprimer, a.ui-menuitem-link:has-text("IMPRIMER")')
    .first()
    .waitFor({ state: "attached", timeout: 30000 })
    .then(() => true)
    .catch(() => false);
  if (!imprimerAttached) {
    onLog(
      "warn",
      "IMPRIMER element not found in DOM after 30s — will try JS click anyway",
    );
  } else {
    onLog("debug", "✓ IMPRIMER present in DOM – starting print attempts");
  }

  const downloadsDir = path.join(os.homedir(), "Downloads");
  let lastError = "";

  for (let attempt = 1; attempt <= PRINT_ATTEMPTS; attempt++) {
    await ensureNoBadrInternalError(conn, onLog, `print attempt ${attempt}`);

    // Re-show the button – BADR hides it in its own onclick handler after
    // every click, so each retry needs to un-hide it first.
    await unhideImprimerButton(page);

    // Fresh Downloads snapshot per attempt so we only detect files that
    // appear AFTER this particular click.
    const downloadsSnapshot = new Set(
      await fs.readdir(downloadsDir).catch(() => []),
    );

    // Start Downloads-folder monitor concurrently.  In CDP-connected mode
    // Playwright may not emit 'download' events; the file still lands in the
    // user's OS Downloads directory, so we poll for it in parallel.
    const downloadsCheckPromise = waitForNewPdfInDownloads(
      downloadsSnapshot,
      targetPath,
      onLog,
    );

    // Register Playwright event listeners NOW – overlay is clear, click is
    // imminent, so the 90-s window will not expire before the file arrives.
    const downloadPromise = Promise.race([
      page
        .waitForEvent("download", { timeout: PRINT_DOWNLOAD_TIMEOUT_MS })
        .catch(() => null),
      conn.context
        .waitForEvent("download", { timeout: PRINT_DOWNLOAD_TIMEOUT_MS })
        .catch(() => null),
    ]);

    onLog(
      "debug",
      `Attempting to click IMPRIMER (attempt ${attempt}/${PRINT_ATTEMPTS})...`,
    );

    // clickImprimerDirect does NOT call waitForNoBlockingOverlay again;
    // the overlay is already clear at this point.
    const imprimerClicked = await clickImprimerDirect(page);
    if (!imprimerClicked) {
      lastError = "Could not click IMPRIMER";
      onLog("warn", `${lastError} on attempt ${attempt}`);
      await page.waitForTimeout(1000);
      continue;
    }

    onLog("debug", "✓ IMPRIMER clicked");
    onLog("debug", "Waiting for PDF download...");

    // Wait for the Playwright event (up to 90 s).
    const download = await downloadPromise;

    if (download) {
      // ── Playwright captured the download event ──────────────────────────
      const tempPath = `${targetPath}.part`;
      await fs.remove(tempPath).catch(() => null);
      await download.saveAs(tempPath);
      await ensureNoBadrInternalError(conn, onLog, "print saveAs done");
      await fs.move(tempPath, targetPath, { overwrite: true });

      const pdfCheck = await verifyPdfSaved(targetPath);
      if (!pdfCheck.ok) {
        lastError = pdfCheck.reason;
        onLog("warn", `Printed file invalid (attempt ${attempt})`, {
          reason: pdfCheck.reason,
        });
        await fs.remove(targetPath).catch(() => null);
        await page.waitForTimeout(800);
        continue;
      }

      await ensureNoBadrInternalError(conn, onLog, "print done");
      onLog("info", "✓ PDF SAVED", {
        filename: path.basename(targetPath),
        fullPath: targetPath,
        size: pdfCheck.size,
      });
      return;
    }

    // ── Playwright event not received – check the Downloads folder
    // (already polling in background since before the click).
    onLog(
      "debug",
      "Playwright download event not captured – awaiting Downloads folder check...",
    );
    const foundInDownloads = await downloadsCheckPromise;
    if (foundInDownloads) {
      const pdfCheck = await verifyPdfSaved(targetPath);
      if (pdfCheck.ok) {
        await ensureNoBadrInternalError(conn, onLog, "print done (downloads)");
        onLog("info", "✓ PDF SAVED (via Downloads folder fallback)", {
          filename: path.basename(targetPath),
          fullPath: targetPath,
          size: pdfCheck.size,
        });
        return;
      }
      lastError = "Downloaded file failed validation";
    } else {
      lastError =
        "No PDF captured after IMPRIMER (Playwright event + Downloads folder both empty)";
    }

    onLog("warn", `${lastError} (attempt ${attempt})`);
    await page.waitForTimeout(1200);
  }

  throw new Error(
    `Print failed after ${PRINT_ATTEMPTS} attempts: ${lastError || "unknown print error"}`,
  );
};

/**
 * Recovery flow: navigate to DEDOUANEMENT → Services → Rechercher par référence,
 * fill the definitive serie/key, load the declaration, then IMPRIMER → save PDF.
 * Used when a DUM was already signed (ALREADY_SIGNED) but PDF was never saved.
 */
const reprintBySerieRef = async (
  conn,
  { bureau, regime, year, serie, key },
  pdfPath,
  onLog,
) => {
  const page = conn.page;

  // The definitive reference is only searchable via
  // DEDOUANEMENT → Services → Rechercher par référence.
  // ("Modifier une déclaration" only accepts provisional references.)
  onLog("debug", "Reprint: expanding DEDOUANEMENT menu...");
  const openedMenu = await clickFirst(page, [
    "h3.ui-panelmenu-header:has-text('DEDOUANEMENT')",
    "h3:has-text('DEDOUANEMENT')",
    ".ui-panelmenu-header a:has-text('DEDOUANEMENT')",
  ]);
  if (!openedMenu) throw new Error("Reprint: could not open DEDOUANEMENT menu");
  // Give the panel time to fully expand before looking for child items.
  await page.waitForTimeout(1000);

  onLog("debug", "Reprint: clicking Services...");
  // The Services item is a collapsible sub-panel whose <a> has nested spans.
  // Use force:true to bypass any interactability check, and a longer timeout.
  const servicesHit = await firstVisible(
    page,
    [
      "a#_2051",
      "a.ui-menuitem-link:has-text('Services')",
      "a:has-text('Services')",
    ],
    3000,
  );
  if (!servicesHit)
    throw new Error("Reprint: could not find Services menu item");
  await servicesHit.loc.click({ force: true });
  await page.waitForTimeout(1000);

  onLog("debug", "Reprint: clicking Rechercher par référence...");
  // BADR opens the search form via window.open() (URL has is_popup=true).
  // Register the popup listener BEFORE the click so the event is not missed.
  const popupPagePromise = conn.context
    .waitForEvent("page", { timeout: 8000 })
    .catch(() => null);

  const clickedSearch = await clickFirst(page, [
    "a:has-text('Rechercher par r\u00e9f\u00e9rence')",
    "span.ui-menuitem-text:has-text('Rechercher par r\u00e9f\u00e9rence')",
    "a[title*='Rechercher par r']",
    "a:has-text('Rechercher par reference')",
  ]);
  if (!clickedSearch)
    throw new Error("Reprint: could not click 'Rechercher par référence'");

  onLog(
    "debug",
    "Reprint: waiting for reference search popup/frame to load...",
  );

  let searchCtx = null;
  let popupPage = null; // set when the form lives in a popup Page, not a frame

  // Phase 1 – popup window (most common: BADR uses window.open)
  const maybePopup = await popupPagePromise;
  if (maybePopup) {
    onLog("debug", "Reprint: popup window detected, waiting for form...");
    try {
      await maybePopup.waitForLoadState("domcontentloaded", { timeout: 8000 });
      const bureauVis = await maybePopup
        .locator('input[name="rootForm:_bureauId"]')
        .isVisible({ timeout: 5000 })
        .catch(() => false);
      if (bureauVis) {
        searchCtx = maybePopup;
        popupPage = maybePopup;
        onLog("debug", "Reprint: ✓ search form ready in popup window");
      }
    } catch (popupErr) {
      onLog("warn", `Reprint: popup form check failed: ${popupErr.message}`);
    }
  }

  // Phase 2 fallback – scan all context pages and their frames
  if (!searchCtx) {
    onLog(
      "debug",
      "Reprint: scanning all context pages/frames for search form...",
    );
    const frameWaitStart = Date.now();
    while (Date.now() - frameWaitStart < 10000) {
      await ensureNoBadrInternalError(conn, onLog, "reprint: wait for form");
      const allCtxPages = conn.context.pages();
      const candidates = [
        ...allCtxPages,
        ...allCtxPages.flatMap((pg) => pg.frames()),
      ];
      for (const ctx of candidates) {
        try {
          const url = typeof ctx.url === "function" ? ctx.url() : "";
          const inSearchPage = url.includes("ded_recherche_reference");
          const bureauVis = await ctx
            .locator('input[name="rootForm:_bureauId"]')
            .isVisible({ timeout: 600 })
            .catch(() => false);
          if (bureauVis || inSearchPage) {
            const confirmed = await ctx
              .locator('input[name="rootForm:_bureauId"]')
              .isVisible({ timeout: 1500 })
              .catch(() => false);
            if (confirmed) {
              searchCtx = ctx;
              if (allCtxPages.includes(ctx) && ctx !== page) popupPage = ctx;
              break;
            }
          }
        } catch (_) {
          // detached frame/page — ignore
        }
      }
      if (searchCtx) break;
      await page.waitForTimeout(400);
    }
  }

  if (!searchCtx) throw new Error("Reprint: search form did not appear");
  onLog("debug", "Reprint: ✓ search form ready");

  // Helper: fill a named input inside searchCtx
  const fillNamed = async (name, value) => {
    const loc = searchCtx.locator(`input[name="${name}"]`).first();
    const visible = await loc.isVisible({ timeout: 2000 }).catch(() => false);
    if (!visible) return false;
    await loc.fill("");
    await loc.fill(String(value));
    return true;
  };

  onLog("debug", "Reprint: filling search form...", {
    bureau,
    regime,
    year,
    serie,
    key,
  });

  if (
    !(await fillNamed("rootForm:_bureauId", bureau || config.badr.bureauCode))
  )
    throw new Error("Reprint: could not fill Bureau");
  if (
    !(await fillNamed("rootForm:_regimeId", regime || config.badr.regimeCode))
  )
    throw new Error("Reprint: could not fill Regime");
  if (!(await fillNamed("rootForm:_anneeId", year || config.badr.year)))
    throw new Error("Reprint: could not fill Year");
  if (!(await fillNamed("rootForm:_serieId", serie)))
    throw new Error("Reprint: could not fill Serie");
  if (!(await fillNamed("rootForm:_cleId", key)))
    throw new Error("Reprint: could not fill Key");

  // Check "Déclaration enregistrée" checkbox — required for definitive references.
  onLog("debug", "Reprint: checking 'Déclaration enregistrée' checkbox...");
  try {
    const chkInput = searchCtx
      .locator('input[name="rootForm:selectcheckbxDecEnreg_input"]')
      .first();
    const chkExists = (await chkInput.count().catch(() => 0)) > 0;
    if (chkExists) {
      const isChecked = await chkInput.isChecked().catch(() => false);
      if (!isChecked) {
        // Click the visible .ui-chkbox-box wrapper (PrimeFaces hides the real input)
        const chkBox = searchCtx.locator(".ui-chkbox-box").first();
        await chkBox.click({ force: true });
        await page.waitForTimeout(300);
      }
      onLog("debug", "Reprint: ✓ Déclaration enregistrée checked");
    } else {
      onLog(
        "warn",
        "Reprint: checkbox 'Déclaration enregistrée' not found — continuing anyway",
      );
    }
  } catch (chkErr) {
    onLog(
      "warn",
      `Reprint: checkbox check failed (non-critical): ${chkErr.message}`,
    );
  }

  onLog("debug", "Reprint: clicking Valider...");
  const clicked =
    (await searchCtx
      .locator('button[id$=":btnConfirmer"], button:has-text("Valider")')
      .first()
      .click()
      .then(() => true)
      .catch(() => false)) ||
    (await clickFirst(page, [
      "#rootForm\\:btnConfirmer",
      "button[id$=':btnConfirmer']",
      "button:has-text('Valider')",
    ]));
  if (!clicked) throw new Error("Reprint: could not click Valider");

  // The declaration may load in the popup page or the main page.
  const activePage = popupPage || page;

  // Wait for the declaration to load (same pattern as fillDeclarationSearch).
  const DECLARATION_LOADED_SELECTORS = [
    "a[href='#mainTab:tab0']",
    "input[id$=':nomOperateurExpediteur']",
    "#mainTab",
    "a[href='#mainTab:tab7']",
  ];
  const maxWaitMs = config.timeout;
  const loadStart = Date.now();
  let loaded = false;
  while (Date.now() - loadStart < maxWaitMs) {
    await ensureNoBadrInternalError(
      conn,
      onLog,
      "reprint: wait for declaration",
    );
    const hit = await firstPresent(activePage, DECLARATION_LOADED_SELECTORS);
    if (hit) {
      loaded = true;
      break;
    }
    await activePage.waitForTimeout(400);
  }
  if (!loaded)
    throw new Error("Reprint: declaration did not load after Valider");
  await activePage.waitForTimeout(600);

  onLog("debug", "Reprint: printing declaration...");
  // Temporarily point conn.page at the popup so printAndSave (which uses
  // conn.page internally) targets the right window.
  const _origPage = conn.page;
  if (popupPage) conn.page = popupPage;
  try {
    await printAndSave(conn, pdfPath, onLog);
  } finally {
    conn.page = _origPage;
    if (popupPage && !popupPage.isClosed()) {
      await popupPage.close().catch(() => {});
      onLog("debug", "Reprint: popup closed");
    }
  }

  const check = await verifyPdfSaved(pdfPath);
  if (!check.ok)
    throw new Error(`Reprint: PDF verification failed — ${check.reason}`);

  onLog("info", `✓ Reprint saved: ${path.basename(pdfPath)}`);
};

export const runSigningJob = async ({
  parsedLtas,
  shipperByFileName,
  onLog,
}) => {
  const conn = new BADRConnection();
  await conn.connect();

  const results = [];

  for (const lta of parsedLtas) {
    const normalLtaFolder = path.join(
      config.directories.signedLtas,
      `LTA N° ${lta.ltaRef}`,
    );
    const readyLtaFolder = path.join(
      config.directories.signedLtas,
      `LTA N° ${lta.ltaRef} READY`,
    );
    const problemLtaFolder = path.join(
      config.directories.signedLtas,
      `LTA N° ${lta.ltaRef} PROBLEM`,
    );
    const readyExists = await fs.pathExists(readyLtaFolder);
    const problemExists = await fs.pathExists(problemLtaFolder);
    const ltaFolder = problemExists
      ? problemLtaFolder
      : readyExists
        ? readyLtaFolder
        : normalLtaFolder;

    await fs.ensureDir(ltaFolder);
    const ltaLogPath = path.join(ltaFolder, `${lta.ltaRef}.log`);
    const csvPath = path.join(ltaFolder, "signed_series.csv");

    // Load any existing signed-series CSV so we can fast-path already-signed DUMs
    // without hitting BADR at all (avoids the "enregistrée" error entirely).
    let signedSeriesMap = await loadSignedSeriesCsv(csvPath);

    const emit = (level, message, meta = {}) => {
      onLog(level, message, meta);
      appendLtaLog(ltaLogPath, level, message, meta);
    };

    emit("info", `Processing LTA ${lta.ltaRef}`, {
      ltaFile: lta.fileName,
      dumsCount: lta.dums.length,
      validDums: lta.validDums,
      invalidDums: lta.invalidDums,
    });

    for (const dum of lta.dums) {
      const pdfName = `DUM ${dum.dumNumber} LTA N°${lta.ltaRef}.pdf`;
      const pdfPath = path.join(ltaFolder, pdfName);

      const result = {
        ltaRef: lta.ltaRef,
        fileName: lta.fileName,
        dumNumber: dum.dumNumber,
        rawSerie: dum.rawSerie,
        status: "failed",
        reason: "",
        outputPdf: pdfPath,
      };

      if (dum.isValid === false || !dum.serie || !dum.key) {
        result.status = "failed";
        result.reason = dum.invalidReason || "Invalid/missing DUM series";
        emit(
          "error",
          `✗ FAILED - DUM ${dum.dumNumber} LTA N°${lta.ltaRef}: ${result.reason}`,
          { sourceCell: dum.sourceCell, rawSerie: dum.rawSerie },
        );
        results.push(result);
        continue;
      }

      // Resume mode: skip DUMs that are already signed on disk.
      if (await fs.pathExists(pdfPath)) {
        result.status = "skipped";
        result.reason = "Already signed (existing PDF found)";
        emit(
          "info",
          `↷ SKIPPED - DUM ${dum.dumNumber} LTA N°${lta.ltaRef} already signed`,
          { outputPdf: pdfPath },
        );
        results.push(result);
        continue;
      }

      // CSV pre-check: DUM was signed in a previous session (CSV entry exists)
      // but PDF is missing → reprint directly, skip the sign flow entirely.
      const csvEntry = signedSeriesMap.get(dum.dumNumber);
      if (csvEntry) {
        emit(
          "info",
          `↷ CSV MATCH - DUM ${dum.dumNumber} LTA N°${lta.ltaRef}: already signed (${csvEntry.serie}${csvEntry.key}), reprinting directly...`,
          { serie: csvEntry.serie, key: csvEntry.key },
        );
        try {
          await conn.navigateToAccueil();
          await reprintBySerieRef(
            conn,
            {
              bureau: config.badr.bureauCode,
              regime: config.badr.regimeCode,
              year: config.badr.year,
              ...csvEntry,
            },
            pdfPath,
            emit,
          );
          result.status = "success";
          result.reason = "Reprinted from CSV (signed in previous session)";
          emit(
            "info",
            `✓ SUCCESS (reprint) - DUM ${dum.dumNumber} LTA N°${lta.ltaRef}`,
            { outputPdf: pdfPath },
          );
        } catch (reprintErr) {
          result.status = "failed";
          result.reason = `Reprint from CSV failed: ${reprintErr.message}`;
          emit(
            "error",
            `✗ FAILED (reprint) - DUM ${dum.dumNumber} LTA N°${lta.ltaRef}: ${reprintErr.message}`,
          );
        }
        results.push(result);
        continue;
      }

      try {
        const maxInternalErrorRetries = 3;
        let done = false;

        for (let attempt = 1; attempt <= maxInternalErrorRetries; attempt++) {
          try {
            emit(
              "info",
              `Processing DUM ${dum.dumNumber} for LTA ${lta.ltaRef}${attempt > 1 ? ` (retry ${attempt}/${maxInternalErrorRetries})` : ""}`,
            );

            emit("debug", "Navigating to BADR Accueil...");
            await conn.navigateToAccueil();
            emit("debug", "✓ At BADR Accueil");

            await ensureNoBadrInternalError(conn, emit, "dum flow start");
            await openModifyDeclaration(conn, emit);
            await fillDeclarationSearch(conn, dum, emit);

            const shipperCheck = await checkShipper(
              conn,
              shipperByFileName[lta.fileName] || "",
              emit,
            );
            if (!shipperCheck.ok) {
              throw new Error(
                `Shipper mismatch. expected='${shipperCheck.expected}' actual='${shipperCheck.actual}'`,
              );
            }

            const docsCheck = await checkRequiredDocuments(conn, emit);
            if (!docsCheck.ok) {
              throw new Error(
                "Required annexed documents not found (transport + facture)",
              );
            }

            const expectedLot = `${lta.ltaNumericRef}/${dum.dumNumber}`;
            const lotCheck = await checkPreapLot(conn, expectedLot, emit);
            if (!lotCheck.ok) {
              throw new Error(`Preapurement lot '${expectedLot}' not found`);
            }

            await clickSecondValidate(conn, emit);
            await signDeclaration(conn, emit);

            // ── Extract definitive reference and persist to CSV ──────────────
            try {
              const originalRef = `${dum.serie}${dum.key}`;
              let defRef = await extractDefinitiveRef(conn.page);

              // If the header still shows the original (pre-signing) series,
              // BADR may not have updated the reference yet — wait 2s and retry once.
              if (defRef && `${defRef.serie}${defRef.key}` === originalRef) {
                emit(
                  "debug",
                  `Definitive ref still matches original (${originalRef}) — re-reading in 2s…`,
                );
                await conn.page.waitForTimeout(2000);
                const recheck = await extractDefinitiveRef(conn.page);
                if (recheck) defRef = recheck;
              }

              if (defRef) {
                const defRefStr = `${defRef.serie}${defRef.key}`;
                const changed = defRefStr !== originalRef;
                if (changed) {
                  emit(
                    "info",
                    `Serie changed after signing: ${originalRef} → ${defRefStr}`,
                  );
                } else {
                  emit("debug", `Serie unchanged after signing: ${defRefStr}`);
                }

                await appendSignedSerieCsv(
                  csvPath,
                  dum.dumNumber,
                  defRef,
                  lta.ltaRef,
                );
                // Refresh in-memory map so later DUMs in the same run can fast-path.
                signedSeriesMap = await loadSignedSeriesCsv(csvPath);
                result.definitiveRef = defRefStr;
                emit(
                  "debug",
                  `✓ Definitive ref recorded: ${result.definitiveRef}`,
                  { csvPath },
                );
              } else {
                emit(
                  "warn",
                  "Could not extract definitive reference from header table",
                );
              }
            } catch (csvErr) {
              emit("warn", "Failed to record definitive ref in CSV", {
                error: csvErr.message,
              });
            }

            await printAndSave(conn, pdfPath, emit);

            const finalPdfCheck = await verifyPdfSaved(pdfPath);
            if (!finalPdfCheck.ok) {
              throw new Error(
                `PDF verification failed after print: ${finalPdfCheck.reason}`,
              );
            }

            result.status = "success";
            result.outputPdf = pdfPath;
            emit(
              "info",
              `✓ SUCCESS - DUM ${dum.dumNumber} LTA N°${lta.ltaRef}`,
              {
                outputPdf: pdfPath,
              },
            );
            done = true;
            break;
          } catch (attemptError) {
            // If the declaration is already signed, don't retry — propagate immediately.
            if (isAlreadySignedError(attemptError)) throw attemptError;

            const shouldRetry =
              (isBadrInternalError(attemptError) ||
                isFormNotReadyError(attemptError)) &&
              attempt < maxInternalErrorRetries;

            if (shouldRetry) {
              const reason = isFormNotReadyError(attemptError)
                ? "Form not ready (iframe not yet rendered)"
                : "BADR internal error";
              emit(
                "warn",
                `${reason} on DUM ${dum.dumNumber} — navigating to Accueil and retrying (attempt ${attempt}/${maxInternalErrorRetries})...`,
                { error: attemptError.message },
              );
              await recoverFromBadrInternalError(conn, emit);
              continue;
            }

            throw attemptError;
          }
        }

        if (!done && result.status !== "success") {
          throw new Error(
            `DUM ${dum.dumNumber} did not complete after retries`,
          );
        }
      } catch (error) {
        result.reason = error.message;

        if (isAlreadySignedError(error)) {
          result.status = "already_signed";
          result.reason = "Declaration already definitively registered on BADR";
          emit(
            "warn",
            `⚑ ALREADY SIGNED - DUM ${dum.dumNumber} LTA N°${lta.ltaRef} — will attempt recovery reprint`,
            { outputPdf: pdfPath },
          );
          results.push(result);
          continue;
        }

        if (isBadrInternalError(error)) {
          result.reason =
            "BADR internal error persisted after automatic refresh/retries";
          await recoverFromBadrInternalError(conn, emit).catch(() => null);
        }

        emit(
          "error",
          `✗ FAILED - DUM ${dum.dumNumber} LTA N°${lta.ltaRef}: ${error.message}`,
          {
            error: error.message,
          },
        );
      }

      results.push(result);
    }

    // ── Recovery reprint pass ──────────────────────────────────────────────
    // For DUMs marked "already_signed" (declaration was signed but PDF never
    // saved), try to reprint them using the signed_series.csv.
    const alreadySignedResults = results.filter(
      (r) => r.ltaRef === lta.ltaRef && r.status === "already_signed",
    );
    if (alreadySignedResults.length > 0) {
      // Reload CSV — may have new entries written during this run.
      const seriesMap = await loadSignedSeriesCsv(csvPath);

      emit(
        "info",
        `Recovery: attempting reprint for ${alreadySignedResults.length} already-signed DUM(s)...`,
        { csvPath },
      );

      for (const res of alreadySignedResults) {
        const pdfPath = res.outputPdf;
        if (await fs.pathExists(pdfPath)) {
          res.status = "skipped";
          res.reason = "Already signed — PDF found on disk";
          emit(
            "info",
            `↷ RECOVERY SKIPPED - DUM ${res.dumNumber}: PDF already exists`,
          );
          continue;
        }

        const refEntry = seriesMap.get(res.dumNumber);
        if (!refEntry) {
          emit(
            "warn",
            `Recovery: no signed serie found in CSV for DUM ${res.dumNumber} — cannot reprint`,
            { csvPath },
          );
          res.status = "failed";
          res.reason =
            "Already signed but no definitive serie in CSV — manual reprint needed";
          continue;
        }

        try {
          emit(
            "info",
            `Recovery: reprinting DUM ${res.dumNumber} via serie ${refEntry.serie}${refEntry.key}...`,
          );
          await conn.navigateToAccueil();
          await reprintBySerieRef(
            conn,
            {
              bureau: config.badr.bureauCode,
              regime: config.badr.regimeCode,
              year: config.badr.year,
              ...refEntry,
            },
            pdfPath,
            emit,
          );
          res.status = "success";
          res.reason = "Reprinted via recovery flow";
          emit(
            "info",
            `✓ RECOVERY SUCCESS - DUM ${res.dumNumber} LTA N°${lta.ltaRef}`,
            { outputPdf: pdfPath },
          );
        } catch (reprintErr) {
          res.status = "failed";
          res.reason = `Recovery reprint failed: ${reprintErr.message}`;
          emit(
            "error",
            `✗ RECOVERY FAILED - DUM ${res.dumNumber}: ${reprintErr.message}`,
          );
        }
      }
    }

    // ── Missing-PDF recovery ─────────────────────────────────────────────────
    // Any DUM still missing its PDF (regardless of prior status) that has a
    // CSV entry gets one more reprint attempt before we compute final status.
    {
      const ltaResultsSoFar = results.filter((r) => r.ltaRef === lta.ltaRef);
      const missingChecks = await Promise.all(
        ltaResultsSoFar.map(async (r) => ({
          r,
          missing:
            r.status !== "skipped" &&
            r.outputPdf &&
            !(await fs.pathExists(r.outputPdf)),
        })),
      );
      const stillMissing = missingChecks
        .filter((x) => x.missing)
        .map((x) => x.r);

      if (stillMissing.length > 0) {
        const seriesMap = await loadSignedSeriesCsv(csvPath);
        emit(
          "info",
          `Missing-PDF recovery: ${stillMissing.length} DUM(s) still need PDFs...`,
        );
        for (const res of stillMissing) {
          const refEntry = seriesMap.get(res.dumNumber);
          if (!refEntry) {
            emit(
              "warn",
              `Missing-PDF recovery: no CSV entry for DUM ${res.dumNumber} — cannot reprint`,
              { csvPath },
            );
            continue;
          }
          try {
            emit(
              "info",
              `Missing-PDF recovery: reprinting DUM ${res.dumNumber} (${refEntry.serie}${refEntry.key})...`,
            );
            await conn.navigateToAccueil();
            await reprintBySerieRef(
              conn,
              {
                bureau: config.badr.bureauCode,
                regime: config.badr.regimeCode,
                year: config.badr.year,
                ...refEntry,
              },
              res.outputPdf,
              emit,
            );
            res.status = "success";
            res.reason = "Reprinted via missing-PDF recovery";
            emit(
              "info",
              `✓ MISSING-PDF RECOVERY SUCCESS - DUM ${res.dumNumber} LTA N°${lta.ltaRef}`,
              { outputPdf: res.outputPdf },
            );
          } catch (err) {
            emit(
              "error",
              `✗ MISSING-PDF RECOVERY FAILED - DUM ${res.dumNumber}: ${err.message}`,
            );
          }
        }
      }
    }

    const ltaResults = results.filter((r) => r.ltaRef === lta.ltaRef);
    const ltaSuccess = ltaResults.filter((r) => r.status === "success").length;
    const ltaSkipped = ltaResults.filter((r) => r.status === "skipped").length;
    const ltaFailed = ltaResults.filter((r) => r.status === "failed").length;
    const expectedPdfCount = lta.dums.length;
    const existingChecks = await Promise.all(
      lta.dums.map((d) =>
        fs.pathExists(
          path.join(ltaFolder, `DUM ${d.dumNumber} LTA N°${lta.ltaRef}.pdf`),
        ),
      ),
    );
    const existingPdfCount = existingChecks.filter(Boolean).length;
    const allPdfsExist = existingPdfCount === expectedPdfCount;

    emit(
      "info",
      `Completed LTA ${lta.ltaRef} (success=${ltaSuccess}, skipped=${ltaSkipped}, failed=${ltaFailed}, pdfs=${existingPdfCount}/${expectedPdfCount})`,
    );

    const isReady = allPdfsExist && ltaFailed === 0;
    const targetFolder = isReady ? readyLtaFolder : problemLtaFolder;

    if (ltaFolder !== targetFolder) {
      if (!(await fs.pathExists(targetFolder))) {
        await fs.move(ltaFolder, targetFolder);
        for (const r of ltaResults) {
          if (r.outputPdf) {
            r.outputPdf = r.outputPdf.replace(ltaFolder, targetFolder);
          }
        }
        emit(
          isReady ? "info" : "warn",
          isReady
            ? `✓ LTA folder marked READY: ${path.basename(targetFolder)}`
            : `⚠ LTA folder marked PROBLEM: ${path.basename(targetFolder)}`,
        );
      } else {
        emit(
          "warn",
          `Target state folder already exists, keeping current folder: ${path.basename(targetFolder)}`,
        );
      }
    } else {
      emit(
        isReady ? "info" : "warn",
        isReady
          ? `✓ LTA remains READY: ${path.basename(targetFolder)}`
          : `⚠ LTA remains PROBLEM: ${path.basename(targetFolder)}`,
      );
    }
  }

  return results;
};
