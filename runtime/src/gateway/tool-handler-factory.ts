/**
 * Shared session-scoped tool handler factory.
 *
 * Extracts the common hook → approval → routing → execution → notify pipeline
 * used by both the daemon (text-mode) and voice-bridge (legacy tool calls).
 *
 * @module
 */

import type { ControlResponse } from './types.js';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath } from 'node:path';
import type { ToolHandler } from '../llm/types.js';
import {
  didToolCallFail,
  normalizeToolCallArguments,
} from '../llm/chat-executor-tool-utils.js';
import type { HookDispatcher } from './hooks.js';
import type { ApprovalEngine } from './approvals.js';
import {
  EXECUTE_WITH_AGENT_TOOL_NAME,
} from './delegation-tool.js';
import {
  isSubAgentSessionId,
  type DelegationToolCompositionResolver,
} from './delegation-runtime.js';
import { executeDelegationTool } from "./tool-handler-factory-delegation.js";
import type { PolicyEvaluationScope } from "../policy/types.js";
import type { SessionCredentialBroker } from "../policy/session-credentials.js";

const DESKTOP_GUI_LAUNCH_RE =
  /^\s*(?:sudo\s+)?(?:env\s+[^;]+\s+)?(?:nohup\s+|setsid\s+)?(?:xfce4-terminal|gnome-terminal|xterm|kitty|firefox|chromium|chromium-browser|google-chrome|thunar|nautilus|mousepad|gedit)\b/i;
const DESKTOP_TERMINAL_LAUNCH_RE = /\b(?:xfce4-terminal|gnome-terminal|xterm|kitty)\b/i;
const DESKTOP_BROWSER_LAUNCH_RE = /\b(?:firefox|chromium|chromium-browser|google-chrome)\b/i;
const DESKTOP_FILE_MANAGER_LAUNCH_RE = /\b(?:thunar|nautilus)\b/i;
const DESKTOP_EDITOR_LAUNCH_RE = /\b(?:mousepad|gedit)\b/i;
const COLLAPSE_WHITESPACE_RE = /\s+/g;
const APPROVAL_TASK_PREVIEW_MAX_CHARS = 180;
const DOOM_TOOL_PREFIX = 'mcp.doom.';
const TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  "system.makeDir": "system.mkdir",
  "system.listFiles": "system.listDir",
};
const TOOL_DEFAULT_CWD_NAMES = new Set([
  "system.bash",
  "system.processStart",
  "system.serverStart",
]);
const TOOL_PATH_ARG_KEYS: Readonly<Record<string, readonly string[]>> = {
  "system.readFile": ["path"],
  "system.writeFile": ["path"],
  "system.appendFile": ["path"],
  "system.listDir": ["path"],
  "system.stat": ["path"],
  "system.mkdir": ["path"],
  "system.delete": ["path"],
  "system.move": ["source", "destination"],
  "system.pdfInfo": ["path"],
  "system.pdfExtractText": ["path"],
  "system.officeDocumentInfo": ["path"],
  "system.officeDocumentExtractText": ["path"],
  "system.emailMessageInfo": ["path"],
  "system.emailMessageExtractText": ["path"],
  "system.calendarInfo": ["path"],
  "system.calendarRead": ["path"],
  "system.sqliteSchema": ["path"],
  "system.sqliteQuery": ["path"],
  "system.spreadsheetInfo": ["path"],
  "system.spreadsheetRead": ["path"],
};
const ROOT_SCOPED_COMMAND_TOOLS = new Set([
  "system.bash",
  "desktop.bash",
  "system.processStart",
  "system.serverStart",
]);
const ABSOLUTE_PATH_ARG_RE = /^(?:~\/|\/)/;
const HEAD_TAIL_OPTION_VALUE_FLAGS = new Set([
  "-c",
  "-n",
  "--bytes",
  "--lines",
]);
const GREP_OPTION_VALUE_FLAGS = new Set([
  "-A",
  "-B",
  "-C",
  "-D",
  "-e",
  "-f",
  "-m",
  "--after-context",
  "--before-context",
  "--context",
  "--directories",
  "--max-count",
  "--regexp",
  "--file",
]);
const SED_OPTION_VALUE_FLAGS = new Set([
  "-e",
  "-f",
  "--expression",
  "--file",
]);
const WORKSPACE_ALIAS_ROOT = "/workspace";

function normalizeToolName(name: string): string {
  const alias = TOOL_NAME_ALIASES[name];
  return typeof alias === "string" ? alias : name;
}

function isRelativeLocalPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (isAbsolute(trimmed) || trimmed.startsWith("~")) {
    return false;
  }
  return !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
}

function pathExists(candidatePath: string): boolean {
  try {
    return existsSync(candidatePath);
  } catch {
    return false;
  }
}

function referencesAbsolutePathWithinRoot(
  toolName: string,
  args: Record<string, unknown>,
  rootPath: string,
): boolean {
  const normalizedRoot = normalizeScopedPathCandidate(rootPath);
  if ((toolName === "system.bash" || toolName === "desktop.bash")) {
    if (Array.isArray(args.args)) {
      for (const arg of extractDirectCommandPathArgs(args.command, args.args)) {
        const candidatePath = normalizeScopedPathCandidate(arg);
        if (isWithinRoot(normalizedRoot, candidatePath)) {
          return true;
        }
      }
    } else if (typeof args.command === "string") {
      for (const pathValue of extractAbsoluteShellPaths(args.command)) {
        const candidatePath = normalizeScopedPathCandidate(pathValue);
        if (isWithinRoot(normalizedRoot, candidatePath)) {
          return true;
        }
      }
    }
  }

  return false;
}

