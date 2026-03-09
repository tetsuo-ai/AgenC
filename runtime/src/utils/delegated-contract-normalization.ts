/**
 * Shared delegated contract parsing and normalization helpers.
 *
 * Keeps dispatch-side prompt shaping and validator-side exact-output
 * enforcement aligned for delegated child-session flows.
 *
 * @module
 */

export interface DelegatedContractTextShape {
  readonly task: string;
  readonly objective?: string;
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
}

export const DELEGATION_MEMORIZED_TOKEN_PLACEHOLDER = "<memorized_token>";

const DELEGATION_SECRET_PLACEHOLDER = "the memorized token";
const DELEGATION_SECRET_ASSIGNMENT_RE =
  /\b([A-Z_][A-Z0-9_]*)=([A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+)\b/g;
const DELEGATION_SECRET_LITERAL_RE = /\b[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})+\b/g;
const DELEGATION_EXACT_OUTPUT_CUE_RE =
  /\b(?:answer|reply|respond|output|return)\s+exactly\s+\S+/i;
const DELEGATION_EXACT_OUTPUT_ACCEPTANCE_RE =
  /\b(?:exact output|output is exactly|return exactly)\b/i;
const DELEGATION_JSON_OBJECT_OUTPUT_CUE_RE =
  /\bjson\s*(?:object|with|containing)\b|\{[^}]+\}|\b(?:childSessionId|subagentSessionId)\b/i;
const DELEGATION_JSON_PRESENTATION_HINT_RE =
  /\s*,?\s*(?:and\s+)?return\s+(?:only\s+)?(?:compact\s+)?(?:raw\s+)?json(?:\s+only)?\.?|\s*,?\s*(?:as|in)\s+(?:only\s+)?(?:compact\s+)?(?:raw\s+)?json(?:\s+only)?|\s*,?\s*(?:raw\s+)?json\s+only\b|\s*,?\s*(?:raw\s+)?json\s+response\b/gi;

function collectDelegatedContractText(
  input: DelegatedContractTextShape,
): string {
  return [
    input.task,
    input.objective,
    input.inputContract,
    input.acceptanceCriteria?.join("\n"),
  ]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
}

function rewriteDelegatedContractShape<T extends DelegatedContractTextShape>(
  input: T,
  fields: {
    readonly task: string;
    readonly objective?: string;
    readonly inputContract?: string;
    readonly acceptanceCriteria?: readonly string[];
  },
): T {
  const {
    task: _task,
    objective: _objective,
    inputContract: _inputContract,
    acceptanceCriteria: _acceptanceCriteria,
    ...rest
  } = input;

  return {
    ...rest,
    task: fields.task,
    ...(fields.objective ? { objective: fields.objective } : {}),
    ...(fields.inputContract ? { inputContract: fields.inputContract } : {}),
    ...(fields.acceptanceCriteria && fields.acceptanceCriteria.length > 0
      ? { acceptanceCriteria: fields.acceptanceCriteria }
      : {}),
  } as T;
}

export function sanitizeDelegatedRecallText(
  text: string | undefined,
): string | undefined {
  if (!text) return undefined;
  const sanitized = text
    .replace(
      DELEGATION_SECRET_ASSIGNMENT_RE,
      (_match, key: string) =>
        `${key}=${DELEGATION_MEMORIZED_TOKEN_PLACEHOLDER}`,
    )
    .replace(DELEGATION_SECRET_LITERAL_RE, DELEGATION_SECRET_PLACEHOLDER)
    .replace(
      /\bthe memorized token(?:\s+the memorized token)+\b/gi,
      DELEGATION_SECRET_PLACEHOLDER,
    );
  return sanitized.trim().length > 0 ? sanitized : undefined;
}

export function sanitizeDelegatedRecallInput<T extends DelegatedContractTextShape>(
  input: T,
): T {
  return rewriteDelegatedContractShape(input, {
    task: sanitizeDelegatedRecallText(input.task) ?? input.task,
    objective: sanitizeDelegatedRecallText(input.objective),
    inputContract: sanitizeDelegatedRecallText(input.inputContract),
    acceptanceCriteria: input.acceptanceCriteria
      ?.map((criterion) => sanitizeDelegatedRecallText(criterion))
      .filter((criterion): criterion is string => Boolean(criterion)),
  });
}

