import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey, Keypair } from "@solana/web3.js";
import { PROGRAM_ID } from "@agenc/sdk";
import { generateAgentId } from "../utils/encoding.js";
import { RuntimeErrorCodes } from "../types/errors.js";
import {
  CollaborationRequestError,
  CollaborationResponseError,
  CollaborationFormationError,
} from "./collaboration-errors.js";
import { CollaborationProtocol } from "./collaboration.js";
import {
  COLLABORATION_TOPIC,
  MAX_TITLE_LENGTH,
  MAX_DESCRIPTION_LENGTH,
  MAX_COLLABORATION_MEMBERS,
  type CollaborationRequest,
} from "./collaboration-types.js";
import type { TeamPayoutConfig } from "../team/types.js";

// ============================================================================
// Test Helpers
// ============================================================================

function randomPubkey(): PublicKey {
  return Keypair.generate().publicKey;
}

function randomBytes32(): Uint8Array {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function createMockProgram() {
  return {
    programId: PROGRAM_ID,
    provider: { publicKey: randomPubkey() },
  } as any;
}

function createMockFeed() {
  return {
    post: vi.fn().mockResolvedValue("mock-sig"),
    getPost: vi.fn().mockResolvedValue(null),
    getFeed: vi.fn().mockResolvedValue([]),
  } as any;
}

function createMockMessaging() {
  return {
    send: vi.fn().mockResolvedValue({
      id: "mock-msg-id",
      sender: randomPubkey(),
      recipient: randomPubkey(),
      content: "{}",
      mode: "on-chain" as const,
      signature: new Uint8Array(64),
      timestamp: Math.floor(Date.now() / 1000),
      nonce: 0,
      onChain: true,
    }),
  } as any;
}

function createMockDiscovery() {
  return {
    search: vi.fn().mockResolvedValue([]),
    getProfile: vi.fn().mockResolvedValue(null),
  } as any;
}

function createMockTeamEngine() {
  return {
    createContract: vi
      .fn()
      .mockImplementation((input: { contractId: string }) => ({
        id: input.contractId.toLowerCase(),
        status: "draft",
        template: {},
        members: [],
      })),
    joinContract: vi
      .fn()
      .mockReturnValue({ id: "mock-contract", status: "draft" }),
    assignRole: vi
      .fn()
      .mockReturnValue({ id: "mock-contract", status: "draft" }),
    getContract: vi
      .fn()
      .mockReturnValue({ id: "mock-contract", status: "draft", members: [] }),
    startRun: vi
      .fn()
      .mockReturnValue({ id: "mock-contract", status: "active" }),
  } as any;
}

function createValidRequest(
  overrides: Partial<CollaborationRequest> = {},
): CollaborationRequest {
  return {
    title: "Multi-agent data processing",
    description: "Need help processing a large dataset collaboratively.",
    requiredCapabilities: 3n, // COMPUTE | INFERENCE
    maxMembers: 3,
    payoutModel: {
      mode: "fixed",
      rolePayoutBps: { collaborator: 10_000 },
    } as TeamPayoutConfig,
    ...overrides,
  };
}

function createTestCollaboration(overrides: Record<string, unknown> = {}) {
  const wallet = Keypair.generate();
  const agentId = generateAgentId(wallet.publicKey);
  const program = createMockProgram();
  const feed = createMockFeed();
  const messaging = createMockMessaging();
  const discovery = createMockDiscovery();
  const teamEngine = createMockTeamEngine();

  const collab = new CollaborationProtocol({
    program,
    agentId,
    wallet,
    feed,
    messaging,
    discovery,
    teamEngine,
    ...overrides,
  });

  return {
    collab,
    program,
    feed,
    messaging,
    discovery,
    teamEngine,
    wallet,
    agentId,
  };
}

// ============================================================================
// Constructor Tests
// ============================================================================

describe("CollaborationProtocol constructor", () => {
  it("creates instance with valid config", () => {
    const { collab } = createTestCollaboration();
    expect(collab).toBeInstanceOf(CollaborationProtocol);
  });

  it("uses silentLogger by default", () => {
    const { collab } = createTestCollaboration();
    // No errors means silentLogger is working
    expect(collab).toBeDefined();
  });

  it("accepts custom collaboration topic", () => {
    const customTopic = randomBytes32();
    const { collab } = createTestCollaboration({
      config: { collaborationTopic: customTopic },
    });
    expect(collab).toBeDefined();
  });
});

// ============================================================================
// requestCollaboration Tests
// ============================================================================

describe("CollaborationProtocol.requestCollaboration()", () => {
  it("posts to feed and returns requestId", async () => {
    const { collab, feed } = createTestCollaboration();
    const request = createValidRequest();

    const requestId = await collab.requestCollaboration(request);

    expect(requestId).toEqual(expect.any(String));
    expect(feed.post).toHaveBeenCalledTimes(1);
  });

  it("passes collaboration topic to feed.post", async () => {
    const { collab, feed } = createTestCollaboration();
    const request = createValidRequest();

    await collab.requestCollaboration(request);

    const postCall = feed.post.mock.calls[0][0];
    expect(postCall.topic).toEqual(COLLABORATION_TOPIC);
  });

  it("stores request state after posting", async () => {
    const { collab } = createTestCollaboration();
    const request = createValidRequest();

    const requestId = await collab.requestCollaboration(request);
    const state = collab.getRequest(requestId);

    expect(state).not.toBeNull();
    expect(state!.status).toBe("open");
    expect(state!.request.title).toBe(request.title);
    expect(state!.responses).toHaveLength(0);
  });

  it("generates 32-byte contentHash", async () => {
    const { collab } = createTestCollaboration();
    const request = createValidRequest();

    const requestId = await collab.requestCollaboration(request);
    const state = collab.getRequest(requestId);

    expect(state!.contentHash).toBeInstanceOf(Uint8Array);
    expect(state!.contentHash).toHaveLength(32);
  });

  it("generates 32-byte nonce", async () => {
    const { collab } = createTestCollaboration();
    const request = createValidRequest();

    const requestId = await collab.requestCollaboration(request);
    const state = collab.getRequest(requestId);

    expect(state!.nonce).toBeInstanceOf(Uint8Array);
    expect(state!.nonce).toHaveLength(32);
  });

  it("throws on empty title", async () => {
    const { collab } = createTestCollaboration();
    const request = createValidRequest({ title: "" });

    await expect(collab.requestCollaboration(request)).rejects.toThrow(
      CollaborationRequestError,
    );
  });

  it("throws on title exceeding max length", async () => {
    const { collab } = createTestCollaboration();
    const request = createValidRequest({
      title: "x".repeat(MAX_TITLE_LENGTH + 1),
    });

    await expect(collab.requestCollaboration(request)).rejects.toThrow(
      CollaborationRequestError,
    );
  });

  it("throws on empty description", async () => {
    const { collab } = createTestCollaboration();
    const request = createValidRequest({ description: "" });

    await expect(collab.requestCollaboration(request)).rejects.toThrow(
      CollaborationRequestError,
    );
  });

  it("throws on description exceeding max length", async () => {
    const { collab } = createTestCollaboration();
    const request = createValidRequest({
      description: "x".repeat(MAX_DESCRIPTION_LENGTH + 1),
    });

    await expect(collab.requestCollaboration(request)).rejects.toThrow(
      CollaborationRequestError,
    );
  });

  it("throws on maxMembers less than 2", async () => {
    const { collab } = createTestCollaboration();
    const request = createValidRequest({ maxMembers: 1 });

    await expect(collab.requestCollaboration(request)).rejects.toThrow(
      CollaborationRequestError,
    );
  });

  it("throws on maxMembers exceeding limit", async () => {
    const { collab } = createTestCollaboration();
    const request = createValidRequest({
      maxMembers: MAX_COLLABORATION_MEMBERS + 1,
    });

    await expect(collab.requestCollaboration(request)).rejects.toThrow(
      CollaborationRequestError,
    );
  });

  it("throws on zero capabilities", async () => {
    const { collab } = createTestCollaboration();
    const request = createValidRequest({ requiredCapabilities: 0n });

    await expect(collab.requestCollaboration(request)).rejects.toThrow(
      CollaborationRequestError,
    );
  });

  it("wraps feed.post errors as CollaborationRequestError", async () => {
    const feed = createMockFeed();
    feed.post.mockRejectedValue(new Error("Feed unavailable"));
    const { collab } = createTestCollaboration({ feed });

    await expect(
      collab.requestCollaboration(createValidRequest()),
    ).rejects.toThrow(CollaborationRequestError);
  });
});

// ============================================================================
// respondToRequest Tests
// ============================================================================

describe("CollaborationProtocol.respondToRequest()", () => {
  it("sends message to requester", async () => {
    const { collab, messaging } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(createValidRequest());

    await collab.respondToRequest(requestId, true);

    expect(messaging.send).toHaveBeenCalledTimes(1);
  });

  it("sends correct JSON content", async () => {
    const { collab, messaging } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(createValidRequest());

    await collab.respondToRequest(requestId, true);

    const content = JSON.parse(messaging.send.mock.calls[0][1]);
    expect(content.type).toBe("collaboration_response");
    expect(content.requestId).toBe(requestId);
    expect(content.accepted).toBe(true);
    expect(content).not.toHaveProperty("capabilities");
  });

  it("sends decline message when accept is false", async () => {
    const { collab, messaging } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(createValidRequest());

    await collab.respondToRequest(requestId, false);

    const content = JSON.parse(messaging.send.mock.calls[0][1]);
    expect(content.accepted).toBe(false);
  });

  it("throws on unknown request", async () => {
    const { collab } = createTestCollaboration();

    await expect(collab.respondToRequest("nonexistent", true)).rejects.toThrow(
      CollaborationResponseError,
    );
  });

  it("throws on cancelled request", async () => {
    const { collab } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(createValidRequest());
    collab.cancelRequest(requestId);

    await expect(collab.respondToRequest(requestId, true)).rejects.toThrow(
      CollaborationResponseError,
    );
  });

  it("wraps messaging errors as CollaborationResponseError", async () => {
    const messaging = createMockMessaging();
    messaging.send.mockRejectedValue(new Error("Connection failed"));
    const { collab } = createTestCollaboration({ messaging });
    const requestId = await collab.requestCollaboration(createValidRequest());

    await expect(collab.respondToRequest(requestId, true)).rejects.toThrow(
      CollaborationResponseError,
    );
  });
});

// ============================================================================
// processResponse Tests
// ============================================================================

describe("CollaborationProtocol.processResponse()", () => {
  it("records accepted response", async () => {
    const { collab } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(createValidRequest());
    const agentPda = randomPubkey();

    collab.processResponse(requestId, agentPda, true, 3n);

    const state = collab.getRequest(requestId)!;
    expect(state.responses).toHaveLength(1);
    expect(state.responses[0].accepted).toBe(true);
    expect(state.responses[0].agentPda.equals(agentPda)).toBe(true);
  });

  it("records rejected response", async () => {
    const { collab } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(createValidRequest());
    const agentPda = randomPubkey();

    collab.processResponse(requestId, agentPda, false, 3n);

    const state = collab.getRequest(requestId)!;
    expect(state.responses).toHaveLength(1);
    expect(state.responses[0].accepted).toBe(false);
  });

  it("throws on unknown request", () => {
    const { collab } = createTestCollaboration();

    expect(() =>
      collab.processResponse("nonexistent", randomPubkey(), true, 3n),
    ).toThrow(CollaborationResponseError);
  });

  it("throws on cancelled request", async () => {
    const { collab } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(createValidRequest());
    collab.cancelRequest(requestId);

    expect(() =>
      collab.processResponse(requestId, randomPubkey(), true, 3n),
    ).toThrow(CollaborationResponseError);
  });

  it("throws on duplicate response from same agent", async () => {
    const { collab } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(createValidRequest());
    const agentPda = randomPubkey();

    collab.processResponse(requestId, agentPda, true, 3n);

    expect(() => collab.processResponse(requestId, agentPda, true, 3n)).toThrow(
      CollaborationResponseError,
    );
  });

  it("transitions to forming when maxMembers accepted", async () => {
    const { collab } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(
      createValidRequest({ maxMembers: 2 }),
    );

    collab.processResponse(requestId, randomPubkey(), true, 3n);
    expect(collab.getRequest(requestId)!.status).toBe("open");

    collab.processResponse(requestId, randomPubkey(), true, 3n);
    expect(collab.getRequest(requestId)!.status).toBe("forming");
  });

  it("does not transition to forming on rejections only", async () => {
    const { collab } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(
      createValidRequest({ maxMembers: 2 }),
    );

    collab.processResponse(requestId, randomPubkey(), false, 3n);
    collab.processResponse(requestId, randomPubkey(), false, 3n);
    expect(collab.getRequest(requestId)!.status).toBe("open");
  });
});

// ============================================================================
// formTeam Tests
// ============================================================================

describe("CollaborationProtocol.formTeam()", () => {
  async function setupFormableRequest(collab: CollaborationProtocol) {
    const requestId = await collab.requestCollaboration(
      createValidRequest({ maxMembers: 2 }),
    );
    const member1 = randomPubkey();
    const member2 = randomPubkey();

    collab.processResponse(requestId, member1, true, 3n);
    collab.processResponse(requestId, member2, true, 3n);

    return { requestId, member1, member2 };
  }

  it("creates team contract via teamEngine", async () => {
    const { collab, teamEngine } = createTestCollaboration();
    const { requestId, member1, member2 } = await setupFormableRequest(collab);

    await collab.formTeam(requestId, [member1.toBytes(), member2.toBytes()]);

    expect(teamEngine.createContract).toHaveBeenCalledTimes(1);
  });

  it("joins all members to the contract with normalized ID", async () => {
    const { collab, teamEngine } = createTestCollaboration();
    const { requestId, member1, member2 } = await setupFormableRequest(collab);

    const contractId = await collab.formTeam(requestId, [
      member1.toBytes(),
      member2.toBytes(),
    ]);

    expect(teamEngine.joinContract).toHaveBeenCalledTimes(2);
    // Verify joinContract uses the normalized ID from createContract snapshot
    expect(teamEngine.joinContract.mock.calls[0][0].contractId).toBe(
      contractId,
    );
    expect(teamEngine.joinContract.mock.calls[1][0].contractId).toBe(
      contractId,
    );
  });

  it("returns contract ID", async () => {
    const { collab } = createTestCollaboration();
    const { requestId, member1, member2 } = await setupFormableRequest(collab);

    const contractId = await collab.formTeam(requestId, [
      member1.toBytes(),
      member2.toBytes(),
    ]);

    expect(contractId).toEqual(expect.any(String));
    expect(contractId).toContain("collab-");
  });

  it("sets status to formed", async () => {
    const { collab } = createTestCollaboration();
    const { requestId, member1, member2 } = await setupFormableRequest(collab);

    await collab.formTeam(requestId, [member1.toBytes(), member2.toBytes()]);

    expect(collab.getRequest(requestId)!.status).toBe("formed");
  });

  it("stores teamContractId on state", async () => {
    const { collab } = createTestCollaboration();
    const { requestId, member1, member2 } = await setupFormableRequest(collab);

    const contractId = await collab.formTeam(requestId, [
      member1.toBytes(),
      member2.toBytes(),
    ]);

    expect(collab.getRequest(requestId)!.teamContractId).toBe(contractId);
  });

  it("throws on unknown request", async () => {
    const { collab } = createTestCollaboration();

    await expect(
      collab.formTeam("nonexistent", [randomBytes32()]),
    ).rejects.toThrow(CollaborationFormationError);
  });

  it("throws on already formed request", async () => {
    const { collab } = createTestCollaboration();
    const { requestId, member1, member2 } = await setupFormableRequest(collab);

    await collab.formTeam(requestId, [member1.toBytes(), member2.toBytes()]);

    await expect(
      collab.formTeam(requestId, [member1.toBytes()]),
    ).rejects.toThrow(CollaborationFormationError);
  });

  it("throws on unaccepted member", async () => {
    const { collab } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(
      createValidRequest({ maxMembers: 2 }),
    );
    const accepted = randomPubkey();
    const stranger = randomPubkey();

    collab.processResponse(requestId, accepted, true, 3n);

    await expect(
      collab.formTeam(requestId, [stranger.toBytes()]),
    ).rejects.toThrow(CollaborationFormationError);
  });

  it("wraps teamEngine errors as CollaborationFormationError", async () => {
    const teamEngine = createMockTeamEngine();
    teamEngine.createContract.mockImplementation(() => {
      throw new Error("Template validation failed");
    });
    const { collab } = createTestCollaboration({ teamEngine });
    const { requestId, member1, member2 } = await setupFormableRequest(collab);

    await expect(
      collab.formTeam(requestId, [member1.toBytes(), member2.toBytes()]),
    ).rejects.toThrow(CollaborationFormationError);
  });

  it("passes payout model through to team template", async () => {
    const { collab, teamEngine } = createTestCollaboration();
    const payoutModel = {
      mode: "weighted" as const,
      roleWeights: { collaborator: 1 },
    };
    const requestId = await collab.requestCollaboration(
      createValidRequest({ maxMembers: 2, payoutModel }),
    );
    const m1 = randomPubkey();
    const m2 = randomPubkey();
    collab.processResponse(requestId, m1, true, 3n);
    collab.processResponse(requestId, m2, true, 3n);

    await collab.formTeam(requestId, [m1.toBytes(), m2.toBytes()]);

    const createCall = teamEngine.createContract.mock.calls[0][0];
    expect(createCall.template.payout).toEqual(payoutModel);
  });

  it("creates team template with correct role and checkpoints", async () => {
    const { collab, teamEngine } = createTestCollaboration();
    const { requestId, member1, member2 } = await setupFormableRequest(collab);

    await collab.formTeam(requestId, [member1.toBytes(), member2.toBytes()]);

    const createCall = teamEngine.createContract.mock.calls[0][0];
    expect(createCall.template.roles).toHaveLength(1);
    expect(createCall.template.roles[0].id).toBe("collaborator");
    expect(createCall.template.roles[0].maxMembers).toBe(2);
    expect(createCall.template.checkpoints).toHaveLength(2);
    expect(createCall.template.checkpoints[0].roleId).toBe("collaborator");
    expect(createCall.template.checkpoints[1].roleId).toBe("collaborator");
  });

  it("emits reputation signal on formation", async () => {
    const onReputationSignal = vi.fn();
    const { collab } = createTestCollaboration({
      config: { onReputationSignal },
    });
    const { requestId, member1, member2 } = await setupFormableRequest(collab);

    await collab.formTeam(requestId, [member1.toBytes(), member2.toBytes()]);

    expect(onReputationSignal).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "collaboration",
        delta: 1,
      }),
    );
  });
});

