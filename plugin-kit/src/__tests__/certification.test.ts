import { describe, expect, it } from "vitest";
import {
  CHANNEL_ADAPTER_HOST_API_VERSION,
  CHANNEL_ADAPTER_PLUGIN_API_VERSION,
  PluginCertificationError,
  PluginManifestValidationError,
  certifyChannelAdapterModule,
  resolveChannelAdapterModuleExports,
  type ChannelAdapter,
  type ChannelAdapterContext,
  type ChannelOutboundMessage,
  type ChannelConfigValidationResult,
} from "../index.js";

class FixtureChannelAdapter implements ChannelAdapter {
  readonly name = "slack";
  private context: ChannelAdapterContext | null = null;

  async initialize(context: ChannelAdapterContext): Promise<void> {
    this.context = context;
  }

  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }

  async send(_message: ChannelOutboundMessage): Promise<void> {
    if (!this.context) {
      throw new Error("missing context");
    }
  }

  isHealthy(): boolean {
    return true;
  }
}

const manifest = {
  schema_version: 1 as const,
  plugin_id: "fixtures/slack",
  channel_name: "slack",
  plugin_type: "channel_adapter" as const,
  version: "0.0.1",
  display_name: "Fixture Slack",
  plugin_api_version: CHANNEL_ADAPTER_PLUGIN_API_VERSION,
  host_api_version: CHANNEL_ADAPTER_HOST_API_VERSION,
};

function validateConfig(config: unknown): ChannelConfigValidationResult {
  const token = (config as { token?: unknown } | null)?.token;
  if (typeof token !== "string" || token.length === 0) {
    return {
      valid: false,
      errors: ["config.token must be a non-empty string"],
    };
  }
  return {
    valid: true,
    errors: [],
  };
}

describe("certifyChannelAdapterModule", () => {
  it("certifies named-export modules and returns one adapter instance", () => {
    const result = certifyChannelAdapterModule({
      moduleExports: {
        manifest,
        validateConfig,
        createChannelAdapter: () => new FixtureChannelAdapter(),
      },
      config: { token: "secret" },
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.adapter).toBeInstanceOf(FixtureChannelAdapter);
  });

  it("supports CommonJS-style default export objects", () => {
    const resolved = resolveChannelAdapterModuleExports({
      default: {
        manifest,
        validateConfig,
        createChannelAdapter: () => new FixtureChannelAdapter(),
      },
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.manifest.plugin_id).toBe("fixtures/slack");
  });

  it("rejects unsupported modules and invalid config", () => {
    const missingExports = certifyChannelAdapterModule({
      moduleExports: {},
      config: { token: "secret" },
    });
    expect(missingExports.ok).toBe(false);
    expect(missingExports.issues[0]?.code).toBe("module_exports_invalid");

    const invalidConfig = certifyChannelAdapterModule({
      moduleExports: {
        manifest,
        validateConfig,
        createChannelAdapter: () => new FixtureChannelAdapter(),
      },
      config: {},
    });
    expect(invalidConfig.ok).toBe(false);
    expect(invalidConfig.issues[0]?.code).toBe("config_invalid");
  });

  it("surfaces structured plugin-kit errors", () => {
    const manifestError = new PluginManifestValidationError("bad manifest", [
      { field: "plugin_id", message: "invalid" },
    ]);
    expect(manifestError.code).toBe("plugin_manifest_validation_error");
    expect(manifestError.issues).toHaveLength(1);

    const certificationError = new PluginCertificationError("bad module", [
      { code: "module_exports_invalid", message: "missing exports" },
    ]);
    expect(certificationError.code).toBe("plugin_certification_error");
    expect(certificationError.issues).toHaveLength(1);
  });
});
