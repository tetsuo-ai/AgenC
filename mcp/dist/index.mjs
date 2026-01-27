#!/usr/bin/env node

// src/index.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// src/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z as z6 } from "zod";

// src/tools/agents.ts
import { PublicKey as PublicKey3 } from "@solana/web3.js";
import {
  AgentCapabilities,
  getCapabilityNames,
  createCapabilityMask,
  agentIdToString,
  agentIdToShortString,
  generateAgentId,
  hexToBytes,
  keypairToWallet as keypairToWallet2,
  findAgentPda,
  AgentManager
} from "@agenc/runtime";
import { z } from "zod";

// src/utils/connection.ts
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { AnchorProvider } from "@coral-xyz/anchor";
import {
  PROGRAM_ID,
  DEVNET_RPC,
  MAINNET_RPC,
  createProgram,
  createReadOnlyProgram,
  keypairToWallet,
  loadKeypairFromFile,
  getDefaultKeypairPath
} from "@agenc/runtime";
var NETWORK_URLS = {
  localnet: "http://localhost:8899",
  devnet: DEVNET_RPC,
  mainnet: MAINNET_RPC
};
var currentConnection = null;
var currentNetwork = "localnet";
var currentProgramId = PROGRAM_ID;
function getConfiguredRpcUrl() {
  return process.env.SOLANA_RPC_URL || NETWORK_URLS.localnet;
}
function getConfiguredProgramId() {
  const envId = process.env.AGENC_PROGRAM_ID;
  if (envId) {
    return new PublicKey(envId);
  }
  return PROGRAM_ID;
}
function getConnection() {
  if (!currentConnection) {
    currentConnection = new Connection(getConfiguredRpcUrl(), "confirmed");
    currentProgramId = getConfiguredProgramId();
  }
  return currentConnection;
}
function getCurrentNetwork() {
  return currentNetwork;
}
function getCurrentProgramId() {
  return currentProgramId;
}
function setNetwork(networkOrUrl) {
  const isKnownNetwork = networkOrUrl in NETWORK_URLS;
  const rpcUrl = isKnownNetwork ? NETWORK_URLS[networkOrUrl] : networkOrUrl;
  currentConnection = new Connection(rpcUrl, "confirmed");
  currentNetwork = isKnownNetwork ? networkOrUrl : rpcUrl;
  currentProgramId = getConfiguredProgramId();
  return { rpcUrl, network: currentNetwork };
}
function getReadOnlyProgram() {
  return createReadOnlyProgram(getConnection(), currentProgramId);
}
function getKeypairPath() {
  return process.env.SOLANA_KEYPAIR_PATH || getDefaultKeypairPath();
}
async function getSigningProgram() {
  const keypairPath = getKeypairPath();
  const keypair = await loadKeypairFromFile(keypairPath);
  const wallet = keypairToWallet(keypair);
  const provider = new AnchorProvider(getConnection(), wallet, { commitment: "confirmed" });
  const program = createProgram(provider, currentProgramId);
  return { program, keypair };
}

// src/utils/formatting.ts
import { LAMPORTS_PER_SOL as LAMPORTS_PER_SOL2 } from "@solana/web3.js";
function formatSol(lamports) {
  const n = typeof lamports === "bigint" ? Number(lamports) : lamports;
  return `${(n / LAMPORTS_PER_SOL2).toFixed(9)} SOL`;
}
function formatTimestamp(ts) {
  if (ts === 0) return "Not set";
  return new Date(ts * 1e3).toISOString();
}
function formatBytes(bytes) {
  if (!bytes) return "null";
  return Buffer.from(bytes).toString("hex");
}
function formatStatus(status) {
  if (typeof status === "object" && status !== null) {
    const keys = Object.keys(status);
    if (keys.length > 0) {
      return keys[0].charAt(0).toUpperCase() + keys[0].slice(1);
    }
  }
  const statusNames = {
    0: "Inactive",
    1: "Active",
    2: "Busy",
    3: "Suspended"
  };
  return statusNames[status] ?? `Unknown(${status})`;
}
function formatTaskStatus(status) {
  if (typeof status === "object" && status !== null) {
    const keys = Object.keys(status);
    if (keys.length > 0) {
      const key = keys[0];
      const names = {
        open: "Open",
        inProgress: "In Progress",
        pendingValidation: "Pending Validation",
        completed: "Completed",
        cancelled: "Cancelled",
        disputed: "Disputed"
      };
      return names[key] ?? key;
    }
  }
  const statusNames = {
    0: "Open",
    1: "In Progress",
    2: "Pending Validation",
    3: "Completed",
    4: "Cancelled",
    5: "Disputed"
  };
  return statusNames[status] ?? `Unknown(${status})`;
}
function formatDisputeStatus(status) {
  if (typeof status === "object" && status !== null) {
    const keys = Object.keys(status);
    if (keys.length > 0) {
      return keys[0].charAt(0).toUpperCase() + keys[0].slice(1);
    }
  }
  const statusNames = {
    0: "Active",
    1: "Resolved",
    2: "Expired"
  };
  return statusNames[status] ?? `Unknown(${status})`;
}
function formatTaskType(taskType) {
  if (typeof taskType === "object" && taskType !== null) {
    const keys = Object.keys(taskType);
    if (keys.length > 0) {
      return keys[0].charAt(0).toUpperCase() + keys[0].slice(1);
    }
  }
  const typeNames = {
    0: "Exclusive",
    1: "Collaborative",
    2: "Competitive"
  };
  return typeNames[taskType] ?? `Unknown(${taskType})`;
}
function formatResolutionType(rt) {
  if (typeof rt === "object" && rt !== null) {
    const keys = Object.keys(rt);
    if (keys.length > 0) {
      return keys[0].charAt(0).toUpperCase() + keys[0].slice(1);
    }
  }
  const names = {
    0: "Refund",
    1: "Complete",
    2: "Split"
  };
  return names[rt] ?? `Unknown(${rt})`;
}

