/**
 * Verifier lane (Executor + Critic) with bounded revision loop.
 *
 * @module
 */

import type { MetricsProvider } from '../task/types.js';
import type {
  RevisionInput,
  Task,
  VerifierExecutionResult,
  VerifierInput,
  VerifierLaneConfig,
  VerifierPolicyConfig,
  VerifierTaskTypePolicy,
  VerifierVerdictPayload,
  VerifierEscalationMetadata,
} from './types.js';
import {
  scoreTaskRisk,
  type TaskRiskScoreResult,
} from './risk-scoring.js';
import {
  allocateVerificationBudget,
  type VerificationBudgetDecision,
} from './verification-budget.js';

const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MAX_VERIFICATION_RETRIES = 1;
const DEFAULT_MAX_VERIFICATION_DURATION_MS = 30_000;
const DEFAULT_REVISION_DELAY_MS = 0;

export const VERIFIER_METRIC_NAMES = {
  CHECKS_TOTAL: 'agenc.verifier.checks.total',
  PASSES_TOTAL: 'agenc.verifier.passes.total',
  FAILS_TOTAL: 'agenc.verifier.fails.total',
  NEEDS_REVISION_TOTAL: 'agenc.verifier.needs_revision.total',
  DISAGREEMENTS_TOTAL: 'agenc.verifier.disagreements.total',
  REVISIONS_TOTAL: 'agenc.verifier.revisions.total',
  ESCALATIONS_TOTAL: 'agenc.verifier.escalations.total',
  ADDED_LATENCY_MS: 'agenc.verifier.added_latency_ms',
  ADAPTIVE_RISK_SCORE: 'agenc.verifier.adaptive.risk_score',
  ADAPTIVE_RISK_TIER_TOTAL: 'agenc.verifier.adaptive.risk_tier.total',
  ADAPTIVE_MAX_RETRIES: 'agenc.verifier.adaptive.max_retries',
  ADAPTIVE_MAX_DURATION_MS: 'agenc.verifier.adaptive.max_duration_ms',
  ADAPTIVE_MAX_COST_LAMPORTS: 'agenc.verifier.adaptive.max_cost_lamports',
  ADAPTIVE_DISABLED_TOTAL: 'agenc.verifier.adaptive.disabled.total',
} as const;

export interface VerifierLaneMetrics {
  checks: number;
  passes: number;
  fails: number;
  needsRevision: number;
  disagreements: number;
  revisions: number;
  escalations: number;
  addedLatencyMs: number;
}

interface VerifierExecutionPolicy {
  enabled: boolean;
  minConfidence: number;
  maxVerificationRetries: number;
  maxVerificationDurationMs: number;
  maxAllowedSpendLamports: bigint;
  riskAssessment?: TaskRiskScoreResult;
  budgetDecision?: VerificationBudgetDecision;
}

export interface VerifierExecutorConfig {
  verifierConfig: VerifierLaneConfig;
  executeTask: (task: Task) => Promise<bigint[]>;
  reviseTask?: (input: RevisionInput) => Promise<bigint[]>;
  metrics?: MetricsProvider;
  onVerdict?: (task: Task, verdict: VerifierVerdictPayload, attempt: number) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class VerifierLaneEscalationError extends Error {
  readonly task: Task;
  readonly metadata: VerifierEscalationMetadata;
  readonly history: VerifierVerdictPayload[];

  constructor(
    task: Task,
    metadata: VerifierEscalationMetadata,
    history: VerifierVerdictPayload[],
  ) {
    super(`Verifier lane escalated: ${metadata.reason}`);
    this.name = 'VerifierLaneEscalationError';
    this.task = task;
    this.metadata = metadata;
    this.history = history;
  }
}

export class VerifierExecutor {
  private readonly config: VerifierLaneConfig;
  private readonly executeTask: (task: Task) => Promise<bigint[]>;
  private readonly reviseTask?: (input: RevisionInput) => Promise<bigint[]>;
  private readonly metrics?: MetricsProvider;
  private readonly onVerdict?: (task: Task, verdict: VerifierVerdictPayload, attempt: number) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private laneMetrics: VerifierLaneMetrics = {
    checks: 0,
    passes: 0,
    fails: 0,
    needsRevision: 0,
    disagreements: 0,
    revisions: 0,
    escalations: 0,
    addedLatencyMs: 0,
  };