// ============================================================================
// delegateTask Tests
// ============================================================================

describe("CollaborationProtocol.delegateTask()", () => {
  it("assigns role via teamEngine", async () => {
    const { collab, teamEngine } = createTestCollaboration();

    await collab.delegateTask("contract-1", "task-1", randomBytes32());

    expect(teamEngine.assignRole).toHaveBeenCalledTimes(1);
    expect(teamEngine.assignRole.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        contractId: "contract-1",
        roleId: "collaborator",
      }),
    );
  });

  it("throws on unknown contract", async () => {
    const teamEngine = createMockTeamEngine();
    teamEngine.getContract.mockReturnValue(null);
    const { collab } = createTestCollaboration({ teamEngine });

    await expect(
      collab.delegateTask("unknown", "task-1", randomBytes32()),
    ).rejects.toThrow(CollaborationFormationError);
  });

  it("wraps teamEngine.assignRole errors", async () => {
    const teamEngine = createMockTeamEngine();
    teamEngine.assignRole.mockImplementation(() => {
      throw new Error("Member not found");
    });
    const { collab } = createTestCollaboration({ teamEngine });

    await expect(
      collab.delegateTask("contract-1", "task-1", randomBytes32()),
    ).rejects.toThrow(CollaborationFormationError);
  });

  it("passes correct memberId as hex", async () => {
    const { collab, teamEngine } = createTestCollaboration();
    const assignee = randomBytes32();

    await collab.delegateTask("contract-1", "task-1", assignee);

    const call = teamEngine.assignRole.mock.calls[0][0];
    expect(call.memberId).toBe(Buffer.from(assignee).toString("hex"));
  });
});

