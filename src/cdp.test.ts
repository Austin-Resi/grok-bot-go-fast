import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cdpEndpoint,
  defaultProfileDirs,
  devToolsEndpoint,
  discoverCdpUrl,
  isWebSocketUrl,
  normalizeDisplay,
  parseChromeProcesses,
  parseRemoteDebuggingPort,
  parseUserDataDirs,
  probePort,
  readDevToolsActivePort,
  scopeToDisplay,
} from "./cdp.ts";

const MULTI_AGENT_PS = [
  "  411 /opt/google/chrome/chrome --user-data-dir=/home/bot/chrome-profile-5 --remote-debugging-port=0",
  "  412 /opt/google/chrome/chrome --type=renderer --user-data-dir=/home/bot/chrome-profile-5",
  "  520 /opt/google/chrome/chrome --user-data-dir=/home/bot/chrome-profile-10 --remote-debugging-port=0",
  "  777 /opt/google/chrome/chrome --user-data-dir=/home/bot/chrome-profile-14 --remote-debugging-port=0",
  "  778 /opt/google/chrome/chrome --type=gpu-process --user-data-dir=/home/bot/chrome-profile-14",
  "  900 node /home/bot/crack-bot/node_modules/.bin/tsx src/index.ts",
  "  901 grep chrome",
].join("\n");

const DISPLAY_BY_PID: Record<number, string | undefined> = { 411: ":5", 520: ":10", 777: ":14.0" };

test("parseRemoteDebuggingPort reads a live port", () => {
  const args = "/usr/bin/google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/bot";
  assert.equal(parseRemoteDebuggingPort(args), 9222);
  assert.equal(cdpEndpoint(9222), "http://127.0.0.1:9222");
});

test("parseRemoteDebuggingPort ignores pipe and port 0", () => {
  assert.equal(parseRemoteDebuggingPort("chrome --remote-debugging-pipe"), undefined);
  assert.equal(parseRemoteDebuggingPort("chrome --remote-debugging-port=0"), undefined);
  assert.equal(parseRemoteDebuggingPort("chrome --remote-debugging-port 9333"), 9333);
});

test("parseUserDataDirs collects every Chrome profile in ps output", () => {
  const args = [
    "/opt/google/chrome/chrome --user-data-dir=/home/bot/.config/google-chrome --remote-debugging-pipe",
    '/usr/bin/chromium --user-data-dir="/tmp/with space/profile"',
    "node server.js",
  ].join("\n");
  assert.deepEqual(parseUserDataDirs(args), ["/home/bot/.config/google-chrome", "/tmp/with space/profile"]);
});

test("parseChromeProcesses keeps browser processes only", () => {
  const procs = parseChromeProcesses(MULTI_AGENT_PS);
  assert.deepEqual(
    procs.map((p) => [p.pid, p.userDataDir]),
    [
      [411, "/home/bot/chrome-profile-5"],
      [520, "/home/bot/chrome-profile-10"],
      [777, "/home/bot/chrome-profile-14"],
    ],
  );
});

test("scopeToDisplay keeps only this agent's Chrome and drops unknown displays", () => {
  const procs = parseChromeProcesses(MULTI_AGENT_PS);
  const read = (pid: number) => DISPLAY_BY_PID[pid];
  assert.deepEqual(scopeToDisplay(procs, ":14", read).map((p) => p.userDataDir), ["/home/bot/chrome-profile-14"]);
  assert.deepEqual(scopeToDisplay(procs, ":10", read).map((p) => p.userDataDir), ["/home/bot/chrome-profile-10"]);
  assert.deepEqual(scopeToDisplay(procs, ":9", read), []);
  assert.deepEqual(scopeToDisplay(procs, ":14", () => undefined), [], "unreadable environ is never a match");
});

test("normalizeDisplay treats screen suffixes and hosts as the same display", () => {
  assert.equal(normalizeDisplay(":14"), ":14");
  assert.equal(normalizeDisplay(":14.0"), ":14");
  assert.equal(normalizeDisplay("localhost:14.0"), ":14");
  assert.equal(normalizeDisplay("unix:14"), ":14");
});

test("defaultProfileDirs covers linux, mac, and windows", () => {
  assert.ok(defaultProfileDirs("linux", "/home/bot").some((d) => d.endsWith("/.config/google-chrome")));
  assert.ok(defaultProfileDirs("darwin", "/Users/bot").some((d) => d.endsWith("Application Support/Google/Chrome")));
  assert.ok(defaultProfileDirs("win32", "C:\\Users\\bot").some((d) => /Chrome[\\/]User Data$/.test(d)));
});

test("readDevToolsActivePort parses the chrome://inspect ws-only endpoint", () => {
  const dir = mkdtempSync(join(tmpdir(), "crack-bot-profile-"));
  try {
    writeFileSync(join(dir, "DevToolsActivePort"), "9222\n/devtools/browser/0f1e2d3c\n");
    const active = readDevToolsActivePort(dir);
    assert.deepEqual(active, { port: 9222, path: "/devtools/browser/0f1e2d3c" });
    assert.equal(devToolsEndpoint(active!), "ws://127.0.0.1:9222/devtools/browser/0f1e2d3c");

    writeFileSync(join(dir, "DevToolsActivePort"), "garbage\n");
    assert.equal(readDevToolsActivePort(dir), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readDevToolsActivePort returns undefined for a missing profile", () => {
  assert.equal(readDevToolsActivePort("/nonexistent/profile"), undefined);
});

test("probePort reports a listening socket and a closed one", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    assert.equal(await probePort(address.port), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await probePort(address.port), false);
});

test("discoverCdpUrl passes ws:// CDP_URL through without an HTTP probe", async () => {
  const previous = process.env.CDP_URL;
  process.env.CDP_URL = "ws://127.0.0.1:9222/devtools/browser/abc";
  try {
    assert.ok(isWebSocketUrl(process.env.CDP_URL));
    assert.equal(await discoverCdpUrl(), "ws://127.0.0.1:9222/devtools/browser/abc");
  } finally {
    if (previous == null) delete process.env.CDP_URL;
    else process.env.CDP_URL = previous;
  }
});

test("discoverCdpUrl rejects an http CDP_URL that does not answer /json/version", async () => {
  const server = createHttpServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const previous = process.env.CDP_URL;
  process.env.CDP_URL = `http://127.0.0.1:${address.port}`;
  try {
    await assert.rejects(() => discoverCdpUrl(), /DevToolsActivePort/);
  } finally {
    if (previous == null) delete process.env.CDP_URL;
    else process.env.CDP_URL = previous;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