  constructor(config: VerifierExecutorConfig) {
    this.config = config.verifierConfig;
    this.executeTask = config.executeTask;
    this.reviseTask = config.reviseTask;
    this.metrics = config.metrics;
    this.onVerdict = config.onVerdict;
    this.now = config.now ?? Date.now;
    this.sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Return true when verifier gating should run for this task.
   */
  shouldVerify(task: Task): boolean {
    return this.resolvePolicy(task).enabled;
  }

  /**
   * Execute task with verifier gate and bounded revision loop.
   */
  async execute(task: Task): Promise<VerifierExecutionResult> {
    const policy = this.resolvePolicy(task);
    const history: VerifierVerdictPayload[] = [];

    const output = await this.executeTask(task);

    if (!policy.enabled) {
      return {
        output,
        attempts: 0,
        revisions: 0,
        durationMs: 0,
        passed: true,
        escalated: false,
        history,
        lastVerdict: null,
        adaptiveRisk: this.toAdaptiveRiskSummary(policy),
      };
    }

    const startedAt = this.now();
    const deadline = startedAt + policy.maxVerificationDurationMs;
    let currentOutput = output;
    let revisions = 0;
    let lastVerdict: VerifierVerdictPayload | null = null;

    const maxAttempts = policy.maxVerificationRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      this.ensureSpendWithinBudget(
        task,
        attempt,
        policy.maxAllowedSpendLamports,
        startedAt,
        revisions,
        history,
        lastVerdict,
      );
      this.ensureWithinBudget(task, deadline, startedAt, revisions, history, lastVerdict);

      const verdictInput: VerifierInput = {
        task,
        output: currentOutput,
        attempt,
        history,
      };

      const verdict = await this.getVerdict(task, verdictInput, deadline, startedAt, revisions, history, lastVerdict);
      const normalized = this.normalizeVerdict(verdict, policy.minConfidence);
      history.push(normalized);
      lastVerdict = normalized;
      this.recordVerdictMetrics(normalized, attempt);
      this.onVerdict?.(task, normalized, attempt);

      if (normalized.verdict === 'pass') {
        const durationMs = this.now() - startedAt;
        this.laneMetrics.addedLatencyMs += durationMs;
        this.metrics?.histogram(VERIFIER_METRIC_NAMES.ADDED_LATENCY_MS, durationMs);

        return {
          output: currentOutput,
          attempts: history.length,
          revisions,
          durationMs,
          passed: true,
          escalated: false,
          history,
          lastVerdict,
          adaptiveRisk: this.toAdaptiveRiskSummary(policy),
        };
      }

      if (attempt >= maxAttempts) {
        this.escalate(task, 'verifier_failed', startedAt, revisions, history, lastVerdict);
      }

      const allowReexecute = this.config.reexecuteOnNeedsRevision === true;
      const shouldRevise = normalized.verdict === 'needs_revision';
      const canRevise = this.reviseTask !== undefined;
      if (shouldRevise && !canRevise && !allowReexecute) {
        this.escalate(task, 'revision_unavailable', startedAt, revisions, history, lastVerdict);
      }

      revisions++;
      this.laneMetrics.revisions++;
      this.metrics?.counter(VERIFIER_METRIC_NAMES.REVISIONS_TOTAL);

      const delayMs = Math.max(0, this.config.revisionDelayMs ?? DEFAULT_REVISION_DELAY_MS);
      if (delayMs > 0) {
        await this.sleepWithinBudget(task, delayMs, deadline, startedAt, revisions, history, lastVerdict);
      }

      this.ensureWithinBudget(task, deadline, startedAt, revisions, history, lastVerdict);

      if (canRevise && shouldRevise) {
        currentOutput = await this.runWithinBudget(
          () =>
            this.reviseTask!({
              task,
              previousOutput: currentOutput,
              verdict: normalized,
              revisionAttempt: revisions,
              history,
            }),
          deadline,
        );
      } else {
        currentOutput = await this.runWithinBudget(
          () => this.executeTask(task),
          deadline,
        );
      }
    }

    this.escalate(task, 'verifier_failed', startedAt, revisions, history, lastVerdict);
  }

  getMetrics(): VerifierLaneMetrics {
    return { ...this.laneMetrics };
  }

