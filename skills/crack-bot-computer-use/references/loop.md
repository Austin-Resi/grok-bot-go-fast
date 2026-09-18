# crack-bot UI loop

`fast_web_task` is the executor. Grok Bot does not click.

1. `snapshot.js` numbers visible controls and stores `window.__jevFast.nodes`
2. One Gateway evaluate call: operation + speculative targets
3. Click the stored node (hit-test just before input)
4. Short wait (autocomplete ≤200ms, otherwise ~50ms)
5. Repeat until DONE, TYPE_TEXT (`need_text`), or a decision Jev cannot make (`need_decision`)

Jev never sees pixels. Model output never becomes a selector, coordinate, or script.

On TYPE_TEXT the loop **pauses**. Grok Bot writes the string from the goal and calls `fast_web_fill`. The executor types into the stored live node and continues. Optional `fillMode: "helper"` uses a small Gateway chat model instead.

The snapshot hit-tests every line box of a control (so wrapped inline links stay clickable) and drops any control whose boxes are all covered by another element (modals, cookie walls) and tags controls inside a dialog or a large fixed banner with `overlay`; Close / Dismiss / No thanks style controls get `dismiss`. Jev sees `open_overlays` and a rule to dismiss before other work. The loop enforces the part that matters: if Jev picks TYPE_TEXT outside an open overlay that has an untried dismiss control, it clicks that control instead and re-decides. A covered or vanished target counts as a step and is recorded in history as failed, so the loop always terminates. Each call also has a wall-clock budget (45s) and returns `budget` with the tab open.

## Multi-step goals

Jev sees two kinds of element each step: hittable controls in the viewport, and up to `CRACK_BOT_PLAN_TOP_K` (32) **offscreen** links/buttons from the whole document, ranked by goal-token overlap with label and href path, then main content over site chrome, then document order. Choosing an offscreen element scrolls it to the center of the viewport, re-runs the hit-test, and clicks; the step is noted `scrolled into view`. This is still one Gateway call per step.

## System 1 / System 2

Jev is System 1. It decides alone whenever its answer is clear: the top pick's probability leads the runner-up by at least `CRACK_BOT_ASK_MARGIN` (0.2). Measured on Wikipedia: a present goal link scores ~0.98 vs 0.01 and is clicked unasked; a page where the goal is several hops away gets BLOCKED at 0.75–0.85 with no target ranking, because Jev correctly refuses to plan a route in one glance.

The loop never guesses on Jev's behalf. When Jev says BLOCKED it scrolls down once (free, reversible, the goal may be just below), asks Jev again, and if still BLOCKED returns `need_decision` to the Bot. It also asks when Jev is torn (margin under `ASK_MARGIN` between operations or between targets) and before clicking a control matching `IRREVERSIBLE` (Publish, Pay, Delete, Send…). The Bot answers with `fast_web_choose({ choice, goal? })`; its pick executes unasked and resets the progress gate.

For a BLOCKED ask, the loop makes one extra cheap Gateway call (`STEPPING_STONE`, ~300ms) asking Jev to rank the page's main-content links as routes toward the goal; that ordering is what the Bot sees as `options[].probability`. Jev's stepping-stone pick is a hint, not a decision: on pages with nothing goal-shaped it favours "start over" links, so site chrome is excluded from the options and the Bot chooses.

A **progress gate** still guards against spinning: progress means the URL changed, or a non-scroll action changed the visible content; `CRACK_BOT_NO_PROGRESS_LIMIT` (3) consecutive no-progress steps also trigger a `need_decision`. A `goBack` that hangs is recorded as a failed step and the run continues. The result carries `visited` URLs and `stats` (gateway ms, asks, low-confidence picks, failed targets, offscreen clicks) so a run can be explained from the result alone.

After BLOCKED or budget, and after DONE when attached to the Bot's Chrome, the tab stays open (`open: true`). Continue with `fast_web_task({ reuseBrowser: true, goal })` or close with `fast_web_abort`. If `attached` is true, this is the Bot's Chrome: cookies are shared, the tab is brought to front before each click, and screenshot computer use should continue on the same URL.

Fall back to screenshot computer use only when this loop returns `blocked`.
