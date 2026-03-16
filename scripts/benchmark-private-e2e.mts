#!/usr/bin/env node

import * as anchor from "@coral-xyz/anchor";
import { Program, type Idl } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  bigintToBytes32,
  computeConstraintHash,
  deriveAgentPda,
  deriveClaimPda,
  deriveEscrowPda,
  PROGRAM_ID,
  deriveProtocolPda,
  deriveZkConfigPda,
  deriveTaskPda,
  getZkConfig,
  initializeZkConfig,
  RISC0_IMAGE_ID_LEN,
  TRUSTED_RISC0_IMAGE_ID,
  updateZkImageId,
} from "@tetsuo-ai/sdk";
import {
  IDL,
  type AgencCoordination,
  ProofEngine,
  TaskOperations,
  taskStatusToString,
  createLogger,
  keypairToWallet,
} from "@tetsuo-ai/runtime";
const require = createRequire(import.meta.url);
const {
  deriveRouterPda,
  deriveVerifierEntryPda,
  deriveVerifierProgramDataPda,
  GROTH16_SELECTOR,
  ROUTER_PROGRAM_ID,
  VERIFIER_PROGRAM_ID,
  hasExpectedProgramDataAuthority,
  isExpectedVerifierEntryData,
} = require("./verifier-localnet") as typeof import("./verifier-localnet");

const CAPABILITY_COMPUTE = 1;
const TASK_TYPE_EXCLUSIVE = 0;
const DEFAULT_AGENT_STAKE_LAMPORTS = 0.2 * LAMPORTS_PER_SOL;
const DEFAULT_REWARD_LAMPORTS = 0.3 * LAMPORTS_PER_SOL;
const DEFAULT_ACCOUNT_FUNDING_LAMPORTS = 2 * LAMPORTS_PER_SOL;
const DEFAULT_OUTPUT = [11n, 22n, 33n, 44n];
const DEFAULT_OUTPUT_PATH = path.resolve(
  process.cwd(),
  "benchmarks/private-proof-e2e/latest.json",
);
const DEFAULT_MARKDOWN_PATH = path.resolve(
  process.cwd(),
  "benchmarks/private-proof-e2e/latest.md",
);
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
const BENCHMARK_HELP_TEXT = [
  "Usage: benchmark-private-e2e [options]",
  "",
  "Required:",
  "  --prover-endpoint <url>        Remote prover endpoint (or set AGENC_PROVER_ENDPOINT)",
  "",
  "Options:",
  "  --rounds <int>                 Number of end-to-end rounds (default: 1)",
  "  --output <path>                JSON artifact path",
  "  --markdown-output <path>       Markdown summary path",
  "  --prover-timeout-ms <int>      Remote prover timeout",
  "  --header name=value            Repeatable remote prover header",
  "  --creator-keypair <path>       Reuse an existing creator wallet instead of funding a new one",
  "  --worker-keypair <path>        Reuse an existing worker wallet instead of funding a new one",
  "  --stake-lamports <int>         Optional agent stake override for low-budget smoke runs",
  "  --reward-lamports <int>        Reward escrowed into the task",
  "  --funding-lamports <int>       Funding per creator/worker account",
  "  --output-values a,b,c,d        Private task expected output values",
  "  --agent-secret <bigint>        Secret witness used for proof generation",
  "  --log-level <level>            debug | info | warn | error",
  "",
  "Environment:",
  "  ANCHOR_PROVIDER_URL            RPC URL (default anchor env)",
  "  ANCHOR_WALLET                  Wallet path (default anchor env)",
  "  AGENC_PROVER_ENDPOINT          Remote prover endpoint",
  "  AGENC_PROVER_API_KEY           Adds x-api-key header automatically",
  '  AGENC_PROVER_HEADERS_JSON      JSON object of additional headers, e.g. {"authorization":"Bearer ..."}',
  "",
  "Expected local verifier setup:",
  "  bash scripts/setup-verifier-localnet.sh --mode real",
  "  npx tsx scripts/setup-verifier-localnet.ts",
].join("\n");

interface CliOptions {
  rounds: number;
  outputPath: string;
  markdownPath: string;
  proverEndpoint: string;
  proverTimeoutMs?: number;
  proverHeaders: Record<string, string>;
  creatorKeypairPath?: string;
  workerKeypairPath?: string;
  stakeLamports?: number;
  rewardLamports: number;
  fundingLamports: number;
  output: bigint[];
  agentSecret: bigint;
  logLevel: "debug" | "info" | "warn" | "error";
}

interface FundingResult {
  strategy: "airdrop" | "payer-transfer" | "preloaded";
  signature: string;
}

interface ProtocolBootstrapResult {
  protocolPda: string;
  treasury: string;
  initializedThisRun: boolean;
  durationMs: number;
}

interface ParsedCliValue {
  nextIndex: number;
  value: string;
}

interface BenchmarkRoundArtifact {
  round: number;
  creator: string;
  worker: string;
  creatorAgent: string;
  workerAgent: string;
  taskPda: string;
  claimPda: string;
  finalTaskStatus: string;
  funding: {
    creator: FundingResult;
    worker: FundingResult;
  };
  signatures: {
    registerCreator: string;
    registerWorker: string;
    createTask: string;
    claimTask: string;
    completeTaskPrivate: string;
  };
  proof: {
    proofSizeBytes: number;
    journalBytes: number;
    imageIdHex: string;
    bindingSeedHex: string;
    nullifierSeedHex: string;
    selectorHex: string;
  };
  timingsMs: {
    fundCreator: number;
    fundWorker: number;
    registerCreator: number;
    registerWorker: number;
    createTask: number;
    claimTask: number;
    proofGeneration: number;
    proofGenerationReported: number;
    submitCompletion: number;
    total: number;
  };
}

