# ── BADR ──────────────────────────────────────────────────────────────────────

BADR_URL=https://badr.douane.gov.ma:40444/badr/Login
BADR_USERNAME=your_badr_username
BADR_PASSWORD=Med@2026

# Path to your Edge executable (with USB certificate profile)

EDGE_PATH=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe

# CDP remote debugging port (any free port)

BADR_CDP_PORT=9222

# Dedicated Edge user data dir (keeps certificate loaded)

BADR_PROFILE_DIR=C:\Temp\badr-edge-profile

# Bureau and operateur codes (defaults match CASA/NOUASSER-FRET + RAM)

BADR_BUREAU_CODE=301
BADR_BUREAU_LABEL=CASA/NOUASSER-FRET(301)(301)
BADR_OPERATEUR_CODE=1063
BADR_OPERATEUR_LABEL=CIE NATIONALE ROYAL AIR MAROC(81/9667)

# ── PORTNET ───────────────────────────────────────────────────────────────────

PORTNET_USERNAME=GN41473
PORTNET_PASSWORD=830@6@M4yX4@

# ── EMAIL NOTIFICATIONS ───────────────────────────────────────────────────────

EMAIL_ENABLED=false
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your_email@gmail.com
EMAIL_PASS=your_app_password
EMAIL_FROM=automation@yourcompany.com
EMAIL_TO=recipient@yourcompany.com

# ── GENERAL ───────────────────────────────────────────────────────────────────

HEADLESS=false
SLOW_MO=50
TIMEOUT=120000
LOGS_DIR=logs

---

this stack :

modern, smooth, simple UI, packaged as a desktop .exe, running Playwright automation, with inputs + logs. Here’s the stack I would use:

1️⃣ Frontend / Desktop UI

✅ Electron + React (or Solid / Vue)

Electron: Wraps a web app as a desktop app (.exe)

React: Modern, flexible UI (you already know it)

TailwindCSS: Smooth, simple, professional design

Optional: Flowbite / Radix UI for components

Why this combo?

Familiar to web devs → fast to build

Can do forms, inputs, buttons easily

Can display logs in real-time (<pre> or console panel)

Works on Windows/macOS/Linux if needed

2️⃣ Backend / Automation Layer

✅ Node.js + Playwright

Playwright handles browser automation (React apps, dynamic forms, file uploads)

Node.js runs in the same Electron app → seamless integration

Can capture logs and send to frontend in real-time

Example structure:

/src
/ui -> React + Tailwind UI
/automation -> Playwright scripts
/logs -> Logging system

Electron can expose Node APIs to your React UI so when an employee clicks “Run”, Playwright runs and logs are streamed to a UI panel.

3️⃣ Logs / Real-Time Feedback

Use Node.js streams or EventEmitters to push Playwright logs to the UI

Display in a scrollable panel in React (<pre> or <code> block)

Optionally color-code errors vs info for clarity

4️⃣ Packaging as .exe

Use Electron-builder

Packages the app + Node.js + Playwright + Chromium browser

You can produce a single .exe installer

No need for employees to install Node / browsers separately

5️⃣ Extras to Make It Modern / Smooth

Dark/light theme toggle

Form validation / input masks (React Hook Form + Tailwind)

Progress indicators while Playwright runs

Buttons disabled during automation

Optional: Simple dashboards for stats (number of runs, errors)

⚡ Why This Stack is Perfect
Requirement Stack Choice Reason
Modern smooth UI/UX React + Tailwind Clean, responsive, familiar
Packaged as .exe Electron + electron-builder Cross-platform, standalone
Automation Node.js + Playwright Reliable, SPA-friendly, supports file uploads
Logs & feedback React UI + Node EventEmitters Real-time streaming, simple
Easy maintenance JS stack end-to-end Same language for UI & automation

---


"use strict";
/**
 * BADRConnection – launches Edge with remote debugging via child_process,
 * then connects Playwright over CDP.
 *
 * Mirrors the Python BADRConnection class from the original reference code
 * but uses Playwright's chromium.connectOverCDP instead of Selenium.
 */

const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const config = require("../config/config");
const { createLogger } = require("../utils/logger");

const log = createLogger("BADRConnection");

