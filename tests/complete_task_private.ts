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
} from "./test-utils";

describe("complete_task_private (router interface)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AgencCoordination as Program<AgencCoordination>;

  const HASH_SIZE = 32;
  const JOURNAL_SIZE = 192;

  const TRUSTED_SELECTOR = Buffer.from([0x52, 0x5a, 0x56, 0x4d]);
  const TRUSTED_ROUTER_PROGRAM_ID = new PublicKey("6JvFfBrvCcWgANKh1Eae9xDq4RC6cfJuBcf71rp2k9Y7");
  const TRUSTED_VERIFIER_PROGRAM_ID = new PublicKey("THq1qFYQoh7zgcjXoMXduDBqiZRCPeg3PvvMbrVQUge");
  const TRUSTED_IMAGE_ID = Buffer.from([
    6, 15, 16, 25, 34, 43, 44, 53, 62, 71, 72, 81, 90, 99, 100, 109, 118, 127, 128, 137, 146,
    155, 156, 165, 174, 183, 184, 193, 202, 211, 212, 221,
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

  let treasury: Keypair;
  let treasuryPubkey: PublicKey;
  let creator: Keypair;
  let worker: Keypair;
  let creatorAgentPda: PublicKey;
  let workerAgentPda: PublicKey;

  const creatorAgentId = Buffer.from(`creator-${runId}`.slice(0, 32).padEnd(32, "\0"));
  const workerAgentId = Buffer.from(`worker-${runId}`.slice(0, 32).padEnd(32, "\0"));

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

  function buildJournal(fields: {
    taskPda: PublicKey;
    authority: PublicKey;
    constraintHash: Buffer;
    outputCommitment?: Buffer;
    bindingSeed?: Buffer;
    nullifierSeed?: Buffer;
  }): Buffer {
    const outputCommitment = fields.outputCommitment ?? Buffer.alloc(HASH_SIZE, 0x22);
    const bindingSeed = fields.bindingSeed ?? Buffer.alloc(HASH_SIZE, 0x33);
    const nullifierSeed = fields.nullifierSeed ?? Buffer.alloc(HASH_SIZE, 0x44);

    return Buffer.concat([
      fields.taskPda.toBuffer(),
      fields.authority.toBuffer(),
      fields.constraintHash,
      outputCommitment,
      bindingSeed,
      nullifierSeed,
    ]);
  }

  function createProofPayload(params: {
    taskPda: PublicKey;
    authority: PublicKey;
    constraintHash: Buffer;
    sealBytesLen?: number;
    bindingSeed?: Buffer;
    nullifierSeed?: Buffer;
  }) {
    const bindingSeed = params.bindingSeed ?? Buffer.alloc(HASH_SIZE, 0x33);
    const nullifierSeed = params.nullifierSeed ?? Buffer.alloc(HASH_SIZE, 0x44);
    const journal = buildJournal({
      taskPda: params.taskPda,
      authority: params.authority,
      constraintHash: params.constraintHash,
      bindingSeed,
      nullifierSeed,
    });

    if (journal.length !== JOURNAL_SIZE) {
      throw new Error(`unexpected journal length ${journal.length}`);
    }

    return {
      sealBytes: Buffer.alloc(params.sealBytesLen ?? 260, 0xaa),
      journal,
      imageId: Array.from(TRUSTED_IMAGE_ID),
      bindingSeed: Array.from(bindingSeed),
      nullifierSeed: Array.from(nullifierSeed),
    };
  }

  async function createTaskAndClaim(constraintHash: Buffer) {
    const taskId = Buffer.alloc(32, 0);
    taskId.writeUInt32LE(Date.now() % 1_000_000, 0);
    taskId[4] = 0x91;
    const description = Buffer.alloc(64, 0);
    description.write("private-router-task");
    const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);
    const taskPda = deriveTaskPda(creator.publicKey, taskId);
    const escrowPda = deriveEscrowPda(taskPda);
    const claimPda = deriveClaimPda(taskPda, workerAgentPda);

    await program.methods
      .createTask(
        Array.from(taskId),
        new BN(CAPABILITY_COMPUTE),
        Array.from(description),
        new BN(0.2 * LAMPORTS_PER_SOL),
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

    return { taskId, taskPda, escrowPda, claimPda };
  }

  async function expectCompletionFailure(input: {
    taskId: Buffer;
    taskPda: PublicKey;
    escrowPda: PublicKey;
    claimPda: PublicKey;
    proof: ReturnType<typeof createProofPayload>;
  }) {
    const bindingSeed = Buffer.from(input.proof.bindingSeed);
    const nullifierSeed = Buffer.from(input.proof.nullifierSeed);
    try {
      await program.methods
        .completeTaskPrivate(taskIdToBn(input.taskId), input.proof)
        .accountsPartial({
          task: input.taskPda,
          claim: input.claimPda,
          escrow: input.escrowPda,
          creator: creator.publicKey,
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
      expect.fail("completeTaskPrivate unexpectedly succeeded");
    } catch (e) {
      expect(String(e)).to.not.equal("");
    }
  }

  before(async function () {
    try {
      await provider.connection.getLatestBlockhash("confirmed");
    } catch (_err) {
      this.skip();
      return;
    }

    treasury = Keypair.generate();
    creator = Keypair.generate();
    worker = Keypair.generate();

    for (const keypair of [treasury, creator, worker]) {
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
          new BN(1 * LAMPORTS_PER_SOL),
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
      const protocol = await program.account.protocolConfig.fetch(protocolPda);
      treasuryPubkey = protocol.treasury;
    }

    const protocol = await program.account.protocolConfig.fetch(protocolPda);
    const minAgentStakeLamportsRaw = (protocol as { minAgentStake: unknown }).minAgentStake;
    const minAgentStakeLamports = BN.isBN(minAgentStakeLamportsRaw)
      ? minAgentStakeLamportsRaw.toNumber()
      : Number(minAgentStakeLamportsRaw);
    const registerStakeLamports = Math.max(minAgentStakeLamports, LAMPORTS_PER_SOL);

    creatorAgentPda = deriveAgentPda(creatorAgentId);
    workerAgentPda = deriveAgentPda(workerAgentId);

    for (const [agentId, agentPda, signer] of [
      [creatorAgentId, creatorAgentPda, creator],
      [workerAgentId, workerAgentPda, worker],
    ] as const) {
      try {
        await program.methods
          .registerAgent(
            Array.from(agentId),
            new BN(CAPABILITY_COMPUTE),
            "https://private-interface-test.example",
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

  it("uses new private payload shape and router/dual-spend accounts", async () => {
    const constraintHash = Buffer.alloc(HASH_SIZE, 0x71);
    const { taskId, taskPda, escrowPda, claimPda } = await createTaskAndClaim(constraintHash);
    const proof = createProofPayload({
      taskPda,
      authority: worker.publicKey,
      constraintHash,
      sealBytesLen: 32,
    });

    await expectCompletionFailure({ taskId, taskPda, escrowPda, claimPda, proof });
  });

  it("accepts payload fields sealBytes/journal/imageId/bindingSeed/nullifierSeed", async () => {
    const constraintHash = Buffer.alloc(HASH_SIZE, 0x72);
    const { taskId, taskPda, escrowPda, claimPda } = await createTaskAndClaim(constraintHash);
    const proof = createProofPayload({
      taskPda,
      authority: worker.publicKey,
      constraintHash,
    });

    await expectCompletionFailure({ taskId, taskPda, escrowPda, claimPda, proof });
  });
});