interface BenchmarkArtifact {
  schemaVersion: 1;
  benchmark: "private-task-e2e";
  generatedAt: string;
  gitCommit: string | null;
  network: {
    rpcUrl: string;
    slot: number;
    routerProgramId: string;
    verifierProgramId: string;
    routerPda: string;
    verifierEntryPda: string;
    verifierProgramDataPda: string;
  };
  prover: {
    kind: "remote";
    endpoint: string;
    timeoutMs: number | null;
    configuredHeaders: string[];
    methodIdHex: string;
  };
  config: {
    rounds: number;
    stakeLamports: number;
    rewardLamports: number;
    fundingLamports: number;
    output: string[];
  };
  bootstrap: ProtocolBootstrapResult;
  aggregate: {
    rounds: number;
    meanProofGenerationMs: number;
    medianProofGenerationMs: number;
    meanSubmitCompletionMs: number;
    medianSubmitCompletionMs: number;
    meanTotalMs: number;
    medianTotalMs: number;
    minTotalMs: number;
    maxTotalMs: number;
  };
  rounds: BenchmarkRoundArtifact[];
}

function resolveDefaultProverHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiKey = process.env.AGENC_PROVER_API_KEY;
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  const headersJson = process.env.AGENC_PROVER_HEADERS_JSON;
  if (headersJson) {
    const parsed = JSON.parse(headersJson) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.length > 0) {
        headers[key] = value;
      }
    }
  }
  return headers;
}

