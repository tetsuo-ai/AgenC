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
import { isRecord, isStringArray } from "../utils/type-guards.js";

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
const VALID_LLM_SEARCH_MODES: ReadonlySet<string> = new Set([
  "auto",
  "on",
  "off",
]);
const VALID_SUBAGENT_MODES: ReadonlySet<string> = new Set([
  "manager_tools",
  "handoff",
  "hybrid",
]);
const VALID_SUBAGENT_CHILD_TOOL_ALLOWLIST_STRATEGIES: ReadonlySet<string> =
  new Set(["inherit_intersection", "explicit_only"]);
const VALID_SUBAGENT_FALLBACK_BEHAVIORS: ReadonlySet<string> = new Set([
  "continue_without_delegation",
  "fail_request",
]);
const VALID_SUBAGENT_CHILD_PROVIDER_STRATEGIES: ReadonlySet<string> = new Set([
  "same_as_parent",
  "capability_matched",
]);
const VALID_SUBAGENT_DELEGATION_AGGRESSIVENESS: ReadonlySet<string> = new Set([
  "conservative",
  "balanced",
  "aggressive",
  "adaptive",
]);
const VALID_SUBAGENT_HARD_BLOCKED_TASK_CLASSES: ReadonlySet<string> = new Set([
  "wallet_signing",
  "wallet_transfer",
  "stake_or_rewards",
  "destructive_host_mutation",
  "credential_exfiltration",
]);
const VALID_MEMORY_BACKENDS: ReadonlySet<string> = new Set([
  "memory",
  "sqlite",
  "redis",
]);
const VALID_CIRCUIT_BREAKER_MODES: ReadonlySet<string> = new Set([
  "pause_discovery",
  "halt_submissions",
  "safe_mode",
]);
const VALID_POLICY_SIMULATION_MODES: ReadonlySet<string> = new Set([
  "off",
  "shadow",
]);
const VALID_MCP_TRUST_TIERS: ReadonlySet<string> = new Set([
  "trusted",
  "sandboxed",
  "untrusted",
]);
const VALID_MATCHING_POLICIES: ReadonlySet<string> = new Set([
  "best_price",
  "best_eta",
  "weighted_score",
]);
const VALID_MESSAGING_MODES: ReadonlySet<string> = new Set([
  "on-chain",
  "off-chain",
  "auto",
]);
const DOCKER_MEMORY_LIMIT_RE = /^\d+(?:[bkmg])?$/i;
const DOCKER_CPU_LIMIT_RE = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/i;

function normalizeBindAddress(bind: string): string {
  const normalized = bind.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return normalized.slice(1, -1);
  }
  return normalized;
}

function isLoopbackBind(bind: string | undefined): boolean {
  if (bind === undefined) return true;
  const normalized = normalizeBindAddress(bind);
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

/** Type predicate — returns true when `obj` satisfies the GatewayConfig shape. */
export function isValidGatewayConfig(obj: unknown): obj is GatewayConfig {
  return validateGatewayConfig(obj).valid;
}

function validateGatewaySection(gateway: unknown, errors: string[]): void {
  if (!isRecord(gateway)) {
    errors.push("gateway section is required");
    return;
  }
  requireIntRange(gateway.port, "gateway.port", 1, 65535, errors);
  if (gateway.bind !== undefined && typeof gateway.bind !== "string") {
    errors.push("gateway.bind must be a string");
  }
}

function validateAgentSection(agent: unknown, errors: string[]): void {
  if (!isRecord(agent)) {
    errors.push("agent section is required");
    return;
  }
  if (typeof agent.name !== "string" || agent.name.trim().length === 0) {
    errors.push("agent.name must be a non-empty string");
  }
}

function validateConnectionSection(connection: unknown, errors: string[]): void {
  if (!isRecord(connection)) {
    errors.push("connection section is required");
    return;
  }
  if (
    typeof connection.rpcUrl !== "string" ||
    connection.rpcUrl.trim().length === 0
  ) {
    errors.push("connection.rpcUrl must be a non-empty string");
  }
}

function validateMemorySection(memory: unknown, errors: string[]): void {
  if (memory === undefined) return;
  if (!isRecord(memory)) {
    errors.push("memory must be an object");
    return;
  }
  requireOneOf(memory.backend, "memory.backend", VALID_MEMORY_BACKENDS, errors);
}

function validateAuthSection(auth: unknown, errors: string[]): void {
  if (auth === undefined) return;
  if (!isRecord(auth)) {
    errors.push("auth must be an object");
    return;
  }
  if (auth.secret !== undefined) {
    if (typeof auth.secret !== "string") {
      errors.push("auth.secret must be a string");
    } else if (auth.secret.length < 32) {
      errors.push("auth.secret must be at least 32 characters");
    }
  }
  if (
    auth.expirySeconds !== undefined &&
    typeof auth.expirySeconds !== "number"
  ) {
    errors.push("auth.expirySeconds must be a number");
  }
  if (auth.localBypass !== undefined && typeof auth.localBypass !== "boolean") {
    errors.push("auth.localBypass must be a boolean");
  }
}

function validateAuthSecretRequirement(
  gateway: unknown,
  auth: unknown,
  errors: string[],
): void {
  const bindAddress =
    isRecord(gateway) && typeof gateway.bind === "string"
      ? gateway.bind
      : undefined;
  const authSecret =
    isRecord(auth) && typeof auth.secret === "string" ? auth.secret : undefined;
  if (!isLoopbackBind(bindAddress) && !authSecret?.trim()) {
    errors.push("auth.secret is required when gateway.bind is non-local");
  }
}

function validateDesktopSection(desktop: unknown, errors: string[]): void {
  if (desktop === undefined) return;
  if (!isRecord(desktop)) {
    errors.push("desktop must be an object");
    return;
  }
  if (desktop.enabled !== undefined && typeof desktop.enabled !== "boolean") {
    errors.push("desktop.enabled must be a boolean");
  }
  if (desktop.maxConcurrent !== undefined) {
    requireIntRange(desktop.maxConcurrent, "desktop.maxConcurrent", 1, 32, errors);
  }
  if (desktop.maxMemory !== undefined) {
    if (
      typeof desktop.maxMemory !== "string" ||
      !DOCKER_MEMORY_LIMIT_RE.test(desktop.maxMemory)
    ) {
      errors.push(
        "desktop.maxMemory must be a string like 512m or 4g (plain integers are treated as GB)",
      );
    }
  }
  if (desktop.maxCpu !== undefined) {
    if (
      typeof desktop.maxCpu !== "string" ||
      !DOCKER_CPU_LIMIT_RE.test(desktop.maxCpu)
    ) {
      errors.push(
        "desktop.maxCpu must be a positive numeric string like 0.5 or 2.0",
      );
    } else {
      const parsed = Number.parseFloat(desktop.maxCpu);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        errors.push("desktop.maxCpu must be greater than 0");
      }
    }
  }
  if (desktop.networkMode !== undefined) {
    requireOneOf(
      desktop.networkMode,
      "desktop.networkMode",
      new Set(["none", "bridge"]),
      errors,
    );
  }
  if (desktop.securityProfile !== undefined) {
    requireOneOf(
      desktop.securityProfile,
      "desktop.securityProfile",
      new Set(["strict", "permissive"]),
      errors,
    );
  }
}

function validatePolicySection(policy: unknown, errors: string[]): void {
  validatePolicySectionAtPath(policy, "policy", errors, true);
}

