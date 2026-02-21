import { describe, expect, it, vi } from "vitest";
import { TeamContractEngine } from "./engine.js";
import {
  TeamContractStateError,
  TeamContractValidationError,
} from "./errors.js";
import type { TeamAuditEvent } from "./types.js";
import type { TeamAuditStore, TeamTemplate } from "./index.js";

function makeTemplate(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: "planner-worker-reviewer",
    name: "Planner Worker Reviewer",
    roles: [
      { id: "planner", requiredCapabilities: 1n, minMembers: 1, maxMembers: 1 },
      { id: "worker", requiredCapabilities: 2n, minMembers: 1, maxMembers: 1 },
      {
        id: "reviewer",
        requiredCapabilities: 4n,
        minMembers: 1,
        maxMembers: 1,
      },
    ],
    checkpoints: [
      { id: "plan", roleId: "planner", label: "Plan" },
      { id: "build", roleId: "worker", label: "Build", dependsOn: ["plan"] },
      {
        id: "review",
        roleId: "reviewer",
        label: "Review",
        dependsOn: ["build"],
      },
    ],
    payout: {
      mode: "fixed",
      rolePayoutBps: {
        planner: 2_000,
        worker: 5_000,
        reviewer: 3_000,
      },
      roleFailurePenaltyBps: {
        worker: 5_000,
      },
    },
    ...overrides,
  };
}

class ThrowingAuditStore implements TeamAuditStore {
  append(_event: TeamAuditEvent): void {
    throw new Error("append failed");
  }

  list(_contractId: string): TeamAuditEvent[] {
    return [];
  }

  clear(_contractId: string): void {
    // no-op
  }
}

