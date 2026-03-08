import { describe, expect, it } from "vitest";

import {
  handleErrorResult,
  handleOkResult,
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
});
