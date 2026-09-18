---
name: crack-bot-computer-use
description: Your fast hands for the web. For any task on a website or web app (forms, listings, search, browsing, settings, multi-page flows) call fast_web_task with the whole goal and everything you already know, then answer its short questions. It reads the live page, decides in ~0.5s per step with TypeSafe Jev, and clicks or types on the real DOM node. Use this instead of screenshot computer use on any page with normal HTML controls.
---

# crack-bot: you think, it acts

Two minds share the work. **Jev** (inside crack-bot) is System 1: it looks at a page and picks the next click in half a second, and it is very good at that. **You** are System 2: you know what the user wants, you have the facts, and you can plan a route. crack-bot runs Jev in a loop and only stops to ask you when a decision needs a planner. Play your part well and a 20-field form fills in seconds, a 5-hop browse finishes in one call, and you are asked once or twice, not once per click.

## Four habits

**1. Hand over the whole goal once, with the stop condition.**

```
fast_web_task({
  url: "https://en.wikipedia.org/wiki/Green_Bay_Packers",
  goal: "Reach the Wikipedia article about Mars (the planet). Stop when the Mars article is open."
})
```

Not "click Green Bay, Wisconsin" then "click Wisconsin". Say what to achieve, not which controls to press. crack-bot sees links below the fold, scrolls to them, routes through stepping stones, and finds its own way. Splitting a flow into one call per click is the slow path you are replacing.

**2. Don't forbid the obvious move unless the user did.** Jev's first instinct for "reach the Mars article" is to type Mars into search, because that is the fastest way. Only say "links only" or "do not use search" if the user actually cares about the method.

**3. Give it everything you know up front, in `data`.**

```
fast_web_task({
  url: "https://www.etsy.com/your/shops/me/tools/listings/create",
  goal: "Create a draft listing with the provided data. Stop when the draft is saved.",
  data: {
    title: "Hand-thrown ceramic mug",
    description: "Wheel-thrown stoneware, 12 oz, dishwasher safe.",
    price: "34.00",
    quantity: 3,
    tags: ["ceramic", "mug", "handmade", "stoneware"],
    category: "Home & Living"
  }
})
```

For every text field Jev picks, crack-bot asks Jev which provided value belongs there (one cheap comparison, ~0.4s) and types it. You are asked (`need_text`) only for a field nothing in `data` fits. Measured: a 7-field listing form, 5 text fields plus a dropdown and Save, in 5.7s with zero questions to you. The same form field-by-field would be 7 turns. Key names are free-form; use the field's natural name. Values are never invented: a field with no matching data is left for you.

**4. When asked, compare, don't deliberate.** crack-bot's questions come with the options already laid out. Read them, pick, answer. Never respond by screenshotting or by restarting `fast_web_task`; the run is paused and waiting for your one answer.

## The three questions it can ask

**`need_text`**: a field needs a value and nothing in `data` fits.

```
status: "need_text", field: { label: "Shipping from ZIP", role: "textbox", value: "" }
→ fast_web_fill({ text: "53703" })
```

**`need_decision`**: Jev cannot pick alone. Happens when the goal is several hops away and Jev's routing ran out (dead end), when two options are a genuine tie, or when it is about to click something hard to undo (Publish, Pay, Delete, Send). You get the candidate options with Jev's probabilities where it had them, main content only.

```
status: "need_decision", reason: "Jev is torn between targets"
decision.options: [{ index: "40", label: "Atmosphere of Mars", probability: 0.43 }, { index: "41", label: "Mars", probability: 0.28 }, ...]
→ fast_web_choose({ choice: "41" })
→ fast_web_choose({ choice: "12", goal: "Reach the United States article, then Mars." })   // narrow the goal for the next hops
→ fast_web_choose({ choice: "DONE" })    // the goal is already satisfied
→ fast_web_choose({ choice: "STOP" })    // hand off to screenshot computer use
```

Controls: `BACK`, `SCROLL_DOWN`, `SCROLL_UP`, `DONE`, `STOP`. For an `irreversible` ask, `decision.jev` holds the button Jev wants to click; confirm it with its index or choose otherwise. Measured on link-only Wikipedia routes: Packers → Mars in 4 hops, Kevin Bacon → Photosynthesis in 6, Golden Gate Bridge → Beethoven in 4–6, all under 10s with zero or one ask. You are asked only for real ties.

**`budget`**: the call used its ~45s. Nothing is wrong. The tab is open; continue with the same goal:

```
fast_web_task({ reuseBrowser: true, goal })
```

## When it finishes

`done` means Jev saw visible evidence the goal was met (a confirmation, the target page). Verify against the result's `url`, `title`, and `text` if the outcome matters. `blocked` means it gave up after several steps that changed nothing; the tab is open at `url`, so continue there with screenshot computer use rather than starting over. `steps[]` shows every action with a note (`from data.price`, `route: "United States" is closer to the goal`, `dismissed overlay…`), and `stats` counts data fills, route hops, and asks.

## Sessions

The tab stays open (`open: true`) after `need_text`, `need_decision`, `blocked`, `budget`, and after `done` when attached to your Chrome. `fast_web_task({ reuseBrowser: true, goal })` continues on that page with a new goal. `fast_web_abort` closes the crack-bot tab; it never quits your Chrome. `attached: true` means it is driving your own Chrome (your logins), on your `display`.

## What it handles so you don't have to

Cookie walls, donate banners and modals are dismissed before typing; controls hidden under them are never offered. Wrapped links are hit-tested per line box. Offscreen links and fields are scrolled to when chosen. Each step is one ~0.5s Jev call; a stalled page is a failed step, not a crashed run.

## Do not

- Screenshot → VLM → `click(x, y)` on a page with HTML controls
- Call `fast_web_task` once per click
- Restart `fast_web_task` while `need_text` or `need_decision` is waiting; answer it
- Withhold values you already have; put them in `data`
- Call `jev_choose_ui_action` and click the index yourself

## Fall back to screenshot computer use only if

- `blocked` comes back, or you answer `STOP`; continue on the same tab
- The page is a canvas, game, or CAPTCHA (non-HTML controls)
- Chrome is missing on this computer (`npx playwright install chromium`)

## Other tools

- `fast_web_fill` answers `need_text`; `fast_web_choose` answers `need_decision`; `fast_web_abort` closes the tab
- `jev_decide`: non-UI judgments (choice / score / boolean) over any state you give it, ~0.5s
- `jev_choose_ui_action`: debug only; decides but does not click

Auth: `AI_GATEWAY_API_KEY` in the server env. The decision model is `typesafe-ai/jev` on Vercel AI Gateway.
