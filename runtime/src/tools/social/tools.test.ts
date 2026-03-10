import { describe, it, expect, vi, beforeEach } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { createSocialTools, type SocialToolsContext } from "./tools.js";
import type { Tool } from "../types.js";
import type { SocialPeerDirectoryEntry } from "../../social/types.js";

function mockDiscovery() {
  return {
    search: vi.fn(),
    getProfile: vi.fn(),
    dispose: vi.fn(),
  };
}

function mockMessaging() {
  return {
    send: vi.fn(),
    getRecentMessages: vi.fn(),
    getLocalAuthority: vi.fn(() => PublicKey.unique()),
    getLocalAgentPda: vi.fn(() => PublicKey.unique()),
  };
}

function mockFeed() {
  return { post: vi.fn() };
}

function mockCollaboration() {
  return { requestCollaboration: vi.fn() };
}

function byName(tools: Tool[], name: string): Tool {
  const t = tools.find((t) => t.name === name);
  if (!t) throw new Error(`Tool not found: ${name}`);
  return t;
}

function makePeerEntry(
  overrides: Partial<SocialPeerDirectoryEntry> = {},
): SocialPeerDirectoryEntry {
  const index = overrides.index ?? 1;
  return {
    index,
    label: overrides.label ?? `agent-${index}`,
    authority: overrides.authority ?? PublicKey.unique().toBase58(),
    agentPda: overrides.agentPda ?? PublicKey.unique().toBase58(),
    aliases: overrides.aliases ?? [`agent ${index}`, `AGENT_${index}`],
  };
}

function makeMessage(args: {
  sender?: PublicKey;
  recipient?: PublicKey;
  content?: string;
  mode?: "on-chain" | "off-chain" | "auto";
  onChain?: boolean;
  threadId?: string | null;
}) {
  return {
    id: "msg-1",
    sender: args.sender ?? PublicKey.unique(),
    recipient: args.recipient ?? PublicKey.unique(),
    content: args.content ?? "hello",
    mode: args.mode ?? "off-chain",
    timestamp: 123,
    nonce: 7,
    onChain: args.onChain ?? false,
    threadId: args.threadId ?? null,
  };
}

