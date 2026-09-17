import assert from "node:assert/strict";
import { test } from "node:test";
import { setting, settingIs } from "./env.ts";

function withEnv(values: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    saved[key] = process.env[key];
    if (values[key] == null) delete process.env[key];
    else process.env[key] = values[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(values)) {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("setting prefers CRACK_BOT_ and falls back to legacy JEV_", () => {
  withEnv({ CRACK_BOT_HEADLESS: "true", JEV_HEADLESS: "false" }, () => {
    assert.equal(setting("HEADLESS"), "true");
    assert.equal(settingIs("HEADLESS", "true"), true);
  });
  withEnv({ CRACK_BOT_HEADLESS: undefined, JEV_HEADLESS: "true" }, () => {
    assert.equal(setting("HEADLESS"), "true");
  });
  withEnv({ CRACK_BOT_HEADLESS: "  ", JEV_HEADLESS: undefined }, () => {
    assert.equal(setting("HEADLESS"), undefined);
    assert.equal(settingIs("HEADLESS", "true"), false);
  });
});
