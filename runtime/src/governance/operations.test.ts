import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey, Keypair } from '@solana/web3.js';
import { GovernanceOperations } from './operations.js';
import {
  parseOnChainProposal,
  parseOnChainGovernanceVote,
  parseOnChainGovernanceConfig,
  proposalStatusToString,
  ProposalStatus,
  ProposalType,
  PROPOSAL_STATUS_OFFSET,
} from './types.js';
import { deriveProposalPda, deriveGovernanceVotePda, deriveGovernanceConfigPda, findProposalPda, findGovernanceVotePda, findGovernanceConfigPda } from './pda.js';
import { GovernanceProposalNotFoundError, GovernanceVoteError, GovernanceExecutionError } from './errors.js';
import { PROGRAM_ID } from '@agenc/sdk';

// ============================================================================
// Test Helpers
// ============================================================================

function randomPubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

function randomBytes(len: number): Uint8Array {
  return new Uint8Array(Array.from({ length: len }, () => Math.floor(Math.random() * 256)));
}

function mockRawProposal(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    proposer: randomPubkey(),
    proposerAuthority: randomPubkey(),
    nonce: { toString: () => '1' },
    proposalType: { feeChange: {} },
    titleHash: Array.from(randomBytes(32)),
    descriptionHash: Array.from(randomBytes(32)),
    payload: Array.from(randomBytes(64)),
    status: { active: {} },
    createdAt: { toNumber: () => 1700000000 },
    votingDeadline: { toNumber: () => 1700259200 },
    executionAfter: { toNumber: () => 1700345600 },
    executedAt: { toNumber: () => 0 },
    votesFor: { toString: () => '100' },
    votesAgainst: { toString: () => '50' },
    totalVoters: 3,
    quorum: { toString: () => '200' },
    bump: 255,
    ...overrides,
  };
}

function mockRawGovernanceVote(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    proposal: randomPubkey(),
    voter: randomPubkey(),
    approved: true,
    votedAt: { toNumber: () => 1700001000 },
    voteWeight: { toString: () => '500' },
    bump: 254,
    ...overrides,
  };
}

function createMockProgram(overrides: Record<string, any> = {}) {
  const rpcMock = vi.fn().mockResolvedValue('mock-signature');

  const methodBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: rpcMock,
  };

  return {
    programId: PROGRAM_ID,
    provider: {
      publicKey: randomPubkey(),
    },
    account: {
      proposal: {
        fetchNullable: vi.fn(),
        all: vi.fn().mockResolvedValue([]),
      },
      governanceVote: {
        fetchNullable: vi.fn(),
        all: vi.fn().mockResolvedValue([]),
      },
      governanceConfig: {
        fetchNullable: vi.fn(),
      },
    },
    methods: {
      createProposal: vi.fn().mockReturnValue(methodBuilder),
      voteProposal: vi.fn().mockReturnValue(methodBuilder),
      executeProposal: vi.fn().mockReturnValue(methodBuilder),
      cancelProposal: vi.fn().mockReturnValue(methodBuilder),
      initializeGovernance: vi.fn().mockReturnValue(methodBuilder),
    },
    ...overrides,
  };
}

// ============================================================================
// PDA Derivation Tests
// ============================================================================

describe('PDA derivation', () => {
  it('derives deterministic proposal PDA', () => {
    const proposerPda = randomPubkey();
    const nonce = 1n;
    const pda1 = deriveProposalPda(proposerPda, nonce);
    const pda2 = deriveProposalPda(proposerPda, nonce);
    expect(pda1.address.toBase58()).toBe(pda2.address.toBase58());
    expect(pda1.bump).toBe(pda2.bump);
  });

  it('derives different PDAs for different nonces', () => {
    const proposerPda = randomPubkey();
    const pda1 = findProposalPda(proposerPda, 0n);
    const pda2 = findProposalPda(proposerPda, 1n);
    expect(pda1.toBase58()).not.toBe(pda2.toBase58());
  });

  it('derives deterministic governance vote PDA', () => {
    const proposalPda = randomPubkey();
    const voterPda = randomPubkey();
    const pda1 = deriveGovernanceVotePda(proposalPda, voterPda);
    const pda2 = deriveGovernanceVotePda(proposalPda, voterPda);
    expect(pda1.address.toBase58()).toBe(pda2.address.toBase58());
  });

  it('findGovernanceVotePda returns address only', () => {
    const proposalPda = randomPubkey();
    const voterPda = randomPubkey();
    const addr = findGovernanceVotePda(proposalPda, voterPda);
    expect(addr).toBeInstanceOf(PublicKey);
  });
});

