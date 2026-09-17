import assert from "node:assert/strict";
import { test } from "node:test";
import { abortFastWebTask, fillFastWebTask } from "./agent.ts";

test("fast_web_fill requires a paused TYPE_TEXT", async () => {
  await abortFastWebTask();
  await assert.rejects(() => fillFastWebTask("Zurich"), /No TYPE_TEXT is waiting/);
});
