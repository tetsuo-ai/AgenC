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
  ChatPlannerSummary,
  EvaluationResult,
  ExecutionContext,
  FullPlannerSummaryState,
} from "./chat-executor-types.js";
import type { LLMStatefulDiagnostics, LLMStatefulFallbackReason } from "./types.js";
import type { LLMPipelineStopReason } from "./policy.js";
import type {
  DelegationTrajectoryFinalReward,
  DelegationTrajectoryRecord,
} from "./delegation-learning.js";
import { SHELL_BUILTIN_COMMANDS } from "./chat-executor-constants.js";
import {
  didToolCallFail,
  extractToolFailureText,
  normalizeDoomScreenResolution,
  parseToolResultObject,
} from "./chat-executor-tool-utils.js";

const DESKTOP_BIASED_SYSTEM_COMMANDS = new Set([
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "playwright",
  "gdb",
]);
const SHELL_WRAPPER_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "csh",
  "fish",
  "ksh",
  "tcsh",
]);

function extractDeniedCommand(failureText: string): string | undefined {
  const quotedDouble = failureText.match(/command\s+"([^"]+)"\s+is denied/i);
  if (quotedDouble && quotedDouble[1]?.trim().length) {
    return quotedDouble[1].trim();
  }
  const quotedSingle = failureText.match(/command\s+'([^']+)'\s+is denied/i);
  if (quotedSingle && quotedSingle[1]?.trim().length) {
    return quotedSingle[1].trim();
  }
  return undefined;
}

function extractSpawnEnoentCommand(failureText: string): string | undefined {
  const match = failureText.match(/spawn\s+([^\s]+)\s+enoent/i);
  const command = match?.[1]?.trim();
  return command && command.length > 0 ? command : undefined;
}

function commandBasename(command: string): string {
  const normalized = command.trim().replace(/\\/g, "/");
  const parts = normalized.split("/");
  return (parts[parts.length - 1] ?? normalized).toLowerCase();
}

function isNodeInterpreterCommand(command: string): boolean {
  const base = commandBasename(command);
  return base === "node" || base.startsWith("node");
}

function isPythonInterpreterCommand(command: string): boolean {
  const base = commandBasename(command);
  return base === "python" || /^python\d+(?:\.\d+)?$/.test(base);
}

function isAgencRuntimeNodeInvocation(args: Record<string, unknown>): boolean {
  const raw = args.args;
  if (!Array.isArray(raw)) return false;
  const first = raw.find((value) => typeof value === "string");
  if (typeof first !== "string") return false;
  const normalized = first.toLowerCase().replace(/\\/g, "/");
  return (
    normalized.endsWith("runtime/dist/bin/agenc-runtime.js") ||
    normalized.endsWith("bin/agenc-runtime.js") ||
    normalized === "agenc-runtime.js"
  );
}

function isDesktopSessionUnavailable(failureTextLower: string): boolean {
  return (
    failureTextLower.includes("requires desktop session") ||
    failureTextLower.includes('tool not found: "desktop.bash"') ||
    failureTextLower.includes("tool not found: 'desktop.bash'")
  );
}

function isDesktopBiasedSystemCommandFailure(
  command: string,
  failureTextLower: string,
): boolean {
  if (!DESKTOP_BIASED_SYSTEM_COMMANDS.has(command)) return false;
  return (
    failureTextLower.includes("enoent") ||
    failureTextLower.includes("command not found") ||
    failureTextLower.includes("is denied") ||
    failureTextLower.includes("not found")
  );
}

function hasBrokenHeredocConjunctionShape(
  args: Record<string, unknown> | undefined,
  failureTextLower: string,
): boolean {
  if (!failureTextLower.includes("syntax error near unexpected token")) {
    return false;
  }
  const command =
    typeof args?.command === "string" ? args.command : "";
  if (!command.includes("<<")) return false;
  return /\n\s*(?:&&|\|\||;)\s+\S/.test(command);
}

function isWatchModeTestRunnerFailure(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
  failureTextLower: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  if (!parsedResult || parsedResult.timedOut !== true) return false;

  const command = String(call.args?.command ?? "").trim().toLowerCase();
  const args = Array.isArray(call.args?.args)
    ? call.args.args
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase())
    : [];
  const stdout = typeof parsedResult.stdout === "string"
    ? parsedResult.stdout.toLowerCase()
    : "";
  const stderr = typeof parsedResult.stderr === "string"
    ? parsedResult.stderr.toLowerCase()
    : "";
  const watchSignal =
    stdout.includes("watching for file changes") ||
    stdout.includes("press h to show help") ||
    stdout.includes("press q to quit") ||
    stderr.includes("watching for file changes");
  if (!watchSignal) return false;

  return (
    command === "vitest" ||
    command === "jest" ||
    command === "npm" ||
    command === "pnpm" ||
    command === "yarn" ||
    command === "bun" ||
    args.includes("test") ||
    args.includes("vitest") ||
    failureTextLower.includes("vitest") ||
    failureTextLower.includes("jest")
  );
}

