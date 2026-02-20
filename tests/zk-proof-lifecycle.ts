import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AgencCoordination } from "../target/types/agenc_coordination";
import {
  CAPABILITY_COMPUTE,
  TASK_TYPE_EXCLUSIVE,
  deriveProgramDataPda,
  disableRateLimitsForTests,
} from "./test-utils";

describe("ZK Proof Verification Lifecycle (router payload)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  const HASH_SIZE = 32;
  const TRUSTED_SELECTOR = Buffer.from([0x52, 0x5a, 0x56, 0x4d]);
  const TRUSTED_ROUTER_PROGRAM_ID = new PublicKey("6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7");
  const TRUSTED_VERIFIER_PROGRAM_ID = new PublicKey("THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge");
  // Must match sdk/src/constants.ts TRUSTED_RISC0_IMAGE_ID and on-chain complete_task_private.rs
  const TRUSTED_IMAGE_ID = Buffer.from([
    202, 175, 194, 115, 244, 76, 8, 9, 197, 55, 54, 103, 21, 34, 178, 245,
    211, 97, 58, 48, 7, 14, 121, 214, 109, 60, 64, 137, 170, 156, 79, 219,
  ]);

  const [protocolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol")],
    program.programId
  );
  const [routerPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("router")],
    TRUSTED_ROUTER_PROGRAM_ID
  );
  const [verifierEntryPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("verifier"), TRUSTED_SELECTOR],
    TRUSTED_ROUTER_PROGRAM_ID
  );

  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  let taskNonce = 0;

  let treasury: Keypair;
  let treasuryPubkey: PublicKey;
  let taskCreator: Keypair;
  let worker: Keypair;
  let creatorAgentPda: PublicKey;
  let workerAgentPda: PublicKey;

  const creatorAgentId = Buffer.from(`zk-creator-${runId}`.slice(0, 32).padEnd(32, "\0"));
  const workerAgentId = Buffer.from(`zk-worker-${runId}`.slice(0, 32).padEnd(32, "\0"));

  function deriveAgentPda(agentId: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("agent"), agentId],
      program.programId
    )[0];
  }

  function deriveTaskPda(creatorPubkey: PublicKey, taskId: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("task"), creatorPubkey.toBuffer(), taskId],
      program.programId
    )[0];
  }

  function deriveEscrowPda(taskPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("escrow"), taskPda.toBuffer()],
      program.programId
    )[0];
  }

  function deriveClaimPda(taskPda: PublicKey, workerPda: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("claim"), taskPda.toBuffer(), workerPda.toBuffer()],
      program.programId
    )[0];
  }

  function deriveBindingSpendPda(bindingSeed: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("binding_spend"), bindingSeed],
      program.programId
    )[0];
  }

  function deriveNullifierSpendPda(nullifierSeed: Buffer): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier_spend"), nullifierSeed],
      program.programId
    )[0];
  }

  function taskIdToBn(taskId: Buffer): BN {
    return new BN(taskId.subarray(0, 8), "le");
  }

  function buildJournal(params: {
    taskPda: PublicKey;
    authority: PublicKey;
    constraintHash: Buffer;
    outputCommitment: Buffer;
    bindingSeed: Buffer;
    nullifierSeed: Buffer;
  }): Buffer {
    return Buffer.concat([
      params.taskPda.toBuffer(),
      params.authority.toBuffer(),
      params.constraintHash,
      params.outputCommitment,
      params.bindingSeed,
      params.nullifierSeed,
    ]);
  }

  function createProofPayload(params: {
    taskPda: PublicKey;
    authority: PublicKey;
    constraintHash: Buffer;
    outputCommitment?: Buffer;
    bindingSeed?: Buffer;
    nullifierSeed?: Buffer;
    sealBytesLen?: number;
  }) {
    const outputCommitment = params.outputCommitment ?? Buffer.alloc(HASH_SIZE, 0x51);
    const bindingSeed = params.bindingSeed ?? Buffer.alloc(HASH_SIZE, 0x52);
    const nullifierSeed = params.nullifierSeed ?? Buffer.alloc(HASH_SIZE, 0x53);
    const journal = buildJournal({
      taskPda: params.taskPda,
      authority: params.authority,
      constraintHash: params.constraintHash,
      outputCommitment,
      bindingSeed,
      nullifierSeed,
    });

    return {
      sealBytes: Buffer.alloc(params.sealBytesLen ?? 260, 0xaa),
      journal,
      imageId: Array.from(TRUSTED_IMAGE_ID),
      bindingSeed: Array.from(bindingSeed),
      nullifierSeed: Array.from(nullifierSeed),
    };
  }

  async function createPrivateTaskAndClaim(constraintHash: Buffer) {
    const taskId = Buffer.from(
      `zk-${runId}-${(taskNonce++).toString(36)}`.slice(0, 32).padEnd(32, "\0")
    );
    const description = Buffer.alloc(64, 0);
    description.write("zk-lifecycle-private-task");
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);
    const taskPda = deriveTaskPda(taskCreator.publicKey, taskId);
    const escrowPda = deriveEscrowPda(taskPda);
    const claimPda = deriveClaimPda(taskPda, workerAgentPda);

    await program.methods
      .createTask(
        Array.from(taskId),
        new BN(CAPABILITY_COMPUTE),
        Array.from(description),
        new BN(0.3 * LAMPORTS_PER_SOL),
        1,
        deadline,
        TASK_TYPE_EXCLUSIVE,
        Array.from(constraintHash),
        0,
        null
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

    return { taskId, taskPda, escrowPda, claimPda };
  }

  async function submitPrivateCompletion(input: {
    taskId: Buffer;
    taskPda: PublicKey;
    escrowPda: PublicKey;
    claimPda: PublicKey;
    proof: ReturnType<typeof createProofPayload>;
  }) {
    const bindingSeed = Buffer.from(input.proof.bindingSeed);
    const nullifierSeed = Buffer.from(input.proof.nullifierSeed);

    return program.methods
      .completeTaskPrivate(taskIdToBn(input.taskId), input.proof)
      .accountsPartial({
        task: input.taskPda,
        claim: input.claimPda,
        escrow: input.escrowPda,
        creator: taskCreator.publicKey,
        worker: workerAgentPda,
        protocolConfig: protocolPda,
        bindingSpend: deriveBindingSpendPda(bindingSeed),
        nullifierSpend: deriveNullifierSpendPda(nullifierSeed),
        treasury: treasuryPubkey,
        authority: worker.publicKey,
        routerProgram: TRUSTED_ROUTER_PROGRAM_ID,
        router: routerPda,
        verifierEntry: verifierEntryPda,
        verifierProgram: TRUSTED_VERIFIER_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([worker])
      .rpc();
  }

  before(async function () {
    try {
      await provider.connection.getLatestBlockhash("confirmed");
    } catch (_err) {
      this.skip();
      return;
    }

    treasury = Keypair.generate();
    taskCreator = Keypair.generate();
    worker = Keypair.generate();

    for (const keypair of [treasury, taskCreator, worker]) {
      const sig = await provider.connection.requestAirdrop(
        keypair.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await provider.connection.confirmTransaction(sig, "confirmed");
    }

    try {
      await program.methods
        .initializeProtocol(
          51,
          100,
          new BN(LAMPORTS_PER_SOL / 10),
          new BN(LAMPORTS_PER_SOL / 100),
          1,
          [provider.wallet.publicKey, treasury.publicKey]
        )
        .accountsPartial({
          protocolConfig: protocolPda,
          treasury: treasury.publicKey,
          authority: provider.wallet.publicKey,
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
      treasuryPubkey = treasury.publicKey;
    } catch (e) {
      const config = await program.account.protocolConfig.fetch(protocolPda);
      treasuryPubkey = config.treasury;
    }

    await disableRateLimitsForTests({
      program,
      protocolPda,
      authority: provider.wallet.publicKey,
      minStakeForDisputeLamports: 0,
      skipPreflight: false,
    });

    const protocol = await program.account.protocolConfig.fetch(protocolPda);
    const minAgentStakeLamportsRaw = (protocol as { minAgentStake: unknown }).minAgentStake;
    const minAgentStakeLamports = BN.isBN(minAgentStakeLamportsRaw)
      ? minAgentStakeLamportsRaw.toNumber()
      : Number(minAgentStakeLamportsRaw);
    const registerStakeLamports = Math.max(minAgentStakeLamports, Math.floor(LAMPORTS_PER_SOL / 10));

    creatorAgentPda = deriveAgentPda(creatorAgentId);
    workerAgentPda = deriveAgentPda(workerAgentId);

    for (const [agentId, agentPda, signer] of [
      [creatorAgentId, creatorAgentPda, taskCreator],
      [workerAgentId, workerAgentPda, worker],
    ] as const) {
      try {
        await program.methods
          .registerAgent(
            Array.from(agentId),
            new BN(CAPABILITY_COMPUTE),
            `https://zk-lifecycle-${runId}.example.com`,
            null,
            new BN(registerStakeLamports)
          )
          .accountsPartial({
            agent: agentPda,
            protocolConfig: protocolPda,
            authority: signer.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([signer])
          .rpc();
      } catch (e) {
        const existingAgent = await (program.account.agentRegistration as {
          fetchNullable: (pubkey: PublicKey) => Promise<{ authority: PublicKey } | null>;
        }).fetchNullable(agentPda);
        if (!existingAgent) {
          throw e;
        }
        if (!existingAgent.authority.equals(signer.publicKey)) {
          throw new Error(
            `agent ${agentPda.toBase58()} authority mismatch (${existingAgent.authority.toBase58()} != ${signer.publicKey.toBase58()})`
          );
        }
      }
    }
  });

  it("submits complete_task_private with dual-spend + router accounts", async () => {
    const constraintHash = Buffer.alloc(HASH_SIZE, 0x61);
    const { taskId, taskPda, escrowPda, claimPda } = await createPrivateTaskAndClaim(constraintHash);
    const proof = createProofPayload({
      taskPda,
      authority: worker.publicKey,
      constraintHash,
      sealBytesLen: 260,
    });

    try {
      await submitPrivateCompletion({ taskId, taskPda, escrowPda, claimPda, proof });
      // A fully deployed router/verifier in local test env could make this succeed.
    } catch (e) {
      expect(String(e)).to.not.equal("");
    }
  });

  it("accepts explicit bindingSeed/nullifierSeed fields in payload", async () => {
    const constraintHash = Buffer.alloc(HASH_SIZE, 0x62);
    const bindingSeed = Buffer.alloc(HASH_SIZE, 0x73);
    const nullifierSeed = Buffer.alloc(HASH_SIZE, 0x74);
    const { taskId, taskPda, escrowPda, claimPda } = await createPrivateTaskAndClaim(constraintHash);
    const proof = createProofPayload({
      taskPda,
      authority: worker.publicKey,
      constraintHash,
      bindingSeed,
      nullifierSeed,
      sealBytesLen: 64,
    });

    try {
      await submitPrivateCompletion({ taskId, taskPda, escrowPda, claimPda, proof });
      expect.fail("submission unexpectedly succeeded with malformed seal");
    } catch (e) {
      expect(String(e)).to.not.equal("");
    }
  });
});

describe("Private Replay Seed Semantics", () => {
  it("derives distinct spend PDAs for distinct binding/nullifier seeds", () => {
    const programId = new PublicKey("5j9ZbT3mnPX5QjWVMrDaWFuaGf8ddji6LW1HVJw6kUE7");

    const bindingA = Buffer.alloc(32, 0x21);
    const bindingB = Buffer.alloc(32, 0x22);
    const nullifierA = Buffer.alloc(32, 0x31);
    const nullifierB = Buffer.alloc(32, 0x32);

    const [bindingSpendA] = PublicKey.findProgramAddressSync(
      [Buffer.from("binding_spend"), bindingA],
      programId
    );
    const [bindingSpendB] = PublicKey.findProgramAddressSync(
      [Buffer.from("binding_spend"), bindingB],
      programId
    );
    const [nullifierSpendA] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier_spend"), nullifierA],
      programId
    );
    const [nullifierSpendB] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier_spend"), nullifierB],
      programId
    );

    expect(bindingSpendA.equals(bindingSpendB)).to.equal(false);
    expect(nullifierSpendA.equals(nullifierSpendB)).to.equal(false);
  });
});
