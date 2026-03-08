import type { DelegationBenchmarkSummary } from "../eval/delegation-benchmark.js";
import type { BackgroundRunQualityArtifact } from "../eval/background-run-quality.js";
import { evaluateBackgroundRunQualityGates } from "../eval/background-run-gates.js";
import { fnv1aHashUnit } from "../utils/encoding.js";
import type { GatewayAutonomyConfig } from "./types.js";

export const AUTONOMY_ROLLOUT_MANIFEST_SCHEMA_VERSION = 1 as const;

export type AutonomyRolloutFeature =
  | "backgroundRuns"
  | "multiAgent"
  | "notifications"
  | "replayGates"
  | "canaryRollout";

export type AutonomyIncidentScenario =
  | "stuck_run"
  | "split_brain"
  | "bad_compaction"
  | "webhook_failure"
  | "policy_regression";

export interface AutonomyRolloutDocRef {
  readonly path: string;
  readonly section: string;
}

export interface AutonomyDrillCheck {
  readonly validated: boolean;
  readonly testRefs: readonly string[];
}

export interface AutonomyRolloutManifest {
  readonly schemaVersion: typeof AUTONOMY_ROLLOUT_MANIFEST_SCHEMA_VERSION;
  readonly migration: {
    readonly playbook: AutonomyRolloutDocRef;
    readonly backwardCompatibilityGuarantee: string;
    readonly rollbackWindow: string;
  };
  readonly canary: {
    readonly strategy: AutonomyRolloutDocRef;
    readonly successCriteria: readonly string[];
    readonly automatedGate: string;
  };
  readonly runbooks: Record<AutonomyIncidentScenario, AutonomyRolloutDocRef>;
  readonly drills: Record<AutonomyIncidentScenario | "rollback", AutonomyDrillCheck>;
  readonly rollback: {
    readonly tested: boolean;
    readonly strategy: AutonomyRolloutDocRef;
    readonly testRefs: readonly string[];
  };
  readonly externalReview: {
    readonly security: boolean;
    readonly privacy: boolean;
    readonly compliance: boolean;
  };
}

export interface AutonomyObservedSloMetrics {
  readonly runStartLatencyMs: number;
  readonly updateCadenceMs: number;
  readonly completionAccuracyRate: number;
  readonly recoverySuccessRate: number;
  readonly stopLatencyMs: number;
  readonly eventLossRate: number;
}

export interface AutonomyRolloutViolation {
  readonly code: string;
  readonly message: string;
  readonly severity: "critical" | "high" | "medium";
}

export interface AutonomyExternalGate {
  readonly code: string;
  readonly message: string;
}

export interface AutonomyCanaryDecision {
  readonly allowed: boolean;
  readonly cohort: "disabled" | "canary" | "holdback";
  readonly sampleUnit?: number;
  readonly reason: string;
}

export interface AutonomyRolloutEvaluation {
  readonly limitedRolloutReady: boolean;
  readonly broadRolloutReady: boolean;
  readonly observed: AutonomyObservedSloMetrics | undefined;
  readonly violations: readonly AutonomyRolloutViolation[];
  readonly externalGates: readonly AutonomyExternalGate[];
}

export interface AutonomyRolloutEvaluationInput {
  readonly autonomy?: GatewayAutonomyConfig;
  readonly backgroundRunQualityArtifact?: BackgroundRunQualityArtifact;
  readonly delegationBenchmark?: DelegationBenchmarkSummary;
  readonly manifest?: AutonomyRolloutManifest;
}

const REQUIRED_FEATURE_FLAGS: readonly AutonomyRolloutFeature[] = [
  "backgroundRuns",
  "multiAgent",
  "notifications",
  "replayGates",
  "canaryRollout",
];

const REQUIRED_INCIDENT_SCENARIOS: readonly AutonomyIncidentScenario[] = [
  "stuck_run",
  "split_brain",
  "bad_compaction",
  "webhook_failure",
  "policy_regression",
];

