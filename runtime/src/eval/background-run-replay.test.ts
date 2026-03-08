import { describe, expect, it } from "vitest";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import { AGENT_RUN_SCHEMA_VERSION } from "../gateway/agent-run-contract.js";
import { BackgroundRunStore } from "../gateway/background-run-store.js";
import { replayBackgroundRunFromStore } from "./background-run-replay.js";

describe("background-run replay", () => {
  it("reconstructs timing and verifier data from persisted events", async () => {
    const store = new BackgroundRunStore({
      memoryBackend: new InMemoryBackend(),
    });

    await store.saveRecentSnapshot({
      version: AGENT_RUN_SCHEMA_VERSION,
      runId: "bg-replay",
      sessionId: "session-replay",
      objective: "Replay the background run.",
      state: "completed",
      contractKind: "finite",
      requiresUserStop: false,
      cycleCount: 1,
      createdAt: 1,
      updatedAt: 5,
      lastVerifiedAt: 4,
      nextCheckAt: undefined,
      nextHeartbeatAt: undefined,
      lastUserUpdate: "Completed.",
      lastToolEvidence: undefined,
      lastWakeReason: "timer",
      pendingSignals: 0,
      carryForwardSummary: "Completed.",
      blockerSummary: undefined,
      watchCount: 0,
      fenceToken: 1,
    });
    await store.appendEvent({ id: "bg-replay", sessionId: "session-replay" }, {
      type: "run_started",
      summary: "started",
      timestamp: 1,
    });
    await store.appendEvent({ id: "bg-replay", sessionId: "session-replay" }, {
      type: "user_update",
      summary: "ack",
      timestamp: 2,
      data: { kind: "ack", verified: false },
    });
    await store.appendEvent({ id: "bg-replay", sessionId: "session-replay" }, {
      type: "user_update",
      summary: "verified",
      timestamp: 4,
      data: { kind: "verified_update", verified: true },
    });
    await store.appendEvent({ id: "bg-replay", sessionId: "session-replay" }, {
      type: "run_completed",
      summary: "done",
      timestamp: 5,
    });

    const replay = await replayBackgroundRunFromStore({
      store,
      sessionId: "session-replay",
    });

    expect(replay.timeToFirstAckMs).toBeGreaterThanOrEqual(0);
    expect(replay.timeToFirstVerifiedUpdateMs).toBeGreaterThanOrEqual(0);
    expect(replay.falseCompletion).toBe(false);
    expect(replay.replayConsistent).toBe(true);
  });
});
