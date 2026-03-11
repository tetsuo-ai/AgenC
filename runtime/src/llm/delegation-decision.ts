import type { WorkflowGraphEdge } from "../workflow/types.js";

export type DelegationDecisionReason =
  | "delegation_disabled"
  | "no_subagent_steps"
  | "hard_blocked_task_class"
  | "trivial_request"
  | "single_hop_request"
  | "fanout_exceeded"
  | "depth_exceeded"
  | "handoff_confidence_below_threshold"
  | "safety_risk_high"
  | "score_below_threshold"
  | "approved";

export type DelegationHardBlockedTaskClass =
  | "wallet_signing"
  | "wallet_transfer"
  | "stake_or_rewards"
  | "destructive_host_mutation"
  | "credential_exfiltration";

export type DelegationHardBlockedMatchSource = "capability" | "text";

export interface DelegationDecisionConfig {
  readonly enabled?: boolean;
  readonly mode?: "manager_tools" | "handoff" | "hybrid";
  readonly scoreThreshold?: number;
  readonly maxFanoutPerTurn?: number;
  readonly maxDepth?: number;
  readonly handoffMinPlannerConfidence?: number;
  readonly hardBlockedTaskClasses?: readonly DelegationHardBlockedTaskClass[];
}

export interface ResolvedDelegationDecisionConfig {
  readonly enabled: boolean;
  readonly mode: "manager_tools" | "handoff" | "hybrid";
  readonly scoreThreshold: number;
  readonly maxFanoutPerTurn: number;
  readonly maxDepth: number;
  readonly handoffMinPlannerConfidence: number;
  readonly hardBlockedTaskClasses: ReadonlySet<DelegationHardBlockedTaskClass>;
}

export interface DelegationSubagentStepProfile {
  readonly name: string;
  readonly dependsOn?: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly requiredToolCapabilities: readonly string[];
  readonly contextRequirements: readonly string[];
  readonly maxBudgetHint: string;
  readonly canRunParallel: boolean;
}

export interface DelegationDecisionInput {
  readonly messageText: string;
  readonly plannerConfidence?: number;
  readonly complexityScore: number;
  readonly totalSteps: number;
  readonly synthesisSteps: number;
  readonly edges: readonly WorkflowGraphEdge[];
  readonly subagentSteps: readonly DelegationSubagentStepProfile[];
  readonly config?: DelegationDecisionConfig;
}

export interface DelegationDecision {
  readonly shouldDelegate: boolean;
  readonly reason: DelegationDecisionReason;
  readonly threshold: number;
  readonly utilityScore: number;
  readonly decompositionBenefit: number;
  readonly coordinationOverhead: number;
  readonly latencyCostRisk: number;
  readonly safetyRisk: number;
  readonly confidence: number;
  readonly hardBlockedTaskClass: DelegationHardBlockedTaskClass | null;
  readonly hardBlockedTaskClassSource: DelegationHardBlockedMatchSource | null;
  readonly hardBlockedTaskClassSignal: string | null;
  readonly diagnostics: Readonly<Record<string, number | boolean>>;
}

// Calibrated against current utility-score ranges for viable coding/research fanout.
const DEFAULT_SCORE_THRESHOLD = 0.2;
const DEFAULT_MAX_FANOUT_PER_TURN = 8;
const DEFAULT_MAX_DEPTH = 4;
const DEFAULT_HANDOFF_MIN_PLANNER_CONFIDENCE = 0.82;
const DEFAULT_SUBAGENT_MODE = "manager_tools" as const;
const TRIVIAL_MAX_WORDS = 28;
const SINGLE_HOP_MAX_WORDS = 72;
const SAFETY_RISK_HARD_BLOCK_THRESHOLD = 0.9;
const DEFAULT_HARD_BLOCKED_TASK_CLASSES: readonly DelegationHardBlockedTaskClass[] = [
  "wallet_signing",
  "wallet_transfer",
  "stake_or_rewards",
  "credential_exfiltration",
];

