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

const waitForBusyOverlay = async (page) => {
  const loading = page.locator("div:has-text('Traitement en cours')").first();
  if (await loading.isVisible().catch(() => false)) {
    await loading
      .waitFor({ state: "hidden", timeout: config.timeout })
      .catch(() => {});
  }
};

const openModifyDeclaration = async (conn) => {
  const page = conn.page;

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

  const clicked = await clickFirst(page, [
    "a#_2008",
    "a[title*='cf2008']",
    "a.ui-menuitem-link:has-text('Modifier une déclaration')",
    "span.ui-menuitem-text:has-text('Modifier une déclaration')",
  ]);

  if (!clicked) {
    throw new Error("Could not open 'Modifier une déclaration'");
  }

  await page.waitForTimeout(1200);
};

const fillDeclarationSearch = async (conn, dum) => {
  const page = conn.page;

  const okBureau = await fillFirst(
    page,
    ["#rootForm\\:_bureauId", "input[id$=':_bureauId']"],
    config.badr.bureauCode,
  );
  const okRegime = await fillFirst(
    page,
    ["#rootForm\\:_regimeId", "input[id$=':_regimeId']"],
    config.badr.regimeCode,
  );
  const okYear = await fillFirst(
    page,
    ["#rootForm\\:_anneeId", "input[id$=':_anneeId']"],
    config.badr.year,
  );
  const okSerie = await fillFirst(
    page,
    ["#rootForm\\:_serieId", "input[id$=':_serieId']"],
    dum.serie,
  );
  const okKey = await fillFirst(
    page,
    ["#rootForm\\:_cleId", "input[id$=':_cleId']"],
    dum.key,
  );

  if (![okBureau, okRegime, okYear, okSerie, okKey].every(Boolean)) {
    throw new Error("Could not fill declaration search form");
  }

  const clicked = await clickFirst(page, [
    "#rootForm\\:btnConfirmer",
    "button[id$=':btnConfirmer']",
    "button:has-text('Valider')",
  ]);
  if (!clicked) {
    throw new Error("Could not click first validation button");
  }

  await page.waitForTimeout(1800);
};

const checkShipper = async (conn, expectedShipper) => {
  if (!normalize(expectedShipper)) {
    return { ok: true, actual: "", expected: "" };
  }

  const page = conn.page;
  const hit = await firstVisible(page, [
    "#mainTab\\:form0\\:nomOperateurExpediteur",
    "input[id$=':nomOperateurExpediteur']",
  ]);
  if (!hit) {
    return { ok: false, actual: "", expected: expectedShipper };
  }

  const actual = await hit.loc.inputValue();
  const ok = toUpperCompact(actual) === toUpperCompact(expectedShipper);
  return { ok, actual, expected: expectedShipper };
};

const checkRequiredDocuments = async (conn) => {
  const page = conn.page;

  await clickFirst(page, [
    "a[href='#mainTab:tab7']",
    "li[role='tab'] a:has-text('Documents')",
  ]);
  await page.waitForTimeout(1000);

  const body = await textInTable(
    page,
    "#mainTab\\:form7\\:listeDocumentsAnnexes_data",
  );
  const hasAll = REQUIRED_DOC_HINTS.every((hint) => body.includes(hint));
  return { ok: hasAll, body };
};

const checkPreapLot = async (conn, expectedLot) => {
  const page = conn.page;

  await clickFirst(page, [
    "a[href='#mainTab:tab3']",
    "li[role='tab'] a:has-text('Preapurement DS')",
    "li[role='tab'] a:has-text('Apurement DS')",
  ]);
  await page.waitForTimeout(1000);

  const body = await textInTable(page, "#mainTab\\:form3\\:table_preap_data");
  return { ok: body.includes(toUpperCompact(expectedLot)), body };
};

