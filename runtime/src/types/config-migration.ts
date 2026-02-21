/**
 * Versioned configuration migration, strict-mode validation, and schema snapshots.
 *
 * @module
 */

import { createHash } from "node:crypto";

/** Semantic config version identifier. */
export interface ConfigVersion {
  major: number;
  minor: number;
  patch: number;
}

/** Current config version. */
export const CURRENT_CONFIG_VERSION: ConfigVersion = {
  major: 1,
  minor: 0,
  patch: 0,
};

/** String representation for serialization. */
export function configVersionToString(v: ConfigVersion): string {
  return `${v.major}.${v.minor}.${v.patch}`;
}

export function parseConfigVersion(s: string): ConfigVersion {
  const parts = s.split(".").map(Number);
  if (parts.length !== 3 || parts.some((p) => !Number.isInteger(p) || p < 0)) {
    throw new ConfigMigrationError(`Invalid config version: "${s}"`);
  }
  return { major: parts[0]!, minor: parts[1]!, patch: parts[2]! };
}

export function compareVersions(a: ConfigVersion, b: ConfigVersion): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

/** Config migration function signature. */
export type ConfigMigrationFn = (
  config: Record<string, unknown>,
) => Record<string, unknown>;

/** Migration step definition. */
export interface ConfigMigrationStep {
  from: ConfigVersion;
  to: ConfigVersion;
  description: string;
  migrate: ConfigMigrationFn;
}

/** Structured warning for deprecated or unknown config values. */
export interface ConfigWarning {
  path: string;
  code: "unknown_key" | "deprecated_value" | "type_mismatch";
  message: string;
  value?: unknown;
  suggestion?: string;
}

/** Result of config validation in strict mode. */
export interface ConfigValidationResult {
  valid: boolean;
  warnings: ConfigWarning[];
  errors: ConfigWarning[];
  migratedConfig: Record<string, unknown>;
  fromVersion: ConfigVersion;
  toVersion: ConfigVersion;
}

export class ConfigMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigMigrationError";
  }
}

/** Schema snapshot for a config profile. */
export interface ConfigSchemaSnapshot {
  version: ConfigVersion;
  profile: string;
  keys: string[];
  sha256: string;
}

// ---------------------------------------------------------------------------
// Migration registry
// ---------------------------------------------------------------------------

/** Registry of all migration steps (ordered). */
const MIGRATION_REGISTRY: ConfigMigrationStep[] = [
  {
    from: { major: 0, minor: 0, patch: 0 },
    to: { major: 1, minor: 0, patch: 0 },
    description: "Initial migration: add configVersion field",
    migrate: (config) => ({
      ...config,
      configVersion: "1.0.0",
    }),
  },
];

function findMigrationPath(
  registry: ConfigMigrationStep[],
  from: ConfigVersion,
  to: ConfigVersion,
): ConfigMigrationStep[] {
  const path: ConfigMigrationStep[] = [];
  let current = from;

  while (compareVersions(current, to) < 0) {
    const next = registry.find((s) => compareVersions(s.from, current) === 0);
    if (!next) break;
    path.push(next);
    current = next.to;
  }

  return path;
}

export function migrateConfig(
  oldConfig: Record<string, unknown>,
  fromVersion: ConfigVersion,
  toVersion: ConfigVersion,
): Record<string, unknown> {
  const path = findMigrationPath(MIGRATION_REGISTRY, fromVersion, toVersion);
  if (path.length === 0 && compareVersions(fromVersion, toVersion) !== 0) {
    throw new ConfigMigrationError(
      `No migration path from ${configVersionToString(fromVersion)} to ${configVersionToString(toVersion)}`,
    );
  }

  let config = { ...oldConfig };
  for (const step of path) {
    config = step.migrate(config);
  }

  config.configVersion = configVersionToString(toVersion);
  return config;
}

// ---------------------------------------------------------------------------
// Strict validation
// ---------------------------------------------------------------------------

/** Known config keys at each depth level (dot-path notation). */
export const KNOWN_CONFIG_KEYS = new Set([
  "configVersion",
  "rpcUrl",
  "programId",
  "storeType",
  "sqlitePath",
  "traceId",
  "strictMode",
  "idempotencyWindow",
  "outputFormat",
  "logLevel",
  "replay",
  "replay.enabled",
  "replay.store",
  "replay.store.type",
  "replay.store.sqlitePath",
  "replay.store.retention",
  "replay.store.retention.ttlMs",
  "replay.tracing",
  "replay.tracing.traceId",
  "replay.tracing.sampleRate",
  "replay.projectionSeed",
  "replay.strictProjection",
  "replay.alerting",
  "replay.alerting.enabled",
]);

/** Deprecated keys mapped to their replacement. */
export const DEPRECATED_KEYS: Readonly<Record<string, string>> = {
  verbose: "logLevel",
  rpc_url: "rpcUrl",
  store_type: "storeType",
  sqlite_path: "sqlitePath",
  strict_mode: "strictMode",
};

function flattenKeys(obj: Record<string, unknown>, prefix = ""): string[] {
  const result: string[] = [];
  for (const key of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    result.push(path);
    const value = obj[key];
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result.push(...flattenKeys(value as Record<string, unknown>, path));
    }
  }
  return result;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function validateConfigStrict(
  config: Record<string, unknown>,
  strict: boolean,
): ConfigValidationResult {
  const warnings: ConfigWarning[] = [];
  const errors: ConfigWarning[] = [];

  const versionStr =
    typeof config.configVersion === "string" ? config.configVersion : "0.0.0";
  const fromVersion = parseConfigVersion(versionStr);

  const allPaths = flattenKeys(config);
  for (const path of allPaths) {
    if (DEPRECATED_KEYS[path]) {
      warnings.push({
        path,
        code: "deprecated_value",
        message: `Key "${path}" is deprecated, use "${DEPRECATED_KEYS[path]}" instead`,
        suggestion: DEPRECATED_KEYS[path],
      });
    } else if (!KNOWN_CONFIG_KEYS.has(path)) {
      const entry: ConfigWarning = {
        path,
        code: "unknown_key",
        message: `Unknown config key: "${path}"`,
        value: getNestedValue(config, path),
      };
      if (strict) {
        errors.push(entry);
      } else {
        warnings.push(entry);
      }
    }
  }

  let migratedConfig = config;
  if (compareVersions(fromVersion, CURRENT_CONFIG_VERSION) < 0) {
    migratedConfig = migrateConfig(config, fromVersion, CURRENT_CONFIG_VERSION);
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
    migratedConfig,
    fromVersion,
    toVersion: CURRENT_CONFIG_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Schema snapshots
// ---------------------------------------------------------------------------

export function buildConfigSchemaSnapshot(
  version: ConfigVersion,
  profile: string,
): ConfigSchemaSnapshot {
  const keys = [...KNOWN_CONFIG_KEYS].sort();
  const sha256 = createHash("sha256").update(keys.join("\n")).digest("hex");

  return { version, profile, keys, sha256 };
}