describe("Social Tools", () => {
  let ctx: SocialToolsContext;
  let discovery: ReturnType<typeof mockDiscovery>;
  let messaging: ReturnType<typeof mockMessaging>;
  let feed: ReturnType<typeof mockFeed>;
  let collab: ReturnType<typeof mockCollaboration>;
  let tools: Tool[];

  beforeEach(() => {
    discovery = mockDiscovery();
    messaging = mockMessaging();
    feed = mockFeed();
    collab = mockCollaboration();

    ctx = {
      getDiscovery: () => discovery as any,
      getMessaging: () => messaging as any,
      getFeed: () => feed as any,
      getCollaboration: () => collab as any,
      getPeerDirectory: () => [],
      logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    };

    tools = createSocialTools(ctx);
  });

  it("creates 6 tools", () => {
    expect(tools).toHaveLength(6);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "social.getRecentMessages",
      "social.getReputation",
      "social.postToFeed",
      "social.requestCollaboration",
      "social.searchAgents",
      "social.sendMessage",
    ]);
  });

  describe("social.searchAgents", () => {
    it("returns not-enabled when discovery is null", async () => {
      ctx.getDiscovery = () => null;
      const tool = byName(createSocialTools(ctx), "social.searchAgents");
      const result = await tool.execute({});
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not enabled");
    });

    it("calls discovery.search with correct filters", async () => {
      discovery.search.mockResolvedValue([]);
      const tool = byName(tools, "social.searchAgents");
      await tool.execute({ capabilities: "3", minReputation: 50, limit: 10 });
      expect(discovery.search).toHaveBeenCalledWith({
        capabilities: 3n,
        minReputation: 50,
        onlineOnly: undefined,
        maxResults: 10,
      });
    });

    it("returns error for invalid capabilities", async () => {
      const tool = byName(tools, "social.searchAgents");
      const result = await tool.execute({ capabilities: "not-a-number" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("Invalid capabilities");
    });

    it("serializes profiles correctly", async () => {
      const pda = PublicKey.unique();
      const authority = PublicKey.unique();
      discovery.search.mockResolvedValue([
        {
          pda,
          authority,
          capabilities: 3n,
          reputation: 500,
          stake: 1_000_000_000n,
          status: 1,
          endpoint: "https://agent.local",
        },
      ]);
      const tool = byName(tools, "social.searchAgents");
      const result = await tool.execute({});
      const parsed = JSON.parse(result.content);
      expect(parsed.count).toBe(1);
      expect(parsed.agents[0].pda).toBe(pda.toBase58());
      expect(parsed.agents[0].authority).toBe(authority.toBase58());
      expect(parsed.agents[0].capabilities).toBe("3");
    });
  });

  describe("social.sendMessage", () => {
    it("returns not-enabled when messaging is null", async () => {
      ctx.getMessaging = () => null;
      const tool = byName(createSocialTools(ctx), "social.sendMessage");
      const result = await tool.execute({
        recipient: PublicKey.unique().toBase58(),
        content: "hello",
      });
      expect(result.isError).toBe(true);
    });

    it("validates recipient as base58", async () => {
      const tool = byName(tools, "social.sendMessage");
      const result = await tool.execute({
        recipient: "not-base58!!!",
        content: "hello",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("base58");
    });

    it("calls messaging.send with correct args", async () => {
      const recipient = PublicKey.unique();
      messaging.send.mockResolvedValue(
        makeMessage({
          recipient,
          mode: "on-chain",
          onChain: true,
          threadId: "thread-1",
        }),
      );
      const tool = byName(tools, "social.sendMessage");
      await tool.execute({
        recipient: recipient.toBase58(),
        content: "hello",
        mode: "on-chain",
        threadId: "thread-1",
      });
      expect(messaging.send).toHaveBeenCalledWith(
        recipient,
        "hello",
        "on-chain",
        { threadId: "thread-1" },
      );
    });

    it("resolves configured peer aliases and reports the resolution", async () => {
      const peer = makePeerEntry({ index: 4 });
      ctx.getPeerDirectory = () => [peer];
      tools = createSocialTools(ctx);
      messaging.send.mockResolvedValue(
        makeMessage({
          recipient: new PublicKey(peer.agentPda),
          mode: "off-chain",
          threadId: "social-run-1",
        }),
      );

      const tool = byName(tools, "social.sendMessage");
      const result = await tool.execute({
        recipient: "4",
        content: "hello",
        mode: "off-chain",
        threadId: "social-run-1",
      });

      expect(messaging.send).toHaveBeenCalledWith(
        new PublicKey(peer.agentPda),
        "hello",
        "off-chain",
        { threadId: "social-run-1" },
      );
      const parsed = JSON.parse(result.content);
      expect(parsed.requestedRecipient).toBe("4");
      expect(parsed.recipient).toBe(peer.agentPda);
      expect(parsed.recipientLabel).toBe(peer.label);
      expect(parsed.recipientResolutionSource).toBe("peer_directory_alias");
      expect(parsed.threadId).toBe("social-run-1");
    });
  });

  describe("social.getRecentMessages", () => {
    it("returns not-enabled when messaging is null", async () => {
      ctx.getMessaging = () => null;
      const tool = byName(createSocialTools(ctx), "social.getRecentMessages");
      const result = await tool.execute({});
      expect(result.isError).toBe(true);
    });

    it("calls messaging.getRecentMessages with parsed filters", async () => {
      const peer = PublicKey.unique();
      const self = PublicKey.unique();
      const selfAgentPda = PublicKey.unique();
      messaging.getLocalAuthority.mockReturnValue(self);
      messaging.getLocalAgentPda.mockReturnValue(selfAgentPda);
      messaging.getRecentMessages.mockReturnValue([
        makeMessage({
          sender: peer,
          recipient: selfAgentPda,
        }),
      ]);
      const tool = byName(tools, "social.getRecentMessages");
      const result = await tool.execute({
        limit: 3,
        direction: "incoming",
        peer: peer.toBase58(),
        mode: "off-chain",
        threadId: "thread-2",
      });

      expect(messaging.getRecentMessages).toHaveBeenCalledWith({
        limit: 3,
        direction: "incoming",
        mode: "off-chain",
        threadId: "thread-2",
      });
      const parsed = JSON.parse(result.content);
      expect(parsed.count).toBe(1);
      expect(parsed.messages[0].content).toBe("hello");
    });

    it("adds peer labels to recent messages when the directory is configured", async () => {
      const self = PublicKey.unique();
      const selfAgentPda = PublicKey.unique();
      const peer = makePeerEntry({ index: 2 });
      ctx.getPeerDirectory = () => [peer];
      tools = createSocialTools(ctx);
      messaging.getLocalAuthority.mockReturnValue(self);
      messaging.getLocalAgentPda.mockReturnValue(selfAgentPda);
      messaging.getRecentMessages.mockReturnValue([
        makeMessage({
          sender: new PublicKey(peer.agentPda),
          recipient: selfAgentPda,
        }),
      ]);

      const tool = byName(tools, "social.getRecentMessages");
      const result = await tool.execute({ peer: "agent 2" });
      const parsed = JSON.parse(result.content);

      expect(parsed.peer.label).toBe("agent-2");
      expect(parsed.messages[0].senderLabel).toBe("agent-2");
    });

    it("returns thread ids with recent messages", async () => {
      messaging.getRecentMessages.mockReturnValue([
        makeMessage({ threadId: "thread-3" }),
      ]);

      const tool = byName(tools, "social.getRecentMessages");
      const result = await tool.execute({ threadId: "thread-3" });
      const parsed = JSON.parse(result.content);

      expect(parsed.messages[0].threadId).toBe("thread-3");
    });
  });

  describe("social.postToFeed", () => {
    it("returns not-enabled when feed is null", async () => {
      ctx.getFeed = () => null;
      const tool = byName(createSocialTools(ctx), "social.postToFeed");
      const result = await tool.execute({
        contentHash: "a".repeat(64),
        topic: "b".repeat(64),
      });
      expect(result.isError).toBe(true);
    });

    it("validates hex format", async () => {
      const tool = byName(tools, "social.postToFeed");
      const result = await tool.execute({
        contentHash: "too-short",
        topic: "b".repeat(64),
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("contentHash");
    });

    it("calls feed.post with Uint8Array args", async () => {
      feed.post.mockResolvedValue("sig123");
      const tool = byName(tools, "social.postToFeed");
      await tool.execute({
        contentHash: "a".repeat(64),
        topic: "b".repeat(64),
      });
      expect(feed.post).toHaveBeenCalledTimes(1);
      const callArgs = feed.post.mock.calls[0][0];
      expect(callArgs.contentHash).toBeInstanceOf(Uint8Array);
      expect(callArgs.nonce).toBeInstanceOf(Uint8Array);
      expect(callArgs.nonce.length).toBe(32);
    });
  });

  describe("social.getReputation", () => {
    it("returns error when profile not found", async () => {
      discovery.getProfile.mockResolvedValue(null);
      const tool = byName(tools, "social.getReputation");
      const result = await tool.execute({
        agentPda: PublicKey.unique().toBase58(),
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("not found");
    });

    it("returns on-chain reputation", async () => {
      const pda = PublicKey.unique();
      const authority = PublicKey.unique();
      discovery.getProfile.mockResolvedValue({
        pda,
        authority,
        reputation: 8000,
        tasksCompleted: 50n,
        stake: 2_000_000_000n,
        status: 1,
        endpoint: "https://agent.local",
      });
      const tool = byName(tools, "social.getReputation");
      const result = await tool.execute({ agentPda: pda.toBase58() });
      const parsed = JSON.parse(result.content);
      expect(parsed.authority).toBe(authority.toBase58());
      expect(parsed.reputation).toBe(8000);
      expect(parsed.tasksCompleted).toBe("50");
    });

    it("resolves peer aliases for reputation lookups", async () => {
      const peer = makePeerEntry({ index: 3 });
      ctx.getPeerDirectory = () => [peer];
      tools = createSocialTools(ctx);
      discovery.getProfile.mockResolvedValue({
        pda: new PublicKey(peer.agentPda),
        authority: new PublicKey(peer.authority),
        reputation: 9000,
        tasksCompleted: 12n,
        stake: 2_000_000_000n,
        status: 1,
        endpoint: "https://agent.local",
      });

      const tool = byName(tools, "social.getReputation");
      const result = await tool.execute({ agentPda: "agent_3" });
      const parsed = JSON.parse(result.content);

      expect(discovery.getProfile).toHaveBeenCalledWith(
        new PublicKey(peer.agentPda),
      );
      expect(parsed.label).toBe("agent-3");
      expect(parsed.reputation).toBe(9000);
    });
  });

  describe("social.requestCollaboration", () => {
    it("returns not-enabled when collab is null", async () => {
      ctx.getCollaboration = () => null;
      const tool = byName(
        createSocialTools(ctx),
        "social.requestCollaboration",
      );
      const result = await tool.execute({
        title: "Team up",
        description: "Need help with task",
        requiredCapabilities: "1",
        maxMembers: 5,
      });
      expect(result.isError).toBe(true);
    });

    it("calls with correct CollaborationRequest shape", async () => {
      collab.requestCollaboration.mockResolvedValue("req-id-123");
      const tool = byName(tools, "social.requestCollaboration");
      await tool.execute({
        title: "Team up",
        description: "Need compute agents",
        requiredCapabilities: "3",
        maxMembers: 5,
        payoutMode: "weighted",
      });
      expect(collab.requestCollaboration).toHaveBeenCalledWith({
        title: "Team up",
        description: "Need compute agents",
        requiredCapabilities: 3n,
        maxMembers: 5,
        payoutModel: { mode: "weighted", roleWeights: { default: 1 } },
      });
    });
  });
});
