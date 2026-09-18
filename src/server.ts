import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { abortFastWebTask, chooseFastWebTask, fillFastWebTask, startFastWebTask } from "./agent.ts";
import { buildUiActionQuestions } from "./choose-ui-action.ts";
import { evaluateWithGateway } from "./evaluate.ts";
import { errorResult, jsonResult, resolveUiDecision } from "./format.ts";

const jsonValue = z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]);

const questionSchema = z.object({
  type: z.enum(["choice", "score", "boolean"]),
  instructions: z.unknown().optional(),
  criteria: z.unknown().optional(),
});

const elementSchema = z.object({
  index: z.string().describe("Visible index, e.g. \"1\""),
  role: z.string().describe("button, textbox, combobox, link, checkbox, etc."),
  label: z.string(),
  operations: z
    .array(z.string())
    .describe("Compatible operations for this control: CLICK, TYPE_TEXT, SELECT, UPLOAD, WAIT, SCROLL_UP, SCROLL_DOWN"),
  value: z.string().optional(),
  checked: z.boolean().optional(),
  selected: z.boolean().optional(),
  expanded: z.boolean().optional(),
  overlay: z.string().optional().describe("Id of the open dialog/banner containing this control."),
  dismiss: z.boolean().optional().describe("This control closes its overlay."),
  offscreen: z.enum(["above", "below"]).optional().describe("Not in the viewport; you must scroll to it before clicking."),
  main: z.boolean().optional().describe("Inside main content rather than site chrome."),
  href: z.string().optional(),
  options: z
    .array(
      z.object({
        index: z.string(),
        label: z.string(),
        value: z.string().optional(),
      }),
    )
    .optional(),
});

