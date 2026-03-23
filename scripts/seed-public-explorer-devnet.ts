import * as anchor from "@coral-xyz/anchor";
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import idlJson from "../runtime/idl/agenc_coordination.json";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com";
const PROGRAM_KEYPAIR_PATH =
  process.env.AGENC_PROGRAM_KEYPAIR ??
  fileURLToPath(new URL("../target/deploy/agenc_coordination-keypair.json", import.meta.url));
const PROGRAM_ID = resolveProgramId();

const AUTHORITY_KEYPAIR_PATH =
  process.env.AGENC_AUTHORITY_KEYPAIR ??
  join(homedir(), ".config", "solana", "id.json");
const WORKER_KEYPAIR_PATH =
  process.env.AGENC_WORKER_KEYPAIR ??
  join(homedir(), ".config", "solana", "second-signer.json");
const ARBITER_KEYPAIR_PATH =
  process.env.AGENC_ARBITER_KEYPAIR ??
  join(homedir(), ".config", "solana", "agenc-devnet-third-signer.json");

const TARGET_WORKER_BALANCE = 150_000_000;
const TARGET_ARBITER_BALANCE = 150_000_000;
const MIN_AGENT_STAKE = 10_000_000;
const MIN_DISPUTE_STAKE = 5_000_000;
const REGISTERED_AGENT_STAKE = 50_000_000;
const TASK_REWARD = 50_000_000;

const CAPABILITY_COMPUTE = 1 << 0;
const CAPABILITY_ARBITER = 1 << 7;
const TASK_TYPE_EXCLUSIVE = 0;
const RESOLUTION_TYPE_REFUND = 0;

const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

const CREATOR_AGENT_ID = fixedId("explorer-creator-devnet-v1");
const WORKER_AGENT_ID = fixedId("explorer-worker-devnet-v1");
const ARBITER_AGENT_ID = fixedId("explorer-arbiter-devnet-v1");
const TASK_ID = fixedId("explorer-task-devnet-v1");
const DISPUTE_ID = fixedId("explorer-dispute-devnet-v1");
const EVIDENCE =
  "Worker is opening a deterministic devnet dispute so the public explorer page has stable dispute data to render.";

type Wallet = anchor.Wallet;
type Program = anchor.Program;

function keypairToWallet(keypair: Keypair): Wallet {
  return {
    publicKey: keypair.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(
      tx: T,
    ): Promise<T> {
      if (tx instanceof VersionedTransaction) {
        tx.sign([keypair]);
      } else {
        tx.partialSign(keypair);
      }
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(
      txs: T[],
    ): Promise<T[]> {
      for (const tx of txs) {
        if (tx instanceof VersionedTransaction) {
          tx.sign([keypair]);
        } else {
          tx.partialSign(keypair);
        }
      }
      return txs;
    },
  };
}

function loadKeypair(filePath: string): Keypair {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function resolveProgramId(): PublicKey {
  if (process.env.AGENC_PROGRAM_ID) {
    return new PublicKey(process.env.AGENC_PROGRAM_ID);
  }

  try {
    return loadKeypair(PROGRAM_KEYPAIR_PATH).publicKey;
  } catch {
    return new PublicKey("8U8C6ndgUGCXjqHcBccPdu1yGqQ5osHnjnAabUjfrzBQ");
  }
}

function fixedId(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value.slice(0, 32).padEnd(32, "\0")));
}

function sha256Bytes(value: string): Uint8Array {
  return Uint8Array.from(createHash("sha256").update(value).digest());
}

