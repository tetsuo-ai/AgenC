import { describe, expect, it } from "vitest";
import {
  CHANNEL_ADAPTER_HOST_API_VERSION,
  CHANNEL_ADAPTER_PLUGIN_API_VERSION,
  validateChannelAdapterManifest,
} from "../index.js";

describe("validateChannelAdapterManifest", () => {
  it("accepts a valid manifest", () => {
    const issues = validateChannelAdapterManifest({
      schema_version: 1,
      plugin_id: "fixtures/slack",
      channel_name: "slack",
      plugin_type: "channel_adapter",
      version: "0.0.1",
      display_name: "Fixture Slack",
      description: "fixture",
      plugin_api_version: CHANNEL_ADAPTER_PLUGIN_API_VERSION,
      host_api_version: CHANNEL_ADAPTER_HOST_API_VERSION,
    });

    expect(issues).toEqual([]);
  });

  it("rejects invalid manifest fields", () => {
    const issues = validateChannelAdapterManifest({
      schema_version: 2,
      plugin_id: "../bad",
      channel_name: "Slack",
      plugin_type: "tool_pack",
      version: "bad",
      display_name: "",
      plugin_api_version: "v1",
      host_api_version: "v1",
    });

    expect(issues.map((issue) => issue.field)).toEqual(
      expect.arrayContaining([
        "schema_version",
        "plugin_id",
        "channel_name",
        "plugin_type",
        "version",
        "display_name",
        "plugin_api_version",
        "host_api_version",
      ]),
    );
  });

  it("rejects unsupported compatibility tuples during manifest validation", () => {
    const issues = validateChannelAdapterManifest({
      schema_version: 1,
      plugin_id: "fixtures/slack",
      channel_name: "slack",
      plugin_type: "channel_adapter",
      version: "0.0.1",
      display_name: "Fixture Slack",
      plugin_api_version: "9.9.9",
      host_api_version: CHANNEL_ADAPTER_HOST_API_VERSION,
    });

    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "plugin_api_version",
        }),
      ]),
    );
  });
});
