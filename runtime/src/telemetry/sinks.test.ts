import { describe, it, expect, vi } from "vitest";
import { ConsoleSink, CallbackSink } from "./sinks.js";
import type { TelemetrySnapshot } from "./types.js";
import type { Logger } from "../utils/logger.js";

function makeSnapshot(
  overrides?: Partial<TelemetrySnapshot>,
): TelemetrySnapshot {
  return {
    counters: {},
    gauges: {},
    bigintGauges: {},
    histograms: {},
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("ConsoleSink", () => {
  it("logs formatted output via logger.info", () => {
    const infoCalls: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: (msg: string) => {
        infoCalls.push(msg);
      },
      warn: () => {},
      error: () => {},
    };
    const sink = new ConsoleSink(logger);
    expect(sink.name).toBe("console");

    const snap = makeSnapshot({
      counters: { "a.b": 5 },
      gauges: { "g.x": 10 },
      bigintGauges: { "bg.y": "1000" },
      histograms: { "h.z": [{ value: 100, timestamp: Date.now() }] },
    });

    sink.flush(snap);
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]).toContain("a.b = 5");
    expect(infoCalls[0]).toContain("g.x = 10");
    expect(infoCalls[0]).toContain("bg.y = 1000");
    expect(infoCalls[0]).toContain("h.z");
  });

  it("handles empty snapshot", () => {
    const infoCalls: string[] = [];
    const logger: Logger = {
      debug: () => {},
      info: (msg: string) => {
        infoCalls.push(msg);
      },
      warn: () => {},
      error: () => {},
    };
    const sink = new ConsoleSink(logger);
    sink.flush(makeSnapshot());
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]).toContain("Counters (0)");
  });
});

describe("CallbackSink", () => {
  it("invokes callback with snapshot", () => {
    const received: TelemetrySnapshot[] = [];
    const sink = new CallbackSink((s) => received.push(s));
    expect(sink.name).toBe("callback");

    const snap = makeSnapshot({ counters: { x: 1 } });
    sink.flush(snap);
    expect(received).toHaveLength(1);
    expect(received[0].counters["x"]).toBe(1);
  });

  it("accepts custom name", () => {
    const sink = new CallbackSink(() => {}, "my-sink");
    expect(sink.name).toBe("my-sink");
  });

  it("callback error propagates (sinks are wrapped in collector)", () => {
    const sink = new CallbackSink(() => {
      throw new Error("fail");
    });
    expect(() => sink.flush(makeSnapshot())).toThrow("fail");
  });
});
