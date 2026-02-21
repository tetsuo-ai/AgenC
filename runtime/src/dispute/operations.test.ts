import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { DisputeOperations, type DisputeOpsConfig } from "./operations.js";
import {
  parseOnChainDispute,
  parseOnChainDisputeVote,
  disputeStatusToString,
  OnChainDisputeStatus,
  DISPUTE_STATUS_OFFSET,
  DISPUTE_TASK_OFFSET,
} from "./types.js";
import { ResolutionType } from "../events/types.js";
import {
  deriveDisputePda,
  deriveVotePda,
  findDisputePda,
  findVotePda,
} from "./pda.js";
import {
  DisputeNotFoundError,
  DisputeVoteError,
  DisputeResolutionError,
  DisputeSlashError,
} from "./errors.js";
import {
  RuntimeError,
  RuntimeErrorCodes,
  AnchorErrorCodes,
  ValidationError,
} from "../types/errors.js";
import { PROGRAM_ID, SEEDS } from "@agenc/sdk";
import { silentLogger } from "../utils/logger.js";
import { generateAgentId } from "../utils/encoding.js";

// ============================================================================
// Test Helpers
// ============================================================================

function randomPubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

function randomBytes(len: number): Uint8Array {
  return new Uint8Array(
    Array.from({ length: len }, () => Math.floor(Math.random() * 256)),
  );
}

/** Create an Anchor-like error with code */
function anchorError(code: number) {
  return { code, message: `custom program error: 0x${code.toString(16)}` };
}

/** Create a mock raw dispute account */
function mockRawDispute(
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    disputeId: Array.from(randomBytes(32)),
    task: randomPubkey(),
    initiator: randomPubkey(),
    initiatorAuthority: randomPubkey(),
    evidenceHash: Array.from(randomBytes(32)),
    resolutionType: { refund: {} },
    status: { active: {} },
    createdAt: { toNumber: () => 1700000000 },
    resolvedAt: { toNumber: () => 0 },
    votesFor: { toString: () => "100" },
    votesAgainst: { toString: () => "50" },
    totalVoters: 3,
    votingDeadline: { toNumber: () => 1700086400 },
    expiresAt: { toNumber: () => 1700172800 },
    slashApplied: false,
    initiatorSlashApplied: false,
    workerStakeAtDispute: { toString: () => "1000000000" },
    initiatedByCreator: false,
    bump: 255,
    defendant: randomPubkey(),
    ...overrides,
  };
}

/** Create a mock raw vote account */
function mockRawVote(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    dispute: randomPubkey(),
    voter: randomPubkey(),
    approved: true,
    votedAt: { toNumber: () => 1700001000 },
    stakeAtVote: { toString: () => "500000000" },
    bump: 254,
    ...overrides,
  };
}

// ============================================================================
// Mock Program Factory
// ============================================================================

function createMockProgram(overrides: Record<string, any> = {}) {
  const rpcMock = vi.fn().mockResolvedValue("mock-signature");

  const methodBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    remainingAccounts: vi.fn().mockReturnThis(),
    rpc: rpcMock,
  };

  return {
    programId: PROGRAM_ID,
    provider: {
      publicKey: randomPubkey(),
    },
    account: {
      dispute: {
        fetch: vi.fn(),
        fetchNullable: vi.fn(),
        all: vi.fn().mockResolvedValue([]),
      },
      disputeVote: {
        fetch: vi.fn(),
        fetchNullable: vi.fn(),
      },
      protocolConfig: {
        fetch: vi.fn().mockResolvedValue({ treasury: randomPubkey() }),
      },
      task: {
        fetch: vi.fn().mockResolvedValue({ rewardMint: null }),
      },
    },
    methods: {
      initiateDispute: vi.fn().mockReturnValue(methodBuilder),
      voteDispute: vi.fn().mockReturnValue(methodBuilder),
      resolveDispute: vi.fn().mockReturnValue(methodBuilder),
      cancelDispute: vi.fn().mockReturnValue(methodBuilder),
      expireDispute: vi.fn().mockReturnValue(methodBuilder),
      applyDisputeSlash: vi.fn().mockReturnValue(methodBuilder),
    },
    _methodBuilder: methodBuilder,
    _rpcMock: rpcMock,
    ...overrides,
  } as any;
}

// ============================================================================
// Parse Function Tests
// ============================================================================

