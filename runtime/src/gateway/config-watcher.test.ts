import { describe, expect, it } from "vitest";
import { validateGatewayConfig } from "./config-watcher.js";

function makeConfig(desktop?: Record<string, unknown>): Record<string, unknown> {
  return {
    gateway: { port: 3100 },
    agent: { name: "test-agent" },
    connection: { rpcUrl: "http://127.0.0.1:8899" },
    ...(desktop ? { desktop } : {}),
  };
}

describe("validateGatewayConfig desktop resource limits", () => {
  it("accepts valid desktop.maxMemory and desktop.maxCpu", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxMemory: "8g",
        maxCpu: "2.5",
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects invalid desktop.maxMemory format", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxMemory: "eight-gb",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "desktop.maxMemory must be a string like 512m or 4g (plain integers are treated as GB)",
    );
  });

  it("rejects invalid desktop.maxCpu format", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxCpu: "two",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      "desktop.maxCpu must be a positive numeric string like 0.5 or 2.0",
    );
  });

  it("rejects non-positive desktop.maxCpu values", () => {
    const result = validateGatewayConfig(
      makeConfig({
        enabled: true,
        maxCpu: "0",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("desktop.maxCpu must be greater than 0");
  });
});
