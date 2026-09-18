---
name: crack-bot-computer-use
description: Your fast hands for the web. Use fast_web_task for any task whose steps are clicking, typing, selecting, or uploading via normal HTML controls (links, buttons, fields, dropdowns, checkboxes, file inputs) on a website or web app: forms and listings with photos, search, navigating to a page, changing settings, multi-page flows, checkout up to the final confirm. Give it the whole goal, your values in data, and file paths in files, then answer its short questions. It decides each step in ~0.5s with TypeSafe Jev and acts on the real DOM node. Do not use it for pixel work (canvas editors, maps, games, video, drag-and-drop, image cropping), CAPTCHAs, passkeys or 2FA, or content inside embedded iframes (payment widgets); use screenshot computer use there. Prefer a connector when one exists for the service.
---

# crack-bot: you think, it acts

Two minds share the work. **Jev** (inside crack-bot) is System 1: it looks at a page and picks the next click in half a second, and it is very good at that. **You** are System 2: you know what the user wants, you have the facts, and you can plan a route. crack-bot runs Jev in a loop and only stops to ask you when a decision needs a planner. Play your part well and a 20-field form fills in seconds, a 5-hop browse finishes in one call, and you are asked once or twice, not once per click.

## When to use it

Ask one question: **is the next thing I need to do a click, a keystroke, or a selection on a normal HTML control?** If yes, this is the tool, and it will be faster and more reliable than a screenshot. If the thing I need is a pixel, a gesture, or a human-only check, it is not.

| Use crack-bot | Use screenshot computer use | Use a connector |
|---|---|---|
| Fill a form, create a listing, update a profile | Canvas / WebGL editors, drawing, image cropping | The service has a Grok Bot plugin (Gmail, Calendar, Slack…) |
| Search a site and open a result | Maps, charts, anything you position by eye | |
| Navigate to a page, follow links, find a setting | Drag-and-drop, sliders you drag, video scrubbing | |
| Checkout, sign-up, settings flows, up to the irreversible click (it asks before Publish / Pay / Delete) | CAPTCHA, passkey, 2FA, "are you human" (take over, then resume crack-bot with `reuseBrowser`) | |
| Toggle checkboxes, pick dropdown values, tabs, accordions | Drop-only zones with no file input behind them (rare) | |
| Attach photos, videos, documents to a form (pass `files`) | | |
| Dismissing cookie walls and modals (it does this itself) | Content inside a cross-origin iframe: embedded payment widgets, chat widgets, some ad-heavy pages | |
| Read a page's visible text after navigating (`text` in the result) | Native OS dialogs, print dialogs, browser chrome | |

Rules of thumb:

- **Start with crack-bot on any web page.** If it returns `blocked`, the tab is still open at `url`; continue there with screenshot computer use rather than starting over. When the human-only step is done, hand back with `fast_web_task({ reuseBrowser: true, goal })`.
- **Login walls:** if you are already signed in on this Chrome (`attached: true`), just go. If a password, passkey, or code is needed, that is a takeover step for you or the user; crack-bot never types passwords.
- **Mostly-HTML pages with one pixel step** (a map pin, a signature pad): do the HTML parts with crack-bot, the pixel step with screenshot, then resume.
- **Reading, not acting:** crack-bot returns the visible text of the page it lands on (`text`, 2000 chars). For long reads or downloads, a fetch or browser-read tool is cheaper than either.
- **Speed expectation:** ~0.5s per step, ~2s per simple task, 5–10s for a multi-hop browse or a full form. If a run takes many `budget` continuations with little progress, the page is probably not HTML-controllable; switch.

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
  },
  files: {
    photos: ["/workspace/listing/mug-front.jpg", "/workspace/listing/mug-side.jpg"],
    video: ["/workspace/listing/mug-spin.mp4"]
  }
})
```

For every text field Jev picks, crack-bot asks Jev which provided value belongs there (one cheap comparison, ~0.4s) and types it. You are asked (`need_text`) only for a field nothing in `data` fits. Measured: a 7-field listing form, 5 text fields plus a dropdown and Save, in 5.7s with zero questions to you. The same form field-by-field would be 7 turns. Key names are free-form; use the field's natural name. Values are never invented: a field with no matching data is left for you.

`files` are absolute paths on this computer (put them under `/workspace`). They go straight onto the page's file input, no dialog: either Jev picks the hidden input directly (`UPLOAD`), or it clicks the site's styled "Upload" button and crack-bot answers the file chooser that opens. A flat list is one group; a map names groups so photos and a video land in the right slots (matched by the input's accepted types). Measured: 2 photos + 1 video + title + price + save on an Etsy-shaped form in 5.0s, zero asks. Paths are checked before the run starts; a missing file is an immediate error, not a mid-run surprise.

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

`done` means Jev saw visible evidence the goal was met (a confirmation, the target page). Verify against the result's `url`, `title`, and `text` if the outcome matters. `blocked` means it gave up after several steps that changed nothing; the tab is open at `url`, so continue there with screenshot computer use rather than starting over. `steps[]` shows every action with a note (`from data.price`, `attached 2 file(s) from files.photos`, `route: "United States" is closer to the goal`, `dismissed overlay…`), and `stats` counts data fills, uploads, route hops, and asks. Set `CRACK_BOT_TRACE=1` on the server to see each step on stderr as it happens.

## Sessions

The tab stays open (`open: true`) after `need_text`, `need_decision`, `blocked`, `budget`, and after `done` when attached to your Chrome. `fast_web_task({ reuseBrowser: true, goal })` continues on that page with a new goal. `fast_web_abort` closes the crack-bot tab; it never quits your Chrome. `attached: true` means it is driving your own Chrome (your logins), on your `display`.

## What it handles so you don't have to

Cookie walls, donate banners and modals are dismissed before typing; controls hidden under them are never offered. Wrapped links are hit-tested per line box. Offscreen links and fields are scrolled to when chosen. Each step is one ~0.5s Jev call; a stalled page is a failed step, not a crashed run.

## Do not

- Screenshot → VLM → `click(x, y)` on a page with HTML controls
- Call `fast_web_task` once per click
- Restart `fast_web_task` while `need_text` or `need_decision` is waiting; answer it
- Withhold values you already have; put them in `data`, and file paths in `files`
- Try to drive a file chooser dialog yourself; pass `files` and let crack-bot attach them
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
