import { describe, expect, it } from "vitest";
import {
  CHANNEL_ADAPTER_HOST_API_VERSION,
  CHANNEL_ADAPTER_PLUGIN_API_VERSION,
  CHANNEL_HOST_COMPATIBILITY_MATRIX,
  findChannelHostCompatibilityEntry,
  isChannelHostCompatibilitySupported,
} from "../index.js";
import { channel_host_matrix } from "../channel-host-matrix.js";
import pluginKit from "../index.js";
import matrixDefault from "../channel-host-matrix.js";

describe("channel host compatibility", () => {
  it("exports the supported compatibility tuple", () => {
    expect(CHANNEL_HOST_COMPATIBILITY_MATRIX).toEqual(channel_host_matrix);
    expect(pluginKit.CHANNEL_HOST_COMPATIBILITY_MATRIX).toBe(
      CHANNEL_HOST_COMPATIBILITY_MATRIX,
    );
    expect(matrixDefault).toBe(CHANNEL_HOST_COMPATIBILITY_MATRIX);
    expect(
      findChannelHostCompatibilityEntry({
        plugin_type: "channel_adapter",
        plugin_api_version: CHANNEL_ADAPTER_PLUGIN_API_VERSION,
        host_api_version: CHANNEL_ADAPTER_HOST_API_VERSION,
      }),
    ).toMatchObject({
      status: "supported",
    });
    expect(
      isChannelHostCompatibilitySupported({
        plugin_type: "channel_adapter",
        plugin_api_version: CHANNEL_ADAPTER_PLUGIN_API_VERSION,
        host_api_version: CHANNEL_ADAPTER_HOST_API_VERSION,
      }),
    ).toBe(true);
  });

  it("rejects unsupported compatibility tuples", () => {
    expect(
      isChannelHostCompatibilitySupported({
        plugin_type: "channel_adapter",
        plugin_api_version: "9.9.9",
        host_api_version: CHANNEL_ADAPTER_HOST_API_VERSION,
      }),
    ).toBe(false);
  });
});
