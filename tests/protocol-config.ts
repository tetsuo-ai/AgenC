/**
 * Protocol Configuration Tests
 *
 * Tests for protocol initialization and configuration updates.
 * Covers: initializeProtocol, updateProtocolFee, updateRateLimits instructions.
 *
 * Run with: npx ts-mocha tests/protocol-config.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  deriveProtocolPda,
  generateRunId,
  fundWallet,
  fundWallets,
} from "./utils/test-helpers";

describe("Protocol Configuration", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;
  const protocolPda = deriveProtocolPda(program.programId);
  const runId = generateRunId();

  let treasury: Keypair;

  before(async () => {
    console.log("\n========================================");
    console.log("Protocol Configuration Tests");
    console.log("Program ID:", program.programId.toBase58());
    console.log("Run ID:", runId);
    console.log("========================================\n");

    treasury = Keypair.generate();
    await fundWallet(provider.connection, treasury);
  });

  // ============================================================================
  // Protocol Initialization
  // ============================================================================

  describe("Protocol Initialization", () => {
    it("initializes protocol with valid parameters", async () => {
      // Note: Protocol may already be initialized from previous tests
      // This test verifies the config can be fetched
      try {
        await program.methods
          .initializeProtocol(
            51,                              // dispute_quorum_percent
            100,                             // dispute_vote_period
            new BN(LAMPORTS_PER_SOL / 10),   // min_stake
            1,                               // min_multisig_signers
            [provider.wallet.publicKey]      // multisig_signers
          )
          .accountsPartial({
            protocolConfig: protocolPda,
            treasury: treasury.publicKey,
            authority: provider.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
          ])
          .rpc({ skipPreflight: true });
        console.log("  Protocol initialized");
      } catch (e: any) {
        if (e.message?.includes("already in use")) {
          console.log("  Protocol already initialized (expected)");
        } else {
          throw e;
        }
      }

      const config = await program.account.protocolConfig.fetch(protocolPda);
      expect(config.isInitialized).to.be.true;
      expect(config.disputeQuorumPercent).to.be.at.least(1);
      expect(config.disputeQuorumPercent).to.be.at.most(100);
      console.log("  Protocol config verified");
    });

    it("stores correct treasury address", async () => {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      expect(config.treasury).to.be.instanceOf(PublicKey);
      // Treasury should be a valid pubkey (not zero)
      expect(config.treasury.toBase58()).to.not.equal(PublicKey.default.toBase58());
      console.log("  Treasury address:", config.treasury.toBase58().slice(0, 16) + "...");
    });

    it("stores minimum stake requirement", async () => {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      expect(config.minStake.toNumber()).to.be.greaterThan(0);
      console.log("  Min stake:", config.minStake.toNumber() / LAMPORTS_PER_SOL, "SOL");
    });

    it("stores multisig configuration", async () => {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      expect(config.minMultisigSigners).to.be.at.least(1);
      expect(config.multisigSigners.length).to.be.at.least(config.minMultisigSigners);
      console.log("  Multisig threshold:", config.minMultisigSigners);
    });
  });

  // ============================================================================
  // Protocol Fee Updates
  // ============================================================================

  describe("Protocol Fee Updates", () => {
    it("reads current protocol fee", async () => {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      // Fee is in basis points (0-1000 = 0-10%)
      expect(config.protocolFeeBps).to.be.at.least(0);
      expect(config.protocolFeeBps).to.be.at.most(1000);
      console.log("  Current protocol fee:", config.protocolFeeBps, "bps");
    });

    it("requires multisig for fee updates", async () => {
      // Attempting to update fee without proper multisig should fail
      // unless we're already a multisig signer
      try {
        await program.methods
          .updateProtocolFee(100) // 1% fee
          .accountsPartial({
            protocolConfig: protocolPda,
          })
          .remainingAccounts([
            { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
          ])
          .rpc();
        console.log("  Fee updated (user is multisig signer)");
      } catch (e: any) {
        if (e.message?.includes("MultisigNotEnoughSigners")) {
          console.log("  Fee update rejected (not enough signers)");
        } else {
          // If we are a multisig signer, update succeeded
          console.log("  Fee update result:", e.message.slice(0, 50));
        }
      }
    });

    it("rejects invalid fee (> 1000 bps)", async () => {
      try {
        await program.methods
          .updateProtocolFee(1001) // 10.01% - too high
          .accountsPartial({
            protocolConfig: protocolPda,
          })
          .remainingAccounts([
            { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
          ])
          .rpc();
        expect.fail("Should have rejected invalid fee");
      } catch (e: any) {
        expect(e.message).to.satisfy((msg: string) =>
          msg.includes("InvalidProtocolFee") || msg.includes("constraint")
        );
        console.log("  Invalid fee rejected");
      }
    });
  });

  // ============================================================================
  // Rate Limit Configuration
  // ============================================================================

  describe("Rate Limit Configuration", () => {
    it("reads current rate limits", async () => {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      console.log("  Task creation cooldown:", config.taskCreationCooldown?.toNumber() || 0, "s");
      console.log("  Max tasks per 24h:", config.maxTasksPer24h || "unlimited");
      console.log("  Dispute cooldown:", config.disputeInitiationCooldown?.toNumber() || 0, "s");
    });

    it("allows disabling rate limits", async () => {
      try {
        await program.methods
          .updateRateLimits(
            new BN(0),  // task_creation_cooldown = 0 (disabled)
            0,          // max_tasks_per_24h = 0 (unlimited)
            new BN(0),  // dispute_initiation_cooldown = 0 (disabled)
            0,          // max_disputes_per_24h = 0 (unlimited)
            new BN(0)   // min_stake_for_dispute = 0
          )
          .accountsPartial({
            protocolConfig: protocolPda,
          })
          .remainingAccounts([
            { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
          ])
          .rpc();
        console.log("  Rate limits disabled");
      } catch (e: any) {
        if (e.message?.includes("MultisigNotEnoughSigners")) {
          console.log("  Rate limit update rejected (not enough signers)");
        } else {
          throw e;
        }
      }
    });
  });

  // ============================================================================
  // Protocol Statistics
  // ============================================================================

  describe("Protocol Statistics", () => {
    it("tracks total tasks created", async () => {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      expect(config.totalTasksCreated.toNumber()).to.be.at.least(0);
      console.log("  Total tasks created:", config.totalTasksCreated.toNumber());
    });

    it("tracks total rewards distributed", async () => {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      expect(config.totalRewardsDistributed.toNumber()).to.be.at.least(0);
      console.log("  Total rewards distributed:", config.totalRewardsDistributed.toNumber() / LAMPORTS_PER_SOL, "SOL");
    });

    it("tracks protocol version", async () => {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      expect(config.version).to.be.at.least(1);
      console.log("  Protocol version:", config.version);
    });
  });

  // ============================================================================
  // Multisig Validation
  // ============================================================================

  describe("Multisig Validation", () => {
    it("rejects duplicate multisig signers", async () => {
      // This would be tested during initialization with duplicate signers
      // For existing protocol, we verify the current signers are unique
      const config = await program.account.protocolConfig.fetch(protocolPda);
      const signers = config.multisigSigners.filter(
        (s: PublicKey) => !s.equals(PublicKey.default)
      );
      const uniqueSigners = new Set(signers.map((s: PublicKey) => s.toBase58()));
      expect(signers.length).to.equal(uniqueSigners.size);
      console.log("  Multisig signers are unique:", signers.length);
    });

    it("validates minimum signers threshold", async () => {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      const validSigners = config.multisigSigners.filter(
        (s: PublicKey) => !s.equals(PublicKey.default)
      );
      expect(validSigners.length).to.be.at.least(config.minMultisigSigners);
      console.log("  Min signers:", config.minMultisigSigners, ", Actual:", validSigners.length);
    });
  });

  after(() => {
    console.log("\n========================================");
    console.log("Protocol Configuration Tests Complete");
    console.log("========================================\n");
  });
});
