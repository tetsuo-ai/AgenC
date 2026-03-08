import { describe, expect, it, vi } from "vitest";
import { BackgroundRunNotifier } from "./background-run-notifier.js";
import type { BackgroundRunOperatorSummary } from "./background-run-operator.js";

function makeSummary(overrides: Partial<BackgroundRunOperatorSummary> = {}): BackgroundRunOperatorSummary {
  return {
    runId: "bg-run-1",
    sessionId: "session-1",
    objective: "Watch the process until it exits.",
    state: "working",
    currentPhase: "active",
    explanation: "Run is active and waiting for the next verification cycle.",
    unsafeToContinue: false,
    createdAt: 1,
    updatedAt: 2,
    lastVerifiedAt: 2,
    nextCheckAt: 4_000,
    nextHeartbeatAt: 8_000,
    cycleCount: 1,
    contractKind: "until_condition",
    contractDomain: "managed_process",
    requiresUserStop: false,
    pendingSignals: 0,
    watchCount: 1,
    fenceToken: 1,
    lastUserUpdate: "Watching the process.",
    lastToolEvidence: "system.processStatus => running",
    lastWakeReason: "tool_result",
    carryForwardSummary: "Process is still running.",
    blockerSummary: undefined,
    approvalRequired: false,
    approvalState: "none",
    preferredWorkerId: "worker-a",
    workerAffinityKey: "session:session-1",
    checkpointAvailable: true,
    ...overrides,
  };
}

describe("BackgroundRunNotifier", () => {
  it("delivers generic webhook payloads for eligible run events", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 202 }));
    const notifier = new BackgroundRunNotifier({
      config: {
        enabled: true,
        sinks: [
          {
            id: "ops-webhook",
            type: "webhook",
            url: "https://example.com/hook",
          },
        ],
      },
      fetchImpl,
    });

    const deliveries = await notifier.notify({
      occurredAt: 123,
      internalEventType: "run_completed",
      summary: "Run completed cleanly.",
      run: makeSummary({ state: "completed" }),
    });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.eventType).toBe("run_completed");
    expect(body.run.runId).toBe("bg-run-1");
  });

  it("filters sinks by event and session scope", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new BackgroundRunNotifier({
      config: {
        enabled: true,
        sinks: [
          {
            id: "blocked-only",
            type: "webhook",
            url: "https://example.com/blocked",
            events: ["run_blocked"],
            sessionIds: ["session-2"],
          },
        ],
      },
      fetchImpl,
    });

    const deliveries = await notifier.notify({
      occurredAt: 456,
      internalEventType: "run_started",
      summary: "Run started.",
      run: makeSummary(),
    });

    expect(deliveries).toHaveLength(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("formats Slack and Discord webhook payloads", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new BackgroundRunNotifier({
      config: {
        enabled: true,
        sinks: [
          {
            id: "slack",
            type: "slack_webhook",
            url: "https://hooks.slack.test/a",
          },
          {
            id: "discord",
            type: "discord_webhook",
            url: "https://discord.test/a",
          },
        ],
      },
      fetchImpl,
    });

    await notifier.notify({
      occurredAt: 789,
      internalEventType: "run_blocked",
      summary: "Run is waiting for operator input.",
      run: makeSummary({
        state: "blocked",
        currentPhase: "blocked",
      }),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const slackBody = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body));
    const discordBody = JSON.parse(String((fetchImpl.mock.calls[1] as [string, RequestInit])[1].body));
    expect(slackBody.text).toContain("run_blocked");
    expect(discordBody.content).toContain("run_blocked");
  });

  it("adds HMAC signatures when signingSecret is configured", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const notifier = new BackgroundRunNotifier({
      config: {
        enabled: true,
        sinks: [
          {
            id: "signed",
            type: "webhook",
            url: "https://example.com/signed",
            signingSecret: "super-secret",
          },
        ],
      },
      fetchImpl,
    });

    await notifier.notify({
      occurredAt: 1_234,
      internalEventType: "run_failed",
      summary: "Run failed.",
      run: makeSummary({ state: "failed" }),
    });

    const headers = (fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>;
    expect(headers["x-agenc-signature"]).toMatch(/^sha256=/);
  });
});
