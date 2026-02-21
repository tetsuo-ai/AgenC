import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UnifiedTelemetryCollector, buildKey } from "./collector.js";
import type { TelemetrySink, TelemetryConfig } from "./types.js";

describe("buildKey", () => {
  it("returns name when no labels", () => {
    expect(buildKey("a.b")).toBe("a.b");
  });

  it("returns name when labels are empty", () => {
    expect(buildKey("a.b", {})).toBe("a.b");
  });

  it("appends sorted labels", () => {
    expect(buildKey("a.b", { z: "1", a: "2" })).toBe("a.b|a=2|z=1");
  });

  it("handles single label", () => {
    expect(buildKey("m", { k: "v" })).toBe("m|k=v");
  });
});

describe("UnifiedTelemetryCollector", () => {
  let collector: UnifiedTelemetryCollector;

  beforeEach(() => {
    collector = new UnifiedTelemetryCollector();
  });

  afterEach(() => {
    collector.destroy();
  });

  // ====== Counters ======

  it("increments counter without labels", () => {
    collector.counter("hits");
    collector.counter("hits");
    collector.counter("hits", 3);
    const snap = collector.getSnapshot();
    expect(snap.counters["hits"]).toBe(5);
  });

  it("increments counter with labels (composite key)", () => {
    collector.counter("hits", 1, { method: "get" });
    collector.counter("hits", 1, { method: "post" });
    collector.counter("hits", 2, { method: "get" });
    const snap = collector.getSnapshot();
    expect(snap.counters["hits|method=get"]).toBe(3);
    expect(snap.counters["hits|method=post"]).toBe(1);
  });

  it("incrementCounter is an alias for counter", () => {
    collector.incrementCounter("x", 5, { a: "b" });
    const snap = collector.getSnapshot();
    expect(snap.counters["x|a=b"]).toBe(5);
  });

  // ====== Gauges ======

  it("sets and overwrites gauge", () => {
    collector.gauge("queue", 10);
    collector.gauge("queue", 5);
    const snap = collector.getSnapshot();
    expect(snap.gauges["queue"]).toBe(5);
  });

  it("gauge with labels uses composite key", () => {
    collector.gauge("queue", 10, { endpoint: "a" });
    collector.gauge("queue", 20, { endpoint: "b" });
    const snap = collector.getSnapshot();
    expect(snap.gauges["queue|endpoint=a"]).toBe(10);
    expect(snap.gauges["queue|endpoint=b"]).toBe(20);
  });

  // ====== Bigint Gauges ======

  it("records bigint gauge", () => {
    collector.bigintGauge("earnings", 1_000_000_000n);
    const full = collector.getFullSnapshot();
    expect(full.bigintGauges["earnings"]).toBe("1000000000");
  });

  it("bigint gauge with labels", () => {
    collector.bigintGauge("stake", 500n, { agent: "a1" });
    const full = collector.getFullSnapshot();
    expect(full.bigintGauges["stake|agent=a1"]).toBe("500");
  });

  it("getSnapshot omits bigintGauges", () => {
    collector.bigintGauge("earnings", 100n);
    const snap = collector.getSnapshot();
    expect("bigintGauges" in snap).toBe(false);
  });

  // ====== Histograms ======

  it("records histogram entries", () => {
    collector.histogram("latency", 42, { endpoint: "a" });
    collector.histogram("latency", 55, { endpoint: "a" });
    const snap = collector.getSnapshot();
    const key = "latency|endpoint=a";
    expect(snap.histograms[key]).toHaveLength(2);
    expect(snap.histograms[key][0].value).toBe(42);
    expect(snap.histograms[key][1].value).toBe(55);
  });

  it("recordHistogram is an alias for histogram", () => {
    collector.recordHistogram("dur", 10);
    const snap = collector.getSnapshot();
    expect(snap.histograms["dur"]).toHaveLength(1);
  });

  it("recordTaskDuration prefixes with agenc.task.", () => {
    collector.recordTaskDuration("claim", 100);
    const snap = collector.getSnapshot();
    expect(snap.histograms["agenc.task.claim.duration_ms"]).toHaveLength(1);
    expect(snap.histograms["agenc.task.claim.duration_ms"][0].value).toBe(100);
  });

  it("evicts oldest histogram entries at max", () => {
    const small = new UnifiedTelemetryCollector({ maxHistogramEntries: 3 });
    for (let i = 0; i < 5; i++) {
      small.histogram("h", i);
    }
    const snap = small.getSnapshot();
    expect(snap.histograms["h"]).toHaveLength(3);
    expect(snap.histograms["h"][0].value).toBe(2);
    expect(snap.histograms["h"][2].value).toBe(4);
    small.destroy();
  });

  // ====== Snapshots ======

  it("getSnapshot includes timestamp", () => {
    const snap = collector.getSnapshot();
    expect(snap.timestamp).toBeGreaterThan(0);
  });

  it("getFullSnapshot includes all types", () => {
    collector.counter("c", 1);
    collector.gauge("g", 2);
    collector.bigintGauge("bg", 3n);
    collector.histogram("h", 4);
    const full = collector.getFullSnapshot();
    expect(full.counters["c"]).toBe(1);
    expect(full.gauges["g"]).toBe(2);
    expect(full.bigintGauges["bg"]).toBe("3");
    expect(full.histograms["h"]).toHaveLength(1);
    expect(full.timestamp).toBeGreaterThan(0);
  });

  // ====== Reset ======

  it("reset clears all data", () => {
    collector.counter("c", 5);
    collector.gauge("g", 10);
    collector.bigintGauge("bg", 100n);
    collector.histogram("h", 1);
    collector.reset();
    const full = collector.getFullSnapshot();
    expect(Object.keys(full.counters)).toHaveLength(0);
    expect(Object.keys(full.gauges)).toHaveLength(0);
    expect(Object.keys(full.bigintGauges)).toHaveLength(0);
    expect(Object.keys(full.histograms)).toHaveLength(0);
  });

  // ====== Sinks ======

  it("flush sends snapshot to all sinks", () => {
    const received: any[] = [];
    const sink1: TelemetrySink = {
      name: "s1",
      flush: (s) => received.push({ sink: "s1", s }),
    };
    const sink2: TelemetrySink = {
      name: "s2",
      flush: (s) => received.push({ sink: "s2", s }),
    };
    collector.addSink(sink1);
    collector.addSink(sink2);
    collector.counter("x", 1);
    collector.flush();
    expect(received).toHaveLength(2);
    expect(received[0].sink).toBe("s1");
    expect(received[0].s.counters["x"]).toBe(1);
    expect(received[1].sink).toBe("s2");
  });

  it("sink error does not throw from flush", () => {
    const errorSink: TelemetrySink = {
      name: "bad",
      flush: () => {
        throw new Error("sink fail");
      },
    };
    const goodReceived: any[] = [];
    const goodSink: TelemetrySink = {
      name: "good",
      flush: (s) => goodReceived.push(s),
    };
    collector.addSink(errorSink);
    collector.addSink(goodSink);
    collector.counter("y", 1);
    expect(() => collector.flush()).not.toThrow();
    expect(goodReceived).toHaveLength(1);
  });

  it("sinks from config are registered", () => {
    const received: any[] = [];
    const sink: TelemetrySink = { name: "cfg", flush: (s) => received.push(s) };
    const c = new UnifiedTelemetryCollector({ sinks: [sink] });
    c.counter("z", 1);
    c.flush();
    expect(received).toHaveLength(1);
    c.destroy();
  });

  // ====== Auto-flush timer ======

  it("auto-flush timer fires and can be destroyed", async () => {
    vi.useFakeTimers();
    const received: any[] = [];
    const sink: TelemetrySink = {
      name: "auto",
      flush: (s) => received.push(s),
    };
    const c = new UnifiedTelemetryCollector({
      flushIntervalMs: 100,
      sinks: [sink],
    });
    c.counter("a", 1);

    vi.advanceTimersByTime(100);
    expect(received).toHaveLength(1);

    c.counter("b", 2);
    vi.advanceTimersByTime(100);
    expect(received).toHaveLength(2);

    c.destroy();
    vi.advanceTimersByTime(200);
    expect(received).toHaveLength(2);

    vi.useRealTimers();
  });

  it("flush with no sinks is a no-op", () => {
    collector.counter("x", 1);
    expect(() => collector.flush()).not.toThrow();
  });
});