const MULTI_AGENT_MIN_USEFUL_DELEGATION_RATE = 0.60;
const MULTI_AGENT_MAX_HARMFUL_DELEGATION_RATE = 0.30;
const MULTI_AGENT_MIN_QUALITY_DELTA = 0;
const MULTI_AGENT_MIN_PASS_AT_K_DELTA = 0;
const MULTI_AGENT_MIN_PASS_CARET_K_DELTA = 0;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, path: string): string {
  assert(typeof value === "string" && value.trim().length > 0, `${path} must be a non-empty string`);
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  assert(typeof value === "boolean", `${path} must be a boolean`);
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  assert(Array.isArray(value), `${path} must be an array`);
  return value.map((entry, index) => asString(entry, `${path}[${index}]`));
}

function parseDocRef(value: unknown, path: string): AutonomyRolloutDocRef {
  assert(isRecord(value), `${path} must be an object`);
  return {
    path: asString(value.path, `${path}.path`),
    section: asString(value.section, `${path}.section`),
  };
}

function parseDrillCheck(value: unknown, path: string): AutonomyDrillCheck {
  assert(isRecord(value), `${path} must be an object`);
  return {
    validated: asBoolean(value.validated, `${path}.validated`),
    testRefs: asStringArray(value.testRefs, `${path}.testRefs`),
  };
}

export function parseAutonomyRolloutManifest(
  value: unknown,
): AutonomyRolloutManifest {
  assert(isRecord(value), "autonomy rollout manifest must be an object");
  assert(
    value.schemaVersion === AUTONOMY_ROLLOUT_MANIFEST_SCHEMA_VERSION,
    `autonomy rollout manifest schemaVersion must be ${AUTONOMY_ROLLOUT_MANIFEST_SCHEMA_VERSION}`,
  );
  assert(isRecord(value.migration), "migration must be an object");
  assert(isRecord(value.canary), "canary must be an object");
  assert(isRecord(value.runbooks), "runbooks must be an object");
  assert(isRecord(value.drills), "drills must be an object");
  assert(isRecord(value.rollback), "rollback must be an object");
  assert(isRecord(value.externalReview), "externalReview must be an object");
  const runbooksValue = value.runbooks;
  const drillsValue = value.drills;

  const runbooks = Object.fromEntries(
    REQUIRED_INCIDENT_SCENARIOS.map((scenario) => [
      scenario,
      parseDocRef(runbooksValue[scenario], `runbooks.${scenario}`),
    ]),
  ) as Record<AutonomyIncidentScenario, AutonomyRolloutDocRef>;

  const drills = Object.fromEntries(
    [...REQUIRED_INCIDENT_SCENARIOS, "rollback"].map((scenario) => [
      scenario,
      parseDrillCheck(drillsValue[scenario], `drills.${scenario}`),
    ]),
  ) as Record<AutonomyIncidentScenario | "rollback", AutonomyDrillCheck>;

  return {
    schemaVersion: AUTONOMY_ROLLOUT_MANIFEST_SCHEMA_VERSION,
    migration: {
      playbook: parseDocRef(value.migration.playbook, "migration.playbook"),
      backwardCompatibilityGuarantee: asString(
        value.migration.backwardCompatibilityGuarantee,
        "migration.backwardCompatibilityGuarantee",
      ),
      rollbackWindow: asString(value.migration.rollbackWindow, "migration.rollbackWindow"),
    },
    canary: {
      strategy: parseDocRef(value.canary.strategy, "canary.strategy"),
      successCriteria: asStringArray(value.canary.successCriteria, "canary.successCriteria"),
      automatedGate: asString(value.canary.automatedGate, "canary.automatedGate"),
    },
    runbooks,
    drills,
    rollback: {
      tested: asBoolean(value.rollback.tested, "rollback.tested"),
      strategy: parseDocRef(value.rollback.strategy, "rollback.strategy"),
      testRefs: asStringArray(value.rollback.testRefs, "rollback.testRefs"),
    },
    externalReview: {
      security: asBoolean(value.externalReview.security, "externalReview.security"),
      privacy: asBoolean(value.externalReview.privacy, "externalReview.privacy"),
      compliance: asBoolean(value.externalReview.compliance, "externalReview.compliance"),
    },
  };
}