function isTestRunnerCommand(
  call: ToolCallRecord,
  failureTextLower: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  const args = Array.isArray(call.args?.args)
    ? call.args.args
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase())
    : [];
  const joined = [command, ...args].join(" ");
  const invokesDirectTestArtifact =
    isNodeInterpreterCommand(command) &&
    args.some((value) =>
      /(^|\/)(?:dist\/)?(?:test|tests|__tests__)\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
        value,
      ) ||
      /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(value)
    );
  if (/\b(?:vitest|jest|pytest|mocha|ava)\b/.test(joined)) {
    return true;
  }
  if (invokesDirectTestArtifact) {
    return true;
  }
  if (
    ["npm", "pnpm", "yarn", "bun"].includes(command) &&
    args.some((value) =>
      value === "test" ||
      value === "vitest" ||
      value === "coverage" ||
      value === "jest"
    )
  ) {
    return true;
  }
  return failureTextLower.includes("vitest") || failureTextLower.includes("jest");
}

function isTimedOutNonWatchTestRunnerFailure(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
  failureTextLower: string,
): boolean {
  if (!parsedResult || parsedResult.timedOut !== true) {
    return false;
  }
  if (isWatchModeTestRunnerFailure(call, parsedResult, failureTextLower)) {
    return false;
  }
  return isTestRunnerCommand(call, failureTextLower);
}

function isVitestUnsupportedThreadsFlagFailure(
  call: ToolCallRecord,
  failureTextLower: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  const args = Array.isArray(call.args?.args)
    ? call.args.args
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase())
    : [];
  const joined = [command, ...args].join(" ");
  if (
    !joined.includes("vitest") &&
    !failureTextLower.includes("vitest")
  ) {
    return false;
  }
  if (
    !failureTextLower.includes("unknown option") ||
    !failureTextLower.includes("--threads")
  ) {
    return false;
  }
  return joined.includes("--threads") || joined.includes("--no-threads");
}

function isUnsupportedWorkspaceProtocolFailure(failureTextLower: string): boolean {
  return (
    failureTextLower.includes("unsupported url type \"workspace:\"") ||
    failureTextLower.includes("unsupported url type 'workspace:'") ||
    failureTextLower.includes("eunsupportedprotocol")
  );
}

function isRecursiveNpmInstallLifecycleFailure(
  call: ToolCallRecord,
  parsedResult: Record<string, unknown> | null,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  if (command !== "npm") return false;
  const args = Array.isArray(call.args?.args)
    ? call.args.args
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.toLowerCase())
    : [];
  if (!args.includes("install")) return false;

  const stdout = typeof parsedResult?.stdout === "string"
    ? parsedResult.stdout.toLowerCase()
    : "";
  const stderr = typeof parsedResult?.stderr === "string"
    ? parsedResult.stderr.toLowerCase()
    : "";
  const combined = `${stdout}\n${stderr}`;
  return (
    />\s+.+?\s+install\s*\n>\s+npm install/.test(combined) ||
    (
      combined.includes("lifecycle script `install` failed") &&
      combined.includes("> npm install")
    )
  );
}

