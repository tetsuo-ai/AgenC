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

// Incident Roles (#993 P2-504)
export {
  ROLE_HIERARCHY,
  PERMISSION_REQUIREMENTS,
  COMMAND_PERMISSIONS,
  MCP_TOOL_PERMISSIONS,
  hasPermission,
  canExecuteCommand,
  canInvokeMcpTool,
  getPermissionsForRole,
  getCommandsForRole,
  getMcpToolsForRole,
  parseRole,
  isValidRole,
  enforcePermission,
  enforceCommand,
  enforceMcpTool,
  type OperatorRole,
  type IncidentPermission,
  type IncidentCommand,
  type McpTool,
  type RoleEnforcementResult,
} from './incident-roles.js';

// Audit Trail (#993 P2-504)
export {
  GENESIS_HASH,
  InMemoryAuditTrail,
  createAuditInput,
  computeAuditHash,
  serializeAuditTrail,
  loadAuditTrail,
  type AuditEntry,
  type AuditTrailStore,
  type AuditVerificationResult,
  type AuditVerificationError,
} from './audit-trail.js';