interface DefaultWorkingDirectoryApplication {
  readonly args: Record<string, unknown>;
  readonly missingDefaultWorkingDirectory?: {
    readonly path: string;
    readonly bootstrapPermitted: boolean;
  };
}

function applyDefaultWorkingDirectory(
  toolName: string,
  args: Record<string, unknown>,
  defaultWorkingDirectory?: string,
): DefaultWorkingDirectoryApplication {
  const workingDirectory = defaultWorkingDirectory?.trim();
  if (!workingDirectory) {
    return { args };
  }

  let nextArgs = args;
  const cwdValue = typeof nextArgs.cwd === "string"
    ? nextArgs.cwd.trim()
    : undefined;
  const hasExplicitCwd = typeof cwdValue === "string" && cwdValue.length > 0;
  const logicalWorkingDirectory = cwdValue && isRelativeLocalPath(cwdValue)
    ? resolvePath(workingDirectory, cwdValue)
    : (cwdValue ?? workingDirectory);
  const shouldInjectDefaultCwd = TOOL_DEFAULT_CWD_NAMES.has(toolName);
  let executionWorkingDirectory: string | undefined = logicalWorkingDirectory;
  let missingDefaultWorkingDirectory:
    | DefaultWorkingDirectoryApplication["missingDefaultWorkingDirectory"]
    | undefined;

  if (
    shouldInjectDefaultCwd &&
    !hasExplicitCwd &&
    !pathExists(logicalWorkingDirectory)
  ) {
    executionWorkingDirectory = undefined;
    missingDefaultWorkingDirectory = {
      path: logicalWorkingDirectory,
      bootstrapPermitted: referencesAbsolutePathWithinRoot(
        toolName,
        nextArgs,
        logicalWorkingDirectory,
      ),
    };
  }

  if (
    shouldInjectDefaultCwd &&
    typeof executionWorkingDirectory === "string" &&
    nextArgs.cwd !== executionWorkingDirectory
  ) {
    nextArgs = { ...nextArgs, cwd: executionWorkingDirectory };
  }

  const pathArgKeys = TOOL_PATH_ARG_KEYS[toolName];
  if (!pathArgKeys) {
    return {
      args: nextArgs,
      ...(missingDefaultWorkingDirectory
        ? { missingDefaultWorkingDirectory }
        : {}),
    };
  }

  for (const key of pathArgKeys) {
    const value = nextArgs[key];
    if (typeof value !== "string" || !isRelativeLocalPath(value)) {
      continue;
    }
    if (nextArgs === args) {
      nextArgs = { ...nextArgs };
    }
    nextArgs[key] = resolvePath(logicalWorkingDirectory, value);
  }

  return {
    args: nextArgs,
    ...(missingDefaultWorkingDirectory
      ? { missingDefaultWorkingDirectory }
      : {}),
  };
}

function buildMissingDefaultWorkingDirectoryError(
  path: string,
  bootstrapPermitted: boolean,
): string {
  if (bootstrapPermitted) {
    return (
      `Delegated working directory "${path}" does not exist yet, so no default cwd was injected. ` +
      "Retry with an existing cwd or keep targeting that workspace via absolute paths until it exists."
    );
  }
  return (
    `Delegated working directory "${path}" does not exist yet. ` +
    "Create it first with system.mkdir or retry the command with an existing cwd."
  );
}

function expandHomeDirectory(rawPath: string): string {
  if (
    rawPath === "~" ||
    rawPath.startsWith("~/") ||
    rawPath.startsWith("~\\")
  ) {
    const home = process.env.HOME ?? process.env.USERPROFILE;
    if (!home || home.trim().length === 0) return rawPath;
    if (rawPath === "~") return home;
    return `${home}${rawPath.slice(1)}`;
  }
  return rawPath;
}

function normalizeScopedRootPath(rootPath: string): string {
  return resolvePath(expandHomeDirectory(rootPath.trim()));
}

