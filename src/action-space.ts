import type { ChooseUiActionInput, OpenOverlay, Progress, RecentAction, UiElement } from "./choose-ui-action.ts";
import { fieldValueSatisfied } from "./suggest.ts";

export interface SnapshotAction {
  id: string;
  kind: "click" | "fill" | "select" | "scroll" | "wait" | "back" | "upload";
  label: string;
  /** File input: accepted types and whether it takes several files. */
  accept?: string;
  multiple?: boolean;
  node?: number;
  role?: string;
  value?: string;
  current_value?: string;
  checked?: string | boolean;
  selected?: string | boolean;
  expanded?: string | boolean;
  delta?: number;
  /** Node id of the dialog/banner that contains this control. */
  overlay?: number;
  /** This control closes or dismisses its overlay. */
  dismiss?: boolean;
  /** Not in the viewport; execution scrolls it into view first. */
  offscreen?: "above" | "below";
  /** Goal-overlap rank score for offscreen candidates (diagnostics). */
  score?: number;
  href?: string;
  /** Inside main content, not site chrome. */
  main?: boolean;
}

export interface ObservedPage {
  url: string;
  title: string;
  text: string;
  actions: SnapshotAction[];
  omitted_actions?: number;
  covered_actions?: number;
  indexed_candidates?: number;
}

export interface DismissCandidate {
  action: SnapshotAction;
  index: string;
  overlay: number;
}

export interface ActionSpaceOptions {
  progress?: Progress;
  canGoBack?: boolean;
  providedValues?: Record<string, string>;
  /** Names of file groups the Bot provided. Without any, file inputs are not offered. */
  providedFiles?: string[];
  /** Raw provided texts; a fill whose current value equals one of these is already done. */
  filledTexts?: string[];
  /** Combobox node that still needs its matching option clicked; TYPE_TEXT is withheld. */
  pendingSuggestNode?: number;
}

const KIND_TO_OPERATION: Record<string, string> = {
  click: "CLICK",
  fill: "TYPE_TEXT",
  select: "SELECT",
  upload: "UPLOAD",
};

export const BACK_ACTION: SnapshotAction = {
  id: "back",
  kind: "back",
  label: "Go back to the previous page (the last navigation was a wrong turn)",
};

export interface ActionSpace {
  input: ChooseUiActionInput;
  resolve(operation: string, target: string | null): SnapshotAction | undefined;
  /** Element index for an observed action, when it is still offered. */
  indexOf(action: SnapshotAction): string | null;
  /** First dismiss control of an open overlay that has not already been tried. */
  dismissFor(tried: ReadonlySet<number>): DismissCandidate | undefined;
  /** Whether the page can scroll further down / up right now. */
  canScroll(direction: "down" | "up"): boolean;
  /** Offscreen click candidates in rank order, with their element index. */
  offscreenCandidates(): OffscreenCandidate[];
  /** Any control (viewport or offscreen) sits in main content. */
  hasMainContent(): boolean;
}

export interface OffscreenCandidate {
  index: string;
  node: number;
  label: string;
  score: number;
  action: SnapshotAction;
}

export function overlayKey(id: number): string {
  return `overlay-${id}`;
}

