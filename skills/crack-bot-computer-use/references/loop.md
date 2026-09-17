# crack-bot UI loop

`fast_web_task` is the executor. Grok Bot does not click.

1. `snapshot.js` numbers visible controls and stores `window.__jevFast.nodes`
2. One Gateway evaluate call: operation + speculative targets
3. Click the stored node (hit-test just before input)
4. Short wait (autocomplete ≤200ms, otherwise ~50ms)
5. Repeat until DONE, BLOCKED, or TYPE_TEXT

Jev never sees pixels. Model output never becomes a selector, coordinate, or script.

On TYPE_TEXT the loop **pauses**. Grok Bot writes the string from the goal and calls `fast_web_fill`. The executor types into the stored live node and continues. Optional `fillMode: "helper"` uses a small Gateway chat model instead.

The snapshot hit-tests every line box of a control (so wrapped inline links stay clickable) and drops any control whose boxes are all covered by another element (modals, cookie walls) and tags controls inside a dialog or a large fixed banner with `overlay`; Close / Dismiss / No thanks style controls get `dismiss`. Jev sees `open_overlays` and a rule to dismiss before other work. The loop enforces the part that matters: if Jev picks TYPE_TEXT outside an open overlay that has an untried dismiss control, it clicks that control instead and re-decides. A covered or vanished target counts as a step and is recorded in history as failed, so the loop always terminates. Each call also has a wall-clock budget (45s) and returns `budget` with the tab open.

## Multi-step goals

Jev sees two kinds of element each step: hittable controls in the viewport, and up to `CRACK_BOT_PLAN_TOP_K` (32) **offscreen** links/buttons from the whole document, ranked by goal-token overlap with label and href path, then main content over site chrome, then document order. Choosing an offscreen element scrolls it to the center of the viewport, re-runs the hit-test, and clicks; the step is noted `scrolled into view`. This is still one Gateway call per step.

A **progress gate** replaces the old "one soft miss ends the run". Progress means the URL changed, or a non-scroll action changed the visible content. Consecutive no-progress steps are counted in `progress.no_progress_steps` (Jev sees it and gets an extra rule once it is above zero). A low-confidence pick is executed and flagged, not treated as failure. When Jev says BLOCKED, the loop treats it as "the right control was not in this snapshot" and works through what the page still offers, once each per no-progress run: the best untried goal-ranked offscreen link, then the next, then SCROLL_DOWN, then SCROLL_UP. BACK destroys progress, so the loop only takes it on its own when the page is a dead end (no offscreen candidates and no main-content controls); Jev may still choose BACK explicitly. A `goBack` that hangs is recorded as a failed step and the run continues. The run returns `blocked` only when `CRACK_BOT_NO_PROGRESS_LIMIT` (3) consecutive steps changed nothing, or every recovery has been tried. The result carries `visited` URLs and `stats` (gateway ms, recoveries, low-confidence picks, failed targets, offscreen clicks) so a failure can be explained from the result alone.

After BLOCKED or budget, and after DONE when attached to the Bot's Chrome, the tab stays open (`open: true`). Continue with `fast_web_task({ reuseBrowser: true, goal })` or close with `fast_web_abort`. If `attached` is true, this is the Bot's Chrome: cookies are shared, the tab is brought to front before each click, and screenshot computer use should continue on the same URL.

Fall back to screenshot computer use only when this loop returns `blocked`.