class BADRConnection {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.edgeProcess = null;
  }

  /**
   * Spawn a fresh Edge instance with remote debugging enabled.
   * Mirrors Python's start_fresh_edge().
   */
  async startFreshEdge() {
    const { edgePath, debuggingPort, userDataDir } = config.badr;

    // Ensure profile dir exists
    if (!fs.existsSync(userDataDir)) {
      fs.mkdirSync(userDataDir, { recursive: true });
      log.info(`Created Edge profile dir: ${userDataDir}`);
    }

    log.info(`Launching Edge on port ${debuggingPort}...`);

    this.edgeProcess = spawn(
      edgePath,
      [
        `--remote-debugging-port=${debuggingPort}`,
        `--user-data-dir=${userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
      ],
      { detached: false, stdio: "ignore" },
    );

    this.edgeProcess.on("error", (err) => {
      log.error("Edge process error", { message: err.message });
    });

    // Give Edge time to start and expose CDP endpoint
    log.info("Waiting for Edge to start (4s)…");
    await new Promise((r) => setTimeout(r, 4000));
    log.info("Edge started");
  }

  /**
   * Connect Playwright to the running Edge instance via CDP.
   * Mirrors Python's connect_to_edge().
   */
  async connectToEdge() {
    const { debuggingPort } = config.badr;
    const cdpUrl = `http://localhost:${debuggingPort}`;
    log.info(`Connecting Playwright via CDP → ${cdpUrl}`);

    this.browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = this.browser.contexts();
    this.context = contexts.length
      ? contexts[0]
      : await this.browser.newContext();

    const pages = this.context.pages();
    this.page = pages.length ? pages[0] : await this.context.newPage();

    this.page.setDefaultTimeout(config.timeout);
    log.info("Playwright connected to Edge");
  }

  /**
   * Navigate to BADR and log in.
   * Mirrors Python's navigate_and_login() exactly:
   *  1. Navigate → wait for password field
   *  2. Fill & verify password (retry if mismatch)
   *  3. Click Connexion
   *  4. Wait 5s → handle active-session popup if present
   */
  async navigateAndLogin() {
    const { url, password } = config.badr;
    // NOTE: BADR authenticates via USB certificate – no username field exists.
    log.info(`Navigating to BADR: ${url}`);
    await this.page.goto(url, { waitUntil: "domcontentloaded" });

    // Wait for password field to be present (same as Python's wait.until)
    log.info("Waiting for password field…");
    await this.page.waitForSelector("#connexionForm\\:pwdConnexionId", {
      timeout: config.timeout,
    });

    // Fill password and verify value (mirrors Python's check + retry logic)
    log.info("Filling BADR password…");
    await this._fillAndVerify("#connexionForm\\:pwdConnexionId", password);

    await this.page.waitForTimeout(1000);

    // Click Connexion button
    log.info("Clicking Connexion…");
    await this.page.waitForSelector("#connexionForm\\:login", {
      state: "visible",
      timeout: config.timeout,
    });
    await this.page.click("#connexionForm\\:login");
    log.info("Connexion clicked – waiting for redirect…");

    // Wait 5s for page load (mirrors Python's time.sleep(5))
    await this.page.waitForTimeout(5000);

    // Handle active-session popup (appears AFTER clicking login, like Python does)
    try {
      const sessionLink = await this.page.$(
        "#connexionForm\\:sessionConnexionId",
      );
      if (sessionLink) {
        log.warn(
          "Active session detected – clicking to deactivate old session…",
        );
        await sessionLink.click();
        await this.page.waitForTimeout(5000);
        log.info("Old session deactivated – redirected to home");
      } else {
        log.info("No active session – direct login succeeded");
      }
    } catch (e) {
      log.warn("Session check error (non-critical)", { message: e.message });
    }

    log.info("BADR login successful");
  }

  /**
   * Fill an input and verify the value was accepted.
   * Clears and retries once if the value doesn't match (mirrors Python).
   */
  async _fillAndVerify(selector, value) {
    const field = this.page.locator(selector);

    const current = await field.inputValue();
    if (current === value) {
      log.info(`Field ${selector} already has correct value`);
      return;
    }
    if (current) {
      log.warn(`Field has stale value (len=${current.length}) – clearing…`);
      await field.clear();
      await this.page.waitForTimeout(500);
    }

    await field.fill(value);

    // Verify
    const filled = await field.inputValue();
    if (filled !== value) {
      log.warn(
        `Value mismatch (got len=${filled.length}, expected len=${value.length}) – retrying…`,
      );
      await field.clear();
      await this.page.waitForTimeout(500);
      await field.fill(value);
      log.info("Retry fill applied");
    }
  }

  /**
   * Full bootstrap: launch Edge → connect CDP → login.
   */
  async connect() {
    if (this.page && !this.page.isClosed()) {
      log.info("Reusing existing BADR page/session");
      return;
    }

    try {
      await this.connectToEdge();
      await this.navigateAndLogin();
      log.info("Connected to existing Edge CDP session");
      return;
    } catch (existingErr) {
      log.warn("No reusable Edge session found – launching fresh Edge", {
        message: existingErr.message,
      });
    }

    await this.startFreshEdge();
    await this.connectToEdge();
    await this.navigateAndLogin();
  }

  /**
   * Reconnect without relaunching Edge (CDP already running).
   */
  async reconnect() {
    if (this.page && !this.page.isClosed()) {
      log.info("BADR reconnect skipped: existing page is active");
      return;
    }

    await this.connectToEdge();
    await this.navigateAndLogin();
  }

  /**
   * Navigate to BADR Accueil and wait for page to stabilize.
   * Resets the DOM context to a known state before starting new operations.
   */
  async navigateToAccueil() {
    if (!this.page || this.page.isClosed()) {
      log.warn("BADR page is closed – cannot navigate to Accueil");
      return;
    }

    // First, close any open popups from previous operations
    const allPages = this.context.pages();
    for (const p of allPages) {
      if (p !== this.page && !p.isClosed()) {
        log.info("Closing stray popup before Accueil navigation");
        await p.close().catch(() => {});
      }
    }

    const { url } = config.badr;
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const contextRoot = pathParts.length ? `/${pathParts[0]}` : "";
    const accueilUrl = `${parsed.origin}${contextRoot}/views/hab/hab_index.xhtml`;

    // Check if we're already on Accueil AND the menu exists in the DOM
    const isOnAccueil = this.page.url().includes("/views/hab/hab_index.xhtml");
    const menuExists = await this.page
      .locator(".ui-panelmenu-header a:has-text('MISE EN DOUANE')")
      .isVisible()
      .catch(() => false);

    if (isOnAccueil && menuExists) {
      log.info("BADR already on Accueil — skipping navigation");
      return;
    }

    if (!isOnAccueil) {
      log.info("Not on Accueil – navigating now");
    } else {
      log.info("On Accueil URL but menu missing – re-navigating to stabilize");
    }

    log.info(`Navigating to BADR Accueil: ${accueilUrl}`);
    await this.page.goto(accueilUrl, { waitUntil: "networkidle" });
    await this.page.waitForTimeout(2000);
    log.info("BADR Accueil ready");
  }

  /**
   * Disconnect Playwright from Edge (does NOT kill the Edge process).
   */
  async disconnect() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      log.info("Playwright disconnected from Edge");
    }
  }

  /**
   * Kill the Edge process completely.
   */
  kill() {
    if (this.edgeProcess) {
      this.edgeProcess.kill();
      this.edgeProcess = null;
      log.info("Edge process killed");
    }
  }
}

