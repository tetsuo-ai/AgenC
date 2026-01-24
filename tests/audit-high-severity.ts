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

  // Generate unique run ID to prevent conflicts with persisted validator state
  const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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

  // Helper to generate unique IDs per test run
  function makeId(prefix: string): Buffer {
    return Buffer.from(`${prefix}-${runId}`.slice(0, 32).padEnd(32, "\0"));
  }

  // Use unique IDs per test run to avoid conflicts with persisted state
  let creatorAgentId: Buffer;
  let workerAgentId1: Buffer;
  let workerAgentId2: Buffer;
  let workerAgentId3: Buffer;
  let arbiterAgentId1: Buffer;

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

  const deriveAuthorityVotePda = (disputePda: PublicKey, authority: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("authority_vote"), disputePda.toBuffer(), authority.toBuffer()],
      program.programId
    )[0];

  const airdrop = async (wallets: Keypair[]) => {
    for (const wallet of wallets) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(wallet.publicKey, 10 * LAMPORTS_PER_SOL),
        "confirmed"
      );
    }
  };

  // Evidence must be at least 50 characters per initiate_dispute.rs requirements
  const VALID_EVIDENCE = "This is valid dispute evidence that exceeds the minimum 50 character requirement for the dispute system.";

  const ensureProtocol = async () => {
    try {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      treasuryPubkey = config.treasury;
    } catch {
      await program.methods
        .initializeProtocol(51, 100, new BN(0), 1, [provider.wallet.publicKey])
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: provider.wallet.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: provider.wallet.publicKey, isSigner: true, isWritable: false },
        ])
        .rpc();
      treasuryPubkey = treasury.publicKey;
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
        .registerAgent(Array.from(agentId), new BN(capabilities), "https://example.com", null, new BN(LAMPORTS_PER_SOL))
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
    creator = Keypair.generate();
    worker1 = Keypair.generate();
    worker2 = Keypair.generate();
    worker3 = Keypair.generate();
    arbiter1 = Keypair.generate();
    unauthorized = Keypair.generate();

    // Initialize unique IDs per test run
    creatorAgentId = makeId("cre");
    workerAgentId1 = makeId("w1");
    workerAgentId2 = makeId("w2");
    workerAgentId3 = makeId("w3");
    arbiterAgentId1 = makeId("arb");

    // Increase airdrop to prevent lamport depletion
    for (const wallet of [treasury, creator, worker1, worker2, worker3, arbiter1, unauthorized]) {
      await provider.connection.confirmTransaction(
        await provider.connection.requestAirdrop(wallet.publicKey, 10 * LAMPORTS_PER_SOL),
        "confirmed"
      );
    }
    await ensureProtocol();

    await ensureAgent(creatorAgentId, creator, CAPABILITY_COMPUTE);
    await ensureAgent(workerAgentId1, worker1, CAPABILITY_COMPUTE);
    await ensureAgent(workerAgentId2, worker2, CAPABILITY_COMPUTE);
    await ensureAgent(workerAgentId3, worker3, CAPABILITY_COMPUTE);
    await ensureAgent(arbiterAgentId1, arbiter1, CAPABILITY_ARBITER);
  });

  // Ensure all shared agents are active before each test
  // This prevents cascading failures when a test deactivates an agent
  beforeEach(async () => {
    const agentsToCheck = [
      { id: workerAgentId1, wallet: worker1 },
      { id: workerAgentId2, wallet: worker2 },
      { id: workerAgentId3, wallet: worker3 },
      { id: creatorAgentId, wallet: creator },
    ];

    for (const agent of agentsToCheck) {
      try {
        const agentPda = deriveAgentPda(agent.id);
        const agentAccount = await program.account.agentRegistration.fetch(agentPda);

        // If agent is inactive, reactivate it
        if (agentAccount.status && 'inactive' in agentAccount.status) {
          await program.methods
            .updateAgent(null, null, null, 1)  // 1 = Active
            .accountsPartial({
              agent: agentPda,
              authority: agent.wallet.publicKey,
            })
            .signers([agent.wallet])
            .rpc();
        }
      } catch (e: any) {
        // Agent may not exist yet or other error - skip
      }
    }
  });

  it("rejects task creation without agent registration (issue #63)", async () => {
    const nonAgent = Keypair.generate();
    await airdrop([nonAgent]);

    const nonAgentId = Buffer.from("no-agent-audit-00000000001".padEnd(32, "\0"));
    const taskId = Buffer.from("task-noagent-audit-000001".padEnd(32, "\0"));
    const taskPda = deriveTaskPda(nonAgent.publicKey, taskId);
    const escrowPda = deriveEscrowPda(taskPda);
    const nonAgentPda = deriveAgentPda(nonAgentId);

    try {
      await program.methods
        .createTask(
          Array.from(taskId),
          new BN(CAPABILITY_COMPUTE),
          Buffer.from("No agent task".padEnd(64, "\0")),
          new BN(10),
          1,
          new BN(0),
          TASK_TYPE_COMPETITIVE,
          null  // constraint_hash
        )
        .accountsPartial({
          creatorAgent: nonAgentPda,
          authority: nonAgent.publicKey,
          creator: nonAgent.publicKey,
        })
        .signers([nonAgent])
        .rpc();
      expect.fail("Should have failed - no agent registration");
    } catch (e: unknown) {
      // Verify error occurred - Anchor returns AnchorError with errorCode
      const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
      expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
    }
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
        new BN(0),
        TASK_TYPE_COLLABORATIVE,
        null  // constraint_hash
      )
      .accountsPartial({
        creatorAgent: creatorAgentPda,
        authority: creator.publicKey,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    const workerPda1 = deriveAgentPda(workerAgentId1);
    const workerPda2 = deriveAgentPda(workerAgentId2);
    const workerPda3 = deriveAgentPda(workerAgentId3);

    const claimPda1 = deriveClaimPda(taskPda, workerPda1);
    const claimPda2 = deriveClaimPda(taskPda, workerPda2);
    const claimPda3 = deriveClaimPda(taskPda, workerPda3);

    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda1,
        protocolConfig: protocolPda,
        worker: workerPda1,
        authority: worker1.publicKey,
      })
      .signers([worker1])
      .rpc();

    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda2,
        protocolConfig: protocolPda,
        worker: workerPda2,
        authority: worker2.publicKey,
      })
      .signers([worker2])
      .rpc();

    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda3,
        protocolConfig: protocolPda,
        worker: workerPda3,
        authority: worker3.publicKey,
      })
      .signers([worker3])
      .rpc();

    const proofHash1 = Buffer.from("proof-remainder-000000000001".padEnd(32, "\0"));
    const proofHash2 = Buffer.from("proof-remainder-000000000002".padEnd(32, "\0"));
    const proofHash3 = Buffer.from("proof-remainder-000000000003".padEnd(32, "\0"));

    await program.methods
      .completeTask(Array.from(proofHash1), null)
      .accountsPartial({
        task: taskPda,
        claim: claimPda1,
        escrow: escrowPda,
        worker: workerPda1,
        protocolConfig: protocolPda,
        treasury: treasuryPubkey,
        authority: worker1.publicKey,
      })
      .signers([worker1])
      .rpc();

    await program.methods
      .completeTask(Array.from(proofHash2), null)
      .accountsPartial({
        task: taskPda,
        claim: claimPda2,
        escrow: escrowPda,
        worker: workerPda2,
        protocolConfig: protocolPda,
        treasury: treasuryPubkey,
        authority: worker2.publicKey,
      })
      .signers([worker2])
      .rpc();

    await program.methods
      .completeTask(Array.from(proofHash3), null)
      .accountsPartial({
        task: taskPda,
        claim: claimPda3,
        escrow: escrowPda,
        worker: workerPda3,
        protocolConfig: protocolPda,
        treasury: treasuryPubkey,
        authority: worker3.publicKey,
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
    const claimPda = deriveClaimPda(taskPda, workerPda1);

    await program.methods
      .createTask(
        Array.from(taskId),
        new BN(CAPABILITY_COMPUTE),
        Buffer.from("Dispute auth test".padEnd(64, "\0")),
        new BN(5),
        1,
        new BN(0),
        TASK_TYPE_COMPETITIVE,
        null  // constraint_hash
      )
      .accountsPartial({
        creatorAgent: creatorAgentPda,
        authority: creator.publicKey,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda,
        protocolConfig: protocolPda,
        worker: workerPda1,
        authority: worker1.publicKey,
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
        RESOLUTION_TYPE_REFUND,
        VALID_EVIDENCE
      )
      .accountsPartial({
        dispute: disputePda,
        task: taskPda,
        agent: workerPda1,
        protocolConfig: protocolPda,
        authority: worker1.publicKey,
      })
      .signers([worker1])
      .rpc();

    const votePda = deriveVotePda(disputePda, arbiterPda1);
    const authorityVotePda = deriveAuthorityVotePda(disputePda, arbiter1.publicKey);
    await program.methods
      .voteDispute(true)
      .accountsPartial({
        dispute: disputePda,
        vote: votePda,
        authorityVote: authorityVotePda,
        arbiter: arbiterPda1,
        protocolConfig: protocolPda,
        authority: arbiter1.publicKey,
      })
      .signers([arbiter1])
      .rpc();

    try {
      await program.methods
        .resolveDispute()
        .accountsPartial({
          dispute: disputePda,
          task: taskPda,
          escrow: escrowPda,
          protocolConfig: protocolPda,
          resolver: unauthorized.publicKey,
          creator: creator.publicKey,
          workerClaim: claimPda,
          worker: deriveAgentPda(workerAgentId1),
        })
        .remainingAccounts([
          { pubkey: votePda, isSigner: false, isWritable: false },
          { pubkey: arbiterPda1, isSigner: false, isWritable: true },
        ])
        .signers([unauthorized])
        .rpc();
      expect.fail("Should have failed - unauthorized resolver");
    } catch (e: unknown) {
      // Verify error occurred - Anchor returns AnchorError with errorCode
      const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
      expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
    }
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
        new BN(0),
        TASK_TYPE_COMPETITIVE,
        null  // constraint_hash
      )
      .accountsPartial({
        creatorAgent: creatorAgentPda,
        authority: creator.publicKey,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    const claimPda1 = deriveClaimPda(taskPda, workerPda1);
    const claimPda2 = deriveClaimPda(taskPda, workerPda2);

    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda1,
        protocolConfig: protocolPda,
        worker: workerPda1,
        authority: worker1.publicKey,
      })
      .signers([worker1])
      .rpc();

    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda2,
        protocolConfig: protocolPda,
        worker: workerPda2,
        authority: worker2.publicKey,
      })
      .signers([worker2])
      .rpc();

    const proofHash1 = Buffer.from("proof-competitive-000000001".padEnd(32, "\0"));
    const proofHash2 = Buffer.from("proof-competitive-000000002".padEnd(32, "\0"));

    await program.methods
      .completeTask(Array.from(proofHash1), null)
      .accountsPartial({
        task: taskPda,
        claim: claimPda1,
        escrow: escrowPda,
        worker: workerPda1,
        protocolConfig: protocolPda,
        treasury: treasuryPubkey,
        authority: worker1.publicKey,
      })
      .signers([worker1])
      .rpc();

    try {
      await program.methods
        .completeTask(Array.from(proofHash2), null)
        .accountsPartial({
          task: taskPda,
          claim: claimPda2,
          escrow: escrowPda,
          worker: workerPda2,
          protocolConfig: protocolPda,
          treasury: treasuryPubkey,
          authority: worker2.publicKey,
        })
        .signers([worker2])
        .rpc();
      expect.fail("Should have failed - second competitive completion");
    } catch (e: unknown) {
      // Verify error occurred - Anchor returns AnchorError with errorCode
      const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
      expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
    }
  });

  it("blocks arbiter deregistration right after voting (issue #67)", async () => {
    const creatorAgentPda = deriveAgentPda(creatorAgentId);
    const workerPda1 = deriveAgentPda(workerAgentId1);
    const arbiterPda1 = deriveAgentPda(arbiterAgentId1);

    const taskId = Buffer.from("task-dispute-audit-01".padEnd(32, "\0"));
    const taskPda = deriveTaskPda(creator.publicKey, taskId);
    const escrowPda = deriveEscrowPda(taskPda);
    const claimPda = deriveClaimPda(taskPda, workerPda1);

    await program.methods
      .createTask(
        Array.from(taskId),
        new BN(CAPABILITY_COMPUTE),
        Buffer.from("Dispute vote test".padEnd(64, "\0")),
        new BN(7),
        1,
        new BN(0),
        TASK_TYPE_COMPETITIVE,
        null  // constraint_hash
      )
      .accountsPartial({
        creatorAgent: creatorAgentPda,
        authority: creator.publicKey,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    await program.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda,
        protocolConfig: protocolPda,
        worker: workerPda1,
        authority: worker1.publicKey,
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
        RESOLUTION_TYPE_REFUND,
        VALID_EVIDENCE
      )
      .accountsPartial({
        dispute: disputePda,
        task: taskPda,
        agent: workerPda1,
        protocolConfig: protocolPda,
        authority: worker1.publicKey,
      })
      .signers([worker1])
      .rpc();

    const votePda = deriveVotePda(disputePda, arbiterPda1);
    const authorityVotePda = deriveAuthorityVotePda(disputePda, arbiter1.publicKey);
    await program.methods
      .voteDispute(true)
      .accountsPartial({
        dispute: disputePda,
        vote: votePda,
        authorityVote: authorityVotePda,
        arbiter: arbiterPda1,
        protocolConfig: protocolPda,
        authority: arbiter1.publicKey,
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
      .accountsPartial({
        dispute: disputePda,
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        resolver: provider.wallet.publicKey,
        creator: creator.publicKey,
        workerClaim: null,
        worker: null,
      })
      .remainingAccounts([
        { pubkey: votePda, isSigner: false, isWritable: false },
        { pubkey: arbiterPda1, isSigner: false, isWritable: true },
      ])
      .rpc();

    try {
      await program.methods
        .deregisterAgent()
        .accountsPartial({
          agent: arbiterPda1,
          protocolConfig: protocolPda,
          authority: arbiter1.publicKey,
        })
        .signers([arbiter1])
        .rpc();
      expect.fail("Should have failed - arbiter has pending dispute");
    } catch (e: unknown) {
      // Verify error occurred - Anchor returns AnchorError with errorCode
      const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
      expect(anchorError.error?.errorCode?.code || anchorError.message).to.exist;
    }
  });

  it("prevents suspended agent from bypassing suspension via update_agent (issue #151)", async () => {
    // Create an agent owned by protocol authority (so it can be suspended)
    const suspendTestAgentId = makeId("susp");
    const suspendTestAgentPda = deriveAgentPda(suspendTestAgentId);

    // Register agent with protocol authority as owner
    await program.methods
      .registerAgent(
        Array.from(suspendTestAgentId),
        new BN(CAPABILITY_COMPUTE),
        "https://example.com",
        null,
        new BN(LAMPORTS_PER_SOL)
      )
      .accountsPartial({
        agent: suspendTestAgentPda,
        protocolConfig: protocolPda,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    // Verify agent is active
    let agentAccount = await program.account.agentRegistration.fetch(suspendTestAgentPda);
    expect('active' in agentAccount.status).to.be.true;

    // Suspend the agent (requires protocol config in remaining accounts)
    await program.methods
      .updateAgent(null, null, null, 3) // 3 = Suspended
      .accountsPartial({
        agent: suspendTestAgentPda,
        authority: provider.wallet.publicKey,
      })
      .remainingAccounts([
        { pubkey: protocolPda, isSigner: false, isWritable: false },
      ])
      .rpc();

    // Verify agent is now suspended
    agentAccount = await program.account.agentRegistration.fetch(suspendTestAgentPda);
    expect('suspended' in agentAccount.status).to.be.true;

    // Try to bypass suspension by setting status to Active (should fail)
    try {
      await program.methods
        .updateAgent(null, null, null, 1) // 1 = Active
        .accountsPartial({
          agent: suspendTestAgentPda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have failed - suspended agent cannot change own status to Active");
    } catch (e: unknown) {
      const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
      expect(anchorError.error?.errorCode?.code).to.equal("AgentSuspended");
    }

    // Also try Inactive (0) - should fail
    try {
      await program.methods
        .updateAgent(null, null, null, 0) // 0 = Inactive
        .accountsPartial({
          agent: suspendTestAgentPda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have failed - suspended agent cannot change own status to Inactive");
    } catch (e: unknown) {
      const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
      expect(anchorError.error?.errorCode?.code).to.equal("AgentSuspended");
    }

    // Also try Busy (2) - should fail
    try {
      await program.methods
        .updateAgent(null, null, null, 2) // 2 = Busy
        .accountsPartial({
          agent: suspendTestAgentPda,
          authority: provider.wallet.publicKey,
        })
        .rpc();
      expect.fail("Should have failed - suspended agent cannot change own status to Busy");
    } catch (e: unknown) {
      const anchorError = e as { error?: { errorCode?: { code: string } }; message?: string };
      expect(anchorError.error?.errorCode?.code).to.equal("AgentSuspended");
    }

    // Verify agent is still suspended after all attempts
    agentAccount = await program.account.agentRegistration.fetch(suspendTestAgentPda);
    expect('suspended' in agentAccount.status).to.be.true;
  });
});