function validatePolicySectionAtPath(
  policy: unknown,
  path: string,
  errors: string[],
  allowBundles: boolean,
): void {
  if (policy === undefined) return;
  if (!isRecord(policy)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (policy.enabled !== undefined && typeof policy.enabled !== "boolean") {
    errors.push(`${path}.enabled must be a boolean`);
  }
  if (
    policy.defaultTenantId !== undefined &&
    typeof policy.defaultTenantId !== "string"
  ) {
    errors.push(`${path}.defaultTenantId must be a string`);
  }
  if (
    policy.defaultProjectId !== undefined &&
    typeof policy.defaultProjectId !== "string"
  ) {
    errors.push(`${path}.defaultProjectId must be a string`);
  }
  if (!allowBundles && policy.simulationMode !== undefined) {
    errors.push(`${path}.simulationMode is not allowed inside nested policy bundles`);
  }
  if (!allowBundles && policy.audit !== undefined) {
    errors.push(`${path}.audit is not allowed inside nested policy bundles`);
  }
  if (!allowBundles && policy.credentialCatalog !== undefined) {
    errors.push(`${path}.credentialCatalog is not allowed inside nested policy bundles`);
  }
  if (policy.simulationMode !== undefined) {
    requireOneOf(
      policy.simulationMode,
      `${path}.simulationMode`,
      VALID_POLICY_SIMULATION_MODES,
      errors,
    );
  }
  if (policy.maxRiskScore !== undefined) {
    if (
      typeof policy.maxRiskScore !== "number" ||
      policy.maxRiskScore < 0 ||
      policy.maxRiskScore > 1
    ) {
      errors.push(`${path}.maxRiskScore must be a number between 0 and 1`);
    }
  }
  if (policy.toolAllowList !== undefined && !isStringArray(policy.toolAllowList)) {
    errors.push(`${path}.toolAllowList must be an array of strings`);
  }
  if (policy.toolDenyList !== undefined && !isStringArray(policy.toolDenyList)) {
    errors.push(`${path}.toolDenyList must be an array of strings`);
  }
  if (
    policy.credentialAllowList !== undefined &&
    !isStringArray(policy.credentialAllowList)
  ) {
    errors.push(`${path}.credentialAllowList must be an array of strings`);
  }
  if (policy.networkAccess !== undefined) {
    if (!isRecord(policy.networkAccess)) {
      errors.push(`${path}.networkAccess must be an object`);
    } else {
      if (
        policy.networkAccess.allowHosts !== undefined &&
        !isStringArray(policy.networkAccess.allowHosts)
      ) {
        errors.push(`${path}.networkAccess.allowHosts must be an array of strings`);
      }
      if (
        policy.networkAccess.denyHosts !== undefined &&
        !isStringArray(policy.networkAccess.denyHosts)
      ) {
        errors.push(`${path}.networkAccess.denyHosts must be an array of strings`);
      }
    }
  }
  if (policy.writeScope !== undefined) {
    if (!isRecord(policy.writeScope)) {
      errors.push(`${path}.writeScope must be an object`);
    } else {
      if (
        policy.writeScope.allowRoots !== undefined &&
        !isStringArray(policy.writeScope.allowRoots)
      ) {
        errors.push(`${path}.writeScope.allowRoots must be an array of strings`);
      }
      if (
        policy.writeScope.denyRoots !== undefined &&
        !isStringArray(policy.writeScope.denyRoots)
      ) {
        errors.push(`${path}.writeScope.denyRoots must be an array of strings`);
      }
    }
  }
  if (allowBundles && policy.credentialCatalog !== undefined) {
    if (!isRecord(policy.credentialCatalog)) {
      errors.push(`${path}.credentialCatalog must be an object`);
    } else {
      for (const [credentialId, value] of Object.entries(policy.credentialCatalog)) {
        if (!isRecord(value)) {
          errors.push(`${path}.credentialCatalog.${credentialId} must be an object`);
          continue;
        }
        if (
          typeof value.sourceEnvVar !== "string" ||
          value.sourceEnvVar.trim().length === 0
        ) {
          errors.push(`${path}.credentialCatalog.${credentialId}.sourceEnvVar must be a non-empty string`);
        }
        if (!isStringArray(value.domains) || value.domains.length === 0) {
          errors.push(`${path}.credentialCatalog.${credentialId}.domains must be a non-empty array of strings`);
        }
        if (
          value.headerTemplates !== undefined &&
          !isRecord(value.headerTemplates)
        ) {
          errors.push(`${path}.credentialCatalog.${credentialId}.headerTemplates must be an object`);
        } else if (isRecord(value.headerTemplates)) {
          for (const [headerName, template] of Object.entries(value.headerTemplates)) {
            if (headerName.trim().length === 0) {
              errors.push(`${path}.credentialCatalog.${credentialId}.headerTemplates contains an empty header name`);
            }
            if (typeof template !== "string" || template.length === 0) {
              errors.push(`${path}.credentialCatalog.${credentialId}.headerTemplates.${headerName} must be a non-empty string`);
            }
          }
        }
        if (
          value.allowedTools !== undefined &&
          !isStringArray(value.allowedTools)
        ) {
          errors.push(`${path}.credentialCatalog.${credentialId}.allowedTools must be an array of strings`);
        }
        if (value.ttlMs !== undefined) {
          requireIntRange(
            value.ttlMs,
            `${path}.credentialCatalog.${credentialId}.ttlMs`,
            1_000,
            86_400_000,
            errors,
          );
        }
      }
    }
  }
  if (policy.actionBudgets !== undefined) {
    validateBudgetMap(policy.actionBudgets, `${path}.actionBudgets`, errors);
  }
  if (policy.spendBudget !== undefined) {
    validateSpendBudget(policy.spendBudget, `${path}.spendBudget`, errors);
  }
  if (policy.tokenBudget !== undefined) {
    validateTokenBudget(policy.tokenBudget, `${path}.tokenBudget`, errors);
  }
  if (policy.runtimeBudget !== undefined) {
    validateRuntimeBudget(policy.runtimeBudget, `${path}.runtimeBudget`, errors);
  }
  if (policy.processBudget !== undefined) {
    validateProcessBudget(policy.processBudget, `${path}.processBudget`, errors);
  }
  if (policy.scopedActionBudgets !== undefined) {
    if (!isRecord(policy.scopedActionBudgets)) {
      errors.push(`${path}.scopedActionBudgets must be an object`);
    } else {
      for (const scopeName of ["tenant", "project", "run"] as const) {
        const scopeValue = policy.scopedActionBudgets[scopeName];
        if (scopeValue !== undefined) {
          validateBudgetMap(
            scopeValue,
            `${path}.scopedActionBudgets.${scopeName}`,
            errors,
          );
        }
      }
    }
  }
  if (policy.scopedSpendBudgets !== undefined) {
    if (!isRecord(policy.scopedSpendBudgets)) {
      errors.push(`${path}.scopedSpendBudgets must be an object`);
    } else {
      for (const scopeName of ["tenant", "project", "run"] as const) {
        const scopeValue = policy.scopedSpendBudgets[scopeName];
        if (scopeValue !== undefined) {
          validateSpendBudget(
            scopeValue,
            `${path}.scopedSpendBudgets.${scopeName}`,
            errors,
          );
        }
      }
    }
  }
  if (policy.scopedTokenBudgets !== undefined) {
    if (!isRecord(policy.scopedTokenBudgets)) {
      errors.push(`${path}.scopedTokenBudgets must be an object`);
    } else {
      for (const scopeName of ["tenant", "project", "run"] as const) {
        const scopeValue = policy.scopedTokenBudgets[scopeName];
        if (scopeValue !== undefined) {
          validateTokenBudget(
            scopeValue,
            `${path}.scopedTokenBudgets.${scopeName}`,
            errors,
          );
        }
      }
    }
  }
  if (policy.scopedRuntimeBudgets !== undefined) {
    if (!isRecord(policy.scopedRuntimeBudgets)) {
      errors.push(`${path}.scopedRuntimeBudgets must be an object`);
    } else {
      for (const scopeName of ["tenant", "project", "run"] as const) {
        const scopeValue = policy.scopedRuntimeBudgets[scopeName];
        if (scopeValue !== undefined) {
          validateRuntimeBudget(
            scopeValue,
            `${path}.scopedRuntimeBudgets.${scopeName}`,
            errors,
          );
        }
      }
    }
  }
  if (policy.scopedProcessBudgets !== undefined) {
    if (!isRecord(policy.scopedProcessBudgets)) {
      errors.push(`${path}.scopedProcessBudgets must be an object`);
    } else {
      for (const scopeName of ["tenant", "project", "run"] as const) {
        const scopeValue = policy.scopedProcessBudgets[scopeName];
        if (scopeValue !== undefined) {
          validateProcessBudget(
            scopeValue,
            `${path}.scopedProcessBudgets.${scopeName}`,
            errors,
          );
        }
      }
    }
  }
  if (policy.policyClassRules !== undefined) {
    if (!isRecord(policy.policyClassRules)) {
      errors.push(`${path}.policyClassRules must be an object`);
    } else {
      const validClasses = new Set([
        "read_only",
        "reversible_side_effect",
        "destructive_side_effect",
        "irreversible_financial_action",
        "credential_secret_access",
      ]);
      for (const [key, value] of Object.entries(policy.policyClassRules)) {
        if (!validClasses.has(key)) {
          errors.push(`${path}.policyClassRules.${key} is not a valid policy class`);
          continue;
        }
        if (!isRecord(value)) {
          errors.push(`${path}.policyClassRules.${key} must be an object`);
          continue;
        }
        if (value.deny !== undefined && typeof value.deny !== "boolean") {
          errors.push(`${path}.policyClassRules.${key}.deny must be a boolean`);
        }
        if (
          value.maxRiskScore !== undefined &&
          (typeof value.maxRiskScore !== "number" ||
            value.maxRiskScore < 0 ||
            value.maxRiskScore > 1)
        ) {
          errors.push(`${path}.policyClassRules.${key}.maxRiskScore must be a number between 0 and 1`);
        }
      }
    }
  }
  if (policy.audit !== undefined) {
    if (!isRecord(policy.audit)) {
      errors.push(`${path}.audit must be an object`);
    } else {
      if (
        policy.audit.enabled !== undefined &&
        typeof policy.audit.enabled !== "boolean"
      ) {
        errors.push(`${path}.audit.enabled must be a boolean`);
      }
      if (
        policy.audit.signingKey !== undefined &&
        typeof policy.audit.signingKey !== "string"
      ) {
        errors.push(`${path}.audit.signingKey must be a string`);
      }
      if (
        policy.audit.retentionMs !== undefined &&
        typeof policy.audit.retentionMs !== "number"
      ) {
        errors.push(`${path}.audit.retentionMs must be a number`);
      } else if (
        typeof policy.audit.retentionMs === "number" &&
        policy.audit.retentionMs <= 0
      ) {
        errors.push(`${path}.audit.retentionMs must be greater than 0`);
      }
      if (
        policy.audit.maxEntries !== undefined &&
        typeof policy.audit.maxEntries !== "number"
      ) {
        errors.push(`${path}.audit.maxEntries must be a number`);
      } else if (
        typeof policy.audit.maxEntries === "number" &&
        policy.audit.maxEntries < 0
      ) {
        errors.push(`${path}.audit.maxEntries must be greater than or equal to 0`);
      }
      if (
        policy.audit.retentionMode !== undefined &&
        policy.audit.retentionMode !== "delete" &&
        policy.audit.retentionMode !== "archive"
      ) {
        errors.push(`${path}.audit.retentionMode must be one of: delete, archive`);
      }
      if (
        policy.audit.legalHold !== undefined &&
        typeof policy.audit.legalHold !== "boolean"
      ) {
        errors.push(`${path}.audit.legalHold must be a boolean`);
      }
      if (policy.audit.redaction !== undefined) {
        if (!isRecord(policy.audit.redaction)) {
          errors.push(`${path}.audit.redaction must be an object`);
        } else {
          if (
            policy.audit.redaction.redactActors !== undefined &&
            typeof policy.audit.redaction.redactActors !== "boolean"
          ) {
            errors.push(`${path}.audit.redaction.redactActors must be a boolean`);
          }
          if (
            policy.audit.redaction.stripFields !== undefined &&
            !isStringArray(policy.audit.redaction.stripFields)
          ) {
            errors.push(
              `${path}.audit.redaction.stripFields must be an array of strings`,
            );
          }
          if (
            policy.audit.redaction.redactPatterns !== undefined &&
            !isStringArray(policy.audit.redaction.redactPatterns)
          ) {
            errors.push(
              `${path}.audit.redaction.redactPatterns must be an array of strings`,
            );
          } else {
            for (const pattern of policy.audit.redaction.redactPatterns ?? []) {
              try {
                // eslint-disable-next-line no-new
                new RegExp(pattern, "g");
              } catch {
                errors.push(
                  `${path}.audit.redaction.redactPatterns contains an invalid regex: ${pattern}`,
                );
              }
            }
          }
        }
      }
    }
  }
  if (allowBundles && policy.tenantBundles !== undefined) {
    if (!isRecord(policy.tenantBundles)) {
      errors.push(`${path}.tenantBundles must be an object`);
    } else {
      for (const [key, value] of Object.entries(policy.tenantBundles)) {
        validatePolicySectionAtPath(
          value,
          `${path}.tenantBundles.${key}`,
          errors,
          false,
        );
      }
    }
  }
  if (allowBundles && policy.projectBundles !== undefined) {
    if (!isRecord(policy.projectBundles)) {
      errors.push(`${path}.projectBundles must be an object`);
    } else {
      for (const [key, value] of Object.entries(policy.projectBundles)) {
        validatePolicySectionAtPath(
          value,
          `${path}.projectBundles.${key}`,
          errors,
          false,
        );
      }
    }
  }
  if (policy.circuitBreaker !== undefined) {
    if (!isRecord(policy.circuitBreaker)) {
      errors.push(`${path}.circuitBreaker must be an object`);
    } else {
      if (
        policy.circuitBreaker.enabled !== undefined &&
        typeof policy.circuitBreaker.enabled !== "boolean"
      ) {
        errors.push(`${path}.circuitBreaker.enabled must be a boolean`);
      }
      if (
        policy.circuitBreaker.threshold !== undefined &&
        typeof policy.circuitBreaker.threshold !== "number"
      ) {
        errors.push(`${path}.circuitBreaker.threshold must be a number`);
      }
      if (
        policy.circuitBreaker.windowMs !== undefined &&
        typeof policy.circuitBreaker.windowMs !== "number"
      ) {
        errors.push(`${path}.circuitBreaker.windowMs must be a number`);
      }
      if (policy.circuitBreaker.mode !== undefined) {
        requireOneOf(
          policy.circuitBreaker.mode,
          `${path}.circuitBreaker.mode`,
          VALID_CIRCUIT_BREAKER_MODES,
          errors,
        );
      }
    }
  }
}

function validateMcpSection(mcp: unknown, errors: string[]): void {
  if (mcp === undefined) return;
  if (!isRecord(mcp)) {
    errors.push("mcp must be an object");
    return;
  }
  if (!Array.isArray(mcp.servers)) {
    errors.push("mcp.servers must be an array");
    return;
  }
  for (const [index, server] of mcp.servers.entries()) {
    const path = `mcp.servers[${index}]`;
    if (!isRecord(server)) {
      errors.push(`${path} must be an object`);
      continue;
    }
    if (typeof server.name !== "string" || server.name.trim().length === 0) {
      errors.push(`${path}.name must be a non-empty string`);
    }
    if (typeof server.command !== "string" || server.command.trim().length === 0) {
      errors.push(`${path}.command must be a non-empty string`);
    }
    if (!isStringArray(server.args)) {
      errors.push(`${path}.args must be an array of strings`);
    }
    if (server.env !== undefined && !isRecord(server.env)) {
      errors.push(`${path}.env must be an object`);
    } else if (isRecord(server.env)) {
      for (const [key, value] of Object.entries(server.env)) {
        if (typeof value !== "string") {
          errors.push(`${path}.env.${key} must be a string`);
        }
      }
    }
    if (server.enabled !== undefined && typeof server.enabled !== "boolean") {
      errors.push(`${path}.enabled must be a boolean`);
    }
    if (server.timeout !== undefined) {
      requireIntRange(server.timeout, `${path}.timeout`, 1, 300_000, errors);
    }
    if (
      server.container !== undefined &&
      server.container !== "desktop"
    ) {
      errors.push(`${path}.container must be "desktop" when provided`);
    }
    if (server.trustTier !== undefined) {
      requireOneOf(
        server.trustTier,
        `${path}.trustTier`,
        VALID_MCP_TRUST_TIERS,
        errors,
      );
    }
    if (server.riskControls !== undefined) {
      if (!isRecord(server.riskControls)) {
        errors.push(`${path}.riskControls must be an object`);
      } else {
        if (
          server.riskControls.toolAllowList !== undefined &&
          !isStringArray(server.riskControls.toolAllowList)
        ) {
          errors.push(`${path}.riskControls.toolAllowList must be an array of strings`);
        }
        if (
          server.riskControls.toolDenyList !== undefined &&
          !isStringArray(server.riskControls.toolDenyList)
        ) {
          errors.push(`${path}.riskControls.toolDenyList must be an array of strings`);
        }
        if (
          server.riskControls.requireApproval !== undefined &&
          typeof server.riskControls.requireApproval !== "boolean"
        ) {
          errors.push(`${path}.riskControls.requireApproval must be a boolean`);
        }
      }
    }
    if (server.supplyChain !== undefined) {
      if (!isRecord(server.supplyChain)) {
        errors.push(`${path}.supplyChain must be an object`);
      } else {
        if (
          server.supplyChain.requirePinnedPackageVersion !== undefined &&
          typeof server.supplyChain.requirePinnedPackageVersion !== "boolean"
        ) {
          errors.push(`${path}.supplyChain.requirePinnedPackageVersion must be a boolean`);
        }
        if (
          server.supplyChain.requireDesktopImageDigest !== undefined &&
          typeof server.supplyChain.requireDesktopImageDigest !== "boolean"
        ) {
          errors.push(`${path}.supplyChain.requireDesktopImageDigest must be a boolean`);
        }
        if (
          server.supplyChain.binarySha256 !== undefined &&
          (typeof server.supplyChain.binarySha256 !== "string" ||
            !SHA256_HEX_RE.test(server.supplyChain.binarySha256))
        ) {
          errors.push(`${path}.supplyChain.binarySha256 must be a 64-character hex SHA-256 digest`);
        }
        if (
          server.supplyChain.catalogSha256 !== undefined &&
          (typeof server.supplyChain.catalogSha256 !== "string" ||
            !SHA256_HEX_RE.test(server.supplyChain.catalogSha256))
        ) {
          errors.push(`${path}.supplyChain.catalogSha256 must be a 64-character hex SHA-256 digest`);
        }
      }
    }
  }
}

function validateBudgetMap(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  for (const [key, val] of Object.entries(value)) {
    if (!isRecord(val)) {
      errors.push(`${path}.${key} must be an object`);
      continue;
    }
    if (typeof val.limit !== "number") {
      errors.push(`${path}.${key}.limit must be a number`);
    }
    if (typeof val.windowMs !== "number") {
      errors.push(`${path}.${key}.windowMs must be a number`);
    }
  }
}

function validateSpendBudget(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (
    typeof value.limitLamports !== "string" ||
    !/^\d+$/.test(value.limitLamports)
  ) {
    errors.push(`${path}.limitLamports must be a decimal string`);
  }
  if (typeof value.windowMs !== "number") {
    errors.push(`${path}.windowMs must be a number`);
  }
}

function validateTokenBudget(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (
    typeof value.limitTokens !== "number" ||
    !Number.isFinite(value.limitTokens) ||
    value.limitTokens <= 0
  ) {
    errors.push(`${path}.limitTokens must be a finite positive number`);
  }
  if (
    typeof value.windowMs !== "number" ||
    !Number.isFinite(value.windowMs) ||
    value.windowMs <= 0
  ) {
    errors.push(`${path}.windowMs must be a finite positive number`);
  }
}

function validateRuntimeBudget(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (
    typeof value.maxElapsedMs !== "number" ||
    !Number.isFinite(value.maxElapsedMs) ||
    value.maxElapsedMs <= 0
  ) {
    errors.push(`${path}.maxElapsedMs must be a finite positive number`);
  }
}

function validateProcessBudget(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return;
  }
  if (
    typeof value.maxConcurrent !== "number" ||
    !Number.isInteger(value.maxConcurrent) ||
    value.maxConcurrent <= 0
  ) {
    errors.push(`${path}.maxConcurrent must be a finite positive integer`);
  }
}

