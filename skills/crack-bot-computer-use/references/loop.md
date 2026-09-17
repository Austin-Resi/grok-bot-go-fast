# Jev UI loop

`fast_web_task` is the executor. Grok Bot does not click.

1. `snapshot.js` numbers visible controls and stores `window.__jevFast.nodes`
2. One Gateway evaluate call: operation + speculative targets
3. Click the stored node (hit-test just before input)
4. Short wait (autocomplete ≤200ms, otherwise ~50ms)
5. Repeat until DONE, BLOCKED, or TYPE_TEXT

Jev never sees pixels. Model output never becomes a selector, coordinate, or script.

On TYPE_TEXT the loop **pauses**. Grok Bot writes the string from the goal and calls `fast_web_fill`. The executor types into the stored live node and continues. Optional `fillMode: "helper"` uses a small Gateway chat model instead.

The snapshot drops any control whose center is covered by another element (modals, cookie walls) and tags controls inside a dialog or a large fixed banner with `overlay`; Close / Dismiss / No thanks style controls get `dismiss`. Jev sees `open_overlays` and a rule to dismiss before other work. The loop enforces the part that matters: if Jev picks TYPE_TEXT outside an open overlay that has an untried dismiss control, it clicks that control instead and re-decides. A covered or vanished target counts as a step and is recorded in history as failed, so the loop always terminates. Each call also has a wall-clock budget (45s) and returns `budget` with the tab open.

After BLOCKED or budget, and after DONE when attached to the Bot's Chrome, the tab stays open (`open: true`). Continue with `fast_web_task({ reuseBrowser: true, goal })` or close with `fast_web_abort`. If `attached` is true, this is the Bot's Chrome: cookies are shared, the tab is brought to front before each click, and screenshot computer use should continue on the same URL.

Fall back to screenshot computer use only when this loop returns `blocked`.
