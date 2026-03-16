/**
 * Shared types, interfaces, and constants for the SubAgentOrchestrator modules.
 *
 * Extracted from subagent-orchestrator.ts to support decomposition into
 * focused sibling modules without circular dependencies.
 *
 * @module
 */

import type {
  PipelinePlannerContextMemorySource,
  PipelineStopReasonHint,
} from "../workflow/pipeline.js";
import type { LLMUsage } from "../llm/types.js";
import type {
  DelegationOutputValidationCode,
} from "../utils/delegation-validation.js";
import type {
  DelegationDecompositionSignal,
} from "./delegation-scope.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

export const CONTEXT_TERM_MIN_LENGTH = 3;
export const CONTEXT_HISTORY_TAIL_PIN = 2;
export const FALLBACK_CONTEXT_HISTORY_CHARS = 2_000;
export const FALLBACK_CONTEXT_MEMORY_CHARS = 2_800;
export const FALLBACK_CONTEXT_TOOL_OUTPUT_CHARS = 3_200;
export const FALLBACK_SUBAGENT_TASK_PROMPT_CHARS = 14_000;

export const REDACTED_IMAGE_DATA_URL = "[REDACTED_IMAGE_DATA_URL]";
export const REDACTED_PRIVATE_KEY_BLOCK = "[REDACTED_PRIVATE_KEY_BLOCK]";
export const REDACTED_INTERNAL_URL = "[REDACTED_INTERNAL_URL]";
export const REDACTED_FILE_URL = "[REDACTED_FILE_URL]";
export const REDACTED_BEARER_TOKEN = "Bearer [REDACTED_TOKEN]";
export const REDACTED_API_KEY = "[REDACTED_API_KEY]";
export const REDACTED_ABSOLUTE_PATH = "[REDACTED_ABSOLUTE_PATH]";

export const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z ]+ PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+ PRIVATE KEY-----/g;
export const IMAGE_DATA_URL_RE = /data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi;
export const BEARER_TOKEN_RE = /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi;
export const API_KEY_ASSIGNMENT_RE =
  /\b(api[_-]?key|access[_-]?token|token|secret|password)\b\s*[:=]\s*([^\s,;]+)/gi;
