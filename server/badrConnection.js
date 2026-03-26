import fs from "fs-extra";
import { spawn } from "child_process";
import { chromium } from "playwright";
import { config } from "./config.js";
import { logger } from "./logger.js";

export class BADRConnection {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.edgeProcess = null;
  }

  async startFreshEdge() {
    await fs.ensureDir(config.badr.userDataDir);
    this.edgeProcess = spawn(
      config.badr.edgePath,
      [
        `--remote-debugging-port=${config.badr.debuggingPort}`,
        `--user-data-dir=${config.badr.userDataDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-popup-blocking",
      ],
      { detached: false, stdio: "ignore" },
    );

    this.edgeProcess.on("error", (err) => {
      logger.error({ err }, "Edge process error");
    });

    await new Promise((r) => setTimeout(r, 4000));
  }

  async connectToEdge() {
    const cdpUrl = `http://localhost:${config.badr.debuggingPort}`;
    this.browser = await chromium.connectOverCDP(cdpUrl);
    const contexts = this.browser.contexts();
    this.context = contexts.length
      ? contexts[0]
      : await this.browser.newContext();
    const pages = this.context.pages();
    this.page = pages.length ? pages[0] : await this.context.newPage();
    this.page.setDefaultTimeout(config.timeout);
  }

  async fillAndVerify(selector, value) {
    const field = this.page.locator(selector);
    await field.waitFor({ state: "visible", timeout: config.timeout });
    await field.fill("");
    await field.fill(String(value));
    const current = await field.inputValue();
    if (current !== String(value)) {
      await field.fill("");
      await field.fill(String(value));
    }
  }

  async navigateAndLogin() {
    await this.page.goto(config.badr.url, { waitUntil: "domcontentloaded" });
    await this.page.waitForSelector("#connexionForm\\:pwdConnexionId", {
      timeout: config.timeout,
    });

    if (config.badr.password) {
      await this.fillAndVerify(
        "#connexionForm\\:pwdConnexionId",
        config.badr.password,
      );
      await this.page.click("#connexionForm\\:login");
      await this.page.waitForTimeout(5000);

      const sessionLink = this.page.locator(
        "#connexionForm\\:sessionConnexionId",
      );
      if (await sessionLink.isVisible().catch(() => false)) {
        await sessionLink.click();
        await this.page.waitForTimeout(3000);
      }
    }
  }

  async connect() {
    if (this.page && !this.page.isClosed()) {
      return;
    }

    try {
      await this.connectToEdge();
      await this.navigateAndLogin();
      return;
    } catch {
      await this.startFreshEdge();
      await this.connectToEdge();
      await this.navigateAndLogin();
    }
  }

  async navigateToAccueil() {
    const parsed = new URL(config.badr.url);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const contextRoot = pathParts.length ? `/${pathParts[0]}` : "";
    const accueilUrl = `${parsed.origin}${contextRoot}/views/hab/hab_index.xhtml`;
    await this.page.goto(accueilUrl, { waitUntil: "networkidle" });
    await this.page.waitForTimeout(1200);
  }

  async disconnect() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