export function buildObservedAutonomySloMetrics(
  artifact: BackgroundRunQualityArtifact,
): AutonomyObservedSloMetrics {
  return {
    runStartLatencyMs: artifact.meanTimeToFirstAckMs,
    updateCadenceMs: artifact.meanTimeToFirstVerifiedUpdateMs,
    completionAccuracyRate: artifact.endStateCorrectnessScore,
    recoverySuccessRate: artifact.recoverySuccessRate,
    stopLatencyMs: artifact.meanStopLatencyMs,
    eventLossRate:
      artifact.runCount > 0 ? artifact.replayInconsistencies / artifact.runCount : 0,
  };
}

function evaluateAutonomyConfig(
  autonomy: GatewayAutonomyConfig | undefined,
): AutonomyRolloutViolation[] {
  if (!autonomy || autonomy.enabled === false) {
    return [
      {
        code: "autonomy.disabled",
        message: "Autonomy runtime is disabled in the gateway config.",
        severity: "critical",
      },
    ];
  }

  const violations: AutonomyRolloutViolation[] = [];
  for (const feature of REQUIRED_FEATURE_FLAGS) {
    if (autonomy.featureFlags?.[feature] === undefined) {
      violations.push({
        code: `autonomy.feature_flag.${feature}`,
        message: `autonomy.featureFlags.${feature} must be set explicitly.`,
        severity: "medium",
      });
    }
    if (autonomy.killSwitches?.[feature] === undefined) {
      violations.push({
        code: `autonomy.kill_switch.${feature}`,
        message: `autonomy.killSwitches.${feature} must be set explicitly.`,
        severity: "medium",
      });
    }
  }

  const slo = autonomy.slo;
  const requiredSloFields: Array<keyof NonNullable<GatewayAutonomyConfig["slo"]>> = [
    "runStartLatencyMs",
    "updateCadenceMs",
    "completionAccuracyRate",
    "recoverySuccessRate",
    "stopLatencyMs",
    "eventLossRate",
  ];
  for (const field of requiredSloFields) {
    if (typeof slo?.[field] !== "number") {
      violations.push({
        code: `autonomy.slo.${field}`,
        message: `autonomy.slo.${field} must be configured for production rollout.`,
        severity: "high",
      });
    }
  }

  if (!autonomy.canary) {
    violations.push({
      code: "autonomy.canary.missing",
      message: "Autonomy canary rollout policy must be configured.",
      severity: "high",
    });
  }

  return violations;
}

