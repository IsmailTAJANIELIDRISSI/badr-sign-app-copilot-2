import path from "path";
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

const normalizeLotRef = (value) => {
  const match = String(value ?? "").match(/([0-9.\-\s]+)\s*\/\s*(\d+)/);
  if (!match) return "";

  const leftDigits = match[1].replace(/[^\d]/g, "");
  const left = leftDigits.replace(/^0+(?=\d)/, "") || "0";
  const right = match[2].replace(/^0+(?=\d)/, "") || "0";
  return `${left}/${right}`;
};

const extractLotRefs = (text) => {
  const source = String(text ?? "");
  const hits = source.match(/[0-9.\-\s]{3,}\s*\/\s*\d+/g) || [];
  const normalized = new Set();
  for (const hit of hits) {
    const lot = normalizeLotRef(hit);
    if (lot) normalized.add(lot);
  }
  return [...normalized];
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

const LOADING_SELECTORS = [
  "#j_id_9:has-text('Traitement en cours')",
  "div.ui-blockui-content:has-text('Traitement en cours')",
  "div:has-text('Traitement en cours')",
];

const PRINT_DOWNLOAD_TIMEOUT_MS = 60000;
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
  // Prefer loader lifecycle if present; otherwise fall back to IMPRIMER readiness polling.
  const maxWaitMs = Math.min(config.timeout, 45000);
  const start = Date.now();

  let sawLoading = false;
  const detectWindowMs = 4000;
  while (Date.now() - start < detectWindowMs) {
    await ensureNoBadrInternalError(conn, onLog, "signing wait bootstrap");

    const loading = await firstVisible(page, LOADING_SELECTORS, 120);
    if (loading) {
      sawLoading = true;
      onLog("debug", "Signing loader detected (Traitement en cours)...");
      break;
    }
    await page.waitForTimeout(200);
  }

  if (sawLoading) {
    // Wait until loader disappears first.
    const loadingHit = await firstVisible(page, LOADING_SELECTORS, 120);
    if (loadingHit) {
      await loadingHit.loc
        .waitFor({ state: "hidden", timeout: maxWaitMs })
        .catch(() => {});
      onLog("debug", "✓ Signing loader hidden");
    }
  }

  // Require IMPRIMER to be stable for 2 checks to avoid stale/early visibility.
  let stableVisibleCount = 0;
  while (Date.now() - start < maxWaitMs) {
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
    `⚠ Signing readiness wait exceeded ${Math.round(maxWaitMs / 1000)}s; continuing to IMPRIMER retries`,
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
  onLog("debug", "✓ Valider clicked - waiting for page load...");

  // CRITICAL: Wait for the iframe/main content to load
  // The declaration form loads inside an iframe or main tab area
  try {
    await page.waitForNavigation({ timeout: 3000 }).catch(() => {});
  } catch (e) {
    // Navigation might not happen, that's okay - just wait a bit more
  }

  await page.waitForTimeout(2500);
  await ensureNoBadrInternalError(conn, onLog, "fill declaration search done");
  onLog("debug", "✓ Declaration page loaded");
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
  const ok = isShipperEquivalent(expectedShipper, actual);

  if (ok) {
    const strictEqual =
      toUpperCompact(actual) === toUpperCompact(expectedShipper);
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
    `✗ Shipper mismatch - expected: '${expectedShipper}' actual: '${actual}'. Updating BADR field...`,
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
  await hit.loc.fill(expectedShipper);
  await conn.page.waitForTimeout(300);

  const after = await hit.loc.inputValue().catch(() => "");
  const updatedOk = isShipperEquivalent(expectedShipper, after);

  if (updatedOk) {
    onLog("info", "✓ BADR shipper field updated to expected value");
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
    `✗ Could not update BADR shipper field. expected='${expectedShipper}' after='${after}'`,
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
  const body = await textInTable(
    page,
    "#mainTab\\:form7\\:listeDocumentsAnnexes_data",
  );

  const hasTransport = body.includes("TRANSPORT");
  const hasFacture = body.includes("FACTURE");
  const hasAll = hasTransport && hasFacture;

  onLog(
    hasAll ? "debug" : "error",
    `✓ Documents found: ${hasTransport ? "✓TRANSPORT " : "✗TRANSPORT "}${hasFacture ? "✓FACTURE" : "✗FACTURE"}`,
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

  const expectedNormalized = normalizeLotRef(expectedLot);
  const [leftPart = "", rightPart = ""] = String(expectedLot).split("/");
  const leftNoZeros = String(leftPart).replace(/^0+(?=\d)/, "") || "0";
  const rightNoZeros = String(rightPart).replace(/^0+(?=\d)/, "") || "0";
  const expectedVariants = new Set([
    toUpperCompact(expectedLot),
    toUpperCompact(`${leftNoZeros}/${rightPart}`),
    toUpperCompact(`${leftPart}/${rightNoZeros}`),
    toUpperCompact(`${leftNoZeros}/${rightNoZeros}`),
    toUpperCompact(expectedNormalized),
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

    if (variantMatched || normalizedMatched) {
      onLog(
        "debug",
        `✓ Found preapurement lot: ${expectedLot} (normalized=${expectedNormalized})`,
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

  const preapCountText = await page
    .locator("td:has-text('Nombre total des préapurements')")
    .first()
    .innerText()
    .catch(() => "");
  const preapCountMatch = String(preapCountText).match(/(\d+)/);
  const totalPreap = preapCountMatch ? Number(preapCountMatch[1]) : 0;

  const sameDumSuffix = String(expectedNormalized).split("/")[1] || "";
  const suffixMatched = lotRefs.some((lot) =>
    lot.endsWith(`/${sameDumSuffix}`),
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

const printAndSave = async (conn, targetPath, onLog) => {
  const page = conn.page;
  await fs.ensureDir(path.dirname(targetPath));

  await ensureNoBadrInternalError(conn, onLog, "print start");

  onLog("debug", "Waiting for IMPRIMER button to be clickable...");

  // Extra wait to ensure button is fully rendered and responsive
  await page.waitForTimeout(1200);

  let lastError = "";

  for (let attempt = 1; attempt <= PRINT_ATTEMPTS; attempt++) {
    await ensureNoBadrInternalError(conn, onLog, `print attempt ${attempt}`);

    // Start waiting for the download before clicking IMPRIMER.
    const downloadPromise = page
      .waitForEvent("download", {
        timeout: Math.min(config.timeout, PRINT_DOWNLOAD_TIMEOUT_MS),
      })
      .catch(() => null);

    onLog(
      "debug",
      `Attempting to click IMPRIMER (attempt ${attempt}/${PRINT_ATTEMPTS})...`,
    );

    const imprimerClicked = await clickFirst(page, IMPRIMER_SELECTORS);
    if (!imprimerClicked) {
      lastError = "Could not click IMPRIMER";
      onLog("warn", `${lastError} on attempt ${attempt}`);
      await page.waitForTimeout(1000);
      continue;
    }

    onLog("debug", "✓ IMPRIMER clicked");
    onLog("debug", "Waiting for PDF download...");

    const download = await downloadPromise;
    if (!download) {
      lastError = "No PDF download event captured after IMPRIMER";
      onLog("warn", `${lastError} (attempt ${attempt})`);
      await page.waitForTimeout(1200);
      continue;
    }

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

  throw new Error(
    `Print failed after ${PRINT_ATTEMPTS} attempts: ${lastError || "unknown print error"}`,
  );
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
            if (
              isBadrInternalError(attemptError) &&
              attempt < maxInternalErrorRetries
            ) {
              emit(
                "warn",
                `BADR internal error on DUM ${dum.dumNumber}. Recovering and retrying...`,
                {
                  attempt,
                  maxAttempts: maxInternalErrorRetries,
                  error: attemptError.message,
                },
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
