import { describe, expect, it } from "vitest";
import { InMemoryBackend } from "../memory/in-memory/backend.js";
import {
  InMemoryGovernanceAuditLog,
  MemoryBackedGovernanceAuditLog,
} from "./governance-audit-log.js";

describe("InMemoryGovernanceAuditLog", () => {
  it("appends signed records with a valid chain", async () => {
    const log = new InMemoryGovernanceAuditLog({
      signingKey: "super-secret-signing-key",
      now: () => 1_700_000_000_000,
    });

    await log.append({
      type: "approval.requested",
      actor: "alice",
      subject: "system.delete",
      payload: {
        secret: "value",
      },
    });
    await log.append({
      type: "approval.resolved",
      actor: "bob",
      subject: "system.delete",
      payload: {
        disposition: "yes",
      },
    });

    await expect(log.verify()).resolves.toEqual({
      valid: true,
      entries: 2,
      archivedEntries: 0,
      anchorPrevRecordHash: undefined,
    });
  });

  it("redacts configured actor, fields, and patterns before persistence", async () => {
    const log = new InMemoryGovernanceAuditLog({
      signingKey: "super-secret-signing-key",
      redaction: {
        redactActors: true,
        stripFields: ["payload.apiKey"],
        redactPatterns: ["sk-[a-z0-9]+"],
      },
      now: () => 1_700_000_000_000,
    });

    const record = await log.append({
      type: "policy.denied",
      actor: "alice",
      payload: {
        apiKey: "sk-secret",
        nested: {
          token: "sk-another",
        },
      },
    });

    expect(record.actor).toBe("[REDACTED]");
    expect(record.payload).toEqual({
      nested: {
        token: "[REDACTED]",
      },
    });
  });

  it("preserves a complete signed chain across all governance event types", async () => {
    const log = new InMemoryGovernanceAuditLog({
      signingKey: "super-secret-signing-key",
      now: () => 1_700_000_000_000,
    });

    await log.append({ type: "policy.denied", subject: "system.delete" });
    await log.append({ type: "policy.shadow_denied", subject: "system.httpGet" });
    await log.append({ type: "approval.requested", subject: "mcp.danger.tool" });
    await log.append({ type: "approval.escalated", subject: "mcp.danger.tool" });
    await log.append({ type: "approval.resolved", subject: "mcp.danger.tool" });
    await log.append({ type: "credential.issued", subject: "api_token" });
    await log.append({ type: "credential.revoked", subject: "api_token" });

    const exported = await log.exportRecords();
    expect(exported.activeRecords.map((record) => record.type)).toEqual([
      "policy.denied",
      "policy.shadow_denied",
      "approval.requested",
      "approval.escalated",
      "approval.resolved",
      "credential.issued",
      "credential.revoked",
    ]);
    await expect(log.verify()).resolves.toEqual({
      valid: true,
      entries: 7,
      archivedEntries: 0,
      anchorPrevRecordHash: undefined,
    });
  });

  it("archives pruned records when retentionMode=archive", async () => {
    let now = 1_700_000_000_000;
    const log = new InMemoryGovernanceAuditLog({
      signingKey: "super-secret-signing-key",
      maxEntries: 1,
      retentionMode: "archive",
      now: () => now,
    });

    await log.append({ type: "approval.requested", subject: "a" });
    now += 1;
    await log.append({ type: "approval.requested", subject: "b" });

    await expect(log.getAll()).resolves.toHaveLength(1);
    const exported = await log.exportRecords();
    expect(exported.activeRecords.map((entry) => entry.subject)).toEqual(["b"]);
    expect(exported.archivedRecords.map((entry) => entry.subject)).toEqual(["a"]);
  });
});

describe("MemoryBackedGovernanceAuditLog", () => {
  it("persists and reloads a verified audit chain", async () => {
    const backend = new InMemoryBackend();
    const log = await MemoryBackedGovernanceAuditLog.create({
      memoryBackend: backend,
      signingKey: "super-secret-signing-key",
      retentionMode: "archive",
      now: () => 1_700_000_000_000,
    });

    await log.append({
      type: "approval.requested",
      actor: "alice",
      subject: "system.delete",
      payload: { requestId: "req-1" },
    });
    await log.append({
      type: "approval.resolved",
      actor: "bob",
      subject: "system.delete",
      payload: { requestId: "req-1", disposition: "yes" },
    });

    const reloaded = await MemoryBackedGovernanceAuditLog.create({
      memoryBackend: backend,
      signingKey: "super-secret-signing-key",
      retentionMode: "archive",
      now: () => 1_700_000_000_100,
    });

    await expect(reloaded.verify()).resolves.toEqual({
      valid: true,
      entries: 2,
      archivedEntries: 0,
      anchorPrevRecordHash: undefined,
    });
    await expect(reloaded.getAll()).resolves.toHaveLength(2);
  });

  it("archives expired records under legal hold instead of deleting them", async () => {
    let now = 1_700_000_000_000;
    const backend = new InMemoryBackend();
    const log = await MemoryBackedGovernanceAuditLog.create({
      memoryBackend: backend,
      signingKey: "super-secret-signing-key",
      retentionMs: 10,
      legalHold: true,
      retentionMode: "delete",
      now: () => now,
    });

    await log.append({
      type: "approval.requested",
      subject: "system.delete",
      payload: { requestId: "req-1" },
    });
    now += 20;

    await expect(log.prune()).resolves.toBe(1);
    await expect(log.getAll()).resolves.toHaveLength(0);
    const exported = await log.exportRecords();
    expect(exported.archivedRecords).toHaveLength(1);
    expect(exported.legalHold).toBe(true);
  });

  it("rejects retention downgrades once legal hold or archive mode is persisted", async () => {
    const backend = new InMemoryBackend();
    const log = await MemoryBackedGovernanceAuditLog.create({
      memoryBackend: backend,
      signingKey: "super-secret-signing-key",
      retentionMode: "archive",
      legalHold: true,
      now: () => 1_700_000_000_000,
    });
    await log.append({
      type: "approval.requested",
      subject: "system.delete",
    });

    await expect(
      MemoryBackedGovernanceAuditLog.create({
        memoryBackend: backend,
        signingKey: "super-secret-signing-key",
        retentionMode: "delete",
        legalHold: false,
        now: () => 1_700_000_000_100,
      }),
    ).rejects.toThrow(/immutable|downgraded/i);
  });
});
