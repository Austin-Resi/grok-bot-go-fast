import assert from "node:assert/strict";
import { test } from "node:test";
import { freshRecovery, madeProgress, recoveryFor, type RecoveryContext } from "./progress.ts";

test("madeProgress: URL change always counts, content change only for page actions", () => {
  assert.equal(madeProgress("click", { urlChanged: true, textChanged: false }, true), true);
  assert.equal(madeProgress("click", { urlChanged: false, textChanged: true }, true), true);
  assert.equal(madeProgress("click", { urlChanged: false, textChanged: false }, true), false);
  assert.equal(madeProgress("scroll", { urlChanged: false, textChanged: true }, true), false, "scrolling is not progress");
  assert.equal(madeProgress("wait", { urlChanged: false, textChanged: true }, true), false);
  assert.equal(madeProgress("back", { urlChanged: true, textChanged: true }, true), true);
  assert.equal(madeProgress("click", { urlChanged: true, textChanged: true }, false), false, "a failed action never counts");
});

const northAmerica = (over: Partial<RecoveryContext> = {}): RecoveryContext => ({
  streak: 0,
  limit: 3,
  canScrollDown: true,
  canScrollUp: false,
  canGoBack: true,
  tried: freshRecovery(),
  candidates: [
    { index: "80", node: 900, label: "Earth", score: 5.5 },
    { index: "81", node: 901, label: "Continent", score: 1.5 },
  ],
  deadEnd: false,
  ...over,
});

test("soak regression: BLOCKED after a valid hop tries goal-ranked links, never BACK", () => {
  // United States -> North America was a valid hop; the page has candidates.
  const ctx = northAmerica();
  let r = recoveryFor(ctx);
  assert.ok("candidate" in r && r.candidate.label === "Earth", "best goal-ranked offscreen link first");
  ctx.tried.candidates.add(900);

  r = recoveryFor({ ...ctx, streak: 1 });
  assert.ok("candidate" in r && r.candidate.label === "Continent", "then the next candidate");
  ctx.tried.candidates.add(901);

  r = recoveryFor({ ...ctx, streak: 2 });
  assert.ok("operation" in r && r.operation === "SCROLL_DOWN", "then scroll");
  ctx.tried.scrollDown = true;

  r = recoveryFor({ ...ctx, streak: 2 });
  assert.ok("stop" in r, "BACK is not offered on a page that has goal-shaped controls");
});

test("BACK only on a dead end, after candidates and scrolls are exhausted", () => {
  const tried = freshRecovery();
  tried.scrollDown = true;
  const ctx = northAmerica({ candidates: [], deadEnd: true, tried, canScrollDown: true, canScrollUp: false });
  const r = recoveryFor(ctx);
  assert.ok("operation" in r && r.operation === "BACK");
  tried.back = true;
  assert.ok("stop" in recoveryFor(ctx), "BACK is tried once");
});

test("a dead end without history stops instead of BACK", () => {
  const tried = freshRecovery();
  tried.scrollDown = true;
  const r = recoveryFor(northAmerica({ candidates: [], deadEnd: true, tried, canGoBack: false }));
  assert.ok("stop" in r);
});

test("recovery stops as soon as the no-progress gate trips", () => {
  const r = recoveryFor(northAmerica({ streak: 3 }));
  assert.ok("stop" in r && /No progress after 3/.test(r.reason));
});

test("scroll recovery skips directions that are not available", () => {
  const r = recoveryFor(northAmerica({ candidates: [], canScrollDown: false, canScrollUp: true }));
  assert.ok("operation" in r && r.operation === "SCROLL_UP");
});
