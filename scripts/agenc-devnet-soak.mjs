#!/usr/bin/env node

import anchor from "@coral-xyz/anchor";
import {
  claimTask,
  bigintToBytes32,
  completeTask,
  computeConstraintHash,
  createTask,
  deriveAgentPda,
  deriveClaimPda,
  deriveEscrowPda,
  deriveProtocolPda,
  deriveZkConfigPda,
  FIELD_MODULUS,
  generateProof,
  generateSalt,
  getAgent,
  getProtocolConfig,
  RECOMMENDED_CU_COMPLETE_TASK_PRIVATE,
  registerAgent,
} from "@tetsuo-ai/sdk";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_IDL_PATH = require.resolve("@tetsuo-ai/protocol/idl/agenc_coordination.json");
const DEFAULT_PROGRAM_ID = new PublicKey("6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab");
const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_KEYPAIR_PATH = path.join(os.homedir(), ".config", "solana", "id.json");
const DEFAULT_STATE_DIR = path.join(os.homedir(), ".agenc", "devnet-soak", "default");
const DEFAULT_WORKER_COUNT = 4;
const DEFAULT_REWARD_SOL = 0.05;
const DEFAULT_TASK_INTERVAL_MS = 15_000;
const DEFAULT_TASK_COUNT = 0;
const DEFAULT_POLL_MS = 2_500;
const DEFAULT_DEADLINE_SECONDS = 1_800;
const DEFAULT_PROOF_MODE = "public";
const DEFAULT_PROVER_TIMEOUT_MS = 600_000;
const DEFAULT_MIN_OPERATOR_BALANCE_SOL = 2;
const DEFAULT_MEMBER_BALANCE_SOL = 2;
const DEFAULT_DISPUTE_THRESHOLD = 51;
const DEFAULT_PROTOCOL_FEE_BPS = 100;
const DEFAULT_MIN_STAKE_LAMPORTS = 1n * BigInt(LAMPORTS_PER_SOL);
const DEFAULT_MIN_STAKE_FOR_DISPUTE_LAMPORTS = 1_000n;
const TASK_TYPE_EXCLUSIVE = 0;
const CAPABILITY_COMPUTE = 1 << 0;
const CAPABILITY_COORDINATOR = 1 << 6;
const BPF_LOADER_UPGRADEABLE_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);
const TRUSTED_RISC0_ROUTER_PROGRAM_ID = new PublicKey(
  "E9ZiqfCdr6gGeB2UhBbkWnFP9vGnRYQwqnDsS1LM3NJZ",
);
const TRUSTED_RISC0_VERIFIER_PROGRAM_ID = new PublicKey(
  "3ZrAHZKjk24AKgXFekpYeG7v3Rz7NucLXTB3zxGGTjsc",
);
const TRUSTED_RISC0_SELECTOR = Buffer.from([0x52, 0x5a, 0x56, 0x4d]);
const ROUTER_SEED = Buffer.from("router");
const VERIFIER_SEED = Buffer.from("verifier");
const BINDING_SPEND_SEED = Buffer.from("binding_spend");
const NULLIFIER_SPEND_SEED = Buffer.from("nullifier_spend");
const FIXTURE_AGENT_SECRET_DOMAIN_TAG = Buffer.from(
  "AGENC_E2E_FIXTURE_AGENT_SECRET",
  "utf8",
);
const PRIVATE_OUTPUT_VALUES = [11n, 22n, 33n, 44n];
const LOOKUP_TABLE_WAIT_MS = 2_000;