export const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9]{16,}\b/g;
export const INTERNAL_URL_RE =
  /\bhttps?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}|169\.254(?:\.\d{1,3}){2}|(?:[A-Za-z0-9-]+\.)*internal)(?::\d+)?(?:\/[^\s"'`)]*)?/gi;
export const FILE_URL_RE = /\bfile:\/\/[^\s"'`)]+/gi;
export const ABSOLUTE_PATH_RE =
  /(^|[\s"'`])((?:\/home|\/Users|\/root|\/etc|\/var|\/opt|\/srv|\/tmp)\/[^\s"'`]+)/g;

export const NODE_PACKAGE_TOOLING_RE =
  /\b(?:node(?:\.js)?|npm|npx|package\.json|package-lock\.json|pnpm|pnpm-workspace\.yaml|yarn|bun|typescript|tsconfig(?:\.[a-z]+)?\.json|tsx|vitest|commander)\b/i;
export const NODE_PACKAGE_MANIFEST_PATH_RE =
  /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb|tsconfig(?:\.[a-z]+)?\.json)$/i;
export const NODE_WORKSPACE_AUTHORING_RE =
  /\b(?:package\.json|pnpm-workspace\.yaml|tsconfig(?:\.[a-z]+)?\.json|vite\.config(?:\.[a-z]+)?|vitest\.config(?:\.[a-z]+)?|workspaces|dependencies|devdependencies|scripts?|bin)\b/i;
export const RUST_WORKSPACE_TOOLING_RE =
  /\b(?:cargo(?:\.toml|\.lock)?|rustc|rustfmt|clippy|crates?)\b|(?:^|\/)(?:src\/)?(?:lib|main)\.rs\b/i;
export const TEST_ARTIFACT_PATH_RE =
  /(?:^|\/)(?:tests?|__tests__|specs?)\/|(?:^\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i;
export const SOURCE_ARTIFACT_PATH_RE = /\.(?:[cm]?[jt]sx?)$/i;
export const GENERATED_DECLARATION_PATH_RE = /\.d\.[cm]?ts$/i;
export const PLACEHOLDER_TEST_SCRIPT_RE =
  /\berror:\s*no test specified\b|exit\s+1\b/i;
export const SUBAGENT_ORCHESTRATION_SECTION_RE =
  /\bsub-agent orchestration plan(?:\s*\((?:required|mandatory)\)|\s+(?:required|mandatory))\s*:[\s\S]*$/i;

export const WORKSPACE_CONTEXT_CANDIDATE_PATH_RE =
  /\.(?:[cm]?[jt]sx?|json|md|txt|html|css|toml|lock|ya?ml)$/i;
export const WORKSPACE_CONTEXT_SKIP_DIRS = new Set([
  ".git",
  ".github",
  ".vscode",
  ".idea",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
]);
export const WORKSPACE_CONTEXT_MAX_SCAN_FILES = 160;
export const WORKSPACE_CONTEXT_MAX_SCAN_DEPTH = 5;
export const WORKSPACE_CONTEXT_MAX_FILE_BYTES = 64_000;
export const WORKSPACE_CONTEXT_MAX_CONTENT_CHARS = 6_000;
export const WORKSPACE_CONTEXT_MIN_CANDIDATES = 3;
export const WORKSPACE_CONTEXT_MAX_CANDIDATES = 10;

export const PACKAGE_AUTHORING_SCAN_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  "coverage",
]);
export const PACKAGE_AUTHORING_MAX_SCAN_FILES = 128;
export const RUST_GENERATED_ARTIFACT_PATH_RE =
  /(?:^|\/)target(?:\/|$)|(?:^|\/)\.fingerprint(?:\/|$)|(?:^|\/)incremental(?:\/|$)|(?:^|\/)\.rustc_info\.json$/i;

/* ------------------------------------------------------------------ */
/*  Types & Interfaces                                                 */
/* ------------------------------------------------------------------ */

export type SubagentFailureClass =
  | "timeout"
  | "budget_exceeded"
  | "tool_misuse"
  | "malformed_result_contract"
  | "needs_decomposition"
  | "invalid_input"
  | "transient_provider_error"
  | "cancelled"
  | "spawn_error"
  | "unknown";

export interface SubagentRetryRule {
  readonly maxRetries: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export type SubagentFailureOutcome = {
  readonly failureClass: SubagentFailureClass;
  readonly message: string;
  readonly stopReasonHint: PipelineStopReasonHint;
  readonly validationCode?: DelegationOutputValidationCode;
  readonly decomposition?: DelegationDecompositionSignal;
  readonly childSessionId?: string;
  readonly durationMs?: number;
  readonly toolCallCount?: number;
  readonly tokenUsage?: LLMUsage;
};

export interface CuratedSection {
  readonly lines: readonly string[];
  readonly selected: number;
  readonly available: number;
  readonly omitted: number;
  readonly truncated: boolean;
}

export interface DependencyArtifactCandidate {
  readonly dependencyName: string;
  readonly path: string;
  readonly content: string;
  readonly score: number;
  readonly order: number;
  readonly depth: number;
}

export interface DependencyContextEntry {
  readonly dependencyName: string;
  readonly result: string | null;
  readonly depth: number;
  readonly orderIndex: number;
}

export interface PackageAuthoringState {
  readonly relativePackageDirectory: string;
  readonly relativeSourceDirectory: string;
  readonly sourceDirExists: boolean;
  readonly sourceFileCount: number;
  readonly testFileCount: number;
}

export type AcceptanceProbeCategory = "build" | "typecheck" | "lint" | "test";

export interface AcceptanceProbePlan {
  readonly name: string;
  readonly category: AcceptanceProbeCategory;
  readonly step: import("../workflow/pipeline.js").PipelinePlannerDeterministicStep;
}

export interface SubagentPromptBudgetCaps {
  readonly historyChars: number;
  readonly memoryChars: number;
  readonly toolOutputChars: number;
  readonly totalPromptChars: number;
}

export interface SubagentContextDiagnostics {
  readonly executionBudget: {
    readonly provider?: string;
    readonly model?: string;
    readonly contextWindowTokens?: number;
    readonly contextWindowSource?: string;
    readonly maxOutputTokens?: number;
    readonly historyChars: number;
    readonly memoryChars: number;
    readonly toolOutputChars: number;
    readonly totalPromptChars: number;
  };
  readonly history: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly memory: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly toolOutputs: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly dependencyArtifacts: {
    readonly selected: number;
    readonly available: number;
    readonly omitted: number;
    readonly truncated: boolean;
  };
  readonly hostTooling: {
    readonly included: boolean;
    readonly reason: "node_package_tooling" | "not_relevant" | "profile_unavailable";
    readonly nodeVersion?: string;
    readonly npmVersion?: string;
    readonly npmWorkspaceProtocolSupport?: "supported" | "unsupported" | "unknown";
    readonly npmWorkspaceProtocolEvidence?: string;
  };
  readonly promptTruncated: boolean;
  readonly toolScope: {
    readonly strategy: "inherit_intersection" | "explicit_only";
    readonly unsafeBenchmarkMode: boolean;
    readonly required: readonly string[];
    readonly parentPolicyAllowed: readonly string[];
    readonly parentPolicyForbidden: readonly string[];
    readonly resolved: readonly string[];
    readonly allowsToollessExecution: boolean;
    readonly semanticFallback: readonly string[];
    readonly removedLowSignalBrowserTools: readonly string[];
    readonly removedByPolicy: readonly string[];
    readonly removedAsDelegationTools: readonly string[];
    readonly removedAsUnknownTools: readonly string[];
  };
}

/* ------------------------------------------------------------------ */
/*  Retry policy & stop reason maps                                    */
/* ------------------------------------------------------------------ */

export const SUBAGENT_RETRY_POLICY: Readonly<
  Record<SubagentFailureClass, SubagentRetryRule>
> = {
  timeout: { maxRetries: 1, baseDelayMs: 75, maxDelayMs: 250 },
  budget_exceeded: { maxRetries: 1, baseDelayMs: 50, maxDelayMs: 150 },
  tool_misuse: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  malformed_result_contract: { maxRetries: 1, baseDelayMs: 50, maxDelayMs: 150 },
  needs_decomposition: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  invalid_input: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  transient_provider_error: { maxRetries: 2, baseDelayMs: 100, maxDelayMs: 300 },
  cancelled: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
  spawn_error: { maxRetries: 1, baseDelayMs: 75, maxDelayMs: 250 },
  unknown: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
};

export const SUBAGENT_FAILURE_STOP_REASON: Readonly<
  Record<SubagentFailureClass, PipelineStopReasonHint>
> = {
  timeout: "timeout",
  budget_exceeded: "budget_exceeded",
  tool_misuse: "tool_error",
  malformed_result_contract: "validation_error",
  needs_decomposition: "validation_error",
  invalid_input: "validation_error",
  transient_provider_error: "provider_error",
  cancelled: "cancelled",
  spawn_error: "tool_error",
  unknown: "tool_error",
};

/* ------------------------------------------------------------------ */
/*  Standalone helper functions                                        */
/* ------------------------------------------------------------------ */

export function isPipelineStopReasonHint(
  value: unknown,
): value is PipelineStopReasonHint {
  return (
    value === "validation_error" ||
    value === "provider_error" ||
    value === "authentication_error" ||
    value === "rate_limited" ||
    value === "timeout" ||
    value === "tool_error" ||
    value === "budget_exceeded" ||
    value === "no_progress" ||
    value === "cancelled"
  );
}

export function toPipelineStopReasonHint(
  value: unknown,
): PipelineStopReasonHint | undefined {
  switch (value) {
    case "validation_error":
    case "provider_error":
    case "authentication_error":
    case "rate_limited":
    case "timeout":
    case "tool_error":
    case "budget_exceeded":
    case "no_progress":
    case "cancelled":
      return value;
    default:
      return undefined;
  }
}

export function summarizeSubagentFailureHistory(
  stepName: string,
  failures: readonly SubagentFailureOutcome[],
): string {
  if (failures.length === 0) {
    return `Sub-agent step "${stepName}" failed`;
  }

  const uniqueReasons = [
    ...new Set(
      failures
        .map((failure) => failure.message.trim())
        .filter((message) => message.length > 0),
    ),
  ];
  const summarizedReasons = uniqueReasons.slice(0, 4).join("; ");
  const moreCount = uniqueReasons.length - Math.min(uniqueReasons.length, 4);
  const suffix = moreCount > 0 ? `; +${moreCount} more` : "";
  return `Sub-agent step "${stepName}" failed after ${failures.length} attempt${failures.length === 1 ? "" : "s"}: ${summarizedReasons}${suffix}`;
}

/* ------------------------------------------------------------------ */
/*  Allowed memory sources helper                                      */
/* ------------------------------------------------------------------ */

export function resolveAllowedMemorySources(
  lowerRequirements: readonly string[],
): Set<PipelinePlannerContextMemorySource> {
  const allowed = new Set<PipelinePlannerContextMemorySource>();
  for (const requirement of lowerRequirements) {
    const normalized = requirement.replace(/[_-]+/g, " ").trim();
    if (
      /\b(?:memory semantic|semantic memory)\b/i.test(normalized)
    ) {
      allowed.add("memory_semantic");
    }
    if (
      /\b(?:memory episodic|episodic memory)\b/i.test(normalized)
    ) {
      allowed.add("memory_episodic");
    }
    if (
      /\b(?:memory working|working memory)\b/i.test(normalized)
    ) {
      allowed.add("memory_working");
    }
  }
  return allowed;
}