function validateMarketplaceSection(
  marketplace: unknown,
  errors: string[],
): void {
  if (marketplace === undefined) return;
  if (!isRecord(marketplace)) {
    errors.push("marketplace must be an object");
    return;
  }
  if (
    marketplace.enabled !== undefined &&
    typeof marketplace.enabled !== "boolean"
  ) {
    errors.push("marketplace.enabled must be a boolean");
  }
  if (marketplace.defaultMatchingPolicy !== undefined) {
    requireOneOf(
      marketplace.defaultMatchingPolicy,
      "marketplace.defaultMatchingPolicy",
      VALID_MATCHING_POLICIES,
      errors,
    );
  }
  if (marketplace.antiSpam !== undefined) {
    if (!isRecord(marketplace.antiSpam)) {
      errors.push("marketplace.antiSpam must be an object");
    } else {
      if (
        marketplace.antiSpam.maxActiveBidsPerBidderPerTask !== undefined &&
        typeof marketplace.antiSpam.maxActiveBidsPerBidderPerTask !== "number"
      ) {
        errors.push(
          "marketplace.antiSpam.maxActiveBidsPerBidderPerTask must be a number",
        );
      }
      if (
        marketplace.antiSpam.maxBidsPerTask !== undefined &&
        typeof marketplace.antiSpam.maxBidsPerTask !== "number"
      ) {
        errors.push("marketplace.antiSpam.maxBidsPerTask must be a number");
      }
    }
  }
  if (
    marketplace.authorizedSelectorIds !== undefined &&
    !isStringArray(marketplace.authorizedSelectorIds)
  ) {
    errors.push("marketplace.authorizedSelectorIds must be an array of strings");
  }
}

