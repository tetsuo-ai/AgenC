import { describe, it, expect } from 'vitest';
import {
  // Constants
  RuntimeErrorCodes,
  AnchorErrorCodes,
  // Types (imported for testing)
  type RuntimeErrorCode,
  type AnchorErrorCode,
  type AnchorErrorName,
  type ParsedAnchorError,
  // Base error class
  RuntimeError,
  // Specific error classes
  AgentNotRegisteredError,
  AgentAlreadyRegisteredError,
  ValidationError,
  RateLimitError,
  InsufficientStakeError,
  ActiveTasksError,
  PendingDisputeVotesError,
  RecentVoteActivityError,
  // Helper functions
  isAnchorError,
  parseAnchorError,
  getAnchorErrorName,
  getAnchorErrorMessage,
  isRuntimeError,
  // Validation helpers (#963)
  validateByteLength,
  validateNonZeroBytes,
} from './errors';

describe('RuntimeErrorCodes', () => {
  it('has all expected error codes', () => {
    expect(RuntimeErrorCodes.AGENT_NOT_REGISTERED).toBe('AGENT_NOT_REGISTERED');
    expect(RuntimeErrorCodes.AGENT_ALREADY_REGISTERED).toBe('AGENT_ALREADY_REGISTERED');
    expect(RuntimeErrorCodes.VALIDATION_ERROR).toBe('VALIDATION_ERROR');
    expect(RuntimeErrorCodes.RATE_LIMIT_ERROR).toBe('RATE_LIMIT_ERROR');
    expect(RuntimeErrorCodes.INSUFFICIENT_STAKE).toBe('INSUFFICIENT_STAKE');
    expect(RuntimeErrorCodes.ACTIVE_TASKS_ERROR).toBe('ACTIVE_TASKS_ERROR');
    expect(RuntimeErrorCodes.PENDING_DISPUTE_VOTES).toBe('PENDING_DISPUTE_VOTES');
    expect(RuntimeErrorCodes.RECENT_VOTE_ACTIVITY).toBe('RECENT_VOTE_ACTIVITY');
    expect(RuntimeErrorCodes.TEAM_CONTRACT_VALIDATION_ERROR).toBe('TEAM_CONTRACT_VALIDATION_ERROR');
    expect(RuntimeErrorCodes.TEAM_CONTRACT_STATE_ERROR).toBe('TEAM_CONTRACT_STATE_ERROR');
    expect(RuntimeErrorCodes.TEAM_PAYOUT_ERROR).toBe('TEAM_PAYOUT_ERROR');
    expect(RuntimeErrorCodes.TEAM_WORKFLOW_TOPOLOGY_ERROR).toBe('TEAM_WORKFLOW_TOPOLOGY_ERROR');
    expect(RuntimeErrorCodes.MARKETPLACE_VALIDATION_ERROR).toBe('MARKETPLACE_VALIDATION_ERROR');
    expect(RuntimeErrorCodes.MARKETPLACE_STATE_ERROR).toBe('MARKETPLACE_STATE_ERROR');
    expect(RuntimeErrorCodes.MARKETPLACE_AUTHORIZATION_ERROR).toBe('MARKETPLACE_AUTHORIZATION_ERROR');
    expect(RuntimeErrorCodes.MARKETPLACE_MATCHING_ERROR).toBe('MARKETPLACE_MATCHING_ERROR');
  });

  it('has exactly 75 error codes', () => {
    expect(Object.keys(RuntimeErrorCodes)).toHaveLength(75);
  });
});

