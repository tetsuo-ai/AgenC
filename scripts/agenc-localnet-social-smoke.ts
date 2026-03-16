#!/usr/bin/env node

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { readFile, writeFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import WebSocket from "../node_modules/ws/wrapper.mjs";
import {
  createProgram,
  createReadOnlyProgram,
  AgentDiscovery,
  AgentMessaging,
  AgentFeed,
} from "../runtime/src/index.js";

const DEFAULT_SUMMARY_PATH = path.join(
  os.homedir(),
  ".agenc",
  "localnet-soak",
  "default",
  "social",
  "summary.json",
);

type SummaryAgent = {
  index: number;
  label: string;
  authority: string;
  keypairPath: string;
  gatewayPort: number;
  messagingPort: number;
  endpoint: string;
  agentPda: string;
};

type Summary = {
  updatedAt: string;
  rpcUrl: string;
  programId: string;
  agents: SummaryAgent[];
};

function usage(): void {
  process.stdout.write(`Usage:
  npx tsx scripts/agenc-localnet-social-smoke.ts [options]

Options:
  --summary-path <path>   Bootstrap summary path (default: ${DEFAULT_SUMMARY_PATH})
  --help                  Show this help
`);
}

function parseArgs(argv: string[]): { summaryPath: string } {
  const options = { summaryPath: DEFAULT_SUMMARY_PATH };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      usage();
      process.exit(0);
    }
    if (arg === "--summary-path" && argv[index + 1]) {
      options.summaryPath = path.resolve(argv[++index]!);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function loadKeypair(filePath: string): Promise<Keypair> {
  const raw = await readFile(filePath, "utf8");
  const secret = JSON.parse(raw);
  if (!Array.isArray(secret)) {
    throw new Error(`Invalid keypair file: ${filePath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function waitForWebSocket(url: string, timeoutMs = 5_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        // ignore
      }
      reject(new Error(`Timed out connecting to ${url}`));
    }, timeoutMs);

    const ws = new WebSocket(url);
    ws.once("open", () => {
      clearTimeout(timer);
      ws.close();
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function createSignedProgram(
  connection: Connection,
  programId: PublicKey,
  keypair: Keypair,
) {
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(keypair),
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    },
  );
  return createProgram(provider, programId);
}

async function main(): Promise<void> {
  const { summaryPath } = parseArgs(process.argv.slice(2));
  const summary = JSON.parse(await readFile(summaryPath, "utf8")) as Summary;
  const connection = new Connection(summary.rpcUrl, "confirmed");
  const programId = new PublicKey(summary.programId);

  for (const agent of summary.agents) {
    await waitForWebSocket(`ws://127.0.0.1:${agent.gatewayPort}`);
    await waitForWebSocket(`ws://127.0.0.1:${agent.messagingPort}`);
  }

  const readOnlyProgram = createReadOnlyProgram(connection, programId);
  const discovery = new AgentDiscovery({
    program: readOnlyProgram,
  });
  const online = await discovery.search({
    onlineOnly: true,
    maxResults: 20,
  });

  const expectedPdas = new Set(summary.agents.map((agent) => agent.agentPda));
  const discoveredPdas = new Set(online.map((entry) => entry.pda.toBase58()));
  for (const expected of expectedPdas) {
    if (!discoveredPdas.has(expected)) {
      throw new Error(`Discovery did not return agent ${expected}`);
    }
  }

  const senderAgent = summary.agents[0]!;
  const recipientAgent = summary.agents[1]!;
  const senderKeypair = await loadKeypair(senderAgent.keypairPath);
  const senderProgram = await createSignedProgram(connection, programId, senderKeypair);
  const senderMessaging = new AgentMessaging({
    program: senderProgram,
    wallet: senderKeypair,
    agentId: senderKeypair.publicKey.toBytes(),
    config: {
      defaultMode: "auto",
    },
  });

  const offChainContent = `localnet-social-offchain-${Date.now()}`;
  await senderMessaging.send(
    new PublicKey(recipientAgent.agentPda),
    offChainContent,
    "off-chain",
  );

  const onChainContent = `localnet-social-onchain-${Date.now()}`;
  await senderMessaging.send(
    new PublicKey(recipientAgent.agentPda),
    onChainContent,
    "on-chain",
  );
  const onChainHistory = await senderMessaging.getOnChainHistory(
    new PublicKey(recipientAgent.agentPda),
    20,
  );
  if (!onChainHistory.some((entry) => entry.content === onChainContent)) {
    throw new Error("On-chain messaging smoke check did not find the sent message");
  }

  const feedAgent = summary.agents[2]!;
  const feedKeypair = await loadKeypair(feedAgent.keypairPath);
  const feedProgram = await createSignedProgram(connection, programId, feedKeypair);
  const feed = new AgentFeed({
    program: feedProgram,
    wallet: feedKeypair,
    agentId: feedKeypair.publicKey.toBytes(),
  });

  let feedReport:
    | {
        status: "ok";
        author: string;
        signature: string;
        postsByAuthor: number;
      }
    | {
        status: "blocked_by_protocol_gate";
        author: string;
        reason: string;
      };
  try {
    const postContent = `localnet-social-feed-${Date.now()}`;
    const contentHash = createHash("sha256").update(postContent).digest();
    const topic = createHash("sha256").update("localnet-social-smoke").digest();
    const nonce = randomBytes(32);
    const feedSignature = await feed.post({
      contentHash,
      nonce,
      topic,
    });
    const feedPosts = await feed.getFeed({
      author: new PublicKey(feedAgent.agentPda),
    });
    const expectedHashHex = contentHash.toString("hex");
    if (
      !feedPosts.some(
        (post) => Buffer.from(post.contentHash).toString("hex") === expectedHashHex,
      )
    ) {
      throw new Error("Feed smoke check did not find the created post");
    }
    feedReport = {
      status: "ok",
      author: feedAgent.agentPda,
      signature: feedSignature,
      postsByAuthor: feedPosts.length,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/(InsufficientReputation|CooldownNotElapsed)/.test(message)) {
      throw error;
    }
    feedReport = {
      status: "blocked_by_protocol_gate",
      author: feedAgent.agentPda,
      reason: message,
    };
  }

  const report = {
    status:
      feedReport.status === "ok" ? "ok" : "partial",
    checkedAt: new Date().toISOString(),
    summaryPath,
    discovery: {
      onlineAgents: online.length,
      foundAgentPdas: Array.from(discoveredPdas),
    },
    messaging: {
      offChainRecipient: recipientAgent.agentPda,
      onChainRecipient: recipientAgent.agentPda,
      onChainHistoryEntries: onChainHistory.length,
    },
    feed: feedReport,
  };

  const reportPath = path.join(path.dirname(summaryPath), "smoke-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