function validateApprovalsSection(approvals: unknown, errors: string[]): void {
  if (approvals === undefined) return;
  if (!isRecord(approvals)) {
    errors.push("approvals must be an object");
    return;
  }
  if (
    approvals.enabled !== undefined &&
    typeof approvals.enabled !== "boolean"
  ) {
    errors.push("approvals.enabled must be a boolean");
  }
  if (
    approvals.timeoutMs !== undefined &&
    typeof approvals.timeoutMs !== "number"
  ) {
    errors.push("approvals.timeoutMs must be a number");
  } else if (
    typeof approvals.timeoutMs === "number" &&
    approvals.timeoutMs <= 0
  ) {
    errors.push("approvals.timeoutMs must be greater than 0");
  }
  if (
    approvals.defaultSlaMs !== undefined &&
    typeof approvals.defaultSlaMs !== "number"
  ) {
    errors.push("approvals.defaultSlaMs must be a number");
  } else if (
    typeof approvals.defaultSlaMs === "number" &&
    approvals.defaultSlaMs <= 0
  ) {
    errors.push("approvals.defaultSlaMs must be greater than 0");
  }
  if (
    approvals.defaultEscalationDelayMs !== undefined &&
    typeof approvals.defaultEscalationDelayMs !== "number"
  ) {
    errors.push("approvals.defaultEscalationDelayMs must be a number");
  } else if (
    typeof approvals.defaultEscalationDelayMs === "number" &&
    approvals.defaultEscalationDelayMs <= 0
  ) {
    errors.push("approvals.defaultEscalationDelayMs must be greater than 0");
  }
  if (
    approvals.resolverSigningKey !== undefined &&
    typeof approvals.resolverSigningKey !== "string"
  ) {
    errors.push("approvals.resolverSigningKey must be a string");
  }
  if (
    typeof approvals.timeoutMs === "number" &&
    typeof approvals.defaultSlaMs === "number" &&
    approvals.defaultSlaMs > approvals.timeoutMs
  ) {
    errors.push("approvals.defaultSlaMs must not exceed approvals.timeoutMs");
  }
  if (
    typeof approvals.timeoutMs === "number" &&
    typeof approvals.defaultEscalationDelayMs === "number" &&
    approvals.defaultEscalationDelayMs > approvals.timeoutMs
  ) {
    errors.push(
      "approvals.defaultEscalationDelayMs must not exceed approvals.timeoutMs",
    );
  }
}

