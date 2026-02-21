import { describe, it, expect } from "vitest";
import {
  Capability,
  ALL_CAPABILITIES,
  ALL_CAPABILITY_NAMES,
  combineCapabilities,
  hasCapability,
  hasAllCapabilities,
  hasAnyCapability,
  getCapabilityNames,
  parseCapabilities,
  formatCapabilities,
  countCapabilities,
  type CapabilityName,
} from "./capabilities.js";

describe("Capability Constants", () => {
  it("matches on-chain state.rs values (lines 16-27)", () => {
    // These values must match programs/agenc-coordination/src/state.rs
    expect(Capability.COMPUTE).toBe(1n << 0n);
    expect(Capability.INFERENCE).toBe(1n << 1n);
    expect(Capability.STORAGE).toBe(1n << 2n);
    expect(Capability.NETWORK).toBe(1n << 3n);
    expect(Capability.SENSOR).toBe(1n << 4n);
    expect(Capability.ACTUATOR).toBe(1n << 5n);
    expect(Capability.COORDINATOR).toBe(1n << 6n);
    expect(Capability.ARBITER).toBe(1n << 7n);
    expect(Capability.VALIDATOR).toBe(1n << 8n);
    expect(Capability.AGGREGATOR).toBe(1n << 9n);
  });

  it("has exactly 10 capabilities", () => {
    expect(ALL_CAPABILITIES.length).toBe(10);
    expect(ALL_CAPABILITY_NAMES.length).toBe(10);
  });

  it("ALL_CAPABILITIES contains all values", () => {
    expect(ALL_CAPABILITIES).toContain(Capability.COMPUTE);
    expect(ALL_CAPABILITIES).toContain(Capability.INFERENCE);
    expect(ALL_CAPABILITIES).toContain(Capability.STORAGE);
    expect(ALL_CAPABILITIES).toContain(Capability.NETWORK);
    expect(ALL_CAPABILITIES).toContain(Capability.SENSOR);
    expect(ALL_CAPABILITIES).toContain(Capability.ACTUATOR);
    expect(ALL_CAPABILITIES).toContain(Capability.COORDINATOR);
    expect(ALL_CAPABILITIES).toContain(Capability.ARBITER);
    expect(ALL_CAPABILITIES).toContain(Capability.VALIDATOR);
    expect(ALL_CAPABILITIES).toContain(Capability.AGGREGATOR);
  });

  it("ALL_CAPABILITY_NAMES contains all names", () => {
    expect(ALL_CAPABILITY_NAMES).toContain("COMPUTE");
    expect(ALL_CAPABILITY_NAMES).toContain("INFERENCE");
    expect(ALL_CAPABILITY_NAMES).toContain("STORAGE");
    expect(ALL_CAPABILITY_NAMES).toContain("NETWORK");
    expect(ALL_CAPABILITY_NAMES).toContain("SENSOR");
    expect(ALL_CAPABILITY_NAMES).toContain("ACTUATOR");
    expect(ALL_CAPABILITY_NAMES).toContain("COORDINATOR");
    expect(ALL_CAPABILITY_NAMES).toContain("ARBITER");
    expect(ALL_CAPABILITY_NAMES).toContain("VALIDATOR");
    expect(ALL_CAPABILITY_NAMES).toContain("AGGREGATOR");
  });
});

describe("combineCapabilities", () => {
  it("combines multiple capabilities with bitwise OR", () => {
    const caps = combineCapabilities(Capability.COMPUTE, Capability.INFERENCE);
    expect(caps).toBe(3n);
  });

  it("returns 0n for no capabilities", () => {
    expect(combineCapabilities()).toBe(0n);
  });

  it("handles single capability", () => {
    expect(combineCapabilities(Capability.STORAGE)).toBe(4n);
  });

  it("combines all capabilities", () => {
    const all = combineCapabilities(...ALL_CAPABILITIES);
    // 2^10 - 1 = 1023 (all 10 bits set)
    expect(all).toBe(1023n);
  });
});

