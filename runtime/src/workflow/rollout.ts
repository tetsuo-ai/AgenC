/**
 * Canary rollout controller for workflow variant deployment.
 *
 * @module
 */

import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { fnv1aHash as hashString } from "../utils/encoding.js";
import { clamp01, nonNegative } from "../utils/numeric.js";
import type { PolicyEngine } from "../policy/engine.js";

export interface WorkflowRolloutStopLossThresholds {
  maxFailureRateDelta: number;
  maxLatencyMsDelta: number;
  maxCostUnitsDelta: number;
}

export interface WorkflowRolloutConfig {
  enabled?: boolean;
  canaryPercent?: number;
  minCanarySamples?: number;
  stopLoss?: Partial<WorkflowRolloutStopLossThresholds>;
  seed?: number;
  logger?: Logger;
  policyEngine?: PolicyEngine;
  now?: () => number;
}

export interface WorkflowRolloutSample {
  success: boolean;
  latencyMs: number;
  costUnits: number;
}

export interface WorkflowRolloutVariantStats {
  variantId: string;
  sampleCount: number;
  successCount: number;
  failureCount: number;
  failureRate: number;
  meanLatencyMs: number;
  meanCostUnits: number;
}

export interface WorkflowRolloutDeltas {
  failureRateDelta: number;
  latencyMsDelta: number;
  costUnitsDelta: number;
}

export type WorkflowRolloutAction = "continue" | "promote" | "rollback";
export type WorkflowRolloutReason =
  | "insufficient_canary_samples"
  | "stop_loss_exceeded"
  | "policy_denied"
  | "already_promoted"
  | "already_rolled_back"
  | "disabled";

export interface WorkflowRolloutDecision {
  action: WorkflowRolloutAction;
  reason: WorkflowRolloutReason;
  timestampMs: number;
  baseline: WorkflowRolloutVariantStats;
  canary: WorkflowRolloutVariantStats;
  deltas: WorkflowRolloutDeltas;
}

interface MutableVariantStats {
  sampleCount: number;
  successCount: number;
  failureCount: number;
  latencySumMs: number;
  costSumUnits: number;
}

const DEFAULT_STOP_LOSS: WorkflowRolloutStopLossThresholds = {
  maxFailureRateDelta: 0.1,
  maxLatencyMsDelta: 2_000,
  maxCostUnitsDelta: 0.5,
};

function toVariantStats(
  variantId: string,
  value: MutableVariantStats | undefined,
): WorkflowRolloutVariantStats {
  const sampleCount = value?.sampleCount ?? 0;
  const successCount = value?.successCount ?? 0;
  const failureCount = value?.failureCount ?? 0;

  return {
    variantId,
    sampleCount,
    successCount,
    failureCount,
    failureRate: sampleCount > 0 ? failureCount / sampleCount : 0,
    meanLatencyMs:
      sampleCount > 0 ? (value?.latencySumMs ?? 0) / sampleCount : 0,
    meanCostUnits:
      sampleCount > 0 ? (value?.costSumUnits ?? 0) / sampleCount : 0,
  };
}

export class WorkflowCanaryRollout {
  private readonly enabled: boolean;
  private readonly canaryPercent: number;
  private readonly minCanarySamples: number;
  private readonly stopLoss: WorkflowRolloutStopLossThresholds;
  private readonly seed: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly policyEngine?: PolicyEngine;

  private status: "canary" | "promoted" | "rolled_back" = "canary";
  private lastRollbackDecision: WorkflowRolloutDecision | null = null;
  private readonly stats = new Map<string, MutableVariantStats>();

  constructor(
    readonly baselineVariantId: string,
    readonly canaryVariantId: string,
    config: WorkflowRolloutConfig = {},
  ) {
    this.enabled = config.enabled ?? true;
    this.canaryPercent = clamp01(config.canaryPercent ?? 0.2);
    this.minCanarySamples = Math.max(
      1,
      Math.floor(config.minCanarySamples ?? 20),
    );
    this.stopLoss = {
      ...DEFAULT_STOP_LOSS,
      ...(config.stopLoss ?? {}),
    };
    this.seed = config.seed ?? 17;
    this.logger = config.logger ?? silentLogger;
    this.now = config.now ?? Date.now;
    this.policyEngine = config.policyEngine;
  }

  getStatus(): "canary" | "promoted" | "rolled_back" {
    return this.status;
  }