function evaluateManifest(
  manifest: AutonomyRolloutManifest | undefined,
): {
  violations: AutonomyRolloutViolation[];
  externalGates: AutonomyExternalGate[];
} {
  if (!manifest) {
    return {
      violations: [
        {
          code: "autonomy.manifest.missing",
          message: "Autonomy rollout manifest is missing.",
          severity: "critical",
        },
      ],
      externalGates: [],
    };
  }

  const violations: AutonomyRolloutViolation[] = [];
  const externalGates: AutonomyExternalGate[] = [];

  if (manifest.canary.successCriteria.length === 0) {
    violations.push({
      code: "autonomy.canary.success_criteria",
      message: "Canary rollout success criteria must be documented.",
      severity: "high",
    });
  }

  if (!manifest.rollback.tested || manifest.rollback.testRefs.length === 0) {
    violations.push({
      code: "autonomy.rollback.untested",
      message: "Rollback strategy must be tested and linked to automated coverage.",
      severity: "high",
    });
  }

  for (const scenario of REQUIRED_INCIDENT_SCENARIOS) {
    const runbook = manifest.runbooks[scenario];
    if (!runbook?.path || !runbook.section) {
      violations.push({
        code: `autonomy.runbook.${scenario}`,
        message: `Runbook coverage is missing for ${scenario}.`,
        severity: "high",
      });
    }
    const drill = manifest.drills[scenario];
    if (!drill?.validated || drill.testRefs.length === 0) {
      violations.push({
        code: `autonomy.drill.${scenario}`,
        message: `Drill validation is missing for ${scenario}.`,
        severity: "high",
      });
    }
  }

  if (!manifest.drills.rollback?.validated) {
    violations.push({
      code: "autonomy.drill.rollback",
      message: "Rollback drill validation is missing.",
      severity: "high",
    });
  }

  if (!manifest.externalReview.security) {
    externalGates.push({
      code: "autonomy.external_review.security",
      message: "External runtime security review is still pending.",
    });
  }
  if (!manifest.externalReview.privacy) {
    externalGates.push({
      code: "autonomy.external_review.privacy",
      message: "External runtime privacy review is still pending.",
    });
  }
  if (!manifest.externalReview.compliance) {
    externalGates.push({
      code: "autonomy.external_review.compliance",
      message: "External runtime compliance review is still pending.",
    });
  }

  return { violations, externalGates };
}

function evaluateObservedMetrics(
  autonomy: GatewayAutonomyConfig | undefined,
  artifact: BackgroundRunQualityArtifact | undefined,
): {
  observed: AutonomyObservedSloMetrics | undefined;
  violations: AutonomyRolloutViolation[];
} {
  if (!artifact) {
    return {
      observed: undefined,
      violations: [
        {
          code: "autonomy.quality_artifact.missing",
          message: "Background-run quality artifact is required for rollout evaluation.",
          severity: "critical",
        },
      ],
    };
  }

  const observed = buildObservedAutonomySloMetrics(artifact);
  const violations: AutonomyRolloutViolation[] = [];
  const slo = autonomy?.slo;

  if (slo) {
    if (
      slo.runStartLatencyMs !== undefined &&
      observed.runStartLatencyMs > slo.runStartLatencyMs
    ) {
      violations.push({
        code: "autonomy.slo.run_start_latency",
        message: `Observed run start latency ${observed.runStartLatencyMs}ms exceeds target ${slo.runStartLatencyMs}ms.`,
        severity: "critical",
      });
    }
    if (
      slo.updateCadenceMs !== undefined &&
      observed.updateCadenceMs > slo.updateCadenceMs
    ) {
      violations.push({
        code: "autonomy.slo.update_cadence",
        message: `Observed update cadence ${observed.updateCadenceMs}ms exceeds target ${slo.updateCadenceMs}ms.`,
        severity: "high",
      });
    }
    if (
      slo.completionAccuracyRate !== undefined &&
      observed.completionAccuracyRate < slo.completionAccuracyRate
    ) {
      violations.push({
        code: "autonomy.slo.completion_accuracy",
        message: `Observed completion accuracy ${observed.completionAccuracyRate.toFixed(3)} is below target ${slo.completionAccuracyRate.toFixed(3)}.`,
        severity: "critical",
      });
    }
    if (
      slo.recoverySuccessRate !== undefined &&
      observed.recoverySuccessRate < slo.recoverySuccessRate
    ) {
      violations.push({
        code: "autonomy.slo.recovery_success",
        message: `Observed recovery success rate ${observed.recoverySuccessRate.toFixed(3)} is below target ${slo.recoverySuccessRate.toFixed(3)}.`,
        severity: "critical",
      });
    }
    if (
      slo.stopLatencyMs !== undefined &&
      observed.stopLatencyMs > slo.stopLatencyMs
    ) {
      violations.push({
        code: "autonomy.slo.stop_latency",
        message: `Observed stop latency ${observed.stopLatencyMs}ms exceeds target ${slo.stopLatencyMs}ms.`,
        severity: "high",
      });
    }
    if (
      slo.eventLossRate !== undefined &&
      observed.eventLossRate > slo.eventLossRate
    ) {
      violations.push({
        code: "autonomy.slo.event_loss",
        message: `Observed event loss rate ${observed.eventLossRate.toFixed(3)} exceeds target ${slo.eventLossRate.toFixed(3)}.`,
        severity: "critical",
      });
    }
  }

  const qualityGates = evaluateBackgroundRunQualityGates(artifact);
  for (const violation of qualityGates.violations) {
    violations.push({
      code: `autonomy.quality_gate.${violation.metric}`,
      message: `Background-run quality gate failed for ${violation.metric}: observed ${violation.observed}, threshold ${violation.threshold}.`,
      severity: "high",
    });
  }

  return { observed, violations };
}

