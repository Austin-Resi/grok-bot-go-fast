# Connect Jev to Grok Bot

This plugin runs the **full fast computer-use loop** on the Bot's computer: snapshot live DOM nodes → Jev on **Vercel AI Gateway** (`typesafe-ai/jev`) → click that node. Grok Bot should call `fast_web_task` and not screenshot-click. When a text field is needed, the tool returns `need_text` and Grok Bot calls `fast_web_fill` with the string. When the result says `open: true` the browser stays open until `fast_web_abort`, or continue with `reuseBrowser: true`.

## 1. Gateway key

1. Open [AI Gateway API keys](https://vercel.com/d?to=%2Fai-gateway%2Fapi-keys).
2. Create a key.
3. Put it in `.env` as `AI_GATEWAY_API_KEY`.

Jev is listed as [typesafe-ai/jev](https://vercel.com/ai-gateway/models/jev). It is an evaluation model, not a chat model.

## 2. Install on the Bot computer

```bash
npm install
npx playwright install chromium
cp .env.example .env
# AI_GATEWAY_API_KEY=...
```

## 3. Use the Bot's own Chrome (best when it works)

Jev attaches to the Bot's Chrome when it exposes a DevTools endpoint. You get the Bot's cookies and logins, the tab is brought to front before each click so the Bot can watch it, and on `blocked` screenshot computer use continues on the same tab.

Chrome 144+ can turn this on at runtime, no relaunch or flags needed. Ask the Bot to:

1. In its browser, open `chrome://inspect/#remote-debugging` and enable **Allow remote debugging for this browser instance**.
2. Run `cat ~/.config/google-chrome/DevToolsActivePort` (Linux) or `cat ~/Library/Application\ Support/Google/Chrome/DevToolsActivePort` (macOS). Two lines: a port and a `/devtools/browser/<id>` path. If the profile lives elsewhere, `ps -eo args | grep -o -- '--user-data-dir=[^ ]*'` shows the directory.
3. Start `fast_web_task`. Chrome shows a permission dialog the first time Jev connects; the Bot clicks **Allow**. Jev keeps one connection open across tasks, so this happens once per Chrome session.

Leave `CDP_URL` unset. Jev finds Chrome browser processes in `ps`, reads each one's `DISPLAY` from `/proc/<pid>/environ`, and keeps only those on **this agent's** `DISPLAY` (the one the MCP server inherits, which is the Computer view). From those it reads `DevToolsActivePort`, confirms the port is listening, and connects to `ws://127.0.0.1:<port><path>`. On a multi-agent box with many `chrome-profile-*` on `:5`, `:9`, `:14`, … it will only ever attach to the Chrome on your display. If no Chrome on this display exposes DevTools, Jev does **not** fall back to another agent's Chrome; it launches its own headed Chromium on this `DISPLAY` so the page still shows in your Computer view.

The result reports `attached`, `attachedTo` (profile dir) and `display` so you can confirm which Chrome is being driven.

Overrides:

- `JEV_CDP_PROFILE_DIR=/home/bot/chrome-profile-14` pins one profile; Jev errors if it has no live `DevToolsActivePort`.
- `JEV_CDP_DISPLAY=:14` scopes discovery to a display other than the inherited `DISPLAY`.
- `CDP_URL=ws://…` pins the endpoint. Use the full `ws://` URL from that profile's `DevToolsActivePort` (it changes on every Chrome restart), not `http://`, and make sure it is **your** agent's Chrome.
- `JEV_CDP_DISCOVER=false` always launches Jev's own Chromium.

Without `/proc` (macOS, Windows) there is one user session, so discovery checks all Chromes and the default profile directories, and also falls back to `--remote-debugging-port=<n>` / `http://127.0.0.1:9222` for Chrome launched with the legacy flag.

Do not `curl /json/version` to check: the `chrome://inspect` flow exposes only the WebSocket endpoint and returns 404 there.

When attached, `fast_web_abort` closes only the Jev tab and never quits Chrome. Finished runs leave the tab open for handoff (`open: true`); a `done` run in Jev's own Chromium closes it. Override with `keepOpen`.

## Dialogs and time budget

Controls hidden under a modal or cookie wall are never offered to Jev. Controls inside a dialog or a large fixed banner are tagged, and their Close / Dismiss / No thanks / I already donated buttons are marked as dismiss controls. If Jev chooses `TYPE_TEXT` on a field outside an open banner, the loop clicks the banner's dismiss control first and decides again, so the Bot is never asked for `need_text` on a field that is about to be covered. A covered or vanished target counts as a step and is recorded as failed, so the loop cannot spin.

Every call returns within `JEV_MAX_RUN_MS` (default 45000, below the usual 60s MCP client timeout) with `status: "budget"` and the tab open. Continue with `reuseBrowser: true`. Per-call `maxMs` can lower it.

## 4. Attach the MCP server

Tell Grok Bot:

> Add a custom MCP server named `jev`. Command: `npx`. Args: `--yes tsx ./src/index.ts`. Working directory: this repo. Env: `AI_GATEWAY_API_KEY` from my saved secret.

Or install this folder as a plugin (`.grok-plugin/plugin.json`).

## 5. Smoke test

> Call `jev_decide` with state "The support agent issued a full refund." and boolean question `refunded`: "Was a refund issued?"

Then:

> Use `fast_web_task` to open https://example.com and stop when the Example Domain heading is visible. Do not use screenshot computer use.

If a form is involved:

> If status is `need_text`, write the field value from the goal and call `fast_web_fill`. Do not screenshot.

## If it fails

- `Missing AI_GATEWAY_API_KEY` — the MCP process cannot see the key.
- Playwright/browser errors — run `npx playwright install chromium`.
- `attached` is false but you enabled remote debugging — check that `DevToolsActivePort` exists in the Bot's Chrome profile and that the Bot clicked **Allow** on Chrome's permission dialog. On Linux also confirm `DISPLAY` in the MCP server's environment matches the Chrome's (`cat /proc/<chrome pid>/environ | tr '\0' '\n' | grep DISPLAY`); if the server was started without `DISPLAY`, set `JEV_CDP_DISPLAY`.
- `attached` is true but the page appears in another agent's Computer view — the result's `attachedTo` / `display` show which Chrome was chosen. Set `JEV_CDP_PROFILE_DIR` to your profile, or make sure `DISPLAY` is set for the server.
- `status: "budget"` after ~45s — normal. Continue with `fast_web_task({ reuseBrowser: true, goal })`.
- Evaluation errors — Jev is not available on `/chat/completions`. This MCP uses the AI SDK `evaluate` API.
- Still slow — the Bot used pixel computer use instead of `fast_web_task`.
