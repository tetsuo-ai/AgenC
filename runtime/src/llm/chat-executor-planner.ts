/**
 * Planner parsing, validation, and message-building functions for ChatExecutor.
 *
 * @module
 */

import type { LLMMessage, LLMToolCall } from "./types.js";
import type {
  PromptBudgetSection,
} from "./prompt-budget.js";
import type { LLMPipelineStopReason } from "./policy.js";
import type {
  PipelinePlannerContext,
  PipelinePlannerContextMemorySource,
  PipelinePlannerStep,
  PipelineResult,
} from "../workflow/pipeline.js";
import type { WorkflowGraphEdge } from "../workflow/types.js";
import type {
  PlannerDecision,
  PlannerStepType,
  PlannerStepIntent,
  PlannerDeterministicToolStepIntent,
  PlannerSubAgentTaskStepIntent,
  PlannerPlan,
  PlannerParseResult,
  PlannerDiagnostic,
  PlannerGraphValidationConfig,
  FullPlannerSummaryState,
  SubagentVerifierDecision,
  SubagentVerifierStepAssessment,
  ToolCallRecord,
} from "./chat-executor-types.js";
import {
  assessDelegationDecision,
  type DelegationDecisionConfig,
  type DelegationDecision,
  type DelegationHardBlockedTaskClass,
} from "./delegation-decision.js";
import type {
  DelegationBanditPolicyTuner,
  DelegationBanditSelection,
} from "./delegation-learning.js";
import {
  MAX_PLANNER_STEPS,
  MAX_PLANNER_CONTEXT_HISTORY_CANDIDATES,
  MAX_PLANNER_CONTEXT_HISTORY_CHARS,
  MAX_PLANNER_CONTEXT_MEMORY_CHARS,
  MAX_PLANNER_CONTEXT_TOOL_OUTPUT_CHARS,
  MAX_USER_MESSAGE_CHARS,
  MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS,
  RECOVERY_HINT_PREFIX,
} from "./chat-executor-constants.js";
import {
  truncateText,
  extractLLMMessageText,
  parseJsonObjectFromText,
  normalizeHistory,
} from "./chat-executor-text.js";
import {
  buildImperativeToolReferenceRegex,
  extractExplicitImperativeToolNames,
} from "./chat-executor-explicit-tools.js";
import { didToolCallFail } from "./chat-executor-tool-utils.js";
import { safeStringify } from "../tools/types.js";
import {
  assessDelegationScope,
  type DelegationDecompositionSignal,
} from "../gateway/delegation-scope.js";
import {
  getAcceptanceVerificationCategories,
  isDefinitionOnlyVerificationText,
  specRequiresMeaningfulBrowserEvidence,
} from "../utils/delegation-validation.js";
import {
  inspectDelegationBudgetHint,
  MIN_DELEGATION_TIMEOUT_MS,
} from "../gateway/delegation-timeout.js";
import type { HostToolingProfile } from "../gateway/host-tooling.js";
import { collectDirectModeShellControlTokens } from "../tools/system/command-line.js";

// ============================================================================
// Planner decision
// ============================================================================

interface PlannerRequestSignals {
  readonly normalized: string;
  readonly hasMultiStepCue: boolean;
  readonly hasToolDiversityCue: boolean;
  readonly hasDelegationCue: boolean;
  readonly hasImplementationScopeCue: boolean;
  readonly hasVerificationCue: boolean;
  readonly hasDocumentationCue: boolean;
  readonly longTask: boolean;
  readonly structuredBulletCount: number;
  readonly priorToolMessages: number;
  readonly hasPriorNoProgressSignal: boolean;
}

function countStructuredBulletLines(messageText: string): number {
  return messageText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*]|\d+[\).:])\s+/.test(line))
    .length;
}

function collectPlannerRequestSignals(
  messageText: string,
  history: readonly LLMMessage[],
): PlannerRequestSignals {
  const normalized = messageText.toLowerCase();
  const historyTail = history.slice(-10);
  return {
    normalized,
    hasMultiStepCue:
      /\b(first|second|third|then|after that|next|finally|step\b|in order|checklist|pipeline)\b/i.test(
        messageText,
      ) ||
      /\b1[\).:]\s+.+\b2[\).:]/s.test(messageText),
    hasToolDiversityCue:
      /\b(browser|http|curl|bash|command|container|playwright|open|navigate|teardown|verify)\b/i.test(
        messageText,
      ),
    hasDelegationCue:
      /\b(sub[\s-]?agent|child agent|execute_with_agent|delegate|delegation|parallel(?:ize|ism)?|fanout)\b/i.test(
        messageText,
      ),
    hasImplementationScopeCue:
      /\b(build|implement|create|scaffold|generate|refactor|migrate|api|endpoint|service|integration|unit tests?|e2e|makefile|project)\b/i.test(
        messageText,
      ) ||
      /\b(add|write|create|run)\s+(?:unit\s+)?tests?\b/i.test(messageText),
    hasVerificationCue:
      /\b(verify|verification|validate|validation|typecheck|lint|build|compile|vitest|jest|mocha|passing commands?)\b/i.test(
        messageText,
      ) ||
      /\b(add|write|create|run|include)\s+(?:unit\s+)?tests?\b/i.test(
        messageText,
      ),
    hasDocumentationCue:
      /\b(readme|docs?|documentation|architecture summary|how to play|known limitations|report)\b/i.test(
        messageText,
      ),
    longTask:
      messageText.length >= 320 || messageText.split(/\n/).length >= 4,
    structuredBulletCount: countStructuredBulletLines(messageText),
    priorToolMessages: historyTail.filter((entry) => entry.role === "tool")
      .length,
    hasPriorNoProgressSignal: historyTail.some(
      (entry) =>
        typeof entry.content === "string" &&
        entry.content.includes(RECOVERY_HINT_PREFIX),
    ),
  };
}

export function assessPlannerDecision(
  plannerEnabled: boolean,
  messageText: string,
  history: readonly LLMMessage[],
): PlannerDecision {
  if (!plannerEnabled) {
    return {
      score: 0,
      shouldPlan: false,
      reason: "planner_disabled",
    };
  }

  const signals = collectPlannerRequestSignals(messageText, history);
  let score = 0;
  const reasons: string[] = [];

  if (signals.hasMultiStepCue) {
    score += 3;
    reasons.push("multi_step_cues");
  }

  if (signals.hasToolDiversityCue) {
    score += 1;
    reasons.push("multi_tool_candidates");
  }

  if (signals.hasDelegationCue) {
    score += 4;
    reasons.push("delegation_cue");
  }

  if (signals.hasImplementationScopeCue) {
    score += 3;
    reasons.push("implementation_scope");
  }

  if (signals.longTask) {
    score += 1;
    reasons.push("long_or_structured_request");
  }

  if (signals.priorToolMessages >= 4) {
    score += 2;
    reasons.push("prior_tool_loop_activity");
  }
  if (signals.hasPriorNoProgressSignal) {
    score += 2;
    reasons.push("prior_no_progress_signal");
  }

  const isExactResponseTurn = isDialogueOnlyExactResponseTurn(messageText);
  if (isExactResponseTurn) {
    return {
      score,
      shouldPlan: false,
      reason: "exact_response_turn",
    };
  }

  const isDialogueMemoryTurn = isDialogueOnlyMemoryTurn(messageText);
  if (isDialogueMemoryTurn) {
    return {
      score,
      shouldPlan: false,
      reason: "dialogue_memory_turn",
    };
  }

  const isDialogueRecallTurn = isDialogueOnlyRecallTurn(messageText);
  if (isDialogueRecallTurn) {
    return {
      score,
      shouldPlan: false,
      reason: "dialogue_recall_turn",
    };
  }

  const directFastPath =
    score < 3 ||
    signals.normalized.trim().length < 20 ||
    /\b(hi|hello|thanks|thank you)\b/.test(signals.normalized);

  return {
    score,
    shouldPlan: !directFastPath,
    reason: reasons.length > 0 ? reasons.join("+") : "direct_fast_path",
  };
}

export function requestRequiresToolGroundedExecution(
  messageText: string,
): boolean {
  if (
    isDialogueOnlyExactResponseTurn(messageText) ||
    isDialogueOnlyMemoryTurn(messageText) ||
    isDialogueOnlyRecallTurn(messageText)
  ) {
    return false;
  }

  const explicitEnvironmentAction = EXPLICIT_ENV_ACTION_CUE_RE.test(messageText);
  if (
    EXPLANATION_ONLY_REQUEST_RE.test(messageText) &&
    !explicitEnvironmentAction
  ) {
    return false;
  }

  const signals = collectPlannerRequestSignals(messageText, []);
  if (explicitEnvironmentAction) {
    return true;
  }

  if (signals.hasImplementationScopeCue && signals.hasVerificationCue) {
    return true;
  }

  if (
    signals.hasImplementationScopeCue &&
    EXECUTION_ARTIFACT_OR_PATH_CUE_RE.test(messageText)
  ) {
    return true;
  }

  if (
    signals.hasImplementationScopeCue &&
    EXECUTION_SCOPE_BOUNDARY_CUE_RE.test(messageText)
  ) {
    return true;
  }

  return (
    signals.hasVerificationCue &&
    (EXECUTION_ARTIFACT_OR_PATH_CUE_RE.test(messageText) ||
      EXECUTION_SCOPE_BOUNDARY_CUE_RE.test(messageText))
  );
}

function deriveMinimumExpectedSalvagedSteps(
  signals: PlannerRequestSignals,
): number {
  let minimumExpectedSteps = 1;
  if (
    signals.hasImplementationScopeCue ||
    signals.hasVerificationCue ||
    signals.hasDocumentationCue ||
    signals.hasMultiStepCue ||
    signals.longTask ||
    signals.structuredBulletCount >= 3
  ) {
    minimumExpectedSteps = 2;
  }
  if (
    (signals.hasImplementationScopeCue &&
      (signals.hasVerificationCue || signals.hasDocumentationCue)) ||
    (signals.hasImplementationScopeCue && signals.structuredBulletCount >= 3) ||
    signals.structuredBulletCount >= 5
  ) {
    minimumExpectedSteps = 3;
  }
  return minimumExpectedSteps;
}

const EXACT_RESPONSE_CUE_RE =
  /\b(?:return|reply|respond|output)(?:\s+with)?\s+exactly\b/i;
const DIALOGUE_MEMORY_CUE_RE =
  /\b(?:memorize|remember|keep in mind|later recall|for later recall|recall later)\b/i;
