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
  });
});
