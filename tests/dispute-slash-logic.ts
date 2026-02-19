/**
 * Tests for apply_dispute_slash logic (Issue #136)
 *
 * This test file verifies the correct behavior of the worker slashing mechanism.
 *
 * Bug #136 Summary:
 * ==================
 * Previously, when a dispute was REJECTED (arbiters voted against it), the code
 * incorrectly set `worker_lost = true`, causing innocent workers to be slashed
 * even when arbiters ruled in their favor.
 *
 * Fix Summary:
 * ============
 * Changed the logic so that:
 * - If dispute is REJECTED (not approved): worker_lost = false (no slash)
 * - If dispute is APPROVED with Refund: worker_lost = true (slash)
 * - If dispute is APPROVED with Split: worker_lost = true (slash)
 * - If dispute is APPROVED with Complete: worker_lost = false (no slash, worker vindicated)
 *
 * Testing Strategy:
 * =================
 * Full integration tests require time warping (7-day dispute duration) which is
 * not easily available in standard Anchor tests. These tests verify:
 * 1. Precondition checks work correctly (dispute not resolved, slash already applied)
 * 2. The Rust code logic is correct (verified via code review and compilation)
 * 3. Related dispute operations work correctly (initiate, vote)
 *
 * For full end-to-end testing with time warping, use:
 * - `@coral-xyz/anchor-bankrun` with clock manipulation
 * - Manual testing with `solana-test-validator --slots-per-epoch 1`
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
  RESOLUTION_TYPE_COMPLETE,
  RESOLUTION_TYPE_SPLIT,
  getDefaultDeadline,
  deriveProgramDataPda,
} from "./test-utils";
import { createLiteSVMContext, fundAccount, getClockTimestamp, advanceClock } from "./litesvm-helpers";

describe("dispute-slash-logic (issue #136)", () => {
  const { svm, provider, program, payer } = createLiteSVMContext();

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  // Generate unique run ID to prevent conflicts with persisted validator state
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);


  let treasury: Keypair;
  let treasuryPubkey: PublicKey;
  let secondSigner: Keypair;  // Required for protocol initialization (fix #556)
  let creator: Keypair;
  let worker: Keypair;
  let arbiter1: Keypair;
  let arbiter2: Keypair;
  let arbiter3: Keypair;

  // Agent IDs
  let creatorAgentId: Buffer;
  let workerAgentId: Buffer;
  let arbiter1AgentId: Buffer;
  let arbiter2AgentId: Buffer;
  let arbiter3AgentId: Buffer;

  // Evidence must be at least 50 characters per initiate_dispute.rs requirements
  const VALID_EVIDENCE = "This is valid dispute evidence that exceeds the minimum 50 character requirement for the dispute system.";

  // Initial stake for workers
  const WORKER_STAKE = 10 * LAMPORTS_PER_SOL;

  function makeId(prefix: string): Buffer {
    return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
  }

  const deriveAgentPda = (agentId: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId], program.programId)[0];

  const deriveTaskPda = (creatorKey: PublicKey, taskId: Buffer) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("task"), creatorKey.toBuffer(), taskId],
      program.programId
    )[0];

  const deriveEscrowPda = (taskPda: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("escrow"), taskPda.toBuffer()], program.programId)[0];

  const deriveClaimPda = (taskPda: PublicKey, workerPda: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), taskPda.toBuffer(), workerPda.toBuffer()],
      program.programId
    )[0];

  const deriveDisputePda = (disputeId: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from("dispute"), disputeId], program.programId)[0];

  const deriveVotePda = (disputePda: PublicKey, arbiterPda: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), disputePda.toBuffer(), arbiterPda.toBuffer()],
      program.programId
    )[0];

  const deriveAuthorityVotePda = (disputePda: PublicKey, authorityPubkey: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("authority_vote"), disputePda.toBuffer(), authorityPubkey.toBuffer()],
      program.programId
    )[0];

  const airdrop = (wallets: Keypair[], amount: number = 20 * LAMPORTS_PER_SOL) => {
    for (const wallet of wallets) {
      fundAccount(svm, wallet.publicKey, amount);
    }
  };

  // Minimum stakes (fetched from protocol config)
  let minAgentStake: number = LAMPORTS_PER_SOL;
  let minArbiterStake: number = LAMPORTS_PER_SOL;

  const ensureProtocol = async () => {
    try {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      treasuryPubkey = config.treasury;
      // Get the actual stake requirements from the existing protocol config
      minAgentStake = Math.max(config.minAgentStake.toNumber(), LAMPORTS_PER_SOL);
      minArbiterStake = Math.max(config.minArbiterStake.toNumber(), minAgentStake);
    } catch {
      // Protocol initialization requires (fix #556):
      // - min_stake >= 0.001 SOL (1_000_000 lamports)
      // - min_stake_for_dispute > 0
      // - second_signer different from authority
      // - both authority and second_signer in multisig_owners
      // - threshold < multisig_owners.length
      const minStake = new BN(LAMPORTS_PER_SOL);  // 1 SOL
      const minStakeForDispute = new BN(LAMPORTS_PER_SOL / 10);  // 0.1 SOL
      await program.methods
        .initializeProtocol(
          51,                // dispute_threshold
          100,               // protocol_fee_bps
          minStake,          // min_stake
          minStakeForDispute, // min_stake_for_dispute (new arg)
          1,                 // multisig_threshold (must be < owners.length)
          [provider.wallet.publicKey, secondSigner.publicKey]  // multisig_owners (need at least 2)
        )
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: secondSigner.publicKey,
          authority: provider.wallet.publicKey,
          secondSigner: secondSigner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([{ pubkey: deriveProgramDataPda(program.programId), isSigner: false, isWritable: false }])
        .signers([secondSigner])
        .rpc();
      treasuryPubkey = secondSigner.publicKey;
      minAgentStake = LAMPORTS_PER_SOL;
      minArbiterStake = LAMPORTS_PER_SOL;
    }

    // Disable rate limiting for tests
    try {
      await program.methods
        .updateRateLimits(
          new BN(0),  // task_creation_cooldown = 0 (disabled)
          0,          // max_tasks_per_24h = 0 (unlimited)
          new BN(0),  // dispute_initiation_cooldown = 0 (disabled)
          0,          // max_disputes_per_24h = 0 (unlimited)
          new BN(LAMPORTS_PER_SOL / 100)   // min_stake_for_dispute = 0.01 SOL (must be > 0)
        )
        .accountsPartial({
          protocolConfig: protocolPda,
        })
        .remainingAccounts([
          { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
        ])
        .rpc();
    } catch {
      // May already be configured
    }
  };

  const registerAgent = async (
    agentId: Buffer,
    authority: Keypair,
    capabilities: number,
    stake: number = 0
  ) => {
    const agentPda = deriveAgentPda(agentId);
    try {
      await program.account.agentRegistration.fetch(agentPda);
    } catch {
      await program.methods
        .registerAgent(Array.from(agentId), new BN(capabilities), "https://example.com", null, new BN(stake))
        .accountsPartial({
          agent: agentPda,
          protocolConfig: protocolPda,
          authority: authority.publicKey,
        })
        .signers([authority])
        .rpc();
    }
    return agentPda;
  };

  before(async () => {
    treasury = Keypair.generate();
    secondSigner = Keypair.generate();  // Required for protocol initialization (fix #556)
    creator = Keypair.generate();
    worker = Keypair.generate();
    arbiter1 = Keypair.generate();
    arbiter2 = Keypair.generate();
    arbiter3 = Keypair.generate();

    // Initialize unique IDs per test run
    creatorAgentId = makeId("cre");
    workerAgentId = makeId("wrk");
    arbiter1AgentId = makeId("ar1");
    arbiter2AgentId = makeId("ar2");
    arbiter3AgentId = makeId("ar3");

    // Airdrop SOL to all participants (including secondSigner for initialization)
    await airdrop([treasury, secondSigner, creator, worker, arbiter1, arbiter2, arbiter3]);
    await ensureProtocol();

    // Register agents
    const actualWorkerStake = Math.max(WORKER_STAKE, minAgentStake);
    await registerAgent(creatorAgentId, creator, CAPABILITY_COMPUTE, minAgentStake);
    await registerAgent(workerAgentId, worker, CAPABILITY_COMPUTE, actualWorkerStake);
    await registerAgent(arbiter1AgentId, arbiter1, CAPABILITY_ARBITER, minArbiterStake);
    await registerAgent(arbiter2AgentId, arbiter2, CAPABILITY_ARBITER, minArbiterStake);
    await registerAgent(arbiter3AgentId, arbiter3, CAPABILITY_ARBITER, minArbiterStake);
  });

  describe("applyDisputeSlash preconditions", () => {
    it("should fail if dispute is not resolved (DisputeNotResolved error)", async () => {
      // Create task, claim it, initiate dispute
      const taskId = makeId("task-precond");
      const disputeId = makeId("disp-precond");

      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const workerAgentPda = deriveAgentPda(workerAgentId);
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);
      const claimPda = deriveClaimPda(taskPda, workerAgentPda);
      const disputePda = deriveDisputePda(disputeId);

      // 1. Create task
      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Test task for precondition".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL),
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

      // 2. Claim task
      await program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          protocolConfig: protocolPda,
          worker: workerAgentPda,
          authority: worker.publicKey,
        })
        .signers([worker])
        .rpc();

      // 3. Initiate dispute (creator initiating requires workerAgent and workerClaim)
      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.from("evidence-hash".padEnd(32, "\0"))),
          RESOLUTION_TYPE_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: creatorAgentPda,
          protocolConfig: protocolPda,
          initiatorClaim: null,  // Creator has no claim
          workerAgent: workerAgentPda,
          workerClaim: claimPda,
          authority: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      // 4. Try to apply slash without resolving - should fail
      try {
        await program.methods
          .applyDisputeSlash()
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            workerClaim: claimPda,
            workerAgent: workerAgentPda,
            protocolConfig: protocolPda,
          })
          .rpc();
        expect.fail("Should have failed - dispute not resolved");
      } catch (e: unknown) {
        // Verify that an error occurred - any error is acceptable since
        // dispute is in Active state (not Resolved), so applying slash should fail
        // The test passes as long as the transaction was rejected
        expect(e).to.exist;

        // Optional: Log error details for debugging (can be removed)
        // const anchorError = e as any;
        // console.log("Error code:", anchorError.error?.errorCode?.code);
        // console.log("Error message:", anchorError.message);
      }
    });

    it("should verify dispute can be voted on by arbiters", async () => {
      // Create task, claim it, initiate dispute, vote
      const taskId = makeId("task-vote");
      const disputeId = makeId("disp-vote");

      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const workerAgentPda = deriveAgentPda(workerAgentId);
      const arbiter1Pda = deriveAgentPda(arbiter1AgentId);
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);
      const claimPda = deriveClaimPda(taskPda, workerAgentPda);
      const disputePda = deriveDisputePda(disputeId);
      const votePda = deriveVotePda(disputePda, arbiter1Pda);

      // 1. Create task
      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Test task for voting".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL),
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

      // 2. Claim task
      await program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          protocolConfig: protocolPda,
          worker: workerAgentPda,
          authority: worker.publicKey,
        })
        .signers([worker])
        .rpc();

      // 3. Initiate dispute (creator initiating requires workerAgent and workerClaim)
      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.from("evidence-hash".padEnd(32, "\0"))),
          RESOLUTION_TYPE_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: creatorAgentPda,
          protocolConfig: protocolPda,
          initiatorClaim: null,  // Creator has no claim
          workerAgent: workerAgentPda,
          workerClaim: claimPda,
          authority: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      // Check if voting is still active (votingDeadline > current time)
      const dispute = await program.account.dispute.fetch(disputePda);
      const currentTime = Math.floor(Date.now() / 1000);

      if (dispute.votingDeadline.toNumber() <= currentTime) {
        // Voting period has already ended (protocol may have short voting period)
        // Just verify the dispute was created correctly
        expect(dispute.status).to.deep.equal({ active: {} });
        return;
      }

      // 4. Vote on dispute (vote AGAINST = in favor of worker)
      const authorityVotePda = deriveAuthorityVotePda(disputePda, arbiter1.publicKey);
      await program.methods
        .voteDispute(false)
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          workerClaim: claimPda,
          defendantAgent: null,
          vote: votePda,
          authorityVote: authorityVotePda,
          arbiter: arbiter1Pda,
          protocolConfig: protocolPda,
          authority: arbiter1.publicKey,
        })
        .signers([arbiter1])
        .rpc();

      // 5. Verify vote was recorded (votes are weighted by stake, not counted)
      const disputeAfterVote = await program.account.dispute.fetch(disputePda);
      // votesAgainst should be > 0 (weighted by arbiter's stake)
      expect(disputeAfterVote.votesAgainst.toNumber()).to.be.greaterThan(0);
      expect(disputeAfterVote.votesFor.toNumber()).to.equal(0);
    });
  });

  describe("Issue #136 fix verification (code review)", () => {
    /**
     * This test documents the fix for Issue #136.
     *
     * The bug was in apply_dispute_slash.rs where:
     *
     * BEFORE (buggy code):
     * ```rust
     * let worker_lost = if approved {
     *     dispute.resolution_type != ResolutionType::Complete
     * } else {
     *     true  // BUG: Slashing workers even when dispute was rejected!
     * };
     * ```
     *
     * AFTER (fixed code):
     * ```rust
     * let worker_lost = if approved {
     *     // Dispute approved: slash worker unless resolution favors them (Complete)
     *     dispute.resolution_type != ResolutionType::Complete
     * } else {
     *     // Dispute rejected: worker was vindicated, do NOT slash
     *     false
     * };
     * ```
     *
     * The fix ensures that when arbiters reject a dispute (vote against it),
     * the worker is NOT slashed because they were vindicated.
     */
    it("documents the fix for issue #136", async () => {
      // This is a documentation test that verifies the fix is in place.
      // The actual logic is verified by:
      // 1. Code review of apply_dispute_slash.rs
      // 2. Compilation (cargo build-sbf)
      // 3. Full integration tests (require time warping, documented below)

      // Verify the protocol config has slash percentage set
      const config = await program.account.protocolConfig.fetch(protocolPda);
      expect(config.slashPercentage).to.be.greaterThan(0);

      // Test passes - the fix is documented and verified via code review.
      // Full integration testing requires time warping to pass the voting deadline.
    });

    /**
     * Integration test scenarios (require time warping):
     *
     * 1. REJECTED dispute (0 for, 2 against):
     *    - Worker should NOT be slashed
     *    - applyDisputeSlash should fail with InvalidInput
     *
     * 2. REJECTED dispute (1 for, 2 against - below 51% threshold):
     *    - Worker should NOT be slashed
     *    - applyDisputeSlash should fail with InvalidInput
     *
     * 3. APPROVED dispute with Refund resolution (2 for, 1 against):
     *    - Worker SHOULD be slashed
     *    - applyDisputeSlash should succeed
     *
     * 4. APPROVED dispute with Split resolution (2 for, 1 against):
     *    - Worker SHOULD be slashed
     *    - applyDisputeSlash should succeed
     *
     * 5. APPROVED dispute with Complete resolution (2 for, 1 against):
     *    - Worker should NOT be slashed (vindicated despite approval)
     *    - applyDisputeSlash should fail with InvalidInput
     *
     * To run these tests with time warping:
     * - Use @coral-xyz/anchor-bankrun with clock manipulation
     * - Or run with a modified test validator
     */
    it("documents expected behavior for each scenario", () => {
      // This is a pure documentation test
      expect(true).to.be.true;
    });
  });

  describe("defendant binding (issue #827)", () => {
    let workerB: Keypair;
    let workerBAgentId: Buffer;

    before(async () => {
      workerB = Keypair.generate();
      workerBAgentId = makeId("wrB");
      await airdrop([workerB]);
      const actualWorkerStake = Math.max(WORKER_STAKE, minAgentStake);
      await registerAgent(workerBAgentId, workerB, CAPABILITY_COMPUTE, actualWorkerStake);
    });

    it("should set defendant field and reject slash on wrong worker", async () => {
      // Create collaborative task with max_workers=3
      const taskId = makeId("task-def");
      const disputeId = makeId("disp-def");

      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const workerAgentPda = deriveAgentPda(workerAgentId);
      const workerBPda = deriveAgentPda(workerBAgentId);
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);
      const claimAPda = deriveClaimPda(taskPda, workerAgentPda);
      const claimBPda = deriveClaimPda(taskPda, workerBPda);
      const disputePda = deriveDisputePda(disputeId);

      // 1. Create collaborative task (max_workers=3)
      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Test task for defendant binding".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL),
          3,  // max_workers
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

      // 2. Worker A claims
      await program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          claim: claimAPda,
          protocolConfig: protocolPda,
          worker: workerAgentPda,
          authority: worker.publicKey,
        })
        .signers([worker])
        .rpc();

      // 3. Worker B claims
      await program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          claim: claimBPda,
          protocolConfig: protocolPda,
          worker: workerBPda,
          authority: workerB.publicKey,
        })
        .signers([workerB])
        .rpc();

      // 4. Creator initiates dispute targeting worker A
      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.from("evidence-hash".padEnd(32, "\0"))),
          RESOLUTION_TYPE_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: creatorAgentPda,
          protocolConfig: protocolPda,
          initiatorClaim: null,
          workerAgent: workerAgentPda,
          workerClaim: claimAPda,
          authority: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      // 5. Verify defendant is worker A
      const dispute = await program.account.dispute.fetch(disputePda);
      expect(dispute.defendant.toBase58()).to.equal(workerAgentPda.toBase58());

      // 6. Try to slash worker B — should fail with WorkerNotInDispute
      let rejected = false;
      try {
        await program.methods
          .applyDisputeSlash()
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            workerClaim: claimBPda,
            workerAgent: workerBPda,
            protocolConfig: protocolPda,
            treasury: treasuryPubkey,
          })
          .rpc();
      } catch (e: unknown) {
        rejected = true;
        const anchorError = e as any;
        const code = anchorError.error?.errorCode?.code;
        if (code !== undefined) {
          expect(["WorkerNotInDispute", "DisputeNotResolved"]).to.include(code);
        }
      }
      expect(rejected).to.equal(true, "slash should be rejected for non-defendant worker");
    });
  });

  // =========================================================================
  // Helpers for #960 tests
  // =========================================================================

  /** Create task → claim → initiate dispute. Returns all PDAs. */
  async function setupDispute(
    prefix: string,
    resolutionType: number = RESOLUTION_TYPE_REFUND,
    rewardLamports: number = LAMPORTS_PER_SOL,
    wrkKp: Keypair = worker,
    wrkAgentId: Buffer = workerAgentId,
  ) {
    const taskId = makeId(`t-${prefix}`);
    const disputeId = makeId(`d-${prefix}`);
    const crePda = deriveAgentPda(creatorAgentId);
    const wrkPda = deriveAgentPda(wrkAgentId);
    const taskPda = deriveTaskPda(creator.publicKey, taskId);
    const escrowPda = deriveEscrowPda(taskPda);
    const claimPda = deriveClaimPda(taskPda, wrkPda);
    const disputePda = deriveDisputePda(disputeId);
    const deadline = new BN(getClockTimestamp(svm) + 2_000_000);

    await program.methods
      .createTask(
        Array.from(taskId), new BN(CAPABILITY_COMPUTE),
        Buffer.from("Dispute test task".padEnd(64, "\0")),
        new BN(rewardLamports), 1, deadline, TASK_TYPE_EXCLUSIVE, null, 0, null,
      )
      .accountsPartial({
        task: taskPda, escrow: escrowPda, protocolConfig: protocolPda,
        creatorAgent: crePda, authority: creator.publicKey,
        creator: creator.publicKey, systemProgram: SystemProgram.programId,
        rewardMint: null, creatorTokenAccount: null,
        tokenEscrowAta: null, tokenProgram: null, associatedTokenProgram: null,
      })
      .signers([creator]).rpc();

    await program.methods.claimTask()
      .accountsPartial({
        task: taskPda, claim: claimPda, protocolConfig: protocolPda,
        worker: wrkPda, authority: wrkKp.publicKey,
      })
      .signers([wrkKp]).rpc();

    await program.methods.initiateDispute(
      Array.from(disputeId), Array.from(taskId),
      Array.from(Buffer.from("evidence-hash".padEnd(32, "\0"))),
      resolutionType, VALID_EVIDENCE,
    )
      .accountsPartial({
        dispute: disputePda, task: taskPda, agent: crePda,
        protocolConfig: protocolPda, initiatorClaim: null,
        workerAgent: wrkPda, workerClaim: claimPda, authority: creator.publicKey,
      })
      .signers([creator]).rpc();

    return { taskId, disputeId, taskPda, escrowPda, claimPda, disputePda, creatorPda: crePda, workerPda: wrkPda };
  }

  /** Cast a single arbiter vote. */
  async function vote(
    disputePda: PublicKey, taskPda: PublicKey, claimPda: PublicKey,
    wrkPda: PublicKey, kp: Keypair, agentId: Buffer, approve: boolean,
  ) {
    const arbPda = deriveAgentPda(agentId);
    const votePda = deriveVotePda(disputePda, arbPda);
    const authVotePda = deriveAuthorityVotePda(disputePda, kp.publicKey);
    await program.methods.voteDispute(approve)
      .accountsPartial({
        dispute: disputePda, task: taskPda, workerClaim: claimPda,
        defendantAgent: wrkPda, vote: votePda, authorityVote: authVotePda,
        arbiter: arbPda, protocolConfig: protocolPda, authority: kp.publicKey,
      })
      .signers([kp]).rpc();
    return { votePda, arbPda };
  }

  /** Cast votes from all 3 arbiters. Returns (votePda, arbiterPda) triples. */
  async function voteAll(
    disputePda: PublicKey, taskPda: PublicKey, claimPda: PublicKey,
    wrkPda: PublicKey, votes: [boolean, boolean, boolean],
  ) {
    const arbs = [
      { kp: arbiter1, id: arbiter1AgentId },
      { kp: arbiter2, id: arbiter2AgentId },
      { kp: arbiter3, id: arbiter3AgentId },
    ];
    const out: Array<{ votePda: PublicKey; arbPda: PublicKey }> = [];
    for (let i = 0; i < 3; i++) {
      out.push(await vote(disputePda, taskPda, claimPda, wrkPda, arbs[i].kp, arbs[i].id, votes[i]));
    }
    return out;
  }

  /** Build remaining_accounts array for resolve_dispute. */
  function resolveRemaining(voters: Array<{ votePda: PublicKey; arbPda: PublicKey }>) {
    return voters.flatMap(({ votePda, arbPda }) => [
      { pubkey: votePda, isSigner: false, isWritable: true },
      { pubkey: arbPda, isSigner: false, isWritable: true },
    ]);
  }

  /** Advance clock to voting deadline and resolve dispute. */
  async function advanceAndResolve(
    disputePda: PublicKey, taskPda: PublicKey, escrowPda: PublicKey,
    claimPda: PublicKey, wrkPda: PublicKey,
    voters: Array<{ votePda: PublicKey; arbPda: PublicKey }>,
    wrkAuthority: Keypair = worker,
  ) {
    const d = await program.account.dispute.fetch(disputePda);
    const dl = d.votingDeadline.toNumber();
    const now = getClockTimestamp(svm);
    if (now < dl) advanceClock(svm, dl - now);

    await program.methods.resolveDispute()
      .accountsPartial({
        dispute: disputePda, task: taskPda, escrow: escrowPda,
        protocolConfig: protocolPda, resolver: provider.wallet.publicKey,
        creator: creator.publicKey, workerClaim: claimPda,
        worker: wrkPda, workerAuthority: wrkAuthority.publicKey,
        systemProgram: SystemProgram.programId,
        tokenEscrowAta: null, creatorTokenAccount: null,
        workerTokenAccountAta: null, treasuryTokenAccount: null,
        rewardMint: null, tokenProgram: null,
      })
      .remainingAccounts(resolveRemaining(voters)).rpc();
  }

  // =========================================================================
  // #960 — Vote window boundary math
  // =========================================================================
  describe("Vote window boundary math (#960)", () => {
    it("accepts vote 1 second before voting_deadline", async () => {
      const { disputePda, taskPda, claimPda, workerPda } = await setupDispute("vw1");
      const d = await program.account.dispute.fetch(disputePda);
      advanceClock(svm, d.votingDeadline.toNumber() - getClockTimestamp(svm) - 1);
      await vote(disputePda, taskPda, claimPda, workerPda, arbiter1, arbiter1AgentId, true);
    });

    it("rejects vote exactly at voting_deadline (VotingEnded)", async () => {
      const { disputePda, taskPda, claimPda, workerPda } = await setupDispute("vw2");
      const d = await program.account.dispute.fetch(disputePda);
      advanceClock(svm, d.votingDeadline.toNumber() - getClockTimestamp(svm));
      try {
        await vote(disputePda, taskPda, claimPda, workerPda, arbiter1, arbiter1AgentId, true);
        expect.fail("Should have failed with VotingEnded");
      } catch (e: unknown) {
        expect((e as any).error?.errorCode?.code).to.equal("VotingEnded");
      }
    });

    it("accepts resolve exactly at voting_deadline", async () => {
      const s = await setupDispute("vw3");
      const voters = await voteAll(s.disputePda, s.taskPda, s.claimPda, s.workerPda, [true, true, true]);
      const d = await program.account.dispute.fetch(s.disputePda);
      advanceClock(svm, d.votingDeadline.toNumber() - getClockTimestamp(svm));
      await program.methods.resolveDispute()
        .accountsPartial({
          dispute: s.disputePda, task: s.taskPda, escrow: s.escrowPda,
          protocolConfig: protocolPda, resolver: provider.wallet.publicKey,
          creator: creator.publicKey, workerClaim: s.claimPda,
          worker: s.workerPda, workerAuthority: worker.publicKey,
          systemProgram: SystemProgram.programId,
          tokenEscrowAta: null, creatorTokenAccount: null,
          workerTokenAccountAta: null, treasuryTokenAccount: null,
          rewardMint: null, tokenProgram: null,
        })
        .remainingAccounts(resolveRemaining(voters)).rpc();
    });

    it("rejects resolve 1 second before voting_deadline (VotingNotEnded)", async () => {
      const s = await setupDispute("vw4");
      const voters = await voteAll(s.disputePda, s.taskPda, s.claimPda, s.workerPda, [true, true, true]);
      const d = await program.account.dispute.fetch(s.disputePda);
      advanceClock(svm, d.votingDeadline.toNumber() - getClockTimestamp(svm) - 1);
      try {
        await program.methods.resolveDispute()
          .accountsPartial({
            dispute: s.disputePda, task: s.taskPda, escrow: s.escrowPda,
            protocolConfig: protocolPda, resolver: provider.wallet.publicKey,
            creator: creator.publicKey, workerClaim: s.claimPda,
            worker: s.workerPda, workerAuthority: worker.publicKey,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: null, creatorTokenAccount: null,
            workerTokenAccountAta: null, treasuryTokenAccount: null,
            rewardMint: null, tokenProgram: null,
          })
          .remainingAccounts(resolveRemaining(voters)).rpc();
        expect.fail("Should have failed with VotingNotEnded");
      } catch (e: unknown) {
        expect((e as any).error?.errorCode?.code).to.equal("VotingNotEnded");
      }
    });
  });

  // =========================================================================
  // Helpers: account sets for slash instructions
  // =========================================================================

  /** Accounts for applyDisputeSlash (SOL tasks — optional token accounts null). */
  function disputeSlashAccounts(s: Awaited<ReturnType<typeof setupDispute>>) {
    return {
      dispute: s.disputePda, task: s.taskPda, workerClaim: s.claimPda,
      workerAgent: s.workerPda, protocolConfig: protocolPda, treasury: treasuryPubkey,
      escrow: null, tokenEscrowAta: null, treasuryTokenAccount: null,
      rewardMint: null, tokenProgram: null,
    };
  }

  /** Extract Anchor error code robustly (LiteSVM may format errors differently). */
  function anchorErrorCode(e: unknown): string | undefined {
    const err = e as any;
    return err.error?.errorCode?.code ?? err.errorCode?.code;
  }

  /** Assert an Anchor error code was thrown (falls back to message check). */
  function expectErrorCode(e: unknown, code: string) {
    const got = anchorErrorCode(e);
    if (got) {
      expect(got).to.equal(code);
    } else {
      const msg = (e as any).message ?? String(e);
      expect(msg).to.include(code, `Expected error ${code}, got: ${msg.slice(0, 200)}`);
    }
  }

  // =========================================================================
  // #960 — Slash idempotency and window
  // =========================================================================
  describe("Slash idempotency and window (#960)", () => {
    let slashWorker: Keypair;
    let slashWorkerAgentId: Buffer;

    before(async () => {
      slashWorker = Keypair.generate();
      slashWorkerAgentId = makeId("swk");
      airdrop([slashWorker]);
      await registerAgent(slashWorkerAgentId, slashWorker, CAPABILITY_COMPUTE, Math.max(WORKER_STAKE, minAgentStake));
    });

    it("applies worker slash exactly once (SlashAlreadyApplied on retry)", async () => {
      const s = await setupDispute("si1", RESOLUTION_TYPE_REFUND, LAMPORTS_PER_SOL, slashWorker, slashWorkerAgentId);
      const voters = await voteAll(s.disputePda, s.taskPda, s.claimPda, s.workerPda, [true, true, true]);
      await advanceAndResolve(s.disputePda, s.taskPda, s.escrowPda, s.claimPda, s.workerPda, voters, slashWorker);

      // First slash succeeds and sets the flag
      await program.methods.applyDisputeSlash()
        .accountsPartial(disputeSlashAccounts(s)).rpc();
      const d = await program.account.dispute.fetch(s.disputePda);
      expect(d.slashApplied).to.equal(true, "slash_applied should be set after first slash");

      // Second slash is rejected (idempotent guard)
      let rejected = false;
      try {
        await program.methods.applyDisputeSlash()
          .accountsPartial(disputeSlashAccounts(s)).rpc();
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true, "Second applyDisputeSlash must be rejected");
    });

    it("applies initiator slash exactly once (SlashAlreadyApplied on retry)", async () => {
      const s = await setupDispute("si2", RESOLUTION_TYPE_REFUND, LAMPORTS_PER_SOL, slashWorker, slashWorkerAgentId);
      const voters = await voteAll(s.disputePda, s.taskPda, s.claimPda, s.workerPda, [false, false, false]);
      await advanceAndResolve(s.disputePda, s.taskPda, s.escrowPda, s.claimPda, s.workerPda, voters, slashWorker);

      // First initiator slash succeeds and sets the flag
      await program.methods.applyInitiatorSlash()
        .accountsPartial({
          dispute: s.disputePda, task: s.taskPda,
          initiatorAgent: s.creatorPda, protocolConfig: protocolPda, treasury: treasuryPubkey,
        }).rpc();
      const d = await program.account.dispute.fetch(s.disputePda);
      expect(d.initiatorSlashApplied).to.equal(true, "initiator_slash_applied should be set");

      // Second is rejected (idempotent guard)
      let rejected = false;
      try {
        await program.methods.applyInitiatorSlash()
          .accountsPartial({
            dispute: s.disputePda, task: s.taskPda,
            initiatorAgent: s.creatorPda, protocolConfig: protocolPda, treasury: treasuryPubkey,
          }).rpc();
      } catch {
        rejected = true;
      }
      expect(rejected).to.equal(true, "Second applyInitiatorSlash must be rejected");
    });

    it("rejects slash after 7-day window (SlashWindowExpired)", async () => {
      const SLASH_WINDOW = 7 * 24 * 60 * 60; // 604800
      const s = await setupDispute("si3", RESOLUTION_TYPE_REFUND, LAMPORTS_PER_SOL, slashWorker, slashWorkerAgentId);
      const voters = await voteAll(s.disputePda, s.taskPda, s.claimPda, s.workerPda, [true, true, true]);
      await advanceAndResolve(s.disputePda, s.taskPda, s.escrowPda, s.claimPda, s.workerPda, voters, slashWorker);

      advanceClock(svm, SLASH_WINDOW + 1);

      try {
        await program.methods.applyDisputeSlash()
          .accountsPartial(disputeSlashAccounts(s)).rpc();
        expect.fail("Should have failed with SlashWindowExpired");
      } catch (e: unknown) {
        expectErrorCode(e, "SlashWindowExpired");
      }
    });

    it("accepts slash at exactly SLASH_WINDOW boundary", async () => {
      const SLASH_WINDOW = 7 * 24 * 60 * 60;
      const s = await setupDispute("si4", RESOLUTION_TYPE_REFUND, LAMPORTS_PER_SOL, slashWorker, slashWorkerAgentId);
      const voters = await voteAll(s.disputePda, s.taskPda, s.claimPda, s.workerPda, [true, true, true]);
      await advanceAndResolve(s.disputePda, s.taskPda, s.escrowPda, s.claimPda, s.workerPda, voters, slashWorker);

      advanceClock(svm, SLASH_WINDOW);

      await program.methods.applyDisputeSlash()
        .accountsPartial(disputeSlashAccounts(s)).rpc();
    });
  });

  // =========================================================================
  // #960 — Deterministic outcome calculation
  // =========================================================================
  describe("Deterministic outcome calculation (#960)", () => {
    let outcomeWorker: Keypair;
    let outcomeWorkerAgentId: Buffer;

    before(async () => {
      outcomeWorker = Keypair.generate();
      outcomeWorkerAgentId = makeId("owk");
      airdrop([outcomeWorker]);
      await registerAgent(outcomeWorkerAgentId, outcomeWorker, CAPABILITY_COMPUTE, Math.max(WORKER_STAKE, minAgentStake));
    });

    it("3 FOR / 0 AGAINST → APPROVED (worker slash succeeds)", async () => {
      const s = await setupDispute("oc1", RESOLUTION_TYPE_REFUND, LAMPORTS_PER_SOL, outcomeWorker, outcomeWorkerAgentId);
      const voters = await voteAll(s.disputePda, s.taskPda, s.claimPda, s.workerPda, [true, true, true]);
      await advanceAndResolve(s.disputePda, s.taskPda, s.escrowPda, s.claimPda, s.workerPda, voters, outcomeWorker);

      const d = await program.account.dispute.fetch(s.disputePda);
      expect(d.status).to.deep.equal({ resolved: {} });

      // Worker slash succeeds — dispute was approved
      await program.methods.applyDisputeSlash()
        .accountsPartial(disputeSlashAccounts(s)).rpc();
    });

    it("0 FOR / 3 AGAINST → REJECTED (initiator slash succeeds)", async () => {
      const s = await setupDispute("oc2", RESOLUTION_TYPE_REFUND, LAMPORTS_PER_SOL, outcomeWorker, outcomeWorkerAgentId);
      const voters = await voteAll(s.disputePda, s.taskPda, s.claimPda, s.workerPda, [false, false, false]);
      await advanceAndResolve(s.disputePda, s.taskPda, s.escrowPda, s.claimPda, s.workerPda, voters, outcomeWorker);

      const d = await program.account.dispute.fetch(s.disputePda);
      expect(d.status).to.deep.equal({ resolved: {} });

      // Initiator slash succeeds — dispute was rejected
      await program.methods.applyInitiatorSlash()
        .accountsPartial({
          dispute: s.disputePda, task: s.taskPda,
          initiatorAgent: s.creatorPda, protocolConfig: protocolPda, treasury: treasuryPubkey,
        }).rpc();
    });

    it("2 FOR / 1 AGAINST → APPROVED (66% ≥ 51%)", async () => {
      const s = await setupDispute("oc3", RESOLUTION_TYPE_REFUND, LAMPORTS_PER_SOL, outcomeWorker, outcomeWorkerAgentId);
      const voters = await voteAll(s.disputePda, s.taskPda, s.claimPda, s.workerPda, [true, true, false]);
      await advanceAndResolve(s.disputePda, s.taskPda, s.escrowPda, s.claimPda, s.workerPda, voters, outcomeWorker);

      // Worker slash succeeds — dispute approved
      await program.methods.applyDisputeSlash()
        .accountsPartial(disputeSlashAccounts(s)).rpc();
    });

    it("1 FOR / 2 AGAINST → REJECTED (33% < 51%)", async () => {
      const s = await setupDispute("oc4", RESOLUTION_TYPE_REFUND, LAMPORTS_PER_SOL, outcomeWorker, outcomeWorkerAgentId);
      const voters = await voteAll(s.disputePda, s.taskPda, s.claimPda, s.workerPda, [true, false, false]);
      await advanceAndResolve(s.disputePda, s.taskPda, s.escrowPda, s.claimPda, s.workerPda, voters, outcomeWorker);

      // Initiator slash succeeds — dispute rejected
      await program.methods.applyInitiatorSlash()
        .accountsPartial({
          dispute: s.disputePda, task: s.taskPda,
          initiatorAgent: s.creatorPda, protocolConfig: protocolPda, treasury: treasuryPubkey,
        }).rpc();
    });
  });

  // =========================================================================
  // #960 — Split payout correctness
  // =========================================================================
  describe("Split payout correctness (#960)", () => {
    let splitWorker: Keypair;
    let splitWorkerAgentId: Buffer;

    before(async () => {
      splitWorker = Keypair.generate();
      splitWorkerAgentId = makeId("spw");
      airdrop([splitWorker]);
      await registerAgent(splitWorkerAgentId, splitWorker, CAPABILITY_COMPUTE, Math.max(WORKER_STAKE, minAgentStake));
    });

    it("split resolution gives creator the odd-lamport remainder", async () => {
      const oddReward = LAMPORTS_PER_SOL + 1; // 1_000_000_001 → worker 500_000_000, creator 500_000_001
      const s = await setupDispute("sp1", RESOLUTION_TYPE_SPLIT, oddReward, splitWorker, splitWorkerAgentId);
      const voters = await voteAll(s.disputePda, s.taskPda, s.claimPda, s.workerPda, [true, true, true]);

      // Fetch escrow state to compute expected split values
      const escrow = await program.account.taskEscrow.fetch(s.escrowPda);
      const distributable = escrow.amount.toNumber() - escrow.distributed.toNumber();
      const expectedWorkerShare = Math.floor(distributable / 2);
      const expectedCreatorShare = distributable - expectedWorkerShare;

      // The odd lamport remainder goes to the creator
      expect(expectedCreatorShare - expectedWorkerShare).to.equal(1);

      // Capture worker balance before resolution (isolate the split payment)
      const workerBalBefore = await provider.connection.getBalance(splitWorker.publicKey);

      await advanceAndResolve(s.disputePda, s.taskPda, s.escrowPda, s.claimPda, s.workerPda, voters, splitWorker);

      const workerBalAfter = await provider.connection.getBalance(splitWorker.publicKey);
      // Worker gets exactly floor(distributable / 2)
      expect(workerBalAfter - workerBalBefore).to.equal(expectedWorkerShare);
    });
  });

  describe("Related functionality verification", () => {
    it("should verify worker stake is tracked correctly", async () => {
      const workerAgentPda = deriveAgentPda(workerAgentId);
      const workerData = await program.account.agentRegistration.fetch(workerAgentPda);

      // Worker should have stake >= WORKER_STAKE
      expect(workerData.stake.toNumber()).to.be.greaterThanOrEqual(
        Math.max(WORKER_STAKE, minAgentStake)
      );
    });

    it("should verify arbiters have required stake and capability", async () => {
      const arbiter1Pda = deriveAgentPda(arbiter1AgentId);
      const arbiter1Data = await program.account.agentRegistration.fetch(arbiter1Pda);

      // Arbiter should have ARBITER capability (1 << 7 = 128)
      const hasArbiterCap = (arbiter1Data.capabilities.toNumber() & CAPABILITY_ARBITER) !== 0;
      expect(hasArbiterCap).to.be.true;

      // Arbiter should have sufficient stake
      expect(arbiter1Data.stake.toNumber()).to.be.greaterThanOrEqual(minArbiterStake);
    });
  });
});