module.exports = BADRConnection;


---

code above its about how to connect to system badr
so now i want to build a script app that connect to system badr and take an excel file and take from the excel some references of dum for ex from dum 1 to dum 20 or 30 or 40
the generated excel look like this : 

		235-97223803		
				
P	1813		Fret	170892
V	204939,15		Ass	615
P,NET	1300		N, COLIS	84
P,BRUT	1644,9			
				
FOURNISSEUR				
MANIFEST				
				
		DUM 1		
P	98	0042192B	Fret	9466
V	11352,25		Ass	34
P,NET	73		N, COLIS	4
P,BRUT	92			
				
				
		DUM 2		
P	117	0042200K	Fret	10446
V	12526,64		Ass	38
P,NET	75		N, COLIS	5
P,BRUT	94			
				
				
		DUM 3		
P	96	0042203N	Fret	7926
V	9504,95		Ass	29
P,NET	59		N, COLIS	4
P,BRUT	75			
				
				
		DUM 4		
P	106	0042205R	Fret	10035
V	12033,85		Ass	36
P,NET	76		N, COLIS	5
P,BRUT	96			
				
				
		DUM 5		
P	123	0042214A	Fret	11192
V	13422		Ass	40
P,NET	86		N, COLIS	5
P,BRUT	109			
				
				
		DUM 6		
P	111	0042221H	Fret	11018
V	13213,22		Ass	40
P,NET	86		N, COLIS	6
P,BRUT	109			
				
				
		DUM 7		
P	121	0042222J	Fret	13592
V	16300,33		Ass	49
P,NET	108		N, COLIS	6
P,BRUT	137			
				
				
		DUM 8		
P	88	0042229S	Fret	8340
V	10001,96		Ass	30
P,NET	63		N, COLIS	4
P,BRUT	80			
				
				
		DUM 9		
P	89	0042232V	Fret	8558
V	10263,09		Ass	31
P,NET	62		N, COLIS	4
P,BRUT	79			
				
				
		DUM 10		
P	107	0042234X	Fret	9615
V	11530,12		Ass	35
P,NET	74		N, COLIS	5
P,BRUT	94			
				
				
		DUM 11		
P	135	0042240D	Fret	12323
V	14778,72		Ass	44
P,NET	93		N, COLIS	6
P,BRUT	118			
				
				
		DUM 12		
P	110	0042250P	Fret	9753
V	11696,36		Ass	35
P,NET	73		N, COLIS	5
P,BRUT	92			
				
				
		DUM 13		
P	122	0042256W	Fret	11451
V	13732,03		Ass	41
P,NET	86		N, COLIS	6
P,BRUT	109			
				
				
		DUM 14		
P	103	0042261B	Fret	9034
V	10833,54		Ass	33
P,NET	67		N, COLIS	4
P,BRUT	85			
				
				
		DUM 15		
P	102	0042264E	Fret	10453
V	12535,9		Ass	38
P,NET	82		N, COLIS	5
P,BRUT	103			
				
				
		DUM 16		
P	118	0042273P	Fret	11780
V	14127,16		Ass	42
P,NET	90		N, COLIS	7
P,BRUT	113			
				
				
		DUM 17		
P	67	0042277U	Fret	5910
V	7087,03		Ass	20
P,NET	47		N, COLIS	3
P,BRUT	59,9			


the LTA reference is 235-97223803
and dum ref or dums validated numbers "séries" is : 0042192B for dum1, 0042200K for dum2, ...

column of dum series always like this : 
dum 1 serie on column C12
dum 2 : C19
dum3 : C26
dum4 : C33
dum5 : C40
...
dum20 
dum30
dum40

---

so the script will take from a folder named dums : 
and inside this folder dums a lot of generated excels of LTAs validated
for example : generated_excel - 235-97223803
generated_excel - 106-78945601

each LTA and its genrated excel

so the script wil take LTA per LTA

and for each LTA should open excel take for example number of dum after connecting to system badr once time :
and for each dum number should "after connecting" and expand the menu of "DEDOUANEMENT" : <h3 class="ui-panelmenu-header ui-state-default ui-corner-all" role="tab" aria-expanded="false"><span class="ui-icon ui-icon-triangle-1-e"></span><a href="#" tabindex="-1">DEDOUANEMENT</a></h3>