const HIGH_RISK_CAPABILITY_PATTERNS: readonly RegExp[] = [
  /^wallet\./i,
  /^solana\./i,
  /^agenc\./i,
  /^desktop\./i,
  /^system\.(?:delete|execute|open|applescript|notification)$/i,
];

const MODERATE_RISK_CAPABILITY_PATTERNS: readonly RegExp[] = [
  /^system\.(?:bash|writeFile|appendFile)$/i,
  /^system\.http$/i,
  /^playwright\./i,
];
const WALLET_SIGNING_CAPABILITY_RE =
  /^(?:wallet|solana|agenc)\.(?:sign|approve|authorize)(?:\.|$)/i;
const WALLET_TRANSFER_CAPABILITY_RE =
  /^(?:wallet|solana|agenc)\.(?:transfer|send|withdraw|swap|pay)(?:\.|$)/i;
const STAKE_OR_REWARDS_CAPABILITY_RE =
  /^(?:wallet|solana|agenc)\.(?:stake|unstake|delegate|undelegate|reward|rewards|claim)(?:\.|$)/i;
const DESTRUCTIVE_HOST_MUTATION_CAPABILITY_RE =
  /^system\.(?:delete|writeFile|execute|open|applescript)(?:\.|$)/i;
const NETWORK_EGRESS_CAPABILITY_RE =
  /^(?:system\.http|system\.bash|desktop\.bash|playwright\.)/i;
const CREDENTIAL_MARKER_RE =
  /\b(secret|api[_-]?key|token|password|private[_\s-]?key|seed\s+phrase|mnemonic)\b/i;
const WALLET_SIGNING_TEXT_RE =
  /\b(sign|authorize|approve)\b[\s\S]{0,48}\b(wallet|transaction|tx)\b/i;
const WALLET_TRANSFER_TEXT_RE =
  /\b(transfer|send|withdraw|pay)\b[\s\S]{0,48}\b(sol|token|fund|wallet|usdc|usdt)\b/i;
const STAKE_OR_REWARDS_TEXT_PATTERNS: readonly RegExp[] = [
  /\b(stake|unstake|undelegate)\b[\s\S]{0,48}\b(sol|token|tokens|validator|stake|staking|reward|rewards|yield|wallet)\b/i,
  /\b(delegate)\b[\s\S]{0,48}\b(stake|staking|validator|vote\s+account|sol|token|tokens|reward|rewards)\b/i,
  /\b(claim|reward|rewards)\b[\s\S]{0,48}\b(stake|staking|validator|sol|token|tokens|wallet|yield|epoch)\b/i,
  /\b(stake|staking|validator|yield|epoch)\b[\s\S]{0,48}\b(reward|rewards|claim|delegate|undelegate|unstake)\b/i,
];

interface HardBlockedTaskClassMatch {
  readonly taskClass: DelegationHardBlockedTaskClass;
  readonly source: DelegationHardBlockedMatchSource;
  readonly signal: string;
}

interface DecisionMetrics {
  readonly utilityScore: number;
  readonly decompositionBenefit: number;
  readonly coordinationOverhead: number;
  readonly latencyCostRisk: number;
  readonly safetyRisk: number;
  readonly confidence: number;
  readonly dependencyDepth: number;
  readonly wordCount: number;
  readonly subagentCount: number;
  readonly edgeCount: number;
  readonly parallelizableSubagentCount: number;
  readonly uniqueCapabilityCount: number;
}

