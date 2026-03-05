/**
 * Planner parsing, validation, and message-building functions for ChatExecutor.
 *
 * @module
 */

import type { LLMMessage } from "./types.js";
import type {
  PromptBudgetSection,
} from "./prompt-budget.js";
import type { LLMPipelineStopReason } from "./policy.js";
import type {
  PipelinePlannerContext,
  PipelinePlannerContextMemorySource,
  PipelineResult,
} from "../workflow/pipeline.js";
import type { WorkflowGraphEdge } from "../workflow/types.js";
import type {
  PlannerDecision,
  PlannerStepType,
  PlannerStepIntent,
  PlannerSubAgentTaskStepIntent,
  PlannerPlan,
  PlannerParseResult,
  PlannerDiagnostic,
  PlannerGraphValidationConfig,
  SubagentVerifierDecision,
  SubagentVerifierStepAssessment,
  ToolCallRecord,
} from "./chat-executor-types.js";
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
import { didToolCallFail } from "./chat-executor-tool-utils.js";
import { safeStringify } from "../tools/types.js";

// ============================================================================
// Planner decision
// ============================================================================

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

  let score = 0;
  const reasons: string[] = [];
  const normalized = messageText.toLowerCase();

  const hasMultiStepCue =
    /\b(first|second|third|then|after that|next|finally|step\b|in order|checklist|pipeline)\b/i.test(
      messageText,
    ) ||
    /\b1[\).:]\s+.+\b2[\).:]/s.test(messageText);
  if (hasMultiStepCue) {
    score += 3;
    reasons.push("multi_step_cues");
  }

  const hasToolDiversityCue =
    /\b(browser|http|curl|bash|command|container|playwright|open|navigate|teardown|verify)\b/i.test(
      messageText,
    );
  if (hasToolDiversityCue) {
    score += 1;
    reasons.push("multi_tool_candidates");
  }

  const hasDelegationCue =
    /\b(sub[\s-]?agent|delegate|delegation|parallel(?:ize|ism)?|fanout)\b/i.test(
      messageText,
    );
  if (hasDelegationCue) {
    score += 4;
    reasons.push("delegation_cue");
  }

  const hasImplementationScopeCue =
    /\b(build|implement|create|scaffold|generate|refactor|migrate|api|endpoint|service|tests?|integration|unit test|e2e|makefile|project)\b/i.test(
      messageText,
    );
  if (hasImplementationScopeCue) {
    score += 3;
    reasons.push("implementation_scope");
  }

  const longTask = messageText.length >= 320 || messageText.split(/\n/).length >= 4;
  if (longTask) {
    score += 1;
    reasons.push("long_or_structured_request");
  }

  const historyTail = history.slice(-10);
  const priorToolMessages = historyTail.filter(
    (entry) => entry.role === "tool",
  ).length;
  if (priorToolMessages >= 4) {
    score += 2;
    reasons.push("prior_tool_loop_activity");
  }
  if (historyTail.some((entry) => typeof entry.content === "string" && entry.content.includes(RECOVERY_HINT_PREFIX))) {
    score += 2;
    reasons.push("prior_no_progress_signal");
  }

  const directFastPath =
    score < 3 ||
    normalized.trim().length < 20 ||
    /\b(hi|hello|thanks|thank you)\b/.test(normalized);

  return {
    score,
    shouldPlan: !directFastPath,
    reason: reasons.length > 0 ? reasons.join("+") : "direct_fast_path",
  };
}

// ============================================================================
// Planner message building
// ============================================================================

export function buildPlannerMessages(
  messageText: string,
  history: readonly LLMMessage[],
  plannerMaxTokens: number,
): readonly LLMMessage[] {
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

  return [
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
        "- subagent_task steps MUST include all subagent fields.\n" +
        "- Prefer subagent_task steps for broad coding/build requests that split into independent tracks (implementation, tests, verification).\n" +
        "- synthesis steps describe final merge/synthesis intent and do not call tools.\n" +
        `Keep output concise and below approximately ${plannerMaxTokens} tokens. ` +
        `Never emit more than ${maxSteps} steps.`,
    },
    {
      role: "user",
      content:
        `User request:\n${messageText}\n\n` +
        (historyPreview.length > 0
          ? `Recent conversation context:\n${historyPreview}\n\n`
          : "") +
        "Return JSON only.",
    },
  ];
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

export function parsePlannerPlan(content: string): PlannerParseResult {
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
            `Planner step "${safeName}" has invalid args; expected JSON object`,
            { stepIndex: index, stepName: safeName },
          ),
        );
        return { diagnostics };
      }
      const args =
        typeof step.args === "object" &&
        step.args !== null &&
        !Array.isArray(step.args)
          ? (step.args as Record<string, unknown>)
          : {};
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
      const objective = parsePlannerRequiredString(step.objective);
      const inputContract = parsePlannerRequiredString(
        step.input_contract,
      );
      const acceptanceCriteria = parsePlannerStringArray(
        step.acceptance_criteria,
      );
      const requiredToolCapabilities = parsePlannerStringArray(
        step.required_tool_capabilities,
      );
      const contextRequirements = parsePlannerStringArray(
        step.context_requirements,
      );
      const maxBudgetHint = parsePlannerRequiredString(
        step.max_budget_hint,
      );
      const canRunParallel =
        typeof step.can_run_parallel === "boolean"
          ? step.can_run_parallel
          : undefined;
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
      if (canRunParallel === undefined) {
        diagnostics.push(
          createPlannerDiagnostic(
            "parse",
            "missing_subagent_field",
            `Planner subagent step "${safeName}" is missing can_run_parallel`,
            {
              stepIndex: index,
              stepName: safeName,
              field: "can_run_parallel",
            },
          ),
        );
        return { diagnostics };
      }

      steps.push({
        name: safeName,
        stepType,
        objective,
        inputContract,
        acceptanceCriteria,
        requiredToolCapabilities,
        contextRequirements,
        maxBudgetHint,
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

// ============================================================================
// Planner graph validation
// ============================================================================

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
  if (graphDepth.maxDepth > config.maxSubagentDepth) {
    diagnostics.push(
      createPlannerDiagnostic(
        "validation",
        "subagent_depth_exceeded",
        `Planner subagent dependency depth ${graphDepth.maxDepth} exceeds maxDepth ${config.maxSubagentDepth}`,
        {
          depth: graphDepth.maxDepth,
          maxDepth: config.maxSubagentDepth,
        },
      ),
    );
  }

  return diagnostics;
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