function derivePda(seeds: Buffer[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

function deriveProgramDataPda(): PublicKey {
  return PublicKey.findProgramAddressSync(
    [PROGRAM_ID.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

function deriveProtocolPda(): PublicKey {
  return derivePda([Buffer.from("protocol")]);
}

function deriveAgentPda(agentId: Uint8Array): PublicKey {
  return derivePda([Buffer.from("agent"), Buffer.from(agentId)]);
}

function deriveTaskPda(creator: PublicKey, taskId: Uint8Array): PublicKey {
  return derivePda([Buffer.from("task"), creator.toBuffer(), Buffer.from(taskId)]);
}

function deriveEscrowPda(taskPda: PublicKey): PublicKey {
  return derivePda([Buffer.from("escrow"), taskPda.toBuffer()]);
}

function deriveClaimPda(taskPda: PublicKey, workerAgentPda: PublicKey): PublicKey {
  return derivePda([
    Buffer.from("claim"),
    taskPda.toBuffer(),
    workerAgentPda.toBuffer(),
  ]);
}

function deriveDisputePda(disputeId: Uint8Array): PublicKey {
  return derivePda([Buffer.from("dispute"), Buffer.from(disputeId)]);
}

function createProgram(connection: Connection, signer: Keypair): Program {
  const provider = new anchor.AnchorProvider(connection, keypairToWallet(signer), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(JSON.stringify(idlJson)) as anchor.Idl & {
    address?: string;
  };
  idl.address = PROGRAM_ID.toBase58();
  return new anchor.Program(idl, provider) as Program;
}

async function fetchNullable<T>(fetcher: () => Promise<T>): Promise<T | null> {
  try {
    return await fetcher();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("Account does not exist") ||
      message.includes("could not find account") ||
      message.includes("Unable to find")
    ) {
      return null;
    }
    throw error;
  }
}

async function ensureBalance(
  connection: Connection,
  payer: Keypair,
  recipient: PublicKey,
  minimumLamports: number,
): Promise<string | null> {
  const current = await connection.getBalance(recipient, "confirmed");
  if (current >= minimumLamports) {
    return null;
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: recipient,
      lamports: minimumLamports - current,
    }),
  );

  return sendAndConfirmTransaction(connection, tx, [payer], {
    commitment: "confirmed",
  });
}

async function ensureProtocol(
  connection: Connection,
  authority: Keypair,
  worker: Keypair,
  arbiter: Keypair,
  authorityProgram: Program,
  protocolPda: PublicKey,
): Promise<string | null> {
  const existing = await fetchNullable(() =>
    ((authorityProgram.account as Record<
      string,
      { fetch: (key: PublicKey) => Promise<unknown> }
    >).protocolConfig).fetch(protocolPda),
  );
  if (existing) {
    return null;
  }

  const signature = await authorityProgram.methods
    .initializeProtocol(
      51,
      100,
      new anchor.BN(MIN_AGENT_STAKE),
      new anchor.BN(MIN_DISPUTE_STAKE),
      2,
      [authority.publicKey, worker.publicKey, arbiter.publicKey],
    )
    .accountsPartial({
      protocolConfig: protocolPda,
      treasury: authority.publicKey,
      authority: authority.publicKey,
      secondSigner: worker.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .remainingAccounts([
      {
        pubkey: deriveProgramDataPda(),
        isSigner: false,
        isWritable: false,
      },
    ])
    .signers([worker])
    .rpc();

  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

async function ensureAgent(
  connection: Connection,
  program: Program,
  authority: Keypair,
  protocolPda: PublicKey,
  agentId: Uint8Array,
  capabilities: number,
  endpoint: string,
): Promise<{ agentPda: PublicKey; txSignature: string | null }> {
  const agentPda = deriveAgentPda(agentId);
  const existing = await fetchNullable(() =>
    ((program.account as Record<
      string,
      { fetch: (key: PublicKey) => Promise<unknown> }
    >).agentRegistration).fetch(agentPda),
  );

  if (existing) {
    return { agentPda, txSignature: null };
  }

  const signature = await program.methods
    .registerAgent(
      Array.from(agentId),
      new anchor.BN(capabilities),
      endpoint,
      null,
      new anchor.BN(REGISTERED_AGENT_STAKE),
    )
    .accountsPartial({
      agent: agentPda,
      protocolConfig: protocolPda,
      authority: authority.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await connection.confirmTransaction(signature, "confirmed");
  return { agentPda, txSignature: signature };
}

async function main(): Promise<void> {
  const connection = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair(AUTHORITY_KEYPAIR_PATH);
  const worker = loadKeypair(WORKER_KEYPAIR_PATH);
  const arbiter = loadKeypair(ARBITER_KEYPAIR_PATH);

  const authorityProgram = createProgram(connection, authority);
  const workerProgram = createProgram(connection, worker);
  const arbiterProgram = createProgram(connection, arbiter);

  const summary: Record<string, string | null> = {};
  const protocolPda = deriveProtocolPda();

  console.log(`RPC: ${RPC_URL}`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Authority: ${authority.publicKey.toBase58()}`);
  console.log(`Worker: ${worker.publicKey.toBase58()}`);
  console.log(`Arbiter: ${arbiter.publicKey.toBase58()}`);

  summary.fundWorker = await ensureBalance(
    connection,
    authority,
    worker.publicKey,
    TARGET_WORKER_BALANCE,
  );
  summary.fundArbiter = await ensureBalance(
    connection,
    authority,
    arbiter.publicKey,
    TARGET_ARBITER_BALANCE,
  );

  summary.initializeProtocol = await ensureProtocol(
    connection,
    authority,
    worker,
    arbiter,
    authorityProgram,
    protocolPda,
  );

  const creatorAgent = await ensureAgent(
    connection,
    authorityProgram,
    authority,
    protocolPda,
    CREATOR_AGENT_ID,
    CAPABILITY_COMPUTE,
    "https://devnet.agenc.ai/explorer/creator",
  );
  summary.registerCreator = creatorAgent.txSignature;

  const workerAgent = await ensureAgent(
    connection,
    workerProgram,
    worker,
    protocolPda,
    WORKER_AGENT_ID,
    CAPABILITY_COMPUTE,
    "https://devnet.agenc.ai/explorer/worker",
  );
  summary.registerWorker = workerAgent.txSignature;

  const arbiterAgent = await ensureAgent(
    connection,
    arbiterProgram,
    arbiter,
    protocolPda,
    ARBITER_AGENT_ID,
    CAPABILITY_COMPUTE | CAPABILITY_ARBITER,
    "https://devnet.agenc.ai/explorer/arbiter",
  );
  summary.registerArbiter = arbiterAgent.txSignature;

  const taskPda = deriveTaskPda(authority.publicKey, TASK_ID);
  const escrowPda = deriveEscrowPda(taskPda);
  const existingTask = await fetchNullable(() =>
    ((authorityProgram.account as Record<
      string,
      { fetch: (key: PublicKey) => Promise<unknown> }
    >).task).fetch(taskPda),
  );

  if (!existingTask) {
    const signature = await authorityProgram.methods
      .createTask(
        Array.from(TASK_ID),
        new anchor.BN(CAPABILITY_COMPUTE),
        Buffer.from("Render a stable devnet dispute on the explorer"),
        new anchor.BN(TASK_REWARD),
        1,
        new anchor.BN(Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60),
        TASK_TYPE_EXCLUSIVE,
        null,
        0,
        null,
      )
      .accountsPartial({
        task: taskPda,
        escrow: escrowPda,
        protocolConfig: protocolPda,
        creatorAgent: creatorAgent.agentPda,
        authority: authority.publicKey,
        creator: authority.publicKey,
        systemProgram: SystemProgram.programId,
        rewardMint: null,
        creatorTokenAccount: null,
        tokenEscrowAta: null,
        tokenProgram: null,
        associatedTokenProgram: null,
      })
      .rpc();

    await connection.confirmTransaction(signature, "confirmed");
    summary.createTask = signature;
  } else {
    summary.createTask = null;
  }

  const claimPda = deriveClaimPda(taskPda, workerAgent.agentPda);
  const existingClaim = await fetchNullable(() =>
    ((workerProgram.account as Record<
      string,
      { fetch: (key: PublicKey) => Promise<unknown> }
    >).taskClaim).fetch(claimPda),
  );

  if (!existingClaim) {
    const signature = await workerProgram.methods
      .claimTask()
      .accountsPartial({
        task: taskPda,
        claim: claimPda,
        worker: workerAgent.agentPda,
        authority: worker.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    await connection.confirmTransaction(signature, "confirmed");
    summary.claimTask = signature;
  } else {
    summary.claimTask = null;
  }

  const disputePda = deriveDisputePda(DISPUTE_ID);
  const existingDispute = await fetchNullable(() =>
    ((workerProgram.account as Record<
      string,
      { fetch: (key: PublicKey) => Promise<unknown> }
    >).dispute).fetch(disputePda),
  );

  if (!existingDispute) {
    const signature = await workerProgram.methods
      .initiateDispute(
        Array.from(DISPUTE_ID),
        Array.from(TASK_ID),
        Array.from(sha256Bytes(EVIDENCE)),
        RESOLUTION_TYPE_REFUND,
        EVIDENCE,
      )
      .accountsPartial({
        dispute: disputePda,
        task: taskPda,
        agent: workerAgent.agentPda,
        authority: worker.publicKey,
        protocolConfig: protocolPda,
        systemProgram: SystemProgram.programId,
        initiatorClaim: claimPda,
        workerAgent: null,
        workerClaim: null,
      })
      .rpc();

    await connection.confirmTransaction(signature, "confirmed");
    summary.initiateDispute = signature;
  } else {
    summary.initiateDispute = null;
  }

  const authorityBalance = await connection.getBalance(authority.publicKey);
  const workerBalance = await connection.getBalance(worker.publicKey);
  const arbiterBalance = await connection.getBalance(arbiter.publicKey);

  console.log("");
  console.log("Seed complete.");
  console.log(`Protocol: ${protocolPda.toBase58()}`);
  console.log(`Creator agent: ${creatorAgent.agentPda.toBase58()}`);
  console.log(`Worker agent: ${workerAgent.agentPda.toBase58()}`);
  console.log(`Arbiter agent: ${arbiterAgent.agentPda.toBase58()}`);
  console.log(`Task: ${taskPda.toBase58()}`);
  console.log(`Claim: ${claimPda.toBase58()}`);
  console.log(`Dispute: ${disputePda.toBase58()}`);
  console.log("");
  console.log(
    JSON.stringify(
      {
        programId: PROGRAM_ID.toBase58(),
        balances: {
          authority: authorityBalance / LAMPORTS_PER_SOL,
          worker: workerBalance / LAMPORTS_PER_SOL,
          arbiter: arbiterBalance / LAMPORTS_PER_SOL,
        },
        summary,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
