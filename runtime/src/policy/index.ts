/**
 * Policy and safety engine exports.
 *
 * @module
 */

export { PolicyEngine } from './engine.js';
export {
  PolicyViolationError,
  type PolicyActionType,
  type PolicyAccess,
  type CircuitBreakerMode,
  type PolicyAction,
  type PolicyBudgetRule,
  type SpendBudgetRule,
  type CircuitBreakerConfig,
  type RuntimePolicyConfig,
  type PolicyViolation,
  type PolicyDecision,
  type PolicyEngineState,
  type PolicyEngineConfig,
  type EndpointExposureConfig,
  type EvidenceRetentionPolicy,
  type ProductionRedactionPolicy,
  type DeletionDefaults,
  type ProductionRuntimeExtensions,
} from './types.js';
export {
  type ProductionReadinessCheck,
  type ProductionProfileConfig,
  PRODUCTION_POLICY,
  PRODUCTION_ENDPOINT_EXPOSURE,
  PRODUCTION_EVIDENCE_RETENTION,
  PRODUCTION_REDACTION,
  PRODUCTION_DELETION,
  PRODUCTION_PROFILE,
  applyProductionProfile,
  validateProductionReadiness,
} from './production-profile.js';

export {
  ROLE_PERMISSION_MATRIX,
  isCommandAllowed,
  enforceRole,
  IncidentRoleViolationError,
  type OperatorRole,
  type IncidentCommandCategory,
  type RolePermission,
} from './incident-roles.js';

export {
  InMemoryAuditTrail,
  computeInputHash,
  computeOutputHash,
  type AuditTrailEntry,
  type AuditTrailStore,
  type AuditTrailVerification,
} from './audit-trail.js';
