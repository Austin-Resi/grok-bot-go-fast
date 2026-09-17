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
});
