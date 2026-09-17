import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FastBrowser } from "./browser.ts";

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
