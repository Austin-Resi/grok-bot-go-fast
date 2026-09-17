---
name: jev-computer-use
description: Speeds up Grok Bot web computer use by delegating to fast_web_task. That tool snapshots live DOM nodes, asks TypeSafe Jev on Vercel AI Gateway what to click, and clicks the node. When a text field is needed, you write the string and call fast_web_fill. Use for forms, search, browsing, and any site with normal HTML controls. Do not screenshot-click those pages.
---

# Jev computer use

For a website or web app, call **`fast_web_task`**. Do not screenshot, do not guess coordinates, do not build an element table yourself.

`fast_web_task` is the jev-ultrafast loop:

1. Read visible controls in the page and keep a pointer to each DOM node
2. Ask Jev (`typesafe-ai/jev` on Vercel AI Gateway) for the next operation + index
3. Click **that node**
4. Repeat until DONE, BLOCKED, or a text field is needed

You never need to know where to click. The node map lives inside the tool.

```
fast_web_task({
  url: "https://www.google.com/travel/flights",
  goal: "Find one-way flights from Zurich to London on September 20, 2026. Stop when matching options are visible."
})
```

## TYPE_TEXT — you write the string

Jev cannot generate text. When the tool needs a field value it **pauses** and returns:

```
status: "need_text"
field: { label, role, value }
next: "Write the exact string for this field..."
```

Then:

1. Infer the exact string from the original **goal** and `field.label`
2. Call **`fast_web_fill({ text })`** — the tool types it into the stored live node and continues
3. If you get `need_text` again, fill the next field the same way
4. Do **not** call `fast_web_task` again until the run returns `done`, `blocked`, or `budget`
5. Do **not** screenshot. Do not click. Do not type into the page yourself.

```
fast_web_fill({ text: "Zurich" })
```

The browser session stays open on the MCP process while status is `need_text`. `fast_web_abort` closes it.

`fillMode: "helper"` is optional: a small Gateway chat model invents the string instead of asking you.

## Do not

- Screenshot → VLM → `click(x, y)`
- Call `jev_choose_ui_action` and then try to click the index yourself
- Ask Jev to generate the TYPE_TEXT string
- Restart `fast_web_task` while a fill is waiting — that aborts the live page

## Fall back to screenshot computer use only if

- `fast_web_task` / `fast_web_fill` returns `blocked` (canvas, empty tree, low confidence)
- The site is a game, canvas editor, or otherwise not HTML/ARIA controls
- The tool errors because Chrome/Chromium is missing (`npx playwright install chromium`)

## Auth

Needs `AI_GATEWAY_API_KEY`. Jev is evaluation, not chat completions. Create a key at the [AI Gateway API keys](https://vercel.com/d?to=%2Fai-gateway%2Fapi-keys) page.

## Other tools

- `fast_web_fill` — resume after `need_text`
- `fast_web_abort` — drop the session
- `jev_decide` — non-UI judgments (choice / score / boolean) on arbitrary state
- `jev_choose_ui_action` — debug only; does not click
