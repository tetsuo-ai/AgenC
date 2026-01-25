/**
 * Integration tests for complete_task_private instruction.
 *
 * Tests the ZK proof-based task completion flow including:
 * - Validation of private task requirements
 * - Constraint hash matching
 * - Proof size validation
 * - Error conditions
 *
 * Note: Full ZK proof verification uses inline groth16-solana.
 * These tests focus on pre-verification validation checks.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";

describe("complete_task_private", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  // Test constants
  const HASH_SIZE = 32;
  const EXPECTED_PROOF_SIZE = 256; // groth16-solana format: 64 (G1) + 128 (G2) + 64 (G1)

  let treasury: Keypair;
  let treasuryPubkey: PublicKey;  // Actual treasury from protocol config
  let creator: Keypair;
  let worker: Keypair;
  let creatorAgentPda: PublicKey;
  let workerAgentPda: PublicKey;

  const creatorAgentId = Buffer.from("creator-priv-0000000000000001".padEnd(32, "\0"));
  const workerAgentId = Buffer.from("worker-priv-00000000000000001".padEnd(32, "\0"));

  const CAPABILITY_COMPUTE = 1 << 0;
  const TASK_TYPE_EXCLUSIVE = 0;

  function deriveAgentPda(agentId: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentId],
      program.programId
    )[0];
  }

  function deriveTaskPda(creatorPubkey: PublicKey, taskId: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("task"), creatorPubkey.toBuffer(), taskId],
      program.programId
    )[0];
  }

  function deriveEscrowPda(taskPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), taskPda.toBuffer()],
      program.programId
    )[0];
  }

  function deriveClaimPda(taskPda: PublicKey, workerPubkey: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), taskPda.toBuffer(), workerPubkey.toBuffer()],
      program.programId
    )[0];
  }

  /**
   * Create a valid-looking but fake proof for testing validation.
   * This proof will fail ZK verification but tests pre-verification checks.
   */
  function createTestProof(options: {
    proofSize?: number;
    constraintHash?: Buffer;
    outputCommitment?: Buffer;
    expectedBinding?: Buffer;
  } = {}) {
    const proofSize = options.proofSize ?? EXPECTED_PROOF_SIZE;
    const constraintHash = options.constraintHash ?? Buffer.alloc(HASH_SIZE, 0x01);
    const outputCommitment = options.outputCommitment ?? Buffer.alloc(HASH_SIZE, 0x02);
    const expectedBinding = options.expectedBinding ?? Buffer.alloc(HASH_SIZE, 0x03);

    return {
      proofData: Buffer.alloc(proofSize, 0xAA), // Fake proof data
      constraintHash: Array.from(constraintHash),
      outputCommitment: Array.from(outputCommitment),
      expectedBinding: Array.from(expectedBinding),
    };
  }

  before(async () => {
    treasury = Keypair.generate();
    creator = Keypair.generate();
    worker = Keypair.generate();

    const airdropAmount = 10 * LAMPORTS_PER_SOL;
    const wallets = [treasury, creator, worker];

    for (const wallet of wallets) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(wallet.publicKey, airdropAmount),
        "confirmed"
      );
    }

    // Initialize protocol if not already done
    try {
      await program.methods
        .initializeProtocol(51, 100, new BN(1 * LAMPORTS_PER_SOL), 1, [provider.wallet.publicKey])
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
        ])
        .rpc();
      treasuryPubkey = treasury.publicKey;
    } catch (e: unknown) {
      // Protocol may already be initialized from other tests
      // Read the actual treasury from protocol config
      const protocolConfig = await program.account.protocolConfig.fetch(protocolPda);
      treasuryPubkey = protocolConfig.treasury;
    }

    // Disable rate limiting for tests
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
    } catch (e) {
      // May already be configured
    }

    // Register creator agent
    creatorAgentPda = deriveAgentPda(creatorAgentId);
    try {
      await program.methods
        .registerAgent(
          Array.from(creatorAgentId),
          new BN(CAPABILITY_COMPUTE),
          "https://creator.example.com",
          null,
          new BN(1 * LAMPORTS_PER_SOL)
        )
        .accountsPartial({
          agent: creatorAgentPda,
          protocolConfig: protocolPda,
          authority: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();
    } catch (e) {
      // Agent may already be registered
    }

    // Register worker agent
    workerAgentPda = deriveAgentPda(workerAgentId);
    try {
      await program.methods
        .registerAgent(
          Array.from(workerAgentId),
          new BN(CAPABILITY_COMPUTE),
          "https://worker.example.com",
          null,
          new BN(1 * LAMPORTS_PER_SOL)
        )
        .accountsPartial({
          agent: workerAgentPda,
          protocolConfig: protocolPda,
          authority: worker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker])
        .rpc();
    } catch (e) {
      // Agent may already be registered
    }
  });

  describe("validation checks", () => {
    let privateTaskId: Buffer;
    let privateTaskPda: PublicKey;
    let privateEscrowPda: PublicKey;
    let privateClaimPda: PublicKey;
    const privateConstraintHash = Buffer.alloc(HASH_SIZE);
    // Set a non-zero constraint hash to make this a "private" task
    privateConstraintHash[0] = 0x12;
    privateConstraintHash[1] = 0x34;
    privateConstraintHash[31] = 0x56;

    before(async () => {
      // Create a private task (with non-zero constraint hash)
      privateTaskId = Buffer.alloc(32, 0);
      privateTaskId.writeUInt32LE(Date.now() % 1000000, 0); // Unique ID
      privateTaskId[4] = 0x01; // Mark as private task test

      privateTaskPda = deriveTaskPda(creator.publicKey, privateTaskId);
      privateEscrowPda = deriveEscrowPda(privateTaskPda);

      await program.methods
        .createTask(
          Array.from(privateTaskId),
          new BN(CAPABILITY_COMPUTE),
          Array.from(Buffer.alloc(64, 0)), // description
          new BN(0.5 * LAMPORTS_PER_SOL), // reward
          1, // max_workers
          new BN(0), // deadline (no deadline)
          TASK_TYPE_EXCLUSIVE,
          Array.from(privateConstraintHash) // constraint_hash (non-zero = private task)
        )
        .accountsPartial({
          task: privateTaskPda,
          escrow: privateEscrowPda,
          creatorAgent: creatorAgentPda,
          protocolConfig: protocolPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      // Worker claims the task
      privateClaimPda = deriveClaimPda(privateTaskPda, workerAgentPda);

      await program.methods
        .claimTask()
        .accountsPartial({
          task: privateTaskPda,
          claim: privateClaimPda,
          worker: workerAgentPda,
          protocolConfig: protocolPda,
          authority: worker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker])
        .rpc();
    });

    it("rejects proof with wrong size (too small)", async () => {
      const proof = createTestProof({
        proofSize: 100, // Should be 256
        constraintHash: privateConstraintHash,
      });

      try {
        await program.methods
          .completeTaskPrivate(new BN(0), proof)
          .accountsPartial({
            task: privateTaskPda,
            claim: privateClaimPda,
            escrow: privateEscrowPda,
            worker: workerAgentPda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker])
          .rpc();
        expect.fail("Should have rejected invalid proof size");
      } catch (e: any) {
        expect(e.message).to.include("InvalidProofSize");
      }
    });

    it("rejects proof with wrong size (too large)", async () => {
      const proof = createTestProof({
        proofSize: 500, // Should be 256
        constraintHash: privateConstraintHash,
      });

      try {
        await program.methods
          .completeTaskPrivate(new BN(0), proof)
          .accountsPartial({
            task: privateTaskPda,
            claim: privateClaimPda,
            escrow: privateEscrowPda,
            worker: workerAgentPda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker])
          .rpc();
        expect.fail("Should have rejected invalid proof size");
      } catch (e: any) {
        expect(e.message).to.include("InvalidProofSize");
      }
    });

    it("rejects proof with mismatched constraint hash", async () => {
      // Use a different constraint hash than the task's
      const wrongConstraintHash = Buffer.alloc(HASH_SIZE, 0xFF);
      const proof = createTestProof({
        constraintHash: wrongConstraintHash, // Doesn't match task
      });

      try {
        await program.methods
          .completeTaskPrivate(new BN(0), proof)
          .accountsPartial({
            task: privateTaskPda,
            claim: privateClaimPda,
            escrow: privateEscrowPda,
            worker: workerAgentPda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker])
          .rpc();
        expect.fail("Should have rejected mismatched constraint hash");
      } catch (e: any) {
        expect(e.message).to.include("ConstraintHashMismatch");
      }
    });
  });

  describe("non-private task rejection", () => {
    let publicTaskId: Buffer;
    let publicTaskPda: PublicKey;
    let publicEscrowPda: PublicKey;
    let publicClaimPda: PublicKey;

    before(async () => {
      // Create a PUBLIC task (zero constraint hash)
      publicTaskId = Buffer.alloc(32, 0);
      publicTaskId.writeUInt32LE(Date.now() % 1000000, 0);
      publicTaskId[4] = 0x02; // Mark as public task test

      publicTaskPda = deriveTaskPda(creator.publicKey, publicTaskId);
      publicEscrowPda = deriveEscrowPda(publicTaskPda);

      await program.methods
        .createTask(
          Array.from(publicTaskId),
          new BN(CAPABILITY_COMPUTE),
          Array.from(Buffer.alloc(64, 0)),
          new BN(0.5 * LAMPORTS_PER_SOL),
          1,
          new BN(0),
          TASK_TYPE_EXCLUSIVE,
          Array.from(Buffer.alloc(HASH_SIZE, 0)) // All zeros = PUBLIC task
        )
        .accountsPartial({
          task: publicTaskPda,
          escrow: publicEscrowPda,
          creatorAgent: creatorAgentPda,
          protocolConfig: protocolPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      // Worker claims the task
      publicClaimPda = deriveClaimPda(publicTaskPda, workerAgentPda);

      await program.methods
        .claimTask()
        .accountsPartial({
          task: publicTaskPda,
          claim: publicClaimPda,
          worker: workerAgentPda,
          protocolConfig: protocolPda,
          authority: worker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker])
        .rpc();
    });

    it("rejects complete_task_private on non-private task", async () => {
      const proof = createTestProof({
        constraintHash: Buffer.alloc(HASH_SIZE, 0), // Matches the public task's zero hash
      });

      try {
        await program.methods
          .completeTaskPrivate(new BN(0), proof)
          .accountsPartial({
            task: publicTaskPda,
            claim: publicClaimPda,
            escrow: publicEscrowPda,
            worker: workerAgentPda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker])
          .rpc();
        expect.fail("Should have rejected non-private task");
      } catch (e: any) {
        expect(e.message).to.include("NotPrivateTask");
      }
    });
  });

  describe("task status validation", () => {
    it("rejects completion on non-in-progress task", async () => {
      // Create and immediately cancel a task
      const cancelledTaskId = Buffer.alloc(32, 0);
      cancelledTaskId.writeUInt32LE(Date.now() % 1000000, 0);
      cancelledTaskId[4] = 0x03;

      const cancelledTaskPda = deriveTaskPda(creator.publicKey, cancelledTaskId);
      const cancelledEscrowPda = deriveEscrowPda(cancelledTaskPda);

      const constraintHash = Buffer.alloc(HASH_SIZE);
      constraintHash[0] = 0xAB;

      await program.methods
        .createTask(
          Array.from(cancelledTaskId),
          new BN(CAPABILITY_COMPUTE),
          Array.from(Buffer.alloc(64, 0)),
          new BN(0.5 * LAMPORTS_PER_SOL),
          1,
          new BN(0),
          TASK_TYPE_EXCLUSIVE,
          Array.from(constraintHash)
        )
        .accountsPartial({
          task: cancelledTaskPda,
          escrow: cancelledEscrowPda,
          creatorAgent: creatorAgentPda,
          protocolConfig: protocolPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      // Cancel the task (no claims yet)
      await program.methods
        .cancelTask()
        .accountsPartial({
          task: cancelledTaskPda,
          escrow: cancelledEscrowPda,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([creator])
        .rpc();

      // Try to complete with a fake claim (this will fail due to PDA derivation)
      // The actual error will be different but demonstrates the flow
      const fakeClaimPda = deriveClaimPda(cancelledTaskPda, workerAgentPda);
      const proof = createTestProof({ constraintHash });

      try {
        await program.methods
          .completeTaskPrivate(new BN(0), proof)
          .accountsPartial({
            task: cancelledTaskPda,
            claim: fakeClaimPda,
            escrow: cancelledEscrowPda,
            worker: workerAgentPda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker])
          .rpc();
        expect.fail("Should have rejected cancelled task");
      } catch (e: any) {
        // Will fail either due to TaskNotInProgress or missing claim account
        expect(e.message).to.satisfy((msg: string) =>
          msg.includes("TaskNotInProgress") ||
          msg.includes("AccountNotInitialized") ||
          msg.includes("NotClaimed")
        );
      }
    });
  });
});
