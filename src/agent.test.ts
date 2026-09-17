import assert from "node:assert/strict";
import { test } from "node:test";
import { abortFastWebTask, fillFastWebTask, startFastWebTask } from "./agent.ts";

test("fast_web_fill requires a paused TYPE_TEXT", async () => {
  await abortFastWebTask();
  await assert.rejects(() => fillFastWebTask("Zurich"), /No TYPE_TEXT is waiting/);
});

test("fast_web_task requires a url unless reuseBrowser", async () => {
  await abortFastWebTask();
  await assert.rejects(() => startFastWebTask({ goal: "look around" }), /Provide a url/);
});

test("reuseBrowser requires an open session", async () => {
  await abortFastWebTask();
  await assert.rejects(
    () => startFastWebTask({ goal: "keep looking", reuseBrowser: true }),
    /No open browser/,
  );
});