function extractMissingNpmScriptName(failureText: string): string | undefined {
  const match = failureText.match(/missing script:\s*["'`]?([^"'`\n]+)["'`]?/i);
  const scriptName = match?.[1]?.trim();
  return scriptName && scriptName.length > 0 ? scriptName : undefined;
}

function extractRequestedNpmWorkspaceSelectors(
  call: ToolCallRecord,
): readonly string[] {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return [];
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  if (command !== "npm") return [];
  const args = Array.isArray(call.args?.args)
    ? call.args.args.filter((value): value is string => typeof value === "string")
    : [];
  const selectors: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]?.trim();
    if (!value) continue;
    if (value.startsWith("--workspace=")) {
      const selector = value.slice("--workspace=".length).trim();
      if (selector.length > 0) selectors.push(selector);
      continue;
    }
    if (value === "--workspace") {
      const selector = args[index + 1]?.trim();
      if (selector && selector.length > 0) {
        selectors.push(selector);
        index += 1;
      }
    }
  }
  return selectors;
}

function isMissingNpmScriptFailure(
  call: ToolCallRecord,
  failureText: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  return command.includes("npm") && extractMissingNpmScriptName(failureText) !== undefined;
}

function isMissingNpmWorkspaceFailure(
  call: ToolCallRecord,
  failureText: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "").trim().toLowerCase();
  if (command !== "npm") return false;
  return /npm error no workspaces found:/i.test(failureText);
}

function isMissingLocalPackageDistFailure(failureText: string): boolean {
  return /cannot find (?:package|module)\s+['"][^'"]*\/node_modules\/[^'"]*\/dist\/[^'"]+['"]/i
    .test(failureText);
}

function isTypescriptRootDirScopeFailure(failureText: string): boolean {
  return /ts6059/i.test(failureText) && /is not under ['"`]rootdir['"`]/i.test(failureText);
}

function isPackagePathNotExportedFailure(failureTextLower: string): boolean {
  return (
    failureTextLower.includes("err_package_path_not_exported") ||
    failureTextLower.includes("no \"exports\" main defined")
  );
}

function usesCommonJsRequireSnippet(call: ToolCallRecord): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "");
  if (!/\bnode\b/i.test(command)) return false;
  return /\brequire\s*\(/.test(command);
}

function hasExtendedGrepPatternWithoutFlag(
  args: Record<string, unknown> | undefined,
): boolean {
  const rawArgs = Array.isArray(args?.args)
    ? args.args.filter((value): value is string => typeof value === "string")
    : [];
  if (rawArgs.length === 0) return false;
  const hasExtendedFlag = rawArgs.some((value) => value === "-E" || value === "-P");
  if (hasExtendedFlag) return false;
  return rawArgs.some((value) => {
    if (value.startsWith("-")) return false;
    return value.includes("|");
  });
}

function isLikelyGrepOperandShapeFailure(
  call: ToolCallRecord,
  failureTextLower: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  const command = String(call.args?.command ?? "");
  if (commandBasename(command) !== "grep") return false;
  if (failureTextLower.includes("no such file or directory")) return true;
  return hasExtendedGrepPatternWithoutFlag(call.args);
}

function isLikelyLiteralGlobFailure(
  call: ToolCallRecord,
  failureTextLower: string,
): boolean {
  if (call.name !== "system.bash" && call.name !== "desktop.bash") return false;
  if (
    !failureTextLower.includes("no such file or directory") &&
    !failureTextLower.includes("cannot access")
  ) {
    return false;
  }
  const rawArgs = Array.isArray(call.args?.args)
    ? call.args.args.filter((value): value is string => typeof value === "string")
    : [];
  if (rawArgs.length === 0) return false;
  return rawArgs.some((value) => {
    if (value.startsWith("-")) return false;
    if (!/[/?[*\]]/.test(value)) return false;
    return value.includes("/") || value.includes(".");
  });
}

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
    unsupported: 0,
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
  const roundHint = inferRoundRecoveryHint(roundCalls);
  if (roundHint && !emittedHints.has(roundHint.key)) {
    emittedHints.add(roundHint.key);
    hints.push(roundHint);
  }
  for (const call of roundCalls) {
    const hint = inferRecoveryHint(call);
    if (!hint) continue;
    if (emittedHints.has(hint.key)) continue;
    emittedHints.add(hint.key);
    hints.push(hint);
  }
  return hints;
}

function inferRoundRecoveryHint(
  roundCalls: readonly ToolCallRecord[],
): RecoveryHint | undefined {
  const failedManagedStop = roundCalls.some((call) => {
    if (call.name !== "desktop.process_stop") return false;
    if (!didToolCallFail(call.isError, call.result)) return false;
    return extractToolFailureText(call)
      .toLowerCase()
      .includes("managed process not found");
  });
  if (!failedManagedStop) return undefined;

  const usedDoomShellStopFallback = roundCalls.some((call) => {
    if (call.name !== "desktop.bash") return false;
    const command = String(call.args?.command ?? "");
    if (!/\b(?:doom|vizdoom)\b/i.test(command)) return false;
    return /\b(?:ps|pgrep|pkill|kill)\b/i.test(command);
  });
  if (!usedDoomShellStopFallback) return undefined;

  return {
    key: "doom-stop-via-mcp",
    message:
      "To stop Doom, call `mcp.doom.stop_game` directly. Do not inspect or kill ViZDoom with " +
      "`desktop.process_stop`, `kill`, or `pkill`; the running game is owned by the Doom MCP, " +
      "not the managed desktop-process registry.",
  };
}