// src/tools/agents.ts
function formatAgentState(account, pda) {
  const agentId = account.agentId;
  const idBytes = agentId instanceof Uint8Array ? agentId : new Uint8Array(agentId);
  const caps = BigInt(account.capabilities.toString());
  const capNames = getCapabilityNames(caps);
  const lines = [
    "Agent ID: " + agentIdToShortString(idBytes),
    "Full ID: " + agentIdToString(idBytes),
    "PDA: " + pda.toBase58(),
    "Authority: " + account.authority.toBase58(),
    "Status: " + formatStatus(account.status),
    "Capabilities: " + (capNames.length > 0 ? capNames.join(", ") : "None") + " (bitmask: " + caps + ")",
    "Endpoint: " + (account.endpoint || "Not set"),
    "Metadata URI: " + (account.metadataUri || "Not set"),
    "",
    "--- Performance ---",
    "Tasks Completed: " + account.tasksCompleted,
    "Total Earned: " + formatSol(Number(account.totalEarned ?? 0)),
    "Reputation: " + (account.reputation ?? 0),
    "Active Tasks: " + (account.activeTasks ?? 0),
    "Stake: " + formatSol(Number(account.stake ?? 0)),
    "",
    "--- Timestamps ---",
    "Registered: " + formatTimestamp(Number(account.registeredAt ?? 0)),
    "Last Active: " + formatTimestamp(Number(account.lastActive ?? 0)),
    "",
    "--- Rate Limits ---",
    "Tasks (24h): " + (account.taskCount24h ?? 0),
    "Disputes (24h): " + (account.disputeCount24h ?? 0),
    "Last Task Created: " + formatTimestamp(Number(account.lastTaskCreated ?? 0)),
    "Last Dispute: " + formatTimestamp(Number(account.lastDisputeInitiated ?? 0))
  ];
  return lines.join("\n");
}
function registerAgentTools(server) {
  server.tool(
    "agenc_register_agent",
    "Register a new agent with capabilities, endpoint, and stake",
    {
      capabilities: z.array(z.string()).describe("Capability names: COMPUTE, INFERENCE, STORAGE, NETWORK, SENSOR, ACTUATOR, COORDINATOR, ARBITER, VALIDATOR, AGGREGATOR"),
      endpoint: z.string().describe("Agent network endpoint URL"),
      stake_amount: z.number().nonnegative().describe("Stake amount in SOL"),
      metadata_uri: z.string().optional().describe("Extended metadata URI")
    },
    async ({ capabilities, endpoint, stake_amount, metadata_uri }) => {
      try {
        const { keypair } = await getSigningProgram();
        const wallet = keypairToWallet2(keypair);
        const manager = new AgentManager({
          connection: getConnection(),
          wallet,
          programId: getCurrentProgramId()
        });
        const agentId = generateAgentId();
        const capMask = createCapabilityMask(capabilities);
        const stakeAmount = BigInt(Math.floor(stake_amount * 1e9));
        await manager.register({
          agentId,
          capabilities: capMask,
          endpoint,
          metadataUri: metadata_uri,
          stakeAmount
        });
        const resultLines = [
          "Agent registered successfully!",
          "Agent ID: " + agentIdToString(agentId),
          "PDA: " + (manager.getAgentPda()?.toBase58() ?? "unknown"),
          "Authority: " + keypair.publicKey.toBase58(),
          "Capabilities: " + capabilities.join(", "),
          "Stake: " + stake_amount + " SOL"
        ];
        return {
          content: [{ type: "text", text: resultLines.join("\n") }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_deregister_agent",
    "Deregister an agent (requires no active tasks, no pending votes, 24h since last vote)",
    {
      agent_id: z.string().describe("Agent ID (64-char hex string)")
    },
    async ({ agent_id }) => {
      try {
        const { keypair } = await getSigningProgram();
        const wallet = keypairToWallet2(keypair);
        const manager = new AgentManager({
          connection: getConnection(),
          wallet,
          programId: getCurrentProgramId()
        });
        const idBytes = hexToBytes(agent_id);
        await manager.load(idBytes);
        const sig = await manager.deregister();
        return {
          content: [{
            type: "text",
            text: "Agent deregistered successfully.\nAgent ID: " + agent_id + "\nSignature: " + sig
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_get_agent",
    "Get agent state by ID (decodes capabilities, status, reputation)",
    {
      agent_id: z.string().describe("Agent ID (64-char hex) or agent PDA (base58)")
    },
    async ({ agent_id }) => {
      try {
        const program = getReadOnlyProgram();
        let pda;
        if (agent_id.length === 64 && /^[0-9a-fA-F]+$/.test(agent_id)) {
          const idBytes = hexToBytes(agent_id);
          pda = findAgentPda(idBytes, getCurrentProgramId());
        } else {
          pda = new PublicKey3(agent_id);
        }
        const account = await program.account.agentRegistration.fetch(pda);
        return {
          content: [{
            type: "text",
            text: formatAgentState(account, pda)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_list_agents",
    "List registered agents (fetches all agentRegistration accounts)",
    {
      status_filter: z.enum(["inactive", "active", "busy", "suspended"]).optional().describe("Filter by agent status")
    },
    async ({ status_filter }) => {
      try {
        const program = getReadOnlyProgram();
        const accounts = await program.account.agentRegistration.all();
        let filtered = accounts;
        if (status_filter) {
          filtered = accounts.filter((a) => {
            const status = a.account.status;
            if (typeof status === "object" && status !== null) {
              return Object.keys(status).some((k) => k === status_filter);
            }
            return false;
          });
        }
        if (filtered.length === 0) {
          return {
            content: [{
              type: "text",
              text: status_filter ? "No agents found with status: " + status_filter : "No agents found"
            }]
          };
        }
        const lines = filtered.map((a, i) => {
          const acc = a.account;
          const agentId = acc.agentId;
          const idBytes = agentId instanceof Uint8Array ? agentId : new Uint8Array(agentId);
          const caps = BigInt(acc.capabilities.toString());
          return [
            "[" + (i + 1) + "] " + agentIdToShortString(idBytes),
            "    PDA: " + a.publicKey.toBase58(),
            "    Status: " + formatStatus(acc.status),
            "    Capabilities: " + (getCapabilityNames(caps).join(", ") || "None"),
            "    Tasks: " + acc.tasksCompleted + " completed, " + acc.activeTasks + " active"
          ].join("\n");
        });
        return {
          content: [{
            type: "text",
            text: "Found " + filtered.length + " agent(s):\n\n" + lines.join("\n\n")
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_update_agent",
    "Update agent capabilities, status, or endpoint",
    {
      agent_id: z.string().describe("Agent ID (64-char hex string)"),
      capabilities: z.array(z.string()).optional().describe("New capability names"),
      status: z.enum(["inactive", "active", "busy"]).optional().describe("New agent status"),
      endpoint: z.string().optional().describe("New endpoint URL"),
      metadata_uri: z.string().optional().describe("New metadata URI")
    },
    async ({ agent_id, capabilities, status, endpoint, metadata_uri }) => {
      try {
        const { keypair } = await getSigningProgram();
        const wallet = keypairToWallet2(keypair);
        const manager = new AgentManager({
          connection: getConnection(),
          wallet,
          programId: getCurrentProgramId()
        });
        const idBytes = hexToBytes(agent_id);
        await manager.load(idBytes);
        const updates = [];
        if (capabilities) {
          const capMask = createCapabilityMask(capabilities);
          await manager.updateCapabilities(capMask);
          updates.push("Capabilities: " + capabilities.join(", "));
        }
        if (status) {
          const statusMap = { inactive: 0, active: 1, busy: 2 };
          await manager.updateStatus(statusMap[status]);
          updates.push("Status: " + status);
        }
        if (endpoint) {
          await manager.updateEndpoint(endpoint);
          updates.push("Endpoint: " + endpoint);
        }
        if (metadata_uri) {
          await manager.updateMetadataUri(metadata_uri);
          updates.push("Metadata URI: " + metadata_uri);
        }
        return {
          content: [{
            type: "text",
            text: updates.length > 0 ? "Agent updated:\n" + updates.join("\n") : "No updates specified"
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_decode_capabilities",
    "Decode a capability bitmask to human-readable names",
    {
      bitmask: z.string().describe('Capability bitmask as decimal or hex string (e.g. "3" or "0x03")')
    },
    async ({ bitmask }) => {
      try {
        const value = BigInt(bitmask);
        const names = getCapabilityNames(value);
        const allCaps = Object.entries(AgentCapabilities).filter(([, v]) => typeof v === "bigint").map(([name, val]) => {
          const has = (value & val) !== 0n;
          return "  " + (has ? "[x]" : "[ ]") + " " + name + " (" + val + ")";
        });
        return {
          content: [{
            type: "text",
            text: [
              "Bitmask: " + value + " (0x" + value.toString(16) + ")",
              "Active: " + (names.length > 0 ? names.join(", ") : "None"),
              "",
              "All capabilities:",
              ...allCaps
            ].join("\n")
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
}

// src/tools/tasks.ts
import { PublicKey as PublicKey4 } from "@solana/web3.js";
import { SEEDS } from "@agenc/sdk";
import { getCapabilityNames as getCapabilityNames2, hexToBytes as hexToBytes2 } from "@agenc/runtime";
import { z as z2 } from "zod";
function deriveTaskPda(creator, taskId, programId) {
  const [pda] = PublicKey4.findProgramAddressSync(
    [SEEDS.TASK, creator.toBuffer(), Buffer.from(taskId)],
    programId
  );
  return pda;
}
function deriveEscrowPda(taskPda, programId) {
  const [pda] = PublicKey4.findProgramAddressSync(
    [SEEDS.ESCROW, taskPda.toBuffer()],
    programId
  );
  return pda;
}
function formatTaskAccount(account, pda) {
  const taskId = account.taskId;
  const idHex = Buffer.from(taskId instanceof Uint8Array ? taskId : new Uint8Array(taskId)).toString("hex");
  const reqCaps = BigInt(account.requiredCapabilities?.toString?.() ?? "0");
  const capNames = getCapabilityNames2(reqCaps);
  const lines = [
    "Task PDA: " + pda.toBase58(),
    "Task ID: " + idHex,
    "Creator: " + account.creator.toBase58(),
    "Status: " + formatTaskStatus(account.status),
    "Type: " + formatTaskType(account.taskType),
    "",
    "--- Configuration ---",
    "Required Capabilities: " + (capNames.length > 0 ? capNames.join(", ") : "None") + " (bitmask: " + reqCaps + ")",
    "Max Workers: " + (account.maxWorkers ?? 1),
    "Current Workers: " + (account.currentWorkers ?? 0),
    "Reward: " + formatSol(Number(account.rewardAmount ?? 0)),
    "Deadline: " + formatTimestamp(Number(account.deadline ?? 0)),
    "",
    "--- State ---",
    "Completions: " + (account.completions ?? 0),
    "Constraint Hash: " + formatBytes(account.constraintHash),
    "Description: " + (account.description || "None"),
    "",
    "--- Timestamps ---",
    "Created: " + formatTimestamp(Number(account.createdAt ?? 0)),
    "Updated: " + formatTimestamp(Number(account.updatedAt ?? 0))
  ];
  return lines.join("\n");
}
function registerTaskTools(server) {
  server.tool(
    "agenc_get_task",
    "Get task state by PDA address or by creator + task ID",
    {
      task_pda: z2.string().optional().describe("Task PDA (base58)"),
      creator: z2.string().optional().describe("Task creator public key (base58)"),
      task_id: z2.string().optional().describe("Task ID (64-char hex)")
    },
    async ({ task_pda, creator, task_id }) => {
      try {
        const program = getReadOnlyProgram();
        let pda;
        if (task_pda) {
          pda = new PublicKey4(task_pda);
        } else if (creator && task_id) {
          const creatorPk = new PublicKey4(creator);
          const idBytes = hexToBytes2(task_id);
          pda = deriveTaskPda(creatorPk, idBytes, getCurrentProgramId());
        } else {
          return {
            content: [{
              type: "text",
              text: "Error: provide either task_pda or both creator and task_id"
            }]
          };
        }
        const account = await program.account.task.fetch(pda);
        return {
          content: [{
            type: "text",
            text: formatTaskAccount(account, pda)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_list_tasks",
    "List tasks by creator public key",
    {
      creator: z2.string().describe("Task creator public key (base58)")
    },
    async ({ creator }) => {
      try {
        const program = getReadOnlyProgram();
        const creatorPk = new PublicKey4(creator);
        const accounts = await program.account.task.all([
          {
            memcmp: {
              offset: 8,
              // discriminator
              bytes: creatorPk.toBase58()
            }
          }
        ]);
        if (accounts.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No tasks found for creator: " + creator
            }]
          };
        }
        const lines = accounts.map((a, i) => {
          const acc = a.account;
          const taskId = acc.taskId;
          const idHex = Buffer.from(
            taskId instanceof Uint8Array ? taskId : new Uint8Array(taskId)
          ).toString("hex");
          return [
            "[" + (i + 1) + "] Task " + idHex.slice(0, 16) + "...",
            "    PDA: " + a.publicKey.toBase58(),
            "    Status: " + formatTaskStatus(acc.status),
            "    Type: " + formatTaskType(acc.taskType),
            "    Reward: " + formatSol(Number(acc.rewardAmount ?? 0)),
            "    Workers: " + (acc.currentWorkers ?? 0) + "/" + (acc.maxWorkers ?? 1)
          ].join("\n");
        });
        return {
          content: [{
            type: "text",
            text: "Found " + accounts.length + " task(s):\n\n" + lines.join("\n\n")
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_get_escrow",
    "Get escrow balance and state for a task",
    {
      task_pda: z2.string().optional().describe("Task PDA (base58)"),
      escrow_pda: z2.string().optional().describe("Escrow PDA (base58) \u2014 if known directly")
    },
    async ({ task_pda, escrow_pda }) => {
      try {
        let escrowAddr;
        let taskAddr = null;
        if (escrow_pda) {
          escrowAddr = new PublicKey4(escrow_pda);
        } else if (task_pda) {
          taskAddr = new PublicKey4(task_pda);
          escrowAddr = deriveEscrowPda(taskAddr, getCurrentProgramId());
        } else {
          return {
            content: [{
              type: "text",
              text: "Error: provide either task_pda or escrow_pda"
            }]
          };
        }
        const connection = getConnection();
        const balance = await connection.getBalance(escrowAddr);
        const lines = [
          "Escrow PDA: " + escrowAddr.toBase58()
        ];
        if (taskAddr) {
          lines.push("Task PDA: " + taskAddr.toBase58());
        }
        lines.push(
          "Balance: " + formatSol(balance),
          "Lamports: " + balance
        );
        if (taskAddr) {
          try {
            const program = getReadOnlyProgram();
            const task = await program.account.task.fetch(taskAddr);
            lines.push(
              "",
              "--- Task Context ---",
              "Status: " + formatTaskStatus(task.status),
              "Reward Amount: " + formatSol(Number(task.rewardAmount ?? 0)),
              "Completions: " + (task.completions ?? 0)
            );
          } catch {
          }
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_create_task",
    "Create a new task with escrow reward (requires signing keypair)",
    {
      capabilities: z2.array(z2.string()).describe("Required capability names"),
      reward: z2.number().positive().describe("Reward amount in SOL"),
      task_type: z2.enum(["exclusive", "collaborative", "competitive"]).default("exclusive").describe("Task type"),
      max_workers: z2.number().int().positive().default(1).describe("Maximum workers"),
      deadline_minutes: z2.number().positive().default(60).describe("Deadline in minutes from now"),
      description: z2.string().optional().describe("Task description (max 64 bytes)")
    },
    async ({ capabilities: _capabilities, reward: _reward, task_type: _task_type, max_workers: _max_workers, deadline_minutes: _deadline_minutes, description: _description }) => {
      return {
        content: [{
          type: "text",
          text: [
            "Task creation via MCP requires a running validator and funded keypair.",
            "Use the SDK directly for transaction submission:",
            "",
            '  import { createTask } from "@agenc/sdk";',
            "  await createTask(connection, program, creator, params);",
            "",
            "Or use anchor test to run the full integration test suite."
          ].join("\n")
        }]
      };
    }
  );
  server.tool(
    "agenc_claim_task",
    "Claim a task as a worker (requires signing keypair)",
    {
      task_pda: z2.string().describe("Task PDA (base58)"),
      agent_id: z2.string().describe("Agent ID (64-char hex)")
    },
    async ({ task_pda: _task_pda, agent_id: _agent_id }) => {
      return {
        content: [{
          type: "text",
          text: [
            "Task claiming via MCP requires a running validator and funded keypair.",
            "Use the SDK directly for transaction submission:",
            "",
            '  import { claimTask } from "@agenc/sdk";',
            "  await claimTask(connection, program, agent, taskId);"
          ].join("\n")
        }]
      };
    }
  );
  server.tool(
    "agenc_complete_task",
    "Complete a claimed task with proof (requires signing keypair)",
    {
      task_pda: z2.string().describe("Task PDA (base58)"),
      agent_id: z2.string().describe("Agent ID (64-char hex)"),
      proof_hash: z2.string().describe("Proof hash (64-char hex)")
    },
    async ({ task_pda: _task_pda, agent_id: _agent_id, proof_hash: _proof_hash }) => {
      return {
        content: [{
          type: "text",
          text: [
            "Task completion via MCP requires a running validator and funded keypair.",
            "Use the SDK directly for transaction submission:",
            "",
            '  import { completeTask } from "@agenc/sdk";',
            "  await completeTask(connection, program, worker, taskId, resultHash);"
          ].join("\n")
        }]
      };
    }
  );
  server.tool(
    "agenc_cancel_task",
    "Cancel a task (creator only, requires signing keypair)",
    {
      task_pda: z2.string().describe("Task PDA (base58)")
    },
    async ({ task_pda: _task_pda }) => {
      return {
        content: [{
          type: "text",
          text: [
            "Task cancellation via MCP requires a running validator and funded keypair.",
            "Use the SDK or Anchor test suite for transaction submission."
          ].join("\n")
        }]
      };
    }
  );
}

// src/tools/protocol.ts
import { PublicKey as PublicKey5 } from "@solana/web3.js";
import { SEEDS as SEEDS2 } from "@agenc/sdk";
import {
  getAnchorErrorName,
  getAnchorErrorMessage,
  findProtocolPda,
  deriveAgentPda,
  deriveProtocolPda,
  deriveAuthorityVotePda
} from "@agenc/runtime";
import { z as z3 } from "zod";
function formatProtocolConfig(config, pda) {
  const lines = [
    "Protocol Config PDA: " + pda.toBase58(),
    "",
    "--- Authority ---",
    "Authority: " + config.authority.toBase58(),
    "Treasury: " + config.treasury.toBase58(),
    "",
    "--- Fees & Thresholds ---",
    "Protocol Fee: " + config.protocolFeeBps + " bps (" + (Number(config.protocolFeeBps) / 100).toFixed(2) + "%)",
    "Dispute Threshold: " + config.disputeThreshold + "%",
    "Slash Percentage: " + config.slashPercentage + "%",
    "",
    "--- Stakes ---",
    "Min Agent Stake: " + formatSol(Number(config.minAgentStake ?? 0)),
    "Min Arbiter Stake: " + formatSol(Number(config.minArbiterStake ?? 0)),
    "Min Dispute Stake: " + formatSol(Number(config.minStakeForDispute ?? 0)),
    "",
    "--- Durations ---",
    "Max Claim Duration: " + config.maxClaimDuration + "s",
    "Max Dispute Duration: " + config.maxDisputeDuration + "s",
    "",
    "--- Rate Limits ---",
    "Task Creation Cooldown: " + config.taskCreationCooldown + "s",
    "Max Tasks / 24h: " + (Number(config.maxTasksPer24h) === 0 ? "Unlimited" : String(config.maxTasksPer24h)),
    "Dispute Initiation Cooldown: " + config.disputeInitiationCooldown + "s",
    "Max Disputes / 24h: " + (Number(config.maxDisputesPer24h) === 0 ? "Unlimited" : String(config.maxDisputesPer24h)),
    "",
    "--- Stats ---",
    "Total Agents: " + config.totalAgents,
    "Total Tasks: " + config.totalTasks,
    "Completed Tasks: " + config.completedTasks,
    "Total Value Distributed: " + formatSol(Number(config.totalValueDistributed ?? 0)),
    "",
    "--- Version ---",
    "Protocol Version: " + config.protocolVersion,
    "Min Supported Version: " + config.minSupportedVersion,
    "",
    "--- Multisig ---",
    "Threshold: " + config.multisigThreshold,
    "Owners: " + config.multisigOwnersLen
  ];
  return lines.join("\n");
}
function registerProtocolTools(server) {
  server.tool(
    "agenc_get_protocol_config",
    "Get full protocol configuration (fees, thresholds, rate limits, stats)",
    {},
    async () => {
      try {
        const program = getReadOnlyProgram();
        const pda = findProtocolPda(getCurrentProgramId());
        const config = await program.account.protocolConfig.fetch(pda);
        return {
          content: [{
            type: "text",
            text: formatProtocolConfig(config, pda)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_derive_pda",
    "Derive any AgenC PDA (agent, task, escrow, claim, dispute, vote, protocol)",
    {
      pda_type: z3.enum(["protocol", "agent", "task", "escrow", "claim", "dispute", "vote", "authority_vote"]).describe("Type of PDA to derive"),
      agent_id: z3.string().optional().describe("Agent ID (hex) \u2014 for agent PDAs"),
      creator: z3.string().optional().describe("Creator pubkey (base58) \u2014 for task PDAs"),
      task_id: z3.string().optional().describe("Task ID (hex) \u2014 for task PDAs"),
      task_pda: z3.string().optional().describe("Task PDA (base58) \u2014 for escrow/claim PDAs"),
      worker_pda: z3.string().optional().describe("Worker agent PDA (base58) \u2014 for claim PDAs"),
      dispute_id: z3.string().optional().describe("Dispute ID (hex) \u2014 for dispute PDAs"),
      dispute_pda: z3.string().optional().describe("Dispute PDA (base58) \u2014 for vote PDAs"),
      voter: z3.string().optional().describe("Voter pubkey (base58) \u2014 for vote PDAs")
    },
    async ({ pda_type, agent_id, creator, task_id, task_pda, worker_pda, dispute_id, dispute_pda, voter }) => {
      try {
        const programId = getCurrentProgramId();
        let address;
        let bump;
        let seedsDesc;
        switch (pda_type) {
          case "protocol": {
            const result = deriveProtocolPda(programId);
            address = result.address;
            bump = result.bump;
            seedsDesc = '["protocol"]';
            break;
          }
          case "agent": {
            if (!agent_id) {
              return { content: [{ type: "text", text: "Error: agent_id required for agent PDA" }] };
            }
            const idBytes = Buffer.from(agent_id, "hex");
            const result = deriveAgentPda(idBytes, programId);
            address = result.address;
            bump = result.bump;
            seedsDesc = '["agent", agent_id]';
            break;
          }
          case "task": {
            if (!creator || !task_id) {
              return { content: [{ type: "text", text: "Error: creator and task_id required for task PDA" }] };
            }
            const creatorPk = new PublicKey5(creator);
            const taskIdBuf = Buffer.from(task_id, "hex");
            const [taskPda, taskBump] = PublicKey5.findProgramAddressSync(
              [SEEDS2.TASK, creatorPk.toBuffer(), taskIdBuf],
              programId
            );
            address = taskPda;
            bump = taskBump;
            seedsDesc = '["task", creator, task_id]';
            break;
          }
          case "escrow": {
            if (!task_pda) {
              return { content: [{ type: "text", text: "Error: task_pda required for escrow PDA" }] };
            }
            const taskPk = new PublicKey5(task_pda);
            const [escrowPda, escrowBump] = PublicKey5.findProgramAddressSync(
              [SEEDS2.ESCROW, taskPk.toBuffer()],
              programId
            );
            address = escrowPda;
            bump = escrowBump;
            seedsDesc = '["escrow", task_pda]';
            break;
          }
          case "claim": {
            if (!task_pda || !worker_pda) {
              return { content: [{ type: "text", text: "Error: task_pda and worker_pda required for claim PDA" }] };
            }
            const tPk = new PublicKey5(task_pda);
            const wPk = new PublicKey5(worker_pda);
            const [claimPda, claimBump] = PublicKey5.findProgramAddressSync(
              [SEEDS2.CLAIM, tPk.toBuffer(), wPk.toBuffer()],
              programId
            );
            address = claimPda;
            bump = claimBump;
            seedsDesc = '["claim", task_pda, worker_pda]';
            break;
          }
          case "dispute": {
            if (!dispute_id) {
              return { content: [{ type: "text", text: "Error: dispute_id required for dispute PDA" }] };
            }
            const disputeIdBuf = Buffer.from(dispute_id, "hex");
            const [dPda, dBump] = PublicKey5.findProgramAddressSync(
              [SEEDS2.DISPUTE, disputeIdBuf],
              programId
            );
            address = dPda;
            bump = dBump;
            seedsDesc = '["dispute", dispute_id]';
            break;
          }
          case "vote": {
            if (!dispute_pda || !voter) {
              return { content: [{ type: "text", text: "Error: dispute_pda and voter required for vote PDA" }] };
            }
            const dpk = new PublicKey5(dispute_pda);
            const vpk = new PublicKey5(voter);
            const [votePda, voteBump] = PublicKey5.findProgramAddressSync(
              [SEEDS2.VOTE, dpk.toBuffer(), vpk.toBuffer()],
              programId
            );
            address = votePda;
            bump = voteBump;
            seedsDesc = '["vote", dispute_pda, voter]';
            break;
          }
          case "authority_vote": {
            if (!dispute_pda || !voter) {
              return { content: [{ type: "text", text: "Error: dispute_pda and voter required for authority_vote PDA" }] };
            }
            const result = deriveAuthorityVotePda(
              new PublicKey5(dispute_pda),
              new PublicKey5(voter),
              programId
            );
            address = result.address;
            bump = result.bump;
            seedsDesc = '["authority_vote", dispute_pda, voter]';
            break;
          }
          default:
            return { content: [{ type: "text", text: "Error: unknown PDA type" }] };
        }
        return {
          content: [{
            type: "text",
            text: [
              "PDA Type: " + pda_type,
              "Address: " + address.toBase58(),
              "Bump: " + (bump !== void 0 ? bump : "N/A"),
              "Seeds: " + seedsDesc,
              "Program: " + programId.toBase58()
            ].join("\n")
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_decode_error",
    "Decode an Anchor error code (6000-6077) to name and description",
    {
      error_code: z3.number().int().describe("Anchor error code (e.g. 6000)")
    },
    async ({ error_code }) => {
      try {
        const name = getAnchorErrorName(error_code);
        const message = name ? getAnchorErrorMessage(error_code) : void 0;
        if (!name) {
          if (error_code >= 100 && error_code < 6e3) {
            return {
              content: [{
                type: "text",
                text: "Error code " + error_code + " is an Anchor framework error, not an AgenC program error.\nAgenC error codes range from 6000-6077."
              }]
            };
          }
          return {
            content: [{
              type: "text",
              text: "Unknown error code: " + error_code + "\nValid range: 6000-6077"
            }]
          };
        }
        let category;
        if (error_code <= 6007) category = "Agent";
        else if (error_code <= 6023) category = "Task";
        else if (error_code <= 6032) category = "Claim";
        else if (error_code <= 6047) category = "Dispute";
        else if (error_code <= 6050) category = "State";
        else if (error_code <= 6061) category = "Protocol";
        else if (error_code <= 6068) category = "General";
        else if (error_code <= 6071) category = "Rate Limiting";
        else category = "Version/Upgrade";
        return {
          content: [{
            type: "text",
            text: [
              "Error Code: " + error_code + " (0x" + error_code.toString(16) + ")",
              "Name: " + name,
              "Category: " + category,
              "Description: " + (message || "No description available")
            ].join("\n")
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_get_program_info",
    "Get AgenC program deployment info (program ID, account existence)",
    {},
    async () => {
      try {
        const connection = getConnection();
        const programId = getCurrentProgramId();
        const accountInfo = await connection.getAccountInfo(programId);
        const protocolPda = findProtocolPda(programId);
        const protocolInfo = await connection.getAccountInfo(protocolPda);
        const lines = [
          "Program ID: " + programId.toBase58(),
          "Program Exists: " + (accountInfo !== null ? "Yes" : "No")
        ];
        if (accountInfo) {
          lines.push(
            "Executable: " + accountInfo.executable,
            "Owner: " + accountInfo.owner.toBase58(),
            "Data Length: " + accountInfo.data.length + " bytes"
          );
        }
        lines.push(
          "",
          "Protocol Config PDA: " + protocolPda.toBase58(),
          "Protocol Initialized: " + (protocolInfo !== null ? "Yes" : "No")
        );
        if (protocolInfo) {
          lines.push("Protocol Data Length: " + protocolInfo.data.length + " bytes");
        }
        return {
          content: [{ type: "text", text: lines.join("\n") }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
}

// src/tools/disputes.ts
import { PublicKey as PublicKey6 } from "@solana/web3.js";
import { SEEDS as SEEDS3 } from "@agenc/sdk";
import { z as z4 } from "zod";
function formatDisputeAccount(account, pda) {
  const disputeId = account.disputeId;
  const idHex = Buffer.from(
    disputeId instanceof Uint8Array ? disputeId : new Uint8Array(disputeId)
  ).toString("hex");
  const lines = [
    "Dispute PDA: " + pda.toBase58(),
    "Dispute ID: " + idHex,
    "Status: " + formatDisputeStatus(account.status),
    "Resolution Type: " + formatResolutionType(account.resolutionType),
    "",
    "--- Parties ---",
    "Task PDA: " + account.task.toBase58(),
    "Initiator: " + account.initiator.toBase58(),
    "",
    "--- Voting ---",
    "Votes For: " + (account.votesFor ?? 0),
    "Votes Against: " + (account.votesAgainst ?? 0),
    "Voting Deadline: " + formatTimestamp(Number(account.votingDeadline ?? 0)),
    "",
    "--- Evidence ---",
    "Evidence: " + (account.evidence || "None"),
    "",
    "--- Timestamps ---",
    "Created: " + formatTimestamp(Number(account.createdAt ?? 0)),
    "Resolved: " + formatTimestamp(Number(account.resolvedAt ?? 0))
  ];
  return lines.join("\n");
}
function registerDisputeTools(server) {
  server.tool(
    "agenc_get_dispute",
    "Get dispute state by dispute ID or PDA",
    {
      dispute_id: z4.string().optional().describe("Dispute ID (64-char hex)"),
      dispute_pda: z4.string().optional().describe("Dispute PDA (base58)")
    },
    async ({ dispute_id, dispute_pda }) => {
      try {
        const program = getReadOnlyProgram();
        let pda;
        if (dispute_pda) {
          pda = new PublicKey6(dispute_pda);
        } else if (dispute_id) {
          const idBuf = Buffer.from(dispute_id, "hex");
          [pda] = PublicKey6.findProgramAddressSync(
            [SEEDS3.DISPUTE, idBuf],
            getCurrentProgramId()
          );
        } else {
          return {
            content: [{
              type: "text",
              text: "Error: provide either dispute_id or dispute_pda"
            }]
          };
        }
        const account = await program.account.dispute.fetch(pda);
        return {
          content: [{
            type: "text",
            text: formatDisputeAccount(account, pda)
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_list_disputes",
    "List disputes (optionally filter by status)",
    {
      status_filter: z4.enum(["active", "resolved", "expired"]).optional().describe("Filter by dispute status")
    },
    async ({ status_filter }) => {
      try {
        const program = getReadOnlyProgram();
        const accounts = await program.account.dispute.all();
        let filtered = accounts;
        if (status_filter) {
          filtered = accounts.filter((a) => {
            const status = a.account.status;
            if (typeof status === "object" && status !== null) {
              return Object.keys(status).some((k) => k === status_filter);
            }
            return false;
          });
        }
        if (filtered.length === 0) {
          return {
            content: [{
              type: "text",
              text: status_filter ? "No disputes found with status: " + status_filter : "No disputes found"
            }]
          };
        }
        const lines = filtered.map((a, i) => {
          const acc = a.account;
          const disputeId = acc.disputeId;
          const idHex = Buffer.from(
            disputeId instanceof Uint8Array ? disputeId : new Uint8Array(disputeId)
          ).toString("hex");
          return [
            "[" + (i + 1) + "] Dispute " + idHex.slice(0, 16) + "...",
            "    PDA: " + a.publicKey.toBase58(),
            "    Status: " + formatDisputeStatus(acc.status),
            "    Resolution: " + formatResolutionType(acc.resolutionType),
            "    Votes: " + (acc.votesFor ?? 0) + " for / " + (acc.votesAgainst ?? 0) + " against",
            "    Deadline: " + formatTimestamp(Number(acc.votingDeadline ?? 0))
          ].join("\n");
        });
        return {
          content: [{
            type: "text",
            text: "Found " + filtered.length + " dispute(s):\n\n" + lines.join("\n\n")
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
}

// src/tools/connection.ts
import { PublicKey as PublicKey7, LAMPORTS_PER_SOL as LAMPORTS_PER_SOL3 } from "@solana/web3.js";
import { z as z5 } from "zod";
function registerConnectionTools(server) {
  server.tool(
    "agenc_set_network",
    "Switch RPC endpoint to localnet, devnet, mainnet, or a custom URL",
    {
      network: z5.string().describe("Network name (localnet, devnet, mainnet) or custom RPC URL")
    },
    async ({ network }) => {
      try {
        const result = setNetwork(network);
        return {
          content: [{
            type: "text",
            text: "Switched to: " + result.network + "\nRPC URL: " + result.rpcUrl + "\nProgram ID: " + getCurrentProgramId().toBase58()
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_get_balance",
    "Get SOL balance for any public key",
    {
      pubkey: z5.string().describe("Base58-encoded public key")
    },
    async ({ pubkey }) => {
      try {
        const pk = new PublicKey7(pubkey);
        const connection = getConnection();
        const balance = await connection.getBalance(pk);
        const sol = balance / LAMPORTS_PER_SOL3;
        return {
          content: [{
            type: "text",
            text: sol + " SOL (" + balance + " lamports)"
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
  server.tool(
    "agenc_airdrop",
    "Request SOL airdrop (localnet/devnet only)",
    {
      pubkey: z5.string().describe("Base58-encoded public key to fund"),
      amount: z5.number().positive().default(1).describe("Amount of SOL to airdrop")
    },
    async ({ pubkey, amount }) => {
      try {
        const network = getCurrentNetwork();
        if (network === "mainnet" || network.includes("mainnet")) {
          return {
            content: [{ type: "text", text: "Error: airdrop not available on mainnet" }]
          };
        }
        const pk = new PublicKey7(pubkey);
        const connection = getConnection();
        const lamports = Math.floor(amount * LAMPORTS_PER_SOL3);
        const sig = await connection.requestAirdrop(pk, lamports);
        await connection.confirmTransaction(sig, "confirmed");
        return {
          content: [{
            type: "text",
            text: "Airdropped " + amount + " SOL to " + pubkey + "\nSignature: " + sig
          }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: "Error: " + error.message }]
        };
      }
    }
  );
}

// src/server.ts
function createServer() {
  const server = new McpServer({
    name: "AgenC Protocol Tools",
    version: "0.1.0"
  });
  registerConnectionTools(server);
  registerAgentTools(server);
  registerTaskTools(server);
  registerProtocolTools(server);
  registerDisputeTools(server);
  registerResources(server);
  registerPrompts(server);
  return server;
}
function registerResources(server) {
  server.resource(
    "errorCodes",
    "agenc://error-codes",
    { description: "Full AgenC error code reference (6000-6077)" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: ERROR_CODES_REFERENCE
      }]
    })
  );
  server.resource(
    "capabilities",
    "agenc://capabilities",
    { description: "Agent capability bitmask reference" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: CAPABILITIES_REFERENCE
      }]
    })
  );
  server.resource(
    "pdaSeeds",
    "agenc://pda-seeds",
    { description: "PDA seed format reference for all account types" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: PDA_SEEDS_REFERENCE
      }]
    })
  );
  server.resource(
    "taskStates",
    "agenc://task-states",
    { description: "Task state machine documentation" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        text: TASK_STATES_REFERENCE
      }]
    })
  );
}
function registerPrompts(server) {
  server.prompt(
    "debug-task",
    "Guided task debugging workflow",
    { task_pda: z6.string().describe("Task PDA to debug") },
    ({ task_pda }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Debug the AgenC task at PDA " + task_pda + ". Steps:\n1. Use agenc_get_task to fetch the task state\n2. Check the task status and identify any issues\n3. Use agenc_get_escrow to verify escrow balance\n4. If disputed, use agenc_get_dispute to check dispute state\n5. Summarize findings and suggest next steps"
        }
      }]
    })
  );
  server.prompt(
    "inspect-agent",
    "Agent state inspection with decoded fields",
    { agent_id: z6.string().describe("Agent ID (hex) or PDA (base58)") },
    ({ agent_id }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Inspect the AgenC agent with ID/PDA " + agent_id + ". Steps:\n1. Use agenc_get_agent to fetch full agent state\n2. Use agenc_decode_capabilities to explain the capability bitmask\n3. Check rate limit state and active tasks\n4. Summarize the agent health and any concerns"
        }
      }]
    })
  );
  server.prompt(
    "escrow-audit",
    "Escrow balance verification checklist",
    { task_pda: z6.string().describe("Task PDA to audit") },
    ({ task_pda }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: "Audit the escrow for AgenC task at PDA " + task_pda + ". Steps:\n1. Use agenc_get_task to fetch the task reward amount and status\n2. Use agenc_get_escrow to check actual escrow balance\n3. Compare expected vs actual balance\n4. Check if completions match distributed amounts\n5. Use agenc_get_protocol_config to verify fee calculations\n6. Report any discrepancies"
        }
      }]
    })
  );
}
var ERROR_CODES_REFERENCE = `# AgenC Error Codes (6000-6077)

## Agent Errors (6000-6007)
- 6000 AgentAlreadyRegistered: Agent is already registered
- 6001 AgentNotFound: Agent not found
- 6002 AgentNotActive: Agent is not active
- 6003 InsufficientCapabilities: Agent has insufficient capabilities
- 6004 MaxActiveTasksReached: Agent has reached maximum active tasks
- 6005 AgentHasActiveTasks: Agent has active tasks and cannot be deregistered
- 6006 UnauthorizedAgent: Only the agent authority can perform this action
- 6007 AgentRegistrationRequired: Agent registration required to create tasks

## Task Errors (6008-6023)
- 6008 TaskNotFound: Task not found
- 6009 TaskNotOpen: Task is not open for claims
- 6010 TaskFullyClaimed: Task has reached maximum workers
- 6011 TaskExpired: Task has expired
- 6012 TaskNotExpired: Task deadline has not passed
- 6013 DeadlinePassed: Task deadline has passed
- 6014 TaskNotInProgress: Task is not in progress
- 6015 TaskAlreadyCompleted: Task is already completed
- 6016 TaskCannotBeCancelled: Task cannot be cancelled
- 6017 UnauthorizedTaskAction: Only the task creator can perform this action
- 6018 InvalidCreator: Invalid creator
- 6019 InvalidTaskType: Invalid task type
- 6020 CompetitiveTaskAlreadyWon: Competitive task already completed by another worker
- 6021 NoWorkers: Task has no workers
- 6022 ConstraintHashMismatch: Proof constraint hash does not match task
- 6023 NotPrivateTask: Task is not a private task (no constraint hash set)

## Claim Errors (6024-6032)
- 6024 AlreadyClaimed: Worker has already claimed this task
- 6025 NotClaimed: Worker has not claimed this task
- 6026 ClaimAlreadyCompleted: Claim has already been completed
- 6027 ClaimNotExpired: Claim has not expired yet
- 6028 InvalidProof: Invalid proof of work
- 6029 ZkVerificationFailed: ZK proof verification failed
- 6030 InvalidProofSize: Invalid proof size - expected 388 bytes for Groth16
- 6031 InvalidProofBinding: Invalid proof binding: expected_binding cannot be all zeros
- 6032 InvalidOutputCommitment: Invalid output commitment: output_commitment cannot be all zeros

## Dispute Errors (6033-6047)
- 6033 DisputeNotActive: Dispute is not active
- 6034 VotingEnded: Voting period has ended
- 6035 VotingNotEnded: Voting period has not ended
- 6036 AlreadyVoted: Already voted on this dispute
- 6037 NotArbiter: Not authorized to vote (not an arbiter)
- 6038 InsufficientVotes: Insufficient votes to resolve
- 6039 DisputeAlreadyResolved: Dispute has already been resolved
- 6040 UnauthorizedResolver: Only protocol authority or dispute initiator can resolve
- 6041 ActiveDisputeVotes: Agent has active dispute votes pending resolution
- 6042 RecentVoteActivity: Agent must wait 24 hours after voting before deregistering
- 6043 InsufficientEvidence: Insufficient dispute evidence provided
- 6044 EvidenceTooLong: Dispute evidence exceeds maximum allowed length
- 6045 DisputeNotExpired: Dispute has not expired
- 6046 SlashAlreadyApplied: Dispute slashing already applied
- 6047 DisputeNotResolved: Dispute has not been resolved

## State Errors (6048-6050)
- 6048 VersionMismatch: State version mismatch (concurrent modification)
- 6049 StateKeyExists: State key already exists
- 6050 StateNotFound: State not found

## Protocol Errors (6051-6061)
- 6051 ProtocolAlreadyInitialized: Protocol is already initialized
- 6052 ProtocolNotInitialized: Protocol is not initialized
- 6053 InvalidProtocolFee: Invalid protocol fee (must be <= 1000 bps)
- 6054 InvalidDisputeThreshold: Invalid dispute threshold
- 6055 InsufficientStake: Insufficient stake for arbiter registration
- 6056 MultisigInvalidThreshold: Invalid multisig threshold
- 6057 MultisigInvalidSigners: Invalid multisig signer configuration
- 6058 MultisigNotEnoughSigners: Not enough multisig signers
- 6059 MultisigDuplicateSigner: Duplicate multisig signer provided
- 6060 MultisigDefaultSigner: Multisig signer cannot be default pubkey
- 6061 MultisigSignerNotSystemOwned: Multisig signer account not owned by System Program

## General Errors (6062-6068)
- 6062 InvalidInput: Invalid input parameter
- 6063 ArithmeticOverflow: Arithmetic overflow
- 6064 VoteOverflow: Vote count overflow
- 6065 InsufficientFunds: Insufficient funds
- 6066 CorruptedData: Account data is corrupted
- 6067 StringTooLong: String too long
- 6068 InvalidAccountOwner: Account not owned by this program

## Rate Limiting Errors (6069-6071)
- 6069 RateLimitExceeded: Maximum actions per 24h window reached
- 6070 CooldownNotElapsed: Cooldown period has not elapsed since last action
- 6071 InsufficientStakeForDispute: Insufficient stake to initiate dispute

## Version/Upgrade Errors (6072-6077)
- 6072 VersionMismatchProtocol: Protocol version incompatible
- 6073 AccountVersionTooOld: Account version too old, migration required
- 6074 AccountVersionTooNew: Account version too new, program upgrade required
- 6075 InvalidMigrationSource: Migration not allowed from source version
- 6076 InvalidMigrationTarget: Migration not allowed to target version
- 6077 UnauthorizedUpgrade: Only upgrade authority can perform this action
`;
var CAPABILITIES_REFERENCE = `# AgenC Agent Capabilities

Capabilities are stored as a u64 bitmask on the AgentRegistration account.

| Bit | Name        | Value | Description              |
|-----|-------------|-------|--------------------------|
| 0   | COMPUTE     | 1     | General computation      |
| 1   | INFERENCE   | 2     | ML inference             |
| 2   | STORAGE     | 4     | Data storage             |
| 3   | NETWORK     | 8     | Network relay            |
| 4   | SENSOR      | 16    | Sensor data collection   |
| 5   | ACTUATOR    | 32    | Physical actuation       |
| 6   | COORDINATOR | 64    | Task coordination        |
| 7   | ARBITER     | 128   | Dispute resolution       |
| 8   | VALIDATOR   | 256   | Result validation        |
| 9   | AGGREGATOR  | 512   | Data aggregation         |

## Examples

- COMPUTE + INFERENCE = 3 (0x03)
- All capabilities = 1023 (0x3FF)
- ARBITER only = 128 (0x80)

## Usage in Tasks

Tasks specify \`required_capabilities\` as a bitmask. An agent must have
ALL required capabilities set to claim a task.
`;
var PDA_SEEDS_REFERENCE = `# AgenC PDA Seeds

All PDAs are derived from the program ID: EopUaCV2svxj9j4hd7KjbrWfdjkspmm2BCBe7jGpKzKZ

| Account          | Seeds                              | Notes                       |
|------------------|------------------------------------|-----------------------------|
| ProtocolConfig   | ["protocol"]                       | Singleton                   |
| AgentRegistration| ["agent", agent_id]                | agent_id: [u8; 32]          |
| Task             | ["task", creator, task_id]         | creator: Pubkey, task_id: [u8; 32] |
| Escrow           | ["escrow", task_pda]               | task_pda: Pubkey             |
| Claim            | ["claim", task_pda, worker_pda]    | Both are Pubkeys             |
| Dispute          | ["dispute", dispute_id]            | dispute_id: [u8; 32]        |
| Vote             | ["vote", dispute_pda, voter]       | Both are Pubkeys             |
| AuthorityVote    | ["authority_vote", dispute_pda, authority] | Both are Pubkeys      |

## Derivation in TypeScript

\`\`\`typescript
import { PublicKey } from '@solana/web3.js';

const [pda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from('task'), creator.toBuffer(), taskIdBuffer],
  programId
);
\`\`\`

Use the \`agenc_derive_pda\` tool to derive any PDA without writing code.
`;
var TASK_STATES_REFERENCE = `# AgenC Task State Machine

## States

| Value | Name              | Description                          |
|-------|-------------------|--------------------------------------|
| 0     | Open              | Task is open for claims              |
| 1     | InProgress        | Task has been claimed, work underway |
| 2     | PendingValidation | Work submitted, awaiting validation  |
| 3     | Completed         | Task successfully completed          |
| 4     | Cancelled         | Task cancelled by creator            |
| 5     | Disputed          | Task is in dispute resolution        |

## Transitions

Open -> InProgress       (claim_task: worker claims the task)
Open -> Cancelled        (cancel_task: creator cancels before any claims)
InProgress -> Completed  (complete_task / complete_task_private: worker submits proof)
InProgress -> Cancelled  (cancel_task: creator cancels, refund minus fee)
InProgress -> Disputed   (initiate_dispute: either party disputes)
Disputed -> Completed    (resolve_dispute: resolved in worker's favor)
Disputed -> Cancelled    (resolve_dispute: resolved in creator's favor / refund)

## Task Types

| Type          | Behavior                                              |
|---------------|-------------------------------------------------------|
| Exclusive     | Single worker claims and completes                    |
| Collaborative | Multiple workers contribute (up to max_workers)       |
| Competitive   | First completion wins \u2014 checks completions == 0       |

## Key Constraints

- Deadline: Tasks expire after deadline (Unix timestamp)
- Max Workers: Limits concurrent claims
- Constraint Hash: Required for private (ZK proof) completion
- Escrow: Reward locked in escrow PDA on creation
`;

// src/index.ts
async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
main();