then see a child with "Modifier une déclaration" : <li class="ui-menuitem ui-widget ui-corner-all" role="menuitem"><a id="_2008" title="/badr/views/menu.xhtml?codeFonctionnalite=cf2008" class="ui-menuitem-link ui-corner-all AddGoto" href="javascript:void(0)" onclick="return false;;PrimeFaces.ab({source:'_2008',update:'ID_tete_form:title_ID',formId:'west_form'});return false;"><span class="ui-menuitem-icon ui-icon ui-icon-bullet"></span><span class="ui-menuitem-text">Modifier une déclaration</span></a></li>

click on it then it redirect to a form iframe "<iframe id="iframeMenu" frameborder="0" scrolling="no" name="leftFreame" src="/badr/views/menu.xhtml?codeFonctionnalite=cf2008" height="100%" width="100%"> Votre navigateur ne supporte
					pas les iframes 
					
					</iframe>":
the form : 

<td role="gridcell">


											<div align="center"><div id="rootForm:criteres" class="ui-panel ui-widget ui-widget-content ui-corner-all" style="text-align:left"><div id="rootForm:criteres_header" class="ui-panel-titlebar ui-widget-header ui-helper-clearfix ui-corner-all"><span class="ui-panel-title">Critères de recherche</span></div><div id="rootForm:criteres_content" class="ui-panel-content ui-widget-content"><table id="rootForm:j_id_1q" class="ui-panelgrid ui-widget" style="width : 100%" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" class="ui-widget-header-2">
																<div align="left">
																	Référence de la déclaration</div></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell">
																<center><div id="rootForm:j_id_1x" class="ui-panel ui-widget ui-widget-content ui-corner-all" style="border: none;"><div id="rootForm:j_id_1x_content" class="ui-panel-content ui-widget-content"><table id="rootForm:j_id_1y" class="ui-panelgrid ui-widget" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell"><table id="rootForm:j_id_21" class="ui-panelgrid ui-widget" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique">
																			Bureau
																		</td><td role="gridcell" class="rubrique">
																			Régime
																		</td><td role="gridcell" class="rubrique">
																			Année
																		</td><td role="gridcell" style="text-align:center" class="rubrique">
																			Série 
																		</td><td role="gridcell" class="rubrique">
																			Clé
																		</td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" style="text-align : center"><input id="rootForm:_bureauId" name="rootForm:_bureauId" type="text" maxlength="3" size="3" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all " role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td><td role="gridcell" style="text-align : center"><input id="rootForm:_regimeId" name="rootForm:_regimeId" type="text" maxlength="3" size="3" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all " role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td><td role="gridcell" style="text-align : center"><input id="rootForm:_anneeId" name="rootForm:_anneeId" type="text" maxlength="4" size="4" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all " role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td><td role="gridcell" style="text-align : center"><input id="rootForm:_serieId" name="rootForm:_serieId" type="text" maxlength="7" size="7" style="border-color: #aed0ea;width: 55px;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td><td role="gridcell" style="text-align : center"><input id="rootForm:_cleId" name="rootForm:_cleId" type="text" maxlength="1" size="1" onkeyup="this.value = this.value.toUpperCase();" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all " role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td></tr></tbody></table></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" style="text-align : left" colspan="5"><div id="rootForm:selectcheckbxDecEnreg" class="ui-chkbox ui-widget"><div class="ui-helper-hidden-accessible"><input id="rootForm:selectcheckbxDecEnreg_input" name="rootForm:selectcheckbxDecEnreg_input" type="checkbox"></div><div class="ui-chkbox-box ui-widget ui-corner-all ui-state-default"><span class="ui-chkbox-icon ui-c"></span></div></div>
																						<i>Déclaration enregistrée</i></td></tr></tbody></table></div></div>
																</center></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" style="text-align :right" class="rubrique"><a id="rootForm:cmdLinkded_listes" href="#" class="ui-commandlink ui-widget click-to-open" onclick="PrimeFaces.ab({source:'rootForm:cmdLinkded_listes',process:'rootForm:cmdLinkded_listes',update:'rootForm:cmdLinkded_listes'});return false;">Rechercher la déclaration</a></td></tr><tr class="ui-widget-content" role="row"><td role="gridcell" style="text-align : center"><button id="rootForm:btnConfirmer" name="rootForm:btnConfirmer" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" onclick="PrimeFaces.ab({source:'rootForm:btnConfirmer',process:'rootForm:rech_content',update:'rootForm:rech_content',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Valider</span></button>
													&nbsp;
												<button id="rootForm:j_id_3c" name="rootForm:j_id_3c" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" onclick="PrimeFaces.ab({source:'rootForm:j_id_3c',process:'rootForm:j_id_3c',update:'rootForm'});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Rétablir</span></button></td></tr></tbody></table></div></div>
											</div></td>

taking example with dum 1 : 0042192B

for Bureau always type : 301
Régime : 010
Année : 2026
Série : 42192
Clé : B


Burau : <input id="rootForm:_bureauId" name="rootForm:_bureauId" type="text" maxlength="3" size="3" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false">

Régime : <input id="rootForm:_regimeId" name="rootForm:_regimeId" type="text" maxlength="3" size="3" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false">