export function resolveDelegationDecisionConfig(
  config?: DelegationDecisionConfig,
): ResolvedDelegationDecisionConfig {
  const mode = config?.mode === "handoff" || config?.mode === "hybrid"
    ? config.mode
    : DEFAULT_SUBAGENT_MODE;
  const hardBlockedTaskClasses = new Set<DelegationHardBlockedTaskClass>();
  const configuredHardBlocked = config?.hardBlockedTaskClasses;
  if (Array.isArray(configuredHardBlocked) && configuredHardBlocked.length > 0) {
    for (const taskClass of configuredHardBlocked) {
      if (
        taskClass === "wallet_signing" ||
        taskClass === "wallet_transfer" ||
        taskClass === "stake_or_rewards" ||
        taskClass === "destructive_host_mutation" ||
        taskClass === "credential_exfiltration"
      ) {
        hardBlockedTaskClasses.add(taskClass);
      }
    }
  } else {
    for (const taskClass of DEFAULT_HARD_BLOCKED_TASK_CLASSES) {
      hardBlockedTaskClasses.add(taskClass);
    }
  }
  return {
    enabled: config?.enabled === true,
    mode,
    scoreThreshold: clamp01(config?.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD),
    maxFanoutPerTurn: Math.max(
      1,
      Math.floor(config?.maxFanoutPerTurn ?? DEFAULT_MAX_FANOUT_PER_TURN),
    ),
    maxDepth: Math.max(1, Math.floor(config?.maxDepth ?? DEFAULT_MAX_DEPTH)),
    handoffMinPlannerConfidence: clamp01(
      config?.handoffMinPlannerConfidence ??
        DEFAULT_HANDOFF_MIN_PLANNER_CONFIDENCE,
    ),
    hardBlockedTaskClasses,
  };
}

export function assessDelegationDecision(
  input: DelegationDecisionInput,
): DelegationDecision {
  const resolvedConfig = resolveDelegationDecisionConfig(input.config);
  const metrics = computeDecisionMetrics(input);
  const hardBlockedMatch = detectHardBlockedTaskClass(input, resolvedConfig);
  const hardBlockedTaskClass = hardBlockedMatch?.taskClass ?? null;
  const plannerConfidence = clamp01(
    input.plannerConfidence ?? metrics.confidence,
  );
  const diagnostics = buildDiagnostics(
    metrics,
    input,
    resolvedConfig,
    plannerConfidence,
    hardBlockedTaskClass,
    hardBlockedMatch,
  );

  if (!resolvedConfig.enabled) {
    return buildDecision({
      shouldDelegate: false,
      reason: "delegation_disabled",
      threshold: resolvedConfig.scoreThreshold,
      metrics,
      hardBlockedMatch,
      diagnostics,
    });
  }

  if (metrics.subagentCount === 0) {
    return buildDecision({
      shouldDelegate: false,
      reason: "no_subagent_steps",
      threshold: resolvedConfig.scoreThreshold,
      metrics,
      hardBlockedMatch,
      diagnostics,
    });
  }

  if (hardBlockedTaskClass) {
    return buildDecision({
      shouldDelegate: false,
      reason: "hard_blocked_task_class",
      threshold: resolvedConfig.scoreThreshold,
      metrics,
      hardBlockedMatch,
      diagnostics,
    });
  }

  if (metrics.subagentCount > resolvedConfig.maxFanoutPerTurn) {
    return buildDecision({
      shouldDelegate: false,
      reason: "fanout_exceeded",
      threshold: resolvedConfig.scoreThreshold,
      metrics,
      hardBlockedMatch,
      diagnostics,
    });
  }

  if (
    resolvedConfig.mode === "handoff" &&
    plannerConfidence < resolvedConfig.handoffMinPlannerConfidence
  ) {
    return buildDecision({
      shouldDelegate: false,
      reason: "handoff_confidence_below_threshold",
      threshold: resolvedConfig.scoreThreshold,
      metrics,
      hardBlockedMatch,
      diagnostics,
    });
  }

  const trivialRequest =
    metrics.wordCount <= TRIVIAL_MAX_WORDS &&
    metrics.subagentCount <= 1 &&
    input.totalSteps <= 2 &&
    input.complexityScore <= 4;
  if (trivialRequest) {
    return buildDecision({
      shouldDelegate: false,
      reason: "trivial_request",
      threshold: resolvedConfig.scoreThreshold,
      metrics,
      hardBlockedMatch,
      diagnostics,
    });
  }

  const singleHopRequest =
    metrics.subagentCount <= 1 &&
    metrics.dependencyDepth <= 1 &&
    metrics.parallelizableSubagentCount === 0 &&
    metrics.wordCount <= SINGLE_HOP_MAX_WORDS &&
    input.complexityScore <= 6;
  if (singleHopRequest) {
    return buildDecision({
      shouldDelegate: false,
      reason: "single_hop_request",
      threshold: resolvedConfig.scoreThreshold,
      metrics,
      hardBlockedMatch,
      diagnostics,
    });
  }

  if (metrics.safetyRisk >= SAFETY_RISK_HARD_BLOCK_THRESHOLD) {
    return buildDecision({
      shouldDelegate: false,
      reason: "safety_risk_high",
      threshold: resolvedConfig.scoreThreshold,
      metrics,
      hardBlockedMatch,
      diagnostics,
    });
  }

  if (metrics.utilityScore < resolvedConfig.scoreThreshold) {
    return buildDecision({
      shouldDelegate: false,
      reason: "score_below_threshold",
      threshold: resolvedConfig.scoreThreshold,
      metrics,
      hardBlockedMatch,
      diagnostics,
    });
  }

  return buildDecision({
    shouldDelegate: true,
    reason: "approved",
    threshold: resolvedConfig.scoreThreshold,
    metrics,
    hardBlockedMatch,
    diagnostics,
  });
}