  private resolvePolicy(task: Task): VerifierExecutionPolicy {
    const policy = this.config.policy;
    const taskTypePolicy = this.getTaskTypePolicy(policy, task);

    let enabled = policy?.enabled ?? true;
    if (taskTypePolicy?.enabled !== undefined) {
      enabled = taskTypePolicy.enabled;
    }

    if (!enabled) {
      return {
        enabled: false,
        minConfidence: this.normalizeMinConfidence(this.config.minConfidence),
        maxVerificationRetries: this.normalizeRetries(this.config.maxVerificationRetries),
        maxVerificationDurationMs: this.normalizeDuration(this.config.maxVerificationDurationMs),
        maxAllowedSpendLamports:
          taskTypePolicy?.maxVerificationCostLamports ??
          task.reward * BigInt(this.normalizeRetries(this.config.maxVerificationRetries) + 1),
      };
    }

    const globalMinReward = policy?.minRewardLamports;
    if (globalMinReward !== undefined && task.reward < globalMinReward) {
      enabled = false;
    }

    const taskTypeMinReward = taskTypePolicy?.minRewardLamports;
    if (taskTypeMinReward !== undefined && task.reward < taskTypeMinReward) {
      enabled = false;
    }

    if (enabled && policy?.taskSelector && !policy.taskSelector(task)) {
      enabled = false;
    }

    const minConfidence = this.normalizeMinConfidence(
      taskTypePolicy?.minConfidence ?? this.config.minConfidence,
    );

    const maxVerificationRetries = this.normalizeRetries(
      taskTypePolicy?.maxVerificationRetries ?? this.config.maxVerificationRetries,
    );

    const maxVerificationDurationMs = this.normalizeDuration(
      taskTypePolicy?.maxVerificationDurationMs ?? this.config.maxVerificationDurationMs,
    );

    const staticPolicy: VerifierExecutionPolicy = {
      enabled,
      minConfidence,
      maxVerificationRetries,
      maxVerificationDurationMs,
      maxAllowedSpendLamports:
        taskTypePolicy?.maxVerificationCostLamports ??
        task.reward * BigInt(maxVerificationRetries + 1),
    };

    const adaptiveRisk = policy?.adaptiveRisk;
    if (adaptiveRisk?.enabled !== true) {
      return staticPolicy;
    }

    const riskAssessment = scoreTaskRisk(
      task,
      {
        nowMs: this.now(),
        verifierDisagreementRate:
          this.laneMetrics.checks > 0
            ? this.laneMetrics.disagreements / this.laneMetrics.checks
            : 0,
        rollbackRate: 0,
        taskTypeRiskMultiplier: taskTypePolicy?.riskMultiplier,
      },
      adaptiveRisk,
    );

    const budgetDecision = allocateVerificationBudget(task, riskAssessment, this.config);
    this.recordAdaptiveDecisionMetrics(riskAssessment, budgetDecision);

    return {
      enabled: budgetDecision.enabled,
      minConfidence: this.normalizeMinConfidence(budgetDecision.minConfidence),
      maxVerificationRetries: this.normalizeRetries(budgetDecision.maxVerificationRetries),
      maxVerificationDurationMs: this.normalizeDuration(budgetDecision.maxVerificationDurationMs),
      maxAllowedSpendLamports: budgetDecision.maxAllowedSpendLamports,
      riskAssessment,
      budgetDecision,
    };
  }

  private getTaskTypePolicy(
    policy: VerifierPolicyConfig | undefined,
    task: Task,
  ): VerifierTaskTypePolicy | undefined {
    if (!policy?.taskTypePolicies || task.taskType === undefined) {
      return undefined;
    }
    return policy.taskTypePolicies[task.taskType];
  }

  private normalizeVerdict(
    verdict: VerifierVerdictPayload,
    minConfidence: number,
  ): VerifierVerdictPayload {
    const normalizedConfidence = this.normalizeConfidence(verdict.confidence);
    const reasons = this.normalizeReasons(verdict.reasons);

    let normalizedVerdict = verdict.verdict;
    if (
      normalizedVerdict !== 'pass'
      && normalizedVerdict !== 'fail'
      && normalizedVerdict !== 'needs_revision'
    ) {
      normalizedVerdict = 'fail';
      reasons.push({
        code: 'invalid_verdict',
        message: `Unsupported verifier verdict: ${String(verdict.verdict)}`,
      });
    }

    if (normalizedVerdict === 'pass' && normalizedConfidence < minConfidence) {
      normalizedVerdict = 'fail';
      reasons.push({
        code: 'confidence_below_threshold',
        message: `Verifier confidence ${normalizedConfidence.toFixed(3)} below threshold ${minConfidence.toFixed(3)}`,
      });
    }

    return {
      verdict: normalizedVerdict,
      confidence: normalizedConfidence,
      reasons,
      metadata: verdict.metadata,
    };
  }

