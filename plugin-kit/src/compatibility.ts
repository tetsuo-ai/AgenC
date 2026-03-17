import matrixJson from "./compatibility/channel-host-matrix.json" with { type: "json" };

export type PluginCompatibilityStatus = "supported" | "deprecated" | "unsupported";

export interface ChannelHostCompatibilityEntry {
  readonly plugin_type: "channel_adapter";
  readonly plugin_api_version: string;
  readonly host_api_version: string;
  readonly status: PluginCompatibilityStatus;
  readonly notes?: string;
}

export const CHANNEL_HOST_COMPATIBILITY_MATRIX = Object.freeze(
  matrixJson.map((entry) => Object.freeze({ ...entry })),
) as readonly ChannelHostCompatibilityEntry[];

export function findChannelHostCompatibilityEntry(params: {
  plugin_type: string;
  plugin_api_version: string;
  host_api_version: string;
}): ChannelHostCompatibilityEntry | undefined {
  return CHANNEL_HOST_COMPATIBILITY_MATRIX.find(
    (entry) =>
      entry.plugin_type === params.plugin_type &&
      entry.plugin_api_version === params.plugin_api_version &&
      entry.host_api_version === params.host_api_version,
  );
}

export function isChannelHostCompatibilitySupported(params: {
  plugin_type: string;
  plugin_api_version: string;
  host_api_version: string;
}): boolean {
  const entry = findChannelHostCompatibilityEntry(params);
  return entry?.status === "supported";
}
