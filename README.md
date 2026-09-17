# Jev for Grok Bot

A Grok Bot plugin that **actually clicks**. It ports the [jev-ultrafast](https://github.com/browser-use/jev-ultrafast) loop: live DOM snapshot, TypeSafe **Jev** through **Vercel AI Gateway**, then CDP click on the observed node.

Grok Bot should call `fast_web_task`. It should not screenshot-click. When a field needs a string, the tool pauses (`need_text`) and Grok Bot continues with `fast_web_fill`.

## Tools

| Tool | What it does |
|---|---|
| **`fast_web_task`** | Owns the browser. Snapshot → Jev → click that node until DONE or a text field |
| **`fast_web_fill`** | Type Grok Bot's string into the waiting live node and continue |
| `fast_web_abort` | Close the browser for the current run |
| `jev_decide` | General Jev questions (choice / score / boolean) |
| `jev_choose_ui_action` | Decision only; does not click. Debug. |

Auth: `AI_GATEWAY_API_KEY`. See [SETUP.md](SETUP.md).