export function inferRecoveryHint(
  call: ToolCallRecord,
): RecoveryHint | undefined {
  const parsedResult = parseToolResultObject(call.result);
  if (
    call.name === "mcp.doom.start_game" &&
    didToolCallFail(call.isError, call.result) &&
    typeof call.args?.screen_resolution === "string"
  ) {
    const normalizedResolution = normalizeDoomScreenResolution(
      call.args.screen_resolution,
    );
    if (
      typeof normalizedResolution === "string" &&
      normalizedResolution !== call.args.screen_resolution
    ) {
      return {
        key: "doom-start-game-invalid-resolution",
        message:
          "Doom screen resolutions must use the exact ViZDoom enum string. " +
          `Retry with \`${normalizedResolution}\` instead of \`${call.args.screen_resolution}\`.`,
      };
    }
  }

  if (
    call.name === "mcp.doom.start_game" &&
    !didToolCallFail(call.isError, call.result) &&
    parsedResult &&
    parsedResult.status === "running" &&
    call.args?.async_player === true
  ) {
    return {
      key: "doom-async-start-verify",
      message:
        "The async Doom executor started, but you still need evidence before claiming success. " +
        "Call `mcp.doom.set_objective` with `objective_type: \"hold_position\"` when the task is stationary defense, " +
        "then verify with `mcp.doom.get_situation_report` or `mcp.doom.get_state`.",
    };
  }

  if (!didToolCallFail(call.isError, call.result)) return undefined;

  const failureText = extractToolFailureText(call);
  const failureTextLower = failureText.toLowerCase();
  if (isWatchModeTestRunnerFailure(call, parsedResult, failureTextLower)) {
    return {
      key: `${call.name}-test-runner-watch-mode`,
      message:
        "This test command entered interactive watch mode and timed out. " +
        "Retry with a non-interactive single-run invocation. Prefer the runner's native single-shot mode. " +
        "For Vitest, use `vitest run` or `vitest --run`; for Jest-based npm scripts, prefer `CI=1 npm test` or `jest --runInBand`. " +
        "Only append npm `--` flags when the underlying runner supports them.",
    };
  }
  if (isTimedOutNonWatchTestRunnerFailure(call, parsedResult, failureTextLower)) {
    return {
      key: `${call.name}-test-runner-timeout`,
      message:
        "This non-interactive test command timed out without entering watch mode. " +
        "A test or code path likely hung (for example an infinite loop, unresolved promise, or open handle). " +
        "Do not keep retrying the same command or append ad-hoc runner flags. Inspect the authored source and tests, fix the hang, then rerun the minimal single-run test command.",
    };
  }
  if (isVitestUnsupportedThreadsFlagFailure(call, failureTextLower)) {
    return {
      key: `${call.name}-vitest-unsupported-threads-flag`,
      message:
        "Vitest rejected an unsupported thread flag. Do not invent `--threads` or `--no-threads`. " +
        "Keep the command in single-run mode (`vitest run` or `vitest --run`). " +
        "If worker strategy matters for the installed Vitest version, use the supported `--pool=<threads|forks>` option or project config instead.",
    };
  }
  if (call.name === "execute_with_agent" && parsedResult) {
    const status =
      typeof parsedResult.status === "string"
        ? parsedResult.status.trim().toLowerCase()
        : "";
    const validationCode =
      typeof parsedResult.validationCode === "string"
        ? parsedResult.validationCode.trim().toLowerCase()
        : "";
    const decomposition =
      typeof parsedResult.decomposition === "object" &&
        parsedResult.decomposition !== null &&
        !Array.isArray(parsedResult.decomposition)
        ? parsedResult.decomposition as {
          phases?: unknown;
          suggestedSteps?: unknown;
        }
        : null;
    if (status === "needs_decomposition" || decomposition) {
      const phases = Array.isArray(decomposition?.phases)
        ? decomposition.phases.filter(
          (phase): phase is string =>
            typeof phase === "string" && phase.trim().length > 0,
        )
        : [];
      const suggestedSteps = Array.isArray(decomposition?.suggestedSteps)
        ? decomposition.suggestedSteps
            .filter(
              (entry): entry is { name: string } =>
                typeof entry === "object" &&
                entry !== null &&
                typeof (entry as { name?: unknown }).name === "string" &&
                (entry as { name: string }).name.trim().length > 0,
            )
            .map((entry) => entry.name.trim())
        : [];
      const phasesText =
        phases.length > 0 ? ` (${phases.join(" -> ")})` : "";
      const splitText =
        suggestedSteps.length > 0
          ? ` Suggested split: ${suggestedSteps.join(", ")}.`
          : "";
      return {
        key:
          `execute-with-agent-needs-decomposition:` +
          `${phases.join(",")}:${suggestedSteps.join(",")}`,
        message:
          `The previous \`execute_with_agent\` objective was too large${phasesText}. ` +
          "Do not retry the same combined task. Split it into smaller " +
          "`execute_with_agent` calls that each own one phase with explicit dependencies " +
          "and distinct acceptance criteria." +
          splitText,
      };
    }
    if (validationCode === "low_signal_browser_evidence") {
      return {
        key: "execute-with-agent-low-signal-browser",
        message:
          "The previous `execute_with_agent` attempt used low-signal browser state checks. " +
          "Retry with concrete browser navigation/snapshot or run_code steps against real URLs or localhost targets. " +
          "Do not rely on `browser_tabs` or about:blank tab listings as evidence.",
      };
    }
    if (validationCode === "missing_file_mutation_evidence") {
      return {
        key: "execute-with-agent-missing-file-mutation",
        message:
          "The previous `execute_with_agent` attempt did not create or edit files with real mutation tools. " +
          "Retry only after explicitly using file-writing tools and naming the changed files in the result.",
      };
    }
    if (validationCode === "forbidden_phase_action") {
      return {
        key: "execute-with-agent-forbidden-phase-action",
        message:
          "The previous `execute_with_agent` attempt violated the delegated phase contract by running or claiming a forbidden action for that phase. " +
          "Retry only with the scoped file-authoring or inspection work, and leave install/build/test verification for the later step.",
      };
    }
    if (validationCode === "blocked_phase_output") {
      return {
        key: "execute-with-agent-blocked-phase-output",
        message:
          "The previous `execute_with_agent` attempt returned a success-path answer that still said the phase was blocked or could not be completed. " +
          "Retry only after fixing and verifying the blocking issue, or let the failure propagate instead of presenting the phase as completed.",
      };
    }
    if (validationCode === "contradictory_completion_claim") {
      return {
        key: "execute-with-agent-contradictory-completion",
        message:
          "The previous `execute_with_agent` attempt claimed completion while still admitting unresolved mismatches or follow-up work. " +
          "Retry only after fixing and verifying the issue, or report the phase as blocked instead of successful.",
      };
    }
    if (validationCode === "expected_json_object") {
      return {
        key: "execute-with-agent-expected-json-object",
        message:
          "The previous `execute_with_agent` attempt returned the wrong shape. " +
          "Retry with a single JSON object only, with no markdown or surrounding prose.",
      };
    }
  }
  if (
    isDesktopSessionUnavailable(failureTextLower) &&
    (call.name === "desktop.bash" ||
      call.name.startsWith("playwright.") ||
      call.name.startsWith("mcp."))
  ) {
    return {
      key: "desktop-session-unavailable",
      message:
        "Desktop/container tools are unavailable in this chat session. Attach a desktop session first (`/desktop attach`), " +
        "then retry with `desktop.bash` or the required `playwright.*`/`mcp.*` tool.",
    };
  }

  if (call.name === "desktop.bash") {
    if (
      failureTextLower.includes("long-running server process") ||
      failureTextLower.includes("background process but does not redirect") ||
      failureTextLower.includes("should run in background to avoid hanging")
    ) {
      return {
        key: "desktop-bash-background-process-shape",
        message:
          "For long-running/background tasks that you need to inspect or stop later, use `desktop.process_start`, " +
          "then `desktop.process_status` and `desktop.process_stop`. Keep `desktop.bash` for one-shot shell commands or shell scripts.",
      };
    }
  }

  if (call.name === "system.bash") {
    const command = String(call.args?.command ?? "").trim().toLowerCase();
    const spawnEnoentCommand = extractSpawnEnoentCommand(failureText);
    if (hasBrokenHeredocConjunctionShape(call.args, failureTextLower)) {
      return {
        key: "system-bash-heredoc-conjunction-shape",
        message:
          "This shell script put `&&`, `||`, or `;` on a new line after a heredoc terminator, " +
          "which is invalid shell syntax. Split the follow-up command into a separate tool call, " +
          "keep the conjunction on the original command line, or use `system.writeFile`/`system.appendFile` " +
          "for file contents instead of shell heredocs.",
      };
    }
    if (
      failureTextLower.includes("long-running server process") ||
      failureTextLower.includes("background process but does not redirect") ||
      failureTextLower.includes("should run in background to avoid hanging")
    ) {
      return {
        key: "system-bash-typed-server-handle",
        message:
          "For local HTTP services you need to monitor, prefer `system.serverStart`, then `system.serverStatus`/`system.serverResume`, `system.serverLogs`, and `system.serverStop`. " +
          "Use `system.process*` for non-HTTP workers and `system.bash` for one-shot commands only.",
      };
    }
    if (isUnsupportedWorkspaceProtocolFailure(failureTextLower)) {
      return {
        key: "system-bash-workspace-protocol-unsupported",
        message:
          "This host package manager rejected `workspace:*`. Do not assume workspace protocol support in generated manifests. " +
          "Rewrite the local dependency to a host-compatible specifier, then rerun `npm install` on this host before continuing.",
      };
    }
    if (isRecursiveNpmInstallLifecycleFailure(call, parsedResult)) {
      return {
        key: "system-bash-recursive-npm-install-lifecycle",
        message:
          "This project defines an `install` lifecycle that recursively reruns `npm install`, which can loop until timeout. " +
          "Remove or rename the recursive `install` script in `package.json`, keep one-time setup out of `npm install`, then rerun `npm install` before continuing.",
      };
    }
    if (isMissingNpmScriptFailure(call, failureText)) {
      const scriptName = extractMissingNpmScriptName(failureText) ?? "requested";
      return {
        key: `system-bash-missing-npm-script:${scriptName.toLowerCase()}`,
        message:
          `The current package.json does not define the npm script \`${scriptName}\`. ` +
          `Inspect the package.json at the active cwd, add the missing root/workspace script if later verification depends on \`npm run ${scriptName}\`, ` +
          "or run the correct package-specific command instead of retrying the same missing script.",
      };
    }
    if (isMissingNpmWorkspaceFailure(call, failureText)) {
      const selectors = extractRequestedNpmWorkspaceSelectors(call);
      const selectorSuffix = selectors.length > 0
        ? ` The rejected selectors were: ${selectors.map((value) => `\`${value}\``).join(", ")}.`
        : "";
      return {
        key: selectors.length > 0
          ? `system-bash-missing-npm-workspace:${selectors.join(",").toLowerCase()}`
          : "system-bash-missing-npm-workspace",
        message:
          "npm could not match one or more `--workspace` selectors in this repo." +
          selectorSuffix +
          " Inspect the root `package.json` workspaces and each package `name`, then rerun with the exact workspace package names " +
          "(for example `--workspace=@scope/pkg`) or run the command from the matching workspace cwd.",
      };
    }
    if (isMissingLocalPackageDistFailure(failureText)) {
      return {
        key: "system-bash-local-package-dist-missing",
        message:
          "This local package link resolved to a `dist/*` entry that does not exist yet. " +
          "Build the dependency package first or point the consumer at source/exports that already exist on disk, then rerun the command before claiming success.",
      };
    }
    if (isTypescriptRootDirScopeFailure(failureText)) {
      return {
        key: "system-bash-typescript-rootdir-scope",
        message:
          "This TypeScript config includes files outside `rootDir` (for example `vite.config.ts`). " +
          "For Vite/browser packages, either remove the restrictive `rootDir`, exclude config files from that tsconfig, " +
          "or move Node-side config files into a separate tsconfig such as `tsconfig.node.json` before rerunning `tsc`.",
      };
    }
    if (isPackagePathNotExportedFailure(failureTextLower)) {
      return {
        key: usesCommonJsRequireSnippet(call)
          ? "system-bash-esm-package-required-via-require"
          : "system-bash-package-exports-mismatch",
        message:
          usesCommonJsRequireSnippet(call)
            ? "This package exposes ESM/`exports` entry points. Do not verify it with CommonJS `require(...)` unless the package defines a `require` condition. " +
              "Retry with an ESM import (for example `node --input-type=module -e \"import('pkg').then(...)\"`) or inspect the package `exports` map directly."
            : "This package's `exports` map does not match the way the command is loading it. " +
              "Inspect `package.json` `exports`/`main`/`types`, then retry with a loader and entry point that match the package format.",
      };
    }
    if (isLikelyLiteralGlobFailure(call, failureTextLower)) {
      return {
        key: "system-bash-literal-glob-operand",
        message:
          "Direct mode passes `args` literally and does not expand shell globs like `*.d.ts`. " +
          "Enumerate matches first with `find` or `rg --files`, or retry in shell mode with the full shell command in `command` and omit `args` when shell expansion is required.",
      };
    }
    if (isLikelyGrepOperandShapeFailure(call, failureTextLower)) {
      return {
        key: "system-bash-grep-shape",
        message:
          "For code/text search, prefer `rg PATTERN PATH`. If you use `grep` in direct mode, pass exactly one pattern followed by file paths, " +
          "and add `-E` (or use shell mode) when the pattern uses alternation like `foo|bar`. Extra non-flag args after the pattern are treated as file paths.",
      };
    }
    if (isDesktopBiasedSystemCommandFailure(command, failureTextLower)) {
      return {
        key: "system-bash-host-desktop-mismatch",
        message:
          "This command failed on `system.bash` (host shell) but appears to target desktop/container tooling. " +
          "Attach desktop (`/desktop attach`) and run it with `desktop.bash` (or `playwright.*` for browser actions).",
      };
    }
    if (/(^|\s)docker(\s|$)/.test(command)) {
      return {
        key: "system-bash-sandbox-handle",
        message:
          "For durable code-execution environments, prefer `system.sandboxStart`, then `system.sandboxJobStart`/`system.sandboxJobStatus`, `system.sandboxJobLogs`, and `system.sandboxStop` " +
          "instead of raw docker shell commands on `system.bash`.",
      };
    }
    const builtinCandidate =
      spawnEnoentCommand && spawnEnoentCommand.length > 0
        ? commandBasename(spawnEnoentCommand)
        : command;
    const isBuiltin =
      builtinCandidate.length > 0 &&
      SHELL_BUILTIN_COMMANDS.has(builtinCandidate);
    if (
      isBuiltin ||
      failureTextLower.includes("shell builtin")
    ) {
      return {
        key: "system-bash-shell-builtin",
        message:
          "Shell builtins (for example `set`, `cd`, `export`) are not standalone executables. " +
          "If you need shell semantics on the host, retry in `system.bash` shell mode by putting the full shell command in `command` and omitting `args`.",
      };
    }
    if (spawnEnoentCommand) {
      const missingCommand = commandBasename(spawnEnoentCommand);
      return {
        key: `system-bash-missing-command:${missingCommand}`,
        message:
          `The executable \`${missingCommand}\` was not found on the host PATH. ` +
          "If this is a project-local Node/TypeScript tool, rerun it via `npx`, `npm exec --`, or `npm run` from the correct `cwd` " +
          `(for example \`npx ${missingCommand}\`). Otherwise install the tool first or call the correct executable instead of retrying the same missing command.`,
      };
    }
    if (
      failureTextLower.includes("one executable token") ||
      failureTextLower.includes("shell operators/newlines")
    ) {
      return {
        key: "system-bash-command-shape",
        message:
          "In `system.bash` direct mode, `command` must be a single executable token and flags belong in `args`. " +
          "If you need pipes, redirection, heredocs, chaining, or other shell syntax on the host, retry with the full shell command in `command` and omit `args`.",
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
    const deniedCommand = extractDeniedCommand(failureText);
    if (deniedCommand) {
      if (SHELL_WRAPPER_COMMANDS.has(commandBasename(deniedCommand))) {
        return {
          key: "system-bash-command-denied-shell-wrapper",
          message:
            'system.bash blocks shell wrapper executables like `bash`/`sh`. Do NOT call `bash -c` or `sh -c`. ' +
            "Call the target executable directly via `command` + `args`.",
        };
      }
      if (isNodeInterpreterCommand(deniedCommand)) {
        if (isAgencRuntimeNodeInvocation(call.args)) {
          return {
            key: "system-bash-command-denied-node-agenc-runtime",
            message:
              "Node interpreter commands are blocked on system.bash. For daemon checks, invoke the CLI directly: " +
              '`command:"agenc-runtime", args:["status","--output","json"]`.',
          };
        }
        return {
          key: "system-bash-command-denied-node",
          message:
            "Node interpreter commands are blocked on system.bash. Use an allowed host binary directly " +
            "(for example `agenc-runtime`) or run interpreter-based workflows in `desktop.bash`.",
        };
      }
      if (isPythonInterpreterCommand(deniedCommand)) {
        return {
          key: "system-bash-command-denied-python",
          message:
            "Python interpreter commands are blocked on system.bash. " +
            "Use an allowed host binary directly, or run Python workflows in `desktop.bash` after `/desktop attach`.",
        };
      }
    }
  }

  if (
    (call.name.startsWith("system.") &&
      (call.name.endsWith("readFile") ||
        call.name.endsWith("writeFile") ||
        call.name.endsWith("appendFile") ||
        call.name.endsWith("listDir") ||
        call.name.endsWith("stat") ||
        call.name.endsWith("mkdir") ||
        call.name.endsWith("move") ||
        call.name.endsWith("delete"))) &&
    (failureTextLower.includes("path is outside allowed directories") ||
      failureTextLower.includes("access denied: path"))
  ) {
    return {
      key: "filesystem-path-allowlist",
      message:
        "This filesystem tool call was blocked by path allowlisting. " +
        "Use files under allowed roots (`~/.agenc/workspace`, project root, `~/Desktop`, `/tmp`) " +
        "or switch to `system.bash` with an explicit `cwd` for repo-local reads.",
    };
  }

  if (failureTextLower.includes("delegated workspace root violation")) {
    return {
      key: "delegated-workspace-root-violation",
      message:
        "This child task is scoped to a delegated workspace root. " +
        "Keep file paths under the assigned root, prefer relative paths from that cwd, " +
        "and do not create fallback workspaces elsewhere (for example under `/tmp`).",
    };
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

  if (
    (
      call.name === "system.browserAction" ||
      call.name.startsWith("system.browserSession")
    ) &&
    (
      failureTextLower.includes("browser_session.domain_blocked") ||
      failureTextLower.includes("ssrf target blocked") ||
      failureTextLower.includes("private/loopback address blocked")
    )
  ) {
    return {
      key: "localhost-browser-session-blocked",
      message:
        "system.browserSession*/system.browserAction cannot open localhost/private/internal targets. " +
        "For local service checks on the HOST, use system.bash (for example `curl -sSf http://127.0.0.1:PORT` or a host-side Playwright/Chromium command). " +
        "Desktop/container browser tools also cannot reach the host's localhost.",
    };
  }

  return undefined;
}

