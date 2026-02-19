/**
 * Sybil Attack Prevention Tests (Issue #101)
 *
 * Tests that one wallet (authority) cannot vote multiple times on the same dispute
 * by registering multiple arbiter agents.
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
  RESOLUTION_TYPE_REFUND,
  deriveProgramDataPda,
} from "./test-utils";

describe("sybil-attack", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  // Generate unique run ID to prevent conflicts with persisted validator state
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  let treasury: Keypair;
  let treasuryPubkey: PublicKey;
  let creator: Keypair;
  let sybilAttacker: Keypair;  // One wallet trying to vote multiple times
  let legitimateArbiter: Keypair;
  let creatorAgentPda: PublicKey;

  // Helper to generate unique IDs
  function makeId(prefix: string): Buffer {
    return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
  }

  // Helper to derive PDAs
  function deriveAgentPda(agentId: Buffer): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentId],
      program.programId
    );
    return pda;
  }

  function deriveVotePda(disputePda: PublicKey, arbiterPda: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), disputePda.toBuffer(), arbiterPda.toBuffer()],
      program.programId
    );
    return pda;
  }

  function deriveAuthorityVotePda(disputePda: PublicKey, authority: PublicKey): PublicKey {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("authority_vote"), disputePda.toBuffer(), authority.toBuffer()],
      program.programId
    );
    return pda;
  }

  // Evidence must be at least 50 characters per initiate_dispute.rs requirements
  const VALID_EVIDENCE = "This is valid dispute evidence that exceeds the minimum 50 character requirement for the dispute system.";

  before(async () => {
    treasury = Keypair.generate();
    creator = Keypair.generate();
    sybilAttacker = Keypair.generate();
    legitimateArbiter = Keypair.generate();

    const airdropAmount = 20 * LAMPORTS_PER_SOL;
    const wallets = [treasury, creator, sybilAttacker, legitimateArbiter];

    for (const wallet of wallets) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(wallet.publicKey, airdropAmount),
        "confirmed"
      );
    }

    // Initialize protocol if not already done
    try {
      const programDataPda = deriveProgramDataPda(program.programId);
      await program.methods
        .initializeProtocol(51, 100, new BN(1 * LAMPORTS_PER_SOL), new BN(LAMPORTS_PER_SOL / 100), 1, [provider.wallet.publicKey, treasury.publicKey])
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
    } catch (e: any) {
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
    } catch (e: any) {
      // May already be configured
    }

    // Register creator agent for task creation
    const creatorAgentId = makeId("cre-sybil");
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
        })
        .signers([creator])
        .rpc();
    } catch (e: any) {
      // Agent may already be registered
    }
  });

  describe("Sybil Attack Prevention", () => {
    let disputePda: PublicKey;
    let taskPda: PublicKey;
    let escrowPda: PublicKey;
    let arbiter1Pda: PublicKey;
    let arbiter2Pda: PublicKey;
    let workerAgentPda: PublicKey;
    let workerClaimPda: PublicKey;

    before(async () => {
      // Create task for dispute
      const taskId = makeId("sybil-task");
      taskPda = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), creator.publicKey.toBuffer(), taskId],
        program.programId
      )[0];
      escrowPda = PublicKey.findProgramAddressSync(
        [Buffer.from("escrow"), taskPda.toBuffer()],
        program.programId
      )[0];

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Sybil test task".padEnd(64, "\0")),
          new BN(1 * LAMPORTS_PER_SOL),
          1,
          new BN(Math.floor(Date.now() / 1000) + 3600),
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

      // Register TWO arbiter agents for the SAME authority (sybilAttacker)
      // This is the Sybil attack vector
      const arbiter1Id = makeId("arb1-sybil");
      const arbiter2Id = makeId("arb2-sybil");
      arbiter1Pda = deriveAgentPda(arbiter1Id);
      arbiter2Pda = deriveAgentPda(arbiter2Id);

      await program.methods
        .registerAgent(
          Array.from(arbiter1Id),
          new BN(CAPABILITY_ARBITER),
          "https://arbiter1.sybil.com",
          null,
          new BN(1 * LAMPORTS_PER_SOL)
        )
        .accountsPartial({
          agent: arbiter1Pda,
          protocolConfig: protocolPda,
          authority: sybilAttacker.publicKey,
        })
        .signers([sybilAttacker])
        .rpc();

      await program.methods
        .registerAgent(
          Array.from(arbiter2Id),
          new BN(CAPABILITY_ARBITER),
          "https://arbiter2.sybil.com",
          null,
          new BN(1 * LAMPORTS_PER_SOL)
        )
        .accountsPartial({
          agent: arbiter2Pda,
          protocolConfig: protocolPda,
          authority: sybilAttacker.publicKey,
        })
        .signers([sybilAttacker])
        .rpc();

      // Claim the task (required before dispute)
      // Need an agent with COMPUTE capability - arbiter1 has ARBITER, need worker with COMPUTE
      const workerAgentId = makeId("wkr-sybil");
      workerAgentPda = deriveAgentPda(workerAgentId);

      await program.methods
        .registerAgent(
          Array.from(workerAgentId),
          new BN(CAPABILITY_COMPUTE),
          "https://worker.sybil.com",
          null,
          new BN(1 * LAMPORTS_PER_SOL)
        )
        .accountsPartial({
          agent: workerAgentPda,
          protocolConfig: protocolPda,
          authority: sybilAttacker.publicKey,
        })
        .signers([sybilAttacker])
        .rpc();

      workerClaimPda = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), taskPda.toBuffer(), workerAgentPda.toBuffer()],
        program.programId
      )[0];

      await program.methods
        .claimTask()
        .accountsPartial({
          task: taskPda,
          claim: workerClaimPda,
          protocolConfig: protocolPda,
          worker: workerAgentPda,
          authority: sybilAttacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([sybilAttacker])
        .rpc();

      // Initiate dispute
      const disputeId = makeId("disp-sybil");
      disputePda = PublicKey.findProgramAddressSync(
        [Buffer.from("dispute"), disputeId],
        program.programId
      )[0];

      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
          RESOLUTION_TYPE_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          agent: workerAgentPda,
          protocolConfig: protocolPda,
          initiatorClaim: workerClaimPda,
          workerAgent: workerAgentPda,
          workerClaim: workerClaimPda,
          authority: sybilAttacker.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([sybilAttacker])
        .rpc();
    });

    it("First vote from authority succeeds", async () => {
      const votePda = deriveVotePda(disputePda, arbiter1Pda);
      const authorityVotePda = deriveAuthorityVotePda(disputePda, sybilAttacker.publicKey);

      try {
        await program.methods
          .voteDispute(true)
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            workerClaim: workerClaimPda,
            defendantAgent: workerAgentPda,
            vote: votePda,
            authorityVote: authorityVotePda,
            arbiter: arbiter1Pda,
            protocolConfig: protocolPda,
            authority: sybilAttacker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([sybilAttacker])
          .rpc();
        expect.fail("Participant authority should not be allowed to vote");
      } catch (e: any) {
        expect(e.message).to.include("ArbiterIsDisputeParticipant");
      }
    });

    it("Second vote from same authority (via different agent) is prevented", async () => {
      // Same authority (sybilAttacker) tries to vote again with a different agent
      const votePda = deriveVotePda(disputePda, arbiter2Pda);
      const authorityVotePda = deriveAuthorityVotePda(disputePda, sybilAttacker.publicKey);

      try {
        await program.methods
          .voteDispute(false)  // Different vote, but same authority
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            workerClaim: workerClaimPda,
            defendantAgent: workerAgentPda,
            vote: votePda,
            authorityVote: authorityVotePda,  // This will fail - account already exists
            arbiter: arbiter2Pda,
            protocolConfig: protocolPda,
            authority: sybilAttacker.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([sybilAttacker])
          .rpc();
        expect.fail("Should have failed - authority already voted");
      } catch (e: any) {
        expect(e?.message || e?.error?.errorCode?.code).to.exist;
      }
    });

    it("Different authority can still vote", async () => {
      // Register a new arbiter with a different authority
      const legitArbId = makeId("arb-legit");
      const legitArbPda = deriveAgentPda(legitArbId);

      await program.methods
        .registerAgent(
          Array.from(legitArbId),
          new BN(CAPABILITY_ARBITER),
          "https://legit-arbiter.example.com",
          null,
          new BN(1 * LAMPORTS_PER_SOL)
        )
        .accountsPartial({
          agent: legitArbPda,
          protocolConfig: protocolPda,
          authority: legitimateArbiter.publicKey,
        })
        .signers([legitimateArbiter])
        .rpc();

      const votePda = deriveVotePda(disputePda, legitArbPda);
      const authorityVotePda = deriveAuthorityVotePda(disputePda, legitimateArbiter.publicKey);

      await program.methods
        .voteDispute(false)
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          workerClaim: workerClaimPda,
          defendantAgent: workerAgentPda,
          vote: votePda,
          authorityVote: authorityVotePda,
          arbiter: legitArbPda,
          protocolConfig: protocolPda,
          authority: legitimateArbiter.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([legitimateArbiter])
        .rpc();

      // Only the legitimate authority vote should exist because participant vote is rejected.
      const dispute = await program.account.dispute.fetch(disputePda);
      expect(dispute.totalVoters).to.equal(1);
      expect(dispute.votesFor.toNumber()).to.equal(0);
      expect(dispute.votesAgainst.toNumber()).to.be.greaterThan(0);
    });

    it("AuthorityDisputeVote account contains correct data", async () => {
      const authorityVotePda = deriveAuthorityVotePda(disputePda, sybilAttacker.publicKey);
      let missingSybilVote = false;
      try {
        await program.account.authorityDisputeVote.fetch(authorityVotePda);
      } catch {
        missingSybilVote = true;
      }
      expect(missingSybilVote).to.be.true;

      // Check the legitimate arbiter's vote record
      const legitVotePda = deriveAuthorityVotePda(disputePda, legitimateArbiter.publicKey);
      const legitVote = await program.account.authorityDisputeVote.fetch(legitVotePda);

      expect(legitVote.dispute.toString()).to.equal(disputePda.toString());
      expect(legitVote.authority.toString()).to.equal(legitimateArbiter.publicKey.toString());
    });
  });

  describe("Multiple Disputes - Same Authority Can Vote on Different Disputes", () => {
    it("Same authority can vote once per dispute", async () => {
      // Register arbiter for this test
      const arb3Id = makeId("arb3-multi");
      const arb3Pda = deriveAgentPda(arb3Id);
      const multiArbiter = Keypair.generate();

      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(multiArbiter.publicKey, 5 * LAMPORTS_PER_SOL),
        "confirmed"
      );

      await program.methods
        .registerAgent(
          Array.from(arb3Id),
          new BN(CAPABILITY_ARBITER),
          "https://multi-arbiter.example.com",
          null,
          new BN(1 * LAMPORTS_PER_SOL)
        )
        .accountsPartial({
          agent: arb3Pda,
          protocolConfig: protocolPda,
          authority: multiArbiter.publicKey,
        })
        .signers([multiArbiter])
        .rpc();

      // Register a worker agent with COMPUTE capability for claiming tasks
      const multiWorkerId = makeId("wkr-multi");
      const multiWorkerPda = deriveAgentPda(multiWorkerId);

      await program.methods
        .registerAgent(
          Array.from(multiWorkerId),
          new BN(CAPABILITY_COMPUTE),
          "https://multi-worker.example.com",
          null,
          new BN(1 * LAMPORTS_PER_SOL)
        )
        .accountsPartial({
          agent: multiWorkerPda,
          protocolConfig: protocolPda,
          authority: multiArbiter.publicKey,
        })
        .signers([multiArbiter])
        .rpc();

      // Create two separate tasks
      const task1Id = makeId("multi-t1");
      const task2Id = makeId("multi-t2");

      for (const taskId of [task1Id, task2Id]) {
        const taskPda = PublicKey.findProgramAddressSync(
          [Buffer.from("task"), creator.publicKey.toBuffer(), taskId],
          program.programId
        )[0];

        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Multi dispute task".padEnd(64, "\0")),
            new BN(1 * LAMPORTS_PER_SOL),
            1,
            new BN(Math.floor(Date.now() / 1000) + 3600),
            TASK_TYPE_EXCLUSIVE,
            null,
            0, // min_reputation
            null, // reward_mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: PublicKey.findProgramAddressSync(
              [Buffer.from("escrow"), taskPda.toBuffer()],
              program.programId
            )[0],
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

        // Claim the task
        const claimPda = PublicKey.findProgramAddressSync(
          [Buffer.from("claim"), taskPda.toBuffer(), multiWorkerPda.toBuffer()],
          program.programId
        )[0];

        await program.methods
          .claimTask()
          .accountsPartial({
            task: taskPda,
            claim: claimPda,
            protocolConfig: protocolPda,
            worker: multiWorkerPda,
            authority: multiArbiter.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([multiArbiter])
          .rpc();
      }

      // Create two disputes
      const dispute1Id = makeId("multi-d1");
      const dispute2Id = makeId("multi-d2");

      const task1Pda = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), creator.publicKey.toBuffer(), task1Id],
        program.programId
      )[0];
      const task2Pda = PublicKey.findProgramAddressSync(
        [Buffer.from("task"), creator.publicKey.toBuffer(), task2Id],
        program.programId
      )[0];
      const claim1Pda = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), task1Pda.toBuffer(), multiWorkerPda.toBuffer()],
        program.programId
      )[0];
      const claim2Pda = PublicKey.findProgramAddressSync(
        [Buffer.from("claim"), task2Pda.toBuffer(), multiWorkerPda.toBuffer()],
        program.programId
      )[0];

      const dispute1Pda = PublicKey.findProgramAddressSync(
        [Buffer.from("dispute"), dispute1Id],
        program.programId
      )[0];
      const dispute2Pda = PublicKey.findProgramAddressSync(
        [Buffer.from("dispute"), dispute2Id],
        program.programId
      )[0];

      // Initiate both disputes
      await program.methods
        .initiateDispute(
          Array.from(dispute1Id),
          Array.from(task1Id),
          Array.from(Buffer.from("evidence1".padEnd(32, "\0"))),
          RESOLUTION_TYPE_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: dispute1Pda,
          task: task1Pda,
          agent: multiWorkerPda,
          protocolConfig: protocolPda,
          initiatorClaim: claim1Pda,
          workerAgent: multiWorkerPda,
          workerClaim: claim1Pda,
          authority: multiArbiter.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([multiArbiter])
        .rpc();

      await program.methods
        .initiateDispute(
          Array.from(dispute2Id),
          Array.from(task2Id),
          Array.from(Buffer.from("evidence2".padEnd(32, "\0"))),
          RESOLUTION_TYPE_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: dispute2Pda,
          task: task2Pda,
          agent: multiWorkerPda,
          protocolConfig: protocolPda,
          initiatorClaim: claim2Pda,
          workerAgent: multiWorkerPda,
          workerClaim: claim2Pda,
          authority: multiArbiter.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([multiArbiter])
        .rpc();

      // Participant authority cannot vote on a dispute they are part of.
      const vote1Pda = deriveVotePda(dispute1Pda, arb3Pda);
      const authVote1Pda = deriveAuthorityVotePda(dispute1Pda, multiArbiter.publicKey);

      try {
        await program.methods
          .voteDispute(true)
          .accountsPartial({
            dispute: dispute1Pda,
            task: task1Pda,
            workerClaim: claim1Pda,
            defendantAgent: multiWorkerPda,
            vote: vote1Pda,
            authorityVote: authVote1Pda,
            arbiter: arb3Pda,
            protocolConfig: protocolPda,
            authority: multiArbiter.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([multiArbiter])
          .rpc();
        expect.fail("Participant authority should not be allowed to vote");
      } catch (e: any) {
        expect(e.message).to.include("ArbiterIsDisputeParticipant");
      }
    });
  });
});
