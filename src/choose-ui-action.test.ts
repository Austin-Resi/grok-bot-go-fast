import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUiActionQuestions, type ChoiceQuestion } from "./choose-ui-action.ts";
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
    assert.ok((built.questions.operation as ChoiceQuestion).criteria.CLICK);
    assert.ok((built.questions.operation as ChoiceQuestion).criteria.TYPE_TEXT);
    assert.ok((built.questions.operation as ChoiceQuestion).criteria.DONE);
    assert.ok(built.questions.click_target);
    assert.ok(built.questions.type_text_target);
    assert.equal(built.truncated, false);
    assert.equal(built.questions.goal_done.type, "boolean", "independent goal watcher rides along");
    assert.equal(built.questions.stuck.type, "boolean", "independent stuck watcher rides along");
    assert.deepEqual(built.state.open_overlays, []);
    const rules = (built.questions.operation.instructions as { rules: string[] }).rules;
    assert.equal(rules.length, 1, "only the base rule when nothing is open and progress is fine");
  });

  it("adds the no-progress rule, BACK, and offscreen/main target hints", () => {
    const built = buildUiActionQuestions({
      goal: "Reach the Mars article",
      page: { url: "https://en.wikipedia.org/wiki/Earth" },
      elements: [
        { index: "1", role: "link", label: "Main menu", operations: ["CLICK"] },
        { index: "2", role: "link", label: "Mars", operations: ["CLICK"], offscreen: "below", main: true, href: "/wiki/Mars" },
      ],
      extraOperations: { BACK: "Go back", SCROLL_DOWN: "Scroll down" },
      progress: { visited_urls: ["https://en.wikipedia.org/wiki/Earth"], no_progress_steps: 2, step: 5, max_steps: 40 },
    });

    const rules = (built.questions.operation.instructions as { rules: string[] }).rules;
    assert.equal(rules.length, 2);
    assert.match(rules[1], /no_progress_steps/);
    assert.ok((built.questions.operation as ChoiceQuestion).criteria.BACK);
    assert.ok((built.questions.operation as ChoiceQuestion).criteria.SCROLL_DOWN);
    assert.equal(built.state.progress?.no_progress_steps, 2);
    const mars = (built.questions.click_target as ChoiceQuestion).criteria["2"] as Record<string, unknown>;
    assert.equal(mars.offscreen, "below");
    assert.equal(mars.main_content, true);
    assert.equal(mars.href, "/wiki/Mars");
  });

  it("adds the overlay rule and marks dismiss targets when a dismissible overlay is open", () => {
    const built = buildUiActionQuestions({
      goal: "Search Packers",
      page: { url: "https://www.wikipedia.org" },
      elements: [
        { index: "1", role: "searchbox", label: "Search Wikipedia", operations: ["TYPE_TEXT", "CLICK"] },
        { index: "2", role: "button", label: "Close", operations: ["CLICK"], overlay: "overlay-40", dismiss: true },
      ],
      overlays: [{ id: "overlay-40", dismiss_controls: ["[2] Close"] }],
    });

    const rules = (built.questions.operation.instructions as { rules: string[] }).rules;
    assert.ok(Array.isArray(rules) && rules.length === 2 && /dismiss/i.test(rules[1]));
    assert.deepEqual(built.state.open_overlays, [{ id: "overlay-40", dismiss_controls: ["[2] Close"] }]);
    const closeTarget = (built.questions.click_target as ChoiceQuestion).criteria["2"] as Record<string, unknown>;
    assert.equal(closeTarget.in_overlay, "overlay-40");
    assert.equal(closeTarget.dismisses_overlay, true);
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
        goal_done: { type: "boolean", probability: 0.07 },
        stuck: { type: "boolean", probability: 0.12 },
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
    assert.equal(decision.goalDone, 0.07);
    assert.equal(decision.stuck, 0.12);
  });

  it("watchers are null when the answers lack them", () => {
    const decision = resolveUiDecision({ operation: { type: "choice", choice: "DONE", probabilities: { DONE: 1 } } }, {});
    assert.equal(decision.goalDone, null);
    assert.equal(decision.stuck, null);
  });
});
