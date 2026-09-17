import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUiActionQuestions } from "./choose-ui-action.ts";
import { resolveUiDecision } from "./format.ts";

describe("buildUiActionQuestions", () => {
  it("fans out operation plus matching target heads", () => {
    const built = buildUiActionQuestions({
      goal: "Search Zurich to London",
      page: { url: "https://www.google.com/travel/flights", title: "Google Flights" },
      elements: [
        {
          index: "2",
          role: "combobox",
          label: "Where from?",
          operations: ["CLICK", "TYPE_TEXT"],
          value: "",
        },
        {
          index: "7",
          role: "button",
          label: "Search",
          operations: ["CLICK"],
        },
      ],
    });

    assert.equal(built.questions.operation.type, "choice");
    assert.ok(built.questions.operation.criteria.CLICK);
    assert.ok(built.questions.operation.criteria.TYPE_TEXT);
    assert.ok(built.questions.operation.criteria.DONE);
    assert.ok(built.questions.click_target);
    assert.ok(built.questions.type_text_target);
    assert.equal(built.truncated, false);
  });
});

describe("resolveUiDecision", () => {
  it("uses only the target head that matches the chosen operation", () => {
    const decision = resolveUiDecision(
      {
        operation: {
          type: "choice",
          choice: "CLICK",
          probabilities: { CLICK: 0.9, TYPE_TEXT: 0.1 },
        },
        click_target: {
          type: "choice",
          choice: "7",
          probabilities: { "2": 0.1, "7": 0.9 },
        },
        type_text_target: {
          type: "choice",
          choice: "2",
          probabilities: { "2": 1 },
        },
      },
      { operation: 0.84, click_target: 0.8 },
    );

    assert.equal(decision.operation, "CLICK");
    assert.equal(decision.target, "7");
    assert.equal(decision.confidence, 0.84);
  });
});
