import assert from "node:assert/strict";
import { test } from "node:test";
import { freshRecovery, madeProgress, recoveryFor } from "./progress.ts";

test("madeProgress: URL change always counts, content change only for page actions", () => {
  assert.equal(madeProgress("click", { urlChanged: true, textChanged: false }, true), true);
  assert.equal(madeProgress("click", { urlChanged: false, textChanged: true }, true), true);
  assert.equal(madeProgress("click", { urlChanged: false, textChanged: false }, true), false);
  assert.equal(madeProgress("scroll", { urlChanged: false, textChanged: true }, true), false, "scrolling is not progress");
  assert.equal(madeProgress("wait", { urlChanged: false, textChanged: true }, true), false);
  assert.equal(madeProgress("back", { urlChanged: true, textChanged: true }, true), true);
  assert.equal(madeProgress("click", { urlChanged: true, textChanged: true }, false), false, "a failed action never counts");
});

test("recoveryFor tries scroll down, scroll up, then back, each once, before stopping", () => {
  const tried = freshRecovery();
  const base = { streak: 0, limit: 3, canScrollDown: true, canScrollUp: true, canGoBack: true, tried };

  let r = recoveryFor(base);
  assert.deepEqual("operation" in r && r.operation, "SCROLL_DOWN");
  tried.scrollDown = true;

  r = recoveryFor({ ...base, streak: 1 });
  assert.deepEqual("operation" in r && r.operation, "SCROLL_UP");
  tried.scrollUp = true;

  r = recoveryFor({ ...base, streak: 2 });
  assert.deepEqual("operation" in r && r.operation, "BACK");
  tried.back = true;

  r = recoveryFor({ ...base, streak: 2 });
  assert.ok("stop" in r && /every recovery was tried/.test(r.reason));
});

test("recoveryFor stops as soon as the no-progress gate trips", () => {
  const r = recoveryFor({
    streak: 3,
    limit: 3,
    canScrollDown: true,
    canScrollUp: true,
    canGoBack: true,
    tried: freshRecovery(),
  });
  assert.ok("stop" in r && /No progress after 3/.test(r.reason));
});

test("recoveryFor skips unavailable moves", () => {
  const r = recoveryFor({
    streak: 0,
    limit: 3,
    canScrollDown: false,
    canScrollUp: false,
    canGoBack: true,
    tried: freshRecovery(),
  });
  assert.deepEqual("operation" in r && r.operation, "BACK");
  const none = recoveryFor({
    streak: 0,
    limit: 3,
    canScrollDown: false,
    canScrollUp: false,
    canGoBack: false,
    tried: freshRecovery(),
  });
  assert.ok("stop" in none);
});
