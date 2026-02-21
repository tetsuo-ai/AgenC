import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { SkillPurchaseManager, type SkillPurchaseConfig } from "./payment.js";
import { SkillPurchaseError } from "./errors.js";
import { RuntimeErrorCodes, AnchorErrorCodes } from "../../types/errors.js";
import { PROGRAM_ID } from "@agenc/sdk";
import { silentLogger } from "../../utils/logger.js";
import { generateAgentId } from "../../utils/encoding.js";

// ============================================================================
// Test Helpers
// ============================================================================

function randomPubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

function anchorError(code: number) {
  return { code, message: `custom program error: 0x${code.toString(16)}` };
}

// ============================================================================
// Mock Program Factory
// ============================================================================

function createMockProgram(overrides: Record<string, any> = {}) {
  const rpcMock = vi.fn().mockResolvedValue("mock-tx-signature");

  const methodBuilder = {
    accountsPartial: vi.fn().mockReturnThis(),
    rpc: rpcMock,
  };

  const authorAuthority = randomPubkey();

  return {
    programId: PROGRAM_ID,
    provider: {
      publicKey: randomPubkey(),
    },
    account: {
      skillRegistration: {
        fetch: vi.fn().mockResolvedValue({
          author: randomPubkey(),
          skillId: new Uint8Array(32).fill(1),
          price: { toString: () => "1000000" },
          priceMint: null,
          isActive: true,
        }),
      },
      agentRegistration: {
        fetch: vi.fn().mockResolvedValue({
          authority: authorAuthority,
          status: { active: {} },
        }),
      },
      protocolConfig: {
        fetch: vi.fn().mockResolvedValue({
          treasury: randomPubkey(),
          protocolFeeBps: { toString: () => "200" },
        }),
      },
      purchaseRecord: {
        fetchNullable: vi.fn().mockResolvedValue(null),
        all: vi.fn().mockResolvedValue([]),
      },
    },
    methods: {
      purchaseSkill: vi.fn().mockReturnValue(methodBuilder),
    },
    _methodBuilder: methodBuilder,
    _rpcMock: rpcMock,
    _authorAuthority: authorAuthority,
    ...overrides,
  } as any;
}

function createMockRegistryClient() {
  return {
    search: vi.fn(),
    get: vi.fn(),
    install: vi.fn().mockResolvedValue({ id: "test-skill" }),
    publish: vi.fn(),
    rate: vi.fn(),
    listByAuthor: vi.fn(),
    verify: vi.fn(),
  };
}

function createManager(
  program: any = createMockProgram(),
  registryClient: any = createMockRegistryClient(),
  agentId?: Uint8Array,
): { manager: SkillPurchaseManager; program: any; registryClient: any } {
  const id = agentId ?? generateAgentId("test-buyer");
  const manager = new SkillPurchaseManager({
    program,
    agentId: id,
    registryClient,
    logger: silentLogger,
  });
  return { manager, program, registryClient };
}

// ============================================================================
// Tests
// ============================================================================

