import { PublicKey } from "@solana/web3.js";
import { SEEDS } from "@agenc/sdk";
import {
  getAnchorErrorName,
  getAnchorErrorMessage,
  findProtocolPda,
  deriveAgentPda,
  deriveProtocolPda,
  deriveAuthorityVotePda,
} from "@agenc/runtime";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getConnection,
  getReadOnlyProgram,
  getCurrentProgramId,
} from "../utils/connection.js";
import { formatSol, safePubkey } from "../utils/formatting.js";
import { toolErrorResponse } from "./response.js";

function formatProtocolConfig(
  config: Record<string, unknown>,
  pda: PublicKey,
): string {
  const lines = [
    "Protocol Config PDA: " + pda.toBase58(),
    "",
    "--- Authority ---",
    "Authority: " + safePubkey(config.authority),
    "Treasury: " + safePubkey(config.treasury),
    "",
    "--- Fees & Thresholds ---",
    "Protocol Fee: " +
      config.protocolFeeBps +
      " bps (" +
      (Number(config.protocolFeeBps) / 100).toFixed(2) +
      "%)",
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
    "Max Tasks / 24h: " +
      (Number(config.maxTasksPer24h) === 0
        ? "Unlimited"
        : String(config.maxTasksPer24h)),
    "Dispute Initiation Cooldown: " + config.disputeInitiationCooldown + "s",
    "Max Disputes / 24h: " +
      (Number(config.maxDisputesPer24h) === 0
        ? "Unlimited"
        : String(config.maxDisputesPer24h)),
    "",
    "--- Stats ---",
    "Total Agents: " + config.totalAgents,
    "Total Tasks: " + config.totalTasks,
    "Completed Tasks: " + config.completedTasks,
    "Total Value Distributed: " +
      formatSol(Number(config.totalValueDistributed ?? 0)),
    "",
    "--- Version ---",
    "Protocol Version: " + config.protocolVersion,
    "Min Supported Version: " + config.minSupportedVersion,
    "",
    "--- Multisig ---",
    "Threshold: " + config.multisigThreshold,
    "Owners: " + config.multisigOwnersLen,
  ];

  return lines.join("\n");
}

