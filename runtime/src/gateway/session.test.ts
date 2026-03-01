import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  SessionManager,
  deriveSessionId,
  type SessionConfig,
  type SessionCompactionHookPayload,
  type SessionLookupParams,
  type Summarizer,
} from "./session.js";
import type { LLMMessage } from "../llm/types.js";

function makeConfig(overrides?: Partial<SessionConfig>): SessionConfig {
  return {
    scope: "per-channel-peer",
    reset: { mode: "never" },
    compaction: "truncate",
    ...overrides,
  };
}

function makeParams(
  overrides?: Partial<SessionLookupParams>,
): SessionLookupParams {
  return {
    channel: "general",
    senderId: "user-1",
    scope: "group",
    workspaceId: "ws-1",
    ...overrides,
  };
}

function msg(role: LLMMessage["role"], content: string): LLMMessage {
  return { role, content };
}

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager(makeConfig());
  });

  // --- getOrCreate ---------------------------------------------------------

  describe("getOrCreate", () => {
    it("creates new session when none exists", () => {
      const session = manager.getOrCreate(makeParams());
      expect(session).toBeDefined();
      expect(session.id).toMatch(/^session:/);
      expect(session.history).toEqual([]);
      expect(session.workspaceId).toBe("ws-1");
      expect(session.createdAt).toBeGreaterThan(0);
      expect(manager.count).toBe(1);
    });

    it("returns existing session for same params", () => {
      const first = manager.getOrCreate(makeParams());
      const second = manager.getOrCreate(makeParams());
      expect(first).toBe(second);
      expect(manager.count).toBe(1);
    });
  });

  // --- deriveSessionId -----------------------------------------------------

  describe("deriveSessionId", () => {
    it("'main' scope returns same ID within a workspace", () => {
      const id1 = deriveSessionId(
        makeParams({ senderId: "a", channel: "x" }),
        "main",
      );
      const id2 = deriveSessionId(
        makeParams({ senderId: "b", channel: "y" }),
        "main",
      );
      expect(id1).toBe(id2);
      expect(id1).toMatch(/^session:/);
    });

    it("includes workspace scope in all derived IDs", () => {
      const id1 = deriveSessionId(
        makeParams({ workspaceId: "ws-a", senderId: "alice" }),
        "per-peer",
      );
      const id2 = deriveSessionId(
        makeParams({ workspaceId: "ws-b", senderId: "alice" }),
        "per-peer",
      );
      expect(id1).not.toBe(id2);
    });

    it("'per-peer' groups by senderId", () => {
      const id1 = deriveSessionId(
        makeParams({ senderId: "alice", channel: "x" }),
        "per-peer",
      );
      const id2 = deriveSessionId(
        makeParams({ senderId: "alice", channel: "y" }),
        "per-peer",
      );
      const id3 = deriveSessionId(
        makeParams({ senderId: "bob", channel: "x" }),
        "per-peer",
      );

      expect(id1).toBe(id2); // same sender, different channel
      expect(id1).not.toBe(id3); // different sender

      const expected =
        "session:" + createHash("sha256").update("ws-1\x00alice").digest("hex");
      expect(id1).toBe(expected);
    });

    it("'per-channel-peer' differentiates by channel+sender", () => {
      const id1 = deriveSessionId(
        makeParams({ channel: "ch1", senderId: "alice" }),
        "per-channel-peer",
      );
      const id2 = deriveSessionId(
        makeParams({ channel: "ch2", senderId: "alice" }),
        "per-channel-peer",
      );
      const id3 = deriveSessionId(
        makeParams({ channel: "ch1", senderId: "bob" }),
        "per-channel-peer",
      );

      expect(id1).not.toBe(id2);
      expect(id1).not.toBe(id3);

      const expected =
        "session:" +
        createHash("sha256")
          .update("ws-1\x00ch1\x00alice")
          .digest("hex");
      expect(id1).toBe(expected);
    });

    it("'per-account-channel-peer' differentiates by all fields", () => {
      const base = {
        channel: "ch",
        senderId: "alice",
        guildId: "g1",
        threadId: "t1",
      };
      const id1 = deriveSessionId(makeParams(base), "per-account-channel-peer");
      const id2 = deriveSessionId(
        makeParams({ ...base, guildId: "g2" }),
        "per-account-channel-peer",
      );
      const id3 = deriveSessionId(
        makeParams({ ...base, threadId: "t2" }),
        "per-account-channel-peer",
      );

      expect(id1).not.toBe(id2);
      expect(id1).not.toBe(id3);

      const expected =
        "session:" +
        createHash("sha256")
          .update("ws-1\x00ch\x00alice\x00g1\x00t1")
          .digest("hex");
      expect(id1).toBe(expected);
    });
  });

  // --- reset ---------------------------------------------------------------

  describe("reset", () => {
    it("clears history but preserves metadata", () => {
      const session = manager.getOrCreate(makeParams());
      session.history.push(msg("user", "hello"));
      session.metadata.key = "value";

      const result = manager.reset(session.id);
      expect(result).toBe(true);
      expect(session.history).toEqual([]);
      expect(session.metadata.key).toBe("value");
    });

    it("returns false for unknown session", () => {
      expect(manager.reset("nonexistent")).toBe(false);
    });
  });

  // --- destroy -------------------------------------------------------------

  describe("destroy", () => {
    it("removes session completely", () => {
      const session = manager.getOrCreate(makeParams());
      expect(manager.count).toBe(1);

      const result = manager.destroy(session.id);
      expect(result).toBe(true);
      expect(manager.get(session.id)).toBeUndefined();
      expect(manager.count).toBe(0);
    });

    it("returns false for unknown session", () => {
      expect(manager.destroy("nonexistent")).toBe(false);
    });
  });

  // --- appendMessage -------------------------------------------------------

  describe("appendMessage", () => {
    it("adds message to history", () => {
      const session = manager.getOrCreate(makeParams());
      manager.appendMessage(session.id, msg("user", "hi"));
      expect(session.history).toHaveLength(1);
      expect(session.history[0].content).toBe("hi");
    });

    it("triggers compaction when exceeding maxHistoryLength", async () => {
      const mgr = new SessionManager(
        makeConfig({ maxHistoryLength: 5, compaction: "truncate" }),
      );
      const session = mgr.getOrCreate(makeParams());

      for (let i = 0; i < 6; i++) {
        mgr.appendMessage(session.id, msg("user", `msg-${i}`));
      }

      // appendMessage compaction is async (fire-and-forget)
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Truncate keeps last half (ceil(6/2)=3)
      expect(session.history.length).toBeLessThanOrEqual(5);
    });

    it("returns false for unknown session", () => {
      expect(manager.appendMessage("nonexistent", msg("user", "hi"))).toBe(
        false,
      );
    });
  });

  // --- compact -------------------------------------------------------------

  describe("compact", () => {
    it("'truncate' drops oldest messages", async () => {
      const mgr = new SessionManager(makeConfig({ compaction: "truncate" }));
      const session = mgr.getOrCreate(makeParams());
      for (let i = 0; i < 10; i++) {
        session.history.push(msg("user", `m${i}`));
      }

      const result = await mgr.compact(session.id);
      expect(result).not.toBeNull();
      expect(result!.messagesRemoved).toBe(5);
      expect(result!.messagesRetained).toBe(5);
      expect(result!.summaryGenerated).toBe(false);
      expect(session.history[0].content).toBe("m5");
    });

    it("'sliding-window' keeps last N + summary placeholder", async () => {
      const mgr = new SessionManager(
        makeConfig({ compaction: "sliding-window" }),
      );
      const session = mgr.getOrCreate(makeParams());
      for (let i = 0; i < 10; i++) {
        session.history.push(msg("user", `m${i}`));
      }

      const result = await mgr.compact(session.id);
      expect(result).not.toBeNull();
      expect(result!.messagesRemoved).toBe(5);
      // 5 kept + 1 summary = 6
      expect(result!.messagesRetained).toBe(6);
      expect(result!.summaryGenerated).toBe(false); // no summarizer
      expect(session.history[0].role).toBe("system");
      expect(session.history[0].content).toContain(
        "5 earlier messages removed",
      );
    });

    it("'summarize' with summarizer calls callback", async () => {
      const summarizer: Summarizer = vi
        .fn()
        .mockResolvedValue("m0 m1 m2 m3 decisions and learnings");
      const mgr = new SessionManager(makeConfig({ compaction: "summarize" }), {
        summarizer,
      });
      const session = mgr.getOrCreate(makeParams());
      for (let i = 0; i < 10; i++) {
        session.history.push(msg("user", `m${i}`));
      }

      const result = await mgr.compact(session.id);
      expect(result).not.toBeNull();
      expect(result!.summaryGenerated).toBe(true);
      expect(result!.summaryQuality).toBe("accepted");
      expect(summarizer).toHaveBeenCalledOnce();
      expect(session.history[0].role).toBe("system");
      expect(session.history[0].content).toContain("decisions");
    });

    it("'summarize' without summarizer falls back to truncate", async () => {
      const mgr = new SessionManager(makeConfig({ compaction: "summarize" }));
      const session = mgr.getOrCreate(makeParams());
      for (let i = 0; i < 10; i++) {
        session.history.push(msg("user", `m${i}`));
      }

      const result = await mgr.compact(session.id);
      expect(result).not.toBeNull();
      expect(result!.summaryGenerated).toBe(false);
      expect(result!.messagesRemoved).toBe(5);
      expect(session.history).toHaveLength(5);
      // Should be truncation — no system summary message
      expect(session.history[0].content).toBe("m5");
    });

    it("returns null for unknown session", async () => {
      expect(await manager.compact("nonexistent")).toBeNull();
    });

    it("propagates summarizer errors", async () => {
      const summarizer: Summarizer = vi
        .fn()
        .mockRejectedValue(new Error("LLM failed"));
      const mgr = new SessionManager(makeConfig({ compaction: "summarize" }), {
        summarizer,
      });
      const session = mgr.getOrCreate(makeParams());
      for (let i = 0; i < 10; i++) {
        session.history.push(msg("user", `m${i}`));
      }

      await expect(mgr.compact(session.id)).rejects.toThrow("LLM failed");
    });

    it("emits compaction hook events before and after compaction", async () => {
      const events: SessionCompactionHookPayload[] = [];
      const mgr = new SessionManager(makeConfig({ compaction: "truncate" }), {
        compactionHook: async (payload) => {
          events.push(payload);
        },
      });
      const session = mgr.getOrCreate(makeParams());
      for (let i = 0; i < 8; i++) {
        session.history.push(msg("user", `m${i}`));
      }

      const result = await mgr.compact(session.id);

      expect(result).not.toBeNull();
      expect(events).toHaveLength(2);
      expect(events[0]?.phase).toBe("before");
      expect(events[1]?.phase).toBe("after");
      expect(events[1]?.result?.messagesRemoved).toBe(4);
      expect(events[1]?.historyLengthBefore).toBe(8);
      expect(events[1]?.historyLengthAfter).toBe(4);
    });

    it("emits an error hook event when compaction fails", async () => {
      const events: SessionCompactionHookPayload[] = [];
      const summarizer: Summarizer = vi
        .fn()
        .mockRejectedValue(new Error("LLM failed"));
      const mgr = new SessionManager(makeConfig({ compaction: "summarize" }), {
        summarizer,
        compactionHook: async (payload) => {
          events.push(payload);
        },
      });
      const session = mgr.getOrCreate(makeParams());
      for (let i = 0; i < 8; i++) {
        session.history.push(msg("user", `m${i}`));
      }

      await expect(mgr.compact(session.id)).rejects.toThrow("LLM failed");
      expect(events[0]?.phase).toBe("before");
      expect(events[1]?.phase).toBe("error");
      expect(events[1]?.error).toContain("LLM failed");
    });
  });

  // --- checkResets ---------------------------------------------------------

  describe("checkResets", () => {
    it("'idle' mode resets sessions exceeding idle timeout", () => {
      const mgr = new SessionManager(
        makeConfig({
          reset: { mode: "idle", idleMinutes: 60 },
        }),
      );
      const session = mgr.getOrCreate(makeParams());
      session.history.push(msg("user", "hi"));

      // Simulate idle by backdating lastActiveAt
      session.lastActiveAt = Date.now() - 61 * 60_000;

      const resetIds = mgr.checkResets();
      expect(resetIds).toContain(session.id);
      expect(session.history).toEqual([]);
    });

    it("'daily' mode resets sessions after daily hour", () => {
      vi.useFakeTimers();
      try {
        // Set clock to 2025-06-15 10:00 UTC (well past 4 AM reset hour)
        const fakeNow = new Date("2025-06-15T10:00:00Z");
        vi.setSystemTime(fakeNow);

        const mgr = new SessionManager(
          makeConfig({
            reset: { mode: "daily", dailyHour: 4 },
          }),
        );
        const session = mgr.getOrCreate(makeParams());
        session.history.push(msg("user", "hi"));

        // Set last activity to yesterday 3 AM (before today's 4 AM reset)
        const yesterday = new Date("2025-06-14T03:00:00Z");
        session.lastActiveAt = yesterday.getTime();

        const resetIds = mgr.checkResets();
        expect(resetIds).toContain(session.id);
        expect(session.history).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("'never' mode never resets", () => {
      const mgr = new SessionManager(makeConfig({ reset: { mode: "never" } }));
      const session = mgr.getOrCreate(makeParams());
      session.history.push(msg("user", "hi"));
      session.lastActiveAt = 0; // very old

      const resetIds = mgr.checkResets();
      expect(resetIds).toEqual([]);
      expect(session.history).toHaveLength(1);
    });

    it("'weekday' mode resets on new weekday", () => {
      vi.useFakeTimers();
      try {
        // 2025-06-18 is a Wednesday (day 3)
        vi.setSystemTime(new Date("2025-06-18T12:00:00Z"));

        const mgr = new SessionManager(
          makeConfig({ reset: { mode: "weekday" } }),
        );
        const session = mgr.getOrCreate(makeParams());
        session.history.push(msg("user", "hi"));

        // Set last activity to Tuesday (day 2) — different weekday
        session.lastActiveAt = new Date("2025-06-17T12:00:00Z").getTime();

        const resetIds = mgr.checkResets();
        expect(resetIds).toContain(session.id);
        expect(session.history).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --- listActive ----------------------------------------------------------

  describe("listActive", () => {
    it("returns all sessions with correct info", () => {
      const params1 = makeParams({ senderId: "alice", channel: "ch1" });
      const params2 = makeParams({ senderId: "bob", channel: "ch2" });
      const s1 = manager.getOrCreate(params1);
      const s2 = manager.getOrCreate(params2);
      s1.history.push(msg("user", "hi"));

      const list = manager.listActive();
      expect(list).toHaveLength(2);

      const info1 = list.find((i) => i.id === s1.id)!;
      expect(info1.channel).toBe("ch1");
      expect(info1.senderId).toBe("alice");
      expect(info1.messageCount).toBe(1);

      const info2 = list.find((i) => i.id === s2.id)!;
      expect(info2.channel).toBe("ch2");
      expect(info2.senderId).toBe("bob");
      expect(info2.messageCount).toBe(0);
    });
  });

  // --- config overrides ----------------------------------------------------

  describe("config overrides", () => {
    it("per-channel overrides take precedence", () => {
      const mgr = new SessionManager(
        makeConfig({
          scope: "per-peer",
          channelOverrides: {
            "special-channel": { scope: "per-channel-peer" },
          },
        }),
      );

      const params = makeParams({
        channel: "special-channel",
        senderId: "alice",
      });
      const session = mgr.getOrCreate(params);

      // Should use per-channel-peer scope from channel override
      const expectedId = deriveSessionId(params, "per-channel-peer");
      expect(session.id).toBe(expectedId);
    });

    it("per-scope overrides apply for dm/group/thread", () => {
      const mgr = new SessionManager(
        makeConfig({
          scope: "per-peer",
          overrides: {
            dm: { scope: "main" },
          },
        }),
      );

      const dmParams = makeParams({ scope: "dm" });
      const session = mgr.getOrCreate(dmParams);

      // DM override changes scope to 'main'
      const expected = deriveSessionId(dmParams, "main");
      expect(session.id).toBe(expected);
    });

    it("channel-level override can replace nested scope overrides", () => {
      const mgr = new SessionManager(
        makeConfig({
          scope: "per-peer",
          overrides: {
            dm: { scope: "main" },
          },
          channelOverrides: {
            "special-channel": {
              overrides: {
                dm: { scope: "per-peer" },
              },
            },
          },
        }),
      );

      const params = makeParams({
        channel: "special-channel",
        scope: "dm",
        senderId: "alice",
      });
      const session = mgr.getOrCreate(params);

      expect(session.id).toBe(deriveSessionId(params, "per-peer"));
    });
  });

  // --- count ---------------------------------------------------------------

  describe("count", () => {
    it("returns correct session count", () => {
      expect(manager.count).toBe(0);
      manager.getOrCreate(makeParams({ senderId: "a" }));
      expect(manager.count).toBe(1);
      manager.getOrCreate(makeParams({ senderId: "b" }));
      expect(manager.count).toBe(2);
      // Same params — no new session
      manager.getOrCreate(makeParams({ senderId: "a" }));
      expect(manager.count).toBe(2);
    });
  });

  describe("summary quality checks", () => {
    it("rejects low-information summaries and falls back to truncation", async () => {
      const summarizer: Summarizer = vi
        .fn()
        .mockResolvedValue("ok");
      const mgr = new SessionManager(makeConfig({ compaction: "summarize" }), {
        summarizer,
      });
      const session = mgr.getOrCreate(makeParams());
      for (let i = 0; i < 10; i++) {
        session.history.push(msg("user", `important-m${i}`));
      }

      const result = await mgr.compact(session.id);
      expect(result).not.toBeNull();
      expect(result!.summaryGenerated).toBe(false);
      expect(result!.summaryQuality).toBe("rejected");
      expect(session.history[0].content).toBe("important-m5");
    });

    it("truncates oversize summaries to bounded length", async () => {
      const summarizer: Summarizer = vi.fn().mockResolvedValue(
        `important decision context ${"x".repeat(2000)}`,
      );
      const mgr = new SessionManager(makeConfig({ compaction: "summarize" }), {
        summarizer,
      });
      const session = mgr.getOrCreate(makeParams());
      for (let i = 0; i < 10; i++) {
        session.history.push(msg("user", `important-${i}`));
      }

      const result = await mgr.compact(session.id);
      expect(result).not.toBeNull();
      expect(result!.summaryGenerated).toBe(true);
      expect(result!.summaryChars).toBeLessThanOrEqual(800);
      expect((session.history[0].content ?? "").length).toBeLessThanOrEqual(800);
    });
  });
});
