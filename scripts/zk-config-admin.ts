#!/usr/bin/env node

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  PROGRAM_ID,
  deriveProtocolPda,
  deriveZkConfigPda,
  getProtocolConfig,
  getZkConfig,
  initializeZkConfig,
  updateZkImageId,
} from "../sdk/src/index.js";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createProgram } from "../runtime/src/index.js";

const DEFAULT_RPC_URL =
  process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
const DEFAULT_AUTHORITY_KEYPAIR =
  process.env.ANCHOR_WALLET ??
  path.join(os.homedir(), ".config", "solana", "id.json");

type Command = "show" | "init" | "rotate";

type CliOptions = {
  command: Command;
  rpcUrl: string;
  programId: string;
  authorityKeypairPath: string;
  imageId?: Uint8Array;
};

type CliContext = {
  options: CliOptions;
  authority: Keypair;
  connection: Connection;
  program: ReturnType<typeof createProgram>;
  protocolPda: PublicKey;
  zkConfigPda: PublicKey;
};

function usage(): void {
  process.stdout.write(`Usage:
  npx tsx scripts/zk-config-admin.ts <show|init|rotate> [options]

Commands:
  show                      Print protocol/zk_config state
  init                      Create zk_config with the provided image ID
  rotate                    Update zk_config.active_image_id

Options:
  --rpc-url <url>           RPC URL (default: ${DEFAULT_RPC_URL})
  --program-id <pubkey>     Program ID (default: ${PROGRAM_ID.toBase58()})
  --authority-keypair <p>   Protocol authority keypair JSON
                            (default: ${DEFAULT_AUTHORITY_KEYPAIR})
  --image-id <value>        Required for init/rotate. Accepted formats:
                            - comma-separated bytes: "1, 2, 3, ..."
                            - JSON array: "[1,2,3,...]"
                            - hex string: "0x0102..."
  --help                    Show this help

Examples:
  npx tsx scripts/zk-config-admin.ts show
  npx tsx scripts/zk-config-admin.ts init --image-id "234, 105, ..."
  npx tsx scripts/zk-config-admin.ts rotate --image-id "0xea693a9a8b2b774161852dfec9b2af4749e61211f30316c12fad6badd7d00152"
`);
}

function expandHome(filePath: string): string {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function parseArgs(argv: string[]): CliOptions {
  if (argv.length === 0 || argv.includes("--help")) {
    usage();
    process.exit(0);
  }

  const [commandArg, ...rest] = argv;
  if (commandArg !== "show" && commandArg !== "init" && commandArg !== "rotate") {
    throw new Error(
      `Unknown command "${commandArg}". Expected show, init, or rotate.`,
    );
  }

  const options: CliOptions = {
    command: commandArg,
    rpcUrl: DEFAULT_RPC_URL,
    programId: PROGRAM_ID.toBase58(),
    authorityKeypairPath: path.resolve(expandHome(DEFAULT_AUTHORITY_KEYPAIR)),
  };

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--rpc-url" && rest[index + 1]) {
      options.rpcUrl = rest[++index]!;
      continue;
    }
    if (arg === "--program-id" && rest[index + 1]) {
      options.programId = rest[++index]!;
      continue;
    }
    if (arg === "--authority-keypair" && rest[index + 1]) {
      options.authorityKeypairPath = path.resolve(
        expandHome(rest[++index]!),
      );
      continue;
    }
    if (arg === "--image-id" && rest[index + 1]) {
      options.imageId = parseImageId(rest[++index]!);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if ((options.command === "init" || options.command === "rotate") && !options.imageId) {
    throw new Error(`${options.command} requires --image-id`);
  }

  return options;
}

function parseImageId(input: string): Uint8Array {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("image ID cannot be empty");
  }

  let values: number[];

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("JSON image ID must be an array");
    }
    values = parsed.map((value) => parseByte(value));
  } else if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(trimmed)) {
    const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : trimmed;
    values = Array.from(Buffer.from(hex, "hex"));
  } else {
    values = trimmed
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => parseByte(part));
  }

  if (values.length !== 32) {
    throw new Error(`image ID must contain exactly 32 bytes, got ${values.length}`);
  }

  return Uint8Array.from(values);
}

function parseByte(value: unknown): number {
  const byte =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
    throw new Error(`invalid image ID byte: ${String(value)}`);
  }
  return byte;
}

async function loadKeypair(filePath: string): Promise<Keypair> {
  if (!existsSync(filePath)) {
    throw new Error(`Authority keypair not found: ${filePath}`);
  }

  const raw = await readFile(filePath, "utf8");
  const secret = JSON.parse(raw);
  if (!Array.isArray(secret)) {
    throw new Error(`Invalid keypair file: ${filePath}`);
  }

  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function renderImageIdHex(imageId: Uint8Array): string {
  return `0x${Buffer.from(imageId).toString("hex")}`;
}

function renderImageIdCsv(imageId: Uint8Array): string {
  return Array.from(imageId).join(", ");
}

function imageIdsEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function stringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_, nested) => {
      if (nested instanceof PublicKey) {
        return nested.toBase58();
      }
      if (typeof nested === "bigint") {
        return nested.toString();
      }
      return nested;
    },
    2,
  );
}

