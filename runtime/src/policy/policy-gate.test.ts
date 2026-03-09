import { describe, expect, it, vi } from "vitest";
import { PolicyEngine } from "./engine.js";
import { createPolicyGateHook } from "./policy-gate.js";
import { silentLogger } from "../utils/logger.js";
import { InMemoryGovernanceAuditLog } from "./governance-audit-log.js";

describe("createPolicyGateHook", () => {
  const runBrowserSessionResumeCheck = async (
    policy: {
      enabled: boolean;
      networkAccess?: { allowHosts?: string[] };
      writeScope?: { allowRoots?: string[] };
    },
    actions: Array<Record<string, unknown>>,
  ) => {
    const hook = createPolicyGateHook({
      engine: new PolicyEngine({ policy }),
      logger: silentLogger,
    });

    return hook.handler({
      event: "tool:before",
      payload: {
        toolName: "system.browserSessionResume",
        args: {
          sessionId: "session-1",
          actions,
        },
      },
      logger: silentLogger,
      timestamp: Date.now(),
    });
  };

  it("blocks denied tools in enforcement mode", async () => {
    const hook = createPolicyGateHook({
      engine: new PolicyEngine({
        policy: {
          enabled: true,
          toolDenyList: ["system.delete"],
        },
      }),
      logger: silentLogger,
    });

    const result = await hook.handler({
      event: "tool:before",
      payload: {
        toolName: "system.delete",
        args: { target: "/tmp/file" },
      },
      logger: silentLogger,
      timestamp: Date.now(),
    });

    expect(result.continue).toBe(false);
    expect(result.payload).toMatchObject({
      blocked: true,
      reason: expect.stringContaining('Policy blocked tool "system.delete"'),
    });
  });

  it("allows denied tools in shadow mode and records the simulated violation", async () => {
    const logger = {
      ...silentLogger,
      warn: vi.fn(),
    };
    const auditLog = new InMemoryGovernanceAuditLog({
      signingKey: "shadow-signing-key",
      now: () => 1_700_000_000_000,
    });
    const hook = createPolicyGateHook({
      engine: new PolicyEngine({
        policy: {
          enabled: true,
          toolDenyList: ["system.delete"],
        },
      }),
      logger,
      simulationMode: "shadow",
      auditLog,
      resolveScope: () => ({
        tenantId: "tenant-a",
        runId: "run-1",
      }),
    });

    const result = await hook.handler({
      event: "tool:before",
      payload: {
        toolName: "system.delete",
        args: { target: "/tmp/file" },
      },
      logger: silentLogger,
      timestamp: Date.now(),
    });

    expect(result.continue).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Policy shadow violation for tool "system.delete"'),
    );
    await expect(auditLog.getAll()).resolves.toHaveLength(1);
    await expect(auditLog.getAll()).resolves.toContainEqual(
      expect.objectContaining({
      type: "policy.shadow_denied",
      subject: "system.delete",
      scope: {
        tenantId: "tenant-a",
        runId: "run-1",
      },
      }),
    );
  });

  it("reclassifies credential-backed HTTP calls as secret access", async () => {
    const hook = createPolicyGateHook({
      engine: new PolicyEngine({
        policy: {
          enabled: true,
          policyClassRules: {
            credential_secret_access: {
              deny: true,
            },
          },
        },
      }),
      logger: silentLogger,
    });

    const result = await hook.handler({
      event: "tool:before",
      payload: {
        toolName: "system.httpGet",
        args: { url: "https://api.example.com/v1/jobs" },
        credentialPreview: {
          credentialIds: ["api_token"],
          headerNames: ["Authorization"],
          domains: ["api.example.com"],
        },
      },
      logger: silentLogger,
      timestamp: Date.now(),
    });

    expect(result.continue).toBe(false);
    expect(result.payload).toMatchObject({
      blocked: true,
      reason: expect.stringContaining('Policy blocked tool "system.httpGet"'),
    });
  });

  it("blocks nested browser session navigation outside the allowed host set", async () => {
    const result = await runBrowserSessionResumeCheck(
      {
        enabled: true,
        networkAccess: {
          allowHosts: ["portal.example.com"],
        },
      },
      [
        {
          type: "navigate",
          url: "https://evil.example.com/upload",
        },
      ],
    );

    expect(result.continue).toBe(false);
    expect(result.payload).toMatchObject({
      blocked: true,
      reason: expect.stringContaining('Policy blocked tool "system.browserSessionResume"'),
    });
  });

  it("blocks nested browser session uploads outside allowed write roots", async () => {
    const result = await runBrowserSessionResumeCheck(
      {
        enabled: true,
        writeScope: {
          allowRoots: ["/srv/workspace"],
        },
      },
      [
        {
          type: "upload",
          selector: "#file",
          path: "/etc/passwd",
        },
      ],
    );

    expect(result.continue).toBe(false);
    expect(result.payload).toMatchObject({
      blocked: true,
      reason: expect.stringContaining('Policy blocked tool "system.browserSessionResume"'),
    });
  });
});