function usage() {
  process.stdout.write(`Usage:
  node scripts/agenc-devnet-soak.mjs prepare [options]
  node scripts/agenc-devnet-soak.mjs controller [options]
  node scripts/agenc-devnet-soak.mjs worker --worker-index <n> [options]

Options:
  --rpc-url <url>            Solana RPC URL (default: ${DEFAULT_RPC_URL})
  --program-id <pubkey>      Override program ID (default: ${DEFAULT_PROGRAM_ID.toBase58()})
  --keypair-path <path>      Operator wallet path (default: ${DEFAULT_KEYPAIR_PATH})
  --state-dir <path>         Soak state directory (default: ${DEFAULT_STATE_DIR})
  --worker-count <n>         Number of worker identities to provision (default: ${DEFAULT_WORKER_COUNT})
  --reward-sol <amount>      Reward per task in SOL (default: ${DEFAULT_REWARD_SOL})
  --interval-ms <ms>         Delay between controller submissions (default: ${DEFAULT_TASK_INTERVAL_MS})
  --count <n>                Number of tasks to submit; 0 = run until stopped (default: ${DEFAULT_TASK_COUNT})
  --poll-ms <ms>             Worker poll interval (default: ${DEFAULT_POLL_MS})
  --deadline-seconds <n>     Task deadline offset from now (default: ${DEFAULT_DEADLINE_SECONDS})
  --proof-mode <mode>        Completion path: public | private (default: ${DEFAULT_PROOF_MODE})
  --prover-endpoint <url>    HTTPS prover endpoint for private mode
  --prover-timeout-ms <ms>   Prover timeout in ms for private mode (default: ${DEFAULT_PROVER_TIMEOUT_MS})
  --run-token <token>        Stable token used in task labels
  --reset-events             Archive and reset events.ndjson during prepare
  --help                     Show this help
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

function createRunToken() {
  const date = new Date();
  const stamp = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
    "-",
    String(date.getUTCHours()).padStart(2, "0"),
    String(date.getUTCMinutes()).padStart(2, "0"),
    String(date.getUTCSeconds()).padStart(2, "0"),
  ].join("");
  return `devnet-soak-${stamp}`;
}

function normalizeProofMode(value) {
  const normalized = String(value ?? DEFAULT_PROOF_MODE).toLowerCase();
  if (normalized !== "public" && normalized !== "private") {
    throw new Error(`Invalid --proof-mode '${value}'. Expected 'public' or 'private'.`);
  }
  return normalized;
}

function shortKey(value) {
  return `${value.slice(0, 4)}..${value.slice(-4)}`;
}

function toLamports(solAmount) {
  return Math.round(Number(solAmount) * LAMPORTS_PER_SOL);
}

function formatSol(lamports) {
  return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(3)} SOL`;
}

function deriveFixtureAgentSecret(secretKey) {
  const digest = crypto
    .createHash("sha256")
    .update(FIXTURE_AGENT_SECRET_DOMAIN_TAG)
    .update(Buffer.from(secretKey))
    .digest();
  return BigInt(`0x${digest.toString("hex")}`) % FIELD_MODULUS;
}

function privateProofPlan() {
  const constraintHash = computeConstraintHash(PRIVATE_OUTPUT_VALUES);
  return {
    mode: "private",
    output: PRIVATE_OUTPUT_VALUES,
    constraintHash,
    constraintHashBytes: bigintToBytes32(constraintHash),
  };
}

function publicProofPlan() {
  return {
    mode: "public",
    output: null,
    constraintHash: null,
    constraintHashBytes: null,
  };
}

function buildProofPlan(proofMode) {
  return proofMode === "private" ? privateProofPlan() : publicProofPlan();
}

function statePaths(stateDir, workerCount) {
  const keysDir = path.join(stateDir, "keys");
  const workerKeypairs = Array.from({ length: workerCount }, (_, index) =>
    path.join(keysDir, `worker-${index + 1}.json`),
  );
  return {
    stateDir,
    keysDir,
    eventsPath: path.join(stateDir, "events.ndjson"),
    summaryPath: path.join(stateDir, "summary.json"),
    creatorKeypairPath: path.join(keysDir, "creator.json"),
    treasuryKeypairPath: path.join(keysDir, "treasury.json"),
    multisigSecondPath: path.join(keysDir, "multisig-second.json"),
    multisigThirdPath: path.join(keysDir, "multisig-third.json"),
    workerKeypairs,
  };
}

function agentLabel(role, workerIndex) {
  return role === "worker" ? `devnet-soak-worker-${workerIndex}` : "devnet-soak-creator";
}

function agentIdFor(role, workerIndex) {
  return new Uint8Array(
    crypto.createHash("sha256").update(agentLabel(role, workerIndex)).digest(),
  );
}

function taskIdFor(runToken, sequence) {
  const label = `${runToken}:task:${String(sequence).padStart(6, "0")}`;
  return new Uint8Array(crypto.createHash("sha256").update(label).digest());
}

function fixedLengthBuffer(value, length) {
  const output = Buffer.alloc(length);
  Buffer.from(value).copy(output, 0, 0, length);
  return output;
}

function parseArgs(argv) {
  const parsed = {
    command: null,
    rpcUrl: DEFAULT_RPC_URL,
    keypairPath: DEFAULT_KEYPAIR_PATH,
    stateDir: DEFAULT_STATE_DIR,
    workerCount: DEFAULT_WORKER_COUNT,
    rewardSol: DEFAULT_REWARD_SOL,
    intervalMs: DEFAULT_TASK_INTERVAL_MS,
    count: DEFAULT_TASK_COUNT,
    pollMs: DEFAULT_POLL_MS,
    deadlineSeconds: DEFAULT_DEADLINE_SECONDS,
    proofMode: DEFAULT_PROOF_MODE,
    proverEndpoint: null,
    proverTimeoutMs: DEFAULT_PROVER_TIMEOUT_MS,
    workerIndex: null,
    runToken: createRunToken(),
    resetEvents: false,
    help: false,
    programId: DEFAULT_PROGRAM_ID.toBase58(),
  };

  if (argv.length === 0) {
    parsed.help = true;
    return parsed;
  }

  if (argv[0] === "--help") {
    parsed.help = true;
    return parsed;
  }

  parsed.command = argv[0] ?? null;

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      parsed.help = true;
    } else if (arg === "--rpc-url" && argv[index + 1]) {
      parsed.rpcUrl = argv[++index];
    } else if (arg === "--keypair-path" && argv[index + 1]) {
      parsed.keypairPath = path.resolve(argv[++index]);
    } else if (arg === "--state-dir" && argv[index + 1]) {
      parsed.stateDir = path.resolve(argv[++index]);
    } else if (arg === "--worker-count" && argv[index + 1]) {
      parsed.workerCount = Number.parseInt(argv[++index], 10);
    } else if (arg === "--reward-sol" && argv[index + 1]) {
      parsed.rewardSol = Number.parseFloat(argv[++index]);
    } else if (arg === "--interval-ms" && argv[index + 1]) {
      parsed.intervalMs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--count" && argv[index + 1]) {
      parsed.count = Number.parseInt(argv[++index], 10);
    } else if (arg === "--poll-ms" && argv[index + 1]) {
      parsed.pollMs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--deadline-seconds" && argv[index + 1]) {
      parsed.deadlineSeconds = Number.parseInt(argv[++index], 10);
    } else if (arg === "--proof-mode" && argv[index + 1]) {
      parsed.proofMode = normalizeProofMode(argv[++index]);
    } else if (arg === "--prover-endpoint" && argv[index + 1]) {
      parsed.proverEndpoint = argv[++index];
    } else if (arg === "--prover-timeout-ms" && argv[index + 1]) {
      parsed.proverTimeoutMs = Number.parseInt(argv[++index], 10);
    } else if (arg === "--worker-index" && argv[index + 1]) {
      parsed.workerIndex = Number.parseInt(argv[++index], 10);
    } else if (arg === "--run-token" && argv[index + 1]) {
      parsed.runToken = argv[++index];
    } else if (arg === "--program-id" && argv[index + 1]) {
      parsed.programId = argv[++index];
    } else if (arg === "--reset-events") {
      parsed.resetEvents = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  parsed.proofMode = normalizeProofMode(parsed.proofMode);
  return parsed;
}

async function loadKeypair(filePath) {
  const raw = await readFile(filePath, "utf8");
  const secret = JSON.parse(raw);
  if (!Array.isArray(secret)) {
    throw new Error(`Invalid keypair file: ${filePath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function saveKeypair(filePath, keypair) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(Array.from(keypair.secretKey), null, 2)}\n`,
    "utf8",
  );
}

async function ensureNamedKeypair(filePath) {
  if (existsSync(filePath)) {
    return loadKeypair(filePath);
  }
  const keypair = Keypair.generate();
  await saveKeypair(filePath, keypair);
  return keypair;
}

async function loadIdl(idlPath, programId) {
  const idl = JSON.parse(await readFile(idlPath, "utf8"));
  idl.address = programId.toBase58();
  return idl;
}

async function createProgramContext(options) {
  const authority = await loadKeypair(options.keypairPath);
  const connection = new Connection(options.rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(authority),
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    },
  );
  const programId = new PublicKey(options.programId);
  const idl = await loadIdl(DEFAULT_IDL_PATH, programId);
  const program = new anchor.Program(idl, provider);

  return {
    authority,
    connection,
    program,
    provider,
    programId,
  };
}

async function appendEvent(paths, record) {
  await mkdir(path.dirname(paths.eventsPath), { recursive: true });
  await appendFile(
    paths.eventsPath,
    `${JSON.stringify({ ts: nowIso(), ...record })}\n`,
    "utf8",
  );
}

async function readEvents(paths) {
  if (!existsSync(paths.eventsPath)) {
    return [];
  }
  const raw = await readFile(paths.eventsPath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function isTransientRpcError(message) {
  return (
    /429|too many requests|timed out|timeout|blockhash|fetch failed|connection closed|socket|temporarily unavailable|node is behind|internal error/i.test(
      message,
    )
  );
}

function isExpectedClaimConflict(message) {
  return (
    /already claimed|maximum workers|not open|task has expired|cannot claim own task|insufficient capabilities|task fully claimed|already in progress|not claimable/i.test(
      message,
    )
  );
}

async function withRetries(label, fn, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === attempts || !isTransientRpcError(message)) {
        throw error;
      }
      const delayMs = 1_000 * attempt;
      process.stdout.write(
        `[${nowIso()}] ${label} transient failure (${message}); retrying in ${delayMs}ms\n`,
      );
      await sleep(delayMs);
    }
  }
  throw new Error(`${label} exhausted retries`);
}