export function actionSpace(
  page: ObservedPage,
  goal: string,
  recentActions: RecentAction[],
  options: ActionSpaceOptions = {},
): ActionSpace {
  const elements: UiElement[] = [];
  const indices = new Map<number, string>();
  const targets: Record<string, Record<string, SnapshotAction>> = {};
  const controls = new Map<string, SnapshotAction>();
  const dismissals: DismissCandidate[] = [];
  const overlays = new Map<number, OpenOverlay>();
  const offscreen: OffscreenCandidate[] = [];
  let mainContent = false;

  for (const action of page.actions) {
    const operation = KIND_TO_OPERATION[action.kind];
    if (!operation) {
      controls.set(action.id.replace(/-/g, "_").toUpperCase(), action);
      continue;
    }
    const node = action.node;
    if (node == null) continue;
    // A node already offered from the viewport is never duplicated by the index.
    if (action.offscreen && indices.has(node)) continue;
    // File inputs are only useful when the Bot brought files.
    if (action.kind === "upload" && !options.providedFiles?.length) continue;
    const withholdFill =
      action.kind === "fill" &&
      (action.node === options.pendingSuggestNode || fieldValueSatisfied(action.value, options.filledTexts ?? []));
    if (!indices.has(node)) {
      const index = String(elements.length + 1);
      indices.set(node, index);
      const element: UiElement = {
        index,
        role: action.role ?? "button",
        label: action.kind === "select" ? (action.label.split(" → ")[0] ?? action.label) : action.label,
        operations: [],
        value: action.kind === "select" ? (action.current_value ?? "") : (action.value ?? ""),
      };
      if (action.checked != null) element.checked = action.checked === true || action.checked === "true";
      if (action.selected != null) element.selected = action.selected === true || action.selected === "true";
      if (action.expanded != null) element.expanded = action.expanded === true || action.expanded === "true";
      if (action.kind === "select") element.options = [];
      if (action.offscreen) element.offscreen = action.offscreen;
      if (action.kind === "upload") {
        element.upload = { accept: action.accept || undefined, multiple: action.multiple === true, files_attached: Number(action.value) || 0 };
      }
      if (action.main) {
        element.main = true;
        mainContent = true;
      }
      if (action.href) element.href = action.href;
      if (action.overlay != null) {
        element.overlay = overlayKey(action.overlay);
        const overlay = overlays.get(action.overlay) ?? { id: element.overlay, dismiss_controls: [] };
        overlays.set(action.overlay, overlay);
        if (action.dismiss) {
          element.dismiss = true;
          overlay.dismiss_controls.push(`[${index}] ${element.label}`);
        }
      }
      elements.push(element);
    }
    // Index the field so its label stays "Category", not "Open Category", but do
    // not offer TYPE_TEXT for a value that is already typed or waiting on a pick.
    if (withholdFill) continue;
    const index = indices.get(node)!;
    const element = elements[Number(index) - 1];
    if (!element.operations.includes(operation)) element.operations.push(operation);
    const group = (targets[operation] ??= {});
    if (action.kind === "select") {
      const optionIndex = `${index}:${(element.options?.length ?? 0) + 1}`;
      element.options?.push({ index: optionIndex, label: action.label, value: action.value });
      group[optionIndex] = action;
    } else {
      group[index] = action;
      if (action.kind === "click" && action.dismiss && action.overlay != null) {
        dismissals.push({ action, index, overlay: action.overlay });
      }
      if (action.kind === "click" && action.offscreen) {
        offscreen.push({ index, node, label: element.label, score: action.score ?? 0, action });
      }
    }
  }

  const extraOperations: Record<string, string> = {};
  for (const [id, action] of controls) extraOperations[id] = action.label;
  if (options.canGoBack) extraOperations.BACK = BACK_ACTION.label;

  return {
    input: {
      goal,
      page: { url: page.url, title: page.title, text: page.text },
      elements,
      recentActions,
      extraOperations,
      overlays: [...overlays.values()],
      progress: options.progress,
      providedValues: options.providedValues,
      providedFiles: options.providedFiles,
    },
    resolve(operation, target) {
      if (operation === "WAIT") return controls.get("WAIT") ?? page.actions.find((a) => a.kind === "wait");
      if (operation === "SCROLL_DOWN") return controls.get("SCROLL_DOWN") ?? page.actions.find((a) => a.id === "scroll_down");
      if (operation === "SCROLL_UP") return controls.get("SCROLL_UP") ?? page.actions.find((a) => a.id === "scroll_up");
      if (operation === "BACK") return options.canGoBack ? BACK_ACTION : undefined;
      if (!target) return undefined;
      return targets[operation]?.[target];
    },
    indexOf(action) {
      for (const group of Object.values(targets)) {
        for (const [index, candidate] of Object.entries(group)) {
          if (candidate.node === action.node && candidate.kind === action.kind && candidate.label === action.label) return index;
        }
      }
      return null;
    },
    dismissFor(tried) {
      return dismissals.find((candidate) => !tried.has(candidate.overlay));
    },
    canScroll(direction) {
      return controls.has(direction === "down" ? "SCROLL_DOWN" : "SCROLL_UP");
    },
    offscreenCandidates() {
      return [...offscreen].sort((a, b) => b.score - a.score);
    },
    hasMainContent() {
      return mainContent;
    },
  };
}