Année : <input id="rootForm:_anneeId" name="rootForm:_anneeId" type="text" maxlength="4" size="4" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false">

Série : <input id="rootForm:_serieId" name="rootForm:_serieId" type="text" maxlength="7" size="7" style="border-color: #aed0ea;width: 55px;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false">

Clé : <input id="rootForm:_cleId" name="rootForm:_cleId" type="text" maxlength="1" size="1" onkeyup="this.value = this.value.toUpperCase();" style="border-color: #aed0ea;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false">

then click on Valider : <button id="rootForm:btnConfirmer" name="rootForm:btnConfirmer" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-only" onclick="PrimeFaces.ab({source:'rootForm:btnConfirmer',process:'rootForm:rech_content',update:'rootForm:rech_content',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-text ui-c">Valider</span></button>

then we redirected auto to the declaration existant "<iframe id="iframeMenu" frameborder="0" scrolling="no" name="leftFreame" src="/badr/views/menu.xhtml?codeFonctionnalite=cf2008" height="100%" width="100%"> Votre navigateur ne supporte
					pas les iframes 
					
					</iframe>"

then we check expediteur shipper name "this script should be an application with an interface with react tailwind after it will be exe not now now we will launch with npm run dev so every generated excel detected should be like on a card and the user should enter on this card the shipper name correct so the app will check when go to badr this shipper name with the shipper name entred on declaration":

so the shipper name is on Entête tab which is default tab wehn entering to a declaration : 
<tr class="ui-widget-content" role="row"><td role="gridcell" class="rubrique rubrique">
					Nom ou raison sociale
					</td><td role="gridcell" colspan="3"><input id="mainTab:form0:nomOperateurExpediteur" name="mainTab:form0:nomOperateurExpediteur" type="text" value="SHENZHEN YONGLIANDA INDUSTRIAL CO., LTD" maxlength="50" style="width:400px;" class="ui-inputfield ui-inputtext ui-widget ui-state-default ui-corner-all" role="textbox" aria-disabled="false" aria-readonly="false" aria-multiline="false"></td></tr>


we navigate to "Documents" Tab to see if user has uplaoded 2 pdfs "annexed" LTA "TITRE DE TRANSPORT" and "FACTURE (mn1,mn2,mn* like dums)" :
so to navigate to Documents tab we click on : <li class="ui-state-default ui-corner-top" role="tab" aria-expanded="false"><a href="#mainTab:tab7">Documents</a></li>

and we should see two documents on this table like this : 
<div class="ui-datatable-tablewrapper"><table role="grid"><thead id="mainTab:form7:listeDocumentsAnnexes_head"><tr role="row"><th id="mainTab:form7:listeDocumentsAnnexes:j_id_3p_25r_2_2n_2" class="ui-state-default" role="columnheader"><span>Numéro</span></th><th id="mainTab:form7:listeDocumentsAnnexes:j_id_3p_25r_2_2n_5" class="ui-state-default" role="columnheader"><span>Document</span></th><th id="mainTab:form7:listeDocumentsAnnexes:j_id_3p_25r_2_2n_8" class="ui-state-default" role="columnheader"><span>Portée</span></th><th id="mainTab:form7:listeDocumentsAnnexes:j_id_3p_25r_2_2n_d" class="ui-state-default" role="columnheader"><span>Statut</span></th><th id="mainTab:form7:listeDocumentsAnnexes:j_id_3p_25r_2_2n_g" class="ui-state-default" role="columnheader"><span>Version</span></th></tr></thead><tfoot></tfoot><tbody id="mainTab:form7:listeDocumentsAnnexes_data" class="ui-datatable-data ui-widget-content"><tr data-ri="0" class="ui-widget-content ui-datatable-even" role="row"><td role="gridcell"><label id="mainTab:form7:listeDocumentsAnnexes:0:j_id_3p_25r_2_2n_4" class="ui-outputlabel">1</label></td><td role="gridcell"><a id="mainTab:form7:listeDocumentsAnnexes:0:j_id_3p_25r_2_2n_7" href="#" class="ui-commandlink ui-widget" onclick="PrimeFaces.ab({source:'mainTab:form7:listeDocumentsAnnexes:0:j_id_3p_25r_2_2n_7',process:'mainTab:form7:listeDocumentsAnnexes:0:j_id_3p_25r_2_2n_7',update:'mainTab:form7:RejeterDocumentBlock'});return false;">TITRE DE PROPRIÉTÉ ET/OU DE TRANSPORT(A0004)</a></td><td role="gridcell">
								<div align="center"><label id="mainTab:form7:listeDocumentsAnnexes:0:j_id_3p_25r_2_2n_b" class="ui-outputlabel">D</label>
								</div></td><td role="gridcell"><a id="mainTab:form7:listeDocumentsAnnexes:0:j_id_3p_25r_2_2n_f" href="#" class="ui-commandlink ui-widget" onclick="PrimeFaces.ab({source:'mainTab:form7:listeDocumentsAnnexes:0:j_id_3p_25r_2_2n_f',process:'mainTab:form7:listeDocumentsAnnexes:0:j_id_3p_25r_2_2n_f',update:'mainTab:form7:RejeterDocumentBlock'});return false;"></a></td><td role="gridcell">
								<div align="center"><label id="mainTab:form7:listeDocumentsAnnexes:0:j_id_3p_25r_2_2n_j" class="ui-outputlabel">0</label>
								</div></td></tr><tr data-ri="1" class="ui-widget-content ui-datatable-odd" role="row"><td role="gridcell"><label id="mainTab:form7:listeDocumentsAnnexes:1:j_id_3p_25r_2_2n_4" class="ui-outputlabel">2</label></td><td role="gridcell"><a id="mainTab:form7:listeDocumentsAnnexes:1:j_id_3p_25r_2_2n_7" href="#" class="ui-commandlink ui-widget" onclick="PrimeFaces.ab({source:'mainTab:form7:listeDocumentsAnnexes:1:j_id_3p_25r_2_2n_7',process:'mainTab:form7:listeDocumentsAnnexes:1:j_id_3p_25r_2_2n_7',update:'mainTab:form7:RejeterDocumentBlock'});return false;">FACTURE(A0006)</a></td><td role="gridcell">
								<div align="center"><label id="mainTab:form7:listeDocumentsAnnexes:1:j_id_3p_25r_2_2n_b" class="ui-outputlabel">D</label>
								</div></td><td role="gridcell"><a id="mainTab:form7:listeDocumentsAnnexes:1:j_id_3p_25r_2_2n_f" href="#" class="ui-commandlink ui-widget" onclick="PrimeFaces.ab({source:'mainTab:form7:listeDocumentsAnnexes:1:j_id_3p_25r_2_2n_f',process:'mainTab:form7:listeDocumentsAnnexes:1:j_id_3p_25r_2_2n_f',update:'mainTab:form7:RejeterDocumentBlock'});return false;"></a></td><td role="gridcell">
								<div align="center"><label id="mainTab:form7:listeDocumentsAnnexes:1:j_id_3p_25r_2_2n_j" class="ui-outputlabel">0</label>
								</div></td></tr></tbody></table></div>

if table is empty we should not process this dum and just ignore it to next dum with leaving notification or log error file like "DUM 1 LTA N°235-97223803 not ready to be signed"
it so obligé to be annexed 2 doc not only 1 okay this is critic

then we navigate to tab "Preapurement DS" : <li class="ui-state-default ui-corner-top ui-state-focus ui-tabs-selected ui-state-active" role="tab" aria-expanded="true"><a href="#mainTab:tab3">Preapurement DS</a></li>

and see if there is a lot row here like this : 
<div class="ui-datatable-tablewrapper"><table role="grid"><thead id="mainTab:form3:table_preap_head"><tr role="row"><th id="mainTab:form3:table_preap:j_id_3p_1ds" class="ui-state-default" role="columnheader"><span>N°</span></th><th id="mainTab:form3:table_preap:j_id_3p_1du" class="ui-state-default" role="columnheader"><span>Type DS</span></th><th id="mainTab:form3:table_preap:j_id_3p_1dw" class="ui-state-default" role="columnheader"><span>Référence DS</span></th><th id="mainTab:form3:table_preap:j_id_3p_1e7" class="ui-state-default" role="columnheader"><span>Lieu de chargement</span></th><th id="mainTab:form3:table_preap:j_id_3p_1e9" class="ui-state-default" role="columnheader"><span>Référence lot</span></th><th id="mainTab:form3:table_preap:j_id_3p_1eh" class="ui-state-default" role="columnheader"><span>Poids brut</span></th><th id="mainTab:form3:table_preap:j_id_3p_1ej" class="ui-state-default" role="columnheader"><span>Nbre contenant</span></th><th id="mainTab:form3:table_preap:j_id_3p_1el" class="ui-state-default" role="columnheader"><span>Tare</span></th><th id="mainTab:form3:table_preap:j_id_3p_1en" class="ui-state-default" role="columnheader"><span>BAD</span></th></tr></thead><tfoot></tfoot><tbody id="mainTab:form3:table_preap_data" class="ui-datatable-data ui-widget-content"><tr data-ri="0" class="ui-widget-content ui-datatable-even" role="row"><td role="gridcell"><a id="mainTab:form3:table_preap:0:j_id_3p_1dt" href="#" class="ui-commandlink ui-widget notDisabled" onclick="PrimeFaces.ab({source:'mainTab:form3:table_preap:0:j_id_3p_1dt',process:'mainTab:form3:table_preap:0:j_id_3p_1dt',update:'mainTab:form3:preap_section_body'});return false;">1</a></td><td role="gridcell">05</td><td role="gridcell">
							<div align="left"><a id="mainTab:form3:table_preap:0:j_id_3p_1e4" href="#" class="ui-commandlink ui-widget notDisabled" onclick="PrimeFaces.ab({source:'mainTab:form3:table_preap:0:j_id_3p_1e4',process:'mainTab:form3:table_preap:0:j_id_3p_1e4',update:'@none'});return false;">301-000-2026-0001620-Y</a>
							</div></td><td role="gridcell">HKG</td><td role="gridcell">15754440223/16</td><td role="gridcell">121</td><td role="gridcell">67</td><td role="gridcell">0</td><td role="gridcell"><a id="mainTab:form3:table_preap:0:j_id_3p_1eo" href="#" class="ui-commandlink ui-widget notDisabled" onclick="PrimeFaces.ab({source:'mainTab:form3:table_preap:0:j_id_3p_1eo',process:'mainTab:form3:table_preap:0:j_id_3p_1eo',update:'@none'});return false;"></a></td></tr></tbody></table></div>

the row should be like if we are processing LTA ref 15754440223 and current dum is dum 16
the lot should be 	15754440223/16 
and if its dum 1 the lot should be 15754440223/1, ...

if its not or empty ignore with error log detailed file

then we validate this declaration by clicking on "VALIDER": <li class="ui-menuitem ui-widget ui-corner-all" role="menuitem"><a id="secure__2003" class="ui-menuitem-link ui-corner-all" href="javascript:void(0)" onclick="PrimeFaces.ab({source:'secure__2003',process:'mainTab:form0:content_tab0',update:'leftMenuPanel',partialSubmit:true,oncomplete:function(xhr,status,args){moveToTargetSection(xhr, status, args, section_widget , 0, true , changerSection_ded_sect_handler_id , 'niveau1' ,'tab0');;},formId:'j_id_1g'});return false;"><span class="ui-menuitem-icon ui-icon ui-icon-triangle-1-e"></span><span class="ui-menuitem-text">VALIDER</span></a></li>

if no error and success message like this : 
<div style="height : 37px;" id="msg-error"><span id="rapportMsg"><form id="rapportMsgForm" name="rapportMsgForm" method="post" action="/badr/views/ded/ded_gestion.xhtml" enctype="application/x-www-form-urlencoded"><table id="rapportMsgForm:j_id_34" class="ui-panelgrid ui-widget barreErreurs" style="position : fixed;z-index : 9;" role="grid"><tbody><tr class="ui-widget-content" role="row"><td role="gridcell" style="padding : 0px !important;">

	<div id="form1:messages" class="ui-messages ui-widget" data-detail="data-detail" data-summary="data-summary" aria-live="polite">
		<div class="ui-messages-info ui-corner-all" style="margin: 0px !important;"><a id="rapportMsgForm:j_id_38" href="#" class="ui-commandlink ui-widget ui-messages-close ui-icon  ui-icon-close" onclick="$(this).parent().slideUp();;PrimeFaces.ab({source:'rapportMsgForm:j_id_38',process:'rapportMsgForm:j_id_38',update:'rapportMsgForm:j_id_36',global:false});return false;"></a>
		         <span class="ui-messages-info-icon"></span>
		    
		    <ul>
		        <li>
		               <span class="ui-messages-info-summary">Infos :  </span>
		                  <span class="ui-messages-info-detail">
			            </span>
		            <span style="float : right"><a id="rapportMsgForm:showErrors" href="#" class="ui-commandlink ui-widget" onclick="PrimeFaces.ab({source:'rapportMsgForm:showErrors',process:'rapportMsgForm:showErrors',update:'@none',global:false,params:[{name:'SKIP_UPDATE_ERROR_KEY',value:'true'}]});return false;">Détails</a>
		            </span>
		        </li>
		        
		    </ul>
		</div>
	</div></td></tr></tbody></table><input type="hidden" name="rapportMsgForm_SUBMIT" value="1"><input type="hidden" name="javax.faces.ViewState" id="javax.faces.ViewState" value="E8f60tWaucesZPquFTPrsA9+8g8tvw1U/PpM8m9b8O7yB9+l6G4X1isKgHQndo2wpk4d3ShWyfnim2kFfBl8ugaLndnnj1qiqdOgoKiLS9o0wIljD5FH/iZR18AlY1kq1uTsCgb+C/5jMrCAlwzkRoWjmwE=" autocomplete="off"></form>
							<br></span> 
				    </div>

if success like above so we click on SIGNER if error we skip with error log file without clikc on SIGNER because its so critic : 

to click on SIGNER we click on : 
<li class="ui-menuitem ui-widget ui-corner-all" role="menuitem"><a id="secure_2018" class="ui-menuitem-link ui-corner-all" href="javascript:void(0)" onclick="dlgConsentementSignerDeclarant.show();;PrimeFaces.ab({source:'secure_2018',process:'mainTab:form0:content_tab0',update:'leftMenuPanel dlginterventionId',partialSubmit:true,formId:'j_id_1g'});return false;"><span class="ui-menuitem-icon ui-icon ui-icon-triangle-1-e"></span><span class="ui-menuitem-text">SIGNER</span></a></li>

a dialog confirmation appear : 
<div id="j_id_47_1:idConsentementSignerDeclarantDlg" class="ui-dialog ui-widget ui-widget-content ui-corner-all ui-shadow ui-draggable ui-resizable ui-overlay-visible" role="dialog" aria-labelledby="j_id_47_1:idConsentementSignerDeclarantDlg_title" aria-hidden="false" style="width: 30%; height: auto; left: 355.5px; top: 85.5px; visibility: visible; z-index: 1002;" aria-live="polite"><div class="ui-dialog-titlebar ui-widget-header ui-helper-clearfix ui-corner-top"><span id="j_id_47_1:idConsentementSignerDeclarantDlg_title" class="ui-dialog-title">Signer la déclaration</span><a href="#" class="ui-dialog-titlebar-icon ui-dialog-titlebar-close ui-corner-all" role="button"><span class="ui-icon ui-icon-closethick"></span></a></div><div class="ui-dialog-content ui-widget-content" style="height: auto;">J'autorise l'Administration des Douanes et Impôts Indirects à communiquer les données de la présente déclaration et ses annexes aux organismes de contrôle non douanier et aux autres intervenants, pour les besoins de dédouanement et d'enlèvement de la marchandise déclarée et ce, conformément aux dispositions de l'article<b> 45 ter</b> du Code des douanes et Impôts et indirects.<br>Etes-vous sûr de vouloir signer les documents de la déclaration ?<br>
					<br>
					<center><button id="j_id_47_1:j_id_47_5" name="j_id_47_1:j_id_47_5" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-icon-left ui-confirmdialog-yes" onclick="PrimeFaces.ab({source:'j_id_47_1:j_id_47_5',process:'j_id_47_1:j_id_47_5',update:'leftMenuPanel dlginterventionId',partialSubmit:true,onstart:function(cfg){dlgConsentementSignerDeclarant.hide();;},oncomplete:function(xhr,status,args){lancerdialogInterAndMoveParam(xhr, status, args, section_widget , 0, true , changerSection_ded_sect_handler_id , 'niveau1' ,'tab0');;}});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-icon-left ui-icon ui-c ui-icon-check"></span><span class="ui-button-text ui-c">Oui</span></button><button id="j_id_47_1:j_id_47_6" name="j_id_47_1:j_id_47_6" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-icon-left ui-confirmdialog-no" onclick="dlgConsentementSignerDeclarant.hide();;PrimeFaces.ab({source:'j_id_47_1:j_id_47_6',process:'j_id_47_1:j_id_47_6',update:'@none',partialSubmit:true});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-icon-left ui-icon ui-c ui-icon-close"></span><span class="ui-button-text ui-c">Non</span></button>

					</center>
					<br>
					<hr><b style="color:red;">La mise à jour de l’adresse et coordonnées GPS (récupérées depuis Google Maps) du siège social de l’importateur est désormais obligatoire. Nous vous invitons à procéder, dans un délai ne dépassant pas 3 mois, à cette mise à jour via le canal officiel désigné (PORTNET).<br></b></div><div class="ui-resizable-handle ui-resizable-n" style="z-index: 1000;"></div><div class="ui-resizable-handle ui-resizable-s" style="z-index: 1000;"></div><div class="ui-resizable-handle ui-resizable-e" style="z-index: 1000;"></div><div class="ui-resizable-handle ui-resizable-w" style="z-index: 1000;"></div><div class="ui-resizable-handle ui-resizable-ne" style="z-index: 1000;"></div><div class="ui-resizable-handle ui-resizable-nw" style="z-index: 1000;"></div><div class="ui-resizable-handle ui-resizable-se ui-icon ui-icon-gripsmall-diagonal-se" style="z-index: 1000;"></div><div class="ui-resizable-handle ui-resizable-sw" style="z-index: 1000;"></div></div>

on this dialog we click on "Oui" button : <button id="j_id_47_1:j_id_47_5" name="j_id_47_1:j_id_47_5" class="ui-button ui-widget ui-state-default ui-corner-all ui-button-text-icon-left ui-confirmdialog-yes" onclick="PrimeFaces.ab({source:'j_id_47_1:j_id_47_5',process:'j_id_47_1:j_id_47_5',update:'leftMenuPanel dlginterventionId',partialSubmit:true,onstart:function(cfg){dlgConsentementSignerDeclarant.hide();;},oncomplete:function(xhr,status,args){lancerdialogInterAndMoveParam(xhr, status, args, section_widget , 0, true , changerSection_ded_sect_handler_id , 'niveau1' ,'tab0');;}});return false;" type="submit" role="button" aria-disabled="false"><span class="ui-button-icon-left ui-icon ui-c ui-icon-check"></span><span class="ui-button-text ui-c">Oui</span></button>

then wait till loading-ui componenet : <div id="j_id_9" class="ui-blockui-content ui-widget ui-widget-content ui-corner-all ui-helper-hidden ui-shadow" style="left: 300.5px; top: 1452px; display: block;">  
	           Traitement en cours... <br><img id="j_id_b" src="/badr/resources/images/ajax-loading.gif" alt="" width="156px" height="23px"></div>

when this loading finish this mean that this dum successfully signed 
after this we click on "IMPRIMER" : <li class="ui-menuitem ui-widget ui-corner-all" role="menuitem"><a id="secure_imprimer" class="ui-menuitem-link ui-corner-all" href="javascript:void(0)" onclick="closeWindow = true;closeWindow = true;closeWindow = true;closeWindow = true;$('#secure_imprimer').hide(); onFileExport();;PrimeFaces.addSubmitParam('j_id_1g',{'secure_imprimer':'secure_imprimer'}).submit('j_id_1g');"><span class="ui-menuitem-icon ui-icon ui-icon-triangle-1-e"></span><span class="ui-menuitem-text">IMPRIMER</span></a></li>
so the dum is downloaded we should name it like this "dynamically on current LTA ref and current dum" LIKE THIS : DUM 1 LTA N°235-97223803 and save it do downloads
after we go back to accueil by refreshing page and redo the process for next LTA (DEDOUANEMENT -> Modifier une declaration -> ...)

when finish an LTA with all its dums make them into folder called for ex : LTA N° 065-46143823 
so it will be for each LTA or each generated excel a folder and inside this folder dums pdfs signed




NB : the selectors id could be dynamic so always do fallbacks and use many attemp with selectors to avoid dynamic id selector issues "Robuste way of accessing"