describe("TeamContractEngine", () => {
  it("enforces role eligibility and capacity constraints", () => {
    const engine = new TeamContractEngine();
    engine.createContract({
      contractId: "Contract-1",
      creatorId: "Creator-1",
      template: makeTemplate(),
    });

    expect(() =>
      engine.joinContract({
        contractId: "contract-1",
        member: {
          id: "member-a",
          capabilities: 1n,
          roles: ["worker"],
        },
      }),
    ).toThrow(TeamContractValidationError);

    engine.joinContract({
      contractId: "contract-1",
      member: {
        id: "worker-1",
        capabilities: 2n,
        roles: ["worker"],
      },
    });

    expect(() =>
      engine.joinContract({
        contractId: "contract-1",
        member: {
          id: "worker-2",
          capabilities: 2n,
          roles: ["worker"],
        },
      }),
    ).toThrow('role "worker" is full');
  });

  it("freezes roster mutations after start", () => {
    const engine = new TeamContractEngine();
    engine.createContract({
      contractId: "c2",
      creatorId: "creator",
      template: makeTemplate(),
    });

    engine.joinContract({
      contractId: "c2",
      member: { id: "p1", capabilities: 1n, roles: ["planner"] },
    });
    engine.joinContract({
      contractId: "c2",
      member: { id: "w1", capabilities: 2n, roles: ["worker"] },
    });
    engine.joinContract({
      contractId: "c2",
      member: { id: "r1", capabilities: 4n, roles: ["reviewer"] },
    });

    engine.startRun("c2");

    expect(() =>
      engine.joinContract({
        contractId: "c2",
        member: { id: "late", capabilities: 1n, roles: ["planner"] },
      }),
    ).toThrow("cannot join members");

    expect(() => engine.leaveContract("c2", "p1")).toThrow(
      "cannot leave members",
    );
    expect(() =>
      engine.assignRole({
        contractId: "c2",
        memberId: "w1",
        roleId: "planner",
      }),
    ).toThrow("cannot assign roles");
  });

  it("gates downstream checkpoints by dependency completion", () => {
    const engine = new TeamContractEngine();
    engine.createContract({
      contractId: "c3",
      creatorId: "creator",
      template: makeTemplate(),
    });

    engine.joinContract({
      contractId: "c3",
      member: { id: "p1", capabilities: 1n, roles: ["planner"] },
    });
    engine.joinContract({
      contractId: "c3",
      member: { id: "w1", capabilities: 2n, roles: ["worker"] },
    });
    engine.joinContract({
      contractId: "c3",
      member: { id: "r1", capabilities: 4n, roles: ["reviewer"] },
    });

    engine.startRun("c3");

    expect(() =>
      engine.completeCheckpoint({
        contractId: "c3",
        checkpointId: "build",
        memberId: "w1",
      }),
    ).toThrow("dependencies are not fully completed");

    engine.completeCheckpoint({
      contractId: "c3",
      checkpointId: "plan",
      memberId: "p1",
    });
    engine.completeCheckpoint({
      contractId: "c3",
      checkpointId: "build",
      memberId: "w1",
    });

    const snapshot = engine.getContract("c3");
    expect(snapshot?.checkpoints.review.status).toBe("ready");
  });

  it("propagates failure and isolates re-entrant hooks", () => {
    let capturedError: Error | null = null;
    const engine = new TeamContractEngine({
      hooks: {
        onRoleFailure: () => {
          try {
            engine.cancelContract({ contractId: "c4", reason: "should-fail" });
          } catch (error) {
            capturedError = error as Error;
          }
        },
      },
    });

    engine.createContract({
      contractId: "c4",
      creatorId: "creator",
      template: makeTemplate(),
    });

    engine.joinContract({
      contractId: "c4",
      member: { id: "p1", capabilities: 1n, roles: ["planner"] },
    });
    engine.joinContract({
      contractId: "c4",
      member: { id: "w1", capabilities: 2n, roles: ["worker"] },
    });
    engine.joinContract({
      contractId: "c4",
      member: { id: "r1", capabilities: 4n, roles: ["reviewer"] },
    });

    engine.startRun("c4");
    engine.failCheckpoint({
      contractId: "c4",
      checkpointId: "plan",
      memberId: "p1",
      reason: "planner output invalid",
    });

    const snapshot = engine.getContract("c4");
    expect(snapshot?.status).toBe("failed");
    expect(snapshot?.checkpoints.build.status).toBe("blocked");
    expect(snapshot?.checkpoints.review.status).toBe("blocked");
    expect(capturedError).toBeInstanceOf(TeamContractStateError);
  });

  it("finalize is idempotent and immutable", () => {
    const engine = new TeamContractEngine();
    engine.createContract({
      contractId: "c5",
      creatorId: "creator",
      template: makeTemplate(),
    });

    engine.joinContract({
      contractId: "c5",
      member: { id: "p1", capabilities: 1n, roles: ["planner"] },
    });
    engine.joinContract({
      contractId: "c5",
      member: { id: "w1", capabilities: 2n, roles: ["worker"] },
    });
    engine.joinContract({
      contractId: "c5",
      member: { id: "r1", capabilities: 4n, roles: ["reviewer"] },
    });

    engine.startRun("c5");
    engine.completeCheckpoint({
      contractId: "c5",
      checkpointId: "plan",
      memberId: "p1",
    });
    engine.completeCheckpoint({
      contractId: "c5",
      checkpointId: "build",
      memberId: "w1",
    });
    engine.completeCheckpoint({
      contractId: "c5",
      checkpointId: "review",
      memberId: "r1",
    });

    const first = engine.finalizePayout({
      contractId: "c5",
      totalRewardLamports: 1_000n,
    });
    const second = engine.finalizePayout({
      contractId: "c5",
      totalRewardLamports: 1_000n,
    });

    expect(second).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(() => {
      (first.rolePayouts as Record<string, bigint>).planner = 1n;
    }).toThrow();
  });

  it("rejects canonical ID collisions", () => {
    const engine = new TeamContractEngine();

    expect(() =>
      engine.createContract({
        contractId: "c6",
        creatorId: "creator",
        template: makeTemplate({
          roles: [
            {
              id: "Planner",
              requiredCapabilities: 1n,
              minMembers: 1,
              maxMembers: 1,
            },
            {
              id: "planner",
              requiredCapabilities: 1n,
              minMembers: 1,
              maxMembers: 1,
            },
          ],
        }),
      }),
    ).toThrow("duplicate role id after normalization");
  });

  it("uses best-effort audit logging and isolates audit hook errors", () => {
    const onAuditError = vi.fn(() => {
      throw new Error("hook failure");
    });

    const engine = new TeamContractEngine({
      auditStore: new ThrowingAuditStore(),
      hooks: { onAuditError },
    });

    expect(() =>
      engine.createContract({
        contractId: "c7",
        creatorId: "creator",
        template: makeTemplate(),
      }),
    ).not.toThrow();

    expect(onAuditError).toHaveBeenCalled();

    expect(() =>
      engine.joinContract({
        contractId: "c7",
        member: { id: "p1", capabilities: 1n, roles: ["planner"] },
      }),
    ).not.toThrow();
  });

  it("supports planner-worker-reviewer end-to-end lifecycle", () => {
    const engine = new TeamContractEngine();
    engine.createContract({
      contractId: "c8",
      creatorId: "creator",
      template: makeTemplate(),
    });

    engine.joinContract({
      contractId: "c8",
      member: { id: "planner-1", capabilities: 1n, roles: ["planner"] },
    });
    engine.joinContract({
      contractId: "c8",
      member: { id: "worker-1", capabilities: 2n, roles: ["worker"] },
    });
    engine.joinContract({
      contractId: "c8",
      member: { id: "reviewer-1", capabilities: 4n, roles: ["reviewer"] },
    });

    engine.startRun("c8");

    engine.completeCheckpoint({
      contractId: "c8",
      checkpointId: "plan",
      memberId: "planner-1",
    });
    engine.completeCheckpoint({
      contractId: "c8",
      checkpointId: "build",
      memberId: "worker-1",
    });
    engine.completeCheckpoint({
      contractId: "c8",
      checkpointId: "review",
      memberId: "reviewer-1",
    });

    const payout = engine.finalizePayout({
      contractId: "c8",
      totalRewardLamports: 1_000n,
    });
    expect(payout.memberPayouts["planner-1"]).toBe(200n);
    expect(payout.memberPayouts["worker-1"]).toBe(500n);
    expect(payout.memberPayouts["reviewer-1"]).toBe(300n);

    const snapshot = engine.getContract("c8");
    expect(snapshot?.status).toBe("completed");
  });
});
