/**
 * Canonical delegation tool schema and argument parsing helpers.
 *
 * This module keeps the `execute_with_agent` contract shared across runtime
 * entry points so tool registration, routing, and execution stay aligned.
 *
 * @module
 */

import { dirname, resolve as resolvePath } from "node:path";
import type { Tool } from "../tools/types.js";
import { safeStringify } from "../tools/types.js";

export const EXECUTE_WITH_AGENT_TOOL_NAME = "execute_with_agent";

const DIRECT_EXECUTION_ERROR =
  "execute_with_agent must run through a session-scoped tool handler";

export interface ExecuteWithAgentInput {
  readonly task: string;
  readonly objective?: string;
  readonly continuationSessionId?: string;
  readonly timeoutMs?: number;
  readonly tools?: readonly string[];
  readonly requiredToolCapabilities?: readonly string[];
  readonly contextRequirements?: readonly string[];
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

const WORKING_DIRECTORY_CONTEXT_REQUIREMENT_RE =
  /^(?:cwd|working(?:[_ -]?directory))\s*(?:=|:)\s*(.+)$/i;
const WORKING_DIRECTORY_TEXT_PATTERNS = [
  /\bchange\s+to\s+(?<path>(?:~\/|\/)\S+)\s+directory\b/i,
  /\b(?:in|under|within)\s+(?<path>(?:~\/|\/)\S+)\s+(?:directory|workspace|project|repo|repository|monorepo)\b/i,
  /\b(?:workspace|project|repo|repository|monorepo)(?:\s+(?:root|directory))?\s+(?:at|in|under)\s+(?<path>(?:~\/|\/)\S+)\b/i,
  /\b(?:create|build|implement|run|work)\b[\s\S]{0,80}\b(?:in|under|within)\s+(?<path>(?:~\/|\/)\S+)\b/i,
  /\b(?:cwd|working(?:[_ -]?directory))\s*(?:=|:|to)\s*(?<path>(?:~\/|\/)\S+)/i,
] as const;
const ABSOLUTE_PATH_TOKEN_RE =
  /(?<![A-Za-z0-9._~:/-])(?<path>(?:~\/|\/)[^\s"'`<>|()[\]{}:,;]+)/g;
const FILE_LIKE_BASENAME_RE =
  /(?:\.[A-Za-z0-9]{1,8}|(?:^|\/)(?:Dockerfile|Makefile|README|LICENSE|CHANGELOG)(?:\.[A-Za-z0-9]+)?)$/i;
const WORKSPACE_ALIAS_ROOT = "/workspace";

export interface DelegatedWorkingDirectoryResolution {
  readonly path: string;
  readonly source: "context_requirement" | "task_text";
}

interface DelegatedWorkingDirectoryInput {
  readonly task?: string;
  readonly objective?: string;
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly contextRequirements?: readonly string[];
}

function expandHomeDirectory(rawPath: string): string {
  if (
    rawPath === "~" ||
    rawPath.startsWith("~/") ||
    rawPath.startsWith("~\\")
  ) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home || home.trim().length === 0) return rawPath;
    if (rawPath === "~") return home;
    return `${home}${rawPath.slice(1)}`;
  }
  return rawPath;
}

function normalizeDelegatedPathToken(rawPath: string): string {
  const expanded = expandHomeDirectory(rawPath.trim());
  const withoutTrailingPunctuation = expanded.replace(/[),.;:]+$/g, "");
  if (withoutTrailingPunctuation === "/") return "/";
  return withoutTrailingPunctuation.replace(/\/+$/g, "");
}

function normalizeDelegatedDirectoryCandidate(rawPath: string): string {
  const normalizedPath = normalizeDelegatedPathToken(rawPath);
  if (normalizedPath === "/") return normalizedPath;
  if (FILE_LIKE_BASENAME_RE.test(normalizedPath)) {
    return dirname(normalizedPath);
  }
  return normalizedPath;
}

