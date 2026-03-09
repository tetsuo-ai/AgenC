import { describe, expect, it } from "vitest";

import type { MemoryBackend } from "../memory/types.js";
import {
  buildSessionStatefulOptions,
  clearWebSessionRuntimeState,
  hydrateWebSessionRuntimeState,
  persistWebSessionRuntimeState,
} from "./daemon-session-state.js";
import {
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  type Session,
} from "./session.js";

function createSession(metadata: Record<string, unknown> = {}): Session {
  return {
    id: "session:test",
    workspaceId: "default",
    history: [],
    createdAt: 0,
    lastActiveAt: 0,
    metadata,
  };
}

function createMemoryBackendStub(): MemoryBackend {
  const kv = new Map<string, unknown>();
  return {
    name: "stub",
    addEntry: async () => {
      throw new Error("not implemented");
    },
    getThread: async () => [],
    query: async () => [],
    deleteThread: async () => 0,
    listSessions: async () => [],
    set: async (key: string, value: unknown) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    get: async <T = unknown>(key: string) => {
      const value = kv.get(key);
      return value === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(value)) as T);
    },
    delete: async (key: string) => kv.delete(key),
    has: async (key: string) => kv.has(key),
    listKeys: async (prefix?: string) =>
      [...kv.keys()].filter((key) => !prefix || key.startsWith(prefix)),
    getDurability: () => ({
      level: "sync",
      supportsFlush: true,
      description: "test",
    }),
    flush: async () => {},
    clear: async () => {
      kv.clear();
    },
    close: async () => {},
    healthCheck: async () => true,
  };
}

describe("buildSessionStatefulOptions", () => {
  it("returns undefined when no stateful session metadata is present", () => {
    expect(buildSessionStatefulOptions(createSession())).toBeUndefined();
  });

  it("returns the stateful continuation options for stored anchors", () => {
    expect(
      buildSessionStatefulOptions(
        createSession({
          [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: {
            previousResponseId: "resp-123",
            reconciliationHash: "hash-123",
          },
          [SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY]: true,
        }),
      ),
    ).toEqual({
      resumeAnchor: {
        previousResponseId: "resp-123",
        reconciliationHash: "hash-123",
      },
      historyCompacted: true,
    });
  });

  it("ignores malformed anchors while preserving trusted compaction state", () => {
    expect(
      buildSessionStatefulOptions(
        createSession({
          [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: {
            previousResponseId: "   ",
          },
          [SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY]: true,
        }),
      ),
    ).toEqual({
      historyCompacted: true,
    });
  });
});

describe("web session runtime state helpers", () => {
  it("clears persisted runtime state during explicit session resets", async () => {
    const memoryBackend = createMemoryBackendStub();

    await persistWebSessionRuntimeState(
      memoryBackend,
      "web-session-1",
      createSession({
        [SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY]: {
          previousResponseId: "resp-123",
          reconciliationHash: "hash-123",
        },
      }),
    );

    await clearWebSessionRuntimeState(memoryBackend, "web-session-1");

    const hydrated = createSession();
    await hydrateWebSessionRuntimeState(
      memoryBackend,
      "web-session-1",
      hydrated,
    );

    expect(hydrated.metadata).toEqual({});
  });
});
