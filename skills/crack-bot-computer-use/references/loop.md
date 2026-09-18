# crack-bot UI loop

`fast_web_task` is the executor. Grok Bot does not click.

1. `snapshot.js` numbers visible controls and stores `window.__jevFast.nodes`
2. One Gateway evaluate call: operation + speculative targets + independent `goal_done` / `stuck` booleans
3. Click the stored node (hit-test just before input)
4. Short wait (autocomplete ≤200ms, otherwise ~50ms)
5. Repeat until DONE, TYPE_TEXT (`need_text`), or a decision Jev cannot make (`need_decision`)

Jev never sees pixels. Model output never becomes a selector, coordinate, or script.

On TYPE_TEXT the loop **pauses**. Grok Bot writes the string from the goal and calls `fast_web_fill`. The executor types into the stored live node and continues. Optional `fillMode: "helper"` uses a small Gateway chat model instead.

The snapshot hit-tests every line box of a control (so wrapped inline links stay clickable) and drops any control whose boxes are all covered by another element (modals, cookie walls) and tags controls inside a dialog or a large fixed banner with `overlay`; Close / Dismiss / No thanks style controls get `dismiss`. Jev sees `open_overlays` and a rule to dismiss before other work. The loop enforces the part that matters: if Jev picks TYPE_TEXT outside an open overlay that has an untried dismiss control, it clicks that control instead and re-decides. After TYPE_TEXT into a combobox or searchbox, it re-snapshots and clicks the matching `option` (labelled `Field → Value`); it will not TYPE_TEXT that field again until the pick is committed or the list is gone. A field whose current value already equals a provided value is not offered as TYPE_TEXT. A covered or vanished target counts as a step and is recorded in history as failed, so the loop always terminates. Each call also has a wall-clock budget (45s) and returns `budget` with the tab open.

## Multi-step goals

Jev sees two kinds of element each step: hittable controls in the viewport, and up to `CRACK_BOT_PLAN_TOP_K` (32) **offscreen** links/buttons from the whole document, ranked by goal-token overlap with label and href path, then main content over site chrome, then document order. Choosing an offscreen element scrolls it to the center of the viewport, re-runs the hit-test, and clicks; the step is noted `scrolled into view`. This is still one Gateway call per step.

## System 1 / System 2

Jev is System 1. It decides alone whenever its answer is clear: the top pick's probability leads the runner-up by at least `CRACK_BOT_ASK_MARGIN` (0.2). Measured on Wikipedia: a present goal link scores ~0.98 vs 0.01 and is clicked unasked; a page where the goal is several hops away gets BLOCKED at 0.75–0.85 with no target ranking, because Jev correctly refuses to plan a route in one glance.

When Jev says BLOCKED on the action question, the loop asks it the routing question instead (`STEPPING_STONE`: which reachable page is closer to the goal topic than this one). Jev answers that well. Measured unaided, through the real loop: Green Bay Packers → Mars in 4 hops, Kevin Bacon → Photosynthesis in 6, Golden Gate Bridge → Beethoven in 4–6, all under 10s with zero or one Bot ask. It routes by word association (Bridge → Frank Bridge → Beethoven), not by world knowledge, and that is enough. The loop follows the pick while its probability is at least `CRACK_BOT_ROUTE_FLOOR` (0.12) and fewer than `CRACK_BOT_ROUTE_HOPS` (8) hops have passed since the last Bot decision. Below the floor it scrolls down once, re-asks, and then returns `need_decision` to the Bot. It also asks when Jev is torn (margin under `ASK_MARGIN` between operations or between targets) and before clicking a control matching `IRREVERSIBLE` (Publish, Pay, Delete, Send…). The Bot answers with `fast_web_choose({ choice, goal? })`; its pick executes unasked and resets the progress gate.

When a BLOCKED does reach the Bot, the options carry Jev's stepping-stone ranking as `options[].probability`. Site chrome is excluded from the options and from the "torn" tie check: a near-tie between a content link and the site logo is Jev saying "this or start over", and the content link wins.

A **progress gate** still guards against spinning: progress means the URL changed, or a non-scroll action changed the visible content. TYPE_TEXT only counts when the field fingerprint changes, so opening an autocomplete list and retyping the same string does not reset the gate. `CRACK_BOT_NO_PROGRESS_LIMIT` (3) consecutive no-progress steps also trigger a `need_decision`. If the last executed action changed nothing and Jev picks it again, the loop takes the runner-up target (or SCROLL / BACK) from that same distribution instead of retrying. A `goBack` that hangs is recorded as a failed step and the run continues.

Each evaluate call also asks two independent watchers: `goal_done` (P ≥ 0.85 ends the run as `done`, even if the action pick wanted to continue) and `stuck` (P ≥ 0.85 after step 2 is treated like BLOCKED). They cannot see the action pick, so they check it rather than rationalise it. The result carries `watchers`, `pageErrors` (console / page / network failures, tagged by step), `visited` URLs and `stats` so a run can be explained from the result alone.

After BLOCKED or budget, and after DONE when attached to the Bot's Chrome, the tab stays open (`open: true`). Continue with `fast_web_task({ reuseBrowser: true, goal })` or close with `fast_web_abort`. If `attached` is true, this is the Bot's Chrome: cookies are shared, the tab is brought to front before each click, and screenshot computer use should continue on the same URL.

Fall back to screenshot computer use only when this loop returns `blocked`.