const DIALOGUE_RECALL_CUE_RE =
  /\b(?:recall|remember|repeat|return|what(?:'s| is| were| did))\b/i;
const DIALOGUE_RECALL_REFERENCE_CUE_RE =
  /\b(?:from (?:test|earlier|before|above|prior|previous)|(?:you|i) (?:stored|memorized|remembered|told)|those facts|these facts|the facts|last turn|prior turn|previous turn|continuity test)\b/i;
const EXPLICIT_ENV_ACTION_CUE_RE =
  /\b(?:use|call|invoke|run|start|stop|create|write|edit|save|open|navigate|click|search|browse|inspect|read|check|verify|delegate|spawn|launch|post|publish|deploy|install|build|implement|refactor|migrate|continue)\b[\s\S]{0,96}\b(?:tool|tools|desktop|system|mcp|browser|bash|command|terminal|file|files|server|process|service|sub[\s-]?agent|execute_with_agent|child\s+session|continuation\s+session|session\s+id|task|api|endpoint|project|tests?|[a-z][\w-]*\.[a-z][\w.-]*)\b/i;
const EXECUTION_ARTIFACT_OR_PATH_CUE_RE =
  /\b(?:[a-z0-9_-]+\.(?:c|cc|cpp|h|hpp|rs|go|py|rb|php|java|kt|js|mjs|cjs|ts|tsx|jsx|json|md|toml|yaml|yml)|makefile|dockerfile|package\.json|tsconfig(?:\.[a-z]+)?\.json|vite\.config(?:\.[a-z]+)?|vitest\.config(?:\.[a-z]+)?|src\/|tests?\/|workspace|directory|folder|repo(?:sitory)?|project)\b/i;
const EXECUTION_SCOPE_BOUNDARY_CUE_RE =
  /\b(?:in|under|inside|within|at)\s+[`'"]?(?:\/|\.\/|\.\.\/)|\b(?:do not read|do not modify|keep everything|only in|only under|only inside)\b/i;
const EXPLANATION_ONLY_REQUEST_RE =
  /\b(?:explain|describe|outline|summarize|brainstorm|compare|review|analy(?:s|z)e|what would|how would|plan(?:\s+out)?|walk me through)\b/i;
const NODE_PACKAGE_TOOLING_RE =
  /\b(?:node(?:\.js)?|npm|npx|package\.json|package-lock\.json|pnpm|pnpm-workspace\.yaml|yarn|bun|workspaces?|typescript|tsconfig(?:\.[a-z]+)?\.json|tsx|vitest|commander)\b/i;
const NODE_PACKAGE_MANIFEST_PATH_RE =
  /(?:^|\/)(?:package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb|tsconfig(?:\.[a-z]+)?\.json)$/i;
const NODE_LOCAL_DEPENDENCY_SPEC_RE =
  /\b(?:file:\.\.\/|workspace:\*|local deps?|local dependency references?)\b/i;
const NODE_MANIFEST_OR_CONFIG_RE =
  /\b(?:package\.json|package-lock\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|tsconfig(?:\.[a-z]+)?\.json|vite\.config(?:\.[a-z]+)?|vitest\.config(?:\.[a-z]+)?|workspaces?|dependencies|devdependencies|scripts?|bin)\b/i;
const NODE_INSTALL_SENSITIVE_VERIFICATION_ACTION_RE =
  /\b(?:verify|verified|validat(?:e|ed|ion)|confirm|confirmed|ensure|ensures|ensured|check|checks|checked|run|runs|running|execute|executes|executed|prove|proves|proven)\b/i;
const NODE_INSTALL_SENSITIVE_VERIFICATION_TARGET_RE =
  /\b(?:tests?|coverage|vitest|jest|mocha|ava|npm\s+(?:test|run\s+build|run\s+typecheck|run\s+lint)|pnpm\s+(?:test|build|typecheck|lint)|yarn\s+(?:test|build|typecheck|lint)|bun\s+(?:test|run(?:\s+(?:build|typecheck|lint))?)|vite\s+build|tsc\b|build(?:s|ing)?|compile(?:s|d|ing)?|typecheck(?:s|ed|ing)?|lint(?:s|ed|ing)?|install(?:s|ed|ing)?)\b/i;
const NODE_INSTALL_SENSITIVE_VERIFICATION_PHRASE_RE =
  /\b(?:tests?\s+(?:pass|passing|passed|run|runs|running|succeed|succeeds|succeeded)|coverage(?:\s+(?:reported|generated|collected|runs?|ran))?|builds?\s+(?:cleanly|correctly|successfully|without errors?|ok)|compiles?\s+(?:cleanly|correctly|successfully|without errors?)|typechecks?\s+(?:cleanly|correctly|successfully|without errors?)|lints?\s+(?:cleanly|correctly|successfully|without errors?)|installs?\s+(?:cleanly|correctly|successfully|without errors?)|npm\s+(?:test|run\s+build|run\s+typecheck|run\s+lint)\s+(?:passes?|succeeds?|runs?)|pnpm\s+(?:test|build|typecheck|lint)\s+(?:passes?|succeeds?|runs?)|yarn\s+(?:test|build|typecheck|lint)\s+(?:passes?|succeeds?|runs?)|bun\s+(?:test|run(?:\s+(?:build|typecheck|lint))?)\s+(?:passes?|succeeds?|runs?)|vite\s+build\s+(?:passes?|succeeds?|runs?)|tsc\s+(?:passes?|succeeds?|runs?))\b/i;
const NEGATED_NODE_VERIFICATION_RE =
  /\b(?:no|without|avoid(?:ing)?|skip|exclude(?:d|ing)?|do\s+not|don't)\s+(?:any\s+)?(?:install(?:ation|ing)?|run(?:ning)?|runtime\s+testing|tests?|testing|build(?:s|ing)?|compile(?:s|d|ing)?|typecheck(?:s|ed|ing)?|lint(?:s|ed|ing)?)(?:\s*(?:\/|or|and)\s*(?:install(?:ation|ing)?|run(?:ning)?|tests?|testing|build(?:s|ing)?|compile(?:s|d|ing)?|typecheck(?:s|ed|ing)?|lint(?:s|ed|ing)?))*\b/gi;
const NODE_PACKAGE_MANAGER_COMMANDS = new Set(["npm", "pnpm", "yarn", "bun"]);
const NODE_INSTALL_ACTIONS = new Set(["install", "ci", "add"]);

function stripNegatedNodeVerificationLanguage(value: string): string {
  return value.replace(NEGATED_NODE_VERIFICATION_RE, " ");
}

function isDialogueOnlyExactResponseTurn(messageText: string): boolean {
  return (
    EXACT_RESPONSE_CUE_RE.test(messageText) &&
    !EXPLICIT_ENV_ACTION_CUE_RE.test(messageText)
  );
}

function isDialogueOnlyMemoryTurn(messageText: string): boolean {
  return (
    DIALOGUE_MEMORY_CUE_RE.test(messageText) &&
    !EXPLICIT_ENV_ACTION_CUE_RE.test(messageText)
  );
}

function isDialogueOnlyRecallTurn(messageText: string): boolean {
  return (
    DIALOGUE_RECALL_CUE_RE.test(messageText) &&
    DIALOGUE_RECALL_REFERENCE_CUE_RE.test(messageText) &&
    !EXPLICIT_ENV_ACTION_CUE_RE.test(messageText)
  );
}

function shouldIncludePlannerHostTooling(
  messageText: string,
  history: readonly LLMMessage[],
): boolean {
  if (
    NODE_PACKAGE_TOOLING_RE.test(messageText) ||
    NODE_PACKAGE_MANIFEST_PATH_RE.test(messageText)
  ) {
    return true;
  }
  return history.some((entry) => {
    const raw =
      typeof entry.content === "string"
        ? entry.content
        : entry.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(" ");
    return (
      NODE_PACKAGE_TOOLING_RE.test(raw) ||
      NODE_PACKAGE_MANIFEST_PATH_RE.test(raw)
    );
  });
}

function buildPlannerHostToolingHint(
  messageText: string,
  history: readonly LLMMessage[],
  hostToolingProfile?: HostToolingProfile | null,
): string | undefined {
  if (
    !hostToolingProfile ||
    !shouldIncludePlannerHostTooling(messageText, history)
  ) {
    return undefined;
  }

  const fragments = [`Host Node version: \`${hostToolingProfile.nodeVersion}\`.`];
  if (hostToolingProfile.npm?.version) {
    fragments.push(`Host npm version: \`${hostToolingProfile.npm.version}\`.`);
  }
  fragments.push(
    "For Node workspace plans, keep manifest/config scaffolding before the real package-manager install, then run one host install before any delegated build/test/coverage validation.",
  );
  fragments.push(
    "Before that install step, scaffold/setup subagent steps may only claim authored manifests, configs, scripts, directory structure, and local dependency links. Do not mention `npm install`, build, test, coverage, typecheck, lint, or runtime success in those step objectives or acceptance criteria.",
  );
  if (hostToolingProfile.npm?.workspaceProtocolSupport === "unsupported") {
    const evidence = hostToolingProfile.npm.workspaceProtocolEvidence
      ? ` (${hostToolingProfile.npm.workspaceProtocolEvidence})`
      : "";
    fragments.push(
      "Empirical npm probe: local `workspace:*` dependency specifiers are unsupported on this host" +
        `${evidence}.`,
    );
    fragments.push(
      "Do not emit `workspace:*` in generated manifests. Choose a host-compatible local dependency reference and verify it with `npm install` on this host before continuing.",
    );
  } else if (hostToolingProfile.npm?.workspaceProtocolSupport === "unknown") {
    const evidence = hostToolingProfile.npm.workspaceProtocolEvidence
      ? ` (${hostToolingProfile.npm.workspaceProtocolEvidence})`
      : "";
    fragments.push(
      "Empirical npm probe could not confirm whether local `workspace:*` dependency specifiers work on this host" +
        `${evidence}. Verify local dependency specs with a real install before depending on workspace protocol semantics.`,
    );
  } else if (hostToolingProfile.npm?.workspaceProtocolSupport === "supported") {
    fragments.push(
      "Empirical npm probe: local `workspace:*` dependency specifiers are supported on this host.",
    );
  }

  return fragments.join(" ");
}

// ============================================================================
// Planner message building
// ============================================================================

export function buildPlannerMessages(
  messageText: string,
  history: readonly LLMMessage[],
  plannerMaxTokens: number,
  explicitDeterministicRequirements?: ExplicitDeterministicToolRequirements,
  refinementHint?: string,
  hostToolingProfile?: HostToolingProfile | null,
  runtimeConstraints?: PlannerRuntimeConstraints,
): readonly LLMMessage[] {
  const explicitOrchestration =
    extractExplicitSubagentOrchestrationRequirements(messageText);
  const verificationRequirements =
    extractPlannerVerificationRequirements(messageText);
  const verificationCommandRequirements =
    extractPlannerVerificationCommandRequirements(messageText);
  const hostToolingHint = buildPlannerHostToolingHint(
    messageText,
    history,
    hostToolingProfile,
  );
  const historyPreview = history
    .slice(-6)
    .map((entry) => {
      const raw =
        typeof entry.content === "string"
          ? entry.content
          : entry.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join(" ");
      return `[${entry.role}] ${truncateText(raw, 300)}`;
    })
    .join("\n");
  const maxSteps = Math.min(
    MAX_PLANNER_STEPS,
    Math.max(1, Math.floor(plannerMaxTokens / 8)),
  );

  const messages: LLMMessage[] = [
    {
      role: "system",
      content:
        "Plan this request into executable intents. Respond with strict JSON only.\n" +
        "Schema:\n" +
        "{\n" +
        '  "reason": "short routing reason",\n' +
        '  "requiresSynthesis": boolean,\n' +
        '  "steps": [\n' +
        "    {\n" +
        '      "name": "step_name",\n' +
        '      "step_type": "deterministic_tool|subagent_task|synthesis",\n' +
        '      "depends_on": ["step_name"],\n' +
        '      "tool": "tool.name",\n' +
        '      "args": { "key": "value" },\n' +
        '      "onError": "abort|retry|skip",\n' +
        '      "maxRetries": number,\n' +
        '      "objective": "required for subagent_task",\n' +
        '      "input_contract": "required for subagent_task",\n' +
        '      "acceptance_criteria": ["required for subagent_task"],\n' +
        '      "required_tool_capabilities": ["required for subagent_task"],\n' +
        '      "context_requirements": ["required for subagent_task"],\n' +
        '      "max_budget_hint": "required for subagent_task",\n' +
        '      "can_run_parallel": true\n' +
        "    }\n" +
        "  ]\n" +
        "}\n" +
        "Rules:\n" +
        "- deterministic_tool steps are executable by the deterministic pipeline.\n" +
        "- subagent_task steps MUST include all required subagent fields.\n" +
        "- `can_run_parallel` is optional; omit it when unknown and the runtime will default it to false.\n" +
        "- When a subagent step needs a workspace, encode it in `context_requirements` as `cwd=/absolute/path`.\n" +
        "- For deterministic_tool steps, put all tool parameters inside `args`. Do not place tool parameters like `cwd` or `timeoutMs` at the step root.\n" +
        "- Each subagent_task must stay narrowly scoped to one phase of work. Do not combine research, setup, implementation, and validation into one delegated step.\n" +
        "- Prefer multiple smaller subagent_task steps with explicit dependencies over one large delegated objective.\n" +
        (
          runtimeConstraints
            ? `- Never emit more than ${runtimeConstraints.maxSubagentFanout} subagent_task steps in the full plan.\n`
            : ""
        ) +
        "- If you need to reduce delegated fanout, only merge adjacent steps from the same phase family. Never merge research with setup/manifest work, or code implementation with broad validation/browser QA.\n" +
        "- For Node workspace scaffold/setup steps that run before the real install step, objectives and acceptance criteria must stay file-authoring-only. Do not mention install/build/test/typecheck/lint/coverage/runtime success there; put those checks in later steps after install.\n" +
        "- For deterministic system.bash/desktop.bash steps, do not use nested shell wrappers like `bash -c` or `sh -c`; call the target command directly or use shell mode.\n" +
        "- Do not embed heredocs, multi-line shell scripts, or generated file contents inside deterministic bash steps. Use file mutation tools for file contents instead.\n" +
        "- Verification/build/test commands must be non-interactive and exit on their own. Do not use watch mode or dev servers for validation. Prefer runner-native single-run invocations. For Vitest use `vitest run`/`vitest --run`. For Jest use `CI=1 npm test` or `jest --runInBand`. Only pass extra npm `--` flags when the underlying runner supports them.\n" +
        "- max_budget_hint must use explicit units like `90s`, `2m`, or `1h`; do not use bare numeric hints such as `0.08`.\n" +
        "- synthesis steps describe final merge/synthesis intent and do not call tools.\n" +
        `Keep output concise and below approximately ${plannerMaxTokens} tokens. ` +
        `Never emit more than ${maxSteps} steps.`,
    },
  ];

  if (explicitOrchestration) {
    messages.push({
      role: "system",
      content:
        "The user supplied a required sub-agent orchestration plan. " +
        "You MUST emit one `subagent_task` step for each required step using " +
        `these exact step names and order: ${explicitOrchestration.stepNames.join(" -> ")}. ` +
        "Do not rename, omit, merge, or collapse any required step. " +
        "Preserve dependency order so later steps depend on the earlier required steps they build on. " +
        "Set `requiresSynthesis` to true so the parent can merge child outputs into the final response.",
    });
  }

  if (explicitDeterministicRequirements) {
    const requiredOrder = renderExplicitToolRequirementSummary(
      explicitDeterministicRequirements,
    );
    const exactLiteralInstruction =
      typeof explicitDeterministicRequirements.exactResponseLiteral === "string"
      && explicitDeterministicRequirements.exactResponseLiteral.length > 0
        ? " The user also requires an exact final response literal after the deterministic tool steps. " +
          "Keep `requiresSynthesis` false and do not add a `synthesis` step for that literal; the parent executor will finalize it after the deterministic steps complete."
        : "";
    messages.push({
      role: "system",
      content:
        "The user supplied an explicit deterministic tool contract for this turn. " +
        `Use only these tools in this order: ${requiredOrder}. ` +
        "Emit one `deterministic_tool` step per required tool call, preserve dependency order between the tool stages, and do not emit `subagent_task` steps or off-domain tools." +
        exactLiteralInstruction,
    });
  }

  if (verificationRequirements.length > 0) {
    messages.push({
      role: "system",
      content:
        "The user explicitly required verification coverage before finishing. " +
        `Preserve these verification modes in the plan: ${verificationRequirements.join(" -> ")}. ` +
        "Do not silently drop a requested verification mode during fanout reduction or runtime repair. " +
        "If browser-grounded checks are required, emit a later validation step whose objective or acceptance criteria explicitly require meaningful browser-grounded evidence.",
    });
  }

  if (verificationCommandRequirements.length > 0) {
    messages.push({
      role: "system",
      content:
        "The user explicitly named acceptance commands that must remain represented in the plan. " +
        `Preserve these commands as deterministic verification steps or delegated validation contracts that mention them explicitly: ${renderPlannerVerificationCommandSummary(verificationCommandRequirements)}. ` +
        "Do not silently drop, paraphrase away, or replace them with generic validation language.",
    });
  }

  if (typeof hostToolingHint === "string" && hostToolingHint.length > 0) {
    messages.push({
      role: "system",
      content: `Host tooling constraints: ${hostToolingHint}`,
    });
  }

  if (typeof refinementHint === "string" && refinementHint.trim().length > 0) {
    messages.push({
      role: "system",
      content:
        "Planner refinement required: " +
        `${refinementHint.trim()} Re-emit a smaller executable plan and do not repeat the overloaded delegated step shape.`,
    });
  }

  messages.push({
    role: "user",
    content:
      `User request:\n${messageText}\n\n` +
      (historyPreview.length > 0
        ? `Recent conversation context:\n${historyPreview}\n\n`
        : "") +
      "Return JSON only.",
  });

  return messages;
}

export interface ExplicitSubagentOrchestrationRequirementStep {
  readonly name: string;
  readonly description: string;
}

export interface ExplicitSubagentOrchestrationRequirements {
  readonly steps: readonly ExplicitSubagentOrchestrationRequirementStep[];
  readonly stepNames: readonly string[];
  readonly requiresSynthesis: boolean;
}

export interface ExplicitDeterministicToolRequirements {
  readonly orderedToolNames: readonly string[];
  readonly minimumToolCallsByName: Readonly<Record<string, number>>;
  readonly forcePlanner: boolean;
  readonly exactResponseLiteral?: string;
}

export interface PlannerRuntimeConstraints {
  readonly maxSubagentFanout: number;
}

export type PlannerVerificationRequirementCategory =
  | "install"
  | "build"
  | "test"
  | "browser";

const REQUIRED_SUBAGENT_PLAN_MARKER_RE =
  /sub-agent orchestration plan(?:\s*\((?:required|mandatory)\)|\s+(?:required|mandatory))\s*:/i;
const REQUIRED_SUBAGENT_STEP_NAME_RE =
  /(?:^|\s)(\d+)[\).:]\s*(?:`([^`]+)`|([A-Za-z0-9_-]+))/g;
const REQUIRED_DELIVERABLE_CUE_RE =
  /\b(final deliverables|how to play|known limitations|architecture summary)\b/i;
const REQUEST_VERIFICATION_DIRECTIVE_RE =
  /\b(?:verify|verification|validated?|before\s+finish(?:ing)?|before\s+returning|before\s+completion|browser-grounded checks?)\b/i;
const REQUEST_INSTALL_VERIFICATION_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|ci)\b|\binstall(?:ation|able|ed|ing|s)?\b/i;
const REQUEST_BUILD_VERIFICATION_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|typecheck|lint)\b|\b(?:vite\s+build|tsc\b|build(?:s|ing)?|compile(?:s|d|ing)?|typecheck(?:s|ed|ing)?|lint(?:s|ed|ing)?)\b/i;
const REQUEST_TEST_VERIFICATION_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|coverage|vitest|jest)\b|\b(?:tests?|testing|smoke tests?|unit tests?|vitest|jest|pytest|mocha|ava|coverage)\b/i;
const REQUEST_BROWSER_VERIFICATION_RE =
  /\b(?:browser(?:-grounded)?|browser\s+checks?|playwright|cypress|puppeteer|chrom(?:e|ium)|localhost|127\.0\.0\.1|e2e|end-to-end|ui validation|browser session|browser action)\b/i;
const PLANNER_SECTION_HEADING_RE = /^([A-Z][A-Za-z0-9 /_-]{0,80}):\s*$/;
const POSITIVE_VERIFICATION_OUTCOME_RE =
  /\b(?:passes?|reports?|returns?|prints?|outputs?|emits?|matches?|succeeds?)\b/i;
const PLANNER_BROWSER_VERIFICATION_TOOL_NAMES = new Set([
  "system.browserAction",
  "system.browserSessionStart",
  "system.browserSessionResume",
  "system.browserSessionStatus",
  "system.browserSessionArtifacts",
  "mcp.browser.browser_navigate",
  "mcp.browser.browser_snapshot",
  "mcp.browser.browser_run_code",
  "playwright.browser_navigate",
  "playwright.browser_snapshot",
]);
const PLANNER_VERIFICATION_CATEGORY_ORDER: readonly PlannerVerificationRequirementCategory[] = [
  "install",
  "build",
  "test",
  "browser",
];

export function extractExplicitSubagentOrchestrationRequirements(
  messageText: string,
): ExplicitSubagentOrchestrationRequirements | undefined {
  const markerMatch = REQUIRED_SUBAGENT_PLAN_MARKER_RE.exec(messageText);
  if (!markerMatch) return undefined;

  const section = messageText.slice(markerMatch.index + markerMatch[0].length);
  const steps: ExplicitSubagentOrchestrationRequirementStep[] = [];
  const seen = new Set<string>();
  const itemMatches = section.matchAll(
    /(\d+)[\).:]\s*(?:`([^`]+)`|([A-Za-z0-9_-]+))\s*:\s*([\s\S]*?)(?=(?:\s+\d+[\).:]\s*(?:`[^`]+`|[A-Za-z0-9_-]+)\s*:)|$)/g,
  );
  for (const match of itemMatches) {
    const normalizedName = sanitizePlannerStepName(
      match[2] ?? match[3] ?? "",
    );
    if (normalizedName.length === 0 || seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    steps.push({
      name: normalizedName,
      description: normalizeExplicitRequirementDescription(match[4] ?? ""),
    });
  }

  if (steps.length < 2) {
    const stepNames: string[] = [];
    REQUIRED_SUBAGENT_STEP_NAME_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REQUIRED_SUBAGENT_STEP_NAME_RE.exec(section)) !== null) {
      const normalizedName = sanitizePlannerStepName(
        match[2] ?? match[3] ?? "",
      );
      if (normalizedName.length === 0 || seen.has(normalizedName)) continue;
      seen.add(normalizedName);
      stepNames.push(normalizedName);
    }
    if (stepNames.length < 2) return undefined;
    return {
      steps: stepNames.map((name) => ({ name, description: "" })),
      stepNames,
      requiresSynthesis: REQUIRED_DELIVERABLE_CUE_RE.test(messageText),
    };
  }

  return {
    steps,
    stepNames: steps.map((step) => step.name),
    requiresSynthesis: REQUIRED_DELIVERABLE_CUE_RE.test(messageText),
  };
}

function normalizeExplicitRequirementDescription(description: string): string {
  return description
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .trim();
}

function normalizePlannerVerificationCategories(
  categories: readonly PlannerVerificationRequirementCategory[],
): readonly PlannerVerificationRequirementCategory[] {
  const remaining = new Set(categories);
  return PLANNER_VERIFICATION_CATEGORY_ORDER.filter((category) =>
    remaining.has(category)
  );
}

function collectPlannerVerificationDirectiveSegments(
  messageText: string,
): readonly string[] {
  const lineSegments = messageText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        REQUEST_VERIFICATION_DIRECTIVE_RE.test(line),
    );
  if (lineSegments.length > 0) {
    return lineSegments;
  }

  const sentenceSegments =
    messageText.match(
      /(?:^|[\n.?!])\s*[^.\n?!]*(?:verify|verification|validated?|before\s+finish(?:ing)?|before\s+returning|before\s+completion|browser-grounded checks?)[^.\n?!]*/gi,
    ) ?? [];
  return sentenceSegments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

interface PlannerSectionedLine {
  readonly section: string | null;
  readonly line: string;
}

function collectPlannerSectionedLines(
  messageText: string,
): readonly PlannerSectionedLine[] {
  const lines = messageText.split(/\r?\n/);
  const sectioned: PlannerSectionedLine[] = [];
  let currentSection: string | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    const headingMatch = PLANNER_SECTION_HEADING_RE.exec(trimmed);
    if (headingMatch) {
      currentSection = (headingMatch[1] ?? "").trim().toLowerCase();
      continue;
    }
    sectioned.push({ section: currentSection, line: trimmed });
  }

  return sectioned;
}

function narrowPlannerVerificationDirectiveSegment(segment: string): string {
  const leadingVerificationCue =
    /\b(?:verify|verification|validated?|validation|validate)\b/i.exec(
      segment,
    );
  if (!leadingVerificationCue) {
    return segment;
  }
  return segment.slice(leadingVerificationCue.index).trim();
}

export function extractPlannerVerificationRequirements(
  messageText: string,
): readonly PlannerVerificationRequirementCategory[] {
  const segments = collectPlannerVerificationDirectiveSegments(messageText);
  if (segments.length === 0) return [];

  const categories = new Set<PlannerVerificationRequirementCategory>();
  for (const segment of segments) {
    const narrowedSegment = narrowPlannerVerificationDirectiveSegment(segment);
    if (REQUEST_INSTALL_VERIFICATION_RE.test(narrowedSegment)) {
      categories.add("install");
    }
    if (REQUEST_BUILD_VERIFICATION_RE.test(narrowedSegment)) {
      categories.add("build");
    }
    if (REQUEST_TEST_VERIFICATION_RE.test(narrowedSegment)) {
      categories.add("test");
    }
    if (REQUEST_BROWSER_VERIFICATION_RE.test(narrowedSegment)) {
      categories.add("browser");
    }
  }

  return normalizePlannerVerificationCategories([...categories]);
}

function isPlannerCommandSnippet(snippet: string): boolean {
  const trimmed = snippet.trim();
  if (trimmed.length === 0 || !/\s/.test(trimmed)) {
    return false;
  }
  const firstToken = trimmed.split(/\s+/, 1)[0] ?? "";
  return /^[./A-Za-z0-9_-]+(?:[\\/][A-Za-z0-9._-]+)*$/.test(firstToken);
}

function extractPlannerBacktickedCommandSnippets(
  line: string,
): readonly string[] {
  const snippets: string[] = [];
  for (const match of line.matchAll(/`([^`\r\n]+)`/g)) {
    const candidate = (match[1] ?? "").trim();
    if (isPlannerCommandSnippet(candidate)) {
      snippets.push(candidate);
    }
  }
  return snippets;
}

function normalizePlannerVerificationCommandKey(value: string): string {
  return value
    .replace(/[`"'“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderPlannerVerificationCommandSummary(
  commands: readonly string[],
): string {
  return commands.map((command) => `\`${command}\``).join(" | ");
}

export function extractPlannerVerificationCommandRequirements(
  messageText: string,
): readonly string[] {
  const requirements: string[] = [];
  const seen = new Set<string>();

  for (const { section, line } of collectPlannerSectionedLines(messageText)) {
    const lowerSection = section?.toLowerCase() ?? null;
    const isAcceptanceLine = lowerSection === "acceptance criteria";
    const isPositiveVerificationLine =
      isAcceptanceLine ||
      REQUEST_VERIFICATION_DIRECTIVE_RE.test(line) ||
      POSITIVE_VERIFICATION_OUTCOME_RE.test(line);
    if (!isPositiveVerificationLine) continue;
    if (/\b(?:do\s+not|don't|never|avoid|without)\b/i.test(line)) continue;

    for (const command of extractPlannerBacktickedCommandSnippets(line)) {
      if (seen.has(command)) continue;
      seen.add(command);
      requirements.push(command);
    }
  }

  return requirements;
}

export function extractExplicitDeterministicToolRequirements(
  messageText: string,
  allowedToolNames: readonly string[],
): ExplicitDeterministicToolRequirements | undefined {
  const orderedToolNames = extractExplicitImperativeToolNames(
    messageText,
    allowedToolNames,
  );
  if (orderedToolNames.length === 0) return undefined;
  const minimumToolCallsByName = Object.fromEntries(
    orderedToolNames.map((toolName) => [
      toolName,
      extractExplicitToolInvocationCount(
        messageText,
        toolName,
        orderedToolNames,
      ),
    ]),
  );
  return {
    orderedToolNames,
    minimumToolCallsByName,
    forcePlanner: Object.values(minimumToolCallsByName).some(
      (count) => count > 1,
    ),
    exactResponseLiteral: extractExactResponseLiteral(messageText),
  };
}

const EXACT_RESPONSE_LITERAL_DIRECTIVE_RE =
  /\b(?:return|reply|respond|output|answer)(?:\s+with)?\s+exactly(?:\s+as)?\s+/i;
const GENERIC_EXACT_LITERAL_RE =
  /^(?:the\s+)?(?:child\s+answer|answer|result|memorized\s+token|memorised\s+token|token)$/i;
const TOOL_INVOCATION_WORD_COUNTS = new Map<string, number>([
  ["once", 1],
  ["twice", 2],
  ["thrice", 3],
]);

function extractExplicitToolInvocationCount(
  messageText: string,
  toolName: string,
  orderedToolNames: readonly string[],
): number {
  const segment = extractExplicitToolDirectiveSegment(
    messageText,
    toolName,
    orderedToolNames,
  );
  const numericMatch =
    /\bexactly\s+(\d+)\s+times?\b/i.exec(segment) ??
    /\b(\d+)\s+times?\b/i.exec(segment);
  if (numericMatch) {
    return Math.max(1, Number(numericMatch[1] ?? "1"));
  }

  const wordMatch = /\b(once|twice|thrice)\b/i.exec(segment);
  if (wordMatch) {
    return TOOL_INVOCATION_WORD_COUNTS.get(
      (wordMatch[1] ?? "").toLowerCase(),
    ) ?? 1;
  }

  const bulletCount = countStructuredDirectiveBullets(segment);
  return Math.max(1, bulletCount);
}

function extractExplicitToolDirectiveSegment(
  messageText: string,
  toolName: string,
  orderedToolNames: readonly string[],
): string {
  const invocationRe = buildImperativeToolReferenceRegex(toolName, "i");
  const invocationMatch = invocationRe.exec(messageText);
  if (!invocationMatch) {
    return messageText;
  }

  const start = invocationMatch.index;
  let end = messageText.length;

  const relativeAfterToolCallsMatch = /\bafter the tool calls\b/i.exec(
    messageText.slice(start),
  );
  if (relativeAfterToolCallsMatch) {
    end = Math.min(end, start + relativeAfterToolCallsMatch.index);
  }

  for (const otherToolName of orderedToolNames) {
    if (otherToolName === toolName) continue;
    const otherInvocationRe = buildImperativeToolReferenceRegex(
      otherToolName,
      "ig",
    );
    let otherMatch: RegExpExecArray | null;
    while ((otherMatch = otherInvocationRe.exec(messageText)) !== null) {
      if (otherMatch.index > start) {
        end = Math.min(end, otherMatch.index);
        break;
      }
    }
  }

  return messageText.slice(start, end);
}

function countStructuredDirectiveBullets(segment: string): number {
  const lines = segment
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const bulletLines = lines.filter((line) => /^[-*]\s+/.test(line));
  return bulletLines.length >= 2 ? bulletLines.length : 0;
}

function extractExactResponseLiteral(messageText: string): string | undefined {
  const directiveMatch = EXACT_RESPONSE_LITERAL_DIRECTIVE_RE.exec(messageText);
  if (!directiveMatch) {
    return extractExactAliasLiteral(messageText);
  }

  const remainder = messageText
    .slice(directiveMatch.index + directiveMatch[0].length)
    .trim();
  if (!remainder) {
    return extractExactAliasLiteral(messageText);
  }

  const normalized = normalizeExactLiteralCandidate(remainder);
  if (normalized && !GENERIC_EXACT_LITERAL_RE.test(normalized)) {
    return normalized;
  }

  return extractExactAliasLiteral(messageText);
}

function extractExactAliasLiteral(messageText: string): string | undefined {
  const aliasMatch =
    /\b(?:return|reply|respond|output|answer)\b[\s\S]{0,160}?\bas\s+("[^"]+"|'[^']+'|`[^`]+`|[^\n]+?)(?:[.!?](?:\s|$)|$)/i.exec(
      messageText,
    );
  if (!aliasMatch) {
    return undefined;
  }
  return normalizeExactLiteralCandidate(aliasMatch[1] ?? "");
}

function normalizeExactLiteralCandidate(candidate: string): string | undefined {
  const trimmedCandidate = candidate.trim();
  if (trimmedCandidate.length === 0) {
    return undefined;
  }

  const openingQuote = trimmedCandidate[0];
  const quotePairs = new Map<string, string>([
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
  ]);
  const closingQuote = quotePairs.get(openingQuote);
  if (closingQuote) {
    const closingIndex = trimmedCandidate.indexOf(closingQuote, 1);
    if (closingIndex > 1) {
      const quoted = trimmedCandidate.slice(1, closingIndex).trim();
      if (quoted.length > 0 && !GENERIC_EXACT_LITERAL_RE.test(quoted)) {
        return quoted;
      }
    }
    return undefined;
  }

  const unquoted = trimmedCandidate
    .replace(/\s+/g, " ")
    .replace(
      /\s+(?:and|with)\s+(?:nothing\s+else|no\s+extra\s+(?:text|words)|no\s+other\s+text)\b[\s\S]*$/i,
      "",
    )
    .replace(/[.!?]+$/, "")
    .trim();
  if (unquoted.length > 0 && !GENERIC_EXACT_LITERAL_RE.test(unquoted)) {
    return unquoted;
  }

  return undefined;
}

// ============================================================================
// Planner execution context
// ============================================================================

export function buildPlannerExecutionContext(
  messageText: string,
  history: readonly LLMMessage[],
  messages: readonly LLMMessage[],
  sections: readonly PromptBudgetSection[],
  parentAllowedTools?: readonly string[],
): PipelinePlannerContext {
  const normalizedHist = normalizeHistory(history);
  const historySlice = normalizedHist
    .slice(-MAX_PLANNER_CONTEXT_HISTORY_CANDIDATES)
    .map((entry) => ({
      role: entry.role,
      content: truncateText(
        extractLLMMessageText(entry),
        MAX_PLANNER_CONTEXT_HISTORY_CHARS,
      ),
      ...(entry.role === "tool" && entry.toolName
        ? { toolName: entry.toolName }
        : {}),
    }))
    .filter((entry) => entry.content.trim().length > 0);

  const memory: Array<{
    source: PipelinePlannerContextMemorySource;
    content: string;
  }> = [];
  const bySection = (
    section: PromptBudgetSection,
  ): PipelinePlannerContextMemorySource | null => {
    if (section === "memory_semantic") return "memory_semantic";
    if (section === "memory_episodic") return "memory_episodic";
    if (section === "memory_working") return "memory_working";
    return null;
  };
  for (let i = 0; i < messages.length; i++) {
    const source = bySection(sections[i] ?? "history");
    if (!source) continue;
    const message = messages[i];
    if (!message || message.role !== "system") continue;
    const content = truncateText(
      extractLLMMessageText(message),
      MAX_PLANNER_CONTEXT_MEMORY_CHARS,
    );
    if (content.trim().length === 0) continue;
    memory.push({ source, content });
  }

  const toolOutputs = normalizedHist
    .filter((entry) => entry.role === "tool")
    .map((entry) => ({
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      content: truncateText(
        extractLLMMessageText(entry),
        MAX_PLANNER_CONTEXT_TOOL_OUTPUT_CHARS,
      ),
    }))
    .filter((entry) => entry.content.trim().length > 0);

  return {
    parentRequest: truncateText(
      messageText,
      MAX_USER_MESSAGE_CHARS,
    ),
    history: historySlice,
    memory,
    toolOutputs,
    ...(parentAllowedTools && parentAllowedTools.length > 0
      ? { parentAllowedTools: [...new Set(parentAllowedTools)] }
      : {}),
  };
}

// ============================================================================
// Planner plan parsing
// ============================================================================

interface ExplicitSubagentStepDefaults {
  readonly objective: string;
  readonly inputContract: string;
  readonly acceptanceCriteria: readonly string[];
  readonly requiredToolCapabilities: readonly string[];
  readonly contextRequirements: readonly string[];
  readonly maxBudgetHint: string;
  readonly canRunParallel: boolean;
}

const DETERMINISTIC_TOOL_STEP_RESERVED_FIELDS = new Set([
  "name",
  "step_type",
  "depends_on",
  "tool",
  "args",
  "onError",
  "maxRetries",
]);

function deriveExplicitSubagentStepDefaults(input: {
  stepName: string;
  description: string;
  dependsOn: readonly string[];
}): ExplicitSubagentStepDefaults {
  const normalizedDescription = normalizeExplicitRequirementDescription(
    input.description,
  );
  const bulletCriteria = normalizedDescription
    .split(/\s+-\s+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 4);
  const lowerName = input.stepName.toLowerCase();
  const lowerDescription = normalizedDescription.toLowerCase();

  const objective =
    normalizedDescription.length > 0
      ? normalizedDescription
      : `Complete the ${input.stepName} phase.`;

  const inputContract = lowerName.includes("design")
    ? "Return markdown with 3 cited references, extracted mechanics, tuning targets, and key decisions"
    : lowerName.includes("tech")
      ? "Return markdown with implementation comparison, selected stack, project structure, and performance constraints"
      : lowerName.includes("qa") || lowerDescription.includes("validate")
        ? "Return JSON with build/test/browser validation evidence and any remaining issues"
        : lowerName.includes("docs") || lowerDescription.includes("docs")
          ? "Return markdown with architecture summary, how to play, commands used, limitations, and next improvements"
          : "Return JSON with implemented scope, touched files, and verification evidence";

  const defaultAcceptanceCriteria: string[] = [];
  if (lowerName.includes("design")) {
    defaultAcceptanceCriteria.push(
      "Exactly 3 references with valid URLs",
      "Extract concrete mechanic ideas",
      "Propose concise tuning targets",
    );
  } else if (lowerName.includes("tech")) {
    defaultAcceptanceCriteria.push(
      "Compare Canvas API, Phaser, and PixiJS with official docs URLs",
      "Pick one implementation approach with rationale",
      "Define project structure and performance constraints",
    );
  } else if (
    lowerName.includes("core") ||
    lowerName.includes("ai") ||
    lowerDescription.includes("implement")
  ) {
    defaultAcceptanceCriteria.push(
      "Name the files created or modified",
      "Describe implemented gameplay behavior",
      "Include verification evidence from commands or browser checks",
    );
  } else if (lowerName.includes("qa") || lowerDescription.includes("validate")) {
    defaultAcceptanceCriteria.push(
      "Include build or test command evidence",
      "Include browser validation evidence with a concrete URL or tab target",
      "List any remaining issues or confirm none remain",
    );
  } else if (lowerName.includes("docs") || lowerDescription.includes("docs")) {
    defaultAcceptanceCriteria.push(
      "Summarize architecture",
      "Explain how to play or operate the result",
      "List known limitations and next improvements",
    );
  }

  const acceptanceCriteria = [
    ...new Set([
      ...bulletCriteria,
      ...defaultAcceptanceCriteria,
      ...(bulletCriteria.length === 0 && defaultAcceptanceCriteria.length === 0
        ? [`Complete the ${input.stepName} phase and return evidence`]
        : []),
    ]),
  ];

  const requiredToolCapabilities = new Set<string>(["desktop.bash"]);
  if (
    lowerName.includes("design") ||
    lowerName.includes("tech") ||
    lowerDescription.includes("primary sources") ||
    lowerDescription.includes("framework")
  ) {
    requiredToolCapabilities.add("system.browse");
  }
  if (
    lowerName.includes("design") ||
    lowerName.includes("tech") ||
    lowerDescription.includes("primary sources") ||
    lowerDescription.includes("browser") ||
    lowerDescription.includes("chromium") ||
    lowerDescription.includes("framework")
  ) {
    requiredToolCapabilities.add("mcp.browser.browser_navigate");
    requiredToolCapabilities.add("mcp.browser.browser_snapshot");
  }
  if (
    lowerName.includes("core") ||
    lowerName.includes("ai") ||
    lowerDescription.includes("implement") ||
    lowerDescription.includes("scaffold") ||
    lowerDescription.includes("file")
  ) {
    requiredToolCapabilities.add("desktop.text_editor");
  }
  if (
    lowerName.includes("qa") ||
    lowerDescription.includes("validate") ||
    lowerDescription.includes("chromium")
  ) {
    requiredToolCapabilities.add("mcp.browser.browser_navigate");
    requiredToolCapabilities.add("mcp.browser.browser_snapshot");
    requiredToolCapabilities.add("mcp.browser.browser_run_code");
  }

  const contextRequirements = [
    "repo_context",
    ...input.dependsOn.map((dependency) => sanitizePlannerStepName(dependency)),
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);

  let maxBudgetHint = "4m";
  if (lowerName.includes("design") || lowerName.includes("tech")) {
    maxBudgetHint = "3m";
  } else if (
    lowerName.includes("core") ||
    lowerName.includes("ai") ||
    lowerDescription.includes("implement")
  ) {
    maxBudgetHint = "8m";
  } else if (lowerName.includes("qa") || lowerDescription.includes("validate")) {
    maxBudgetHint = "6m";
  } else if (lowerName.includes("docs") || lowerDescription.includes("docs")) {
    maxBudgetHint = "4m";
  }

  return {
    objective,
    inputContract,
    acceptanceCriteria,
    requiredToolCapabilities: [...requiredToolCapabilities],
    contextRequirements,
    maxBudgetHint,
    canRunParallel: false,
  };
}

function getExplicitSubagentStepDefaults(
  requirements: ExplicitSubagentOrchestrationRequirements | undefined,
  stepName: string,
  dependsOn: readonly string[],
): ExplicitSubagentStepDefaults | undefined {
  const requirement = requirements?.steps.find(
    (candidate) => candidate.name === stepName,
  );
  if (!requirement) return undefined;
  return deriveExplicitSubagentStepDefaults({
    stepName,
    description: requirement.description,
    dependsOn,
  });
}

function normalizeExplicitRequiredToolCapabilities(
  parsed: readonly string[] | undefined,
  defaults: readonly string[] | undefined,
): readonly string[] | undefined {
  const normalizedParsed = [
    ...new Set(
      (parsed ?? [])
        .map((capability) => capability.trim())
        .filter((capability) => capability.length > 0),
    ),
  ];
  if (normalizedParsed.length > 0) {
    return normalizedParsed;
  }
  const normalizedDefaults = [
    ...new Set(
      (defaults ?? [])
        .map((capability) => capability.trim())
        .filter((capability) => capability.length > 0),
    ),
  ];
  return normalizedDefaults.length > 0 ? normalizedDefaults : undefined;
}

function mergeExplicitContextRequirements(
  parsed: readonly string[] | undefined,
  defaults: readonly string[] | undefined,
): readonly string[] | undefined {
  const merged = [
    ...new Set([
      ...(parsed ?? []),
      ...(defaults ?? []),
    ]),
  ];
  return merged.length > 0 ? merged : undefined;
}

function buildDefaultPlannerContextRequirements(
  dependsOn: readonly string[],
): readonly string[] {
  return [
    ...new Set([
      "repo_context",
      ...dependsOn.map((dependency) => sanitizePlannerStepName(dependency)),
    ]),
  ].filter((value) => value.length > 0);
}

function normalizePlannerSubagentBudgetHint(params: {
  readonly stepName: string;
  readonly maxBudgetHint: string;
  readonly diagnostics: PlannerDiagnostic[];
}): string {
  const inspection = inspectDelegationBudgetHint(params.maxBudgetHint);
  if (
    inspection.kind === "explicit" &&
    inspection.durationMs < MIN_DELEGATION_TIMEOUT_MS
  ) {
    const repairedHint = `${Math.ceil(MIN_DELEGATION_TIMEOUT_MS / 1000)}s`;
    params.diagnostics.push(
      createPlannerDiagnostic(
        "policy",
        "planner_subagent_budget_hint_clamped",
        `Planner subagent step "${params.stepName}" used a max_budget_hint below the runtime minimum; clamping to ${repairedHint}`,
        {
          stepName: params.stepName,
          originalMaxBudgetHint: params.maxBudgetHint,
          repairedMaxBudgetHint: repairedHint,
          minimumSeconds: Math.floor(MIN_DELEGATION_TIMEOUT_MS / 1000),
        },
      ),
    );
    return repairedHint;
  }
  return params.maxBudgetHint;
}

function normalizeDeterministicPlannerToolArgs(params: {
  readonly step: Record<string, unknown>;
  readonly stepIndex: number;
  readonly stepName: string;
  readonly toolName: string;
  readonly diagnostics: PlannerDiagnostic[];
}): Record<string, unknown> | undefined {
  const { step, stepIndex, stepName, toolName, diagnostics } = params;
  if (
    step.args !== undefined &&
    (
      typeof step.args !== "object" ||
      step.args === null ||
      Array.isArray(step.args)
    )
  ) {
    diagnostics.push(
      createPlannerDiagnostic(
        "parse",
        "invalid_tool_args",
        `Planner step "${stepName}" has invalid args; expected JSON object`,
        { stepIndex, stepName, field: "args" },
      ),
    );
    return undefined;
  }

  const rawArgs =
    typeof step.args === "object" &&
    step.args !== null &&
    !Array.isArray(step.args)
      ? (step.args as Record<string, unknown>)
      : {};
  let args = rawArgs;
  const promotedFields: string[] = [];

  for (const [field, value] of Object.entries(step)) {
    if (DETERMINISTIC_TOOL_STEP_RESERVED_FIELDS.has(field)) continue;
    if (value === undefined) continue;

    if (Object.prototype.hasOwnProperty.call(args, field)) {
      if (safeStringify(args[field]) !== safeStringify(value)) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "planner_tool_root_arg_conflict",
            `Planner deterministic step "${stepName}" has conflicting "${field}" values at the step root and inside args`,
            { stepIndex, stepName, field },
          ),
        );
        return undefined;
      }
      continue;
    }

    if (args === rawArgs) {
      args = { ...rawArgs };
    }
    args[field] = value;
    promotedFields.push(field);
  }

  if (promotedFields.length > 0) {
    diagnostics.push(
      createPlannerDiagnostic(
        "parse",
        "planner_tool_root_args_promoted",
        `Planner deterministic step "${stepName}" placed tool parameters at the step root; promoting them into args`,
        {
          stepIndex,
          stepName,
          promotedFields: promotedFields.join(","),
        },
      ),
    );
  }

  if (PLANNER_BASH_TOOL_NAMES.has(toolName)) {
    const command =
      typeof args.command === "string" ? args.command.trim() : "";
    const parsedArgs = parsePlannerStringArgs(args.args);
    if (command.length > 0 && parsedArgs && parsedArgs.length > 0) {
      const shellTokens = collectDirectModeShellControlTokens(parsedArgs);
      if (shellTokens.length > 0) {
        const { args: _ignoredArgs, ...shellModeArgs } = args;
        args = {
          ...shellModeArgs,
          command: [
            quotePlannerShellWord(command),
            ...parsedArgs.map((token) =>
              normalizePlannerShellModeToken(token)
            ),
          ].join(" "),
        };
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "planner_bash_direct_args_normalized_to_shell_mode",
            `Planner bash step "${stepName}" embedded shell-only control tokens in direct-mode args; normalizing to shell mode`,
            {
              stepIndex,
              stepName,
              tool: toolName,
              shellTokens: shellTokens.join(","),
            },
          ),
        );
      }
    }
  }

  return args;
}