// ============================================================================
// Parse Function Tests
// ============================================================================

describe('parseOnChainProposal', () => {
  it('parses raw proposal data', () => {
    const proposer = randomPubkey();
    const raw = mockRawProposal({ proposer, proposalType: { treasurySpend: {} } });
    const parsed = parseOnChainProposal(raw);
    expect(parsed.proposer).toBe(proposer);
    expect(parsed.proposalType).toBe(ProposalType.TreasurySpend);
    expect(parsed.status).toBe(ProposalStatus.Active);
    expect(parsed.votesFor).toBe(100n);
    expect(parsed.votesAgainst).toBe(50n);
    expect(parsed.totalVoters).toBe(3);
    expect(parsed.createdAt).toBe(1700000000);
    expect(parsed.executionAfter).toBe(1700345600);
    expect(parsed.executedAt).toBe(0);
    expect(parsed.quorum).toBe(200n);
    expect(parsed.bump).toBe(255);
  });

  it('parses all proposal types', () => {
    expect(parseOnChainProposal(mockRawProposal({ proposalType: { protocolUpgrade: {} } })).proposalType).toBe(ProposalType.ProtocolUpgrade);
    expect(parseOnChainProposal(mockRawProposal({ proposalType: { feeChange: {} } })).proposalType).toBe(ProposalType.FeeChange);
    expect(parseOnChainProposal(mockRawProposal({ proposalType: { treasurySpend: {} } })).proposalType).toBe(ProposalType.TreasurySpend);
    expect(parseOnChainProposal(mockRawProposal({ proposalType: { rateLimitChange: {} } })).proposalType).toBe(ProposalType.RateLimitChange);
  });

  it('parses all proposal statuses', () => {
    expect(parseOnChainProposal(mockRawProposal({ status: { active: {} } })).status).toBe(ProposalStatus.Active);
    expect(parseOnChainProposal(mockRawProposal({ status: { executed: {} } })).status).toBe(ProposalStatus.Executed);
    expect(parseOnChainProposal(mockRawProposal({ status: { defeated: {} } })).status).toBe(ProposalStatus.Defeated);
    expect(parseOnChainProposal(mockRawProposal({ status: { cancelled: {} } })).status).toBe(ProposalStatus.Cancelled);
  });

  it('handles BN-like nonce values', () => {
    const parsed = parseOnChainProposal(mockRawProposal({ nonce: { toString: () => '42' } }));
    expect(parsed.nonce).toBe(42n);
  });
});

describe('parseOnChainGovernanceVote', () => {
  it('parses raw vote data', () => {
    const voter = randomPubkey();
    const raw = mockRawGovernanceVote({ voter, approved: false });
    const parsed = parseOnChainGovernanceVote(raw);
    expect(parsed.voter).toBe(voter);
    expect(parsed.approved).toBe(false);
    expect(parsed.voteWeight).toBe(500n);
    expect(parsed.votedAt).toBe(1700001000);
  });
});

describe('proposalStatusToString', () => {
  it('converts all statuses to strings', () => {
    expect(proposalStatusToString(ProposalStatus.Active)).toBe('Active');
    expect(proposalStatusToString(ProposalStatus.Executed)).toBe('Executed');
    expect(proposalStatusToString(ProposalStatus.Defeated)).toBe('Defeated');
    expect(proposalStatusToString(ProposalStatus.Cancelled)).toBe('Cancelled');
  });

  it('returns Unknown for invalid status', () => {
    expect(proposalStatusToString(99 as ProposalStatus)).toBe('Unknown(99)');
  });
});

// ============================================================================
// GovernanceOperations Tests
// ============================================================================

