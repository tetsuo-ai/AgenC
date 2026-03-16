/**
 * Sub-agent failure classification, retry logic, and working-directory
 * resolution for delegated planner steps.
 *
 * Extracted from SubAgentOrchestrator — these helpers classify spawn/runtime
 * failures into retryable categories, resolve delegated working directories,
 * and manage retry budget tracking.
 *
 * @module
 */

import type { PipelinePlannerSubagentStep } from "../workflow/pipeline.js";
import type { Pipeline } from "../workflow/pipeline.js";
import type { SubAgentResult } from "./sub-agent.js";
import {
  type DelegatedWorkingDirectoryResolution,
  resolveDelegatedWorkingDirectory,
  resolveDelegatedWorkingDirectoryPath,
} from "./delegation-tool.js";
import {
  resolveDelegationBudgetHintMs,
} from "./delegation-timeout.js";
import type { SubagentFailureClass, SubagentRetryRule } from "./subagent-orchestrator-types.js";
import {
  DEFAULT_TOOL_BUDGET_PER_REQUEST,
} from "../llm/chat-executor-constants.js";

/* ------------------------------------------------------------------ */
/*  Budget & tool budget constants                                     */
/* ------------------------------------------------------------------ */

const DEFAULT_PLANNED_SUBAGENT_TOOL_BUDGET = DEFAULT_TOOL_BUDGET_PER_REQUEST;
const MAX_PLANNED_SUBAGENT_TOOL_BUDGET = 96;
const PLANNED_SUBAGENT_TOOL_BUDGET_MS_PER_CALL = 7_500;
const BUDGET_EXCEEDED_RETRY_TOOL_BUDGET_MULTIPLIER = 1.5;

/* ------------------------------------------------------------------ */
/*  Budget hint & tool budget resolution                               */
/* ------------------------------------------------------------------ */

export function parseBudgetHintMs(
  hint: string,
  defaultSubagentTimeoutMs: number,
): number {
  return resolveDelegationBudgetHintMs(
    hint,
    defaultSubagentTimeoutMs,
  );
}

export function resolveSubagentToolBudgetPerRequest(params: {
  readonly timeoutMs: number;
  readonly priorFailureClass?: SubagentFailureClass;
}): number {
  const baseBudget = Math.max(
    DEFAULT_PLANNED_SUBAGENT_TOOL_BUDGET,
    Math.ceil(params.timeoutMs / PLANNED_SUBAGENT_TOOL_BUDGET_MS_PER_CALL),
  );
  const boostedBudget =
    params.priorFailureClass === "budget_exceeded"
      ? Math.ceil(
          baseBudget * BUDGET_EXCEEDED_RETRY_TOOL_BUDGET_MULTIPLIER,
        )
      : baseBudget;
  return Math.min(MAX_PLANNED_SUBAGENT_TOOL_BUDGET, boostedBudget);
}

/* ------------------------------------------------------------------ */
/*  Retry attempt tracking                                             */
/* ------------------------------------------------------------------ */

export function createRetryAttemptTracker(): Record<SubagentFailureClass, number> {
  return {
    timeout: 0,
    budget_exceeded: 0,
    tool_misuse: 0,
    malformed_result_contract: 0,
    needs_decomposition: 0,
    invalid_input: 0,
    transient_provider_error: 0,
    cancelled: 0,
    spawn_error: 0,
    unknown: 0,
  };
}

export function computeRetryDelayMs(
  rule: SubagentRetryRule,
  retryAttempt: number,
): number {
  if (rule.maxRetries <= 0 || rule.baseDelayMs <= 0) return 0;
  const scaled = rule.baseDelayMs * Math.max(1, retryAttempt);
  return Math.max(0, Math.min(rule.maxDelayMs, scaled));
}

/* ------------------------------------------------------------------ */
/*  Failure classification                                             */
/* ------------------------------------------------------------------ */

export function classifySpawnFailure(message: string): SubagentFailureClass {
  const lower = message.toLowerCase();
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("deadline exceeded")
  ) {
    return "timeout";
  }
  if (
    lower.includes("temporarily unavailable") ||
    lower.includes("resource temporarily unavailable") ||
    lower.includes("connection reset") ||
    lower.includes("econnreset") ||
    lower.includes("429") ||
    lower.includes("rate limit")
  ) {
    return "transient_provider_error";
  }
  return "spawn_error";
}