function quotePlannerShellWord(token: string): string {
  if (token.length === 0) return "''";
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(token)) {
    return token;
  }
  return `'${token.replace(/'/g, `'\"'\"'`)}'`;
}

function normalizePlannerShellModeToken(token: string): string {
  if (token === "(" || token === ")" || token === "$" || token === "`") {
    return `\\${token}`;
  }
  return collectDirectModeShellControlTokens([token]).length > 0
    ? token
    : quotePlannerShellWord(token);
}

export function parsePlannerPlan(
  content: string,
  repairRequirements?: ExplicitSubagentOrchestrationRequirements,
): PlannerParseResult {
  const diagnostics: PlannerDiagnostic[] = [];
  const parsed = parseJsonObjectFromText(content);
  if (!parsed) {
    diagnostics.push(
      createPlannerDiagnostic(
        "parse",
        "invalid_json",
        "Planner output is not parseable JSON object",
      ),
    );
    return { diagnostics };
  }
  if (!Array.isArray(parsed.steps)) {
    diagnostics.push(
      createPlannerDiagnostic(
        "parse",
        "missing_steps_array",
        'Planner output must include a "steps" array',
      ),
    );
    return { diagnostics };
  }

  const steps: PlannerStepIntent[] = [];
  const unresolvedDependencies = new Map<string, readonly string[]>();
  const nameAliases = new Map<string, string>();
  const usedStepNames = new Set<string>();
  const maxSteps = Math.min(MAX_PLANNER_STEPS, parsed.steps.length);

  for (const [index, rawStep] of parsed.steps.slice(0, maxSteps).entries()) {
    if (
      typeof rawStep !== "object" ||
      rawStep === null ||
      Array.isArray(rawStep)
    ) {
      diagnostics.push(
        createPlannerDiagnostic(
          "parse",
          "invalid_step_object",
          `Planner step at index ${index} must be an object`,
          { stepIndex: index },
        ),
      );
      return { diagnostics };
    }
    const step = rawStep as Record<string, unknown>;
    const stepType = parsePlannerStepType(step.step_type);
    if (!stepType) {
      diagnostics.push(
        createPlannerDiagnostic(
          "parse",
          "invalid_step_type",
          `Planner step at index ${index} has invalid step_type`,
          { stepIndex: index },
        ),
      );
      return { diagnostics };
    }

    const rawName =
      typeof step.name === "string" ? step.name.trim() : "";
    const sanitizedName = sanitizePlannerStepName(
      rawName.length > 0 ? rawName : `step_${steps.length + 1}`,
    );
    const safeName = dedupePlannerStepName(
      sanitizedName,
      usedStepNames,
    );
    usedStepNames.add(safeName);

    if (rawName.length > 0) {
      if (nameAliases.has(rawName)) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "duplicate_step_name",
            `Planner step name "${rawName}" is duplicated`,
            { stepIndex: index, stepName: rawName },
          ),
        );
        return { diagnostics };
      }
      nameAliases.set(rawName, safeName);
    }
    nameAliases.set(safeName, safeName);

    const dependsOn = parsePlannerDependsOn(step.depends_on);
    if (!dependsOn) {
      diagnostics.push(
        createPlannerDiagnostic(
          "parse",
          "invalid_depends_on",
          `Planner step "${safeName}" has invalid depends_on`,
          { stepIndex: index, stepName: safeName },
        ),
      );
      return { diagnostics };
    }
    unresolvedDependencies.set(safeName, dependsOn);

    if (stepType === "deterministic_tool") {
      if (typeof step.tool !== "string" || step.tool.trim().length === 0) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "missing_tool_name",
            `Deterministic planner step "${safeName}" must include a non-empty tool name`,
            { stepIndex: index, stepName: safeName },
          ),
        );
        return { diagnostics };
      }
      const args = normalizeDeterministicPlannerToolArgs({
        step,
        stepIndex: index,
        stepName: safeName,
        toolName: step.tool.trim(),
        diagnostics,
      });
      if (!args) {
        return { diagnostics };
      }
      const onError =
        step.onError === "retry" ||
        step.onError === "skip" ||
        step.onError === "abort"
          ? step.onError
          : undefined;
      const maxRetries =
        typeof step.maxRetries === "number" && Number.isFinite(step.maxRetries)
          ? Math.max(0, Math.min(5, Math.floor(step.maxRetries)))
          : undefined;
      steps.push({
        name: safeName,
        stepType,
        tool: step.tool.trim(),
        args,
        onError,
        maxRetries,
      });
      continue;
    }

    if (stepType === "subagent_task") {
      const explicitDefaults = getExplicitSubagentStepDefaults(
        repairRequirements,
        safeName,
        dependsOn,
      );
      const subagentArgs = parsePlannerArgsRecord(step.args);
      const objective =
        parsePlannerRequiredString(step.objective) ??
        parsePlannerStringFromKeys(subagentArgs, ["objective", "task"]) ??
        explicitDefaults?.objective;
      const inputContract =
        parsePlannerRequiredString(step.input_contract) ??
        parsePlannerStringFromKeys(subagentArgs, [
          "input_contract",
          "inputContract",
        ]) ??
        explicitDefaults?.inputContract;
      const acceptanceCriteria =
        parsePlannerStringArray(step.acceptance_criteria) ??
        parsePlannerStringArrayFromKeys(subagentArgs, [
          "acceptance_criteria",
          "acceptanceCriteria",
        ]) ??
        explicitDefaults?.acceptanceCriteria;
      const plannerRequiredToolCapabilities =
        parsePlannerStringArray(step.required_tool_capabilities) ??
        parsePlannerStringArrayFromKeys(subagentArgs, [
          "required_tool_capabilities",
          "requiredToolCapabilities",
          "requiredCapabilities",
        ]);
      const requiredToolCapabilities =
        normalizeExplicitRequiredToolCapabilities(
          plannerRequiredToolCapabilities,
          explicitDefaults?.requiredToolCapabilities,
        ) ??
        plannerRequiredToolCapabilities;
      const plannerContextRequirements =
        parsePlannerStringArray(step.context_requirements) ??
        parsePlannerStringArrayFromKeys(subagentArgs, [
          "context_requirements",
          "contextRequirements",
        ]);
      const contextRequirements =
        mergeExplicitContextRequirements(
          plannerContextRequirements,
          explicitDefaults?.contextRequirements,
        ) ??
        plannerContextRequirements ??
        buildDefaultPlannerContextRequirements(dependsOn);
      const maxBudgetHint =
        parsePlannerRequiredString(step.max_budget_hint) ??
        parsePlannerStringFromKeys(subagentArgs, ["max_budget_hint"]) ??
        explicitDefaults?.maxBudgetHint;
      if (
        step.can_run_parallel !== undefined &&
        typeof step.can_run_parallel !== "boolean"
      ) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "invalid_subagent_field_type",
            `Planner subagent step "${safeName}" has invalid can_run_parallel`,
            {
              stepIndex: index,
              stepName: safeName,
              field: "can_run_parallel",
            },
          ),
        );
        return { diagnostics };
      }
      const canRunParallel =
        typeof step.can_run_parallel === "boolean"
          ? step.can_run_parallel
          : explicitDefaults?.canRunParallel ?? false;
      if (!objective) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "missing_subagent_field",
            `Planner subagent step "${safeName}" is missing objective`,
            { stepIndex: index, stepName: safeName, field: "objective" },
          ),
        );
        return { diagnostics };
      }
      if (!inputContract) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "missing_subagent_field",
            `Planner subagent step "${safeName}" is missing input_contract`,
            { stepIndex: index, stepName: safeName, field: "input_contract" },
          ),
        );
        return { diagnostics };
      }
      if (!acceptanceCriteria || acceptanceCriteria.length === 0) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "missing_subagent_field",
            `Planner subagent step "${safeName}" is missing acceptance_criteria`,
            {
              stepIndex: index,
              stepName: safeName,
              field: "acceptance_criteria",
            },
          ),
        );
        return { diagnostics };
      }
      if (!requiredToolCapabilities || requiredToolCapabilities.length === 0) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "missing_subagent_field",
            `Planner subagent step "${safeName}" is missing required_tool_capabilities`,
            {
              stepIndex: index,
              stepName: safeName,
              field: "required_tool_capabilities",
            },
          ),
        );
        return { diagnostics };
      }
      if (!contextRequirements || contextRequirements.length === 0) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "missing_subagent_field",
            `Planner subagent step "${safeName}" is missing context_requirements`,
            {
              stepIndex: index,
              stepName: safeName,
              field: "context_requirements",
            },
          ),
        );
        return { diagnostics };
      }
      if (!maxBudgetHint) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "missing_subagent_field",
            `Planner subagent step "${safeName}" is missing max_budget_hint`,
            {
              stepIndex: index,
              stepName: safeName,
              field: "max_budget_hint",
            },
          ),
        );
        return { diagnostics };
      }
      const normalizedBudgetHint = normalizePlannerSubagentBudgetHint({
        stepName: safeName,
        maxBudgetHint,
        diagnostics,
      });

      steps.push({
        name: safeName,
        stepType,
        objective,
        inputContract,
        acceptanceCriteria,
        requiredToolCapabilities,
        contextRequirements,
        maxBudgetHint: normalizedBudgetHint,
        canRunParallel,
      });
      continue;
    }

    const objective = parsePlannerOptionalString(step.objective);
    steps.push({
      name: safeName,
      stepType,
      ...(objective ? { objective } : {}),
    });
  }

  const knownStepNames = new Set(steps.map((step) => step.name));
  const edges: WorkflowGraphEdge[] = [];
  for (const step of steps) {
    const rawDepends = unresolvedDependencies.get(step.name) ?? [];
    if (rawDepends.length === 0) continue;
    const resolved = new Set<string>();
    for (const dependencyName of rawDepends) {
      const alias = nameAliases.get(dependencyName) ?? dependencyName;
      if (!knownStepNames.has(alias)) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "unknown_dependency",
            `Planner step "${step.name}" depends on unknown step "${dependencyName}"`,
            { stepName: step.name, dependencyName },
          ),
        );
        return { diagnostics };
      }
      if (alias === step.name) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "self_dependency",
            `Planner step "${step.name}" cannot depend on itself`,
            { stepName: step.name },
          ),
        );
        return { diagnostics };
      }
      if (resolved.has(alias)) continue;
      resolved.add(alias);
      edges.push({ from: alias, to: step.name });
    }
    if (resolved.size > 0) {
      step.dependsOn = [...resolved];
    }
  }

  const cyclePath = detectPlannerCycle(
    steps.map((step) => step.name),
    edges,
  );
  if (cyclePath) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "cyclic_dependency",
        "Planner dependency graph contains a cycle",
        {
          cycle: cyclePath.join("->"),
        },
      ),
    );
    return { diagnostics };
  }

  const containsSynthesisStep = steps.some(
    (step) => step.stepType === "synthesis",
  );

  return {
    plan: {
      reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
      confidence: parsePlannerConfidence(parsed.confidence),
      requiresSynthesis:
        typeof parsed.requiresSynthesis === "boolean"
          ? parsed.requiresSynthesis || containsSynthesisStep
          : containsSynthesisStep || undefined,
      steps,
      edges,
    },
    diagnostics,
  };
}

