import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FastBrowser } from "./browser.ts";

describe("FastBrowser", () => {
  it("snapshots a live button and clicks that node", { timeout: 30_000 }, async () => {
    process.env.JEV_HEADLESS = "true";
    process.env.JEV_CDP_DISCOVER = "false";
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
