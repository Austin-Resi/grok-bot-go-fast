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
  scrolled?: number;
}

export interface ObserveOptions {
  /** Ranks offscreen candidates against this text. */
  goal?: string;
  /** How many offscreen candidates to offer. */
  topK?: number;
  /** How long to wait for a navigating document before giving up. */
  timeoutMs?: number;
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
  private lastUrl: string | undefined;
  private navigations = 0;
  private wentBack = false;

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

    // Clicking a styled "Upload" button opens a native file chooser, which no
    // model can drive. Intercept it: attach whatever the run provides, or let it
    // pass with nothing so the page simply sees no selection.
    this.page.on("filechooser", (chooser) => {
      const paths = this.fileChooserHandler?.(chooser.isMultiple()) ?? [];
      void (paths.length ? chooser.setFiles(chooser.isMultiple() ? paths : paths.slice(0, 1)) : Promise.resolve()).catch(() => undefined);
      this.lastChooser = { multiple: chooser.isMultiple(), attached: paths.length };
    });

    this.session = await this.page.context().newCDPSession(this.page);
    await this.goto(url);
  }

  /** Supplies file paths when the page opens a chooser; return [] to attach nothing. */
  fileChooserHandler: ((multiple: boolean) => string[]) | undefined;
  /** The last intercepted chooser, cleared by takeChooser(). */
  private lastChooser: { multiple: boolean; attached: number } | undefined;

  /** Whether a file chooser opened since the last call, and what was attached. */
  takeChooser(): { multiple: boolean; attached: number } | undefined {
    const c = this.lastChooser;
    this.lastChooser = undefined;
    return c;
  }

  async goto(url: string): Promise<void> {
    const page = this.requirePage();
    await this.focus();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    this.navigations = 0;
    this.wentBack = false;
    this.lastUrl = page.url();
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

  /** Number of in-run navigations available to BACK. */
  get canGoBack(): boolean {
    return this.navigations > 0;
  }

  /**
   * History back. A hung or refused history navigation is a failed step, not a
   * dead run: it surfaces as StalePage so the loop records it and continues.
   */
  async back(timeoutMs = 20_000): Promise<void> {
    const page = this.requirePage();
    await this.focus();
    try {
      await page.goBack({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch (error) {
      this.wentBack = false;
      throw new StalePage(`Back navigation did not complete: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
    this.navigations = Math.max(0, this.navigations - 1);
  }

  async observe(opts: ObserveOptions = {}): Promise<ObservedPage> {
    const session = this.session;
    if (!session) throw new Error("Browser is not open");
    const page = this.requirePage();
    const url = page.url();
    if (this.lastUrl != null && url !== this.lastUrl && !this.wentBack) this.navigations += 1;
    this.wentBack = false;
    this.lastUrl = url;
    // A click may have started a navigation. The snapshot returns null until
    // document.body exists and throws if the document is torn down under it;
    // wait for the new document instead of failing the step.
    const expression = `(${SNAPSHOT})(${JSON.stringify({ goal: opts.goal ?? "", topK: opts.topK })})`;
    const deadline = performance.now() + (opts.timeoutMs ?? 8_000);
    for (;;) {
      let info: ObservedPage | null | undefined;
      let failed = false;
      try {
        const result = await session.send("Runtime.evaluate", { expression, returnByValue: true });
        if (result.exceptionDetails) failed = true;
        else info = result.result?.value as ObservedPage | null | undefined;
      } catch {
        failed = true;
      }
      if (info) return info;
      if (performance.now() >= deadline) {
        throw new StalePage(failed ? "Document changed during evaluation" : "Document is navigating");
      }
      await page.waitForLoadState("domcontentloaded", { timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(50);
    }
  }

  /**
   * Attach files to a file input by node, no OS dialog. Works on hidden inputs
   * (the usual case behind a styled Upload button). Paths must exist on the
   * machine running this server, which is the Bot's computer.
   */
  async upload(action: SnapshotAction, paths: string[]): Promise<number> {
    const page = this.requirePage();
    if (action.node == null) throw new StalePage("Action has no observed node");
    await this.focus();
    const handle = await page.evaluateHandle(
      (id: number) => (window as unknown as { __jevFast?: { nodes: Map<number, Element> } }).__jevFast?.nodes.get(id) ?? null,
      action.node,
    );
    const element = handle.asElement();
    if (!element) throw new StalePage("File input is gone");
    const isFile = await element.evaluate((e) => e instanceof HTMLInputElement && e.type === "file" && e.isConnected && !e.disabled);
    if (!isFile) throw new StalePage("Target is no longer a file input");
    const files = action.multiple ? paths : paths.slice(0, 1);
    await element.setInputFiles(files);
    const attached = await element.evaluate((e) => (e as HTMLInputElement).files?.length ?? 0);
    await handle.dispose();
    // Uploaders react asynchronously (thumbnails, progress). Give them a moment.
    await page.waitForTimeout(800);
    return attached;
  }

  async act(action: SnapshotAction, text?: string): Promise<void> {
    const page = this.requirePage();
    await this.focus();
    if (action.kind === "wait") {
      await page.waitForTimeout(100);
      return;
    }
    if (action.kind === "upload") throw new Error("Use upload() for file inputs");
    if (action.kind === "scroll") {
      await page.mouse.wheel(0, action.delta ?? 560);
      await page.waitForTimeout(50);
      return;
    }
    if (action.kind === "back") {
      if (!this.canGoBack) throw new StalePage("No earlier page in this run");
      this.wentBack = true;
      await this.back();
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
    // resolve-target may have scrolled an offscreen node into view; let layout settle
    // so the click lands on the post-scroll geometry.
    if (action.offscreen) await page.waitForTimeout(60);

    if (action.kind !== "select") {
      await page.mouse.click(target.x, target.y);
      if (action.kind === "fill") {
        if (!text) throw new Error("TYPE_TEXT needs a field value");
        const modifier = process.platform === "darwin" ? "Meta" : "Control";
        await page.keyboard.press(`${modifier}+A`);
        await page.keyboard.insertText(text);
      }
    }

    // SETTLE resolves via requestAnimationFrame. If the click started a navigation
    // the old document may never paint again; cap the wait rather than hang.
    await Promise.race([
      session.send("Runtime.evaluate", {
        expression: `(${SETTLE})(${JSON.stringify(action)})`,
        awaitPromise: true,
        returnByValue: true,
      }).catch(() => undefined),
      page.waitForTimeout(1_500),
    ]);
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
