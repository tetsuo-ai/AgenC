export {
  CHANNEL_ADAPTER_HOST_API_VERSION,
  CHANNEL_ADAPTER_PLUGIN_API_VERSION,
  CHANNEL_ADAPTER_PLUGIN_TYPE,
  CHANNEL_ADAPTER_SCHEMA_VERSION,
  validateChannelAdapterManifest,
  type ChannelAdapterManifest,
  type ChannelManifestValidationIssue,
} from "./channel-manifest.js";
export {
  CHANNEL_HOST_COMPATIBILITY_MATRIX,
  findChannelHostCompatibilityEntry,
  isChannelHostCompatibilitySupported,
  type ChannelHostCompatibilityEntry,
  type PluginCompatibilityStatus,
} from "./compatibility.js";
export {
  certifyChannelAdapterModule,
  resolveChannelAdapterModuleExports,
  type ChannelAdapterCertificationIssue,
  type ChannelAdapterCertificationResult,
} from "./certification.js";
export {
  type ChannelAdapter,
  type ChannelAdapterContext,
  type ChannelAdapterLogger,
  type ChannelAdapterModuleExports,
  type ChannelConfigValidationResult,
  type ChannelInboundAttachment,
  type ChannelInboundMessage,
  type ChannelOutboundMessage,
} from "./channel-runtime.js";
export {
  PluginCertificationError,
  PluginKitError,
  PluginManifestValidationError,
} from "./errors.js";

import {
  CHANNEL_ADAPTER_HOST_API_VERSION,
  CHANNEL_ADAPTER_PLUGIN_API_VERSION,
  CHANNEL_ADAPTER_PLUGIN_TYPE,
  CHANNEL_ADAPTER_SCHEMA_VERSION,
  validateChannelAdapterManifest,
} from "./channel-manifest.js";
import {
  CHANNEL_HOST_COMPATIBILITY_MATRIX,
  findChannelHostCompatibilityEntry,
  isChannelHostCompatibilitySupported,
} from "./compatibility.js";
import {
  certifyChannelAdapterModule,
  resolveChannelAdapterModuleExports,
} from "./certification.js";
import {
  PluginCertificationError,
  PluginKitError,
  PluginManifestValidationError,
} from "./errors.js";

const pluginKit = {
  CHANNEL_ADAPTER_HOST_API_VERSION,
  CHANNEL_ADAPTER_PLUGIN_API_VERSION,
  CHANNEL_ADAPTER_PLUGIN_TYPE,
  CHANNEL_ADAPTER_SCHEMA_VERSION,
  CHANNEL_HOST_COMPATIBILITY_MATRIX,
  validateChannelAdapterManifest,
  findChannelHostCompatibilityEntry,
  isChannelHostCompatibilitySupported,
  certifyChannelAdapterModule,
  resolveChannelAdapterModuleExports,
  PluginCertificationError,
  PluginKitError,
  PluginManifestValidationError,
};

export default pluginKit;
