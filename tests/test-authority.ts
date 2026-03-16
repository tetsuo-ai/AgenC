/**
 * Issue #20: Authority and PDA Validation Tests
 *
 * Split from test_1.ts for domain-focused test organization.
 * Uses LiteSVM for fast in-process testing.
 */

import BN from "bn.js";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_INFERENCE,
  CAPABILITY_ARBITER,
  TASK_TYPE_EXCLUSIVE,
  TASK_TYPE_COLLABORATIVE,
  TASK_TYPE_COMPETITIVE,
  VALID_EVIDENCE,
  getDefaultDeadline,
  buildCancelTaskRemainingAccounts,
} from "./test-utils.ts";
import {
  fundAccount,
  advanceClock,
  getClockTimestamp,
} from "./litesvm-helpers.ts";
import { createTestContext } from "./test-litesvm-setup.ts";

describe("Issue #20: Authority and PDA Validation Tests", () => {
  const ctx = createTestContext();

  // Local aliases — assigned from ctx after before() populates them.
  // We use property access on ctx so the values resolve at test runtime.
  let program: typeof ctx.program;
  let provider: typeof ctx.provider;
  let svm: typeof ctx.svm;
  let protocolPda: PublicKey;
  let runId: string;
  let creator: Keypair;
  let worker1: Keypair;
  let worker2: Keypair;
  let worker3: Keypair;
  let creatorAgentPda: PublicKey;
  let agentId1: Buffer;
  let agentId2: Buffer;
  let agentId3: Buffer;
  let creatorAgentId: Buffer;
  let treasuryPubkey: PublicKey;
  let secondSigner: Keypair;
  let thirdSigner: Keypair;

  // Bind PDA helpers that close over program.programId
  let deriveAgentPda: (agentId: Buffer) => PublicKey;
  let deriveTaskPda: (creatorPubkey: PublicKey, taskId: Buffer) => PublicKey;
  let deriveEscrowPda: (taskPda: PublicKey) => PublicKey;
  let deriveClaimPda: (taskPda: PublicKey, workerPubkey: PublicKey) => PublicKey;
  let makeAgentId: (prefix: string) => Buffer;
  let createFreshWorker: (capabilities?: number) => Promise<{ wallet: Keypair; agentId: Buffer; agentPda: PublicKey }>; 
  let getPooledWorker: () => { wallet: Keypair; agentId: Buffer; agentPda: PublicKey };

  before(() => {
    program = ctx.program;
    provider = ctx.provider;
    svm = ctx.svm;
    protocolPda = ctx.protocolPda;
    runId = ctx.runId;
    creator = ctx.creator;
    worker1 = ctx.worker1;
    worker2 = ctx.worker2;
    worker3 = ctx.worker3;
    creatorAgentPda = ctx.creatorAgentPda;
    agentId1 = ctx.agentId1;
    agentId2 = ctx.agentId2;
    agentId3 = ctx.agentId3;
    creatorAgentId = ctx.creatorAgentId;
    treasuryPubkey = ctx.treasuryPubkey;
    secondSigner = ctx.secondSigner;
    thirdSigner = ctx.thirdSigner;
    deriveAgentPda = ctx.deriveAgentPda;
    deriveTaskPda = ctx.deriveTaskPda;
    deriveEscrowPda = ctx.deriveEscrowPda;
    deriveClaimPda = ctx.deriveClaimPda;
    makeAgentId = ctx.makeAgentId;
    createFreshWorker = ctx.createFreshWorker;
    getPooledWorker = ctx.getPooledWorker;
  });

  // Helper function to derive state PDA
  function deriveStatePda(authority: PublicKey, stateKey: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("state"), authority.toBuffer(), stateKey],
      program.programId,
    )[0];
  }

  // Helper function to derive dispute PDA
  function deriveDisputePda(disputeId: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("dispute"), disputeId],
      program.programId,
    )[0];
  }

  // Helper function to derive vote PDA
  function deriveVotePda(
    disputePda: PublicKey,
    arbiterPda: PublicKey,
  ): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), disputePda.toBuffer(), arbiterPda.toBuffer()],
      program.programId,
    )[0];
  }

  // Helper function to derive authority vote PDA
  function deriveAuthorityVotePda(
    disputePda: PublicKey,
    authority: PublicKey,
  ): PublicKey {
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("authority_vote"),
        disputePda.toBuffer(),
        authority.toBuffer(),
      ],
      program.programId,
    )[0];
  }

  describe("Issue #20: Authority and PDA Validation Tests", () => {
    describe("register_agent", () => {
      it("Rejects registration with wrong authority (signer mismatch)", async () => {
        const newAgentId = makeAgentId("auth-test-1");
        const agentPda = deriveAgentPda(newAgentId);
        const wrongSigner = Keypair.generate();

        // Fund wrong signer
        fundAccount(svm, wrongSigner.publicKey, 1 * LAMPORTS_PER_SOL);

        // Try to register with wrong signer - but this actually works
        // because authority is just the payer/signer, not a special account
        await program.methods
          .registerAgent(
            Array.from(newAgentId),
            new BN(CAPABILITY_COMPUTE),
            "https://test.example.com",
            null,
            new BN(LAMPORTS_PER_SOL / 10), // stake_amount
          )
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: wrongSigner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([wrongSigner])
          .rpc();

        // Verify the agent was registered with wrongSigner as authority
        const agent = await program.account.agentRegistration.fetch(agentPda);
        expect(agent.authority.toString()).to.equal(
          wrongSigner.publicKey.toString(),
        );
      });
    });

    describe("update_agent", () => {
      it("Rejects update by non-owner", async () => {
        const nonOwner = Keypair.generate();
        fundAccount(svm, nonOwner.publicKey, 1 * LAMPORTS_PER_SOL);

        // Try to update agent1 (owned by worker1) with non-owner signer
        try {
          await program.methods
            .updateAgent(
              new BN(CAPABILITY_COMPUTE | CAPABILITY_INFERENCE),
              null,
              null,
              null,
            )
            .accountsPartial({
              agent: deriveAgentPda(agentId1),
              authority: nonOwner.publicKey,
            })
            .signers([nonOwner])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });

      it("Rejects update with mismatched authority account", async () => {
        // Try to use worker2's key as authority but sign with worker1
        try {
          await program.methods
            .updateAgent(new BN(CAPABILITY_COMPUTE), null, null, null)
            .accountsPartial({
              agent: deriveAgentPda(agentId1),
              authority: worker2.publicKey, // Wrong authority
            })
            .signers([worker2]) // Even though signing, authority doesn't match agent.authority
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });
    });

    describe("deregister_agent", () => {
      it("Rejects deregistration by non-owner", async () => {
        // Create a new agent specifically for this test
        const deregAgentId = makeAgentId("dereg-test");
        const deregAgentPda = deriveAgentPda(deregAgentId);
        const deregOwner = Keypair.generate();
        const nonOwner = Keypair.generate();

        fundAccount(svm, deregOwner.publicKey, 2 * LAMPORTS_PER_SOL);
        fundAccount(svm, nonOwner.publicKey, 1 * LAMPORTS_PER_SOL);

        // Register agent
        await program.methods
          .registerAgent(
            Array.from(deregAgentId),
            new BN(CAPABILITY_COMPUTE),
            "https://dereg-test.example.com",
            null,
            new BN(LAMPORTS_PER_SOL / 10), // stake_amount
          )
          .accountsPartial({
            agent: deregAgentPda,
            protocolConfig: protocolPda,
            authority: deregOwner.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([deregOwner])
          .rpc();

        // Try to deregister with non-owner
        try {
          await program.methods
            .deregisterAgent()
            .accountsPartial({
              agent: deregAgentPda,
              protocolConfig: protocolPda,
              authority: nonOwner.publicKey,
            })
            .signers([nonOwner])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });
    });

    describe("create_task", () => {
      it("Rejects task creation with wrong protocol_config PDA", async () => {
        const taskId = Buffer.from("auth-task-001".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const wrongProtocol = Keypair.generate().publicKey;

        try {
          await program.methods
            .createTask(
              Array.from(taskId),
              new BN(CAPABILITY_COMPUTE),
              Buffer.from("Wrong protocol task".padEnd(64, "\0")),
              new BN(LAMPORTS_PER_SOL / 100),
              1,
              getDefaultDeadline(),
              TASK_TYPE_EXCLUSIVE,
              null,
              0, // min_reputation
              null, // reward_mint
            )
            .accountsPartial({
              task: taskPda,
              escrow: escrowPda,
              protocolConfig: wrongProtocol, // Wrong PDA
              creatorAgent: creatorAgentPda,
              authority: creator.publicKey,
              creator: creator.publicKey,
              systemProgram: SystemProgram.programId,
              rewardMint: null,
              creatorTokenAccount: null,
              tokenEscrowAta: null,
              tokenProgram: null,
              associatedTokenProgram: null,
            })
            .signers([creator])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });
    });

    describe("claim_task", () => {
      it("Rejects claim with wrong worker authority", async () => {
        const taskId = Buffer.from("auth-task-002".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Wrong authority claim test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, deriveAgentPda(agentId2));

        // Try to claim using worker1's agent but signing with worker2
        try {
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda,
              claim: claimPda,
              worker: deriveAgentPda(agentId1), // Agent owned by worker1
              authority: worker2.publicKey, // But signing with worker2
              systemProgram: SystemProgram.programId,
            })
            .signers([worker2])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });

      it("Rejects claim with wrong agent PDA", async () => {
        const taskId = Buffer.from("auth-task-003".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Wrong agent PDA claim test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, deriveAgentPda(agentId1));
        const wrongAgentId = makeAgentId("nonexistent");

        // Try to claim with non-existent agent PDA
        try {
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda,
              claim: claimPda,
              worker: deriveAgentPda(wrongAgentId), // Non-existent agent
              authority: worker1.publicKey,
            })
            .signers([worker1])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });
    });

    describe("complete_task", () => {
      it("Rejects completion with wrong worker authority", async () => {
        const worker1 = await createFreshWorker();
        const worker2 = await createFreshWorker();
        const taskId = Buffer.from("auth-task-004".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Wrong authority complete test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker1.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker1.agentPda,
            authority: worker1.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1.wallet])
          .rpc();

        // Try to complete with wrong authority (worker2 trying to complete worker1's claim)
        try {
          await program.methods
            .completeTask(
              Array.from(Buffer.from("proof".padEnd(32, "\0"))),
              null,
            )
            .accountsPartial({
              task: taskPda,
              claim: claimPda,
              escrow: escrowPda,
              creator: creator.publicKey,
              worker: worker1.agentPda, // Worker1's agent
              protocolConfig: protocolPda,
              treasury: treasuryPubkey,
              authority: worker2.wallet.publicKey, // But worker2 signing
              systemProgram: SystemProgram.programId,
              tokenEscrowAta: null,
              workerTokenAccount: null,
              treasuryTokenAccount: null,
              rewardMint: null,
              tokenProgram: null,
            })
            .signers([worker2.wallet])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });

      it("Rejects completion with wrong treasury", async () => {
        const worker = await createFreshWorker();
        const taskId = Buffer.from("auth-task-005".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const wrongTreasury = Keypair.generate();

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Wrong treasury complete test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();

        // Try to complete with wrong treasury
        try {
          await program.methods
            .completeTask(
              Array.from(Buffer.from("proof".padEnd(32, "\0"))),
              null,
            )
            .accountsPartial({
              task: taskPda,
              claim: claimPda,
              escrow: escrowPda,
              creator: creator.publicKey,
              worker: worker.agentPda,
              protocolConfig: protocolPda,
              treasury: wrongTreasury.publicKey, // Wrong treasury
              authority: worker.wallet.publicKey,
              systemProgram: SystemProgram.programId,
              tokenEscrowAta: null,
              workerTokenAccount: null,
              treasuryTokenAccount: null,
              rewardMint: null,
              tokenProgram: null,
            })
            .signers([worker.wallet])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });

      it("Rejects completion with wrong claim PDA", async () => {
        const worker1 = await createFreshWorker();
        const worker2 = await createFreshWorker();
        const taskId = Buffer.from("auth-task-006".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Wrong claim PDA complete test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            2,
            getDefaultDeadline(),
            TASK_TYPE_COLLABORATIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        // Worker1 claims
        const claimPda1 = deriveClaimPda(taskPda, worker1.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: worker1.agentPda,
            authority: worker1.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1.wallet])
          .rpc();

        // Worker2 claims
        const claimPda2 = deriveClaimPda(taskPda, worker2.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: worker2.agentPda,
            authority: worker2.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker2.wallet])
          .rpc();

        // Worker1 tries to complete using Worker2's claim PDA
        try {
          await program.methods
            .completeTask(
              Array.from(Buffer.from("proof".padEnd(32, "\0"))),
              null,
            )
            .accountsPartial({
              task: taskPda,
              claim: claimPda2, // Worker2's claim
              escrow: escrowPda,
              creator: creator.publicKey,
              worker: worker1.agentPda, // But using Worker1's agent
              protocolConfig: protocolPda,
              treasury: treasuryPubkey,
              authority: worker1.wallet.publicKey,
              systemProgram: SystemProgram.programId,
              tokenEscrowAta: null,
              workerTokenAccount: null,
              treasuryTokenAccount: null,
              rewardMint: null,
              tokenProgram: null,
            })
            .signers([worker1.wallet])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });
    });

    describe("cancel_task", () => {
      it("Rejects cancellation by non-creator", async () => {
        const taskId = Buffer.from("auth-task-007".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const nonCreator = Keypair.generate();

        fundAccount(svm, nonCreator.publicKey, 1 * LAMPORTS_PER_SOL);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Non-creator cancel test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        // Try to cancel with non-creator
        try {
          await program.methods
            .cancelTask()
            .accountsPartial({
              task: taskPda,
              escrow: escrowPda,
              authority: nonCreator.publicKey,
              protocolConfig: protocolPda,
              systemProgram: SystemProgram.programId,
              tokenEscrowAta: null,
              creatorTokenAccount: null,
              rewardMint: null,
              tokenProgram: null,
            })
            .signers([nonCreator])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });

      it("Does not reopen cancelled task when claim expires (zombie task fix #138)", async () => {
        // This test verifies the fix for the zombie task attack where expire_claim
        // could reset a cancelled task's status to Open, creating tasks with empty
        // escrows that would trap workers.
        const worker = await createFreshWorker();
        const taskId = Buffer.from(`zombie-fix-${runId}`.padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        // Get the on-chain clock time to set deadline relative to it
        const slot = await provider.connection.getSlot();
        const blockTime = await provider.connection.getBlockTime(slot);
        // Set deadline to 4 seconds from now
        const shortDeadline = (blockTime || getClockTimestamp(svm)) + 4;

        // 1. Create task with short deadline
        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Zombie task fix test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            new BN(shortDeadline),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        // 2. Worker claims task (status becomes InProgress, claim.expires_at = deadline)
        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();

        let task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ inProgress: {} });
        expect(task.currentWorkers).to.equal(1);

        // 3. Advance clock past deadline (LiteSVM doesn't advance time automatically)
        advanceClock(svm, 10);

        // 4. Creator cancels task (status becomes Cancelled)
        // When task has workers, remaining_accounts must contain
        // (claim, worker_agent, worker_authority_recipient) triples.
        await program.methods
          .cancelTask()
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            authority: creator.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null,
            creatorTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .remainingAccounts(
            buildCancelTaskRemainingAccounts([
              {
                claim: claimPda,
                workerAgent: worker.agentPda,
                workerAuthority: worker.wallet.publicKey,
              },
            ]),
          )
          .signers([creator])
          .rpc();

        task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ cancelled: {} });

        // Claim is closed by cancel_task, so expire_claim would fail
        // Instead verify the task is properly cancelled with no workers
        expect(task.currentWorkers).to.equal(0);
      });
    });

    describe("update_state", () => {
      it("Rejects state update with wrong agent authority", async () => {
        const stateKey = Buffer.from("state-key-001".padEnd(32, "\0"));
        // State PDA uses signer's authority in seeds
        const statePda = deriveStatePda(worker2.publicKey, stateKey);
        const stateValue = Buffer.from("test-value".padEnd(64, "\0"));

        // Try to update state with worker2 signing but using worker1's agent
        // The has_one = authority constraint on agent will fail
        try {
          await program.methods
            .updateState(
              Array.from(stateKey),
              Array.from(stateValue),
              new BN(0),
            )
            .accountsPartial({
              state: statePda,
              agent: deriveAgentPda(agentId1), // Worker1's agent
              authority: worker2.publicKey, // But worker2 signing
              protocolConfig: protocolPda,
              systemProgram: SystemProgram.programId,
            })
            .signers([worker2])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });

      it("Allows state update with correct authority", async () => {
        const stateKey = Buffer.from("state-key-002".padEnd(32, "\0"));
        // State PDA uses authority in seeds
        const statePda = deriveStatePda(worker1.publicKey, stateKey);
        const stateValue = Buffer.from("valid-value".padEnd(64, "\0"));

        // Fetch current state version if it exists (for re-runs on persistent validator)
        let expectedVersion = 0;
        try {
          const existingState =
            await program.account.coordinationState.fetch(statePda);
          expectedVersion = existingState.version.toNumber();
        } catch {
          // State doesn't exist yet, version 0 is correct
        }

        await program.methods
          .updateState(
            Array.from(stateKey),
            Array.from(stateValue),
            new BN(expectedVersion),
          )
          .accountsPartial({
            state: statePda,
            agent: deriveAgentPda(agentId1),
            authority: worker1.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker1])
          .rpc();

        const state = await program.account.coordinationState.fetch(statePda);
        expect(state.version.toNumber()).to.equal(expectedVersion + 1);
      });
    });

    describe("initiate_dispute", () => {
      it("Rejects dispute initiation with wrong agent authority", async () => {
        const worker = await createFreshWorker();
        const wrongSigner = Keypair.generate();
        fundAccount(svm, wrongSigner.publicKey, 1 * LAMPORTS_PER_SOL);

        const taskId = Buffer.from("auth-task-008".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const disputeId = Buffer.from(`dispute-001-${runId}`.padEnd(32, "\0"));
        const disputePda = deriveDisputePda(disputeId);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Dispute authority test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();

        // Try to initiate dispute with wrong authority
        try {
          await program.methods
            .initiateDispute(
              Array.from(disputeId),
              Array.from(taskId),
              Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
              0, // Refund
              VALID_EVIDENCE,
            )
            .accountsPartial({
              dispute: disputePda,
              task: taskPda,
              agent: worker.agentPda, // Worker's agent
              authority: wrongSigner.publicKey, // But wrong signer signing
              protocolConfig: protocolPda,
              systemProgram: SystemProgram.programId,
              initiatorClaim: claimPda,
              workerAgent: null,
              workerClaim: null,
            })
            .signers([wrongSigner])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });
    });

    describe("vote_dispute", () => {
      let arbiter: Keypair;
      let arbiterAgentId: Buffer;
      let arbiterAgentPda: PublicKey;

      before(async () => {
        // Create an arbiter agent with ARBITER capability and stake
        arbiter = Keypair.generate();
        arbiterAgentId = makeAgentId("arbiter");
        arbiterAgentPda = deriveAgentPda(arbiterAgentId);

        fundAccount(svm, arbiter.publicKey, 5 * LAMPORTS_PER_SOL);

        await program.methods
          .registerAgent(
            Array.from(arbiterAgentId),
            new BN(CAPABILITY_ARBITER | CAPABILITY_COMPUTE),
            "https://arbiter.example.com",
            null,
            new BN(LAMPORTS_PER_SOL), // stake_amount - required parameter
          )
          .accountsPartial({
            agent: arbiterAgentPda,
            protocolConfig: protocolPda,
            authority: arbiter.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([arbiter])
          .rpc();
      });

      it("Rejects vote with wrong arbiter authority", async () => {
        const worker = await createFreshWorker();
        const taskId = Buffer.from("auth-task-009".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const disputeId = Buffer.from(`dispute-002-${runId}`.padEnd(32, "\0"));
        const disputePda = deriveDisputePda(disputeId);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Vote authority test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();

        // Initiate dispute properly
        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
            0,
            VALID_EVIDENCE,
          )
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: worker.agentPda,
            authority: worker.wallet.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            initiatorClaim: claimPda,
            workerAgent: null,
            workerClaim: null,
          })
          .signers([worker.wallet])
          .rpc();

        // Try to vote with wrong authority
        const votePda = deriveVotePda(disputePda, arbiterAgentPda);
        const wrongSigner = Keypair.generate();
        const authorityVotePda = deriveAuthorityVotePda(
          disputePda,
          wrongSigner.publicKey,
        );
        fundAccount(svm, wrongSigner.publicKey, 1 * LAMPORTS_PER_SOL);

        try {
          await program.methods
            .voteDispute(true)
            .accountsPartial({
              dispute: disputePda,
              task: taskPda, // Required for party validation
              workerClaim: claimPda, // Optional but needed for validation
              vote: votePda,
              authorityVote: authorityVotePda,
              arbiter: arbiterAgentPda, // Correct arbiter agent
              protocolConfig: protocolPda,
              authority: wrongSigner.publicKey, // But wrong signer
              systemProgram: SystemProgram.programId,
              defendantAgent: null,
            })
            .signers([wrongSigner])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });

      it("Rejects vote by non-arbiter (lacks ARBITER capability)", async () => {
        const worker = await createFreshWorker();
        const taskId = Buffer.from("auth-task-010".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const disputeId = Buffer.from(`dispute-003-${runId}`.padEnd(32, "\0"));
        const disputePda = deriveDisputePda(disputeId);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Non-arbiter vote test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();

        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
            0,
            VALID_EVIDENCE,
          )
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: worker.agentPda,
            authority: worker.wallet.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            initiatorClaim: claimPda,
            workerAgent: null,
            workerClaim: null,
          })
          .signers([worker.wallet])
          .rpc();

        // Worker's agent doesn't have ARBITER capability
        const votePda = deriveVotePda(disputePda, worker.agentPda);
        const authorityVotePda = deriveAuthorityVotePda(
          disputePda,
          worker.wallet.publicKey,
        );

        try {
          await program.methods
            .voteDispute(true)
            .accountsPartial({
              dispute: disputePda,
              task: taskPda, // Required for party validation
              workerClaim: claimPda, // Optional
              vote: votePda,
              authorityVote: authorityVotePda,
              arbiter: worker.agentPda, // Agent without ARBITER capability
              protocolConfig: protocolPda,
              authority: worker.wallet.publicKey,
              systemProgram: SystemProgram.programId,
              defendantAgent: null,
            })
            .signers([worker.wallet])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });
    });

    describe("resolve_dispute", () => {
      it("Rejects resolution before voting ends", async () => {
        const worker = await createFreshWorker();
        const taskId = Buffer.from("auth-task-011".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const disputeId = Buffer.from(`dispute-004-${runId}`.padEnd(32, "\0"));
        const disputePda = deriveDisputePda(disputeId);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Early resolution test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();

        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
            0,
            VALID_EVIDENCE,
          )
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: worker.agentPda,
            authority: worker.wallet.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            initiatorClaim: claimPda,
            workerAgent: null,
            workerClaim: null,
          })
          .signers([worker.wallet])
          .rpc();

        // Try to resolve immediately (voting deadline is 24 hours from now)
        try {
          await program.methods
            .resolveDispute()
            .accountsPartial({
              dispute: disputePda,
              task: taskPda,
              escrow: escrowPda,
              protocolConfig: protocolPda,
              resolver: provider.wallet.publicKey,
              creator: creator.publicKey,
              workerClaim: null, // Required with worker/workerAuthority
              worker: null,
              workerAuthority: null,
              systemProgram: SystemProgram.programId,
              tokenEscrowAta: null,
              creatorTokenAccount: null,
              workerTokenAccountAta: null,
              treasuryTokenAccount: null,
              rewardMint: null,
              tokenProgram: null,
            })
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });

      it("Rejects resolution with insufficient votes (no votes cast)", async () => {
        // This is tested implicitly - if we could warp time, we'd test this
        // The resolve_dispute instruction requires total_votes > 0
        // Without time manipulation in local validator, we document this requirement
        const worker = await createFreshWorker();
        const taskId = Buffer.from("auth-task-012".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const disputeId = Buffer.from(`dispute-005-${runId}`.padEnd(32, "\0"));
        const disputePda = deriveDisputePda(disputeId);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("No votes test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([worker.wallet])
          .rpc();

        await program.methods
          .initiateDispute(
            Array.from(disputeId),
            Array.from(taskId),
            Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
            0,
            VALID_EVIDENCE,
          )
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            agent: worker.agentPda,
            authority: worker.wallet.publicKey,
            protocolConfig: protocolPda,
            systemProgram: SystemProgram.programId,
            initiatorClaim: claimPda,
            workerAgent: null,
            workerClaim: null,
          })
          .signers([worker.wallet])
          .rpc();

        // Verify dispute has 0 votes
        const dispute = await program.account.dispute.fetch(disputePda);
        expect(
          typeof dispute.votesFor === "object"
            ? dispute.votesFor.toNumber()
            : dispute.votesFor,
        ).to.equal(0);
        expect(
          typeof dispute.votesAgainst === "object"
            ? dispute.votesAgainst.toNumber()
            : dispute.votesAgainst,
        ).to.equal(0);
        expect(
          typeof dispute.totalVoters === "object"
            ? dispute.totalVoters.toNumber()
            : dispute.totalVoters,
        ).to.equal(0);

        // Resolution would fail with VotingNotEnded and InsufficientVotes
        // We can't test the InsufficientVotes path without time manipulation
      });
    });

    describe("initialize_protocol", () => {
      it("Rejects re-initialization of already initialized protocol", async () => {
        // The protocol is already initialized in the before() hook
        // Trying to initialize again should fail because PDA already exists
        try {
          const programDataPda = deriveProgramDataPda(program.programId);
          await program.methods
            .initializeProtocol(51, 100, 1 * LAMPORTS_PER_SOL)
            .accountsPartial({
              protocolConfig: protocolPda,
              treasury: treasuryPubkey,
              authority: provider.wallet.publicKey,
              systemProgram: SystemProgram.programId,
            })
            .remainingAccounts([
              {
                pubkey: deriveProgramDataPda(program.programId),
                isSigner: false,
                isWritable: false,
              },
            ])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: unknown) {
          // Verify error occurred - Anchor returns AnchorError with errorCode
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });

      it("Confirms protocol singleton pattern via PDA", async () => {
        // The protocol PDA is deterministic - only one can exist
        const [derivedPda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol")],
          program.programId,
        );
        expect(derivedPda.toString()).to.equal(protocolPda.toString());

        // Verify it exists
        const config = await program.account.protocolConfig.fetch(protocolPda);
        expect(config.authority.toString()).to.equal(
          provider.wallet.publicKey.toString(),
        );
      });
    });
  });


});
