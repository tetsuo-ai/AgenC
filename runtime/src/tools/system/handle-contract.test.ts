import { describe, expect, it } from "vitest";

import {
  handleErrorResult,
  handleOkResult,
  normalizeResourceEnvelope,
  normalizeHandleIdentity,
} from "./handle-contract.js";

describe("structured handle contract helpers", () => {
  it("normalizes label/idempotencyKey aliases when they match", () => {
    expect(
      normalizeHandleIdentity("system_process", "worker-1", undefined),
    ).toEqual({ label: "worker-1", idempotencyKey: undefined });
    expect(
      normalizeHandleIdentity("system_process", undefined, "worker-1"),
    ).toEqual({ label: undefined, idempotencyKey: "worker-1" });
    expect(
      normalizeHandleIdentity("system_process", "worker-1", "worker-1"),
    ).toEqual({ label: "worker-1", idempotencyKey: "worker-1" });
  });

  it("preserves separate label and idempotencyKey values", () => {
    const result = normalizeHandleIdentity(
      "browser_session",
      "session-a",
      "session-b",
    );
    expect(result).toEqual({
      label: "session-a",
      idempotencyKey: "session-b",
    });
  });

  it("emits structured handle error envelopes", () => {
    const result = handleErrorResult(
      "system_process",
      "system_process.start_failed",
      "boom",
      true,
      { processId: "proc_1" },
      "start",
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"family":"system_process"');
    expect(result.content).toContain('"code":"system_process.start_failed"');
    expect(result.content).toContain('"kind":"start_failed"');
    expect(result.content).toContain('"operation":"start"');
    expect(result.content).toContain('"retryable":true');
    expect(result.content).toContain('"processId":"proc_1"');
  });

  it("emits safe JSON success envelopes", () => {
    const result = handleOkResult({ processId: "proc_1", state: "running" });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('"processId":"proc_1"');
    expect(result.content).toContain('"state":"running"');
  });

  it("normalizes resource envelopes", () => {
    expect(
      normalizeResourceEnvelope("system_server", {
        cpu: 1,
        memoryMb: 512,
        diskMb: 2048,
        network: "enabled",
        wallClockMs: 30_000,
        environmentClass: "host",
      }),
    ).toEqual({
      cpu: 1,
      memoryMb: 512,
      diskMb: 2048,
      network: "enabled",
      wallClockMs: 30_000,
      environmentClass: "host",
      enforcement: "best_effort",
    });
  });

  it("rejects invalid resource envelopes", () => {
    const result = normalizeResourceEnvelope("system_server", {
      network: "maybe",
    });
    expect(result).toMatchObject({
      isError: true,
    });
    expect((result as { content: string }).content).toContain(
      "system_server.invalid_resource_envelope",
    );
  });

  it("maps the shared structured error taxonomy consistently across families", () => {
    const cases = [
      { code: "browser_session.invalid_url", kind: "validation" },
      { code: "system_server.not_found", kind: "not_found" },
      { code: "system_research.idempotency_conflict", kind: "idempotency_conflict" },
      { code: "system_sandbox.label_conflict", kind: "label_conflict" },
      { code: "system_remote_job.url_blocked", kind: "permission_denied" },
      { code: "system_sandbox.launch_failed", kind: "environment_unavailable" },
      { code: "system_process.start_failed", kind: "start_failed" },
      { code: "system_server.stop_failed", kind: "stop_failed" },
      { code: "system_server.timeout", kind: "timeout" },
      { code: "system_research.internal_error", kind: "internal" },
    ] as const;

    for (const entry of cases) {
      const result = handleErrorResult("test_family", entry.code, "boom");
      const parsed = JSON.parse(result.content) as {
        error?: { kind?: string; code?: string };
      };
      expect(parsed.error?.code).toBe(entry.code);
      expect(parsed.error?.kind).toBe(entry.kind);
    }
  });
});