function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ${flag} value: ${raw}`);
  }
  return parsed;
}

function parseNonNegativeInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`invalid ${flag} value: ${raw}`);
  }
  return parsed;
}

function parseOutput(raw: string): bigint[] {
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(BigInt);
  if (values.length !== 4) {
    throw new Error("private proof benchmark output must contain exactly 4 values");
  }
  return values;
}

function parseLogLevel(raw: string): CliOptions["logLevel"] {
  if (!LOG_LEVELS.includes(raw as CliOptions["logLevel"])) {
    throw new Error(`invalid --log-level value: ${raw}`);
  }
  return raw as CliOptions["logLevel"];
}

function fixedLengthBuffer(value: string, size: number): Buffer {
  const buffer = Buffer.alloc(size);
  Buffer.from(value, "utf8").copy(buffer, 0, 0, size);
  return buffer;
}

function resolveDefaultOptions(): CliOptions {
  return {
    rounds: 1,
    outputPath: DEFAULT_OUTPUT_PATH,
    markdownPath: DEFAULT_MARKDOWN_PATH,
    proverEndpoint: process.env.AGENC_PROVER_ENDPOINT ?? "",
    proverTimeoutMs: process.env.AGENC_PROVER_TIMEOUT_MS
      ? parsePositiveInt(process.env.AGENC_PROVER_TIMEOUT_MS, "AGENC_PROVER_TIMEOUT_MS")
      : undefined,
    proverHeaders: resolveDefaultProverHeaders(),
    creatorKeypairPath: process.env.AGENC_BENCH_CREATOR_KEYPAIR_PATH
      ? path.resolve(process.cwd(), process.env.AGENC_BENCH_CREATOR_KEYPAIR_PATH)
      : undefined,
    workerKeypairPath: process.env.AGENC_BENCH_WORKER_KEYPAIR_PATH
      ? path.resolve(process.cwd(), process.env.AGENC_BENCH_WORKER_KEYPAIR_PATH)
      : undefined,
    stakeLamports: process.env.AGENC_BENCH_STAKE_LAMPORTS
      ? parsePositiveInt(
          process.env.AGENC_BENCH_STAKE_LAMPORTS,
          "AGENC_BENCH_STAKE_LAMPORTS",
        )
      : undefined,
    rewardLamports: parseNonNegativeInt(
      process.env.AGENC_BENCH_REWARD_LAMPORTS ?? String(DEFAULT_REWARD_LAMPORTS),
      "AGENC_BENCH_REWARD_LAMPORTS",
    ),
    fundingLamports: parseNonNegativeInt(
      process.env.AGENC_BENCH_ACCOUNT_FUNDING_LAMPORTS ??
        String(DEFAULT_ACCOUNT_FUNDING_LAMPORTS),
      "AGENC_BENCH_ACCOUNT_FUNDING_LAMPORTS",
    ),
    output: process.env.AGENC_BENCH_OUTPUT
      ? parseOutput(process.env.AGENC_BENCH_OUTPUT)
      : [...DEFAULT_OUTPUT],
    agentSecret: BigInt(process.env.AGENC_BENCH_AGENT_SECRET ?? "42"),
    logLevel: parseLogLevel(process.env.AGENC_BENCH_LOG_LEVEL ?? "info"),
  };
}

function readCliValue(
  argv: string[],
  index: number,
  flag: string,
): ParsedCliValue {
  const value = argv[index + 1];
  if (value === undefined) {
    throw new Error(`missing ${flag} value`);
  }
  return { nextIndex: index + 1, value };
}

function applyCliOption(
  options: CliOptions,
  flag: string,
  value: string,
): void {
  switch (flag) {
    case "--rounds":
      options.rounds = parsePositiveInt(value, flag);
      break;
    case "--output":
      options.outputPath = path.resolve(process.cwd(), value);
      break;
    case "--markdown-output":
      options.markdownPath = path.resolve(process.cwd(), value);
      break;
    case "--prover-endpoint":
      options.proverEndpoint = value;
      break;
    case "--prover-timeout-ms":
      options.proverTimeoutMs = parsePositiveInt(value, flag);
      break;
    case "--header": {
      const [key, ...valueParts] = value.split("=");
      const headerValue = valueParts.join("=");
      if (!key || !headerValue) {
        throw new Error(`invalid --header value: ${value}`);
      }
      options.proverHeaders[key] = headerValue;
      break;
    }
    case "--creator-keypair":
      options.creatorKeypairPath = path.resolve(process.cwd(), value);
      break;
    case "--worker-keypair":
      options.workerKeypairPath = path.resolve(process.cwd(), value);
      break;
    case "--stake-lamports":
      options.stakeLamports = parsePositiveInt(value, flag);
      break;
    case "--reward-lamports":
      options.rewardLamports = parseNonNegativeInt(value, flag);
      break;
    case "--funding-lamports":
      options.fundingLamports = parseNonNegativeInt(value, flag);
      break;
    case "--output-values":
      options.output = parseOutput(value);
      break;
    case "--agent-secret":
      options.agentSecret = BigInt(value);
      break;
    case "--log-level":
      options.logLevel = parseLogLevel(value);
      break;
    default:
      throw new Error(`unknown option: ${flag}`);
  }
}

function printHelpAndExit(): never {
  console.log(BENCHMARK_HELP_TEXT);
  process.exit(0);
}

function parseCliArgs(argv: string[]): CliOptions {
  const options = resolveDefaultOptions();

  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--help") {
      printHelpAndExit();
    }

    const parsedValue = readCliValue(argv, index, arg);
    applyCliOption(options, arg, parsedValue.value);
    index = parsedValue.nextIndex + 1;
  }

  if (!options.proverEndpoint) {
    throw new Error(
      "missing remote prover endpoint: pass --prover-endpoint or set AGENC_PROVER_ENDPOINT",
    );
  }

  return options;
}

function isAirdropSupported(rpcUrl: string): boolean {
  if (process.env.AGENC_BENCH_DISABLE_AIRDROP === "1") {
    return false;
  }
  return (
    rpcUrl.includes("127.0.0.1") ||
    rpcUrl.includes("localhost") ||
    rpcUrl.includes("devnet")
  );
}

function sanitizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    return `${url.origin}${url.pathname}`;
  } catch {
    return endpoint;
  }
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function nowIso(): string {
  return new Date().toISOString();
}

function measure<T>(fn: () => Promise<T>): Promise<{ durationMs: number; result: T }> {
  const startedAt = Date.now();
  return fn().then((result) => ({
    durationMs: Date.now() - startedAt,
    result,
  }));
}

function deriveProgramDataPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"),
  )[0];
}

function makeId(seed: string): Buffer {
  return createHash("sha256").update(seed).digest();
}

function resolveGitDir(cwd: string): string | null {
  const dotGitPath = path.join(cwd, ".git");
  if (!existsSync(dotGitPath)) {
    return null;
  }

  try {
    const dotGitContents = readFileSync(dotGitPath, "utf8").trim();
    if (dotGitContents.startsWith("gitdir:")) {
      return path.resolve(cwd, dotGitContents.slice("gitdir:".length).trim());
    }
  } catch {
    return dotGitPath;
  }

  return dotGitPath;
}

function readPackedRef(gitDir: string, refPath: string): string | null {
  const packedRefsPath = path.join(gitDir, "packed-refs");
  if (!existsSync(packedRefsPath)) {
    return null;
  }

  const packedRefs = readFileSync(packedRefsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean);
  for (const line of packedRefs) {
    if (line.startsWith("#") || line.startsWith("^")) {
      continue;
    }
    const [commit, ref] = line.split(" ");
    if (ref === refPath && commit) {
      return commit;
    }
  }
  return null;
}

function safeGitCommit(cwd = process.cwd()): string | null {
  const envCommit = process.env.GITHUB_SHA?.trim();
  if (envCommit) {
    return envCommit;
  }

  const gitDir = resolveGitDir(cwd);
  if (!gitDir) {
    return null;
  }

  try {
    const head = readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (!head) {
      return null;
    }
    if (!head.startsWith("ref: ")) {
      return head;
    }

    const refPath = head.slice("ref: ".length).trim();
    const looseRefPath = path.join(gitDir, refPath);
    if (existsSync(looseRefPath)) {
      return readFileSync(looseRefPath, "utf8").trim() || null;
    }

    return readPackedRef(gitDir, refPath);
  } catch {
    return null;
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 0) {
    return (ordered[mid - 1] + ordered[mid]) / 2;
  }
  return ordered[mid];
}

function imageIdsEqual(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function getWalletPayer(wallet: anchor.Wallet): Keypair | undefined {
  const payer = Reflect.get(wallet, "payer");
  return payer instanceof Keypair ? payer : undefined;
}

function requireAuthorityKeypair(provider: anchor.AnchorProvider): Keypair {
  const payer = getWalletPayer(provider.wallet);
  if (!payer) {
    throw new TypeError(
      "benchmark-private-e2e requires ANCHOR_WALLET to be a local keypair-backed wallet",
    );
  }
  return payer;
}

function loadKeypairFromFile(filePath: string): Keypair {
  const secret = JSON.parse(readFileSync(filePath, "utf8")) as number[];
  if (!Array.isArray(secret)) {
    throw new TypeError(`invalid keypair file: ${filePath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function createCoordinationProgram(
  provider: anchor.AnchorProvider,
  programId: PublicKey = PROGRAM_ID,
): Program<AgencCoordination> {
  return new Program(
    {
      ...(IDL as Idl),
      address: programId.toBase58(),
    },
    provider,
  ) as Program<AgencCoordination>;
}

async function ensureTrustedImageId(
  provider: anchor.AnchorProvider,
  program: Program<AgencCoordination>,
): Promise<Uint8Array> {
  const expectedImageId = Uint8Array.from(TRUSTED_RISC0_IMAGE_ID);
  const zkConfig = await getZkConfig(program);
  if (!zkConfig) {
    await initializeZkConfig(
      provider.connection,
      program,
      requireAuthorityKeypair(provider),
      expectedImageId,
    );
    return expectedImageId;
  }
  if (zkConfig.activeImageId.length !== RISC0_IMAGE_ID_LEN) {
    throw new Error(
      `zk_config active image ID must be ${RISC0_IMAGE_ID_LEN} bytes, got ${zkConfig.activeImageId.length}`,
    );
  }
  if (!imageIdsEqual(zkConfig.activeImageId, expectedImageId)) {
    await updateZkImageId(
      provider.connection,
      program,
      requireAuthorityKeypair(provider),
      expectedImageId,
    );
    return expectedImageId;
  }
  return zkConfig.activeImageId;
}

async function fundKeypair(
  provider: anchor.AnchorProvider,
  recipient: PublicKey,
  lamports: number,
): Promise<FundingResult> {
  if (isAirdropSupported(provider.connection.rpcEndpoint)) {
    try {
      const signature = await provider.connection.requestAirdrop(recipient, lamports);
      await provider.connection.confirmTransaction(signature, "confirmed");
      return { strategy: "airdrop", signature };
    } catch {
      // Fall through to payer funding.
    }
  }

  const transfer = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: provider.wallet.publicKey,
      toPubkey: recipient,
      lamports,
    }),
  );
  const signature = await provider.sendAndConfirm(transfer, []);
  return { strategy: "payer-transfer", signature };
}

