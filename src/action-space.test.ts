import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { actionSpace } from "./action-space.ts";

describe("actionSpace", () => {
  it("maps fill+click on one node and keeps a live action for Jev's index", () => {
    const space = actionSpace(
      {
        url: "https://example.com",
        title: "Example",
        text: "Search",
        actions: [
          { id: "e1", kind: "fill", node: 4, role: "combobox", label: "Where from?", value: "" },
          { id: "e2", kind: "click", node: 4, role: "combobox", label: "Open Where from?", value: "" },
          { id: "e3", kind: "click", node: 9, role: "button", label: "Search", value: "" },
          { id: "wait", kind: "wait", label: "Wait for the page to update" },
        ],
      },
      "Search Zurich",
      [],
    );

    assert.equal(space.input.elements.length, 2);
    assert.deepEqual(space.input.elements[0].operations.sort(), ["CLICK", "TYPE_TEXT"]);
    assert.equal(space.input.extraOperations?.WAIT, "Wait for the page to update");
    assert.equal(space.resolve("TYPE_TEXT", "1")?.id, "e1");
    assert.equal(space.resolve("CLICK", "2")?.id, "e3");
    assert.equal(space.resolve("WAIT", null)?.kind, "wait");
    assert.deepEqual(space.input.overlays, []);
    assert.equal(space.dismissFor(new Set()), undefined);
  });

  it("surfaces overlay dismiss controls and skips overlays already tried", () => {
    const space = actionSpace(
      {
        url: "https://www.wikipedia.org",
        title: "Wikipedia",
        text: "Thank you",
        actions: [
          { id: "e1", kind: "fill", node: 1, role: "searchbox", label: "Search Wikipedia", value: "" },
          { id: "e2", kind: "click", node: 7, role: "button", label: "I already donated", overlay: 40, dismiss: true },
          { id: "e3", kind: "click", node: 8, role: "button", label: "Close", overlay: 40, dismiss: true },
          { id: "e4", kind: "click", node: 9, role: "link", label: "Donate now", overlay: 40 },
        ],
      },
      "Search Packers",
      [],
    );

    assert.deepEqual(space.input.overlays, [
      { id: "overlay-40", dismiss_controls: ["[2] I already donated", "[3] Close"] },
    ]);
    assert.equal(space.input.elements[3].overlay, "overlay-40");
    assert.equal(space.input.elements[3].dismiss, undefined);
    assert.equal(space.input.elements[0].overlay, undefined);

    const first = space.dismissFor(new Set());
    assert.equal(first?.index, "2");
    assert.equal(first?.overlay, 40);
    assert.equal(space.dismissFor(new Set([40])), undefined);
  });

  it("offers offscreen candidates, dedupes them against viewport nodes, and exposes BACK/scroll", () => {
    const space = actionSpace(
      {
        url: "https://en.wikipedia.org/wiki/Earth",
        title: "Earth",
        text: "Earth is the third planet",
        actions: [
          { id: "e1", kind: "click", node: 1, role: "link", label: "Main menu", value: "" },
          { id: "e2", kind: "click", node: 2, role: "link", label: "Solar System", value: "", href: "/wiki/Solar_System", main: true },
          { id: "o1", kind: "click", node: 9, role: "link", label: "Mars", value: "", href: "/wiki/Mars", main: true, offscreen: "below", score: 4 },
          { id: "o2", kind: "click", node: 2, role: "link", label: "Solar System", value: "", offscreen: "below" },
          { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
          { id: "wait", kind: "wait", label: "Wait for the page to update" },
        ],
      },
      "Reach the Mars article",
      [],
      { canGoBack: true, progress: { visited_urls: ["a", "b"], no_progress_steps: 1, step: 3, max_steps: 40 } },
    );

    assert.equal(space.input.elements.length, 3, "offscreen duplicate of node 2 is not offered twice");
    const mars = space.input.elements[2];
    assert.equal(mars.label, "Mars");
    assert.equal(mars.offscreen, "below");
    assert.equal(mars.main, true);
    assert.equal(mars.href, "/wiki/Mars");
    assert.equal(space.resolve("CLICK", "3")?.id, "o1");
    assert.equal(space.input.extraOperations?.BACK !== undefined, true);
    assert.equal(space.resolve("BACK", null)?.kind, "back");
    assert.equal(space.canScroll("down"), true);
    assert.equal(space.canScroll("up"), false);
    assert.equal(space.input.progress?.no_progress_steps, 1);
  });

  it("offers file inputs as UPLOAD only when the Bot provided files", () => {
    const page = {
      url: "https://shop.example/listing/new",
      title: "New listing",
      text: "Photo and video",
      actions: [
        { id: "e1", kind: "upload" as const, node: 3, role: "button", label: "+ Upload", value: "0", accept: "image/*", multiple: true, main: true },
        { id: "e2", kind: "click" as const, node: 4, role: "button", label: "Save draft", value: "" },
      ],
    };
    const without = actionSpace(page, "create listing", []);
    assert.deepEqual(without.input.elements.map((e) => e.label), ["Save draft"]);

    const withFiles = actionSpace(page, "create listing", [], { providedFiles: ["photos"] });
    const upload = withFiles.input.elements[0];
    assert.equal(upload.label, "+ Upload");
    assert.deepEqual(upload.operations, ["UPLOAD"]);
    assert.deepEqual(upload.upload, { accept: "image/*", multiple: true, files_attached: 0 });
    assert.equal(withFiles.resolve("UPLOAD", "1")?.kind, "upload");
    assert.deepEqual(withFiles.input.providedFiles, ["photos"]);
  });

  it("does not offer BACK without navigation history", () => {
    const space = actionSpace(
      { url: "https://example.com", title: "x", text: "", actions: [{ id: "wait", kind: "wait", label: "Wait" }] },
      "anything",
      [],
    );
    assert.equal(space.input.extraOperations?.BACK, undefined);
    assert.equal(space.resolve("BACK", null), undefined);
  });
});
