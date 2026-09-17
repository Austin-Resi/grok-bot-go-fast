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
  url?: string;
  goal: string;
  maxSteps?: number;
  fillMode?: FillMode;
  keepOpen?: boolean;
  reuseBrowser?: boolean;
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
  open?: boolean;
  attached?: boolean;
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
  keepOpen: boolean | undefined;
}

let active: Run | undefined;

export async function startFastWebTask(input: FastWebTaskInput): Promise<FastWebTaskResult> {
  const fillMode = input.fillMode ?? "bot";
  const maxSteps = Math.min(input.maxSteps ?? MAX_STEPS, MAX_STEPS);

  if (input.reuseBrowser) {
    const run = active;
    if (!run) {
      throw new Error("No open browser. Start with fast_web_task and a url, or the previous run already closed.");
    }
    if (run.pending) {
      throw new Error("A TYPE_TEXT is waiting. Call fast_web_fill with the string, or fast_web_abort to drop it.");
    }
    try {
      if (input.url) await run.browser.goto(input.url);
      run.page = await run.browser.observe();
      run.goal = input.goal;
      run.maxSteps = maxSteps;
      run.fillMode = fillMode;
      run.keepOpen = input.keepOpen ?? run.keepOpen;
      run.step = 1;
      run.history = [];
      run.steps = [];
      run.started = performance.now();
      run.pending = undefined;
      return await advanceActive();
    } catch (error) {
      await abortFastWebTask();
      throw error;
    }
  }

  const url = input.url?.trim();
  if (!url) throw new Error("Provide a url, or set reuseBrowser: true to keep the open page.");

  await abortFastWebTask();
  const browser = new FastBrowser();
  try {
    await browser.open(url);
    const page = await browser.observe();
    active = {
      browser,
      goal: input.goal,
      maxSteps,
      fillMode,
      step: 1,
      page,
      history: [],
      steps: [],
      started: performance.now(),
      pending: undefined,
      keepOpen: input.keepOpen,
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
    attached: run.browser.attached,
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
    open: true,
  };
}

async function stop(
  status: Exclude<FastWebTaskResult["status"], "need_text">,
  run: Run,
  reason?: string,
): Promise<FastWebTaskResult> {
  run.pending = undefined;
  // Default: keep the tab for handoff when it is the Bot's Chrome, or when the
  // run did not finish. A done run in Jev's own Chromium has nothing to hand off.
  const keepOpen = run.keepOpen ?? (run.browser.attached || status !== "done");
  if (keepOpen) await run.browser.focus();
  const result: FastWebTaskResult = {
    ...snapshot(run),
    status,
    reason,
    open: keepOpen,
    next: stopNext(status, run, keepOpen),
  };
  if (!keepOpen) await abortFastWebTask();
  return result;
}

function stopNext(
  status: Exclude<FastWebTaskResult["status"], "need_text">,
  run: Run,
  keepOpen: boolean,
): string | undefined {
  if (!keepOpen) return undefined;
  const tab = `This tab is still open at ${run.page.url}.`;
  const guest = run.browser.attached
    ? " attached=true: this is the Bot's Chrome. Do not quit it. fast_web_abort closes only the Jev tab."
    : " Call fast_web_abort to close this browser.";
  if (status === "done") {
    return `${tab} Call fast_web_task({ reuseBrowser: true, goal }) to continue on this page.${guest}`;
  }
  if (status === "blocked") {
    return `${tab} Use screenshot computer use on this same page (CAPTCHA, canvas, 2FA). Do not open a new window. Or retry with fast_web_task({ reuseBrowser: true, goal }).${guest}`;
  }
  return `${tab} Continue with fast_web_task({ reuseBrowser: true, goal, maxSteps }).${guest}`;
}