function parsePlannerToolCallArguments(
  rawArguments: string,
): Record<string, unknown> | undefined {
  const parsed = parseJsonObjectFromText(rawArguments);
  if (!parsed || Array.isArray(parsed)) return undefined;
  return parsed as Record<string, unknown>;
}

export function salvagePlannerToolCallsAsPlan(
  toolCalls: readonly LLMToolCall[],
): PlannerParseResult {
  const diagnostics: PlannerDiagnostic[] = [];
  if (toolCalls.length === 0) {
    return { diagnostics };
  }

  const steps: PlannerStepIntent[] = [];
  for (const [index, toolCall] of toolCalls.entries()) {
    const toolName =
      typeof toolCall.name === "string" ? toolCall.name.trim() : "";
    if (toolName.length === 0) {
      diagnostics.push(
        createPlannerDiagnostic(
          "parse",
          "missing_tool_name",
          `Planner tool call at index ${index} is missing a tool name`,
          { stepIndex: index },
        ),
      );
      return { diagnostics };
    }
    const args = parsePlannerToolCallArguments(toolCall.arguments);
    if (!args) {
      diagnostics.push(
        createPlannerDiagnostic(
          "parse",
          "invalid_tool_args",
          `Planner tool call "${toolName}" has invalid arguments; expected a JSON object`,
          { stepIndex: index, toolName },
        ),
      );
      return { diagnostics };
    }
    steps.push({
      name: sanitizePlannerStepName(
        `${toolName.replace(/[^A-Za-z0-9_-]+/g, "_")}_${index + 1}`,
      ),
      stepType: "deterministic_tool",
      tool: toolName,
      args,
      onError: "abort",
    });
  }

  diagnostics.push(
    createPlannerDiagnostic(
      "parse",
      "planner_tool_call_salvaged",
      "Planner emitted direct tool calls instead of JSON; salvaging them as deterministic planner steps",
      {
        toolNames: toolCalls.map((toolCall) => toolCall.name).join(","),
      },
    ),
  );

  return {
    plan: {
      reason: "planner_tool_call_salvaged",
      requiresSynthesis: false,
      confidence: 0.5,
      steps,
      edges: [],
    },
    diagnostics,
  };
}