function collectWorkingDirectoryText(input: DelegatedWorkingDirectoryInput): readonly string[] {
  return [
    input.task,
    input.objective,
    input.inputContract,
    input.acceptanceCriteria?.join("\n"),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function inferDelegatedWorkingDirectory(
  input: DelegatedWorkingDirectoryInput,
): string | undefined {
  const textSegments = collectWorkingDirectoryText(input);
  for (const segment of textSegments) {
    for (const pattern of WORKING_DIRECTORY_TEXT_PATTERNS) {
      const match = segment.match(pattern);
      const candidate = match?.groups?.path?.trim();
      if (candidate) {
        return normalizeDelegatedDirectoryCandidate(candidate);
      }
    }
  }

  const discovered = new Set<string>();
  for (const segment of textSegments) {
    for (const match of segment.matchAll(ABSOLUTE_PATH_TOKEN_RE)) {
      const candidate = match.groups?.path?.trim();
      if (!candidate) continue;
      discovered.add(normalizeDelegatedDirectoryCandidate(candidate));
    }
  }

  if (discovered.size === 1) {
    return [...discovered][0];
  }
  return undefined;
}

export function extractDelegatedWorkingDirectory(
  contextRequirements?: readonly string[],
): string | undefined {
  if (!Array.isArray(contextRequirements)) return undefined;
  for (const requirement of contextRequirements) {
    if (typeof requirement !== "string") continue;
    const match = requirement.match(WORKING_DIRECTORY_CONTEXT_REQUIREMENT_RE);
    const workingDirectory = match?.[1]?.trim();
    if (workingDirectory) {
      return normalizeDelegatedDirectoryCandidate(workingDirectory);
    }
  }
  return undefined;
}

export function resolveDelegatedWorkingDirectory(
  input: DelegatedWorkingDirectoryInput,
): DelegatedWorkingDirectoryResolution | undefined {
  const explicit = extractDelegatedWorkingDirectory(input.contextRequirements);
  if (explicit) {
    return {
      path: explicit,
      source: "context_requirement",
    };
  }

  const inferred = inferDelegatedWorkingDirectory(input);
  if (!inferred) return undefined;
  return {
    path: inferred,
    source: "task_text",
  };
}

export function resolveDelegatedWorkingDirectoryPath(
  workingDirectory: string,
  hostWorkspaceRoot?: string,
): string {
  const normalizedWorkingDirectory =
    normalizeDelegatedDirectoryCandidate(workingDirectory);
  const normalizedHostWorkspaceRoot = hostWorkspaceRoot?.trim().length
    ? resolvePath(expandHomeDirectory(hostWorkspaceRoot.trim()))
    : undefined;

  if (
    !normalizedHostWorkspaceRoot ||
    normalizedHostWorkspaceRoot === WORKSPACE_ALIAS_ROOT
  ) {
    return normalizedWorkingDirectory;
  }

  if (
    normalizedWorkingDirectory === WORKSPACE_ALIAS_ROOT ||
    normalizedWorkingDirectory.startsWith(`${WORKSPACE_ALIAS_ROOT}/`)
  ) {
    const relativePath = normalizedWorkingDirectory
      .slice(WORKSPACE_ALIAS_ROOT.length)
      .replace(/^\/+/, "");
    return relativePath.length > 0
      ? resolvePath(normalizedHostWorkspaceRoot, relativePath)
      : normalizedHostWorkspaceRoot;
  }

  return normalizedWorkingDirectory;
}

export function parseExecuteWithAgentInput(
  args: Record<string, unknown>,
): ParseExecuteWithAgentResult {
  const objective = toNonEmptyString(args.objective);
  const task = toNonEmptyString(args.task) ?? objective;
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
    toTrimmedStringArray(args.required_tool_capabilities) ??
    toTrimmedStringArray(args.requiredCapabilities);
  const contextRequirements =
    toTrimmedStringArray(args.contextRequirements) ??
    toTrimmedStringArray(args.context_requirements);
  const acceptanceCriteria =
    toTrimmedStringArray(args.acceptanceCriteria) ??
    toTrimmedStringArray(args.acceptance_criteria);

  return {
    ok: true,
    value: {
      task,
      objective,
      continuationSessionId:
        toNonEmptyString(args.continuationSessionId) ??
        toNonEmptyString(args.subagentSessionId),
      timeoutMs: toOptionalTimeout(args.timeoutMs),
      tools,
      requiredToolCapabilities,
      contextRequirements,
      inputContract:
        toNonEmptyString(args.inputContract) ??
        toNonEmptyString(args.input_contract),
      acceptanceCriteria,
      spawnDecisionScore:
        toOptionalScore(args.spawnDecisionScore) ??
        toOptionalScore(args.spawn_decision_score) ??
        toOptionalScore(args.delegationScore) ??
        toOptionalScore(args.delegation_score) ??
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
        contextRequirements: {
          type: "array",
          description:
            "Optional scoped context requirements for child execution, such as cwd=/path",
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
