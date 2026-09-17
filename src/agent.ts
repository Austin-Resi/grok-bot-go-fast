import { actionSpace, type ObservedPage, type SnapshotAction } from "./action-space.ts";
import { FastBrowser, StalePage } from "./browser.ts";
import { buildUiActionQuestions } from "./choose-ui-action.ts";
import type { RecentAction } from "./choose-ui-action.ts";
import { evaluateWithGateway } from "./evaluate.ts";
import { fieldText } from "./fill-text.ts";
import { resolveUiDecision } from "./format.ts";
import { MAX_STEPS } from "./questions.ts";

export type FillMode = "bot" | "helper";

export interface FastWebTaskInput {
  url: string;
  goal: string;
  maxSteps?: number;
  fillMode?: FillMode;
}

export interface FastWebStep {
  step: number;
  operation: string;
  target: string | null;
  execute: string;
  text?: string;
  url: string;
  latencyMs: number;
  confidence: number | null;
}

export interface NeedTextField {
  label: string;
  role?: string;
  value?: string;
}

export interface FastWebTaskResult {
  status: "done" | "blocked" | "budget" | "need_text";
  url: string;
  title: string;
  text: string;
  steps: FastWebStep[];
  elapsedMs: number;
  reason?: string;
  next?: string;
  field?: NeedTextField;
  goal?: string;
}

interface PendingFill {
  action: SnapshotAction;
  execute: string;
  operation: string;
  target: string | null;
  confidence: number | null;
  latencyMs: number;
}

interface Run {
  browser: FastBrowser;
  goal: string;
  maxSteps: number;
  fillMode: FillMode;
  step: number;
  page: ObservedPage;
  history: RecentAction[];
  steps: FastWebStep[];
  started: number;
  pending: PendingFill | undefined;
}

let active: Run | undefined;

export async function startFastWebTask(input: FastWebTaskInput): Promise<FastWebTaskResult> {
  await abortFastWebTask();
  const browser = new FastBrowser();
  try {
    await browser.open(input.url);
    const page = await browser.observe();
    active = {
      browser,
      goal: input.goal,
      maxSteps: Math.min(input.maxSteps ?? MAX_STEPS, MAX_STEPS),
      fillMode: input.fillMode ?? "bot",
      step: 1,
      page,
      history: [],
      steps: [],
      started: performance.now(),
      pending: undefined,
    };
    return await advanceActive();
  } catch (error) {
    if (!active) await browser.close();
    throw error;
  }
}

export async function fillFastWebTask(text: string): Promise<FastWebTaskResult> {
  const run = active;
  if (!run?.pending) {
    throw new Error("No TYPE_TEXT is waiting. Start with fast_web_task. When status is need_text, call fast_web_fill.");
  }
  const value = text.trim();
  if (!value || value.length > 2000) throw new Error("Provide the exact field string to type.");
  await applyFill(run, value);
  return await advanceActive();
}

export async function abortFastWebTask(): Promise<void> {
  const run = active;
  active = undefined;
  await run?.browser.close();
}

async function applyFill(run: Run, text: string): Promise<void> {
  const pending = run.pending;
  if (!pending) return;
  try {
    await run.browser.act(pending.action, text);
  } catch (error) {
    if (!(error instanceof StalePage)) throw error;
    run.pending = undefined;
    run.page = await run.browser.observe();
    return;
  }
  const before = run.page;
  run.page = await run.browser.observe();
  run.history.push({
    action: pending.action.label,
    kind: pending.action.kind,
    text,
    pageChanged: run.page.url !== before.url || run.page.text !== before.text,
  });
  run.steps.push({
    step: run.step,
    operation: pending.operation,
    target: pending.target,
    execute: pending.execute,
    text,
    url: run.page.url,
    latencyMs: pending.latencyMs,
    confidence: pending.confidence,
  });
  run.step += 1;
  run.pending = undefined;
}

async function advanceActive(): Promise<FastWebTaskResult> {
  const run = active;
  if (!run) throw new Error("No active web task");

  try {
    while (run.step <= run.maxSteps) {
      const space = actionSpace(run.page, run.goal, run.history);
      const built = buildUiActionQuestions(space.input);
      const started = performance.now();
      const decided = await evaluateWithGateway({
        state: built.state,
        questions: built.questions,
      });
      const latencyMs = Math.round(performance.now() - started);
      const decision = resolveUiDecision(decided.answers, decided.confidence);
      const execute =
        decision.operation === "DONE" || decision.operation === "BLOCKED"
          ? decision.operation
          : decision.target
            ? `${decision.operation} [${decision.target}]`
            : decision.operation;

      if (decision.operation === "DONE") {
        record(run, decision.operation, decision.target, execute, decision.confidence, latencyMs);
        return await stop("done", run);
      }

      if (decision.operation === "BLOCKED" || (decision.confidence != null && decision.confidence < 0.45)) {
        record(run, decision.operation || "BLOCKED", decision.target, execute, decision.confidence, latencyMs);
        return await stop(
          "blocked",
          run,
          "Jev could not progress on this page. Use screenshot computer use.",
        );
      }

      const action = space.resolve(decision.operation, decision.target);
      if (!action) return await stop("blocked", run, `No live node for ${execute}`);

      if (action.kind === "fill") {
        run.pending = {
          action,
          execute,
          operation: decision.operation,
          target: decision.target,
          confidence: decision.confidence,
          latencyMs,
        };
        if (run.fillMode === "bot") return needText(run);
        const text = await fieldText({
          goal: run.goal,
          field: { label: action.label, role: action.role, value: action.value },
          page: { title: run.page.title, text: run.page.text.slice(0, 6000) },
          recentActions: run.history,
        });
        await applyFill(run, text);
        continue;
      }

      try {
        await run.browser.act(action);
      } catch (error) {
        if (!(error instanceof StalePage)) throw error;
        run.page = await run.browser.observe();
        continue;
      }

      const before = run.page;
      run.page = await run.browser.observe();
      run.history.push({
        action: action.label,
        kind: action.kind,
        pageChanged: run.page.url !== before.url || run.page.text !== before.text,
      });
      record(run, decision.operation, decision.target, execute, decision.confidence, latencyMs, run.page.url);
      run.step += 1;
    }

    return await stop("budget", run, `Stopped after ${run.maxSteps} actions`);
  } catch (error) {
    await abortFastWebTask();
    throw error;
  }
}

function record(
  run: Run,
  operation: string,
  target: string | null,
  execute: string,
  confidence: number | null,
  latencyMs: number,
  url = run.page.url,
): void {
  run.steps.push({
    step: run.step,
    operation,
    target,
    execute,
    url,
    latencyMs,
    confidence,
  });
}

function snapshot(run: Run): Omit<FastWebTaskResult, "status"> {
  return {
    url: run.page.url,
    title: run.page.title,
    text: run.page.text.slice(0, 2000),
    steps: run.steps,
    elapsedMs: Math.round(performance.now() - run.started),
    goal: run.goal,
  };
}

function needText(run: Run): FastWebTaskResult {
  const pending = run.pending;
  return {
    ...snapshot(run),
    status: "need_text",
    field: {
      label: pending?.action.label ?? "",
      role: pending?.action.role,
      value: pending?.action.value,
    },
    next: "Write the exact string for this field from the goal, then call fast_web_fill({ text }). Do not screenshot. Do not call fast_web_task again until this run finishes.",
  };
}

async function stop(
  status: Exclude<FastWebTaskResult["status"], "need_text">,
  run: Run,
  reason?: string,
): Promise<FastWebTaskResult> {
  const result = { ...snapshot(run), status, reason };
  await abortFastWebTask();
  return result;
}
