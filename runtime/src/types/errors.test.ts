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
  });

  it('has exactly 13 error codes', () => {
    expect(Object.keys(RuntimeErrorCodes)).toHaveLength(13);
  });
});

describe('AnchorErrorCodes', () => {
  it('has exactly 78 error codes (6000-6077)', () => {
    expect(Object.keys(AnchorErrorCodes)).toHaveLength(78);
  });

  it('has codes in range 6000-6077', () => {
    const codes = Object.values(AnchorErrorCodes);
    const minCode = Math.min(...codes);
    const maxCode = Math.max(...codes);

    expect(minCode).toBe(6000);
    expect(maxCode).toBe(6077);
  });

  it('has sequential codes (no gaps)', () => {
    const codes = Object.values(AnchorErrorCodes).sort((a, b) => a - b);
    for (let i = 0; i < codes.length; i++) {
      expect(codes[i]).toBe(6000 + i);
    }
  });

  it('has correct agent error codes (6000-6007)', () => {
    expect(AnchorErrorCodes.AgentAlreadyRegistered).toBe(6000);
    expect(AnchorErrorCodes.AgentNotFound).toBe(6001);
    expect(AnchorErrorCodes.AgentNotActive).toBe(6002);
    expect(AnchorErrorCodes.InsufficientCapabilities).toBe(6003);
    expect(AnchorErrorCodes.MaxActiveTasksReached).toBe(6004);
    expect(AnchorErrorCodes.AgentHasActiveTasks).toBe(6005);
    expect(AnchorErrorCodes.UnauthorizedAgent).toBe(6006);
    expect(AnchorErrorCodes.AgentRegistrationRequired).toBe(6007);
  });

  it('has correct task error codes (6008-6023)', () => {
    expect(AnchorErrorCodes.TaskNotFound).toBe(6008);
    expect(AnchorErrorCodes.TaskNotOpen).toBe(6009);
    expect(AnchorErrorCodes.TaskFullyClaimed).toBe(6010);
    expect(AnchorErrorCodes.TaskExpired).toBe(6011);
    expect(AnchorErrorCodes.TaskNotExpired).toBe(6012);
    expect(AnchorErrorCodes.DeadlinePassed).toBe(6013);
    expect(AnchorErrorCodes.TaskNotInProgress).toBe(6014);
    expect(AnchorErrorCodes.TaskAlreadyCompleted).toBe(6015);
    expect(AnchorErrorCodes.TaskCannotBeCancelled).toBe(6016);
    expect(AnchorErrorCodes.UnauthorizedTaskAction).toBe(6017);
    expect(AnchorErrorCodes.InvalidCreator).toBe(6018);
    expect(AnchorErrorCodes.InvalidTaskType).toBe(6019);
    expect(AnchorErrorCodes.CompetitiveTaskAlreadyWon).toBe(6020);
    expect(AnchorErrorCodes.NoWorkers).toBe(6021);
    expect(AnchorErrorCodes.ConstraintHashMismatch).toBe(6022);
    expect(AnchorErrorCodes.NotPrivateTask).toBe(6023);
  });

  it('has correct claim error codes (6024-6032)', () => {
    expect(AnchorErrorCodes.AlreadyClaimed).toBe(6024);
    expect(AnchorErrorCodes.NotClaimed).toBe(6025);
    expect(AnchorErrorCodes.ClaimAlreadyCompleted).toBe(6026);
    expect(AnchorErrorCodes.ClaimNotExpired).toBe(6027);
    expect(AnchorErrorCodes.InvalidProof).toBe(6028);
    expect(AnchorErrorCodes.ZkVerificationFailed).toBe(6029);
    expect(AnchorErrorCodes.InvalidProofSize).toBe(6030);
    expect(AnchorErrorCodes.InvalidProofBinding).toBe(6031);
    expect(AnchorErrorCodes.InvalidOutputCommitment).toBe(6032);
  });

  it('has correct dispute error codes (6033-6047)', () => {
    expect(AnchorErrorCodes.DisputeNotActive).toBe(6033);
    expect(AnchorErrorCodes.VotingEnded).toBe(6034);
    expect(AnchorErrorCodes.VotingNotEnded).toBe(6035);
    expect(AnchorErrorCodes.AlreadyVoted).toBe(6036);
    expect(AnchorErrorCodes.NotArbiter).toBe(6037);
    expect(AnchorErrorCodes.InsufficientVotes).toBe(6038);
    expect(AnchorErrorCodes.DisputeAlreadyResolved).toBe(6039);
    expect(AnchorErrorCodes.UnauthorizedResolver).toBe(6040);
    expect(AnchorErrorCodes.ActiveDisputeVotes).toBe(6041);
    expect(AnchorErrorCodes.RecentVoteActivity).toBe(6042);
    expect(AnchorErrorCodes.InsufficientEvidence).toBe(6043);
    expect(AnchorErrorCodes.EvidenceTooLong).toBe(6044);
    expect(AnchorErrorCodes.DisputeNotExpired).toBe(6045);
    expect(AnchorErrorCodes.SlashAlreadyApplied).toBe(6046);
    expect(AnchorErrorCodes.DisputeNotResolved).toBe(6047);
  });

  it('has correct state error codes (6048-6050)', () => {
    expect(AnchorErrorCodes.VersionMismatch).toBe(6048);
    expect(AnchorErrorCodes.StateKeyExists).toBe(6049);
    expect(AnchorErrorCodes.StateNotFound).toBe(6050);
  });

  it('has correct protocol error codes (6051-6061)', () => {
    expect(AnchorErrorCodes.ProtocolAlreadyInitialized).toBe(6051);
    expect(AnchorErrorCodes.ProtocolNotInitialized).toBe(6052);
    expect(AnchorErrorCodes.InvalidProtocolFee).toBe(6053);
    expect(AnchorErrorCodes.InvalidDisputeThreshold).toBe(6054);
    expect(AnchorErrorCodes.InsufficientStake).toBe(6055);
    expect(AnchorErrorCodes.MultisigInvalidThreshold).toBe(6056);
    expect(AnchorErrorCodes.MultisigInvalidSigners).toBe(6057);
    expect(AnchorErrorCodes.MultisigNotEnoughSigners).toBe(6058);
    expect(AnchorErrorCodes.MultisigDuplicateSigner).toBe(6059);
    expect(AnchorErrorCodes.MultisigDefaultSigner).toBe(6060);
    expect(AnchorErrorCodes.MultisigSignerNotSystemOwned).toBe(6061);
  });

  it('has correct general error codes (6062-6068)', () => {
    expect(AnchorErrorCodes.InvalidInput).toBe(6062);
    expect(AnchorErrorCodes.ArithmeticOverflow).toBe(6063);
    expect(AnchorErrorCodes.VoteOverflow).toBe(6064);
    expect(AnchorErrorCodes.InsufficientFunds).toBe(6065);
    expect(AnchorErrorCodes.CorruptedData).toBe(6066);
    expect(AnchorErrorCodes.StringTooLong).toBe(6067);
    expect(AnchorErrorCodes.InvalidAccountOwner).toBe(6068);
  });

  it('has correct rate limiting error codes (6069-6071)', () => {
    expect(AnchorErrorCodes.RateLimitExceeded).toBe(6069);
    expect(AnchorErrorCodes.CooldownNotElapsed).toBe(6070);
    expect(AnchorErrorCodes.InsufficientStakeForDispute).toBe(6071);
  });

  it('has correct version/upgrade error codes (6072-6077)', () => {
    expect(AnchorErrorCodes.VersionMismatchProtocol).toBe(6072);
    expect(AnchorErrorCodes.AccountVersionTooOld).toBe(6073);
    expect(AnchorErrorCodes.AccountVersionTooNew).toBe(6074);
    expect(AnchorErrorCodes.InvalidMigrationSource).toBe(6075);
    expect(AnchorErrorCodes.InvalidMigrationTarget).toBe(6076);
    expect(AnchorErrorCodes.UnauthorizedUpgrade).toBe(6077);
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
          number: 6009,
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
      message: 'Error Number: 6024',
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
        number: 6011,
      },
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(6011);
    expect(parsed?.name).toBe('TaskExpired');
    expect(parsed?.message).toBe('Task has expired');
  });

  it('parses nested error.error format', () => {
    const error = {
      error: {
        errorCode: {
          code: 'ZkVerificationFailed',
          number: 6029,
        },
      },
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(6029);
    expect(parsed?.name).toBe('ZkVerificationFailed');
  });

  it('parses transaction logs', () => {
    const error = {
      logs: [
        'Program log: Error Code: DisputeNotActive. Error Number: 6033. Some message',
      ],
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(6033);
    expect(parsed?.name).toBe('DisputeNotActive');
  });

  it('parses hex error code in message', () => {
    const error = {
      message: 'custom program error: 0x17b5', // 6069
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(6069);
    expect(parsed?.name).toBe('RateLimitExceeded');
  });

  it('parses decimal error code in message', () => {
    const error = {
      message: 'Error Number: 6055',
    };
    const parsed = parseAnchorError(error);

    expect(parsed).not.toBeNull();
    expect(parsed?.code).toBe(6055);
    expect(parsed?.name).toBe('InsufficientStake');
  });

  it('returns null for unknown error code', () => {
    const error = { code: 9999 };
    const parsed = parseAnchorError(error);

    expect(parsed).toBeNull();
  });

  it('returns null for code outside range', () => {
    expect(parseAnchorError({ code: 5999 })).toBeNull();
    expect(parseAnchorError({ code: 6078 })).toBeNull();
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
      { code: 6029, expected: 'ZK proof verification failed' },
      { code: 6055, expected: 'Insufficient stake for arbiter registration' },
      { code: 6077, expected: 'Only upgrade authority can perform this action' },
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
    expect(getAnchorErrorName(6029)).toBe('ZkVerificationFailed');
    expect(getAnchorErrorName(6077)).toBe('UnauthorizedUpgrade');
  });

  it('returns undefined for invalid code', () => {
    expect(getAnchorErrorName(5999)).toBeUndefined();
    expect(getAnchorErrorName(6078)).toBeUndefined();
    expect(getAnchorErrorName(0)).toBeUndefined();
  });

  it('returns name for all 78 codes', () => {
    for (let code = 6000; code <= 6077; code++) {
      const name = getAnchorErrorName(code);
      expect(name).toBeDefined();
      expect(typeof name).toBe('string');
    }
  });
});

describe('getAnchorErrorMessage', () => {
  it('returns correct message for valid code', () => {
    expect(getAnchorErrorMessage(6000)).toBe('Agent is already registered');
    expect(getAnchorErrorMessage(6029)).toBe('ZK proof verification failed');
  });

  it('returns message for all 78 codes', () => {
    for (let code = 6000; code <= 6077; code++) {
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
