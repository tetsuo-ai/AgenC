/**
 * Full AgenC coordination-program error map (6000-6146).
 */

export type ErrorCategory =
  | 'agent'
  | 'task'
  | 'claim'
  | 'dispute'
  | 'state'
  | 'protocol'
  | 'general'
  | 'rate_limit'
  | 'version'
  | 'dependency'
  | 'nullifier'
  | 'cancel'
  | 'duplicate'
  | 'escrow'
  | 'status'
  | 'stake'
  | 'bond'
  | 'reputation'
  | 'security'
  | 'token';

export interface CoordinationErrorEntry {
  name: string;
  message: string;
  category: ErrorCategory;
}

/**
 * Complete mapping of on-chain error codes to typed metadata.
 * Generated from target/idl/agenc_coordination.json.
 */
export const COORDINATION_ERROR_MAP: Record<number, CoordinationErrorEntry> = {
  6000: { name: 'AgentAlreadyRegistered', message: 'Agent is already registered', category: 'agent' },
  6001: { name: 'AgentNotFound', message: 'Agent not found', category: 'agent' },
  6002: { name: 'AgentNotActive', message: 'Agent is not active', category: 'agent' },
  6003: { name: 'InsufficientCapabilities', message: 'Agent has insufficient capabilities', category: 'agent' },
  6004: { name: 'InvalidCapabilities', message: 'Agent capabilities bitmask cannot be zero', category: 'agent' },
  6005: { name: 'MaxActiveTasksReached', message: 'Agent has reached maximum active tasks', category: 'agent' },
  6006: { name: 'AgentHasActiveTasks', message: 'Agent has active tasks and cannot be deregistered', category: 'agent' },
  6007: { name: 'UnauthorizedAgent', message: 'Only the agent authority can perform this action', category: 'agent' },
  6008: { name: 'CreatorAuthorityMismatch', message: 'Creator must match authority to prevent social engineering', category: 'agent' },
  6009: { name: 'InvalidAgentId', message: 'Invalid agent ID: agent_id cannot be all zeros', category: 'agent' },
  6010: { name: 'AgentRegistrationRequired', message: 'Agent registration required to create tasks', category: 'agent' },
  6011: { name: 'AgentSuspended', message: 'Agent is suspended and cannot change status', category: 'agent' },
  6012: { name: 'AgentBusyWithTasks', message: 'Agent cannot set status to Active while having active tasks', category: 'agent' },
  6013: { name: 'TaskNotFound', message: 'Task not found', category: 'task' },
  6014: { name: 'TaskNotOpen', message: 'Task is not open for claims', category: 'task' },
  6015: { name: 'TaskFullyClaimed', message: 'Task has reached maximum workers', category: 'task' },
  6016: { name: 'TaskExpired', message: 'Task has expired', category: 'task' },
  6017: { name: 'TaskNotExpired', message: 'Task deadline has not passed', category: 'task' },
  6018: { name: 'DeadlinePassed', message: 'Task deadline has passed', category: 'task' },
  6019: { name: 'TaskNotInProgress', message: 'Task is not in progress', category: 'task' },
  6020: { name: 'TaskAlreadyCompleted', message: 'Task is already completed', category: 'task' },
  6021: { name: 'TaskCannotBeCancelled', message: 'Task cannot be cancelled', category: 'task' },
  6022: { name: 'UnauthorizedTaskAction', message: 'Only the task creator can perform this action', category: 'task' },
  6023: { name: 'InvalidCreator', message: 'Invalid creator', category: 'task' },
  6024: { name: 'InvalidTaskId', message: 'Invalid task ID: cannot be zero', category: 'task' },
  6025: { name: 'InvalidDescription', message: 'Invalid description: cannot be empty', category: 'task' },
  6026: { name: 'InvalidMaxWorkers', message: 'Invalid max workers: must be between 1 and 100', category: 'task' },
  6027: { name: 'InvalidTaskType', message: 'Invalid task type', category: 'task' },
  6028: { name: 'InvalidDeadline', message: 'Invalid deadline: deadline must be greater than zero', category: 'task' },
  6029: { name: 'InvalidReward', message: 'Invalid reward: reward must be greater than zero', category: 'task' },
  6030: { name: 'InvalidRequiredCapabilities', message: 'Invalid required capabilities: required_capabilities cannot be zero', category: 'task' },
  6031: { name: 'CompetitiveTaskAlreadyWon', message: 'Competitive task already completed by another worker', category: 'task' },
  6032: { name: 'NoWorkers', message: 'Task has no workers', category: 'task' },
  6033: { name: 'ConstraintHashMismatch', message: 'Proof constraint hash does not match task\'s stored constraint hash', category: 'task' },
  6034: { name: 'NotPrivateTask', message: 'Task is not a private task (no constraint hash set)', category: 'task' },
  6035: { name: 'AlreadyClaimed', message: 'Worker has already claimed this task', category: 'claim' },
  6036: { name: 'NotClaimed', message: 'Worker has not claimed this task', category: 'claim' },
  6037: { name: 'ClaimAlreadyCompleted', message: 'Claim has already been completed', category: 'claim' },
  6038: { name: 'ClaimNotExpired', message: 'Claim has not expired yet', category: 'claim' },
  6039: { name: 'ClaimExpired', message: 'Claim has expired', category: 'claim' },
  6040: { name: 'InvalidExpiration', message: 'Invalid expiration: expires_at cannot be zero', category: 'claim' },
  6041: { name: 'InvalidProof', message: 'Invalid proof of work', category: 'claim' },
  6042: { name: 'ZkVerificationFailed', message: 'ZK proof verification failed', category: 'claim' },
  6043: { name: 'InvalidProofSize', message: 'Invalid proof size - expected 256 bytes for Groth16', category: 'claim' },
  6044: { name: 'InvalidProofBinding', message: 'Invalid proof binding: expected_binding cannot be all zeros', category: 'claim' },
  6045: { name: 'InvalidOutputCommitment', message: 'Invalid output commitment: output_commitment cannot be all zeros', category: 'claim' },
  6046: { name: 'InvalidRentRecipient', message: 'Invalid rent recipient: must be worker authority', category: 'claim' },
  6047: { name: 'GracePeriodNotPassed', message: 'Grace period not passed: only worker authority can expire claim within 60 seconds of expiry', category: 'claim' },
  6048: { name: 'InvalidProofHash', message: 'Invalid proof hash: proof_hash cannot be all zeros', category: 'claim' },
  6049: { name: 'InvalidResultData', message: 'Invalid result data: result_data cannot be all zeros when provided', category: 'claim' },
  6050: { name: 'DisputeNotActive', message: 'Dispute is not active', category: 'dispute' },
  6051: { name: 'VotingEnded', message: 'Voting period has ended', category: 'dispute' },
  6052: { name: 'VotingNotEnded', message: 'Voting period has not ended', category: 'dispute' },
  6053: { name: 'AlreadyVoted', message: 'Already voted on this dispute', category: 'dispute' },
  6054: { name: 'NotArbiter', message: 'Not authorized to vote (not an arbiter)', category: 'dispute' },
  6055: { name: 'InsufficientVotes', message: 'Insufficient votes to resolve', category: 'dispute' },
  6056: { name: 'DisputeAlreadyResolved', message: 'Dispute has already been resolved', category: 'dispute' },
  6057: { name: 'UnauthorizedResolver', message: 'Only protocol authority or dispute initiator can resolve disputes', category: 'dispute' },
  6058: { name: 'ActiveDisputeVotes', message: 'Agent has active dispute votes pending resolution', category: 'dispute' },
  6059: { name: 'RecentVoteActivity', message: 'Agent must wait 24 hours after voting before deregistering', category: 'dispute' },
  6060: { name: 'AuthorityAlreadyVoted', message: 'Authority has already voted on this dispute', category: 'dispute' },
  6061: { name: 'InsufficientEvidence', message: 'Insufficient dispute evidence provided', category: 'dispute' },
  6062: { name: 'EvidenceTooLong', message: 'Dispute evidence exceeds maximum allowed length', category: 'dispute' },
  6063: { name: 'DisputeNotExpired', message: 'Dispute has not expired', category: 'dispute' },
  6064: { name: 'SlashAlreadyApplied', message: 'Dispute slashing already applied', category: 'dispute' },
  6065: { name: 'SlashWindowExpired', message: 'Slash window expired: must apply slashing within 7 days of resolution', category: 'dispute' },
  6066: { name: 'DisputeNotResolved', message: 'Dispute has not been resolved', category: 'dispute' },
  6067: { name: 'NotTaskParticipant', message: 'Only task creator or workers can initiate disputes', category: 'dispute' },
  6068: { name: 'InvalidEvidenceHash', message: 'Invalid evidence hash: cannot be all zeros', category: 'dispute' },
  6069: { name: 'ArbiterIsDisputeParticipant', message: 'Arbiter cannot vote on disputes they are a participant in', category: 'dispute' },
  6070: { name: 'InsufficientQuorum', message: 'Insufficient quorum: minimum number of voters not reached', category: 'dispute' },
  6071: { name: 'ActiveDisputesExist', message: 'Agent has active disputes as defendant and cannot deregister', category: 'dispute' },
  6072: { name: 'WorkerAgentRequired', message: 'Worker agent account required when creator initiates dispute', category: 'dispute' },
  6073: { name: 'WorkerClaimRequired', message: 'Worker claim account required when creator initiates dispute', category: 'dispute' },
  6074: { name: 'WorkerNotInDispute', message: 'Worker was not involved in this dispute', category: 'dispute' },
  6075: { name: 'InitiatorCannotResolve', message: 'Dispute initiator cannot resolve their own dispute', category: 'dispute' },
  6076: { name: 'VersionMismatch', message: 'State version mismatch (concurrent modification)', category: 'state' },
  6077: { name: 'StateKeyExists', message: 'State key already exists', category: 'state' },
  6078: { name: 'StateNotFound', message: 'State not found', category: 'state' },
  6079: { name: 'InvalidStateValue', message: 'Invalid state value: state_value cannot be all zeros', category: 'state' },
  6080: { name: 'StateOwnershipViolation', message: 'State ownership violation: only the creator agent can update this state', category: 'state' },
  6081: { name: 'InvalidStateKey', message: 'Invalid state key: state_key cannot be all zeros', category: 'state' },
  6082: { name: 'ProtocolAlreadyInitialized', message: 'Protocol is already initialized', category: 'protocol' },
  6083: { name: 'ProtocolNotInitialized', message: 'Protocol is not initialized', category: 'protocol' },
  6084: { name: 'InvalidProtocolFee', message: 'Invalid protocol fee (must be <= 1000 bps)', category: 'protocol' },
  6085: { name: 'InvalidTreasury', message: 'Invalid treasury: treasury account cannot be default pubkey', category: 'protocol' },
  6086: { name: 'InvalidDisputeThreshold', message: 'Invalid dispute threshold: must be 1-100 (percentage of votes required)', category: 'protocol' },
  6087: { name: 'InsufficientStake', message: 'Insufficient stake for arbiter registration', category: 'protocol' },
  6088: { name: 'MultisigInvalidThreshold', message: 'Invalid multisig threshold', category: 'protocol' },
  6089: { name: 'MultisigInvalidSigners', message: 'Invalid multisig signer configuration', category: 'protocol' },
  6090: { name: 'MultisigNotEnoughSigners', message: 'Not enough multisig signers', category: 'protocol' },
  6091: { name: 'MultisigDuplicateSigner', message: 'Duplicate multisig signer provided', category: 'protocol' },
  6092: { name: 'MultisigDefaultSigner', message: 'Multisig signer cannot be default pubkey', category: 'protocol' },
  6093: { name: 'MultisigSignerNotSystemOwned', message: 'Multisig signer account not owned by System Program', category: 'protocol' },
  6094: { name: 'InvalidInput', message: 'Invalid input parameter', category: 'general' },
  6095: { name: 'ArithmeticOverflow', message: 'Arithmetic overflow', category: 'general' },
  6096: { name: 'VoteOverflow', message: 'Vote count overflow', category: 'general' },
  6097: { name: 'InsufficientFunds', message: 'Insufficient funds', category: 'general' },
  6098: { name: 'RewardTooSmall', message: 'Reward too small: worker must receive at least 1 lamport', category: 'general' },
  6099: { name: 'CorruptedData', message: 'Account data is corrupted', category: 'general' },
  6100: { name: 'StringTooLong', message: 'String too long', category: 'general' },
  6101: { name: 'InvalidAccountOwner', message: 'Account owner validation failed: account not owned by this program', category: 'general' },
  6102: { name: 'RateLimitExceeded', message: 'Rate limit exceeded: maximum actions per 24h window reached', category: 'rate_limit' },
  6103: { name: 'CooldownNotElapsed', message: 'Cooldown period has not elapsed since last action', category: 'rate_limit' },
  6104: { name: 'UpdateTooFrequent', message: 'Agent update too frequent: must wait cooldown period', category: 'rate_limit' },
  6105: { name: 'InvalidCooldown', message: 'Cooldown value cannot be negative', category: 'rate_limit' },
  6106: { name: 'CooldownTooLarge', message: 'Cooldown value exceeds maximum (24 hours)', category: 'rate_limit' },
  6107: { name: 'RateLimitTooHigh', message: 'Rate limit value exceeds maximum allowed (1000)', category: 'rate_limit' },
  6108: { name: 'CooldownTooLong', message: 'Cooldown value exceeds maximum allowed (1 week)', category: 'rate_limit' },
  6109: { name: 'InsufficientStakeForDispute', message: 'Insufficient stake to initiate dispute', category: 'rate_limit' },
  6110: { name: 'InsufficientStakeForCreatorDispute', message: 'Creator-initiated disputes require 2x the minimum stake', category: 'rate_limit' },
  6111: { name: 'VersionMismatchProtocol', message: 'Protocol version mismatch: account version incompatible with current program', category: 'version' },
  6112: { name: 'AccountVersionTooOld', message: 'Account version too old: migration required', category: 'version' },
  6113: { name: 'AccountVersionTooNew', message: 'Account version too new: program upgrade required', category: 'version' },
  6114: { name: 'InvalidMigrationSource', message: 'Migration not allowed: invalid source version', category: 'version' },
  6115: { name: 'InvalidMigrationTarget', message: 'Migration not allowed: invalid target version', category: 'version' },
  6116: { name: 'UnauthorizedUpgrade', message: 'Only upgrade authority can perform this action', category: 'version' },
  6117: { name: 'InvalidMinVersion', message: 'Minimum version cannot exceed current protocol version', category: 'version' },
  6118: { name: 'ProtocolConfigRequired', message: 'Protocol config account required: suspending an agent requires the protocol config PDA in remaining_accounts', category: 'version' },
  6119: { name: 'ParentTaskCancelled', message: 'Parent task has been cancelled', category: 'dependency' },
  6120: { name: 'ParentTaskDisputed', message: 'Parent task is in disputed state', category: 'dependency' },
  6121: { name: 'InvalidDependencyType', message: 'Invalid dependency type', category: 'dependency' },
  6122: { name: 'ParentTaskNotCompleted', message: 'Parent task must be completed before completing a proof-dependent task', category: 'dependency' },
  6123: { name: 'ParentTaskAccountRequired', message: 'Parent task account required for proof-dependent task completion', category: 'dependency' },
  6124: { name: 'UnauthorizedCreator', message: 'Parent task does not belong to the same creator', category: 'dependency' },
  6125: { name: 'NullifierAlreadySpent', message: 'Nullifier has already been spent - proof/knowledge reuse detected', category: 'nullifier' },
  6126: { name: 'InvalidNullifier', message: 'Invalid nullifier: nullifier value cannot be all zeros', category: 'nullifier' },
  6127: { name: 'IncompleteWorkerAccounts', message: 'All worker accounts must be provided when cancelling a task with active claims', category: 'cancel' },
  6128: { name: 'WorkerAccountsRequired', message: 'Worker accounts required when task has active workers', category: 'cancel' },
  6129: { name: 'DuplicateArbiter', message: 'Duplicate arbiter provided in remaining_accounts', category: 'duplicate' },
  6130: { name: 'InsufficientEscrowBalance', message: 'Escrow has insufficient balance for reward transfer', category: 'escrow' },
  6131: { name: 'InvalidStatusTransition', message: 'Invalid task status transition', category: 'status' },
  6132: { name: 'StakeTooLow', message: 'Stake value is below minimum required (0.001 SOL)', category: 'stake' },
  6133: { name: 'InvalidMinStake', message: 'min_stake_for_dispute must be greater than zero', category: 'stake' },
  6134: { name: 'InvalidSlashAmount', message: 'Slash amount must be greater than zero', category: 'stake' },
  6135: { name: 'BondAmountTooLow', message: 'Bond amount too low', category: 'bond' },
  6136: { name: 'BondAlreadyExists', message: 'Bond already exists', category: 'bond' },
  6137: { name: 'BondNotFound', message: 'Bond not found', category: 'bond' },
  6138: { name: 'BondNotMatured', message: 'Bond not yet matured', category: 'bond' },
  6139: { name: 'InsufficientReputation', message: 'Agent reputation below task minimum requirement', category: 'reputation' },
  6140: { name: 'InvalidMinReputation', message: 'Invalid minimum reputation: must be <= 10000', category: 'reputation' },
  6141: { name: 'DevelopmentKeyNotAllowed', message: 'Development verifying key detected (gamma == delta). ZK proofs are forgeable. Run MPC ceremony before use.', category: 'security' },
  6142: { name: 'SelfTaskNotAllowed', message: 'Cannot claim own task: worker authority matches task creator', category: 'security' },
  6143: { name: 'MissingTokenAccounts', message: 'Token accounts not provided for token-denominated task', category: 'token' },
  6144: { name: 'InvalidTokenEscrow', message: 'Token escrow ATA does not match expected derivation', category: 'token' },
  6145: { name: 'InvalidTokenMint', message: 'Provided mint does not match task\'s reward_mint', category: 'token' },
  6146: { name: 'TokenTransferFailed', message: 'SPL token transfer CPI failed', category: 'token' },
};