  private normalizeReasons(input: VerifierVerdictPayload['reasons']): VerifierVerdictPayload['reasons'] {
    if (!Array.isArray(input) || input.length === 0) {
      return [{ code: 'unspecified', message: 'Verifier returned no reasons' }];
    }

    const normalized: VerifierVerdictPayload['reasons'] = [];

    for (const reason of input.slice(0, 16)) {
      const code = this.normalizeReasonCode(reason.code);
      const message = String(reason.message ?? '').trim();
      if (message.length === 0) {
        normalized.push({ code, message: 'Verifier reason missing message' });
        continue;
      }
      normalized.push({
        code,
        message: message.slice(0, 256),
        field: reason.field?.slice(0, 64),
        severity: reason.severity,
      });
    }

    if (normalized.length === 0) {
      normalized.push({ code: 'unspecified', message: 'Verifier returned no usable reasons' });
    }

    return normalized;
  }

  private normalizeReasonCode(code: string): string {
    const trimmed = String(code ?? '').trim().toLowerCase();
    if (trimmed.length === 0) return 'unspecified';
    if (/^[a-z0-9_.-]{1,64}$/.test(trimmed)) return trimmed;
    return 'invalid_reason_code';
  }

  private normalizeConfidence(confidence: number): number {
    if (!Number.isFinite(confidence)) return 0;
    if (confidence < 0) return 0;
    if (confidence > 1) return 1;
    return confidence;
  }

  private normalizeMinConfidence(minConfidence: number | undefined): number {
    return this.normalizeConfidence(minConfidence ?? DEFAULT_MIN_CONFIDENCE);
  }

  private normalizeRetries(maxVerificationRetries: number | undefined): number {
    const retries = maxVerificationRetries ?? DEFAULT_MAX_VERIFICATION_RETRIES;
    if (!Number.isFinite(retries) || retries < 0) return DEFAULT_MAX_VERIFICATION_RETRIES;
    return Math.floor(retries);
  }

  private normalizeDuration(maxVerificationDurationMs: number | undefined): number {
    const duration = maxVerificationDurationMs ?? DEFAULT_MAX_VERIFICATION_DURATION_MS;
    if (!Number.isFinite(duration) || duration <= 0) return DEFAULT_MAX_VERIFICATION_DURATION_MS;
    return Math.floor(duration);
  }

  private async getVerdict(
    task: Task,
    input: VerifierInput,
    deadline: number,
    startedAt: number,
    revisions: number,
    history: VerifierVerdictPayload[],
    lastVerdict: VerifierVerdictPayload | null,
  ): Promise<VerifierVerdictPayload> {
    try {
      return await this.runWithinBudget(() => this.config.verifier.verify(input), deadline);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (err.message === 'verification timeout') {
        this.escalate(task, 'verifier_timeout', startedAt, revisions, history, lastVerdict);
      }
      if (this.config.failOnVerifierError) {
        this.escalate(task, 'verifier_error', startedAt, revisions, history, lastVerdict);
      }
      return {
        verdict: 'fail',
        confidence: 0,
        reasons: [{ code: 'verifier_error', message: err.message }],
      };
    }
  }

  private recordVerdictMetrics(verdict: VerifierVerdictPayload, attempt: number): void {
    this.laneMetrics.checks++;
    this.metrics?.counter(VERIFIER_METRIC_NAMES.CHECKS_TOTAL);

    if (verdict.verdict === 'pass') {
      this.laneMetrics.passes++;
      this.metrics?.counter(VERIFIER_METRIC_NAMES.PASSES_TOTAL);
    } else if (verdict.verdict === 'fail') {
      this.laneMetrics.fails++;
      this.metrics?.counter(VERIFIER_METRIC_NAMES.FAILS_TOTAL);
    } else {
      this.laneMetrics.needsRevision++;
      this.metrics?.counter(VERIFIER_METRIC_NAMES.NEEDS_REVISION_TOTAL);
    }

    if (attempt === 1 && verdict.verdict !== 'pass') {
      this.laneMetrics.disagreements++;
      this.metrics?.counter(VERIFIER_METRIC_NAMES.DISAGREEMENTS_TOTAL);
    }
  }

  private ensureWithinBudget(
    task: Task,
    deadline: number,
    startedAt: number,
    revisions: number,
    history: VerifierVerdictPayload[],
    lastVerdict: VerifierVerdictPayload | null,
  ): void {
    if (this.now() > deadline) {
      this.escalate(task, 'verifier_timeout', startedAt, revisions, history, lastVerdict);
    }
  }

