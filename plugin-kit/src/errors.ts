import type {
  ChannelAdapterCertificationIssue,
} from "./certification.js";
import type {
  ChannelManifestValidationIssue,
} from "./channel-manifest.js";

export class PluginKitError extends Error {
  readonly code: string;

  constructor(message: string, code = "plugin_kit_error") {
    super(message);
    this.name = "PluginKitError";
    this.code = code;
  }
}

export class PluginManifestValidationError extends PluginKitError {
  readonly issues: readonly ChannelManifestValidationIssue[];

  constructor(
    message: string,
    issues: readonly ChannelManifestValidationIssue[] = [],
  ) {
    super(message, "plugin_manifest_validation_error");
    this.name = "PluginManifestValidationError";
    this.issues = issues;
  }
}

export class PluginCertificationError extends PluginKitError {
  readonly issues: readonly ChannelAdapterCertificationIssue[];

  constructor(
    message: string,
    issues: readonly ChannelAdapterCertificationIssue[] = [],
  ) {
    super(message, "plugin_certification_error");
    this.name = "PluginCertificationError";
    this.issues = issues;
  }
}
