interface ChoiceAnswer {
  type?: string;
  choice?: string;
  probabilities?: Record<string, number>;
}

export function jsonResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

export function errorResult(message: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function resolveUiDecision(
  answers: Record<string, unknown>,
  confidence: Record<string, number> | undefined,
): {
  operation: string;
  target: string | null;
  confidence: number | null;
  targetConfidence: number | null;
  operationProbabilities: Record<string, number>;
  targetProbabilities: Record<string, number>;
} {
  const operationAnswer = answers.operation as ChoiceAnswer | undefined;
  const operation = operationAnswer?.choice ?? "";
  const targetKey = `${operation.toLowerCase()}_target`;
  const targetAnswer = answers[targetKey] as ChoiceAnswer | undefined;

  return {
    operation,
    target: targetAnswer?.choice ?? null,
    confidence: confidence?.operation ?? null,
    targetConfidence: confidence?.[targetKey] ?? null,
    operationProbabilities: operationAnswer?.probabilities ?? {},
    targetProbabilities: targetAnswer?.probabilities ?? {},
  };
}