export function stripDelegatedJsonPresentationHints(
  text: string | undefined,
): string | undefined {
  if (!text) return undefined;
  const stripped = text
    .replace(DELEGATION_JSON_PRESENTATION_HINT_RE, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/,\s*(?:,|\.|;|:)/g, (match) => match.slice(-1))
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}

export function prefersLiteralDelegatedOutput(
  input: DelegatedContractTextShape,
): boolean {
  const combined = collectDelegatedContractText(input);
  if (combined.length === 0) return false;

  const hasExactOutputCue =
    DELEGATION_EXACT_OUTPUT_CUE_RE.test(combined) ||
    (input.acceptanceCriteria?.some((criterion) =>
      DELEGATION_EXACT_OUTPUT_ACCEPTANCE_RE.test(criterion)
    ) ?? false);
  if (!hasExactOutputCue) return false;

  return !DELEGATION_JSON_OBJECT_OUTPUT_CUE_RE.test(combined);
}

export function normalizeDelegatedLiteralOutputContract<
  T extends DelegatedContractTextShape,
>(input: T): T {
  if (!prefersLiteralDelegatedOutput(input)) return input;

  return rewriteDelegatedContractShape(input, {
    task: stripDelegatedJsonPresentationHints(input.task) ?? input.task,
    objective:
      stripDelegatedJsonPresentationHints(input.objective) ?? input.objective,
    inputContract: stripDelegatedJsonPresentationHints(input.inputContract),
    acceptanceCriteria: input.acceptanceCriteria
      ?.map((criterion) => {
        if (
          /\b(?:raw\s+)?json\b/i.test(criterion) &&
          !DELEGATION_JSON_OBJECT_OUTPUT_CUE_RE.test(criterion)
        ) {
          return undefined;
        }
        return stripDelegatedJsonPresentationHints(criterion) ?? criterion;
      })
      .filter((criterion): criterion is string => Boolean(criterion)),
  });
}

export function tryParseJsonObject(
  candidate: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through.
  }
  return undefined;
}

export function parseJsonObjectFromText(
  content: string,
): Record<string, unknown> | undefined {
  const trimmed = content.trim();
  const direct = tryParseJsonObject(trimmed);
  if (direct) return direct;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return tryParseJsonObject(trimmed.slice(start, end + 1));
  }
  return undefined;
}

export function extractExactOutputExpectation(
  criterion: string,
): string | undefined {
  const trimmed = criterion.trim().replace(/[.;:]+$/, "");
  const patterns = [
    /\b(?:child\s+)?(?:output|response|reply)\s+(?:is\s+)?exactly\s+(.+)$/i,
    /\b(?:child\s+)?(?:responds?|replies?)\s+(?:with\s+)?exactly\s+(.+)$/i,
    /^\s*exact(?:\s+output)?\s+(.+)$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (!match) continue;
    const expected = match[1]
      ?.replace(/\s+or\s+equivalent.*$/i, "")
      .trim()
      .replace(/^["'`]|["'`]$/g, "");
    if (expected && expected.length > 0) {
      return expected;
    }
  }
  return undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesExactOutputExpectation(
  expected: string,
  output: string,
): boolean {
  const normalizedOutput = output.trim().replace(/^["'`]|["'`]$/g, "");
  if (normalizedOutput === expected) return true;
  if (!expected.includes(DELEGATION_MEMORIZED_TOKEN_PLACEHOLDER)) {
    return false;
  }

  const pattern = new RegExp(
    `^${escapeRegex(expected).replace(
      escapeRegex(DELEGATION_MEMORIZED_TOKEN_PLACEHOLDER),
      "[A-Z0-9][A-Z0-9|=._:-]*(?:-[A-Z0-9|=._:-]+)*",
    )}$`,
  );
  return pattern.test(normalizedOutput);
}
