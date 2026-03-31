import { describe, it, expect } from "vitest";
import { manifest, validateConfig, createChannelAdapter } from "../src/index.js";

describe("Concordia plugin-kit contract", () => {
  describe("manifest", () => {
    it("has required fields", () => {
      expect(manifest.schema_version).toBe(1);
      expect(manifest.plugin_id).toBe("ai.tetsuo.channel.concordia");
      expect(manifest.channel_name).toBe("concordia");
      expect(manifest.plugin_type).toBe("channel_adapter");
      expect(manifest.version).toBe("0.1.0");
      expect(manifest.display_name).toBeTruthy();
      expect(manifest.plugin_api_version).toBe("1.0.0");
      expect(manifest.host_api_version).toBe("1.0.0");
    });
  });

  describe("validateConfig", () => {
    it("accepts empty config", () => {
      const result = validateConfig({});
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts null/undefined config", () => {
      expect(validateConfig(null).valid).toBe(true);
      expect(validateConfig(undefined).valid).toBe(true);
    });

    it("accepts valid config", () => {
      const result = validateConfig({
        bridge_port: 3200,
        event_port: 3201,
        world_id: "test-world",
        reflection_interval: 5,
      });
      expect(result.valid).toBe(true);
    });

    it("rejects invalid bridge_port", () => {
      const result = validateConfig({ bridge_port: -1 });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("bridge_port");
    });

    it("rejects invalid event_port", () => {
      const result = validateConfig({ event_port: 99999 });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("event_port");
    });

    it("rejects invalid reflection_interval", () => {
      const result = validateConfig({ reflection_interval: 0 });
      expect(result.valid).toBe(false);
    });
  });

  describe("createChannelAdapter", () => {
    it("returns an adapter with correct name", () => {
      const adapter = createChannelAdapter();
      expect(adapter.name).toBe("concordia");
    });

    it("adapter has all required methods", () => {
      const adapter = createChannelAdapter();
      expect(typeof adapter.initialize).toBe("function");
      expect(typeof adapter.start).toBe("function");
      expect(typeof adapter.stop).toBe("function");
      expect(typeof adapter.send).toBe("function");
      expect(typeof adapter.isHealthy).toBe("function");
    });

    it("adapter is not healthy before start", () => {
      const adapter = createChannelAdapter();
      expect(adapter.isHealthy()).toBe(false);
    });
  });

  describe("module exports", () => {
    it("exports all three required members", async () => {
      const mod = await import("../src/index.js");
      expect(mod.manifest).toBeDefined();
      expect(typeof mod.validateConfig).toBe("function");
      expect(typeof mod.createChannelAdapter).toBe("function");
    });

    it("default export contains all three", async () => {
      const mod = await import("../src/index.js");
      expect(mod.default.manifest).toBeDefined();
      expect(typeof mod.default.validateConfig).toBe("function");
      expect(typeof mod.default.createChannelAdapter).toBe("function");
    });
  });
});
