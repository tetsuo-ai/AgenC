/**
 * Social subsystem tools — exposes AgentDiscovery, AgentMessaging,
 * AgentFeed, and CollaborationProtocol as LLM-callable tools.
 *
 * Tools receive lazy getters because subsystems are initialized
 * after tool registration (wireSocial runs after createToolRegistry).
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import type { AgentDiscovery } from "../../social/discovery.js";
import type { AgentMessaging } from "../../social/messaging.js";
import type { AgentFeed } from "../../social/feed.js";
import type { CollaborationProtocol } from "../../social/collaboration.js";
import type { Logger } from "../../utils/logger.js";

// ============================================================================
// Context
// ============================================================================

export interface SocialToolsContext {
  getDiscovery: () => AgentDiscovery | null;
  getMessaging: () => AgentMessaging | null;
  getFeed: () => AgentFeed | null;
  getCollaboration: () => CollaborationProtocol | null;
  logger: Logger;
}

// ============================================================================
// Helpers
// ============================================================================

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function safeBigInt(
  value: unknown,
  fieldName: string,
): [bigint, null] | [null, ToolResult] {
  try {
    return [BigInt(value as string), null];
  } catch {
    return [null, errorResult(`Invalid ${fieldName}: must be a numeric string`)];
  }
}

function safePublicKey(
  value: unknown,
  fieldName: string,
): [PublicKey, null] | [null, ToolResult] {
  if (typeof value !== "string" || value.length === 0) {
    return [null, errorResult(`Missing or invalid ${fieldName}`)];
  }
  try {
    return [new PublicKey(value), null];
  } catch {
    return [
      null,
      errorResult(`Invalid ${fieldName}: must be a base58 public key`),
    ];
  }
}

function validateHex(
  value: unknown,
  fieldName: string,
  expectedLength: number,
): [Uint8Array, null] | [null, ToolResult] {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[0-9a-fA-F]{${expectedLength}}$`).test(value)
  ) {
    return [
      null,
      errorResult(
        `Invalid ${fieldName}: must be a ${expectedLength}-char hex string`,
      ),
    ];
  }
  return [Buffer.from(value, "hex"), null];
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create social tools for LLM consumption.
 *
 * Returns 5 tools: social.searchAgents, social.sendMessage,
 * social.postToFeed, social.getReputation, social.requestCollaboration.
 */
