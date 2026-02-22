/**
 * Gateway configuration loading, validation, diffing, and file watching.
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { GatewayConfig, ConfigDiff } from "./types.js";
import { GatewayValidationError, GatewayConnectionError } from "./errors.js";
import {
  type ValidationResult,
  validationResult,
  requireIntRange,
  requireOneOf,
} from "../utils/validation.js";
import { isRecord } from "../utils/type-guards.js";

// ============================================================================
// Default config path
// ============================================================================

export function getDefaultConfigPath(): string {
  return process.env.AGENC_CONFIG ?? join(homedir(), ".agenc", "config.json");
}

// ============================================================================
// Config loading
// ============================================================================

export async function loadGatewayConfig(path: string): Promise<GatewayConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    throw new GatewayConnectionError(
      `Failed to read config file at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayValidationError("config", "Invalid JSON");
  }

  if (!isValidGatewayConfig(parsed)) {
    const result = validateGatewayConfig(parsed);
    throw new GatewayValidationError("config", result.errors.join("; "));
  }

  return parsed;
}

// ============================================================================
// Config validation
// ============================================================================

const VALID_LOG_LEVELS: ReadonlySet<string> = new Set([
  "debug",
  "info",
  "warn",
  "error",
]);
const VALID_LLM_PROVIDERS: ReadonlySet<string> = new Set([
  "grok",
  "ollama",
]);
const VALID_MEMORY_BACKENDS: ReadonlySet<string> = new Set([
  "memory",
  "sqlite",
  "redis",
]);

/** Type predicate — returns true when `obj` satisfies the GatewayConfig shape. */
export function isValidGatewayConfig(obj: unknown): obj is GatewayConfig {
  return validateGatewayConfig(obj).valid;
}

export function validateGatewayConfig(obj: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(obj)) {
    return { valid: false, errors: ["Config must be a non-null object"] };
  }

  // gateway section
  if (!isRecord(obj.gateway)) {
    errors.push("gateway section is required");
  } else {
    requireIntRange(obj.gateway.port, "gateway.port", 1, 65535, errors);
    if (
      obj.gateway.bind !== undefined &&
      typeof obj.gateway.bind !== "string"
    ) {
      errors.push("gateway.bind must be a string");
    }
  }

  // agent section
  if (!isRecord(obj.agent)) {
    errors.push("agent section is required");
  } else {
    if (
      typeof obj.agent.name !== "string" ||
      obj.agent.name.trim().length === 0
    ) {
      errors.push("agent.name must be a non-empty string");
    }
  }

  // connection section
  if (!isRecord(obj.connection)) {
    errors.push("connection section is required");
  } else {
    if (
      typeof obj.connection.rpcUrl !== "string" ||
      obj.connection.rpcUrl.trim().length === 0
    ) {
      errors.push("connection.rpcUrl must be a non-empty string");
    }
  }

  // logging (optional — requires process restart to change level)
  if (obj.logging !== undefined) {
    if (!isRecord(obj.logging)) {
      errors.push("logging must be an object");
    } else if (obj.logging.level !== undefined) {
      requireOneOf(
        obj.logging.level,
        "logging.level",
        VALID_LOG_LEVELS,
        errors,
      );
    }
  }

  // llm (optional)
  if (obj.llm !== undefined) {
    if (!isRecord(obj.llm)) {
      errors.push("llm must be an object");
    } else {
      requireOneOf(
        obj.llm.provider,
        "llm.provider",
        VALID_LLM_PROVIDERS,
        errors,
      );
    }
  }

  // memory (optional)
  if (obj.memory !== undefined) {
    if (!isRecord(obj.memory)) {
      errors.push("memory must be an object");
    } else {
      requireOneOf(
        obj.memory.backend,
        "memory.backend",
        VALID_MEMORY_BACKENDS,
        errors,
      );
    }
  }

  // auth (optional)
  if (obj.auth !== undefined) {
    if (!isRecord(obj.auth)) {
      errors.push("auth must be an object");
    } else {
      if (obj.auth.secret !== undefined) {
        if (typeof obj.auth.secret !== "string") {
          errors.push("auth.secret must be a string");
        } else if (obj.auth.secret.length < 32) {
          errors.push("auth.secret must be at least 32 characters");
        }
      }
      if (
        obj.auth.expirySeconds !== undefined &&
        typeof obj.auth.expirySeconds !== "number"
      ) {
        errors.push("auth.expirySeconds must be a number");
      }
      if (
        obj.auth.localBypass !== undefined &&
        typeof obj.auth.localBypass !== "boolean"
      ) {
        errors.push("auth.localBypass must be a boolean");
      }
    }
  }

  // desktop (optional)
  if (obj.desktop !== undefined) {
    if (!isRecord(obj.desktop)) {
      errors.push("desktop must be an object");
    } else {
      if (
        obj.desktop.enabled !== undefined &&
        typeof obj.desktop.enabled !== "boolean"
      ) {
        errors.push("desktop.enabled must be a boolean");
      }
      if (obj.desktop.maxConcurrent !== undefined) {
        requireIntRange(
          obj.desktop.maxConcurrent,
          "desktop.maxConcurrent",
          1,
          32,
          errors,
        );
      }
      if (obj.desktop.networkMode !== undefined) {
        requireOneOf(
          obj.desktop.networkMode,
          "desktop.networkMode",
          new Set(["none", "bridge"]),
          errors,
        );
      }
      if (obj.desktop.securityProfile !== undefined) {
        requireOneOf(
          obj.desktop.securityProfile,
          "desktop.securityProfile",
          new Set(["strict", "permissive"]),
          errors,
        );
      }
    }
  }

  return validationResult(errors);
}