async function requestAirdrop(connection, pubkey, lamports) {
  const signature = await connection.requestAirdrop(pubkey, lamports);
  await connection.confirmTransaction(signature, "confirmed");
}

async function ensureOperatorBalance(connection, authority, minLamports) {
  let balance = await connection.getBalance(authority.publicKey, "confirmed");
  while (balance < minLamports) {
    const topUp = Math.min(
      Math.max(minLamports - balance, 1 * LAMPORTS_PER_SOL),
      2 * LAMPORTS_PER_SOL,
    );
    process.stdout.write(
      `[${nowIso()}] Funding operator wallet ${shortKey(authority.publicKey.toBase58())} with ${formatSol(topUp)} via devnet airdrop\n`,
    );

    await withRetries(
      "operator airdrop",
      async () => requestAirdrop(connection, authority.publicKey, topUp),
      5,
    );

    balance = await connection.getBalance(authority.publicKey, "confirmed");
  }
  return balance;
}

async function topUpMemberAccount(connection, authority, recipient, minLamports, targetLamports, label) {
  const current = await connection.getBalance(recipient.publicKey, "confirmed");
  if (current >= minLamports) {
    return current;
  }

  const transferLamports = Math.max(targetLamports - current, minLamports - current);
  const operatorFloor = toLamports(DEFAULT_MIN_OPERATOR_BALANCE_SOL);
  await ensureOperatorBalance(connection, authority, operatorFloor + transferLamports);

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: authority.publicKey,
      toPubkey: recipient.publicKey,
      lamports: transferLamports,
    }),
  );

  await withRetries(
    `fund ${label}`,
    async () => sendAndConfirmTransaction(connection, tx, [authority], { commitment: "confirmed" }),
    3,
  );

  process.stdout.write(
    `[${nowIso()}] Funded ${label} ${shortKey(recipient.publicKey.toBase58())} with ${formatSol(transferLamports)}\n`,
  );

  return connection.getBalance(recipient.publicKey, "confirmed");
}

