/**
 * Team contract module.
 *
 * @module
 */

export {
  TeamContractValidationError,
  TeamContractStateError,
  TeamPayoutError,
  TeamWorkflowTopologyError,
} from './errors.js';

export {
  InMemoryTeamAuditStore,
  type TeamAuditStore,
  type InMemoryTeamAuditStoreConfig,
} from './audit.js';

export {
  TeamContractEngine,
  type TeamContractEngineConfig,
  type TeamContractEngineReadonlyView,
  type CreateTeamContractInput,
  type JoinTeamContractInput,
  type AssignTeamRoleInput,
  type CompleteTeamCheckpointInput,
  type FailTeamCheckpointInput,
  type FinalizeTeamPayoutInput,
  type CancelTeamContractInput,
} from './engine.js';

export {
  TeamWorkflowAdapter,
  type TeamWorkflowBuildOptions,
  type TeamWorkflowBuildResult,
  type TeamWorkflowLaunchResult,
} from './workflow-adapter.js';

export {
  computeTeamPayout,
  type TeamPayoutComputationInput,
} from './payout.js';

export {
  canonicalizeTeamId,
  validateTeamId,
  MAX_TEAM_ID_LENGTH,
  TEAM_ID_PATTERN,
  type TeamContractStatus,
  type TeamCheckpointStatus,
  type TeamRoleTemplate,
  type TeamCheckpointTemplate,
  type TeamPayoutConfig,
  type FixedTeamPayoutConfig,
  type WeightedTeamPayoutConfig,
  type MilestoneTeamPayoutConfig,
  type TeamTemplate,
  type TeamMemberInput,
  type TeamMember,
  type TeamCheckpointState,
  type TeamPayoutResult,
  type TeamAuditEventType,
  type TeamAuditEvent,
  type RoleFailureAttribution,
  type TeamContractSnapshot,
  type TeamEngineHooks,
} from './types.js';
