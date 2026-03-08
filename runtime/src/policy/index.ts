/**
 * Policy and safety engine exports.
 *
 * @module
 */

export { PolicyEngine } from "./engine.js";
export {
  PolicyViolationError,
  type PolicyActionType,
  type PolicyAccess,
  type PolicyClass,
  type PolicySimulationMode,
  type GovernanceAuditRetentionMode,
  type CircuitBreakerMode,
  type PolicyAction,
  type PolicyEvaluationScope,
  type PolicyBudgetRule,
  type RuntimeSessionCredentialConfig,
  type SpendBudgetRule,
  type PolicyClassRule,
  type ScopedActionBudgetRules,
  type ScopedSpendBudgetRules,
  type RuntimePolicyBundleConfig,
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
  type GovernanceAuditConfig,
  type GovernanceAuditRedactionConfig,
} from "./types.js";
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
} from "./production-profile.js";

export {
  ROLE_PERMISSION_MATRIX,
  isCommandAllowed,
  enforceRole,
  IncidentRoleViolationError,
  type OperatorRole,
  type IncidentCommandCategory,
  type RolePermission,
} from "./incident-roles.js";

export {
  InMemoryGovernanceAuditLog,
  MemoryBackedGovernanceAuditLog,
  type GovernanceAuditEvent,
  type GovernanceAuditEventType,
  type GovernanceAuditRecord,
  type GovernanceAuditVerification,
  type GovernanceAuditExport,
  type GovernanceAuditRecordListOptions,
  type GovernanceAuditLog,
  type GovernanceAuditLogConfig,
  type DurableGovernanceAuditLogConfig,
} from "./governance-audit-log.js";

export {
  createPolicyGateHook,
  type CreatePolicyGateHookOptions,
} from "./policy-gate.js";

export {
  InMemoryAuditTrail,
  computeInputHash,
  computeOutputHash,
  type AuditTrailEntry,
  type AuditTrailStore,
  type AuditTrailVerification,
} from "./audit-trail.js";

export {
  mergePolicyBundles,
  resolvePolicyContext,
  type ResolvedPolicyContext,
} from "./bundles.js";

export {
  SessionCredentialBroker,
  type SessionCredentialBrokerConfig,
  type SessionCredentialLease,
  type SessionCredentialLeaseEvent,
  type SessionCredentialPreparationResult,
  type SessionCredentialInjectionResult,
  type SessionCredentialPreview,
} from "./session-credentials.js";

export {
  buildMCPApprovalRules,
  computeMCPToolCatalogSha256,
  filterMCPToolCatalog,
  validateMCPServerBinaryIntegrity,
  validateMCPServerStaticPolicy,
  validateMCPToolCatalogIntegrity,
  type MCPServerPolicyViolation,
  type MCPToolSchemaDescriptor,
} from "./mcp-governance.js";

export {
  ToolPolicyEvaluator,
  type ToolPermissionPolicy,
  type ToolPolicyConditions,
  type ToolPolicyContext,
  type ToolPolicyDecision,
} from "./tool-policy.js";

export {
  inferToolAccess,
  classifyToolGovernance,
  buildToolPolicyAction,
  type ToolGovernanceClassification,
} from "./tool-governance.js";
