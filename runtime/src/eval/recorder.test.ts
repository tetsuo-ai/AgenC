import { describe, it, expect } from "vitest";
import { Keypair } from "@solana/web3.js";
import { TrajectoryRecorder } from "./recorder.js";

describe("TrajectoryRecorder", () => {
  it("records deterministic sequence and timestamp ordering", () => {
    let now = 1000;
    const recorder = new TrajectoryRecorder({
      traceId: "trace-recorder",
      seed: 123,
      now: () => now++,
    });

    recorder.record({
      type: "discovered",
      taskPda: "task-1",
      payload: { rewardLamports: "100" },
    });
    recorder.record({
      type: "claimed",
      taskPda: "task-1",
      payload: { claimTx: "tx-1" },
    });

    const trace = recorder.createTrace();
    expect(trace.traceId).toBe("trace-recorder");
    expect(trace.seed).toBe(123);
    expect(trace.events).toHaveLength(2);
    expect(trace.events[0].seq).toBe(1);
    expect(trace.events[1].seq).toBe(2);
    expect(trace.events[0].timestampMs).toBe(1001);
    expect(trace.events[1].timestampMs).toBe(1002);
  });

  it("sanitizes non-JSON payload values", () => {
    const recorder = new TrajectoryRecorder({ traceId: "sanitize" });
    const publicKey = Keypair.generate().publicKey;

    recorder.record({
      type: "executed",
      taskPda: "task-2",
      payload: {
        amount: 9n,
        bytes: new Uint8Array([1, 2, 3]),
        account: publicKey,
      },
    });

    const event = recorder.createTrace().events[0];
    expect(event.payload.amount).toBe("9");
    expect(event.payload.bytes).toEqual([1, 2, 3]);
    expect(event.payload.account).toBe(publicKey.toBase58());
  });

  it("enforces max event limit", () => {
    const recorder = new TrajectoryRecorder({
      traceId: "limit",
      maxEvents: 1,
    });

    recorder.record({ type: "discovered", taskPda: "task-1" });
    expect(() =>
      recorder.record({ type: "claimed", taskPda: "task-1" }),
    ).toThrow("limit");
  });

  it("returns deep copies from createTrace/getEvents", () => {
    const recorder = new TrajectoryRecorder({ traceId: "copy-check" });
    recorder.record({
      type: "discovered",
      taskPda: "task-1",
      payload: { rewardLamports: "100" },
    });

    const events = recorder.getEvents();
    events[0].payload.rewardLamports = "999";

    const trace = recorder.createTrace();
    expect(trace.events[0].payload.rewardLamports).toBe("100");
  });

  it("supports disabled mode without recording side effects", () => {
    const recorder = new TrajectoryRecorder({
      traceId: "disabled",
      enabled: false,
    });

    const result = recorder.record({ type: "discovered", taskPda: "task-1" });
    expect(result).toBeNull();
    expect(recorder.size()).toBe(0);
    expect(recorder.createTrace().events).toHaveLength(0);
  });
});
