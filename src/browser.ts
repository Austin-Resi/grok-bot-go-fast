import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type CDPSession, type Page } from "playwright";
import type { ObservedPage, SnapshotAction } from "./action-space.ts";
import { discoverCdp } from "./cdp.ts";
import { settingIs } from "./env.ts";

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

// One CDP client per Chrome. Reconnecting per task leaks connections and, with
// the Chrome 144+ chrome://inspect flow, prompts the user on every connect.
let shared: { url: string; browser: Browser } | undefined;

async function sharedBrowser(url: string): Promise<Browser> {
  if (shared?.url === url && shared.browser.isConnected()) return shared.browser;
  const browser = await chromium.connectOverCDP(url);
  shared = { url, browser };
  browser.once("disconnected", () => {
    if (shared?.browser === browser) shared = undefined;
  });
  return browser;
}

export async function disconnectSharedBrowser(): Promise<void> {
  const current = shared;
  shared = undefined;
  await current?.browser.close().catch(() => undefined);
}

export class FastBrowser {
  private browser: Browser | undefined;
  private page: Page | undefined;
  private session: CDPSession | undefined;
  private connected = false;
  private attachment: string | undefined;

  get attached(): boolean {
    return this.connected;
  }

  /** Profile dir or endpoint of the Chrome this instance drives, when attached. */
  get attachedTo(): string | undefined {
    return this.attachment;
  }

  async open(url: string): Promise<void> {
    const cdp = await discoverCdp();
    const headless = settingIs("HEADLESS", "true");

    if (cdp) {
      this.browser = await sharedBrowser(cdp.url);
      this.connected = true;
      this.attachment = cdp.profileDir ?? cdp.url;
      const context = this.browser.contexts()[0] ?? await this.browser.newContext({
        viewport: { width: 1120, height: 780 },
      });
      this.page = await context.newPage();
    } else {
      this.browser = await chromium.launch({ headless });
      const context = await this.browser.newContext({ viewport: { width: 1120, height: 780 } });
      this.page = await context.newPage();
    }

    this.session = await this.page.context().newCDPSession(this.page);
    await this.goto(url);
  }

  async goto(url: string): Promise<void> {
    const page = this.requirePage();
    await this.focus();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  }

  async focus(): Promise<void> {
    await this.page?.bringToFront().catch(() => undefined);
  }

  /** Evaluate an expression in the page. Diagnostics and tests only. */
  async evaluate<T>(expression: string): Promise<T> {
    const session = this.session;
    if (!session) throw new Error("Browser is not open");
    const result = await session.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Evaluation failed");
    return result.result?.value as T;
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
    await this.focus();
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
    // Attached browsers stay connected in `shared`; only Jev's own launch is closed.
    if (this.browser && !this.connected) await this.browser.close().catch(() => undefined);
    this.browser = undefined;
    this.connected = false;
    this.attachment = undefined;
  }

  private requirePage(): Page {
    if (!this.page) throw new Error("Browser is not open");
    return this.page;
  }
}
