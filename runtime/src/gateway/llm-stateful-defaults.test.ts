import { describe, expect, it } from "vitest";

import { resolveGatewayStatefulResponses } from "./llm-stateful-defaults.js";

describe("resolveGatewayStatefulResponses", () => {
  it("enables Grok stateful responses with compaction defaults when omitted", () => {
    const resolved = resolveGatewayStatefulResponses("grok", undefined);

    expect(resolved.usedDefaults).toBe(true);
    expect(resolved.config).toEqual({
      enabled: true,
      store: false,
      fallbackToStateless: true,
      compaction: {
        enabled: true,
        compactThreshold: 16_000,
        fallbackOnUnsupported: true,
      },
    });
  });

  it("fills missing Grok fields while preserving explicit partial overrides", () => {
    const resolved = resolveGatewayStatefulResponses("grok", {
      enabled: true,
      compaction: {
        enabled: false,
      },
    });

    expect(resolved.usedDefaults).toBe(true);
    expect(resolved.config).toEqual({
      enabled: true,
      store: false,
      fallbackToStateless: true,
      compaction: {
        enabled: false,
        compactThreshold: 16_000,
        fallbackOnUnsupported: true,
      },
    });
  });

  it("preserves explicit Grok disable without forcing defaults", () => {
    const config = {
      enabled: false,
      store: false,
      fallbackToStateless: true,
      compaction: {
        enabled: false,
      },
    };
    const resolved = resolveGatewayStatefulResponses("grok", config);

    expect(resolved.usedDefaults).toBe(false);
    expect(resolved.config).toBe(config);
  });

  it("leaves non-Grok providers unchanged", () => {
    const config = {
      enabled: true,
      store: true,
      fallbackToStateless: false,
      compaction: {
        enabled: true,
        compactThreshold: 9_000,
        fallbackOnUnsupported: false,
      },
    };
    const resolved = resolveGatewayStatefulResponses("ollama", config);

    expect(resolved.usedDefaults).toBe(false);
    expect(resolved.config).toBe(config);
  });
});