async function assertVerifierStackReady(
  connection: anchor.web3.Connection,
): Promise<void> {
  const routerPda = deriveRouterPda();
  const verifierEntryPda = deriveVerifierEntryPda();
  const verifierProgramDataPda = deriveVerifierProgramDataPda();

  const [
    routerProgramInfo,
    verifierProgramInfo,
    verifierProgramDataInfo,
    routerPdaInfo,
    verifierEntryInfo,
  ] = await Promise.all([
    connection.getAccountInfo(ROUTER_PROGRAM_ID),
    connection.getAccountInfo(VERIFIER_PROGRAM_ID),
    connection.getAccountInfo(verifierProgramDataPda),
    connection.getAccountInfo(routerPda),
    connection.getAccountInfo(verifierEntryPda),
  ]);

  if (!routerProgramInfo?.executable) {
    throw new Error(
      `Verifier router ${ROUTER_PROGRAM_ID.toBase58()} is not deployed. Run: bash scripts/setup-verifier-localnet.sh --mode real`,
    );
  }
  if (!verifierProgramInfo?.executable) {
    throw new Error(
      `Groth16 verifier ${VERIFIER_PROGRAM_ID.toBase58()} is not deployed. Run: bash scripts/setup-verifier-localnet.sh --mode real`,
    );
  }
  if (!hasExpectedProgramDataAuthority(verifierProgramDataInfo, routerPda)) {
    throw new Error(
      "Verifier ProgramData upgrade authority is not pinned to the router PDA. This RPC is not using the expected real verifier stack.",
    );
  }
  if (!routerPdaInfo) {
    throw new Error(
      `Router PDA ${routerPda.toBase58()} is not initialized. Run: npx tsx scripts/setup-verifier-localnet.ts`,
    );
  }
  if (!verifierEntryInfo || !isExpectedVerifierEntryData(verifierEntryInfo.data)) {
    throw new Error(
      `Verifier entry PDA ${verifierEntryPda.toBase58()} is not initialized with the expected Groth16 entry. Run: npx tsx scripts/setup-verifier-localnet.ts`,
    );
  }
}

async function ensureProtocolInitialized(
  provider: anchor.AnchorProvider,
  program: Program<AgencCoordination>,
): Promise<ProtocolBootstrapResult> {
  const protocolPda = deriveProtocolPda(program.programId);
  const startedAt = Date.now();

  try {
    const existing = await program.account.protocolConfig.fetch(protocolPda);
    return {
      protocolPda: protocolPda.toBase58(),
      treasury: existing.treasury.toBase58(),
      initializedThisRun: false,
      durationMs: Date.now() - startedAt,
    };
  } catch {
    const treasury = Keypair.generate();
    const thirdSigner = Keypair.generate();
    const multisigOwners = [
      provider.wallet.publicKey,
      treasury.publicKey,
      thirdSigner.publicKey,
    ];

    await program.methods
      .initializeProtocol(
        51,
        100,
        new BN(LAMPORTS_PER_SOL / 10),
        new BN(LAMPORTS_PER_SOL / 100),
        2,
        multisigOwners,
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
        {
          pubkey: thirdSigner.publicKey,
          isSigner: true,
          isWritable: false,
        },
      ])
      .signers([treasury, thirdSigner])
      .rpc();

    return {
      protocolPda: protocolPda.toBase58(),
      treasury: treasury.publicKey.toBase58(),
      initializedThisRun: true,
      durationMs: Date.now() - startedAt,
    };
  }
}