export interface DecodedError extends CoordinationErrorEntry {
  code: number;
}

/**
 * Decode a numeric Anchor error code.
 */
export function decodeError(code: number): DecodedError | null {
  const entry = COORDINATION_ERROR_MAP[code];
  if (!entry) return null;
  return { code, ...entry };
}

function extractCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;

  const err = error as Record<string, unknown>;

  if (typeof err.code === 'number') {
    return err.code;
  }

  const directErrorCode = err.errorCode as Record<string, unknown> | undefined;
  if (directErrorCode && typeof directErrorCode.number === 'number') {
    return directErrorCode.number;
  }

  const nested = err.error as Record<string, unknown> | undefined;
  const nestedErrorCode = nested?.errorCode as Record<string, unknown> | undefined;
  if (nestedErrorCode && typeof nestedErrorCode.number === 'number') {
    return nestedErrorCode.number;
  }

  if (Array.isArray(err.logs)) {
    for (const line of err.logs) {
      if (typeof line !== 'string') continue;
      const match = line.match(/Error Number: (\d+)/);
      if (match) return Number.parseInt(match[1], 10);
    }
  }

  if (typeof err.message === 'string') {
    const hexMatch = err.message.match(/custom program error: 0x([0-9a-fA-F]+)/);
    if (hexMatch) {
      return Number.parseInt(hexMatch[1], 16);
    }
    const decimalMatch = err.message.match(/Error Number: (\d+)/);
    if (decimalMatch) {
      return Number.parseInt(decimalMatch[1], 10);
    }
  }

  return null;
}

/**
 * Decode common Anchor error object shapes.
 */
export function decodeAnchorError(error: unknown): DecodedError | null {
  const code = extractCode(error);
  if (code === null) return null;
  return decodeError(code);
}