  route(requestKey: string): string {
    if (!this.enabled) return this.baselineVariantId;
    if (this.status === "rolled_back") return this.baselineVariantId;
    if (this.status === "promoted") return this.canaryVariantId;

    const unit = hashString(`${this.seed}:${requestKey}`) / 0xffff_ffff;
    return unit < this.canaryPercent
      ? this.canaryVariantId
      : this.baselineVariantId;
  }

  recordSample(variantId: string, sample: WorkflowRolloutSample): void {
    const bucket = this.stats.get(variantId) ?? {
      sampleCount: 0,
      successCount: 0,
      failureCount: 0,
      latencySumMs: 0,
      costSumUnits: 0,
    };

    bucket.sampleCount += 1;
    if (sample.success) {
      bucket.successCount += 1;
    } else {
      bucket.failureCount += 1;
    }
    bucket.latencySumMs += nonNegative(sample.latencyMs);
    bucket.costSumUnits += nonNegative(sample.costUnits);

    this.stats.set(variantId, bucket);
  }

  evaluate(): WorkflowRolloutDecision {
    if (!this.enabled) {
      return this.buildDecision("continue", "disabled");
    }

    if (this.status === "rolled_back" && this.lastRollbackDecision) {
      return this.lastRollbackDecision;
    }

    if (this.status === "promoted") {
      return this.buildDecision("promote", "already_promoted");
    }

    const canaryStats = toVariantStats(
      this.canaryVariantId,
      this.stats.get(this.canaryVariantId),
    );
    if (canaryStats.sampleCount < this.minCanarySamples) {
      return this.buildDecision("continue", "insufficient_canary_samples");
    }

    const deltas = this.buildDeltas();
    const shouldRollback =
      deltas.failureRateDelta > this.stopLoss.maxFailureRateDelta ||
      deltas.latencyMsDelta > this.stopLoss.maxLatencyMsDelta ||
      deltas.costUnitsDelta > this.stopLoss.maxCostUnitsDelta;

    if (shouldRollback) {
      return this.rollback("stop_loss_exceeded");
    }

    if (this.policyEngine) {
      const policyDecision = this.policyEngine.evaluate({
        type: "custom",
        name: "workflow.rollout.promote",
        access: "write",
        metadata: {
          canaryVariantId: this.canaryVariantId,
          baselineVariantId: this.baselineVariantId,
          deltas,
        },
      });

      if (!policyDecision.allowed) {
        this.logger.warn("Workflow rollout promotion denied by policy engine");
        return this.rollback("policy_denied");
      }
    }

    this.status = "promoted";
    return this.buildDecision("promote", "already_promoted");
  }

  rollback(
    reason: WorkflowRolloutReason = "stop_loss_exceeded",
  ): WorkflowRolloutDecision {
    if (this.status === "rolled_back" && this.lastRollbackDecision) {
      return this.lastRollbackDecision;
    }

    this.status = "rolled_back";
    const decision = this.buildDecision(
      "rollback",
      reason === "policy_denied" ? reason : "stop_loss_exceeded",
    );
    this.lastRollbackDecision = decision;
    this.logger.warn(
      `Workflow rollout rolled back to baseline (${decision.reason})`,
    );
    return decision;
  }

  private buildDeltas(): WorkflowRolloutDeltas {
    const baseline = toVariantStats(
      this.baselineVariantId,
      this.stats.get(this.baselineVariantId),
    );
    const canary = toVariantStats(
      this.canaryVariantId,
      this.stats.get(this.canaryVariantId),
    );

    return {
      failureRateDelta: canary.failureRate - baseline.failureRate,
      latencyMsDelta: canary.meanLatencyMs - baseline.meanLatencyMs,
      costUnitsDelta: canary.meanCostUnits - baseline.meanCostUnits,
    };
  }

  private buildDecision(
    action: WorkflowRolloutAction,
    reason: WorkflowRolloutReason,
  ): WorkflowRolloutDecision {
    const baseline = toVariantStats(
      this.baselineVariantId,
      this.stats.get(this.baselineVariantId),
    );
    const canary = toVariantStats(
      this.canaryVariantId,
      this.stats.get(this.canaryVariantId),
    );

    return {
      action,
      reason,
      timestampMs: this.now(),
      baseline,
      canary,
      deltas: {
        failureRateDelta: canary.failureRate - baseline.failureRate,
        latencyMsDelta: canary.meanLatencyMs - baseline.meanLatencyMs,
        costUnitsDelta: canary.meanCostUnits - baseline.meanCostUnits,
      },
    };
  }
}
