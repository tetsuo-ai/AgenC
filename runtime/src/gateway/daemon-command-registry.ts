/**
 * Slash command registry creation for the daemon.
 *
 * Extracted from daemon.ts to reduce file size.
 * Contains the createDaemonCommandRegistry() function that registers all
 * built-in slash commands (/help, /new, /init, /status, /model, /eval, etc.).
 *
 * @module
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { Logger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import type { GatewayConfig } from "./types.js";
import type { LLMProvider, LLMProviderTraceEvent, ToolHandler } from "../llm/types.js";
import type { MemoryBackend } from "../memory/types.js";
import { SlashCommandRegistry, createDefaultCommands } from "./commands.js";
import { SessionManager } from "./session.js";
import type { DiscoveredSkill } from "../skills/markdown/discovery.js";
import { ToolRegistry } from "../tools/registry.js";
import { HookDispatcher } from "./hooks.js";
import { ApprovalEngine } from "./approvals.js";
import { ProgressTracker } from "./progress.js";
import {
  PipelineExecutor,
  type Pipeline,
  type PipelineStep,
} from "../workflow/pipeline.js";
import { ChatExecutor } from "../llm/chat-executor.js";
import type { GatewayMessage } from "./message.js";
import { createGatewayMessage } from "./message.js";
import {
  resolveTraceLoggingConfig,
  logProviderPayloadTraceEvent,
  truncateToolLogText,
  EVAL_REPLY_MAX_CHARS,
} from "./daemon-trace.js";
// ResolvedTraceLoggingConfig used indirectly via resolveTraceLoggingConfig
import {
  resolveSessionTokenBudget,
  DEFAULT_GROK_MODEL,
} from "./llm-provider-manager.js";
import {
  listKnownGrokModels,
  normalizeGrokModel,
} from "./context-window.js";
import { getDefaultWorkspacePath } from "./workspace-files.js";
import type {
  DelegationAggressivenessProfile,
  ResolvedSubAgentRuntimeConfig,
} from "./subagent-infrastructure.js";
import type { VoiceBridge } from "./voice-bridge.js";
import type { WebChatChannel } from "../channels/webchat/plugin.js";

// ============================================================================
// Eval script helpers (moved from daemon.ts top-level)
// ============================================================================

export interface EvalScriptResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export function didEvalScriptPass(result: EvalScriptResult): boolean {
  if (result.timedOut || result.exitCode !== 0) return false;
  return extractEvalOverall(result.stdout) === "pass";
}

function extractEvalOverall(stdout: string): "pass" | "fail" | undefined {
  const marker = stdout.match(/\bOverall:\s*(pass|fail)\b/i);
  if (marker) {
    return marker[1].toLowerCase() as "pass" | "fail";
  }

  const objectMatches = stdout.match(/\{[\s\S]*?\}/g);
  if (!objectMatches) return undefined;
  for (let i = objectMatches.length - 1; i >= 0; i--) {
    const candidate = objectMatches[i];
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed.overall === "pass" || parsed.overall === "fail") {
        return parsed.overall;
      }
    } catch {
      // continue scanning
    }
  }

  return undefined;
}

export function formatEvalScriptReply(result: EvalScriptResult): string {
  const stdout = formatEvalTextForReply(result.stdout);
  const stderr = formatEvalTextForReply(result.stderr);
  if (result.timedOut) {
    return (
      `Eval test timed out after ${result.durationMs}ms.` +
      (stdout ? `\nstdout:\n${stdout}` : "") +
      (stderr ? `\nstderr:\n${stderr}` : "")
    );
  }
  if (result.exitCode === 0) {
    return (
      `Eval test passed in ${result.durationMs}ms.` +
      (stdout ? `\nstdout:\n${stdout}` : "") +
      (stderr ? `\nstderr:\n${stderr}` : "")
    );
  }
  return (
    `Eval test failed (exit ${result.exitCode ?? "unknown"}) in ${result.durationMs}ms.` +
    (stderr ? `\nstderr:\n${stderr}` : "") +
    (stdout ? `\nstdout:\n${stdout}` : "")
  );
}

function formatEvalTextForReply(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return truncateToolLogText(trimmed, EVAL_REPLY_MAX_CHARS);
}

// ============================================================================
// Eval script runner (moved from daemon.ts top-level)
// ============================================================================

import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { access as accessFs, constants as fsConstants } from "node:fs";

const EVAL_SCRIPT_NAME = "agenc-eval-test.cjs";
const EVAL_SCRIPT_TIMEOUT_MS = 10 * 60_000;

interface ResolveEvalScriptPathOptions {
  readonly cwd?: string;
  readonly workspacePath?: string;
  readonly canRead?: (candidate: string) => Promise<boolean>;
}

export function getEvalScriptPathCandidates(options: ResolveEvalScriptPathOptions = {}): string[] {
  const cwd = options.cwd ?? process.cwd();
  const workspacePath = options.workspacePath ?? getDefaultWorkspacePath();
  return [
    resolvePath(cwd, "tools", "eval", EVAL_SCRIPT_NAME),
    resolvePath(workspacePath, "tools", "eval", EVAL_SCRIPT_NAME),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
}

async function canReadEvalScript(candidate: string): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      accessFs(candidate, fsConstants.R_OK, (err) => (err ? reject(err) : resolve()));
    });
    return true;
  } catch {
    return false;
  }
}

export async function resolveEvalScriptPathCandidates(
  options: ResolveEvalScriptPathOptions = {},
): Promise<string | undefined> {
  const candidates = getEvalScriptPathCandidates(options);
  const canRead = options.canRead ?? canReadEvalScript;
  for (const candidate of candidates) {
    if (await canRead(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function formatEvalScriptCandidateList(options: ResolveEvalScriptPathOptions = {}): string {
  const candidates = getEvalScriptPathCandidates(options);
  return candidates.map((candidate) => `- ${candidate}`).join("\n");
}

export async function resolveEvalScriptForReply(
  options: ResolveEvalScriptPathOptions = {},
): Promise<{ scriptPath: string | undefined; candidateList: string }> {
  const scriptPath = await resolveEvalScriptPathCandidates(options);
  return {
    scriptPath,
    candidateList: formatEvalScriptCandidateList(options),
  };
}

export async function runEvalScript(
  scriptPath: string,
  args: readonly string[],
  onProgress?: (progress: {
    stream: "stdout" | "stderr";
    line: string;
  }) => void,
): Promise<EvalScriptResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let stdoutCarry = "";
    let stderrCarry = "";
    let settled = false;
    let timedOut = false;

    const emitProgressLines = (
      stream: "stdout" | "stderr",
      chunk: string,
      carry: string,
    ): { nextCarry: string } => {
      const combined = carry + chunk;
      const parts = combined.split(/\r?\n/);
      const nextCarry = parts.pop() ?? "";
      for (const rawLine of parts) {
        const line = rawLine.trim();
        if (!line) continue;
        onProgress?.({ stream, line });
      }
      return { nextCarry };
    };

    const finalize = (exitCode: number | null, errorMessage?: string): void => {
      if (settled) return;
      settled = true;

      if (stdoutCarry.trim().length > 0) {
        onProgress?.({ stream: "stdout", line: stdoutCarry.trim() });
      }
      if (stderrCarry.trim().length > 0) {
        onProgress?.({ stream: "stderr", line: stderrCarry.trim() });
      }

      if (errorMessage && stderr.trim().length === 0) {
        stderr = errorMessage;
      }

      resolve({
        exitCode: timedOut ? null : exitCode,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - start,
      });
    };

    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: dirname(scriptPath),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // best-effort kill
      }
    }, EVAL_SCRIPT_TIMEOUT_MS);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stdout += text;
      const { nextCarry } = emitProgressLines("stdout", text, stdoutCarry);
      stdoutCarry = nextCarry;
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderr += text;
      const { nextCarry } = emitProgressLines("stderr", text, stderrCarry);
      stderrCarry = nextCarry;
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      finalize(1, toErrorMessage(err));
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      finalize(code ?? 1);
    });
  });
}

// ============================================================================
// WebChatSkillSummary type
// ============================================================================

export interface WebChatSkillSummary {
  name: string;
  description: string;
  enabled: boolean;
}

// ============================================================================
// Daemon context type for command registry
// ============================================================================

export interface CommandRegistryDaemonContext {
  readonly logger: Logger;
  readonly configPath: string;
  readonly gateway: { readonly config: GatewayConfig } | null;
  readonly yolo: boolean;
  resetWebSessionContext(params: {
    webSessionId: string;
    sessionMgr: SessionManager;
    resolveSessionId: (sessionKey: string) => string;
    memoryBackend: MemoryBackend;
    progressTracker?: ProgressTracker;
  }): Promise<void>;
  getWebChatChannel(): WebChatChannel | null;
  getHostWorkspacePath(): string | null;
  getChatExecutor(): ChatExecutor | null;
  getResolvedContextWindowTokens(): number | undefined;
  getSystemPrompt(): string;
  getMemoryBackendName(): string | undefined;
  getPolicyEngineState(): { mode: string; recentViolations: number } | undefined;
  isPolicyEngineEnabled(): boolean;
  isGovernanceAuditLogEnabled(): boolean;
  listSessionCredentialLeases(sessionId: string): Array<{
    credentialId: string;
    expiresAt: number;
    domains: string[];
  }>;
  revokeSessionCredentials(params: {
    sessionId: string;
    credentialId?: string;
    reason: "manual" | "shutdown" | "session_reset";
  }): Promise<number>;
  resolvePolicyScopeForSession(params: {
    sessionId: string;
    runId?: string;
    channel?: string;
  }): {
    tenantId?: string;
    projectId?: string;
    runId?: string;
    sessionId: string;
    channel: string;
  };
  buildPolicySimulationPreview(params: {
    sessionId: string;
    toolName: string;
    args?: Record<string, unknown>;
  }): Promise<{
    toolName: string;
    sessionId: string;
    policy: {
      allowed: boolean;
      mode: string;
      violations: Array<{ code: string; message: string }>;
    };
    approval: {
      required: boolean;
      elevated: boolean;
      denied: boolean;
      requestPreview?: {
        message: string;
        deadlineAt: number;
        allowDelegatedResolution: boolean;
        approverGroup?: string;
        requiredApproverRoles?: readonly string[];
      };
    };
  }>;
  getSubAgentRuntimeConfig(): ResolvedSubAgentRuntimeConfig | null;
  getActiveDelegationAggressiveness(
    config: ResolvedSubAgentRuntimeConfig,
  ): DelegationAggressivenessProfile;
  resolveDelegationScoreThreshold(
    config?: ResolvedSubAgentRuntimeConfig,
  ): number;
  getDelegationAggressivenessOverride(): DelegationAggressivenessProfile | null;
  setDelegationAggressivenessOverride(
    value: DelegationAggressivenessProfile | null,
  ): void;
  configureDelegationRuntimeServices(
    config: ResolvedSubAgentRuntimeConfig,
  ): void;
  getWebChatInboundHandler(): ((msg: GatewayMessage) => Promise<void>) | null;
  getDesktopHandleBySession(
    sessionId: string,
  ): { containerId: string; maxMemory: string; maxCpu: string } | undefined;
  getSessionModelInfo(sessionId: string): {
    provider: string;
    model: string;
    usedFallback: boolean;
  } | undefined;
  handleConfigReload(): Promise<void>;
  getVoiceBridge(): VoiceBridge | null;
  getDesktopManager(): {
    getOrCreate(sessionId: string, opts?: { maxMemory?: string; maxCpu?: string }): Promise<{
      containerId: string;
      vncHostPort: number;
      resolution: { width: number; height: number };
      maxMemory: string;
      maxCpu: string;
    }>;
    destroy(containerId: string): Promise<void>;
    getHandleBySession(sessionId: string): {
      containerId: string;
      vncHostPort: number;
      resolution: { width: number; height: number };
      maxMemory: string;
      maxCpu: string;
      status: string;
      createdAt: number;
      sessionId: string;
    } | undefined;
    getHandle(containerId: string): {
      containerId: string;
      sessionId: string;
    } | undefined;
    assignSession(containerId: string, sessionId: string): {
      containerId: string;
      vncHostPort: number;
    };
    listAll(): Array<{
      containerId: string;
      sessionId: string;
      status: string;
      maxMemory: string;
      maxCpu: string;
      vncUrl: string;
      createdAt: number;
    }>;
  } | null;
  getDesktopBridges(): Map<string, unknown>;
  getPlaywrightBridges(): Map<string, unknown>;
  getContainerMCPBridges(): Map<string, unknown[]>;
  getGoalManager(): {
    addGoal(params: {
      title: string;
      description: string;
      priority: string;
      source: string;
      maxAttempts: number;
    }): Promise<{ id: string; title: string }>;
    getActiveGoals(): Promise<
      Array<{ priority: string; status: string; title: string }>
    >;
  } | null;
}

// ============================================================================
// Main factory function
// ============================================================================

export function createDaemonCommandRegistry(
  ctx: CommandRegistryDaemonContext,
  sessionMgr: SessionManager,
  resolveSessionId: (sessionKey: string) => string,
  providers: LLMProvider[],
  memoryBackend: MemoryBackend,
  registry: ToolRegistry,
  availableSkills: DiscoveredSkill[],
  skillList: WebChatSkillSummary[],
  hooks: HookDispatcher,
  baseToolHandler: ToolHandler,
  approvalEngine: ApprovalEngine | null,
  progressTracker?: ProgressTracker,
  pipelineExecutor?: PipelineExecutor,
): SlashCommandRegistry {
  void hooks; void baseToolHandler; void approvalEngine;
  const commandRegistry = new SlashCommandRegistry({ logger: ctx.logger });
  for (const command of createDefaultCommands()) {
    commandRegistry.register(command);
  }

  commandRegistry.register({
    name: "help",
    description: "Show available commands",
    global: true,
    handler: async (cmdCtx) => {
      const commands = commandRegistry.getCommands();
      const lines = commands.map(
        (command) => `  /${command.name} — ${command.description}`,
      );
      await cmdCtx.reply("Available commands:\n" + lines.join("\n"));
    },
  });
  commandRegistry.register({
    name: "new",
    description: "Start a new session (reset conversation)",
    global: true,
    handler: async (cmdCtx) => {
      await ctx.resetWebSessionContext({
        webSessionId: cmdCtx.sessionId,
        sessionMgr,
        resolveSessionId,
        memoryBackend,
        progressTracker,
      });
      await cmdCtx.reply("Session reset. Starting fresh conversation.");
    },
  });
  commandRegistry.register({
    name: "init",
    description: "Generate an AGENC.md contributor guide",
    args: "[--force]",
    global: true,
    handler: async (cmdCtx) => {
      const force = cmdCtx.argv.includes("--force");
      const workspaceRoot =
        (typeof ctx.getWebChatChannel()?.loadSessionWorkspaceRoot === "function"
          ? await ctx.getWebChatChannel()!.loadSessionWorkspaceRoot(cmdCtx.sessionId)
          : undefined) ??
        ctx.getHostWorkspacePath() ??
        process.cwd();
      const filePath = `${workspaceRoot}/AGENC.md`;

      // Check if file exists and --force not set
      const { existsSync } = await import("node:fs");
      if (existsSync(filePath) && !force) {
        await cmdCtx.reply(`AGENC.md already exists at ${filePath}. Use /init --force to overwrite.`);
        return;
      }

      const initPrompt =
        `List the files in ${workspaceRoot}, read the important ones (package.json, README, Makefile, config files, etc), ` +
        `then write ${filePath} with these sections: ` +
        `"# Repository Guidelines", "## Project Structure & Module Organization", ` +
        `"## Build, Test, and Development Commands", "## Coding Style & Naming Conventions", ` +
        `"## Testing Guidelines", "## Commit & Pull Request Guidelines". ` +
        `Base it on what you find. Do NOT build, compile, or run anything — just read and write the guide.`;

      const webChat = ctx.getWebChatChannel();
      if (!webChat) {
        await cmdCtx.reply("Init unavailable: webchat pipeline is not initialized.");
        return;
      }
      // Inject as a synthetic user message — bypasses planner since it's simple
      webChat.injectSyntheticUserMessage(cmdCtx.sessionId, cmdCtx.senderId, initPrompt);
    },
  });
  commandRegistry.register({
    name: "reset",
    description: "Reset session and clear context",
    global: true,
    handler: async (cmdCtx) => {
      await ctx.resetWebSessionContext({
        webSessionId: cmdCtx.sessionId,
        sessionMgr,
        resolveSessionId,
        memoryBackend,
        progressTracker,
      });
      await cmdCtx.reply("Session and context cleared.");
    },
  });
  commandRegistry.register({
    name: "restart",
    description: "Restart current chat context (alias for /reset)",
    global: true,
    handler: async (cmdCtx) => {
      await ctx.resetWebSessionContext({
        webSessionId: cmdCtx.sessionId,
        sessionMgr,
        resolveSessionId,
        memoryBackend,
        progressTracker,
      });
      await cmdCtx.reply("Session restarted. Context cleared.");
    },
  });
  commandRegistry.register({
    name: "compact",
    description: "Force conversation compaction",
    global: true,
    handler: async (cmdCtx) => {
      const sessionId = resolveSessionId(cmdCtx.sessionId);
      const result = await sessionMgr.compact(sessionId);
      if (result) {
        await cmdCtx.reply(
          `Compacted: removed ${result.messagesRemoved}, retained ${result.messagesRetained}.`,
        );
      } else {
        await cmdCtx.reply("No session to compact.");
      }
    },
  });
  commandRegistry.register({
    name: "context",
    description: "Show current context window usage",
    global: true,
    handler: async (cmdCtx) => {
      const executor = ctx.getChatExecutor();
      if (!executor) {
        await cmdCtx.reply(
          `Session: ${cmdCtx.sessionId}\nContext usage unavailable (LLM not initialized).`,
        );
        return;
      }

      const totalTokens = executor.getSessionTokenUsage(cmdCtx.sessionId);
      const contextWindowTokens = ctx.getResolvedContextWindowTokens();
      const sessionTokenBudget = resolveSessionTokenBudget(
        ctx.gateway?.config.llm,
        contextWindowTokens,
      );
      const ratio =
        sessionTokenBudget > 0 ? totalTokens / sessionTokenBudget : 0;
      const percent = Math.min(100, Math.max(0, ratio * 100));

      // Build breakdown
      const sessionId = resolveSessionId(cmdCtx.sessionId);
      const session = sessionMgr.get(sessionId);
      const historyLen = session?.history.length ?? 0;
      const systemPrompt = ctx.getSystemPrompt();
      const systemPromptChars = (systemPrompt ?? "").length;
      const systemPromptTokens = Math.ceil(systemPromptChars / 4);
      const toolCount = registry.size;
      const model = normalizeGrokModel(ctx.gateway?.config.llm?.model) ?? "unknown";
      const provider = ctx.gateway?.config.llm?.provider ?? "unknown";

      const overBudget = totalTokens > sessionTokenBudget;
      const lines = [
        `Context Window: ${(contextWindowTokens ?? 0).toLocaleString()} tokens (${model} via ${provider})`,
        `Session Budget: ${sessionTokenBudget.toLocaleString()} tokens`,
        `Used: ${totalTokens.toLocaleString()} tokens (${percent.toFixed(percent >= 10 ? 0 : 1)}%)` +
          (overBudget ? " — COMPACTION PENDING (next message will compact)" : ""),
        `Free: ${overBudget ? "0" : Math.max(0, sessionTokenBudget - totalTokens).toLocaleString()} tokens`,
        "",
        "Breakdown:",
        `  System prompt: ~${systemPromptTokens.toLocaleString()} tokens`,
        `  Tools: ${toolCount} registered`,
        `  History: ${historyLen} messages`,
        `  Memory: ${ctx.getMemoryBackendName() ?? "none"}`,
        "",
        "Workspace files loaded:",
      ];

      // Show which workspace files are loaded
      const wsFiles: [string, boolean][] = [
        ["AGENT.md", !!systemPrompt?.includes("# Agent")],
        ["AGENC.md", !!systemPrompt?.includes("# Repository Guidelines")],
        ["SOUL.md", !!systemPrompt?.includes("# Soul")],
        ["TOOLS.md", !!systemPrompt?.includes("# Tool")],
        ["MEMORY.md", !!systemPrompt?.includes("# Memory")],
        ["USER.md", !!systemPrompt?.includes("# User")],
      ];
      for (const [name, loaded] of wsFiles) {
        lines.push(`  ${loaded ? "●" : "○"} ${name}`);
      }

      await cmdCtx.reply(lines.join("\n"));
    },
  });
  commandRegistry.register({
    name: "status",
    description: "Show agent status",
    global: true,
    handler: async (cmdCtx) => {
      const sessionId = resolveSessionId(cmdCtx.sessionId);
      const session = sessionMgr.get(sessionId);
      const historyLen = session?.history.length ?? 0;
      const providerNames =
        providers.map((provider) => provider.name).join(" → ") || "none";
      await cmdCtx.reply(
        `Agent is running.\n` +
          `Session: ${cmdCtx.sessionId}\n` +
          `History: ${historyLen} messages\n` +
          `LLM: ${providerNames}\n` +
          `Memory: ${memoryBackend.name}\n` +
          `Tools: ${registry.size}\n` +
          `Skills: ${availableSkills.length}`,
      );
    },
  });
  commandRegistry.register({
    name: "policy",
    description: "Show policy state or simulate a tool policy decision",
    args: "[status|simulate <toolName> [jsonArgs]|credentials|revoke-credentials [credentialId]]",
    global: true,
    handler: async (cmdCtx) => {
      const subcommand = cmdCtx.argv[0]?.toLowerCase();
      if (!subcommand || subcommand === "status") {
        const state = ctx.getPolicyEngineState();
        const policy = ctx.gateway?.config.policy;
        await cmdCtx.reply(
          [
            `Policy engine: ${ctx.isPolicyEngineEnabled() ? "enabled" : "disabled"}`,
            `Simulation mode: ${policy?.simulationMode ?? "off"}`,
            `Audit log: ${ctx.isGovernanceAuditLogEnabled() ? "enabled" : "disabled"}`,
            state
              ? `Circuit mode: ${state.mode} (recent violations: ${state.recentViolations})`
              : "Circuit mode: unavailable",
          ].join("\n"),
        );
        return;
      }
      if (subcommand === "credentials") {
        const leases =
          ctx.listSessionCredentialLeases(cmdCtx.sessionId) ?? [];
        if (leases.length === 0) {
          await cmdCtx.reply("No active session credential leases.");
          return;
        }
        const lines = leases.map(
          (lease) =>
            `- ${lease.credentialId}: expires ${new Date(lease.expiresAt).toISOString()} ` +
            `(domains=${lease.domains.join(", ") || "none"})`,
        );
        await cmdCtx.reply(
          `Active session credential leases:\n${lines.join("\n")}`,
        );
        return;
      }
      if (subcommand === "revoke-credentials") {
        const credentialId = cmdCtx.argv[1]?.trim();
        const revoked = await ctx.revokeSessionCredentials({
          sessionId: cmdCtx.sessionId,
          credentialId:
            credentialId && credentialId.length > 0
              ? credentialId
              : undefined,
          reason: "manual",
        });
        await cmdCtx.reply(
          revoked > 0
            ? `Revoked ${revoked} session credential lease${revoked === 1 ? "" : "s"}.`
            : credentialId
              ? `No active lease found for credential ${credentialId}.`
              : "No active session credential leases to revoke.",
        );
        return;
      }
      if (subcommand !== "simulate") {
        await cmdCtx.reply(
          "Usage: /policy [status|simulate <toolName> [jsonArgs]|credentials|revoke-credentials [credentialId]]",
        );
        return;
      }
      const toolName = cmdCtx.argv[1]?.trim();
      if (!toolName) {
        await cmdCtx.reply("Usage: /policy simulate <toolName> [jsonArgs]");
        return;
      }
      const argsText = cmdCtx.args.replace(/^simulate\s+\S+\s*/i, "").trim();
      let parsedArgs: Record<string, unknown> = {};
      if (argsText.length > 0) {
        try {
          const candidate = JSON.parse(argsText);
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate)
          ) {
            await cmdCtx.reply("Policy simulate JSON args must be an object.");
            return;
          }
          parsedArgs = candidate as Record<string, unknown>;
        } catch (error) {
          await cmdCtx.reply(
            `Policy simulate JSON parse failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return;
        }
      }
      const preview = await ctx.buildPolicySimulationPreview({
        sessionId: cmdCtx.sessionId,
        toolName,
        args: parsedArgs,
      });
      const violationLines =
        preview.policy.violations.length > 0
          ? preview.policy.violations
              .map((violation) => `- ${violation.code}: ${violation.message}`)
              .join("\n")
          : "- none";
      const approvalPreview = preview.approval.requestPreview;
      await cmdCtx.reply(
        [
          `Policy simulation for ${preview.toolName}`,
          `Session: ${preview.sessionId}`,
          `Policy: ${preview.policy.allowed ? "allow" : "deny"} (${preview.policy.mode})`,
          `Violations:\n${violationLines}`,
          `Approval: required=${preview.approval.required} elevated=${preview.approval.elevated} denied=${preview.approval.denied}`,
          approvalPreview
            ? `Approval preview: ${approvalPreview.message}`
            : "Approval preview: none",
        ].join("\n"),
      );
    },
  });
  commandRegistry.register({
    name: "delegation",
    description: "Show or set delegation aggressiveness",
    args: "[status|conservative|balanced|aggressive|adaptive|default]",
    global: true,
    handler: async (cmdCtx) => {
      const resolved = ctx.getSubAgentRuntimeConfig();
      if (!resolved?.enabled) {
        await cmdCtx.reply(
          "Delegation is disabled. Enable llm.subagents.enabled in config first.",
        );
        return;
      }

      const renderStatus = (): string => {
        const activeProfile =
          ctx.getActiveDelegationAggressiveness(resolved);
        const effectiveThreshold =
          ctx.resolveDelegationScoreThreshold(resolved);
        const override = ctx.getDelegationAggressivenessOverride();
        const hardBlocked =
          resolved.hardBlockedTaskClasses.length > 0
            ? resolved.hardBlockedTaskClasses.join(", ")
            : "none";
        return (
          `Delegation profile: ${activeProfile}` +
          `${override ? " (runtime override)" : " (config)"}\n` +
          `Threshold: effective=${effectiveThreshold.toFixed(3)} base=${resolved.baseSpawnDecisionThreshold.toFixed(3)}\n` +
          `Mode: ${resolved.mode} (handoff min confidence ${resolved.handoffMinPlannerConfidence.toFixed(2)})\n` +
          `Child provider strategy: ${resolved.childProviderStrategy}\n` +
          `Hard-blocked task classes: ${hardBlocked}`
        );
      };

      const arg = cmdCtx.argv[0]?.toLowerCase();
      if (!arg || arg === "status") {
        await cmdCtx.reply(renderStatus());
        return;
      }

      if (arg === "default" || arg === "clear" || arg === "reset") {
        ctx.setDelegationAggressivenessOverride(null);
        ctx.configureDelegationRuntimeServices(resolved);
        await cmdCtx.reply(
          `Delegation aggressiveness reset to config default.\n${renderStatus()}`,
        );
        return;
      }

      if (
        arg !== "conservative" &&
        arg !== "balanced" &&
        arg !== "aggressive" &&
        arg !== "adaptive"
      ) {
        await cmdCtx.reply(
          "Usage: /delegation [status|conservative|balanced|aggressive|adaptive|default]",
        );
        return;
      }

      ctx.setDelegationAggressivenessOverride(arg);
      ctx.configureDelegationRuntimeServices(resolved);
      await cmdCtx.reply(
        `Delegation aggressiveness set to ${arg}.\n${renderStatus()}`,
      );
    },
  });
  commandRegistry.register({
    name: "eval",
    description:
      "Evaluate model output or run tool harness in current session",
    args: "[prompt] | full [prompt] | script [args]",
    global: true,
    handler: async (cmdCtx) => {
      const mode = cmdCtx.argv[0]?.toLowerCase();
      const scriptHarness = mode === "script";
      const fullHarness =
        mode === "full" || mode === "tools" || scriptHarness;

      if (!fullHarness) {
        const provider = providers[0];
        if (!provider) {
          await cmdCtx.reply("No configured LLM provider available for /eval.");
          return;
        }

        const prompt =
          cmdCtx.args && cmdCtx.args.trim().length > 0
            ? cmdCtx.args.trim()
            : 'Respond with strict JSON only: {"ok":true,"test":"model-eval"}';

        const started = Date.now();
        const traceConfig = resolveTraceLoggingConfig(
          ctx.gateway?.config.logging,
        );
        const evalProviderTrace =
          traceConfig.enabled && traceConfig.includeProviderPayloads
            ? {
                trace: {
                  includeProviderPayloads: true as const,
                  onProviderTraceEvent: (event: LLMProviderTraceEvent) => {
                    logProviderPayloadTraceEvent({
                      logger: ctx.logger,
                      channelName: "webchat.eval",
                      traceConfig,
                      traceId: `eval:${cmdCtx.sessionId ?? "unknown"}:${started}`,
                      sessionId: cmdCtx.sessionId,
                      event,
                    });
                  },
                },
              }
            : undefined;
        try {
          const response = await provider.chat(
            [
              {
                role: "system",
                content:
                  "You are a model evaluation probe. Follow user formatting instructions exactly.",
              },
              { role: "user", content: prompt },
            ],
            evalProviderTrace,
          );
          const durationMs = Date.now() - started;
          if (response.finishReason === "error" || response.error) {
            await cmdCtx.reply(
              `Model eval failed (${provider.name}) in ${durationMs}ms: ` +
                `${response.error?.message ?? "unknown provider error"}`,
            );
            return;
          }

          await cmdCtx.reply(
            `Model eval (${provider.name}) completed in ${durationMs}ms.\n` +
              `Model: ${response.model}\n` +
              `Finish: ${response.finishReason}\n` +
              `Usage: prompt=${response.usage.promptTokens}, completion=${response.usage.completionTokens}, total=${response.usage.totalTokens}\n` +
              `Response:\n${truncateToolLogText(response.content, EVAL_REPLY_MAX_CHARS)}\n` +
              `Mode: model-only (no tools). Use /eval full to run tools in this chat session.`,
          );
        } catch (err) {
          await cmdCtx.reply(
            `Model eval error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      if (!scriptHarness) {
        const inboundHandler = ctx.getWebChatInboundHandler();
        if (!inboundHandler) {
          await cmdCtx.reply(
            "Full eval unavailable: webchat pipeline is not initialized.",
          );
          return;
        }

        const desktopHandle = ctx.getDesktopHandleBySession(
          cmdCtx.sessionId,
        );
        const customPrompt = cmdCtx.args.replace(/^(full|tools)\s*/i, "").trim();
        const defaultPrompt = desktopHandle
          ? [
              "You are running /eval full inside a desktop-assigned chat session.",
              "Use desktop tools only for execution.",
              "Do not use system.bash or other system.* tools.",
              "Steps:",
              "1) Use desktop.bash to create /tmp/agenc-eval/index.html containing exactly: <h1>agent-ok</h1>.",
              '2) Use desktop.bash to start a local HTTP server on 127.0.0.1 with a free port, and write /tmp/agenc-eval/state.txt with "port=<port> pid=<pid>".',
              "3) Use desktop.bash to curl the server and verify response includes agent-ok.",
              "4) Use desktop.bash to stop the exact pid and verify the port is closed.",
              'Return strict JSON: {"overall":"pass|fail","steps":[{"name":"...","status":"pass|fail","evidence":"..."}]}',
            ].join("\n")
          : [
              "You are running /eval full in a host-tools session (no desktop assigned).",
              "Use system.bash for all execution steps.",
              "Steps:",
              "1) Create /tmp/agenc-eval/index.html containing exactly: <h1>agent-ok</h1>.",
              '2) Start a local HTTP server on 127.0.0.1 with a free port, and write /tmp/agenc-eval/state.txt with "port=<port> pid=<pid>".',
              "3) curl the server and verify response includes agent-ok.",
              "4) Stop the exact pid and verify the port is closed.",
              'Return strict JSON: {"overall":"pass|fail","steps":[{"name":"...","status":"pass|fail","evidence":"..."}]}',
            ].join("\n");

        const evalPrompt =
          customPrompt.length > 0 ? customPrompt : defaultPrompt;
        const evalMessage = createGatewayMessage({
          channel: "webchat",
          senderId: cmdCtx.senderId,
          senderName: `WebClient(${cmdCtx.senderId})`,
          sessionId: cmdCtx.sessionId,
          content: evalPrompt,
          scope: "dm",
          metadata: {
            source: "slash-eval",
            mode: "full",
            target: desktopHandle ? "desktop" : "host",
            desktopContainerId: desktopHandle?.containerId,
          },
        });

        await cmdCtx.reply(
          desktopHandle
            ? `Starting full eval in this chat session on assigned desktop ${desktopHandle.containerId}. Live tool events will stream below.`
            : "Starting full eval in this chat session using host tools (no desktop assigned). Live tool events will stream below.",
        );
        void inboundHandler(evalMessage).catch((error) => {
          void cmdCtx.reply(
            `Full eval failed to start: ${toErrorMessage(error)}`,
          );
        });
        return;
      }

      const harnessArgs = cmdCtx.argv.slice(1);
      const { scriptPath, candidateList } = await resolveEvalScriptForReply();
      if (!scriptPath) {
        await cmdCtx.reply(
          `Could not find ${EVAL_SCRIPT_NAME}. ` +
            `Checked these locations:\n${candidateList}\n` +
            "Use `/eval` for model testing or `/eval full` for in-session tool evaluation.",
        );
        return;
      }

      await cmdCtx.reply(
        `Running ${EVAL_SCRIPT_NAME} (live tool trace enabled)...`,
      );
      let streamedLines = 0;
      let droppedLines = 0;
      const maxStreamedLines = 60;
      const shouldStreamEvalLine = (line: string): boolean =>
        line.startsWith("[TEST]") ||
        line.startsWith("[TOOL]") ||
        line.includes("AGENT RESPONSE") ||
        line.startsWith("Overall:");

      const result = await runEvalScript(
        scriptPath,
        harnessArgs,
        (progress) => {
          const line = progress.line.trim();
          if (!shouldStreamEvalLine(line)) return;

          if (streamedLines >= maxStreamedLines) {
            droppedLines += 1;
            return;
          }
          streamedLines += 1;
          const prefix =
            progress.stream === "stderr" ? "[eval stderr]" : "[eval]";
          void cmdCtx.reply(`${prefix} ${truncateToolLogText(line, 500)}`);
        },
      );
      if (droppedLines > 0) {
        await cmdCtx.reply(
          `[eval] Suppressed ${droppedLines} additional progress line(s).`,
        );
      }
      if (result.exitCode === 0 && !didEvalScriptPass(result)) {
        await cmdCtx.reply(
          formatEvalScriptReply({
            ...result,
            exitCode: 1,
            stderr: result.stderr
              ? `${result.stderr}\nEval output did not report Overall: pass.`
              : "Eval output did not report Overall: pass.",
          }),
        );
        return;
      }
      await cmdCtx.reply(formatEvalScriptReply(result));
    },
  });
  commandRegistry.register({
    name: "skills",
    description: "List available skills",
    global: true,
    handler: async (cmdCtx) => {
      if (skillList.length === 0) {
        await cmdCtx.reply("No skills available.");
        return;
      }
      const lines = skillList.map(
        (skill) =>
          `  ${skill.enabled ? "●" : "○"} ${skill.name} — ${skill.description}`,
      );
      await cmdCtx.reply("Skills:\n" + lines.join("\n"));
    },
  });
  commandRegistry.register({
    name: "model",
    description: "Show or switch the current LLM model",
    args: "[model-name | current | list]",
    global: true,
    handler: async (cmdCtx) => {
      const sessionId = cmdCtx.sessionId;
      const last = ctx.getSessionModelInfo(sessionId);
      const arg = cmdCtx.args.trim();
      const argLower = arg.toLowerCase();
      const configuredPrimaryProvider = ctx.gateway?.config.llm?.provider ?? "none";
      const configuredPrimaryModel =
        configuredPrimaryProvider === "grok"
          ? normalizeGrokModel(ctx.gateway?.config.llm?.model) ??
            DEFAULT_GROK_MODEL
          : ctx.gateway?.config.llm?.model ?? "unknown";
      const configuredFallbacks =
        ctx.gateway?.config.llm?.fallback?.map((entry) => (
          `${entry.provider}:${
            entry.provider === "grok"
              ? normalizeGrokModel(entry.model) ?? DEFAULT_GROK_MODEL
              : entry.model ?? "unknown"
          }`
        )) ?? [];

      const knownGrokModels = listKnownGrokModels();
      const chatModels = knownGrokModels.filter((entry) => !entry.modality);

      // /model (no args) or /model current — show current routing
      if (!arg || argLower === "current") {
        const lines = [
          "Model routing:",
          last
            ? `  Last completion: ${last.model} (provider: ${last.provider}${last.usedFallback ? ", fallback used" : ""})`
            : "  Last completion: none recorded for this session",
          `  Primary: ${configuredPrimaryProvider}:${configuredPrimaryModel}`,
          `  Fallbacks: ${configuredFallbacks.length > 0 ? configuredFallbacks.join(", ") : "none"}`,
          "",
          `Available chat models: ${chatModels.map((m) => m.id).join(", ")}`,
          "",
          "Switch with: /model <model-name>",
        ];
        await cmdCtx.reply(lines.join("\n"));
        return;
      }

      // /model list — show full catalog
      if (argLower === "list") {
        const lines = ["Known xAI models:"];
        for (const entry of knownGrokModels) {
          if (entry.modality) {
            lines.push(`  ${entry.id} [${entry.modality}]`);
          } else {
            const active = entry.id === configuredPrimaryModel ? " (active)" : "";
            lines.push(
              `  ${entry.id} (${entry.contextWindowTokens.toLocaleString("en-US")} ctx)${active}` +
                (entry.aliases.length > 0 ? ` aliases: ${entry.aliases.join(", ")}` : ""),
            );
          }
        }
        await cmdCtx.reply(lines.join("\n"));
        return;
      }

      // /model <name> — switch model
      if (configuredPrimaryProvider !== "grok") {
        await cmdCtx.reply(
          `Model switching is only supported for the grok provider (current: ${configuredPrimaryProvider}).`,
        );
        return;
      }

      const normalized = normalizeGrokModel(arg) ?? arg;
      let match = chatModels.find((m) => m.id === normalized);
      if (!match) {
        // Try fuzzy: check if any model contains the input
        const fuzzy = chatModels.filter((m) =>
          m.id.toLowerCase().includes(argLower) ||
          m.aliases.some((a) => a.toLowerCase().includes(argLower)),
        );
        if (fuzzy.length === 1) {
          match = fuzzy[0];
        } else if (fuzzy.length > 1) {
          await cmdCtx.reply(
            `Multiple models match "${arg}":\n${fuzzy.map((m) => `  ${m.id}`).join("\n")}\n\nBe more specific.`,
          );
          return;
        } else {
          await cmdCtx.reply(
            `Unknown model "${arg}". Available chat models:\n${chatModels.map((m) => `  ${m.id}`).join("\n")}`,
          );
          return;
        }
      }

      if (match.id === configuredPrimaryModel) {
        await cmdCtx.reply(`Already using ${match.id}.`);
        return;
      }

      // Write updated model to config file and explicitly trigger reload
      try {
        const raw = await readFile(ctx.configPath, "utf-8");
        const config = JSON.parse(raw) as Record<string, unknown>;
        const llm = (config.llm ?? {}) as Record<string, unknown>;
        llm.model = match.id;
        config.llm = llm;
        await writeFile(ctx.configPath, JSON.stringify(config, null, 2) + "\n");
        ctx.logger.info(`Model switched to ${match.id} via /model command`);
        // Trigger config reload explicitly — filesystem watchers can be unreliable
        await ctx.handleConfigReload();
        await cmdCtx.reply(
          `Model switched: ${configuredPrimaryModel} → ${match.id} (${match.contextWindowTokens.toLocaleString("en-US")} ctx)`,
        );
      } catch (err) {
        ctx.logger.error("Failed to update model config", { error: toErrorMessage(err) });
        await cmdCtx.reply(`Failed to switch model: ${toErrorMessage(err)}`);
      }
    },
  });

  // Voice command
  const XAI_VOICES = ["Ara", "Rex", "Sal", "Eve", "Leo"] as const;
  commandRegistry.register({
    name: "voice",
    description: "Show voice config or change voice persona",
    args: "[Ara|Rex|Sal|Eve|Leo|status|enable|disable]",
    global: true,
    handler: async (cmdCtx) => {
      const arg = cmdCtx.args.trim();
      const voiceConfig = ctx.gateway?.config.voice;
      const bridge = ctx.getVoiceBridge();

      // /voice status — show active sessions
      if (arg.toLowerCase() === "status") {
        const count = bridge?.activeSessionCount ?? 0;
        const lines = [
          `Voice sessions: ${count} active`,
          `Enabled: ${voiceConfig?.enabled !== false && bridge ? "yes" : "no"}`,
          `Voice: ${voiceConfig?.voice ?? "Ara"} (default)`,
          `Mode: ${voiceConfig?.mode ?? "vad"}`,
          `Model: ${voiceConfig?.model ?? DEFAULT_GROK_MODEL}`,
          `VAD threshold: ${voiceConfig?.vadThreshold ?? 0.5}`,
          `VAD silence: ${voiceConfig?.vadSilenceDurationMs ?? 800}ms`,
        ];
        await cmdCtx.reply(lines.join("\n"));
        return;
      }

      // /voice enable / disable
      if (arg.toLowerCase() === "enable" || arg.toLowerCase() === "disable") {
        const enable = arg.toLowerCase() === "enable";
        if (ctx.gateway?.config.voice) {
          ctx.gateway.config.voice.enabled = enable;
        }
        await cmdCtx.reply(`Voice ${enable ? "enabled" : "disabled"}.`);
        return;
      }

      // /voice <VoiceName> — change voice persona
      const matchedVoice = XAI_VOICES.find(
        (v) => v.toLowerCase() === arg.toLowerCase(),
      );
      if (matchedVoice) {
        if (ctx.gateway?.config.voice) {
          ctx.gateway.config.voice.voice = matchedVoice;
        } else if (ctx.gateway?.config) {
          (ctx.gateway.config as any).voice = { voice: matchedVoice };
        }
        await cmdCtx.reply(
          `Voice set to ${matchedVoice}. New voice sessions will use this persona.`,
        );
        return;
      }

      // /voice (no args) — show config + available voices
      const currentVoice = voiceConfig?.voice ?? "Ara";
      const lines = [
        `Voice: ${bridge ? "available" : "not configured"}`,
        `Current persona: ${currentVoice}`,
        `Mode: ${voiceConfig?.mode ?? "vad"}`,
        `Sessions: ${bridge?.activeSessionCount ?? 0} active`,
        "",
        "Available voices:",
      ];
      for (const v of XAI_VOICES) {
        lines.push(`  ${v === currentVoice ? "●" : "○"} ${v}`);
      }
      lines.push(
        "",
        "Usage: /voice <name> to switch, /voice status for details",
      );
      await cmdCtx.reply(lines.join("\n"));
    },
  });

  // Progress tracker command
  if (progressTracker) {
    commandRegistry.register({
      name: "progress",
      description: "Show recent task progress",
      global: true,
      handler: async (cmdCtx) => {
        const sessionId = cmdCtx.sessionId;
        const summary = await progressTracker.getSummary(sessionId);
        await cmdCtx.reply(summary || "No progress entries yet.");
      },
    });
  }

  // Pipeline commands
  if (pipelineExecutor) {
    commandRegistry.register({
      name: "pipeline",
      description: "Run a pipeline from JSON steps",
      args: "<json>",
      global: true,
      handler: async (cmdCtx) => {
        if (!cmdCtx.args) {
          await cmdCtx.reply(
            'Usage: /pipeline [{"name":"step1","tool":"system.bash","args":{"command":"ls"}}]',
          );
          return;
        }
        try {
          const steps: PipelineStep[] = JSON.parse(cmdCtx.args);
          if (!Array.isArray(steps) || steps.length === 0) {
            await cmdCtx.reply("Pipeline steps must be a non-empty JSON array.");
            return;
          }
          const pipeline: Pipeline = {
            id: `pipeline-${Date.now()}`,
            steps,
            context: { results: {} },
            createdAt: Date.now(),
          };
          await cmdCtx.reply(
            `Starting pipeline "${pipeline.id}" with ${steps.length} step(s)...`,
          );
          const result = await pipelineExecutor.execute(pipeline);
          if (result.status === "completed") {
            await cmdCtx.reply(
              `Pipeline completed (${result.completedSteps}/${result.totalSteps} steps).`,
            );
          } else if (result.status === "halted") {
            await cmdCtx.reply(
              `Pipeline halted at step ${result.resumeFrom}/${result.totalSteps}. ` +
                `Use /resume ${pipeline.id} to continue.`,
            );
          } else {
            await cmdCtx.reply(
              `Pipeline failed: ${result.error ?? "unknown error"}`,
            );
          }
        } catch (err) {
          await cmdCtx.reply(
            `Invalid pipeline JSON: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    });
    commandRegistry.register({
      name: "resume",
      description: "Resume a halted pipeline",
      args: "[pipeline-id]",
      global: true,
      handler: async (cmdCtx) => {
        if (!cmdCtx.args) {
          const active = await pipelineExecutor.listActive();
          if (active.length === 0) {
            await cmdCtx.reply("No active pipelines.");
            return;
          }
          const lines = active.map(
            (cp) =>
              `  ${cp.pipelineId} — step ${cp.stepIndex}/${cp.pipeline.steps.length} (${cp.status})`,
          );
          await cmdCtx.reply("Active pipelines:\n" + lines.join("\n"));
          return;
        }
        try {
          const result = await pipelineExecutor.resume(cmdCtx.args.trim());
          if (result.status === "completed") {
            await cmdCtx.reply(
              `Pipeline resumed and completed (${result.completedSteps}/${result.totalSteps} steps).`,
            );
          } else if (result.status === "halted") {
            await cmdCtx.reply(
              `Pipeline halted again at step ${result.resumeFrom}/${result.totalSteps}.`,
            );
          } else {
            await cmdCtx.reply(
              `Pipeline resume failed: ${result.error ?? "unknown error"}`,
            );
          }
        } catch (err) {
          await cmdCtx.reply(
            `Resume failed: ${err instanceof Error ? err.message : err}`,
          );
        }
      },
    });
  }

  // Desktop sandbox commands (only when desktop is enabled)
  const desktopMgr = ctx.getDesktopManager();
  if (desktopMgr) {
    commandRegistry.register({
      name: "desktop",
      description:
        "Manage desktop sandbox (start|stop|status|vnc|list|attach)",
      args: "<subcommand>",
      global: true,
      handler: async (cmdCtx) => {
        const sub = cmdCtx.argv[0]?.toLowerCase();
        const sessionId = cmdCtx.sessionId;
        const listOrderedSandboxes = () =>
          desktopMgr
            .listAll()
            .slice()
            .sort((a, b) => a.createdAt - b.createdAt);
        const listActiveSandboxes = () =>
          listOrderedSandboxes().filter(
            (entry) =>
              entry.status !== "stopped" && entry.status !== "failed",
          );
        const desktopLabel = (index: number) => `desktop-${index + 1}`;
        const findDesktopLabel = (
          containerId: string,
        ): string | undefined => {
          const index = listOrderedSandboxes().findIndex(
            (entry) => entry.containerId === containerId,
          );
          return index >= 0 ? desktopLabel(index) : undefined;
        };
        const resolveAttachTarget = (
          rawTarget: string | undefined,
        ): { containerId?: string; label?: string; error?: string } => {
          const running = listActiveSandboxes();
          if (running.length === 0) {
            return {
              error: "No active desktop sandboxes. Use /desktop start first.",
            };
          }

          const target = rawTarget?.trim();
          if (!target) {
            if (running.length === 1) {
              return {
                containerId: running[0].containerId,
                label: findDesktopLabel(running[0].containerId),
              };
            }
            return {
              error:
                "Usage: /desktop attach <number|name|containerId>\nTip: run /desktop list first.",
            };
          }

          if (/^\d+$/.test(target)) {
            const index = Number.parseInt(target, 10) - 1;
            if (index >= 0 && index < running.length) {
              return {
                containerId: running[index].containerId,
                label: findDesktopLabel(running[index].containerId),
              };
            }
            return {
              error: `Desktop index out of range: ${target}. Run /desktop list first.`,
            };
          }

          const labelMatch = target.toLowerCase().match(/^desktop-(\d+)$/);
          if (labelMatch) {
            const index = Number.parseInt(labelMatch[1], 10) - 1;
            if (index >= 0 && index < running.length) {
              return {
                containerId: running[index].containerId,
                label: desktopLabel(index),
              };
            }
            return {
              error: `Unknown desktop name: ${target}. Run /desktop list first.`,
            };
          }

          const exact = running.find((entry) => entry.containerId === target);
          if (exact) {
            return {
              containerId: exact.containerId,
              label: findDesktopLabel(exact.containerId),
            };
          }

          const prefixMatches = running.filter((entry) =>
            entry.containerId.startsWith(target),
          );
          if (prefixMatches.length === 1) {
            return {
              containerId: prefixMatches[0].containerId,
              label: findDesktopLabel(prefixMatches[0].containerId),
            };
          }
          if (prefixMatches.length > 1) {
            return {
              error:
                `Container id prefix "${target}" is ambiguous (${prefixMatches.length} matches). ` +
                "Use /desktop list and pick the desktop number.",
            };
          }

          return {
            error:
              `Desktop not found: ${target}\n` +
              "Use /desktop list and attach by number (for example, /desktop attach 1).",
          };
        };
        const resolveActiveSessionHandle = (): {
          handle?: ReturnType<typeof desktopMgr.getHandleBySession>;
          sourceSessionId?: string;
        } => {
          const direct = desktopMgr.getHandleBySession(sessionId);
          if (direct) {
            return { handle: direct, sourceSessionId: sessionId };
          }

          // Voice/session routing previously used senderId as the desktop
          // router key. Keep /desktop stop/status/vnc compatible with those
          // existing sandboxes while newer sessions converge on sessionId.
          const senderSessionId = cmdCtx.senderId?.trim();
          if (senderSessionId && senderSessionId !== sessionId) {
            const senderHandle =
              desktopMgr.getHandleBySession(senderSessionId);
            if (senderHandle) {
              return {
                handle: senderHandle,
                sourceSessionId: senderSessionId,
              };
            }
          }

          return {};
        };

        if (sub === "start") {
          const parseStartResourceOverrides = (): {
            maxMemory?: string;
            maxCpu?: string;
            error?: string;
          } => {
            let maxMemory: string | undefined;
            let maxCpu: string | undefined;
            for (let i = 1; i < cmdCtx.argv.length; i++) {
              const token = cmdCtx.argv[i];
              if (token === "--memory" || token === "--ram") {
                const value = cmdCtx.argv[i + 1];
                if (!value) return { error: "Missing value for --memory" };
                maxMemory = value;
                i += 1;
                continue;
              }
              if (
                token.startsWith("--memory=") ||
                token.startsWith("--ram=")
              ) {
                maxMemory = token.slice(token.indexOf("=") + 1);
                continue;
              }
              if (token === "--cpu" || token === "--cpus") {
                const value = cmdCtx.argv[i + 1];
                if (!value) return { error: "Missing value for --cpu" };
                maxCpu = value;
                i += 1;
                continue;
              }
              if (token.startsWith("--cpu=") || token.startsWith("--cpus=")) {
                maxCpu = token.slice(token.indexOf("=") + 1);
                continue;
              }
              return { error: `Unknown /desktop start option: ${token}` };
            }
            return { maxMemory, maxCpu };
          };

          const overrides = parseStartResourceOverrides();
          if (overrides.error) {
            await cmdCtx.reply(
              `${overrides.error}\nUsage: /desktop start [--memory 4g] [--cpu 2.0]`,
            );
            return;
          }

          const existing = desktopMgr.getHandleBySession(sessionId);
          if (existing && (overrides.maxMemory || overrides.maxCpu)) {
            await cmdCtx.reply(
              `Desktop already running for this session (RAM ${existing.maxMemory}, CPU ${existing.maxCpu}). ` +
                "Stop it first to change resources.",
            );
            return;
          }

          try {
            const handle = await desktopMgr.getOrCreate(sessionId, {
              maxMemory: overrides.maxMemory,
              maxCpu: overrides.maxCpu,
            });
            const label = findDesktopLabel(handle.containerId) ?? "desktop";
            await cmdCtx.reply(
              `Desktop sandbox started (${label}).\nVNC: http://localhost:${handle.vncHostPort}/vnc.html\n` +
                `Resolution: ${handle.resolution.width}x${handle.resolution.height}\n` +
                `Resources: RAM ${handle.maxMemory}, CPU ${handle.maxCpu}`,
            );
          } catch (err) {
            await cmdCtx.reply(
              `Failed to start desktop: ${err instanceof Error ? err.message : err}`,
            );
          }
        } else if (sub === "stop") {
          const stopTarget = cmdCtx.argv[1]?.trim();
          const { destroySessionBridge } =
            await import("../desktop/session-router.js");

          if (stopTarget && stopTarget.length > 0) {
            const resolved = resolveAttachTarget(stopTarget);
            if (!resolved.containerId) {
              await cmdCtx.reply(
                resolved.error ?? "Failed to resolve desktop target.",
              );
              return;
            }

            const targetHandle = desktopMgr.getHandle(resolved.containerId);
            await desktopMgr.destroy(resolved.containerId);

            const sessionsToReset = new Set<string>([sessionId]);
            if (targetHandle?.sessionId) {
              sessionsToReset.add(targetHandle.sessionId);
            }
            for (const targetSessionId of sessionsToReset) {
              destroySessionBridge(
                targetSessionId,
                ctx.getDesktopBridges() as any,
                ctx.getPlaywrightBridges() as any,
                ctx.getContainerMCPBridges() as any,
                ctx.logger,
              );
            }

            await cmdCtx.reply(
              `Desktop sandbox stopped (${resolved.label ?? resolved.containerId}).`,
            );
            return;
          }

          const activeResolution = resolveActiveSessionHandle();
          const active = activeResolution.handle;
          if (!active) {
            await cmdCtx.reply(
              "No active desktop sandbox for this session.\n" +
                "Use /desktop list and stop by number (for example, /desktop stop 1).",
            );
            return;
          }

          await desktopMgr.destroy(active.containerId);
          const sessionsToReset = new Set<string>([sessionId]);
          if (activeResolution.sourceSessionId) {
            sessionsToReset.add(activeResolution.sourceSessionId);
          }
          for (const targetSessionId of sessionsToReset) {
            destroySessionBridge(
              targetSessionId,
              ctx.getDesktopBridges() as any,
              ctx.getPlaywrightBridges() as any,
              ctx.getContainerMCPBridges() as any,
              ctx.logger,
            );
          }
          await cmdCtx.reply("Desktop sandbox stopped.");
        } else if (sub === "status") {
          const handle = resolveActiveSessionHandle().handle;
          if (!handle) {
            await cmdCtx.reply("No active desktop sandbox for this session.");
          } else {
            const uptimeS = Math.round(
              (Date.now() - handle.createdAt) / 1000,
            );
            const label = findDesktopLabel(handle.containerId) ?? "desktop";
            await cmdCtx.reply(
              `Desktop sandbox: ${label} [${handle.status}]\n` +
                `Container: ${handle.containerId}\n` +
                `Uptime: ${uptimeS}s\n` +
                `VNC: http://localhost:${handle.vncHostPort}/vnc.html\n` +
                `Resolution: ${handle.resolution.width}x${handle.resolution.height}\n` +
                `Resources: RAM ${handle.maxMemory}, CPU ${handle.maxCpu}`,
            );
          }
        } else if (sub === "vnc") {
          const handle = resolveActiveSessionHandle().handle;
          if (!handle) {
            await cmdCtx.reply(
              "No active desktop sandbox. Use /desktop start first.",
            );
          } else {
            await cmdCtx.reply(
              `http://localhost:${handle.vncHostPort}/vnc.html`,
            );
          }
        } else if (sub === "list") {
          const all = listOrderedSandboxes();
          if (all.length === 0) {
            await cmdCtx.reply("No desktop sandboxes running.");
          } else {
            const lines = all.map((entry, index) => {
              const label = desktopLabel(index);
              const session =
                entry.sessionId.length > 48
                  ? `${entry.sessionId.slice(0, 48)}...`
                  : entry.sessionId;
              return (
                `${index + 1}) ${label} [${entry.status}] id=${entry.containerId}\n` +
                `   session=${session} ram=${entry.maxMemory} cpu=${entry.maxCpu}\n` +
                `   vnc=${entry.vncUrl}`
              );
            });
            await cmdCtx.reply(
              `Desktop sandboxes (${all.length}):\n${lines.join("\n")}\n` +
                "Attach with: /desktop attach <number|name|containerId>",
            );
          }
        } else if (sub === "attach") {
          const targetArg = cmdCtx.argv[1];
          const resolved = resolveAttachTarget(
            typeof targetArg === "string" ? targetArg : undefined,
          );
          if (!resolved.containerId) {
            await cmdCtx.reply(
              resolved.error ?? "Failed to resolve desktop target.",
            );
            return;
          }

          try {
            const { destroySessionBridge } =
              await import("../desktop/session-router.js");
            // Reset any existing bridge for this session so follow-up desktop tool
            // calls reconnect against the newly attached container.
            destroySessionBridge(
              sessionId,
              ctx.getDesktopBridges() as any,
              ctx.getPlaywrightBridges() as any,
              ctx.getContainerMCPBridges() as any,
              ctx.logger,
            );
            const handle = desktopMgr.assignSession(
              resolved.containerId,
              sessionId,
            );
            const label =
              resolved.label ??
              findDesktopLabel(handle.containerId) ??
              "desktop";
            await cmdCtx.reply(
              `Attached ${label} (${handle.containerId}) to this chat session.\n` +
                `VNC: http://localhost:${handle.vncHostPort}/vnc.html`,
            );
          } catch (err) {
            await cmdCtx.reply(
              `Failed to attach desktop: ${err instanceof Error ? err.message : err}`,
            );
          }
        } else {
          await cmdCtx.reply(
            "Usage: /desktop <start|stop|status|vnc|list|attach>\n" +
              "/desktop start flags: [--memory 4g] [--cpu 2.0]\n" +
              "/desktop attach: <number|name|containerId>",
          );
        }
      },
    });
  }

  // /goal — create or list goals (lazy access to goalManager via getter)
  commandRegistry.register({
    name: "goal",
    description: "Create or list goals",
    args: "[description]",
    global: true,
    handler: async (cmdCtx) => {
      const gm = ctx.getGoalManager();
      if (!gm) {
        await cmdCtx.reply(
          "Goal manager not available. Autonomous features may be disabled.",
        );
        return;
      }
      if (cmdCtx.args) {
        const goal = await gm.addGoal({
          title: cmdCtx.args.slice(0, 60),
          description: cmdCtx.args,
          priority: "medium",
          source: "user",
          maxAttempts: 2,
        });
        await cmdCtx.reply(
          `Goal created [${goal.id.slice(0, 8)}]: ${goal.title}`,
        );
      } else {
        const active = await gm.getActiveGoals();
        if (active.length === 0) {
          await cmdCtx.reply(
            "No active goals. Use /goal <description> to create one.",
          );
          return;
        }
        const lines = active.map(
          (g) => `  [${g.priority}/${g.status}] ${g.title}`,
        );
        await cmdCtx.reply(
          `Active goals (${active.length}):\n${lines.join("\n")}`,
        );
      }
    },
  });

  return commandRegistry;
}
