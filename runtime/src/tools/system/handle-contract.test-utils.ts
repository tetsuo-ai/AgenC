import { describe, expect, it } from "vitest";

interface DurableHandleIdentity {
  readonly label: string;
  readonly idempotencyKey: string;
}

interface DurableHandleContractHarness {
  readonly family: string;
  readonly handleIdField: string;
  readonly runningState: string;
  readonly terminalState: string;
  buildStartArgs(identity: DurableHandleIdentity): Record<string, unknown>;
  buildStatusArgs(identity: Partial<DurableHandleIdentity>): Record<string, unknown>;
  buildStopArgs(identity: Partial<DurableHandleIdentity> & {
    readonly handleId?: string;
  }): Record<string, unknown>;
  start(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  status(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  stop(args: Record<string, unknown>): Promise<Record<string, unknown>>;
}

function nextIdentity(family: string, suffix: string): DurableHandleIdentity {
  return {
    label: `${family}-${suffix}-label`,
    idempotencyKey: `${family}-${suffix}-request`,
  };
}

export function runDurableHandleContractSuite(
  harnessFactory: () => DurableHandleContractHarness,
): void {
  describe("durable handle contract", () => {
    it("reuses duplicate idempotent starts", async () => {
      const harness = harnessFactory();
      const identity = nextIdentity(harness.family, "idempotent");

      const first = await harness.start(harness.buildStartArgs(identity));
      const second = await harness.start(harness.buildStartArgs(identity));

      expect(second[harness.handleIdField]).toBe(first[harness.handleIdField]);
      expect(second.reused).toBe(true);
      expect(second.state).toBe(harness.runningState);
    });

    it("resolves status by idempotencyKey when label differs", async () => {
      const harness = harnessFactory();
      const identity = nextIdentity(harness.family, "lookup");

      const started = await harness.start(harness.buildStartArgs(identity));
      const status = await harness.status(
        harness.buildStatusArgs({ idempotencyKey: identity.idempotencyKey }),
      );

      expect(started.label).toBe(identity.label);
      expect(started.idempotencyKey).toBe(identity.idempotencyKey);
      expect(status[harness.handleIdField]).toBe(started[harness.handleIdField]);
    });

    it("keeps stop idempotent after terminal transition", async () => {
      const harness = harnessFactory();
      const identity = nextIdentity(harness.family, "stop");

      const started = await harness.start(harness.buildStartArgs(identity));
      const firstStop = await harness.stop(
        harness.buildStopArgs({
          label: identity.label,
          handleId: String(started[harness.handleIdField]),
        }),
      );
      const secondStop = await harness.stop(
        harness.buildStopArgs({
          handleId: String(started[harness.handleIdField]),
        }),
      );

      expect(firstStop[harness.handleIdField]).toBe(started[harness.handleIdField]);
      expect(firstStop.state).toBe(harness.terminalState);
      expect(secondStop[harness.handleIdField]).toBe(started[harness.handleIdField]);
      expect(secondStop.state).toBe(harness.terminalState);
    });
  });
}