describe('GovernanceOperations', () => {
  let ops: GovernanceOperations;
  let mockProgram: any;

  beforeEach(() => {
    mockProgram = createMockProgram();
    ops = new GovernanceOperations({
      program: mockProgram,
      agentId: randomBytes(32),
    });
  });

  describe('fetchProposal', () => {
    it('returns parsed proposal', async () => {
      const raw = mockRawProposal();
      mockProgram.account.proposal.fetchNullable.mockResolvedValue(raw);
      const result = await ops.fetchProposal(randomPubkey());
      expect(result).not.toBeNull();
      expect(result!.status).toBe(ProposalStatus.Active);
    });

    it('returns null for missing proposal', async () => {
      mockProgram.account.proposal.fetchNullable.mockResolvedValue(null);
      const result = await ops.fetchProposal(randomPubkey());
      expect(result).toBeNull();
    });
  });

  describe('fetchAllProposals', () => {
    it('returns all proposals', async () => {
      const accounts = [
        { publicKey: randomPubkey(), account: mockRawProposal() },
        { publicKey: randomPubkey(), account: mockRawProposal({ status: { executed: {} } }) },
      ];
      mockProgram.account.proposal.all.mockResolvedValue(accounts);
      const result = await ops.fetchAllProposals();
      expect(result).toHaveLength(2);
      expect(result[0].proposal.status).toBe(ProposalStatus.Active);
      expect(result[1].proposal.status).toBe(ProposalStatus.Executed);
    });
  });

  describe('fetchActiveProposals', () => {
    it('filters by active status', async () => {
      const accounts = [
        { publicKey: randomPubkey(), account: mockRawProposal() },
      ];
      mockProgram.account.proposal.all.mockResolvedValue(accounts);
      const result = await ops.fetchActiveProposals();
      expect(result).toHaveLength(1);
      expect(result[0].proposal.status).toBe(ProposalStatus.Active);
    });
  });

  describe('fetchGovernanceVote', () => {
    it('returns parsed vote', async () => {
      const raw = mockRawGovernanceVote();
      mockProgram.account.governanceVote.fetchNullable.mockResolvedValue(raw);
      const result = await ops.fetchGovernanceVote(randomPubkey());
      expect(result).not.toBeNull();
      expect(result!.approved).toBe(true);
    });

    it('returns null for missing vote', async () => {
      mockProgram.account.governanceVote.fetchNullable.mockResolvedValue(null);
      const result = await ops.fetchGovernanceVote(randomPubkey());
      expect(result).toBeNull();
    });
  });

  describe('createProposal', () => {
    it('calls program.methods.createProposal and returns result', async () => {
      const result = await ops.createProposal({
        nonce: 0n,
        proposalType: ProposalType.FeeChange,
        titleHash: randomBytes(32),
        descriptionHash: randomBytes(32),
        payload: randomBytes(64),
        votingPeriod: 259200,
      });
      expect(result.transactionSignature).toBe('mock-signature');
      expect(result.proposalPda).toBeInstanceOf(PublicKey);
      expect(mockProgram.methods.createProposal).toHaveBeenCalled();
    });
  });

  describe('vote', () => {
    it('calls program.methods.voteProposal with approve=true', async () => {
      const result = await ops.vote({
        proposalPda: randomPubkey(),
        approve: true,
      });
      expect(result.transactionSignature).toBe('mock-signature');
      expect(result.votePda).toBeInstanceOf(PublicKey);
      expect(mockProgram.methods.voteProposal).toHaveBeenCalledWith(true);
    });

    it('throws GovernanceVoteError for ProposalNotActive', async () => {
      const rpcMock = vi.fn().mockRejectedValue({ code: 6147 });
      mockProgram.methods.voteProposal.mockReturnValue({
        accountsPartial: vi.fn().mockReturnValue({ rpc: rpcMock }),
      });

      await expect(
        ops.vote({ proposalPda: randomPubkey(), approve: true }),
      ).rejects.toThrow(GovernanceVoteError);
    });

    it('throws GovernanceVoteError for ProposalVotingEnded', async () => {
      const rpcMock = vi.fn().mockRejectedValue({ code: 6149 });
      mockProgram.methods.voteProposal.mockReturnValue({
        accountsPartial: vi.fn().mockReturnValue({ rpc: rpcMock }),
      });

      await expect(
        ops.vote({ proposalPda: randomPubkey(), approve: false }),
      ).rejects.toThrow(GovernanceVoteError);
    });
  });

  describe('executeProposal', () => {
    it('calls program.methods.executeProposal', async () => {
      const proposalPda = randomPubkey();
      const result = await ops.executeProposal({ proposalPda });
      expect(result.transactionSignature).toBe('mock-signature');
      expect(result.proposalPda).toBe(proposalPda);
    });

    it('throws GovernanceExecutionError for insufficient quorum', async () => {
      const rpcMock = vi.fn().mockRejectedValue({ code: 6151 });
      mockProgram.methods.executeProposal.mockReturnValue({
        accountsPartial: vi.fn().mockReturnValue({ rpc: rpcMock }),
      });

      await expect(
        ops.executeProposal({ proposalPda: randomPubkey() }),
      ).rejects.toThrow(GovernanceExecutionError);
    });

    it('throws GovernanceExecutionError for not approved', async () => {
      const rpcMock = vi.fn().mockRejectedValue({ code: 6152 });
      mockProgram.methods.executeProposal.mockReturnValue({
        accountsPartial: vi.fn().mockReturnValue({ rpc: rpcMock }),
      });

      await expect(
        ops.executeProposal({ proposalPda: randomPubkey() }),
      ).rejects.toThrow(GovernanceExecutionError);
    });
  });
});

