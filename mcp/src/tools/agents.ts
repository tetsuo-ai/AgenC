import { PublicKey } from "@solana/web3.js";
import {
  AgentCapabilities,
  getCapabilityNames,
  createCapabilityMask,
  agentIdToString,
  agentIdToShortString,
  generateAgentId,
  hexToBytes,
  keypairToWallet,
  findAgentPda,
  AgentManager,
  type CapabilityName,
} from "@agenc/runtime";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getConnection,
  getReadOnlyProgram,
  getSigningProgram,
  getCurrentProgramId,
} from "../utils/connection.js";
import {
  formatSol,
  formatTimestamp,
  formatStatus,
  safePubkey,
  safeBigInt,
} from "../utils/formatting.js";
import { toolErrorResponse } from "./response.js";

function formatAgentState(
  account: Record<string, unknown>,
  pda: PublicKey,
): string {
  const agentId = account.agentId as Uint8Array | number[];
  const idBytes =
    agentId instanceof Uint8Array ? agentId : new Uint8Array(agentId);

  const caps = safeBigInt(account.capabilities);
  const capNames = getCapabilityNames(caps);

  const lines = [
    "Agent ID: " + agentIdToShortString(idBytes),
    "Full ID: " + agentIdToString(idBytes),
    "PDA: " + pda.toBase58(),
    "Authority: " + safePubkey(account.authority),
    "Status: " +
      formatStatus(account.status as number | Record<string, unknown>),
    "Capabilities: " +
      (capNames.length > 0 ? capNames.join(", ") : "None") +
      " (bitmask: " +
      caps +
      ")",
    "Endpoint: " + ((account.endpoint as string) || "Not set"),
    "Metadata URI: " + ((account.metadataUri as string) || "Not set"),
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
    "Last Task Created: " +
      formatTimestamp(Number(account.lastTaskCreated ?? 0)),
    "Last Dispute: " +
      formatTimestamp(Number(account.lastDisputeInitiated ?? 0)),
  ];

  return lines.join("\n");
}