function isWithinRoot(rootPath: string, candidatePath: string): boolean {
  const rel = relative(rootPath, candidatePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function normalizeScopedPathCandidate(rawPath: string): string {
  return resolvePath(expandHomeDirectory(rawPath.trim()));
}

function hasWorkspaceAliasPath(rawPath: string): boolean {
  return rawPath === WORKSPACE_ALIAS_ROOT ||
    rawPath.startsWith(`${WORKSPACE_ALIAS_ROOT}/`);
}

function translateWorkspaceAliasPath(
  rawPath: string,
  workspaceRoot?: string,
): string {
  const trimmed = rawPath.trim();
  if (!hasWorkspaceAliasPath(trimmed)) {
    return rawPath;
  }
  const root = workspaceRoot?.trim();
  if (!root || root === WORKSPACE_ALIAS_ROOT) {
    return rawPath;
  }
  const normalizedRoot = normalizeScopedPathCandidate(root);
  if (hasWorkspaceAliasPath(normalizedRoot)) {
    return rawPath;
  }
  if (normalizedRoot === "/") {
    return rawPath;
  }
  const relativePath = trimmed
    .slice(WORKSPACE_ALIAS_ROOT.length)
    .replace(/^\/+/, "");
  return relativePath.length > 0
    ? resolvePath(normalizedRoot, relativePath)
    : normalizedRoot;
}

function rewriteWorkspaceAliasShellCommand(
  command: string,
  workspaceRoot?: string,
): string {
  const replacements = [...extractAbsoluteShellPaths(command)]
    .map((value) => ({
      from: value,
      to: translateWorkspaceAliasPath(value, workspaceRoot),
    }))
    .filter((entry) => entry.from !== entry.to)
    .sort((left, right) => right.from.length - left.from.length);

  let rewritten = command;
  for (const entry of replacements) {
    rewritten = rewritten.split(entry.from).join(entry.to);
  }
  return rewritten;
}

function applyWorkspaceAliasTranslation(
  toolName: string,
  args: Record<string, unknown>,
  workspaceRoot?: string,
): Record<string, unknown> {
  const root = workspaceRoot?.trim();
  if (!root || root === WORKSPACE_ALIAS_ROOT) {
    return args;
  }

  let nextArgs = args;
  const updateArg = (key: string, nextValue: unknown): void => {
    if (nextArgs === args) {
      nextArgs = { ...args };
    }
    nextArgs[key] = nextValue;
  };

  const pathArgKeys = TOOL_PATH_ARG_KEYS[toolName];
  if (pathArgKeys) {
    for (const key of pathArgKeys) {
      const value = nextArgs[key];
      if (typeof value !== "string" || value.trim().length === 0) {
        continue;
      }
      const translated = translateWorkspaceAliasPath(value, root);
      if (translated !== value) {
        updateArg(key, translated);
      }
    }
  }

  const cwdValue = typeof nextArgs.cwd === "string"
    ? nextArgs.cwd.trim()
    : undefined;
  if (cwdValue) {
    const translatedCwd = translateWorkspaceAliasPath(cwdValue, root);
    if (translatedCwd !== cwdValue) {
      updateArg("cwd", translatedCwd);
    }
  }

  if (toolName !== "system.bash" && toolName !== "desktop.bash") {
    return nextArgs;
  }

  const commandValue = typeof nextArgs.command === "string"
    ? nextArgs.command
    : undefined;
  if (commandValue && !Array.isArray(nextArgs.args)) {
    const translatedCommand = rewriteWorkspaceAliasShellCommand(
      commandValue,
      root,
    );
    if (translatedCommand !== commandValue) {
      updateArg("command", translatedCommand);
    }
    return nextArgs;
  }

  if (commandValue) {
    const translatedCommand = translateWorkspaceAliasPath(commandValue, root);
    if (translatedCommand !== commandValue) {
      updateArg("command", translatedCommand);
    }
  }

  if (!Array.isArray(nextArgs.args)) {
    return nextArgs;
  }

  const pathArgs = new Set(
    extractDirectCommandPathArgs(nextArgs.command, nextArgs.args).map((value) =>
      value.trim()
    ),
  );
  if (pathArgs.size === 0) {
    return nextArgs;
  }

  let didRewriteArgs = false;
  const translatedArgs = nextArgs.args.map((value) => {
    if (typeof value !== "string") {
      return value;
    }
    const trimmed = value.trim();
    if (!pathArgs.has(trimmed)) {
      return value;
    }
    const translated = translateWorkspaceAliasPath(trimmed, root);
    if (translated === trimmed) {
      return value;
    }
    didRewriteArgs = true;
    return translated;
  });
  if (didRewriteArgs) {
    updateArg("args", translatedArgs);
  }

  return nextArgs;
}

function buildScopedRootViolationMessage(
  detail: string,
  scopedFilesystemRoot: string,
): string {
  return (
    `Delegated workspace root violation: ${detail}. ` +
    `Keep all filesystem paths under ${scopedFilesystemRoot}.`
  );
}

type ShellToken =
  | { type: "word"; value: string }
  | { type: "operator"; value: string };

function tokenizeShellCommand(command: string): readonly ShellToken[] {
  const tokens: ShellToken[] = [];
  let current = "";
  let index = 0;
  let state: "normal" | "single" | "double" = "normal";

  const pushCurrent = (): void => {
    if (current.length === 0) return;
    tokens.push({ type: "word", value: current });
    current = "";
  };

  const pushOperator = (value: string): void => {
    tokens.push({ type: "operator", value });
  };

  while (index < command.length) {
    const ch = command[index]!;
    if (state === "single") {
      if (ch === "'") {
        state = "normal";
      } else {
        current += ch;
      }
      index += 1;
      continue;
    }

    if (state === "double") {
      if (ch === '"') {
        state = "normal";
        index += 1;
        continue;
      }
      if (ch === "\\" && index + 1 < command.length) {
        const next = command[index + 1]!;
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          current += next;
          index += 2;
          continue;
        }
      }
      current += ch;
      index += 1;
      continue;
    }

    if (ch === "'") {
      state = "single";
      index += 1;
      continue;
    }
    if (ch === '"') {
      state = "double";
      index += 1;
      continue;
    }
    if (ch === "\\" && index + 1 < command.length) {
      current += command[index + 1]!;
      index += 2;
      continue;
    }
    if (ch === "\n") {
      pushCurrent();
      pushOperator("\n");
      index += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      pushCurrent();
      index += 1;
      continue;
    }

    if (ch === "|" || ch === "&" || ch === ";" || ch === "<" || ch === ">") {
      let operator = ch;
      if ((ch === "<" || ch === ">") && /^\d+$/.test(current)) {
        operator = `${current}${ch}`;
        current = "";
      } else {
        pushCurrent();
      }

      const next = command[index + 1];
      if (ch === "|" && next === "|") {
        operator += next;
        index += 1;
      } else if (ch === "&" && (next === "&" || next === ">")) {
        operator += next;
        index += 1;
        if (operator === "&>" && command[index + 1] === ">") {
          operator += ">";
          index += 1;
        }
      } else if ((ch === "<" || ch === ">") && (next === ch || next === "&")) {
        operator += next;
        index += 1;
      }

      pushOperator(operator);
      index += 1;
      continue;
    }

    current += ch;
    index += 1;
  }

  pushCurrent();
  return tokens;
}

function isShellCommandBoundaryOperator(value: string): boolean {
  return value === "|" || value === "||" || value === "&&" || value === ";" || value === "&" || value === "\n";
}

function isShellRedirectionOperator(value: string): boolean {
  return /^(?:\d+)?(?:>>?|<<?|<>|>&|&>|&>>|<&)$/.test(value);
}

function isShellVariableAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(value);
}