describe('AnchorErrorCodes', () => {
  it('has exactly 161 error codes (6000-6160)', () => {
    expect(Object.keys(AnchorErrorCodes)).toHaveLength(161);
  });

  it('has codes in range 6000-6160', () => {
    const codes = Object.values(AnchorErrorCodes);
    const minCode = Math.min(...codes);
    const maxCode = Math.max(...codes);

    expect(minCode).toBe(6000);
    expect(maxCode).toBe(6160);
  });

  it('has sequential codes (no gaps)', () => {
    const codes = Object.values(AnchorErrorCodes).sort((a, b) => a - b);
    for (let i = 0; i < codes.length; i++) {
      expect(codes[i]).toBe(6000 + i);
    }
  });

  it('has correct agent error codes (6000-6012)', () => {
    expect(AnchorErrorCodes.AgentAlreadyRegistered).toBe(6000);
    expect(AnchorErrorCodes.AgentNotFound).toBe(6001);
    expect(AnchorErrorCodes.AgentNotActive).toBe(6002);
    expect(AnchorErrorCodes.InsufficientCapabilities).toBe(6003);
    expect(AnchorErrorCodes.InvalidCapabilities).toBe(6004);
    expect(AnchorErrorCodes.MaxActiveTasksReached).toBe(6005);
    expect(AnchorErrorCodes.AgentHasActiveTasks).toBe(6006);
    expect(AnchorErrorCodes.UnauthorizedAgent).toBe(6007);
    expect(AnchorErrorCodes.CreatorAuthorityMismatch).toBe(6008);
    expect(AnchorErrorCodes.InvalidAgentId).toBe(6009);
    expect(AnchorErrorCodes.AgentRegistrationRequired).toBe(6010);
    expect(AnchorErrorCodes.AgentSuspended).toBe(6011);
    expect(AnchorErrorCodes.AgentBusyWithTasks).toBe(6012);
  });

  it('has correct task error codes (6013-6034)', () => {
    expect(AnchorErrorCodes.TaskNotFound).toBe(6013);
    expect(AnchorErrorCodes.TaskNotOpen).toBe(6014);
    expect(AnchorErrorCodes.TaskFullyClaimed).toBe(6015);
    expect(AnchorErrorCodes.TaskExpired).toBe(6016);
    expect(AnchorErrorCodes.TaskNotExpired).toBe(6017);
    expect(AnchorErrorCodes.DeadlinePassed).toBe(6018);
    expect(AnchorErrorCodes.TaskNotInProgress).toBe(6019);
    expect(AnchorErrorCodes.TaskAlreadyCompleted).toBe(6020);
    expect(AnchorErrorCodes.TaskCannotBeCancelled).toBe(6021);
    expect(AnchorErrorCodes.UnauthorizedTaskAction).toBe(6022);
    expect(AnchorErrorCodes.InvalidCreator).toBe(6023);
    expect(AnchorErrorCodes.InvalidTaskId).toBe(6024);
    expect(AnchorErrorCodes.InvalidDescription).toBe(6025);
    expect(AnchorErrorCodes.InvalidMaxWorkers).toBe(6026);
    expect(AnchorErrorCodes.InvalidTaskType).toBe(6027);
    expect(AnchorErrorCodes.InvalidDeadline).toBe(6028);
    expect(AnchorErrorCodes.InvalidReward).toBe(6029);
    expect(AnchorErrorCodes.InvalidRequiredCapabilities).toBe(6030);
    expect(AnchorErrorCodes.CompetitiveTaskAlreadyWon).toBe(6031);
    expect(AnchorErrorCodes.NoWorkers).toBe(6032);
    expect(AnchorErrorCodes.ConstraintHashMismatch).toBe(6033);
    expect(AnchorErrorCodes.NotPrivateTask).toBe(6034);
  });

  it('has correct claim error codes (6035-6049)', () => {
    expect(AnchorErrorCodes.AlreadyClaimed).toBe(6035);
    expect(AnchorErrorCodes.NotClaimed).toBe(6036);
    expect(AnchorErrorCodes.ClaimAlreadyCompleted).toBe(6037);
    expect(AnchorErrorCodes.ClaimNotExpired).toBe(6038);
    expect(AnchorErrorCodes.ClaimExpired).toBe(6039);
    expect(AnchorErrorCodes.InvalidExpiration).toBe(6040);
    expect(AnchorErrorCodes.InvalidProof).toBe(6041);
    expect(AnchorErrorCodes.ZkVerificationFailed).toBe(6042);
    expect(AnchorErrorCodes.InvalidProofSize).toBe(6043);
    expect(AnchorErrorCodes.InvalidProofBinding).toBe(6044);
    expect(AnchorErrorCodes.InvalidOutputCommitment).toBe(6045);
    expect(AnchorErrorCodes.InvalidRentRecipient).toBe(6046);
    expect(AnchorErrorCodes.GracePeriodNotPassed).toBe(6047);
    expect(AnchorErrorCodes.InvalidProofHash).toBe(6048);
    expect(AnchorErrorCodes.InvalidResultData).toBe(6049);
  });

  it('has correct dispute error codes (6050-6075)', () => {
    expect(AnchorErrorCodes.DisputeNotActive).toBe(6050);
    expect(AnchorErrorCodes.VotingEnded).toBe(6051);
    expect(AnchorErrorCodes.VotingNotEnded).toBe(6052);
    expect(AnchorErrorCodes.AlreadyVoted).toBe(6053);
    expect(AnchorErrorCodes.NotArbiter).toBe(6054);
    expect(AnchorErrorCodes.InsufficientVotes).toBe(6055);
    expect(AnchorErrorCodes.DisputeAlreadyResolved).toBe(6056);
    expect(AnchorErrorCodes.UnauthorizedResolver).toBe(6057);
    expect(AnchorErrorCodes.ActiveDisputeVotes).toBe(6058);
    expect(AnchorErrorCodes.RecentVoteActivity).toBe(6059);
    expect(AnchorErrorCodes.AuthorityAlreadyVoted).toBe(6060);
    expect(AnchorErrorCodes.InsufficientEvidence).toBe(6061);
    expect(AnchorErrorCodes.EvidenceTooLong).toBe(6062);
    expect(AnchorErrorCodes.DisputeNotExpired).toBe(6063);
    expect(AnchorErrorCodes.SlashAlreadyApplied).toBe(6064);
    expect(AnchorErrorCodes.SlashWindowExpired).toBe(6065);
    expect(AnchorErrorCodes.DisputeNotResolved).toBe(6066);
    expect(AnchorErrorCodes.NotTaskParticipant).toBe(6067);
    expect(AnchorErrorCodes.InvalidEvidenceHash).toBe(6068);
    expect(AnchorErrorCodes.ArbiterIsDisputeParticipant).toBe(6069);
    expect(AnchorErrorCodes.InsufficientQuorum).toBe(6070);
    expect(AnchorErrorCodes.ActiveDisputesExist).toBe(6071);
    expect(AnchorErrorCodes.WorkerAgentRequired).toBe(6072);
    expect(AnchorErrorCodes.WorkerClaimRequired).toBe(6073);
    expect(AnchorErrorCodes.WorkerNotInDispute).toBe(6074);
    expect(AnchorErrorCodes.InitiatorCannotResolve).toBe(6075);
  });

  it('has correct state error codes (6076-6081)', () => {
    expect(AnchorErrorCodes.VersionMismatch).toBe(6076);
    expect(AnchorErrorCodes.StateKeyExists).toBe(6077);
    expect(AnchorErrorCodes.StateNotFound).toBe(6078);
    expect(AnchorErrorCodes.InvalidStateValue).toBe(6079);
    expect(AnchorErrorCodes.StateOwnershipViolation).toBe(6080);
    expect(AnchorErrorCodes.InvalidStateKey).toBe(6081);
  });

  it('has correct protocol error codes (6082-6093)', () => {
    expect(AnchorErrorCodes.ProtocolAlreadyInitialized).toBe(6082);
    expect(AnchorErrorCodes.ProtocolNotInitialized).toBe(6083);
    expect(AnchorErrorCodes.InvalidProtocolFee).toBe(6084);
    expect(AnchorErrorCodes.InvalidTreasury).toBe(6085);
    expect(AnchorErrorCodes.InvalidDisputeThreshold).toBe(6086);
    expect(AnchorErrorCodes.InsufficientStake).toBe(6087);
    expect(AnchorErrorCodes.MultisigInvalidThreshold).toBe(6088);
    expect(AnchorErrorCodes.MultisigInvalidSigners).toBe(6089);
    expect(AnchorErrorCodes.MultisigNotEnoughSigners).toBe(6090);
    expect(AnchorErrorCodes.MultisigDuplicateSigner).toBe(6091);
    expect(AnchorErrorCodes.MultisigDefaultSigner).toBe(6092);
    expect(AnchorErrorCodes.MultisigSignerNotSystemOwned).toBe(6093);
  });

  it('has correct general error codes (6094-6101)', () => {
    expect(AnchorErrorCodes.InvalidInput).toBe(6094);
    expect(AnchorErrorCodes.ArithmeticOverflow).toBe(6095);
    expect(AnchorErrorCodes.VoteOverflow).toBe(6096);
    expect(AnchorErrorCodes.InsufficientFunds).toBe(6097);
    expect(AnchorErrorCodes.RewardTooSmall).toBe(6098);
    expect(AnchorErrorCodes.CorruptedData).toBe(6099);
    expect(AnchorErrorCodes.StringTooLong).toBe(6100);
    expect(AnchorErrorCodes.InvalidAccountOwner).toBe(6101);
  });

  it('has correct rate limiting error codes (6102-6110)', () => {
    expect(AnchorErrorCodes.RateLimitExceeded).toBe(6102);
    expect(AnchorErrorCodes.CooldownNotElapsed).toBe(6103);
    expect(AnchorErrorCodes.UpdateTooFrequent).toBe(6104);
    expect(AnchorErrorCodes.InvalidCooldown).toBe(6105);
    expect(AnchorErrorCodes.CooldownTooLarge).toBe(6106);
    expect(AnchorErrorCodes.RateLimitTooHigh).toBe(6107);
    expect(AnchorErrorCodes.CooldownTooLong).toBe(6108);
    expect(AnchorErrorCodes.InsufficientStakeForDispute).toBe(6109);
    expect(AnchorErrorCodes.InsufficientStakeForCreatorDispute).toBe(6110);
  });

  it('has correct version/upgrade error codes (6111-6118)', () => {
    expect(AnchorErrorCodes.VersionMismatchProtocol).toBe(6111);
    expect(AnchorErrorCodes.AccountVersionTooOld).toBe(6112);
    expect(AnchorErrorCodes.AccountVersionTooNew).toBe(6113);
    expect(AnchorErrorCodes.InvalidMigrationSource).toBe(6114);
    expect(AnchorErrorCodes.InvalidMigrationTarget).toBe(6115);
    expect(AnchorErrorCodes.UnauthorizedUpgrade).toBe(6116);
    expect(AnchorErrorCodes.InvalidMinVersion).toBe(6117);
    expect(AnchorErrorCodes.ProtocolConfigRequired).toBe(6118);
  });

  it('has correct dependency error codes (6119-6124)', () => {
    expect(AnchorErrorCodes.ParentTaskCancelled).toBe(6119);
    expect(AnchorErrorCodes.ParentTaskDisputed).toBe(6120);
    expect(AnchorErrorCodes.InvalidDependencyType).toBe(6121);
    expect(AnchorErrorCodes.ParentTaskNotCompleted).toBe(6122);
    expect(AnchorErrorCodes.ParentTaskAccountRequired).toBe(6123);
    expect(AnchorErrorCodes.UnauthorizedCreator).toBe(6124);
  });

  it('has correct nullifier error codes (6125-6126)', () => {
    expect(AnchorErrorCodes.NullifierAlreadySpent).toBe(6125);
    expect(AnchorErrorCodes.InvalidNullifier).toBe(6126);
  });

  it('has correct SPL token error codes (6143-6146)', () => {
    expect(AnchorErrorCodes.MissingTokenAccounts).toBe(6143);
    expect(AnchorErrorCodes.InvalidTokenEscrow).toBe(6144);
    expect(AnchorErrorCodes.InvalidTokenMint).toBe(6145);
    expect(AnchorErrorCodes.TokenTransferFailed).toBe(6146);
  });
});

