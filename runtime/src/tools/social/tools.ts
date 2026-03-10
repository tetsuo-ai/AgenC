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
import type { SocialPeerDirectoryEntry } from "../../social/types.js";
import type { Logger } from "../../utils/logger.js";
import {
  parseBigIntArg,
  toolErrorResult,
} from "../shared/helpers.js";

// ============================================================================
// Context
// ============================================================================

export interface SocialToolsContext {
  getDiscovery: () => AgentDiscovery | null;
  getMessaging: () => AgentMessaging | null;
  getFeed: () => AgentFeed | null;
  getCollaboration: () => CollaborationProtocol | null;
  getPeerDirectory?: () => readonly SocialPeerDirectoryEntry[] | null;
  logger: Logger;
}

// ============================================================================
// Helpers
// ============================================================================

function safePublicKey(
  value: unknown,
  fieldName: string,
): [PublicKey, null] | [null, ToolResult] {
  if (typeof value !== "string" || value.length === 0) {
    return [null, toolErrorResult(`Missing or invalid ${fieldName}`)];
  }
  try {
    return [new PublicKey(value), null];
  } catch {
    return [
      null,
      toolErrorResult(`Invalid ${fieldName}: must be a base58 public key`),
    ];
  }
}

function safeOptionalNonEmptyString(
  value: unknown,
  fieldName: string,
): [string | undefined, null] | [null, ToolResult] {
  if (value === undefined) {
    return [undefined, null];
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return [null, toolErrorResult(`Missing or invalid ${fieldName}`)];
  }
  return [value.trim(), null];
}

type PeerResolutionSource =
  | "base58"
  | "directory_agent_pda"
  | "directory_authority"
  | "peer_directory_alias";

type ResolvedPeerReference = {
  pubkey: PublicKey;
  source: PeerResolutionSource;
  requested: string;
  entry: SocialPeerDirectoryEntry | null;
};

function normalizePeerAlias(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9]/g, "");
}

function expandPeerAliases(entry: SocialPeerDirectoryEntry): string[] {
  const aliases = new Set<string>();
  const add = (value: string | undefined): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length === 0) return;
    aliases.add(trimmed);
  };

  add(entry.label);
  add(entry.authority);
  add(entry.agentPda);
  for (const alias of entry.aliases ?? []) {
    add(alias);
  }
  if (Number.isInteger(entry.index) && typeof entry.index === "number") {
    add(String(entry.index));
    add(`agent${entry.index}`);
    add(`agent-${entry.index}`);
    add(`agent_${entry.index}`);
    add(`agent ${entry.index}`);
    add(`peer${entry.index}`);
    add(`peer-${entry.index}`);
    add(`peer_${entry.index}`);
    add(`peer ${entry.index}`);
  }

  return Array.from(aliases);
}

function getPeerDirectory(
  ctx: SocialToolsContext,
): readonly SocialPeerDirectoryEntry[] {
  return ctx.getPeerDirectory?.() ?? [];
}

function buildPeerDirectoryLookup(
  entries: readonly SocialPeerDirectoryEntry[],
): {
  byAlias: Map<string, SocialPeerDirectoryEntry | null>;
  byAddress: Map<string, SocialPeerDirectoryEntry>;
} {
  const byAlias = new Map<string, SocialPeerDirectoryEntry | null>();
  const byAddress = new Map<string, SocialPeerDirectoryEntry>();

  for (const entry of entries) {
    byAddress.set(entry.authority, entry);
    byAddress.set(entry.agentPda, entry);

    for (const alias of expandPeerAliases(entry)) {
      const normalized = normalizePeerAlias(alias);
      if (normalized.length === 0) continue;
      const existing = byAlias.get(normalized);
      if (existing && existing !== entry) {
        byAlias.set(normalized, null);
        continue;
      }
      if (!byAlias.has(normalized)) {
        byAlias.set(normalized, entry);
      }
    }
  }

  return { byAlias, byAddress };
}

function listKnownPeerLabels(
  entries: readonly SocialPeerDirectoryEntry[],
): string {
  return entries
    .map((entry) => entry.label.trim())
    .filter((label, index, labels) => label.length > 0 && labels.indexOf(label) === index)
    .slice(0, 8)
    .join(", ");
}

