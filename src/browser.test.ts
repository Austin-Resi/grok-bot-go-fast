import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { FastBrowser, StalePage } from "./browser.ts";

describe("FastBrowser", () => {
  it("snapshots a live button and clicks that node", { timeout: 30_000 }, async () => {
    process.env.CRACK_BOT_HEADLESS = "true";
    process.env.CRACK_BOT_CDP_DISCOVER = "false";
    delete process.env.CDP_URL;
    const browser = new FastBrowser();
    try {
      await browser.open("data:text/html,<!doctype html><button id='go'>Go</button>");
      const page = await browser.observe();
      const go = page.actions.find((action) => action.label === "Go");
      assert.ok(go?.node, "expected a live node for the Go button");
      await browser.act(go);
      await browser.goto("data:text/html,<!doctype html><button id='next'>Next</button>");
      const nextPage = await browser.observe();
      assert.ok(nextPage.actions.some((action) => action.label === "Next"));
    } finally {
      await browser.close();
    }
  });

  it("keeps a wrapped inline link whose union-box center misses the anchor, and clicks it", { timeout: 30_000 }, async () => {
    process.env.CRACK_BOT_HEADLESS = "true";
    process.env.CRACK_BOT_CDP_DISCOVER = "false";
    delete process.env.CDP_URL;
    // Line 1: 320px of filler then "United"; line 2: "States" then 320px of filler.
    // The anchor's union rect spans x≈0..370 and both lines, so its center sits on
    // the line-2 filler span, not on either link fragment.
    const html = `<!doctype html>
      <p style="width:400px;font:16px/24px sans-serif;margin:40px;white-space:nowrap">
        <span style="display:inline-block;width:320px">Wisconsin is a state of the</span>
        <a id="us" href="javascript:void(0)" onclick="window.__hit=true">United<br>States</a>
        <span style="display:inline-block;width:320px">bordered by Minnesota.</span>
      </p>`;
    const browser = new FastBrowser();
    try {
      await browser.open(`data:text/html,${encodeURIComponent(html)}`);
      const page = await browser.observe();
      const rects = await browser.evaluate<number>("document.getElementById('us').getClientRects().length");
      assert.ok(rects >= 2, `expected the link to wrap, got ${rects} line box(es)`);
      const unionCenterHitsAnchor = await browser.evaluate<boolean>(
        "(() => { const e = document.getElementById('us'); const r = e.getBoundingClientRect(); return e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()",
      );
      assert.equal(unionCenterHitsAnchor, false, "test setup: union center must miss the anchor to exercise the fix");

      const link = page.actions.find((a) => a.kind === "click" && /^United\s+States/.test(a.label));
      assert.ok(link, `wrapped link is offered as an action; got ${JSON.stringify(page.actions.map((a) => a.label))}`);
      assert.equal(page.covered_actions, 0);

      await browser.act(link);
      assert.equal(await browser.evaluate<boolean>("window.__hit === true"), true, "click landed on the anchor");
    } finally {
      await browser.close();
    }
  });

  it("indexes offscreen links ranked by goal overlap and clicks one by scrolling to it", { timeout: 30_000 }, async () => {
    process.env.CRACK_BOT_HEADLESS = "true";
    process.env.CRACK_BOT_CDP_DISCOVER = "false";
    delete process.env.CDP_URL;
    const filler = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i} of body text with no links in it.</p>`).join("");
    const html = `<!doctype html>
      <header><nav><a href="/menu">Main menu</a></nav></header>
      <main>
        <p>Above the fold: <a id="top" href="/wiki/Earth">Earth</a></p>
        ${filler}
        <p>Far below: <a id="venus" href="/wiki/Venus">Venus</a> and
           <a id="mars" href="javascript:void(0)" onclick="window.__mars=true">Mars</a> and
           <a id="jup" href="/wiki/Jupiter">Jupiter</a>.</p>
      </main>
      <footer><a href="/about">About</a><a href="/mars-footer">Mars in the footer</a></footer>`;
    const browser = new FastBrowser();
    try {
      await browser.open(`data:text/html,${encodeURIComponent(html)}`);
      const page = await browser.observe({ goal: "Reach the Mars article", topK: 5 });

      const viewport = page.actions.filter((a) => a.node != null && !a.offscreen).map((a) => a.label);
      assert.ok(viewport.includes("Earth"), "above-the-fold link is a viewport action");
      assert.ok(!viewport.includes("Mars"), "below-the-fold link is not a viewport action");

      const offscreen = page.actions.filter((a) => a.offscreen);
      assert.equal(offscreen.length, 5, `top-K of ${page.indexed_candidates} offscreen candidates are offered`);
      assert.equal(offscreen[0].label, "Mars", "goal-overlapping main-content link ranks first");
      assert.equal(offscreen[0].main, true);
      assert.equal(offscreen[0].offscreen, "below");
      const marsFooter = offscreen.find((a) => a.label === "Mars in the footer");
      assert.ok(marsFooter && (marsFooter.score ?? 0) < (offscreen[0].score ?? 0), "chrome link ranks below the main-content match");
      assert.equal(offscreen[1].label, "Mars in the footer", "goal overlap still beats non-matching main links");
      assert.equal(page.indexed_candidates, 5);

      await browser.act(offscreen[0]);
      assert.equal(await browser.evaluate<boolean>("window.__mars === true"), true, "scrolled to and clicked the offscreen link");
      assert.ok((await browser.evaluate<number>("scrollY")) > 0, "page scrolled to reach the target");
    } finally {
      await browser.close();
    }
  });

  it("BACK returns to the previous page only after an in-run navigation", { timeout: 30_000 }, async () => {
    process.env.CRACK_BOT_HEADLESS = "true";
    process.env.CRACK_BOT_CDP_DISCOVER = "false";
    delete process.env.CDP_URL;
    // Chrome refuses page-initiated navigation to data: URLs, so serve two real pages.
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(req.url === "/second" ? "<!doctype html><h1>Second</h1>" : '<!doctype html><a id="go" href="/second">Go</a>');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const browser = new FastBrowser();
    try {
      await browser.open(`http://127.0.0.1:${address.port}/`);
      const page = await browser.observe();
      assert.equal(browser.canGoBack, false);
      const go = page.actions.find((a) => a.label === "Go");
      await browser.act(go!);
      const after = await browser.observe();
      assert.ok(after.text.includes("Second"), `navigated, got ${after.url}`);
      assert.equal(browser.canGoBack, true);
      await browser.act({ id: "back", kind: "back", label: "back" });
      const back = await browser.observe();
      assert.ok(back.actions.some((a) => a.label === "Go"), "back on the first page");
      assert.equal(browser.canGoBack, false);
    } finally {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("a hung history navigation is a StalePage, not a dead run", { timeout: 30_000 }, async () => {
    process.env.CRACK_BOT_HEADLESS = "true";
    process.env.CRACK_BOT_CDP_DISCOVER = "false";
    delete process.env.CDP_URL;
    // First page is served once, then hangs forever. no-store keeps it out of
    // bfcache so goBack has to refetch it, and times out.
    let served = 0;
    let hanging = true;
    const pending: import("node:http").ServerResponse[] = [];
    const first = '<!doctype html><a id="go" href="/second">Go</a>';
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      res.setHeader("cache-control", "no-store");
      if (req.url === "/second") return void res.end("<!doctype html><h1>Second</h1>");
      if (served++ === 0 || !hanging) return void res.end(first);
      pending.push(res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const browser = new FastBrowser();
    try {
      await browser.open(`http://127.0.0.1:${address.port}/`);
      const page = await browser.observe();
      await browser.act(page.actions.find((a) => a.label === "Go")!);
      await browser.observe();
      assert.equal(browser.canGoBack, true);
      await assert.rejects(browser.back(1500), StalePage);
      assert.equal(browser.canGoBack, true, "the failed back did not consume the history entry");
    } finally {
      // Let the hung navigation finish; page.close() waits on it otherwise.
      hanging = false;
      for (const res of pending) res.end(first);
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("attaches files to a hidden file input and answers a native chooser", { timeout: 30_000 }, async () => {
    process.env.CRACK_BOT_HEADLESS = "true";
    process.env.CRACK_BOT_CDP_DISCOVER = "false";
    delete process.env.CDP_URL;
    const dir = mkdtempSync(join(tmpdir(), "crack-bot-upload-"));
    const photo = join(dir, "mug.png");
    writeFileSync(photo, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
    const html = `<!doctype html>
      <section><h2>Photo and video</h2>
        <button type="button" onclick="document.getElementById('in').click()">+ Upload</button>
        <input id="in" type="file" accept="image/*" multiple style="display:none"
          onchange="document.getElementById('n').textContent=this.files.length+' attached'">
        <p id="n">0 attached</p>
      </section>`;
    const browser = new FastBrowser();
    try {
      await browser.open(`data:text/html,${encodeURIComponent(html)}`);
      const page = await browser.observe();
      const input = page.actions.find((a) => a.kind === "upload");
      assert.ok(input, "hidden file input is indexed");
      assert.equal(input.label, "+ Upload", "labelled from the nearby styled button");
      assert.equal(input.accept, "image/*");
      assert.equal(input.multiple, true);

      // Direct path: set files on the node, no dialog.
      assert.equal(await browser.upload(input, [photo]), 1);
      assert.match((await browser.observe()).text, /1 attached/);
      const after = (await browser.observe()).actions.find((a) => a.kind === "upload");
      assert.equal(after?.value, "1", "snapshot reports the attached count");

      // Human path: the styled button opens a chooser; the handler answers it.
      browser.fileChooserHandler = () => [photo, photo];
      const button = page.actions.find((a) => a.label === "+ Upload" && a.kind === "click");
      await browser.act(button!);
      await browser.observe();
      assert.deepEqual(browser.takeChooser(), { multiple: true, attached: 2 });
      assert.match((await browser.observe()).text, /2 attached/);
    } finally {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops controls hidden under a modal and tags the modal's dismiss button", { timeout: 30_000 }, async () => {
    process.env.JEV_HEADLESS = "true";
    process.env.JEV_CDP_DISCOVER = "false";
    delete process.env.CDP_URL;
    const html = `<!doctype html>
      <input id="q" aria-label="Search" style="position:absolute;left:20px;top:20px;width:300px">
      <button id="go" style="position:absolute;left:20px;top:80px">Go</button>
      <div id="wall" style="position:fixed;inset:0;background:rgba(0,0,0,.5)">
        <div role="dialog" style="position:absolute;left:10px;top:10px;width:400px;height:200px;background:#fff">
          <p>Thank you</p>
          <button id="donate">I already donated</button>
          <button id="close" aria-label="Close">×</button>
        </div>
      </div>`;
    const browser = new FastBrowser();
    try {
      await browser.open(`data:text/html,${encodeURIComponent(html)}`);
      const page = await browser.observe();
      const labels = page.actions.filter((a) => a.node != null).map((a) => a.label);
      assert.ok(!labels.includes("Search"), "covered search box must not be offered");
      assert.ok(!labels.includes("Go"), "covered Go button must not be offered");
      assert.ok((page.covered_actions ?? 0) >= 2);
      const close = page.actions.find((a) => a.label === "Close");
      const donated = page.actions.find((a) => a.label === "I already donated");
      assert.ok(close?.overlay != null && close.dismiss === true, "Close is a dismiss control of the overlay");
      assert.ok(donated?.overlay === close.overlay && donated.dismiss === true);

      await browser.act(close);
      await browser.goto(
        `data:text/html,${encodeURIComponent(html.replace('id="wall" style="position:fixed;inset:0', 'id="wall" style="display:none'))}`,
      );
      const after = await browser.observe();
      const search = after.actions.find((a) => a.label === "Search" && a.kind === "fill");
      assert.ok(search && search.overlay == null, "search is offered again once the wall is gone");
    } finally {
      await browser.close();
    }
  });
});
