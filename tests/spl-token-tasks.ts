/**
 * SPL Token Task Integration Tests (Issue #860)
 *
 * Tests the optional SPL token escrow support added in PR #864.
 * Verifies token-denominated task creation, completion, cancellation,
 * and dispute initiation across all supported task types.
 *
 * Test Strategy:
 * - Happy path: create, claim, complete, cancel with SPL tokens
 * - Edge cases: SOL regression, missing accounts, insufficient balance,
 *   competitive/collaborative token tasks, minimum amounts, 0-decimal mints
 * - Fee verification: protocol fees in tokens, not SOL
 * - Dispute preconditions: initiate + vote on token tasks (resolution
 *   requires time warp, so only preconditions are tested)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  CAPABILITY_COMPUTE,
  CAPABILITY_ARBITER,
  TASK_TYPE_EXCLUSIVE,
  TASK_TYPE_COLLABORATIVE,
  TASK_TYPE_COMPETITIVE,
  RESOLUTION_TYPE_REFUND,
  getDefaultDeadline,
  deriveProgramDataPda,
} from "./test-utils";
import { createLiteSVMContext, fundAccount, advanceClock } from "./litesvm-helpers";

describe("spl-token-tasks (issue #860)", () => {
  const { svm, provider, program, payer: payerKp } = createLiteSVMContext({ splTokens: true });

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  const runId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Wallets
  let treasury: Keypair;
  let treasuryPubkey: PublicKey;
  let secondSigner: Keypair;
  let creator: Keypair;
  let worker: Keypair;
  let worker2: Keypair;
  let arbiter1: Keypair;
  let arbiter2: Keypair;
  let arbiter3: Keypair;

  // Agent IDs
  let creatorAgentId: Buffer;
  let workerAgentId: Buffer;
  let worker2AgentId: Buffer;
  let arbiter1AgentId: Buffer;
  let arbiter2AgentId: Buffer;
  let arbiter3AgentId: Buffer;

  // Token state
  let mint: PublicKey;
  let creatorAta: PublicKey;
  let workerAta: PublicKey;
  let worker2Ata: PublicKey;
  let treasuryAta: PublicKey;

  // 0-decimal mint for edge case
  let zeroDecMint: PublicKey;
  let zeroDecCreatorAta: PublicKey;
  let zeroDecWorkerAta: PublicKey;
  let zeroDecTreasuryAta: PublicKey;

  // Protocol fee: 100 bps = 1%
  const PROTOCOL_FEE_BPS = 100;

  const VALID_EVIDENCE =
    "This is valid dispute evidence that exceeds the minimum 50 character requirement for the dispute system.";

  let minAgentStake: number = LAMPORTS_PER_SOL;
  let minArbiterStake: number = LAMPORTS_PER_SOL;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function makeId(prefix: string): Buffer {
    return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
  }

  const deriveAgentPda = (agentId: Buffer) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentId],
      program.programId
    )[0];

  const deriveTaskPda = (creatorKey: PublicKey, taskId: Buffer) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("task"), creatorKey.toBuffer(), taskId],
      program.programId
    )[0];

  const deriveEscrowPda = (taskPda: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), taskPda.toBuffer()],
      program.programId
    )[0];

  const deriveClaimPda = (taskPda: PublicKey, workerPda: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), taskPda.toBuffer(), workerPda.toBuffer()],
      program.programId
    )[0];

  const deriveDisputePda = (disputeId: Buffer) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("dispute"), disputeId],
      program.programId
    )[0];

  const deriveVotePda = (disputePda: PublicKey, arbiterPda: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), disputePda.toBuffer(), arbiterPda.toBuffer()],
      program.programId
    )[0];

  const deriveAuthorityVotePda = (
    disputePda: PublicKey,
    authorityPubkey: PublicKey
  ) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("authority_vote"),
        disputePda.toBuffer(),
        authorityPubkey.toBuffer(),
      ],
      program.programId
    )[0];

  /** Derive escrow's ATA for the given mint (allowOwnerOffCurve for PDA) */
  const deriveEscrowAta = (tokenMint: PublicKey, escrowPda: PublicKey) =>
    getAssociatedTokenAddressSync(tokenMint, escrowPda, true);

  /** Fetch token balance as bigint */
  async function getTokenBalance(ata: PublicKey): Promise<bigint> {
    const acct = await getAccount(provider.connection, ata);
    return acct.amount;
  }

  const airdrop = (
    wallets: Keypair[],
    amount: number = 20 * LAMPORTS_PER_SOL
  ) => {
    for (const wallet of wallets) {
      fundAccount(svm, wallet.publicKey, amount);
    }
  };

  const payer = (): Keypair => payerKp;

  const ensureProtocol = async () => {
    try {
      const config =
        await program.account.protocolConfig.fetch(protocolPda);
      treasuryPubkey = config.treasury;
      minAgentStake = Math.max(
        config.minAgentStake.toNumber(),
        LAMPORTS_PER_SOL
      );
      minArbiterStake = Math.max(
        config.minArbiterStake.toNumber(),
        minAgentStake
      );
    } catch {
      const minStake = new BN(LAMPORTS_PER_SOL);
      const minStakeForDispute = new BN(LAMPORTS_PER_SOL / 10);
      await program.methods
        .initializeProtocol(
          51,
          PROTOCOL_FEE_BPS,
          minStake,
          minStakeForDispute,
          1,
          [provider.wallet.publicKey, secondSigner.publicKey]
        )
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: provider.wallet.publicKey,
          secondSigner: secondSigner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: deriveProgramDataPda(program.programId),
            isSigner: false,
            isWritable: false,
          },
        ])
        .signers([secondSigner])
        .rpc();
      treasuryPubkey = treasury.publicKey;
      minAgentStake = LAMPORTS_PER_SOL;
      minArbiterStake = LAMPORTS_PER_SOL;
    }

    // Disable rate limiting for tests
    try {
      await program.methods
        .updateRateLimits(
          new BN(0),
          0,
          new BN(0),
          0,
          new BN(LAMPORTS_PER_SOL / 100)
        )
        .accountsPartial({ protocolConfig: protocolPda })
        .remainingAccounts([
          {
            pubkey: provider.wallet.publicKey,
            isSigner: true,
            isWritable: false,
          },
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
        .registerAgent(
          Array.from(agentId),
          new BN(capabilities),
          "https://example.com",
          null,
          new BN(stake)
        )
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

  /** Create a token-denominated task, returning all relevant PDAs */
  async function createTokenTask(opts: {
    taskId: Buffer;
    tokenMint: PublicKey;
    creatorKp: Keypair;
    creatorAgentPda: PublicKey;
    creatorTokenAccount: PublicKey;
    rewardAmount: number;
    maxWorkers?: number;
    taskType?: number;
    constraintHash?: number[] | null;
  }) {
    const taskPda = deriveTaskPda(opts.creatorKp.publicKey, opts.taskId);
    const escrowPda = deriveEscrowPda(taskPda);
    const escrowAta = deriveEscrowAta(opts.tokenMint, escrowPda);

    await program.methods
      .createTask(
        Array.from(opts.taskId),
        new BN(CAPABILITY_COMPUTE),
        Buffer.from("Token task description".padEnd(64, "\0")),
        new BN(opts.rewardAmount),
        opts.maxWorkers ?? 1,
        getDefaultDeadline(),
        opts.taskType ?? TASK_TYPE_EXCLUSIVE,
        opts.constraintHash ?? null,
        0,
        opts.tokenMint
      )
      .accountsPartial({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        creatorAgent: opts.creatorAgentPda,
        authority: opts.creatorKp.publicKey,
        creator: opts.creatorKp.publicKey,
        systemProgram: SystemProgram.programId,
        rewardMint: opts.tokenMint,
        creatorTokenAccount: opts.creatorTokenAccount,
        tokenEscrowAta: escrowAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([opts.creatorKp])
      .rpc();

    return { taskPda, escrowPda, escrowAta };
  }

  /** Claim a task (no token accounts needed) */
  async function claimTask(
    taskPda: PublicKey,
    workerAgentPda: PublicKey,
    workerKp: Keypair
  ) {
    const claimPda = deriveClaimPda(taskPda, workerAgentPda);
    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda,
        protocolConfig: protocolPda,
        worker: workerAgentPda,
        authority: workerKp.publicKey,
      })
      .signers([workerKp])
      .rpc();
    return claimPda;
  }

  /** Complete a token-denominated task */
  async function completeTokenTask(opts: {
    taskPda: PublicKey;
    claimPda: PublicKey;
    escrowPda: PublicKey;
    escrowAta: PublicKey;
    workerAgentPda: PublicKey;
    workerKp: Keypair;
    workerTokenAccount: PublicKey;
    tokenMint: PublicKey;
    treasuryTokenAccount: PublicKey;
  }) {
    await program.methods
      .completeTask(
        Array.from(Buffer.from("proof-hash".padEnd(32, "\0"))),
        Buffer.from("result-data".padEnd(64, "\0"))
      )
      .accountsPartial({
        task: opts.taskPda,
        claim: opts.claimPda,
        escrow: opts.escrowPda,
        creator: creator.publicKey,
        worker: opts.workerAgentPda,
        protocolConfig: protocolPda,
        treasury: treasuryPubkey,
        authority: opts.workerKp.publicKey,
        systemProgram: SystemProgram.programId,
        tokenEscrowAta: opts.escrowAta,
        workerTokenAccount: opts.workerTokenAccount,
        treasuryTokenAccount: opts.treasuryTokenAccount,
        rewardMint: opts.tokenMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([opts.workerKp])
      .rpc();
  }

  // ---------------------------------------------------------------------------
  // Setup
  // ---------------------------------------------------------------------------

  before(async () => {
    treasury = Keypair.generate();
    secondSigner = Keypair.generate();
    creator = Keypair.generate();
    worker = Keypair.generate();
    worker2 = Keypair.generate();
    arbiter1 = Keypair.generate();
    arbiter2 = Keypair.generate();
    arbiter3 = Keypair.generate();

    creatorAgentId = makeId("cre");
    workerAgentId = makeId("wrk");
    worker2AgentId = makeId("wr2");
    arbiter1AgentId = makeId("ar1");
    arbiter2AgentId = makeId("ar2");
    arbiter3AgentId = makeId("ar3");

    // Airdrop SOL
    await airdrop([
      treasury,
      secondSigner,
      creator,
      worker,
      worker2,
      arbiter1,
      arbiter2,
      arbiter3,
    ]);

    await ensureProtocol();

    // Register agents
    await registerAgent(creatorAgentId, creator, CAPABILITY_COMPUTE, minAgentStake);
    await registerAgent(workerAgentId, worker, CAPABILITY_COMPUTE, minAgentStake);
    await registerAgent(worker2AgentId, worker2, CAPABILITY_COMPUTE, minAgentStake);
    await registerAgent(arbiter1AgentId, arbiter1, CAPABILITY_ARBITER, minArbiterStake);
    await registerAgent(arbiter2AgentId, arbiter2, CAPABILITY_ARBITER, minArbiterStake);
    await registerAgent(arbiter3AgentId, arbiter3, CAPABILITY_ARBITER, minArbiterStake);

    // Create 9-decimal test mint
    mint = await createMint(
      provider.connection,
      payer(),
      payer().publicKey,
      null,
      9
    );

    // Create ATAs
    creatorAta = await createAssociatedTokenAccount(
      provider.connection,
      payer(),
      mint,
      creator.publicKey
    );
    workerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer(),
      mint,
      worker.publicKey
    );
    worker2Ata = await createAssociatedTokenAccount(
      provider.connection,
      payer(),
      mint,
      worker2.publicKey
    );
    treasuryAta = await createAssociatedTokenAccount(
      provider.connection,
      payer(),
      mint,
      treasuryPubkey
    );

    // Mint 100 tokens (100 * 10^9) to creator
    await mintTo(
      provider.connection,
      payer(),
      mint,
      creatorAta,
      payer(),
      100_000_000_000n
    );

    // Create 0-decimal mint + ATAs for edge case
    zeroDecMint = await createMint(
      provider.connection,
      payer(),
      payer().publicKey,
      null,
      0
    );
    zeroDecCreatorAta = await createAssociatedTokenAccount(
      provider.connection,
      payer(),
      zeroDecMint,
      creator.publicKey
    );
    zeroDecWorkerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer(),
      zeroDecMint,
      worker.publicKey
    );
    zeroDecTreasuryAta = await createAssociatedTokenAccount(
      provider.connection,
      payer(),
      zeroDecMint,
      treasuryPubkey
    );

    // Mint 1000 whole tokens to creator (0-decimal)
    await mintTo(
      provider.connection,
      payer(),
      zeroDecMint,
      zeroDecCreatorAta,
      payer(),
      1000n
    );
  });

  // ---------------------------------------------------------------------------
  // Happy Path
  // ---------------------------------------------------------------------------

  describe("happy path", () => {
    it("should create a token-denominated task with escrow funded", async () => {
      const taskId = makeId("t-create");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const rewardAmount = 1_000_000_000; // 1 token

      const creatorBefore = await getTokenBalance(creatorAta);

      const { taskPda, escrowAta } = await createTokenTask({
        taskId,
        tokenMint: mint,
        creatorKp: creator,
        creatorAgentPda,
        creatorTokenAccount: creatorAta,
        rewardAmount,
      });

      // Verify task has reward_mint set
      const task = await program.account.task.fetch(taskPda);
      expect(task.rewardMint).to.not.be.null;
      expect(task.rewardMint!.toBase58()).to.equal(mint.toBase58());

      // Verify escrow ATA funded
      const escrowBalance = await getTokenBalance(escrowAta);
      expect(Number(escrowBalance)).to.equal(rewardAmount);

      // Verify creator debited
      const creatorAfter = await getTokenBalance(creatorAta);
      expect(Number(creatorBefore - creatorAfter)).to.equal(rewardAmount);
    });

    it("should claim a token task (no token accounts needed)", async () => {
      const taskId = makeId("t-claim");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const workerAgentPda = deriveAgentPda(workerAgentId);

      const { taskPda } = await createTokenTask({
        taskId,
        tokenMint: mint,
        creatorKp: creator,
        creatorAgentPda,
        creatorTokenAccount: creatorAta,
        rewardAmount: 500_000_000,
      });

      const claimPda = await claimTask(taskPda, workerAgentPda, worker);
      const claim = await program.account.taskClaim.fetch(claimPda);
      expect(claim.task.toBase58()).to.equal(taskPda.toBase58());
    });

    it("should complete a token task with correct fee distribution", async () => {
      const taskId = makeId("t-compl");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const workerAgentPda = deriveAgentPda(workerAgentId);
      const rewardAmount = 10_000_000_000; // 10 tokens

      const { taskPda, escrowPda, escrowAta } = await createTokenTask({
        taskId,
        tokenMint: mint,
        creatorKp: creator,
        creatorAgentPda,
        creatorTokenAccount: creatorAta,
        rewardAmount,
      });

      const claimPda = await claimTask(taskPda, workerAgentPda, worker);

      const workerBefore = await getTokenBalance(workerAta);
      const treasuryBefore = await getTokenBalance(treasuryAta);

      await completeTokenTask({
        taskPda,
        claimPda,
        escrowPda,
        escrowAta,
        workerAgentPda,
        workerKp: worker,
        workerTokenAccount: workerAta,
        tokenMint: mint,
        treasuryTokenAccount: treasuryAta,
      });

      const workerAfter = await getTokenBalance(workerAta);
      const treasuryAfter = await getTokenBalance(treasuryAta);

      // Fee: floor(10_000_000_000 * 100 / 10000) = 100_000_000 (0.1 token)
      const expectedFee = Math.floor(
        (rewardAmount * PROTOCOL_FEE_BPS) / 10000
      );
      const expectedWorkerReward = rewardAmount - expectedFee;

      expect(Number(workerAfter - workerBefore)).to.equal(
        expectedWorkerReward
      );
      expect(Number(treasuryAfter - treasuryBefore)).to.equal(expectedFee);
    });

    it("should cancel an unclaimed token task with full refund", async () => {
      const taskId = makeId("t-cancel");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const rewardAmount = 2_000_000_000; // 2 tokens

      const { taskPda, escrowPda, escrowAta } = await createTokenTask({
        taskId,
        tokenMint: mint,
        creatorKp: creator,
        creatorAgentPda,
        creatorTokenAccount: creatorAta,
        rewardAmount,
      });

      const creatorBefore = await getTokenBalance(creatorAta);

      await program.methods
        .cancelTask()
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          creator: creator.publicKey,
          protocolConfig: protocolPda,
          systemProgram: SystemProgram.programId,
          tokenEscrowAta: escrowAta,
          creatorTokenAccount: creatorAta,
          rewardMint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([creator])
        .rpc();

      const creatorAfter = await getTokenBalance(creatorAta);
      expect(Number(creatorAfter - creatorBefore)).to.equal(rewardAmount);

      // Verify task is cancelled
      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ cancelled: {} });
    });

    it("should create a dependent token task", async () => {
      const parentTaskId = makeId("t-par");
      const childTaskId = makeId("t-child");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);

      // Create parent task (SOL to keep it simple)
      const parentTaskPda = deriveTaskPda(creator.publicKey, parentTaskId);
      const parentEscrowPda = deriveEscrowPda(parentTaskPda);

      await program.methods
        .createTask(
          Array.from(parentTaskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Parent task".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 10),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null,
          0,
          null
        )
        .accountsPartial({
          task: parentTaskPda,
          escrow: parentEscrowPda,
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

      // Create dependent token task
      const childTaskPda = deriveTaskPda(creator.publicKey, childTaskId);
      const childEscrowPda = deriveEscrowPda(childTaskPda);
      const childEscrowAta = deriveEscrowAta(mint, childEscrowPda);
      const rewardAmount = 500_000_000;

      await program.methods
        .createDependentTask(
          Array.from(childTaskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Dependent token task".padEnd(64, "\0")),
          new BN(rewardAmount),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null,
          1, // DependencyType::Data
          0,
          mint
        )
        .accountsPartial({
          task: childTaskPda,
          escrow: childEscrowPda,
          parentTask: parentTaskPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
          rewardMint: mint,
          creatorTokenAccount: creatorAta,
          tokenEscrowAta: childEscrowAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([creator])
        .rpc();

      // Verify child task has reward_mint set
      const childTask = await program.account.task.fetch(childTaskPda);
      expect(childTask.rewardMint).to.not.be.null;
      expect(childTask.rewardMint!.toBase58()).to.equal(mint.toBase58());

      // Verify escrow funded
      const escrowBalance = await getTokenBalance(childEscrowAta);
      expect(Number(escrowBalance)).to.equal(rewardAmount);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge Cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    it("should create SOL task with reward_mint: null (regression)", async () => {
      const taskId = makeId("t-sol");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("SOL task regression".padEnd(64, "\0")),
          new BN(LAMPORTS_PER_SOL / 10),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null,
          0,
          null // No reward_mint = SOL path
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

      const task = await program.account.task.fetch(taskPda);
      expect(task.rewardMint).to.be.null;
      expect(task.rewardAmount.toNumber()).to.equal(LAMPORTS_PER_SOL / 10);
    });

    it("should fail with MissingTokenAccounts when token accounts omitted", async () => {
      const taskId = makeId("t-miss");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);

      try {
        // Pass reward_mint arg + account, but null out the other token accounts
        // Anchor sets null optional accounts to the program ID (= not provided)
        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Missing token accounts".padEnd(64, "\0")),
            new BN(1_000_000_000),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0,
            mint // reward_mint specified
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: creatorAgentPda,
            authority: creator.publicKey,
            creator: creator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: mint,
            creatorTokenAccount: null,
            tokenEscrowAta: null,
            tokenProgram: null,
            associatedTokenProgram: null,
          })
          .signers([creator])
          .rpc();
        expect.fail("Should have failed with MissingTokenAccounts");
      } catch (e: unknown) {
        const err = e as any;
        expect(err.error?.errorCode?.code).to.equal("MissingTokenAccounts");
      }
    });

    it("should fail when creator has insufficient token balance", async () => {
      // Create a new keypair with an empty ATA
      const poorCreator = Keypair.generate();
      const poorAgentId = makeId("poor");
      await airdrop([poorCreator]);
      await registerAgent(poorAgentId, poorCreator, CAPABILITY_COMPUTE, minAgentStake);

      const poorAta = await createAssociatedTokenAccount(
        provider.connection,
        payer(),
        mint,
        poorCreator.publicKey
      );
      // Do NOT mint any tokens to poorAta

      const taskId = makeId("t-insuf");
      const poorAgentPda = deriveAgentPda(poorAgentId);
      const taskPda = deriveTaskPda(poorCreator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);
      const escrowAta = deriveEscrowAta(mint, escrowPda);

      try {
        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Buffer.from("Insufficient balance task".padEnd(64, "\0")),
            new BN(1_000_000_000),
            1,
            getDefaultDeadline(),
            TASK_TYPE_EXCLUSIVE,
            null,
            0,
            mint
          )
          .accountsPartial({
            task: taskPda,
            escrow: escrowPda,
            protocolConfig: protocolPda,
            creatorAgent: poorAgentPda,
            authority: poorCreator.publicKey,
            creator: poorCreator.publicKey,
            systemProgram: SystemProgram.programId,
            rewardMint: mint,
            creatorTokenAccount: poorAta,
            tokenEscrowAta: escrowAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          })
          .signers([poorCreator])
          .rpc();
        expect.fail("Should have failed with insufficient balance");
      } catch (e: unknown) {
        // SPL token transfer fails — the exact error depends on the runtime
        expect(e).to.exist;
      }
    });

    it("should handle competitive token task (first completer gets tokens)", async () => {
      const taskId = makeId("t-comp");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const workerAgentPda = deriveAgentPda(workerAgentId);
      const worker2AgentPda = deriveAgentPda(worker2AgentId);
      const rewardAmount = 5_000_000_000;

      const { taskPda, escrowPda, escrowAta } = await createTokenTask({
        taskId,
        tokenMint: mint,
        creatorKp: creator,
        creatorAgentPda,
        creatorTokenAccount: creatorAta,
        rewardAmount,
        maxWorkers: 2,
        taskType: TASK_TYPE_COMPETITIVE,
      });

      // Both workers claim
      const claimPda1 = await claimTask(taskPda, workerAgentPda, worker);
      const claimPda2 = await claimTask(taskPda, worker2AgentPda, worker2);

      // First worker completes
      const workerBefore = await getTokenBalance(workerAta);

      await completeTokenTask({
        taskPda,
        claimPda: claimPda1,
        escrowPda,
        escrowAta,
        workerAgentPda,
        workerKp: worker,
        workerTokenAccount: workerAta,
        tokenMint: mint,
        treasuryTokenAccount: treasuryAta,
      });

      const workerAfter = await getTokenBalance(workerAta);
      const expectedFee = Math.floor(
        (rewardAmount * PROTOCOL_FEE_BPS) / 10000
      );
      expect(Number(workerAfter - workerBefore)).to.equal(
        rewardAmount - expectedFee
      );

      // Verify task is completed — second worker cannot complete
      const task = await program.account.task.fetch(taskPda);
      expect(task.status).to.deep.equal({ completed: {} });

      // Second worker tries to complete — should fail.
      // For token tasks, the escrow ATA is closed after first completion,
      // so the second attempt fails at account deserialization rather than
      // reaching the CompetitiveTaskAlreadyWon check.
      try {
        await completeTokenTask({
          taskPda,
          claimPda: claimPda2,
          escrowPda,
          escrowAta,
          workerAgentPda: worker2AgentPda,
          workerKp: worker2,
          workerTokenAccount: worker2Ata,
          tokenMint: mint,
          treasuryTokenAccount: treasuryAta,
        });
        expect.fail("Second completion should have failed");
      } catch (e: unknown) {
        // Expected: AccountNotInitialized (escrow ATA closed) or
        // CompetitiveTaskAlreadyWon (if escrow ATA not yet closed)
        expect(e).to.be.an("error");
      }
    });

    it("should handle collaborative token task (multiple workers get tokens)", async () => {
      const taskId = makeId("t-collab");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const workerAgentPda = deriveAgentPda(workerAgentId);
      const worker2AgentPda = deriveAgentPda(worker2AgentId);
      const rewardAmount = 10_000_000_000; // 10 tokens total

      const { taskPda, escrowPda, escrowAta } = await createTokenTask({
        taskId,
        tokenMint: mint,
        creatorKp: creator,
        creatorAgentPda,
        creatorTokenAccount: creatorAta,
        rewardAmount,
        maxWorkers: 2,
        taskType: TASK_TYPE_COLLABORATIVE,
      });

      // Both workers claim
      const claimPda1 = await claimTask(taskPda, workerAgentPda, worker);
      const claimPda2 = await claimTask(taskPda, worker2AgentPda, worker2);

      // Worker 1 completes
      const worker1Before = await getTokenBalance(workerAta);
      await completeTokenTask({
        taskPda,
        claimPda: claimPda1,
        escrowPda,
        escrowAta,
        workerAgentPda,
        workerKp: worker,
        workerTokenAccount: workerAta,
        tokenMint: mint,
        treasuryTokenAccount: treasuryAta,
      });
      const worker1After = await getTokenBalance(workerAta);

      // Worker 2 completes
      const worker2Before = await getTokenBalance(worker2Ata);
      await completeTokenTask({
        taskPda,
        claimPda: claimPda2,
        escrowPda,
        escrowAta,
        workerAgentPda: worker2AgentPda,
        workerKp: worker2,
        workerTokenAccount: worker2Ata,
        tokenMint: mint,
        treasuryTokenAccount: treasuryAta,
      });
      const worker2After = await getTokenBalance(worker2Ata);

      // Each worker gets reward / maxWorkers, minus fee
      const perWorker = Math.floor(rewardAmount / 2);
      const feePerWorker = Math.floor(
        (perWorker * PROTOCOL_FEE_BPS) / 10000
      );
      const expectedPerWorker = perWorker - feePerWorker;

      expect(Number(worker1After - worker1Before)).to.equal(
        expectedPerWorker
      );
      expect(Number(worker2After - worker2Before)).to.equal(
        expectedPerWorker
      );
    });

    it("should handle minimum reward amount (1 unit, fee rounds to 0)", async () => {
      const taskId = makeId("t-min");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const workerAgentPda = deriveAgentPda(workerAgentId);
      const rewardAmount = 1; // 1 smallest unit

      const { taskPda, escrowPda, escrowAta } = await createTokenTask({
        taskId,
        tokenMint: mint,
        creatorKp: creator,
        creatorAgentPda,
        creatorTokenAccount: creatorAta,
        rewardAmount,
      });

      const claimPda = await claimTask(taskPda, workerAgentPda, worker);

      const workerBefore = await getTokenBalance(workerAta);
      const treasuryBefore = await getTokenBalance(treasuryAta);

      // fee = floor(1 * 100 / 10000) = 0, worker gets 1
      // But the program enforces worker_reward > 0, and with fee=0, worker gets 1
      await completeTokenTask({
        taskPda,
        claimPda,
        escrowPda,
        escrowAta,
        workerAgentPda,
        workerKp: worker,
        workerTokenAccount: workerAta,
        tokenMint: mint,
        treasuryTokenAccount: treasuryAta,
      });

      const workerAfter = await getTokenBalance(workerAta);
      const treasuryAfter = await getTokenBalance(treasuryAta);

      expect(Number(workerAfter - workerBefore)).to.equal(1);
      expect(Number(treasuryAfter - treasuryBefore)).to.equal(0);
    });

    it("should work with 0-decimal mint", async () => {
      const taskId = makeId("t-0dec");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const workerAgentPda = deriveAgentPda(workerAgentId);
      const rewardAmount = 100; // 100 whole tokens

      const taskPda = deriveTaskPda(creator.publicKey, taskId);
      const escrowPda = deriveEscrowPda(taskPda);
      const escrowAta = deriveEscrowAta(zeroDecMint, escrowPda);

      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("Zero decimal task".padEnd(64, "\0")),
          new BN(rewardAmount),
          1,
          getDefaultDeadline(),
          TASK_TYPE_EXCLUSIVE,
          null,
          0,
          zeroDecMint
        )
        .accountsPartial({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: creatorAgentPda,
          authority: creator.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
          rewardMint: zeroDecMint,
          creatorTokenAccount: zeroDecCreatorAta,
          tokenEscrowAta: escrowAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .signers([creator])
        .rpc();

      const claimPda = await claimTask(taskPda, workerAgentPda, worker);

      const workerBefore = await getTokenBalance(zeroDecWorkerAta);

      await program.methods
        .completeTask(
          Array.from(Buffer.from("proof-hash-0dec".padEnd(32, "\0"))),
          Buffer.from("result-0dec".padEnd(64, "\0"))
        )
        .accountsPartial({
          task: taskPda,
          claim: claimPda,
          escrow: escrowPda,
          creator: creator.publicKey,
          worker: workerAgentPda,
          protocolConfig: protocolPda,
          treasury: treasuryPubkey,
          authority: worker.publicKey,
          systemProgram: SystemProgram.programId,
          tokenEscrowAta: escrowAta,
          workerTokenAccount: zeroDecWorkerAta,
          treasuryTokenAccount: zeroDecTreasuryAta,
          rewardMint: zeroDecMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([worker])
        .rpc();

      const workerAfter = await getTokenBalance(zeroDecWorkerAta);

      // fee = floor(100 * 100 / 10000) = 1 token
      const expectedFee = Math.floor(
        (rewardAmount * PROTOCOL_FEE_BPS) / 10000
      );
      expect(Number(workerAfter - workerBefore)).to.equal(
        rewardAmount - expectedFee
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Fee Verification
  // ---------------------------------------------------------------------------

  describe("fee verification", () => {
    it("should collect protocol fees in tokens, not SOL", async () => {
      const taskId = makeId("t-fee");
      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const workerAgentPda = deriveAgentPda(workerAgentId);
      const rewardAmount = 20_000_000_000; // 20 tokens

      const { taskPda, escrowPda, escrowAta } = await createTokenTask({
        taskId,
        tokenMint: mint,
        creatorKp: creator,
        creatorAgentPda,
        creatorTokenAccount: creatorAta,
        rewardAmount,
      });

      const claimPda = await claimTask(taskPda, workerAgentPda, worker);

      // Record SOL balances before completion
      const workerSolBefore = await provider.connection.getBalance(
        worker.publicKey
      );
      const treasurySolBefore =
        await provider.connection.getBalance(treasuryPubkey);

      // Record token balances
      const treasuryTokenBefore = await getTokenBalance(treasuryAta);

      await completeTokenTask({
        taskPda,
        claimPda,
        escrowPda,
        escrowAta,
        workerAgentPda,
        workerKp: worker,
        workerTokenAccount: workerAta,
        tokenMint: mint,
        treasuryTokenAccount: treasuryAta,
      });

      const treasuryTokenAfter = await getTokenBalance(treasuryAta);
      const treasurySolAfter =
        await provider.connection.getBalance(treasuryPubkey);

      // Token fee should be collected
      const expectedFee = Math.floor(
        (rewardAmount * PROTOCOL_FEE_BPS) / 10000
      );
      expect(Number(treasuryTokenAfter - treasuryTokenBefore)).to.equal(
        expectedFee
      );

      // Treasury SOL balance should be unchanged (no SOL fees)
      expect(treasurySolAfter).to.equal(treasurySolBefore);

      // Worker SOL change should be small — no reward in SOL.
      // Worker pays tx fee but may receive rent back from closed accounts
      // (claim PDA and escrow PDA), so net change could be slightly positive.
      const workerSolAfter = await provider.connection.getBalance(
        worker.publicKey
      );
      const solDiff = Math.abs(workerSolBefore - workerSolAfter);
      // The SOL change should be well under 1 SOL (just tx fees + rent refunds)
      expect(solDiff).to.be.lessThan(LAMPORTS_PER_SOL / 10);
    });
  });

  // ---------------------------------------------------------------------------
  // Dispute Preconditions (token tasks)
  // ---------------------------------------------------------------------------

  describe("dispute preconditions (token tasks)", () => {
    let disputeTaskId: Buffer;
    let disputeTaskPda: PublicKey;
    let disputeEscrowPda: PublicKey;
    let disputeEscrowAta: PublicKey;
    let disputeClaimPda: PublicKey;
    let workerAgentPda: PublicKey;
    let creatorAgentPda: PublicKey;
    // Shared dispute: created in test 1, voted in test 2, resolve-rejected in test 3
    let sharedDisputeId: Buffer;
    let sharedDisputePda: PublicKey;

    before(async () => {
      disputeTaskId = makeId("t-disp");
      creatorAgentPda = deriveAgentPda(creatorAgentId);
      workerAgentPda = deriveAgentPda(workerAgentId);

      const result = await createTokenTask({
        taskId: disputeTaskId,
        tokenMint: mint,
        creatorKp: creator,
        creatorAgentPda,
        creatorTokenAccount: creatorAta,
        rewardAmount: 5_000_000_000,
      });

      disputeTaskPda = result.taskPda;
      disputeEscrowPda = result.escrowPda;
      disputeEscrowAta = result.escrowAta;

      disputeClaimPda = await claimTask(
        disputeTaskPda,
        workerAgentPda,
        worker
      );

      sharedDisputeId = makeId("d-tok");
      sharedDisputePda = deriveDisputePda(sharedDisputeId);
    });

    it("should initiate a dispute on a token task", async () => {
      await program.methods
        .initiateDispute(
          Array.from(sharedDisputeId),
          Array.from(disputeTaskId),
          Array.from(Buffer.from("evidence-hash".padEnd(32, "\0"))),
          RESOLUTION_TYPE_REFUND,
          VALID_EVIDENCE
        )
        .accountsPartial({
          dispute: sharedDisputePda,
          task: disputeTaskPda,
          agent: creatorAgentPda,
          protocolConfig: protocolPda,
          initiatorClaim: null,
          workerAgent: workerAgentPda,
          workerClaim: disputeClaimPda,
          authority: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      const dispute = await program.account.dispute.fetch(sharedDisputePda);
      expect(dispute.status).to.deep.equal({ active: {} });
      expect(dispute.task.toBase58()).to.equal(disputeTaskPda.toBase58());
    });

    it("should vote on a dispute for a token task", async () => {
      const arbiter1Pda = deriveAgentPda(arbiter1AgentId);
      const votePda = deriveVotePda(sharedDisputePda, arbiter1Pda);
      const authorityVotePda = deriveAuthorityVotePda(
        sharedDisputePda,
        arbiter1.publicKey
      );

      // Check if voting period has already ended
      const dispute = await program.account.dispute.fetch(sharedDisputePda);
      const currentTime = Math.floor(Date.now() / 1000);
      if (dispute.votingDeadline.toNumber() <= currentTime) {
        // Voting already ended — skip but verify dispute state is valid
        expect(dispute.status).to.deep.equal({ active: {} });
        return;
      }

      await program.methods
        .voteDispute(true)
        .accountsPartial({
          dispute: sharedDisputePda,
          task: disputeTaskPda,
          workerClaim: disputeClaimPda,
          defendantAgent: workerAgentPda,
          vote: votePda,
          authorityVote: authorityVotePda,
          arbiter: arbiter1Pda,
          protocolConfig: protocolPda,
          authority: arbiter1.publicKey,
        })
        .signers([arbiter1])
        .rpc();

      const disputeAfter = await program.account.dispute.fetch(
        sharedDisputePda
      );
      expect(disputeAfter.votesFor.toNumber()).to.be.greaterThan(0);
    });

    it("should reject resolve before voting period ends (VotingNotEnded)", async () => {
      // Check if voting period has already ended
      const dispute = await program.account.dispute.fetch(sharedDisputePda);
      const currentTime = Math.floor(Date.now() / 1000);
      if (dispute.votingDeadline.toNumber() <= currentTime) {
        // Voting already ended — can't test VotingNotEnded, skip
        return;
      }

      // Use protocol authority as resolver (initiator can't resolve)
      try {
        await program.methods
          .resolveDispute()
          .accountsPartial({
            dispute: sharedDisputePda,
            task: disputeTaskPda,
            escrow: disputeEscrowPda,
            creator: creator.publicKey,
            protocolConfig: protocolPda,
            resolver: provider.wallet.publicKey,
            workerClaim: null,
            worker: null,
            workerAuthority: null,
            systemProgram: SystemProgram.programId,
            tokenEscrowAta: disputeEscrowAta,
            creatorTokenAccount: creatorAta,
            workerTokenAccountAta: null,
            treasuryTokenAccount: treasuryAta,
            rewardMint: mint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
        expect.fail("Should have failed with VotingNotEnded");
      } catch (e: unknown) {
        const err = e as any;
        expect(err.error?.errorCode?.code).to.equal("VotingNotEnded");
      }
    });
  });

  describe("token dispute resolution + slash", () => {
    it("should reserve token slash at resolve and settle it in applyDisputeSlash", async () => {
      const taskId = makeId("t-slash");
      const disputeId = makeId("d-slash");
      const rewardAmount = 4_000_000_000;

      const creatorAgentPda = deriveAgentPda(creatorAgentId);
      const workerAgentPda = deriveAgentPda(workerAgentId);
      const arbiter1Pda = deriveAgentPda(arbiter1AgentId);
      const arbiter2Pda = deriveAgentPda(arbiter2AgentId);
      const arbiter3Pda = deriveAgentPda(arbiter3AgentId);

      const { taskPda, escrowPda, escrowAta } = await createTokenTask({
        taskId,
        tokenMint: mint,
        creatorKp: creator,
        creatorAgentPda,
        creatorTokenAccount: creatorAta,
        rewardAmount,
      });
      const claimPda = await claimTask(taskPda, workerAgentPda, worker);

      const disputePda = deriveDisputePda(disputeId);
      await program.methods
        .initiateDispute(
          Array.from(disputeId),
          Array.from(taskId),
          Array.from(Buffer.from("slash-evidence-hash".padEnd(32, "\0"))),
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
          workerClaim: claimPda,
          authority: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      const initiatedDispute = await program.account.dispute.fetch(disputePda);
      const votingDeadline = initiatedDispute.votingDeadline.toNumber();
      const currentClock = Number(svm.getClock().unixTimestamp);
      if (currentClock >= votingDeadline) {
        // Work around zero voting_period in test protocol config by extending
        // this dispute's deadline in-place for deterministic vote/resolve flow.
        const disputeAccount = svm.getAccount(disputePda);
        expect(disputeAccount).to.not.equal(null);
        const patchedData = new Uint8Array(disputeAccount!.data);
        const view = new DataView(
          patchedData.buffer,
          patchedData.byteOffset,
          patchedData.byteLength
        );
        view.setBigInt64(203, BigInt(currentClock + 3600), true); // voting_deadline
        view.setBigInt64(211, BigInt(currentClock + 7200), true); // expires_at
        svm.setAccount(disputePda, {
          ...disputeAccount!,
          data: patchedData,
        });
      }

      const arbiters = [
        { kp: arbiter1, pda: arbiter1Pda },
        { kp: arbiter2, pda: arbiter2Pda },
        { kp: arbiter3, pda: arbiter3Pda },
      ];
      for (const arbiter of arbiters) {
        const votePda = deriveVotePda(disputePda, arbiter.pda);
        const authorityVotePda = deriveAuthorityVotePda(
          disputePda,
          arbiter.kp.publicKey
        );
        await program.methods
          .voteDispute(true)
          .accountsPartial({
            dispute: disputePda,
            task: taskPda,
            workerClaim: claimPda,
            defendantAgent: workerAgentPda,
            vote: votePda,
            authorityVote: authorityVotePda,
            arbiter: arbiter.pda,
            protocolConfig: protocolPda,
            authority: arbiter.kp.publicKey,
          })
          .signers([arbiter.kp])
          .rpc();
      }

      const votedDispute = await program.account.dispute.fetch(disputePda);
      expect(votedDispute.votesFor.toNumber()).to.be.greaterThan(0);
      expect(votedDispute.votesAgainst.toNumber()).to.equal(0);
      expect(votedDispute.totalVoters).to.equal(3);

      const secondsUntilVotingEnds = Math.max(
        1,
        (
          await program.account.dispute.fetch(disputePda)
        ).votingDeadline.toNumber() - Number(svm.getClock().unixTimestamp) + 1
      );
      advanceClock(svm, secondsUntilVotingEnds);

      const disputeBeforeResolve = await program.account.dispute.fetch(disputePda);
      const config = await program.account.protocolConfig.fetch(protocolPda);
      const taskBeforeResolve = await program.account.task.fetch(taskPda);
      const workerBeforeResolve = await program.account.agentRegistration.fetch(
        workerAgentPda
      );
      const expectedSlash = Math.floor(
        (disputeBeforeResolve.workerStakeAtDispute.toNumber() *
          config.slashPercentage) /
          100
      );
      const expectedReserved = Math.min(expectedSlash, rewardAmount);
      expect(workerBeforeResolve.stake.toNumber()).to.be.greaterThan(0);
      expect(expectedSlash).to.be.greaterThan(0);
      expect(taskBeforeResolve.rewardMint?.toBase58()).to.equal(mint.toBase58());

      const creatorBeforeResolve = await getTokenBalance(creatorAta);
      const treasuryBeforeResolve = await getTokenBalance(treasuryAta);

      await program.methods
        .resolveDispute()
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          resolver: provider.wallet.publicKey,
          creator: creator.publicKey,
          workerClaim: claimPda,
          worker: workerAgentPda,
          workerAuthority: worker.publicKey,
          systemProgram: SystemProgram.programId,
          tokenEscrowAta: escrowAta,
          creatorTokenAccount: creatorAta,
          workerTokenAccountAta: null,
          treasuryTokenAccount: treasuryAta,
          rewardMint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .remainingAccounts([
          {
            pubkey: deriveVotePda(disputePda, arbiter1Pda),
            isSigner: false,
            isWritable: true,
          },
          { pubkey: arbiter1Pda, isSigner: false, isWritable: true },
          {
            pubkey: deriveVotePda(disputePda, arbiter2Pda),
            isSigner: false,
            isWritable: true,
          },
          { pubkey: arbiter2Pda, isSigner: false, isWritable: true },
          {
            pubkey: deriveVotePda(disputePda, arbiter3Pda),
            isSigner: false,
            isWritable: true,
          },
          { pubkey: arbiter3Pda, isSigner: false, isWritable: true },
        ])
        .rpc();

      const escrowPdaInfoAfterResolve = await provider.connection.getAccountInfo(
        escrowPda
      );
      expect(
        escrowPdaInfoAfterResolve,
        "escrow PDA unexpectedly closed during resolve"
      ).to.not.equal(null);

      const escrowAtaInfoAfterResolve = await provider.connection.getAccountInfo(
        escrowAta
      );
      expect(
        escrowAtaInfoAfterResolve,
        "escrow ATA unexpectedly closed during resolve"
      ).to.not.equal(null);

      const creatorAfterResolve = await getTokenBalance(creatorAta);
      const treasuryAfterResolve = await getTokenBalance(treasuryAta);
      const escrowAfterResolve = await getTokenBalance(escrowAta);

      expect(Number(creatorAfterResolve - creatorBeforeResolve)).to.equal(
        rewardAmount - expectedReserved
      );
      expect(Number(treasuryAfterResolve - treasuryBeforeResolve)).to.equal(0);
      expect(Number(escrowAfterResolve)).to.equal(expectedReserved);

      const escrowState = await program.account.taskEscrow.fetch(escrowPda);
      expect(escrowState.isClosed).to.equal(false);
      expect(escrowState.distributed.toNumber()).to.equal(
        rewardAmount - expectedReserved
      );

      const treasuryBeforeSlash = await getTokenBalance(treasuryAta);
      const workerBeforeSlash = await program.account.agentRegistration.fetch(
        workerAgentPda
      );

      await program.methods
        .applyDisputeSlash()
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          workerClaim: claimPda,
          workerAgent: workerAgentPda,
          protocolConfig: protocolPda,
          treasury: treasuryPubkey,
          escrow: escrowPda,
          tokenEscrowAta: escrowAta,
          treasuryTokenAccount: treasuryAta,
          rewardMint: mint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();

      const disputeAfterSlash = await program.account.dispute.fetch(disputePda);
      expect(disputeAfterSlash.slashApplied).to.equal(true);

      const treasuryAfterSlash = await getTokenBalance(treasuryAta);
      expect(Number(treasuryAfterSlash - treasuryBeforeSlash)).to.equal(
        expectedReserved
      );

      const workerAfterSlash = await program.account.agentRegistration.fetch(
        workerAgentPda
      );
      expect(
        workerBeforeSlash.stake.sub(workerAfterSlash.stake).toNumber()
      ).to.equal(expectedSlash);

      const escrowPdaAccount = await provider.connection.getAccountInfo(escrowPda);
      const escrowAtaAccount = await provider.connection.getAccountInfo(escrowAta);
      expect(escrowPdaAccount).to.equal(null);
      expect(escrowAtaAccount).to.equal(null);
    });
  });
});