function validateSocialSection(social: unknown, errors: string[]): void {
  if (social === undefined) return;
  if (!isRecord(social)) {
    errors.push("social must be an object");
    return;
  }
  const boolFields = [
    "enabled",
    "discoveryEnabled",
    "messagingEnabled",
    "feedEnabled",
    "collaborationEnabled",
    "reputationEnabled",
  ];
  for (const field of boolFields) {
    if (social[field] !== undefined && typeof social[field] !== "boolean") {
      errors.push(`social.${field} must be a boolean`);
    }
  }
  if (social.messagingMode !== undefined) {
    requireOneOf(
      social.messagingMode,
      "social.messagingMode",
      VALID_MESSAGING_MODES,
      errors,
    );
  }
  if (social.messagingPort !== undefined) {
    requireIntRange(
      social.messagingPort,
      "social.messagingPort",
      0,
      65535,
      errors,
    );
  }
  if (
    social.discoveryCacheTtlMs !== undefined &&
    (typeof social.discoveryCacheTtlMs !== "number" ||
      social.discoveryCacheTtlMs < 0)
  ) {
    errors.push("social.discoveryCacheTtlMs must be a non-negative number");
  }
  if (
    social.discoveryCacheMaxEntries !== undefined &&
    (typeof social.discoveryCacheMaxEntries !== "number" ||
      social.discoveryCacheMaxEntries < 1)
  ) {
    errors.push("social.discoveryCacheMaxEntries must be a positive number");
  }
}

function validateLlmToolFailureCircuitBreakerSection(
  breakerValue: unknown,
  errors: string[],
): void {
  if (breakerValue === undefined) return;
  if (!isRecord(breakerValue)) {
    errors.push("llm.toolFailureCircuitBreaker must be an object");
    return;
  }

  if (
    breakerValue.enabled !== undefined &&
    typeof breakerValue.enabled !== "boolean"
  ) {
    errors.push("llm.toolFailureCircuitBreaker.enabled must be a boolean");
  }
  if (breakerValue.threshold !== undefined) {
    requireIntRange(
      breakerValue.threshold,
      "llm.toolFailureCircuitBreaker.threshold",
      2,
      128,
      errors,
    );
  }
  if (breakerValue.windowMs !== undefined) {
    requireIntRange(
      breakerValue.windowMs,
      "llm.toolFailureCircuitBreaker.windowMs",
      1_000,
      3_600_000,
      errors,
    );
  }
  if (breakerValue.cooldownMs !== undefined) {
    requireIntRange(
      breakerValue.cooldownMs,
      "llm.toolFailureCircuitBreaker.cooldownMs",
      1_000,
      3_600_000,
      errors,
    );
  }
}

function validateLlmRetryPolicySection(
  retryPolicyValue: unknown,
  errors: string[],
): void {
  if (retryPolicyValue === undefined) return;
  if (!isRecord(retryPolicyValue)) {
    errors.push("llm.retryPolicy must be an object");
    return;
  }

  const validFailureClasses = new Set([
    "validation_error",
    "provider_error",
    "authentication_error",
    "rate_limited",
    "timeout",
    "tool_error",
    "budget_exceeded",
    "no_progress",
    "cancelled",
    "unknown",
  ]);

  for (const [failureClass, ruleValue] of Object.entries(retryPolicyValue)) {
    if (!validFailureClasses.has(failureClass)) {
      errors.push(
        `llm.retryPolicy.${failureClass} is not a recognized failure class`,
      );
      continue;
    }
    if (!isRecord(ruleValue)) {
      errors.push(`llm.retryPolicy.${failureClass} must be an object`);
      continue;
    }

    if (ruleValue.maxRetries !== undefined) {
      requireIntRange(
        ruleValue.maxRetries,
        `llm.retryPolicy.${failureClass}.maxRetries`,
        0,
        16,
        errors,
      );
    }
    if (ruleValue.baseDelayMs !== undefined) {
      requireIntRange(
        ruleValue.baseDelayMs,
        `llm.retryPolicy.${failureClass}.baseDelayMs`,
        0,
        120_000,
        errors,
      );
    }
    if (ruleValue.maxDelayMs !== undefined) {
      requireIntRange(
        ruleValue.maxDelayMs,
        `llm.retryPolicy.${failureClass}.maxDelayMs`,
        0,
        600_000,
        errors,
      );
    }
    if (ruleValue.jitter !== undefined && typeof ruleValue.jitter !== "boolean") {
      errors.push(`llm.retryPolicy.${failureClass}.jitter must be a boolean`);
    }
    if (
      ruleValue.circuitBreakerEligible !== undefined &&
      typeof ruleValue.circuitBreakerEligible !== "boolean"
    ) {
      errors.push(
        `llm.retryPolicy.${failureClass}.circuitBreakerEligible must be a boolean`,
      );
    }
  }
}