// ============================================================================
// Getters and Cancel Tests
// ============================================================================

describe("CollaborationProtocol getters and cancel", () => {
  it("getRequest returns null for unknown ID", () => {
    const { collab } = createTestCollaboration();
    expect(collab.getRequest("nonexistent")).toBeNull();
  });

  it("getRequest returns state for known ID", async () => {
    const { collab } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(createValidRequest());

    const state = collab.getRequest(requestId);
    expect(state).not.toBeNull();
    expect(state!.requestId).toBe(requestId);
  });

  it("getActiveRequests filters by status", async () => {
    const { collab } = createTestCollaboration();
    const id1 = await collab.requestCollaboration(createValidRequest());
    const id2 = await collab.requestCollaboration(createValidRequest());

    collab.cancelRequest(id1);

    const active = collab.getActiveRequests();
    expect(active).toHaveLength(1);
    expect(active[0].requestId).toBe(id2);
  });

  it("cancelRequest sets status to cancelled", async () => {
    const { collab } = createTestCollaboration();
    const requestId = await collab.requestCollaboration(createValidRequest());

    collab.cancelRequest(requestId);

    expect(collab.getRequest(requestId)!.status).toBe("cancelled");
  });

  it("cancelRequest throws on unknown request", () => {
    const { collab } = createTestCollaboration();

    expect(() => collab.cancelRequest("nonexistent")).toThrow(
      CollaborationRequestError,
    );
  });

  it("getRequest returns expired state for past-deadline requests", async () => {
    const { collab } = createTestCollaboration();
    const pastDeadline = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const requestId = await collab.requestCollaboration(
      createValidRequest({ deadline: pastDeadline }),
    );

    const state = collab.getRequest(requestId);
    expect(state!.status).toBe("expired");
  });
});

