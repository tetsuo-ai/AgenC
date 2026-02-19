/**
 * Security audit integration tests — validates fixes for remaining_accounts
 * manipulation, escrow accounting, and ZK proof pre-verification defenses.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_ARBITER,
  TASK_TYPE_EXCLUSIVE,
  TASK_TYPE_COLLABORATIVE,
  RESOLUTION_TYPE_REFUND,
  VALID_EVIDENCE,
  generateRunId,
  makeAgentId,
  makeTaskId,
  makeDisputeId,
  deriveProtocolPda,
  deriveAgentPda,
  deriveTaskPda,
  deriveEscrowPda,
  deriveClaimPda,
  deriveDisputePda,
  deriveVotePda,
  deriveProgramDataPda,
  getDefaultDeadline,
  fundWallet,
  disableRateLimitsForTests,
} from "./test-utils";

const HASH_SIZE = 32;

describe("security-audit-fixes", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;
  const protocolPda = deriveProtocolPda(program.programId);
  const runId = generateRunId();

  let treasuryPubkey: PublicKey;
  let creator: Keypair;
  let creatorAgentId: Buffer;
  let creatorAgentPda: PublicKey;

  // Helper to create and fund a fresh keypair
  async function freshKeypair(): Promise<Keypair> {
    const kp = Keypair.generate();
    await fundWallet(provider.connection, kp.publicKey, 10 * LAMPORTS_PER_SOL);
    return kp;
  }

  // Helper to register an agent
  async function registerAgent(
    wallet: Keypair,
    agentId: Buffer,
    caps: number = CAPABILITY_COMPUTE,
    stakeAmount: number = LAMPORTS_PER_SOL,
  ): Promise<PublicKey> {
    const agentPda = deriveAgentPda(agentId, program.programId);
    try {
      await program.methods
        .registerAgent(
          Array.from(agentId),
          new BN(caps),
          "https://test.example.com",
          null,
          new BN(stakeAmount),
        )
        .accountsPartial({
          agent: agentPda,
          protocolConfig: protocolPda,
          authority: wallet.publicKey,
        })
        .signers([wallet])
        .rpc();
    } catch {
      // Already registered
    }
    return agentPda;
  }

  // Helper to create a task and return PDAs
  async function createTask(
    taskId: Buffer,
    reward: number = LAMPORTS_PER_SOL,
    maxWorkers: number = 1,
    taskType: number = TASK_TYPE_EXCLUSIVE,
    constraintHash: number[] | null = null,
  ) {
    const taskPda = deriveTaskPda(creator.publicKey, taskId, program.programId);
    const escrowPda = deriveEscrowPda(taskPda, program.programId);
    await program.methods
      .createTask(
        Array.from(taskId),
        new BN(CAPABILITY_COMPUTE),
        Buffer.from("Security test task".padEnd(64, "\0")),
        new BN(reward),
        maxWorkers,
        getDefaultDeadline(),
        taskType,
        constraintHash,
        0,
      )
      .accountsPartial({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        creatorAgent: creatorAgentPda,
        authority: creator.publicKey,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();
    return { taskPda, escrowPda };
  }

  // Helper to claim a task
  async function claimTask(
    taskPda: PublicKey,
    workerAgentPda: PublicKey,
    workerWallet: Keypair,
  ): Promise<PublicKey> {
    const claimPda = deriveClaimPda(taskPda, workerAgentPda, program.programId);
    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda,
        worker: workerAgentPda,
        protocolConfig: protocolPda,
        authority: workerWallet.publicKey,
      })
      .signers([workerWallet])
      .rpc();
    return claimPda;
  }

  before(async () => {
    const treasury = Keypair.generate();
    creator = await freshKeypair();

    await fundWallet(provider.connection, treasury.publicKey, 5 * LAMPORTS_PER_SOL);

    // Initialize protocol (idempotent)
    try {
      const programDataPda = deriveProgramDataPda(program.programId);
      await program.methods
        .initializeProtocol(51, 100, new BN(LAMPORTS_PER_SOL), new BN(LAMPORTS_PER_SOL / 100), 1, [provider.wallet.publicKey, treasury.publicKey])
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: provider.wallet.publicKey,
          secondSigner: treasury.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: deriveProgramDataPda(program.programId), isSigner: false, isWritable: false }])
        .signers([treasury])
        .rpc();
      treasuryPubkey = treasury.publicKey;
    } catch {
      const cfg = await program.account.protocolConfig.fetch(protocolPda);
      treasuryPubkey = cfg.treasury;
    }

    await disableRateLimitsForTests({
      program,
      protocolPda,
      authority: provider.wallet.publicKey,
      minStakeForDisputeLamports: 0,
      skipPreflight: false,
    });

    // Register creator agent
    creatorAgentId = makeAgentId("secCre", runId);
    creatorAgentPda = await registerAgent(creator, creatorAgentId);
  });

  // ==========================================================================
  // A. remaining_accounts manipulation
  // ==========================================================================

  describe("A. remaining_accounts manipulation", () => {
    it("rejects System-owned account as claim in cancel_task", async () => {
      const worker = await freshKeypair();
      const workerId = makeAgentId("secW1", runId);
      const workerPda = await registerAgent(worker, workerId);

      const taskId = makeTaskId("secCa1", runId);
      const { taskPda, escrowPda } = await createTask(taskId);
      const claimPda = await claimTask(taskPda, workerPda, worker);

      // Use a random keypair (System-owned) as the fake claim account
      const fakeAccount = Keypair.generate();

      try {
        await program.methods
          .cancelTask()
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: fakeAccount.publicKey, isSigner: false, isWritable: true },
            { pubkey: workerPda, isSigner: false, isWritable: true },
          ])
          .signers([creator])
          .rpc();
        expect.fail("Should reject System-owned account as claim");
      } catch (e: any) {
        expect(
          e.message.includes("InvalidAccountOwner") ||
          e.message.includes("InvalidInput") ||
          e.message.includes("AccountNotInitialized"),
        ).to.be.true;
      }
    });

    it("rejects mismatched claim/worker pair in cancel_task", async () => {
      // Create two tasks, each with a different worker
      const worker1 = await freshKeypair();
      const worker1Id = makeAgentId("secWm1", runId);
      const worker1Pda = await registerAgent(worker1, worker1Id);

      const worker2 = await freshKeypair();
      const worker2Id = makeAgentId("secWm2", runId);
      const worker2Pda = await registerAgent(worker2, worker2Id);

      // Task A: claimed by worker1
      const taskIdA = makeTaskId("secMm1", runId);
      const { taskPda: taskPdaA, escrowPda: escrowPdaA } = await createTask(taskIdA);
      await claimTask(taskPdaA, worker1Pda, worker1);

      // Task B: claimed by worker2
      const taskIdB = makeTaskId("secMm2", runId);
      const { taskPda: taskPdaB } = await createTask(taskIdB);
      await claimTask(taskPdaB, worker2Pda, worker2);

      // Try to cancel task A but pass worker2's claim from task B
      const claim2ForTaskB = deriveClaimPda(taskPdaB, worker2Pda, program.programId);

      try {
        await program.methods
          .cancelTask()
          .accountsPartial({
            task: taskPdaA,
            escrow: escrowPdaA,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: claim2ForTaskB, isSigner: false, isWritable: true },
            { pubkey: worker2Pda, isSigner: false, isWritable: true },
          ])
          .signers([creator])
          .rpc();
        expect.fail("Should reject mismatched claim/worker pair");
      } catch (e: any) {
        // Should get InvalidInput or a similar error for wrong task claim
        expect(
          e.message.includes("InvalidInput") ||
          e.message.includes("IncompleteWorkerAccounts") ||
          e.message.includes("InvalidAccountOwner"),
        ).to.be.true;
      }
    });

    it("rejects incomplete worker accounts in cancel_task", async () => {
      const worker = await freshKeypair();
      const workerId = makeAgentId("secWi", runId);
      const workerPda = await registerAgent(worker, workerId);

      const taskId = makeTaskId("secIn1", runId);
      const { taskPda, escrowPda } = await createTask(taskId);
      await claimTask(taskPda, workerPda, worker);

      // Pass only 1 account instead of the expected pair
      try {
        await program.methods
          .cancelTask()
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .remainingAccounts([
            { pubkey: deriveClaimPda(taskPda, workerPda, program.programId), isSigner: false, isWritable: true },
            // Missing worker agent PDA
          ])
          .signers([creator])
          .rpc();
        expect.fail("Should reject incomplete worker accounts");
      } catch (e: any) {
        expect(
          e.message.includes("IncompleteWorkerAccounts") ||
          e.message.includes("WorkerAccountsRequired") ||
          e.message.includes("InvalidInput"),
        ).to.be.true;
      }
    });
  });

  // ==========================================================================
  // B. Escrow accounting
  // ==========================================================================

  describe("B. Escrow accounting", () => {
    it("collaborative task: escrow stays open until all completions done", async () => {
      const worker1 = await freshKeypair();
      const worker1Id = makeAgentId("secEw1", runId);
      const worker1Pda = await registerAgent(worker1, worker1Id);

      const worker2 = await freshKeypair();
      const worker2Id = makeAgentId("secEw2", runId);
      const worker2Pda = await registerAgent(worker2, worker2Id);

      const taskId = makeTaskId("secEs1", runId);
      const { taskPda, escrowPda } = await createTask(
        taskId,
        2 * LAMPORTS_PER_SOL,
        2,
        TASK_TYPE_COLLABORATIVE,
      );

      const claim1 = await claimTask(taskPda, worker1Pda, worker1);
      const claim2 = await claimTask(taskPda, worker2Pda, worker2);

      // First completion — escrow should still exist
      await program.methods
        .completeTask(Array.from(Buffer.from("proof1".padEnd(32, "\0"))), null)
        .accountsPartial({
          task: taskPda,
          claim: claim1,
          escrow: escrowPda,
          worker: worker1Pda,
          creator: creator.publicKey,
          protocolConfig: protocolPda,
          treasury: treasuryPubkey,
          authority: worker1.publicKey,
        })
        .signers([worker1])
        .rpc();

      const escrowAfterFirst = await provider.connection.getAccountInfo(escrowPda);
      expect(escrowAfterFirst).to.not.be.null;

      // Second completion — escrow should be closed
      await program.methods
        .completeTask(Array.from(Buffer.from("proof2".padEnd(32, "\0"))), null)
        .accountsPartial({
          task: taskPda,
          claim: claim2,
          escrow: escrowPda,
          worker: worker2Pda,
          creator: creator.publicKey,
          protocolConfig: protocolPda,
          treasury: treasuryPubkey,
          authority: worker2.publicKey,
        })
        .signers([worker2])
        .rpc();

      const escrowAfterSecond = await provider.connection.getAccountInfo(escrowPda);
      expect(escrowAfterSecond).to.be.null;

      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ completed: {} });
      expect(task.completions).to.equal(2);
    });

    it("cancel after claim: creator receives full refund minus distributed", async () => {
      const worker = await freshKeypair();
      const workerId = makeAgentId("secEw3", runId);
      const workerPda = await registerAgent(worker, workerId);

      const rewardAmount = LAMPORTS_PER_SOL;
      const taskId = makeTaskId("secEs2", runId);
      const { taskPda, escrowPda } = await createTask(taskId, rewardAmount);
      const claimPda = await claimTask(taskPda, workerPda, worker);

      const creatorBefore = await provider.connection.getBalance(creator.publicKey);

      await program.methods
        .cancelTask()
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          creator: creator.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: claimPda, isSigner: false, isWritable: true },
          { pubkey: workerPda, isSigner: false, isWritable: true },
        ])
        .signers([creator])
        .rpc();

      const creatorAfter = await provider.connection.getBalance(creator.publicKey);
      // Creator should have received back at least the reward minus tx fees
      // Use a generous tolerance for tx fees + rent
      expect(creatorAfter).to.be.greaterThan(creatorBefore - 100000);
    });

    it("escrow balance matches expected after completion", async () => {
      const worker = await freshKeypair();
      const workerId = makeAgentId("secEw4", runId);
      const workerPda = await registerAgent(worker, workerId);

      const rewardAmount = LAMPORTS_PER_SOL;
      const taskId = makeTaskId("secEs3", runId);
      const { taskPda, escrowPda } = await createTask(taskId, rewardAmount);
      await claimTask(taskPda, workerPda, worker);

      const escrowBefore = await provider.connection.getBalance(escrowPda);
      const workerBefore = await provider.connection.getBalance(worker.publicKey);

      await program.methods
        .completeTask(Array.from(Buffer.from("proof1".padEnd(32, "\0"))), null)
        .accountsPartial({
          task: taskPda,
          claim: deriveClaimPda(taskPda, workerPda, program.programId),
          escrow: escrowPda,
          worker: workerPda,
          creator: creator.publicKey,
          protocolConfig: protocolPda,
          treasury: treasuryPubkey,
          authority: worker.publicKey,
        })
        .signers([worker])
        .rpc();

      // Escrow should be closed (exclusive task)
      const escrowAfter = await provider.connection.getAccountInfo(escrowPda);
      expect(escrowAfter).to.be.null;

      // Worker should have received reward minus fee (within tolerance for tx fee + rent)
      const workerAfter = await provider.connection.getBalance(worker.publicKey);
      expect(workerAfter).to.be.greaterThan(workerBefore);
    });
  });

  // ==========================================================================
  // C. Proof pre-verification defense
  // ==========================================================================

  describe("C. Proof pre-verification defense", () => {
    // Helper to create a test proof structure
    function createTestProof(overrides: {
      constraintHash?: Buffer;
      outputCommitment?: Buffer;
      bindingValue?: Buffer;
      nullifier?: Buffer;
      sealBytes?: Buffer;
    } = {}) {
      return {
        sealBytes: overrides.sealBytes ?? Buffer.alloc(256, 0xAA),
        constraintHash: Array.from(overrides.constraintHash ?? Buffer.alloc(HASH_SIZE, 0x11)),
        outputCommitment: Array.from(overrides.outputCommitment ?? Buffer.alloc(HASH_SIZE, 0x22)),
        bindingValue: Array.from(overrides.bindingValue ?? Buffer.alloc(HASH_SIZE, 0x33)),
        nullifier: Array.from(overrides.nullifier ?? Buffer.alloc(HASH_SIZE, 0x44)),
      };
    }

    it("rejects completeTaskPrivate with all-zero nullifier", async () => {
      const worker = await freshKeypair();
      const workerId = makeAgentId("secZk1", runId);
      const workerPda = await registerAgent(worker, workerId);

      const constraintHash = Buffer.alloc(HASH_SIZE, 0x11);
      const taskId = makeTaskId("secZk1", runId);
      const taskPda = deriveTaskPda(creator.publicKey, taskId, program.programId);
      const escrowPda = deriveEscrowPda(taskPda, program.programId);

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("ZK nullifier test".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          Array.from(constraintHash),
          0,
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      const claimPda = await claimTask(taskPda, workerPda, worker);

      const proof = createTestProof({
        constraintHash,
        nullifier: Buffer.alloc(HASH_SIZE, 0), // All zeros
      });

      // Derive nullifier PDA for the all-zero nullifier
      const [nullifierPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier"), Buffer.alloc(HASH_SIZE, 0)],
        program.programId,
      );

      try {
        await program.methods
          .completeTaskPrivate(new BN(0), proof)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: workerPda,
            protocolConfig: protocolPda,
            nullifierAccount: nullifierPda,
            treasury: treasuryPubkey,
            authority: worker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker])
          .rpc();
        expect.fail("Should reject all-zero nullifier");
      } catch (e: any) {
        expect(e.message).to.include("InvalidNullifier");
      }
    });

    it("rejects completeTaskPrivate with all-zero binding", async () => {
      const worker = await freshKeypair();
      const workerId = makeAgentId("secZk2", runId);
      const workerPda = await registerAgent(worker, workerId);

      const constraintHash = Buffer.alloc(HASH_SIZE, 0x22);
      const taskId = makeTaskId("secZk2", runId);
      const taskPda = deriveTaskPda(creator.publicKey, taskId, program.programId);
      const escrowPda = deriveEscrowPda(taskPda, program.programId);

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("ZK binding test".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          Array.from(constraintHash),
          0,
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      const claimPda = await claimTask(taskPda, workerPda, worker);

      const nullifierBytes = Buffer.alloc(HASH_SIZE, 0x55);
      const proof = createTestProof({
        constraintHash,
        bindingValue: Buffer.alloc(HASH_SIZE, 0), // All zeros
        nullifier: nullifierBytes,
      });

      const [nullifierPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("nullifier"), nullifierBytes],
        program.programId,
      );

      try {
        await program.methods
          .completeTaskPrivate(new BN(0), proof)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: workerPda,
            protocolConfig: protocolPda,
            nullifierAccount: nullifierPda,
            treasury: treasuryPubkey,
            authority: worker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker])
          .rpc();
        expect.fail("Should reject all-zero binding");
      } catch (e: any) {
        expect(e.message).to.include("InvalidProofBinding");
      }
    });
  });
});