export function registerProtocolTools(server: McpServer): void {
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
          content: [
            {
              type: "text" as const,
              text: formatProtocolConfig(
                config as unknown as Record<string, unknown>,
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
    "agenc_derive_pda",
    "Derive any AgenC PDA (agent, task, escrow, claim, dispute, vote, protocol)",
    {
      pda_type: z
        .enum([
          "protocol",
          "agent",
          "task",
          "escrow",
          "claim",
          "dispute",
          "vote",
          "authority_vote",
        ])
        .describe("Type of PDA to derive"),
      agent_id: z
        .string()
        .optional()
        .describe("Agent ID (hex) — for agent PDAs"),
      creator: z
        .string()
        .optional()
        .describe("Creator pubkey (base58) — for task PDAs"),
      task_id: z.string().optional().describe("Task ID (hex) — for task PDAs"),
      task_pda: z
        .string()
        .optional()
        .describe("Task PDA (base58) — for escrow/claim PDAs"),
      worker_pda: z
        .string()
        .optional()
        .describe("Worker agent PDA (base58) — for claim PDAs"),
      dispute_id: z
        .string()
        .optional()
        .describe("Dispute ID (hex) — for dispute PDAs"),
      dispute_pda: z
        .string()
        .optional()
        .describe("Dispute PDA (base58) — for vote PDAs"),
      voter: z
        .string()
        .optional()
        .describe("Voter pubkey (base58) — for vote PDAs"),
    },
    async ({
      pda_type,
      agent_id,
      creator,
      task_id,
      task_pda,
      worker_pda,
      dispute_id,
      dispute_pda,
      voter,
    }) => {
      try {
        const programId = getCurrentProgramId();
        let address: PublicKey;
        let bump: number | undefined;
        let seedsDesc: string;

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
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Error: agent_id required for agent PDA",
                  },
                ],
              };
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
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Error: creator and task_id required for task PDA",
                  },
                ],
              };
            }
            const creatorPk = new PublicKey(creator);
            const taskIdBuf = Buffer.from(task_id, "hex");
            const [taskPda, taskBump] = PublicKey.findProgramAddressSync(
              [SEEDS.TASK, creatorPk.toBuffer(), taskIdBuf],
              programId,
            );
            address = taskPda;
            bump = taskBump;
            seedsDesc = '["task", creator, task_id]';
            break;
          }
          case "escrow": {
            if (!task_pda) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Error: task_pda required for escrow PDA",
                  },
                ],
              };
            }
            const taskPk = new PublicKey(task_pda);
            const [escrowPda, escrowBump] = PublicKey.findProgramAddressSync(
              [SEEDS.ESCROW, taskPk.toBuffer()],
              programId,
            );
            address = escrowPda;
            bump = escrowBump;
            seedsDesc = '["escrow", task_pda]';
            break;
          }
          case "claim": {
            if (!task_pda || !worker_pda) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Error: task_pda and worker_pda required for claim PDA",
                  },
                ],
              };
            }
            const tPk = new PublicKey(task_pda);
            const wPk = new PublicKey(worker_pda);
            const [claimPda, claimBump] = PublicKey.findProgramAddressSync(
              [SEEDS.CLAIM, tPk.toBuffer(), wPk.toBuffer()],
              programId,
            );
            address = claimPda;
            bump = claimBump;
            seedsDesc = '["claim", task_pda, worker_pda]';
            break;
          }
          case "dispute": {
            if (!dispute_id) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Error: dispute_id required for dispute PDA",
                  },
                ],
              };
            }
            const disputeIdBuf = Buffer.from(dispute_id, "hex");
            const [dPda, dBump] = PublicKey.findProgramAddressSync(
              [SEEDS.DISPUTE, disputeIdBuf],
              programId,
            );
            address = dPda;
            bump = dBump;
            seedsDesc = '["dispute", dispute_id]';
            break;
          }
          case "vote": {
            if (!dispute_pda || !voter) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Error: dispute_pda and voter required for vote PDA",
                  },
                ],
              };
            }
            const dpk = new PublicKey(dispute_pda);
            const vpk = new PublicKey(voter);
            const [votePda, voteBump] = PublicKey.findProgramAddressSync(
              [SEEDS.VOTE, dpk.toBuffer(), vpk.toBuffer()],
              programId,
            );
            address = votePda;
            bump = voteBump;
            seedsDesc = '["vote", dispute_pda, voter]';
            break;
          }
          case "authority_vote": {
            if (!dispute_pda || !voter) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Error: dispute_pda and voter required for authority_vote PDA",
                  },
                ],
              };
            }
            const result = deriveAuthorityVotePda(
              new PublicKey(dispute_pda),
              new PublicKey(voter),
              programId,
            );
            address = result.address;
            bump = result.bump;
            seedsDesc = '["authority_vote", dispute_pda, voter]';
            break;
          }
          default:
            return {
              content: [
                { type: "text" as const, text: "Error: unknown PDA type" },
              ],
            };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: [
                "PDA Type: " + pda_type,
                "Address: " + address.toBase58(),
                "Bump: " + (bump !== undefined ? bump : "N/A"),
                "Seeds: " + seedsDesc,
                "Program: " + programId.toBase58(),
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return toolErrorResponse(error);
      }
    },
  );

  server.tool(
    "agenc_decode_error",
    "Decode an Anchor error code (6000-6077) to name and description",
    {
      error_code: z.number().int().describe("Anchor error code (e.g. 6000)"),
    },
    async ({ error_code }) => {
      try {
        const name = getAnchorErrorName(error_code);
        const message = name
          ? getAnchorErrorMessage(
              error_code as Parameters<typeof getAnchorErrorMessage>[0],
            )
          : undefined;

        if (!name) {
          // Check if it's a standard Anchor framework error
          if (error_code >= 100 && error_code < 6000) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    "Error code " +
                    error_code +
                    " is an Anchor framework error, not an AgenC program error.\nAgenC error codes range from 6000-6175.",
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "Unknown error code: " +
                  error_code +
                  "\nValid range: 6000-6175",
              },
            ],
          };
        }

        // Determine category
        let category: string;
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
          content: [
            {
              type: "text" as const,
              text: [
                "Error Code: " +
                  error_code +
                  " (0x" +
                  error_code.toString(16) +
                  ")",
                "Name: " + name,
                "Category: " + category,
                "Description: " + (message || "No description available"),
              ].join("\n"),
            },
          ],
        };
      } catch (error) {
        return toolErrorResponse(error);
      }
    },
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
          "Program Exists: " + (accountInfo !== null ? "Yes" : "No"),
        ];

        if (accountInfo) {
          lines.push(
            "Executable: " + accountInfo.executable,
            "Owner: " + accountInfo.owner.toBase58(),
            "Data Length: " + accountInfo.data.length + " bytes",
          );
        }

        lines.push(
          "",
          "Protocol Config PDA: " + protocolPda.toBase58(),
          "Protocol Initialized: " + (protocolInfo !== null ? "Yes" : "No"),
        );

        if (protocolInfo) {
          lines.push(
            "Protocol Data Length: " + protocolInfo.data.length + " bytes",
          );
        }

        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        return toolErrorResponse(error);
      }
    },
  );
}
