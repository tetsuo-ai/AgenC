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
} from "@tetsuo-ai/sdk";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import process from "node:process";
import { createProgram } from "@tetsuo-ai/runtime";
import { type CliOptions, parseZkConfigArgs } from "./zk-config-admin-cli.js";

type CliContext = {
  options: CliOptions;
  authority: Keypair;
  connection: Connection;
  program: ReturnType<typeof createProgram>;
  protocolPda: PublicKey;
  zkConfigPda: PublicKey;
};

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
  const programIdl = {
    ...(idlJson as anchor.Idl),
    address: programId.toBase58(),
  } as anchor.Idl;
  const program = new anchor.Program<AgencCoordination>(
    programIdl as AgencCoordination,
    provider,
  );
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
  const options = parseZkConfigArgs(process.argv.slice(2));
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