function deriveProgramDataPda(programId) {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_ID,
  )[0];
}

function deriveRouterPda() {
  return PublicKey.findProgramAddressSync(
    [ROUTER_SEED],
    TRUSTED_RISC0_ROUTER_PROGRAM_ID,
  )[0];
}

function deriveVerifierEntryPda() {
  return PublicKey.findProgramAddressSync(
    [VERIFIER_SEED, TRUSTED_RISC0_SELECTOR],
    TRUSTED_RISC0_ROUTER_PROGRAM_ID,
  )[0];
}

async function assertPrivateModeReady(context) {
  const routerPda = deriveRouterPda();
  const verifierEntryPda = deriveVerifierEntryPda();
  const [routerProgramInfo, verifierProgramInfo, routerPdaInfo, verifierEntryInfo] =
    await Promise.all([
      context.connection.getAccountInfo(TRUSTED_RISC0_ROUTER_PROGRAM_ID, "confirmed"),
      context.connection.getAccountInfo(TRUSTED_RISC0_VERIFIER_PROGRAM_ID, "confirmed"),
      context.connection.getAccountInfo(routerPda, "confirmed"),
      context.connection.getAccountInfo(verifierEntryPda, "confirmed"),
    ]);

  if (!routerProgramInfo?.executable) {
    throw new Error(
      `Private proof mode requires router program ${TRUSTED_RISC0_ROUTER_PROGRAM_ID.toBase58()} on-chain.`,
    );
  }
  if (!verifierProgramInfo?.executable) {
    throw new Error(
      `Private proof mode requires verifier program ${TRUSTED_RISC0_VERIFIER_PROGRAM_ID.toBase58()} on-chain.`,
    );
  }
  if (!routerPdaInfo?.owner.equals(TRUSTED_RISC0_ROUTER_PROGRAM_ID)) {
    throw new Error(
      `Private proof mode requires initialized router PDA ${routerPda.toBase58()}.`,
    );
  }
  if (!verifierEntryInfo?.owner.equals(TRUSTED_RISC0_ROUTER_PROGRAM_ID)) {
    throw new Error(
      `Private proof mode requires verifier entry PDA ${verifierEntryPda.toBase58()}.`,
    );
  }
}

async function waitForLookupTable(connection, lookupTableAddress, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const result = await connection.getAddressLookupTable(lookupTableAddress);
    if (result.value) {
      return result.value;
    }
    await sleep(LOOKUP_TABLE_WAIT_MS);
  }

  throw new Error(
    `Address lookup table ${lookupTableAddress.toBase58()} was not ready within ${timeoutMs}ms`,
  );
}

