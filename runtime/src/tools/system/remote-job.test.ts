import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { silentLogger } from "../../utils/logger.js";
import { runDurableHandleContractSuite } from "./handle-contract.test-utils.js";
import { createRemoteJobTools, SystemRemoteJobManager } from "./remote-job.js";

describe("system.remoteJob tools", () => {
  const cleanup: SystemRemoteJobManager[] = [];
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    while (cleanup.length > 0) {
      const manager = cleanup.pop()!;
      await manager.resetForTesting();
    }
  });

  function createManager(
    overrides?: Partial<ConstructorParameters<typeof SystemRemoteJobManager>[0]>,
  ): SystemRemoteJobManager {
    const rootDir = mkdtempSync(join(tmpdir(), "agenc-system-remote-job-test-"));
    const manager = new SystemRemoteJobManager({
      rootDir,
      logger: silentLogger,
      callbackBaseUrl: "http://127.0.0.1:3100",
      defaultPollTimeoutMs: 250,
      ...overrides,
    });
    cleanup.push(manager);
    return manager;
  }

  runDurableHandleContractSuite(() => {
    const manager = createManager();
    return {
      family: "system-remote-job",
      handleIdField: "jobHandleId",
      runningState: "running",
      terminalState: "cancelled",
      resourceEnvelope: {
        cpu: 1,
        memoryMb: 128,
        wallClockMs: 60_000,
        network: "enabled",
        enforcement: "best_effort",
      },
      buildStartArgs: ({ label, idempotencyKey }) => ({
        serverName: "remote-job-server",
        remoteJobId: "job-42",
        mode: "callback",
        label,
        idempotencyKey,
        resourceEnvelope: {
          cpu: 1,
          memoryMb: 128,
          wallClockMs: 60_000,
          network: "enabled",
        },
      }),
      buildStatusArgs: ({ label, idempotencyKey }) => ({
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      buildMissingStatusArgs: () => ({
        label: "missing-remote-job-handle",
      }),
      buildStopArgs: ({ handleId, label, idempotencyKey }) => ({
        ...(handleId ? { jobHandleId: handleId } : {}),
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      start: async (args) =>
        JSON.parse((await manager.start(args)).content) as Record<string, unknown>,
      status: async (args) =>
        JSON.parse((await manager.status(args)).content) as Record<string, unknown>,
      stop: async (args) =>
        JSON.parse((await manager.cancel(args)).content) as Record<string, unknown>,
    };
  });

  it("creates the five structured remote job tools", () => {
    const tools = createRemoteJobTools({
      rootDir: "/tmp/ignored",
      logger: silentLogger,
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.remoteJobStart",
      "system.remoteJobStatus",
      "system.remoteJobResume",
      "system.remoteJobCancel",
      "system.remoteJobArtifacts",
    ]);
  });

  it("accepts authenticated webhook callbacks and rejects replayed duplicates", async () => {
    const manager = createManager();
    const started = JSON.parse((await manager.start({
      serverName: "remote-job-server",
      remoteJobId: "job-99",
      mode: "callback",
      label: "remote-job-callback",
    })).content) as Record<string, unknown>;
    const callback = started.callback as {
      authToken: string;
      path: string;
    };

    expect(callback.path).toBe(`/webhooks/remote-job/${started.jobHandleId}`);
    expect(typeof callback.authToken).toBe("string");
    expect(callback.authToken.length).toBeGreaterThan(20);

    const accepted = await manager.handleWebhook({
      jobHandleId: String(started.jobHandleId),
      headers: {
        authorization: `Bearer ${callback.authToken}`,
        "x-agenc-event-id": "evt-1",
      },
      body: {
        state: "completed",
        summary: "Remote job finished successfully.",
        artifacts: [
          { kind: "report", locator: "/tmp/report.json", label: "result" },
        ],
      },
    });
    expect(accepted.status).toBe(202);

    const duplicate = await manager.handleWebhook({
      jobHandleId: String(started.jobHandleId),
      headers: {
        authorization: `Bearer ${callback.authToken}`,
        "x-agenc-event-id": "evt-1",
      },
      body: {
        state: "completed",
        summary: "Remote job finished successfully.",
      },
    });
    expect(duplicate.status).toBe(202);
    expect(duplicate.body).toMatchObject({ duplicate: true });

    const status = JSON.parse((await manager.status({
      jobHandleId: String(started.jobHandleId),
    })).content) as Record<string, unknown>;
    expect(status.state).toBe("completed");
    expect(status.progressSummary).toBe("Remote job finished successfully.");

    const artifacts = JSON.parse((await manager.artifacts({
      jobHandleId: String(started.jobHandleId),
    })).content) as Record<string, unknown>;
    expect(artifacts.artifacts).toEqual([
      expect.objectContaining({
        kind: "report",
        locator: "/tmp/report.json",
      }),
    ]);
  });

  it("refreshes poll-mode handles from the configured status endpoint", async () => {
    const manager = createManager();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          state: "completed",
          summary: "Remote polling confirmed completion.",
          artifacts: [
            { kind: "report", locator: "https://example.com/result.json" },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    const started = JSON.parse((await manager.start({
      serverName: "remote-job-server",
      remoteJobId: "job-poll-1",
      mode: "poll",
      statusUrl: "https://example.com/jobs/job-poll-1",
      cancelUrl: "https://example.com/jobs/job-poll-1/cancel",
      cancelMethod: "DELETE",
      label: "remote-job-poll",
    })).content) as Record<string, unknown>;

    const status = JSON.parse((await manager.status({
      jobHandleId: String(started.jobHandleId),
    })).content) as Record<string, unknown>;

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/jobs/job-poll-1",
      expect.objectContaining({ method: "GET" }),
    );
    expect(status.state).toBe("completed");
    expect(status.progressSummary).toBe("Remote polling confirmed completion.");
    expect(status.lastStatusCode).toBe(200);
    expect(status.artifactCount).toBe(1);
  });

  it("rejects webhook callbacks with invalid auth tokens", async () => {
    const manager = createManager();
    const started = JSON.parse((await manager.start({
      serverName: "remote-job-server",
      remoteJobId: "job-auth-1",
      mode: "callback",
      label: "remote-job-auth",
    })).content) as Record<string, unknown>;

    const rejected = await manager.handleWebhook({
      jobHandleId: String(started.jobHandleId),
      headers: {
        authorization: "Bearer wrong-token",
      },
      body: {
        state: "completed",
      },
    });

    expect(rejected.status).toBe(401);
    expect(rejected.body).toMatchObject({
      error: expect.objectContaining({
        kind: "permission_denied",
        code: "system_remote_job.permission_denied",
      }),
    });

    const status = JSON.parse((await manager.status({
      jobHandleId: String(started.jobHandleId),
    })).content) as Record<string, unknown>;
    expect(status.state).toBe("running");
  });

  it("blocks disallowed poll URLs with a structured permission error", async () => {
    const manager = createManager({
      blockedDomains: ["evil.example"],
    });

    const result = await manager.start({
      serverName: "remote-job-server",
      remoteJobId: "job-blocked-1",
      mode: "poll",
      statusUrl: "https://evil.example/jobs/job-blocked-1",
    });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content) as {
      error?: { kind?: string; code?: string };
    };
    expect(parsed.error?.kind).toBe("permission_denied");
    expect(parsed.error?.code).toBe("system_remote_job.url_blocked");
  });
});