export function validateSalvagedPlannerToolPlan(input: {
  readonly plannerPlan: PlannerPlan;
  readonly messageText: string;
  readonly history?: readonly LLMMessage[];
  readonly explicitDeterministicRequirements?: ExplicitDeterministicToolRequirements;
}): readonly PlannerDiagnostic[] {
  if (input.plannerPlan.reason !== "planner_tool_call_salvaged") {
    return [];
  }
  if (input.explicitDeterministicRequirements) {
    return [];
  }

  const signals = collectPlannerRequestSignals(
    input.messageText,
    input.history ?? [],
  );
  const minimumExpectedSteps = deriveMinimumExpectedSalvagedSteps(signals);
  const actualSteps = input.plannerPlan.steps.length;
  if (actualSteps >= minimumExpectedSteps) {
    return [];
  }

  const expectedSignals = [
    signals.hasMultiStepCue ? "multi_step_cues" : "",
    signals.hasImplementationScopeCue ? "implementation_scope" : "",
    signals.hasVerificationCue ? "verification" : "",
    signals.hasDocumentationCue ? "documentation" : "",
    signals.longTask ? "long_or_structured_request" : "",
    signals.structuredBulletCount >= 3 ? "structured_bullets" : "",
  ].filter((value) => value.length > 0);

  return [
    createPlannerDiagnostic(
      "validation",
      "salvaged_tool_plan_underdecomposed",
      "Planner salvaged raw tool calls but under-decomposed a structured request",
      {
        actualSteps,
        minimumExpectedSteps,
        structuredBulletCount: signals.structuredBulletCount,
        signals: expectedSignals.join(","),
      },
    ),
  ];
}

// ============================================================================
// Planner graph validation
// ============================================================================

function collectPlannerSubagentStepText(
  step: PlannerSubAgentTaskStepIntent,
): string {
  return [
    step.objective,
    step.inputContract,
    ...step.acceptanceCriteria,
  ]
    .filter((value) => value.trim().length > 0)
    .join(" ");
}

function isNodeWorkspaceSubagentStep(
  step: PlannerSubAgentTaskStepIntent,
): boolean {
  const combined = collectPlannerSubagentStepText(step);
  return NODE_PACKAGE_TOOLING_RE.test(combined) ||
    NODE_PACKAGE_MANIFEST_PATH_RE.test(combined) ||
    NODE_LOCAL_DEPENDENCY_SPEC_RE.test(combined);
}

function stepAuthorsNodeManifestOrConfig(
  step: PlannerSubAgentTaskStepIntent,
): boolean {
  return NODE_MANIFEST_OR_CONFIG_RE.test(
    [step.objective, step.inputContract, ...step.acceptanceCriteria].join(" "),
  );
}

function stepObjectiveOrInputRequiresInstallSensitiveNodeVerification(
  step: PlannerSubAgentTaskStepIntent,
): boolean {
  const actionableFragments = [step.objective, step.inputContract]
    .filter((value) => value.trim().length > 0)
    .filter((value) => !isDefinitionOnlyVerificationText(value));
  const combined = stripNegatedNodeVerificationLanguage(
    actionableFragments.join(" "),
  );
  if (combined.length === 0) return false;
  if (NODE_INSTALL_SENSITIVE_VERIFICATION_PHRASE_RE.test(combined)) {
    return true;
  }
  return NODE_INSTALL_SENSITIVE_VERIFICATION_ACTION_RE.test(combined) &&
    NODE_INSTALL_SENSITIVE_VERIFICATION_TARGET_RE.test(combined);
}

function stepRequiresInstallSensitiveNodeVerification(
  step: PlannerSubAgentTaskStepIntent,
): {
  readonly required: boolean;
  readonly categories: readonly string[];
} {
  const categories = [
    ...new Set(
      step.acceptanceCriteria.flatMap((criterion) =>
        getAcceptanceVerificationCategories(criterion)
      ),
    ),
  ];
  if (categories.length > 0) {
    return { required: true, categories };
  }
  return {
    required:
      stepObjectiveOrInputRequiresInstallSensitiveNodeVerification(step),
    categories: [],
  };
}

function isNodeInstallPlannerStep(
  step: PlannerStepIntent,
): step is PlannerDeterministicToolStepIntent {
  if (step.stepType !== "deterministic_tool") return false;
  if (!PLANNER_BASH_TOOL_NAMES.has(step.tool)) return false;
  const command =
    typeof step.args.command === "string" ? step.args.command.trim() : "";
  if (!NODE_PACKAGE_MANAGER_COMMANDS.has(commandBasename(command))) {
    return false;
  }
  const parsedArgs = parsePlannerStringArgs(step.args.args);
  if (!parsedArgs) return false;
  if (
    commandBasename(command) === "yarn" &&
    parsedArgs.length === 0
  ) {
    return true;
  }
  return parsedArgs.some((entry, index) =>
    index === 0 && NODE_INSTALL_ACTIONS.has(entry.trim().toLowerCase())
  );
}

function collectPlannerStepVerificationCategories(
  step: PlannerStepIntent,
): readonly PlannerVerificationRequirementCategory[] {
  const categories = new Set<PlannerVerificationRequirementCategory>();
  if (step.stepType === "deterministic_tool") {
    if (isNodeInstallPlannerStep(step)) {
      categories.add("install");
    }
    if (PLANNER_BROWSER_VERIFICATION_TOOL_NAMES.has(step.tool)) {
      categories.add("browser");
    }
    if (!PLANNER_BASH_TOOL_NAMES.has(step.tool)) {
      return normalizePlannerVerificationCategories([...categories]);
    }

    const command =
      typeof step.args.command === "string" ? step.args.command : "";
    const parsedArgs = parsePlannerStringArgs(step.args.args) ?? [];
    const combined = [command, ...parsedArgs].join(" ").trim();
    const normalized = stripNegatedNodeVerificationLanguage(combined);

    if (REQUEST_INSTALL_VERIFICATION_RE.test(normalized)) {
      categories.add("install");
    }
    if (REQUEST_BUILD_VERIFICATION_RE.test(normalized)) {
      categories.add("build");
    }
    if (REQUEST_TEST_VERIFICATION_RE.test(normalized)) {
      categories.add("test");
    }
    if (REQUEST_BROWSER_VERIFICATION_RE.test(combined)) {
      categories.add("browser");
    }

    return normalizePlannerVerificationCategories([...categories]);
  }

  if (step.stepType !== "subagent_task") {
    return [];
  }

  const combined = stripNegatedNodeVerificationLanguage(
    [step.objective, step.inputContract, ...step.acceptanceCriteria].join(" "),
  );
  if (REQUEST_INSTALL_VERIFICATION_RE.test(combined)) {
    categories.add("install");
  }
  if (REQUEST_BUILD_VERIFICATION_RE.test(combined)) {
    categories.add("build");
  }
  if (REQUEST_TEST_VERIFICATION_RE.test(combined)) {
    categories.add("test");
  }
  if (
    specRequiresMeaningfulBrowserEvidence({
      task: step.name,
      objective: step.objective,
      inputContract: step.inputContract,
      acceptanceCriteria: step.acceptanceCriteria,
      requiredToolCapabilities: step.requiredToolCapabilities,
      contextRequirements: step.contextRequirements,
    })
  ) {
    categories.add("browser");
  }

  return normalizePlannerVerificationCategories([...categories]);
}

function collectPlannerVerificationCoverage(
  plannerPlan: PlannerPlan,
): ReadonlyMap<PlannerVerificationRequirementCategory, readonly string[]> {
  const coverage = new Map<PlannerVerificationRequirementCategory, string[]>();
  for (const step of plannerPlan.steps) {
    for (const category of collectPlannerStepVerificationCategories(step)) {
      const bucket = coverage.get(category);
      if (bucket) {
        bucket.push(step.name);
      } else {
        coverage.set(category, [step.name]);
      }
    }
  }
  return coverage;
}

function collectPlannerStepVerificationCommandTexts(
  step: PlannerStepIntent,
): readonly string[] {
  if (step.stepType === "deterministic_tool") {
    if (!PLANNER_BASH_TOOL_NAMES.has(step.tool)) return [];
    const command =
      typeof step.args.command === "string" ? step.args.command : "";
    const parsedArgs = parsePlannerStringArgs(step.args.args) ?? [];
    const normalized = normalizePlannerVerificationCommandKey(
      [command, ...parsedArgs].join(" "),
    );
    return normalized.length > 0 ? [normalized] : [];
  }

  if (step.stepType !== "subagent_task") {
    return [];
  }

  const normalized = normalizePlannerVerificationCommandKey(
    [step.objective, step.inputContract, ...step.acceptanceCriteria].join("\n"),
  );
  return normalized.length > 0 ? [normalized] : [];
}

function collectPlannerVerificationCommandCoverage(
  plannerPlan: PlannerPlan,
  requiredCommands: readonly string[],
): ReadonlyMap<string, readonly string[]> {
  const coverage = new Map<string, string[]>();
  const normalizedRequired = requiredCommands
    .map((command) => ({
      raw: command,
      key: normalizePlannerVerificationCommandKey(command),
    }))
    .filter((entry) => entry.key.length > 0);

  for (const step of plannerPlan.steps) {
    const stepTexts = collectPlannerStepVerificationCommandTexts(step);
    if (stepTexts.length === 0) continue;
    for (const requirement of normalizedRequired) {
      if (!stepTexts.some((text) => text.includes(requirement.key))) {
        continue;
      }
      const bucket = coverage.get(requirement.raw);
      if (bucket) {
        bucket.push(step.name);
      } else {
        coverage.set(requirement.raw, [step.name]);
      }
    }
  }

  return coverage;
}

export function validatePlannerVerificationRequirements(
  plannerPlan: PlannerPlan,
  requiredCategories: readonly PlannerVerificationRequirementCategory[],
  requiredCommands: readonly string[] = [],
): readonly PlannerDiagnostic[] {
  const normalizedRequired = normalizePlannerVerificationCategories(
    requiredCategories,
  );
  const normalizedCommands = requiredCommands
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
  if (normalizedRequired.length === 0 && normalizedCommands.length === 0) {
    return [];
  }

  const coverage = collectPlannerVerificationCoverage(plannerPlan);
  const commandCoverage = collectPlannerVerificationCommandCoverage(
    plannerPlan,
    normalizedCommands,
  );
  const missingCategories = normalizedRequired.filter((category) =>
    (coverage.get(category)?.length ?? 0) === 0
  );
  const missingCommands = normalizedCommands.filter((command) =>
    (commandCoverage.get(command)?.length ?? 0) === 0
  );
  if (missingCategories.length === 0 && missingCommands.length === 0) {
    return [];
  }

  const coverageSummary = PLANNER_VERIFICATION_CATEGORY_ORDER
    .filter((category) => normalizedRequired.includes(category))
    .map((category) =>
      `${category}:${(coverage.get(category) ?? []).join("|") || "-"}`
    )
    .join(",");
  const commandCoverageSummary = normalizedCommands
    .map((command) => `${command}:${(commandCoverage.get(command) ?? []).join("|") || "-"}`)
    .join("\n");

  return [
    createPlannerDiagnostic(
      "validation",
      "planner_verification_requirements_missing",
      "Planner omitted one or more user-requested verification requirements before finishing",
      {
        missingCategories: missingCategories.join(","),
        requiredCategories: normalizedRequired.join(","),
        coveredCategories: normalizePlannerVerificationCategories(
          [...coverage.keys()],
        ).join(","),
        coverageSummary,
        missingCommands: missingCommands.join("\n"),
        requiredCommands: normalizedCommands.join("\n"),
        coveredCommands: normalizedCommands
          .filter((command) => (commandCoverage.get(command)?.length ?? 0) > 0)
          .join("\n"),
        commandCoverageSummary,
      },
    ),
  ];
}

function validateNodeWorkspacePlannerStages(
  plannerPlan: PlannerPlan,
): readonly PlannerDiagnostic[] {
  const diagnostics: PlannerDiagnostic[] = [];
  const installSteps = plannerPlan.steps.filter(isNodeInstallPlannerStep);
  if (installSteps.length === 0) return diagnostics;

  const dependencyMap = buildPlannerDependencyMap(plannerPlan);
  const ancestorMemo = new Map<string, ReadonlySet<string>>();
  const indexByName = new Map(
    plannerPlan.steps.map((step, index) => [step.name, index] as const),
  );

  for (const step of plannerPlan.steps) {
    if (step.stepType !== "subagent_task") continue;
    if (!isNodeWorkspaceSubagentStep(step)) continue;

    const verification = stepRequiresInstallSensitiveNodeVerification(step);
    if (!verification.required) continue;

    const stepIndex = indexByName.get(step.name);
    if (stepIndex === undefined) continue;

    const laterInstallSteps = installSteps.filter((installStep) =>
      (indexByName.get(installStep.name) ?? Number.NEGATIVE_INFINITY) > stepIndex
    );
    if (laterInstallSteps.length === 0) continue;

    const ancestors = collectPlannerStepAncestors(
      step.name,
      dependencyMap,
      ancestorMemo,
    );
    if (installSteps.some((installStep) => ancestors.has(installStep.name))) {
      continue;
    }

    const requiresPhaseSplit = stepAuthorsNodeManifestOrConfig(step);
    const verificationModes =
      verification.categories.length > 0
        ? verification.categories.join(",")
        : "runner_or_build_tooling";
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "node_workspace_install_phase_mismatch",
        requiresPhaseSplit
          ? `Planner subagent step "${step.name}" mixes Node workspace manifest/config scaffolding with install-sensitive verification before install`
          : `Planner subagent step "${step.name}" schedules install-sensitive Node verification before the workspace install step`,
        {
          stepName: step.name,
          installSteps: laterInstallSteps.map((installStep) => installStep.name).join(","),
          verificationModes,
          requiresPhaseSplit: requiresPhaseSplit ? "true" : "false",
        },
      ),
    );
  }

  return diagnostics;
}

export function validatePlannerGraph(
  plannerPlan: PlannerPlan,
  config: PlannerGraphValidationConfig,
): readonly PlannerDiagnostic[] {
  const diagnostics: PlannerDiagnostic[] = [];
  const subagentSteps = plannerPlan.steps.filter(
    (step): step is PlannerSubAgentTaskStepIntent =>
      step.stepType === "subagent_task",
  );
  if (subagentSteps.length === 0) return diagnostics;

  if (subagentSteps.length > config.maxSubagentFanout) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "subagent_fanout_exceeded",
        `Planner emitted ${subagentSteps.length} subagent tasks but maxFanoutPerTurn is ${config.maxSubagentFanout}`,
        {
          subagentSteps: subagentSteps.length,
          maxFanoutPerTurn: config.maxSubagentFanout,
        },
      ),
    );
  }

  const subagentStepNames = new Set(subagentSteps.map((step) => step.name));
  const subagentEdges = plannerPlan.edges.filter((edge) =>
    subagentStepNames.has(edge.from) && subagentStepNames.has(edge.to)
  );
  const graphDepth = computePlannerGraphDepth(
    [...subagentStepNames],
    subagentEdges,
  );
  if (graphDepth.cyclic) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "cyclic_dependency",
        "Planner dependency graph contains a cycle",
      ),
    );
    return diagnostics;
  }

  for (const step of subagentSteps) {
    const scopeAssessment = assessDelegationScope({
      objective: step.objective,
      inputContract: step.inputContract,
      acceptanceCriteria: step.acceptanceCriteria,
      requiredToolCapabilities: step.requiredToolCapabilities,
    });
    if (scopeAssessment.ok) continue;
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "subagent_step_needs_decomposition",
        `Planner subagent step "${step.name}" is overloaded: ${scopeAssessment.error}`,
        {
          stepName: step.name,
          phases: scopeAssessment.phases.join(","),
          suggestedSteps:
            scopeAssessment.decomposition?.suggestedSteps
              .map((suggestion) => suggestion.name)
              .join(",") ?? "",
        },
      ),
    );
  }

  diagnostics.push(...validateNodeWorkspacePlannerStages(plannerPlan));

  return diagnostics;
}

export function validateExplicitSubagentOrchestrationRequirements(
  plannerPlan: PlannerPlan,
  requirements: ExplicitSubagentOrchestrationRequirements,
): readonly PlannerDiagnostic[] {
  const diagnostics: PlannerDiagnostic[] = [];
  const stepIndexByName = new Map<string, number>();
  const stepByName = new Map<string, PlannerStepIntent>();

  plannerPlan.steps.forEach((step, index) => {
    const normalizedName = sanitizePlannerStepName(step.name);
    stepIndexByName.set(normalizedName, index);
    stepByName.set(normalizedName, step);
  });

  const missingSteps: string[] = [];
  const wrongTypeSteps: string[] = [];
  const requiredIndexes: number[] = [];

  for (const requiredStepName of requirements.stepNames) {
    const step = stepByName.get(requiredStepName);
    const stepIndex = stepIndexByName.get(requiredStepName);
    if (!step || stepIndex === undefined) {
      missingSteps.push(requiredStepName);
      continue;
    }
    requiredIndexes.push(stepIndex);
    if (step.stepType !== "subagent_task") {
      wrongTypeSteps.push(requiredStepName);
    }
  }

  if (missingSteps.length > 0) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "required_subagent_steps_missing",
        "Planner omitted one or more user-required sub-agent steps",
        {
          missingSteps: missingSteps.join(","),
          requiredSteps: requirements.stepNames.join(","),
        },
      ),
    );
  }

  if (wrongTypeSteps.length > 0) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "required_subagent_step_wrong_type",
        "Planner emitted a required step with a non-subagent type",
        {
          wrongTypeSteps: wrongTypeSteps.join(","),
        },
      ),
    );
  }

  const orderMismatch = requiredIndexes.some(
    (index, position) => position > 0 && index <= requiredIndexes[position - 1]!,
  );
  if (orderMismatch) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "required_subagent_step_order_mismatch",
        "Planner did not preserve the user-required sub-agent step order",
        {
          requiredSteps: requirements.stepNames.join("->"),
        },
      ),
    );
  }

  return diagnostics;
}