function validateLlmStatefulResponsesSection(
  statefulResponsesValue: unknown,
  errors: string[],
): void {
  if (statefulResponsesValue === undefined) return;
  if (!isRecord(statefulResponsesValue)) {
    errors.push("llm.statefulResponses must be an object");
    return;
  }

  if (
    statefulResponsesValue.enabled !== undefined &&
    typeof statefulResponsesValue.enabled !== "boolean"
  ) {
    errors.push("llm.statefulResponses.enabled must be a boolean");
  }
  if (
    statefulResponsesValue.store !== undefined &&
    typeof statefulResponsesValue.store !== "boolean"
  ) {
    errors.push("llm.statefulResponses.store must be a boolean");
  }
  if (
    statefulResponsesValue.fallbackToStateless !== undefined &&
    typeof statefulResponsesValue.fallbackToStateless !== "boolean"
  ) {
    errors.push("llm.statefulResponses.fallbackToStateless must be a boolean");
  }

  const compactionValue = statefulResponsesValue.compaction;
  if (compactionValue === undefined) {
    return;
  }
  if (!isRecord(compactionValue)) {
    errors.push("llm.statefulResponses.compaction must be an object");
    return;
  }

  if (
    compactionValue.enabled !== undefined &&
    typeof compactionValue.enabled !== "boolean"
  ) {
    errors.push("llm.statefulResponses.compaction.enabled must be a boolean");
  }
  if (compactionValue.compactThreshold !== undefined) {
    requireIntRange(
      compactionValue.compactThreshold,
      "llm.statefulResponses.compaction.compactThreshold",
      1,
      Number.MAX_SAFE_INTEGER,
      errors,
    );
  }
  if (
    compactionValue.fallbackOnUnsupported !== undefined &&
    typeof compactionValue.fallbackOnUnsupported !== "boolean"
  ) {
    errors.push(
      "llm.statefulResponses.compaction.fallbackOnUnsupported must be a boolean",
    );
  }
  if (
    compactionValue.enabled === true &&
    compactionValue.compactThreshold === undefined
  ) {
    errors.push(
      "llm.statefulResponses.compaction.compactThreshold is required when compaction.enabled is true",
    );
  }
}

function validateLlmToolRoutingSection(
  toolRoutingValue: unknown,
  errors: string[],
): void {
  if (toolRoutingValue === undefined) return;
  if (!isRecord(toolRoutingValue)) {
    errors.push("llm.toolRouting must be an object");
    return;
  }

  if (
    toolRoutingValue.enabled !== undefined &&
    typeof toolRoutingValue.enabled !== "boolean"
  ) {
    errors.push("llm.toolRouting.enabled must be a boolean");
  }
  if (toolRoutingValue.minToolsPerTurn !== undefined) {
    requireIntRange(
      toolRoutingValue.minToolsPerTurn,
      "llm.toolRouting.minToolsPerTurn",
      1,
      256,
      errors,
    );
  }
  if (toolRoutingValue.maxToolsPerTurn !== undefined) {
    requireIntRange(
      toolRoutingValue.maxToolsPerTurn,
      "llm.toolRouting.maxToolsPerTurn",
      1,
      256,
      errors,
    );
  }
  if (toolRoutingValue.maxExpandedToolsPerTurn !== undefined) {
    requireIntRange(
      toolRoutingValue.maxExpandedToolsPerTurn,
      "llm.toolRouting.maxExpandedToolsPerTurn",
      1,
      256,
      errors,
    );
  }
  if (toolRoutingValue.cacheTtlMs !== undefined) {
    requireIntRange(
      toolRoutingValue.cacheTtlMs,
      "llm.toolRouting.cacheTtlMs",
      10_000,
      86_400_000,
      errors,
    );
  }
  if (toolRoutingValue.minCacheConfidence !== undefined) {
    if (
      typeof toolRoutingValue.minCacheConfidence !== "number" ||
      !Number.isFinite(toolRoutingValue.minCacheConfidence) ||
      toolRoutingValue.minCacheConfidence < 0 ||
      toolRoutingValue.minCacheConfidence > 1
    ) {
      errors.push(
        "llm.toolRouting.minCacheConfidence must be a number between 0 and 1",
      );
    }
  }
  if (toolRoutingValue.pivotSimilarityThreshold !== undefined) {
    if (
      typeof toolRoutingValue.pivotSimilarityThreshold !== "number" ||
      !Number.isFinite(toolRoutingValue.pivotSimilarityThreshold) ||
      toolRoutingValue.pivotSimilarityThreshold < 0 ||
      toolRoutingValue.pivotSimilarityThreshold > 1
    ) {
      errors.push(
        "llm.toolRouting.pivotSimilarityThreshold must be a number between 0 and 1",
      );
    }
  }
  if (toolRoutingValue.pivotMissThreshold !== undefined) {
    requireIntRange(
      toolRoutingValue.pivotMissThreshold,
      "llm.toolRouting.pivotMissThreshold",
      1,
      64,
      errors,
    );
  }
  if (
    toolRoutingValue.mandatoryTools !== undefined &&
    !isStringArray(toolRoutingValue.mandatoryTools)
  ) {
    errors.push("llm.toolRouting.mandatoryTools must be a string array");
  }
  if (toolRoutingValue.familyCaps !== undefined) {
    if (!isRecord(toolRoutingValue.familyCaps)) {
      errors.push("llm.toolRouting.familyCaps must be an object");
    } else {
      for (const [family, cap] of Object.entries(toolRoutingValue.familyCaps)) {
        if (
          typeof cap !== "number" ||
          !Number.isFinite(cap) ||
          cap < 1 ||
          cap > 256 ||
          !Number.isInteger(cap)
        ) {
          errors.push(
            `llm.toolRouting.familyCaps.${family} must be an integer between 1 and 256`,
          );
        }
      }
    }
  }
  if (
    toolRoutingValue.minToolsPerTurn !== undefined &&
    toolRoutingValue.maxToolsPerTurn !== undefined &&
    typeof toolRoutingValue.minToolsPerTurn === "number" &&
    typeof toolRoutingValue.maxToolsPerTurn === "number" &&
    toolRoutingValue.minToolsPerTurn > toolRoutingValue.maxToolsPerTurn
  ) {
    errors.push(
      "llm.toolRouting.minToolsPerTurn must be less than or equal to llm.toolRouting.maxToolsPerTurn",
    );
  }
  if (
    toolRoutingValue.maxToolsPerTurn !== undefined &&
    toolRoutingValue.maxExpandedToolsPerTurn !== undefined &&
    typeof toolRoutingValue.maxToolsPerTurn === "number" &&
    typeof toolRoutingValue.maxExpandedToolsPerTurn === "number" &&
    toolRoutingValue.maxExpandedToolsPerTurn < toolRoutingValue.maxToolsPerTurn
  ) {
    errors.push(
      "llm.toolRouting.maxExpandedToolsPerTurn must be greater than or equal to llm.toolRouting.maxToolsPerTurn",
    );
  }
}

