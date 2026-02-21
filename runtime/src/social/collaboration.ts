/**
 * CollaborationProtocol - Agent team formation via feed posts and messaging.
 *
 * One agent discovers a task too complex for a single agent, posts a
 * collaboration request to the feed, other agents respond via messaging,
 * and once enough members accept, the requester forms a team contract.
 *
 * This is a runtime-only coordination layer — no new on-chain instructions.
 * It composes existing subsystems (feed, messaging, discovery, team engine)
 * via dependency injection.
 *
 * @module
 */

import { createHash, randomBytes } from "node:crypto";
import type { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import type { AgencCoordination } from "../idl.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { findAgentPda } from "../agent/pda.js";
import type { AgentFeed } from "./feed.js";
import { deriveFeedPostPda } from "./feed.js";
import type { AgentMessaging } from "./messaging.js";
import type { AgentDiscovery } from "./discovery.js";
import type { AgentProfile } from "./types.js";
import type { ReputationSignalCallback } from "./reputation-types.js";
import type { TeamContractEngine } from "../team/engine.js";
import type {
  TeamRoleTemplate,
  TeamCheckpointTemplate,
} from "../team/types.js";
import {
  CollaborationRequestError,
  CollaborationResponseError,
  CollaborationFormationError,
} from "./collaboration-errors.js";
import {
  COLLABORATION_TOPIC,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_COLLABORATION_MEMBERS,
  type CollaborationRequest,
  type CollaborationResponse,
  type CollaborationRequestState,
  type CollaborationRequestMetadata,
  type CollaborationOpsConfig,
} from "./collaboration-types.js";

// ============================================================================
// CollaborationProtocol
// ============================================================================

export class CollaborationProtocol {
  private readonly program: Program<AgencCoordination>;
  private readonly agentId: Uint8Array;
  private readonly feed: AgentFeed;
  private readonly messaging: AgentMessaging;
  private readonly discovery: AgentDiscovery;
  private readonly teamEngine: TeamContractEngine;
  private readonly logger: Logger;
  private readonly agentPda: PublicKey;
  private readonly collaborationTopic: Uint8Array;
  private readonly onReputationSignal?: ReputationSignalCallback;

  /** In-memory store of collaboration requests created by this agent */
  private readonly requests = new Map<string, CollaborationRequestState>();

  constructor(opsConfig: CollaborationOpsConfig) {
    this.program = opsConfig.program;
    this.agentId = new Uint8Array(opsConfig.agentId);
    this.feed = opsConfig.feed;
    this.messaging = opsConfig.messaging;
    this.discovery = opsConfig.discovery;
    this.teamEngine = opsConfig.teamEngine;
    this.logger = opsConfig.config?.logger ?? silentLogger;
    this.onReputationSignal = opsConfig.config?.onReputationSignal;
    this.collaborationTopic =
      opsConfig.config?.collaborationTopic ?? COLLABORATION_TOPIC;

    this.agentPda = findAgentPda(this.agentId, this.program.programId);
  }

  // ==========================================================================
  // Public API: Write Operations
  // ==========================================================================

  /**
   * Post a collaboration request to the feed.
   *
   * @param request - The collaboration request details
   * @returns The request ID (postPda base58)
   */
  async requestCollaboration(request: CollaborationRequest): Promise<string> {
    this.validateRequest(request);

    const metadata: CollaborationRequestMetadata = {
      type: "collaboration_request",
      version: 1,
      title: request.title,
      description: request.description,
      requiredCapabilities: request.requiredCapabilities.toString(),
      maxMembers: request.maxMembers,
      payoutModel: request.payoutModel,
      deadline: request.deadline,
    };

    const contentHash = createHash("sha256")
      .update(JSON.stringify(metadata))
      .digest();

    const nonce = randomBytes(32);

    const postPda = deriveFeedPostPda(
      this.agentPda,
      nonce,
      this.program.programId,
    );

    try {
      await this.feed.post({
        contentHash: new Uint8Array(contentHash),
        nonce: new Uint8Array(nonce),
        topic: this.collaborationTopic,
      });
    } catch (err) {
      throw new CollaborationRequestError(
        err instanceof Error ? err.message : String(err),
      );
    }

    const requestId = postPda.toBase58();
    const state: CollaborationRequestState = {
      requestId,
      request,
      postPda,
      requesterPda: this.agentPda,
      status: "open",
      responses: [],
      teamContractId: null,
      contentHash: new Uint8Array(contentHash),
      nonce: new Uint8Array(nonce),
      createdAt: Math.floor(Date.now() / 1000),
    };

    this.requests.set(requestId, state);
    this.logger.info(`Collaboration request created: ${requestId}`);
    return requestId;
  }

  /**
   * Respond to a collaboration request by sending a message to the requester.
   *
   * @param requestId - The request ID (postPda base58)
   * @param accept - Whether to accept the collaboration
   */
  async respondToRequest(requestId: string, accept: boolean): Promise<void> {
    const state = this.requests.get(requestId);
    if (!state) {
      throw new CollaborationResponseError(requestId, "Request not found");
    }

    this.checkExpiration(state);
    if (state.status !== "open" && state.status !== "forming") {
      throw new CollaborationResponseError(
        requestId,
        `Request is ${state.status}, not accepting responses`,
      );
    }

    const content = JSON.stringify({
      type: "collaboration_response",
      requestId,
      accepted: accept,
    });

    try {
      await this.messaging.send(state.requesterPda, content);
    } catch (err) {
      throw new CollaborationResponseError(
        requestId,
        err instanceof Error ? err.message : String(err),
      );
    }

    this.logger.info(
      `Responded to collaboration ${requestId}: ${accept ? "accepted" : "declined"}`,
    );
  }

  /**
   * Process a collaboration response (requester-side).
   * Records the response and transitions to 'forming' when maxMembers reached.
   *
   * @param requestId - The request ID
   * @param agentPda - PDA of the responding agent
   * @param accepted - Whether the agent accepted
   * @param capabilities - Capabilities of the responding agent
   */
  processResponse(
    requestId: string,
    agentPda: PublicKey,
    accepted: boolean,
    capabilities: bigint,
  ): void {
    const state = this.requests.get(requestId);
    if (!state) {
      throw new CollaborationResponseError(requestId, "Request not found");
    }

    this.checkExpiration(state);
    if (state.status !== "open" && state.status !== "forming") {
      throw new CollaborationResponseError(
        requestId,
        `Request is ${state.status}, not accepting responses`,
      );
    }

    // Check for duplicate response from same agent
    const existing = state.responses.find((r) => r.agentPda.equals(agentPda));
    if (existing) {
      throw new CollaborationResponseError(
        requestId,
        `Agent ${agentPda.toBase58()} already responded`,
      );
    }

    const response: CollaborationResponse = {
      agentPda,
      accepted,
      capabilities,
      respondedAt: Math.floor(Date.now() / 1000),
    };
    state.responses.push(response);

    // Transition to 'forming' when enough accepted responses
    const acceptedCount = state.responses.filter((r) => r.accepted).length;
    if (acceptedCount >= state.request.maxMembers) {
      state.status = "forming";
      this.logger.info(
        `Collaboration ${requestId} has enough members (${acceptedCount}/${state.request.maxMembers}), ready to form team`,
      );
    }
  }

  /**
   * Form a team contract from a collaboration request.
   *
   * @param requestId - The request ID
   * @param members - Agent PDA bytes (32-byte Uint8Array) of accepted members to include
   * @returns The team contract ID (normalized by the team engine)
   */
  async formTeam(requestId: string, members: Uint8Array[]): Promise<string> {
    const state = this.requests.get(requestId);
    if (!state) {
      throw new CollaborationFormationError(requestId, "Request not found");
    }

    if (state.status !== "open" && state.status !== "forming") {
      throw new CollaborationFormationError(
        requestId,
        `Request is ${state.status}, cannot form team`,
      );
    }

    // Validate all members have accepted
    for (const memberId of members) {
      const memberHex = Buffer.from(memberId).toString("hex");
      const response = this.findResponseByHex(state, memberHex);
      if (!response || !response.accepted) {
        throw new CollaborationFormationError(
          requestId,
          `Member ${memberHex} has not accepted the collaboration`,
        );
      }
    }

    // Build team template — use hex-encoded contentHash prefix for team-ID-compatible strings
    const hashHex = Buffer.from(state.contentHash).toString("hex");
    const roleId = "collaborator";
    const role: TeamRoleTemplate = {
      id: roleId,
      requiredCapabilities: state.request.requiredCapabilities,
      minMembers: 1,
      maxMembers: members.length,
    };

    const checkpoints: TeamCheckpointTemplate[] = members.map((_m, i) => ({
      id: `checkpoint-${i}`,
      roleId,
      label: `Member ${i} contribution`,
    }));

    const contractId = `collab-${hashHex.slice(0, 16)}-${Date.now()}`;

    try {
      // Create the contract — the engine normalizes/validates the ID
      const snapshot = this.teamEngine.createContract({
        contractId,
        creatorId: Buffer.from(this.agentPda.toBytes()).toString("hex"),
        template: {
          id: `collab-tmpl-${hashHex.slice(0, 12)}`,
          name: state.request.title,
          roles: [role],
          checkpoints,
          payout: state.request.payoutModel,
        },
      });

      // Use the normalized ID from the engine's snapshot
      const normalizedId = snapshot.id;

      // Join all members
      for (const memberId of members) {
        const memberHex = Buffer.from(memberId).toString("hex");
        const response = this.findResponseByHex(state, memberHex);

        this.teamEngine.joinContract({
          contractId: normalizedId,
          member: {
            id: memberHex,
            capabilities: response!.capabilities,
            roles: [roleId],
          },
        });
      }

      state.status = "formed";
      state.teamContractId = normalizedId;

      this.logger.info(
        `Team formed for collaboration ${requestId}: contract ${normalizedId} with ${members.length} members`,
      );

      // Emit reputation signal for collaboration formation
      if (this.onReputationSignal) {
        this.onReputationSignal({
          kind: "collaboration",
          agent: this.agentPda,
          delta: 1,
          timestamp: Math.floor(Date.now() / 1000),
        });
      }

      return normalizedId;
    } catch (err) {
      if (err instanceof CollaborationFormationError) {
        throw err;
      }
      throw new CollaborationFormationError(
        requestId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  /**
   * Delegate a task to a team member via the team engine.
   *
   * @param teamId - The team contract ID
   * @param taskId - The task identifier
   * @param assignee - The assignee's agent PDA bytes (32-byte Uint8Array)
   */
  async delegateTask(
    teamId: string,
    taskId: string,
    assignee: Uint8Array,
  ): Promise<void> {
    const contract = this.teamEngine.getContract(teamId);
    if (!contract) {
      throw new CollaborationFormationError(teamId, "Team contract not found");
    }

    const memberId = Buffer.from(assignee).toString("hex");

    try {
      this.teamEngine.assignRole({
        contractId: teamId,
        memberId,
        roleId: "collaborator",
      });
    } catch (err) {
      throw new CollaborationFormationError(
        teamId,
        err instanceof Error ? err.message : String(err),
      );
    }

    this.logger.info(
      `Delegated task ${taskId} to member ${memberId} in team ${teamId}`,
    );
  }

  // ==========================================================================
  // Public API: Read Operations
  // ==========================================================================

  /**
   * Get a collaboration request by ID.
   * Returns null if not found. Performs lazy deadline expiration check.
   */
  getRequest(requestId: string): CollaborationRequestState | null {
    const state = this.requests.get(requestId);
    if (!state) return null;
    this.checkExpiration(state);
    return state;
  }

  /**
   * Get all active (open or forming) collaboration requests.
   */
  getActiveRequests(): CollaborationRequestState[] {
    const results: CollaborationRequestState[] = [];
    for (const state of this.requests.values()) {
      this.checkExpiration(state);
      if (state.status === "open" || state.status === "forming") {
        results.push(state);
      }
    }
    return results;
  }

  /**
   * Cancel a collaboration request.
   */
  cancelRequest(requestId: string): void {
    const state = this.requests.get(requestId);
    if (!state) {
      throw new CollaborationRequestError(`Request ${requestId} not found`);
    }
    state.status = "cancelled";
    this.logger.info(`Collaboration request cancelled: ${requestId}`);
  }

  /**
   * Find potential collaborators matching capability requirements.
   *
   * @param capabilities - Required capability bitmask
   * @param minReputation - Optional minimum reputation threshold
   * @returns Matching agent profiles
   */
  async findCollaborators(
    capabilities: bigint,
    minReputation?: number,
  ): Promise<AgentProfile[]> {
    return this.discovery.search({
      capabilities,
      minReputation,
    });
  }

  // ==========================================================================
  // Private: Validation
  // ==========================================================================

  private validateRequest(request: CollaborationRequest): void {
    if (!request.title || request.title.length === 0) {
      throw new CollaborationRequestError("Title is required");
    }
    if (request.title.length > MAX_TITLE_LENGTH) {
      throw new CollaborationRequestError(
        `Title exceeds ${MAX_TITLE_LENGTH} characters`,
      );
    }
    if (!request.description || request.description.length === 0) {
      throw new CollaborationRequestError("Description is required");
    }
    if (request.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new CollaborationRequestError(
        `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters`,
      );
    }
    if (request.maxMembers < 2) {
      throw new CollaborationRequestError("maxMembers must be at least 2");
    }
    if (request.maxMembers > MAX_COLLABORATION_MEMBERS) {
      throw new CollaborationRequestError(
        `maxMembers exceeds ${MAX_COLLABORATION_MEMBERS}`,
      );
    }
    if (request.requiredCapabilities === 0n) {
      throw new CollaborationRequestError(
        "requiredCapabilities must not be zero",
      );
    }
    if (!request.payoutModel || !request.payoutModel.mode) {
      throw new CollaborationRequestError("payoutModel is required");
    }
  }

  private checkExpiration(state: CollaborationRequestState): void {
    if (state.status === "open" || state.status === "forming") {
      if (
        state.request.deadline &&
        Math.floor(Date.now() / 1000) > state.request.deadline
      ) {
        state.status = "expired";
      }
    }
  }

  private findResponseByHex(
    state: CollaborationRequestState,
    memberHex: string,
  ): CollaborationResponse | undefined {
    return state.responses.find((r) => {
      const rHex = Buffer.from(r.agentPda.toBytes()).toString("hex");
      return rHex === memberHex;
    });
  }
}
