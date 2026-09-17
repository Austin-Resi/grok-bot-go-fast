import { experimental_evaluate as evaluate } from "ai";
import type { Experimental_EvaluationQuestion } from "ai";

const DEFAULT_MODEL = "typesafe-ai/jev";

export interface EvaluationQuestionInput {
  type: "choice" | "score" | "boolean";
  instructions?: unknown;
  criteria?: unknown;
}

export interface EvaluateInput {
  state: unknown;
  questions: Record<string, EvaluationQuestionInput>;
}

export interface EvaluateOutput {
  model: string;
  answers: Record<string, unknown>;
  confidence: Record<string, number> | undefined;
  usage: unknown;
}

function gatewayModel(): string {
  return process.env.JEV_MODEL?.trim() || DEFAULT_MODEL;
}

function requireGatewayAuth(): string | undefined {
  if (process.env.AI_GATEWAY_API_KEY?.trim()) return undefined;
  if (process.env.VERCEL_OIDC_TOKEN?.trim()) return undefined;
  return "Missing AI_GATEWAY_API_KEY. Create a key at https://vercel.com/d?to=%2Fai-gateway%2Fapi-keys then set it in the plugin env. Jev is called through Vercel AI Gateway, not TypeSafe directly.";
}

function asJson(value: unknown, fallback: string): Experimental_EvaluationQuestion["instructions"] {
  if (value == null) return fallback;
  try {
    return JSON.parse(JSON.stringify(value)) as Experimental_EvaluationQuestion["instructions"];
  } catch {
    throw new Error("State and question fields must be JSON-serializable.");
  }
}

function toQuestions(
  questions: Record<string, EvaluationQuestionInput>,
): Record<string, Experimental_EvaluationQuestion> {
  const mapped: Record<string, Experimental_EvaluationQuestion> = {};

  for (const [id, question] of Object.entries(questions)) {
    const instructions = asJson(question.instructions, id);

    if (question.type === "choice") {
      if (!question.criteria || typeof question.criteria !== "object" || Array.isArray(question.criteria)) {
        throw new Error(`Question "${id}" is choice and needs criteria as an option→description object.`);
      }
      mapped[id] = {
        type: "choice",
        instructions,
        criteria: asJson(question.criteria, id) as Record<string, Experimental_EvaluationQuestion["instructions"] | null>,
      };
      continue;
    }

    if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2) {
        throw new Error(`Question "${id}" is score and needs criteria as an array of at least two labels.`);
      }
      mapped[id] = {
        type: "score",
        instructions,
        criteria: asJson(question.criteria, id) as Experimental_EvaluationQuestion["instructions"][],
      };
      continue;
    }

    const booleanCriteria =
      question.criteria && typeof question.criteria === "object" && !Array.isArray(question.criteria)
        ? (asJson(question.criteria, id) as { true?: Experimental_EvaluationQuestion["instructions"] | null; false?: Experimental_EvaluationQuestion["instructions"] | null })
        : undefined;

    mapped[id] = {
      type: "boolean",
      instructions,
      criteria: booleanCriteria,
    };
  }

  return mapped;
}

export async function evaluateWithGateway(input: EvaluateInput): Promise<EvaluateOutput> {
  const authError = requireGatewayAuth();
  if (authError) throw new Error(authError);

  const zeroDataRetention = process.env.JEV_ZERO_DATA_RETENTION === "true";
  const model = gatewayModel();
  const questions = toQuestions(input.questions);

  const result = await evaluate({
    model,
    state: asJson(input.state, ""),
    questions,
    providerOptions: zeroDataRetention
      ? { gateway: { zeroDataRetention: true } }
      : undefined,
  });

  const metadata = result.providerMetadata as
    | { typesafe?: { confidence?: Record<string, number> } }
    | undefined;

  return {
    model: result.response.modelId || model,
    answers: result.answers as Record<string, unknown>,
    confidence: metadata?.typesafe?.confidence,
    usage: result.usage,
  };
}
