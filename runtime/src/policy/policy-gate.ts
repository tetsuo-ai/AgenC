/**
 * Runtime policy gate hook creation.
 *
 * @module
 */

import type { HookHandler } from "../gateway/hooks.js";
import type { Logger } from "../utils/logger.js";
import { PolicyEngine } from "./engine.js";
import { buildToolPolicyAction } from "./tool-governance.js";
import type {
  GovernanceAuditLog,
} from "./governance-audit-log.js";
import type {
  PolicyEvaluationScope,
  PolicySimulationMode,
} from "./types.js";

export interface CreatePolicyGateHookOptions {
  engine: PolicyEngine;
  logger: Logger;
  simulationMode?: PolicySimulationMode;
  resolveScope?: (
    payload: Record<string, unknown>,
  ) => PolicyEvaluationScope | undefined;
  auditLog?: GovernanceAuditLog;
}

export function createPolicyGateHook(
  options: CreatePolicyGateHookOptions,
): HookHandler {
  return {
    event: "tool:before",
    name: "policy-gate",
    priority: 15,
    handler: async (ctx) => {
      const payload = ctx.payload;
      const toolName =
        typeof payload.toolName === "string" ? payload.toolName : undefined;
      if (!toolName) {
        return { continue: true };
      }

      const args =
        typeof payload.args === "object" &&
        payload.args !== null &&
        !Array.isArray(payload.args)
          ? (payload.args as Record<string, unknown>)
          : {};
      const scope = options.resolveScope?.(payload);
      const action = buildToolPolicyAction({
        toolName,
        args,
        scope,
        extraMetadata: payload,
      });
      const credentialPreview =
        typeof payload.credentialPreview === "object" &&
        payload.credentialPreview !== null &&
        !Array.isArray(payload.credentialPreview)
          ? (payload.credentialPreview as {
              credentialIds?: unknown;
              headerNames?: unknown;
              domains?: unknown;
            })
          : undefined;
      if (
        credentialPreview &&
        Array.isArray(credentialPreview.credentialIds) &&
        credentialPreview.credentialIds.length > 0
      ) {
        action.policyClass = "credential_secret_access";
        action.riskScore = Math.max(action.riskScore ?? 0, 0.9);
        action.metadata = {
          ...(action.metadata ?? {}),
          credentialPreview,
        };
      }
      const simulationMode = options.simulationMode ?? "off";
      const decision =
        simulationMode === "shadow"
          ? options.engine.simulate(action)
          : options.engine.evaluate(action);

      if (decision.allowed) {
        return { continue: true };
      }

      const violationSummary = decision.violations
        .map((violation) => violation.message)
        .join("; ");
      await options.auditLog?.append({
        type:
          simulationMode === "shadow"
            ? "policy.shadow_denied"
            : "policy.denied",
        subject: toolName,
        scope,
        payload: {
          toolName,
          args,
          simulationMode,
          violations: decision.violations,
        },
      });

      if (simulationMode === "shadow") {
        options.logger.warn?.(
          `Policy shadow violation for tool "${toolName}": ${violationSummary}`,
        );
        return { continue: true };
      }

      options.logger.warn?.(
        `Policy blocked tool "${toolName}": ${violationSummary}`,
      );
      return {
        continue: false,
        payload: {
          ...payload,
          blocked: true,
          reason: `Policy blocked tool "${toolName}": ${violationSummary}`,
          violations: decision.violations,
        },
      };
    },
  };
}