// ============================================================================
// Quality & trajectory helpers (extracted from recordOutcomeAndFinalize)
// ============================================================================

/** Input for computing quality proxy score. */
export interface QualityProxyInput {
  readonly stopReason: LLMPipelineStopReason;
  readonly verifierPerformed: boolean;
  readonly verifierOverall: "pass" | "retry" | "fail" | "skipped";
  readonly evaluation?: EvaluationResult;
  readonly failedToolCalls: number;
}

/** Compute a 0–1 quality proxy score from execution outcome signals. */
export function computeQualityProxy(input: QualityProxyInput): number {
  const stopReasonQualityBase = input.stopReason === "completed"
    ? 0.85
    : input.stopReason === "tool_calls"
      ? 0.6
      : 0.25;
  const verifierBonus = input.verifierPerformed
    ? (
      input.verifierOverall === "pass"
        ? 0.1
        : input.verifierOverall === "retry"
          ? 0
          : -0.15
    )
    : 0;
  const evaluatorBonus = input.evaluation
    ? (input.evaluation.passed ? 0.1 : -0.1)
    : 0;
  const failurePenalty = Math.min(0.25, input.failedToolCalls * 0.05);
  return Math.max(
    0,
    Math.min(
      1,
      stopReasonQualityBase + verifierBonus + evaluatorBonus - failurePenalty,
    ),
  );
}