async function completeTaskPrivateVersioned(
  context,
  workerKeypair,
  workerMeta,
  taskPda,
  proof,
  protocol,
) {
  const workerAgentPda = deriveAgentPda(workerMeta.agentId, context.program.programId);
  const claimPda = deriveClaimPda(taskPda, workerAgentPda, context.program.programId);
  const escrowPda = deriveEscrowPda(taskPda, context.program.programId);
  const protocolPda = deriveProtocolPda(context.program.programId);
  const zkConfigPda = deriveZkConfigPda(context.program.programId);
  const routerPda = deriveRouterPda();
  const verifierEntryPda = deriveVerifierEntryPda();
  const [bindingSpendPda] = PublicKey.findProgramAddressSync(
    [BINDING_SPEND_SEED, Buffer.from(proof.bindingSeed)],
    context.program.programId,
  );
  const [nullifierSpendPda] = PublicKey.findProgramAddressSync(
    [NULLIFIER_SPEND_SEED, Buffer.from(proof.nullifierSeed)],
    context.program.programId,
  );

  const taskAccount = await context.program.account.task.fetch(taskPda);
  const taskIdBuf = Buffer.from(taskAccount.taskId);
  const taskIdU64 = new anchor.BN(taskIdBuf.subarray(0, 8), "le");

  const recentSlot = await context.connection.getSlot("finalized");
  const [createLookupTableIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: workerKeypair.publicKey,
      payer: workerKeypair.publicKey,
      recentSlot,
    });
  const extendLookupTableIx = AddressLookupTableProgram.extendLookupTable({
    payer: workerKeypair.publicKey,
    authority: workerKeypair.publicKey,
    lookupTable: lookupTableAddress,
    addresses: [
      taskPda,
      claimPda,
      escrowPda,
      taskAccount.creator,
      workerAgentPda,
      protocolPda,
      zkConfigPda,
      bindingSpendPda,
      nullifierSpendPda,
      protocol.treasury,
      TRUSTED_RISC0_ROUTER_PROGRAM_ID,
      routerPda,
      verifierEntryPda,
      TRUSTED_RISC0_VERIFIER_PROGRAM_ID,
      SystemProgram.programId,
      context.program.programId,
    ],
  });

  const lookupTableTxSignature = await sendAndConfirmTransaction(
    context.connection,
    new Transaction().add(createLookupTableIx, extendLookupTableIx),
    [workerKeypair],
    { commitment: "confirmed" },
  );

  const lookupTable = await waitForLookupTable(context.connection, lookupTableAddress);
  const completeIx = await context.program.methods
    .completeTaskPrivate(taskIdU64, {
      sealBytes: Buffer.from(proof.sealBytes),
      journal: Buffer.from(proof.journal),
      imageId: Array.from(proof.imageId),
      bindingSeed: Array.from(proof.bindingSeed),
      nullifierSeed: Array.from(proof.nullifierSeed),
    })
    .accountsPartial({
      task: taskPda,
      claim: claimPda,
      escrow: escrowPda,
      creator: taskAccount.creator,
      worker: workerAgentPda,
      protocolConfig: protocolPda,
      zkConfig: zkConfigPda,
      bindingSpend: bindingSpendPda,
      nullifierSpend: nullifierSpendPda,
      treasury: protocol.treasury,
      authority: workerKeypair.publicKey,
      routerProgram: TRUSTED_RISC0_ROUTER_PROGRAM_ID,
      router: routerPda,
      verifierEntry: verifierEntryPda,
      verifierProgram: TRUSTED_RISC0_VERIFIER_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null,
      workerTokenAccount: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
    })
    .instruction();

  const { blockhash, lastValidBlockHeight } =
    await context.connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: workerKeypair.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({
        units: RECOMMENDED_CU_COMPLETE_TASK_PRIVATE,
      }),
      completeIx,
    ],
  }).compileToV0Message([lookupTable]);
  const tx = new VersionedTransaction(message);
  tx.sign([workerKeypair]);

  const txSignature = await context.connection.sendTransaction(tx, { maxRetries: 3 });
  await context.connection.confirmTransaction(
    { signature: txSignature, blockhash, lastValidBlockHeight },
    "confirmed",
  );

  return {
    txSignature,
    lookupTableAddress: lookupTableAddress.toBase58(),
    lookupTableTxSignature,
  };
}

