/**
 * Plugin manifest types and validation helpers for the runtime skill ecosystem.
 *
 * @module
 */

import { isRecord, isStringArray } from '../utils/type-guards.js';

/** Permission a plugin requests. */
export interface PluginPermission {
  /** Permission type. */
  type: 'tool_call' | 'network' | 'filesystem' | 'wallet_sign';

  /** Scope this permission applies to. */
  scope: string;

  /** Whether the permission is required to run this plugin. */
  required: boolean;
}

/** Allow/deny rules for plugin actions. */
export interface PluginAllowDeny {
  /** Allowed action names. Empty means allow all. */
  allow?: string[];
  /** Denied action names. Deny list takes precedence over allow. */
  deny?: string[];
}

/** Plugin manifest schema for governance. */
export interface PluginManifest {
  /** Unique plugin identifier (namespaced, e.g. 'agenc.memory.redis'). */
  id: string;
  /** Semantic version. */
  version: string;
  /** Schema compatibility version. */
  schemaVersion: number;
  /** Human-readable display name. */
  displayName: string;
  /** Description text for operators. */
  description?: string;
  /** Labels used for discovery and policy UI. */
  labels: string[];
  /** Optional capability requirements as bigint string. */
  requiredCapabilities?: string;
  /** Permissions the plugin requires. */
  permissions: PluginPermission[];
  /** Optional allow/deny metadata for plugin action gating. */
  allowDeny?: PluginAllowDeny;
}

/** Config section for plugin governance. */
export interface PluginsConfig {
  /** Plugin manifests keyed by plugin ID. */
  entries: Record<string, PluginManifest>;
  /** Optional allow-list of plugin IDs. */
  allow?: string[];
  /** Optional deny-list of plugin IDs. */
  deny?: string[];
}

/** Validation issue for a manifest or config value. */
export interface ManifestValidationError {
  /** Plugin identifier associated with the error. */
  pluginId: string;
  /** Field path where validation failed. */
  field: string;
  /** Human-readable validation message. */
  message: string;
  /** Optional raw value for debugging. */
  value?: unknown;
}

/** Error raised when plugin manifests/config fail validation. */
export class PluginManifestError extends Error {
  /** Structured validation errors collected during checks. */
  public readonly errors: readonly ManifestValidationError[];

  constructor(errors: readonly ManifestValidationError[]) {
    super(
      `Plugin manifest validation failed: ${errors
        .map((entry) => `[${entry.pluginId}] ${entry.message}`)
        .join('; ')}`,
    );
    this.name = 'PluginManifestError';
    this.errors = errors;
  }
}

const VALID_PLUGIN_ID = /^[a-z][a-z0-9._-]*$/;

const VALID_PERMISSION_TYPES = ['tool_call', 'network', 'filesystem', 'wallet_sign'];

/**
 * Validate a single plugin manifest and return structured errors.
 */
export function validatePluginManifest(manifest: unknown): ManifestValidationError[] {
  const errors: ManifestValidationError[] = [];

  if (!isRecord(manifest)) {
    errors.push({
      pluginId: 'unknown',
      field: 'root',
      message: 'Manifest must be an object',
      value: manifest,
    });
    return errors;
  }

  const pluginId = typeof manifest.id === 'string' ? manifest.id : 'unknown';

  if (typeof manifest.id !== 'string' || manifest.id.length === 0) {
    errors.push({
      pluginId,
      field: 'id',
      message: 'Plugin id is required and must be a non-empty string',
      value: manifest.id,
    });
  } else if (!VALID_PLUGIN_ID.test(manifest.id)) {
    errors.push({
      pluginId,
      field: 'id',
      message: 'Plugin id must match pattern: ^[a-z][a-z0-9._-]*$',
      value: manifest.id,
    });
  }

  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    errors.push({
      pluginId,
      field: 'version',
      message: 'Version is required',
      value: manifest.version,
    });
  }

  if (
    typeof manifest.schemaVersion !== 'number'
    || !Number.isInteger(manifest.schemaVersion)
    || manifest.schemaVersion < 1
  ) {
    errors.push({
      pluginId,
      field: 'schemaVersion',
      message: 'schemaVersion must be a positive integer',
      value: manifest.schemaVersion,
    });
  }

  if (typeof manifest.displayName !== 'string' || manifest.displayName.length === 0) {
    errors.push({
      pluginId,
      field: 'displayName',
      message: 'displayName is required',
      value: manifest.displayName,
    });
  }

  if (!isStringArray(manifest.labels)) {
    errors.push({
      pluginId,
      field: 'labels',
      message: 'labels must be an array of strings',
      value: manifest.labels,
    });
  }

  if (!Array.isArray(manifest.permissions)) {
    errors.push({
      pluginId,
      field: 'permissions',
      message: 'permissions must be an array',
      value: manifest.permissions,
    });
    return errors;
  }

  for (const [index, permission] of manifest.permissions.entries()) {
    if (!isRecord(permission)) {
      errors.push({
        pluginId,
        field: `permissions[${index}]`,
        message: 'Permission must be an object',
        value: permission,
      });
      continue;
    }

    if (typeof permission.scope !== 'string') {
      errors.push({
        pluginId,
        field: `permissions[${index}].scope`,
        message: 'Permission scope must be a string',
        value: permission.scope,
      });
    }

    if (typeof permission.required !== 'boolean') {
      errors.push({
        pluginId,
        field: `permissions[${index}].required`,
        message: 'Permission required flag must be a boolean',
        value: permission.required,
      });
  }

    if (!VALID_PERMISSION_TYPES.includes(permission.type as string)) {
      errors.push({
        pluginId,
        field: `permissions[${index}].type`,
        message: `Permission type must be one of: ${VALID_PERMISSION_TYPES.join(', ')}`,
        value: permission.type,
      });
    }
  }

  if (!manifest.allowDeny) {
    return errors;
  }

  if (!isRecord(manifest.allowDeny)) {
    errors.push({
      pluginId,
      field: 'allowDeny',
      message: 'allowDeny must be an object',
      value: manifest.allowDeny,
    });
    return errors;
  }

  if (!('allow' in manifest.allowDeny) && !('deny' in manifest.allowDeny)) {
    return errors;
  }

  if (!isStringArray((manifest.allowDeny as PluginAllowDeny).allow)) {
    errors.push({
      pluginId,
      field: 'allowDeny.allow',
      message: 'allow must be an array of strings',
      value: manifest.allowDeny.allow,
    });
  }

  if (!isStringArray((manifest.allowDeny as PluginAllowDeny).deny)) {
    errors.push({
      pluginId,
      field: 'allowDeny.deny',
      message: 'deny must be an array of strings',
      value: manifest.allowDeny.deny,
    });
  }

  return errors;
}