// ============================================================================
// Error Class Tests
// ============================================================================

describe('Governance Errors', () => {
  it('GovernanceProposalNotFoundError has correct name and code', () => {
    const err = new GovernanceProposalNotFoundError('abc123');
    expect(err.name).toBe('GovernanceProposalNotFoundError');
    expect(err.proposalPda).toBe('abc123');
    expect(err.message).toContain('abc123');
  });

  it('GovernanceVoteError has correct name and fields', () => {
    const err = new GovernanceVoteError('pda1', 'not active');
    expect(err.name).toBe('GovernanceVoteError');
    expect(err.proposalPda).toBe('pda1');
    expect(err.reason).toBe('not active');
  });

  it('GovernanceExecutionError has correct name and fields', () => {
    const err = new GovernanceExecutionError('pda2', 'no quorum');
    expect(err.name).toBe('GovernanceExecutionError');
    expect(err.proposalPda).toBe('pda2');
    expect(err.reason).toBe('no quorum');
  });
});

// ============================================================================
// GovernanceConfig PDA Tests
// ============================================================================

describe('GovernanceConfig PDA', () => {
  it('derives deterministic governance config PDA', () => {
    const pda1 = deriveGovernanceConfigPda();
    const pda2 = deriveGovernanceConfigPda();
    expect(pda1.address.toBase58()).toBe(pda2.address.toBase58());
  });

  it('findGovernanceConfigPda returns address only', () => {
    const addr = findGovernanceConfigPda();
    expect(addr).toBeInstanceOf(PublicKey);
  });
});

// ============================================================================
// parseOnChainGovernanceConfig Tests
// ============================================================================

describe('parseOnChainGovernanceConfig', () => {
  it('parses raw governance config data', () => {
    const authority = randomPubkey();
    const raw = {
      authority,
      minProposalStake: { toString: () => '1000000000' },
      votingPeriod: { toNumber: () => 259200 },
      executionDelay: { toNumber: () => 86400 },
      quorumBps: 1000,
      approvalThresholdBps: 5000,
      totalProposals: { toString: () => '5' },
      bump: 253,
    };
    const parsed = parseOnChainGovernanceConfig(raw);
    expect(parsed.authority).toBe(authority);
    expect(parsed.minProposalStake).toBe(1000000000n);
    expect(parsed.votingPeriod).toBe(259200);
    expect(parsed.executionDelay).toBe(86400);
    expect(parsed.quorumBps).toBe(1000);
    expect(parsed.approvalThresholdBps).toBe(5000);
    expect(parsed.totalProposals).toBe(5n);
    expect(parsed.bump).toBe(253);
  });
});