// ============================================================================
// findCollaborators Tests
// ============================================================================

describe("CollaborationProtocol.findCollaborators()", () => {
  it("delegates to discovery.search", async () => {
    const { collab, discovery } = createTestCollaboration();

    await collab.findCollaborators(3n);

    expect(discovery.search).toHaveBeenCalledWith({
      capabilities: 3n,
      minReputation: undefined,
    });
  });

  it("passes minReputation to search", async () => {
    const { collab, discovery } = createTestCollaboration();

    await collab.findCollaborators(3n, 5000);

    expect(discovery.search).toHaveBeenCalledWith({
      capabilities: 3n,
      minReputation: 5000,
    });
  });

  it("returns profiles from discovery", async () => {
    const mockProfile = {
      pda: randomPubkey(),
      capabilities: 3n,
      reputation: 8000,
    };
    const discovery = createMockDiscovery();
    discovery.search.mockResolvedValue([mockProfile]);
    const { collab } = createTestCollaboration({ discovery });

    const results = await collab.findCollaborators(3n);

    expect(results).toHaveLength(1);
    expect(results[0]).toBe(mockProfile);
  });
});

// ============================================================================
// Error Code Tests
// ============================================================================

describe("Collaboration error codes", () => {
  it("CollaborationRequestError uses correct code", () => {
    const err = new CollaborationRequestError("test");
    expect(err.code).toBe(RuntimeErrorCodes.COLLABORATION_REQUEST_ERROR);
    expect(err.name).toBe("CollaborationRequestError");
  });

  it("CollaborationResponseError uses correct code", () => {
    const err = new CollaborationResponseError("req-1", "test");
    expect(err.code).toBe(RuntimeErrorCodes.COLLABORATION_RESPONSE_ERROR);
    expect(err.name).toBe("CollaborationResponseError");
    expect(err.requestId).toBe("req-1");
  });

  it("CollaborationFormationError uses correct code", () => {
    const err = new CollaborationFormationError("req-1", "test");
    expect(err.code).toBe(RuntimeErrorCodes.COLLABORATION_FORMATION_ERROR);
    expect(err.name).toBe("CollaborationFormationError");
    expect(err.requestId).toBe("req-1");
  });
});
