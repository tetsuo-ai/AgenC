/**
 * Semantic key building, recovery hints, and stateful summary functions for ChatExecutor.
 *
 * @module
 */

import type {
  ToolCallRecord,
  RecoveryHint,
  ChatCallUsageRecord,
  ChatStatefulSummary,
} from "./chat-executor-types.js";
import type { LLMStatefulDiagnostics, LLMStatefulFallbackReason } from "./types.js";
import { SHELL_BUILTIN_COMMANDS } from "./chat-executor-constants.js";
import {
  didToolCallFail,
  extractToolFailureText,
} from "./chat-executor-tool-utils.js";

export function buildSemanticToolCallKey(
  name: string,
  args: Record<string, unknown>,
): string {
  return `${name}:${normalizeSemanticValue(args)}`;
}

export function normalizeSemanticValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => normalizeSemanticValue(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map(
        (key) =>
          `${key}:${normalizeSemanticValue(obj[key])}`,
      )
      .join(",")}}`;
  }
  return String(value);
}

export function summarizeStateful(
  callUsage: readonly ChatCallUsageRecord[],
): ChatStatefulSummary | undefined {
  const entries = callUsage
    .map((entry) => entry.statefulDiagnostics)
    .filter(
      (entry): entry is LLMStatefulDiagnostics =>
        entry !== undefined && entry.enabled,
    );
  if (entries.length === 0) return undefined;

  const fallbackReasons: Record<LLMStatefulFallbackReason, number> = {
    missing_previous_response_id: 0,
    provider_retrieval_failure: 0,
    state_reconciliation_mismatch: 0,
  };
  let attemptedCalls = 0;
  let continuedCalls = 0;
  let fallbackCalls = 0;

  for (const entry of entries) {
    if (entry.attempted) attemptedCalls++;
    if (entry.continued) continuedCalls++;
    if (entry.fallbackReason) {
      fallbackCalls++;
      fallbackReasons[entry.fallbackReason] += 1;
    }
  }

  return {
    enabled: true,
    attemptedCalls,
    continuedCalls,
    fallbackCalls,
    fallbackReasons,
  };
}

export function buildRecoveryHints(
  roundCalls: readonly ToolCallRecord[],
  emittedHints: Set<string>,
): RecoveryHint[] {
  const hints: RecoveryHint[] = [];
  for (const call of roundCalls) {
    const hint = inferRecoveryHint(call);
    if (!hint) continue;
    if (emittedHints.has(hint.key)) continue;
    emittedHints.add(hint.key);
    hints.push(hint);
  }
  return hints;
}

export function inferRecoveryHint(
  call: ToolCallRecord,
): RecoveryHint | undefined {
  if (!didToolCallFail(call.isError, call.result)) return undefined;

  const failureText = extractToolFailureText(call);
  const failureTextLower = failureText.toLowerCase();

  if (call.name === "system.bash") {
    const command = String(call.args?.command ?? "").trim().toLowerCase();
    const isBuiltin = command.length > 0 && SHELL_BUILTIN_COMMANDS.has(command);
    if (
      isBuiltin ||
      failureTextLower.includes("shell builtin") ||
      /spawn\s+\S+\s+enoent/i.test(failureText)
    ) {
      return {
        key: "system-bash-shell-builtin",
        message:
          "system.bash executes one real binary only. Shell builtins (for example `set`, `cd`, `export`) " +
          "and script-style command chains do not work there. Use executable + args, or move multi-line/chained logic to `desktop.bash`.",
      };
    }
    if (
      failureTextLower.includes("one executable token") ||
      failureTextLower.includes("shell operators/newlines")
    ) {
      return {
        key: "system-bash-command-shape",
        message:
          "system.bash `command` must be a single executable token. Put flags/operands in `args`. " +
          "For pipes/redirection/heredocs or multi-line shell scripts, use `desktop.bash`.",
      };
    }
    if (failureTextLower.includes("nested shell invocation")) {
      return {
        key: "system-bash-shell-reinvocation",
        message:
          "system.bash already runs commands in a shell. Do NOT wrap with `bash -c` or `sh -c`. " +
          "Pass the inner command directly as `command` (omit `args` for shell mode). " +
          'Example: instead of command="bash -c \'curl http://...\'" use command="curl http://...".',
      };
    }
  }

  if (
    call.name === "system.browse" ||
    call.name === "system.httpGet" ||
    call.name === "system.httpPost" ||
    call.name === "system.httpFetch"
  ) {
    if (
      failureTextLower.includes("private/loopback address blocked") ||
      failureTextLower.includes("ssrf target blocked")
    ) {
      return {
        key: "localhost-ssrf-blocked",
        message:
          "system.browse/system.http* block localhost/private/internal addresses by design. " +
          "For local service checks on the HOST, use system.bash with curl (e.g. command=\"curl -sSf http://127.0.0.1:PORT\"). " +
          "Desktop tools run inside Docker and CANNOT reach the host's localhost.",
      };
    }
  }

  return undefined;
}
