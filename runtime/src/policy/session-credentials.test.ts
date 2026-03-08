import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { SessionCredentialBroker } from "./session-credentials.js";
import type { RuntimePolicyConfig } from "./types.js";

const ORIGINAL_ENV = { ...process.env };

describe("SessionCredentialBroker", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("issues short-lived session leases and injects headers for matching policy-scoped credentials", async () => {
    process.env.AGENT_API_TOKEN = "secret-token";
    const issued = vi.fn();
    const broker = new SessionCredentialBroker({
      policy: {
        enabled: true,
        credentialCatalog: {
          api_token: {
            sourceEnvVar: "AGENT_API_TOKEN",
            domains: ["api.example.com"],
            headerTemplates: {
              Authorization: "Bearer ${secret}",
              "X-Token": "${secret}",
            },
            allowedTools: ["system.httpGet"],
            ttlMs: 30_000,
          },
        },
        tenantBundles: {
          tenant_a: {
            credentialAllowList: ["api_token"],
          },
        },
      } satisfies RuntimePolicyConfig,
      now: () => 1_700_000_000_000,
      onLeaseIssued: issued,
    });

    const prepared = broker.prepare({
      sessionId: "session-1",
      toolName: "system.httpGet",
      args: { url: "https://api.example.com/items" },
      scope: { tenantId: "tenant_a" },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok || !prepared.prepared) {
      throw new Error("expected prepared injection");
    }
    expect(prepared.prepared.preview).toEqual({
      credentialIds: ["api_token"],
      headerNames: ["Authorization", "X-Token"],
      domains: ["api.example.com"],
    });

    const injected = broker.inject({
      prepared: prepared.prepared,
      args: {
        url: "https://api.example.com/items",
        headers: { "X-Caller": "present" },
      },
      scope: { tenantId: "tenant_a" },
    });
    expect(injected.ok).toBe(true);
    if (!injected.ok) {
      throw new Error("expected injected args");
    }
    expect(injected.args.headers).toEqual({
      "X-Caller": "present",
      Authorization: "Bearer secret-token",
      "X-Token": "secret-token",
    });
    expect(broker.listLeases("session-1")).toHaveLength(1);
    expect(issued).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        credentialId: "api_token",
      }),
    );
  });

  it("returns a clear error when a policy credential references a missing environment variable", () => {
    delete process.env.AGENT_API_TOKEN;
    const broker = new SessionCredentialBroker({
      policy: {
        enabled: true,
        credentialCatalog: {
          api_token: {
            sourceEnvVar: "AGENT_API_TOKEN",
            domains: ["api.example.com"],
          },
        },
        credentialAllowList: ["api_token"],
      },
    });

    const prepared = broker.prepare({
      sessionId: "session-2",
      toolName: "system.httpGet",
      args: { url: "https://api.example.com/items" },
    });
    expect(prepared).toEqual({
      ok: false,
      error:
        'Session credential "api_token" is unavailable because env.AGENT_API_TOKEN is not set.',
    });
  });

  it("revokes active leases and reports them as inactive afterward", async () => {
    process.env.AGENT_API_TOKEN = "secret-token";
    const revoked = vi.fn();
    const broker = new SessionCredentialBroker({
      policy: {
        enabled: true,
        credentialCatalog: {
          api_token: {
            sourceEnvVar: "AGENT_API_TOKEN",
            domains: ["api.example.com"],
          },
        },
        credentialAllowList: ["api_token"],
      },
      now: () => 1_700_000_000_000,
      onLeaseRevoked: revoked,
    });

    const prepared = broker.prepare({
      sessionId: "session-3",
      toolName: "system.httpGet",
      args: { url: "https://api.example.com/items" },
    });
    if (!prepared.ok || !prepared.prepared) {
      throw new Error("expected prepared injection");
    }
    const injected = broker.inject({
      prepared: prepared.prepared,
      args: { url: "https://api.example.com/items" },
    });
    expect(injected.ok).toBe(true);
    expect(broker.listLeases("session-3")).toHaveLength(1);

    await expect(
      broker.revoke({
        sessionId: "session-3",
        credentialId: "api_token",
        reason: "manual",
      }),
    ).resolves.toBe(1);
    expect(broker.listLeases("session-3")).toHaveLength(0);
    expect(revoked).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-3",
        credentialId: "api_token",
        reason: "manual",
      }),
    );
  });

  it("keeps tenant-scoped credentials isolated between tenants", () => {
    process.env.AGENT_API_TOKEN = "secret-token";
    const broker = new SessionCredentialBroker({
      policy: {
        enabled: true,
        credentialCatalog: {
          api_token: {
            sourceEnvVar: "AGENT_API_TOKEN",
            domains: ["api.example.com"],
          },
        },
        tenantBundles: {
          tenant_a: {
            credentialAllowList: ["api_token"],
          },
          tenant_b: {
            credentialAllowList: [],
          },
        },
      },
    });

    const tenantA = broker.prepare({
      sessionId: "session-a",
      toolName: "system.httpGet",
      args: { url: "https://api.example.com/items" },
      scope: { tenantId: "tenant_a" },
    });
    const tenantB = broker.prepare({
      sessionId: "session-b",
      toolName: "system.httpGet",
      args: { url: "https://api.example.com/items" },
      scope: { tenantId: "tenant_b" },
    });

    expect(tenantA).toMatchObject({
      ok: true,
      prepared: {
        preview: {
          credentialIds: ["api_token"],
        },
      },
    });
    expect(tenantB).toEqual({ ok: true });
  });
});
