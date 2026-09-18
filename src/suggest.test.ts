import assert from "node:assert/strict";
import { test } from "node:test";
import type { ObservedPage } from "./action-space.ts";
import {
  fieldValueSatisfied,
  isAutocompleteRole,
  pickProvidedSuggestion,
  pickSuggestion,
  valuesEqual,
} from "./suggest.ts";

const page: ObservedPage = {
  url: "https://www.etsy.com/your/shops/me/tools/listings/create",
  title: "Create a listing",
  text: "Category",
  actions: [
    { id: "e1", kind: "fill", node: 1, role: "combobox", label: "Category", value: "Digital Prints" },
    { id: "e2", kind: "click", node: 1, role: "combobox", label: "Open Category", value: "Digital Prints" },
    { id: "e3", kind: "click", node: 4, role: "option", label: "Category → Digital Prints" },
    { id: "e4", kind: "click", node: 5, role: "option", label: "Category → Paintings" },
    { id: "e5", kind: "click", node: 8, role: "button", label: "Digital Prints" },
    { id: "e6", kind: "fill", node: 9, role: "textbox", label: "Title", value: "Hand-thrown ceramic mug" },
  ],
};

test("valuesEqual ignores case and extra spaces; does not substring-match", () => {
  assert.equal(valuesEqual("Digital Prints", "digital  prints"), true);
  assert.equal(valuesEqual("Hand-thrown ceramic mug", "Digital Prints"), false);
  assert.equal(valuesEqual("mug with Digital Prints on it", "Digital Prints"), false);
});

test("fieldValueSatisfied is true only when the current value is exactly a provided one", () => {
  const provided = ["Digital Prints", "Hand-thrown ceramic mug"];
  assert.equal(fieldValueSatisfied("Digital Prints", provided), true);
  assert.equal(fieldValueSatisfied("digital prints", provided), true);
  assert.equal(fieldValueSatisfied("", provided), false);
  assert.equal(fieldValueSatisfied("mug with Digital Prints on it", provided), false);
});

test("isAutocompleteRole covers combobox and searchbox, not a plain textbox", () => {
  assert.equal(isAutocompleteRole("combobox"), true);
  assert.equal(isAutocompleteRole("searchbox"), true);
  assert.equal(isAutocompleteRole("textbox"), false);
});

test("pickSuggestion prefers a listbox option over the Open control and a same-name chip", () => {
  const pick = pickSuggestion(page, "Digital Prints", { node: 1, label: "Category" });
  assert.equal(pick?.id, "e3");
  assert.equal(pick?.role, "option");
});

test("pickSuggestion never returns the combobox it is committing", () => {
  const pick = pickSuggestion(page, "Digital Prints", { node: 1, label: "Category" });
  assert.notEqual(pick?.node, 1);
});

test("pickProvidedSuggestion walks provided values until one has a visible option", () => {
  const hit = pickProvidedSuggestion(page, ["Oil painting", "Digital Prints"], { node: 1, label: "Category" });
  assert.equal(hit?.text, "Digital Prints");
  assert.equal(hit?.action.id, "e3");
});
