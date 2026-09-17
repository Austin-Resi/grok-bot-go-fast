import type { SnapshotAction } from "./action-space.ts";

export interface PageDelta {
  urlChanged: boolean;
  textChanged: boolean;
}

/**
 * Did this step move the task forward? URL changes always count. Content changes
 * count only for actions that act on the page; scrolling changes the visible text
 * by definition and must not reset the gate, or a scroll loop never trips it.
 */
export function madeProgress(kind: SnapshotAction["kind"], delta: PageDelta, ok: boolean): boolean {
  if (!ok) return false;
  if (delta.urlChanged) return true;
  if (kind === "scroll" || kind === "wait") return false;
  return delta.textChanged;
}

export interface RecoveryTried {
  scrollDown: boolean;
  scrollUp: boolean;
  back: boolean;
  /** Node ids of offscreen candidates already clicked during this no-progress run. */
  candidates: Set<number>;
}

export interface RecoveryCandidate {
  index: string;
  node: number;
  label: string;
  score: number;
}

export interface RecoveryContext {
  streak: number;
  limit: number;
  canScrollDown: boolean;
  canScrollUp: boolean;
  canGoBack: boolean;
  tried: RecoveryTried;
  /** Goal-ranked offscreen candidates on this page, best first. */
  candidates: RecoveryCandidate[];
  /**
   * The page offers nothing goal-shaped: no offscreen candidates and no
   * main-content controls. Only then is undoing the last hop justified.
   */
  deadEnd: boolean;
}

export type Recovery =
  | { operation: "CLICK"; candidate: RecoveryCandidate; reason: string }
  | { operation: "SCROLL_DOWN" | "SCROLL_UP" | "BACK"; reason: string }
  | { stop: true; reason: string };

/**
 * What to do when Jev says BLOCKED. BLOCKED usually means "the right control was
 * not in this snapshot", so recovery works through what the page still offers,
 * best goal match first. BACK destroys progress and is reserved for a dead end.
 */
export function recoveryFor(ctx: RecoveryContext): Recovery {
  if (ctx.streak >= ctx.limit) {
    return { stop: true, reason: `No progress after ${ctx.streak} consecutive steps` };
  }
  const candidate = ctx.candidates.find((c) => !ctx.tried.candidates.has(c.node));
  if (candidate) {
    return {
      operation: "CLICK",
      candidate,
      reason: `Jev chose BLOCKED; trying the best goal-ranked offscreen link "${candidate.label}"`,
    };
  }
  if (ctx.canScrollDown && !ctx.tried.scrollDown) {
    return { operation: "SCROLL_DOWN", reason: "Jev chose BLOCKED; scrolling to unexplored content" };
  }
  if (ctx.canScrollUp && !ctx.tried.scrollUp) {
    return { operation: "SCROLL_UP", reason: "Jev chose BLOCKED; scrolling back up" };
  }
  if (ctx.deadEnd && ctx.canGoBack && !ctx.tried.back) {
    return { operation: "BACK", reason: "Jev chose BLOCKED on a page with no goal-shaped controls; returning to the previous page" };
  }
  return { stop: true, reason: "Jev could not progress on this page and every recovery was tried" };
}

export function freshRecovery(): RecoveryTried {
  return { scrollDown: false, scrollUp: false, back: false, candidates: new Set() };
}
