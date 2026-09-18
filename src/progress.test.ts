import assert from "node:assert/strict";
import { test } from "node:test";
import { madeProgress, margin, shouldAsk } from "./progress.ts";

test("madeProgress: URL change always counts, content change only for page actions", () => {
  assert.equal(madeProgress("click", { urlChanged: true, textChanged: false }, true), true);
  assert.equal(madeProgress("click", { urlChanged: false, textChanged: true }, true), true);
  assert.equal(madeProgress("click", { urlChanged: false, textChanged: false }, true), false);
  assert.equal(madeProgress("scroll", { urlChanged: false, textChanged: true }, true), false, "scrolling is not progress");
  assert.equal(madeProgress("wait", { urlChanged: false, textChanged: true }, true), false);
  assert.equal(madeProgress("back", { urlChanged: true, textChanged: true }, true), true);
  assert.equal(madeProgress("click", { urlChanged: true, textChanged: true }, false), false, "a failed action never counts");
});

test("margin is the gap between the top two probabilities", () => {
  assert.equal(margin({ a: 0.98, b: 0.01, c: 0.01 }), 0.97);
  assert.equal(margin({ a: 0.54, b: 0.37, c: 0.05 })?.toFixed(2), "0.17");
  assert.equal(margin({ a: 1 }), undefined);
});

// Numbers below are Jev's real answers on Wikipedia pages (2026-09-17).
const MIN = 0.2;

test("shouldAsk: a present goal link (Earth page, Mars goal) is not asked", () => {
  assert.equal(
    shouldAsk({
      operation: "CLICK",
      operationProbabilities: { CLICK: 0.98, SCROLL_DOWN: 0.01, TYPE_TEXT: 0.01 },
      targetProbabilities: { "75": 0.98, "3": 0.01, "40": 0.01 },
      minMargin: MIN,
    }),
    undefined,
  );
});

test("shouldAsk: a low-but-unambiguous pick is not asked", () => {
  assert.equal(
    shouldAsk({
      operation: "CLICK",
      operationProbabilities: { CLICK: 0.6, BLOCKED: 0.3 },
      targetProbabilities: { "12": 0.4, "7": 0.05, "9": 0.05 },
      minMargin: MIN,
    }),
    undefined,
    "0.40 vs 0.05 across many options is decisive",
  );
});

test("shouldAsk: BLOCKED always asks (Packers page, link-only Mars goal)", () => {
  assert.equal(
    shouldAsk({ operation: "BLOCKED", operationProbabilities: { BLOCKED: 0.86, CLICK: 0.09 }, targetProbabilities: {}, minMargin: MIN }),
    "blocked",
  );
  assert.equal(shouldAsk({ operation: "", operationProbabilities: {}, targetProbabilities: {}, minMargin: MIN }), "blocked");
});

test("shouldAsk: two constructive operations tied is not a dilemma (form: CLICK 0.49 vs UPLOAD 0.38)", () => {
  assert.equal(
    shouldAsk({
      operation: "CLICK",
      operationProbabilities: { CLICK: 0.49, UPLOAD: 0.38, TYPE_TEXT: 0.1 },
      targetProbabilities: { "13": 0.9 },
      minMargin: MIN,
    }),
    undefined,
  );
  assert.equal(
    shouldAsk({
      operation: "CLICK",
      operationProbabilities: { CLICK: 0.5, DONE: 0.4 },
      targetProbabilities: { "13": 0.9 },
      minMargin: MIN,
    }),
    "torn_operation",
    "a tie with DONE is a real question",
  );
});

test("shouldAsk: torn between operations (United States page: BLOCKED 0.54 vs CLICK 0.37)", () => {
  assert.equal(
    shouldAsk({
      operation: "CLICK",
      operationProbabilities: { CLICK: 0.54, BLOCKED: 0.37, SCROLL_DOWN: 0.05 },
      targetProbabilities: { "20": 0.9 },
      minMargin: MIN,
    }),
    "torn_operation",
  );
});

test("shouldAsk: torn between targets (Earth page with routing wording: Mars 0.78 vs Solar System 0.19 is NOT torn; 0.45 vs 0.40 is)", () => {
  assert.equal(
    shouldAsk({
      operation: "CLICK",
      operationProbabilities: { CLICK: 0.98 },
      targetProbabilities: { "75": 0.78, "40": 0.19, "41": 0.03 },
      minMargin: MIN,
    }),
    undefined,
  );
  assert.equal(
    shouldAsk({
      operation: "CLICK",
      operationProbabilities: { CLICK: 0.98 },
      targetProbabilities: { "75": 0.45, "40": 0.4, "41": 0.15 },
      minMargin: MIN,
    }),
    "torn_target",
  );
});

test("shouldAsk: a near-tie with site chrome is not a tie (United States page: Mars Exploration Program 0.53 vs Wikipedia logo 0.32)", () => {
  const ctx = {
    operation: "CLICK",
    operationProbabilities: { CLICK: 0.9 },
    targetProbabilities: { "82": 0.5, "1": 0.35, "3": 0.07 },
    minMargin: MIN,
  };
  assert.equal(shouldAsk(ctx), "torn_target", "without chrome info it looks torn");
  assert.equal(shouldAsk({ ...ctx, chromeTargets: new Set(["1", "3"]) }), undefined, "chrome excluded, content pick is clear");
  assert.equal(
    shouldAsk({ ...ctx, targetProbabilities: { "82": 0.43, "40": 0.28 }, chromeTargets: new Set(["1"]) }),
    "torn_target",
    "two content links close together is still a real tie",
  );
});

test("shouldAsk: target margin is ignored for operations without a target head", () => {
  assert.equal(
    shouldAsk({ operation: "SCROLL_DOWN", operationProbabilities: { SCROLL_DOWN: 0.9 }, targetProbabilities: { a: 0.5, b: 0.5 }, minMargin: MIN }),
    undefined,
  );
});