function evaluateMultiAgentReadiness(
  autonomy: GatewayAutonomyConfig | undefined,
  delegationBenchmark: DelegationBenchmarkSummary | undefined,
): AutonomyRolloutViolation[] {
  if (autonomy?.featureFlags?.multiAgent !== true) {
    return [];
  }
  if (autonomy.killSwitches?.multiAgent === true) {
    return [];
  }
  if (!delegationBenchmark) {
    return [
      {
        code: "autonomy.multi_agent.benchmark_missing",
        message: "Multi-agent rollout requires delegation benchmark evidence.",
        severity: "critical",
      },
    ];
  }

  const violations: AutonomyRolloutViolation[] = [];
  if (
    delegationBenchmark.usefulDelegationRate <
    MULTI_AGENT_MIN_USEFUL_DELEGATION_RATE
  ) {
    violations.push({
      code: "autonomy.multi_agent.useful_rate",
      message: `Useful delegation rate ${delegationBenchmark.usefulDelegationRate.toFixed(3)} is below ${MULTI_AGENT_MIN_USEFUL_DELEGATION_RATE.toFixed(2)}.`,
      severity: "high",
    });
  }
  if (
    delegationBenchmark.harmfulDelegationRate >
    MULTI_AGENT_MAX_HARMFUL_DELEGATION_RATE
  ) {
    violations.push({
      code: "autonomy.multi_agent.harmful_rate",
      message: `Harmful delegation rate ${delegationBenchmark.harmfulDelegationRate.toFixed(3)} exceeds ${MULTI_AGENT_MAX_HARMFUL_DELEGATION_RATE.toFixed(2)}.`,
      severity: "critical",
    });
  }
  if (delegationBenchmark.qualityDeltaVsBaseline < MULTI_AGENT_MIN_QUALITY_DELTA) {
    violations.push({
      code: "autonomy.multi_agent.quality_delta",
      message: `Multi-agent quality delta ${delegationBenchmark.qualityDeltaVsBaseline.toFixed(3)} regressed below baseline.`,
      severity: "critical",
    });
  }
  if (delegationBenchmark.passAtKDeltaVsBaseline < MULTI_AGENT_MIN_PASS_AT_K_DELTA) {
    violations.push({
      code: "autonomy.multi_agent.pass_at_k_delta",
      message: `Multi-agent pass@k delta ${delegationBenchmark.passAtKDeltaVsBaseline.toFixed(3)} regressed below baseline.`,
      severity: "high",
    });
  }
  if (
    delegationBenchmark.passCaretKDeltaVsBaseline <
    MULTI_AGENT_MIN_PASS_CARET_K_DELTA
  ) {
    violations.push({
      code: "autonomy.multi_agent.pass_hat_k_delta",
      message: `Multi-agent pass^k delta ${delegationBenchmark.passCaretKDeltaVsBaseline.toFixed(3)} regressed below baseline.`,
      severity: "high",
    });
  }

  return violations;
}