/** Input for building a delegation trajectory record. */
export interface DelegationTrajectoryInput {
  readonly ctx: ExecutionContext;
  readonly qualityProxy: number;
  readonly durationMs: number;
  readonly rewardSignal: DelegationTrajectoryFinalReward;
  readonly usefulnessProxy: { readonly useful: boolean; readonly score: number };
  readonly selectedTools: readonly string[];
  readonly defaultStrategyArmId: string;
  readonly delegationMaxDepth: number;
  readonly delegationMaxFanoutPerTurn: number;
  readonly requestTimeoutMs: number;
  readonly usefulDelegationProxyVersion: string;
}

/** Build a trajectory sink record object from execution context. */
export function buildDelegationTrajectoryEntry(input: DelegationTrajectoryInput): DelegationTrajectoryRecord {
  const { ctx } = input;
  return {
    schemaVersion: 1,
    traceId: ctx.trajectoryTraceId,
    turnId: ctx.parentTurnId,
    turnType: "parent",
    timestampMs: Date.now(),
    stateFeatures: {
      sessionId: ctx.sessionId,
      contextClusterId: ctx.trajectoryContextClusterId,
      complexityScore: ctx.plannerDecision.score,
      plannerStepCount: ctx.plannerSummaryState.plannedSteps,
      subagentStepCount: ctx.plannedSubagentSteps,
      deterministicStepCount: ctx.plannedDeterministicSteps,
      synthesisStepCount: ctx.plannedSynthesisSteps,
      dependencyDepth: ctx.plannedDependencyDepth,
      fanout: ctx.plannedFanout,
    },
    action: {
      delegated:
        ctx.plannerSummaryState.delegationDecision?.shouldDelegate === true,
      strategyArmId:
        ctx.selectedBanditArm?.armId ?? input.defaultStrategyArmId,
      threshold: ctx.tunedDelegationThreshold,
      selectedTools: [...input.selectedTools],
      childConfig: {
        maxDepth: input.delegationMaxDepth,
        maxFanoutPerTurn: input.delegationMaxFanoutPerTurn,
        timeoutMs: input.requestTimeoutMs,
      },
    },
    immediateOutcome: {
      qualityProxy: input.qualityProxy,
      tokenCost: ctx.cumulativeUsage.totalTokens,
      latencyMs: input.durationMs,
      errorCount:
        ctx.failedToolCalls + (ctx.stopReason === "completed" ? 0 : 1),
      ...(ctx.stopReason !== "completed" ? { errorClass: ctx.stopReason } : {}),
    },
    finalReward: input.rewardSignal,
    metadata: {
      plannerUsed: ctx.plannerSummaryState.used,
      routeReason: ctx.plannerSummaryState.routeReason ?? "none",
      stopReason: ctx.stopReason,
      usefulDelegation: input.usefulnessProxy.useful,
      usefulDelegationScore: Number(input.usefulnessProxy.score.toFixed(4)),
      usefulDelegationProxyVersion: input.usefulDelegationProxyVersion,
    },
  };
}

/** Build the final ChatPlannerSummary from mutable summary state. */
export function buildPlannerSummary(
  state: FullPlannerSummaryState,
  estimatedRecallsAvoided: number,
): ChatPlannerSummary {
  return {
    enabled: state.enabled,
    used: state.used,
    routeReason: state.routeReason,
    complexityScore: state.complexityScore,
    plannerCalls: state.plannerCalls,
    plannedSteps: state.plannedSteps,
    deterministicStepsExecuted: state.deterministicStepsExecuted,
    estimatedRecallsAvoided: state.used ? estimatedRecallsAvoided : 0,
    diagnostics: state.diagnostics.length > 0
      ? state.diagnostics
      : undefined,
    delegationDecision: state.delegationDecision,
    subagentVerification: state.subagentVerification.enabled
      ? state.subagentVerification
      : undefined,
    delegationPolicyTuning: state.delegationPolicyTuning.enabled
      ? state.delegationPolicyTuning
      : undefined,
  };
}
