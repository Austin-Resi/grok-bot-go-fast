import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import type { ObservedPage, SnapshotAction } from "./action-space.ts";

const ROOT = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = readFileSync(join(ROOT, "runtime/snapshot.js"), "utf8");
const RESOLVE_TARGET = readFileSync(join(ROOT, "runtime/resolve-target.js"), "utf8");
const SETTLE = readFileSync(join(ROOT, "runtime/settle.js"), "utf8");

export class StalePage extends Error {
  constructor(message = "Page changed since this decision. Observe again.") {
    super(message);
    this.name = "StalePage";
  }
}

interface ClickTarget {
  x: number;
  y: number;
}

export class FastBrowser {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private session: CDPSession | undefined;
  private connected = false;

  async open(url: string): Promise<void> {
    const cdp = process.env.CDP_URL?.trim();
    const headless = process.env.JEV_HEADLESS === "true";

    if (cdp) {
      this.browser = await chromium.connectOverCDP(cdp);
      this.connected = true;
      const context = this.browser.contexts()[0] ?? await this.browser.newContext({
        viewport: { width: 1120, height: 780 },
      });
      this.page = await context.newPage();
    } else {
      this.browser = await chromium.launch({ headless });
      const context = await this.browser.newContext({ viewport: { width: 1120, height: 780 } });
      this.page = await context.newPage();
    }

    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    this.session = await this.page.context().newCDPSession(this.page);
  }

  async observe(): Promise<ObservedPage> {
    const session = this.session;
    if (!session) throw new Error("Browser is not open");
    const result = await session.send("Runtime.evaluate", {
      expression: SNAPSHOT,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new StalePage("Document changed during evaluation");
    const info = result.result?.value as ObservedPage | null | undefined;
    if (!info) throw new StalePage("Document is navigating");
    return info;
  }

  async act(action: SnapshotAction, text?: string): Promise<void> {
    const page = this.requirePage();
    if (action.kind === "wait") {
      await page.waitForTimeout(100);
      return;
    }
    if (action.kind === "scroll") {
      await page.mouse.wheel(0, action.delta ?? 560);
      await page.waitForTimeout(50);
      return;
    }
    if (action.node == null) throw new StalePage("Action has no observed node");

    const session = this.session;
    if (!session) throw new Error("Browser is not open");
    const resolved = await session.send("Runtime.evaluate", {
      expression: `(${RESOLVE_TARGET})(${JSON.stringify(action)})`,
      returnByValue: true,
    });
    if (resolved.exceptionDetails) throw new StalePage("Document changed during evaluation");
    const target = resolved.result?.value as ClickTarget | null | undefined;
    if (!target) throw new StalePage("Target changed or is covered. Observe again.");

    if (action.kind !== "select") {
      await page.mouse.click(target.x, target.y);
      if (action.kind === "fill") {
        if (!text) throw new Error("TYPE_TEXT needs a field value");
        const modifier = process.platform === "darwin" ? "Meta" : "Control";
        await page.keyboard.press(`${modifier}+A`);
        await page.keyboard.insertText(text);
      }
    }

    await session.send("Runtime.evaluate", {
      expression: `(${SETTLE})(${JSON.stringify(action)})`,
      awaitPromise: true,
      returnByValue: true,
    });
  }

  async close(): Promise<void> {
    await this.session?.detach().catch(() => undefined);
    this.session = undefined;
    await this.page?.close().catch(() => undefined);
    this.page = undefined;
    if (this.browser && !this.connected) await this.browser.close().catch(() => undefined);
    this.browser = undefined;
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("Browser is not open");
    return this.page;
  }
}

