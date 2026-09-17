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
}

export interface RecoveryContext {
  streak: number;
  limit: number;
  canScrollDown: boolean;
  canScrollUp: boolean;
  canGoBack: boolean;
  tried: RecoveryTried;
}

export type Recovery =
  | { operation: "SCROLL_DOWN" | "SCROLL_UP" | "BACK"; reason: string }
  | { stop: true; reason: string };

/**
 * What to do when Jev says BLOCKED. Each recovery is tried at most once per
 * no-progress run; BLOCKED sticks only when the gate has tripped or nothing is left.
 */
export function recoveryFor(ctx: RecoveryContext): Recovery {
  if (ctx.streak >= ctx.limit) {
    return { stop: true, reason: `No progress after ${ctx.streak} consecutive steps` };
  }
  if (ctx.canScrollDown && !ctx.tried.scrollDown) {
    return { operation: "SCROLL_DOWN", reason: "Jev chose BLOCKED; scrolling to unexplored content first" };
  }
  if (ctx.canScrollUp && !ctx.tried.scrollUp) {
    return { operation: "SCROLL_UP", reason: "Jev chose BLOCKED; scrolling back up first" };
  }
  if (ctx.canGoBack && !ctx.tried.back) {
    return { operation: "BACK", reason: "Jev chose BLOCKED; returning to the previous page" };
  }
  return { stop: true, reason: "Jev could not progress on this page and every recovery was tried" };
}

export function freshRecovery(): RecoveryTried {
  return { scrollDown: false, scrollUp: false, back: false };
}
