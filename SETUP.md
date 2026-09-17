# Connect Jev to Grok Bot

This plugin runs the **full fast computer-use loop** on the Bot's computer: snapshot live DOM nodes → Jev on **Vercel AI Gateway** (`typesafe-ai/jev`) → click that node. Grok Bot should call `fast_web_task` and not screenshot-click. When a text field is needed, the tool returns `need_text` and Grok Bot calls `fast_web_fill` with the string.

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

To attach to an already-running Chrome instead of Playwright's Chromium, set `CDP_URL=http://127.0.0.1:9222`.

## 3. Attach the MCP server

Tell Grok Bot:

> Add a custom MCP server named `jev`. Command: `npx`. Args: `--yes tsx ./src/index.ts`. Working directory: this repo. Env: `AI_GATEWAY_API_KEY=<the key>`.

Or install this folder as a plugin (`.grok-plugin/plugin.json`).

## 4. Smoke test

> Call `jev_decide` with state "The support agent issued a full refund." and boolean question `refunded`: "Was a refund issued?"

Then:

> Use `fast_web_task` to open https://example.com and stop when the Example Domain heading is visible. Do not use screenshot computer use.

If a form is involved:

> If status is `need_text`, write the field value from the goal and call `fast_web_fill`. Do not screenshot.

## If it fails

- `Missing AI_GATEWAY_API_KEY` — the MCP process cannot see the key.
- Playwright/browser errors — run `npx playwright install chromium`.
- Evaluation errors — Jev is not available on `/chat/completions`. This MCP uses the AI SDK `evaluate` API.
- Still slow — the Bot used pixel computer use instead of `fast_web_task`.