function extractAbsoluteShellPaths(command: string): readonly string[] {
  const matches: string[] = [];
  const seen = new Set<string>();
  const tokens = tokenizeShellCommand(command);
  let currentCommandName: string | undefined;
  let currentArgs: string[] = [];

  const pushPath = (value: string): void => {
    const trimmed = value.trim();
    if (!ABSOLUTE_PATH_ARG_RE.test(trimmed)) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    matches.push(trimmed);
  };

  const flushCurrentCommand = (): void => {
    if (!currentCommandName) {
      currentArgs = [];
      return;
    }
    for (const arg of extractDirectCommandPathArgs(currentCommandName, currentArgs)) {
      pushPath(arg);
    }
    currentCommandName = undefined;
    currentArgs = [];
  };

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token.type === "operator") {
      if (isShellCommandBoundaryOperator(token.value)) {
        flushCurrentCommand();
        continue;
      }
      if (isShellRedirectionOperator(token.value)) {
        const next = tokens[index + 1];
        if (next?.type === "word") {
          pushPath(next.value);
          index += 1;
        }
      }
      continue;
    }

    const value = token.value.trim();
    if (value.length === 0) continue;
    if (!currentCommandName) {
      if (isShellVariableAssignment(value)) {
        continue;
      }
      currentCommandName = value;
      continue;
    }
    currentArgs.push(value);
  }

  flushCurrentCommand();
  return matches;
}

function extractAbsoluteArgs(args: readonly unknown[]): string[] {
  return args
    .filter((arg): arg is string =>
      typeof arg === "string" && ABSOLUTE_PATH_ARG_RE.test(arg.trim())
    )
    .map((arg) => arg.trim());
}

function extractAbsoluteNonOptionArgs(
  args: readonly unknown[],
  optionValueFlags: ReadonlySet<string> = new Set(),
): string[] {
  const matches: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (typeof arg !== "string") continue;
    const trimmed = arg.trim();
    if (trimmed.length === 0) continue;
    if (optionValueFlags.has(trimmed)) {
      index++;
      continue;
    }
    if (trimmed.startsWith("-")) {
      continue;
    }
    if (ABSOLUTE_PATH_ARG_RE.test(trimmed)) {
      matches.push(trimmed);
    }
  }
  return matches;
}

function extractSedPathArgs(args: readonly unknown[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (typeof arg !== "string") {
      index++;
      continue;
    }
    const trimmed = arg.trim();
    if (trimmed.length === 0) {
      index++;
      continue;
    }
    if (SED_OPTION_VALUE_FLAGS.has(trimmed)) {
      index += 2;
      continue;
    }
    if (trimmed.startsWith("-")) {
      index++;
      continue;
    }
    index++;
    break;
  }
  return extractAbsoluteArgs(args.slice(index));
}

function extractGrepPathArgs(args: readonly unknown[]): string[] {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (typeof arg !== "string") {
      index++;
      continue;
    }
    const trimmed = arg.trim();
    if (trimmed.length === 0) {
      index++;
      continue;
    }
    if (GREP_OPTION_VALUE_FLAGS.has(trimmed)) {
      index += 2;
      continue;
    }
    if (trimmed.startsWith("-")) {
      index++;
      continue;
    }
    index++;
    break;
  }
  return extractAbsoluteArgs(args.slice(index));
}

function extractDirectCommandPathArgs(
  command: unknown,
  args: readonly unknown[],
): string[] {
  const commandName = typeof command === "string"
    ? command.trim().replace(/^.*[\\/]/, "").toLowerCase()
    : "";
  switch (commandName) {
    case "sed":
      return extractSedPathArgs(args);
    case "grep":
      return extractGrepPathArgs(args);
    case "head":
    case "tail":
      return extractAbsoluteNonOptionArgs(args, HEAD_TAIL_OPTION_VALUE_FLAGS);
    case "ls":
    case "cat":
    case "wc":
    case "mkdir":
    case "rm":
    case "mv":
    case "cp":
    case "touch":
    case "install":
    case "find":
      return extractAbsoluteNonOptionArgs(args);
    default:
      return extractAbsoluteArgs(args);
  }
}

function validateScopedFilesystemRoot(
  toolName: string,
  args: Record<string, unknown>,
  scopedFilesystemRoot?: string,
): string | undefined {
  const root = scopedFilesystemRoot?.trim();
  if (!root) return undefined;
  const normalizedRoot = normalizeScopedRootPath(root);

  const pathArgKeys = TOOL_PATH_ARG_KEYS[toolName];
  if (pathArgKeys) {
    for (const key of pathArgKeys) {
      const value = args[key];
      if (typeof value !== "string" || value.trim().length === 0) continue;
      const candidatePath = normalizeScopedPathCandidate(value);
      if (!isWithinRoot(normalizedRoot, candidatePath)) {
        return buildScopedRootViolationMessage(
          `${key} must stay under the delegated workspace root`,
          normalizedRoot,
        );
      }
    }
  }

  if (ROOT_SCOPED_COMMAND_TOOLS.has(toolName)) {
    const cwdValue = typeof args.cwd === "string" ? args.cwd.trim() : undefined;
    if (cwdValue) {
      const candidateCwd = normalizeScopedPathCandidate(cwdValue);
      if (
        !isWithinRoot(normalizedRoot, candidateCwd) &&
        !allowsMissingRootBootstrapCwd(
          toolName,
          args,
          normalizedRoot,
          candidateCwd,
        )
      ) {
        return buildScopedRootViolationMessage(
          "cwd must stay under the delegated workspace root",
          normalizedRoot,
        );
      }
    }
  }

  if (
    (toolName === "system.bash" || toolName === "desktop.bash") &&
    Array.isArray(args.args)
  ) {
    for (const arg of extractDirectCommandPathArgs(args.command, args.args)) {
      const candidatePath = normalizeScopedPathCandidate(arg);
      if (!isWithinRoot(normalizedRoot, candidatePath)) {
        return buildScopedRootViolationMessage(
          "command arguments reference a path outside the delegated workspace root",
          normalizedRoot,
        );
      }
    }
  }

  if (
    (toolName === "system.bash" || toolName === "desktop.bash") &&
    !Array.isArray(args.args) &&
    typeof args.command === "string"
  ) {
    for (const pathValue of extractAbsoluteShellPaths(args.command)) {
      const candidatePath = normalizeScopedPathCandidate(pathValue);
      if (!isWithinRoot(normalizedRoot, candidatePath)) {
        return buildScopedRootViolationMessage(
          "shell mode command references a path outside the delegated workspace root",
          normalizedRoot,
        );
      }
    }
  }

  return undefined;
}