function summarizeProtocolConfig(
  protocolConfig: Awaited<ReturnType<typeof getProtocolConfig>>,
) {
  if (!protocolConfig) {
    return null;
  }

  return {
    authority: protocolConfig.authority.toBase58(),
    treasury: protocolConfig.treasury.toBase58(),
    disputeThreshold: protocolConfig.disputeThreshold,
    protocolFeeBps: protocolConfig.protocolFeeBps,
    minAgentStake: protocolConfig.minAgentStake.toString(),
    minStakeForDispute: protocolConfig.minStakeForDispute.toString(),
    multisigThreshold: protocolConfig.multisigThreshold,
  };
}

function summarizeZkConfig(zkConfig: Awaited<ReturnType<typeof getZkConfig>>) {
  if (!zkConfig) {
    return null;
  }

  return {
    activeImageId: Array.from(zkConfig.activeImageId),
    activeImageIdCsv: renderImageIdCsv(zkConfig.activeImageId),
    activeImageIdHex: renderImageIdHex(zkConfig.activeImageId),
  };
}

function assertProtocolAuthority(
  protocolConfig: Awaited<ReturnType<typeof getProtocolConfig>>,
  authority: Keypair,
): void {
  if (!protocolConfig) {
    throw new Error("protocol_config is missing; initialize the protocol first");
  }

  if (!protocolConfig.authority.equals(authority.publicKey)) {
    throw new Error(
      `Authority mismatch: protocol_config.authority=${protocolConfig.authority.toBase58()} signer=${authority.publicKey.toBase58()}`,
    );
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${stringify(value)}\n`);
}

async function createCliContext(options: CliOptions): Promise<CliContext> {
  const authority = await loadKeypair(options.authorityKeypairPath);
  const programId = new PublicKey(options.programId);
  const connection = new Connection(options.rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(authority),
    { commitment: "confirmed" },
  );
  const program = createProgram(provider, programId);
  return {
    options,
    authority,
    connection,
    program,
    protocolPda: deriveProtocolPda(program.programId),
    zkConfigPda: deriveZkConfigPda(program.programId),
  };
}

async function loadCurrentState(context: CliContext) {
  const [protocolConfig, zkConfig] = await Promise.all([
    getProtocolConfig(context.program),
    getZkConfig(context.program),
  ]);
  return { protocolConfig, zkConfig };
}

async function runShow(context: CliContext): Promise<void> {
  const { protocolConfig, zkConfig } = await loadCurrentState(context);
  writeJson({
    rpcUrl: context.options.rpcUrl,
    programId: context.program.programId.toBase58(),
    authorityKeypairPath: context.options.authorityKeypairPath,
    signer: context.authority.publicKey.toBase58(),
    protocolPda: context.protocolPda.toBase58(),
    zkConfigPda: context.zkConfigPda.toBase58(),
    protocolConfig: summarizeProtocolConfig(protocolConfig),
    zkConfig: summarizeZkConfig(zkConfig),
  });
}

async function runInit(context: CliContext): Promise<void> {
  const { protocolConfig, zkConfig } = await loadCurrentState(context);
  assertProtocolAuthority(protocolConfig, context.authority);
  if (zkConfig) {
    throw new Error(
      `zk_config already exists at ${context.zkConfigPda.toBase58()}; use rotate instead`,
    );
  }

  const result = await initializeZkConfig(
    context.connection,
    context.program,
    context.authority,
    context.options.imageId!,
  );
  const updatedZkConfig = await getZkConfig(context.program);

  writeJson({
    action: "init",
    txSignature: result.txSignature,
    programId: context.program.programId.toBase58(),
    signer: context.authority.publicKey.toBase58(),
    protocolPda: context.protocolPda.toBase58(),
    zkConfigPda: result.zkConfigPda.toBase58(),
    zkConfig: summarizeZkConfig(updatedZkConfig),
  });
}

async function runRotate(context: CliContext): Promise<void> {
  const { protocolConfig, zkConfig } = await loadCurrentState(context);
  assertProtocolAuthority(protocolConfig, context.authority);
  if (!zkConfig) {
    throw new Error(
      `zk_config is missing at ${context.zkConfigPda.toBase58()}; use init first`,
    );
  }

  const imageId = context.options.imageId!;
  if (imageIdsEqual(zkConfig.activeImageId, imageId)) {
    throw new Error("new image ID matches the currently active image ID");
  }

  const result = await updateZkImageId(
    context.connection,
    context.program,
    context.authority,
    imageId,
  );
  const updatedZkConfig = await getZkConfig(context.program);

  writeJson({
    action: "rotate",
    txSignature: result.txSignature,
    programId: context.program.programId.toBase58(),
    signer: context.authority.publicKey.toBase58(),
    protocolPda: context.protocolPda.toBase58(),
    zkConfigPda: context.zkConfigPda.toBase58(),
    zkConfig: summarizeZkConfig(updatedZkConfig),
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const context = await createCliContext(options);

  if (options.command === "show") {
    await runShow(context);
    return;
  }

  if (options.command === "init") {
    await runInit(context);
    return;
  }

  if (options.command === "rotate") {
    await runRotate(context);
    return;
  }

  throw new Error(`Unsupported command: ${options.command}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