async function registerBenchAgent(params: {
  program: Program<AgencCoordination>;
  protocolPda: PublicKey;
  authority: Keypair;
  agentId: Buffer;
  endpoint: string;
  stakeLamports: number;
}): Promise<{ agentPda: PublicKey; signature: string }> {
  const agentPda = deriveAgentPda(params.agentId, params.program.programId);
  const signature = await params.program.methods
    .registerAgent(
      Array.from(params.agentId),
      new BN(CAPABILITY_COMPUTE),
      params.endpoint,
      null,
      new BN(params.stakeLamports),
    )
    .accountsPartial({
      agent: agentPda,
      protocolConfig: params.protocolPda,
      authority: params.authority.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([params.authority])
    .rpc();

  return { agentPda, signature };
}

async function createPrivateTask(params: {
  program: Program<AgencCoordination>;
  protocolPda: PublicKey;
  creator: Keypair;
  creatorAgentPda: PublicKey;
  taskId: Buffer;
  rewardLamports: number;
  constraintHashBytes: Uint8Array;
  description: string;
}): Promise<{ taskPda: PublicKey; escrowPda: PublicKey; signature: string }> {
  const taskPda = deriveTaskPda(
    params.creator.publicKey,
    params.taskId,
    params.program.programId,
  );
  const escrowPda = deriveEscrowPda(taskPda, params.program.programId);
  const deadline = new BN(Math.floor(Date.now() / 1000) + 3600);
  const descriptionBytes = fixedLengthBuffer(params.description, 64);

  const signature = await params.program.methods
    .createTask(
      Array.from(params.taskId),
      new BN(CAPABILITY_COMPUTE),
      descriptionBytes,
      new BN(params.rewardLamports),
      1,
      deadline,
      TASK_TYPE_EXCLUSIVE,
      Array.from(params.constraintHashBytes),
      0,
      null,
    )
    .accountsPartial({
      task: taskPda,
      escrow: escrowPda,
      creatorAgent: params.creatorAgentPda,
      protocolConfig: params.protocolPda,
      authority: params.creator.publicKey,
      creator: params.creator.publicKey,
      systemProgram: SystemProgram.programId,
      rewardMint: null,
      creatorTokenAccount: null,
      tokenEscrowAta: null,
      tokenProgram: null,
      associatedTokenProgram: null,
    })
    .signers([params.creator])
    .rpc();

  return { taskPda, escrowPda, signature };
}

async function claimPrivateTask(params: {
  program: Program<AgencCoordination>;
  protocolPda: PublicKey;
  worker: Keypair;
  workerAgentPda: PublicKey;
  taskPda: PublicKey;
}): Promise<{ claimPda: PublicKey; signature: string }> {
  const claimPda = deriveClaimPda(
    params.taskPda,
    params.workerAgentPda,
    params.program.programId,
  );
  const signature = await params.program.methods
    .claimTask()
    .accountsPartial({
      task: params.taskPda,
      claim: claimPda,
      worker: params.workerAgentPda,
      protocolConfig: params.protocolPda,
      authority: params.worker.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([params.worker])
    .rpc();

  return { claimPda, signature };
}

async function completePrivateTaskVersioned(params: {
  connection: anchor.web3.Connection;
  program: Program<AgencCoordination>;
  protocolPda: PublicKey;
  worker: Keypair;
  workerAgentPda: PublicKey;
  taskPda: PublicKey;
  creator: PublicKey;
  taskId: Uint8Array;
  sealBytes: Uint8Array;
  journal: Uint8Array;
  imageId: Uint8Array;
  bindingSeed: Uint8Array;
  nullifierSeed: Uint8Array;
}): Promise<{ signature: string }> {
  const claimPda = deriveClaimPda(
    params.taskPda,
    params.workerAgentPda,
    params.program.programId,
  );
  const escrowPda = deriveEscrowPda(params.taskPda, params.program.programId);
  const zkConfigPda = deriveZkConfigPda(params.program.programId);
  const [bindingSpendPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("binding_spend"), Buffer.from(params.bindingSeed)],
    params.program.programId,
  );
  const [nullifierSpendPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("nullifier_spend"), Buffer.from(params.nullifierSeed)],
    params.program.programId,
  );
  const routerPda = deriveRouterPda();
  const verifierEntryPda = deriveVerifierEntryPda();
  const protocolConfig = await params.program.account.protocolConfig.fetch(
    params.protocolPda,
  );
  const taskIdU64 = new BN(params.taskId.slice(0, 8), "le");

  const recentSlot = await params.connection.getSlot("finalized");
  const [createLookupTableIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: params.worker.publicKey,
      payer: params.worker.publicKey,
      recentSlot,
    });
  const extendLookupTableIx = AddressLookupTableProgram.extendLookupTable({
    payer: params.worker.publicKey,
    authority: params.worker.publicKey,
    lookupTable: lookupTableAddress,
    addresses: [
      params.taskPda,
      claimPda,
      escrowPda,
      params.creator,
      params.workerAgentPda,
      params.protocolPda,
      zkConfigPda,
      bindingSpendPda,
      nullifierSpendPda,
      protocolConfig.treasury,
      ROUTER_PROGRAM_ID,
      routerPda,
      verifierEntryPda,
      VERIFIER_PROGRAM_ID,
      SystemProgram.programId,
      params.program.programId,
    ],
  });

  await sendAndConfirmTransaction(
    params.connection,
    new Transaction().add(createLookupTableIx, extendLookupTableIx),
    [params.worker],
    { commitment: "confirmed" },
  );

  await new Promise((resolve) => setTimeout(resolve, 2000));

  const lookupTableResult = await params.connection.getAddressLookupTable(
    lookupTableAddress,
  );
  if (!lookupTableResult.value) {
    throw new Error("lookup table not found after creation");
  }

  const completeIx = await params.program.methods
    .completeTaskPrivate(taskIdU64, {
      sealBytes: Buffer.from(params.sealBytes),
      journal: Buffer.from(params.journal),
      imageId: Array.from(params.imageId),
      bindingSeed: Array.from(params.bindingSeed),
      nullifierSeed: Array.from(params.nullifierSeed),
    })
    .accountsPartial({
      task: params.taskPda,
      claim: claimPda,
      escrow: escrowPda,
      creator: params.creator,
      worker: params.workerAgentPda,
      protocolConfig: params.protocolPda,
      zkConfig: zkConfigPda,
      bindingSpend: bindingSpendPda,
      nullifierSpend: nullifierSpendPda,
      treasury: protocolConfig.treasury,
      authority: params.worker.publicKey,
      routerProgram: ROUTER_PROGRAM_ID,
      router: routerPda,
      verifierEntry: verifierEntryPda,
      verifierProgram: VERIFIER_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      tokenEscrowAta: null,
      workerTokenAccount: null,
      treasuryTokenAccount: null,
      rewardMint: null,
      tokenProgram: null,
    })
    .instruction();

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { blockhash, lastValidBlockHeight } =
      await params.connection.getLatestBlockhash("confirmed");
    const messageV0 = new TransactionMessage({
      payerKey: params.worker.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 500_000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }),
        completeIx,
      ],
    }).compileToV0Message([lookupTableResult.value]);

    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign([params.worker]);

    let signature: string;
    try {
      signature = await params.connection.sendTransaction(versionedTx, {
        maxRetries: 10,
        preflightCommitment: "confirmed",
      });
    } catch (error) {
      const simulation = await params.connection.simulateTransaction(versionedTx, {
        commitment: "confirmed",
      });
      const simulationLogs = simulation.value.logs ?? [];
      const simulationErr =
        simulation.value.err === null
          ? "unknown"
          : JSON.stringify(simulation.value.err);
      throw new Error(
        [
          `completeTaskPrivate send failed on attempt ${attempt}: ${String(error)}`,
          `simulation err: ${simulationErr}`,
          `simulation logs: ${simulationLogs.join("\n")}`,
        ].join("\n"),
      );
    }

    try {
      await params.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );
      return { signature };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === 3 ||
        !message.toLowerCase().includes("block height exceeded")
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_200));
    }
  }

  throw lastError ?? new Error("completeTaskPrivate transaction failed");
}

