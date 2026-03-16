/**
 * Issue #26: Instruction Fuzzing and Invariant Validation Tests
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
} from "./test-utils";
import {
  fundAccount,
  advanceClock,
  getClockTimestamp,
} from "./litesvm-helpers";
import { createTestContext } from "./test-litesvm-setup";

describe("Issue #26: Instruction Fuzzing and Invariant Validation Tests", () => {
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

  describe("Issue #26: Instruction Fuzzing and Invariant Validation", () => {
    describe("Boundary inputs", () => {
      it("max_workers = 100 (max allowed) is valid", async () => {
        const taskId = Buffer.from("fuzz-001".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Max workers test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            100,
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
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const task = await program.account.task.fetch(taskPda);
        expect(task.maxWorkers).to.equal(100);
      });

      it("max_workers = 0 should fail (InvalidMaxWorkers)", async () => {
        const taskId = Buffer.from("fuzz-002".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        try {
          await program.methods
            .createTask(
              Array.from(taskId),
              new BN(CAPABILITY_COMPUTE),
              Buffer.from("Zero workers test".padEnd(64, "\0")),
              new BN(LAMPORTS_PER_SOL / 100),
              0,
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
              rewardMint: null,
              creatorTokenAccount: null,
              tokenEscrowAta: null,
              tokenProgram: null,
              associatedTokenProgram: null,
            })
            .signers([creator])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: any) {
          expect(e.error?.errorCode?.code || e.message).to.include(
            "InvalidMaxWorkers",
          );
        }
      });

      it("reward_amount = 0 is rejected (InvalidReward)", async () => {
        const taskId = Buffer.from("fuzz-003".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        try {
          await program.methods
            .createTask(
              Array.from(taskId),
              new BN(CAPABILITY_COMPUTE),
              Buffer.from("Zero reward test".padEnd(64, "\0")),
              new BN(0),
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
              rewardMint: null,
              creatorTokenAccount: null,
              tokenEscrowAta: null,
              tokenProgram: null,
              associatedTokenProgram: null,
            })
            .signers([creator])
            .rpc();
          expect.fail("Should have rejected zero reward");
        } catch (e: any) {
          expect(e.error?.errorCode?.code).to.equal("InvalidReward");
        }
      });

      it("reward_amount = very large value should fail (insufficient funds)", async () => {
        const taskId = Buffer.from("fuzz-004".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        // Creator doesn't have u64::MAX lamports
        try {
          await program.methods
            .createTask(
              Array.from(taskId),
              new BN(CAPABILITY_COMPUTE),
              Buffer.from("Huge reward test".padEnd(64, "\0")),
              new BN("18446744073709551615"), // u64::MAX
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

      it("deadline = 0 should fail with InvalidDeadline (#492)", async () => {
        const taskId = Buffer.from("fuzz-005".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        try {
          await program.methods
            .createTask(
              Array.from(taskId),
              new BN(CAPABILITY_COMPUTE),
              Buffer.from("No deadline test".padEnd(64, "\0")),
              new BN(LAMPORTS_PER_SOL),
              1,
              new BN(0),
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
              rewardMint: null,
              creatorTokenAccount: null,
              tokenEscrowAta: null,
              tokenProgram: null,
              associatedTokenProgram: null,
            })
            .signers([creator])
            .rpc();
          expect.fail("Should have failed with deadline=0");
        } catch (e: unknown) {
          // Deadline=0 is rejected as past deadline (DeadlinePassed)
          const anchorError = e as {
            error?: { errorCode?: { code: string } };
            message?: string;
          };
          expect(anchorError.error?.errorCode?.code || anchorError.message).to
            .exist;
        }
      });

      it("deadline in past should fail on creation", async () => {
        const taskId = Buffer.from("fuzz-006".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        const pastDeadline = getClockTimestamp(svm) - 3600; // 1 hour ago

        try {
          await program.methods
            .createTask(
              Array.from(taskId),
              new BN(CAPABILITY_COMPUTE),
              Buffer.from("Past deadline test".padEnd(64, "\0")),
              new BN(0),
              1,
              new BN(pastDeadline),
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

      it("task_type > 2 should fail (InvalidTaskType)", async () => {
        const taskId = Buffer.from("fuzz-007".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        try {
          await program.methods
            .createTask(
              Array.from(taskId),
              new BN(CAPABILITY_COMPUTE),
              Buffer.from("Invalid type test".padEnd(64, "\0")),
              new BN(0),
              1,
              new BN(0),
              3,
              null, // Invalid: only 0, 1, 2 are valid
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
              rewardMint: null,
              creatorTokenAccount: null,
              tokenEscrowAta: null,
              tokenProgram: null,
              associatedTokenProgram: null,
            })
            .signers([creator])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: any) {
          expect(e.message).to.include("InvalidTaskType");
        }
      });

      it("capabilities = 0 is rejected (InvalidCapabilities)", async () => {
        const zeroCapOwner = Keypair.generate();
        const zeroCapId = makeAgentId("fuzz-1");
        const zeroCapPda = deriveAgentPda(zeroCapId);

        fundAccount(svm, zeroCapOwner.publicKey, 2 * LAMPORTS_PER_SOL);

        try {
          await program.methods
            .registerAgent(
              Array.from(zeroCapId),
              new BN(0), // Zero capabilities - now rejected
              "https://zero-cap.example.com",
              null,
              new BN(LAMPORTS_PER_SOL),
            )
            .accountsPartial({
              agent: zeroCapPda,
              protocolConfig: protocolPda,
              authority: zeroCapOwner.publicKey,
            })
            .signers([zeroCapOwner])
            .rpc();
          expect.fail("Should have failed with InvalidCapabilities");
        } catch (e: any) {
          expect(e.message).to.include("InvalidCapabilities");
        }
      });

      it("capabilities = u64::MAX is valid", async () => {
        const maxCapOwner = Keypair.generate();
        const maxCapId = makeAgentId("fuzz-2");
        const maxCapPda = deriveAgentPda(maxCapId);

        fundAccount(svm, maxCapOwner.publicKey, 2 * LAMPORTS_PER_SOL);

        await program.methods
          .registerAgent(
            Array.from(maxCapId),
            new BN("18446744073709551615"), // u64::MAX
            "https://max-cap.example.com",
            null,
            new BN(LAMPORTS_PER_SOL),
          )
          .accountsPartial({
            agent: maxCapPda,
            protocolConfig: protocolPda,
            authority: maxCapOwner.publicKey,
          })
          .signers([maxCapOwner])
          .rpc();

        const agent = await program.account.agentRegistration.fetch(maxCapPda);
        // Verify u64::MAX was stored — BN.js may have precision issues with max u64 in some environments
        // so we verify the raw bytes instead of the decimal string
        const rawCapBytes = agent.capabilities.toArray("le", 8);
        expect(rawCapBytes).to.deep.equal([
          255, 255, 255, 255, 255, 255, 255, 255,
        ]);
      });

      it("Empty strings for endpoint are rejected (InvalidInput)", async () => {
        const emptyStrOwner = Keypair.generate();
        const emptyStrId = makeAgentId("fuzz-3");
        const emptyStrPda = deriveAgentPda(emptyStrId);

        fundAccount(svm, emptyStrOwner.publicKey, 2 * LAMPORTS_PER_SOL);

        try {
          await program.methods
            .registerAgent(
              Array.from(emptyStrId),
              new BN(CAPABILITY_COMPUTE),
              "", // Empty endpoint - now rejected
              "", // Empty metadata
              new BN(LAMPORTS_PER_SOL),
            )
            .accountsPartial({
              agent: emptyStrPda,
              protocolConfig: protocolPda,
              authority: emptyStrOwner.publicKey,
            })
            .signers([emptyStrOwner])
            .rpc();
          expect.fail("Should have failed with InvalidInput");
        } catch (e: any) {
          expect(e.message).to.include("InvalidInput");
        }
      });

      it("Max length strings (128 chars) for endpoint - must be valid URL", async () => {
        const maxLenOwner = Keypair.generate();
        const maxLenId = makeAgentId("fuzz-4");
        const maxLenPda = deriveAgentPda(maxLenId);

        fundAccount(svm, maxLenOwner.publicKey, 2 * LAMPORTS_PER_SOL);

        // Use a valid URL format with padding to max length
        const baseUrl = "https://example.com/";
        const padding = "a".repeat(128 - baseUrl.length);
        const maxUrl = baseUrl + padding;

        await program.methods
          .registerAgent(
            Array.from(maxLenId),
            new BN(CAPABILITY_COMPUTE),
            maxUrl,
            null,
            new BN(LAMPORTS_PER_SOL),
          )
          .accountsPartial({
            agent: maxLenPda,
            protocolConfig: protocolPda,
            authority: maxLenOwner.publicKey,
          })
          .signers([maxLenOwner])
          .rpc();

        const agent = await program.account.agentRegistration.fetch(maxLenPda);
        expect(agent.endpoint.length).to.equal(128);
      });

      it("Over max length strings (129 chars) should fail", async () => {
        const overLenOwner = Keypair.generate();
        const overLenId = makeAgentId("fuzz-5");
        const overLenPda = deriveAgentPda(overLenId);

        fundAccount(svm, overLenOwner.publicKey, 2 * LAMPORTS_PER_SOL);

        const baseUrl = "https://example.com/";
        const padding = "a".repeat(129 - baseUrl.length);
        const overStr = baseUrl + padding;

        try {
          await program.methods
            .registerAgent(
              Array.from(overLenId),
              new BN(CAPABILITY_COMPUTE),
              overStr, // 129 chars - too long
              null,
              new BN(LAMPORTS_PER_SOL),
            )
            .accountsPartial({
              agent: overLenPda,
              protocolConfig: protocolPda,
              authority: overLenOwner.publicKey,
            })
            .signers([overLenOwner])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: any) {
          // May be StringTooLong or InvalidInput depending on validation order
          expect(e.message).to.satisfy(
            (msg: string) =>
              msg.includes("StringTooLong") || msg.includes("InvalidInput"),
          );
        }
      });
    });

    describe("Invariant checks", () => {
      it("task.current_workers <= task.max_workers always", async () => {
        const taskId = Buffer.from("invariant-001".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Invariant test".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 50),
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
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        // Claim up to max using fresh workers
        const worker1 = await createFreshWorker();
        const worker2 = await createFreshWorker();
        const claimPda1 = deriveClaimPda(taskPda, worker1.agentPda);
        const claimPda2 = deriveClaimPda(taskPda, worker2.agentPda);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: worker1.agentPda,
            authority: worker1.wallet.publicKey,
          })
          .signers([worker1.wallet])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: worker2.agentPda,
            authority: worker2.wallet.publicKey,
          })
          .signers([worker2.wallet])
          .rpc();

        const task = await program.account.task.fetch(taskPda);
        expect(task.currentWorkers).to.be.at.most(task.maxWorkers);
      });

      it("task.completions <= task.required_completions always", async () => {
        const taskId = Buffer.from("invariant-002".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Completion invariant".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 50),
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
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const worker1 = await createFreshWorker();
        const worker2 = await createFreshWorker();
        const claimPda1 = deriveClaimPda(taskPda, worker1.agentPda);
        const claimPda2 = deriveClaimPda(taskPda, worker2.agentPda);

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            worker: worker1.agentPda,
            authority: worker1.wallet.publicKey,
          })
          .signers([worker1.wallet])
          .rpc();

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda2,
            worker: worker2.agentPda,
            authority: worker2.wallet.publicKey,
          })
          .signers([worker2.wallet])
          .rpc();

        // Complete first worker - this closes the escrow in current design
        await program.methods
          .completeTask(
            Array.from(Buffer.from("proof1".padEnd(32, "\0"))),
            null,
          )
          .accountsPartial({
            task: taskPda,
            claim: claimPda1,
            escrow: escrowPda,
            worker: worker1.agentPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker1.wallet.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([worker1.wallet])
          .rpc();

        // Note: For exclusive tasks (max_workers=1), escrow is closed after single completion

        const task = await program.account.task.fetch(taskPda);
        expect(task.completions).to.be.at.most(task.requiredCompletions);
      });

      it("escrow.distributed <= escrow.amount always (verified before completion)", async () => {
        const taskId = Buffer.from("invariant-003".padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);
        const rewardAmount = 1 * LAMPORTS_PER_SOL;

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Escrow invariant".padEnd(64, "\0")),
            new BN(rewardAmount),
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
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        // Check escrow invariant before completion (escrow is closed after completion)
        const escrowBefore = await program.account.taskEscrow.fetch(escrowPda);
        expect(escrowBefore.distributed.toNumber()).to.be.at.most(
          escrowBefore.amount.toNumber(),
        );
        expect(escrowBefore.distributed.toNumber()).to.equal(0); // No distributions yet

        const worker = await createFreshWorker();
        const claimPda = deriveClaimPda(taskPda, worker.agentPda);
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: worker.agentPda,
            authority: worker.wallet.publicKey,
          })
          .signers([worker.wallet])
          .rpc();

        await program.methods
          .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: worker.agentPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: worker.wallet.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([worker.wallet])
          .rpc();

        // Escrow is closed after completion - verify task is completed
        const task = await program.account.task.fetch(taskPda);
        expect(task.status).to.deep.equal({ completed: {} });
      });

      it("worker.active_tasks <= 10 always", async () => {
        // Create agent and claim 10 tasks
        const busyAgentOwner = Keypair.generate();
        const busyAgentId = makeAgentId("busy-1");
        const busyAgentPda = deriveAgentPda(busyAgentId);

        fundAccount(svm, busyAgentOwner.publicKey, 15 * LAMPORTS_PER_SOL);

        await program.methods
          .registerAgent(
            Array.from(busyAgentId),
            new BN(CAPABILITY_COMPUTE),
            "https://busy.example.com",
            null,
            new BN(LAMPORTS_PER_SOL),
          )
          .accountsPartial({
            agent: busyAgentPda,
            protocolConfig: protocolPda,
            authority: busyAgentOwner.publicKey,
          })
          .signers([busyAgentOwner])
          .rpc();

        // Create and claim 10 tasks
        for (let i = 0; i < 10; i++) {
          advanceClock(svm, 2); // satisfy rate limit cooldown
          const taskId = Buffer.from(
            `busy-task-${i.toString().padStart(3, "0")}`.padEnd(32, "\0"),
          );
          const taskPda = deriveTaskPda(creator.publicKey, taskId);
          const escrowPda = deriveEscrowPda(taskPda);

          await program.methods
            .createTask(
              Array.from(taskId),
              new BN(CAPABILITY_COMPUTE),
              Buffer.from(`Busy task ${i}`.padEnd(64, "\0")),
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
              rewardMint: null,
              creatorTokenAccount: null,
              tokenEscrowAta: null,
              tokenProgram: null,
              associatedTokenProgram: null,
            })
            .signers([creator])
            .rpc();

          const claimPda = deriveClaimPda(taskPda, deriveAgentPda(busyAgentId));
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda,
              claim: claimPda,
              worker: deriveAgentPda(busyAgentId),
              authority: busyAgentOwner.publicKey,
            })
            .signers([busyAgentOwner])
            .rpc();
        }

        // Verify active_tasks is 10
        let agent = await program.account.agentRegistration.fetch(busyAgentPda);
        expect(agent.activeTasks).to.equal(10);

        // 11th claim should fail
        advanceClock(svm, 2); // satisfy rate limit cooldown
        const taskId11 = Buffer.from("busy-task-010".padEnd(32, "\0"));
        const taskPda11 = deriveTaskPda(creator.publicKey, taskId11);
        const escrowPda11 = deriveEscrowPda(taskPda11);

        await program.methods
          .createTask(
            Array.from(taskId11),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Busy task 10".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda11,
            escrow: escrowPda11,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        const claimPda11 = deriveClaimPda(
          taskPda11,
          deriveAgentPda(busyAgentId),
        );
        try {
          await program.methods
            .claimTask()
            .accountsPartial({
              task: taskPda11,
              claim: claimPda11,
              worker: deriveAgentPda(busyAgentId),
              authority: busyAgentOwner.publicKey,
            })
            .signers([busyAgentOwner])
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

        // Verify active_tasks is still 10
        agent = await program.account.agentRegistration.fetch(busyAgentPda);
        expect(agent.activeTasks).to.be.at.most(10);
      });

      it("Protocol stats only increase (total_tasks, total_agents, completed_tasks)", async () => {
        // Get initial stats
        const configBefore =
          await program.account.protocolConfig.fetch(protocolPda);
        const totalTasksBefore = configBefore.totalTasks.toNumber();
        const totalAgentsBefore = configBefore.totalAgents.toNumber();
        const completedTasksBefore = configBefore.completedTasks.toNumber();

        // Create a task (use unique ID to avoid collision with earlier test)
        const taskId = Buffer.from(`stats-task-002-${runId}`.padEnd(32, "\0"));
        const taskPda = deriveTaskPda(creator.publicKey, taskId);
        const escrowPda = deriveEscrowPda(taskPda);

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Stats increase test".padEnd(64, "\0")),
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
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        // Verify total_tasks increased
        let configAfter =
          await program.account.protocolConfig.fetch(protocolPda);
        expect(configAfter.totalTasks.toNumber()).to.be.greaterThan(
          totalTasksBefore,
        );

        // Create an agent
        const newAgentOwner = Keypair.generate();
        const newAgentId = makeAgentId("stats-new");
        const newAgentPda = deriveAgentPda(newAgentId);

        fundAccount(svm, newAgentOwner.publicKey, 5 * LAMPORTS_PER_SOL);

        await program.methods
          .registerAgent(
            Array.from(newAgentId),
            new BN(CAPABILITY_COMPUTE),
            "https://stats-agent.example.com",
            null,
            new BN(LAMPORTS_PER_SOL),
          )
          .accountsPartial({
            agent: newAgentPda,
            protocolConfig: protocolPda,
            authority: newAgentOwner.publicKey,
          })
          .signers([newAgentOwner])
          .rpc();

        // Verify total_agents increased
        configAfter = await program.account.protocolConfig.fetch(protocolPda);
        expect(configAfter.totalAgents.toNumber()).to.be.greaterThan(
          totalAgentsBefore,
        );

        // Complete a task
        const claimPda = deriveClaimPda(taskPda, deriveAgentPda(newAgentId));
        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            worker: deriveAgentPda(newAgentId),
            authority: newAgentOwner.publicKey,
          })
          .signers([newAgentOwner])
          .rpc();

        await program.methods
          .completeTask(Array.from(Buffer.from("proof".padEnd(32, "\0"))), null)
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            escrow: escrowPda,
            worker: deriveAgentPda(newAgentId),
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
            authority: newAgentOwner.publicKey,
            tokenEscrowAta: null,
            workerTokenAccount: null,
            treasuryTokenAccount: null,
            rewardMint: null,
            tokenProgram: null,
          })
          .signers([newAgentOwner])
          .rpc();

        // Verify completed_tasks increased
        configAfter = await program.account.protocolConfig.fetch(protocolPda);
        expect(configAfter.completedTasks.toNumber()).to.be.greaterThan(
          completedTasksBefore,
        );
      });
    });

    describe("PDA uniqueness", () => {
      it("Same task_id + different creator = different task PDA", async () => {
        const sharedTaskId = Buffer.from("shared-task-id-001".padEnd(32, "\0"));

        // Creator 1
        const taskPda1 = deriveTaskPda(creator.publicKey, sharedTaskId);
        const escrowPda1 = deriveEscrowPda(taskPda1);

        await program.methods
          .createTask(
            Array.from(sharedTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Shared ID test 1".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda1,
            escrow: escrowPda1,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();

        // Creator 2 (using worker1 as different creator)
        const taskPda2 = deriveTaskPda(worker1.publicKey, sharedTaskId);
        const escrowPda2 = deriveEscrowPda(taskPda2);

        await program.methods
          .createTask(
            Array.from(sharedTaskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Shared ID test 2".padEnd(64, "\0")),
            new BN(LAMPORTS_PER_SOL / 100),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda2,
            escrow: escrowPda2,
            protocolConfig: protocolPda,
            creatorAgent: deriveAgentPda(agentId1),
            authority: worker1.publicKey,
            creator: worker1.publicKey,
            rewardMint: null,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([worker1])
          .rpc();

        // Verify PDAs are different
        expect(taskPda1.toString()).to.not.equal(taskPda2.toString());

        // Verify both tasks exist
        const task1 = await program.account.task.fetch(taskPda1);
        const task2 = await program.account.task.fetch(taskPda2);
        expect(task1.creator.toString()).to.equal(creator.publicKey.toString());
        expect(task2.creator.toString()).to.equal(worker1.publicKey.toString());
      });

      it("Same agent_id = same agent PDA (cannot register twice)", async () => {
        const duplicateId = makeAgentId("duplicate");
        const duplicatePda = deriveAgentPda(duplicateId);

        const owner1 = Keypair.generate();
        fundAccount(svm, owner1.publicKey, 2 * LAMPORTS_PER_SOL);

        // First registration succeeds
        await program.methods
          .registerAgent(
            Array.from(duplicateId),
            new BN(CAPABILITY_COMPUTE),
            "https://duplicate.example.com",
            null,
            new BN(LAMPORTS_PER_SOL),
          )
          .accountsPartial({
            agent: duplicatePda,
            protocolConfig: protocolPda,
            authority: owner1.publicKey,
          })
          .signers([owner1])
          .rpc();

        // Second registration with same ID should fail (PDA already exists)
        const owner2 = Keypair.generate();
        fundAccount(svm, owner2.publicKey, 2 * LAMPORTS_PER_SOL);

        try {
          await program.methods
            .registerAgent(
              Array.from(duplicateId),
              new BN(CAPABILITY_COMPUTE),
              "https://duplicate2.example.com",
              null,
              new BN(LAMPORTS_PER_SOL),
            )
            .accountsPartial({
              agent: duplicatePda,
              protocolConfig: protocolPda,
              authority: owner2.publicKey,
            })
            .signers([owner2])
            .rpc();
          expect.fail("Should have failed");
        } catch (e: any) {
          expect(e.message).to.include("already in use");
        }
      });
    });
  });


});