function buildDecision(input: {
  shouldDelegate: boolean;
  reason: DelegationDecisionReason;
  threshold: number;
  metrics: DecisionMetrics;
  hardBlockedMatch: HardBlockedTaskClassMatch | null;
  diagnostics: Readonly<Record<string, number | boolean>>;
}): DelegationDecision {
  return {
    shouldDelegate: input.shouldDelegate,
    reason: input.reason,
    threshold: input.threshold,
    utilityScore: input.metrics.utilityScore,
    decompositionBenefit: input.metrics.decompositionBenefit,
    coordinationOverhead: input.metrics.coordinationOverhead,
    latencyCostRisk: input.metrics.latencyCostRisk,
    safetyRisk: input.metrics.safetyRisk,
    confidence: input.metrics.confidence,
    hardBlockedTaskClass: input.hardBlockedMatch?.taskClass ?? null,
    hardBlockedTaskClassSource: input.hardBlockedMatch?.source ?? null,
    hardBlockedTaskClassSignal: input.hardBlockedMatch?.signal ?? null,
    diagnostics: input.diagnostics,
  };
}

function buildDiagnostics(
  metrics: DecisionMetrics,
  input: DelegationDecisionInput,
  config: ResolvedDelegationDecisionConfig,
  plannerConfidence: number,
  hardBlockedTaskClass: DelegationHardBlockedTaskClass | null,
  hardBlockedMatch?: HardBlockedTaskClassMatch | null,
): Readonly<Record<string, number | boolean>> {
  return {
    complexityScore: input.complexityScore,
    plannerConfidence,
    totalSteps: input.totalSteps,
    synthesisSteps: input.synthesisSteps,
    subagentSteps: metrics.subagentCount,
    edgeCount: metrics.edgeCount,
    dependencyDepth: metrics.dependencyDepth,
    parallelizableSubagentSteps: metrics.parallelizableSubagentCount,
    uniqueCapabilityCount: metrics.uniqueCapabilityCount,
    wordCount: metrics.wordCount,
    maxFanoutPerTurn: config.maxFanoutPerTurn,
    maxDepth: config.maxDepth,
    modeHandoff: config.mode === "handoff",
    handoffMinPlannerConfidence: config.handoffMinPlannerConfidence,
    hasHardBlockedTaskClass: hardBlockedTaskClass !== null,
    hardBlockedTaskClassMatchedByCapability:
      hardBlockedMatch?.source === "capability",
    hardBlockedTaskClassMatchedByText: hardBlockedMatch?.source === "text",
    hardBlockedTaskClassWalletSigning:
      hardBlockedTaskClass === "wallet_signing",
    hardBlockedTaskClassWalletTransfer:
      hardBlockedTaskClass === "wallet_transfer",
    hardBlockedTaskClassStakeOrRewards:
      hardBlockedTaskClass === "stake_or_rewards",
    hardBlockedTaskClassDestructiveHostMutation:
      hardBlockedTaskClass === "destructive_host_mutation",
    hardBlockedTaskClassCredentialExfiltration:
      hardBlockedTaskClass === "credential_exfiltration",
    threshold: config.scoreThreshold,
  };
}

