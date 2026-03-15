import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type {
  ChatExecuteParams,
  ChatExecutorResult,
  ToolCallRecord,
} from "../llm/chat-executor.js";
import { didToolCallFail } from "../llm/chat-executor-tool-utils.js";
import { createGatewayMessage } from "./message.js";

export const INIT_GUIDE_FILENAME = "AGENC.md";
export const INIT_ROUTED_TOOL_NAMES = [
  "system.listDir",
  "system.readFile",
  "system.stat",
  "system.bash",
  "system.writeFile",
  "execute_with_agent",
] as const;

const DEFAULT_MIN_DELEGATED_INVESTIGATIONS = 1;
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_MAX_TOOL_ROUNDS = 30;
const REQUIRED_SECTION_HEADINGS = [
  "## Project Structure & Module Organization",
  "## Build, Test, and Development Commands",
  "## Coding Style & Naming Conventions",
  "## Testing Guidelines",
  "## Commit & Pull Request Guidelines",
] as const;

export interface InitChatExecutor {
  execute(params: ChatExecuteParams): Promise<ChatExecutorResult>;
}

export interface ModelBackedProjectGuideParams {
  readonly workspaceRoot: string;
  readonly systemPrompt: string;
  readonly chatExecutor: InitChatExecutor;
  readonly toolHandler: ChatExecuteParams["toolHandler"];
  readonly sessionId: string;
  readonly force?: boolean;
  readonly maxAttempts?: number;
  readonly maxToolRounds?: number;
  readonly minimumDelegatedInvestigations?: number;
}

export interface ModelBackedProjectGuideResult {
  readonly status: "created" | "updated" | "skipped";
  readonly filePath: string;
  readonly content: string;
  readonly attempts: number;
  readonly delegatedInvestigations: number;
  readonly result: ChatExecutorResult | null;
}

export function resolveInitGuidePath(workspaceRoot: string): string {
  return join(resolvePath(workspaceRoot), INIT_GUIDE_FILENAME);
}

export function validateInitGuideContent(content: string): string | null {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return "AGENC.md was empty";
  }
  if (!trimmed.startsWith("# Repository Guidelines")) {
    return 'AGENC.md must start with "# Repository Guidelines"';
  }
  for (const heading of REQUIRED_SECTION_HEADINGS) {
    if (!trimmed.includes(heading)) {
      return `AGENC.md is missing required section "${heading}"`;
    }
  }
  return null;
}

export function buildModelBackedInitPrompt(params: {
  readonly workspaceRoot: string;
  readonly filePath: string;
  readonly force: boolean;
  readonly minimumDelegatedInvestigations: number;
  readonly retryReason?: string;
}): string {
  const retryInstruction =
    typeof params.retryReason === "string" && params.retryReason.trim().length > 0
      ? `\nPrevious attempt failed validation: ${params.retryReason.trim()}\nRetry from scratch and fix that exact problem.`
      : "";
  const overwriteInstruction = params.force
    ? "Overwrite the existing AGENC.md if it already exists."
    : "Create AGENC.md if it does not already exist.";

  return [
    `Generate ${params.filePath} for the repository at ${params.workspaceRoot}.`,
    overwriteInstruction,
    "",
    "Steps:",
    `1. Run system.listDir on ${params.workspaceRoot} to see what's there.`,
    "2. Read the files that actually exist — package.json, Cargo.toml, Makefile, CMakeLists.txt, any README, any config files. Do NOT guess filenames — only read what listDir showed you.",
    "3. If you need more detail, list subdirectories and read their contents.",
    `4. Write the guide to ${params.filePath} with system.writeFile.`,
    "",
    "The document must:",
    '- Start with "# Repository Guidelines".',
    `- Include these section headings:\n  ${REQUIRED_SECTION_HEADINGS.join("\n  ")}`,
    "- Be concise and specific to what you actually found in the repo.",
    "",
    "Do NOT try to read files that don't exist. Do NOT guess. List first, then read.",
    "Do NOT over-explore. List the root, read 3-5 key files, then WRITE the guide. Do not list every subdirectory.",
    `You MUST call system.writeFile to create ${params.filePath} before finishing. This is not optional. Even if the repo is small or has few files, write the guide based on what you found.`,
    retryInstruction,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readFileIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return null;
  }
}