// ============================================================================
// GovernanceOperations: initializeGovernance, cancelProposal, fetchGovernanceConfig
// ============================================================================

describe('GovernanceOperations extended methods', () => {
  let mockProgram: ReturnType<typeof createMockProgram>;
  let ops: GovernanceOperations;
  const agentId = randomBytes(32);

  beforeEach(() => {
    mockProgram = createMockProgram();
    ops = new GovernanceOperations({ program: mockProgram as any, agentId });
  });

  describe('initializeGovernance', () => {
    it('sends initializeGovernance transaction', async () => {
      const result = await ops.initializeGovernance({
        votingPeriod: 259200,
        executionDelay: 86400,
        quorumBps: 1000,
        approvalThresholdBps: 5000,
        minProposalStake: 1_000_000_000n,
      });
      expect(result.transactionSignature).toBe('mock-signature');
      expect(result.governanceConfigPda).toBeInstanceOf(PublicKey);
      expect(mockProgram.methods.initializeGovernance).toHaveBeenCalledWith(
        259200, 86400, 1000, 5000, 1_000_000_000n,
      );
    });
  });

  describe('cancelProposal', () => {
    it('cancels a proposal', async () => {
      const proposalPda = randomPubkey();
      const result = await ops.cancelProposal({ proposalPda });
      expect(result.transactionSignature).toBe('mock-signature');
      expect(result.proposalPda).toBe(proposalPda);
      expect(mockProgram.methods.cancelProposal).toHaveBeenCalled();
    });

    it('maps ProposalNotActive to GovernanceProposalNotFoundError', async () => {
      const rpcMock = vi.fn().mockRejectedValue(
        Object.assign(new Error(), { error: { errorCode: { code: 'ProposalNotActive', number: 6147 } } }),
      );
      mockProgram.methods.cancelProposal.mockReturnValue({
        accountsPartial: vi.fn().mockReturnValue({ rpc: rpcMock }),
      });
      await expect(
        ops.cancelProposal({ proposalPda: randomPubkey() }),
      ).rejects.toThrow(GovernanceProposalNotFoundError);
    });

    it('maps ProposalUnauthorizedCancel to GovernanceExecutionError', async () => {
      const rpcMock = vi.fn().mockRejectedValue(
        Object.assign(new Error(), { error: { errorCode: { code: 'ProposalUnauthorizedCancel', number: 6153 } } }),
      );
      mockProgram.methods.cancelProposal.mockReturnValue({
        accountsPartial: vi.fn().mockReturnValue({ rpc: rpcMock }),
      });
      await expect(
        ops.cancelProposal({ proposalPda: randomPubkey() }),
      ).rejects.toThrow(GovernanceExecutionError);
    });
  });

  describe('fetchGovernanceConfig', () => {
    it('returns parsed governance config', async () => {
      const authority = randomPubkey();
      mockProgram.account.governanceConfig.fetchNullable.mockResolvedValue({
        authority,
        minProposalStake: { toString: () => '1000000000' },
        votingPeriod: { toNumber: () => 259200 },
        executionDelay: { toNumber: () => 86400 },
        quorumBps: 1000,
        approvalThresholdBps: 5000,
        totalProposals: { toString: () => '0' },
        bump: 253,
      });
      const config = await ops.fetchGovernanceConfig();
      expect(config).not.toBeNull();
      expect(config!.authority).toBe(authority);
      expect(config!.votingPeriod).toBe(259200);
    });

    it('returns null when not initialized', async () => {
      mockProgram.account.governanceConfig.fetchNullable.mockResolvedValue(null);
      const config = await ops.fetchGovernanceConfig();
      expect(config).toBeNull();
    });
  });
});

// ============================================================================
// Constants Tests
// ============================================================================

describe('Constants', () => {
  it('PROPOSAL_STATUS_OFFSET is correct', () => {
    // 8 (disc) + 32 (proposer) + 32 (proposer_authority) + 8 (nonce)
    // + 1 (proposal_type) + 32 (title_hash) + 32 (description_hash) + 64 (payload) = 209
    expect(PROPOSAL_STATUS_OFFSET).toBe(209);
  });
});
