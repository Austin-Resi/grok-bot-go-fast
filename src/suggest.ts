import type { ObservedPage, SnapshotAction } from "./action-space.ts";

const AUTOCOMPLETE_ROLES = new Set(["combobox", "searchbox"]);
const OPTION_ROLES = new Set(["option", "menuitem", "menuitemradio"]);

export function normalizeValue(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Exact match after normalizing whitespace/case. Used to decide a field is already filled. */
export function valuesEqual(a: string, b: string): boolean {
  const x = normalizeValue(a);
  const y = normalizeValue(b);
  return x.length > 0 && x === y;
}

/** Haystack contains needle, or they are equal. Used to match "Category → Digital Prints" to a provided value. */
export function valueContains(haystack: string, needle: string): boolean {
  const h = normalizeValue(haystack);
  const n = normalizeValue(needle);
  if (!h || !n) return false;
  if (h === n) return true;
  const rhs = h.includes(" → ") ? h.slice(h.lastIndexOf(" → ") + 3).trim() : h;
  return rhs === n || h.includes(n);
}

export function isAutocompleteRole(role: string | undefined): boolean {
  return role != null && AUTOCOMPLETE_ROLES.has(role);
}

/** True when the field already shows one of the provided values. Do not TYPE_TEXT it again. */
export function fieldValueSatisfied(current: string | undefined, providedTexts: readonly string[]): boolean {
  if (!current?.trim()) return false;
  return providedTexts.some((text) => valuesEqual(current, text));
}

/**
 * The click that commits a typed/provided autocomplete value: a listbox option,
 * a "Field → Value" row, or an exact-label chip. Never the combobox itself.
 */
export function pickSuggestion(
  page: ObservedPage,
  query: string,
  field?: { node?: number; label?: string },
): SnapshotAction | undefined {
  const q = normalizeValue(query);
  if (!q) return undefined;
  let best: { action: SnapshotAction; score: number } | undefined;
  for (const action of page.actions) {
    if (action.kind !== "click" && action.kind !== "select") continue;
    if (action.offscreen) continue;
    if (field?.node != null && action.node === field.node) continue;
    const label = action.label ?? "";
    const rhs = label.includes(" → ") ? label.slice(label.lastIndexOf(" → ") + 3).trim() : label;
    if (!valueContains(label, query) && !valuesEqual(rhs, query)) continue;
    let score = 0;
    if (action.role && OPTION_ROLES.has(action.role)) score = 4;
    else if (label.includes(" → ")) score = 3;
    else if (valuesEqual(rhs, query)) score = 2;
    else score = 1;
    if (field?.label && valueContains(label, field.label)) score += 1;
    if (!best || score > best.score) best = { action, score };
  }
  return best?.action;
}

/** First provided value that a visible suggestion matches. */
export function pickProvidedSuggestion(
  page: ObservedPage,
  providedTexts: readonly string[],
  field?: { node?: number; label?: string },
): { action: SnapshotAction; text: string } | undefined {
  for (const text of providedTexts) {
    const action = pickSuggestion(page, text, field);
    if (action) return { action, text };
  }
}