const clickSecondValidate = async (conn) => {
  const page = conn.page;
  const clicked = await clickFirst(page, [
    "#secure__2003",
    "a[id*='2003']:has-text('VALIDER')",
    "a.ui-menuitem-link:has-text('VALIDER')",
  ]);

  if (!clicked) {
    throw new Error("Could not click declaration VALIDER action");
  }

  await page.waitForTimeout(1500);

  const errorMessage = await firstVisible(page, [
    ".ui-messages-error",
    ".ui-message-error",
    "#msg-error .ui-messages-error",
  ]);

  if (errorMessage) {
    throw new Error("Validation returned an error message");
  }
};

const signDeclaration = async (conn) => {
  const page = conn.page;

  const signClicked = await clickFirst(page, [
    "#secure_2018",
    "a[id*='2018']:has-text('SIGNER')",
    "a.ui-menuitem-link:has-text('SIGNER')",
  ]);
  if (!signClicked) {
    throw new Error("Could not click SIGNER");
  }

  await page.waitForTimeout(600);

  const yesClicked = await clickFirst(page, [
    "#j_id_47_1\\:j_id_47_5",
    "button.ui-confirmdialog-yes",
    "button:has-text('Oui')",
  ]);
  if (!yesClicked) {
    throw new Error("Could not confirm SIGNER dialog");
  }

  await waitForBusyOverlay(page);
  await page.waitForTimeout(1800);
};

const printAndSave = async (conn, targetPath) => {
  const page = conn.page;
  await fs.ensureDir(path.dirname(targetPath));

  const downloadPromise = page.waitForEvent("download", {
    timeout: config.timeout,
  });

  const clicked = await clickFirst(page, [
    "#secure_imprimer",
    "a.ui-menuitem-link:has-text('IMPRIMER')",
    "span.ui-menuitem-text:has-text('IMPRIMER')",
  ]);

  if (!clicked) {
    throw new Error("Could not click IMPRIMER");
  }

  const download = await downloadPromise;
  await download.saveAs(targetPath);
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
    const ltaFolder = path.join(
      config.directories.outputs,
      `LTA N° ${lta.ltaRef}`,
    );
    await fs.ensureDir(ltaFolder);

    onLog("info", `Processing LTA ${lta.ltaRef}`, {
      ltaFile: lta.fileName,
      dumsCount: lta.dums.length,
    });

    for (const dum of lta.dums) {
      const result = {
        ltaRef: lta.ltaRef,
        fileName: lta.fileName,
        dumNumber: dum.dumNumber,
        rawSerie: dum.rawSerie,
        status: "failed",
        reason: "",
        outputPdf: "",
      };

      try {
        await conn.navigateToAccueil();
        await openModifyDeclaration(conn);
        await fillDeclarationSearch(conn, dum);

        const shipperCheck = await checkShipper(
          conn,
          shipperByFileName[lta.fileName] || "",
        );
        if (!shipperCheck.ok) {
          throw new Error(
            `Shipper mismatch. expected='${shipperCheck.expected}' actual='${shipperCheck.actual}'`,
          );
        }

        const docsCheck = await checkRequiredDocuments(conn);
        if (!docsCheck.ok) {
          throw new Error(
            "Required annexed documents not found (transport + facture)",
          );
        }

        const expectedLot = `${lta.ltaNumericRef}/${dum.dumNumber}`;
        const lotCheck = await checkPreapLot(conn, expectedLot);
        if (!lotCheck.ok) {
          throw new Error(`Preapurement lot '${expectedLot}' not found`);
        }

        await clickSecondValidate(conn);
        await signDeclaration(conn);

        const pdfName = `DUM ${dum.dumNumber} LTA N°${lta.ltaRef}.pdf`;
        const pdfPath = path.join(ltaFolder, pdfName);
        await printAndSave(conn, pdfPath);

        result.status = "success";
        result.outputPdf = pdfPath;
        onLog("info", `Signed DUM ${dum.dumNumber} for ${lta.ltaRef}`, {
          outputPdf: pdfPath,
        });
      } catch (error) {
        result.reason = error.message;
        onLog(
          "error",
          `DUM ${dum.dumNumber} LTA N°${lta.ltaRef} not ready to be signed`,
          {
            error: error.message,
          },
        );
      }

      results.push(result);
    }
  }

  return results;
};
