# Jev UI loop

`fast_web_task` is the executor. Grok Bot does not click.

1. `snapshot.js` numbers visible controls and stores `window.__jevFast.nodes`
2. One Gateway evaluate call: operation + speculative targets
3. Click the stored node (hit-test just before input)
4. Short wait (autocomplete ≤200ms, otherwise ~50ms)
5. Repeat until DONE, BLOCKED, or TYPE_TEXT

Jev never sees pixels. Model output never becomes a selector, coordinate, or script.

On TYPE_TEXT the loop **pauses**. Grok Bot writes the string from the goal and calls `fast_web_fill`. The executor types into the stored live node and continues. Optional `fillMode: "helper"` uses a small Gateway chat model instead.

Fall back to screenshot computer use only when this loop returns `blocked`.