export function classifySubagentFailureMessage(message: string): SubagentFailureClass {
  const lower = message.toLowerCase();
  if (
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("deadline exceeded")
  ) {
    return "timeout";
  }
  if (lower.includes("cancelled") || lower.includes("canceled")) {
    return "cancelled";
  }
  if (
    lower.includes("provider error") ||
    lower.includes("fetch failed") ||
    lower.includes("temporarily unavailable") ||
    lower.includes("connection reset") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("rate limit") ||
    lower.includes("429")
  ) {
    return "transient_provider_error";
  }
  if (
    lower.includes("missing required argument") ||
    lower.includes("invalid argument") ||
    lower.includes("unknown tool") ||
    lower.includes("tool call validation") ||
    lower.includes("command must be one executable token/path") ||
    lower.includes("shell snippets")
  ) {
    return "tool_misuse";
  }
  if (
    lower.includes("malformed result contract") ||
    lower.includes("expected json object")
  ) {
    return "malformed_result_contract";
  }
  return "unknown";
}

export function classifySubagentFailureResult(
  result: Pick<SubAgentResult, "output" | "stopReason" | "stopReasonDetail">,
): SubagentFailureClass {
  if (result.stopReason === "timeout") return "timeout";
  if (result.stopReason === "budget_exceeded") return "budget_exceeded";
  if (result.stopReason === "cancelled") return "cancelled";
  if (
    result.stopReason === "provider_error" ||
    result.stopReason === "authentication_error" ||
    result.stopReason === "rate_limited"
  ) {
    return "transient_provider_error";
  }
  const message =
    typeof result.stopReasonDetail === "string" &&
      result.stopReasonDetail.trim().length > 0
      ? result.stopReasonDetail
      : (typeof result.output === "string" ? result.output : "");
  return classifySubagentFailureMessage(message);
}

/* ------------------------------------------------------------------ */
/*  Delegated working directory resolution                             */
/* ------------------------------------------------------------------ */

export function resolveEffectiveDelegatedWorkingDirectory(input: {
  readonly task?: string;
  readonly objective?: string;
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly contextRequirements?: readonly string[];
}): (DelegatedWorkingDirectoryResolution & { readonly anchored: boolean }) | undefined {
  const delegatedWorkingDirectory = resolveDelegatedWorkingDirectory(input);
  if (!delegatedWorkingDirectory) {
    return undefined;
  }

  return {
    ...delegatedWorkingDirectory,
    anchored: isAnchoredDelegatedWorkingDirectory(delegatedWorkingDirectory.path),
  };
}

export function isAnchoredDelegatedWorkingDirectory(path: string): boolean {
  const normalized = path.trim();
  if (normalized.length === 0) return false;
  if (normalized.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(normalized)) return true;
  if (normalized.startsWith("~")) return true;
  return false;
}

export function normalizeAnchoredDelegatedWorkingDirectory(
  directoryPath: string,
  workspaceRoot?: string,
): string {
  const normalized = directoryPath.trim();
  if (normalized.length === 0 || !workspaceRoot) {
    return normalized;
  }
  const resolvedPath = resolveDelegatedWorkingDirectoryPath(
    normalized,
    workspaceRoot,
  );
  return resolvedPath ?? normalized;
}

export function resolvePlannerContextDelegatedWorkingDirectory(
  pipeline: Pipeline,
  hostWorkspaceRoot?: string | null,
): {
  readonly path: string;
  readonly anchored: boolean;
  readonly source?: DelegatedWorkingDirectoryResolution["source"];
} | undefined {
  const cwdFromPipeline = (pipeline.plannerContext as Record<string, unknown> | undefined)?.delegatedWorkingDirectory;
  if (typeof cwdFromPipeline !== "string" || cwdFromPipeline.trim().length === 0) {
    return undefined;
  }
  const path = hostWorkspaceRoot
    ? normalizeAnchoredDelegatedWorkingDirectory(
        cwdFromPipeline,
        hostWorkspaceRoot,
      )
    : cwdFromPipeline;
  return { path, anchored: isAnchoredDelegatedWorkingDirectory(path), source: "context_requirement" };
}