// ============================================================================
// Config diffing
// ============================================================================

const UNSAFE_KEYS = new Set([
  "gateway.port",
  "gateway.bind",
  "connection.rpcUrl",
  "connection.keypairPath",
  "agent.capabilities",
  "agent.name",
  "desktop.enabled",
]);

export function diffGatewayConfig(
  oldConfig: GatewayConfig,
  newConfig: GatewayConfig,
): ConfigDiff {
  const safe: string[] = [];
  const unsafe: string[] = [];

  const flatOld = flattenConfig(
    oldConfig as unknown as Record<string, unknown>,
  );
  const flatNew = flattenConfig(
    newConfig as unknown as Record<string, unknown>,
  );

  const allKeys = new Set([...Object.keys(flatOld), ...Object.keys(flatNew)]);

  for (const key of allKeys) {
    const oldVal = flatOld[key];
    const newVal = flatNew[key];

    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      if (UNSAFE_KEYS.has(key)) {
        unsafe.push(key);
      } else {
        safe.push(key);
      }
    }
  }

  return { safe, unsafe };
}

function flattenConfig(
  obj: Record<string, unknown>,
  prefix = "",
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(
        result,
        flattenConfig(value as Record<string, unknown>, fullKey),
      );
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

// ============================================================================
// ConfigWatcher
// ============================================================================

export type ConfigReloadCallback = (config: GatewayConfig) => void;
export type ConfigErrorCallback = (error: Error) => void;

export class ConfigWatcher {
  private readonly configPath: string;
  private readonly debounceMs: number;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(configPath: string, debounceMs = 500) {
    this.configPath = configPath;
    this.debounceMs = debounceMs;
  }

  start(onReload: ConfigReloadCallback, onError?: ConfigErrorCallback): void {
    if (this.watcher) return;

    try {
      this.watcher = watch(this.configPath, () => {
        if (this.debounceTimer) {
          clearTimeout(this.debounceTimer);
        }
        this.debounceTimer = setTimeout(async () => {
          try {
            const config = await loadGatewayConfig(this.configPath);
            onReload(config);
          } catch (err) {
            onError?.(err as Error);
          }
        }, this.debounceMs);
      });

      this.watcher.on("error", (err) => {
        onError?.(err);
      });
    } catch (err) {
      onError?.(err as Error);
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }
}
