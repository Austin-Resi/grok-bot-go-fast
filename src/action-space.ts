import type { ChooseUiActionInput, OpenOverlay, RecentAction, UiElement } from "./choose-ui-action.ts";

export interface SnapshotAction {
  id: string;
  kind: "click" | "fill" | "select" | "scroll" | "wait";
  label: string;
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
}

export interface ObservedPage {
  url: string;
  title: string;
  text: string;
  actions: SnapshotAction[];
  omitted_actions?: number;
  covered_actions?: number;
}

export interface DismissCandidate {
  action: SnapshotAction;
  index: string;
  overlay: number;
}

const KIND_TO_OPERATION: Record<string, string> = {
  click: "CLICK",
  fill: "TYPE_TEXT",
  select: "SELECT",
};

export interface ActionSpace {
  input: ChooseUiActionInput;
  resolve(operation: string, target: string | null): SnapshotAction | undefined;
  /** First dismiss control of an open overlay that has not already been tried. */
  dismissFor(tried: ReadonlySet<number>): DismissCandidate | undefined;
}

export function overlayKey(id: number): string {
  return `overlay-${id}`;
}

export function actionSpace(
  page: ObservedPage,
  goal: string,
  recentActions: RecentAction[],
): ActionSpace {
  const elements: UiElement[] = [];
  const indices = new Map<number, string>();
  const targets: Record<string, Record<string, SnapshotAction>> = {};
  const controls = new Map<string, SnapshotAction>();
  const dismissals: DismissCandidate[] = [];
  const overlays = new Map<number, OpenOverlay>();

  for (const action of page.actions) {
    const operation = KIND_TO_OPERATION[action.kind];
    if (!operation) {
      controls.set(action.id.replace(/-/g, "_").toUpperCase(), action);
      continue;
    }
    const node = action.node;
    if (node == null) continue;
    if (!indices.has(node)) {
      const index = String(elements.length + 1);
      indices.set(node, index);
      const element: UiElement = {
        index,
        role: action.role ?? "button",
        label: action.label.split(" → ")[0] ?? action.label,
        operations: [],
        value: action.kind === "select" ? (action.current_value ?? "") : (action.value ?? ""),
      };
      if (action.checked != null) element.checked = action.checked === true || action.checked === "true";
      if (action.selected != null) element.selected = action.selected === true || action.selected === "true";
      if (action.expanded != null) element.expanded = action.expanded === true || action.expanded === "true";
      if (action.kind === "select") element.options = [];
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
    }
  }

  const extraOperations: Record<string, string> = {};
  for (const [id, action] of controls) extraOperations[id] = action.label;

  return {
    input: {
      goal,
      page: { url: page.url, title: page.title, text: page.text },
      elements,
      recentActions,
      extraOperations,
      overlays: [...overlays.values()],
    },
    resolve(operation, target) {
      if (operation === "WAIT") return controls.get("WAIT") ?? page.actions.find((a) => a.kind === "wait");
      if (operation === "SCROLL_DOWN") return controls.get("SCROLL_DOWN") ?? page.actions.find((a) => a.id === "scroll_down");
      if (operation === "SCROLL_UP") return controls.get("SCROLL_UP") ?? page.actions.find((a) => a.id === "scroll_up");
      if (!target) return undefined;
      return targets[operation]?.[target];
    },
    dismissFor(tried) {
      return dismissals.find((candidate) => !tried.has(candidate.overlay));
    },
  };
}
