import {
  CHANNEL_ADAPTER_HOST_API_VERSION,
  CHANNEL_ADAPTER_PLUGIN_API_VERSION,
  type ChannelAdapter,
  type ChannelAdapterContext,
  type ChannelConfigValidationResult,
  type ChannelOutboundMessage,
} from "@tetsuo-ai/plugin-kit";

export const manifest = {
  schema_version: 1 as const,
  plugin_id: "fixtures/slack",
  channel_name: "fixture-slack",
  plugin_type: "channel_adapter" as const,
  version: "0.0.0",
  display_name: "Fixture Slack Channel",
  description: "Workspace fixture channel adapter used by runtime tests",
  plugin_api_version: CHANNEL_ADAPTER_PLUGIN_API_VERSION,
  host_api_version: CHANNEL_ADAPTER_HOST_API_VERSION,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateConfig(config: unknown): ChannelConfigValidationResult {
  if (!isRecord(config)) {
    return {
      valid: false,
      errors: ["config must be an object"],
    };
  }
  if (typeof config.token !== "string" || config.token.trim().length === 0) {
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

class FixtureSlackChannelAdapter implements ChannelAdapter {
  readonly name = "fixture-slack";
  private context: ChannelAdapterContext | null = null;
  readonly sent: Array<{ session_id: string; content: string }> = [];

  async initialize(context: ChannelAdapterContext): Promise<void> {
    this.context = context;
  }

  async start(): Promise<void> {
    return;
  }

  async stop(): Promise<void> {
    return;
  }

  async send(message: ChannelOutboundMessage): Promise<void> {
    this.sent.push(message);
  }

  isHealthy(): boolean {
    return this.context !== null;
  }
}

export function createChannelAdapter(): ChannelAdapter {
  return new FixtureSlackChannelAdapter();
}

export default {
  manifest,
  validateConfig,
  createChannelAdapter,
};
