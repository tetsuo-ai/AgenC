/**
 * complete_task_private integration tests (LiteSVM).
 *
 * Uses a mock Verifier Router to exercise the full positive path
 * without requiring a real RISC Zero prover.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect, AssertionError } from "chai";
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

describe("complete_task_private (LiteSVM + mock router)", () => {
  let ctx: LiteSVMContext;
  let program: Program<AgencCoordination>;
  let protocolPda: PublicKey;
  let routerPda: PublicKey;
  let verifierEntryPda: PublicKey;

  const runId = generateRunId();
  let treasury: Keypair;
  let creator: Keypair;
  let worker: Keypair;
  let creatorAgentPda: PublicKey;
  let workerAgentPda: PublicKey;

  function taskIdToBn(taskId: Buffer): BN {
    return new BN(taskId.subarray(0, 8), "le");
  }

  /**
   * Build and send a completeTaskPrivate transaction with the signer
   * as fee payer. This avoids a second signer/key that would push
   * the transaction over the 1232-byte limit.
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
    taskCreator?: PublicKey;
  }): Promise<void> {
    const signer = params.signer ?? worker;
    const workerAgent = params.workerAgent ?? workerAgentPda;
    const taskCreatorKey = params.taskCreator ?? creator.publicKey;

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

  async function createTaskAndClaim(
    constraintHash: Buffer,
    taskIdBuf: Buffer,
    rewardLamports: number = 0.2 * LAMPORTS_PER_SOL,
  ) {
    const description = createDescription("private-router-task");
    const deadline = new BN(getClockTimestamp(ctx.svm) + 3600);
    const taskPda = deriveTaskPda(
      creator.publicKey,
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
        new BN(rewardLamports),
        1,
        deadline,
        TASK_TYPE_EXCLUSIVE,
        Array.from(constraintHash),
        0,
        null,
      )
      .accountsPartial({
        task: taskPda,
        escrow: escrowPda,
        creatorAgent: creatorAgentPda,
        protocolConfig: protocolPda,
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

  function buildProofForTask(
    taskPda: PublicKey,
    workerPubkey: PublicKey,
    constraintHashBuf: Buffer,
    output: bigint[],
    salt: bigint,
  ) {
    const hashes = computeHashes(taskPda, workerPubkey, output, salt);
    const bindingSeed = bigintToBytes32(hashes.binding);
    const nullifierSeed = bigintToBytes32(hashes.nullifier);
    const outputCommitment = bigintToBytes32(hashes.outputCommitment);

    const journal = buildTestJournal({
      taskPda: taskPda.toBuffer(),
      authority: workerPubkey.toBuffer(),
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
    creator = Keypair.generate();
    worker = Keypair.generate();
    for (const kp of [treasury, creator, worker]) {
      fundAccount(ctx.svm, kp.publicKey, 50 * LAMPORTS_PER_SOL);
    }

    await program.methods
      .initializeProtocol(
        51,
        100,
        new BN(LAMPORTS_PER_SOL),
        new BN(LAMPORTS_PER_SOL / 100),
        1,
        [ctx.payer.publicKey, treasury.publicKey],
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
      ])
      .signers([treasury])
      .rpc();

    await disableRateLimitsForTests({
      program,
      protocolPda,
      authority: ctx.payer.publicKey,
    });

    const creatorAgentId = makeAgentId("zkc", runId);
    const workerAgentId = makeAgentId("zkw", runId);
    creatorAgentPda = await ensureAgentRegistered({
      program,
      protocolPda,
      agentId: creatorAgentId,
      authority: creator,
      capabilities: CAPABILITY_COMPUTE,
    });
    workerAgentPda = await ensureAgentRegistered({
      program,
      protocolPda,
      agentId: workerAgentId,
      authority: worker,
      capabilities: CAPABILITY_COMPUTE,
    });
  });

  it("completes private task end-to-end with real hashes", async () => {
    const output = [11n, 22n, 33n, 44n];
    const salt = generateSalt();
    const constraintHash = computeConstraintHash(output);
    const constraintHashBuf = bigintToBytes32(constraintHash);
    const taskIdBuf = makeTaskId("zkp1", runId);

    const { taskPda, escrowPda, claimPda } = await createTaskAndClaim(
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

    const bindingSpendPda = deriveBindingSpendPda(bindingSeed, program.programId);
    const nullifierSpendPda = deriveNullifierSpendPda(nullifierSeed, program.programId);
    const workerBalanceBefore = Number(ctx.svm.getBalance(worker.publicKey));

    await sendCompleteTaskPrivate({
      taskIdBuf,
      proof,
      taskPda,
      claimPda,
      escrowPda,
      bindingSpendPda,
      nullifierSpendPda,
    });

    // Verify task status = Completed
    const taskAccount = await program.account.task.fetch(taskPda);
    expect("completed" in taskAccount.status).to.be.true;

    // Verify BindingSpend PDA exists
    const bindingSpend = await program.account.bindingSpend.fetch(bindingSpendPda);
    expect(Buffer.from(bindingSpend.binding).equals(bindingSeed)).to.be.true;
    expect(bindingSpend.task.equals(taskPda)).to.be.true;
    expect(bindingSpend.agent.equals(workerAgentPda)).to.be.true;

    // Verify NullifierSpend PDA exists
    const nullifierSpend = await program.account.nullifierSpend.fetch(nullifierSpendPda);
    expect(Buffer.from(nullifierSpend.nullifier).equals(nullifierSeed)).to.be.true;
    expect(nullifierSpend.task.equals(taskPda)).to.be.true;
    expect(nullifierSpend.agent.equals(workerAgentPda)).to.be.true;

    // Verify worker balance increased (reward minus tx fee + PDA rent)
    const workerBalanceAfter = Number(ctx.svm.getBalance(worker.publicKey));
    expect(workerBalanceAfter).to.be.greaterThan(workerBalanceBefore - 10_000_000);
  });

  it("rejects replay with same binding seed", async () => {
    const output = [55n, 66n, 77n, 88n];
    const salt = generateSalt();
    const constraintHash = computeConstraintHash(output);
    const constraintHashBuf = bigintToBytes32(constraintHash);
    const taskIdBuf = makeTaskId("zkp2", runId);

    const { taskPda, escrowPda, claimPda } = await createTaskAndClaim(
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

    // First completion should succeed
    await sendCompleteTaskPrivate({
      taskIdBuf,
      proof,
      taskPda,
      claimPda,
      escrowPda,
      bindingSpendPda: deriveBindingSpendPda(bindingSeed, program.programId),
      nullifierSpendPda: deriveNullifierSpendPda(nullifierSeed, program.programId),
    });

    // Second task reusing the same binding/nullifier seeds should fail
    const taskIdBuf2 = makeTaskId("zkp2b", runId);
    const { taskPda: task2Pda, escrowPda: escrow2Pda, claimPda: claim2Pda } =
      await createTaskAndClaim(constraintHashBuf, taskIdBuf2);

    // Build journal for second task but reuse binding/nullifier
    const hashes = computeHashes(taskPda, worker.publicKey, output, salt);
    const outputCommitment = bigintToBytes32(hashes.outputCommitment);
    const journal2 = buildTestJournal({
      taskPda: task2Pda.toBuffer(),
      authority: worker.publicKey.toBuffer(),
      constraintHash: constraintHashBuf,
      outputCommitment,
      binding: bindingSeed,
      nullifier: nullifierSeed,
    });

    const proof2 = {
      sealBytes: buildTestSealBytes(),
      journal: journal2,
      imageId: Array.from(TRUSTED_IMAGE_ID),
      bindingSeed: Array.from(bindingSeed),
      nullifierSeed: Array.from(nullifierSeed),
    };

    try {
      await sendCompleteTaskPrivate({
        taskIdBuf: taskIdBuf2,
        proof: proof2,
        taskPda: task2Pda,
        claimPda: claim2Pda,
        escrowPda: escrow2Pda,
        bindingSpendPda: deriveBindingSpendPda(bindingSeed, program.programId),
        nullifierSpendPda: deriveNullifierSpendPda(nullifierSeed, program.programId),
      });
      expect.fail("replay should have been rejected");
    } catch (e: any) {
      if (e instanceof AssertionError) throw e;
      expect(String(e)).to.not.equal("");
    }
  });

  it("rejects wrong image ID", async () => {
    const output = [99n, 100n, 101n, 102n];
    const salt = generateSalt();
    const constraintHash = computeConstraintHash(output);
    const constraintHashBuf = bigintToBytes32(constraintHash);
    const taskIdBuf = makeTaskId("zkp3", runId);

    const { taskPda, escrowPda, claimPda } = await createTaskAndClaim(
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

    // Tamper with image ID
    const wrongProof = { ...proof, imageId: [...proof.imageId] };
    wrongProof.imageId[0] ^= 0xff;

    try {
      await sendCompleteTaskPrivate({
        taskIdBuf,
        proof: wrongProof,
        taskPda,
        claimPda,
        escrowPda,
        bindingSpendPda: deriveBindingSpendPda(bindingSeed, program.programId),
        nullifierSpendPda: deriveNullifierSpendPda(nullifierSeed, program.programId),
      });
      expect.fail("wrong image ID should have been rejected");
    } catch (e: any) {
      if (e instanceof AssertionError) throw e;
      expect(String(e)).to.include("InvalidImageId");
    }
  });

  it("rejects wrong constraint hash in journal", async () => {
    const output = [200n, 201n, 202n, 203n];
    const salt = generateSalt();
    const constraintHash = computeConstraintHash(output);
    const constraintHashBuf = bigintToBytes32(constraintHash);
    const taskIdBuf = makeTaskId("zkp4", runId);

    const { taskPda, escrowPda, claimPda } = await createTaskAndClaim(
      constraintHashBuf,
      taskIdBuf,
    );

    const hashes = computeHashes(taskPda, worker.publicKey, output, salt);
    const bindingSeed = bigintToBytes32(hashes.binding);
    const nullifierSeed = bigintToBytes32(hashes.nullifier);
    const outputCommitment = bigintToBytes32(hashes.outputCommitment);

    // Build journal with wrong constraint hash
    const wrongConstraintHash = Buffer.from(constraintHashBuf);
    wrongConstraintHash[0] ^= 0xff;

    const journal = buildTestJournal({
      taskPda: taskPda.toBuffer(),
      authority: worker.publicKey.toBuffer(),
      constraintHash: wrongConstraintHash,
      outputCommitment,
      binding: bindingSeed,
      nullifier: nullifierSeed,
    });

    const proof = {
      sealBytes: buildTestSealBytes(),
      journal,
      imageId: Array.from(TRUSTED_IMAGE_ID),
      bindingSeed: Array.from(bindingSeed),
      nullifierSeed: Array.from(nullifierSeed),
    };

    try {
      await sendCompleteTaskPrivate({
        taskIdBuf,
        proof,
        taskPda,
        claimPda,
        escrowPda,
        bindingSpendPda: deriveBindingSpendPda(bindingSeed, program.programId),
        nullifierSpendPda: deriveNullifierSpendPda(nullifierSeed, program.programId),
      });
      expect.fail("wrong constraint hash should have been rejected");
    } catch (e: any) {
      if (e instanceof AssertionError) throw e;
      expect(String(e)).to.include("ConstraintHashMismatch");
    }
  });

  it("rejects low-entropy binding seed", async () => {
    const output = [300n, 301n, 302n, 303n];
    const salt = generateSalt();
    const constraintHash = computeConstraintHash(output);
    const constraintHashBuf = bigintToBytes32(constraintHash);
    const taskIdBuf = makeTaskId("zkp5", runId);

    const { taskPda, escrowPda, claimPda } = await createTaskAndClaim(
      constraintHashBuf,
      taskIdBuf,
    );

    const hashes = computeHashes(taskPda, worker.publicKey, output, salt);
    const nullifierSeed = bigintToBytes32(hashes.nullifier);
    const outputCommitment = bigintToBytes32(hashes.outputCommitment);

    // Low-entropy binding seed (constant fill — only 1 distinct byte)
    const lowEntropyBinding = Buffer.alloc(32, 0xaa);

    const journal = buildTestJournal({
      taskPda: taskPda.toBuffer(),
      authority: worker.publicKey.toBuffer(),
      constraintHash: constraintHashBuf,
      outputCommitment,
      binding: lowEntropyBinding,
      nullifier: nullifierSeed,
    });

    const proof = {
      sealBytes: buildTestSealBytes(),
      journal,
      imageId: Array.from(TRUSTED_IMAGE_ID),
      bindingSeed: Array.from(lowEntropyBinding),
      nullifierSeed: Array.from(nullifierSeed),
    };

    try {
      await sendCompleteTaskPrivate({
        taskIdBuf,
        proof,
        taskPda,
        claimPda,
        escrowPda,
        bindingSpendPda: deriveBindingSpendPda(lowEntropyBinding, program.programId),
        nullifierSpendPda: deriveNullifierSpendPda(nullifierSeed, program.programId),
      });
      expect.fail("low-entropy binding should have been rejected");
    } catch (e: any) {
      if (e instanceof AssertionError) throw e;
      expect(String(e)).to.include("InsufficientSeedEntropy");
    }
  });
});