export function registerAgentTools(server: McpServer): void {
  server.tool(
    "agenc_register_agent",
    "Register a new agent with capabilities, endpoint, and stake",
    {
      capabilities: z
        .array(z.string())
        .describe(
          "Capability names: COMPUTE, INFERENCE, STORAGE, NETWORK, SENSOR, ACTUATOR, COORDINATOR, ARBITER, VALIDATOR, AGGREGATOR",
        ),
      endpoint: z.string().describe("Agent network endpoint URL"),
      stake_amount: z.number().nonnegative().describe("Stake amount in SOL"),
      metadata_uri: z.string().optional().describe("Extended metadata URI"),
    },
    async ({ capabilities, endpoint, stake_amount, metadata_uri }) => {
      try {
        const { keypair } = await getSigningProgram();
        const wallet = keypairToWallet(keypair);
        const manager = new AgentManager({
          connection: getConnection(),
          wallet,
          programId: getCurrentProgramId(),
        });

        const agentId = generateAgentId();
        const capMask = createCapabilityMask(capabilities as CapabilityName[]);
        const stakeAmount = BigInt(Math.floor(stake_amount * 1e9));

        await manager.register({
          agentId,
          capabilities: capMask,
          endpoint,
          metadataUri: metadata_uri,
          stakeAmount,
        });

        const resultLines = [
          "Agent registered successfully!",
          "Agent ID: " + agentIdToString(agentId),
          "PDA: " + (manager.getAgentPda()?.toBase58() ?? "unknown"),
          "Authority: " + keypair.publicKey.toBase58(),
          "Capabilities: " + capabilities.join(", "),
          "Stake: " + stake_amount + " SOL",
        ];

        return {
          content: [{ type: "text" as const, text: resultLines.join("\n") }],
        };
      } catch (error) {
        return toolErrorResponse(error);
      }
    },
  );

  server.tool(
    "agenc_deregister_agent",
    "Deregister an agent (requires no active tasks, no pending votes, 24h since last vote)",
    {
      agent_id: z.string().describe("Agent ID (64-char hex string)"),
    },
    async ({ agent_id }) => {
      try {
        const { keypair } = await getSigningProgram();
        const wallet = keypairToWallet(keypair);
        const manager = new AgentManager({
          connection: getConnection(),
          wallet,
          programId: getCurrentProgramId(),
        });

        const idBytes = hexToBytes(agent_id);
        await manager.load(idBytes);
        const sig = await manager.deregister();

        return {
          content: [
            {
              type: "text" as const,
              text:
                "Agent deregistered successfully.\nAgent ID: " +
                agent_id +
                "\nSignature: " +
                sig,
            },
          ],
        };
      } catch (error) {
        return toolErrorResponse(error);
      }
    },
  );

  server.tool(
    "agenc_get_agent",
    "Get agent state by ID (decodes capabilities, status, reputation)",
    {
      agent_id: z
        .string()
        .describe("Agent ID (64-char hex) or agent PDA (base58)"),
    },
    async ({ agent_id }) => {
      try {
        const program = getReadOnlyProgram();
        let pda: PublicKey;

        if (agent_id.length === 64 && /^[0-9a-fA-F]+$/.test(agent_id)) {
          const idBytes = hexToBytes(agent_id);
          pda = findAgentPda(idBytes, getCurrentProgramId());
        } else {
          pda = new PublicKey(agent_id);
        }

        const account = await program.account.agentRegistration.fetch(pda);
        return {
          content: [
            {
              type: "text" as const,
              text: formatAgentState(
                account as unknown as Record<string, unknown>,
                pda,
              ),
            },
          ],
        };
      } catch (error) {
        return toolErrorResponse(error);
      }
    },
  );

  server.tool(
    "agenc_list_agents",
    "List registered agents (fetches all agentRegistration accounts)",
    {
      status_filter: z
        .enum(["inactive", "active", "busy", "suspended"])
        .optional()
        .describe("Filter by agent status"),
    },
    async ({ status_filter }) => {
      try {
        const program = getReadOnlyProgram();
        const accounts = await program.account.agentRegistration.all();

        let filtered = accounts;
        if (status_filter) {
          filtered = accounts.filter((a) => {
            const status = a.account.status as Record<string, unknown>;
            if (typeof status === "object" && status !== null) {
              return Object.keys(status).some((k) => k === status_filter);
            }
            return false;
          });
        }

        if (filtered.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: status_filter
                  ? "No agents found with status: " + status_filter
                  : "No agents found",
              },
            ],
          };
        }

        const lines = filtered.map((a, i) => {
          const acc = a.account as unknown as Record<string, unknown>;
          const agentId = acc.agentId as Uint8Array | number[];
          const idBytes =
            agentId instanceof Uint8Array ? agentId : new Uint8Array(agentId);
          const caps = safeBigInt(acc.capabilities);
          return [
            "[" + (i + 1) + "] " + agentIdToShortString(idBytes),
            "    PDA: " + a.publicKey.toBase58(),
            "    Status: " +
              formatStatus(acc.status as number | Record<string, unknown>),
            "    Capabilities: " +
              (getCapabilityNames(caps).join(", ") || "None"),
            "    Tasks: " +
              acc.tasksCompleted +
              " completed, " +
              acc.activeTasks +
              " active",
          ].join("\n");
        });

        return {
          content: [
            {
              type: "text" as const,
              text:
                "Found " +
                filtered.length +
                " agent(s):\n\n" +
                lines.join("\n\n"),
            },
          ],
        };
      } catch (error) {
        return toolErrorResponse(error);
      }
    },
  );

  server.tool(
    "agenc_update_agent",
    "Update agent capabilities, status, or endpoint",
    {
      agent_id: z.string().describe("Agent ID (64-char hex string)"),
      capabilities: z
        .array(z.string())
        .optional()
        .describe("New capability names"),
      status: z
        .enum(["inactive", "active", "busy"])
        .optional()
        .describe("New agent status"),
      endpoint: z.string().optional().describe("New endpoint URL"),
      metadata_uri: z.string().optional().describe("New metadata URI"),
    },
    async ({ agent_id, capabilities, status, endpoint, metadata_uri }) => {
      try {
        const { keypair } = await getSigningProgram();
        const wallet = keypairToWallet(keypair);
        const manager = new AgentManager({
          connection: getConnection(),
          wallet,
          programId: getCurrentProgramId(),
        });

        const idBytes = hexToBytes(agent_id);
        await manager.load(idBytes);

        const updates: string[] = [];

        if (capabilities) {
          const capMask = createCapabilityMask(
            capabilities as CapabilityName[],
          );
          await manager.updateCapabilities(capMask);
          updates.push("Capabilities: " + capabilities.join(", "));
        }

        if (status) {
          const statusMap: Record<string, number> = {
            inactive: 0,
            active: 1,
            busy: 2,
          };
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
          content: [
            {
              type: "text" as const,
              text:
                updates.length > 0
                  ? "Agent updated:\n" + updates.join("\n")
                  : "No updates specified",
            },
          ],
        };
      } catch (error) {
        return toolErrorResponse(error);
      }
    },
  );

  server.tool(
    "agenc_decode_capabilities",
    "Decode a capability bitmask to human-readable names",
    {
      bitmask: z
        .string()
        .describe(
          'Capability bitmask as decimal or hex string (e.g. "3" or "0x03")',
        ),
    },
    async ({ bitmask }) => {
      try {
        const value = BigInt(bitmask);
        const names = getCapabilityNames(value);

        const allCaps = Object.entries(AgentCapabilities)
          .filter(([, v]) => typeof v === "bigint")
          .map(([name, val]) => {
            const has = (value & (val as bigint)) !== 0n;
            return "  " + (has ? "[x]" : "[ ]") + " " + name + " (" + val + ")";
          });

        return {
          content: [
            {
              type: "text" as const,
              text: [
                "Bitmask: " + value + " (0x" + value.toString(16) + ")",
                "Active: " + (names.length > 0 ? names.join(", ") : "None"),
                "",
                "All capabilities:",
                ...allCaps,
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return toolErrorResponse(error);
      }
    },
  );
}