export function resolveInheritedDelegatedWorkingDirectory(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  hostWorkspaceRoot?: string | null,
): {
  readonly path: string;
  readonly anchored: boolean;
  readonly source?: DelegatedWorkingDirectoryResolution["source"];
} | undefined {
  // 1. Try planner-context CWD.
  const plannerContextCwd = resolvePlannerContextDelegatedWorkingDirectory(
    pipeline,
    hostWorkspaceRoot,
  );
  if (plannerContextCwd) return plannerContextCwd;

  // 2. Try step-level extraction.
  const effective = resolveEffectiveDelegatedWorkingDirectory({
    task: step.name,
    objective: step.objective,
    inputContract: step.inputContract,
    acceptanceCriteria: step.acceptanceCriteria,
    contextRequirements: step.contextRequirements,
  });
  if (effective) {
    const normalized = hostWorkspaceRoot
      ? normalizeAnchoredDelegatedWorkingDirectory(
          effective.path,
          hostWorkspaceRoot,
        )
      : effective.path;
    return { path: normalized, anchored: isAnchoredDelegatedWorkingDirectory(normalized), source: effective.source };
  }

  // 3. Try parent request extraction.
  const parentRequest = pipeline.plannerContext?.parentRequest?.trim();
  if (typeof parentRequest === "string" && parentRequest.length > 0) {
    const parentCwd = resolveEffectiveDelegatedWorkingDirectory({
      task: step.name,
      objective: parentRequest,
    });
    if (parentCwd) {
      const normalized = hostWorkspaceRoot
        ? normalizeAnchoredDelegatedWorkingDirectory(
            parentCwd.path,
            hostWorkspaceRoot,
          )
        : parentCwd.path;
      return { path: normalized, anchored: isAnchoredDelegatedWorkingDirectory(normalized), source: parentCwd.source };
    }
  }

  return undefined;
}

export function resolvePlannerStepWorkingDirectory(
  step: PipelinePlannerSubagentStep,
  pipeline: Pipeline,
  hostWorkspaceRoot?: string | null,
): {
  readonly path: string;
  readonly anchored: boolean;
  readonly source?: DelegatedWorkingDirectoryResolution["source"];
} | undefined {
  const inherited = resolveInheritedDelegatedWorkingDirectory(
    step,
    pipeline,
    hostWorkspaceRoot,
  );
  if (inherited) return inherited;

  // Fallback: host workspace root.
  if (typeof hostWorkspaceRoot === "string" && hostWorkspaceRoot.trim().length > 0) {
    return {
      path: hostWorkspaceRoot,
      anchored: isAnchoredDelegatedWorkingDirectory(hostWorkspaceRoot),
    };
  }

  return undefined;
}

export function buildEffectiveContextRequirements(
  step: PipelinePlannerSubagentStep,
  delegatedWorkingDirectory?: string,
): readonly string[] {
  if (
    typeof delegatedWorkingDirectory !== "string" ||
    delegatedWorkingDirectory.trim().length === 0
  ) {
    return step.contextRequirements;
  }

  const normalizedRequirement = `cwd=${delegatedWorkingDirectory}`;
  let replaced = false;
  const rewritten = step.contextRequirements
    .map((requirement) => {
      if (
        /^(?:cwd|working(?:[_ -]?directory))\s*(?:=|:)\s*(.+)$/i.test(
          requirement,
        )
      ) {
        replaced = true;
        return normalizedRequirement;
      }
      return requirement;
    })
    .filter((requirement, index, entries) =>
      requirement.length > 0 && entries.indexOf(requirement) === index
    );

  if (replaced) {
    return rewritten;
  }

  return [normalizedRequirement, ...rewritten];
}

/* ------------------------------------------------------------------ */
/*  High risk capabilities check                                       */
/* ------------------------------------------------------------------ */

export function hasHighRiskCapabilities(capabilities: readonly string[]): boolean {
  for (const capability of capabilities) {
    const normalized = capability.trim().toLowerCase();
    if (!normalized) continue;
    if (
      normalized.startsWith("wallet.") ||
      normalized.startsWith("solana.") ||
      normalized.startsWith("agenc.") ||
      normalized.startsWith("desktop.") ||
      normalized === "system.delete" ||
      normalized === "system.execute" ||
      normalized === "system.open" ||
      normalized === "system.applescript" ||
      normalized === "system.notification"
    ) {
      return true;
    }
  }
  return false;
}