async function runRound(params: {
  round: number;
  options: CliOptions;
  provider: anchor.AnchorProvider;
  program: Program<AgencCoordination>;
  protocolPda: PublicKey;
  stakeLamports: number;
  activeImageId: Uint8Array;
  logger: ReturnType<typeof createLogger>;
}): Promise<BenchmarkRoundArtifact> {
  const roundStartedAt = Date.now();
  const {
    round,
    options,
    provider,
    program,
    protocolPda,
    stakeLamports,
    activeImageId,
    logger,
  } = params;
  const roundLabel = `private-bench:${nowIso()}:round:${round}`;

  const creator = options.creatorKeypairPath
    ? loadKeypairFromFile(options.creatorKeypairPath)
    : Keypair.generate();
  const worker = options.workerKeypairPath
    ? loadKeypairFromFile(options.workerKeypairPath)
    : Keypair.generate();
  if (creator.publicKey.equals(worker.publicKey)) {
    throw new Error("creator and worker keypairs must be distinct");
  }
  const creatorAgentId = makeId(`${roundLabel}:creator-agent`);
  const workerAgentId = makeId(`${roundLabel}:worker-agent`);
  const taskId = makeId(`${roundLabel}:task`);
  const constraintHash = computeConstraintHash(options.output);
  const constraintHashBytes = bigintToBytes32(constraintHash);

  const fundCreator = await measure(() =>
    options.creatorKeypairPath
      ? Promise.resolve({ strategy: "preloaded" as const, signature: "" })
      : fundKeypair(provider, creator.publicKey, options.fundingLamports),
  );
  logger.info(`[round ${round}] creator funding ready`);
  const fundWorker = await measure(() =>
    options.workerKeypairPath
      ? Promise.resolve({ strategy: "preloaded" as const, signature: "" })
      : fundKeypair(provider, worker.publicKey, options.fundingLamports),
  );
  logger.info(`[round ${round}] worker funding ready`);

  logger.info(`[round ${round}] registering creator agent`);
  const registerCreator = await measure(() =>
    registerBenchAgent({
      program,
      protocolPda,
      authority: creator,
      agentId: creatorAgentId,
      endpoint: "https://benchmark.creator.local",
      stakeLamports,
    }),
  );
  logger.info(`[round ${round}] registering worker agent`);
  const registerWorker = await measure(() =>
    registerBenchAgent({
      program,
      protocolPda,
      authority: worker,
      agentId: workerAgentId,
      endpoint: "https://benchmark.worker.local",
      stakeLamports,
    }),
  );

  logger.info(`[round ${round}] creating private task`);
  const createTaskResult = await measure(() =>
    createPrivateTask({
      program,
      protocolPda,
      creator,
      creatorAgentPda: registerCreator.result.agentPda,
      taskId,
      rewardLamports: options.rewardLamports,
      constraintHashBytes,
      description: `Private benchmark round ${round}`,
    }),
  );
  logger.info(`[round ${round}] claiming private task`);
  const claimTaskResult = await measure(() =>
    claimPrivateTask({
      program,
      protocolPda,
      worker,
      workerAgentPda: registerWorker.result.agentPda,
      taskPda: createTaskResult.result.taskPda,
    }),
  );

  const proofEngine = new ProofEngine({
    methodId: activeImageId,
    routerConfig: {
      routerProgramId: ROUTER_PROGRAM_ID,
      routerPda: deriveRouterPda(),
      verifierEntryPda: deriveVerifierEntryPda(),
      verifierProgramId: VERIFIER_PROGRAM_ID,
    },
    proverBackend: {
      kind: "remote",
      endpoint: options.proverEndpoint,
      timeoutMs: options.proverTimeoutMs,
      headers: options.proverHeaders,
    },
    logger,
  });

  const proofInputs = {
    taskPda: createTaskResult.result.taskPda,
    agentPubkey: worker.publicKey,
    output: options.output,
    salt: proofEngine.generateSalt(),
    agentSecret: options.agentSecret,
  };

  const generatedProof = await measure(() => proofEngine.generate(proofInputs));
  logger.info(`[round ${round}] proof generated, submitting private completion`);

  const workerProvider = new anchor.AnchorProvider(
    provider.connection,
    keypairToWallet(worker),
    provider.opts,
  );
  const workerProgram = createCoordinationProgram(
    workerProvider,
    program.programId,
  );

  const taskOps = new TaskOperations({
    program: workerProgram,
    agentId: workerAgentId,
    logger,
  });
  const task = await taskOps.fetchTask(createTaskResult.result.taskPda);
  if (!task) {
    throw new Error(
      `task ${createTaskResult.result.taskPda.toBase58()} was not found after creation`,
    );
  }

  const submitCompletion = await measure(() =>
    completePrivateTaskVersioned({
      connection: provider.connection,
      program: workerProgram,
      protocolPda,
      worker,
      workerAgentPda: registerWorker.result.agentPda,
      taskPda: createTaskResult.result.taskPda,
      creator: task.creator,
      taskId: task.taskId,
      sealBytes: generatedProof.result.sealBytes,
      journal: generatedProof.result.journal,
      imageId: generatedProof.result.imageId,
      bindingSeed: generatedProof.result.bindingSeed,
      nullifierSeed: generatedProof.result.nullifierSeed,
    }),
  );

  const completedTask = await taskOps.fetchTask(createTaskResult.result.taskPda);
  if (!completedTask) {
    throw new Error(
      `task ${createTaskResult.result.taskPda.toBase58()} was not found after completion`,
    );
  }

  return {
    round,
    creator: creator.publicKey.toBase58(),
    worker: worker.publicKey.toBase58(),
    creatorAgent: registerCreator.result.agentPda.toBase58(),
    workerAgent: registerWorker.result.agentPda.toBase58(),
    taskPda: createTaskResult.result.taskPda.toBase58(),
    claimPda: claimTaskResult.result.claimPda.toBase58(),
    finalTaskStatus: taskStatusToString(completedTask.status),
    funding: {
      creator: fundCreator.result,
      worker: fundWorker.result,
    },
    signatures: {
      registerCreator: registerCreator.result.signature,
      registerWorker: registerWorker.result.signature,
      createTask: createTaskResult.result.signature,
      claimTask: claimTaskResult.result.signature,
      completeTaskPrivate: submitCompletion.result.signature,
    },
    proof: {
      proofSizeBytes: generatedProof.result.proofSize,
      journalBytes: generatedProof.result.journal.length,
      imageIdHex: toHex(generatedProof.result.imageId),
      bindingSeedHex: toHex(generatedProof.result.bindingSeed),
      nullifierSeedHex: toHex(generatedProof.result.nullifierSeed),
      selectorHex: Buffer.from(GROTH16_SELECTOR).toString("hex"),
    },
    timingsMs: {
      fundCreator: fundCreator.durationMs,
      fundWorker: fundWorker.durationMs,
      registerCreator: registerCreator.durationMs,
      registerWorker: registerWorker.durationMs,
      createTask: createTaskResult.durationMs,
      claimTask: claimTaskResult.durationMs,
      proofGeneration: generatedProof.durationMs,
      proofGenerationReported: generatedProof.result.generationTimeMs,
      submitCompletion: submitCompletion.durationMs,
      total: Date.now() - roundStartedAt,
    },
  };
}

