/**
 * Dependency result summarization for sub-agent prompt construction.
 *
 * Extracted from SubAgentOrchestrator — helpers that parse and summarize
 * dependency step results for injection into downstream sub-agent prompts.
 *
 * @module
 */

import { safeStringify } from "../tools/types.js";
import { truncateText, normalizeDependencyArtifactPath, isDependencyArtifactPathCandidate } from "./subagent-context-curation.js";

/* ------------------------------------------------------------------ */
/*  Dependency result summarization                                    */
/* ------------------------------------------------------------------ */

export function summarizeDependencyResultForPrompt(result: string | null): string {
  if (result === null) return "null";

  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return truncateText(result, 320);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return truncateText(result, 320);
  }

  const record = parsed as Record<string, unknown>;
  const summary: Record<string, unknown> = {};

  for (const key of [
    "status",
    "success",
    "durationMs",
    "providerName",
    "attempts",
    "stopReason",
    "stopReasonDetail",
    "validationCode",
  ]) {
    const value = record[key];
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      summary[key] = value;
    }
  }

  if (Array.isArray(record.toolCalls)) {
    const toolNames = new Set<string>();
    const modifiedFiles: string[] = [];
    const verificationCommandStates = new Map<string, number>();
    for (const entry of record.toolCalls) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const toolCall = entry as Record<string, unknown>;
      const name = toolCall.name;
      if (typeof name === "string" && name.trim().length > 0) {
        toolNames.add(name);
      }
      const args =
        typeof toolCall.args === "object" &&
          toolCall.args !== null &&
          !Array.isArray(toolCall.args)
          ? toolCall.args as Record<string, unknown>
          : undefined;
      if ((name === "system.writeFile" || name === "system.appendFile") && args) {
        const path = typeof args.path === "string" ? args.path.trim() : "";
        const normalizedPath = normalizeDependencyArtifactPath(path);
        if (
          normalizedPath.length > 0 &&
          isDependencyArtifactPathCandidate(normalizedPath) &&
          !modifiedFiles.includes(normalizedPath)
        ) {
          modifiedFiles.push(normalizedPath);
        }
      }
      if (name === "system.bash" || name === "desktop.bash") {
        const command = summarizeDependencyShellCommand(args);
        if (!command || !isDependencyVerificationCommand(command)) {
          continue;
        }
        const exitCode = extractDependencyCommandExitCode(
          typeof toolCall.result === "string" ? toolCall.result : "",
        );
        if (typeof exitCode === "number") {
          verificationCommandStates.set(command, exitCode);
        }
      }
    }
    const verifiedCommands = [...verificationCommandStates.entries()]
      .filter(([, exitCode]) => exitCode === 0)
      .map(([command]) => command);
    const failedCommands = [...verificationCommandStates.entries()]
      .filter(([, exitCode]) => exitCode !== 0)
      .map(([command]) => command);
    if (modifiedFiles.length > 0) {
      summary.modifiedFiles = modifiedFiles.slice(0, 6);
    }
    if (verifiedCommands.length > 0) {
      summary.verifiedCommands = verifiedCommands.slice(0, 4);
    }
    if (failedCommands.length > 0) {
      summary.failedCommands = failedCommands.slice(0, 4);
    }
    summary.toolCallSummary = {
      count: record.toolCalls.length,
      tools: [...toolNames],
    };
  }

  if (
    typeof record.output === "string" &&
    record.output.trim().length > 0 &&
    summary.modifiedFiles === undefined &&
    summary.verifiedCommands === undefined &&
    summary.failedCommands === undefined
  ) {
    summary.outputSummary = summarizeDependencyOutputText(record.output);
  }

  return safeStringify(
    Object.keys(summary).length > 0 ? summary : record,
  );
}

export function summarizeDependencyShellCommand(
  args: Record<string, unknown> | undefined,
): string | undefined {
  if (!args) return undefined;
  const command =
    typeof args.command === "string" ? args.command.trim() : "";
  const commandArgs = Array.isArray(args.args)
    ? args.args.filter((value): value is string => typeof value === "string")
    : [];
  const rendered = [command, ...commandArgs]
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
  return rendered.length > 0 ? rendered : undefined;
}

export function isDependencyVerificationCommand(command: string): boolean {
  return /\b(?:npm|pnpm|yarn|bun|vitest|jest|tsc)\b/i.test(command) &&
    /\b(?:build|test|coverage|verify|check|install|run)\b/i.test(command);
}

export function extractDependencyCommandExitCode(result: string): number | undefined {
  if (result.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(result) as Record<string, unknown>;
    return typeof parsed.exitCode === "number" && Number.isFinite(parsed.exitCode)
      ? parsed.exitCode
      : undefined;
  } catch {
    return undefined;
  }
}

export function summarizeDependencyOutputText(output: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return truncateText(output.trim(), 240);
  }
  return truncateText(lines.slice(0, 3).join(" "), 240);
}

export function resolveParentSessionId(pipelineId: string): string {
  if (!pipelineId.startsWith("planner:")) return pipelineId;
  const encodedParentSessionId = pipelineId.slice("planner:".length);
  const separatorIndex = encodedParentSessionId.lastIndexOf(":");
  if (separatorIndex <= 0) {
    return encodedParentSessionId || pipelineId;
  }
  return encodedParentSessionId.slice(0, separatorIndex);
}
