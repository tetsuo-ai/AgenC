/**
 * Delegation learning primitives: trajectory schema + online bandit tuner.
 *
 * Runtime components only emit normalized trajectories and consume bandit
 * selections. Trainer/offline optimization stays decoupled from execution.
 *
 * @module
 */

export const DELEGATION_TRAJECTORY_SCHEMA_VERSION = 1 as const;

export type DelegationTrajectoryTurnType = "parent" | "child";

export interface DelegationTrajectoryStateFeatures {
  readonly sessionId: string;
  readonly contextClusterId: string;
  readonly complexityScore: number;
  readonly plannerStepCount: number;
  readonly subagentStepCount: number;
  readonly deterministicStepCount: number;
  readonly synthesisStepCount: number;
  readonly dependencyDepth: number;
  readonly fanout: number;
}

export interface DelegationTrajectoryAction {
  readonly delegated: boolean;
  readonly strategyArmId: string;
  readonly threshold: number;
  readonly selectedTools: readonly string[];
  readonly childConfig: {
    readonly maxDepth: number;
    readonly maxFanoutPerTurn: number;
    readonly timeoutMs: number;
  };
}

export interface DelegationTrajectoryImmediateOutcome {
  readonly qualityProxy: number;
  readonly tokenCost: number;
  readonly latencyMs: number;
  readonly errorCount: number;
  readonly errorClass?: string;
}

export interface DelegationTrajectoryFinalReward {
  readonly value: number;
  readonly qualityComponent: number;
  readonly costPenalty: number;
  readonly latencyPenalty: number;
  readonly errorPenalty: number;
}

export interface DelegationTrajectoryRecord {
  readonly schemaVersion: typeof DELEGATION_TRAJECTORY_SCHEMA_VERSION;
  readonly traceId: string;
  readonly turnId: string;
  readonly parentTurnId?: string;
  readonly turnType: DelegationTrajectoryTurnType;
  readonly timestampMs: number;
  readonly stateFeatures: DelegationTrajectoryStateFeatures;
  readonly action: DelegationTrajectoryAction;
  readonly immediateOutcome: DelegationTrajectoryImmediateOutcome;
  readonly finalReward: DelegationTrajectoryFinalReward;
  readonly metadata?: Readonly<Record<string, string | number | boolean>>;
}

export interface DelegationTrajectorySink {
  record(record: DelegationTrajectoryRecord): void;
}

export interface InMemoryDelegationTrajectorySinkConfig {
  readonly maxRecords?: number;
}

export class InMemoryDelegationTrajectorySink implements DelegationTrajectorySink {
  private readonly maxRecords: number;
  private readonly records: DelegationTrajectoryRecord[] = [];

  constructor(config: InMemoryDelegationTrajectorySinkConfig = {}) {
    this.maxRecords = Math.max(1, Math.floor(config.maxRecords ?? 10_000));
  }

  record(record: DelegationTrajectoryRecord): void {
    this.records.push(record);
    if (this.records.length <= this.maxRecords) return;
    this.records.splice(0, this.records.length - this.maxRecords);
  }

  snapshot(): readonly DelegationTrajectoryRecord[] {
    return [...this.records];
  }

  clear(): void {
    this.records.splice(0, this.records.length);
  }
}

export interface DelegationFinalRewardInput {
  readonly qualityProxy: number;
  readonly tokenCost: number;
  readonly latencyMs: number;
  readonly errorCount: number;
}

export interface DelegationUsefulnessProxyInput {
  readonly delegated: boolean;
  readonly stopReason: string;
  readonly failedToolCalls: number;
  readonly estimatedRecallsAvoided: number;
  readonly verifier: {
    readonly performed: boolean;
    readonly overall: "pass" | "retry" | "fail" | "skipped";
    readonly confidence: number;
  };
  readonly reward: DelegationTrajectoryFinalReward;
}

export interface DelegationUsefulnessProxyResult {
  readonly score: number;
  readonly useful: boolean;
}