  private ensureSpendWithinBudget(
    task: Task,
    attempt: number,
    maxAllowedSpendLamports: bigint,
    startedAt: number,
    revisions: number,
    history: VerifierVerdictPayload[],
    lastVerdict: VerifierVerdictPayload | null,
  ): void {
    const projected = task.reward * BigInt(Math.max(1, attempt));
    if (projected > maxAllowedSpendLamports) {
      this.escalate(task, 'verifier_budget_exhausted', startedAt, revisions, history, lastVerdict);
    }
  }

  private async sleepWithinBudget(
    task: Task,
    delayMs: number,
    deadline: number,
    startedAt: number,
    revisions: number,
    history: VerifierVerdictPayload[],
    lastVerdict: VerifierVerdictPayload | null,
  ): Promise<void> {
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      this.escalate(task, 'verifier_timeout', startedAt, revisions, history, lastVerdict);
    }
    await this.sleep(Math.min(delayMs, remaining));
  }

  private async runWithinBudget<T>(fn: () => Promise<T>, deadline: number): Promise<T> {
    const remaining = deadline - this.now();
    if (remaining <= 0) {
      throw new Error('verification timeout');
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fn(),
        new Promise<T>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('verification timeout')), remaining);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private escalate(
    task: Task,
    reason: VerifierEscalationMetadata['reason'],
    startedAt: number,
    revisions: number,
    history: VerifierVerdictPayload[],
    lastVerdict: VerifierVerdictPayload | null,
  ): never {
    this.laneMetrics.escalations++;
    this.metrics?.counter(VERIFIER_METRIC_NAMES.ESCALATIONS_TOTAL);

    const metadata: VerifierEscalationMetadata = {
      reason,
      attempts: history.length,
      revisions,
      durationMs: this.now() - startedAt,
      lastVerdict,
    };
    throw new VerifierLaneEscalationError(task, metadata, [...history]);
  }

  private recordAdaptiveDecisionMetrics(
    riskAssessment: TaskRiskScoreResult,
    budgetDecision: VerificationBudgetDecision,
  ): void {
    this.metrics?.histogram(
      VERIFIER_METRIC_NAMES.ADAPTIVE_RISK_SCORE,
      riskAssessment.score,
      { tier: riskAssessment.tier },
    );
    this.metrics?.counter(
      VERIFIER_METRIC_NAMES.ADAPTIVE_RISK_TIER_TOTAL,
      1,
      { tier: riskAssessment.tier },
    );
    this.metrics?.histogram(
      VERIFIER_METRIC_NAMES.ADAPTIVE_MAX_RETRIES,
      budgetDecision.maxVerificationRetries,
      { tier: budgetDecision.riskTier },
    );
    this.metrics?.histogram(
      VERIFIER_METRIC_NAMES.ADAPTIVE_MAX_DURATION_MS,
      budgetDecision.maxVerificationDurationMs,
      { tier: budgetDecision.riskTier },
    );
    this.metrics?.histogram(
      VERIFIER_METRIC_NAMES.ADAPTIVE_MAX_COST_LAMPORTS,
      Number(budgetDecision.maxAllowedSpendLamports),
      { tier: budgetDecision.riskTier },
    );

    if (!budgetDecision.enabled) {
      this.metrics?.counter(VERIFIER_METRIC_NAMES.ADAPTIVE_DISABLED_TOTAL, 1, {
        tier: budgetDecision.riskTier,
        reason: String(budgetDecision.metadata.reason ?? 'unknown'),
      });
    }
  }

  private toAdaptiveRiskSummary(policy: VerifierExecutionPolicy): VerifierExecutionResult['adaptiveRisk'] {
    if (!policy.riskAssessment || !policy.budgetDecision) {
      return undefined;
    }

    return {
      score: policy.riskAssessment.score,
      tier: policy.riskAssessment.tier,
      contributions: policy.riskAssessment.contributions.map((item) => ({
        feature: item.feature,
        value: item.value,
        weight: item.weight,
        contribution: item.contribution,
      })),
      budget: {
        maxVerificationRetries: policy.budgetDecision.maxVerificationRetries,
        maxVerificationDurationMs: policy.budgetDecision.maxVerificationDurationMs,
        minConfidence: policy.budgetDecision.minConfidence,
        maxAllowedSpendLamports: policy.budgetDecision.maxAllowedSpendLamports.toString(),
      },
    };
  }
}
