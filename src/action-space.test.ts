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
});
