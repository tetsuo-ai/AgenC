import { findChannelHostCompatibilityEntry } from "./compatibility.js";

export const CHANNEL_ADAPTER_PLUGIN_TYPE = "channel_adapter" as const;
export const CHANNEL_ADAPTER_SCHEMA_VERSION = 1 as const;
export const CHANNEL_ADAPTER_PLUGIN_API_VERSION = "1.0.0" as const;
export const CHANNEL_ADAPTER_HOST_API_VERSION = "1.0.0" as const;

const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/;

export interface ChannelAdapterManifest {
  readonly schema_version: typeof CHANNEL_ADAPTER_SCHEMA_VERSION;
  readonly plugin_id: string;
  readonly channel_name: string;
  readonly plugin_type: typeof CHANNEL_ADAPTER_PLUGIN_TYPE;
  readonly version: string;
  readonly display_name: string;
  readonly description?: string;
  readonly plugin_api_version: string;
  readonly host_api_version: string;
}

export interface ChannelManifestValidationIssue {
  readonly field: string;
  readonly message: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function validateChannelAdapterManifest(
  value: unknown,
): readonly ChannelManifestValidationIssue[] {
  if (!isRecord(value)) {
    return [{ field: "manifest", message: "manifest must be an object" }];
  }

  const issues: ChannelManifestValidationIssue[] = [];

  if (value.schema_version !== CHANNEL_ADAPTER_SCHEMA_VERSION) {
    issues.push({
      field: "schema_version",
      message: `schema_version must be ${CHANNEL_ADAPTER_SCHEMA_VERSION}`,
    });
  }

  if (
    typeof value.plugin_id !== "string" ||
    !PLUGIN_ID_RE.test(value.plugin_id.trim())
  ) {
    issues.push({
      field: "plugin_id",
      message:
        "plugin_id must be a non-empty stable identifier using letters, numbers, ., _, -, and optional / segments",
    });
  }

  if (
    typeof value.channel_name !== "string" ||
    !CHANNEL_NAME_RE.test(value.channel_name.trim())
  ) {
    issues.push({
      field: "channel_name",
      message:
        "channel_name must be a non-empty lower-case route name using letters, numbers, ., _, or -",
    });
  }

  if (value.plugin_type !== CHANNEL_ADAPTER_PLUGIN_TYPE) {
    issues.push({
      field: "plugin_type",
      message: `plugin_type must be ${CHANNEL_ADAPTER_PLUGIN_TYPE}`,
    });
  }

  if (typeof value.version !== "string" || !SEMVER_RE.test(value.version.trim())) {
    issues.push({
      field: "version",
      message: "version must be a valid semver string",
    });
  }

  if (
    typeof value.display_name !== "string" ||
    value.display_name.trim().length === 0
  ) {
    issues.push({
      field: "display_name",
      message: "display_name must be a non-empty string",
    });
  }

  if (
    value.description !== undefined &&
    typeof value.description !== "string"
  ) {
    issues.push({
      field: "description",
      message: "description must be a string when provided",
    });
  }

  if (
    typeof value.plugin_api_version !== "string" ||
    !SEMVER_RE.test(value.plugin_api_version.trim())
  ) {
    issues.push({
      field: "plugin_api_version",
      message: "plugin_api_version must be a valid semver string",
    });
  }

  if (
    typeof value.host_api_version !== "string" ||
    !SEMVER_RE.test(value.host_api_version.trim())
  ) {
    issues.push({
      field: "host_api_version",
      message: "host_api_version must be a valid semver string",
    });
  }

  if (
    typeof value.plugin_type === "string" &&
    typeof value.plugin_api_version === "string" &&
    typeof value.host_api_version === "string" &&
    value.plugin_type === CHANNEL_ADAPTER_PLUGIN_TYPE &&
    findChannelHostCompatibilityEntry({
      plugin_type: value.plugin_type,
      plugin_api_version: value.plugin_api_version,
      host_api_version: value.host_api_version,
    }) === undefined
  ) {
    issues.push({
      field: "plugin_api_version",
      message:
        "plugin_api_version and host_api_version must match a supported channel-host compatibility tuple",
    });
  }

  return issues;
}