function allowsMissingRootBootstrapCwd(
  toolName: string,
  args: Record<string, unknown>,
  normalizedRoot: string,
  candidateCwd: string,
): boolean {
  if (pathExists(normalizedRoot)) {
    return false;
  }
  if (isWithinRoot(normalizedRoot, candidateCwd)) {
    return false;
  }
  return referencesAbsolutePathWithinRoot(toolName, args, normalizedRoot);
}

function isDoomTool(name: string): boolean {
  return name.startsWith(DOOM_TOOL_PREFIX);
}

function canonicalizeToolFailureResult(
  toolName: string,
  result: string,
): string {
  if (!isDoomTool(toolName) || !didToolCallFail(false, result)) {
    return result;
  }

  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return result;
    }
  } catch {
    // Wrap known Doom plain-text failures below.
  }

  const trimmed = result.trim();
  return JSON.stringify({
    error: trimmed.length > 0 ? trimmed : `Tool "${toolName}" failed`,
  });
}

function normalizeDesktopBashCommand(
  name: string,
  args: Record<string, unknown>,
): string | undefined {
  if (name !== 'desktop.bash') return undefined;
  const command =
    typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return undefined;
  if (!DESKTOP_GUI_LAUNCH_RE.test(command)) return undefined;
  if (DESKTOP_TERMINAL_LAUNCH_RE.test(command)) return '__gui_terminal__';
  if (DESKTOP_BROWSER_LAUNCH_RE.test(command)) {
    // Browser launches can differ materially by URL/flags; only dedupe exact
    // normalized command strings so recovery launches are not skipped.
    return `__gui_browser__:${command
      .replace(COLLAPSE_WHITESPACE_RE, ' ')
      .toLowerCase()}`;
  }
  if (DESKTOP_FILE_MANAGER_LAUNCH_RE.test(command)) return '__gui_file_manager__';
  if (DESKTOP_EDITOR_LAUNCH_RE.test(command)) return '__gui_editor__';
  return command.replace(COLLAPSE_WHITESPACE_RE, ' ').toLowerCase();
}

function shouldMarkGuiLaunchSeen(result: string): boolean {
  try {
    const parsed = JSON.parse(result) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return false;
    }
    const payload = parsed as { error?: unknown; exitCode?: unknown };
    if (typeof payload.error === 'string' && payload.error.trim().length > 0) {
      return false;
    }
    if (typeof payload.exitCode === 'number' && payload.exitCode !== 0) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function toErrorString(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 3) return value.slice(0, Math.max(0, maxChars));
  return value.slice(0, maxChars - 3) + "...";
}

type DelegationContext = NonNullable<
  ReturnType<NonNullable<DelegationToolCompositionResolver>>
>;
type DelegationSubAgentInfo = ReturnType<
  NonNullable<DelegationContext["subAgentManager"]>["getInfo"]
>;
type DelegationLifecycleEmitter = DelegationContext["lifecycleEmitter"];

function sendDeniedToolResult(params: {
  send: (msg: ControlResponse) => void;
  toolName: string;
  result: string;
  toolCallId: string;
  sessionId: string;
  isSubAgentSession: boolean;
}): void {
  const { send, toolName, result, toolCallId, sessionId, isSubAgentSession } =
    params;
  send({
    type: "tools.result",
    payload: {
      toolName,
      result,
      durationMs: 0,
      isError: true,
      toolCallId,
      ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
    },
  });
}

function buildApprovalMessage(params: {
  ruleDescription?: string;
  toolName: string;
  sessionId: string;
  isSubAgentSession: boolean;
  subAgentInfo: DelegationSubAgentInfo | null;
}): string {
  const {
    ruleDescription,
    toolName,
    sessionId,
    isSubAgentSession,
    subAgentInfo,
  } = params;
  const baseMessage = ruleDescription ?? `Approval required for ${toolName}`;
  if (!isSubAgentSession || !subAgentInfo) return baseMessage;
  const taskPreview = truncateText(
    subAgentInfo.task.trim(),
    APPROVAL_TASK_PREVIEW_MAX_CHARS,
  );
  return (
    `${baseMessage}\n` +
    `Parent session: ${subAgentInfo.parentSessionId}\n` +
    `Sub-agent session: ${sessionId}\n` +
    `Delegated task: ${taskPreview}`
  );
}