function buildArtifact(params: {
  options: CliOptions;
  rounds: BenchmarkRoundArtifact[];
  provider: anchor.AnchorProvider;
  bootstrap: ProtocolBootstrapResult;
  activeImageId: Uint8Array;
  stakeLamports: number;
}): BenchmarkArtifact {
  const proofDurations = params.rounds.map((round) => round.timingsMs.proofGeneration);
  const submitDurations = params.rounds.map(
    (round) => round.timingsMs.submitCompletion,
  );
  const totalDurations = params.rounds.map((round) => round.timingsMs.total);

  return {
    schemaVersion: 1,
    benchmark: "private-task-e2e",
    generatedAt: nowIso(),
    gitCommit: safeGitCommit(),
    network: {
      rpcUrl: params.provider.connection.rpcEndpoint,
      slot: 0,
      routerProgramId: ROUTER_PROGRAM_ID.toBase58(),
      verifierProgramId: VERIFIER_PROGRAM_ID.toBase58(),
      routerPda: deriveRouterPda().toBase58(),
      verifierEntryPda: deriveVerifierEntryPda().toBase58(),
      verifierProgramDataPda: deriveVerifierProgramDataPda().toBase58(),
    },
    prover: {
      kind: "remote",
      endpoint: sanitizeEndpoint(params.options.proverEndpoint),
      timeoutMs: params.options.proverTimeoutMs ?? null,
      configuredHeaders: Object.keys(params.options.proverHeaders),
      methodIdHex: Buffer.from(params.activeImageId).toString("hex"),
    },
    config: {
      rounds: params.options.rounds,
      stakeLamports: params.stakeLamports,
      rewardLamports: params.options.rewardLamports,
      fundingLamports: params.options.fundingLamports,
      output: params.options.output.map((value) => value.toString()),
    },
    bootstrap: params.bootstrap,
    aggregate: {
      rounds: params.rounds.length,
      meanProofGenerationMs: mean(proofDurations),
      medianProofGenerationMs: median(proofDurations),
      meanSubmitCompletionMs: mean(submitDurations),
      medianSubmitCompletionMs: median(submitDurations),
      meanTotalMs: mean(totalDurations),
      medianTotalMs: median(totalDurations),
      minTotalMs: totalDurations.length > 0 ? Math.min(...totalDurations) : 0,
      maxTotalMs: totalDurations.length > 0 ? Math.max(...totalDurations) : 0,
    },
    rounds: params.rounds,
  };
}

