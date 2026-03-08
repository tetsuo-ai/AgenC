import { describe, expect, it } from "vitest";
import { InMemoryBackend } from "../../memory/in-memory/backend.js";
import { WebChatSessionStore } from "./session-store.js";

describe("WebChatSessionStore", () => {
  it("creates a durable session record and indexes it by owner", async () => {
    const backend = new InMemoryBackend();
    const store = new WebChatSessionStore({ memoryBackend: backend });

    await store.ensureSession({
      sessionId: "session-1",
      ownerKey: "web:browser-1",
      createdAt: 100,
    });

    expect(await store.loadSession("session-1")).toMatchObject({
      sessionId: "session-1",
      ownerKey: "web:browser-1",
      label: "New conversation",
      messageCount: 0,
    });
    expect(await store.listSessionsForOwner("web:browser-1")).toHaveLength(1);
  });

  it("tracks label, activity time, and message count across user/agent turns", async () => {
    const backend = new InMemoryBackend();
    const store = new WebChatSessionStore({ memoryBackend: backend });

    await store.recordActivity({
      sessionId: "session-2",
      ownerKey: "web:browser-2",
      sender: "user",
      content: "Check the deployment logs for errors",
      timestamp: 200,
    });
    await store.recordActivity({
      sessionId: "session-2",
      ownerKey: "web:browser-2",
      sender: "agent",
      content: "Still checking in the background.",
      timestamp: 250,
    });

    expect(await store.loadSession("session-2")).toMatchObject({
      label: "Check the deployment logs for errors",
      messageCount: 2,
      lastActiveAt: 250,
    });
  });

  it("persists policy context metadata for durable session scope", async () => {
    const backend = new InMemoryBackend();
    const store = new WebChatSessionStore({ memoryBackend: backend });

    await store.ensureSession({
      sessionId: "session-3",
      ownerKey: "web:browser-3",
      createdAt: 300,
      metadata: {
        policyContext: {
          tenantId: "tenant-a",
          projectId: "project-x",
        },
      },
    });
    await store.recordActivity({
      sessionId: "session-3",
      ownerKey: "web:browser-3",
      sender: "user",
      content: "hello",
      timestamp: 350,
    });

    expect(await store.loadSession("session-3")).toMatchObject({
      metadata: {
        policyContext: {
          tenantId: "tenant-a",
          projectId: "project-x",
        },
      },
    });
  });
});