function sendImmediateToolError(params: {
  send: (msg: ControlResponse) => void;
  toolName: string;
  result: string;
  toolCallId: string;
  sessionId: string;
  isSubAgentSession: boolean;
  onToolEnd: SessionToolHandlerConfig["onToolEnd"];
  hooks?: HookDispatcher;
  args: Record<string, unknown>;
  hookMetadata?: Record<string, unknown>;
}): string {
  const {
    send,
    toolName,
    result,
    toolCallId,
    sessionId,
    isSubAgentSession,
    onToolEnd,
    hooks,
    args,
    hookMetadata,
  } = params;
  sendDeniedToolResult({
    send,
    toolName,
    result,
    toolCallId,
    sessionId,
    isSubAgentSession,
  });
  if (hooks) {
    void hooks.dispatch("tool:after", {
      sessionId,
      toolName,
      args,
      result,
      durationMs: 0,
      toolCallId,
      ...(hookMetadata ? { ...hookMetadata } : {}),
    });
  }
  onToolEnd?.(toolName, result, 0, toolCallId);
  return result;
}

async function runApprovalGate(params: {
  approvalEngine: ApprovalEngine | undefined;
  name: string;
  args: Record<string, unknown>;
  sessionId: string;
  parentSessionId: string | undefined;
  isSubAgentSession: boolean;
  subAgentInfo: DelegationSubAgentInfo | null;
  lifecycleEmitter: DelegationLifecycleEmitter;
  send: (msg: ControlResponse) => void;
  onToolEnd: SessionToolHandlerConfig["onToolEnd"];
  toolCallId: string;
}): Promise<string | null> {
  const {
    approvalEngine,
    name,
    args,
    sessionId,
    parentSessionId,
    isSubAgentSession,
    subAgentInfo,
    lifecycleEmitter,
    send,
    onToolEnd,
    toolCallId,
  } = params;
  if (!approvalEngine) {
    return null;
  }

  const rule = approvalEngine.requiresApproval(name, args);
  if (!rule || approvalEngine.isToolElevated(sessionId, name)) {
    return null;
  }

  if (approvalEngine.isToolDenied(sessionId, name, parentSessionId)) {
    const err = JSON.stringify({
      error:
        `Tool "${name}" blocked because this action was denied earlier in the request tree`,
    });
    sendDeniedToolResult({
      send,
      toolName: name,
      result: err,
      toolCallId,
      sessionId,
      isSubAgentSession,
    });
    if (isSubAgentSession && lifecycleEmitter) {
      lifecycleEmitter.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        ...(parentSessionId ? { parentSessionId } : {}),
        toolName: name,
        payload: {
          stage: "approval",
          reason: "denied_previously",
          toolCallId,
        },
      });
    }
    onToolEnd?.(name, err, 0, toolCallId);
    return err;
  }

  const approvalMessage = buildApprovalMessage({
    ruleDescription: rule.description,
    toolName: name,
    sessionId,
    isSubAgentSession,
    subAgentInfo,
  });
  const request = approvalEngine.createRequest(
    name,
    args,
    sessionId,
    approvalMessage,
    rule,
    {
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
    },
  );
  send({
    type: "approval.request",
    payload: {
      requestId: request.id,
      action: name,
      details: args,
      message: request.message,
      deadlineAt: request.deadlineAt,
      ...(request.slaMs !== undefined ? { slaMs: request.slaMs } : {}),
      ...(request.escalateAt !== undefined
        ? { escalateAt: request.escalateAt }
        : {}),
      allowDelegatedResolution: request.allowDelegatedResolution,
      ...(request.approverGroup
        ? { approverGroup: request.approverGroup }
        : {}),
      ...(request.requiredApproverRoles &&
      request.requiredApproverRoles.length > 0
        ? { requiredApproverRoles: request.requiredApproverRoles }
        : {}),
      ...(request.parentSessionId
        ? { parentSessionId: request.parentSessionId }
        : {}),
      ...(request.subagentSessionId
        ? { subagentSessionId: request.subagentSessionId }
        : {}),
    },
  });

  const response = await approvalEngine.requestApproval(request);
  if (response.disposition === "no") {
    const err = JSON.stringify({ error: `Tool "${name}" denied by user` });
    sendDeniedToolResult({
      send,
      toolName: name,
      result: err,
      toolCallId,
      sessionId,
      isSubAgentSession,
    });
    if (isSubAgentSession && lifecycleEmitter) {
      lifecycleEmitter.emit({
        type: "subagents.failed",
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        toolName: name,
        payload: {
          stage: "approval",
          reason: "denied",
          toolCallId,
        },
      });
    }
    onToolEnd?.(name, err, 0, toolCallId);
    return err;
  }

  if (response.disposition === "always") {
    approvalEngine.elevate(sessionId, name);
  }
  return null;
}

// ============================================================================
// Config
// ============================================================================

