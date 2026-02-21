/**
 * Autonomous Agent System
 *
 * Provides self-operating agents that automatically discover, claim,
 * execute, and complete tasks on the AgenC protocol.
 *
 * @module
 */

export { AutonomousAgent } from "./agent.js";
export {
  TaskScanner,
  type TaskScannerConfig,
  type TaskEventSubscription,
  type TaskCreatedCallback,
} from "./scanner.js";
export {
  VerifierExecutor,
  VerifierLaneEscalationError,
  VERIFIER_METRIC_NAMES,
  type VerifierLaneMetrics,
  type VerifierExecutorConfig,
} from "./verifier.js";
export {
  extractTaskRiskFeatures,
  scoreTaskRisk,
  type RiskTier,
  type RiskFeatureVector,
  type RiskContribution,
  type TaskRiskScoringContext,
  type TaskRiskScoringConfig,
  type TaskRiskScoreResult,
} from "./risk-scoring.js";
export {
  allocateVerificationBudget,
  BudgetAdjustmentInput,
  BudgetAdjustmentResult,
  BudgetAuditEntry,
  BudgetAuditTrail,
  BudgetGuardrail,
  clampBudget,
  calculateNextBudget,
  countConsecutiveFromEnd,
  DEFAULT_BUDGET_GUARDRAIL,
  DEFAULT_INITIAL_BUDGET_LAMPORTS,
  resolveBudgetGuardrail,
  validateBudgetGuardrail,
  type VerificationBudgetDecision,
} from "./verification-budget.js";
export {
  planVerifierSchedule,
  type VerifierRouteStrategy,
  type VerifierScheduleInput,
  type VerifierSchedulePlan,
} from "./verifier-scheduler.js";
export {
  resolveEscalationTransition,
  type EscalationTransitionState,
  type EscalationTransitionReason,
  type EscalationGraphInput,
  type EscalationGraphTransition,
} from "./escalation-graph.js";
export {
  generateExecutionCandidates,
  type GeneratedExecutionCandidate,
  type CandidateGenerationAttemptContext,
  type CandidateGenerationInput,
  type CandidateGenerationResult,
} from "./candidate-generator.js";
export {
  detectCandidateInconsistencies,
  type CandidateDisagreementReasonCode,
  type CandidateDisagreementReason,
  type CandidateDisagreement,
  type CandidateProvenanceLink,
  type InconsistencyDetectionResult,
  type InconsistencyDetectorInput,
} from "./inconsistency-detector.js";
export {
  arbitrateCandidates,
  type CandidateArbitrationScore,
  type CandidateArbitrationDecision,
  type CandidateArbitrationInput,
} from "./arbitration.js";
export {
  // Types
  type Task,
  TaskStatus,
  type TaskFilter,
  type ClaimStrategy,
  type AutonomousTaskExecutor,
  type AutonomousAgentConfig,
  type AutonomousAgentStats,
  type DiscoveryMode,
  type SpeculationConfig,
  type VerifierReason,
  type VerifierVerdict,
  type VerifierVerdictPayload,
  type VerifierInput,
  type TaskVerifier,
  type RevisionInput,
  type RevisionCapableTaskExecutor,
  type VerifierTaskTypePolicy,
  type VerifierAdaptiveRiskWeights,
  type VerifierAdaptiveRiskConfig,
  type MultiCandidateArbitrationWeights,
  type MultiCandidateEscalationPolicy,
  type MultiCandidatePolicyBudget,
  type MultiCandidateConfig,
  type VerifierPolicyConfig,
  type VerifierEscalationMetadata,
  type VerifierLaneConfig,
  type VerifierExecutionResult,
  // Default strategy
  DefaultClaimStrategy,
} from "./types.js";