export function evaluateAutonomyRolloutReadiness(
  input: AutonomyRolloutEvaluationInput,
): AutonomyRolloutEvaluation {
  const configViolations = evaluateAutonomyConfig(input.autonomy);
  const manifestEvaluation = evaluateManifest(input.manifest);
  const observedEvaluation = evaluateObservedMetrics(
    input.autonomy,
    input.backgroundRunQualityArtifact,
  );
  const multiAgentViolations = evaluateMultiAgentReadiness(
    input.autonomy,
    input.delegationBenchmark,
  );

  const violations = [
    ...configViolations,
    ...manifestEvaluation.violations,
    ...observedEvaluation.violations,
    ...multiAgentViolations,
  ];

  return {
    limitedRolloutReady: violations.length === 0,
    broadRolloutReady:
      violations.length === 0 && manifestEvaluation.externalGates.length === 0,
    observed: observedEvaluation.observed,
    violations,
    externalGates: manifestEvaluation.externalGates,
  };
}

export function evaluateAutonomyCanaryAdmission(params: {
  readonly autonomy?: GatewayAutonomyConfig;
  readonly tenantId?: string;
  readonly feature: AutonomyRolloutFeature;
  readonly domain?: string;
  readonly stableKey: string;
}): AutonomyCanaryDecision {
  const { autonomy, tenantId, feature, domain, stableKey } = params;
  if (!autonomy || autonomy.enabled === false) {
    return {
      allowed: false,
      cohort: "holdback",
      reason: "Autonomy runtime is disabled.",
    };
  }
  if (autonomy.featureFlags?.[feature] === false) {
    return {
      allowed: false,
      cohort: "holdback",
      reason: `Feature flag ${feature} is disabled.`,
    };
  }
  if (autonomy.killSwitches?.[feature] === true) {
    return {
      allowed: false,
      cohort: "holdback",
      reason: `Kill switch ${feature} is enabled.`,
    };
  }

  const canaryEnabled =
    autonomy.featureFlags?.canaryRollout !== false &&
    autonomy.killSwitches?.canaryRollout !== true &&
    autonomy.canary?.enabled === true;
  if (!canaryEnabled) {
    return {
      allowed: true,
      cohort: "disabled",
      reason: "Canary rollout is inactive.",
    };
  }

  if (
    tenantId &&
    autonomy.canary?.tenantAllowList &&
    autonomy.canary.tenantAllowList.length > 0 &&
    !autonomy.canary.tenantAllowList.includes(tenantId)
  ) {
    return {
      allowed: false,
      cohort: "holdback",
      reason: `Tenant ${tenantId} is outside the canary allow-list.`,
    };
  }

  if (
    autonomy.canary?.featureAllowList &&
    autonomy.canary.featureAllowList.length > 0 &&
    !autonomy.canary.featureAllowList.includes(feature)
  ) {
    return {
      allowed: false,
      cohort: "holdback",
      reason: `Feature ${feature} is outside the canary allow-list.`,
    };
  }

  if (
    domain &&
    autonomy.canary?.domainAllowList &&
    autonomy.canary.domainAllowList.length > 0 &&
    !autonomy.canary.domainAllowList.includes(domain)
  ) {
    return {
      allowed: false,
      cohort: "holdback",
      reason: `Domain ${domain} is outside the canary allow-list.`,
    };
  }

  const sampleUnit = fnv1aHashUnit(
    [tenantId ?? "tenant:none", feature, domain ?? "domain:none", stableKey].join(":"),
  );
  const percentage = autonomy.canary?.percentage ?? 1;
  const allowed = sampleUnit < percentage;
  return {
    allowed,
    cohort: allowed ? "canary" : "holdback",
    sampleUnit,
    reason: allowed
      ? `Canary cohort admitted at ${(sampleUnit * 100).toFixed(2)}%.`
      : `Canary cohort holdback at ${(sampleUnit * 100).toFixed(2)}%.`,
  };
}