export interface SessionToolHandlerConfig {
  /** Session ID for hook context and approval scoping. */
  sessionId: string;
  /** Base tool handler (from ToolRegistry). */
  baseHandler: ToolHandler;
  /** Optional factory that returns a desktop-aware handler per router ID. */
  desktopRouterFactory?: (
    routerId: string,
    allowedToolNames?: readonly string[],
  ) => ToolHandler;
  /** ID used for desktop routing (clientId for voice, sessionId for daemon). */
  routerId: string;
  /** Send a message to the connected client. */
  send: (msg: ControlResponse) => void;
  /** Hook dispatcher for tool:before/after lifecycle. */
  hooks?: HookDispatcher;
  /** Approval engine for tool gating. */
  approvalEngine?: ApprovalEngine;
  /** Called when tool execution starts (before hooks). */
  onToolStart?: (
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string,
  ) => void;
  /** Called when tool execution finishes (after hooks). */
  onToolEnd?: (
    toolName: string,
    result: string,
    durationMs: number,
    toolCallId: string,
  ) => void;
  /** Optional resolver for live delegation runtime dependencies. */
  delegation?: DelegationToolCompositionResolver;
  /** Tool names visible to this session for child delegation scoping. */
  availableToolNames?: readonly string[];
  /** Optional working directory used to rebase relative delegated tool args. */
  defaultWorkingDirectory?: string;
  /** Optional host workspace root used to translate logical /workspace aliases. */
  workspaceAliasRoot?: string;
  /** Optional delegated workspace root. Absolute/tilde path escapes are rejected when set. */
  scopedFilesystemRoot?: string;
  /** Extra metadata attached to tool hook payloads for this handler. */
  hookMetadata?: Record<string, unknown>;
  /** Optional session credential broker for structured secret injection. */
  credentialBroker?: SessionCredentialBroker;
  /** Optional callback resolving the policy scope for this session. */
  resolvePolicyScope?: () => PolicyEvaluationScope | undefined;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a session-scoped tool handler that integrates hooks, approval gating,
 * desktop routing, and WebSocket notifications.
 *
 * Flow:
 * 1. `tool:before` hook — if blocked, return error (NO WS messages sent)
 * 2. `onToolStart` callback
 * 3. Send `tools.executing` to client
 * 4. Approval gate — if denied, send `tools.result` (isError), call `onToolEnd`, return
 * 5. Select handler via desktop router or base handler
 * 6. Execute and time it
 * 7. Send `tools.result` to client
 * 8. `tool:after` hook
 * 9. `onToolEnd` callback
 */
export function createSessionToolHandler(config: SessionToolHandlerConfig): ToolHandler {
  const {
    sessionId,
    baseHandler,
    desktopRouterFactory,
    routerId,
    send,
    hooks,
    approvalEngine,
    onToolStart,
    onToolEnd,
    delegation,
    availableToolNames,
    hookMetadata,
    credentialBroker,
    resolvePolicyScope,
  } = config;
  let toolCallSeq = 0;
  // Per-message duplicate guard to avoid opening the same GUI app twice when
  // the model emits repeated desktop.bash launch calls in one turn.
  const seenGuiLaunches = new Set<string>();
  const nextToolCallId = (): string =>
    `tool-${Date.now().toString(36)}-${++toolCallSeq}`;

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const toolName = normalizeToolName(name);
    const workspaceAliasRoot =
      config.workspaceAliasRoot ??
      config.scopedFilesystemRoot ??
      config.defaultWorkingDirectory;
    const {
      args: normalizedArgs,
      missingDefaultWorkingDirectory,
    } = applyDefaultWorkingDirectory(
      toolName,
      applyWorkspaceAliasTranslation(
        toolName,
        normalizeToolCallArguments(toolName, args),
        workspaceAliasRoot,
      ),
      config.defaultWorkingDirectory,
    );
    if (
      missingDefaultWorkingDirectory &&
      !missingDefaultWorkingDirectory.bootstrapPermitted
    ) {
      return JSON.stringify({
        error: buildMissingDefaultWorkingDirectoryError(
          missingDefaultWorkingDirectory.path,
          false,
        ),
      });
    }
    const scopedRootViolation = validateScopedFilesystemRoot(
      toolName,
      normalizedArgs,
      config.scopedFilesystemRoot,
    );
    if (scopedRootViolation) {
      return JSON.stringify({ error: scopedRootViolation });
    }
    const delegationContext = delegation?.();
    const subAgentManager = delegationContext?.subAgentManager ?? null;
    const policyEngine = delegationContext?.policyEngine ?? null;
    const verifier = delegationContext?.verifier ?? null;
    const lifecycleEmitter = delegationContext?.lifecycleEmitter ?? null;
    const unsafeBenchmarkMode = delegationContext?.unsafeBenchmarkMode === true;
    const isSubAgentSession = isSubAgentSessionId(sessionId);
    const subAgentInfo = isSubAgentSession
      ? subAgentManager?.getInfo(sessionId) ?? null
      : null;
    const parentSessionId = subAgentInfo?.parentSessionId;
    const policyScope = resolvePolicyScope?.();
    const credentialPreparation = credentialBroker?.prepare({
      sessionId,
      toolName,
      args: normalizedArgs,
      scope: policyScope,
    });
    if (credentialPreparation && !credentialPreparation.ok) {
      return JSON.stringify({ error: credentialPreparation.error });
    }
    const credentialPrepared = credentialPreparation?.prepared;
    const enrichedHookMetadata = {
      ...(hookMetadata ? { ...hookMetadata } : {}),
      ...(credentialPrepared
        ? { credentialPreview: credentialPrepared.preview }
        : {}),
    };

    const launchKey = normalizeDesktopBashCommand(toolName, args);
    if (launchKey) {
      if (seenGuiLaunches.has(launchKey)) {
        return JSON.stringify({
          stdout: '',
          stderr: '',
          exitCode: 0,
          backgrounded: true,
          skippedDuplicate: true,
        });
      }
    }

    const toolCallId = nextToolCallId();

    if (
      lifecycleEmitter &&
      policyEngine &&
      !isSubAgentSession &&
      policyEngine.isDelegationTool(toolName)
    ) {
      lifecycleEmitter.emit({
        type: 'subagents.planned',
        timestamp: Date.now(),
        sessionId,
        toolName: name,
        payload: {
          decisionThreshold: policyEngine.snapshot().spawnDecisionThreshold,
        },
      });
    }

    if (policyEngine) {
      const decision = policyEngine.evaluate({
        sessionId,
        toolName,
        args: normalizedArgs,
        isSubAgentSession,
      });
      if (
        decision.matchedRule === "unsafe_benchmark_bypass" &&
        lifecycleEmitter &&
        policyEngine.isDelegationTool(toolName)
      ) {
        lifecycleEmitter.emit({
          type: "subagents.policy_bypassed",
          timestamp: Date.now(),
          sessionId,
          ...(parentSessionId ? { parentSessionId } : {}),
          ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
          toolName,
          payload: {
            stage: "policy",
            unsafeBenchmarkMode: true,
            matchedRule: decision.matchedRule,
            decisionThreshold: decision.threshold,
            isSubAgentSession,
          },
        });
      }
      if (!decision.allowed) {
        const err = JSON.stringify({
          error: decision.reason ?? `Tool "${toolName}" blocked by delegation policy`,
        });
        if (isSubAgentSession && lifecycleEmitter) {
          lifecycleEmitter.emit({
            type: 'subagents.failed',
            timestamp: Date.now(),
            sessionId,
            subagentSessionId: sessionId,
            toolName,
            payload: {
              stage: 'policy',
              reason: decision.reason,
            },
          });
        }
        return err;
      }
    }

    // 1. Hook: tool:before (policy gate, progress tracking, etc.)
    if (hooks) {
      const beforeResult = await hooks.dispatch('tool:before', {
        sessionId,
        toolName,
        args: normalizedArgs,
        ...(enrichedHookMetadata ? { ...enrichedHookMetadata } : {}),
      });
      if (!beforeResult.completed) {
        // Bug fix: do NOT send tools.executing when hook blocks — the tool
        // never started executing, so the client shouldn't show a tool card.
        const hookReason =
          typeof beforeResult.payload.reason === "string" &&
          beforeResult.payload.reason.trim().length > 0
            ? beforeResult.payload.reason.trim()
            : `Tool "${toolName}" blocked by hook`;
        if (isSubAgentSession && lifecycleEmitter) {
          lifecycleEmitter.emit({
            type: 'subagents.failed',
            timestamp: Date.now(),
            sessionId,
            subagentSessionId: sessionId,
            toolName,
            payload: { stage: 'hook_before', reason: hookReason },
          });
        }
        return JSON.stringify({ error: hookReason });
      }
    }

    // 2. Notify caller: tool execution starting
    onToolStart?.(toolName, normalizedArgs, toolCallId);

    if (isSubAgentSession && lifecycleEmitter) {
      lifecycleEmitter.emit({
        type: 'subagents.tool.executing',
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        toolName,
        payload: { args: normalizedArgs, toolCallId },
      });
    }

    // 3. Send tools.executing to client
    send({
      type: 'tools.executing',
      payload: {
        toolName,
        args: normalizedArgs,
        toolCallId,
        ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
      },
    });

    // 4. Approval gate
    const approvalError = await runApprovalGate({
      approvalEngine,
      name: toolName,
      args: normalizedArgs,
      sessionId,
      parentSessionId,
      isSubAgentSession,
      subAgentInfo,
      lifecycleEmitter,
      send,
      onToolEnd,
      toolCallId,
    });
    if (approvalError) {
      return approvalError;
    }

    let executionArgs = normalizedArgs;
    if (credentialBroker && credentialPrepared) {
      const injectionResult = credentialBroker.inject({
        prepared: credentialPrepared,
        args: normalizedArgs,
        scope: policyScope,
      });
      if (!injectionResult.ok) {
        return sendImmediateToolError({
          send,
          toolName,
          result: JSON.stringify({ error: injectionResult.error }),
          toolCallId,
          sessionId,
          isSubAgentSession,
          onToolEnd,
          hooks,
          args: normalizedArgs,
          hookMetadata: enrichedHookMetadata,
        });
      }
      executionArgs = injectionResult.args;
    }

    // 5. Select handler: delegation executor or desktop-aware/base handler
    const routedHandler = desktopRouterFactory
      ? desktopRouterFactory(routerId, availableToolNames)
      : baseHandler;
    const activeHandler: ToolHandler = toolName === EXECUTE_WITH_AGENT_TOOL_NAME
      ? async (_toolName, toolArgs) =>
        executeDelegationTool({
          toolArgs,
          name: toolName,
          sessionId,
          toolCallId,
          subAgentManager,
          lifecycleEmitter,
          verifier,
          availableToolNames,
          defaultWorkingDirectory: config.defaultWorkingDirectory,
          unsafeBenchmarkMode,
        })
      : routedHandler;

    // 6. Execute and time
    const start = Date.now();
    let result: string;
    try {
      result = await activeHandler(toolName, executionArgs);
    } catch (error) {
      if (isSubAgentSession && lifecycleEmitter) {
        lifecycleEmitter.emit({
          type: 'subagents.failed',
          timestamp: Date.now(),
          sessionId,
          subagentSessionId: sessionId,
          toolName,
          payload: {
            stage: 'execution',
            error: toErrorString(error),
            toolCallId,
          },
        });
      }
      throw error;
    }
    const durationMs = Date.now() - start;
    result = canonicalizeToolFailureResult(toolName, result);

    if (launchKey && shouldMarkGuiLaunchSeen(result)) {
      seenGuiLaunches.add(launchKey);
    }

    // 7. Send tools.result to client
    send({
      type: 'tools.result',
      payload: {
        toolName,
        result,
        durationMs,
        toolCallId,
        ...(isSubAgentSession ? { subagentSessionId: sessionId } : {}),
      },
    });

    if (isSubAgentSession && lifecycleEmitter) {
      lifecycleEmitter.emit({
        type: 'subagents.tool.result',
        timestamp: Date.now(),
        sessionId,
        subagentSessionId: sessionId,
        toolName,
        payload: {
          result,
          durationMs,
          toolCallId,
          verifyRequested: verifier?.shouldVerifySubAgentResult() ?? false,
        },
      });
    }

    // 8. Hook: tool:after (progress tracking)
    if (hooks) {
      await hooks.dispatch('tool:after', {
        sessionId,
        toolName,
        args: normalizedArgs,
        result,
        durationMs,
        toolCallId,
        ...(enrichedHookMetadata ? { ...enrichedHookMetadata } : {}),
      });
    }

    // 9. Notify caller: tool execution finished
    onToolEnd?.(toolName, result, durationMs, toolCallId);

    return result;
  };
}
