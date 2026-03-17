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
import type { AgencCoordination } from "-ai/protocol";
import {
  CAPABILITY_COMPUTE,
  TASK_TYPE_EXCLUSIVE,
  VALID_EVIDENCE,
  createHash,
  deriveAgentPda,
  deriveClaimPda,
  deriveDisputePda,
  deriveEscrowPda,
  deriveProgramDataPda,
  deriveProtocolPda,
  deriveTaskPda,
  disableRateLimitsForTests,
  generateRunId,
  makeAgentId,
  makeDisputeId,
  makeTaskId,
} from "./test-utils";
import {
  advanceClock,
  createLiteSVMContext,
  fundAccount,
  getClockTimestamp,
} from "./litesvm-helpers";

describe("instruction-coverage", () => {
  const { svm, provider, program } = createLiteSVMContext();
  const protocolPda = deriveProtocolPda(program.programId);
  const runId = generateRunId();

  let secondSigner: Keypair;
  let thirdSigner: Keypair;
  let creator: Keypair;
  let worker: Keypair;
  let buyer: Keypair;
  let suspendTarget: Keypair;
  let newMultisigOwner: Keypair;

  let creatorAgentPda: PublicKey;
  let workerAgentPda: PublicKey;
  let buyerAgentPda: PublicKey;
  let suspendTargetPda: PublicKey;

  function deriveSkillPda(authorAgent: PublicKey, skillId: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("skill"), authorAgent.toBuffer(), skillId],
      program.programId,
    )[0];
  }

  function deriveSkillPurchasePda(skillPda: PublicKey, buyerAgent: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("skill_purchase"), skillPda.toBuffer(), buyerAgent.toBuffer()],
      program.programId,
    )[0];
  }

  function deriveSkillRatingPda(skillPda: PublicKey, buyerAgent: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("skill_rating"), skillPda.toBuffer(), buyerAgent.toBuffer()],
      program.programId,
    )[0];
  }

  function multisigRemainingAccounts() {
    return [
      { pubkey: secondSigner.publicKey, isSigner: true, isWritable: false },
      { pubkey: thirdSigner.publicKey, isSigner: true, isWritable: false },
    ];
  }

  async function registerAgent(
    wallet: Keypair,
    agentId: Buffer,
    endpoint: string,
    capabilities: number = CAPABILITY_COMPUTE,
  ): Promise<PublicKey> {
    const agentPda = deriveAgentPda(agentId, program.programId);
    await program.methods
      .registerAgent(
        Array.from(agentId),
        new BN(capabilities),
        endpoint,
        null,
        new BN(LAMPORTS_PER_SOL),
      )
      .accountsPartial({
        agent: agentPda,
        protocolConfig: protocolPda,
        authority: wallet.publicKey,
      })
      .signers([wallet])
      .rpc({ skipPreflight: true });
    return agentPda;
  }

  async function createTask(taskId: Buffer, deadlineOffsetSeconds: number) {
    const taskPda = deriveTaskPda(creator.publicKey, taskId, program.programId);
    const escrowPda = deriveEscrowPda(taskPda, program.programId);
    const deadline = new BN(getClockTimestamp(svm) + deadlineOffsetSeconds);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await program.methods
          .createTask(
            Array.from(taskId),
            new BN(CAPABILITY_COMPUTE),
            Array.from(Buffer.from("Instruction coverage task".padEnd(64, "\0"))),
            new BN(LAMPORTS_PER_SOL / 10),
            1,
            deadline,
            TASK_TYPE_EXCLUSIVE,
            null,
            0,
            null,
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
          .rpc({ skipPreflight: true });
        return { taskPda, escrowPda };
      } catch (error) {
        const message = (error as { message?: string }).message ?? String(error);
        if (message.includes("CooldownNotElapsed")) {
          advanceClock(svm, 2);
          continue;
        }
        throw error;
      }
    }
    throw new Error("createTask failed after retries");
  }

  async function claimTask(taskPda: PublicKey): Promise<PublicKey> {
    const claimPda = deriveClaimPda(taskPda, workerAgentPda, program.programId);
    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda,
        worker: workerAgentPda,
        protocolConfig: protocolPda,
        authority: worker.publicKey,
      })
      .signers([worker])
      .rpc({ skipPreflight: true });
    return claimPda;
  }

  before(async () => {
    secondSigner = Keypair.generate();
    thirdSigner = Keypair.generate();
    creator = Keypair.generate();
    worker = Keypair.generate();
    buyer = Keypair.generate();
    suspendTarget = Keypair.generate();
    newMultisigOwner = Keypair.generate();

    const toFund = [
      secondSigner,
      thirdSigner,
      creator,
      worker,
      buyer,
      suspendTarget,
      newMultisigOwner,
    ];
    for (const wallet of toFund) {
      fundAccount(svm, wallet.publicKey, 20 * LAMPORTS_PER_SOL);
    }

    await program.methods
      .initializeProtocol(
        51,
        100,
        new BN(LAMPORTS_PER_SOL),
        new BN(1_000_000),
        2,
        [provider.wallet.publicKey, secondSigner.publicKey, thirdSigner.publicKey],
      )
      .accountsPartial({
        protocolConfig: protocolPda,
        treasury: secondSigner.publicKey,
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
        { pubkey: thirdSigner.publicKey, isSigner: true, isWritable: false },
      ])
      .signers([secondSigner, thirdSigner])
      .rpc({ skipPreflight: true });

    await disableRateLimitsForTests({
      program: program as Program<AgencCoordination>,
      protocolPda,
      authority: provider.wallet.publicKey,
      additionalSigners: [secondSigner],
      skipPreflight: true,
    });

    creatorAgentPda = await registerAgent(
      creator,
      makeAgentId("covCre", runId),
      "https://creator.coverage.test",
    );
    workerAgentPda = await registerAgent(
      worker,
      makeAgentId("covWrk", runId),
      "https://worker.coverage.test",
    );
    buyerAgentPda = await registerAgent(
      buyer,
      makeAgentId("covBuy", runId),
      "https://buyer.coverage.test",
    );
    suspendTargetPda = await registerAgent(
      suspendTarget,
      makeAgentId("covSup", runId),
      "https://suspend.coverage.test",
    );
  });

  it("covers suspend_agent and unsuspend_agent", async () => {
    await program.methods
      .suspendAgent()
      .accountsPartial({
        agent: suspendTargetPda,
        protocolConfig: protocolPda,
        authority: provider.wallet.publicKey,
      })
      .rpc({ skipPreflight: true });

    const suspended = await program.account.agentRegistration.fetch(suspendTargetPda);
    expect("suspended" in suspended.status).to.equal(true);

    await program.methods
      .unsuspendAgent()
      .accountsPartial({
        agent: suspendTargetPda,
        protocolConfig: protocolPda,
        authority: provider.wallet.publicKey,
      })
      .rpc({ skipPreflight: true });

    const unsuspended = await program.account.agentRegistration.fetch(suspendTargetPda);
    expect("inactive" in unsuspended.status).to.equal(true);
  });

  it("covers expire_claim", async () => {
    const taskId = makeTaskId("covExp", runId);
    const { taskPda, escrowPda } = await createTask(taskId, 30);
    const claimPda = await claimTask(taskPda);

    // claim.expires_at = task.deadline + 3600
    advanceClock(svm, 3700);

    await program.methods
      .expireClaim()
      .accountsPartial({
        authority: worker.publicKey,
        task: taskPda,
        escrow: escrowPda,
        claim: claimPda,
        worker: workerAgentPda,
        protocolConfig: protocolPda,
        rentRecipient: worker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker])
      .rpc({ skipPreflight: true });

    try {
      await program.account.taskClaim.fetch(claimPda);
      expect.fail("Expected claim to be closed after expireClaim");
    } catch {
      // Expected
    }

    const task = await program.account.task.fetch(taskPda);
    expect(task.currentWorkers).to.equal(0);
    expect("open" in task.status).to.equal(true);

    const workerAccount = await program.account.agentRegistration.fetch(workerAgentPda);
    expect(workerAccount.activeTasks).to.equal(0);
  });

  it("covers cancel_dispute", async () => {
    const taskId = makeTaskId("covDsp", runId);
    const { taskPda } = await createTask(taskId, 3600);
    const claimPda = await claimTask(taskPda);
    const disputeId = makeDisputeId("covDsp", runId);
    const disputePda = deriveDisputePda(disputeId, program.programId);

    await program.methods
      .initiateDispute(
        Array.from(disputeId),
        Array.from(taskId),
        createHash("coverage-dispute-evidence"),
        0,
        VALID_EVIDENCE,
      )
      .accountsPartial({
        dispute: disputePda,
        task: taskPda,
        agent: workerAgentPda,
        protocolConfig: protocolPda,
        initiatorClaim: claimPda,
        workerAgent: null,
        workerClaim: null,
        authority: worker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker])
      .rpc({ skipPreflight: true });

    await program.methods
      .cancelDispute()
      .accountsPartial({
        dispute: disputePda,
        task: taskPda,
        authority: worker.publicKey,
      })
      .remainingAccounts([
        { pubkey: workerAgentPda, isSigner: false, isWritable: true },
      ])
      .signers([worker])
      .rpc({ skipPreflight: true });

    const dispute = await program.account.dispute.fetch(disputePda);
    expect("cancelled" in dispute.status).to.equal(true);

    const task = await program.account.task.fetch(taskPda);
    expect("inProgress" in task.status).to.equal(true);
  });

  it("covers register_skill, update_skill, purchase_skill, and rate_skill", async () => {
    const skillId = makeTaskId("covSkl", runId);
    const skillPda = deriveSkillPda(creatorAgentPda, skillId);
    const purchasePda = deriveSkillPurchasePda(skillPda, buyerAgentPda);
    const ratingPda = deriveSkillRatingPda(skillPda, buyerAgentPda);

    const skillName = Buffer.from("Coverage Skill".padEnd(32, "\0"));
    const initialContentHash = Buffer.from(createHash("coverage-skill-v1"));
    const updatedContentHash = Buffer.from(createHash("coverage-skill-v2"));
    const initialTags = Buffer.from("coverage,instruction".padEnd(64, "\0"));
    const updatedTags = Buffer.from("coverage,updated".padEnd(64, "\0"));
    const initialPrice = 25_000;
    const updatedPrice = 30_000;

    await program.methods
      .registerSkill(
        Array.from(skillId),
        Array.from(skillName),
        Array.from(initialContentHash),
        new BN(initialPrice),
        null,
        Array.from(initialTags),
      )
      .accountsPartial({
        skill: skillPda,
        author: creatorAgentPda,
        protocolConfig: protocolPda,
        authority: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc({ skipPreflight: true });

    await program.methods
      .updateSkill(
        Array.from(updatedContentHash),
        new BN(updatedPrice),
        Array.from(updatedTags),
        true,
      )
      .accountsPartial({
        skill: skillPda,
        author: creatorAgentPda,
        protocolConfig: protocolPda,
        authority: creator.publicKey,
      })
      .signers([creator])
      .rpc({ skipPreflight: true });

    await program.methods
      .purchaseSkill(new BN(updatedPrice))
      .accountsPartial({
        skill: skillPda,
        purchaseRecord: purchasePda,
        buyer: buyerAgentPda,
        authorAgent: creatorAgentPda,
        authorWallet: creator.publicKey,
        protocolConfig: protocolPda,
        treasury: secondSigner.publicKey,
        authority: buyer.publicKey,
        systemProgram: SystemProgram.programId,
        priceMint: null,
        buyerTokenAccount: null,
        authorTokenAccount: null,
        treasuryTokenAccount: null,
        tokenProgram: null,
      })
      .signers([buyer])
      .rpc({ skipPreflight: true });

    await program.methods
      .rateSkill(5, createHash("coverage-skill-review"))
      .accountsPartial({
        skill: skillPda,
        ratingAccount: ratingPda,
        rater: buyerAgentPda,
        purchaseRecord: purchasePda,
        protocolConfig: protocolPda,
        authority: buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer])
      .rpc({ skipPreflight: true });

    const skill = await program.account.skillRegistration.fetch(skillPda);
    expect(skill.price.toNumber()).to.equal(updatedPrice);
    expect(skill.version).to.equal(2);
    expect(skill.downloadCount).to.equal(1);
    expect(skill.ratingCount).to.equal(1);
  });

  it("covers update_protocol_fee, update_treasury, and update_multisig", async () => {
    await program.methods
      .updateProtocolFee(150)
      .accountsPartial({ protocolConfig: protocolPda })
      .remainingAccounts(multisigRemainingAccounts())
      .signers([secondSigner, thirdSigner])
      .rpc({ skipPreflight: true });

    let config = await program.account.protocolConfig.fetch(protocolPda);
    expect(config.protocolFeeBps).to.equal(150);

    await program.methods
      .updateTreasury()
      .accountsPartial({
        protocolConfig: protocolPda,
        newTreasury: creatorAgentPda,
      })
      .remainingAccounts(multisigRemainingAccounts())
      .signers([secondSigner, thirdSigner])
      .rpc({ skipPreflight: true });

    config = await program.account.protocolConfig.fetch(protocolPda);
    expect(config.treasury.toBase58()).to.equal(creatorAgentPda.toBase58());

    const newOwners = [
      secondSigner.publicKey,
      thirdSigner.publicKey,
      newMultisigOwner.publicKey,
    ];

    await program.methods
      .updateMultisig(2, newOwners)
      .accountsPartial({
        protocolConfig: protocolPda,
      })
      .remainingAccounts(multisigRemainingAccounts())
      .signers([secondSigner, thirdSigner])
      .rpc({ skipPreflight: true });

    config = await program.account.protocolConfig.fetch(protocolPda);
    expect(config.multisigThreshold).to.equal(2);
    expect(config.multisigOwnersLen).to.equal(3);

    const configuredOwners = config.multisigOwners
      .slice(0, config.multisigOwnersLen)
      .map((pubkey) => pubkey.toBase58());
    expect(configuredOwners).to.deep.equal(newOwners.map((pubkey) => pubkey.toBase58()));
  });
});
