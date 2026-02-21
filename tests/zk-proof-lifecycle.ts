/**
 * ZK proof verification lifecycle tests (LiteSVM).
 *
 * Exercises the full private task completion lifecycle with real hash
 * computations and a mock Verifier Router.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  SendTransactionError,
} from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  createLiteSVMContext,
  fundAccount,
  getClockTimestamp,
  injectMockVerifierRouter,
  type LiteSVMContext,
} from "./litesvm-helpers";
import {
  CAPABILITY_COMPUTE,
  TASK_TYPE_EXCLUSIVE,
  TASK_TYPE_COMPETITIVE,
  deriveProtocolPda,
  deriveTaskPda,
  deriveEscrowPda,
  deriveClaimPda,
  deriveProgramDataPda,
  deriveBindingSpendPda,
  deriveNullifierSpendPda,
  deriveRouterPda,
  deriveVerifierEntryPda,
  disableRateLimitsForTests,
  ensureAgentRegistered,
  generateRunId,
  makeAgentId,
  makeTaskId,
  createDescription,
  computeHashes,
  computeConstraintHash,
  generateSalt,
  bigintToBytes32,
  buildTestSealBytes,
  buildTestJournal,
  TRUSTED_IMAGE_ID,
  TRUSTED_ROUTER_PROGRAM_ID,
  TRUSTED_VERIFIER_PROGRAM_ID,
} from "./test-utils";

describe("ZK Proof Verification Lifecycle (LiteSVM)", () => {
  let ctx: LiteSVMContext;
  let program: Program<AgencCoordination>;
  let protocolPda: PublicKey;
  let routerPda: PublicKey;
  let verifierEntryPda: PublicKey;

  const runId = generateRunId();
  let treasury: Keypair;
  let taskCreator: Keypair;
  let worker: Keypair;
  let creatorAgentPda: PublicKey;
  let workerAgentPda: PublicKey;

  function taskIdToBn(taskId: Buffer): BN {
    return new BN(taskId.subarray(0, 8), "le");
  }

  /**
   * Send completeTaskPrivate with the signer as fee payer to avoid
   * exceeding the 1232-byte transaction limit.
   *
   * Uses constructor.name check instead of instanceof because
   * anchor-litesvm's fromWorkspace() bundles its own litesvm module,
   * causing class identity mismatch across module boundaries.
   */
  async function sendCompleteTaskPrivate(params: {
    taskIdBuf: Buffer;
    proof: {
      sealBytes: Buffer;
      journal: Buffer;
      imageId: number[];
      bindingSeed: number[];
      nullifierSeed: number[];
    };
    taskPda: PublicKey;
    claimPda: PublicKey;
    escrowPda: PublicKey;
    bindingSpendPda: PublicKey;
    nullifierSpendPda: PublicKey;
    signer?: Keypair;
    workerAgent?: PublicKey;
    taskCreatorKey?: PublicKey;
  }): Promise<void> {
    const signer = params.signer ?? worker;
    const workerAgent = params.workerAgent ?? workerAgentPda;
    const taskCreatorKey = params.taskCreatorKey ?? taskCreator.publicKey;

    const ix = await program.methods
      .completeTaskPrivate(taskIdToBn(params.taskIdBuf), params.proof)
      .accountsPartial({
        task: params.taskPda,
        claim: params.claimPda,
        escrow: params.escrowPda,
        creator: taskCreatorKey,
        worker: workerAgent,
        protocolConfig: protocolPda,
        bindingSpend: params.bindingSpendPda,
        nullifierSpend: params.nullifierSpendPda,
        treasury: treasury.publicKey,
        authority: signer.publicKey,
        routerProgram: TRUSTED_ROUTER_PROGRAM_ID,
        router: routerPda,
        verifierEntry: verifierEntryPda,
        verifierProgram: TRUSTED_VERIFIER_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        tokenEscrowAta: null,
        workerTokenAccount: null,
        treasuryTokenAccount: null,
        rewardMint: null,
        tokenProgram: null,
      })
      .instruction();

    const tx = new Transaction();
    tx.add(ix);
    tx.feePayer = signer.publicKey;
    tx.recentBlockhash = ctx.svm.latestBlockhash();
    tx.sign(signer);

    const res = ctx.svm.sendTransaction(tx);
    if (res.constructor.name === "FailedTransactionMetadata") {
      const failed = res as any;
      throw new SendTransactionError({
        action: "send",
        signature: "unknown",
        transactionMessage: failed.err().toString(),
        logs: failed.meta().logs(),
      });
    }
  }

  async function createPrivateTaskAndClaim(
    constraintHash: Buffer,
    taskIdBuf: Buffer,
    taskType: number = TASK_TYPE_EXCLUSIVE,
  ) {
    const description = createDescription("zk-lifecycle-task");
    const deadline = new BN(getClockTimestamp(ctx.svm) + 3600);
    const taskPda = deriveTaskPda(
      taskCreator.publicKey,
      taskIdBuf,
      program.programId,
    );
    const escrowPda = deriveEscrowPda(taskPda, program.programId);
    const claimPda = deriveClaimPda(
      taskPda,
      workerAgentPda,
      program.programId,
    );

    await program.methods
      .createTask(
        Array.from(taskIdBuf),
        new BN(CAPABILITY_COMPUTE),
        description,
        new BN(0.3 * LAMPORTS_PER_SOL),
        taskType === TASK_TYPE_COMPETITIVE ? 3 : 1,
        deadline,
        taskType,
        Array.from(constraintHash),
        0,
        null,
      )
      .accountsPartial({
        task: taskPda,
        escrow: escrowPda,
        creatorAgent: creatorAgentPda,
        protocolConfig: protocolPda,
        authority: taskCreator.publicKey,
        creator: taskCreator.publicKey,
        systemProgram: SystemProgram.programId,
        rewardMint: null,
        creatorTokenAccount: null,
        tokenEscrowAta: null,
        tokenProgram: null,
        associatedTokenProgram: null,
      })
      .signers([taskCreator])
      .rpc();

    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda,
        worker: workerAgentPda,
        protocolConfig: protocolPda,
        authority: worker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker])
      .rpc();

    return { taskPda, escrowPda, claimPda };
  }

  const TEST_AGENT_SECRET = 42n;

  function buildProofForTask(
    taskPda: PublicKey,
    workerPublicKey: PublicKey,
    constraintHashBuf: Buffer,
    output: bigint[],
    salt: bigint,
  ) {
    const hashes = computeHashes(taskPda, workerPublicKey, output, salt, TEST_AGENT_SECRET);
    const bindingSeed = bigintToBytes32(hashes.binding);
    const nullifierSeed = bigintToBytes32(hashes.nullifier);
    const outputCommitment = bigintToBytes32(hashes.outputCommitment);

    const journal = buildTestJournal({
      taskPda: taskPda.toBuffer(),
      authority: workerPublicKey.toBuffer(),
      constraintHash: constraintHashBuf,
      outputCommitment,
      binding: bindingSeed,
      nullifier: nullifierSeed,
    });

    return {
      proof: {
        sealBytes: buildTestSealBytes(),
        journal,
        imageId: Array.from(TRUSTED_IMAGE_ID),
        bindingSeed: Array.from(bindingSeed),
        nullifierSeed: Array.from(nullifierSeed),
      },
      bindingSeed,
      nullifierSeed,
    };
  }

  before(async () => {
    ctx = createLiteSVMContext();
    injectMockVerifierRouter(ctx.svm);
    program = ctx.program;
    protocolPda = deriveProtocolPda(program.programId);
    routerPda = deriveRouterPda();
    verifierEntryPda = deriveVerifierEntryPda();

    treasury = Keypair.generate();
    const thirdSigner = Keypair.generate();
    taskCreator = Keypair.generate();
    worker = Keypair.generate();
    for (const kp of [treasury, thirdSigner, taskCreator, worker]) {
      fundAccount(ctx.svm, kp.publicKey, 50 * LAMPORTS_PER_SOL);
    }

    await program.methods
      .initializeProtocol(
        51,
        100,
        new BN(LAMPORTS_PER_SOL / 10),
        new BN(LAMPORTS_PER_SOL / 100),
        2,
        [ctx.payer.publicKey, treasury.publicKey, thirdSigner.publicKey],
      )
      .accountsPartial({
        protocolConfig: protocolPda,
        treasury: treasury.publicKey,
        authority: ctx.payer.publicKey,
        secondSigner: treasury.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        {
          pubkey: deriveProgramDataPda(program.programId),
          isSigner: false,
          isWritable: false,
        },
        {
          pubkey: thirdSigner.publicKey,
          isSigner: true,
          isWritable: false,
        },
      ])
      .signers([treasury, thirdSigner])
      .rpc();

    await disableRateLimitsForTests({
      program,
      protocolPda,
      authority: ctx.payer.publicKey,
      additionalSigners: [treasury],
    });

    const creatorAgentId = makeAgentId("zlc", runId);
    const workerAgentId = makeAgentId("zlw", runId);
    creatorAgentPda = await ensureAgentRegistered({
      program,
      protocolPda,
      agentId: creatorAgentId,
      authority: taskCreator,
      capabilities: CAPABILITY_COMPUTE,
      stakeLamports: LAMPORTS_PER_SOL / 10,
    });
    workerAgentPda = await ensureAgentRegistered({
      program,
      protocolPda,
      agentId: workerAgentId,
      authority: worker,
      capabilities: CAPABILITY_COMPUTE,
      stakeLamports: LAMPORTS_PER_SOL / 10,
    });
  });

  it("submits complete_task_private with dual-spend + router accounts", async () => {
    const output = [11n, 22n, 33n, 44n];
    const salt = generateSalt();
    const constraintHash = computeConstraintHash(output);
    const constraintHashBuf = bigintToBytes32(constraintHash);
    const taskIdBuf = makeTaskId("zl1", runId);

    const { taskPda, escrowPda, claimPda } = await createPrivateTaskAndClaim(
      constraintHashBuf,
      taskIdBuf,
    );

    const { proof, bindingSeed, nullifierSeed } = buildProofForTask(
      taskPda,
      worker.publicKey,
      constraintHashBuf,
      output,
      salt,
    );

    await sendCompleteTaskPrivate({
      taskIdBuf,
      proof,
      taskPda,
      claimPda,
      escrowPda,
      bindingSpendPda: deriveBindingSpendPda(bindingSeed, program.programId),
      nullifierSpendPda: deriveNullifierSpendPda(nullifierSeed, program.programId),
    });

    const taskAccount = await program.account.task.fetch(taskPda);
    expect("completed" in taskAccount.status).to.be.true;

    const bindingSpend = await program.account.bindingSpend.fetch(
      deriveBindingSpendPda(bindingSeed, program.programId),
    );
    expect(bindingSpend.task.equals(taskPda)).to.be.true;
  });

  it("accepts explicit bindingSeed/nullifierSeed fields in payload", async () => {
    const output = [55n, 66n, 77n, 88n];
    const salt = generateSalt();
    const constraintHash = computeConstraintHash(output);
    const constraintHashBuf = bigintToBytes32(constraintHash);
    const taskIdBuf = makeTaskId("zl2", runId);

    const { taskPda, escrowPda, claimPda } = await createPrivateTaskAndClaim(
      constraintHashBuf,
      taskIdBuf,
    );

    const { proof, bindingSeed, nullifierSeed } = buildProofForTask(
      taskPda,
      worker.publicKey,
      constraintHashBuf,
      output,
      salt,
    );

    await sendCompleteTaskPrivate({
      taskIdBuf,
      proof,
      taskPda,
      claimPda,
      escrowPda,
      bindingSpendPda: deriveBindingSpendPda(bindingSeed, program.programId),
      nullifierSpendPda: deriveNullifierSpendPda(nullifierSeed, program.programId),
    });

    const taskAccount = await program.account.task.fetch(taskPda);
    expect("completed" in taskAccount.status).to.be.true;
  });

  it("prevents double-completion of competitive private task", async () => {
    const output = [100n, 200n, 300n, 400n];
    const salt = generateSalt();
    const constraintHash = computeConstraintHash(output);
    const constraintHashBuf = bigintToBytes32(constraintHash);
    const taskIdBuf = makeTaskId("zl3", runId);

    // Create competitive task (max_workers=3)
    const description = createDescription("zk-competitive-task");
    const deadline = new BN(getClockTimestamp(ctx.svm) + 3600);
    const taskPda = deriveTaskPda(
      taskCreator.publicKey,
      taskIdBuf,
      program.programId,
    );
    const escrowPda = deriveEscrowPda(taskPda, program.programId);

    await program.methods
      .createTask(
        Array.from(taskIdBuf),
        new BN(CAPABILITY_COMPUTE),
        description,
        new BN(0.3 * LAMPORTS_PER_SOL),
        3,
        deadline,
        TASK_TYPE_COMPETITIVE,
        Array.from(constraintHashBuf),
        0,
        null,
      )
      .accountsPartial({
        task: taskPda,
        escrow: escrowPda,
        creatorAgent: creatorAgentPda,
        protocolConfig: protocolPda,
        authority: taskCreator.publicKey,
        creator: taskCreator.publicKey,
        systemProgram: SystemProgram.programId,
        rewardMint: null,
        creatorTokenAccount: null,
        tokenEscrowAta: null,
        tokenProgram: null,
        associatedTokenProgram: null,
      })
      .signers([taskCreator])
      .rpc();

    // Register second worker
    const worker2 = Keypair.generate();
    fundAccount(ctx.svm, worker2.publicKey, 10 * LAMPORTS_PER_SOL);
    const worker2AgentId = makeAgentId("zlw2", runId);
    const worker2AgentPda = await ensureAgentRegistered({
      program,
      protocolPda,
      agentId: worker2AgentId,
      authority: worker2,
      capabilities: CAPABILITY_COMPUTE,
      stakeLamports: LAMPORTS_PER_SOL / 10,
    });

    // Both workers claim BEFORE any completion
    const claimPda = deriveClaimPda(taskPda, workerAgentPda, program.programId);
    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda,
        worker: workerAgentPda,
        protocolConfig: protocolPda,
        authority: worker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker])
      .rpc();

    const claim2Pda = deriveClaimPda(taskPda, worker2AgentPda, program.programId);
    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claim2Pda,
        worker: worker2AgentPda,
        protocolConfig: protocolPda,
        authority: worker2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker2])
      .rpc();

    // First completion succeeds
    const { proof, bindingSeed, nullifierSeed } = buildProofForTask(
      taskPda,
      worker.publicKey,
      constraintHashBuf,
      output,
      salt,
    );

    await sendCompleteTaskPrivate({
      taskIdBuf,
      proof,
      taskPda,
      claimPda,
      escrowPda,
      bindingSpendPda: deriveBindingSpendPda(bindingSeed, program.programId),
      nullifierSpendPda: deriveNullifierSpendPda(nullifierSeed, program.programId),
    });

    // Second completion should fail (competitive tasks enforce completions == 0)
    const salt2 = generateSalt();
    const { proof: proof2, bindingSeed: bs2, nullifierSeed: ns2 } =
      buildProofForTask(taskPda, worker2.publicKey, constraintHashBuf, output, salt2);

    try {
      await sendCompleteTaskPrivate({
        taskIdBuf,
        proof: proof2,
        taskPda,
        claimPda: claim2Pda,
        escrowPda,
        bindingSpendPda: deriveBindingSpendPda(bs2, program.programId),
        nullifierSpendPda: deriveNullifierSpendPda(ns2, program.programId),
        signer: worker2,
        workerAgent: worker2AgentPda,
      });
      expect.fail("double-completion of competitive task should fail");
    } catch (e: any) {
      // Expected: competitive tasks enforce completions == 0 before paying
      if (e.name === "AssertionError") throw e;
      expect(String(e)).to.not.equal("");
    }
  });
});

describe("Private Replay Seed Semantics", () => {
  it("derives distinct spend PDAs for distinct binding/nullifier seeds", () => {
    const programId = new PublicKey(
      "5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7",
    );

    const bindingA = Buffer.alloc(32, 0x21);
    const bindingB = Buffer.alloc(32, 0x22);
    const nullifierA = Buffer.alloc(32, 0x31);
    const nullifierB = Buffer.alloc(32, 0x32);

    const bindingSpendA = deriveBindingSpendPda(bindingA, programId);
    const bindingSpendB = deriveBindingSpendPda(bindingB, programId);
    const nullifierSpendA = deriveNullifierSpendPda(nullifierA, programId);
    const nullifierSpendB = deriveNullifierSpendPda(nullifierB, programId);

    expect(bindingSpendA.equals(bindingSpendB)).to.equal(false);
    expect(nullifierSpendA.equals(nullifierSpendB)).to.equal(false);
  });
});
