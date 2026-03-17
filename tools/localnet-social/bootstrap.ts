#!/usr/bin/env node

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  deriveAgentPda,
  deriveProtocolPda,
  getProtocolConfig,
} from "@tetsuo-ai/sdk";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  type CliOptions,
  DEFAULT_BASE_CONFIG,
  DEFAULT_GATEWAY_BASE_PORT,
  DEFAULT_MESSAGING_BASE_PORT,
  DEFAULT_OPERATOR_KEYPAIR,
  DEFAULT_PROGRAM_ID,
  DEFAULT_RPC_URL,
  DEFAULT_STATE_DIR,
  parseBootstrapArgs,
} from "./bootstrap-cli.js";
import {
  createProgram,
  Capability,
  combineCapabilities,
} from "@tetsuo-ai/runtime";

const DEFAULT_MIN_BALANCE_SOL = 5;
const DEFAULT_PROTOCOL_FEE_BPS = 100;
const DEFAULT_DISPUTE_THRESHOLD = 51;
const DEFAULT_MIN_STAKE_LAMPORTS = 1n * BigInt(LAMPORTS_PER_SOL);
const DEFAULT_MIN_STAKE_FOR_DISPUTE_LAMPORTS = 1_000n;
const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

type AgentProfile = {
  index: number;
  label: string;
  keypairPath: string;
  capabilities: bigint;
};

type PreparedAgent = {
  index: number;
  label: string;
  authority: string;
  keypairPath: string;
  gatewayPort: number;
  messagingPort: number;
  endpoint: string;
  agentIdHex: string;
  agentPda: string;
  capabilities: string;
  configPath: string;
  daemonLogPath: string;
  memoryDbPath: string;
};

type PeerDirectoryEntry = {
  index: number;
  label: string;
  authority: string;
  agentPda: string;
  aliases: string[];
};

function buildPeerAliases(index: number, label: string): string[] {
  return Array.from(
    new Set([
      label,
      label.replace(/-/g, "_"),
      label.replace(/-/g, " "),
      label.replace(/[^a-zA-Z0-9]/g, ""),
      `agent${index}`,
      `agent-${index}`,
      `agent_${index}`,
      `agent ${index}`,
      `peer${index}`,
      `peer-${index}`,
      `peer_${index}`,
      `peer ${index}`,
      String(index),
      label.toUpperCase(),
      label.toUpperCase().replace(/-/g, "_"),
    ]),
  );
}

function buildPeerDirectoryEntry(agent: PreparedAgent): PeerDirectoryEntry {
  return {
    index: agent.index,
    label: agent.label,
    authority: agent.authority,
    agentPda: agent.agentPda,
    aliases: buildPeerAliases(agent.index, agent.label),
  };
}

