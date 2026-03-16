#!/usr/bin/env node

import { Connection, PublicKey } from "@solana/web3.js";
import process from "node:process";

const DEFAULT_RPC_URL = "https://api.devnet.solana.com";
const DEFAULT_PROGRAM_ID = "6UcJzbTEemBz3aY5wK5qKHGMD7bdRsmR4smND29gB2ab";

function usage() {
  process.stdout.write(`Usage:
  node scripts/agenc-devnet-log-watch.mjs [--rpc-url <url>] [--program-id <pubkey>]
`);
}

function parseArgs(argv) {
  const options = {
    rpcUrl: DEFAULT_RPC_URL,
    programId: DEFAULT_PROGRAM_ID,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
    } else if (arg === "--rpc-url" && argv[index + 1]) {
      options.rpcUrl = argv[++index];
    } else if (arg === "--program-id" && argv[index + 1]) {
      options.programId = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const connection = new Connection(options.rpcUrl, "confirmed");
  const programId = new PublicKey(options.programId);

  process.stdout.write(
    `[${nowIso()}] Subscribing to Devnet logs for ${programId.toBase58()} via ${options.rpcUrl}\n`,
  );

  const subscriptionId = connection.onLogs(
    programId,
    (entry) => {
      const lines = Array.isArray(entry.logs) ? entry.logs : [];
      process.stdout.write(
        `\n[${nowIso()}] signature=${entry.signature} slot=${entry.slot}\n`,
      );
      for (const line of lines) {
        process.stdout.write(`${line}\n`);
      }
    },
    "confirmed",
  );

  const stop = async (signal) => {
    process.stdout.write(`[${nowIso()}] Received ${signal}; closing log subscription\n`);
    try {
      await connection.removeOnLogsListener(subscriptionId);
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void stop("SIGINT");
  });
  process.on("SIGTERM", () => {
    void stop("SIGTERM");
  });

  await new Promise(() => {});
}

try {
  await main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