function invalidPeerReferenceResult(
  fieldName: string,
  entries: readonly SocialPeerDirectoryEntry[],
): ToolResult {
  const knownLabels = listKnownPeerLabels(entries);
  const suffix =
    knownLabels.length > 0
      ? ` or a configured peer alias (${knownLabels})`
      : "";
  return toolErrorResult(
    `Invalid ${fieldName}: must be a base58 public key${suffix}`,
  );
}

function ambiguousPeerReferenceResult(
  fieldName: string,
  value: string,
): ToolResult {
  return toolErrorResult(
    `Ambiguous ${fieldName}: "${value}" matched multiple configured peers`,
  );
}

function resolvePeerReference(
  value: unknown,
  fieldName: string,
  ctx: SocialToolsContext,
): [ResolvedPeerReference, null] | [null, ToolResult] {
  if (typeof value !== "string" || value.trim().length === 0) {
    return [null, toolErrorResult(`Missing or invalid ${fieldName}`)];
  }

  const requested = value.trim();
  const entries = getPeerDirectory(ctx);
  const lookup = buildPeerDirectoryLookup(entries);

  try {
    const pubkey = new PublicKey(requested);
    const base58 = pubkey.toBase58();
    const entry = lookup.byAddress.get(base58) ?? null;
    const source: PeerResolutionSource =
      entry === null
        ? "base58"
        : entry.agentPda === base58
          ? "directory_agent_pda"
          : "directory_authority";
    return [{ pubkey, source, requested, entry }, null];
  } catch {
    const normalized = normalizePeerAlias(requested);
    if (normalized.length === 0) {
      return [null, invalidPeerReferenceResult(fieldName, entries)];
    }
    if (lookup.byAlias.has(normalized)) {
      const entry = lookup.byAlias.get(normalized);
      if (entry === null) {
        return [null, ambiguousPeerReferenceResult(fieldName, requested)];
      }
      if (entry) {
        return [
          {
            pubkey: new PublicKey(entry.agentPda),
            source: "peer_directory_alias",
            requested,
            entry,
          },
          null,
        ];
      }
    }
    return [null, invalidPeerReferenceResult(fieldName, entries)];
  }
}

function findPeerDirectoryEntry(
  ctx: SocialToolsContext,
  value: PublicKey,
): SocialPeerDirectoryEntry | null {
  const lookup = buildPeerDirectoryLookup(getPeerDirectory(ctx));
  return lookup.byAddress.get(value.toBase58()) ?? null;
}

function serializeSocialMessageResult(
  ctx: SocialToolsContext,
  message: {
    id: string;
    sender: PublicKey;
    recipient: PublicKey;
    content: string;
    mode: string;
    timestamp: number;
    nonce: number;
    onChain: boolean;
    threadId?: string | null;
  },
  resolution?: ResolvedPeerReference,
): Record<string, unknown> {
  const senderEntry = findPeerDirectoryEntry(ctx, message.sender);
  const recipientEntry = findPeerDirectoryEntry(ctx, message.recipient);

  return {
    id: message.id,
    sender: message.sender.toBase58(),
    senderLabel: senderEntry?.label ?? null,
    recipient: message.recipient.toBase58(),
    recipientLabel: recipientEntry?.label ?? null,
    content: message.content,
    mode: message.mode,
    timestamp: message.timestamp,
    nonce: message.nonce,
    onChain: message.onChain,
    threadId: message.threadId ?? null,
    requestedRecipient: resolution?.requested ?? null,
    recipientResolutionSource: resolution?.source ?? null,
  };
}

