import { describe, expect, it } from "vitest";
import {
  artifactContractSatisfied,
  assertValidBackgroundRunLineage,
  assertValidDurableSubrunSpec,
  buildSubrunSessionId,
  summarizeNestedBudget,
} from "./subrun-contract.js";

describe("subrun-contract", () => {
  it("validates durable subrun specs and session ids", () => {
    expect(() =>
      assertValidDurableSubrunSpec({
        objective: "Gather evidence for the failing job.",
        role: "worker",
        scope: {
          allowedTools: ["system.processStatus", "system.httpGet"],
          allowedWriteRoots: ["/tmp"],
          allowedHosts: ["example.com"],
        },
        artifactContract: {
          requiredKinds: ["log"],
          minArtifactCount: 1,
          summaryRequired: true,
        },
        budget: {
          maxRuntimeMs: 30_000,
          maxTokens: 1_000,
          maxToolCalls: 6,
          maxChildren: 2,
        },
      }),
    ).not.toThrow();

    expect(
      buildSubrunSessionId({
        parentSessionId: "session-parent",
        role: "critic",
        index: 2,
      }),
    ).toBe("subrun:session-parent:critic:2");
  });

  it("rejects invalid subrun scopes, budgets, and lineage", () => {
    expect(() =>
      assertValidDurableSubrunSpec({
        objective: "bad",
        role: "worker",
        scope: { allowedTools: [] },
        artifactContract: { requiredKinds: [] },
        budget: { maxRuntimeMs: 1 },
      }),
    ).toThrow(/allowedTools/i);

    expect(() =>
      assertValidBackgroundRunLineage({
        rootRunId: "root",
        role: "worker",
        depth: -1,
        scope: { allowedTools: ["system.processStatus"] },
        artifactContract: { requiredKinds: [] },
        budget: { maxRuntimeMs: 10_000 },
        childRunIds: [],
      }),
    ).toThrow(/depth/i);
  });

  it("checks artifact contract satisfaction and nested budget totals", () => {
    expect(
      artifactContractSatisfied({
        artifacts: [
          {
            kind: "log",
            locator: "/tmp/job.log",
            source: "system.processStatus",
            observedAt: 1,
          },
          {
            kind: "file",
            locator: "/tmp/report.json",
            source: "system.processStatus",
            observedAt: 1,
          },
        ],
        artifactContract: {
          requiredKinds: ["log", "file"],
          minArtifactCount: 2,
          summaryRequired: true,
        },
        carryForwardSummary: "Worker captured the requested artifacts.",
      }),
    ).toBe(true);

    expect(
      summarizeNestedBudget([
        {
          rootRunId: "root",
          parentRunId: "parent",
          role: "worker",
          depth: 1,
          scope: { allowedTools: ["system.processStatus"] },
          artifactContract: { requiredKinds: ["log"] },
          budget: {
            maxRuntimeMs: 10_000,
            maxTokens: 200,
            maxToolCalls: 4,
            maxChildren: 1,
          },
          childRunIds: [],
        },
        {
          rootRunId: "root",
          parentRunId: "parent",
          role: "verifier",
          depth: 1,
          scope: { allowedTools: ["system.processStatus"] },
          artifactContract: { requiredKinds: [] },
          budget: {
            maxRuntimeMs: 5_000,
            maxTokens: 120,
            maxToolCalls: 2,
            maxChildren: 0,
          },
          childRunIds: [],
        },
      ]),
    ).toEqual({
      maxRuntimeMs: 15_000,
      maxTokens: 320,
      maxToolCalls: 6,
      maxChildren: 1,
    });
  });
});
