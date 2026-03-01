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
      if (obj.llm.timeoutMs !== undefined) {
        requireIntRange(
          obj.llm.timeoutMs,
          "llm.timeoutMs",
          1_000,
          3_600_000,
          errors,
        );
      }
      if (obj.llm.requestTimeoutMs !== undefined) {
        requireIntRange(
          obj.llm.requestTimeoutMs,
          "llm.requestTimeoutMs",
          5_000,
          7_200_000,
          errors,
        );
      }
      if (obj.llm.toolCallTimeoutMs !== undefined) {
        requireIntRange(
          obj.llm.toolCallTimeoutMs,
          "llm.toolCallTimeoutMs",
          1_000,
          3_600_000,
          errors,
        );
      }
      if (obj.llm.toolFailureCircuitBreaker !== undefined) {
        if (!isRecord(obj.llm.toolFailureCircuitBreaker)) {
          errors.push("llm.toolFailureCircuitBreaker must be an object");
        } else {
          const breaker = obj.llm.toolFailureCircuitBreaker;
          if (
            breaker.enabled !== undefined &&
            typeof breaker.enabled !== "boolean"
          ) {
            errors.push("llm.toolFailureCircuitBreaker.enabled must be a boolean");
          }
          if (breaker.threshold !== undefined) {
            requireIntRange(
              breaker.threshold,
              "llm.toolFailureCircuitBreaker.threshold",
              2,
              128,
              errors,
            );
          }
          if (breaker.windowMs !== undefined) {
            requireIntRange(
              breaker.windowMs,
              "llm.toolFailureCircuitBreaker.windowMs",
              1_000,
              3_600_000,
              errors,
            );
          }
          if (breaker.cooldownMs !== undefined) {
            requireIntRange(
              breaker.cooldownMs,
              "llm.toolFailureCircuitBreaker.cooldownMs",
              1_000,
              3_600_000,
              errors,
            );
          }
        }
      }
      if (obj.llm.retryPolicy !== undefined) {
        if (!isRecord(obj.llm.retryPolicy)) {
          errors.push("llm.retryPolicy must be an object");
        } else {
          const retryPolicy = obj.llm.retryPolicy;
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
          for (const [failureClass, ruleValue] of Object.entries(retryPolicy)) {
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
            if (
              ruleValue.jitter !== undefined &&
              typeof ruleValue.jitter !== "boolean"
            ) {
              errors.push(
                `llm.retryPolicy.${failureClass}.jitter must be a boolean`,
              );
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
      }
      if (obj.llm.maxTokens !== undefined) {
        requireIntRange(
          obj.llm.maxTokens,
          "llm.maxTokens",
          1,
          262_144,
          errors,
        );
      }
      if (obj.llm.contextWindowTokens !== undefined) {
        requireIntRange(
          obj.llm.contextWindowTokens,
          "llm.contextWindowTokens",
          2_048,
          2_000_000,
          errors,
        );
      }
      if (obj.llm.promptHardMaxChars !== undefined) {
        requireIntRange(
          obj.llm.promptHardMaxChars,
          "llm.promptHardMaxChars",
          8_000,
          1_500_000,
          errors,
        );
      }
      if (obj.llm.promptSafetyMarginTokens !== undefined) {
        requireIntRange(
          obj.llm.promptSafetyMarginTokens,
          "llm.promptSafetyMarginTokens",
          128,
          200_000,
          errors,
        );
      }
      if (obj.llm.promptCharPerToken !== undefined) {
        requireIntRange(
          obj.llm.promptCharPerToken,
          "llm.promptCharPerToken",
          1,
          12,
          errors,
        );
      }
      if (obj.llm.maxRuntimeHints !== undefined) {
        requireIntRange(
          obj.llm.maxRuntimeHints,
          "llm.maxRuntimeHints",
          0,
          32,
          errors,
        );
      }
      if (obj.llm.maxToolRounds !== undefined) {
        requireIntRange(
          obj.llm.maxToolRounds,
          "llm.maxToolRounds",
          1,
          64,
          errors,
        );
      }
      if (
        obj.llm.plannerEnabled !== undefined &&
        typeof obj.llm.plannerEnabled !== "boolean"
      ) {
        errors.push("llm.plannerEnabled must be a boolean");
      }
      if (obj.llm.plannerMaxTokens !== undefined) {
        requireIntRange(
          obj.llm.plannerMaxTokens,
          "llm.plannerMaxTokens",
          16,
          8_192,
          errors,
        );
      }
      if (obj.llm.toolBudgetPerRequest !== undefined) {
        requireIntRange(
          obj.llm.toolBudgetPerRequest,
          "llm.toolBudgetPerRequest",
          1,
          256,
          errors,
        );
      }
      if (obj.llm.maxModelRecallsPerRequest !== undefined) {
        requireIntRange(
          obj.llm.maxModelRecallsPerRequest,
          "llm.maxModelRecallsPerRequest",
          0,
          128,
          errors,
        );
      }
      if (obj.llm.maxFailureBudgetPerRequest !== undefined) {
        requireIntRange(
          obj.llm.maxFailureBudgetPerRequest,
          "llm.maxFailureBudgetPerRequest",
          1,
          256,
          errors,
        );
      }
      if (
        obj.llm.parallelToolCalls !== undefined &&
        typeof obj.llm.parallelToolCalls !== "boolean"
      ) {
        errors.push("llm.parallelToolCalls must be a boolean");
      }
      if (obj.llm.statefulResponses !== undefined) {
        if (!isRecord(obj.llm.statefulResponses)) {
          errors.push("llm.statefulResponses must be an object");
        } else {
          if (
            obj.llm.statefulResponses.enabled !== undefined &&
            typeof obj.llm.statefulResponses.enabled !== "boolean"
          ) {
            errors.push("llm.statefulResponses.enabled must be a boolean");
          }
          if (
            obj.llm.statefulResponses.store !== undefined &&
            typeof obj.llm.statefulResponses.store !== "boolean"
          ) {
            errors.push("llm.statefulResponses.store must be a boolean");
          }
          if (
            obj.llm.statefulResponses.fallbackToStateless !== undefined &&
            typeof obj.llm.statefulResponses.fallbackToStateless !== "boolean"
          ) {
            errors.push("llm.statefulResponses.fallbackToStateless must be a boolean");
          }
        }
      }
      if (obj.llm.toolRouting !== undefined) {
        if (!isRecord(obj.llm.toolRouting)) {
          errors.push("llm.toolRouting must be an object");
        } else {
          if (
            obj.llm.toolRouting.enabled !== undefined &&
            typeof obj.llm.toolRouting.enabled !== "boolean"
          ) {
            errors.push("llm.toolRouting.enabled must be a boolean");
          }
          if (obj.llm.toolRouting.minToolsPerTurn !== undefined) {
            requireIntRange(
              obj.llm.toolRouting.minToolsPerTurn,
              "llm.toolRouting.minToolsPerTurn",
              1,
              256,
              errors,
            );
          }
          if (obj.llm.toolRouting.maxToolsPerTurn !== undefined) {
            requireIntRange(
              obj.llm.toolRouting.maxToolsPerTurn,
              "llm.toolRouting.maxToolsPerTurn",
              1,
              256,
              errors,
            );
          }
          if (obj.llm.toolRouting.maxExpandedToolsPerTurn !== undefined) {
            requireIntRange(
              obj.llm.toolRouting.maxExpandedToolsPerTurn,
              "llm.toolRouting.maxExpandedToolsPerTurn",
              1,
              256,
              errors,
            );
          }
          if (obj.llm.toolRouting.cacheTtlMs !== undefined) {
            requireIntRange(
              obj.llm.toolRouting.cacheTtlMs,
              "llm.toolRouting.cacheTtlMs",
              10_000,
              86_400_000,
              errors,
            );
          }
          if (obj.llm.toolRouting.minCacheConfidence !== undefined) {
            if (
              typeof obj.llm.toolRouting.minCacheConfidence !== "number" ||
              !Number.isFinite(obj.llm.toolRouting.minCacheConfidence) ||
              obj.llm.toolRouting.minCacheConfidence < 0 ||
              obj.llm.toolRouting.minCacheConfidence > 1
            ) {
              errors.push(
                "llm.toolRouting.minCacheConfidence must be a number between 0 and 1",
              );
            }
          }
          if (obj.llm.toolRouting.pivotSimilarityThreshold !== undefined) {
            if (
              typeof obj.llm.toolRouting.pivotSimilarityThreshold !== "number" ||
              !Number.isFinite(obj.llm.toolRouting.pivotSimilarityThreshold) ||
              obj.llm.toolRouting.pivotSimilarityThreshold < 0 ||
              obj.llm.toolRouting.pivotSimilarityThreshold > 1
            ) {
              errors.push(
                "llm.toolRouting.pivotSimilarityThreshold must be a number between 0 and 1",
              );
            }
          }
          if (obj.llm.toolRouting.pivotMissThreshold !== undefined) {
            requireIntRange(
              obj.llm.toolRouting.pivotMissThreshold,
              "llm.toolRouting.pivotMissThreshold",
              1,
              64,
              errors,
            );
          }
          if (
            obj.llm.toolRouting.mandatoryTools !== undefined &&
            !isStringArray(obj.llm.toolRouting.mandatoryTools)
          ) {
            errors.push("llm.toolRouting.mandatoryTools must be a string array");
          }
          if (obj.llm.toolRouting.familyCaps !== undefined) {
            if (!isRecord(obj.llm.toolRouting.familyCaps)) {
              errors.push("llm.toolRouting.familyCaps must be an object");
            } else {
              for (const [family, cap] of Object.entries(
                obj.llm.toolRouting.familyCaps,
              )) {
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
            obj.llm.toolRouting.minToolsPerTurn !== undefined &&
            obj.llm.toolRouting.maxToolsPerTurn !== undefined &&
            typeof obj.llm.toolRouting.minToolsPerTurn === "number" &&
            typeof obj.llm.toolRouting.maxToolsPerTurn === "number" &&
            obj.llm.toolRouting.minToolsPerTurn >
              obj.llm.toolRouting.maxToolsPerTurn
          ) {
            errors.push(
              "llm.toolRouting.minToolsPerTurn must be less than or equal to llm.toolRouting.maxToolsPerTurn",
            );
          }
          if (
            obj.llm.toolRouting.maxToolsPerTurn !== undefined &&
            obj.llm.toolRouting.maxExpandedToolsPerTurn !== undefined &&
            typeof obj.llm.toolRouting.maxToolsPerTurn === "number" &&
            typeof obj.llm.toolRouting.maxExpandedToolsPerTurn === "number" &&
            obj.llm.toolRouting.maxExpandedToolsPerTurn <
              obj.llm.toolRouting.maxToolsPerTurn
          ) {
            errors.push(
              "llm.toolRouting.maxExpandedToolsPerTurn must be greater than or equal to llm.toolRouting.maxToolsPerTurn",
            );
          }
        }
      }
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

  // policy (optional)
  if (obj.policy !== undefined) {
    if (!isRecord(obj.policy)) {
      errors.push("policy must be an object");
    } else {
      if (
        obj.policy.enabled !== undefined &&
        typeof obj.policy.enabled !== "boolean"
      ) {
        errors.push("policy.enabled must be a boolean");
      }
      if (obj.policy.maxRiskScore !== undefined) {
        if (
          typeof obj.policy.maxRiskScore !== "number" ||
          obj.policy.maxRiskScore < 0 ||
          obj.policy.maxRiskScore > 1
        ) {
          errors.push("policy.maxRiskScore must be a number between 0 and 1");
        }
      }
      if (
        obj.policy.toolAllowList !== undefined &&
        !isStringArray(obj.policy.toolAllowList)
      ) {
        errors.push("policy.toolAllowList must be an array of strings");
      }
      if (
        obj.policy.toolDenyList !== undefined &&
        !isStringArray(obj.policy.toolDenyList)
      ) {
        errors.push("policy.toolDenyList must be an array of strings");
      }
      if (obj.policy.actionBudgets !== undefined) {
        if (!isRecord(obj.policy.actionBudgets)) {
          errors.push("policy.actionBudgets must be an object");
        } else {
          for (const [key, val] of Object.entries(
            obj.policy.actionBudgets as Record<string, unknown>,
          )) {
            if (!isRecord(val)) {
              errors.push(`policy.actionBudgets.${key} must be an object`);
            } else {
              if (typeof val.limit !== "number") {
                errors.push(
                  `policy.actionBudgets.${key}.limit must be a number`,
                );
              }
              if (typeof val.windowMs !== "number") {
                errors.push(
                  `policy.actionBudgets.${key}.windowMs must be a number`,
                );
              }
            }
          }
        }
      }
      if (obj.policy.spendBudget !== undefined) {
        if (!isRecord(obj.policy.spendBudget)) {
          errors.push("policy.spendBudget must be an object");
        } else {
          if (
            typeof obj.policy.spendBudget.limitLamports !== "string" ||
            !/^\d+$/.test(obj.policy.spendBudget.limitLamports)
          ) {
            errors.push(
              "policy.spendBudget.limitLamports must be a decimal string",
            );
          }
          if (typeof obj.policy.spendBudget.windowMs !== "number") {
            errors.push("policy.spendBudget.windowMs must be a number");
          }
        }
      }
      if (obj.policy.circuitBreaker !== undefined) {
        if (!isRecord(obj.policy.circuitBreaker)) {
          errors.push("policy.circuitBreaker must be an object");
        } else {
          if (
            obj.policy.circuitBreaker.enabled !== undefined &&
            typeof obj.policy.circuitBreaker.enabled !== "boolean"
          ) {
            errors.push(
              "policy.circuitBreaker.enabled must be a boolean",
            );
          }
          if (
            obj.policy.circuitBreaker.threshold !== undefined &&
            typeof obj.policy.circuitBreaker.threshold !== "number"
          ) {
            errors.push(
              "policy.circuitBreaker.threshold must be a number",
            );
          }
          if (
            obj.policy.circuitBreaker.windowMs !== undefined &&
            typeof obj.policy.circuitBreaker.windowMs !== "number"
          ) {
            errors.push(
              "policy.circuitBreaker.windowMs must be a number",
            );
          }
          if (obj.policy.circuitBreaker.mode !== undefined) {
            requireOneOf(
              obj.policy.circuitBreaker.mode,
              "policy.circuitBreaker.mode",
              VALID_CIRCUIT_BREAKER_MODES,
              errors,
            );
          }
        }
      }
    }
  }

  // marketplace (optional)
  if (obj.marketplace !== undefined) {
    if (!isRecord(obj.marketplace)) {
      errors.push("marketplace must be an object");
    } else {
      if (
        obj.marketplace.enabled !== undefined &&
        typeof obj.marketplace.enabled !== "boolean"
      ) {
        errors.push("marketplace.enabled must be a boolean");
      }
      if (obj.marketplace.defaultMatchingPolicy !== undefined) {
        requireOneOf(
          obj.marketplace.defaultMatchingPolicy,
          "marketplace.defaultMatchingPolicy",
          VALID_MATCHING_POLICIES,
          errors,
        );
      }
      if (obj.marketplace.antiSpam !== undefined) {
        if (!isRecord(obj.marketplace.antiSpam)) {
          errors.push("marketplace.antiSpam must be an object");
        } else {
          if (
            obj.marketplace.antiSpam.maxActiveBidsPerBidderPerTask !==
              undefined &&
            typeof obj.marketplace.antiSpam.maxActiveBidsPerBidderPerTask !==
              "number"
          ) {
            errors.push(
              "marketplace.antiSpam.maxActiveBidsPerBidderPerTask must be a number",
            );
          }
          if (
            obj.marketplace.antiSpam.maxBidsPerTask !== undefined &&
            typeof obj.marketplace.antiSpam.maxBidsPerTask !== "number"
          ) {
            errors.push(
              "marketplace.antiSpam.maxBidsPerTask must be a number",
            );
          }
        }
      }
      if (
        obj.marketplace.authorizedSelectorIds !== undefined &&
        !isStringArray(obj.marketplace.authorizedSelectorIds)
      ) {
        errors.push(
          "marketplace.authorizedSelectorIds must be an array of strings",
        );
      }
    }
  }

  // social (optional)
  if (obj.social !== undefined) {
    if (!isRecord(obj.social)) {
      errors.push("social must be an object");
    } else {
      const boolFields = [
        "enabled",
        "discoveryEnabled",
        "messagingEnabled",
        "feedEnabled",
        "collaborationEnabled",
        "reputationEnabled",
      ];
      for (const field of boolFields) {
        if (
          obj.social[field] !== undefined &&
          typeof obj.social[field] !== "boolean"
        ) {
          errors.push(`social.${field} must be a boolean`);
        }
      }
      if (obj.social.messagingMode !== undefined) {
        requireOneOf(
          obj.social.messagingMode,
          "social.messagingMode",
          VALID_MESSAGING_MODES,
          errors,
        );
      }
      if (obj.social.messagingPort !== undefined) {
        requireIntRange(
          obj.social.messagingPort,
          "social.messagingPort",
          0,
          65535,
          errors,
        );
      }
      if (
        obj.social.discoveryCacheTtlMs !== undefined &&
        (typeof obj.social.discoveryCacheTtlMs !== "number" ||
          obj.social.discoveryCacheTtlMs < 0)
      ) {
        errors.push(
          "social.discoveryCacheTtlMs must be a non-negative number",
        );
      }
      if (
        obj.social.discoveryCacheMaxEntries !== undefined &&
        (typeof obj.social.discoveryCacheMaxEntries !== "number" ||
          obj.social.discoveryCacheMaxEntries < 1)
      ) {
        errors.push(
          "social.discoveryCacheMaxEntries must be a positive number",
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
