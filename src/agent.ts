import { actionSpace, type ActionSpace, type ObservedPage, type SnapshotAction } from "./action-space.ts";
import { FastBrowser, StalePage } from "./browser.ts";
import { buildUiActionQuestions } from "./choose-ui-action.ts";
import type { Progress, RecentAction } from "./choose-ui-action.ts";
import { setting } from "./env.ts";
import { evaluateWithGateway } from "./evaluate.ts";
import { matchField, type TaskData } from "./field-match.ts";
import { fieldText } from "./fill-text.ts";
import { resolveUiDecision } from "./format.ts";
import { madeProgress, shouldAsk, type AskReason } from "./progress.ts";
import {
  ASK_MARGIN,
  ASK_OPTIONS,
  IRREVERSIBLE,
  LOW_CONFIDENCE,
  MAX_RUN_MS,
  MAX_STEPS,
  NO_PROGRESS_LIMIT,
  PLAN_TOP_K,
  ROUTE_FLOOR,
  ROUTE_HOPS,
  STEPPING_STONE,
} from "./questions.ts";

export type FillMode = "bot" | "helper";

export interface FastWebTaskInput {
  url?: string;
  goal: string;
  /** Values the Bot already knows (title, price, tags…). Typed into matching fields without a round trip. */
  data?: TaskData;
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

/** One option the Bot can pick in a need_decision. */
export interface DecisionOption {
  /** Pass this to fast_web_choose. */
  index: string;
  operation: string;
  label: string;
  role?: string;
  href?: string;
  offscreen?: "above" | "below";
  main?: boolean;
  /** Jev's probability for this option, when it gave one. */
  probability?: number;
}

export interface NeedDecision {
  reason: AskReason | "irreversible";
  /** Jev's own pick, when it had one. Confirming it is a valid answer. */
  jev?: { operation: string; index: string | null; label?: string; confidence: number | null };
  options: DecisionOption[];
  /** Always available: BACK (if history), SCROLL_DOWN/UP (if scrollable), DONE, STOP. */
  controls: string[];
}

export interface RunStats {
  gatewayMs: number;
  asks: number;
  lowConfidence: number;
  failedTargets: number;
  offscreenClicks: number;
  /** Stepping-stone hops Jev took on its own after a BLOCKED. */
  routeHops: number;
  /** Fields filled from provided data without asking the Bot. */
  dataFills: number;
}

export interface FastWebTaskResult {
  status: "done" | "blocked" | "budget" | "need_text" | "need_decision";
  url: string;
  title: string;
  text: string;
  steps: FastWebStep[];
  elapsedMs: number;
  reason?: string;
  next?: string;
  field?: NeedTextField;
  decision?: NeedDecision;
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

interface PendingDecision {
  space: ActionSpace;
  options: DecisionOption[];
  latencyMs: number;
  confidence: number | null;
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
  decision: PendingDecision | undefined;
  keepOpen: boolean | undefined;
  /** Overlays whose dismiss control the loop already clicked on its own. */
  dismissTried: Set<number>;
  visited: string[];
  /** Consecutive steps that changed neither URL nor content. */
  streak: number;
  /** Whether the free scroll-and-re-ask has been used since the last progress. */
  scrolledForBlocked: boolean;
  stats: RunStats;
  topK: number;
  noProgressLimit: number;
  askMargin: number;
  routeFloor: number;
  routeHopLimit: number;
  /** Consecutive stepping-stone hops since the last Bot decision. */
  routeHops: number;
  data: TaskData;
  dataUsed: Set<string>;
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
  return { gatewayMs: 0, asks: 0, lowConfidence: 0, failedTargets: 0, offscreenClicks: 0, routeHops: 0, dataFills: 0 };
}

function resetProgress(run: Run, goal: string, maxSteps: number, maxMs: number, fillMode: FillMode, data: TaskData): void {
  run.goal = goal;
  run.data = data;
  run.dataUsed = new Set();
  run.maxSteps = maxSteps;
  run.maxMs = maxMs;
  run.fillMode = fillMode;
  run.step = 1;
  run.history = [];
  run.steps = [];
  run.started = performance.now();
  run.deadline = run.started + maxMs;
  run.pending = undefined;
  run.decision = undefined;
  run.dismissTried = new Set();
  run.visited = [run.page.url];
  run.streak = 0;
  run.scrolledForBlocked = false;
  run.routeHops = 0;
  run.stats = freshStats();
}

export async function startFastWebTask(input: FastWebTaskInput): Promise<FastWebTaskResult> {
  const fillMode = input.fillMode ?? "bot";
  const maxSteps = Math.min(input.maxSteps ?? MAX_STEPS, MAX_STEPS);
  const maxMs = runBudgetMs(input);
  const topK = numberSetting("PLAN_TOP_K", PLAN_TOP_K, 0, 5000);
  const noProgressLimit = numberSetting("NO_PROGRESS_LIMIT", NO_PROGRESS_LIMIT, 1, 20);
  const askMargin = numberSetting("ASK_MARGIN", ASK_MARGIN, 0, 1);
  const routeFloor = numberSetting("ROUTE_FLOOR", ROUTE_FLOOR, 0, 1);
  const routeHopLimit = numberSetting("ROUTE_HOPS", ROUTE_HOPS, 0, 40);
  const data = input.data ?? {};

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
      run.askMargin = askMargin;
      run.routeFloor = routeFloor;
      run.routeHopLimit = routeHopLimit;
      run.page = await run.browser.observe({ goal: input.goal, topK });
      resetProgress(run, input.goal, maxSteps, maxMs, fillMode, data);
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
      decision: undefined,
      keepOpen: input.keepOpen,
      dismissTried: new Set(),
      visited: [],
      streak: 0,
      scrolledForBlocked: false,
      stats: freshStats(),
      topK,
      noProgressLimit,
      askMargin,
      routeFloor,
      routeHopLimit,
      routeHops: 0,
      data,
      dataUsed: new Set(),
    };
    resetProgress(run, input.goal, maxSteps, maxMs, fillMode, data);
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

export interface ChooseInput {
  /** An option index from need_decision, or a control: BACK, SCROLL_DOWN, SCROLL_UP, DONE, STOP. */
  choice: string;
  /** Optionally narrow the goal for the remaining steps (e.g. the next stepping stone). */
  goal?: string;
}

/** Answer a need_decision. The Bot is System 2 here; its pick is executed unasked. */
export async function chooseFastWebTask(input: ChooseInput): Promise<FastWebTaskResult> {
  const run = active;
  if (!run?.decision) {
    throw new Error("No decision is waiting. fast_web_choose answers a need_decision result.");
  }
  const pending = run.decision;
  run.decision = undefined;
  run.deadline = performance.now() + run.maxMs;
  if (input.goal?.trim()) run.goal = input.goal.trim();
  const choice = input.choice.trim().toUpperCase();

  try {
    if (choice === "STOP") return await stop("blocked", run, "The Bot stopped this run.");
    if (choice === "DONE") {
      record(run, "DONE", null, "DONE", pending.confidence, pending.latencyMs, undefined, "confirmed by the Bot");
      return await stop("done", run);
    }

    let action: SnapshotAction | undefined;
    let operation: string;
    let target: string | null = null;
    if (choice === "BACK" || choice === "SCROLL_DOWN" || choice === "SCROLL_UP") {
      operation = choice;
      action = pending.space.resolve(choice, null);
    } else {
      const option = pending.options.find((o) => o.index === input.choice.trim());
      if (!option) {
        throw new Error(`"${input.choice}" is not an offered option. Use an index from decision.options or one of ${describeControls(pending.space, run)}.`);
      }
      operation = option.operation;
      target = option.index;
      action = pending.space.resolve(option.operation, option.index);
    }
    if (!action) throw new Error(`"${input.choice}" is not available on this page any more.`);

    const note = "chosen by the Bot";
    if (action.kind === "fill") {
      run.pending = { action, execute: `TYPE_TEXT [${target}]`, operation: "TYPE_TEXT", target, confidence: pending.confidence, latencyMs: pending.latencyMs };
      const paused = await resolveFill(run);
      if (paused) return paused;
    } else {
      const outcome = await perform(run, action, undefined, note);
      record(run, operation, target, target ? `${operation} [${target}]` : operation, pending.confidence, pending.latencyMs, outcome, note);
      run.step += 1;
    }
    // A Bot decision is a fresh start for the gate: the planner has weighed in.
    run.streak = 0;
    run.scrolledForBlocked = false;
    run.routeHops = 0;
    return await advanceActive();
  } catch (error) {
    await abortFastWebTask();
    throw error;
  }
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

/** Field values, checks and selections, so typing into a form counts as progress. */
function formState(page: ObservedPage): string {
  return page.actions
    .filter((a) => a.node != null && (a.kind === "fill" || a.kind === "select" || a.checked != null))
    .map((a) => `${a.node}:${a.kind === "select" ? a.current_value ?? "" : a.value ?? ""}:${a.checked ?? ""}`)
    .join("|");
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
  try {
    run.page = await run.browser.observe({ goal: run.goal, topK: run.topK });
  } catch (error) {
    if (!(error instanceof StalePage)) throw error;
    // The page never settled (media, long-running navigation). Keep the last
    // good snapshot, count the step as no progress, and let the loop decide.
    ok = false;
    failed = "page did not finish loading after this action";
    run.stats.failedTargets += 1;
  }
  const delta = {
    urlChanged: run.page.url !== before.url,
    textChanged: run.page.text !== before.text,
    fieldsChanged: formState(run.page) !== formState(before),
  };
  const progressed = madeProgress(action.kind, delta, ok);
  if (delta.urlChanged && run.visited[run.visited.length - 1] !== run.page.url) run.visited.push(run.page.url);
  if (progressed) {
    run.streak = 0;
    run.scrolledForBlocked = false;
  } else {
    run.streak += 1;
  }
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

/**
 * A TYPE_TEXT is pending. Fill it from the Bot's provided data when one value
 * clearly fits (one cheap Jev comparison, no round trip), else from the helper
 * model in helper mode, else pause with need_text. Returns the pause result or
 * undefined when the fill was applied.
 */
async function resolveFill(run: Run): Promise<FastWebTaskResult | undefined> {
  const pending = run.pending;
  if (!pending) return undefined;
  const field = { label: pending.action.label, role: pending.action.role, value: pending.action.value };

  if (Object.keys(run.data).length) {
    const match = await matchField({ goal: run.goal, field, pageTitle: run.page.title, data: run.data, used: run.dataUsed });
    if (match) {
      run.stats.gatewayMs += match.gatewayMs;
      run.stats.dataFills += 1;
      run.dataUsed.add(match.key);
      await applyFill(run, match.text, `from data.${match.key} (p=${match.probability.toFixed(2)})`);
      return undefined;
    }
  }

  if (run.fillMode === "bot") return needText(run);
  const text = await fieldText({
    goal: run.goal,
    field,
    page: { title: run.page.title, text: run.page.text.slice(0, 6000) },
    recentActions: run.history,
  });
  await applyFill(run, text, "from helper model");
  return undefined;
}

async function applyFill(run: Run, text: string, source?: string): Promise<void> {
  const pending = run.pending;
  if (!pending) return;
  run.pending = undefined;
  const outcome = await perform(run, pending.action, text, source);
  run.steps.push({
    step: run.step,
    operation: pending.operation,
    target: pending.target,
    execute: pending.execute,
    text,
    url: run.page.url,
    latencyMs: pending.latencyMs,
    confidence: pending.confidence,
    note: [outcome.ok ? undefined : "field was covered; nothing typed", source].filter(Boolean).join("; ") || undefined,
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

function describeControls(space: ActionSpace, run: Run): string {
  const controls = ["DONE", "STOP"];
  if (run.browser.canGoBack) controls.unshift("BACK");
  if (space.canScroll("up")) controls.unshift("SCROLL_UP");
  if (space.canScroll("down")) controls.unshift("SCROLL_DOWN");
  return controls.join(", ");
}

/** Human-readable page title from a link, so Jev judges the destination, not the anchor text. */
function pageTitle(href: string | undefined, label: string): string {
  if (href) {
    try {
      const path = decodeURIComponent(new URL(href, "https://x/").pathname);
      const last = path.split("/").filter(Boolean).pop();
      if (last && !/\.\w{2,5}$/.test(last)) return last.replace(/[_-]+/g, " ").slice(0, 80);
    } catch {
      /* fall through to label */
    }
  }
  return label.replace(/\s+/g, " ").slice(0, 80);
}

function visitedTitles(run: Run): string[] {
  return run.visited.map((u) => pageTitle(u, u));
}

interface SteppingStone {
  probabilities: Record<string, number>;
  pick?: { index: string; probability: number };
}

/**
 * When Jev said BLOCKED on the action question, ask it the routing question
 * instead: which reachable page is closer to the goal. Main-content links only,
 * pages already visited excluded. Returns Jev's ranking and its top pick.
 */
async function rankSteppingStones(run: Run, space: ActionSpace): Promise<SteppingStone> {
  const visited = new Set(visitedTitles(run));
  const links = space.input.elements.filter(
    (e) =>
      e.operations.includes("CLICK") &&
      !e.overlay &&
      (e.main || e.offscreen) &&
      e.role !== "button" &&
      !visited.has(pageTitle(e.href, e.label)),
  );
  if (links.length < 2) return { probabilities: {} };
  const criteria: Record<string, unknown> = {};
  for (const e of links.slice(0, 250)) criteria[e.index] = { page: pageTitle(e.href, e.label) };
  try {
    const started = performance.now();
    const result = await evaluateWithGateway({
      state: { current_page: pageTitle(run.page.url, run.page.title), goal: run.goal, visited: [...visited].slice(-8) },
      questions: { stepping_stone: { type: "choice", instructions: STEPPING_STONE, criteria } },
    });
    run.stats.gatewayMs += Math.round(performance.now() - started);
    const answer = result.answers.stepping_stone as { choice?: string; probabilities?: Record<string, number> } | undefined;
    const probabilities = answer?.probabilities ?? {};
    const pick = answer?.choice ? { index: answer.choice, probability: probabilities[answer.choice] ?? 0 } : undefined;
    return { probabilities, pick };
  } catch {
    return { probabilities: {} };
  }
}

/**
 * Build the option list for a need_decision: main-content links ordered by
 * Jev's probability, then the goal-ranked offscreen shortlist, then remaining
 * main-content viewport controls. Site chrome is left out; the Bot has BACK,
 * SCROLL and STOP as controls. Deduped by element index.
 */
function decisionOptions(space: ActionSpace, probabilities: Record<string, number>, operation: string): DecisionOption[] {
  const byIndex = new Map(space.input.elements.map((e) => [e.index, e]));
  const seen = new Set<string>();
  const out: DecisionOption[] = [];
  const push = (index: string, op: string, probability?: number) => {
    if (seen.has(index) || out.length >= ASK_OPTIONS) return;
    const element = byIndex.get(index);
    if (!element || !element.operations.includes(op)) return;
    seen.add(index);
    out.push({
      index,
      operation: op,
      label: element.label.replace(/\s+/g, " ").slice(0, 80),
      role: element.role,
      href: element.href,
      offscreen: element.offscreen,
      main: element.main,
      probability,
    });
  };
  const clickOp = operation === "SELECT" || operation === "TYPE_TEXT" ? operation : "CLICK";
  for (const [index, p] of Object.entries(probabilities).sort((a, b) => b[1] - a[1])) {
    if (p >= 0.01) push(index, clickOp, p);
  }
  for (const c of space.offscreenCandidates()) push(c.index, "CLICK");
  for (const e of space.input.elements) {
    if (e.main && !e.offscreen && e.operations.includes("CLICK")) push(e.index, "CLICK");
  }
  return out;
}

async function advanceActive(): Promise<FastWebTaskResult> {
  const run = active;
  if (!run) throw new Error("No active web task");

  try {
    while (run.step <= run.maxSteps) {
      if (performance.now() >= run.deadline) {
        return await stop("budget", run, `Stopped after ${Math.round(run.maxMs / 1000)}s of wall-clock time`);
      }

      const space = actionSpace(run.page, run.goal, run.history, {
        progress: progressState(run),
        canGoBack: run.browser.canGoBack,
        providedValues: Object.keys(run.data).filter((k) => !run.dataUsed.has(k)),
      });

      // The gate tripped: stop guessing, hand the page to the planner with options.
      if (run.streak >= run.noProgressLimit) {
        const ranked = await rankSteppingStones(run, space);
        return ask(run, space, "blocked", { operation: "BLOCKED", target: null, confidence: null, targetProbabilities: ranked.probabilities }, 0,
          `No progress after ${run.streak} consecutive steps`);
      }

      const built = buildUiActionQuestions(space.input);
      const started = performance.now();
      const decided = await evaluateWithGateway({ state: built.state, questions: built.questions });
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

      const askReason = shouldAsk({
        operation: decision.operation,
        operationProbabilities: decision.operationProbabilities,
        targetProbabilities: decision.targetProbabilities,
        minMargin: run.askMargin,
        chromeTargets: new Set(space.input.elements.filter((e) => !e.main && !e.overlay).map((e) => e.index)),
      });

      if (askReason === "blocked") {
        // Jev will not plan a route on the action question, but it routes well when
        // asked "which page is closer to the goal". Follow that pick while it is
        // confident enough and we have not wandered too long.
        const ranked = await rankSteppingStones(run, space);
        const pick = ranked.pick;
        const stone = pick && pick.probability >= run.routeFloor ? space.resolve("CLICK", pick.index) : undefined;
        if (pick && stone && run.routeHops < run.routeHopLimit) {
          run.routeHops += 1;
          run.stats.routeHops += 1;
          const note = `route: "${pageTitle(stone.href, stone.label)}" is closer to the goal (p=${pick.probability.toFixed(2)})`;
          const outcome = await perform(run, stone, undefined, note);
          record(run, "CLICK", pick.index, `CLICK [${pick.index}]`, pick.probability, latencyMs, outcome, note);
          run.step += 1;
          continue;
        }
        // No route either. One free scroll before asking: the routing question only
        // saw the shortlist, and the answer may be a control further down.
        if (!run.scrolledForBlocked && space.canScroll("down")) {
          run.scrolledForBlocked = true;
          const scroll = space.resolve("SCROLL_DOWN", null)!;
          const note = "Jev chose BLOCKED and found no route; scrolling once before asking";
          const outcome = await perform(run, scroll, undefined, note);
          record(run, "SCROLL_DOWN", null, "SCROLL_DOWN", decision.confidence, latencyMs, outcome, note);
          run.step += 1;
          continue;
        }
        record(run, "BLOCKED", null, "BLOCKED", decision.confidence, latencyMs, undefined, "asked the Bot");
        const why =
          stone && run.routeHops >= run.routeHopLimit
            ? `${run.routeHops} stepping-stone hops without reaching the goal; checking in`
            : "Jev cannot advance the goal in one step from this page";
        run.routeHops = 0;
        return ask(run, space, "blocked", { ...decision, targetProbabilities: ranked.probabilities }, latencyMs, why);
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

      if (askReason) {
        record(run, decision.operation, decision.target, execute, decision.confidence, latencyMs, undefined, `asked the Bot (${askReason})`);
        return ask(run, space, askReason, decision, latencyMs, askReason === "torn_operation"
          ? "Jev is torn between operations"
          : "Jev is torn between targets");
      }

      if (action.kind === "click" && IRREVERSIBLE.test(action.label.trim())) {
        record(run, decision.operation, decision.target, execute, decision.confidence, latencyMs, undefined, "asked the Bot (irreversible)");
        return ask(run, space, "irreversible", decision, latencyMs, `"${action.label}" is hard to undo; confirm before clicking`);
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
        const paused = await resolveFill(run);
        if (paused) return paused;
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

function ask(
  run: Run,
  space: ActionSpace,
  reason: NeedDecision["reason"],
  decision: { operation: string; target: string | null; confidence: number | null; targetProbabilities: Record<string, number> },
  latencyMs: number,
  why: string,
): FastWebTaskResult {
  const options = decisionOptions(space, decision.targetProbabilities, decision.operation);
  run.decision = { space, options, latencyMs, confidence: decision.confidence };
  run.stats.asks += 1;
  const jevLabel = decision.target ? space.input.elements.find((e) => e.index === decision.target)?.label : undefined;
  return {
    ...snapshot(run),
    status: "need_decision",
    reason: why,
    decision: {
      reason,
      jev:
        decision.operation && decision.operation !== "BLOCKED"
          ? { operation: decision.operation, index: decision.target, label: jevLabel, confidence: decision.confidence }
          : undefined,
      options,
      controls: describeControls(space, run).split(", "),
    },
    next:
      reason === "irreversible"
        ? `Jev wants to click "${jevLabel}". Confirm with fast_web_choose({ choice: "${decision.target}" }) or pick another option / STOP.`
        : "You are the planner here. Pick the option that best advances the goal: fast_web_choose({ choice: <index> }). You may also pass a narrower goal for the next steps. Controls: " +
          describeControls(space, run) +
          ". Do not screenshot; the options are the page.",
    open: true,
  };
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
  status: Exclude<FastWebTaskResult["status"], "need_text" | "need_decision">,
  run: Run,
  reason?: string,
): Promise<FastWebTaskResult> {
  run.pending = undefined;
  run.decision = undefined;
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
  status: Exclude<FastWebTaskResult["status"], "need_text" | "need_decision">,
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
