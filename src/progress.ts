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

export interface AskContext {
  operation: string;
  /** Probability of the chosen operation and of the runner-up operation. */
  operationProbabilities: Record<string, number>;
  targetProbabilities: Record<string, number>;
  /** Below this gap between first and second choice, System 1 is torn. */
  minMargin: number;
  /**
   * Target indexes that are site chrome (nav, header, footer). A near-tie with
   * chrome is not a real tie: Jev is saying "this or start over", and the
   * content pick wins.
   */
  chromeTargets?: ReadonlySet<string>;
}

export type AskReason = "blocked" | "torn_operation" | "torn_target";

/**
 * Should System 1 hand this decision up? Jev's BLOCKED means "not in one step
 * from here", which is a planning question. A near-tie between two picks means
 * Jev cannot separate them; the Bot usually can in one look. A low absolute
 * probability with a clear runner-up gap is not a reason to ask: with ~100
 * options, 0.4 vs 0.05 is decisive.
 */
export function shouldAsk(ctx: AskContext): AskReason | undefined {
  if (ctx.operation === "BLOCKED" || !ctx.operation) return "blocked";
  const opGap = margin(ctx.operationProbabilities);
  if (opGap != null && opGap < ctx.minMargin) return "torn_operation";
  if (ctx.operation === "CLICK" || ctx.operation === "SELECT") {
    const content = ctx.chromeTargets
      ? Object.fromEntries(Object.entries(ctx.targetProbabilities).filter(([index]) => !ctx.chromeTargets!.has(index)))
      : ctx.targetProbabilities;
    const targetGap = margin(content);
    if (targetGap != null && targetGap < ctx.minMargin) return "torn_target";
  }
  return undefined;
}

/** Difference between the top two probabilities, or undefined with fewer than two options. */
export function margin(probabilities: Record<string, number>): number | undefined {
  const sorted = Object.values(probabilities).sort((a, b) => b - a);
  if (sorted.length < 2) return undefined;
  return sorted[0] - sorted[1];
}
