import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import { abortFastWebTask, fillFastWebTask, startFastWebTask } from "./agent.ts";
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
    .describe("Compatible operations for this control: CLICK, TYPE_TEXT, SELECT, WAIT, SCROLL_UP, SCROLL_DOWN"),
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
        "Do a web task quickly. Attaches to this agent's Chrome when it exposes DevTools (enable via chrome://inspect/#remote-debugging; Jev reads DevToolsActivePort, scoped to this DISPLAY), otherwise launches Chromium on this display. Snapshot live DOM nodes, Jev picks the control, this tool clicks that node. Handles multi-step goals in one call: offscreen links ranked against the goal are offered and scrolled to, BACK undoes wrong hops, and blocked is returned only after several no-progress steps. Open dialogs/banners are dismissed before typing; controls hidden under them are never offered. When a text field is needed, status is need_text — you write the string and call fast_web_fill. On blocked/budget, or whenever attached, the tab stays open (open: true) — use screenshot computer use on the returned url, same tab. Do not screenshot-click the happy path.",
      inputSchema: z.object({
        url: z
          .string()
          .optional()
          .describe("Starting URL. Required unless reuseBrowser is true."),
        goal: z.string().describe("The full task. Stop condition belongs here."),
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
    async ({ url, goal, maxSteps, maxMs, fillMode, keepOpen, reuseBrowser }) => {
      try {
        const result = await startFastWebTask({ url, goal, maxSteps, maxMs, fillMode, keepOpen, reuseBrowser });
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
        "Continue a paused fast_web_task. Use when the last result status is need_text. Pass the exact string to type into the waiting field. The tool types it into the live node and keeps going until DONE, BLOCKED, or another need_text.",
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
