import { describe, it, expect, vi } from "vitest";
import type { VerifierVerdictPayload } from "./types.js";
import { VerifierExecutor, VerifierLaneEscalationError } from "./verifier.js";
import { createTask } from "./test-utils.js";

function passVerdict(confidence = 0.95): VerifierVerdictPayload {
  return {
    verdict: "pass",
    confidence,
    reasons: [{ code: "ok", message: "Looks good" }],
  };
}

describe("VerifierExecutor", () => {
  it("skips verifier when policy disables gating", async () => {
    const executeTask = vi.fn(async () => [1n, 2n]);
    const verify = vi.fn(async () => passVerdict());

    const lane = new VerifierExecutor({
      verifierConfig: {
        verifier: { verify },
        policy: { enabled: false },
      },
      executeTask,
    });

    const result = await lane.execute(createTask());
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(0);
    expect(result.revisions).toBe(0);
    expect(verify).not.toHaveBeenCalled();
  });

  it("passes on first verifier success", async () => {
    const executeTask = vi.fn(async () => [3n, 4n]);
    const verify = vi.fn(async () => passVerdict(0.91));

    const lane = new VerifierExecutor({
      verifierConfig: { verifier: { verify } },
      executeTask,
    });

    const result = await lane.execute(createTask());
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.revisions).toBe(0);

    const metrics = lane.getMetrics();
    expect(metrics.checks).toBe(1);
    expect(metrics.passes).toBe(1);
    expect(metrics.disagreements).toBe(0);
  });

  it("revises and passes when verifier requests revision", async () => {
    const executeTask = vi.fn(async () => [11n, 22n]);
    const reviseTask = vi.fn(async () => [33n, 44n]);
    const verify = vi
      .fn()
      .mockResolvedValueOnce({
        verdict: "needs_revision",
        confidence: 0.35,
        reasons: [{ code: "format", message: "Output shape mismatch" }],
      } satisfies VerifierVerdictPayload)
      .mockResolvedValueOnce(passVerdict(0.88));

    const lane = new VerifierExecutor({
      verifierConfig: {
        verifier: { verify },
        maxVerificationRetries: 2,
      },
      executeTask,
      reviseTask,
    });

    const result = await lane.execute(createTask());
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.revisions).toBe(1);
    expect(result.output).toEqual([33n, 44n]);
    expect(reviseTask).toHaveBeenCalledTimes(1);

    const metrics = lane.getMetrics();
    expect(metrics.needsRevision).toBe(1);
    expect(metrics.revisions).toBe(1);
    expect(metrics.disagreements).toBe(1);
  });

  it("escalates when needs_revision is returned but revision is unavailable", async () => {
    const executeTask = vi.fn(async () => [7n, 8n]);
    const verify = vi.fn(async () => ({
      verdict: "needs_revision",
      confidence: 0.2,
      reasons: [{ code: "bad", message: "Needs targeted edit" }],
    }));

    const lane = new VerifierExecutor({
      verifierConfig: { verifier: { verify } },
      executeTask,
    });

    await expect(lane.execute(createTask())).rejects.toMatchObject({
      name: "VerifierLaneEscalationError",
      metadata: expect.objectContaining({ reason: "revision_unavailable" }),
    });
    expect(executeTask).toHaveBeenCalledTimes(1);
  });

  it("escalates after bounded retries are exhausted", async () => {
    const executeTask = vi.fn(async () => [5n, 6n]);
    const verify = vi.fn(async () => ({
      verdict: "fail",
      confidence: 0.1,
      reasons: [
        { code: "incorrect", message: "Result does not satisfy rubric" },
      ],
    }));

    const lane = new VerifierExecutor({
      verifierConfig: {
        verifier: { verify },
        maxVerificationRetries: 1,
      },
      executeTask,
    });

    await expect(lane.execute(createTask())).rejects.toMatchObject({
      name: "VerifierLaneEscalationError",
      metadata: expect.objectContaining({
        reason: "verifier_failed",
        attempts: 2,
        revisions: 1,
      }),
    });

    expect(executeTask).toHaveBeenCalledTimes(2);
  });

  it("enforces verification time budget", async () => {
    const executeTask = vi.fn(async () => [1n]);
    const verify = vi.fn(
      async () => await new Promise<VerifierVerdictPayload>(() => {}),
    );

    const lane = new VerifierExecutor({
      verifierConfig: {
        verifier: { verify },
        maxVerificationDurationMs: 10,
      },
      executeTask,
    });

    await expect(lane.execute(createTask())).rejects.toMatchObject({
      name: "VerifierLaneEscalationError",
      metadata: expect.objectContaining({ reason: "verifier_timeout" }),
    });
  });

  it("retries verifier errors when failOnVerifierError=false", async () => {
    const executeTask = vi.fn(async () => [1n]);
    const verify = vi
      .fn()
      .mockRejectedValueOnce(new Error("critic transport failed"))
      .mockResolvedValueOnce(passVerdict(0.9));

    const lane = new VerifierExecutor({
      verifierConfig: {
        verifier: { verify },
        maxVerificationRetries: 1,
        failOnVerifierError: false,
      },
      executeTask,
    });

    const result = await lane.execute(createTask());
    expect(result.passed).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.history[0].verdict).toBe("fail");
    expect(result.history[0].reasons[0].code).toBe("verifier_error");
  });

  it("uses task-type policy override to enable verifier lane", () => {
    const executeTask = vi.fn(async () => [1n]);
    const verify = vi.fn(async () => passVerdict());

    const lane = new VerifierExecutor({
      verifierConfig: {
        verifier: { verify },
        policy: {
          enabled: false,
          taskTypePolicies: {
            2: { enabled: true },
          },
        },
      },
      executeTask,
    });

    expect(lane.shouldVerify(createTask({ taskType: 2 }))).toBe(true);
    expect(lane.shouldVerify(createTask({ taskType: 1 }))).toBe(false);
  });

  it("publishes verdict callbacks for each attempt", async () => {
    const executeTask = vi.fn(async () => [2n]);
    const verify = vi
      .fn()
      .mockResolvedValueOnce({
        verdict: "fail",
        confidence: 0.2,
        reasons: [{ code: "first_fail", message: "Bad output" }],
      } satisfies VerifierVerdictPayload)
      .mockResolvedValueOnce(passVerdict(0.92));
    const onVerdict = vi.fn();

    const lane = new VerifierExecutor({
      verifierConfig: {
        verifier: { verify },
        maxVerificationRetries: 1,
      },
      executeTask,
      onVerdict,
    });

    const result = await lane.execute(createTask());
    expect(result.passed).toBe(true);
    expect(onVerdict).toHaveBeenCalledTimes(2);
    expect(onVerdict.mock.calls[0][2]).toBe(1);
    expect(onVerdict.mock.calls[1][2]).toBe(2);
  });

  it("throws typed escalation error for inspection", async () => {
    const executeTask = vi.fn(async () => [1n]);
    const verify = vi.fn(async () => ({
      verdict: "fail",
      confidence: 0,
      reasons: [{ code: "never", message: "Never pass" }],
    }));

    const lane = new VerifierExecutor({
      verifierConfig: { verifier: { verify }, maxVerificationRetries: 0 },
      executeTask,
    });

    try {
      await lane.execute(createTask());
      throw new Error("expected VerifierLaneEscalationError");
    } catch (error) {
      expect(error).toBeInstanceOf(VerifierLaneEscalationError);
      const typed = error as VerifierLaneEscalationError;
      expect(typed.metadata.reason).toBe("verifier_failed");
      expect(typed.metadata.attempts).toBe(1);
      expect(typed.history).toHaveLength(1);
    }
  });
});
