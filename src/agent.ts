import { actionSpace, type ActionSpace, type ObservedPage, type SnapshotAction } from "./action-space.ts";
import { FastBrowser, StalePage } from "./browser.ts";
import { buildUiActionQuestions } from "./choose-ui-action.ts";
import type { Progress, RecentAction } from "./choose-ui-action.ts";
import { setting } from "./env.ts";
import { evaluateWithGateway } from "./evaluate.ts";
import { fieldText } from "./fill-text.ts";
import { resolveUiDecision } from "./format.ts";
import { freshRecovery, madeProgress, recoveryFor, type RecoveryTried } from "./progress.ts";
import { LOW_CONFIDENCE, MAX_RUN_MS, MAX_STEPS, NO_PROGRESS_LIMIT, PLAN_TOP_K } from "./questions.ts";

export type FillMode = "bot" | "helper";

export interface FastWebTaskInput {
  url?: string;
  goal: string;
  maxSteps?: number;
  maxMs?: number;
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
  note?: string;
  pageChanged?: boolean;
  /** Consecutive no-progress steps after this one. */
  noProgress?: number;
}

export interface NeedTextField {
  label: string;
  role?: string;
  value?: string;
}

export interface RunStats {
  gatewayMs: number;
  recoveries: number;
  lowConfidence: number;
  failedTargets: number;
  offscreenClicks: number;
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
  attachedTo?: string;
  display?: string;
  visited?: string[];
  stats?: RunStats;
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
  maxMs: number;
  deadline: number;
  fillMode: FillMode;
  step: number;
  page: ObservedPage;
  history: RecentAction[];
  steps: FastWebStep[];
  started: number;
  pending: PendingFill | undefined;
  keepOpen: boolean | undefined;
  /** Overlays whose dismiss control the loop already clicked on its own. */
  dismissTried: Set<number>;
  visited: string[];
  /** Consecutive steps that changed neither URL nor content. */
  streak: number;
  recovery: RecoveryTried;
  stats: RunStats;
  topK: number;
  noProgressLimit: number;
}

let active: Run | undefined;