export function createServer(): McpServer {
  const server = new McpServer({
    name: "crack-bot",
    version: "0.2.0",
  });

  server.registerTool(
    "fast_web_task",
    {
      description:
        "Do a web task quickly on any page with normal HTML controls (forms, search, navigation, settings, checkout up to the confirm). Attaches files you pass in `files` (no dialog). Not for canvas/maps/drag-and-drop, CAPTCHAs, passkeys, or content inside embedded iframes: use screenshot computer use for those. Attaches to this agent's Chrome when it exposes DevTools (enable via chrome://inspect/#remote-debugging; Jev reads DevToolsActivePort, scoped to this DISPLAY), otherwise launches Chromium on this display. Snapshot live DOM nodes, Jev picks the control, this tool clicks that node. Jev is System 1: it acts on its own when confident. When it cannot pick (BLOCKED, torn between options, or about to click something irreversible) the tool returns status need_decision with the candidate options and you choose with fast_web_choose — you are System 2. Offscreen links ranked against the goal are offered and scrolled to on click. Open dialogs/banners are dismissed before typing; controls hidden under them are never offered. When a text field is needed, status is need_text — you write the string and call fast_web_fill. On blocked/budget, or whenever attached, the tab stays open (open: true) — use screenshot computer use on the returned url, same tab. Do not screenshot-click the happy path.",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe("Starting URL. Required unless reuseBrowser is true."),
        goal: z.string().describe("The full task, including the stop condition. Say what to achieve, not which controls to click."),
        data: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]))
          .optional()
          .describe("Values you already know for form fields, keyed by name (title, price, tags, email…). Typed into matching fields with no round trip; need_text is only returned for fields nothing here fits. Give everything up front."),
        files: z
          .union([z.array(z.string()), z.record(z.string(), z.array(z.string()))])
          .optional()
          .describe("Files to attach, as absolute paths on this computer. A list is one group; a map names groups (photos, video…) for forms with several upload slots. Attached directly to the file input, no dialog. Paths are checked before the run starts."),
        maxSteps: z.number().int().min(1).max(40).optional(),
        maxMs: z
          .number()
          .int()
          .min(1000)
          .max(45000)
          .optional()
          .describe("Wall-clock budget for this call in ms (default 45000). Returns status budget with the tab open when exceeded; continue with reuseBrowser."),
        fillMode: z
          .enum(["bot", "helper"])
          .optional()
          .describe("bot (default): pause on TYPE_TEXT and wait for fast_web_fill. helper: a small Gateway chat model fills the string."),
        keepOpen: z
          .boolean()
          .optional()
          .describe("Leave the tab open after the run so screenshot computer use can continue on the same page. Default: true when attached to the Bot's Chrome or when status is blocked/budget; false for a done run in crack-bot's own Chromium. When attached, fast_web_abort closes only the crack-bot tab — never Chrome."),
        reuseBrowser: z
          .boolean()
          .optional()
          .describe("Keep the already-open page instead of launching a new browser. Pass a url to navigate that same window. Do not use while status is need_text."),
      }),
    },
    async ({ url, goal, data, files, maxSteps, maxMs, fillMode, keepOpen, reuseBrowser }) => {
      try {
        const result = await startFastWebTask({ url, goal, data, files, maxSteps, maxMs, fillMode, keepOpen, reuseBrowser });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "fast_web_fill",
    {
      description:
        "Continue a paused fast_web_task. Use when the last result status is need_text. Pass the exact string to type into the waiting field. The tool types it into the live node and keeps going until done, another need_text, or a need_decision.",
      inputSchema: z.object({
        text: z.string().describe("Exact value to type. Infer it from the original goal and the field label."),
      }),
    },
    async ({ text }) => {
      try {
        const result = await fillFastWebTask(text);
        return jsonResult(result);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "fast_web_choose",
    {
      description:
        "Answer a need_decision from fast_web_task. Jev (fast, System 1) could not pick the next step alone: it said BLOCKED, was torn between two options, or wants to click something hard to undo. You are the planner: read decision.options (each has index, label, href, offscreen, main, and Jev's probability when it had one), pick the one that best advances the goal, and pass its index. Controls: BACK, SCROLL_DOWN, SCROLL_UP, DONE (goal is satisfied), STOP (hand off). Optionally pass a narrower goal for the remaining steps, e.g. the next stepping stone. Do not screenshot; the options are the page.",
      inputSchema: z.object({
        choice: z.string().describe("An option index from decision.options, or BACK / SCROLL_DOWN / SCROLL_UP / DONE / STOP."),
        goal: z.string().optional().describe("Optional narrower goal for the next steps. The original goal is replaced for this run."),
      }),
    },
    async ({ choice, goal }) => {
      try {
        const result = await chooseFastWebTask({ choice, goal });
        return jsonResult(result);
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "fast_web_abort",
    {
      description:
        "Detach from the current fast_web_task. When a result said open: true, the tab stays open until you call this. Drops any waiting TYPE_TEXT. If attached to the Bot's Chrome, this closes only the crack-bot tab and never quits Chrome.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        await abortFastWebTask();
        return jsonResult({ status: "aborted" });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "jev_decide",
    {
      description:
        "Ask TypeSafe Jev (via Vercel AI Gateway, model typesafe-ai/jev) one or more typed questions about a shared state. Use for fast structured decisions: pick an option, score a rubric, or estimate P(true). All questions run in parallel in one ~70–500ms call. Do not use this for generating text.",
      inputSchema: z.object({
        state: jsonValue.describe("Shared context Jev evaluates. String, object, or array. Keep it filtered to what the questions need."),
        questions: z
          .record(z.string(), questionSchema)
          .describe(
            "Named questions. Types: choice (criteria is option→description map), score (criteria is ordered labels), boolean (optional true/false criteria). AI Gateway uses boolean for TypeSafe noul.",
          ),
      }),
    },
    async ({ state, questions }) => {
      try {
        const started = performance.now();
        const result = await evaluateWithGateway({ state, questions });
        return jsonResult({
          ...result,
          latency_ms: Math.round(performance.now() - started),
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.registerTool(
    "jev_choose_ui_action",
    {
      description:
        "Fast computer-use decision. Send an indexed element table from the current page (no screenshot). Jev picks the next operation and target in one Gateway call using speculative fan-out. Prefer this over screenshot/VLM computer use for normal HTML/ARIA controls. Execute the chosen index yourself (click/type/select). If operation is TYPE_TEXT, write the field value from the goal. If BLOCKED or confidence is low, fall back to screenshot computer use.",
      inputSchema: z.object({
        goal: z.string().describe("The full user goal for this task."),
        page: z.object({
          url: z.string().optional(),
          title: z.string().optional(),
          text: z.string().optional().describe("Visible page text only. Do not send offscreen bodies."),
        }),
        elements: z
          .array(elementSchema)
          .describe("Indexed interactive controls currently visible. Indexes must match what you will click."),
        recentActions: z
          .array(
            z.object({
              action: z.string().optional(),
              kind: z.string().optional(),
              text: z.string().optional(),
              pageChanged: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
    },
    async (input) => {
      try {
        const built = buildUiActionQuestions(input);
        const started = performance.now();
        const result = await evaluateWithGateway({
          state: built.state,
          questions: built.questions,
        });
        const decision = resolveUiDecision(result.answers, result.confidence);
        return jsonResult({
          ...decision,
          execute:
            decision.operation === "DONE" || decision.operation === "BLOCKED"
              ? decision.operation
              : decision.target
                ? `${decision.operation} [${decision.target}]`
                : decision.operation,
          next:
            decision.operation === "TYPE_TEXT"
              ? "Write the field value from the goal, then type it into the chosen element. Do not ask Jev to generate the string."
              : decision.operation === "DONE"
                ? "Verify the outcome independently. DONE is not proof of success."
                : decision.operation === "BLOCKED"
                  ? "Fall back to screenshot computer use or a different tool."
                  : "Execute this control by index. Do not screenshot unless execution fails.",
          truncated: built.truncated,
          answers: result.answers,
          usage: result.usage,
          model: result.model,
          latency_ms: Math.round(performance.now() - started),
        });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  );

  return server;
}