async function ensureProtocol(context, state) {
  const existing = await getProtocolConfig(context.program);
  if (existing) {
    return existing;
  }

  const secondSigner = await ensureNamedKeypair(state.paths.multisigSecondPath);
  const thirdSigner = await ensureNamedKeypair(state.paths.multisigThirdPath);
  const programDataPda = deriveProgramDataPda(context.program.programId);

  process.stdout.write(
    `[${nowIso()}] Protocol config missing; initializing devnet program ${context.program.programId.toBase58()}\n`,
  );

  try {
    const txSignature = await withRetries("initializeProtocol", async () =>
      context.program.methods
        .initializeProtocol(
          DEFAULT_DISPUTE_THRESHOLD,
          DEFAULT_PROTOCOL_FEE_BPS,
          new anchor.BN(DEFAULT_MIN_STAKE_LAMPORTS.toString()),
          new anchor.BN(DEFAULT_MIN_STAKE_FOR_DISPUTE_LAMPORTS.toString()),
          2,
          [
            context.authority.publicKey,
            secondSigner.publicKey,
            thirdSigner.publicKey,
          ],
        )
        .accountsPartial({
          treasury: context.authority.publicKey,
          authority: context.authority.publicKey,
          secondSigner: secondSigner.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          {
            pubkey: programDataPda,
            isSigner: false,
            isWritable: false,
          },
          {
            pubkey: thirdSigner.publicKey,
            isSigner: true,
            isWritable: false,
          },
        ])
        .signers([context.authority, secondSigner, thirdSigner])
        .rpc(),
    );
    await context.connection.confirmTransaction(txSignature, "confirmed");
    await appendEvent(state.paths, {
      actor: "prepare",
      event: "protocol_initialized",
      txSignature,
      treasury: context.authority.publicKey.toBase58(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already initialized|custom program error/i.test(message)) {
      throw error;
    }
  }

  const protocol = await getProtocolConfig(context.program);
  if (!protocol) {
    throw new Error("Protocol config is still unavailable after initialization attempt.");
  }
  return protocol;
}

async function ensureAgentRegistration(context, state, role, workerIndex, keypair, stakeLamports) {
  const agentId = agentIdFor(role, workerIndex);
  const agentPda = deriveAgentPda(agentId, context.program.programId);
  const existing = await getAgent(context.program, agentPda);
  if (existing) {
    return {
      agentId,
      agentPda,
      authority: keypair.publicKey,
      role,
      workerIndex,
    };
  }

  const capabilities = role === "creator" ? CAPABILITY_COORDINATOR : CAPABILITY_COMPUTE;
  const endpoint = role === "creator"
    ? "https://local.agenc/creator"
    : `https://local.agenc/worker-${workerIndex}`;

  try {
    const { txSignature } = await withRetries(
      `registerAgent(${role}${workerIndex ? `:${workerIndex}` : ""})`,
      async () =>
        registerAgent(context.connection, context.program, keypair, {
          agentId,
          capabilities,
          endpoint,
          metadataUri: null,
          stakeAmount: stakeLamports,
        }),
    );
    await appendEvent(state.paths, {
      actor: "prepare",
      event: "agent_registered",
      role,
      workerIndex,
      authority: keypair.publicKey.toBase58(),
      agentPda: agentPda.toBase58(),
      txSignature,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already in use|already initialized|already exists/i.test(message)) {
      throw error;
    }
  }

  return {
    agentId,
    agentPda,
    authority: keypair.publicKey,
    role,
    workerIndex,
  };
}

async function archiveEventsIfRequested(paths, resetEvents) {
  if (!resetEvents || !existsSync(paths.eventsPath)) {
    return;
  }
  const archivedPath = path.join(
    paths.stateDir,
    `events-${Date.now()}.ndjson`,
  );
  await rename(paths.eventsPath, archivedPath);
}

async function writeSummary(paths, summary) {
  await mkdir(path.dirname(paths.summaryPath), { recursive: true });
  await writeFile(paths.summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
}

async function ensureHarnessState(options) {
  const paths = statePaths(options.stateDir, options.workerCount);
  const proof = buildProofPlan(options.proofMode);
  await mkdir(paths.keysDir, { recursive: true });
  await archiveEventsIfRequested(paths, options.resetEvents);
  if (!existsSync(paths.eventsPath)) {
    await writeFile(paths.eventsPath, "", "utf8");
  }

  const context = await createProgramContext(options);
  if (proof.mode === "private") {
    await assertPrivateModeReady(context);
  }

  await ensureOperatorBalance(
    context.connection,
    context.authority,
    toLamports(DEFAULT_MIN_OPERATOR_BALANCE_SOL),
  );

  const creatorKeypair = await ensureNamedKeypair(paths.creatorKeypairPath);
  const workerKeypairs = await Promise.all(
    paths.workerKeypairs.map((filePath) => ensureNamedKeypair(filePath)),
  );

  await topUpMemberAccount(
    context.connection,
    context.authority,
    creatorKeypair,
    toLamports(DEFAULT_MEMBER_BALANCE_SOL),
    toLamports(DEFAULT_MEMBER_BALANCE_SOL),
    "creator",
  );
  for (const [index, worker] of workerKeypairs.entries()) {
    await topUpMemberAccount(
      context.connection,
      context.authority,
      worker,
      toLamports(DEFAULT_MEMBER_BALANCE_SOL),
      toLamports(DEFAULT_MEMBER_BALANCE_SOL),
      `worker-${index + 1}`,
    );
  }

  const protocol = await ensureProtocol(context, { paths });
  const stakeLamports = Number(protocol.minAgentStake ?? DEFAULT_MIN_STAKE_LAMPORTS);

  const creator = await ensureAgentRegistration(
    context,
    { paths },
    "creator",
    null,
    creatorKeypair,
    stakeLamports,
  );

  const workers = [];
  for (const [index, workerKeypair] of workerKeypairs.entries()) {
    workers.push(
      await ensureAgentRegistration(
        context,
        { paths },
        "worker",
        index + 1,
        workerKeypair,
        stakeLamports,
      ),
    );
  }

  const summary = {
    updatedAt: nowIso(),
    rpcUrl: options.rpcUrl,
    programId: context.program.programId.toBase58(),
    proof: {
      mode: proof.mode,
      constraintHashHex: proof.constraintHashBytes?.toString("hex") ?? null,
      output: proof.output?.map((value) => value.toString()) ?? null,
      proverEndpoint: options.proverEndpoint,
      proverTimeoutMs: options.proverTimeoutMs,
    },
    operator: context.authority.publicKey.toBase58(),
    protocol: {
      authority: protocol.authority.toBase58(),
      treasury: protocol.treasury.toBase58(),
      minAgentStakeLamports: protocol.minAgentStake.toString(),
      minAgentStakeSol: Number(protocol.minAgentStake) / LAMPORTS_PER_SOL,
      disputeThreshold: protocol.disputeThreshold,
      protocolFeeBps: protocol.protocolFeeBps,
    },
    creator: {
      authority: creatorKeypair.publicKey.toBase58(),
      agentPda: creator.agentPda.toBase58(),
    },
    workers: workers.map((worker, index) => ({
      workerIndex: index + 1,
      authority: workerKeypairs[index].publicKey.toBase58(),
      agentPda: worker.agentPda.toBase58(),
      keypairPath: paths.workerKeypairs[index],
    })),
    files: {
      eventsPath: paths.eventsPath,
      summaryPath: paths.summaryPath,
    },
  };

  await writeSummary(paths, summary);

  return {
    context,
    paths,
    creator,
    creatorKeypair,
    workerKeypairs,
    workers,
    protocol,
    proof,
    summary,
  };
}

function installSignalHandlers(onStop) {
  let stopping = false;
  const stop = async (signal) => {
    if (stopping) {
      return;
    }
    stopping = true;
    process.stdout.write(`[${nowIso()}] Received ${signal}; stopping\n`);
    await onStop();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void stop("SIGINT");
  });
  process.on("SIGTERM", () => {
    void stop("SIGTERM");
  });
}

async function runPrepare(options) {
  const state = await ensureHarnessState(options);
  await appendEvent(state.paths, {
    actor: "prepare",
    event: "state_ready",
    workerCount: options.workerCount,
    proofMode: state.proof.mode,
    summaryPath: state.paths.summaryPath,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "ok",
        command: "prepare",
        stateDir: state.paths.stateDir,
        summaryPath: state.paths.summaryPath,
        eventsPath: state.paths.eventsPath,
        proof: state.summary.proof,
        creator: state.summary.creator,
        workers: state.summary.workers,
      },
      null,
      2,
    )}\n`,
  );
}

async function runController(options) {
  const state = await ensureHarnessState(options);
  const rewardLamports = toLamports(options.rewardSol);
  const creatorMinBalanceLamports = Math.max(
    toLamports(1.5),
    rewardLamports * 10,
  );
  const creatorTargetBalanceLamports = Math.max(
    toLamports(4),
    rewardLamports * 40,
  );
  let sequence = 0;
  let stopped = false;

  installSignalHandlers(async () => {
    stopped = true;
    await appendEvent(state.paths, {
      actor: "controller",
      event: "controller_stopped",
      proofMode: state.proof.mode,
      submittedCount: sequence,
    });
  });

  await appendEvent(state.paths, {
    actor: "controller",
    event: "controller_started",
    runToken: options.runToken,
    proofMode: state.proof.mode,
    rewardLamports,
    intervalMs: options.intervalMs,
    count: options.count,
  });

  process.stdout.write(
    `[${nowIso()}] Controller ready. Run token ${options.runToken}; reward ${formatSol(rewardLamports)}; interval ${options.intervalMs}ms\n`,
  );

  while (!stopped) {
    if (options.count > 0 && sequence >= options.count) {
      break;
    }

    sequence += 1;
    const taskId = taskIdFor(options.runToken, sequence);
    const description = fixedLengthBuffer(
      `Devnet soak ${options.runToken} #${sequence}`,
      64,
    );
    const deadline = Math.floor(Date.now() / 1000) + options.deadlineSeconds;

    try {
      await topUpMemberAccount(
        state.context.connection,
        state.context.authority,
        state.creatorKeypair,
        creatorMinBalanceLamports,
        creatorTargetBalanceLamports,
        "creator",
      );

      const { taskPda, txSignature } = await withRetries(
        `createTask(${sequence})`,
        async () =>
          createTask(
            state.context.connection,
            state.context.program,
            state.creatorKeypair,
            state.creator.agentId,
            {
              taskId,
              requiredCapabilities: CAPABILITY_COMPUTE,
              description,
              rewardAmount: rewardLamports,
              maxWorkers: 1,
              deadline,
              taskType: TASK_TYPE_EXCLUSIVE,
              constraintHash: state.proof.constraintHashBytes
                ? Array.from(state.proof.constraintHashBytes)
                : null,
              minReputation: 0,
              rewardMint: null,
            },
          ),
      );

      const taskBase58 = taskPda.toBase58();
      process.stdout.write(
        `[${nowIso()}] Created task #${sequence} ${shortKey(taskBase58)} (${taskBase58}) tx=${txSignature}\n`,
      );
      await appendEvent(state.paths, {
        actor: "controller",
        event: "task_created",
        sequence,
        runToken: options.runToken,
        proofMode: state.proof.mode,
        taskPda: taskBase58,
        rewardLamports,
        deadline,
        constraintHashHex: state.proof.constraintHashBytes?.toString("hex") ?? null,
        txSignature,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stdout.write(
        `[${nowIso()}] Failed to create task #${sequence}: ${message}\n`,
      );
      await appendEvent(state.paths, {
        actor: "controller",
        event: "task_create_failed",
        sequence,
        runToken: options.runToken,
        error: message,
      });
    }

    if (stopped) {
      break;
    }
    await sleep(options.intervalMs);
  }

  await appendEvent(state.paths, {
    actor: "controller",
    event: "controller_finished",
    proofMode: state.proof.mode,
    submittedCount: sequence,
    runToken: options.runToken,
  });
}

async function runWorker(options) {
  if (!Number.isInteger(options.workerIndex) || options.workerIndex < 1 || options.workerIndex > options.workerCount) {
    throw new Error(`worker --worker-index must be between 1 and ${options.workerCount}`);
  }
  if (options.proofMode === "private" && !options.proverEndpoint) {
    throw new Error("worker private proof mode requires --prover-endpoint");
  }

  const state = await ensureHarnessState(options);
  const workerArrayIndex = options.workerIndex - 1;
  const workerMeta = state.workers[workerArrayIndex];
  const workerKeypair = state.workerKeypairs[workerArrayIndex];
  const proverConfig = state.proof.mode === "private"
    ? {
        kind: "remote",
        endpoint: options.proverEndpoint,
        timeoutMs: options.proverTimeoutMs,
      }
    : null;
  const agentSecret = state.proof.mode === "private"
    ? deriveFixtureAgentSecret(workerKeypair.secretKey)
    : null;
  const attempted = new Set();
  let stopped = false;
  let claimedCount = 0;
  let completedCount = 0;

  for (const event of await readEvents(state.paths)) {
    if (typeof event.taskPda === "string" && typeof event.workerIndex === "number" && event.workerIndex === options.workerIndex) {
      attempted.add(event.taskPda);
    }
  }

  installSignalHandlers(async () => {
    stopped = true;
    await appendEvent(state.paths, {
      actor: "worker",
      event: "worker_stopped",
      workerIndex: options.workerIndex,
      proofMode: state.proof.mode,
      claimedCount,
      completedCount,
    });
  });

  await appendEvent(state.paths, {
    actor: "worker",
    event: "worker_started",
    workerIndex: options.workerIndex,
    proofMode: state.proof.mode,
    authority: workerKeypair.publicKey.toBase58(),
    agentPda: workerMeta.agentPda.toBase58(),
  });

  process.stdout.write(
    `[${nowIso()}] Worker ${options.workerIndex} ready. authority=${workerKeypair.publicKey.toBase58()} agent=${workerMeta.agentPda.toBase58()}\n`,
  );

  while (!stopped) {
    const events = await readEvents(state.paths);
    const pendingTasks = events.filter(
      (event) =>
        event &&
        event.event === "task_created" &&
        typeof event.taskPda === "string" &&
        (typeof event.proofMode !== "string" || event.proofMode === state.proof.mode) &&
        !attempted.has(event.taskPda),
    );

    for (const event of pendingTasks) {
      if (stopped) {
        break;
      }

      const taskPda = event.taskPda;
      attempted.add(taskPda);
      const taskPubkey = new PublicKey(taskPda);

      try {
        const claim = await withRetries(
          `claimTask(worker:${options.workerIndex}, task:${shortKey(taskPda)})`,
          async () =>
            claimTask(
              state.context.connection,
              state.context.program,
              workerKeypair,
              workerMeta.agentId,
              taskPubkey,
            ),
        );
        claimedCount += 1;
        process.stdout.write(
          `[${nowIso()}] Worker ${options.workerIndex} claimed ${taskPda} tx=${claim.txSignature}\n`,
        );
        await appendEvent(state.paths, {
          actor: "worker",
          event: "task_claimed",
          workerIndex: options.workerIndex,
          proofMode: state.proof.mode,
          taskPda,
          txSignature: claim.txSignature,
        });

        let completion;
        if (state.proof.mode === "private") {
          const proofResult = await generateProof(
            {
              taskPda: taskPubkey,
              agentPubkey: workerKeypair.publicKey,
              output: state.proof.output,
              salt: generateSalt(),
              agentSecret,
            },
            proverConfig,
          );
          await appendEvent(state.paths, {
            actor: "worker",
            event: "proof_generated",
            workerIndex: options.workerIndex,
            taskPda,
            generationTimeMs: proofResult.generationTime,
            proofSize: proofResult.proofSize,
            nullifierHex: proofResult.nullifierSeed.toString("hex"),
          });
          completion = await withRetries(
            `completeTaskPrivate(worker:${options.workerIndex}, task:${shortKey(taskPda)})`,
            async () =>
              completeTaskPrivateVersioned(
                state.context,
                workerKeypair,
                workerMeta,
                taskPubkey,
                proofResult,
                state.protocol,
              ),
            2,
          );
        } else {
          const proofHash = crypto
            .createHash("sha256")
            .update(`${options.workerIndex}:${taskPda}:proof`)
            .digest();

          completion = await withRetries(
            `completeTask(worker:${options.workerIndex}, task:${shortKey(taskPda)})`,
            async () =>
              completeTask(
                state.context.connection,
                state.context.program,
                workerKeypair,
                workerMeta.agentId,
                taskPubkey,
                proofHash,
                null,
              ),
          );
        }
        completedCount += 1;
        process.stdout.write(
          `[${nowIso()}] Worker ${options.workerIndex} completed ${taskPda} tx=${completion.txSignature}\n`,
        );
        await appendEvent(state.paths, {
          actor: "worker",
          event: state.proof.mode === "private"
            ? "task_completed_private"
            : "task_completed",
          workerIndex: options.workerIndex,
          proofMode: state.proof.mode,
          taskPda,
          txSignature: completion.txSignature,
          lookupTableAddress: completion.lookupTableAddress ?? null,
          lookupTableTxSignature: completion.lookupTableTxSignature ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const eventName = isExpectedClaimConflict(message)
          ? "task_claim_conflict"
          : "task_processing_failed";
        process.stdout.write(
          `[${nowIso()}] Worker ${options.workerIndex} skipped ${taskPda}: ${message}\n`,
        );
        await appendEvent(state.paths, {
          actor: "worker",
          event: eventName,
          workerIndex: options.workerIndex,
          proofMode: state.proof.mode,
          taskPda,
          error: message,
        });
      }
    }

    await sleep(options.pollMs);
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    usage();
    process.exit(1);
  }

  if (options.help || !options.command) {
    usage();
    process.exit(options.help ? 0 : 1);
  }

  if (!existsSync(options.keypairPath)) {
    throw new Error(`Operator keypair not found: ${options.keypairPath}`);
  }

  if (options.command === "prepare") {
    await runPrepare(options);
    return;
  }
  if (options.command === "controller") {
    await runController(options);
    return;
  }
  if (options.command === "worker") {
    await runWorker(options);
    return;
  }

  throw new Error(`Unknown command: ${options.command}`);
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
