import { describe, expect, it } from "vitest";
import type { GatewayConfig } from "./types.js";
import { wireExternalChannels } from "./channel-wiring.js";
import { silentLogger } from "../utils/logger.js";

function makeConfig(): GatewayConfig {
  return {
    gateway: { port: 8080 },
    agent: { name: "Fixture" },
    llm: { provider: "grok" },
    plugins: {
      trustedPackages: [
        {
          packageName: "@tetsuo-ai/plugin-kit-channel-fixture",
          allowedSubpaths: ["slack"],
        },
      ],
    },
    channels: {
      "fixture-slack": {
        type: "plugin",
        moduleSpecifier: "@tetsuo-ai/plugin-kit-channel-fixture/slack",
        config: {
          token: "abc",
        },
      },
    },
  };
}

describe("wireExternalChannels", () => {
  it("loads trusted plugin-backed channel adapters into the unified registry", async () => {
    const registry = await wireExternalChannels(makeConfig(), {
      gateway: null,
      logger: silentLogger,
      chatExecutor: null,
      memoryBackend: null,
      defaultForegroundMaxToolRounds: 1,
      async buildSystemPrompt() {
        return "system prompt";
      },
      async handleTextChannelApprovalCommand() {
        return false;
      },
      registerTextApprovalDispatcher() {
        return () => {};
      },
      createTextChannelSessionToolHandler() {
        throw new Error("should not be called during channel bootstrap");
      },
      buildToolRoutingDecision() {
        return undefined;
      },
      recordToolRoutingOutcome() {
        return;
      },
    });

    const plugin = registry.get("fixture-slack");
    expect(plugin?.name).toBe("fixture-slack");
    expect(plugin?.isHealthy()).toBe(true);

    await plugin?.stop();
  });
});