function validateLlmSubagentPolicyLearningSection(
  policyLearningValue: unknown,
  errors: string[],
): void {
  if (policyLearningValue === undefined) return;
  if (!isRecord(policyLearningValue)) {
    errors.push("llm.subagents.policyLearning must be an object");
    return;
  }

  if (
    policyLearningValue.enabled !== undefined &&
    typeof policyLearningValue.enabled !== "boolean"
  ) {
    errors.push("llm.subagents.policyLearning.enabled must be a boolean");
  }
  if (policyLearningValue.epsilon !== undefined) {
    if (
      typeof policyLearningValue.epsilon !== "number" ||
      !Number.isFinite(policyLearningValue.epsilon) ||
      policyLearningValue.epsilon < 0 ||
      policyLearningValue.epsilon > 1
    ) {
      errors.push(
        "llm.subagents.policyLearning.epsilon must be a number between 0 and 1",
      );
    }
  }
  if (policyLearningValue.explorationBudget !== undefined) {
    requireIntRange(
      policyLearningValue.explorationBudget,
      "llm.subagents.policyLearning.explorationBudget",
      0,
      1_000_000,
      errors,
    );
  }
  if (policyLearningValue.minSamplesPerArm !== undefined) {
    requireIntRange(
      policyLearningValue.minSamplesPerArm,
      "llm.subagents.policyLearning.minSamplesPerArm",
      1,
      10_000,
      errors,
    );
  }
  if (policyLearningValue.ucbExplorationScale !== undefined) {
    if (
      typeof policyLearningValue.ucbExplorationScale !== "number" ||
      !Number.isFinite(policyLearningValue.ucbExplorationScale) ||
      policyLearningValue.ucbExplorationScale < 0
    ) {
      errors.push(
        "llm.subagents.policyLearning.ucbExplorationScale must be a non-negative number",
      );
    }
  }
  if (policyLearningValue.arms === undefined) return;
  if (!Array.isArray(policyLearningValue.arms)) {
    errors.push("llm.subagents.policyLearning.arms must be an array");
    return;
  }

  for (let i = 0; i < policyLearningValue.arms.length; i++) {
    const arm = policyLearningValue.arms[i];
    if (!isRecord(arm)) {
      errors.push(`llm.subagents.policyLearning.arms[${i}] must be an object`);
      continue;
    }
    if (typeof arm.id !== "string" || arm.id.trim().length === 0) {
      errors.push(
        `llm.subagents.policyLearning.arms[${i}].id must be a non-empty string`,
      );
    }
    if (
      arm.thresholdOffset !== undefined &&
      (
        typeof arm.thresholdOffset !== "number" ||
        !Number.isFinite(arm.thresholdOffset) ||
        arm.thresholdOffset < -1 ||
        arm.thresholdOffset > 1
      )
    ) {
      errors.push(
        `llm.subagents.policyLearning.arms[${i}].thresholdOffset must be a number between -1 and 1`,
      );
    }
    if (arm.description !== undefined && typeof arm.description !== "string") {
      errors.push(
        `llm.subagents.policyLearning.arms[${i}].description must be a string`,
      );
    }
  }
}

function validateLlmSubagentsSection(
  subagentsValue: unknown,
  errors: string[],
): void {
  if (subagentsValue === undefined) return;
  if (!isRecord(subagentsValue)) {
    errors.push("llm.subagents must be an object");
    return;
  }

  if (
    subagentsValue.enabled !== undefined &&
    typeof subagentsValue.enabled !== "boolean"
  ) {
    errors.push("llm.subagents.enabled must be a boolean");
  }
  if (subagentsValue.mode !== undefined) {
    requireOneOf(
      subagentsValue.mode,
      "llm.subagents.mode",
      VALID_SUBAGENT_MODES,
      errors,
    );
  }
  if (subagentsValue.delegationAggressiveness !== undefined) {
    requireOneOf(
      subagentsValue.delegationAggressiveness,
      "llm.subagents.delegationAggressiveness",
      VALID_SUBAGENT_DELEGATION_AGGRESSIVENESS,
      errors,
    );
  }
  if (subagentsValue.maxConcurrent !== undefined) {
    requireIntRange(
      subagentsValue.maxConcurrent,
      "llm.subagents.maxConcurrent",
      1,
      64,
      errors,
    );
  }
  if (subagentsValue.maxDepth !== undefined) {
    requireIntRange(
      subagentsValue.maxDepth,
      "llm.subagents.maxDepth",
      1,
      16,
      errors,
    );
  }
  if (subagentsValue.maxFanoutPerTurn !== undefined) {
    requireIntRange(
      subagentsValue.maxFanoutPerTurn,
      "llm.subagents.maxFanoutPerTurn",
      1,
      64,
      errors,
    );
  }
  if (subagentsValue.maxTotalSubagentsPerRequest !== undefined) {
    requireIntRange(
      subagentsValue.maxTotalSubagentsPerRequest,
      "llm.subagents.maxTotalSubagentsPerRequest",
      1,
      1024,
      errors,
    );
  }
  if (subagentsValue.maxCumulativeToolCallsPerRequestTree !== undefined) {
    requireIntRange(
      subagentsValue.maxCumulativeToolCallsPerRequestTree,
      "llm.subagents.maxCumulativeToolCallsPerRequestTree",
      1,
      4096,
      errors,
    );
  }
  if (subagentsValue.maxCumulativeTokensPerRequestTree !== undefined) {
    requireIntRange(
      subagentsValue.maxCumulativeTokensPerRequestTree,
      "llm.subagents.maxCumulativeTokensPerRequestTree",
      1,
      10_000_000,
      errors,
    );
  }
  if (subagentsValue.defaultTimeoutMs !== undefined) {
    requireIntRange(
      subagentsValue.defaultTimeoutMs,
      "llm.subagents.defaultTimeoutMs",
      1_000,
      3_600_000,
      errors,
    );
  }
  if (subagentsValue.spawnDecisionThreshold !== undefined) {
    if (
      typeof subagentsValue.spawnDecisionThreshold !== "number" ||
      !Number.isFinite(subagentsValue.spawnDecisionThreshold) ||
      subagentsValue.spawnDecisionThreshold < 0 ||
      subagentsValue.spawnDecisionThreshold > 1
    ) {
      errors.push(
        "llm.subagents.spawnDecisionThreshold must be a number between 0 and 1",
      );
    }
  }
  if (subagentsValue.handoffMinPlannerConfidence !== undefined) {
    if (
      typeof subagentsValue.handoffMinPlannerConfidence !== "number" ||
      !Number.isFinite(subagentsValue.handoffMinPlannerConfidence) ||
      subagentsValue.handoffMinPlannerConfidence < 0 ||
      subagentsValue.handoffMinPlannerConfidence > 1
    ) {
      errors.push(
        "llm.subagents.handoffMinPlannerConfidence must be a number between 0 and 1",
      );
    }
  }
  if (
    subagentsValue.forceVerifier !== undefined &&
    typeof subagentsValue.forceVerifier !== "boolean"
  ) {
    errors.push("llm.subagents.forceVerifier must be a boolean");
  }
  if (
    subagentsValue.allowParallelSubtasks !== undefined &&
    typeof subagentsValue.allowParallelSubtasks !== "boolean"
  ) {
    errors.push("llm.subagents.allowParallelSubtasks must be a boolean");
  }
  if (
    subagentsValue.allowedParentTools !== undefined &&
    !isStringArray(subagentsValue.allowedParentTools)
  ) {
    errors.push("llm.subagents.allowedParentTools must be a string array");
  }
  if (
    subagentsValue.forbiddenParentTools !== undefined &&
    !isStringArray(subagentsValue.forbiddenParentTools)
  ) {
    errors.push("llm.subagents.forbiddenParentTools must be a string array");
  }
  if (subagentsValue.hardBlockedTaskClasses !== undefined) {
    if (!isStringArray(subagentsValue.hardBlockedTaskClasses)) {
      errors.push("llm.subagents.hardBlockedTaskClasses must be a string array");
    } else {
      for (let i = 0; i < subagentsValue.hardBlockedTaskClasses.length; i++) {
        const item = subagentsValue.hardBlockedTaskClasses[i];
        if (!VALID_SUBAGENT_HARD_BLOCKED_TASK_CLASSES.has(item)) {
          errors.push(
            `llm.subagents.hardBlockedTaskClasses[${i}] must be one of: ${[...VALID_SUBAGENT_HARD_BLOCKED_TASK_CLASSES].join(", ")}`,
          );
        }
      }
    }
  }
  if (subagentsValue.childToolAllowlistStrategy !== undefined) {
    requireOneOf(
      subagentsValue.childToolAllowlistStrategy,
      "llm.subagents.childToolAllowlistStrategy",
      VALID_SUBAGENT_CHILD_TOOL_ALLOWLIST_STRATEGIES,
      errors,
    );
  }
  if (subagentsValue.childProviderStrategy !== undefined) {
    requireOneOf(
      subagentsValue.childProviderStrategy,
      "llm.subagents.childProviderStrategy",
      VALID_SUBAGENT_CHILD_PROVIDER_STRATEGIES,
      errors,
    );
  }
  if (subagentsValue.fallbackBehavior !== undefined) {
    requireOneOf(
      subagentsValue.fallbackBehavior,
      "llm.subagents.fallbackBehavior",
      VALID_SUBAGENT_FALLBACK_BEHAVIORS,
      errors,
    );
  }

  validateLlmSubagentPolicyLearningSection(
    subagentsValue.policyLearning,
    errors,
  );

  if (
    subagentsValue.maxFanoutPerTurn !== undefined &&
    subagentsValue.maxTotalSubagentsPerRequest !== undefined &&
    typeof subagentsValue.maxFanoutPerTurn === "number" &&
    typeof subagentsValue.maxTotalSubagentsPerRequest === "number" &&
    subagentsValue.maxFanoutPerTurn > subagentsValue.maxTotalSubagentsPerRequest
  ) {
    errors.push(
      "llm.subagents.maxFanoutPerTurn must be less than or equal to llm.subagents.maxTotalSubagentsPerRequest",
    );
  }
}