function numberSetting(name: string, fallback: number, min: number, max: number): number {
  const value = Number(setting(name));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

function runBudgetMs(input: FastWebTaskInput): number {
  const fallback = numberSetting("MAX_RUN_MS", MAX_RUN_MS, 1_000, 10 * 60_000);
  const requested = input.maxMs ?? fallback;
  return Math.min(Math.max(requested, 1_000), fallback);
}

function freshStats(): RunStats {
  return { gatewayMs: 0, recoveries: 0, lowConfidence: 0, failedTargets: 0, offscreenClicks: 0 };
}

function resetProgress(run: Run, goal: string, maxSteps: number, maxMs: number, fillMode: FillMode): void {
  run.goal = goal;
  run.maxSteps = maxSteps;
  run.maxMs = maxMs;
  run.fillMode = fillMode;
  run.step = 1;
  run.history = [];
  run.steps = [];
  run.started = performance.now();
  run.deadline = run.started + maxMs;
  run.pending = undefined;
  run.dismissTried = new Set();
  run.visited = [run.page.url];
  run.streak = 0;
  run.recovery = freshRecovery();
  run.stats = freshStats();
}

export async function startFastWebTask(input: FastWebTaskInput): Promise<FastWebTaskResult> {
  const fillMode = input.fillMode ?? "bot";
  const maxSteps = Math.min(input.maxSteps ?? MAX_STEPS, MAX_STEPS);
  const maxMs = runBudgetMs(input);
  const topK = numberSetting("PLAN_TOP_K", PLAN_TOP_K, 0, 120);
  const noProgressLimit = numberSetting("NO_PROGRESS_LIMIT", NO_PROGRESS_LIMIT, 1, 20);

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
      run.topK = topK;
      run.noProgressLimit = noProgressLimit;
      run.page = await run.browser.observe({ goal: input.goal, topK });
      resetProgress(run, input.goal, maxSteps, maxMs, fillMode);
      run.keepOpen = input.keepOpen ?? run.keepOpen;
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
    const page = await browser.observe({ goal: input.goal, topK });
    const run: Run = {
      browser,
      goal: input.goal,
      maxSteps,
      maxMs,
      deadline: 0,
      fillMode,
      step: 1,
      page,
      history: [],
      steps: [],
      started: 0,
      pending: undefined,
      keepOpen: input.keepOpen,
      dismissTried: new Set(),
      visited: [],
      streak: 0,
      recovery: freshRecovery(),
      stats: freshStats(),
      topK,
      noProgressLimit,
    };
    resetProgress(run, input.goal, maxSteps, maxMs, fillMode);
    active = run;
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
  // Time spent waiting for the Bot to write the string is not the loop's budget.
  run.deadline = performance.now() + run.maxMs;
  try {
    await applyFill(run, value);
  } catch (error) {
    await abortFastWebTask();
    throw error;
  }
  return await advanceActive();
}

export async function abortFastWebTask(): Promise<void> {
  const run = active;
  active = undefined;
  await run?.browser.close();
}

interface Outcome {
  ok: boolean;
  progressed: boolean;
  pageChanged: boolean;
}

/**
 * Execute one action, re-observe, and update the progress gate. A covered or
 * vanished target is recorded as failed so Jev does not pick it again.
 */
async function perform(run: Run, action: SnapshotAction, text?: string, note?: string): Promise<Outcome> {
  const before = run.page;
  let ok = true;
  let failed: string | undefined;
  try {
    await run.browser.act(action, text);
  } catch (error) {
    if (!(error instanceof StalePage)) throw error;
    ok = false;
    failed = "target was covered or removed before it could be used; it is not offered again";
    run.stats.failedTargets += 1;
  }
  run.page = await run.browser.observe({ goal: run.goal, topK: run.topK });
  const delta = {
    urlChanged: run.page.url !== before.url,
    textChanged: run.page.text !== before.text,
  };
  const progressed = madeProgress(action.kind, delta, ok);
  if (delta.urlChanged && run.visited[run.visited.length - 1] !== run.page.url) run.visited.push(run.page.url);
  if (progressed) {
    run.streak = 0;
    run.recovery = freshRecovery();
  } else {
    run.streak += 1;
  }
  if (action.kind === "scroll") {
    if ((action.delta ?? 0) >= 0) run.recovery.scrollDown = true;
    else run.recovery.scrollUp = true;
  }
  if (action.kind === "back") run.recovery.back = true;
  if (ok && action.offscreen) run.stats.offscreenClicks += 1;

  run.history.push({
    action: action.label,
    kind: action.kind,
    text,
    pageChanged: ok && (delta.urlChanged || delta.textChanged),
    failed,
    note,
  });
  return { ok, progressed, pageChanged: delta.urlChanged || delta.textChanged };
}

async function applyFill(run: Run, text: string): Promise<void> {
  const pending = run.pending;
  if (!pending) return;
  run.pending = undefined;
  const outcome = await perform(run, pending.action, text);
  run.steps.push({
    step: run.step,
    operation: pending.operation,
    target: pending.target,
    execute: pending.execute,
    text,
    url: run.page.url,
    latencyMs: pending.latencyMs,
    confidence: pending.confidence,
    note: outcome.ok ? undefined : "field was covered; nothing typed",
    pageChanged: outcome.pageChanged,
    noProgress: run.streak,
  });
  run.step += 1;
}

/**
 * Jev chose TYPE_TEXT outside an open overlay that still has an untried dismiss
 * control. Click that control instead. Pausing for need_text under a banner
 * freezes the page with the banner up; the Bot then fills into a covered field.
 */
async function dismissBeforeTyping(
  run: Run,
  space: ActionSpace,
  action: SnapshotAction,
  confidence: number | null,
  latencyMs: number,
): Promise<boolean> {
  if (action.kind !== "fill" || action.overlay != null) return false;
  const candidate = space.dismissFor(run.dismissTried);
  if (!candidate) return false;
  run.dismissTried.add(candidate.overlay);
  const note = `dismissed overlay before TYPE_TEXT into "${action.label}"`;
  const outcome = await perform(run, candidate.action, undefined, note);
  record(run, "CLICK", candidate.index, `CLICK [${candidate.index}]`, confidence, latencyMs, outcome, note);
  run.step += 1;
  return true;
}

function progressState(run: Run): Progress {
  return {
    visited_urls: run.visited.slice(-8),
    no_progress_steps: run.streak,
    step: run.step,
    max_steps: run.maxSteps,
  };
}

async function advanceActive(): Promise<FastWebTaskResult> {
  const run = active;
  if (!run) throw new Error("No active web task");

  try {
    while (run.step <= run.maxSteps) {
      if (performance.now() >= run.deadline) {
        return await stop("budget", run, `Stopped after ${Math.round(run.maxMs / 1000)}s of wall-clock time`);
      }
      if (run.streak >= run.noProgressLimit) {
        return await stop(
          "blocked",
          run,
          `No progress after ${run.streak} consecutive steps. Use screenshot computer use on this page.`,
        );
      }

      const space = actionSpace(run.page, run.goal, run.history, {
        progress: progressState(run),
        canGoBack: run.browser.canGoBack,
      });
      const built = buildUiActionQuestions(space.input);
      const started = performance.now();
      const decided = await evaluateWithGateway({
        state: built.state,
        questions: built.questions,
      });
      const latencyMs = Math.round(performance.now() - started);
      run.stats.gatewayMs += latencyMs;
      const decision = resolveUiDecision(decided.answers, decided.confidence);
      const execute =
        decision.operation === "DONE" || decision.operation === "BLOCKED"
          ? decision.operation
          : decision.target
            ? `${decision.operation} [${decision.target}]`
            : decision.operation;
      const lowConfidence = decision.confidence != null && decision.confidence < LOW_CONFIDENCE;
      if (lowConfidence) run.stats.lowConfidence += 1;

      if (decision.operation === "DONE") {
        record(run, decision.operation, decision.target, execute, decision.confidence, latencyMs);
        return await stop("done", run);
      }

      if (decision.operation === "BLOCKED" || !decision.operation) {
        const candidates = space.offscreenCandidates();
        const recovery = recoveryFor({
          streak: run.streak,
          limit: run.noProgressLimit,
          canScrollDown: space.canScroll("down"),
          canScrollUp: space.canScroll("up"),
          canGoBack: run.browser.canGoBack,
          tried: run.recovery,
          candidates,
          deadEnd: candidates.length === 0 && !space.hasMainContent(),
        });
        if ("stop" in recovery) {
          record(run, "BLOCKED", null, "BLOCKED", decision.confidence, latencyMs);
          return await stop("blocked", run, `${recovery.reason}. Use screenshot computer use on this page.`);
        }
        let action: SnapshotAction | undefined;
        let target: string | null = null;
        if (recovery.operation === "CLICK") {
          run.recovery.candidates.add(recovery.candidate.node);
          action = space.resolve("CLICK", recovery.candidate.index);
          target = recovery.candidate.index;
        } else {
          action = space.resolve(recovery.operation, null);
        }
        if (!action) {
          record(run, "BLOCKED", null, "BLOCKED", decision.confidence, latencyMs);
          return await stop("blocked", run, "Jev could not progress on this page. Use screenshot computer use.");
        }
        run.stats.recoveries += 1;
        const outcome = await perform(run, action, undefined, recovery.reason);
        const execute = target ? `${recovery.operation} [${target}]` : recovery.operation;
        record(run, recovery.operation, target, execute, decision.confidence, latencyMs, outcome, recovery.reason);
        run.step += 1;
        continue;
      }

      const action = space.resolve(decision.operation, decision.target);
      if (!action) {
        // Jev named something the executor cannot map. Count it against the gate
        // and let Jev see the failure instead of ending the run.
        run.streak += 1;
        run.stats.failedTargets += 1;
        run.history.push({
          action: execute,
          kind: "click",
          pageChanged: false,
          failed: "no live node matched this choice; it is not offered again",
        });
        record(run, decision.operation, decision.target, execute, decision.confidence, latencyMs, undefined, "no live node");
        run.step += 1;
        continue;
      }

      if (await dismissBeforeTyping(run, space, action, decision.confidence, latencyMs)) continue;

      const confidenceNote = lowConfidence ? `low confidence ${decision.confidence?.toFixed(2)}` : undefined;

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

      const outcome = await perform(run, action, undefined, confidenceNote);
      record(
        run,
        decision.operation,
        decision.target,
        execute,
        decision.confidence,
        latencyMs,
        outcome,
        [outcome.ok ? undefined : "target was covered; not clicked", action.offscreen ? "scrolled into view" : undefined, confidenceNote]
          .filter(Boolean)
          .join("; ") || undefined,
      );
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
  outcome?: Outcome,
  note?: string,
): void {
  run.steps.push({
    step: run.step,
    operation,
    target,
    execute,
    url: run.page.url,
    latencyMs,
    confidence,
    note,
    pageChanged: outcome?.pageChanged,
    noProgress: run.streak,
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
    attachedTo: run.browser.attachedTo,
    display: process.env.DISPLAY || undefined,
    visited: run.visited,
    stats: run.stats,
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
  // run did not finish. A done run in crack-bot's own Chromium has nothing to hand off.
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
    ? " attached=true: this is the Bot's Chrome. Do not quit it. fast_web_abort closes only the crack-bot tab."
    : " Call fast_web_abort to close this browser.";
  if (status === "done") {
    return `${tab} Call fast_web_task({ reuseBrowser: true, goal }) to continue on this page.${guest}`;
  }
  if (status === "blocked") {
    return `${tab} Use screenshot computer use on this same page (CAPTCHA, canvas, 2FA). Do not open a new window. Or retry with fast_web_task({ reuseBrowser: true, goal }).${guest}`;
  }
  return `${tab} Continue with fast_web_task({ reuseBrowser: true, goal, maxSteps }).${guest}`;
}