export function validateExplicitDeterministicToolRequirements(
  plannerPlan: PlannerPlan,
  requirements: ExplicitDeterministicToolRequirements,
): readonly PlannerDiagnostic[] {
  const diagnostics: PlannerDiagnostic[] = [];
  const allowedToolNames = new Set(requirements.orderedToolNames);
  const deterministicSteps = plannerPlan.steps.filter(
    (step): step is PlannerDeterministicToolStepIntent =>
      step.stepType === "deterministic_tool",
  );
  const subagentSteps = plannerPlan.steps
    .filter((step): step is PlannerSubAgentTaskStepIntent => step.stepType === "subagent_task")
    .map((step) => step.name);

  if (subagentSteps.length > 0) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "explicit_tool_plan_subagent_forbidden",
        "Planner introduced delegated steps into a turn that explicitly named deterministic tools",
        {
          subagentSteps: subagentSteps.join(","),
          requiredTools: requirements.orderedToolNames.join(","),
        },
      ),
    );
  }

  const disallowedTools = deterministicSteps
    .filter((step) => !allowedToolNames.has(step.tool))
    .map((step) => `${step.name}:${step.tool}`);
  if (disallowedTools.length > 0) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "explicit_tool_plan_disallowed_tool",
        "Planner introduced deterministic tools outside the user-requested tool set",
        {
          disallowedTools: disallowedTools.join(","),
          requiredTools: requirements.orderedToolNames.join(","),
        },
      ),
    );
  }

  const stepsByTool = new Map<string, PlannerDeterministicToolStepIntent[]>();
  for (const step of deterministicSteps) {
    const bucket = stepsByTool.get(step.tool);
    if (bucket) {
      bucket.push(step);
    } else {
      stepsByTool.set(step.tool, [step]);
    }
  }

  const missingTools = requirements.orderedToolNames.filter(
    (toolName) => (stepsByTool.get(toolName)?.length ?? 0) === 0,
  );
  if (missingTools.length > 0) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "explicit_tool_plan_missing_required_tool",
        "Planner omitted one or more explicitly requested deterministic tools",
        {
          missingTools: missingTools.join(","),
          requiredTools: requirements.orderedToolNames.join(","),
        },
      ),
    );
  }

  const insufficientToolCalls = requirements.orderedToolNames
    .map((toolName) => ({
      toolName,
      requiredCount: requirements.minimumToolCallsByName[toolName] ?? 1,
      actualCount: stepsByTool.get(toolName)?.length ?? 0,
    }))
    .filter(
      (entry) =>
        entry.actualCount > 0 && entry.actualCount < entry.requiredCount,
    );
  if (insufficientToolCalls.length > 0) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "explicit_tool_plan_insufficient_tool_calls",
        "Planner did not include enough deterministic calls for one or more explicitly repeated tools",
        {
          insufficientToolCalls: insufficientToolCalls
            .map(
              (entry) =>
                `${entry.toolName}:${entry.actualCount}/${entry.requiredCount}`,
            )
            .join(","),
        },
      ),
    );
  }

  const firstStepIndexByTool = new Map<string, number>();
  plannerPlan.steps.forEach((step, index) => {
    if (step.stepType !== "deterministic_tool") return;
    if (!allowedToolNames.has(step.tool)) return;
    if (firstStepIndexByTool.has(step.tool)) return;
    firstStepIndexByTool.set(step.tool, index);
  });
  const orderMismatch = requirements.orderedToolNames.some(
    (toolName, index) =>
      index > 0 &&
      (firstStepIndexByTool.get(toolName) ?? Number.POSITIVE_INFINITY) <=
        (firstStepIndexByTool.get(requirements.orderedToolNames[index - 1]!) ??
          Number.NEGATIVE_INFINITY),
  );
  if (orderMismatch) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "explicit_tool_plan_order_mismatch",
        "Planner did not preserve the user-requested deterministic tool order",
        {
          requiredTools: requirements.orderedToolNames.join("->"),
        },
      ),
    );
  }

  const dependencyMap = buildPlannerDependencyMap(plannerPlan);
  const ancestorMemo = new Map<string, ReadonlySet<string>>();
  for (let index = 1; index < requirements.orderedToolNames.length; index++) {
    const previousTool = requirements.orderedToolNames[index - 1]!;
    const currentTool = requirements.orderedToolNames[index]!;
    const previousStepNames = new Set(
      (stepsByTool.get(previousTool) ?? []).map((step) => step.name),
    );
    if (previousStepNames.size === 0) continue;

    const unmatchedCurrentSteps = (stepsByTool.get(currentTool) ?? [])
      .filter((step) => {
        const ancestors = collectPlannerStepAncestors(
          step.name,
          dependencyMap,
          ancestorMemo,
        );
        for (const dependency of previousStepNames) {
          if (ancestors.has(dependency)) {
            return false;
          }
        }
        return true;
      })
      .map((step) => step.name);

    if (unmatchedCurrentSteps.length > 0) {
      diagnostics.push(
        createPlannerDiagnostic(
          "validation",
          "explicit_tool_plan_dependency_mismatch",
          "Planner did not preserve dependency gating between explicitly ordered tools",
          {
            previousTool,
            currentTool,
            unmatchedSteps: unmatchedCurrentSteps.join(","),
          },
        ),
      );
    }
  }

  return diagnostics;
}

const PLANNER_BASH_TOOL_NAMES = new Set(["system.bash", "desktop.bash"]);
const PLANNER_SHELL_WRAPPER_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
]);
const PLANNER_SHELL_WRAPPER_FLAG_RE = /^-[A-Za-z]*c[A-Za-z]*$/;
const PLANNER_INLINE_SHELL_WRAPPER_RE =
  /^(?:\S+\/)?(?:bash|sh|zsh|dash|ksh|fish|csh|tcsh)\s+-[A-Za-z]*c\b/i;