function validateLlmSection(llm: unknown, errors: string[]): void {
  if (llm === undefined) return;
  if (!isRecord(llm)) {
    errors.push("llm must be an object");
    return;
  }

  requireOneOf(llm.provider, "llm.provider", VALID_LLM_PROVIDERS, errors);
  if (llm.webSearch !== undefined && typeof llm.webSearch !== "boolean") {
    errors.push("llm.webSearch must be a boolean");
  }
  if (llm.searchMode !== undefined) {
    requireOneOf(
      llm.searchMode,
      "llm.searchMode",
      VALID_LLM_SEARCH_MODES,
      errors,
    );
  }

  if (llm.timeoutMs !== undefined) {
    requireIntRange(llm.timeoutMs, "llm.timeoutMs", 1_000, 3_600_000, errors);
  }
  if (llm.requestTimeoutMs !== undefined) {
    requireIntRange(
      llm.requestTimeoutMs,
      "llm.requestTimeoutMs",
      5_000,
      7_200_000,
      errors,
    );
  }
  if (llm.toolCallTimeoutMs !== undefined) {
    requireIntRange(
      llm.toolCallTimeoutMs,
      "llm.toolCallTimeoutMs",
      1_000,
      3_600_000,
      errors,
    );
  }

  validateLlmToolFailureCircuitBreakerSection(llm.toolFailureCircuitBreaker, errors);
  validateLlmRetryPolicySection(llm.retryPolicy, errors);

  if (llm.maxTokens !== undefined) {
    requireIntRange(llm.maxTokens, "llm.maxTokens", 1, 262_144, errors);
  }
  if (llm.contextWindowTokens !== undefined) {
    requireIntRange(
      llm.contextWindowTokens,
      "llm.contextWindowTokens",
      2_048,
      2_000_000,
      errors,
    );
  }
  if (llm.promptHardMaxChars !== undefined) {
    requireIntRange(
      llm.promptHardMaxChars,
      "llm.promptHardMaxChars",
      8_000,
      1_500_000,
      errors,
    );
  }
  if (llm.promptSafetyMarginTokens !== undefined) {
    requireIntRange(
      llm.promptSafetyMarginTokens,
      "llm.promptSafetyMarginTokens",
      128,
      200_000,
      errors,
    );
  }
  if (llm.promptCharPerToken !== undefined) {
    requireIntRange(
      llm.promptCharPerToken,
      "llm.promptCharPerToken",
      1,
      12,
      errors,
    );
  }
  if (llm.maxRuntimeHints !== undefined) {
    requireIntRange(llm.maxRuntimeHints, "llm.maxRuntimeHints", 0, 32, errors);
  }
  if (llm.maxToolRounds !== undefined) {
    requireIntRange(llm.maxToolRounds, "llm.maxToolRounds", 1, 64, errors);
  }
  if (llm.plannerEnabled !== undefined && typeof llm.plannerEnabled !== "boolean") {
    errors.push("llm.plannerEnabled must be a boolean");
  }
  if (llm.plannerMaxTokens !== undefined) {
    requireIntRange(
      llm.plannerMaxTokens,
      "llm.plannerMaxTokens",
      16,
      8_192,
      errors,
    );
  }
  if (llm.toolBudgetPerRequest !== undefined) {
    requireIntRange(
      llm.toolBudgetPerRequest,
      "llm.toolBudgetPerRequest",
      1,
      256,
      errors,
    );
  }
  if (llm.maxModelRecallsPerRequest !== undefined) {
    requireIntRange(
      llm.maxModelRecallsPerRequest,
      "llm.maxModelRecallsPerRequest",
      0,
      128,
      errors,
    );
  }
  if (llm.maxFailureBudgetPerRequest !== undefined) {
    requireIntRange(
      llm.maxFailureBudgetPerRequest,
      "llm.maxFailureBudgetPerRequest",
      1,
      256,
      errors,
    );
  }
  if (llm.parallelToolCalls !== undefined && typeof llm.parallelToolCalls !== "boolean") {
    errors.push("llm.parallelToolCalls must be a boolean");
  }

  validateLlmStatefulResponsesSection(llm.statefulResponses, errors);
  validateLlmToolRoutingSection(llm.toolRouting, errors);
  validateLlmSubagentsSection(llm.subagents, errors);
}

export function validateGatewayConfig(obj: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(obj)) {
    return { valid: false, errors: ["Config must be a non-null object"] };
  }

  validateGatewaySection(obj.gateway, errors);
  validateAgentSection(obj.agent, errors);
  validateConnectionSection(obj.connection, errors);

  // logging (optional — requires process restart to change level)
  if (obj.logging !== undefined) {
    if (!isRecord(obj.logging)) {
      errors.push("logging must be an object");
    } else {
      if (obj.logging.level !== undefined) {
        requireOneOf(
          obj.logging.level,
          "logging.level",
          VALID_LOG_LEVELS,
          errors,
        );
      }
      if (obj.logging.trace !== undefined) {
        if (!isRecord(obj.logging.trace)) {
          errors.push("logging.trace must be an object");
        } else {
          const boolFields = [
            "enabled",
            "includeHistory",
            "includeSystemPrompt",
            "includeToolArgs",
            "includeToolResults",
          ];
          for (const field of boolFields) {
            if (
              obj.logging.trace[field] !== undefined &&
              typeof obj.logging.trace[field] !== "boolean"
            ) {
              errors.push(`logging.trace.${field} must be a boolean`);
            }
          }
          if (obj.logging.trace.maxChars !== undefined) {
            requireIntRange(
              obj.logging.trace.maxChars,
              "logging.trace.maxChars",
              256,
              200_000,
              errors,
            );
          }
        }
      }
    }
  }

  validateLlmSection(obj.llm, errors);

  validateMemorySection(obj.memory, errors);
  validateAuthSection(obj.auth, errors);
  validateAuthSecretRequirement(obj.gateway, obj.auth, errors);
  validateDesktopSection(obj.desktop, errors);
  validateMcpSection(obj.mcp, errors);
  validatePolicySection(obj.policy, errors);
  validateApprovalsSection(obj.approvals, errors);
  validateMarketplaceSection(obj.marketplace, errors);
  validateSocialSection(obj.social, errors);

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
  "marketplace.enabled",
  "social.enabled",
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