function detectHardBlockedTaskClass(
  input: DelegationDecisionInput,
  config: ResolvedDelegationDecisionConfig,
): HardBlockedTaskClassMatch | null {
  if (config.hardBlockedTaskClasses.size === 0) return null;

  const capabilities = input.subagentSteps.flatMap((step) =>
    step.requiredToolCapabilities.map((capability) => capability.trim()),
  );
  const textBlob = [
    input.messageText,
    ...input.subagentSteps.map((step) => step.name),
    ...input.subagentSteps.map((step) => step.maxBudgetHint),
    ...input.subagentSteps.flatMap((step) => step.acceptanceCriteria),
    ...input.subagentSteps.flatMap((step) => step.contextRequirements),
  ].join("\n");

  if (config.hardBlockedTaskClasses.has("wallet_signing")) {
    const capabilityMatch = findCapabilityMatch(
      capabilities,
      WALLET_SIGNING_CAPABILITY_RE,
    );
    if (capabilityMatch) {
      return buildHardBlockedMatch(
        "wallet_signing",
        "capability",
        capabilityMatch,
      );
    }
    const textMatch = findTextMatch(textBlob, [WALLET_SIGNING_TEXT_RE]);
    if (textMatch) {
      return buildHardBlockedMatch("wallet_signing", "text", textMatch);
    }
  }

  if (config.hardBlockedTaskClasses.has("wallet_transfer")) {
    const capabilityMatch = findCapabilityMatch(
      capabilities,
      WALLET_TRANSFER_CAPABILITY_RE,
    );
    if (capabilityMatch) {
      return buildHardBlockedMatch(
        "wallet_transfer",
        "capability",
        capabilityMatch,
      );
    }
    const textMatch = findTextMatch(textBlob, [WALLET_TRANSFER_TEXT_RE]);
    if (textMatch) {
      return buildHardBlockedMatch("wallet_transfer", "text", textMatch);
    }
  }

  if (config.hardBlockedTaskClasses.has("stake_or_rewards")) {
    const capabilityMatch = findCapabilityMatch(
      capabilities,
      STAKE_OR_REWARDS_CAPABILITY_RE,
    );
    if (capabilityMatch) {
      return buildHardBlockedMatch(
        "stake_or_rewards",
        "capability",
        capabilityMatch,
      );
    }
    const textMatch = findTextMatch(textBlob, STAKE_OR_REWARDS_TEXT_PATTERNS);
    if (textMatch) {
      return buildHardBlockedMatch("stake_or_rewards", "text", textMatch);
    }
  }

  if (config.hardBlockedTaskClasses.has("destructive_host_mutation")) {
    const capabilityMatch = findCapabilityMatch(
      capabilities,
      DESTRUCTIVE_HOST_MUTATION_CAPABILITY_RE,
    );
    if (capabilityMatch) {
      return buildHardBlockedMatch(
        "destructive_host_mutation",
        "capability",
        capabilityMatch,
      );
    }
  }

  if (
    config.hardBlockedTaskClasses.has("credential_exfiltration") &&
    CREDENTIAL_MARKER_RE.test(textBlob)
  ) {
    const capabilityMatch = findCapabilityMatch(
      capabilities,
      NETWORK_EGRESS_CAPABILITY_RE,
    );
    if (capabilityMatch) {
      return buildHardBlockedMatch(
        "credential_exfiltration",
        "capability",
        capabilityMatch,
      );
    }
  }

  return null;
}

function buildHardBlockedMatch(
  taskClass: DelegationHardBlockedTaskClass,
  source: DelegationHardBlockedMatchSource,
  signal: string,
): HardBlockedTaskClassMatch {
  return {
    taskClass,
    source,
    signal: summarizeHardBlockedSignal(signal),
  };
}

function findCapabilityMatch(
  capabilities: readonly string[],
  pattern: RegExp,
): string | null {
  for (const capability of capabilities) {
    if (pattern.test(capability)) {
      return capability;
    }
  }
  return null;
}