async function loadKeypair(filePath: string): Promise<Keypair> {
  const raw = await readFile(filePath, "utf8");
  const secret = JSON.parse(raw);
  if (!Array.isArray(secret)) {
    throw new Error(`Invalid keypair file: ${filePath}`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

async function saveKeypair(filePath: string, keypair: Keypair): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify(Array.from(keypair.secretKey), null, 2)}\n`,
    "utf8",
  );
}

async function ensureKeypair(filePath: string): Promise<Keypair> {
  if (existsSync(filePath)) {
    return loadKeypair(filePath);
  }
  const keypair = Keypair.generate();
  await saveKeypair(filePath, keypair);
  return keypair;
}

async function airdropIfNeeded(
  connection: Connection,
  pubkey: PublicKey,
  minimumLamports: number,
): Promise<void> {
  const balance = await connection.getBalance(pubkey, "confirmed");
  if (balance >= minimumLamports) {
    return;
  }
  const signature = await connection.requestAirdrop(
    pubkey,
    minimumLamports - balance,
  );
  await connection.confirmTransaction(signature, "confirmed");
}

function agentProfiles(stateDir: string): AgentProfile[] {
  const keysDir = path.join(stateDir, "keys");
  return [
    {
      index: 1,
      label: "agent-1",
      keypairPath: path.join(keysDir, "worker-1.json"),
      capabilities: combineCapabilities(
        Capability.COMPUTE,
        Capability.COORDINATOR,
        Capability.NETWORK,
      ),
    },
    {
      index: 2,
      label: "agent-2",
      keypairPath: path.join(keysDir, "worker-2.json"),
      capabilities: combineCapabilities(
        Capability.COMPUTE,
        Capability.INFERENCE,
        Capability.STORAGE,
      ),
    },
    {
      index: 3,
      label: "agent-3",
      keypairPath: path.join(keysDir, "worker-3.json"),
      capabilities: combineCapabilities(
        Capability.COMPUTE,
        Capability.VALIDATOR,
        Capability.AGGREGATOR,
      ),
    },
    {
      index: 4,
      label: "agent-4",
      keypairPath: path.join(keysDir, "worker-4.json"),
      capabilities: combineCapabilities(
        Capability.COMPUTE,
        Capability.ARBITER,
        Capability.NETWORK,
      ),
    },
  ];
}

async function ensureProtocol(
  connection: Connection,
  program: ReturnType<typeof createProgram>,
  authority: Keypair,
  stateDir: string,
): Promise<NonNullable<Awaited<ReturnType<typeof getProtocolConfig>>>> {
  const existing = await getProtocolConfig(program);
  if (existing) {
    return existing;
  }

  const keysDir = path.join(stateDir, "keys");
  const secondSigner = await ensureKeypair(path.join(keysDir, "multisig-second.json"));
  const thirdSigner = await ensureKeypair(path.join(keysDir, "multisig-third.json"));
  const [programDataPda] = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  );

  const txSignature = await program.methods
    .initializeProtocol(
      DEFAULT_DISPUTE_THRESHOLD,
      DEFAULT_PROTOCOL_FEE_BPS,
      new anchor.BN(DEFAULT_MIN_STAKE_LAMPORTS.toString()),
      new anchor.BN(DEFAULT_MIN_STAKE_FOR_DISPUTE_LAMPORTS.toString()),
      2,
      [authority.publicKey, secondSigner.publicKey, thirdSigner.publicKey],
    )
    .accountsPartial({
      treasury: authority.publicKey,
      authority: authority.publicKey,
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
    .signers([authority, secondSigner, thirdSigner])
    .rpc();

  await connection.confirmTransaction(txSignature, "confirmed");
  const created = await getProtocolConfig(program);
  if (!created) {
    throw new Error("Protocol initialization did not produce a readable config");
  }
  return created;
}

async function ensureAgentRegistration(
  connection: Connection,
  program: ReturnType<typeof createProgram>,
  wallet: Keypair,
  endpoint: string,
  capabilities: bigint,
  stakeLamports: bigint,
): Promise<{ agentPda: PublicKey; agentId: Uint8Array }> {
  const agentId = wallet.publicKey.toBytes();
  const agentPda = deriveAgentPda(agentId, program.programId);
  const existing = await program.account.agentRegistration.fetchNullable(agentPda);

  if (!existing) {
    const txSignature = await program.methods
      .registerAgent(
        Array.from(agentId),
        new anchor.BN(capabilities.toString()),
        endpoint,
        null,
        new anchor.BN(stakeLamports.toString()),
      )
      .accountsPartial({
        agent: agentPda,
        protocolConfig: deriveProtocolPda(program.programId),
        authority: wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([wallet])
      .rpc();
    await connection.confirmTransaction(txSignature, "confirmed");
    return { agentPda, agentId };
  }

  const existingRecord = existing as {
    endpoint: string;
    capabilities: { toString(): string };
  };
  const existingCaps = BigInt(existingRecord.capabilities.toString());
  if (existingRecord.endpoint !== endpoint || existingCaps !== capabilities) {
    const txSignature = await program.methods
      .updateAgent(new anchor.BN(capabilities.toString()), endpoint, null, null)
      .accountsPartial({
        agent: agentPda,
        authority: wallet.publicKey,
      })
      .signers([wallet])
      .rpc();
    await connection.confirmTransaction(txSignature, "confirmed");
  }

  return { agentPda, agentId };
}

function buildDaemonConfig(
  baseConfig: Record<string, unknown>,
  agent: PreparedAgent,
  options: CliOptions,
  peerDirectory: readonly PeerDirectoryEntry[],
): Record<string, unknown> {
  const baseGateway =
    baseConfig.gateway && typeof baseConfig.gateway === "object"
      ? (baseConfig.gateway as Record<string, unknown>)
      : {};
  const baseConnection =
    baseConfig.connection && typeof baseConfig.connection === "object"
      ? (baseConfig.connection as Record<string, unknown>)
      : {};
  const baseMemory =
    baseConfig.memory && typeof baseConfig.memory === "object"
      ? (baseConfig.memory as Record<string, unknown>)
      : {};
  const baseSocial =
    baseConfig.social && typeof baseConfig.social === "object"
      ? (baseConfig.social as Record<string, unknown>)
      : {};
  const baseMarketplace =
    baseConfig.marketplace && typeof baseConfig.marketplace === "object"
      ? (baseConfig.marketplace as Record<string, unknown>)
      : {};
  const baseAutonomy =
    baseConfig.autonomy && typeof baseConfig.autonomy === "object"
      ? (baseConfig.autonomy as Record<string, unknown>)
      : {};
  const baseLogging =
    baseConfig.logging && typeof baseConfig.logging === "object"
      ? (baseConfig.logging as Record<string, unknown>)
      : {};
  const baseAgent =
    baseConfig.agent && typeof baseConfig.agent === "object"
      ? (baseConfig.agent as Record<string, unknown>)
      : {};
  const llm =
    baseConfig.llm && typeof baseConfig.llm === "object"
      ? (baseConfig.llm as Record<string, unknown>)
      : null;

  if (!llm) {
    throw new Error(`Base config ${options.baseConfigPath} is missing llm settings`);
  }

  return {
    gateway: {
      ...baseGateway,
      port: agent.gatewayPort,
    },
    agent: {
      ...baseAgent,
      name: agent.label,
    },
    connection: {
      ...baseConnection,
      rpcUrl: options.rpcUrl,
      keypairPath: agent.keypairPath,
    },
    llm,
    voice: {
      enabled: false,
    },
    desktop: {
      enabled: false,
    },
    mcp: {
      servers: [],
    },
    memory: {
      ...baseMemory,
      backend: "sqlite",
      dbPath: agent.memoryDbPath,
    },
    logging: baseLogging,
    autonomy: {
      ...baseAutonomy,
      enabled: true,
    },
    marketplace: {
      ...baseMarketplace,
      enabled: true,
    },
    social: {
      ...baseSocial,
      enabled: true,
      discoveryEnabled: true,
      messagingEnabled: true,
      feedEnabled: true,
      collaborationEnabled: true,
      reputationEnabled: true,
      messagingPort: agent.messagingPort,
      peerDirectory,
    },
  };
}

async function main(): Promise<void> {
  const options = parseBootstrapArgs(process.argv.slice(2));

  if (!existsSync(options.operatorKeypairPath)) {
    throw new Error(`Missing operator keypair: ${options.operatorKeypairPath}`);
  }
  if (!existsSync(options.baseConfigPath)) {
    throw new Error(`Missing base config: ${options.baseConfigPath}`);
  }

  const operator = await loadKeypair(options.operatorKeypairPath);
  const connection = new Connection(options.rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(operator),
    {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    },
  );
  const program = createProgram(provider, new PublicKey(options.programId));

  const socialDir = path.dirname(options.summaryPath);
  const configDir = path.join(socialDir, "configs");
  const logsDir = path.join(socialDir, "logs");
  const dbDir = path.join(socialDir, "db");
  await Promise.all([
    mkdir(configDir, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
    mkdir(dbDir, { recursive: true }),
  ]);

  await airdropIfNeeded(
    connection,
    operator.publicKey,
    DEFAULT_MIN_BALANCE_SOL * LAMPORTS_PER_SOL,
  );

  const protocol = await ensureProtocol(connection, program, operator, options.stateDir);
  const stakeLamports = BigInt(protocol.minAgentStake.toString());
  const profiles = agentProfiles(options.stateDir);
  const baseConfig = JSON.parse(
    await readFile(options.baseConfigPath, "utf8"),
  ) as Record<string, unknown>;

  const preparedAgents: PreparedAgent[] = [];
  for (const profile of profiles) {
    const wallet = await ensureKeypair(profile.keypairPath);
    await airdropIfNeeded(
      connection,
      wallet.publicKey,
      DEFAULT_MIN_BALANCE_SOL * LAMPORTS_PER_SOL,
    );

    const gatewayPort = options.gatewayBasePort + (profile.index - 1);
    const messagingPort = options.messagingBasePort + (profile.index - 1);
    const endpoint = `http://127.0.0.1:${messagingPort}`;
    const { agentPda, agentId } = await ensureAgentRegistration(
      connection,
      program,
      wallet,
      endpoint,
      profile.capabilities,
      stakeLamports,
    );

    const prepared: PreparedAgent = {
      index: profile.index,
      label: profile.label,
      authority: wallet.publicKey.toBase58(),
      keypairPath: profile.keypairPath,
      gatewayPort,
      messagingPort,
      endpoint,
      agentIdHex: Buffer.from(agentId).toString("hex"),
      agentPda: agentPda.toBase58(),
      capabilities: profile.capabilities.toString(),
      configPath: path.join(configDir, `${profile.label}.json`),
      daemonLogPath: path.join(logsDir, `${profile.label}.log`),
      memoryDbPath: path.join(dbDir, `${profile.label}.sqlite`),
    };

    preparedAgents.push(prepared);
  }

  for (const prepared of preparedAgents) {
    const peerDirectory = preparedAgents.map(buildPeerDirectoryEntry);
    const daemonConfig = buildDaemonConfig(
      baseConfig,
      prepared,
      options,
      peerDirectory,
    );
    await writeFile(
      prepared.configPath,
      `${JSON.stringify(daemonConfig, null, 2)}\n`,
      "utf8",
    );
  }

  const summary = {
    updatedAt: new Date().toISOString(),
    rpcUrl: options.rpcUrl,
    programId: program.programId.toBase58(),
    operator: {
      authority: operator.publicKey.toBase58(),
      keypairPath: options.operatorKeypairPath,
    },
    protocol: {
      authority: protocol.authority.toBase58(),
      treasury: protocol.treasury.toBase58(),
      minAgentStakeLamports: protocol.minAgentStake.toString(),
      disputeThreshold: protocol.disputeThreshold,
      protocolFeeBps: protocol.protocolFeeBps,
    },
    agents: preparedAgents,
  };

  await writeFile(
    options.summaryPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8",
  );

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