const PLANNER_HEREDOC_RE = /<<-?\s*['"]?[A-Za-z0-9_-]+['"]?/;
const PLANNER_INLINE_FILE_WRITE_RE =
  /\b(?:cat|tee)\b[\s\S]{0,96}(?:>\s*\S|>>\s*\S|<<-?\s*['"]?[A-Za-z0-9_-]+['"]?)|\b(?:echo|printf)\b[\s\S]{0,160}(?:>\s*\S|>>\s*\S)/i;

function commandBasename(command: string): string {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "";
  const parts = trimmed.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

function parsePlannerStringArgs(
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const parsed: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    parsed.push(entry);
  }
  return parsed;
}

function extractPlannerStepShellText(
  command: string,
  args: readonly string[],
): readonly string[] {
  return [command, ...args].filter((entry) => entry.trim().length > 0);
}

export function validatePlannerStepContracts(
  plannerPlan: PlannerPlan,
): readonly PlannerDiagnostic[] {
  const diagnostics: PlannerDiagnostic[] = [];

  for (const step of plannerPlan.steps) {
    if (step.stepType === "deterministic_tool") {
      if (!PLANNER_BASH_TOOL_NAMES.has(step.tool)) continue;

      const command = step.args.command;
      if (typeof command !== "string" || command.trim().length === 0) {
        diagnostics.push(
          createPlannerDiagnostic(
            "validation",
            "planner_bash_missing_command",
            `Planner bash step "${step.name}" must provide a non-empty string command`,
            {
              stepName: step.name,
              tool: step.tool,
            },
          ),
        );
        continue;
      }

      const parsedArgs = parsePlannerStringArgs(step.args.args);
      if (!parsedArgs) {
        diagnostics.push(
          createPlannerDiagnostic(
            "validation",
            "planner_bash_invalid_args",
            `Planner bash step "${step.name}" must provide string args when args is present`,
            {
              stepName: step.name,
              tool: step.tool,
            },
          ),
        );
        continue;
      }

      const commandBase = commandBasename(command);
      const firstArg = parsedArgs[0]?.trim() ?? "";
      if (
        (parsedArgs.length === 0 &&
          PLANNER_INLINE_SHELL_WRAPPER_RE.test(command.trim())) ||
        PLANNER_SHELL_WRAPPER_COMMANDS.has(commandBase) &&
        PLANNER_SHELL_WRAPPER_FLAG_RE.test(firstArg)
      ) {
        diagnostics.push(
          createPlannerDiagnostic(
            "validation",
            "planner_bash_nested_shell_forbidden",
            `Planner bash step "${step.name}" uses forbidden nested shell wrapper invocation`,
            {
              stepName: step.name,
              tool: step.tool,
              command: commandBase,
            },
          ),
        );
        continue;
      }

      const directModeShellTokens = collectDirectModeShellControlTokens(parsedArgs);
      if (directModeShellTokens.length > 0) {
        diagnostics.push(
          createPlannerDiagnostic(
            "validation",
            "planner_bash_shell_syntax_in_direct_args",
            `Planner bash step "${step.name}" embeds shell-only control tokens in direct-mode args`,
            {
              stepName: step.name,
              tool: step.tool,
              shellTokens: directModeShellTokens.join(","),
            },
          ),
        );
        continue;
      }

      const shellFragments = extractPlannerStepShellText(command, parsedArgs);
      const hasInlineFileMaterialization = shellFragments.some((fragment) =>
        /\r|\n/.test(fragment) ||
        PLANNER_HEREDOC_RE.test(fragment) ||
        PLANNER_INLINE_FILE_WRITE_RE.test(fragment)
      );
      if (hasInlineFileMaterialization) {
        diagnostics.push(
          createPlannerDiagnostic(
            "validation",
            "planner_bash_file_materialization_forbidden",
            `Planner bash step "${step.name}" embeds file contents or a multiline shell script`,
            {
              stepName: step.name,
              tool: step.tool,
            },
          ),
        );
      }
      continue;
    }

    if (step.stepType !== "subagent_task") continue;
    const budgetHint = inspectDelegationBudgetHint(step.maxBudgetHint);
    if (budgetHint.kind === "ambiguous_numeric") {
      diagnostics.push(
        createPlannerDiagnostic(
          "validation",
          "planner_subagent_budget_hint_ambiguous",
          `Planner subagent step "${step.name}" uses an ambiguous max_budget_hint without units`,
          {
            stepName: step.name,
            maxBudgetHint: step.maxBudgetHint,
          },
        ),
      );
      continue;
    }
    if (
      budgetHint.kind === "explicit" &&
      budgetHint.durationMs < MIN_DELEGATION_TIMEOUT_MS
    ) {
      diagnostics.push(
        createPlannerDiagnostic(
          "validation",
          "planner_subagent_budget_hint_too_small",
          `Planner subagent step "${step.name}" uses a max_budget_hint below the delegation minimum`,
          {
            stepName: step.name,
            maxBudgetHint: step.maxBudgetHint,
            minimumSeconds: Math.floor(MIN_DELEGATION_TIMEOUT_MS / 1000),
          },
        ),
      );
    }
  }

  return diagnostics;
}

export function buildPlannerStepContractRefinementHint(
  diagnostics: readonly PlannerDiagnostic[],
): string {
  const fragments = diagnostics
    .map((diagnostic) => {
      if (diagnostic.code === "planner_bash_nested_shell_forbidden") {
        return "do not use `bash -c` or `sh -c` in deterministic bash steps";
      }
      if (
        diagnostic.code === "planner_bash_shell_syntax_in_direct_args"
      ) {
        return "do not place shell separators or redirects in direct-mode bash args; use one executable in `command` with plain operands in `args`, or switch to shell mode";
      }
      if (
        diagnostic.code === "planner_bash_file_materialization_forbidden"
      ) {
        return "do not embed heredocs, multiline shell scripts, or inline file contents in deterministic bash steps; use file tools instead";
      }
      if (
        diagnostic.code === "planner_subagent_budget_hint_ambiguous"
      ) {
        return `replace bare max_budget_hint values like "${readDiagnosticDetail(diagnostic, "maxBudgetHint") ?? "0.08"}" with explicit units such as \`2m\``;
      }
      if (
        diagnostic.code === "planner_subagent_budget_hint_too_small"
      ) {
        return `give subagent steps at least ${readDiagnosticDetail(diagnostic, "minimumSeconds") ?? "60"}s with an explicit unit`;
      }
      return diagnostic.message;
    })
    .filter((fragment) => fragment.length > 0);

  if (fragments.length === 0) {
    return (
      "The previous plan violated runtime step contracts. Re-emit a plan that " +
      "uses direct bash commands without shell wrappers, keeps file contents out " +
      "of bash scripts, and uses explicit subagent budget units."
    );
  }

  return (
    "The previous plan violated runtime step contracts. " +
    `${fragments.join(" | ")}. ` +
    "Re-emit an executable plan that follows those constraints."
  );
}

const RECOVERABLE_PLANNER_PARSE_DIAGNOSTIC_CODES = new Set([
  "duplicate_step_name",
  "missing_subagent_field",
  "invalid_subagent_field_type",
]);

export function extractRecoverablePlannerParseDiagnostics(
  diagnostics: readonly PlannerDiagnostic[],
): readonly PlannerDiagnostic[] {
  return diagnostics.filter((diagnostic) =>
    RECOVERABLE_PLANNER_PARSE_DIAGNOSTIC_CODES.has(diagnostic.code)
  );
}

export function buildPlannerParseRefinementHint(
  diagnostics: readonly PlannerDiagnostic[],
): string {
  const recoverable = extractRecoverablePlannerParseDiagnostics(diagnostics);
  const fragments = recoverable
    .map((diagnostic) => {
      const stepName = readDiagnosticDetail(diagnostic, "stepName");
      const field = readDiagnosticDetail(diagnostic, "field");
      if (
        diagnostic.code === "duplicate_step_name" &&
        stepName
      ) {
        return `planner step "${stepName}" must use a unique name`;
      }
      if (
        diagnostic.code === "missing_subagent_field" &&
        stepName &&
        field
      ) {
        return `subagent step "${stepName}" must include "${field}"`;
      }
      if (
        diagnostic.code === "invalid_subagent_field_type" &&
        stepName &&
        field
      ) {
        return `subagent step "${stepName}" must use the correct type for "${field}"`;
      }
      return diagnostic.message;
    })
    .filter((fragment) => fragment.length > 0);

  const repairSummary =
    fragments.length > 0
      ? ` Fix these issues: ${fragments.join(" | ")}.`
      : "";

  return (
    "The previous planner response was close but failed local schema checks." +
    repairSummary +
    " Re-emit strict JSON only. " +
    "Each planner step name must be unique within the full plan. " +
    "Every `subagent_task` must include `objective`, `input_contract`, `acceptance_criteria`, `required_tool_capabilities`, `context_requirements`, and `max_budget_hint`. " +
    "If `can_run_parallel` is present, it must be a boolean."
  );
}

export function buildExplicitSubagentOrchestrationRefinementHint(
  requirements: ExplicitSubagentOrchestrationRequirements,
  diagnostics: readonly PlannerDiagnostic[] = [],
): string {
  const fragments = diagnostics
    .map((diagnostic) => {
      if (diagnostic.code === "required_subagent_steps_missing") {
        return `missing required steps: ${readDiagnosticDetail(diagnostic, "missingSteps") ?? "unknown"}`;
      }
      if (diagnostic.code === "required_subagent_step_wrong_type") {
        return `wrong step type: ${readDiagnosticDetail(diagnostic, "wrongTypeSteps") ?? "unknown"}`;
      }
      if (diagnostic.code === "required_subagent_step_order_mismatch") {
        return "required step order was not preserved";
      }
      return diagnostic.message;
    })
    .filter((fragment) => fragment.length > 0);

  const requiredOrder = requirements.stepNames.join(" -> ");
  const suffix =
    fragments.length > 0 ? ` Fix these issues: ${fragments.join(" | ")}.` : "";
  return (
    "The user requires an explicit sub-agent orchestration plan. " +
    `Emit one subagent_task for each required step using these exact names and order: ${requiredOrder}.` +
    suffix +
    " Do not omit, rename, merge, or collapse required steps."
  );
}

export function buildExplicitDeterministicToolRefinementHint(
  requirements: ExplicitDeterministicToolRequirements,
  diagnostics: readonly PlannerDiagnostic[] = [],
): string {
  const fragments = diagnostics
    .map((diagnostic) => {
      if (diagnostic.code === "explicit_tool_plan_subagent_forbidden") {
        return "do not introduce subagent_task steps";
      }
      if (diagnostic.code === "explicit_tool_plan_disallowed_tool") {
        return `use only these tools: ${requirements.orderedToolNames.join(", ")}`;
      }
      if (diagnostic.code === "explicit_tool_plan_missing_required_tool") {
        return `missing required tools: ${readDiagnosticDetail(diagnostic, "missingTools") ?? "unknown"}`;
      }
      if (diagnostic.code === "explicit_tool_plan_insufficient_tool_calls") {
        return `increase repeated tool calls to satisfy: ${readDiagnosticDetail(diagnostic, "insufficientToolCalls") ?? "unknown"}`;
      }
      if (diagnostic.code === "explicit_tool_plan_order_mismatch") {
        return "preserve the explicit tool order";
      }
      if (diagnostic.code === "explicit_tool_plan_dependency_mismatch") {
        return `add dependency gating for: ${readDiagnosticDetail(diagnostic, "unmatchedSteps") ?? "unknown"}`;
      }
      return diagnostic.message;
    })
    .filter((fragment) => fragment.length > 0);
  const requiredOrder = renderExplicitToolRequirementSummary(requirements);
  const suffix =
    fragments.length > 0 ? ` Fix these issues: ${fragments.join(" | ")}.` : "";
  return (
    "The user explicitly named deterministic tools for this turn. " +
    `Use only these tools in this order: ${requiredOrder}. ` +
    "Keep the plan deterministic-only, preserve dependency order between the tool stages, and do not add delegated steps or off-domain tools." +
    suffix
  );
}

export function buildExplicitDeterministicToolFailureMessage(
  requirements: ExplicitDeterministicToolRequirements,
  diagnostics: readonly PlannerDiagnostic[] = [],
): string {
  const lines = [
    "Planner could not produce the required deterministic tool plan.",
    `Required tool order: ${renderExplicitToolRequirementSummary(requirements)}`,
  ];
  for (const diagnostic of diagnostics.slice(0, 3)) {
    lines.push(`- ${diagnostic.message}`);
  }
  return lines.join("\n");
}

export function buildPlannerVerificationRequirementsRefinementHint(
  requiredCategories: readonly PlannerVerificationRequirementCategory[],
  diagnostics: readonly PlannerDiagnostic[] = [],
): string {
  const missingCategories = diagnostics
    .flatMap((diagnostic) =>
      (readDiagnosticDetail(diagnostic, "missingCategories") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
    .filter((value, index, values) => values.indexOf(value) === index);
  const missingCommands = diagnostics
    .flatMap((diagnostic) =>
      (readDiagnosticDetail(diagnostic, "missingCommands") ?? "")
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
    .filter((value, index, values) => values.indexOf(value) === index);
  const requiredSummary = normalizePlannerVerificationCategories(
    requiredCategories,
  ).join(" -> ");
  const missingSummary =
    missingCategories.length > 0 ? missingCategories.join(", ") : "unknown";
  const parts = [
    "The user explicitly required verification coverage before finishing. " +
    (requiredSummary.length > 0
      ? `Keep these verification modes in the plan: ${requiredSummary}. `
      : ""),
    missingCategories.length > 0
      ? `The previous plan dropped: ${missingSummary}. `
      : "",
    missingCommands.length > 0
      ? `It also dropped explicit acceptance commands: ${renderPlannerVerificationCommandSummary(missingCommands)}. `
      : "",
    "Add dependent verification steps or delegated validation contracts that preserve those modes and commands, and do not collapse them away during repair.",
  ];
  return parts.join("");
}

export function buildPlannerVerificationRequirementsFailureMessage(
  requiredCategories: readonly PlannerVerificationRequirementCategory[],
  diagnostics: readonly PlannerDiagnostic[] = [],
): string {
  const missingCategories = diagnostics
    .flatMap((diagnostic) =>
      (readDiagnosticDetail(diagnostic, "missingCategories") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
    .filter((value, index, values) => values.indexOf(value) === index);
  const missingCommands = diagnostics
    .flatMap((diagnostic) =>
      (readDiagnosticDetail(diagnostic, "missingCommands") ?? "")
        .split("\n")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    )
    .filter((value, index, values) => values.indexOf(value) === index);
  const lines = [
    "Planner could not preserve the user-requested verification coverage.",
  ];
  const requiredModes = normalizePlannerVerificationCategories(requiredCategories);
  if (requiredModes.length > 0) {
    lines.push(`Required verification modes: ${requiredModes.join(" -> ")}`);
  }
  if (missingCategories.length > 0) {
    lines.push(`Missing verification modes: ${missingCategories.join(", ")}`);
  }
  if (missingCommands.length > 0) {
    lines.push(
      `Missing acceptance commands: ${renderPlannerVerificationCommandSummary(missingCommands)}`,
    );
  }
  for (const diagnostic of diagnostics.slice(0, 2)) {
    lines.push(`- ${diagnostic.message}`);
  }
  return lines.join("\n");
}

function renderExplicitToolRequirementSummary(
  requirements: ExplicitDeterministicToolRequirements,
): string {
  return requirements.orderedToolNames
    .map((toolName) => {
      const requiredCount = requirements.minimumToolCallsByName[toolName] ?? 1;
      return requiredCount > 1 ? `${toolName} x${requiredCount}` : toolName;
    })
    .join(" -> ");
}

export function buildExplicitSubagentOrchestrationFailureMessage(
  requirements: ExplicitSubagentOrchestrationRequirements,
  diagnostics: readonly PlannerDiagnostic[] = [],
): string {
  const lines = [
    "Planner could not produce the required sub-agent orchestration plan.",
    `Required step order: ${requirements.stepNames.join(" -> ")}`,
  ];
  for (const diagnostic of diagnostics.slice(0, 3)) {
    lines.push(`- ${diagnostic.message}`);
  }
  return lines.join("\n");
}

export function buildPlannerValidationFailureMessage(
  diagnostics: readonly PlannerDiagnostic[] = [],
): string {
  const lines = [
    "Planner produced a structured plan that failed local validation, so execution stopped instead of bypassing planner safety checks.",
  ];
  for (const diagnostic of diagnostics.slice(0, 3)) {
    lines.push(`- ${diagnostic.message}`);
  }
  return lines.join("\n");
}

function readDiagnosticDetail(
  diagnostic: PlannerDiagnostic,
  key: string,
): string | undefined {
  const value = diagnostic.details?.[key];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return undefined;
}

function buildPlannerDependencyMap(
  plannerPlan: PlannerPlan,
): ReadonlyMap<string, ReadonlySet<string>> {
  const dependencies = new Map<string, Set<string>>();
  for (const step of plannerPlan.steps) {
    dependencies.set(step.name, new Set(step.dependsOn ?? []));
  }
  for (const edge of plannerPlan.edges) {
    const target = dependencies.get(edge.to);
    if (!target || !dependencies.has(edge.from)) continue;
    target.add(edge.from);
  }
  return dependencies;
}

function collectPlannerStepAncestors(
  stepName: string,
  dependencyMap: ReadonlyMap<string, ReadonlySet<string>>,
  memo: Map<string, ReadonlySet<string>>,
  visiting = new Set<string>(),
): ReadonlySet<string> {
  const cached = memo.get(stepName);
  if (cached) return cached;
  if (visiting.has(stepName)) return new Set();

  visiting.add(stepName);
  const ancestors = new Set<string>();
  for (const dependency of dependencyMap.get(stepName) ?? []) {
    ancestors.add(dependency);
    for (const ancestor of collectPlannerStepAncestors(
      dependency,
      dependencyMap,
      memo,
      visiting,
    )) {
      ancestors.add(ancestor);
    }
  }
  visiting.delete(stepName);
  memo.set(stepName, ancestors);
  return ancestors;
}

export function extractPlannerDecompositionDiagnostics(
  diagnostics: readonly PlannerDiagnostic[],
): readonly PlannerDiagnostic[] {
  return diagnostics.filter(
    (diagnostic) => diagnostic.code === "subagent_step_needs_decomposition",
  );
}

const STRUCTURAL_PLANNER_GRAPH_DIAGNOSTIC_CODES = new Set([
  "subagent_fanout_exceeded",
  "cyclic_dependency",
  "subagent_step_needs_decomposition",
  "node_workspace_install_phase_mismatch",
  "planner_verification_requirements_missing",
]);

export function extractPlannerStructuralDiagnostics(
  diagnostics: readonly PlannerDiagnostic[],
): readonly PlannerDiagnostic[] {
  return diagnostics.filter((diagnostic) =>
    STRUCTURAL_PLANNER_GRAPH_DIAGNOSTIC_CODES.has(diagnostic.code)
  );
}

export function buildPlannerStructuralRefinementHint(
  diagnostics: readonly PlannerDiagnostic[],
): string {
  const fragments = diagnostics
    .map((diagnostic) => {
      if (diagnostic.code === "subagent_fanout_exceeded") {
        return (
          "reduce the total number of subagent_task steps so it does not exceed " +
          `maxFanoutPerTurn=${readDiagnosticDetail(diagnostic, "maxFanoutPerTurn") ?? "the configured limit"}`
        );
      }
      if (diagnostic.code === "cyclic_dependency") {
        return "remove cycles from the step dependency graph";
      }
      if (diagnostic.code === "subagent_step_needs_decomposition") {
        const stepName = readDiagnosticDetail(diagnostic, "stepName") ?? "subagent_step";
        const phases = readDiagnosticDetail(diagnostic, "phases");
        const suggestedSteps = readDiagnosticDetail(
          diagnostic,
          "suggestedSteps",
        );
        const parts = [`step "${stepName}"`];
        const normalizedPhases = new Set(
          (phases ?? "")
            .split(",")
            .map((phase) => phase.trim())
            .filter((phase) => phase.length > 0),
        );
        if (phases) {
          parts.push(`phases: ${phases}`);
        }
        if (suggestedSteps) {
          parts.push(`suggested split: ${suggestedSteps}`);
        }
        if (
          normalizedPhases.has("implementation") &&
          normalizedPhases.has("browser")
        ) {
          parts.push(
            "keep code/build work in this step and move browser-session validation into its own later step",
          );
        } else if (
          normalizedPhases.has("implementation") &&
          normalizedPhases.has("validation")
        ) {
          parts.push(
            "keep implementation in this step and move broad validation into its own dependent verification step",
          );
        }
        return parts.join("; ");
      }
      if (diagnostic.code === "node_workspace_install_phase_mismatch") {
        const stepName = readDiagnosticDetail(diagnostic, "stepName") ?? "subagent_step";
        const installSteps = readDiagnosticDetail(diagnostic, "installSteps") ?? "the install step";
        const verificationModes =
          readDiagnosticDetail(diagnostic, "verificationModes") ?? "build/test";
        const requiresPhaseSplit =
          readDiagnosticDetail(diagnostic, "requiresPhaseSplit") === "true";
        return requiresPhaseSplit
          ? `step "${stepName}" must stay as pure manifest/config scaffolding before ${installSteps}; do not mention install/build/test/typecheck/lint/coverage success in that step's objective or acceptance criteria. Limit it to authored files, scripts, configs, directories, and local dependency links, then move verification after install`
          : `step "${stepName}" must depend on ${installSteps} before ${verificationModes} verification and must not claim that verification earlier`;
      }
      if (diagnostic.code === "planner_verification_requirements_missing") {
        const missingCommands = (readDiagnosticDetail(
          diagnostic,
          "missingCommands",
        ) ?? "")
          .split("\n")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        const missingModesFragment =
          readDiagnosticDetail(diagnostic, "missingCategories") ?? "unknown";
        const missingCommandsFragment =
          missingCommands.length > 0
            ? `; missing commands: ${renderPlannerVerificationCommandSummary(missingCommands)}`
            : "";
        return (
          "preserve all user-requested verification modes before finishing; " +
          `missing: ${missingModesFragment}${missingCommandsFragment}`
        );
      }
      return diagnostic.message;
    })
    .filter((fragment) => fragment.length > 0);

  if (fragments.length === 0) {
    return (
      "The previous plan violated structural delegation constraints. Re-emit " +
      "a smaller acyclic plan whose delegated fanout stays within the runtime limit."
    );
  }

  return (
    "The previous plan violated structural delegation constraints: " +
    `${fragments.join(" | ")}. ` +
    "Re-emit a smaller acyclic plan that stays within the runtime fanout limit."
  );
}

export function buildPlannerDecompositionRefinementHint(
  diagnostics: readonly PlannerDiagnostic[],
): string {
  return buildPlannerStructuralRefinementHint(
    diagnostics.filter(
      (diagnostic) => diagnostic.code === "subagent_step_needs_decomposition",
    ),
  );
}

export function buildSalvagedPlannerToolCallRefinementHint(
  diagnostics: readonly PlannerDiagnostic[],
): string {
  const underdecomposed = diagnostics.find(
    (diagnostic) => diagnostic.code === "salvaged_tool_plan_underdecomposed",
  );
  const minimumExpectedSteps = underdecomposed
    ? readDiagnosticDetail(underdecomposed, "minimumExpectedSteps")
    : undefined;
  const expectedSignals = underdecomposed
    ? readDiagnosticDetail(underdecomposed, "signals")
    : undefined;
  const constraintFragments = [
    minimumExpectedSteps
      ? `emit at least ${minimumExpectedSteps} dependent step(s)`
      : "emit multiple dependent steps",
    expectedSignals ? `cover these request signals: ${expectedSignals}` : "",
  ].filter((value) => value && value.length > 0);

  return (
    "The previous planner reply emitted raw tool calls that under-decomposed the request. " +
    (constraintFragments.length > 0
      ? `${constraintFragments.join("; ")}. `
      : "") +
    "Return strict JSON only and do not collapse the task into a single bootstrap action or direct tool call."
  );
}

export function buildPipelineDecompositionRefinementHint(
  decomposition: DelegationDecompositionSignal,
): string {
  const phases = decomposition.phases.join(",");
  const suggestedSteps = decomposition.suggestedSteps
    .map((suggestion) => suggestion.name)
    .join(",");
  const fragments = [
    decomposition.reason,
    phases.length > 0 ? `phases: ${phases}` : "",
    suggestedSteps.length > 0 ? `suggested split: ${suggestedSteps}` : "",
  ].filter((value) => value.length > 0);
  return (
    "Delegation execution requested parent-side decomposition. " +
    fragments.join(". ") +
    ". Replace the oversized delegated step with smaller dependent subagent_task steps."
  );
}

export function buildPipelineFailureRepairRefinementHint(params: {
  readonly pipelineResult: PipelineResult;
  readonly plannerPlan: PlannerPlan;
}): string {
  const failureSpecificRepairHint = buildFailureSpecificRepairHint(
    params.pipelineResult.error,
  );
  const unresolvedSteps = params.plannerPlan.steps
    .slice(Math.max(0, params.pipelineResult.completedSteps))
    .map((step) => step.name)
    .join(", ");
  const fragments = [
    `completed ${params.pipelineResult.completedSteps}/${params.pipelineResult.totalSteps} planned steps`,
    typeof params.pipelineResult.stopReasonHint === "string"
      ? `stop reason hint: ${params.pipelineResult.stopReasonHint}`
      : "",
    unresolvedSteps.length > 0 ? `unresolved steps: ${unresolvedSteps}` : "",
    typeof params.pipelineResult.error === "string" &&
      params.pipelineResult.error.trim().length > 0
      ? `failure details: ${truncateText(params.pipelineResult.error.trim(), 800)}`
      : "",
    failureSpecificRepairHint ?? "",
  ].filter((fragment) => fragment.length > 0);
  return (
    "A prior executable plan partially succeeded but failed during deterministic verification. " +
    "Treat the existing workspace mutations from completed steps as already applied. " +
    "Re-emit an incremental repair plan that focuses only on the remaining defect, inserts narrow repair subagent_task steps before re-running verification, and avoids redoing successful setup/build work unless the failure evidence proves it is necessary. " +
    fragments.join(". ")
  );
}

function buildFailureSpecificRepairHint(
  error: string | undefined,
): string | undefined {
  if (typeof error !== "string" || error.trim().length === 0) {
    return undefined;
  }
  const normalized = error.toLowerCase();
  if (
    normalized.includes('unsupported url type "workspace:"') ||
    normalized.includes("eunsupportedprotocol")
  ) {
    return (
      "This host package manager rejected `workspace:*`. " +
      "Do not emit `workspace:*` in generated manifests. Use a host-compatible local dependency reference, then rerun `npm install` on this host before continuing."
    );
  }
  if (
    normalized.includes('unrecognized option "run"') ||
    normalized.includes("unrecognized cli parameter")
  ) {
    return (
      "Do not assume `npm test -- --run` works for every workspace. " +
      "Re-run tests with a runner-compatible single-run command; for Jest prefer `CI=1 npm test` or `jest --runInBand`."
    );
  }
  return undefined;
}

// ============================================================================
// Planner utility functions
// ============================================================================

export function createPlannerDiagnostic(
  category: PlannerDiagnostic["category"],
  code: string,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): PlannerDiagnostic {
  return { category, code, message, ...(details ? { details } : {}) };
}

export function isHighRiskSubagentPlan(
  steps: readonly PlannerSubAgentTaskStepIntent[],
): boolean {
  for (const step of steps) {
    for (const capability of step.requiredToolCapabilities) {
      const normalized = capability.trim().toLowerCase();
      if (!normalized) continue;
      if (
        normalized.startsWith("wallet.") ||
        normalized.startsWith("solana.") ||
        normalized.startsWith("agenc.") ||
        normalized.startsWith("desktop.") ||
        normalized === "system.delete" ||
        normalized === "system.writefile" ||
        normalized === "system.execute" ||
        normalized === "system.open" ||
        normalized === "system.applescript" ||
        normalized === "system.notification"
      ) {
        return true;
      }
    }
  }
  return false;
}

export function detectPlannerCycle(
  nodes: readonly string[],
  edges: readonly WorkflowGraphEdge[],
): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const node of nodes) {
    adjacency.set(node, []);
  }
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const walk = (node: string): string[] | null => {
    if (visiting.has(node)) {
      const loopStart = stack.indexOf(node);
      return loopStart >= 0
        ? [...stack.slice(loopStart), node]
        : [node, node];
    }
    if (visited.has(node)) return null;
    visiting.add(node);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const cycle = walk(next);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(node);
    visited.add(node);
    return null;
  };

  for (const node of nodes) {
    const cycle = walk(node);
    if (cycle) return cycle;
  }
  return null;
}

export function computePlannerGraphDepth(
  nodes: readonly string[],
  edges: readonly WorkflowGraphEdge[],
): { maxDepth: number; cyclic: boolean } {
  if (nodes.length === 0) return { maxDepth: 0, cyclic: false };
  const inDegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const depth = new Map<string, number>();

  for (const node of nodes) {
    inDegree.set(node, 0);
    outgoing.set(node, []);
    depth.set(node, 1);
  }
  for (const edge of edges) {
    if (!inDegree.has(edge.from) || !inDegree.has(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [node, nodeInDegree] of inDegree.entries()) {
    if (nodeInDegree === 0) queue.push(node);
  }

  let visited = 0;
  let maxDepth = 1;
  while (queue.length > 0) {
    const node = queue.shift()!;
    visited++;
    const nodeDepth = depth.get(node) ?? 1;
    maxDepth = Math.max(maxDepth, nodeDepth);
    for (const next of outgoing.get(node) ?? []) {
      const nextDepth = Math.max(depth.get(next) ?? 1, nodeDepth + 1);
      depth.set(next, nextDepth);
      const nextInDegree = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, nextInDegree);
      if (nextInDegree === 0) queue.push(next);
    }
  }

  return {
    maxDepth,
    cyclic: visited !== nodes.length,
  };
}

export function parsePlannerStepType(
  value: unknown,
): PlannerStepType | undefined {
  return value === "deterministic_tool" ||
    value === "subagent_task" ||
    value === "synthesis"
    ? value
    : undefined;
}

export function parsePlannerRequiredString(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parsePlannerOptionalString(
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parsePlannerStringArray(
  value: unknown,
): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    const trimmed = entry.trim();
    if (trimmed.length === 0) return undefined;
    items.push(trimmed);
  }
  return items;
}

function parsePlannerArgsRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function parsePlannerStringFromKeys(
  source: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const parsed = parsePlannerRequiredString(source[key]);
    if (parsed) return parsed;
  }
  return undefined;
}

function parsePlannerStringArrayFromKeys(
  source: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): readonly string[] | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const parsed = parsePlannerStringArray(source[key]);
    if (parsed) return parsed;
  }
  return undefined;
}

export function parsePlannerDependsOn(
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const items: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return undefined;
    const trimmed = entry.trim();
    if (trimmed.length === 0) return undefined;
    items.push(trimmed);
  }
  return items;
}

export function parsePlannerConfidence(
  value: unknown,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value >= 0 && value <= 1) return value;
  if (value >= 0 && value <= 100) return value / 100;
  return undefined;
}

export function sanitizePlannerStepName(name: string): string {
  const trimmed = name.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return normalized.length > 0 ? normalized : "step";
}

export function dedupePlannerStepName(
  name: string,
  used: ReadonlySet<string>,
): string {
  if (!used.has(name)) return name;
  for (let i = 2; i <= 999; i++) {
    const candidate = `${name}_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${name}_${Date.now().toString(36)}`;
}

export function isPipelineStopReasonHint(
  value: unknown,
): value is Exclude<LLMPipelineStopReason, "completed" | "tool_calls"> {
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

// ============================================================================
// Planner synthesis messages
// ============================================================================

export function buildPlannerSynthesisMessages(
  systemPrompt: string,
  messageText: string,
  plannerPlan: PlannerPlan,
  pipelineResult: PipelineResult,
  verificationDecision?: SubagentVerifierDecision,
): readonly LLMMessage[] {
  const plannerSteps = plannerPlan.steps.map((step) => {
    if (step.stepType === "deterministic_tool") {
      return {
        name: step.name,
        stepType: step.stepType,
        tool: step.tool,
        dependsOn: step.dependsOn,
      };
    }
    if (step.stepType === "subagent_task") {
      return {
        name: step.name,
        stepType: step.stepType,
        objective: step.objective,
        dependsOn: step.dependsOn,
        canRunParallel: step.canRunParallel,
      };
    }
    return {
      name: step.name,
      stepType: step.stepType,
      objective: step.objective,
      dependsOn: step.dependsOn,
    };
  });
  const subagentStepMap = new Map<
    string,
    SubagentVerifierStepAssessment
  >(
    (verificationDecision?.steps ?? []).map((step) => [step.name, step]),
  );
  const childOutputs = plannerPlan.steps
    .filter((step): step is PlannerSubAgentTaskStepIntent => step.stepType === "subagent_task")
    .map((step) => {
      const raw = pipelineResult.context.results[step.name];
      const parsed = typeof raw === "string"
        ? parseJsonObjectFromText(raw)
        : undefined;
      const status =
        typeof parsed?.status === "string" ? parsed.status : "unknown";
      const output = typeof parsed?.output === "string"
        ? parsed.output
        : (typeof raw === "string" ? raw : "");
      const marker =
        status === "failed" || status === "cancelled"
          ? status
          : (
              status === "delegation_fallback" ? "unresolved" : "completed"
            );
      const verification = subagentStepMap.get(step.name);
      return {
        name: step.name,
        objective: step.objective,
        status,
        marker,
        confidence: verification?.confidence ?? null,
        verifierVerdict: verification?.verdict ?? null,
        unresolvedIssues: verification?.issues ?? [],
        output: truncateText(
          output,
          MAX_SUBAGENT_VERIFIER_OUTPUT_CHARS,
        ),
        provenanceTag: `[source:${step.name}]`,
      };
    });
  const unresolvedItems = [
    ...(verificationDecision?.unresolvedItems ?? []),
    ...childOutputs
      .filter((child) => child.marker !== "completed")
      .map((child) => `${child.name}:${child.marker}`),
  ];
  const renderedResults = safeStringify({
    plannerReason: plannerPlan.reason,
    status: pipelineResult.status,
    completedSteps: pipelineResult.completedSteps,
    totalSteps: pipelineResult.totalSteps,
    resumeFrom: pipelineResult.resumeFrom,
    error: pipelineResult.error,
    plannerSteps,
    plannerEdges: plannerPlan.edges,
    results: pipelineResult.context.results,
    childOutputs,
    verifier: verificationDecision ?? null,
    unresolvedItems,
  });
  return [
    { role: "system", content: systemPrompt },
    {
      role: "system",
      content:
        "Synthesize the final user-facing answer from deterministic workflow and delegated child results. " +
        "Do not invent unexecuted steps and do not call any tools. " +
        "When a major claim is derived from child output, append provenance tags like [source:<step_name>]. " +
        "Explicitly surface unresolved items or failed/cancelled child outputs.",
    },
    {
      role: "user",
      content:
        `Original request:\n${messageText}\n\n` +
        `Workflow execution bundle (with child confidence/provenance markers):\n${renderedResults}`,
    },
  ];
}

export function ensureSubagentProvenanceCitations(
  content: string,
  plannerPlan: PlannerPlan,
  pipelineResult: PipelineResult,
): string {
  const trimmed = content.trim();
  const subagentStepNames = plannerPlan.steps
    .filter((step): step is PlannerSubAgentTaskStepIntent => step.stepType === "subagent_task")
    .map((step) => step.name)
    .filter((name) =>
      typeof pipelineResult.context.results[name] === "string"
    );
  if (subagentStepNames.length === 0) return content;
  if (/\[source:[^\]]+\]/.test(trimmed)) return content;
  const citationLine = `Sources: ${subagentStepNames
    .map((name) => `[source:${name}]`)
    .join(" ")}`;
  if (trimmed.length === 0) return citationLine;
  return `${content}\n\n${citationLine}`;
}

export function buildPlannerSynthesisFallbackContent(
  plannerPlan: PlannerPlan,
  pipelineResult: PipelineResult,
  verificationDecision?: SubagentVerifierDecision,
  failureDetail?: string,
): string {
  const deterministicSteps = plannerPlan.steps
    .filter((step): step is PlannerDeterministicToolStepIntent =>
      step.stepType === "deterministic_tool" &&
      typeof pipelineResult.context.results[step.name] === "string"
    )
    .map((step) => step.name);
  const delegatedSteps = plannerPlan.steps
    .filter((step): step is PlannerSubAgentTaskStepIntent =>
      step.stepType === "subagent_task" &&
      typeof pipelineResult.context.results[step.name] === "string"
    )
    .map((step) => step.name);
  const unresolvedItems = [
    ...(verificationDecision?.unresolvedItems ?? []),
    ...delegatedSteps
      .map((name) => {
        const raw = pipelineResult.context.results[name];
        const parsed = typeof raw === "string"
          ? parseJsonObjectFromText(raw)
          : undefined;
        const status =
          typeof parsed?.status === "string" ? parsed.status : "completed";
        return status === "completed" ? null : `${name}:${status}`;
      })
      .filter((value): value is string => value !== null),
  ];
  const lines = [
    "Completed the requested workflow, but the final synthesis model call failed. Returning a deterministic summary from executed steps.",
    `Workflow status: ${pipelineResult.completedSteps}/${pipelineResult.totalSteps} steps completed.`,
    deterministicSteps.length > 0
      ? `Deterministic steps: ${deterministicSteps.join(", ")}`
      : null,
    delegatedSteps.length > 0
      ? `Delegated steps: ${delegatedSteps
          .map((name) => `${name} [source:${name}]`)
          .join(", ")}`
      : null,
    verificationDecision
      ? `Verifier: ${verificationDecision.overall} (${verificationDecision.rounds} round${verificationDecision.rounds === 1 ? "" : "s"})`
      : null,
    unresolvedItems.length > 0
      ? `Unresolved: ${unresolvedItems.join(", ")}`
      : null,
    typeof failureDetail === "string" && failureDetail.trim().length > 0
      ? `Fallback reason: ${failureDetail.trim()}`
      : null,
  ].filter((value): value is string => value !== null);
  return lines.join("\n");
}

export function pipelineResultToToolCalls(
  steps: readonly PlannerStepIntent[],
  pipelineResult: PipelineResult,
): ToolCallRecord[] {
  const records: ToolCallRecord[] = [];
  for (const step of steps) {
    const result = pipelineResult.context.results[step.name];
    if (typeof result !== "string") continue;
    if (step.stepType === "deterministic_tool") {
      const inferredFailure =
        result.startsWith("SKIPPED:") || didToolCallFail(false, result);
      records.push({
        name: step.tool,
        args: step.args,
        result,
        isError: inferredFailure,
        durationMs: 0,
      });
      continue;
    }
    if (step.stepType === "subagent_task") {
      const inferredFailure = didSubagentStepFail(result);
      records.push({
        name: "execute_with_agent",
        args: {
          objective: step.objective,
          requiredToolCapabilities: step.requiredToolCapabilities,
          stepName: step.name,
        },
        result,
        isError: inferredFailure,
        durationMs: 0,
      });
    }
  }
  return records;
}

// ============================================================================
// Extracted from executePlannerPath — delegation bandit arm resolution
// ============================================================================

/** Result of bandit arm resolution for delegation policy tuning. */
export interface BanditArmResolution {
  readonly selectedArm: DelegationBanditSelection | undefined;
  readonly tunedThreshold: number;
  readonly policyTuning: FullPlannerSummaryState["delegationPolicyTuning"];
}

/**
 * Resolve the delegation bandit arm selection, returning the selected arm,
 * tuned threshold, and delegation policy tuning record.
 */
export function resolveDelegationBanditArm(
  banditTuner: DelegationBanditPolicyTuner | undefined,
  trajectoryContextClusterId: string,
  defaultArmId: string,
  baseDelegationThreshold: number,
): BanditArmResolution {
  if (banditTuner) {
    const selectedArm = banditTuner.selectArm({
      contextClusterId: trajectoryContextClusterId,
      preferredArmId: defaultArmId,
    });
    const tunedThreshold = banditTuner.applyThresholdOffset(
      baseDelegationThreshold,
      selectedArm.armId,
    );
    return {
      selectedArm,
      tunedThreshold,
      policyTuning: {
        enabled: true,
        contextClusterId: trajectoryContextClusterId,
        selectedArmId: selectedArm.armId,
        selectedArmReason: selectedArm.reason,
        tunedThreshold,
        exploration: selectedArm.exploration,
        finalReward: undefined,
        usefulDelegation: undefined,
        usefulDelegationScore: undefined,
        rewardProxyVersion: undefined,
      },
    };
  }

  return {
    selectedArm: undefined,
    tunedThreshold: baseDelegationThreshold,
    policyTuning: {
      enabled: false,
      contextClusterId: trajectoryContextClusterId,
      selectedArmId: defaultArmId,
      selectedArmReason: "fallback",
      tunedThreshold: baseDelegationThreshold,
      exploration: false,
      finalReward: undefined,
      usefulDelegation: undefined,
      usefulDelegationScore: undefined,
      rewardProxyVersion: undefined,
    },
  };
}

// ============================================================================
// Extracted from executePlannerPath — delegation decision assessment
// ============================================================================

/** Input for assessing and recording a delegation decision. */
export interface DelegationAssessmentInput {
  readonly messageText: string;
  readonly plannerPlan: PlannerPlan;
  readonly subagentSteps: readonly PlannerSubAgentTaskStepIntent[];
  readonly complexityScore: number;
  readonly tunedThreshold: number;
  readonly delegationConfig: {
    readonly enabled: boolean;
    readonly mode: string;
    readonly maxFanoutPerTurn: number;
    readonly maxDepth: number;
    readonly handoffMinPlannerConfidence: number;
    readonly hardBlockedTaskClasses: Iterable<DelegationHardBlockedTaskClass>;
  };
}

/**
 * Assess whether to delegate and record the decision + any veto diagnostic
 * on the planner summary state. Returns the delegation decision.
 */
export function assessAndRecordDelegationDecision(
  input: DelegationAssessmentInput,
  summaryState: FullPlannerSummaryState,
): DelegationDecision {
  const synthesisSteps = input.plannerPlan.steps.filter(
    (step) => step.stepType === "synthesis",
  ).length;

  const tunedDecisionConfig: DelegationDecisionConfig = {
    enabled: input.delegationConfig.enabled,
    mode: input.delegationConfig.mode as DelegationDecisionConfig["mode"],
    scoreThreshold: input.tunedThreshold,
    maxFanoutPerTurn: input.delegationConfig.maxFanoutPerTurn,
    maxDepth: input.delegationConfig.maxDepth,
    handoffMinPlannerConfidence:
      input.delegationConfig.handoffMinPlannerConfidence,
    hardBlockedTaskClasses: [
      ...input.delegationConfig.hardBlockedTaskClasses,
    ],
  };

  const delegationDecision = assessDelegationDecision({
    messageText: input.messageText,
    plannerConfidence: input.plannerPlan.confidence,
    complexityScore: input.complexityScore,
    totalSteps: input.plannerPlan.steps.length,
    synthesisSteps,
    edges: input.plannerPlan.edges,
    subagentSteps: input.subagentSteps.map((step) => ({
      name: step.name,
      dependsOn: step.dependsOn,
      acceptanceCriteria: step.acceptanceCriteria,
      requiredToolCapabilities: step.requiredToolCapabilities,
      contextRequirements: step.contextRequirements,
      maxBudgetHint: step.maxBudgetHint,
      canRunParallel: step.canRunParallel,
    })),
    config: tunedDecisionConfig,
  });

  summaryState.delegationDecision = delegationDecision;
  if (!delegationDecision.shouldDelegate) {
    const vetoDetails: Record<string, string | number | boolean> = {
      reason: delegationDecision.reason,
      threshold: delegationDecision.threshold,
      utilityScore: Number(
        delegationDecision.utilityScore.toFixed(4),
      ),
      safetyRisk: Number(delegationDecision.safetyRisk.toFixed(4)),
    };
    if (
      delegationDecision.hardBlockedTaskClass &&
      delegationDecision.hardBlockedTaskClassSource &&
      delegationDecision.hardBlockedTaskClassSignal
    ) {
      vetoDetails.hardBlockedTaskClass =
        delegationDecision.hardBlockedTaskClass;
      vetoDetails.hardBlockedTaskClassSource =
        delegationDecision.hardBlockedTaskClassSource;
      vetoDetails.hardBlockedTaskClassSignal =
        delegationDecision.hardBlockedTaskClassSignal;
    }
    summaryState.routeReason =
      `delegation_veto_${delegationDecision.reason}`;
    summaryState.diagnostics.push({
      category: "policy",
      code: "delegation_veto",
      message:
        `Delegation vetoed by policy scorer: ${delegationDecision.reason}`,
      details: vetoDetails,
    });
  }

  return delegationDecision;
}

// ============================================================================
// Extracted from executePlannerPath — pipeline step mapping
// ============================================================================

/**
 * Map PlannerStepIntent[] to PipelinePlannerStep[] for the pipeline executor.
 */
export function mapPlannerStepsToPipelineSteps(
  steps: readonly PlannerStepIntent[],
): PipelinePlannerStep[] {
  return steps.map((step) => {
    if (step.stepType === "deterministic_tool") {
      return {
        name: step.name,
        stepType: step.stepType,
        dependsOn: step.dependsOn,
        tool: step.tool,
        args: step.args,
        onError: step.onError,
        maxRetries: step.maxRetries,
      };
    }
    if (step.stepType === "subagent_task") {
      return {
        name: step.name,
        stepType: step.stepType,
        dependsOn: step.dependsOn,
        objective: step.objective,
        inputContract: step.inputContract,
        acceptanceCriteria: step.acceptanceCriteria,
        requiredToolCapabilities: step.requiredToolCapabilities,
        contextRequirements: step.contextRequirements,
        maxBudgetHint: step.maxBudgetHint,
        canRunParallel: step.canRunParallel,
      };
    }
    return {
      name: step.name,
      stepType: step.stepType,
      dependsOn: step.dependsOn,
      objective: step.objective,
    };
  });
}

export function didSubagentStepFail(result: string): boolean {
  if (result.startsWith("SKIPPED:")) return true;
  try {
    const parsed = JSON.parse(result) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return didToolCallFail(false, result);
    }
    const obj = parsed as Record<string, unknown>;
    if (obj.success === false) return true;
    if (obj.status === "failed" || obj.status === "cancelled") return true;
    if (typeof obj.error === "string" && obj.error.trim().length > 0) {
      return true;
    }
    return false;
  } catch {
    return didToolCallFail(false, result);
  }
}