function findTextMatch(
  textBlob: string,
  patterns: readonly RegExp[],
): string | null {
  for (const pattern of patterns) {
    const match = textBlob.match(pattern);
    if (match?.[0]) {
      return match[0];
    }
  }
  return null;
}

function summarizeHardBlockedSignal(signal: string): string {
  const normalized = signal.replace(/\s+/g, " ").trim();
  if (normalized.length <= 96) {
    return normalized;
  }
  return `${normalized.slice(0, 93)}...`;
}

function computeDecisionMetrics(input: DelegationDecisionInput): DecisionMetrics {
  const wordCount = countWords(input.messageText);
  const subagentCount = input.subagentSteps.length;
  const subagentStepNames = input.subagentSteps.map((step) => step.name);
  const relevantEdges = filterRelevantSubagentEdges(subagentStepNames, input.edges);
  const edgeCount = relevantEdges.length;
  const dependencyDepth = estimateDependencyDepth(
    subagentStepNames,
    relevantEdges,
  );
  const parallelizableSubagentCount = input.subagentSteps.filter((step) =>
    step.canRunParallel
  ).length;

  const capabilities = input.subagentSteps.flatMap((step) =>
    step.requiredToolCapabilities
  );
  const uniqueCapabilityCount = new Set(capabilities).size;

  const avgAcceptanceCount = average(
    input.subagentSteps.map((step) => step.acceptanceCriteria.length),
  );
  const avgContextRequirementCount = average(
    input.subagentSteps.map((step) => step.contextRequirements.length),
  );
  const avgBudgetMinutes = average(
    input.subagentSteps.map((step) => parseBudgetHintMinutes(step.maxBudgetHint)),
  );
  const budgetRisk = clamp01(avgBudgetMinutes / 30);

  const {
    highRiskCount,
    moderateRiskCount,
    riskySubagentCount,
    parallelRiskySubagentCount,
  } = countRiskyCapabilities(input.subagentSteps);

  const decompositionBenefit = clamp01(
    0.08 +
      Math.min(0.4, subagentCount * 0.18) +
      Math.min(0.2, parallelizableSubagentCount * 0.08) +
      Math.min(0.18, uniqueCapabilityCount * 0.035) +
      Math.min(0.14, input.complexityScore * 0.02),
  );

  const sequentialPhaseCount = Math.max(0, subagentCount - parallelizableSubagentCount);
  const dependencyDepthPenalty = Math.max(0, dependencyDepth - 2);
  const coordinationOverhead = clamp01(
    0.05 +
      Math.max(0, sequentialPhaseCount - 2) * 0.06 +
      parallelizableSubagentCount * 0.11 +
      edgeCount * 0.025 +
      dependencyDepthPenalty * 0.03,
  );

  const latencyCostRisk = clamp01(
    0.05 +
      subagentCount * 0.065 +
      dependencyDepthPenalty * 0.035 +
      budgetRisk * 0.18 -
      parallelizableSubagentCount * 0.03,
  );

  const safetyRisk = clamp01(
    0.05 +
      highRiskCount * 0.22 +
      moderateRiskCount * 0.08 +
      Math.max(0, riskySubagentCount - 2) * 0.03 +
      parallelRiskySubagentCount * 0.04 +
      Math.max(0, uniqueCapabilityCount - 6) * 0.02,
  );

  const confidence = clamp01(
    0.34 +
      Math.min(0.2, avgAcceptanceCount * 0.05) +
      Math.min(0.16, avgContextRequirementCount * 0.05) +
      Math.min(0.14, uniqueCapabilityCount * 0.02) +
      Math.min(0.16, input.complexityScore * 0.025) -
      Math.max(0, dependencyDepth - 3) * 0.05,
  );

  const utilityScore = clamp01(
    decompositionBenefit * confidence -
      (coordinationOverhead * 0.4 +
        latencyCostRisk * 0.35 +
        safetyRisk * 0.25) +
      0.5,
  );

  return {
    utilityScore,
    decompositionBenefit,
    coordinationOverhead,
    latencyCostRisk,
    safetyRisk,
    confidence,
    dependencyDepth,
    wordCount,
    subagentCount,
    edgeCount,
    parallelizableSubagentCount,
    uniqueCapabilityCount,
  };
}

