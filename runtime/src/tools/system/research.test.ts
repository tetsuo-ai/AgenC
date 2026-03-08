import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { silentLogger } from "../../utils/logger.js";
import { runDurableHandleContractSuite } from "./handle-contract.test-utils.js";
import { createResearchTools, SystemResearchManager } from "./research.js";

describe("system.research tools", () => {
  const cleanup: SystemResearchManager[] = [];

  afterEach(async () => {
    while (cleanup.length > 0) {
      const manager = cleanup.pop()!;
      await manager.resetForTesting();
    }
  });

  function createManager(): SystemResearchManager {
    const rootDir = mkdtempSync(join(tmpdir(), "agenc-system-research-test-"));
    const manager = new SystemResearchManager({
      rootDir,
      logger: silentLogger,
    });
    cleanup.push(manager);
    return manager;
  }

  runDurableHandleContractSuite(() => {
    const manager = createManager();
    return {
      family: "system-research",
      handleIdField: "researchId",
      runningState: "running",
      terminalState: "cancelled",
      resourceEnvelope: {
        cpu: 1,
        memoryMb: 128,
        wallClockMs: 120_000,
        environmentClass: "research",
        enforcement: "best_effort",
      },
      buildStartArgs: ({ label, idempotencyKey }) => ({
        objective: "Research durable supervisor patterns.",
        sources: ["https://example.com/spec"],
        label,
        idempotencyKey,
        resourceEnvelope: {
          cpu: 1,
          memoryMb: 128,
          wallClockMs: 120_000,
          environmentClass: "research",
        },
      }),
      buildStatusArgs: ({ label, idempotencyKey }) => ({
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      buildMissingStatusArgs: () => ({
        label: "missing-research-handle",
      }),
      buildStopArgs: ({ handleId, label, idempotencyKey }) => ({
        ...(handleId ? { researchId: handleId } : {}),
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }),
      start: async (args) =>
        JSON.parse((await manager.start(args)).content) as Record<string, unknown>,
      status: async (args) =>
        JSON.parse((await manager.status(args)).content) as Record<string, unknown>,
      stop: async (args) =>
        JSON.parse((await manager.stop(args)).content) as Record<string, unknown>,
    };
  });

  it("creates the eight structured research tools", () => {
    const tools = createResearchTools({
      rootDir: "/tmp/ignored",
      logger: silentLogger,
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.researchStart",
      "system.researchStatus",
      "system.researchResume",
      "system.researchUpdate",
      "system.researchComplete",
      "system.researchBlock",
      "system.researchArtifacts",
      "system.researchStop",
    ]);
  });

  it("tracks research progress, block state, and final artifacts", async () => {
    const manager = createManager();
    const started = JSON.parse((await manager.start({
      objective: "Compare durable runtime architectures.",
      label: "research-runtime",
      sources: ["https://example.com/runtime-rfc"],
    })).content) as Record<string, unknown>;

    const blocked = JSON.parse((await manager.block({
      researchId: String(started.researchId),
      blockedReason: "Need a second primary source.",
      progressSummary: "Blocked waiting on another source.",
    })).content) as Record<string, unknown>;
    expect(blocked.state).toBe("blocked");
    expect(blocked.verifierState).toBe("blocked");
    expect(blocked.blockedReason).toBe("Need a second primary source.");

    const updated = JSON.parse((await manager.update({
      researchId: String(started.researchId),
      state: "running",
      verifierState: "verifying",
      progressSummary: "Comparing the second source now.",
      sources: ["https://example.com/runtime-evals"],
      artifacts: [
        {
          kind: "note",
          locator: "/tmp/research-notes.md",
          label: "notes",
        },
      ],
    })).content) as Record<string, unknown>;
    expect(updated.state).toBe("running");
    expect(updated.verifierState).toBe("verifying");
    expect(updated.artifactCount).toBe(1);

    const completed = JSON.parse((await manager.complete({
      researchId: String(started.researchId),
      progressSummary: "Research report completed.",
      artifacts: [
        {
          kind: "report",
          locator: "/tmp/research-report.md",
          label: "report",
        },
      ],
    })).content) as Record<string, unknown>;
    expect(completed.state).toBe("completed");
    expect(completed.verifierState).toBe("verified");

    const artifacts = JSON.parse((await manager.artifacts({
      researchId: String(started.researchId),
    })).content) as Record<string, unknown>;
    expect(artifacts.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "note",
          locator: "/tmp/research-notes.md",
        }),
        expect.objectContaining({
          kind: "report",
          locator: "/tmp/research-report.md",
        }),
      ]),
    );
  });
});
