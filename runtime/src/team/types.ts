/**
 * Team contract domain types for role-based multi-agent coordination.
 *
 * @module
 */

export const MAX_TEAM_ID_LENGTH = 64;
export const TEAM_ID_PATTERN = /^[a-z0-9:_-]+$/;

export type TeamContractStatus = 'draft' | 'active' | 'completed' | 'failed' | 'cancelled';

export type TeamCheckpointStatus =
  | 'pending'
  | 'ready'
  | 'completed'
  | 'failed'
  | 'blocked';

export interface TeamRoleTemplate {
  id: string;
  requiredCapabilities: bigint;
  minMembers?: number;
  maxMembers?: number;
}

export interface TeamCheckpointTemplate {
  id: string;
  roleId: string;
  label: string;
  dependsOn?: readonly string[];
  required?: boolean;
}

interface BasePayoutConfig {
  /** Optional per-role failure penalty in bps [0, 10_000]. */
  roleFailurePenaltyBps?: Record<string, number>;
  /** Whether penalized amounts are redistributed (default true). */
  redistributePenalties?: boolean;
}

export interface FixedTeamPayoutConfig extends BasePayoutConfig {
  mode: 'fixed';
  /** Per-role payout split in bps. Must sum to 10_000. */
  rolePayoutBps: Record<string, number>;
}

export interface WeightedTeamPayoutConfig extends BasePayoutConfig {
  mode: 'weighted';
  /** Per-role positive integer weights. */
  roleWeights: Record<string, number>;
}

export interface MilestoneTeamPayoutConfig extends BasePayoutConfig {
  mode: 'milestone';
  /** Per-checkpoint payout split in bps. Sum may be <= 10_000. */
  milestonePayoutBps: Record<string, number>;
}

export type TeamPayoutConfig =
  | FixedTeamPayoutConfig
  | WeightedTeamPayoutConfig
  | MilestoneTeamPayoutConfig;

export interface TeamTemplate {
  id: string;
  name: string;
  roles: readonly TeamRoleTemplate[];
  checkpoints: readonly TeamCheckpointTemplate[];
  payout: TeamPayoutConfig;
  metadata?: Record<string, unknown>;
}

export interface TeamMemberInput {
  id: string;
  capabilities: bigint;
  roles?: readonly string[];
  metadata?: Record<string, unknown>;
}

export interface TeamMember {
  id: string;
  capabilities: bigint;
  roles: readonly string[];
  active: boolean;
  joinedAt: number;
  leftAt: number | null;
  metadata?: Record<string, unknown>;
}

export interface TeamCheckpointState {
  id: string;
  roleId: string;
  label: string;
  dependsOn: readonly string[];
  required: boolean;
  status: TeamCheckpointStatus;
  completedBy: string | null;
  completedAt: number | null;
  outputDigest: string | null;
  failedBy: string | null;
  failedAt: number | null;
  failureReason: string | null;
}

export interface TeamPayoutResult {
  mode: TeamPayoutConfig['mode'];
  totalRewardLamports: bigint;
  rolePayouts: Record<string, bigint>;
  memberPayouts: Record<string, bigint>;
  rolePenalties: Record<string, bigint>;
  redistributedLamports: bigint;
  unallocatedLamports: bigint;
}

export type TeamAuditEventType =
  | 'contract_created'
  | 'member_joined'
  | 'member_left'
  | 'role_assigned'
  | 'run_started'
  | 'checkpoint_completed'
  | 'checkpoint_failed'
  | 'contract_cancelled'
  | 'payout_finalized';

export interface TeamAuditEvent {
  sequence: number;
  contractId: string;
  type: TeamAuditEventType;
  atMs: number;
  payload: Record<string, unknown>;
}

export interface RoleFailureAttribution {
  contractId: string;
  roleId: string;
  checkpointId: string;
  memberId: string;
  reason: string;
  atMs: number;
}

export interface TeamContractSnapshot {
  id: string;
  creatorId: string;
  template: TeamTemplate;
  status: TeamContractStatus;
  members: readonly TeamMember[];
  roleAssignments: Readonly<Record<string, readonly string[]>>;
  checkpoints: Readonly<Record<string, TeamCheckpointState>>;
  startedAt: number | null;
  completedAt: number | null;
  cancelledAt: number | null;
  finalizedPayout: Readonly<TeamPayoutResult> | null;
}

export interface TeamEngineHooks {
  onRoleFailure?: (failure: RoleFailureAttribution) => void;
  onAuditError?: (error: Error, event: TeamAuditEvent) => void;
}

export function canonicalizeTeamId(value: string): string {
  return value.trim().toLowerCase();
}

export function validateTeamId(value: string, maxLength = MAX_TEAM_ID_LENGTH): string | null {
  if (value.length === 0) {
    return 'must not be empty';
  }
  if (value.length > maxLength) {
    return `must be <= ${maxLength} characters`;
  }
  if (!TEAM_ID_PATTERN.test(value)) {
    return 'must match [a-z0-9:_-]';
  }
  return null;
}
