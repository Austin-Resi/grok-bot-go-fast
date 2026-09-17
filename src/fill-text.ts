import { generateObject } from "ai";
import * as z from "zod/v4";
import { TEXT_VALUE } from "./questions.ts";

const DEFAULT_TEXT_MODEL = "google/gemini-2.5-flash";

export interface FillContext {
  goal: string;
  field: { label?: string; role?: string; value?: string };
  page: { title?: string; text?: string };
  recentActions: Array<{ action?: string; text?: string }>;
}

export async function fieldText(context: FillContext): Promise<string> {
  const model = process.env.JEV_TEXT_MODEL?.trim() || DEFAULT_TEXT_MODEL;
  const { object } = await generateObject({
    model,
    schema: z.object({ text: z.string().nullable() }),
    system: TEXT_VALUE,
    prompt: JSON.stringify(context),
    maxRetries: 2,
  });
  if (!object.text?.trim() || object.text.length > 2000) {
    throw new Error("Text helper returned no valid field value; nothing typed.");
  }
  return object.text;
}
