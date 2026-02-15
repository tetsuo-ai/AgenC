/**
 * Gateway configuration loading, validation, diffing, and file watching.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { GatewayConfig, ConfigDiff } from './types.js';
import { GatewayValidationError, GatewayConnectionError } from './errors.js';

// ============================================================================
// Default config path
// ============================================================================

export function getDefaultConfigPath(): string {
  return process.env.AGENC_CONFIG ?? join(homedir(), '.agenc', 'config.json');
}

// ============================================================================
// Config loading
// ============================================================================

export async function loadGatewayConfig(path: string): Promise<GatewayConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    throw new GatewayConnectionError(
      `Failed to read config file at ${path}: ${(err as Error).message}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GatewayValidationError('config', 'Invalid JSON');
  }

  const result = validateGatewayConfig(parsed);
  if (!result.valid) {
    throw new GatewayValidationError('config', result.errors.join('; '));
  }

  return parsed as GatewayConfig;
}

// ============================================================================
// Config validation
// ============================================================================

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export function validateGatewayConfig(
  obj: unknown,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!obj || typeof obj !== 'object') {
    return { valid: false, errors: ['Config must be a non-null object'] };
  }

  const config = obj as Record<string, unknown>;

  // gateway section
  if (!config.gateway || typeof config.gateway !== 'object') {
    errors.push('gateway section is required');
  } else {
    const gw = config.gateway as Record<string, unknown>;
    if (typeof gw.port !== 'number' || !Number.isInteger(gw.port) || gw.port < 1 || gw.port > 65535) {
      errors.push('gateway.port must be an integer between 1 and 65535');
    }
    if (gw.bind !== undefined && typeof gw.bind !== 'string') {
      errors.push('gateway.bind must be a string');
    }
  }

  // agent section
  if (!config.agent || typeof config.agent !== 'object') {
    errors.push('agent section is required');
  } else {
    const agent = config.agent as Record<string, unknown>;
    if (typeof agent.name !== 'string' || agent.name.trim().length === 0) {
      errors.push('agent.name must be a non-empty string');
    }
  }

  // connection section
  if (!config.connection || typeof config.connection !== 'object') {
    errors.push('connection section is required');
  } else {
    const conn = config.connection as Record<string, unknown>;
    if (typeof conn.rpcUrl !== 'string' || conn.rpcUrl.trim().length === 0) {
      errors.push('connection.rpcUrl must be a non-empty string');
    }
  }

  // logging (optional)
  if (config.logging !== undefined) {
    if (typeof config.logging !== 'object' || config.logging === null) {
      errors.push('logging must be an object');
    } else {
      const logging = config.logging as Record<string, unknown>;
      if (logging.level !== undefined && !VALID_LOG_LEVELS.has(logging.level as string)) {
        errors.push(`logging.level must be one of: ${[...VALID_LOG_LEVELS].join(', ')}`);
      }
    }
  }

  // llm (optional)
  if (config.llm !== undefined) {
    if (typeof config.llm !== 'object' || config.llm === null) {
      errors.push('llm must be an object');
    } else {
      const llm = config.llm as Record<string, unknown>;
      const validProviders = ['grok', 'anthropic', 'ollama'];
      if (typeof llm.provider !== 'string' || !validProviders.includes(llm.provider)) {
        errors.push(`llm.provider must be one of: ${validProviders.join(', ')}`);
      }
    }
  }

  // memory (optional)
  if (config.memory !== undefined) {
    if (typeof config.memory !== 'object' || config.memory === null) {
      errors.push('memory must be an object');
    } else {
      const memory = config.memory as Record<string, unknown>;
      const validBackends = ['memory', 'sqlite', 'redis'];
      if (typeof memory.backend !== 'string' || !validBackends.includes(memory.backend)) {
        errors.push(`memory.backend must be one of: ${validBackends.join(', ')}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Config diffing
// ============================================================================

const UNSAFE_KEYS = new Set([
  'gateway.port',
  'gateway.bind',
  'connection.rpcUrl',
  'connection.keypairPath',
  'agent.capabilities',
  'agent.name',
]);

export function diffGatewayConfig(
  oldConfig: GatewayConfig,
  newConfig: GatewayConfig,
): ConfigDiff {
  const safe: string[] = [];
  const unsafe: string[] = [];

  const flatOld = flattenConfig(oldConfig as unknown as Record<string, unknown>);
  const flatNew = flattenConfig(newConfig as unknown as Record<string, unknown>);

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
  prefix = '',
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenConfig(value as Record<string, unknown>, fullKey));
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

  start(
    onReload: ConfigReloadCallback,
    onError?: ConfigErrorCallback,
  ): void {
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

      this.watcher.on('error', (err) => {
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
