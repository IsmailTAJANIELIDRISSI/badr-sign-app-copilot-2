import path from "path";
import fs from "fs-extra";
import { config } from "./config.js";
import { BADRConnection } from "./badrConnection.js";

const REQUIRED_DOC_HINTS = ["TRANSPORT", "FACTURE"];

const normalize = (value) => String(value ?? "").trim();

const toUpperCompact = (value) =>
  normalize(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .toUpperCase();

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
  const hit = await firstVisible(page, [tableSelector]);
  if (!hit) return "";
  return toUpperCompact(await hit.loc.innerText());
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

const waitForSigningReady = async (page, onLog) => {
  // Prefer loader lifecycle if present; otherwise fall back to IMPRIMER readiness polling.
  const maxWaitMs = Math.min(config.timeout, 45000);
  const start = Date.now();

  let sawLoading = false;
  const detectWindowMs = 4000;
  while (Date.now() - start < detectWindowMs) {
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
};

const fillDeclarationSearch = async (conn, dum, onLog) => {
  const page = conn.page;

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
  onLog("debug", "✓ Declaration page loaded");
};

const checkShipper = async (conn, expectedShipper, onLog) => {
  onLog("debug", "Checking shipper name...", { expected: expectedShipper });

  if (!normalize(expectedShipper)) {
    onLog("debug", "✓ No shipper to validate (empty expected value)");
    return { ok: true, actual: "", expected: "" };
  }

  const page = conn.page;
  const hit = await firstVisible(page, [
    "#mainTab\\:form0\\:nomOperateurExpediteur",
    "input[id$=':nomOperateurExpediteur']",
  ]);
  if (!hit) {
    onLog("warn", "✗ Could not find shipper field on page");
    return { ok: false, actual: "", expected: expectedShipper };
  }

  const actual = await hit.loc.inputValue();
  const ok = toUpperCompact(actual) === toUpperCompact(expectedShipper);

  if (ok) {
    onLog("debug", "✓ Shipper matches: " + actual);
  } else {
    onLog(
      "error",
      `✗ Shipper mismatch - expected: '${expectedShipper}' actual: '${actual}'`,
    );
  }

  return { ok, actual, expected: expectedShipper };
};

const checkRequiredDocuments = async (conn, onLog) => {
  const page = conn.page;

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

  return { ok: hasAll, body };
};

const checkPreapLot = async (conn, expectedLot, onLog) => {
  const page = conn.page;

  onLog("debug", "Navigating to Preapurement DS tab...");
  await clickFirst(page, [
    "a[href='#mainTab:tab3']",
    "li[role='tab'] a:has-text('Preapurement DS')",
    "li[role='tab'] a:has-text('Apurement DS')",
  ]);
  await page.waitForTimeout(1000);
  onLog("debug", "✓ Preapurement tab opened");

  onLog("debug", "Checking for preapurement lot...", { expected: expectedLot });
  const body = await textInTable(page, "#mainTab\\:form3\\:table_preap_data");
  const found = body.includes(toUpperCompact(expectedLot));

  if (found) {
    onLog("debug", "✓ Found preapurement lot: " + expectedLot);
  } else {
    onLog("error", `✗ Preapurement lot not found: ${expectedLot}`);
  }

  return { ok: found, body };
};

const clickSecondValidate = async (conn, onLog) => {
  const page = conn.page;

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

  onLog("debug", "✓ Validation successful");
};

const signDeclaration = async (conn, onLog) => {
  const page = conn.page;

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
  await waitForSigningReady(page, onLog);

  // Extra wait to ensure page is fully stable
  await page.waitForTimeout(600);
  onLog("debug", "✓ Page stabilized");
};

const printAndSave = async (conn, targetPath, onLog) => {
  const page = conn.page;
  await fs.ensureDir(path.dirname(targetPath));

  // Start waiting for the download before clicking IMPRIMER to avoid missing the event.
  const downloadPromise = page.waitForEvent("download", {
    timeout: config.timeout,
  });

  onLog("debug", "Waiting for IMPRIMER button to be clickable...");

  // Extra wait to ensure button is fully rendered and responsive
  await page.waitForTimeout(1500);

  // Try to find and click IMPRIMER button with multiple attempts
  let imprimerClicked = false;
  let retries = 0;
  const maxRetries = 3;

  while (!imprimerClicked && retries < maxRetries) {
    try {
      onLog(
        "debug",
        `Attempting to click IMPRIMER (attempt ${retries + 1}/${maxRetries})...`,
      );

      imprimerClicked = await clickFirst(page, IMPRIMER_SELECTORS);

      if (imprimerClicked) {
        onLog("debug", "✓ IMPRIMER clicked");
        break;
      }

      retries++;
      if (retries < maxRetries) {
        onLog("debug", `IMPRIMER not found, waiting 1s before retry...`);
        await page.waitForTimeout(1000);
      }
    } catch (e) {
      retries++;
      await page.waitForTimeout(1000);
    }
  }

  if (!imprimerClicked) {
    throw new Error("Could not click IMPRIMER button after 3 attempts");
  }

  onLog("debug", "Waiting for PDF download...");
  const download = await downloadPromise;
  await download.saveAs(targetPath);
  onLog("info", "✓ PDF SAVED", {
    filename: path.basename(targetPath),
    fullPath: targetPath,
  });
};

export const runSigningJob = async ({
  parsedLtas,
  shipperByFileName,
  onLog,
  onShipperAutofix,
}) => {
  const conn = new BADRConnection();
  await conn.connect();

  const results = [];

  for (const lta of parsedLtas) {
    const ltaFolder = path.join(
      config.directories.signedLtas,
      `LTA N° ${lta.ltaRef}`,
    );
    await fs.ensureDir(ltaFolder);

    onLog("info", `Processing LTA ${lta.ltaRef}`, {
      ltaFile: lta.fileName,
      dumsCount: lta.dums.length,
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

      // Resume mode: skip DUMs that are already signed on disk.
      if (await fs.pathExists(pdfPath)) {
        result.status = "skipped";
        result.reason = "Already signed (existing PDF found)";
        onLog(
          "info",
          `↷ SKIPPED - DUM ${dum.dumNumber} LTA N°${lta.ltaRef} already signed`,
          { outputPdf: pdfPath },
        );
        results.push(result);
        continue;
      }

      try {
        onLog("info", `Processing DUM ${dum.dumNumber} for LTA ${lta.ltaRef}`);

        onLog("debug", "Navigating to BADR Accueil...");
        await conn.navigateToAccueil();
        onLog("debug", "✓ At BADR Accueil");

        await openModifyDeclaration(conn, onLog);
        await fillDeclarationSearch(conn, dum, onLog);

        const shipperCheck = await checkShipper(
          conn,
          shipperByFileName[lta.fileName] || "",
          onLog,
        );
        if (!shipperCheck.ok) {
          if (shipperCheck.actual) {
            onLog(
              "warn",
              `Shipper mismatch detected. Updating expected shipper to '${shipperCheck.actual}' and continuing...`,
            );

            if (typeof onShipperAutofix === "function") {
              await onShipperAutofix({
                fileName: lta.fileName,
                ltaRef: lta.ltaRef,
                shipperName: shipperCheck.actual,
              });
            }

            shipperByFileName[lta.fileName] = shipperCheck.actual;
            onLog(
              "info",
              "✓ Expected shipper auto-corrected from BADR declaration",
            );
          } else {
            throw new Error(
              `Shipper mismatch. expected='${shipperCheck.expected}' actual='${shipperCheck.actual}'`,
            );
          }
        }

        const docsCheck = await checkRequiredDocuments(conn, onLog);
        if (!docsCheck.ok) {
          throw new Error(
            "Required annexed documents not found (transport + facture)",
          );
        }

        const expectedLot = `${lta.ltaNumericRef}/${dum.dumNumber}`;
        const lotCheck = await checkPreapLot(conn, expectedLot, onLog);
        if (!lotCheck.ok) {
          throw new Error(`Preapurement lot '${expectedLot}' not found`);
        }

        await clickSecondValidate(conn, onLog);
        await signDeclaration(conn, onLog);

        await printAndSave(conn, pdfPath, onLog);

        result.status = "success";
        result.outputPdf = pdfPath;
        onLog("info", `✓ SUCCESS - DUM ${dum.dumNumber} LTA N°${lta.ltaRef}`, {
          outputPdf: pdfPath,
        });
      } catch (error) {
        result.reason = error.message;
        onLog(
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
    onLog(
      "info",
      `Completed LTA ${lta.ltaRef} (success=${ltaSuccess}, skipped=${ltaSkipped}, failed=${ltaFailed})`,
    );
  }

  return results;
};