describe("parseOnChainDispute", () => {
  it("parses BN fields to correct types", () => {
    const raw = mockRawDispute();
    const parsed = parseOnChainDispute(raw);

    expect(parsed.disputeId).toBeInstanceOf(Uint8Array);
    expect(parsed.disputeId.length).toBe(32);
    expect(parsed.createdAt).toBe(1700000000);
    expect(parsed.resolvedAt).toBe(0);
    expect(parsed.votesFor).toBe(100n);
    expect(parsed.votesAgainst).toBe(50n);
    expect(parsed.totalVoters).toBe(3);
    expect(parsed.votingDeadline).toBe(1700086400);
    expect(parsed.expiresAt).toBe(1700172800);
    expect(parsed.workerStakeAtDispute).toBe(1000000000n);
    expect(parsed.bump).toBe(255);
    expect(parsed.rewardMint).toBeNull();
  });

  it("parses enum objects correctly", () => {
    const raw = mockRawDispute({
      resolutionType: { complete: {} },
      status: { resolved: {} },
    });
    const parsed = parseOnChainDispute(raw);

    expect(parsed.resolutionType).toBe(ResolutionType.Complete);
    expect(parsed.status).toBe(OnChainDisputeStatus.Resolved);
  });

  it("parses boolean fields", () => {
    const raw = mockRawDispute({
      slashApplied: true,
      initiatorSlashApplied: true,
      initiatedByCreator: true,
    });
    const parsed = parseOnChainDispute(raw);

    expect(parsed.slashApplied).toBe(true);
    expect(parsed.initiatorSlashApplied).toBe(true);
    expect(parsed.initiatedByCreator).toBe(true);
  });

  it("handles all resolution types", () => {
    expect(
      parseOnChainDispute(mockRawDispute({ resolutionType: { refund: {} } }))
        .resolutionType,
    ).toBe(ResolutionType.Refund);
    expect(
      parseOnChainDispute(mockRawDispute({ resolutionType: { complete: {} } }))
        .resolutionType,
    ).toBe(ResolutionType.Complete);
    expect(
      parseOnChainDispute(mockRawDispute({ resolutionType: { split: {} } }))
        .resolutionType,
    ).toBe(ResolutionType.Split);
  });

  it("handles all dispute statuses", () => {
    expect(
      parseOnChainDispute(mockRawDispute({ status: { active: {} } })).status,
    ).toBe(OnChainDisputeStatus.Active);
    expect(
      parseOnChainDispute(mockRawDispute({ status: { resolved: {} } })).status,
    ).toBe(OnChainDisputeStatus.Resolved);
    expect(
      parseOnChainDispute(mockRawDispute({ status: { expired: {} } })).status,
    ).toBe(OnChainDisputeStatus.Expired);
    expect(
      parseOnChainDispute(mockRawDispute({ status: { cancelled: {} } })).status,
    ).toBe(OnChainDisputeStatus.Cancelled);
  });
});

describe("parseOnChainDisputeVote", () => {
  it("parses raw vote data correctly", () => {
    const raw = mockRawVote();
    const parsed = parseOnChainDisputeVote(raw);

    expect(parsed.approved).toBe(true);
    expect(parsed.votedAt).toBe(1700001000);
    expect(parsed.stakeAtVote).toBe(500000000n);
    expect(parsed.bump).toBe(254);
  });

  it("parses rejected vote", () => {
    const parsed = parseOnChainDisputeVote(mockRawVote({ approved: false }));
    expect(parsed.approved).toBe(false);
  });
});

describe("disputeStatusToString", () => {
  it("converts all statuses", () => {
    expect(disputeStatusToString(OnChainDisputeStatus.Active)).toBe("Active");
    expect(disputeStatusToString(OnChainDisputeStatus.Resolved)).toBe(
      "Resolved",
    );
    expect(disputeStatusToString(OnChainDisputeStatus.Expired)).toBe("Expired");
    expect(disputeStatusToString(OnChainDisputeStatus.Cancelled)).toBe(
      "Cancelled",
    );
  });

  it("returns Unknown for invalid status", () => {
    expect(disputeStatusToString(99 as OnChainDisputeStatus)).toBe(
      "Unknown(99)",
    );
  });
});

// ============================================================================
// PDA Derivation Tests
// ============================================================================

