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

Leave `CDP_URL` unset. Jev reads `DevToolsActivePort` from every `--user-data-dir` in `ps` plus the default Chrome/Chromium profile dirs, confirms the port is listening, and connects to `ws://127.0.0.1:<port><path>`. It also falls back to `--remote-debugging-port=<n>` / `http://127.0.0.1:9222` for Chrome launched with the legacy flag. If neither is present, Jev launches its own Chromium.

Do not `curl /json/version` to check: the `chrome://inspect` flow exposes only the WebSocket endpoint and returns 404 there. If you pin `CDP_URL`, use the full `ws://` URL from `DevToolsActivePort` (it changes on every Chrome restart), not `http://`.

When attached, `fast_web_abort` closes only the Jev tab and never quits Chrome. Finished runs leave the tab open for handoff (`open: true`); a `done` run in Jev's own Chromium closes it. Override with `keepOpen`.

Set `JEV_CDP_DISCOVER=false` to always launch Jev's own Chromium.

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
- `attached` is false but you enabled remote debugging — check that `DevToolsActivePort` exists in the Bot's Chrome profile and that the Bot clicked **Allow** on Chrome's permission dialog.
- Evaluation errors — Jev is not available on `/chat/completions`. This MCP uses the AI SDK `evaluate` API.
- Still slow — the Bot used pixel computer use instead of `fast_web_task`.