export const DELEGATION_USEFULNESS_PROXY_VERSION = "v1" as const;
export const DEFAULT_USEFUL_DELEGATION_THRESHOLD = 0.62;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampNeg1To1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function normalizeCostPenalty(tokenCost: number): number {
  if (!Number.isFinite(tokenCost) || tokenCost <= 0) return 0;
  return clamp01(tokenCost / 120_000);
}

function normalizeLatencyPenalty(latencyMs: number): number {
  if (!Number.isFinite(latencyMs) || latencyMs <= 0) return 0;
  return clamp01(latencyMs / 90_000);
}

export function computeDelegationFinalReward(
  input: DelegationFinalRewardInput,
): DelegationTrajectoryFinalReward {
  const qualityComponent = clamp01(input.qualityProxy);
  const costPenalty = normalizeCostPenalty(input.tokenCost);
  const latencyPenalty = normalizeLatencyPenalty(input.latencyMs);
  const errorPenalty = clamp01(input.errorCount > 0 ? 1 : 0);

  const value = clampNeg1To1(
    qualityComponent -
      0.2 * costPenalty -
      0.2 * latencyPenalty -
      0.35 * errorPenalty,
  );

  return {
    value,
    qualityComponent,
    costPenalty,
    latencyPenalty,
    errorPenalty,
  };
}

export function computeUsefulDelegationProxy(
  input: DelegationUsefulnessProxyInput,
): DelegationUsefulnessProxyResult {
  if (!input.delegated) {
    return { score: 0, useful: false };
  }

  const rewardComponent = clamp01((input.reward.value + 1) / 2);
  const recallGain = Math.min(0.15, clamp01(input.estimatedRecallsAvoided / 4) * 0.15);
  const failedToolPenalty = Math.min(0.25, Math.max(0, input.failedToolCalls) * 0.06);
  const stopReasonPenalty = input.stopReason === "completed"
    ? 0
    : input.stopReason === "tool_calls"
      ? 0.15
      : 0.3;

  let verifierAdjustment = 0;
  if (input.verifier.performed) {
    if (input.verifier.overall === "pass") {
      verifierAdjustment = 0.1 + Math.min(0.05, clamp01(input.verifier.confidence) * 0.05);
    } else if (input.verifier.overall === "retry") {
      verifierAdjustment = -0.05;
    } else if (input.verifier.overall === "fail") {
      verifierAdjustment = -0.2;
    }
  }

  const score = clamp01(
    rewardComponent +
      recallGain +
      verifierAdjustment -
      failedToolPenalty -
      stopReasonPenalty,
  );

  return {
    score,
    useful:
      input.stopReason === "completed" &&
      score >= DEFAULT_USEFUL_DELEGATION_THRESHOLD,
  };
}

export type DelegationComplexityBucket =
  | "low"
  | "medium"
  | "high"
  | "critical";

export function deriveDelegationComplexityBucket(
  complexityScore: number,
): DelegationComplexityBucket {
  if (!Number.isFinite(complexityScore)) return "low";
  if (complexityScore >= 9) return "critical";
  if (complexityScore >= 7) return "high";
  if (complexityScore >= 4) return "medium";
  return "low";
}

export interface DelegationContextClusterInput {
  readonly complexityScore: number;
  readonly subagentStepCount: number;
  readonly hasHistory: boolean;
  readonly highRiskPlan: boolean;
}

export function deriveDelegationContextClusterId(
  input: DelegationContextClusterInput,
): string {
  const complexity = deriveDelegationComplexityBucket(input.complexityScore);
  const shape = input.subagentStepCount >= 3
    ? "fanout"
    : input.subagentStepCount >= 1
      ? "single"
      : "none";
  const history = input.hasHistory ? "history" : "fresh";
  const risk = input.highRiskPlan ? "highrisk" : "normal";
  return `${complexity}:${shape}:${history}:${risk}`;
}

export interface DelegationBanditArm {
  readonly id: string;
  readonly thresholdOffset?: number;
  readonly description?: string;
}

export interface DelegationBanditArmStats {
  readonly armId: string;
  readonly pulls: number;
  readonly meanReward: number;
  readonly totalReward: number;
  readonly lastReward?: number;
  readonly updatedAtMs: number;
}