/**
 * Validate a plugins config object and return all discovered errors.
 */
export function validatePluginsConfig(config: unknown): ManifestValidationError[] {
  if (!isRecord(config)) {
    return [{
      pluginId: 'unknown',
      field: 'root',
      message: 'Plugins config must be an object',
      value: config,
    }];
  }

  const errors: ManifestValidationError[] = [];
  const typedConfig = config as {
    entries?: unknown;
    allow?: unknown;
    deny?: unknown;
  };

  if (!isRecord(typedConfig.entries)) {
    errors.push({
      pluginId: 'config',
      field: 'entries',
      message: 'entries must be an object',
      value: typedConfig.entries,
    });
  } else {
    const entries = typedConfig.entries as Record<string, unknown>;
    const knownIds = new Set(Object.keys(entries));

    for (const [pluginId, manifest] of Object.entries(entries)) {
      if (!isRecord(manifest) || !('id' in manifest)) {
        errors.push({
          pluginId,
          field: 'manifest',
          message: 'Manifest must be an object',
          value: manifest,
        });
        continue;
      }

      const declaredId = typeof manifest.id === 'string' ? manifest.id : pluginId;

      if (declaredId !== pluginId) {
        errors.push({
          pluginId,
          field: 'id',
          message: `Manifest id "${declaredId}" does not match config key "${pluginId}"`,
        });
      }

      errors.push(...validatePluginManifest(manifest).map((error) => ({
        ...error,
        pluginId,
      })));
    }

    for (const allowedId of isStringArray(typedConfig.allow) ? typedConfig.allow : []) {
      if (!knownIds.has(allowedId)) {
        errors.push({
          pluginId: allowedId,
          field: 'allow',
          message: `Plugin "${allowedId}" in allow list is not declared in entries`,
        });
      }
    }

    for (const deniedId of isStringArray(typedConfig.deny) ? typedConfig.deny : []) {
      if (!knownIds.has(deniedId)) {
        errors.push({
          pluginId: deniedId,
          field: 'deny',
          message: `Plugin "${deniedId}" in deny list is not declared in entries`,
        });
      }
    }
  }

  if (typedConfig.allow !== undefined && !isStringArray(typedConfig.allow)) {
    errors.push({
      pluginId: 'config',
      field: 'allow',
      message: 'allow must be an array of strings',
      value: typedConfig.allow,
    });
  }

  if (typedConfig.deny !== undefined && !isStringArray(typedConfig.deny)) {
    errors.push({
      pluginId: 'config',
      field: 'deny',
      message: 'deny must be an array of strings',
      value: typedConfig.deny,
    });
  }

  return errors;
}

/**
 * Produce operator-friendly manifest snapshots from plugin config.
 */
export function getPluginConfigHints(config: PluginsConfig): {
  pluginId: string;
  displayName: string;
  labels: string[];
  hasPermissions: boolean;
  isAllowed: boolean;
  isDenied: boolean;
}[] {
  const denySet = new Set(config.deny ?? []);
  const allowSet = config.allow ? new Set(config.allow) : null;

  return Object.values(config.entries).map((manifest) => ({
    pluginId: manifest.id,
    displayName: manifest.displayName,
    labels: manifest.labels,
    hasPermissions: manifest.permissions.length > 0,
    isAllowed: allowSet === null || allowSet.has(manifest.id),
    isDenied: denySet.has(manifest.id),
  }));
}