describe('RuntimeError', () => {
  it('has correct properties', () => {
    const error = new RuntimeError('Test message', RuntimeErrorCodes.VALIDATION_ERROR);

    expect(error.name).toBe('RuntimeError');
    expect(error.message).toBe('Test message');
    expect(error.code).toBe('VALIDATION_ERROR');
  });

  it('is instanceof Error', () => {
    const error = new RuntimeError('Test', RuntimeErrorCodes.VALIDATION_ERROR);

    expect(error instanceof Error).toBe(true);
    expect(error instanceof RuntimeError).toBe(true);
  });

  it('has stack trace', () => {
    const error = new RuntimeError('Test', RuntimeErrorCodes.VALIDATION_ERROR);

    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('RuntimeError');
  });
});

describe('AgentNotRegisteredError', () => {
  it('has correct message and code', () => {
    const error = new AgentNotRegisteredError();

    expect(error.name).toBe('AgentNotRegisteredError');
    expect(error.message).toBe('Agent is not registered in the protocol');
    expect(error.code).toBe(RuntimeErrorCodes.AGENT_NOT_REGISTERED);
  });

  it('is instanceof RuntimeError', () => {
    const error = new AgentNotRegisteredError();

    expect(error instanceof RuntimeError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });
});

describe('AgentAlreadyRegisteredError', () => {
  it('has correct message, code, and agentId', () => {
    const error = new AgentAlreadyRegisteredError('agent-123');

    expect(error.name).toBe('AgentAlreadyRegisteredError');
    expect(error.message).toBe('Agent "agent-123" is already registered');
    expect(error.code).toBe(RuntimeErrorCodes.AGENT_ALREADY_REGISTERED);
    expect(error.agentId).toBe('agent-123');
  });

  it('is instanceof RuntimeError', () => {
    const error = new AgentAlreadyRegisteredError('test');

    expect(error instanceof RuntimeError).toBe(true);
  });
});

describe('ValidationError', () => {
  it('has correct message and code', () => {
    const error = new ValidationError('Invalid endpoint URL');

    expect(error.name).toBe('ValidationError');
    expect(error.message).toBe('Invalid endpoint URL');
    expect(error.code).toBe(RuntimeErrorCodes.VALIDATION_ERROR);
  });
});

describe('RateLimitError', () => {
  it('has correct properties', () => {
    const cooldownEnds = new Date('2024-01-01T12:00:00Z');
    const error = new RateLimitError('task_creation', cooldownEnds);

    expect(error.name).toBe('RateLimitError');
    expect(error.message).toContain('task_creation');
    expect(error.message).toContain(cooldownEnds.toISOString());
    expect(error.code).toBe(RuntimeErrorCodes.RATE_LIMIT_ERROR);
    expect(error.limitType).toBe('task_creation');
    expect(error.cooldownEnds).toBe(cooldownEnds);
  });
});

describe('InsufficientStakeError', () => {
  it('has correct properties with bigint values', () => {
    const required = BigInt('1000000000000');
    const available = BigInt('500000000000');
    const error = new InsufficientStakeError(required, available);

    expect(error.name).toBe('InsufficientStakeError');
    expect(error.message).toContain('1000000000000');
    expect(error.message).toContain('500000000000');
    expect(error.code).toBe(RuntimeErrorCodes.INSUFFICIENT_STAKE);
    expect(error.required).toBe(required);
    expect(error.available).toBe(available);
  });

  it('handles large bigint values correctly', () => {
    const required = BigInt('9007199254740993'); // Larger than MAX_SAFE_INTEGER
    const available = BigInt('1');
    const error = new InsufficientStakeError(required, available);

    expect(error.required).toBe(required);
    expect(error.available).toBe(available);
  });
});

describe('ActiveTasksError', () => {
  it('has correct properties', () => {
    const error = new ActiveTasksError(5);

    expect(error.name).toBe('ActiveTasksError');
    expect(error.message).toContain('5 active tasks');
    expect(error.code).toBe(RuntimeErrorCodes.ACTIVE_TASKS_ERROR);
    expect(error.activeTaskCount).toBe(5);
  });

  it('handles singular correctly', () => {
    const error = new ActiveTasksError(1);

    expect(error.message).toContain('1 active task');
    expect(error.message).not.toContain('tasks');
  });
});

describe('PendingDisputeVotesError', () => {
  it('has correct properties', () => {
    const error = new PendingDisputeVotesError(3);

    expect(error.name).toBe('PendingDisputeVotesError');
    expect(error.message).toContain('3 pending dispute votes');
    expect(error.code).toBe(RuntimeErrorCodes.PENDING_DISPUTE_VOTES);
    expect(error.voteCount).toBe(3);
  });

  it('handles singular correctly', () => {
    const error = new PendingDisputeVotesError(1);

    expect(error.message).toContain('1 pending dispute vote');
    expect(error.message).not.toContain('votes');
  });
});

describe('RecentVoteActivityError', () => {
  it('has correct properties', () => {
    const lastVote = new Date('2024-01-01T10:00:00Z');
    const error = new RecentVoteActivityError(lastVote);

    expect(error.name).toBe('RecentVoteActivityError');
    expect(error.message).toContain('24 hours');
    expect(error.message).toContain(lastVote.toISOString());
    expect(error.code).toBe(RuntimeErrorCodes.RECENT_VOTE_ACTIVITY);
    expect(error.lastVoteTimestamp).toBe(lastVote);
  });
});

describe('isAnchorError', () => {
  it('returns true for direct code property', () => {
    const error = { code: 6000 };
    expect(isAnchorError(error, AnchorErrorCodes.AgentAlreadyRegistered)).toBe(true);
  });

  it('returns false for wrong code', () => {
    const error = { code: 6000 };
    expect(isAnchorError(error, AnchorErrorCodes.AgentNotFound)).toBe(false);
  });

  it('handles Anchor SDK errorCode format', () => {
    const error = {
      errorCode: {
        code: 'AgentNotFound',
        number: 6001,
      },
    };
    expect(isAnchorError(error, AnchorErrorCodes.AgentNotFound)).toBe(true);
    expect(isAnchorError(error, AnchorErrorCodes.AgentAlreadyRegistered)).toBe(false);
  });

  it('handles nested error.error format', () => {
    const error = {
      error: {
        errorCode: {
          code: 'TaskNotOpen',
          number: AnchorErrorCodes.TaskNotOpen,
        },
      },
    };
    expect(isAnchorError(error, AnchorErrorCodes.TaskNotOpen)).toBe(true);
  });

  it('handles transaction logs', () => {
    const error = {
      logs: [
        'Program log: AnchorError',
        'Program log: Error Code: AgentNotFound. Error Number: 6001. Message: Agent not found',
      ],
    };
    expect(isAnchorError(error, AnchorErrorCodes.AgentNotFound)).toBe(true);
    expect(isAnchorError(error, AnchorErrorCodes.AgentAlreadyRegistered)).toBe(false);
  });

  it('handles hex error code in message', () => {
    const error = {
      message: 'failed to send transaction: Transaction simulation failed: custom program error: 0x1770',
    };
    // 0x1770 = 6000
    expect(isAnchorError(error, AnchorErrorCodes.AgentAlreadyRegistered)).toBe(true);
  });

  it('handles decimal error code in message', () => {
    const error = {
      message: `Error Number: ${AnchorErrorCodes.AlreadyClaimed}`,
    };
    expect(isAnchorError(error, AnchorErrorCodes.AlreadyClaimed)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isAnchorError(null, AnchorErrorCodes.AgentNotFound)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isAnchorError(undefined, AnchorErrorCodes.AgentNotFound)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isAnchorError('error', AnchorErrorCodes.AgentNotFound)).toBe(false);
    expect(isAnchorError(123, AnchorErrorCodes.AgentNotFound)).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isAnchorError({}, AnchorErrorCodes.AgentNotFound)).toBe(false);
  });
});

