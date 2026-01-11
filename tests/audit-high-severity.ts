import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";

describe("audit-high-severity", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );

  const CAPABILITY_COMPUTE = 1 << 0;
  const CAPABILITY_ARBITER = 1 << 7;
  const TASK_TYPE_COLLABORATIVE = 1;
  const TASK_TYPE_COMPETITIVE = 2;
  const RESOLUTION_TYPE_REFUND = 0;

  let treasury: Keypair;
  let treasuryPubkey: PublicKey;
  let creator: Keypair;
  let worker1: Keypair;
  let worker2: Keypair;
  let worker3: Keypair;
  let arbiter1: Keypair;
  let unauthorized: Keypair;

  const creatorAgentId = Buffer.from("creator-audit-000000000001".padEnd(32, "\0"));
  const workerAgentId1 = Buffer.from("worker-audit-000000000001".padEnd(32, "\0"));
  const workerAgentId2 = Buffer.from("worker-audit-000000000002".padEnd(32, "\0"));
  const workerAgentId3 = Buffer.from("worker-audit-000000000003".padEnd(32, "\0"));
  const arbiterAgentId1 = Buffer.from("arbiter-audit-000000000001".padEnd(32, "\0"));

  const deriveAgentPda = (agentId: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from("agent"), agentId], program.programId)[0];

  const deriveTaskPda = (creatorKey: PublicKey, taskId: Buffer) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("task"), creatorKey.toBuffer(), taskId],
      program.programId
    )[0];

  const deriveEscrowPda = (taskPda: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("escrow"), taskPda.toBuffer()], program.programId)[0];

  const deriveClaimPda = (taskPda: PublicKey, workerKey: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), taskPda.toBuffer(), workerKey.toBuffer()],
      program.programId
    )[0];

  const deriveVotePda = (disputePda: PublicKey, arbiterPda: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vote"), disputePda.toBuffer(), arbiterPda.toBuffer()],
      program.programId
    )[0];

  const airdrop = async (wallets: Keypair[]) => {
    for (const wallet of wallets) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL),
        "confirmed"
      );
    }
  };

  const ensureProtocol = async () => {
    try {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      treasuryPubkey = config.treasury;
    } catch {
      await program.methods
        .initializeProtocol(51, 100, 0)
        .accounts({
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      treasuryPubkey = treasury.publicKey;
    }
  };

  const ensureAgent = async (
    agentId: Buffer,
    authority: Keypair,
    capabilities: number
  ) => {
    const agentPda = deriveAgentPda(agentId);
    try {
      await program.account.agentRegistration.fetch(agentPda);
    } catch {
      await program.methods
        .registerAgent(Array.from(agentId), new BN(capabilities), "https://example.com", null)
        .accounts({
          agent: agentPda,
          protocolConfig: protocolPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([authority])
        .rpc();
    }
    return agentPda;
  };

  before(async () => {
    treasury = Keypair.generate();
    creator = Keypair.generate();
    worker1 = Keypair.generate();
    worker2 = Keypair.generate();
    worker3 = Keypair.generate();
    arbiter1 = Keypair.generate();
    unauthorized = Keypair.generate();

    await airdrop([treasury, creator, worker1, worker2, worker3, arbiter1, unauthorized]);
    await ensureProtocol();

    await ensureAgent(creatorAgentId, creator, CAPABILITY_COMPUTE);
    await ensureAgent(workerAgentId1, worker1, CAPABILITY_COMPUTE);
    await ensureAgent(workerAgentId2, worker2, CAPABILITY_COMPUTE);
    await ensureAgent(workerAgentId3, worker3, CAPABILITY_COMPUTE);
    await ensureAgent(arbiterAgentId1, arbiter1, CAPABILITY_ARBITER);
  });

  it("rejects task creation without agent registration (issue #63)", async () => {
    const nonAgent = Keypair.generate();
    await airdrop([nonAgent]);

    const nonAgentId = Buffer.from("no-agent-audit-00000000001".padEnd(32, "\0"));
    const taskId = Buffer.from("task-noagent-audit-000001".padEnd(32, "\0"));
    const taskPda = deriveTaskPda(nonAgent.publicKey, taskId);
    const escrowPda = deriveEscrowPda(taskPda);
    const nonAgentPda = deriveAgentPda(nonAgentId);

    await expect(
      program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("No agent task".padEnd(64, "\0")),
          new BN(10),
          1,
          0,
          TASK_TYPE_COMPETITIVE
        )
        .accounts({
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          creatorAgent: nonAgentPda,
          authority: nonAgent.publicKey,
          creator: nonAgent.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([nonAgent])
        .rpc()
    ).to.be.rejected;
  });

  it("pays remainder to last collaborative worker (issue #64)", async () => {
    const creatorAgentPda = deriveAgentPda(creatorAgentId);
    const taskId = Buffer.from("task-remainder-audit-01".padEnd(32, "\0"));
    const taskPda = deriveTaskPda(creator.publicKey, taskId);
    const escrowPda = deriveEscrowPda(taskPda);

    await program.methods
      .createTask(
        Array.from(taskId),
        new BN(CAPABILITY_COMPUTE),
        Buffer.from("Remainder task".padEnd(64, "\0")),
        new BN(10),
        3,
        0,
        TASK_TYPE_COLLABORATIVE
      )
      .accounts({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        creatorAgent: creatorAgentPda,
        authority: creator.publicKey,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const workerPda1 = deriveAgentPda(workerAgentId1);
    const workerPda2 = deriveAgentPda(workerAgentId2);
    const workerPda3 = deriveAgentPda(workerAgentId3);

    const claimPda1 = deriveClaimPda(taskPda, worker1.publicKey);
    const claimPda2 = deriveClaimPda(taskPda, worker2.publicKey);
    const claimPda3 = deriveClaimPda(taskPda, worker3.publicKey);

    await program.methods
      .claimTask()
      .accounts({
        task: taskPda,
        claim: claimPda1,
        protocolConfig: protocolPda,
        worker: workerPda1,
        authority: worker1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker1])
      .rpc();

    await program.methods
      .claimTask()
      .accounts({
        task: taskPda,
        claim: claimPda2,
        protocolConfig: protocolPda,
        worker: workerPda2,
        authority: worker2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker2])
      .rpc();

    await program.methods
      .claimTask()
      .accounts({
        task: taskPda,
        claim: claimPda3,
        protocolConfig: protocolPda,
        worker: workerPda3,
        authority: worker3.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker3])
      .rpc();

    const proofHash1 = Buffer.from("proof-remainder-000000000001".padEnd(32, "\0"));
    const proofHash2 = Buffer.from("proof-remainder-000000000002".padEnd(32, "\0"));
    const proofHash3 = Buffer.from("proof-remainder-000000000003".padEnd(32, "\0"));

    await program.methods
      .completeTask(Array.from(proofHash1), null)
      .accounts({
        task: taskPda,
        claim: claimPda1,
        escrow: escrowPda,
        worker: workerPda1,
        protocolConfig: protocolPda,
        treasury: treasuryPubkey,
        authority: worker1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker1])
      .rpc();

    await program.methods
      .completeTask(Array.from(proofHash2), null)
      .accounts({
        task: taskPda,
        claim: claimPda2,
        escrow: escrowPda,
        worker: workerPda2,
        protocolConfig: protocolPda,
        treasury: treasuryPubkey,
        authority: worker2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker2])
      .rpc();

    await program.methods
      .completeTask(Array.from(proofHash3), null)
      .accounts({
        task: taskPda,
        claim: claimPda3,
        escrow: escrowPda,
        worker: workerPda3,
        protocolConfig: protocolPda,
        treasury: treasuryPubkey,
        authority: worker3.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker3])
      .rpc();

    const claim1 = await program.account.taskClaim.fetch(claimPda1);
    const claim2 = await program.account.taskClaim.fetch(claimPda2);
    const claim3 = await program.account.taskClaim.fetch(claimPda3);

    expect(claim1.rewardPaid.toNumber()).to.equal(3);
    expect(claim2.rewardPaid.toNumber()).to.equal(3);
    expect(claim3.rewardPaid.toNumber()).to.equal(4);
  });

  it("rejects unauthorized dispute resolution (issue #65)", async () => {
    const creatorAgentPda = deriveAgentPda(creatorAgentId);
    const workerPda1 = deriveAgentPda(workerAgentId1);
    const arbiterPda1 = deriveAgentPda(arbiterAgentId1);

    const taskId = Buffer.from("task-unauth-resolve-01".padEnd(32, "\0"));
    const taskPda = deriveTaskPda(creator.publicKey, taskId);
    const escrowPda = deriveEscrowPda(taskPda);
    const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

    await program.methods
      .createTask(
        Array.from(taskId),
        new BN(CAPABILITY_COMPUTE),
        Buffer.from("Dispute auth test".padEnd(64, "\0")),
        new BN(5),
        1,
        0,
        TASK_TYPE_COMPETITIVE
      )
      .accounts({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        creatorAgent: creatorAgentPda,
        authority: creator.publicKey,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .claimTask()
      .accounts({
        task: taskPda,
        claim: claimPda,
        protocolConfig: protocolPda,
        worker: workerPda1,
        authority: worker1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker1])
      .rpc();

    const disputeId = Buffer.from("dispute-unauth-res-01".padEnd(32, "\0"));
    const [disputePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("dispute"), disputeId],
      program.programId
    );

    await program.methods
      .initiateDispute(
        Array.from(disputeId),
        Array.from(taskId),
        Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
        RESOLUTION_TYPE_REFUND
      )
      .accounts({
        dispute: disputePda,
        task: taskPda,
        agent: workerPda1,
        protocolConfig: protocolPda,
        authority: worker1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker1])
      .rpc();

    const votePda = deriveVotePda(disputePda, arbiterPda1);
    await program.methods
      .voteDispute(true)
      .accounts({
        dispute: disputePda,
        vote: votePda,
        arbiter: arbiterPda1,
        protocolConfig: protocolPda,
        authority: arbiter1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([arbiter1])
      .rpc();

    await expect(
      program.methods
        .resolveDispute()
        .accounts({
          dispute: disputePda,
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          resolver: unauthorized.publicKey,
          creator: creator.publicKey,
          workerClaim: claimPda,
          worker: worker1.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: votePda, isSigner: false, isWritable: false },
          { pubkey: arbiterPda1, isSigner: false, isWritable: true },
        ])
        .signers([unauthorized])
        .rpc()
    ).to.be.rejected;
  });

  it("rejects second competitive completion (issue #66)", async () => {
    const creatorAgentPda = deriveAgentPda(creatorAgentId);
    const workerPda1 = deriveAgentPda(workerAgentId1);
    const workerPda2 = deriveAgentPda(workerAgentId2);

    const taskId = Buffer.from("task-competitive-audit01".padEnd(32, "\0"));
    const taskPda = deriveTaskPda(creator.publicKey, taskId);
    const escrowPda = deriveEscrowPda(taskPda);

    await program.methods
      .createTask(
        Array.from(taskId),
        new BN(CAPABILITY_COMPUTE),
        Buffer.from("Competitive audit".padEnd(64, "\0")),
        new BN(9),
        2,
        0,
        TASK_TYPE_COMPETITIVE
      )
      .accounts({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        creatorAgent: creatorAgentPda,
        authority: creator.publicKey,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const claimPda1 = deriveClaimPda(taskPda, worker1.publicKey);
    const claimPda2 = deriveClaimPda(taskPda, worker2.publicKey);

    await program.methods
      .claimTask()
      .accounts({
        task: taskPda,
        claim: claimPda1,
        protocolConfig: protocolPda,
        worker: workerPda1,
        authority: worker1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker1])
      .rpc();

    await program.methods
      .claimTask()
      .accounts({
        task: taskPda,
        claim: claimPda2,
        protocolConfig: protocolPda,
        worker: workerPda2,
        authority: worker2.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker2])
      .rpc();

    const proofHash1 = Buffer.from("proof-competitive-000000001".padEnd(32, "\0"));
    const proofHash2 = Buffer.from("proof-competitive-000000002".padEnd(32, "\0"));

    await program.methods
      .completeTask(Array.from(proofHash1), null)
      .accounts({
        task: taskPda,
        claim: claimPda1,
        escrow: escrowPda,
        worker: workerPda1,
        protocolConfig: protocolPda,
        treasury: treasuryPubkey,
        authority: worker1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker1])
      .rpc();

    await expect(
      program.methods
        .completeTask(Array.from(proofHash2), null)
        .accounts({
          task: taskPda,
          claim: claimPda2,
          escrow: escrowPda,
          worker: workerPda2,
          protocolConfig: protocolPda,
          treasury: treasuryPubkey,
          authority: worker2.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([worker2])
        .rpc()
    ).to.be.rejected;
  });

  it("blocks arbiter deregistration right after voting (issue #67)", async () => {
    const creatorAgentPda = deriveAgentPda(creatorAgentId);
    const workerPda1 = deriveAgentPda(workerAgentId1);
    const arbiterPda1 = deriveAgentPda(arbiterAgentId1);

    const taskId = Buffer.from("task-dispute-audit-01".padEnd(32, "\0"));
    const taskPda = deriveTaskPda(creator.publicKey, taskId);
    const escrowPda = deriveEscrowPda(taskPda);
    const claimPda = deriveClaimPda(taskPda, worker1.publicKey);

    await program.methods
      .createTask(
        Array.from(taskId),
        new BN(CAPABILITY_COMPUTE),
        Buffer.from("Dispute vote test".padEnd(64, "\0")),
        new BN(7),
        1,
        0,
        TASK_TYPE_COMPETITIVE
      )
      .accounts({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        creatorAgent: creatorAgentPda,
        authority: creator.publicKey,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .claimTask()
      .accounts({
        task: taskPda,
        claim: claimPda,
        protocolConfig: protocolPda,
        worker: workerPda1,
        authority: worker1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker1])
      .rpc();

    const disputeId = Buffer.from("dispute-deregister-01".padEnd(32, "\0"));
    const [disputePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("dispute"), disputeId],
      program.programId
    );

    await program.methods
      .initiateDispute(
        Array.from(disputeId),
        Array.from(taskId),
        Array.from(Buffer.from("evidence".padEnd(32, "\0"))),
        RESOLUTION_TYPE_REFUND
      )
      .accounts({
        dispute: disputePda,
        task: taskPda,
        agent: workerPda1,
        protocolConfig: protocolPda,
        authority: worker1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker1])
      .rpc();

    const votePda = deriveVotePda(disputePda, arbiterPda1);
    await program.methods
      .voteDispute(true)
      .accounts({
        dispute: disputePda,
        vote: votePda,
        arbiter: arbiterPda1,
        protocolConfig: protocolPda,
        authority: arbiter1.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([arbiter1])
      .rpc();

    const dispute = await program.account.dispute.fetch(disputePda);
    const now = Math.floor(Date.now() / 1000);
    const waitMs = Math.max(0, (dispute.votingDeadline.toNumber() - now + 1) * 1000);
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    await program.methods
      .resolveDispute()
      .accounts({
        dispute: disputePda,
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        resolver: provider.wallet.publicKey,
        creator: creator.publicKey,
        workerClaim: null,
        worker: null,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts([
        { pubkey: votePda, isSigner: false, isWritable: false },
        { pubkey: arbiterPda1, isSigner: false, isWritable: true },
      ])
      .rpc();

    await expect(
      program.methods
        .deregisterAgent()
        .accounts({
          agent: arbiterPda1,
          protocolConfig: protocolPda,
          authority: arbiter1.publicKey,
        })
        .signers([arbiter1])
        .rpc()
    ).to.be.rejected;
  });
});