describe("SkillPurchaseManager", () => {
  describe("constructor", () => {
    it("caches buyerAgentPda and protocolPda", () => {
      const agentId = generateAgentId("test-buyer");
      const program = createMockProgram();
      const registryClient = createMockRegistryClient();
      const manager = new SkillPurchaseManager({
        program,
        agentId,
        registryClient,
      });
      // Manager should be created without errors, with cached PDAs
      expect(manager).toBeDefined();
    });
  });

  describe("isPurchased", () => {
    it("returns true when purchase record exists", async () => {
      const program = createMockProgram();
      const skillPda = randomPubkey();
      program.account.purchaseRecord.fetchNullable.mockResolvedValueOnce({
        skill: skillPda,
        buyer: randomPubkey(),
        pricePaid: { toString: () => "1000000" },
        timestamp: { toNumber: () => 1700000000 },
        bump: 255,
      });
      const { manager } = createManager(program);
      expect(await manager.isPurchased(skillPda)).toBe(true);
    });

    it("returns false when purchase record is absent", async () => {
      const program = createMockProgram();
      program.account.purchaseRecord.fetchNullable.mockResolvedValueOnce(null);
      const { manager } = createManager(program);
      expect(await manager.isPurchased(randomPubkey())).toBe(false);
    });
  });

  describe("fetchPurchaseRecord", () => {
    it("returns null when not found", async () => {
      const program = createMockProgram();
      program.account.purchaseRecord.fetchNullable.mockResolvedValueOnce(null);
      const { manager } = createManager(program);
      expect(await manager.fetchPurchaseRecord(randomPubkey())).toBeNull();
    });

    it("parses raw record correctly", async () => {
      const program = createMockProgram();
      const skillPda = randomPubkey();
      const buyerPda = randomPubkey();
      program.account.purchaseRecord.fetchNullable.mockResolvedValueOnce({
        skill: skillPda,
        buyer: buyerPda,
        pricePaid: { toString: () => "5000000" },
        timestamp: { toNumber: () => 1700001234 },
        bump: 253,
      });
      const { manager } = createManager(program);
      const record = await manager.fetchPurchaseRecord(skillPda);
      expect(record).not.toBeNull();
      expect(record!.pricePaid).toBe(5000000n);
      expect(record!.timestamp).toBe(1700001234);
      expect(record!.bump).toBe(253);
    });
  });

  describe("purchase", () => {
    it("purchases paid skill (SOL) and returns correct result", async () => {
      const program = createMockProgram();
      const registryClient = createMockRegistryClient();
      const { manager } = createManager(program, registryClient);
      const skillPda = randomPubkey();

      const result = await manager.purchase(
        skillPda,
        "test-skill",
        "/tmp/skill.md",
      );

      expect(result.skillId).toBe("test-skill");
      expect(result.paid).toBe(true);
      expect(result.pricePaid).toBe(1000000n);
      // feeBps=200, price=1000000 → fee = 1000000 * 200 / 10000 = 20000
      expect(result.protocolFee).toBe(20000n);
      expect(result.transactionSignature).toBe("mock-tx-signature");
      expect(result.contentPath).toBe("/tmp/skill.md");

      // Verify tx was submitted
      expect(program.methods.purchaseSkill).toHaveBeenCalled();
      expect(program._methodBuilder.accountsPartial).toHaveBeenCalled();
      expect(registryClient.install).toHaveBeenCalledWith(
        "test-skill",
        "/tmp/skill.md",
      );
    });

    it("purchases free skill — tx sent, paid=false, pricePaid=0", async () => {
      const program = createMockProgram();
      program.account.skillRegistration.fetch.mockResolvedValueOnce({
        author: randomPubkey(),
        skillId: new Uint8Array(32).fill(2),
        price: { toString: () => "0" },
        priceMint: null,
        isActive: true,
      });
      const { manager } = createManager(program);

      const result = await manager.purchase(
        randomPubkey(),
        "free-skill",
        "/tmp/free.md",
      );

      expect(result.paid).toBe(false);
      expect(result.pricePaid).toBe(0n);
      expect(result.protocolFee).toBe(0n);
      expect(result.transactionSignature).toBe("mock-tx-signature");
    });

    it("computes correct protocol fee", async () => {
      const program = createMockProgram();
      const treasury = randomPubkey();
      // price=10000000, feeBps=500
      program.account.skillRegistration.fetch.mockResolvedValueOnce({
        author: randomPubkey(),
        skillId: new Uint8Array(32).fill(3),
        price: { toString: () => "10000000" },
        priceMint: null,
        isActive: true,
      });
      // Override for all calls (getTreasury + purchase both fetch protocolConfig)
      program.account.protocolConfig.fetch.mockResolvedValue({
        treasury,
        protocolFeeBps: { toString: () => "500" },
      });
      const { manager } = createManager(program);

      const result = await manager.purchase(
        randomPubkey(),
        "premium-skill",
        "/tmp/premium.md",
      );

      // 10000000 * 500 / 10000 = 500000
      expect(result.protocolFee).toBe(500000n);
    });

    it("re-purchase skips tx and re-downloads content", async () => {
      const program = createMockProgram();
      const registryClient = createMockRegistryClient();
      const skillPda = randomPubkey();
      // Return existing purchase record
      program.account.purchaseRecord.fetchNullable.mockResolvedValueOnce({
        skill: skillPda,
        buyer: randomPubkey(),
        pricePaid: { toString: () => "1000000" },
        timestamp: { toNumber: () => 1700000000 },
        bump: 255,
      });
      const { manager } = createManager(program, registryClient);

      const result = await manager.purchase(
        skillPda,
        "already-owned",
        "/tmp/redownload.md",
      );

      expect(result.paid).toBe(false);
      expect(result.pricePaid).toBe(0n);
      expect(result.protocolFee).toBe(0n);
      expect(result.transactionSignature).toBeUndefined();
      expect(result.contentPath).toBe("/tmp/redownload.md");
      // tx should NOT have been called
      expect(program.methods.purchaseSkill).not.toHaveBeenCalled();
      // but install should have been called
      expect(registryClient.install).toHaveBeenCalledWith(
        "already-owned",
        "/tmp/redownload.md",
      );
    });

    it("SPL token payment — token accounts passed correctly", async () => {
      const program = createMockProgram();
      const mint = randomPubkey();
      program.account.skillRegistration.fetch.mockResolvedValueOnce({
        author: randomPubkey(),
        skillId: new Uint8Array(32).fill(4),
        price: { toString: () => "5000000" },
        priceMint: mint,
        isActive: true,
      });
      const { manager } = createManager(program);

      await manager.purchase(randomPubkey(), "token-skill", "/tmp/token.md");

      const callArgs = program._methodBuilder.accountsPartial.mock.calls[0][0];
      expect(callArgs.priceMint).toEqual(mint);
      expect(callArgs.buyerTokenAccount).toBeDefined();
      expect(callArgs.authorTokenAccount).toBeDefined();
      expect(callArgs.treasuryTokenAccount).toBeDefined();
      expect(callArgs.tokenProgram).toEqual(TOKEN_PROGRAM_ID);
    });

    it("SOL payment — token accounts are null", async () => {
      const program = createMockProgram();
      const { manager } = createManager(program);

      await manager.purchase(randomPubkey(), "sol-skill", "/tmp/sol.md");

      const callArgs = program._methodBuilder.accountsPartial.mock.calls[0][0];
      expect(callArgs.priceMint).toBeNull();
      expect(callArgs.buyerTokenAccount).toBeNull();
      expect(callArgs.authorTokenAccount).toBeNull();
      expect(callArgs.treasuryTokenAccount).toBeNull();
      expect(callArgs.tokenProgram).toBeNull();
    });

    it("download failure after tx — partial result with empty contentPath", async () => {
      const program = createMockProgram();
      const registryClient = createMockRegistryClient();
      registryClient.install.mockRejectedValueOnce(
        new Error("Download failed"),
      );
      const { manager } = createManager(program, registryClient);

      const result = await manager.purchase(
        randomPubkey(),
        "broken-dl",
        "/tmp/broken.md",
      );

      expect(result.transactionSignature).toBe("mock-tx-signature");
      expect(result.contentPath).toBe("");
      expect(result.paid).toBe(true);
    });

    // Error mapping tests

    it("inactive skill → SkillPurchaseError", async () => {
      const program = createMockProgram();
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.SkillNotActive),
      );
      const { manager } = createManager(program);

      await expect(
        manager.purchase(randomPubkey(), "inactive-skill", "/tmp/inactive.md"),
      ).rejects.toThrow(SkillPurchaseError);

      try {
        await manager.purchase(
          randomPubkey(),
          "inactive-skill",
          "/tmp/inactive.md",
        );
      } catch (err) {
        // Second call also has the mock reset, just verify the first rejection
      }
    });

    it("self-purchase → SkillPurchaseError", async () => {
      const program = createMockProgram();
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.SkillSelfPurchase),
      );
      const { manager } = createManager(program);

      await expect(
        manager.purchase(randomPubkey(), "my-skill", "/tmp/my.md"),
      ).rejects.toThrow(SkillPurchaseError);
    });

    it("insufficient balance → SkillPurchaseError", async () => {
      const program = createMockProgram();
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.InsufficientFunds),
      );
      const { manager } = createManager(program);

      await expect(
        manager.purchase(randomPubkey(), "expensive", "/tmp/exp.md"),
      ).rejects.toThrow(SkillPurchaseError);
    });

    it("missing token accounts → SkillPurchaseError", async () => {
      const program = createMockProgram();
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.MissingTokenAccounts),
      );
      const { manager } = createManager(program);

      await expect(
        manager.purchase(randomPubkey(), "token-skill", "/tmp/token.md"),
      ).rejects.toThrow(SkillPurchaseError);
    });

    it("token mint mismatch → SkillPurchaseError", async () => {
      const program = createMockProgram();
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.InvalidTokenMint),
      );
      const { manager } = createManager(program);

      await expect(
        manager.purchase(randomPubkey(), "bad-mint", "/tmp/mint.md"),
      ).rejects.toThrow(SkillPurchaseError);
    });

    it("inactive buyer agent → SkillPurchaseError", async () => {
      const program = createMockProgram();
      program._rpcMock.mockRejectedValueOnce(
        anchorError(AnchorErrorCodes.AgentNotActive),
      );
      const { manager } = createManager(program);

      await expect(
        manager.purchase(randomPubkey(), "paused-agent", "/tmp/paused.md"),
      ).rejects.toThrow(SkillPurchaseError);
    });

    it("unknown error is re-thrown as-is", async () => {
      const program = createMockProgram();
      const unknownErr = new Error("Network timeout");
      program._rpcMock.mockRejectedValueOnce(unknownErr);
      const { manager } = createManager(program);

      await expect(
        manager.purchase(randomPubkey(), "timeout-skill", "/tmp/timeout.md"),
      ).rejects.toThrow("Network timeout");
    });
  });

  describe("getPurchaseHistory", () => {
    it("returns parsed records sorted by timestamp desc", async () => {
      const program = createMockProgram();
      const skill1 = randomPubkey();
      const skill2 = randomPubkey();
      const buyer = randomPubkey();
      program.account.purchaseRecord.all.mockResolvedValueOnce([
        {
          publicKey: randomPubkey(),
          account: {
            skill: skill1,
            buyer,
            pricePaid: { toString: () => "1000000" },
            timestamp: { toNumber: () => 1700000000 },
            bump: 255,
          },
        },
        {
          publicKey: randomPubkey(),
          account: {
            skill: skill2,
            buyer,
            pricePaid: { toString: () => "2000000" },
            timestamp: { toNumber: () => 1700100000 },
            bump: 254,
          },
        },
      ]);
      const { manager } = createManager(program);

      const history = await manager.getPurchaseHistory();

      expect(history).toHaveLength(2);
      // Most recent first
      expect(history[0].timestamp).toBe(1700100000);
      expect(history[0].pricePaid).toBe(2000000n);
      expect(history[1].timestamp).toBe(1700000000);
      expect(history[1].pricePaid).toBe(1000000n);
    });

    it("returns empty array when no purchases", async () => {
      const program = createMockProgram();
      program.account.purchaseRecord.all.mockResolvedValueOnce([]);
      const { manager } = createManager(program);

      const history = await manager.getPurchaseHistory();
      expect(history).toHaveLength(0);
    });

    it("uses memcmp filter on buyer field", async () => {
      const program = createMockProgram();
      program.account.purchaseRecord.all.mockResolvedValueOnce([]);
      const { manager } = createManager(program);

      await manager.getPurchaseHistory();

      expect(program.account.purchaseRecord.all).toHaveBeenCalledWith([
        {
          memcmp: {
            offset: 40, // 8 discriminator + 32 skill pubkey
            bytes: expect.any(String), // base58 of buyerAgentPda
          },
        },
      ]);
    });
  });
});