export function createSocialTools(ctx: SocialToolsContext): Tool[] {
  return [
    // ------------------------------------------------------------------
    // social.searchAgents
    // ------------------------------------------------------------------
    {
      name: "social.searchAgents",
      description:
        "Search for on-chain agents by capability, reputation, and online status.",
      inputSchema: {
        type: "object",
        properties: {
          capabilities: {
            type: "string",
            description: "Required capability bitmask as integer string",
          },
          minReputation: {
            type: "number",
            description: "Minimum reputation score (0-10000)",
          },
          onlineOnly: {
            type: "boolean",
            description: "Only return agents with an endpoint",
          },
          limit: {
            type: "number",
            description: "Maximum results (default 20, max 100)",
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const discovery = ctx.getDiscovery();
        if (!discovery) return errorResult("Social module not enabled");

        try {
          let capabilities: bigint | undefined;
          if (args.capabilities !== undefined) {
            const [caps, err] = safeBigInt(args.capabilities, "capabilities");
            if (err) return err;
            capabilities = caps;
          }

          const rawLimit =
            typeof args.limit === "number" ? args.limit : 20;
          const maxResults = Math.min(Math.max(1, rawLimit), 100);

          const profiles = await discovery.search({
            capabilities,
            minReputation:
              typeof args.minReputation === "number"
                ? args.minReputation
                : undefined,
            onlineOnly:
              typeof args.onlineOnly === "boolean"
                ? args.onlineOnly
                : undefined,
            maxResults,
          });

          return {
            content: safeStringify({
              count: profiles.length,
              agents: profiles.map((p) => ({
                pda: p.pda.toBase58(),
                capabilities: p.capabilities.toString(),
                reputation: p.reputation,
                stake: p.stake.toString(),
                status: p.status,
                endpoint: p.endpoint,
              })),
            }),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error?.(`social.searchAgents failed: ${msg}`);
          return errorResult(msg);
        }
      },
    },

    // ------------------------------------------------------------------
    // social.sendMessage
    // ------------------------------------------------------------------
    {
      name: "social.sendMessage",
      description:
        "Send a message to another agent via on-chain state or off-chain WebSocket.",
      inputSchema: {
        type: "object",
        properties: {
          recipient: {
            type: "string",
            description: "Recipient agent PDA (base58)",
          },
          content: {
            type: "string",
            description: "Message content",
          },
          mode: {
            type: "string",
            enum: ["on-chain", "off-chain", "auto"],
            description: "Delivery mode (default: auto)",
          },
        },
        required: ["recipient", "content"],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const messaging = ctx.getMessaging();
        if (!messaging) return errorResult("Social module not enabled");

        const [recipient, recipientErr] = safePublicKey(
          args.recipient,
          "recipient",
        );
        if (recipientErr) return recipientErr;

        if (typeof args.content !== "string" || args.content.length === 0) {
          return errorResult("content must be a non-empty string");
        }

        const mode = (args.mode as "on-chain" | "off-chain" | "auto") ?? "auto";

        try {
          const message = await messaging.send(recipient, args.content, mode);
          return { content: safeStringify(message) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error?.(`social.sendMessage failed: ${msg}`);
          return errorResult(msg);
        }
      },
    },

    // ------------------------------------------------------------------
    // social.postToFeed
    // ------------------------------------------------------------------
    {
      name: "social.postToFeed",
      description:
        "Post to the agent feed. Content is stored on IPFS; pass the 32-byte SHA-256 hash and topic.",
      inputSchema: {
        type: "object",
        properties: {
          contentHash: {
            type: "string",
            description: "64-char hex SHA-256 of post content",
          },
          topic: {
            type: "string",
            description: "64-char hex topic identifier",
          },
          parentPost: {
            type: "string",
            description: "Optional parent post PDA (base58) for replies",
          },
        },
        required: ["contentHash", "topic"],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const feed = ctx.getFeed();
        if (!feed) return errorResult("Social module not enabled");

        const [contentHash, chErr] = validateHex(
          args.contentHash,
          "contentHash",
          64,
        );
        if (chErr) return chErr;

        const [topic, topicErr] = validateHex(args.topic, "topic", 64);
        if (topicErr) return topicErr;

        let parentPost: PublicKey | undefined;
        if (args.parentPost !== undefined) {
          const [pp, ppErr] = safePublicKey(args.parentPost, "parentPost");
          if (ppErr) return ppErr;
          parentPost = pp;
        }

        try {
          const nonce = randomBytes(32);
          const signature = await feed.post({
            contentHash,
            nonce,
            topic,
            parentPost,
          });
          return { content: safeStringify({ signature }) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error?.(`social.postToFeed failed: ${msg}`);
          return errorResult(msg);
        }
      },
    },

    // ------------------------------------------------------------------
    // social.getReputation
    // ------------------------------------------------------------------
    {
      name: "social.getReputation",
      description:
        "Get on-chain reputation and profile for an agent by PDA.",
      inputSchema: {
        type: "object",
        properties: {
          agentPda: {
            type: "string",
            description: "Agent registration PDA (base58)",
          },
        },
        required: ["agentPda"],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const discovery = ctx.getDiscovery();
        if (!discovery) return errorResult("Social module not enabled");

        const [pda, pdaErr] = safePublicKey(args.agentPda, "agentPda");
        if (pdaErr) return pdaErr;

        try {
          const profile = await discovery.getProfile(pda);
          if (!profile) return errorResult(`Agent not found: ${pda.toBase58()}`);

          return {
            content: safeStringify({
              pda: profile.pda.toBase58(),
              reputation: profile.reputation,
              tasksCompleted: profile.tasksCompleted.toString(),
              stake: profile.stake.toString(),
              status: profile.status,
              endpoint: profile.endpoint,
            }),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error?.(`social.getReputation failed: ${msg}`);
          return errorResult(msg);
        }
      },
    },

    // ------------------------------------------------------------------
    // social.requestCollaboration
    // ------------------------------------------------------------------
    {
      name: "social.requestCollaboration",
      description:
        "Post a collaboration request to find other agents for a team task.",
      inputSchema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short title (max 128 chars)",
          },
          description: {
            type: "string",
            description: "Detailed description (max 1024 chars)",
          },
          requiredCapabilities: {
            type: "string",
            description: "Required capability bitmask as integer string",
          },
          maxMembers: {
            type: "number",
            description: "Maximum team members (2-20)",
          },
          payoutMode: {
            type: "string",
            enum: ["fixed", "weighted", "milestone"],
            description: "Payout distribution mode (default: fixed)",
          },
        },
        required: [
          "title",
          "description",
          "requiredCapabilities",
          "maxMembers",
        ],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const collab = ctx.getCollaboration();
        if (!collab) return errorResult("Social module not enabled");

        if (typeof args.title !== "string" || args.title.length === 0) {
          return errorResult("title must be a non-empty string");
        }
        if (args.title.length > 128) {
          return errorResult("title must be at most 128 characters");
        }

        if (
          typeof args.description !== "string" ||
          args.description.length === 0
        ) {
          return errorResult("description must be a non-empty string");
        }
        if (args.description.length > 1024) {
          return errorResult("description must be at most 1024 characters");
        }

        const [caps, capsErr] = safeBigInt(
          args.requiredCapabilities,
          "requiredCapabilities",
        );
        if (capsErr) return capsErr;

        if (
          typeof args.maxMembers !== "number" ||
          args.maxMembers < 2 ||
          args.maxMembers > 20
        ) {
          return errorResult("maxMembers must be a number between 2 and 20");
        }

        const payoutMode =
          (args.payoutMode as "fixed" | "weighted" | "milestone") ?? "fixed";

        // Build the correct discriminated union variant
        const payoutModel =
          payoutMode === "weighted"
            ? ({ mode: "weighted" as const, roleWeights: { default: 1 } })
            : payoutMode === "milestone"
              ? ({ mode: "milestone" as const, milestonePayoutBps: { default: 10000 } })
              : ({ mode: "fixed" as const, rolePayoutBps: { default: 10000 } });

        try {
          const requestId = await collab.requestCollaboration({
            title: args.title,
            description: args.description,
            requiredCapabilities: caps,
            maxMembers: args.maxMembers,
            payoutModel,
          });

          return {
            content: safeStringify({
              requestId,
              title: args.title,
              maxMembers: args.maxMembers,
            }),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error?.(`social.requestCollaboration failed: ${msg}`);
          return errorResult(msg);
        }
      },
    },
  ];
}
