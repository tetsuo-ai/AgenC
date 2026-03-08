import { describe, expect, it } from "vitest";
import { mergePolicyBundles, resolvePolicyContext } from "./bundles.js";
import type { RuntimePolicyConfig } from "./types.js";

describe("policy bundles", () => {
  it("merges overlays with restrictive semantics", () => {
    const merged = mergePolicyBundles(
      {
        enabled: true,
        toolAllowList: ["system.readFile", "system.processStart"],
        toolDenyList: ["system.delete"],
        actionBudgets: {
          "tool_call:*": { limit: 10, windowMs: 60_000 },
        },
        maxRiskScore: 0.8,
        policyClassRules: {
          destructive_side_effect: { maxRiskScore: 0.7 },
        },
      },
      {
        enabled: true,
        toolAllowList: ["system.processStart"],
        toolDenyList: ["system.processStop"],
        networkAccess: {
          allowHosts: ["api.internal.example.com"],
          denyHosts: ["blocked.example.com"],
        },
        writeScope: {
          allowRoots: ["/srv/workspace"],
          denyRoots: ["/srv/workspace/secrets"],
        },
        actionBudgets: {
          "tool_call:*": { limit: 5, windowMs: 120_000 },
        },
        maxRiskScore: 0.5,
        policyClassRules: {
          destructive_side_effect: { deny: true },
        },
      },
    );

    expect(merged.toolAllowList).toEqual(["system.processStart"]);
    expect(merged.toolDenyList).toEqual([
      "system.delete",
      "system.processStop",
    ]);
    expect(merged.networkAccess).toEqual({
      allowHosts: ["api.internal.example.com"],
      denyHosts: ["blocked.example.com"],
    });
    expect(merged.writeScope).toEqual({
      allowRoots: ["/srv/workspace"],
      denyRoots: ["/srv/workspace/secrets"],
    });
    expect(merged.actionBudgets?.["tool_call:*"]).toEqual({
      limit: 5,
      windowMs: 120_000,
    });
    expect(merged.maxRiskScore).toBe(0.5);
    expect(merged.policyClassRules?.destructive_side_effect).toEqual({
      deny: true,
      maxRiskScore: 0.7,
    });
  });

  it("resolves tenant and project overlays on top of the global bundle", () => {
    const policy: RuntimePolicyConfig = {
      enabled: true,
      toolAllowList: ["system.readFile", "system.processStart"],
      tenantBundles: {
        tenant_a: {
          toolAllowList: ["system.processStart"],
        },
      },
      projectBundles: {
        project_x: {
          toolDenyList: ["system.processStart"],
        },
      },
    };

    const resolved = resolvePolicyContext(policy, {
      tenantId: "tenant_a",
      projectId: "project_x",
    });

    expect(resolved.tenantId).toBe("tenant_a");
    expect(resolved.projectId).toBe("project_x");
    expect(resolved.policy.toolAllowList).toEqual(["system.processStart"]);
    expect(resolved.policy.toolDenyList).toEqual(["system.processStart"]);
  });
});
