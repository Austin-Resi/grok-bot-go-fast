import { MAX_CHOICE_OPTIONS, NEXT_ACTION, NO_PROGRESS, OVERLAY_OPEN, PROVIDED_VALUES, TARGET } from "./questions.ts";

export interface UiElement {
  index: string;
  role: string;
  label: string;
  operations: string[];
  value?: string;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  options?: Array<{
    index: string;
    label: string;
    value?: string;
  }>;
  /** Id of the open dialog/banner containing this control. */
  overlay?: string;
  /** This control closes its overlay. */
  dismiss?: boolean;
  /** Not currently visible; the tool scrolls to it before clicking. */
  offscreen?: "above" | "below";
  /** Inside the page's main content rather than navigation/header/footer chrome. */
  main?: boolean;
  href?: string;
  /** A file input. */
  upload?: { accept?: string; multiple: boolean; files_attached: number };
}

export interface Progress {
  visited_urls: string[];
  /** Consecutive steps that changed neither URL nor visible content. */
  no_progress_steps: number;
  step: number;
  max_steps: number;
}

export interface RecentAction {
  action?: string;
  kind?: string;
  text?: string;
  pageChanged?: boolean;
  /** Why the action did not execute (target covered or gone). */
  failed?: string;
  /** Why the loop chose this action itself instead of Jev's pick. */
  note?: string;
}

export interface PageState {
  url?: string;
  title?: string;
  text?: string;
}

export interface OpenOverlay {
  id: string;
  dismiss_controls: string[];
}

export interface ChooseUiActionInput {
  goal: string;
  page: PageState;
  elements: UiElement[];
  recentActions?: RecentAction[];
  extraOperations?: Record<string, string>;
  overlays?: OpenOverlay[];
  progress?: Progress;
  /** Names of values the Bot provided up front; TYPE_TEXT into a matching field needs no round trip. */
  providedValues?: string[];
  /** Names of file groups the Bot provided; UPLOAD attaches them. */
  providedFiles?: string[];
}

export interface ChoiceQuestion {
  type: "choice";
  instructions: unknown;
  criteria: Record<string, unknown>;
}

export interface UiActionQuestions {
  state: {
    page: PageState;
    elements: UiElement[];
    recent_actions: RecentAction[];
    open_overlays: OpenOverlay[];
    progress?: Progress;
    provided_values?: string[];
    provided_files?: string[];
  };
  questions: Record<string, ChoiceQuestion>;
  truncated: boolean;
}

const OPERATION_LABELS: Record<string, string> = {
  CLICK: "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
  TYPE_TEXT: "Enter or replace text in an editable field. Supply the value from the goal after this decision.",
  SELECT: "Select an observed dropdown value.",
  UPLOAD: "Attach the provided files to a file input (photos, videos, documents). No dialog is opened.",
};

const CONTROL_OPERATIONS = new Set(["SCROLL_UP", "SCROLL_DOWN", "WAIT", "BACK", "DONE", "BLOCKED"]);

function capCriteria(
  criteria: Record<string, unknown>,
  limit: number,
): { criteria: Record<string, unknown>; truncated: boolean } {
  const entries = Object.entries(criteria);
  if (entries.length <= limit) return { criteria, truncated: false };
  return {
    criteria: Object.fromEntries(entries.slice(0, limit)),
    truncated: true,
  };
}

export function buildUiActionQuestions(input: ChooseUiActionInput): UiActionQuestions {
  const operations: Record<string, string> = {};
  const targets: Record<string, Record<string, unknown>> = {};
  let truncated = false;

  for (const element of input.elements) {
    for (const raw of element.operations) {
      const operation = raw.toUpperCase();
      if (CONTROL_OPERATIONS.has(operation)) {
        operations[operation] = element.label;
        continue;
      }
      if (!(operation in OPERATION_LABELS)) continue;
      operations[operation] = OPERATION_LABELS[operation];
      const group = (targets[operation] ??= {});
      if (operation === "SELECT" && element.options?.length) {
        for (const option of element.options) {
          group[option.index] = {
            element: `[${option.index}] ${option.label}`,
            current_value: element.value ?? "",
            role: element.role,
          };
        }
      } else {
        group[element.index] = {
          element: `[${element.index}] ${element.label}`,
          current_value: element.value ?? "",
          role: element.role,
          checked: element.checked,
          selected: element.selected,
          expanded: element.expanded,
          in_overlay: element.overlay,
          dismisses_overlay: element.dismiss,
          offscreen: element.offscreen,
          main_content: element.main,
          href: element.href,
          file_input: element.upload,
        };
      }
    }
  }

  Object.assign(operations, input.extraOperations);
  operations.DONE = "Every requirement is visibly satisfied.";
  operations.BLOCKED = "No supported operation can make progress.";

  const operationCap = capCriteria(operations, MAX_CHOICE_OPTIONS);
  truncated = truncated || operationCap.truncated;

  const overlays = input.overlays ?? [];
  const hasDismissibleOverlay = overlays.some((overlay) => overlay.dismiss_controls.length > 0);
  const stuck = (input.progress?.no_progress_steps ?? 0) > 0;
  const rules = [NEXT_ACTION];
  if (hasDismissibleOverlay) rules.push(OVERLAY_OPEN);
  if (stuck) rules.push(NO_PROGRESS);
  if (input.providedValues?.length || input.providedFiles?.length) rules.push(PROVIDED_VALUES);

  const questions: Record<string, ChoiceQuestion> = {
    operation: {
      type: "choice",
      instructions: { goal: input.goal, rules },
      criteria: operationCap.criteria,
    },
  };

  for (const [operation, candidates] of Object.entries(targets)) {
    const targetCap = capCriteria(candidates, MAX_CHOICE_OPTIONS);
    truncated = truncated || targetCap.truncated;
    questions[`${operation.toLowerCase()}_target`] = {
      type: "choice",
      instructions: {
        goal: input.goal,
        operation,
        rules: [...rules, TARGET],
      },
      criteria: targetCap.criteria,
    };
  }

  return {
    state: {
      page: input.page,
      elements: input.elements,
      recent_actions: input.recentActions ?? [],
      open_overlays: overlays,
      progress: input.progress,
      provided_values: input.providedValues?.length ? input.providedValues : undefined,
      provided_files: input.providedFiles?.length ? input.providedFiles : undefined,
    },
    questions,
    truncated,
  };
}
