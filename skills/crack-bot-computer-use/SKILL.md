---
name: crack-bot-computer-use
description: Speeds up Grok Bot web computer use by delegating to fast_web_task. That tool snapshots live DOM nodes, asks TypeSafe Jev on Vercel AI Gateway what to click, and clicks the node. When a text field is needed, you write the string and call fast_web_fill. Use for forms, search, browsing, and any site with normal HTML controls. Do not screenshot-click those pages.
---

# crack-bot computer use

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
4. Do **not** call `fast_web_task` again until the run returns `done`, `blocked`, or `budget`; answer `need_text` and `need_decision` first
5. Do **not** screenshot. Do not click. Do not type into the page yourself.

```
fast_web_fill({ text: "Zurich" })
```

The browser session stays open on the MCP process after `need_text`, `blocked`, and `budget`, and after `done` when attached to the Bot's Chrome. The result says so with `open: true`. Call **`fast_web_abort`** when you are finished with the page.

To keep working on that same page (new goal, more steps), call:

```
fast_web_task({ reuseBrowser: true, goal: "..." })
```

A new `fast_web_task` with a `url` and no `reuseBrowser` replaces the session. `keepOpen` overrides the default in either direction.

If the result has `attached: true`, this is your Chrome on your `display` (shared cookies; `attachedTo` names the profile). Do not quit Chrome. On `blocked`, use screenshot computer use on the **same** `url` — the tab is already in front.

## Dialogs, banners, cookie walls

The tool handles these. Controls hidden under a modal are never offered to Jev, and if Jev wants to type into a field while a dismissible banner is open, the tool clicks the banner's Close / No thanks / I already donated control first (a step with `note: "dismissed overlay…"`). You never get `need_text` for a covered field. If a page returns `blocked` with an overlay still up (CAPTCHA, unlabeled close icon), dismiss it with screenshot computer use, then `fast_web_task({ reuseBrowser: true, goal })`.

Each call returns within ~45s (`status: "budget"`, tab open). Continue with `reuseBrowser: true`; that is a normal path, not a failure.

## need_decision — you are the planner

Jev is System 1: fast, confident when the next step is on the page. You are System 2. When Jev cannot pick, the tool **pauses** and returns:

```
status: "need_decision"
reason: "Jev cannot advance the goal in one step from this page"
decision: {
  reason: "blocked" | "torn_operation" | "torn_target" | "irreversible",
  jev: { operation, index, label, confidence } | undefined,
  options: [{ index, operation, label, href, offscreen, main, probability }, ...],
  controls: ["SCROLL_DOWN", "BACK", "DONE", "STOP"]
}
```

This happens when Jev says BLOCKED (the goal is not one click away: route planning is your job), when Jev is torn between two picks, or when Jev wants to click something hard to undo (Publish, Pay, Delete, Send). Read the options, think about the route, and answer:

```
fast_web_choose({ choice: "58" })
fast_web_choose({ choice: "58", goal: "Reach the United States article, then Mars." })
```

`options` are main-content links only, ordered by Jev's own stepping-stone ranking (`probability`) when it had one; site chrome is left out. Passing `goal` narrows the goal for the rest of the run, which is the right move when the original goal needs several hops: name the next stepping stone. Controls: `BACK`, `SCROLL_DOWN`, `SCROLL_UP`, `DONE` (confirm the goal is met), `STOP` (hand off to screenshot computer use). Do not screenshot to answer; the options are the page. Once you choose, Jev takes over again and runs unasked until the next decision it cannot make.

Measured: Earth → Mars finishes in 2 steps with no asks. Green Bay Packers → Mars link-only takes 4 hops and 3 asks (~6s total); Jev finishes alone once a Mars-shaped link appears.

## Multi-step goals

Give the whole goal once, including the stop condition, and let the tool run it. The tool sees links below the fold and scrolls to them. Do not split a browse or form flow into one call per click. If a run returns `budget` mid-way, continue with `fast_web_task({ reuseBrowser: true, goal })` using the same goal; `visited` in the result shows the path so far.

`fillMode: "helper"` is optional: a small Gateway chat model invents the string instead of asking you.

## Do not

- Screenshot → VLM → `click(x, y)`
- Call `jev_choose_ui_action` and then try to click the index yourself
- Ask Jev to generate the TYPE_TEXT string
- Restart `fast_web_task` while a fill is waiting — that aborts the live page unless you call `fast_web_fill` first

## Fall back to screenshot computer use only if

- `fast_web_task` / `fast_web_fill` returns `blocked` (canvas, empty tree, low confidence) — continue screenshot computer use on the returned url; the tab is still open
- The site is a game, canvas editor, or otherwise not HTML/ARIA controls
- The tool errors because Chrome/Chromium is missing (`npx playwright install chromium`) and CDP attach failed

## Auth

Needs `AI_GATEWAY_API_KEY`. Jev is evaluation, not chat completions. Create a key at the [AI Gateway API keys](https://vercel.com/d?to=%2Fai-gateway%2Fapi-keys) page.

## Other tools

- `fast_web_fill` — resume after `need_text`
- `fast_web_choose` — resume after `need_decision`
- `fast_web_abort` — close the crack-bot tab (never quits the Bot's Chrome when attached)
- `jev_decide` — non-UI judgments (choice / score / boolean) on arbitrary state
- `jev_choose_ui_action` — debug only; does not click