function countDelegatedInvestigations(
  toolCalls: readonly ToolCallRecord[],
): number {
  return toolCalls.filter(
    (toolCall) =>
      toolCall.name === "execute_with_agent" &&
      !didToolCallFail(toolCall.isError, toolCall.result),
  ).length;
}

function countDiscoveryCalls(toolCalls: readonly ToolCallRecord[]): number {
  return toolCalls.filter(
    (toolCall) =>
      (toolCall.name === "system.listDir" ||
        toolCall.name === "system.readFile" ||
        toolCall.name === "system.stat" ||
        toolCall.name === "system.bash") &&
      !didToolCallFail(toolCall.isError, toolCall.result),
  ).length;
}

function buildValidationFailureReason(params: {
  readonly content: string | null;
  readonly delegatedInvestigations: number;
  readonly discoveryCalls: number;
  readonly minimumDelegatedInvestigations: number;
}): string | null {
  if (params.discoveryCalls < 2) {
    return `expected at least 2 discovery calls (listDir/readFile) but saw ${params.discoveryCalls}`;
  }
  if (params.content === null) {
    return "AGENC.md was not written";
  }
  return validateInitGuideContent(params.content);
}

export async function runModelBackedProjectGuide(
  params: ModelBackedProjectGuideParams,
): Promise<ModelBackedProjectGuideResult> {
  const workspaceRoot = resolvePath(params.workspaceRoot);
  const filePath = resolveInitGuidePath(workspaceRoot);
  const force = params.force === true;
  const minimumDelegatedInvestigations =
    params.minimumDelegatedInvestigations ??
    DEFAULT_MIN_DELEGATED_INVESTIGATIONS;
  const maxAttempts = Math.max(1, params.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const maxToolRounds = Math.max(
    1,
    params.maxToolRounds ?? DEFAULT_MAX_TOOL_ROUNDS,
  );
  const existedBefore = await fileExists(filePath);

  if (existedBefore && !force) {
    const existingContent = (await readFileIfExists(filePath)) ?? "";
    return {
      status: "skipped",
      filePath,
      content: existingContent,
      attempts: 0,
      delegatedInvestigations: 0,
      result: null,
    };
  }

  let lastFailureReason = "";
  let lastDelegatedInvestigations = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const message = createGatewayMessage({
      channel: "system",
      senderId: "agenc-init",
      senderName: "AgenC Init",
      sessionId: params.sessionId,
      scope: "dm",
      metadata: { workspaceRoot, purpose: "init" },
      content: buildModelBackedInitPrompt({
        workspaceRoot,
        filePath,
        force,
        minimumDelegatedInvestigations,
        ...(lastFailureReason.length > 0
          ? { retryReason: lastFailureReason }
          : {}),
      }),
    });

    const result = await params.chatExecutor.execute({
      message,
      history: [],
      systemPrompt: params.systemPrompt,
      sessionId: params.sessionId,
      toolHandler: params.toolHandler,
      maxToolRounds,
      requiredToolEvidence: { maxCorrectionAttempts: 1 },
      toolRouting: {
        routedToolNames: [...INIT_ROUTED_TOOL_NAMES],
        expandedToolNames: [...INIT_ROUTED_TOOL_NAMES],
        expandOnMiss: false,
      },
    });

    lastDelegatedInvestigations = countDelegatedInvestigations(result.toolCalls);
    const discoveryCalls = countDiscoveryCalls(result.toolCalls);
    const currentContent = await readFileIfExists(filePath);
    const failureReason = buildValidationFailureReason({
      content: currentContent,
      delegatedInvestigations: lastDelegatedInvestigations,
      discoveryCalls,
      minimumDelegatedInvestigations,
    });
    if (!failureReason) {
      return {
        status: existedBefore ? "updated" : "created",
        filePath,
        content: currentContent ?? "",
        attempts: attempt,
        delegatedInvestigations: lastDelegatedInvestigations,
        result,
      };
    }
    lastFailureReason = failureReason;
  }

  throw new Error(
    `Model-backed init failed validation for ${filePath}: ${lastFailureReason}`,
  );
}
