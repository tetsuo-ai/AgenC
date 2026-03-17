import {
  validateChannelAdapterManifest,
  type ChannelAdapterManifest,
} from "./channel-manifest.js";
import {
  findChannelHostCompatibilityEntry,
  type ChannelHostCompatibilityEntry,
} from "./compatibility.js";
import type {
  ChannelAdapter,
  ChannelAdapterModuleExports,
  ChannelConfigValidationResult,
} from "./channel-runtime.js";

export interface ChannelAdapterCertificationIssue {
  readonly code:
    | "module_exports_invalid"
    | "manifest_invalid"
    | "compatibility_unsupported"
    | "config_validator_missing"
    | "config_invalid"
    | "factory_missing"
    | "adapter_invalid";
  readonly message: string;
  readonly field?: string;
}

export interface ChannelAdapterCertificationResult {
  readonly ok: boolean;
  readonly manifest?: ChannelAdapterManifest;
  readonly compatibility?: ChannelHostCompatibilityEntry;
  readonly adapter?: ChannelAdapter;
  readonly issues: readonly ChannelAdapterCertificationIssue[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unwrapModuleNamespace(
  moduleExports: unknown,
): Record<string, unknown> | null {
  if (!isRecord(moduleExports)) {
    return null;
  }
  if ("manifest" in moduleExports && "createChannelAdapter" in moduleExports) {
    return moduleExports;
  }
  if (isRecord(moduleExports.default)) {
    return moduleExports.default;
  }
  return moduleExports;
}

function validateChannelAdapterShape(
  adapter: unknown,
): readonly ChannelAdapterCertificationIssue[] {
  if (!isRecord(adapter)) {
    return [
      {
        code: "adapter_invalid",
        message: "createChannelAdapter() must return an object",
      },
    ];
  }

  const requiredMethods = [
    "initialize",
    "start",
    "stop",
    "send",
    "isHealthy",
  ] as const;
  const issues: ChannelAdapterCertificationIssue[] = [];
  for (const method of requiredMethods) {
    if (typeof adapter[method] !== "function") {
      issues.push({
        code: "adapter_invalid",
        field: method,
        message: `adapter.${method} must be a function`,
      });
    }
  }
  if (typeof adapter.name !== "string" || adapter.name.trim().length === 0) {
    issues.push({
      code: "adapter_invalid",
      field: "name",
      message: "adapter.name must be a non-empty string",
    });
  }
  return issues;
}

function normalizeConfigValidationResult(
  result: unknown,
): ChannelConfigValidationResult | null {
  if (!isRecord(result) || typeof result.valid !== "boolean") {
    return null;
  }
  if (!Array.isArray(result.errors) || !result.errors.every((value) => typeof value === "string")) {
    return null;
  }
  return {
    valid: result.valid,
    errors: result.errors,
  };
}

export function resolveChannelAdapterModuleExports(
  moduleExports: unknown,
): ChannelAdapterModuleExports | null {
  const unwrapped = unwrapModuleNamespace(moduleExports);
  if (!unwrapped) {
    return null;
  }
  if (
    typeof unwrapped.validateConfig !== "function" ||
    typeof unwrapped.createChannelAdapter !== "function" ||
    !("manifest" in unwrapped)
  ) {
    return null;
  }
  return unwrapped as unknown as ChannelAdapterModuleExports;
}

export function certifyChannelAdapterModule(params: {
  readonly moduleExports: unknown;
  readonly config?: unknown;
}): ChannelAdapterCertificationResult {
  const resolved = resolveChannelAdapterModuleExports(params.moduleExports);
  if (!resolved) {
    return {
      ok: false,
      issues: [
        {
          code: "module_exports_invalid",
          message:
            "module must expose manifest, validateConfig, and createChannelAdapter (or provide them on default export)",
        },
      ],
    };
  }

  const manifestIssues = validateChannelAdapterManifest(resolved.manifest);
  if (manifestIssues.length > 0) {
    return {
      ok: false,
      issues: manifestIssues.map((issue) => ({
        code: "manifest_invalid" as const,
        field: issue.field,
        message: issue.message,
      })),
    };
  }

  const manifest = resolved.manifest;
  const compatibility = findChannelHostCompatibilityEntry({
    plugin_type: manifest.plugin_type,
    plugin_api_version: manifest.plugin_api_version,
    host_api_version: manifest.host_api_version,
  });
  if (!compatibility || compatibility.status !== "supported") {
    return {
      ok: false,
      manifest,
      issues: [
        {
          code: "compatibility_unsupported",
          message:
            "plugin_api_version and host_api_version are not present as a supported tuple in the channel-host compatibility matrix",
        },
      ],
    };
  }

  const configResult = normalizeConfigValidationResult(
    resolved.validateConfig(params.config ?? {}),
  );
  if (!configResult) {
    return {
      ok: false,
      manifest,
      compatibility,
      issues: [
        {
          code: "config_validator_missing",
          message:
            "validateConfig() must return { valid: boolean, errors: string[] }",
        },
      ],
    };
  }
  if (!configResult.valid) {
    return {
      ok: false,
      manifest,
      compatibility,
      issues: configResult.errors.map((message) => ({
        code: "config_invalid" as const,
        message,
      })),
    };
  }

  const adapter = resolved.createChannelAdapter();
  const adapterIssues = validateChannelAdapterShape(adapter);
  if (adapterIssues.length > 0) {
    return {
      ok: false,
      manifest,
      compatibility,
      issues: adapterIssues,
    };
  }

  return {
    ok: true,
    manifest,
    compatibility,
    adapter: adapter as ChannelAdapter,
    issues: [],
  };
}