describe("deriveDisputePda", () => {
  it("derives deterministic PDA", () => {
    const disputeId = randomBytes(32);
    const { address: pda1, bump: bump1 } = deriveDisputePda(disputeId);
    const { address: pda2, bump: bump2 } = deriveDisputePda(disputeId);

    expect(pda1.equals(pda2)).toBe(true);
    expect(bump1).toBe(bump2);
  });

  it("throws on invalid length", () => {
    expect(() => deriveDisputePda(new Uint8Array(16))).toThrow(
      "Invalid disputeId length",
    );
  });

  it("findDisputePda returns same address", () => {
    const disputeId = randomBytes(32);
    const { address } = deriveDisputePda(disputeId);
    const pda = findDisputePda(disputeId);
    expect(pda.equals(address)).toBe(true);
  });
});

describe("deriveVotePda", () => {
  it("derives deterministic PDA", () => {
    const disputePda = randomPubkey();
    const arbiterPda = randomPubkey();
    const { address: pda1, bump: bump1 } = deriveVotePda(
      disputePda,
      arbiterPda,
    );
    const { address: pda2, bump: bump2 } = deriveVotePda(
      disputePda,
      arbiterPda,
    );

    expect(pda1.equals(pda2)).toBe(true);
    expect(bump1).toBe(bump2);
  });

  it("findVotePda returns same address", () => {
    const disputePda = randomPubkey();
    const arbiterPda = randomPubkey();
    const { address } = deriveVotePda(disputePda, arbiterPda);
    const pda = findVotePda(disputePda, arbiterPda);
    expect(pda.equals(address)).toBe(true);
  });
});

// ============================================================================
// Error Class Tests
// ============================================================================

describe("DisputeNotFoundError", () => {
  it("has correct properties", () => {
    const pda = randomPubkey().toBase58();
    const err = new DisputeNotFoundError(pda);

    expect(err).toBeInstanceOf(RuntimeError);
    expect(err.name).toBe("DisputeNotFoundError");
    expect(err.code).toBe(RuntimeErrorCodes.DISPUTE_NOT_FOUND);
    expect(err.disputePda).toBe(pda);
    expect(err.message).toContain(pda);
  });
});

describe("DisputeVoteError", () => {
  it("has correct properties", () => {
    const pda = randomPubkey().toBase58();
    const err = new DisputeVoteError(pda, "Voting ended");

    expect(err).toBeInstanceOf(RuntimeError);
    expect(err.name).toBe("DisputeVoteError");
    expect(err.code).toBe(RuntimeErrorCodes.DISPUTE_VOTE_ERROR);
    expect(err.disputePda).toBe(pda);
    expect(err.reason).toBe("Voting ended");
  });
});

describe("DisputeResolutionError", () => {
  it("has correct properties", () => {
    const pda = randomPubkey().toBase58();
    const err = new DisputeResolutionError(pda, "Not authorized");

    expect(err).toBeInstanceOf(RuntimeError);
    expect(err.name).toBe("DisputeResolutionError");
    expect(err.code).toBe(RuntimeErrorCodes.DISPUTE_RESOLUTION_ERROR);
    expect(err.disputePda).toBe(pda);
    expect(err.reason).toBe("Not authorized");
  });
});

describe("DisputeSlashError", () => {
  it("has correct properties", () => {
    const pda = randomPubkey().toBase58();
    const err = new DisputeSlashError(pda, "Already applied");

    expect(err).toBeInstanceOf(RuntimeError);
    expect(err.name).toBe("DisputeSlashError");
    expect(err.code).toBe(RuntimeErrorCodes.DISPUTE_SLASH_ERROR);
    expect(err.disputePda).toBe(pda);
    expect(err.reason).toBe("Already applied");
  });
});

// ============================================================================
// DisputeOperations - Query Tests
// ============================================================================

