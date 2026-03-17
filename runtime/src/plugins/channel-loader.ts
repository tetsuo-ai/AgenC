import { certifyChannelAdapterModule } from "@tetsuo-ai/plugin-kit";
import type {
  ChannelAdapterCertificationResult,
  ChannelAdapterManifest,
} from "@tetsuo-ai/plugin-kit";
import type { ChannelPlugin } from "../gateway/channel.js";
import {
  GatewayConnectionError,
  GatewayValidationError,
} from "../gateway/errors.js";
import type {
  GatewayTrustedPluginPackageConfig,
  GatewayChannelConfig,
} from "../gateway/types.js";
import { isRecord } from "../utils/type-guards.js";
import { HostedChannelPlugin } from "./channel-host.js";
import {
  RESERVED_CHANNEL_NAMES,
  isTrustedPluginModuleSpecifier,
  parsePluginModuleSpecifier,
} from "./channel-policy.js";

export interface PluginChannelWrapperConfig extends GatewayChannelConfig {
  readonly type: "plugin";
  readonly moduleSpecifier: string;
  readonly config?: Readonly<Record<string, unknown>>;
}

export interface LoadedConfiguredPluginChannel {
  readonly manifest: ChannelAdapterManifest;
  readonly channel: ChannelPlugin;
  readonly moduleSpecifier: string;
}

function formatCertificationIssues(
  result: ChannelAdapterCertificationResult,
): string {
  return result.issues
    .map((issue) =>
      issue.field ? `${issue.field}: ${issue.message}` : issue.message,
    )
    .join("; ");
}

function throwForCertificationFailure(
  channelName: string,
  moduleSpecifier: string,
  result: ChannelAdapterCertificationResult,
): never {
  const issueSummary = formatCertificationIssues(result) || "unknown certification error";
  const allConfigErrors = result.issues.length > 0 &&
    result.issues.every((issue) => issue.code === "config_invalid");
  if (allConfigErrors) {
    throw new GatewayValidationError(
      `channels.${channelName}.config`,
      issueSummary,
    );
  }
  throw new GatewayConnectionError(
    `Failed to certify channel plugin "${moduleSpecifier}": ${issueSummary}`,
  );
}

function toPluginChannelConfig(
  channelName: string,
  value: unknown,
): PluginChannelWrapperConfig {
  const fieldBase = `channels.${channelName}`;
  if (!isRecord(value)) {
    throw new GatewayValidationError(fieldBase, "must be an object");
  }

  if (value.type !== "plugin") {
    throw new GatewayValidationError(
      `${fieldBase}.type`,
      'must be "plugin" when loading a hosted channel adapter',
    );
  }
  if (
    typeof value.moduleSpecifier !== "string" ||
    value.moduleSpecifier.trim().length === 0
  ) {
    throw new GatewayValidationError(
      `${fieldBase}.moduleSpecifier`,
      'must be a non-empty string when type is "plugin"',
    );
  }
  if (value.config !== undefined && !isRecord(value.config)) {
    throw new GatewayValidationError(
      `${fieldBase}.config`,
      "must be an object when provided",
    );
  }

  return {
    ...value,
    type: "plugin",
    moduleSpecifier: value.moduleSpecifier.trim(),
    config:
      value.config === undefined
        ? undefined
        : Object.freeze({ ...value.config }),
  };
}

function assertChannelNameAllowed(
  channelName: string,
  fieldName: string,
): void {
  if (RESERVED_CHANNEL_NAMES.has(channelName)) {
    throw new GatewayValidationError(
      fieldName,
      `channel name "${channelName}" is reserved for built-in runtime channels`,
    );
  }
}

function assertTrustedSpecifier(params: {
  readonly channelName: string;
  readonly moduleSpecifier: string;
  readonly trustedPackages: readonly GatewayTrustedPluginPackageConfig[];
}): void {
  if (
    !isTrustedPluginModuleSpecifier({
      moduleSpecifier: params.moduleSpecifier,
      trustedPackages: params.trustedPackages,
    })
  ) {
    const parsed = parsePluginModuleSpecifier(params.moduleSpecifier);
    const detail = parsed
      ? parsed.subpath === null
        ? `trusted package "${parsed.packageName}" is missing from plugins.trustedPackages`
        : `trusted package "${parsed.packageName}" does not allow subpath "${parsed.subpath}"`
      : "module specifier is invalid";
    throw new GatewayValidationError(
      `channels.${params.channelName}.moduleSpecifier`,
      `${detail}`,
    );
  }
}

function assertCertifiedChannelMatchesConfig(params: {
  readonly channelName: string;
  readonly moduleSpecifier: string;
  readonly result: ChannelAdapterCertificationResult;
}): asserts params is {
  readonly channelName: string;
  readonly moduleSpecifier: string;
  readonly result: ChannelAdapterCertificationResult & {
    readonly ok: true;
    readonly manifest: ChannelAdapterManifest;
    readonly adapter: NonNullable<ChannelAdapterCertificationResult["adapter"]>;
  };
} {
  if (
    !params.result.ok ||
    !params.result.manifest ||
    !params.result.adapter
  ) {
    throwForCertificationFailure(
      params.channelName,
      params.moduleSpecifier,
      params.result,
    );
  }

  const { manifest, adapter } = params.result;
  if (manifest.channel_name !== params.channelName) {
    throw new GatewayValidationError(
      `channels.${params.channelName}.moduleSpecifier`,
      `plugin manifest.channel_name "${manifest.channel_name}" must match the config key "${params.channelName}"`,
    );
  }

  assertChannelNameAllowed(
    manifest.channel_name,
    `channels.${params.channelName}.moduleSpecifier`,
  );

  if (adapter.name !== manifest.channel_name) {
    throw new GatewayConnectionError(
      `Failed to certify channel plugin "${params.moduleSpecifier}": adapter.name "${adapter.name}" must match manifest.channel_name "${manifest.channel_name}"`,
    );
  }
}

export async function loadConfiguredPluginChannel(params: {
  readonly channelName: string;
  readonly channelConfig: unknown;
  readonly trustedPackages?: readonly GatewayTrustedPluginPackageConfig[];
}): Promise<LoadedConfiguredPluginChannel> {
  const config = toPluginChannelConfig(params.channelName, params.channelConfig);

  assertChannelNameAllowed(params.channelName, `channels.${params.channelName}`);
  assertTrustedSpecifier({
    channelName: params.channelName,
    moduleSpecifier: config.moduleSpecifier,
    trustedPackages: params.trustedPackages ?? [],
  });

  let moduleExports: unknown;
  try {
    moduleExports = await import(config.moduleSpecifier);
  } catch (error) {
    throw new GatewayConnectionError(
      `Failed to load channel plugin "${config.moduleSpecifier}": ${(error as Error).message}`,
    );
  }

  const certification = certifyChannelAdapterModule({
    moduleExports,
    config: config.config ?? {},
  });
  assertCertifiedChannelMatchesConfig({
    channelName: params.channelName,
    moduleSpecifier: config.moduleSpecifier,
    result: certification,
  });
  const manifest = certification.manifest;
  const adapter = certification.adapter;
  if (!manifest || !adapter) {
    throw new GatewayConnectionError(
      `Failed to certify channel plugin "${config.moduleSpecifier}": certification completed without manifest/adapter output`,
    );
  }

  return {
    manifest,
    moduleSpecifier: config.moduleSpecifier,
    channel: new HostedChannelPlugin({
      manifest,
      adapter,
      config: (config.config ?? {}) as Record<string, unknown>,
      moduleSpecifier: config.moduleSpecifier,
    }),
  };
}