function validateHex(
  value: unknown,
  fieldName: string,
  expectedLength: number,
): [Uint8Array, null] | [null, ToolResult] {
  if (typeof value !== "string" || value.length !== expectedLength) {
    return [
      null,
      toolErrorResult(
        `Invalid ${fieldName}: must be a ${expectedLength}-char hex string`,
      ),
    ];
  }

  for (const char of value) {
    const code = char.charCodeAt(0);
    const isNumber = code >= 48 && code <= 57;
    const isLowerHex = code >= 97 && code <= 102;
    const isUpperHex = code >= 65 && code <= 70;
    if (!isNumber && !isLowerHex && !isUpperHex) {
      return [
        null,
        toolErrorResult(
          `Invalid ${fieldName}: must be a ${expectedLength}-char hex string`,
        ),
      ];
    }
  }

  return [Buffer.from(value, "hex"), null];
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create social tools for LLM consumption.
 *
 * Returns 6 tools: social.searchAgents, social.sendMessage,
 * social.getRecentMessages, social.postToFeed, social.getReputation,
 * social.requestCollaboration.
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
        if (!discovery) return toolErrorResult("Social module not enabled");

        try {
          let capabilities: bigint | undefined;
          if (args.capabilities !== undefined) {
            const [caps, err] = parseBigIntArg(args.capabilities, "capabilities");
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
                authority: p.authority.toBase58(),
                label:
                  findPeerDirectoryEntry(ctx, p.pda)?.label ??
                  findPeerDirectoryEntry(ctx, p.authority)?.label ??
                  null,
                aliases:
                  findPeerDirectoryEntry(ctx, p.pda)?.aliases ??
                  findPeerDirectoryEntry(ctx, p.authority)?.aliases ??
                  [],
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
          return toolErrorResult(msg);
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
            description:
              "Recipient agent PDA/authority (base58) or configured peer alias",
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
          threadId: {
            type: "string",
            description:
              "Optional stable thread/conversation identifier for correlation and retrieval",
          },
        },
        required: ["recipient", "content"],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const messaging = ctx.getMessaging();
        if (!messaging) return toolErrorResult("Social module not enabled");

        const [recipientResolution, recipientErr] = resolvePeerReference(
          args.recipient,
          "recipient",
          ctx,
        );
        if (recipientErr) return recipientErr;

        if (typeof args.content !== "string" || args.content.length === 0) {
          return toolErrorResult("content must be a non-empty string");
        }

        const mode = (args.mode as "on-chain" | "off-chain" | "auto") ?? "auto";
        const [threadId, threadIdErr] = safeOptionalNonEmptyString(
          args.threadId,
          "threadId",
        );
        if (threadIdErr) return threadIdErr;

        try {
          ctx.logger.info?.("social.sendMessage recipient resolved", {
            requestedRecipient: recipientResolution.requested,
            resolvedRecipient: recipientResolution.pubkey.toBase58(),
            recipientLabel: recipientResolution.entry?.label ?? null,
            recipientAuthority: recipientResolution.entry?.authority ?? null,
            recipientAgentPda: recipientResolution.entry?.agentPda ?? null,
            resolutionSource: recipientResolution.source,
            mode,
            threadId: threadId ?? null,
          });

          const message = await messaging.send(
            recipientResolution.pubkey,
            args.content,
            mode,
            { threadId },
          );
          return {
            content: safeStringify(
              serializeSocialMessageResult(ctx, message, recipientResolution),
            ),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error?.(`social.sendMessage failed: ${msg}`);
          return toolErrorResult(msg);
        }
      },
    },

    // ------------------------------------------------------------------
    // social.getRecentMessages
    // ------------------------------------------------------------------
    {
      name: "social.getRecentMessages",
      description:
        "Read recent inbound/outbound social messages observed by this daemon.",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum messages to return (default 10, max 50)",
          },
          direction: {
            type: "string",
            enum: ["incoming", "outgoing", "all"],
            description: "Filter to incoming, outgoing, or all messages",
          },
          peer: {
            type: "string",
            description:
              "Optional peer authority/agent PDA (base58) or configured peer alias",
          },
          mode: {
            type: "string",
            enum: ["on-chain", "off-chain", "all"],
            description: "Optional delivery-mode filter",
          },
          threadId: {
            type: "string",
            description:
              "Optional stable thread/conversation identifier for correlation and retrieval",
          },
        },
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const messaging = ctx.getMessaging();
        if (!messaging) return toolErrorResult("Social module not enabled");

        const rawLimit =
          typeof args.limit === "number" ? args.limit : 10;
        const limit = Math.min(Math.max(1, rawLimit), 50);

        const direction =
          args.direction === "incoming" ||
          args.direction === "outgoing" ||
          args.direction === "all"
            ? args.direction
            : "all";

        const mode =
          args.mode === "on-chain" ||
          args.mode === "off-chain" ||
          args.mode === "all"
            ? args.mode
            : "all";
        const [threadId, threadIdErr] = safeOptionalNonEmptyString(
          args.threadId,
          "threadId",
        );
        if (threadIdErr) return threadIdErr;

        let peerResolution: ResolvedPeerReference | undefined;
        if (args.peer !== undefined) {
          const [parsedPeer, peerErr] = resolvePeerReference(args.peer, "peer", ctx);
          if (peerErr) return peerErr;
          peerResolution = parsedPeer;
        }

        try {
          const self = messaging.getLocalAuthority();
          const localAgentPda = messaging.getLocalAgentPda();
          const messages = messaging.getRecentMessages({
            limit,
            direction,
            mode,
            threadId,
          });
          let filteredMessages = messages;
          if (peerResolution) {
            if (peerResolution.entry) {
              const peerEntry = peerResolution.entry;
              filteredMessages = messages.filter((message) => {
                const sender = message.sender.toBase58();
                const recipient = message.recipient.toBase58();
                return (
                  sender === peerEntry.authority ||
                  sender === peerEntry.agentPda ||
                  recipient === peerEntry.authority ||
                  recipient === peerEntry.agentPda
                );
              });
            } else {
              filteredMessages = messages.filter(
                (message) =>
                  message.sender.equals(peerResolution.pubkey) ||
                  message.recipient.equals(peerResolution.pubkey),
              );
            }
          }
          return {
            content: safeStringify({
              count: filteredMessages.length,
              peer:
                peerResolution === undefined
                  ? null
                  : {
                      requested: peerResolution.requested,
                      resolved: peerResolution.pubkey.toBase58(),
                      label: peerResolution.entry?.label ?? null,
                      source: peerResolution.source,
                    },
              messages: filteredMessages.map((message) => ({
                id: message.id,
                sender: message.sender.toBase58(),
                senderLabel: findPeerDirectoryEntry(ctx, message.sender)?.label ?? null,
                recipient: message.recipient.toBase58(),
                recipientLabel:
                  findPeerDirectoryEntry(ctx, message.recipient)?.label ?? null,
                content: message.content,
                mode: message.mode,
                timestamp: message.timestamp,
                nonce: message.nonce,
                onChain: message.onChain,
                threadId: message.threadId ?? null,
                direction:
                  message.sender.equals(self) || message.sender.equals(localAgentPda)
                    ? "outgoing"
                    : "incoming",
              })),
            }),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          ctx.logger.error?.(`social.getRecentMessages failed: ${msg}`);
          return toolErrorResult(msg);
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
        if (!feed) return toolErrorResult("Social module not enabled");

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
          return toolErrorResult(msg);
        }
      },
    },

    // ------------------------------------------------------------------
    // social.getReputation
    // ------------------------------------------------------------------
    {
      name: "social.getReputation",
      description:
        "Get on-chain reputation and profile for an agent by PDA, authority, or configured peer alias.",
      inputSchema: {
        type: "object",
        properties: {
          agentPda: {
            type: "string",
            description:
              "Agent registration PDA/authority (base58) or configured peer alias",
          },
        },
        required: ["agentPda"],
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const discovery = ctx.getDiscovery();
        if (!discovery) return toolErrorResult("Social module not enabled");

        const [agentRef, agentErr] = resolvePeerReference(args.agentPda, "agentPda", ctx);
        if (agentErr) return agentErr;

        try {
          let profile = await discovery.getProfile(agentRef.pubkey);
          if (!profile && agentRef.entry) {
            profile = await discovery.getProfile(new PublicKey(agentRef.entry.agentPda));
          }
          if (!profile) {
            return toolErrorResult(`Agent not found: ${agentRef.pubkey.toBase58()}`);
          }

          return {
            content: safeStringify({
              pda: profile.pda.toBase58(),
              authority: profile.authority.toBase58(),
              label:
                findPeerDirectoryEntry(ctx, profile.pda)?.label ??
                findPeerDirectoryEntry(ctx, profile.authority)?.label ??
                null,
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
          return toolErrorResult(msg);
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
        if (!collab) return toolErrorResult("Social module not enabled");

        if (typeof args.title !== "string" || args.title.length === 0) {
          return toolErrorResult("title must be a non-empty string");
        }
        if (args.title.length > 128) {
          return toolErrorResult("title must be at most 128 characters");
        }

        if (
          typeof args.description !== "string" ||
          args.description.length === 0
        ) {
          return toolErrorResult("description must be a non-empty string");
        }
        if (args.description.length > 1024) {
          return toolErrorResult("description must be at most 1024 characters");
        }

        const [caps, capsErr] = parseBigIntArg(
          args.requiredCapabilities,
          "requiredCapabilities",
        );
        if (capsErr) return capsErr;

        if (
          typeof args.maxMembers !== "number" ||
          args.maxMembers < 2 ||
          args.maxMembers > 20
        ) {
          return toolErrorResult("maxMembers must be a number between 2 and 20");
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
          return toolErrorResult(msg);
        }
      },
    },
  ];
}