async function finalizeArtifact(
  artifact: BenchmarkArtifact,
  provider: anchor.AnchorProvider,
): Promise<BenchmarkArtifact> {
  return {
    ...artifact,
    network: {
      ...artifact.network,
      slot: await provider.connection.getSlot("confirmed"),
    },
  };
}

function renderMarkdown(artifact: BenchmarkArtifact): string {
  const lines = [
    "# Private Task E2E Benchmark",
    "",
    `Generated: ${artifact.generatedAt}`,
    artifact.gitCommit ? `Git commit: \`${artifact.gitCommit}\`` : "Git commit: unavailable",
    `RPC: \`${artifact.network.rpcUrl}\``,
    `Prover endpoint: \`${artifact.prover.endpoint}\``,
    `Rounds: ${artifact.aggregate.rounds}`,
    `Stake lamports: ${artifact.config.stakeLamports}`,
    `Reward lamports: ${artifact.config.rewardLamports}`,
    `Funding lamports: ${artifact.config.fundingLamports}`,
    "",
    "## Aggregate",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Mean proof generation (ms) | ${artifact.aggregate.meanProofGenerationMs.toFixed(2)} |`,
    `| Median proof generation (ms) | ${artifact.aggregate.medianProofGenerationMs.toFixed(2)} |`,
    `| Mean completeTaskPrivate submit (ms) | ${artifact.aggregate.meanSubmitCompletionMs.toFixed(2)} |`,
    `| Median completeTaskPrivate submit (ms) | ${artifact.aggregate.medianSubmitCompletionMs.toFixed(2)} |`,
    `| Mean round total (ms) | ${artifact.aggregate.meanTotalMs.toFixed(2)} |`,
    `| Median round total (ms) | ${artifact.aggregate.medianTotalMs.toFixed(2)} |`,
    `| Min round total (ms) | ${artifact.aggregate.minTotalMs.toFixed(2)} |`,
    `| Max round total (ms) | ${artifact.aggregate.maxTotalMs.toFixed(2)} |`,
    "",
    "## Rounds",
    "",
    "| Round | Proof ms | Submit ms | Total ms | Task | Tx |",
    "| --- | ---: | ---: | ---: | --- | --- |",
  ];

  for (const round of artifact.rounds) {
    lines.push(
      `| ${round.round} | ${round.timingsMs.proofGeneration.toFixed(2)} | ${round.timingsMs.submitCompletion.toFixed(2)} | ${round.timingsMs.total.toFixed(2)} | \`${round.taskPda}\` | \`${round.signatures.completeTaskPrivate}\` |`,
    );
  }

  lines.push(
    "",
    "## Notes",
    "",
    "- This benchmark creates a real private task, claims it, generates a proof through the configured remote prover, and submits `completeTaskPrivate` against the verifier-enabled chain.",
    "- The prover header values are intentionally omitted from this report; only header names are recorded in the JSON artifact.",
  );

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const logger = createLogger(options.logLevel, "[private-proof-benchmark]");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  await assertVerifierStackReady(provider.connection);

  const program = createCoordinationProgram(provider);
  const protocolPda = deriveProtocolPda(program.programId);
  const bootstrap = await ensureProtocolInitialized(provider, program);
  const activeImageId = await ensureTrustedImageId(provider, program);

  const rawProtocol = await program.account.protocolConfig.fetch(protocolPda);
  const configuredMinAgentStake = Number(rawProtocol.minAgentStake.toString());
  const stakeLamports =
    options.stakeLamports ??
    Math.max(configuredMinAgentStake, DEFAULT_AGENT_STAKE_LAMPORTS);
  if (stakeLamports < configuredMinAgentStake) {
    throw new Error(
      `stake override ${stakeLamports} is below protocol minAgentStake ${configuredMinAgentStake}`,
    );
  }

  const rounds: BenchmarkRoundArtifact[] = [];
  for (let round = 1; round <= options.rounds; round++) {
    logger.info(`Starting private E2E benchmark round ${round}/${options.rounds}`);
    rounds.push(
      await runRound({
        round,
        options,
        provider,
        program,
        protocolPda,
        stakeLamports,
        activeImageId,
        logger,
      }),
    );
  }

  const finalized = await finalizeArtifact(
    buildArtifact({
      options,
      rounds,
      provider,
      bootstrap,
      activeImageId,
      stakeLamports,
    }),
    provider,
  );

  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await mkdir(path.dirname(options.markdownPath), { recursive: true });
  await writeFile(
    options.outputPath,
    `${JSON.stringify(finalized, null, 2)}\n`,
    "utf8",
  );
  await writeFile(options.markdownPath, renderMarkdown(finalized), "utf8");

  console.log(
    [
      `Private E2E benchmark complete: ${finalized.aggregate.rounds} round(s)`,
      `Mean proof generation: ${finalized.aggregate.meanProofGenerationMs.toFixed(2)} ms`,
      `Mean submit completion: ${finalized.aggregate.meanSubmitCompletionMs.toFixed(2)} ms`,
      `Mean total: ${finalized.aggregate.meanTotalMs.toFixed(2)} ms`,
      `JSON: ${options.outputPath}`,
      `Markdown: ${options.markdownPath}`,
    ].join("\n"),
  );
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Private E2E benchmark failed: ${message}`);
  process.exit(1);
}