describe('parseAnchorError', () => {
  it('parses direct code property', () => {
    const error = { code: 6000 };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(6000);
    expect(parsed?.name).toBe('AgentAlreadyRegistered');
    expect(parsed?.message).toBe('Agent is already registered');
  });

  it('parses Anchor SDK errorCode format', () => {
    const error = {
      errorCode: {
        code: 'TaskExpired',
        number: AnchorErrorCodes.TaskExpired,
      },
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(AnchorErrorCodes.TaskExpired);
    expect(parsed?.name).toBe('TaskExpired');
    expect(parsed?.message).toBe('Task has expired');
  });

  it('parses nested error.error format', () => {
    const error = {
      error: {
        errorCode: {
          code: 'ZkVerificationFailed',
          number: AnchorErrorCodes.ZkVerificationFailed,
        },
      },
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(AnchorErrorCodes.ZkVerificationFailed);
    expect(parsed?.name).toBe('ZkVerificationFailed');
  });

  it('parses transaction logs', () => {
    const error = {
      logs: [
        `Program log: Error Code: DisputeNotActive. Error Number: ${AnchorErrorCodes.DisputeNotActive}. Some message`,
      ],
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(AnchorErrorCodes.DisputeNotActive);
    expect(parsed?.name).toBe('DisputeNotActive');
  });

  it('parses hex error code in message', () => {
    const error = {
      message: `custom program error: 0x${AnchorErrorCodes.RateLimitExceeded.toString(16)}`,
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(AnchorErrorCodes.RateLimitExceeded);
    expect(parsed?.name).toBe('RateLimitExceeded');
  });

  it('parses decimal error code in message', () => {
    const error = {
      message: `Error Number: ${AnchorErrorCodes.InsufficientStake}`,
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(AnchorErrorCodes.InsufficientStake);
    expect(parsed?.name).toBe('InsufficientStake');
  });

  it('returns null for unknown error code', () => {
    const error = { code: 9999 };
    const parsed = parseAnchorError(error);

    expect(parsed).toBeNull();
  });

  it('returns null for code outside range', () => {
    expect(parseAnchorError({ code: 5999 })).toBeNull();
    expect(parseAnchorError({ code: 6161 })).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(parseAnchorError(null)).toBeNull();
    expect(parseAnchorError(undefined)).toBeNull();
  });

  it('returns null for non-object', () => {
    expect(parseAnchorError('error')).toBeNull();
    expect(parseAnchorError(123)).toBeNull();
  });

  it('returns correct message for all error codes', () => {
    // Test a sampling of error codes to ensure messages are mapped
    const testCases = [
      { code: 6000, expected: 'Agent is already registered' },
      { code: AnchorErrorCodes.ZkVerificationFailed, expected: 'ZK proof verification failed' },
      { code: AnchorErrorCodes.InsufficientStake, expected: 'Insufficient stake for arbiter registration' },
      { code: AnchorErrorCodes.UnauthorizedUpgrade, expected: 'Only upgrade authority can perform this action' },
      { code: AnchorErrorCodes.TokenTransferFailed, expected: 'SPL token transfer CPI failed' },
    ];

    for (const { code, expected } of testCases) {
      const parsed = parseAnchorError({ code });
      expect(parsed?.message).toBe(expected);
    }
  });
});

describe('getAnchorErrorName', () => {
  it('returns correct name for valid code', () => {
    expect(getAnchorErrorName(6000)).toBe('AgentAlreadyRegistered');
    expect(getAnchorErrorName(AnchorErrorCodes.ZkVerificationFailed)).toBe('ZkVerificationFailed');
    expect(getAnchorErrorName(AnchorErrorCodes.UnauthorizedUpgrade)).toBe('UnauthorizedUpgrade');
    expect(getAnchorErrorName(AnchorErrorCodes.TokenTransferFailed)).toBe('TokenTransferFailed');
  });

  it('returns undefined for invalid code', () => {
    expect(getAnchorErrorName(5999)).toBeUndefined();
    expect(getAnchorErrorName(6161)).toBeUndefined();
    expect(getAnchorErrorName(0)).toBeUndefined();
  });

  it('returns name for all 161 codes', () => {
    for (let code = 6000; code <= 6160; code++) {
      const name = getAnchorErrorName(code);
      expect(name).toBeDefined();
      expect(typeof name).toBe('string');
    }
  });
});

describe('getAnchorErrorMessage', () => {
  it('returns correct message for valid code', () => {
    expect(getAnchorErrorMessage(6000)).toBe('Agent is already registered');
    expect(getAnchorErrorMessage(AnchorErrorCodes.ZkVerificationFailed)).toBe('ZK proof verification failed');
    expect(getAnchorErrorMessage(AnchorErrorCodes.TokenTransferFailed)).toBe('SPL token transfer CPI failed');
  });

  it('returns message for all 147 codes', () => {
    for (let code = 6000; code <= 6146; code++) {
      const message = getAnchorErrorMessage(code as AnchorErrorCode);
      expect(message).toBeDefined();
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe('isRuntimeError', () => {
  it('returns true for RuntimeError instance', () => {
    const error = new RuntimeError('Test', RuntimeErrorCodes.VALIDATION_ERROR);
    expect(isRuntimeError(error)).toBe(true);
  });

  it('returns true for subclasses', () => {
    expect(isRuntimeError(new AgentNotRegisteredError())).toBe(true);
    expect(isRuntimeError(new AgentAlreadyRegisteredError('test'))).toBe(true);
    expect(isRuntimeError(new ValidationError('test'))).toBe(true);
    expect(isRuntimeError(new RateLimitError('test', new Date()))).toBe(true);
    expect(isRuntimeError(new InsufficientStakeError(1n, 0n))).toBe(true);
    expect(isRuntimeError(new ActiveTasksError(1))).toBe(true);
    expect(isRuntimeError(new PendingDisputeVotesError(1))).toBe(true);
    expect(isRuntimeError(new RecentVoteActivityError(new Date()))).toBe(true);
  });

  it('returns false for regular Error', () => {
    expect(isRuntimeError(new Error('Test'))).toBe(false);
  });

  it('returns false for non-errors', () => {
    expect(isRuntimeError(null)).toBe(false);
    expect(isRuntimeError(undefined)).toBe(false);
    expect(isRuntimeError('error')).toBe(false);
    expect(isRuntimeError({ message: 'error' })).toBe(false);
  });

  it('provides type guard functionality', () => {
    const error: unknown = new ValidationError('test');

    if (isRuntimeError(error)) {
      // TypeScript should recognize error.code is accessible
      expect(error.code).toBe(RuntimeErrorCodes.VALIDATION_ERROR);
    } else {
      throw new Error('Should have passed type guard');
    }
  });
});

describe('Error inheritance chain', () => {
  it('all specific errors extend RuntimeError', () => {
    const errors = [
      new AgentNotRegisteredError(),
      new AgentAlreadyRegisteredError('test'),
      new ValidationError('test'),
      new RateLimitError('test', new Date()),
      new InsufficientStakeError(1n, 0n),
      new ActiveTasksError(1),
      new PendingDisputeVotesError(1),
      new RecentVoteActivityError(new Date()),
    ];

    for (const error of errors) {
      expect(error instanceof RuntimeError).toBe(true);
      expect(error instanceof Error).toBe(true);
    }
  });

  it('error names are distinct', () => {
    const names = [
      new RuntimeError('', RuntimeErrorCodes.VALIDATION_ERROR).name,
      new AgentNotRegisteredError().name,
      new AgentAlreadyRegisteredError('test').name,
      new ValidationError('test').name,
      new RateLimitError('test', new Date()).name,
      new InsufficientStakeError(1n, 0n).name,
      new ActiveTasksError(1).name,
      new PendingDisputeVotesError(1).name,
      new RecentVoteActivityError(new Date()).name,
    ];

    const uniqueNames = new Set(names);
    expect(uniqueNames.size).toBe(names.length);
  });
});

describe('Type exports', () => {
  it('RuntimeErrorCode is assignable from RuntimeErrorCodes values', () => {
    const code: RuntimeErrorCode = RuntimeErrorCodes.VALIDATION_ERROR;
    expect(code).toBe('VALIDATION_ERROR');
  });

  it('AnchorErrorCode is assignable from AnchorErrorCodes values', () => {
    const code: AnchorErrorCode = AnchorErrorCodes.AgentNotFound;
    expect(code).toBe(6001);
  });

  it('AnchorErrorName is assignable from AnchorErrorCodes keys', () => {
    const name: AnchorErrorName = 'AgentNotFound';
    expect(name).toBe('AgentNotFound');
  });

  it('ParsedAnchorError has correct shape', () => {
    const parsed: ParsedAnchorError = {
      code: 6000,
      name: 'AgentAlreadyRegistered',
      message: 'Agent is already registered',
    };

    expect(parsed.code).toBe(6000);
    expect(parsed.name).toBe('AgentAlreadyRegistered');
    expect(parsed.message).toBe('Agent is already registered');
  });
});

describe('validateByteLength', () => {
  it('returns Uint8Array for valid input', () => {
    const input = new Uint8Array(32);
    const result = validateByteLength(input, 32, 'testParam');
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(32);
  });

  it('throws ValidationError for wrong length', () => {
    expect(() => validateByteLength(new Uint8Array(16), 32, 'testParam')).toThrow(ValidationError);
  });
});

describe('validateNonZeroBytes', () => {
  it('passes for non-zero bytes', () => {
    const input = new Uint8Array([1, 2, 3, 4]);
    expect(() => validateNonZeroBytes(input, 'testParam')).not.toThrow();
  });

  it('throws ValidationError for all-zero bytes', () => {
    expect(() => validateNonZeroBytes(new Uint8Array(32), 'testParam')).toThrow(ValidationError);
  });
});