describe("DisputeOperations", () => {
  let program: ReturnType<typeof createMockProgram>;
  let ops: DisputeOperations;
  const agentId = generateAgentId();

  beforeEach(() => {
    program = createMockProgram();
    ops = new DisputeOperations({
      program,
      agentId,
      logger: silentLogger,
    });
  });

  describe("fetchDispute", () => {
    it("returns parsed dispute when found", async () => {
      const disputePda = randomPubkey();
      const raw = mockRawDispute();
      program.account.dispute.fetchNullable.mockResolvedValue(raw);

      const result = await ops.fetchDispute(disputePda);

      expect(result).not.toBeNull();
      expect(result!.createdAt).toBe(1700000000);
      expect(result!.votesFor).toBe(100n);
      expect(result!.rewardMint).toBeNull();
    });

    it("enriches dispute with task rewardMint", async () => {
      const disputePda = randomPubkey();
      const raw = mockRawDispute();
      const mint = randomPubkey();
      program.account.dispute.fetchNullable.mockResolvedValue(raw);
      program.account.task.fetch.mockResolvedValue({ rewardMint: mint });

      const result = await ops.fetchDispute(disputePda);

      expect(result).not.toBeNull();
      expect(result!.rewardMint?.equals(mint)).toBe(true);
    });

    it("returns null when not found", async () => {
      const disputePda = randomPubkey();
      program.account.dispute.fetchNullable.mockResolvedValue(null);

      const result = await ops.fetchDispute(disputePda);

      expect(result).toBeNull();
    });
  });

  describe("fetchDisputeByIds", () => {
    it("returns dispute and PDA when found", async () => {
      const disputeId = randomBytes(32);
      const raw = mockRawDispute();
      program.account.dispute.fetchNullable.mockResolvedValue(raw);

      const result = await ops.fetchDisputeByIds(disputeId);

      expect(result).not.toBeNull();
      expect(result!.disputePda).toBeDefined();
      expect(result!.dispute.createdAt).toBe(1700000000);
    });

    it("returns null when not found", async () => {
      const disputeId = randomBytes(32);
      program.account.dispute.fetchNullable.mockResolvedValue(null);

      const result = await ops.fetchDisputeByIds(disputeId);

      expect(result).toBeNull();
    });
  });

  describe("fetchAllDisputes", () => {
    it("returns all disputes", async () => {
      program.account.dispute.all.mockResolvedValue([
        { publicKey: randomPubkey(), account: mockRawDispute() },
        { publicKey: randomPubkey(), account: mockRawDispute() },
      ]);

      const results = await ops.fetchAllDisputes();

      expect(results).toHaveLength(2);
    });
  });

  describe("fetchActiveDisputes", () => {
    it("uses memcmp filter", async () => {
      program.account.dispute.all.mockResolvedValue([
        { publicKey: randomPubkey(), account: mockRawDispute() },
      ]);

      const results = await ops.fetchActiveDisputes();

      expect(results).toHaveLength(1);
      expect(program.account.dispute.all).toHaveBeenCalledWith([
        expect.objectContaining({
          memcmp: expect.objectContaining({
            offset: DISPUTE_STATUS_OFFSET,
          }),
        }),
      ]);
    });

    it("falls back to full scan on memcmp failure", async () => {
      // First call (memcmp) fails, second call (fallback) succeeds
      program.account.dispute.all
        .mockRejectedValueOnce(new Error("memcmp not supported"))
        .mockResolvedValueOnce([
          {
            publicKey: randomPubkey(),
            account: mockRawDispute({ status: { active: {} } }),
          },
          {
            publicKey: randomPubkey(),
            account: mockRawDispute({ status: { resolved: {} } }),
          },
        ]);

      const results = await ops.fetchActiveDisputes();

      // Only the active one should be returned
      expect(results).toHaveLength(1);
      expect(results[0].dispute.status).toBe(OnChainDisputeStatus.Active);
    });
  });

  describe("fetchDisputesForTask", () => {
    it("uses memcmp filter on task field", async () => {
      const taskPda = randomPubkey();
      program.account.dispute.all.mockResolvedValue([
        {
          publicKey: randomPubkey(),
          account: mockRawDispute({ task: taskPda }),
        },
      ]);

      const results = await ops.fetchDisputesForTask(taskPda);

      expect(results).toHaveLength(1);
      expect(program.account.dispute.all).toHaveBeenCalledWith([
        expect.objectContaining({
          memcmp: expect.objectContaining({
            offset: DISPUTE_TASK_OFFSET,
            bytes: taskPda.toBase58(),
          }),
        }),
      ]);
    });
  });

  describe("fetchVote", () => {
    it("returns parsed vote when found", async () => {
      const votePda = randomPubkey();
      program.account.disputeVote.fetchNullable.mockResolvedValue(
        mockRawVote(),
      );

      const result = await ops.fetchVote(votePda);

      expect(result).not.toBeNull();
      expect(result!.approved).toBe(true);
      expect(result!.stakeAtVote).toBe(500000000n);
    });

    it("returns null when not found", async () => {
      const votePda = randomPubkey();
      program.account.disputeVote.fetchNullable.mockResolvedValue(null);

      const result = await ops.fetchVote(votePda);

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // Transaction Tests
  // ==========================================================================

  describe("initiateDispute", () => {
    it("initiates dispute as worker", async () => {
      const result = await ops.initiateDispute({
        disputeId: randomBytes(32),
        taskPda: randomPubkey(),
        taskId: randomBytes(32),
        evidenceHash: randomBytes(32),
        resolutionType: 0,
        evidence:
          "Worker did not complete the task properly. Detailed explanation of the issue.",
      });

      expect(result.transactionSignature).toBe("mock-signature");
      expect(result.disputePda).toBeDefined();
      expect(program.methods.initiateDispute).toHaveBeenCalled();
      expect(program._methodBuilder.accountsPartial).toHaveBeenCalled();
    });

    it("initiates dispute as creator with defendant workers", async () => {
      const workers = [
        { claimPda: randomPubkey(), workerPda: randomPubkey() },
        { claimPda: randomPubkey(), workerPda: randomPubkey() },
      ];

      const result = await ops.initiateDispute({
        disputeId: randomBytes(32),
        taskPda: randomPubkey(),
        taskId: randomBytes(32),
        evidenceHash: randomBytes(32),
        resolutionType: 1,
        evidence:
          "Task was not completed according to specifications. Need resolution.",
        workerAgentPda: randomPubkey(),
        workerClaimPda: randomPubkey(),
        defendantWorkers: workers,
      });

      expect(result.transactionSignature).toBe("mock-signature");
      expect(program._methodBuilder.remainingAccounts).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            pubkey: workers[0].claimPda,
            isWritable: true,
            isSigner: false,
          }),
          expect.objectContaining({
            pubkey: workers[0].workerPda,
            isWritable: true,
            isSigner: false,
          }),
        ]),
      );
    });

    it("maps InsufficientEvidence error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.InsufficientEvidence),
      );

      await expect(
        ops.initiateDispute({
          disputeId: randomBytes(32),
          taskPda: randomPubkey(),
          taskId: randomBytes(32),
          evidenceHash: randomBytes(32),
          resolutionType: 0,
          evidence: "short",
        }),
      ).rejects.toThrow(DisputeResolutionError);
    });

    it("maps EvidenceTooLong error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.EvidenceTooLong),
      );

      // Evidence >256 chars is now caught by local validation (#963)
      // so we test with a valid-length evidence that triggers the Anchor error
      await expect(
        ops.initiateDispute({
          disputeId: randomBytes(32),
          taskPda: randomPubkey(),
          taskId: randomBytes(32),
          evidenceHash: randomBytes(32),
          resolutionType: 0,
          evidence: "valid evidence",
        }),
      ).rejects.toThrow(DisputeResolutionError);
    });
  });

  describe("voteOnDispute", () => {
    it("casts approval vote", async () => {
      const result = await ops.voteOnDispute({
        disputePda: randomPubkey(),
        taskPda: randomPubkey(),
        approve: true,
      });

      expect(result.transactionSignature).toBe("mock-signature");
      expect(result.votePda).toBeDefined();
      expect(program.methods.voteDispute).toHaveBeenCalledWith(true);
    });

    it("casts rejection vote", async () => {
      const result = await ops.voteOnDispute({
        disputePda: randomPubkey(),
        taskPda: randomPubkey(),
        approve: false,
      });

      expect(result.transactionSignature).toBe("mock-signature");
      expect(program.methods.voteDispute).toHaveBeenCalledWith(false);
    });

    it("maps NotArbiter error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.NotArbiter),
      );

      await expect(
        ops.voteOnDispute({
          disputePda: randomPubkey(),
          taskPda: randomPubkey(),
          approve: true,
        }),
      ).rejects.toThrow(DisputeVoteError);
    });

    it("maps VotingEnded error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.VotingEnded),
      );

      await expect(
        ops.voteOnDispute({
          disputePda: randomPubkey(),
          taskPda: randomPubkey(),
          approve: true,
        }),
      ).rejects.toThrow(DisputeVoteError);
    });

    it("maps AlreadyVoted error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.AlreadyVoted),
      );

      await expect(
        ops.voteOnDispute({
          disputePda: randomPubkey(),
          taskPda: randomPubkey(),
          approve: true,
        }),
      ).rejects.toThrow(DisputeVoteError);
    });

    it("maps DisputeNotActive error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.DisputeNotActive),
      );

      await expect(
        ops.voteOnDispute({
          disputePda: randomPubkey(),
          taskPda: randomPubkey(),
          approve: true,
        }),
      ).rejects.toThrow(DisputeVoteError);
    });
  });

  describe("resolveDispute", () => {
    it("resolves with refund (no worker accounts)", async () => {
      const result = await ops.resolveDispute({
        disputePda: randomPubkey(),
        taskPda: randomPubkey(),
        creatorPubkey: randomPubkey(),
        arbiterVotes: [],
      });

      expect(result.transactionSignature).toBe("mock-signature");
      expect(program.methods.resolveDispute).toHaveBeenCalled();
    });

    it("resolves with worker accounts and arbiter remaining_accounts", async () => {
      const arbiterVotes = [
        { votePda: randomPubkey(), arbiterAgentPda: randomPubkey() },
        { votePda: randomPubkey(), arbiterAgentPda: randomPubkey() },
      ];

      const result = await ops.resolveDispute({
        disputePda: randomPubkey(),
        taskPda: randomPubkey(),
        creatorPubkey: randomPubkey(),
        workerClaimPda: randomPubkey(),
        workerAgentPda: randomPubkey(),
        workerAuthority: randomPubkey(),
        arbiterVotes,
      });

      expect(result.transactionSignature).toBe("mock-signature");
      expect(program._methodBuilder.remainingAccounts).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ pubkey: arbiterVotes[0].votePda }),
          expect.objectContaining({ pubkey: arbiterVotes[0].arbiterAgentPda }),
          expect.objectContaining({ pubkey: arbiterVotes[1].votePda }),
          expect.objectContaining({ pubkey: arbiterVotes[1].arbiterAgentPda }),
        ]),
      );
    });

    it("resolves with extra workers for collaborative tasks", async () => {
      const extraWorkers = [
        { claimPda: randomPubkey(), workerPda: randomPubkey() },
      ];
      const arbiterVotes = [
        { votePda: randomPubkey(), arbiterAgentPda: randomPubkey() },
      ];

      await ops.resolveDispute({
        disputePda: randomPubkey(),
        taskPda: randomPubkey(),
        creatorPubkey: randomPubkey(),
        arbiterVotes,
        extraWorkers,
      });

      // remaining_accounts should have 2 (arbiter pair) + 2 (worker pair) = 4
      const remainingCall =
        program._methodBuilder.remainingAccounts.mock.calls[0][0];
      expect(remainingCall).toHaveLength(4);
    });

    it("maps VotingNotEnded error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.VotingNotEnded),
      );

      await expect(
        ops.resolveDispute({
          disputePda: randomPubkey(),
          taskPda: randomPubkey(),
          creatorPubkey: randomPubkey(),
          arbiterVotes: [],
        }),
      ).rejects.toThrow(DisputeResolutionError);
    });

    it("maps InsufficientVotes error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.InsufficientVotes),
      );

      await expect(
        ops.resolveDispute({
          disputePda: randomPubkey(),
          taskPda: randomPubkey(),
          creatorPubkey: randomPubkey(),
          arbiterVotes: [],
        }),
      ).rejects.toThrow(DisputeResolutionError);
    });

    it("maps UnauthorizedResolver error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.UnauthorizedResolver),
      );

      await expect(
        ops.resolveDispute({
          disputePda: randomPubkey(),
          taskPda: randomPubkey(),
          creatorPubkey: randomPubkey(),
          arbiterVotes: [],
        }),
      ).rejects.toThrow(DisputeResolutionError);
    });

    it("maps DisputeAlreadyResolved error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.DisputeAlreadyResolved),
      );

      await expect(
        ops.resolveDispute({
          disputePda: randomPubkey(),
          taskPda: randomPubkey(),
          creatorPubkey: randomPubkey(),
          arbiterVotes: [],
        }),
      ).rejects.toThrow(DisputeResolutionError);
    });
  });

  describe("cancelDispute", () => {
    it("cancels dispute successfully", async () => {
      const disputePda = randomPubkey();
      const taskPda = randomPubkey();
      const defendant = randomPubkey();
      program.account.dispute.fetchNullable.mockResolvedValue(
        mockRawDispute({ defendant }),
      );

      const result = await ops.cancelDispute(disputePda, taskPda);

      expect(result.transactionSignature).toBe("mock-signature");
      expect(result.disputePda.equals(disputePda)).toBe(true);
      expect(program.methods.cancelDispute).toHaveBeenCalled();
      expect(program._methodBuilder.remainingAccounts).toHaveBeenCalledWith([
        { pubkey: defendant, isSigner: false, isWritable: true },
      ]);
    });

    it("maps DisputeNotActive error", async () => {
      program.account.dispute.fetchNullable.mockResolvedValue(mockRawDispute());
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.DisputeNotActive),
      );

      await expect(
        ops.cancelDispute(randomPubkey(), randomPubkey()),
      ).rejects.toThrow(DisputeResolutionError);
    });

    it("maps UnauthorizedResolver error", async () => {
      program.account.dispute.fetchNullable.mockResolvedValue(mockRawDispute());
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.UnauthorizedResolver),
      );

      await expect(
        ops.cancelDispute(randomPubkey(), randomPubkey()),
      ).rejects.toThrow(DisputeResolutionError);
    });
  });

  describe("expireDispute", () => {
    it("expires dispute with remaining_accounts", async () => {
      const arbiterVotes = [
        { votePda: randomPubkey(), arbiterAgentPda: randomPubkey() },
      ];

      const result = await ops.expireDispute({
        disputePda: randomPubkey(),
        taskPda: randomPubkey(),
        creatorPubkey: randomPubkey(),
        arbiterVotes,
      });

      expect(result.transactionSignature).toBe("mock-signature");
      expect(program.methods.expireDispute).toHaveBeenCalled();
      expect(program._methodBuilder.remainingAccounts).toHaveBeenCalled();
    });

    it("maps DisputeNotExpired error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.DisputeNotExpired),
      );

      await expect(
        ops.expireDispute({
          disputePda: randomPubkey(),
          taskPda: randomPubkey(),
          creatorPubkey: randomPubkey(),
          arbiterVotes: [],
        }),
      ).rejects.toThrow(DisputeResolutionError);
    });
  });

  describe("applySlash", () => {
    it("applies slash with treasury fetch", async () => {
      const result = await ops.applySlash({
        disputePda: randomPubkey(),
        taskPda: randomPubkey(),
        workerClaimPda: randomPubkey(),
        workerAgentPda: randomPubkey(),
      });

      expect(result.transactionSignature).toBe("mock-signature");
      expect(program.methods.applyDisputeSlash).toHaveBeenCalled();
      // Treasury fetched from protocol config
      expect(program.account.protocolConfig.fetch).toHaveBeenCalled();
      // Task fetched to determine token account wiring
      expect(program.account.task.fetch).toHaveBeenCalled();
    });

    it("wires token slash accounts for token-denominated task", async () => {
      const mint = randomPubkey();
      const taskPda = randomPubkey();
      program.account.task.fetch.mockResolvedValueOnce({ rewardMint: mint });

      await ops.applySlash({
        disputePda: randomPubkey(),
        taskPda,
        workerClaimPda: randomPubkey(),
        workerAgentPda: randomPubkey(),
      });

      const accounts = program._methodBuilder.accountsPartial.mock.calls[0][0];
      expect(accounts.escrow).toBeInstanceOf(PublicKey);
      expect(accounts.tokenEscrowAta).toBeInstanceOf(PublicKey);
      expect(accounts.treasuryTokenAccount).toBeInstanceOf(PublicKey);
      expect(accounts.rewardMint?.equals(mint)).toBe(true);
      expect(accounts.tokenProgram).toBeInstanceOf(PublicKey);
    });

    it("caches treasury across calls", async () => {
      await ops.applySlash({
        disputePda: randomPubkey(),
        taskPda: randomPubkey(),
        workerClaimPda: randomPubkey(),
        workerAgentPda: randomPubkey(),
      });

      await ops.applySlash({
        disputePda: randomPubkey(),
        taskPda: randomPubkey(),
        workerClaimPda: randomPubkey(),
        workerAgentPda: randomPubkey(),
      });

      // Should only fetch protocol config once (cached)
      expect(program.account.protocolConfig.fetch).toHaveBeenCalledTimes(1);
    });

    it("maps SlashAlreadyApplied error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.SlashAlreadyApplied),
      );

      await expect(
        ops.applySlash({
          disputePda: randomPubkey(),
          taskPda: randomPubkey(),
          workerClaimPda: randomPubkey(),
          workerAgentPda: randomPubkey(),
        }),
      ).rejects.toThrow(DisputeSlashError);
    });

    it("maps DisputeNotResolved error", async () => {
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.DisputeNotResolved),
      );

      await expect(
        ops.applySlash({
          disputePda: randomPubkey(),
          taskPda: randomPubkey(),
          workerClaimPda: randomPubkey(),
          workerAgentPda: randomPubkey(),
        }),
      ).rejects.toThrow(DisputeSlashError);
    });
  });

  // ==========================================================================
  // buildRemainingAccounts Tests (tested via transaction methods)
  // ==========================================================================

  describe("buildRemainingAccounts (integration)", () => {
    it("handles arbiter-only remaining accounts", async () => {
      const arbiterVotes = [
        { votePda: randomPubkey(), arbiterAgentPda: randomPubkey() },
      ];

      await ops.resolveDispute({
        disputePda: randomPubkey(),
        taskPda: randomPubkey(),
        creatorPubkey: randomPubkey(),
        arbiterVotes,
      });

      const remainingCall =
        program._methodBuilder.remainingAccounts.mock.calls[0][0];
      expect(remainingCall).toHaveLength(2); // 1 pair = 2 accounts
      expect(remainingCall[0].pubkey.equals(arbiterVotes[0].votePda)).toBe(
        true,
      );
      expect(
        remainingCall[1].pubkey.equals(arbiterVotes[0].arbiterAgentPda),
      ).toBe(true);
    });

    it("handles arbiter + worker remaining accounts in correct order", async () => {
      const arbiterVotes = [
        { votePda: randomPubkey(), arbiterAgentPda: randomPubkey() },
      ];
      const extraWorkers = [
        { claimPda: randomPubkey(), workerPda: randomPubkey() },
      ];

      await ops.resolveDispute({
        disputePda: randomPubkey(),
        taskPda: randomPubkey(),
        creatorPubkey: randomPubkey(),
        arbiterVotes,
        extraWorkers,
      });

      const remainingCall =
        program._methodBuilder.remainingAccounts.mock.calls[0][0];
      expect(remainingCall).toHaveLength(4);
      // Arbiter pair first
      expect(remainingCall[0].pubkey.equals(arbiterVotes[0].votePda)).toBe(
        true,
      );
      expect(
        remainingCall[1].pubkey.equals(arbiterVotes[0].arbiterAgentPda),
      ).toBe(true);
      // Worker pair second
      expect(remainingCall[2].pubkey.equals(extraWorkers[0].claimPda)).toBe(
        true,
      );
      expect(remainingCall[3].pubkey.equals(extraWorkers[0].workerPda)).toBe(
        true,
      );
    });
  });

  // ==========================================================================
  // Input Validation Tests (#963)
  // ==========================================================================

  describe("initiateDispute input validation (#963)", () => {
    it("rejects disputeId with wrong length", async () => {
      await expect(
        ops.initiateDispute({
          disputeId: new Uint8Array(16),
          taskId: randomBytes(32),
          taskPda: randomPubkey(),
          evidenceHash: randomBytes(32),
          evidence: "test evidence",
          resolutionType: 0,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects all-zero evidenceHash", async () => {
      await expect(
        ops.initiateDispute({
          disputeId: randomBytes(32),
          taskId: randomBytes(32),
          taskPda: randomPubkey(),
          evidenceHash: new Uint8Array(32),
          evidence: "test evidence",
          resolutionType: 0,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects empty evidence string", async () => {
      await expect(
        ops.initiateDispute({
          disputeId: randomBytes(32),
          taskId: randomBytes(32),
          taskPda: randomPubkey(),
          evidenceHash: randomBytes(32),
          evidence: "",
          resolutionType: 0,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects evidence exceeding 256 characters", async () => {
      await expect(
        ops.initiateDispute({
          disputeId: randomBytes(32),
          taskId: randomBytes(32),
          taskPda: randomPubkey(),
          evidenceHash: randomBytes(32),
          evidence: "x".repeat(257),
          resolutionType: 0,
        }),
      ).rejects.toThrow(ValidationError);
    });

    it("rejects invalid resolution type", async () => {
      await expect(
        ops.initiateDispute({
          disputeId: randomBytes(32),
          taskId: randomBytes(32),
          taskPda: randomPubkey(),
          evidenceHash: randomBytes(32),
          evidence: "test evidence",
          resolutionType: 5,
        }),
      ).rejects.toThrow(ValidationError);
    });
  });
});