describe("hasCapability", () => {
  it("returns true for set capability", () => {
    const caps = combineCapabilities(Capability.COMPUTE, Capability.INFERENCE);
    expect(hasCapability(caps, Capability.COMPUTE)).toBe(true);
    expect(hasCapability(caps, Capability.INFERENCE)).toBe(true);
  });

  it("returns false for unset capability", () => {
    const caps = combineCapabilities(Capability.COMPUTE, Capability.INFERENCE);
    expect(hasCapability(caps, Capability.STORAGE)).toBe(false);
  });

  it("handles zero capabilities", () => {
    expect(hasCapability(0n, Capability.COMPUTE)).toBe(false);
  });
});

describe("hasAllCapabilities", () => {
  it("returns true when all required capabilities are present", () => {
    const caps = combineCapabilities(
      Capability.COMPUTE,
      Capability.INFERENCE,
      Capability.STORAGE,
    );
    expect(
      hasAllCapabilities(caps, [Capability.COMPUTE, Capability.INFERENCE]),
    ).toBe(true);
  });

  it("returns false when any required capability is missing", () => {
    const caps = combineCapabilities(Capability.COMPUTE, Capability.INFERENCE);
    expect(
      hasAllCapabilities(caps, [Capability.COMPUTE, Capability.NETWORK]),
    ).toBe(false);
  });

  it("returns true for empty requirements", () => {
    expect(hasAllCapabilities(0n, [])).toBe(true);
  });
});

describe("hasAnyCapability", () => {
  it("returns true when any capability matches", () => {
    const caps = combineCapabilities(Capability.COMPUTE);
    expect(
      hasAnyCapability(caps, [Capability.COMPUTE, Capability.INFERENCE]),
    ).toBe(true);
  });

  it("returns false when no capability matches", () => {
    const caps = combineCapabilities(Capability.COMPUTE);
    expect(
      hasAnyCapability(caps, [Capability.STORAGE, Capability.NETWORK]),
    ).toBe(false);
  });

  it("returns false for empty list", () => {
    const caps = combineCapabilities(Capability.COMPUTE);
    expect(hasAnyCapability(caps, [])).toBe(false);
  });
});

describe("getCapabilityNames", () => {
  it("returns correct names for bitmask", () => {
    const caps = combineCapabilities(Capability.COMPUTE, Capability.INFERENCE);
    const names = getCapabilityNames(caps);
    expect(names).toContain("COMPUTE");
    expect(names).toContain("INFERENCE");
    expect(names.length).toBe(2);
  });

  it("returns empty array for zero", () => {
    expect(getCapabilityNames(0n)).toEqual([]);
  });

  it("returns all names for all capabilities", () => {
    const all = combineCapabilities(...ALL_CAPABILITIES);
    const names = getCapabilityNames(all);
    expect(names.length).toBe(10);
  });
});

describe("parseCapabilities", () => {
  it("converts names to bitmask", () => {
    const caps = parseCapabilities(["COMPUTE", "INFERENCE"]);
    expect(caps).toBe(3n);
  });

  it("handles empty array", () => {
    expect(parseCapabilities([])).toBe(0n);
  });

  it("round-trips with getCapabilityNames", () => {
    const original: CapabilityName[] = ["COMPUTE", "STORAGE", "ARBITER"];
    const caps = parseCapabilities(original);
    const names = getCapabilityNames(caps);
    expect(names.sort()).toEqual(original.sort());
  });
});

describe("formatCapabilities", () => {
  it("formats as comma-separated string", () => {
    const caps = combineCapabilities(Capability.COMPUTE, Capability.INFERENCE);
    expect(formatCapabilities(caps)).toBe("COMPUTE, INFERENCE");
  });

  it('returns "None" for zero', () => {
    expect(formatCapabilities(0n)).toBe("None");
  });

  it("handles single capability", () => {
    expect(formatCapabilities(Capability.ARBITER)).toBe("ARBITER");
  });
});

describe("countCapabilities", () => {
  it("counts set bits correctly", () => {
    const caps = combineCapabilities(
      Capability.COMPUTE,
      Capability.INFERENCE,
      Capability.STORAGE,
    );
    expect(countCapabilities(caps)).toBe(3);
  });

  it("returns 0 for no capabilities", () => {
    expect(countCapabilities(0n)).toBe(0);
  });

  it("returns 10 for all capabilities", () => {
    const all = combineCapabilities(...ALL_CAPABILITIES);
    expect(countCapabilities(all)).toBe(10);
  });
});