function filterRelevantSubagentEdges(
  stepNames: readonly string[],
  edges: readonly WorkflowGraphEdge[],
): WorkflowGraphEdge[] {
  if (stepNames.length === 0 || edges.length === 0) return [];
  const stepSet = new Set(stepNames);
  return edges.filter((edge) => stepSet.has(edge.from) && stepSet.has(edge.to));
}

function estimateDependencyDepth(
  stepNames: readonly string[],
  edges: readonly WorkflowGraphEdge[],
): number {
  if (stepNames.length === 0) return 0;
  const stepSet = new Set(stepNames);
  const incoming = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  const depth = new Map<string, number>();

  for (const stepName of stepNames) {
    incoming.set(stepName, 0);
    outgoing.set(stepName, []);
    depth.set(stepName, 1);
  }

  for (const edge of edges) {
    if (!stepSet.has(edge.from) || !stepSet.has(edge.to)) continue;
    outgoing.get(edge.from)!.push(edge.to);
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [stepName, incomingCount] of incoming.entries()) {
    if (incomingCount === 0) queue.push(stepName);
  }

  let visited = 0;
  let maxDepth = 1;
  while (queue.length > 0) {
    const stepName = queue.shift()!;
    visited++;
    const currentDepth = depth.get(stepName) ?? 1;
    maxDepth = Math.max(maxDepth, currentDepth);
    for (const next of outgoing.get(stepName) ?? []) {
      const nextDepth = Math.max(depth.get(next) ?? 1, currentDepth + 1);
      depth.set(next, nextDepth);
      const nextIncoming = (incoming.get(next) ?? 0) - 1;
      incoming.set(next, nextIncoming);
      if (nextIncoming === 0) queue.push(next);
    }
  }

  // Guard against cyclic graphs in planner output.
  if (visited !== stepNames.length) {
    return stepNames.length + 1;
  }
  return maxDepth;
}

function countRiskyCapabilities(
  subagentSteps: readonly DelegationSubagentStepProfile[],
): {
  highRiskCount: number;
  moderateRiskCount: number;
  riskySubagentCount: number;
  parallelRiskySubagentCount: number;
} {
  const highRiskCapabilities = new Set<string>();
  const moderateRiskCapabilities = new Set<string>();
  let riskySubagentCount = 0;
  let parallelRiskySubagentCount = 0;

  for (const step of subagentSteps) {
    let stepHasRiskyCapability = false;
    for (const rawCapability of step.requiredToolCapabilities) {
      const capability = rawCapability.trim();
      if (
        HIGH_RISK_CAPABILITY_PATTERNS.some((pattern) => pattern.test(capability))
      ) {
        highRiskCapabilities.add(capability);
        stepHasRiskyCapability = true;
        continue;
      }
      if (
        MODERATE_RISK_CAPABILITY_PATTERNS.some((pattern) =>
          pattern.test(capability)
        )
      ) {
        moderateRiskCapabilities.add(capability);
        stepHasRiskyCapability = true;
      }
    }

    if (stepHasRiskyCapability) {
      riskySubagentCount++;
      if (step.canRunParallel) {
        parallelRiskySubagentCount++;
      }
    }
  }

  return {
    highRiskCount: highRiskCapabilities.size,
    moderateRiskCount: moderateRiskCapabilities.size,
    riskySubagentCount,
    parallelRiskySubagentCount,
  };
}

function parseBudgetHintMinutes(hint: string): number {
  const normalized = hint.trim().toLowerCase();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(ms|s|sec|m|min|h|hr)?/);
  if (!match) return 5;
  const value = Number.parseFloat(match[1] ?? "0");
  if (!Number.isFinite(value) || value <= 0) return 5;
  const unit = match[2] ?? "m";
  if (unit === "ms") return value / 60_000;
  if (unit === "s" || unit === "sec") return value / 60;
  if (unit === "h" || unit === "hr") return value * 60;
  return value;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