export interface DelegationBanditSelection {
  readonly contextClusterId: string;
  readonly armId: string;
  readonly arm: DelegationBanditArm;
  readonly reason:
    | "initial_exploration"
    | "epsilon_exploration"
    | "ucb_exploitation"
    | "fallback";
  readonly exploration: boolean;
}

export interface DelegationBanditPolicyTunerConfig {
  readonly enabled?: boolean;
  readonly arms?: readonly DelegationBanditArm[];
  readonly epsilon?: number;
  readonly explorationBudget?: number;
  readonly minSamplesPerArm?: number;
  readonly ucbExplorationScale?: number;
  readonly now?: () => number;
  readonly random?: () => number;
}

interface MutableDelegationBanditArmStats {
  pulls: number;
  totalReward: number;
  meanReward: number;
  lastReward?: number;
  updatedAtMs: number;
}

interface MutableDelegationBanditClusterStats {
  totalPulls: number;
  arms: Map<string, MutableDelegationBanditArmStats>;
}

const DEFAULT_BANDIT_ARMS: readonly DelegationBanditArm[] = [
  {
    id: "conservative",
    thresholdOffset: 0.1,
    description: "Higher delegation threshold for risk-sensitive tasks",
  },
  {
    id: "balanced",
    thresholdOffset: 0,
    description: "Neutral threshold for general workloads",
  },
  {
    id: "aggressive",
    thresholdOffset: -0.1,
    description: "Lower threshold to favor broader delegation",
  },
];

export class DelegationBanditPolicyTuner {
  private readonly enabled: boolean;
  private readonly arms: Map<string, DelegationBanditArm>;
  private readonly epsilon: number;
  private readonly minSamplesPerArm: number;
  private readonly ucbExplorationScale: number;
  private explorationBudgetRemaining: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly clusters = new Map<string, MutableDelegationBanditClusterStats>();

  constructor(config: DelegationBanditPolicyTunerConfig = {}) {
    const configuredArms = (config.arms ?? DEFAULT_BANDIT_ARMS)
      .map((arm) => ({
        ...arm,
        id: arm.id.trim(),
      }))
      .filter((arm) => arm.id.length > 0);

    this.enabled = config.enabled !== false;
    this.arms = new Map(configuredArms.map((arm) => [arm.id, arm]));
    this.epsilon = clamp01(config.epsilon ?? 0.1);
    this.explorationBudgetRemaining = Math.max(
      0,
      Math.floor(config.explorationBudget ?? 500),
    );
    this.minSamplesPerArm = Math.max(1, Math.floor(config.minSamplesPerArm ?? 2));
    this.ucbExplorationScale = Math.max(0, config.ucbExplorationScale ?? 1.2);
    this.now = config.now ?? (() => Date.now());
    this.random = config.random ?? Math.random;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getArm(armId: string): DelegationBanditArm | undefined {
    return this.arms.get(armId);
  }

  applyThresholdOffset(baseThreshold: number, armId: string): number {
    const arm = this.arms.get(armId);
    if (!arm) return clamp01(baseThreshold);
    const offset = Number.isFinite(arm.thresholdOffset)
      ? (arm.thresholdOffset as number)
      : 0;
    return clamp01(baseThreshold + offset);
  }

  selectArm(input: {
    readonly contextClusterId: string;
    readonly preferredArmId?: string;
  }): DelegationBanditSelection {
    const candidateArms = this.listArms();
    if (candidateArms.length === 0) {
      const fallback: DelegationBanditArm = {
        id: "fallback",
        thresholdOffset: 0,
        description: "Fallback arm when none configured",
      };
      return {
        contextClusterId: input.contextClusterId,
        armId: fallback.id,
        arm: fallback,
        reason: "fallback",
        exploration: false,
      };
    }

    if (!this.enabled) {
      const preferred = input.preferredArmId
        ? this.arms.get(input.preferredArmId)
        : undefined;
      const arm = preferred ?? candidateArms[0]!;
      return {
        contextClusterId: input.contextClusterId,
        armId: arm.id,
        arm,
        reason: "fallback",
        exploration: false,
      };
    }

    const cluster = this.getOrCreateClusterStats(input.contextClusterId);

    for (const arm of candidateArms) {
      const stats = cluster.arms.get(arm.id);
      if (!stats || stats.pulls < this.minSamplesPerArm) {
        return {
          contextClusterId: input.contextClusterId,
          armId: arm.id,
          arm,
          reason: "initial_exploration",
          exploration: true,
        };
      }
    }

    const allowEpsilonExploration =
      this.explorationBudgetRemaining > 0 && this.random() < this.epsilon;
    if (allowEpsilonExploration) {
      const index = Math.floor(this.random() * candidateArms.length);
      const arm = candidateArms[Math.max(0, Math.min(candidateArms.length - 1, index))]!;
      this.explorationBudgetRemaining = Math.max(
        0,
        this.explorationBudgetRemaining - 1,
      );
      return {
        contextClusterId: input.contextClusterId,
        armId: arm.id,
        arm,
        reason: "epsilon_exploration",
        exploration: true,
      };
    }

    const totalPulls = Math.max(1, cluster.totalPulls);
    let bestArm = candidateArms[0]!;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const arm of candidateArms) {
      const stats = cluster.arms.get(arm.id);
      const pulls = Math.max(1, stats?.pulls ?? 1);
      const meanReward = stats?.meanReward ?? 0;
      const confidenceBonus = this.ucbExplorationScale *
        Math.sqrt(Math.log(totalPulls + 1) / pulls);
      const score = meanReward + confidenceBonus;
      if (score > bestScore) {
        bestScore = score;
        bestArm = arm;
      }
    }

    return {
      contextClusterId: input.contextClusterId,
      armId: bestArm.id,
      arm: bestArm,
      reason: "ucb_exploitation",
      exploration: false,
    };
  }

