/**
 * Canonical delegation tool schema and argument parsing helpers.
 *
 * This module keeps the `execute_with_agent` contract shared across runtime
 * entry points so tool registration, routing, and execution stay aligned.
 *
 * @module
 */

import type { Tool } from "../tools/types.js";
import { safeStringify } from "../tools/types.js";

export const EXECUTE_WITH_AGENT_TOOL_NAME = "execute_with_agent";

const DIRECT_EXECUTION_ERROR =
  "execute_with_agent must run through a session-scoped tool handler";

export interface ExecuteWithAgentInput {
  readonly task: string;
  readonly objective?: string;
  readonly timeoutMs?: number;
  readonly tools?: readonly string[];
  readonly requiredToolCapabilities?: readonly string[];
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly spawnDecisionScore?: number;
}

export type ParseExecuteWithAgentResult =
  | { ok: true; value: ExecuteWithAgentInput }
  | { ok: false; error: string };

function toNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function toTrimmedStringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result.length > 0 ? result : undefined;
}

function toOptionalScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

function toOptionalTimeout(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  if (rounded < 1_000 || rounded > 3_600_000) return undefined;
  return rounded;
}

export function parseExecuteWithAgentInput(
  args: Record<string, unknown>,
): ParseExecuteWithAgentResult {
  const objective = toNonEmptyString(args.objective);
  const task = objective ?? toNonEmptyString(args.task);
  if (!task) {
    return {
      ok: false,
      error:
        'execute_with_agent requires a non-empty "task" string (or "objective")',
    };
  }

  const tools = toTrimmedStringArray(args.tools);
  const requiredToolCapabilities =
    toTrimmedStringArray(args.requiredToolCapabilities) ??
    toTrimmedStringArray(args.requiredCapabilities);
  const acceptanceCriteria = toTrimmedStringArray(args.acceptanceCriteria);

  return {
    ok: true,
    value: {
      task,
      objective,
      timeoutMs: toOptionalTimeout(args.timeoutMs),
      tools,
      requiredToolCapabilities,
      inputContract: toNonEmptyString(args.inputContract),
      acceptanceCriteria,
      spawnDecisionScore:
        toOptionalScore(args.spawnDecisionScore) ??
        toOptionalScore(args.delegationScore) ??
        toOptionalScore(args.utilityScore),
    },
  };
}

/**
 * Registerable tool definition for `execute_with_agent`.
 *
 * Runtime execution happens in the session tool-handler layer where session
 * identity and lifecycle dependencies are available.
 */
export function createExecuteWithAgentTool(): Tool {
  return {
    name: EXECUTE_WITH_AGENT_TOOL_NAME,
    description:
      "Delegate a bounded child objective to a sub-agent with scoped tools, then return the child result.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Child task objective to execute",
        },
        objective: {
          type: "string",
          description: "Alias for task when planner emits objective-centric payloads",
        },
        tools: {
          type: "array",
          description: "Optional explicit tool allowlist for the child task",
          items: { type: "string" },
        },
        requiredToolCapabilities: {
          type: "array",
          description: "Capability-oriented tool requirements for child execution",
          items: { type: "string" },
        },
        timeoutMs: {
          type: "number",
          description: "Optional child timeout in milliseconds (1000-3600000)",
        },
        inputContract: {
          type: "string",
          description: "Optional output format contract for child execution",
        },
        acceptanceCriteria: {
          type: "array",
          description: "Optional acceptance criteria checklist for the child task",
          items: { type: "string" },
        },
        spawnDecisionScore: {
          type: "number",
          description: "Optional planner/policy delegation score for policy gating",
        },
      },
      required: ["task"],
    },
    execute: async () => ({
      content: safeStringify({ error: DIRECT_EXECUTION_ERROR }),
      isError: true,
    }),
  };
}
