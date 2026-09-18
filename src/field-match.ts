import { evaluateWithGateway } from "./evaluate.ts";
import { FIELD_MATCH } from "./questions.ts";

/** Values the Bot knows before the run starts, keyed by whatever name it likes. */
export type TaskData = Record<string, string | number | boolean | string[]>;

export interface FieldMatchInput {
  goal: string;
  field: { label: string; role?: string; value?: string };
  pageTitle: string;
  data: TaskData;
  /** Data keys already typed somewhere; still offered, but Jev is told. */
  used: ReadonlySet<string>;
}

export interface FieldMatch {
  key: string;
  text: string;
  probability: number;
  gatewayMs: number;
}

const NONE = "__none__";

/** Below this the match is not trusted and the Bot is asked instead. */
export const FIELD_MATCH_FLOOR = 0.5;

export function dataToText(value: TaskData[string]): string {
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/**
 * Ask Jev which of the Bot's provided values belongs in this field. This is a
 * comparison over a small fixed set, which Jev answers well; it never invents
 * a value. Returns undefined when nothing fits or the pick is weak.
 */
export async function matchField(input: FieldMatchInput): Promise<FieldMatch | undefined> {
  const keys = Object.keys(input.data);
  if (!keys.length) return undefined;
  const criteria: Record<string, unknown> = {};
  for (const key of keys) {
    criteria[key] = {
      name: key,
      value_preview: dataToText(input.data[key]).slice(0, 80),
      already_used: input.used.has(key) || undefined,
    };
  }
  criteria[NONE] = "None of the provided values belongs in this field.";
  const started = performance.now();
  const result = await evaluateWithGateway({
    state: {
      page: input.pageTitle,
      goal: input.goal,
      field: { label: input.field.label, role: input.field.role, current_value: input.field.value ?? "" },
    },
    questions: { value: { type: "choice", instructions: FIELD_MATCH, criteria } },
  });
  const gatewayMs = Math.round(performance.now() - started);
  const answer = result.answers.value as { choice?: string; probabilities?: Record<string, number> } | undefined;
  const key = answer?.choice;
  if (!key || key === NONE) return undefined;
  const probability = answer?.probabilities?.[key] ?? 0;
  if (probability < FIELD_MATCH_FLOOR) return undefined;
  return { key, text: dataToText(input.data[key]), probability, gatewayMs };
}