  recordOutcome(input: {
    readonly contextClusterId: string;
    readonly armId: string;
    readonly reward: number;
  }): void {
    if (!this.enabled) return;
    if (!this.arms.has(input.armId)) return;

    const reward = clampNeg1To1(input.reward);
    const cluster = this.getOrCreateClusterStats(input.contextClusterId);
    const now = this.now();
    const stats = cluster.arms.get(input.armId) ?? {
      pulls: 0,
      totalReward: 0,
      meanReward: 0,
      updatedAtMs: now,
    };

    stats.pulls += 1;
    stats.totalReward += reward;
    stats.meanReward = stats.totalReward / stats.pulls;
    stats.lastReward = reward;
    stats.updatedAtMs = now;
    cluster.totalPulls += 1;

    cluster.arms.set(input.armId, stats);
  }

  snapshot(input?: {
    readonly contextClusterId?: string;
  }): Readonly<Record<string, readonly DelegationBanditArmStats[]>> {
    const output: Record<string, readonly DelegationBanditArmStats[]> = {};
    for (const [clusterId, cluster] of this.clusters.entries()) {
      if (input?.contextClusterId && input.contextClusterId !== clusterId) {
        continue;
      }
      const rows = Array.from(cluster.arms.entries())
        .map(([armId, stats]) => ({
          armId,
          pulls: stats.pulls,
          meanReward: stats.meanReward,
          totalReward: stats.totalReward,
          lastReward: stats.lastReward,
          updatedAtMs: stats.updatedAtMs,
        }))
        .sort((a, b) => b.meanReward - a.meanReward);
      output[clusterId] = rows;
    }
    return output;
  }

  listArms(): readonly DelegationBanditArm[] {
    return Array.from(this.arms.values());
  }

  remainingExplorationBudget(): number {
    return this.explorationBudgetRemaining;
  }

  private getOrCreateClusterStats(
    clusterId: string,
  ): MutableDelegationBanditClusterStats {
    const existing = this.clusters.get(clusterId);
    if (existing) return existing;

    const created: MutableDelegationBanditClusterStats = {
      totalPulls: 0,
      arms: new Map<string, MutableDelegationBanditArmStats>(),
    };
    for (const armId of this.arms.keys()) {
      created.arms.set(armId, {
        pulls: 0,
        totalReward: 0,
        meanReward: 0,
        updatedAtMs: 0,
      });
    }
    this.clusters.set(clusterId, created);
    return created;
  }
}
