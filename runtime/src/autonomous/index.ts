/**
 * Autonomous Agent System
 *
 * Provides self-operating agents that automatically discover, claim,
 * execute, and complete tasks on the AgenC protocol.
 *
 * @module
 */

export { AutonomousAgent } from './agent.js';
export { TaskScanner, type TaskScannerConfig, type TaskEventSubscription, type TaskCreatedCallback } from './scanner.js';
export {
  VerifierExecutor,
  VerifierLaneEscalationError,
  VERIFIER_METRIC_NAMES,
  type VerifierLaneMetrics,
  type VerifierExecutorConfig,
} from './verifier.js';
export {
  extractTaskRiskFeatures,
  scoreTaskRisk,
  type RiskTier,
  type RiskFeatureVector,
  type RiskContribution,
  type TaskRiskScoringContext,
  type TaskRiskScoringConfig,
  type TaskRiskScoreResult,
} from './risk-scoring.js';
export {
  allocateVerificationBudget,
  type VerificationBudgetDecision,
} from './verification-budget.js';
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
  type VerifierPolicyConfig,
  type VerifierEscalationMetadata,
  type VerifierLaneConfig,
  type VerifierExecutionResult,
  // Default strategy
  DefaultClaimStrategy,
} from './types.js';
