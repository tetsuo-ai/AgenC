import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { ToolHandler } from "../llm/types.js";
import { extractToolFailureText } from "../llm/chat-executor-tool-utils.js";
import { parseDirectCommandLine } from "../tools/system/command-line.js";
import {
  buildNativeActorResult,
  executeNativeToolCall,
} from "./run-domain-native-tools.js";
import type {
  AgentRunContract,
  AgentRunDomain,
  AgentRunWakeReason,
} from "./agent-run-contract.js";
import type {
  BackgroundRunApprovalState,
  BackgroundRunBlockerState,
  BackgroundRunCarryForwardState,
  BackgroundRunObservedTarget,
  BackgroundRunSignal,
  BackgroundRunWatchRegistration,
} from "./background-run-store.js";

export type RunDomainVerifierState =
  | "success"
  | "blocked"
  | "needs_attention"
  | "safe_to_continue";

export interface RunDomainVerification {
  readonly state: RunDomainVerifierState;
  readonly summary: string;
  readonly userUpdate: string;
  readonly safeToContinue: boolean;
  readonly nextCheckMs?: number;
  readonly blockerCode?: BackgroundRunBlockerState["code"];
}

export interface RunDomainRetryPolicy {
  readonly fastFollowupMs: number;
  readonly idleNextCheckMs: number;
  readonly stableStepMs: number;
  readonly maxNextCheckMs: number;
  readonly heartbeatMinMs?: number;
  readonly heartbeatMaxMs?: number;
}

export interface RunDomainNativeCycleResult {
  readonly actorResult: ChatExecutorResult;
  readonly verification: RunDomainVerification;
}

export interface RunDomainRun {
  readonly id: string;
  readonly sessionId: string;
  readonly objective: string;
  readonly contract: AgentRunContract;
  readonly approvalState: BackgroundRunApprovalState;
  readonly blocker?: BackgroundRunBlockerState;
  readonly carryForward?: BackgroundRunCarryForwardState;
  readonly pendingSignals: BackgroundRunSignal[];
  readonly observedTargets: BackgroundRunObservedTarget[];
  readonly watchRegistrations: BackgroundRunWatchRegistration[];
  readonly lastUserUpdate?: string;
  lastToolEvidence?: string;
  lastVerifiedAt?: number;
}

export interface RunDomainExecutionContext {
  readonly now: number;
  readonly toolHandler: ToolHandler;
}

export interface RunDomain<T extends RunDomainRun = RunDomainRun> {
  readonly id: AgentRunDomain;
  matches(run: T): boolean;
  plannerContract(run: T): readonly string[];
  verifierContract(run: T): readonly string[];
  eventSubscriptions(run: T): readonly AgentRunWakeReason[];
  artifactContract(run: T): readonly string[];
  recoveryStrategy(run: T): string;
  summarizeStatus(run: T): string | undefined;
  retryPolicy?(run: T): RunDomainRetryPolicy | undefined;
  detectBlocker(run: T): RunDomainVerification | undefined;
  detectDeterministicVerification(run: T): RunDomainVerification | undefined;
  observeActorResult?(run: T, actorResult: ChatExecutorResult, now: number): void;
  executeNativeCycle?(
    run: T,
    context: RunDomainExecutionContext,
  ): Promise<RunDomainNativeCycleResult | undefined>;
}

const MAX_USER_UPDATE_CHARS = 240;
const MAX_TOOL_RESULT_PREVIEW_CHARS = 240;
const FINITE_COMPLETION_RE = /\b(completed?|finished?|done|saved|generated|exported|downloaded|uploaded|submitted|confirmed|deployed|ready|succeeded?)\b/i;
const BUILD_OR_TEST_COMMAND_RE =
  /\b(?:npm|pnpm|yarn|bun|npx|node|vitest|jest|pytest|cargo|go|ruff|eslint|tsc|turbo|make)\b/i;
const EXPLICIT_CODE_COMMAND_RE = /`([^`]+)`/g;
const QUOTED_WORKSPACE_COMMAND_RE =
  /\b(?:run|execute)\s+(?:"([^"]+)"|'([^']+)')/i;
const PLAIN_WORKSPACE_COMMAND_RE =
  /\b(?:run|execute)\s+([A-Za-z0-9_./:+%@=-]+(?:\s+[A-Za-z0-9_./:+%@=-]+)*)\s+(?:in|inside|from)\s+the\s+workspace\b/i;
const SIGNAL_PREFERRED_RETRY_POLICY: RunDomainRetryPolicy = {
  fastFollowupMs: 8_000,
  idleNextCheckMs: 15_000,
  stableStepMs: 15_000,
  maxNextCheckMs: 120_000,
  heartbeatMinMs: 15_000,
  heartbeatMaxMs: 30_000,
};
const WORKSPACE_RETRY_POLICY: RunDomainRetryPolicy = {
  fastFollowupMs: 4_000,
  idleNextCheckMs: 8_000,
  stableStepMs: 6_000,
  maxNextCheckMs: 60_000,
  heartbeatMinMs: 10_000,
  heartbeatMaxMs: 20_000,
};
const DESKTOP_GUI_RETRY_POLICY: RunDomainRetryPolicy = {
  fastFollowupMs: 4_000,
  idleNextCheckMs: 8_000,
  stableStepMs: 8_000,
  maxNextCheckMs: 60_000,
  heartbeatMinMs: 10_000,
  heartbeatMaxMs: 20_000,
};

interface ParsedDomainSignal {
  readonly signal: BackgroundRunSignal;
  readonly category?:
    | "browser"
    | "filesystem"
    | "health"
    | "mcp"
    | "managed_process"
    | "generic";
  readonly eventType?: string;
  readonly toolName?: string;
  readonly command?: string;
  readonly path?: string;
  readonly destination?: string;
  readonly artifactPath?: string;
  readonly url?: string;
  readonly title?: string;
  readonly state?: string;
  readonly status?: number;
  readonly jobId?: string;
  readonly serverName?: string;
  readonly source?: string;
  readonly error?: string;
  readonly failed: boolean;
}

function truncate(text: string, maxChars = MAX_USER_UPDATE_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function summarizeNativeToolCall(
  toolCall: ChatExecutorResult["toolCalls"][number],
): string {
  const result = truncate(toolCall.result, MAX_TOOL_RESULT_PREVIEW_CHARS);
  return `- ${toolCall.name} [${toolCall.isError ? "error" : "ok"}] ${result}`;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseSignal(signal: BackgroundRunSignal): ParsedDomainSignal {
  const data = asObject(signal.data);
  const category = asString(data?.category);
  const eventType = asString(data?.eventType);
  const toolName = asString(data?.toolName);
  const error = asString(data?.error);
  const state = asString(data?.state);
  const status = asNumber(data?.status);
  return {
    signal,
    category:
      category === "browser" ||
      category === "filesystem" ||
      category === "health" ||
      category === "mcp" ||
      category === "managed_process" ||
      category === "generic"
        ? category
        : undefined,
    eventType,
    toolName,
    command: asString(data?.command),
    path: asString(data?.path),
    destination: asString(data?.destination),
    artifactPath: asString(data?.artifactPath),
    url: asString(data?.url),
    title: asString(data?.title),
    state,
    status,
    jobId: asString(data?.jobId),
    serverName: asString(data?.serverName),
    source: asString(data?.source),
    error,
    failed:
      data?.failed === true ||
      Boolean(error) ||
      /failed|error/i.test(signal.content) ||
      state === "failed" ||
      state === "error" ||
      (typeof status === "number" && status >= 400),
  };
}

function criteriaCorpus(run: RunDomainRun): string {
  return [
    run.objective,
    ...run.contract.successCriteria,
    ...run.contract.completionCriteria,
    ...run.contract.blockedCriteria,
  ]
    .join(" ")
    .toLowerCase();
}

function allowsDeterministicCompletion(run: RunDomainRun): boolean {
  return run.contract.kind !== "until_stopped" && !run.contract.requiresUserStop;
}

function latestSignal(
  run: RunDomainRun,
  predicate: (signal: ParsedDomainSignal) => boolean,
): ParsedDomainSignal | undefined {
  return [...run.pendingSignals]
    .reverse()
    .map((signal) => parseSignal(signal))
    .find(predicate);
}

function verificationFromBlocker(
  blocker: BackgroundRunBlockerState,
): RunDomainVerification {
  return {
    state: blocker.requiresOperatorAction ? "needs_attention" : "blocked",
    summary: blocker.summary,
    userUpdate: truncate(blocker.summary),
    safeToContinue: false,
    blockerCode: blocker.code,
  };
}

function safeToContinueVerification(
  summary: string,
  userUpdate: string,
  nextCheckMs: number,
): RunDomainVerification {
  return {
    state: "safe_to_continue",
    summary,
    userUpdate: truncate(userUpdate),
    safeToContinue: true,
    nextCheckMs,
  };
}

function blockedVerification(
  summary: string,
  blockerCode: BackgroundRunBlockerState["code"],
): RunDomainVerification {
  return {
    state: "blocked",
    summary,
    userUpdate: truncate(summary),
    safeToContinue: false,
    blockerCode,
  };
}

function successVerification(summary: string): RunDomainVerification {
  return {
    state: "success",
    summary,
    userUpdate: truncate(summary),
    safeToContinue: false,
  };
}

function summarizeFromRun(run: RunDomainRun): string | undefined {
  return run.lastUserUpdate ?? run.carryForward?.summary ?? run.lastToolEvidence;
}

function detectSignalFailure(
  info: ParsedDomainSignal | undefined,
  blockerCode: BackgroundRunBlockerState["code"] = "tool_failure",
): RunDomainVerification | undefined {
  if (!info?.failed) {
    return undefined;
  }
  const summary =
    info.error ??
    info.signal.content ??
    `The latest ${info.category ?? "runtime"} event failed.`;
  return blockedVerification(summary, blockerCode);
}

function domainPlannerContract(domain: AgentRunDomain): readonly string[] {
  return [
    `Domain: ${domain}`,
    "The runtime verifier is authoritative over assistant narration.",
    "Preserve typed handles, artifact references, and wake-driven progress.",
  ];
}

function domainVerifierContract(
  domain: AgentRunDomain,
  detail: string,
): readonly string[] {
  return [
    `Domain: ${domain}`,
    detail,
    "Emit success, blocked, needs_attention, or safe_to_continue from evidence instead of prose alone.",
  ];
}

function commandLooksLikeBuildOrTest(command: string | undefined): boolean {
  return typeof command === "string" && BUILD_OR_TEST_COMMAND_RE.test(command);
}

function browserSignalMatches(info: ParsedDomainSignal): boolean {
  return (
    info.category === "browser" ||
    info.eventType?.startsWith("browser.") === true
  );
}

function desktopGuiSignalMatches(info: ParsedDomainSignal): boolean {
  return (
    info.toolName?.startsWith("desktop.") === true ||
    info.toolName?.startsWith("mcp.kitty.") === true ||
    info.eventType?.startsWith("desktop.") === true ||
    info.eventType?.startsWith("window.") === true ||
    info.eventType?.startsWith("application.") === true ||
    info.eventType?.startsWith("gui.") === true
  );
}

function workspaceSignalMatches(info: ParsedDomainSignal): boolean {
  return (
    info.category === "filesystem" ||
    info.toolName === "system.writeFile" ||
    info.toolName === "system.appendFile" ||
    info.toolName === "system.move" ||
    info.toolName === "system.readFile" ||
    info.toolName === "system.listDir" ||
    info.toolName === "system.bash" ||
    info.toolName === "desktop.bash" ||
    (typeof info.command === "string" && info.command.trim().length > 0) ||
    commandLooksLikeBuildOrTest(info.command)
  );
}

function researchSignalMatches(info: ParsedDomainSignal): boolean {
  return (
    browserSignalMatches(info) ||
    info.category === "mcp" ||
    info.category === "filesystem" ||
    info.signal.type === "webhook"
  );
}

function pipelineSignalMatches(info: ParsedDomainSignal): boolean {
  return (
    info.category === "health" ||
    info.category === "mcp" ||
    info.signal.type === "webhook" ||
    info.eventType?.startsWith("server.") === true ||
    info.eventType?.startsWith("socket.") === true ||
    info.eventType?.startsWith("pipeline.") === true
  );
}

function remoteMcpSignalMatches(info: ParsedDomainSignal): boolean {
  return (
    info.category === "mcp" ||
    info.eventType?.startsWith("mcp.") === true ||
    (info.signal.type === "webhook" &&
      typeof info.source === "string" &&
      info.source.toLowerCase().includes("mcp"))
  );
}

function browserCompletionSatisfied(
  run: RunDomainRun,
  info: ParsedDomainSignal,
): boolean {
  if (!allowsDeterministicCompletion(run)) {
    return false;
  }
  const corpus = criteriaCorpus(run);
  const downloadObjective =
    /\b(download|export|artifact|report|pdf|capture|screenshot)\b/.test(
      corpus,
    );
  const uploadObjective = /\b(upload|submit|send|attach)\b/.test(corpus);
  const navigationObjective =
    /\b(navigate|visit|open|reach|load|page|url)\b/.test(corpus) &&
    !downloadObjective &&
    !uploadObjective;
  if (
    (downloadObjective &&
      (
        info.signal.content.toLowerCase().includes("download completed") ||
        Boolean(info.artifactPath) ||
        info.toolName === "system.exportPdf" ||
        info.toolName === "system.screenshot"
      )) ||
    (uploadObjective &&
      info.signal.content.toLowerCase().includes("upload completed")) ||
    (navigationObjective &&
      info.signal.content.toLowerCase().includes("navigation completed"))
  ) {
    return true;
  }
  return false;
}

function desktopGuiCompletionSatisfied(
  run: RunDomainRun,
  info: ParsedDomainSignal,
): boolean {
  if (!allowsDeterministicCompletion(run)) {
    return false;
  }
  const corpus = criteriaCorpus(run);
  return (
    /\b(open|launch|display|show|focus|window|application|gui|screenshot|capture)\b/.test(
      corpus,
    ) &&
    (
      desktopGuiSignalMatches(info) ||
      info.toolName === "system.screenshot"
    ) &&
    (
      /\b(ready|visible|focused|launched|opened|captured)\b/i.test(
        info.signal.content,
      ) ||
      info.toolName === "system.screenshot"
    )
  );
}

function workspaceCompletionSatisfied(
  run: RunDomainRun,
  info: ParsedDomainSignal,
): boolean {
  if (!allowsDeterministicCompletion(run)) {
    return false;
  }
  const corpus = criteriaCorpus(run);
  if (
    /\b(file|write|update|create|modify|patch|save)\b/.test(corpus) &&
    workspaceSignalMatches(info) &&
    (Boolean(info.path) || info.category === "filesystem")
  ) {
    return true;
  }
  if (
    /\b(build|test|lint|typecheck|compile|format)\b/.test(corpus) &&
    commandLooksLikeBuildOrTest(info.command)
  ) {
    return true;
  }
  if (
    /\b(run|execute|command|shell|bash|workspace)\b/.test(corpus) &&
    typeof info.command === "string" &&
    info.command.trim().length > 0
  ) {
    return true;
  }
  return false;
}

function extractExplicitWorkspaceCommandLine(
  run: RunDomainRun,
): string | undefined {
  const candidates = [
    run.objective,
    ...run.contract.successCriteria,
    ...run.contract.completionCriteria,
  ];

  for (const candidate of candidates) {
    const codeMatches = candidate.matchAll(EXPLICIT_CODE_COMMAND_RE);
    for (const match of codeMatches) {
      const commandLine = match[1]?.trim();
      if (commandLine) {
        return commandLine;
      }
    }

    const quotedMatch = candidate.match(QUOTED_WORKSPACE_COMMAND_RE);
    const quotedCommand =
      quotedMatch?.[1]?.trim() ?? quotedMatch?.[2]?.trim();
    if (quotedCommand) {
      return quotedCommand;
    }

    const plainMatch = candidate.match(PLAIN_WORKSPACE_COMMAND_RE);
    const plainCommand = plainMatch?.[1]?.trim();
    if (plainCommand) {
      return plainCommand;
    }
  }

  return undefined;
}

async function executeWorkspaceNativeCycle(
  run: RunDomainRun,
  context: RunDomainExecutionContext,
): Promise<RunDomainNativeCycleResult | undefined> {
  if (!allowsDeterministicCompletion(run)) {
    return undefined;
  }
  if (run.pendingSignals.some((signal) => signal.type !== "user_input")) {
    return undefined;
  }
  if (typeof run.lastToolEvidence === "string" && run.lastToolEvidence.trim().length > 0) {
    return undefined;
  }

  const commandLine = extractExplicitWorkspaceCommandLine(run);
  if (!commandLine) {
    return undefined;
  }

  const parsed = parseDirectCommandLine(commandLine);
  if (!parsed) {
    return undefined;
  }

  const toolCall = await executeNativeToolCall(
    context.toolHandler,
    "system.bash",
    {
      command: parsed.command,
      args: [...parsed.args],
    },
  );

  const actorResult = buildNativeActorResult(
    [toolCall],
    `Executed workspace command \`${commandLine}\` natively.`,
    "workspace-supervisor",
  );
  run.lastVerifiedAt = context.now;
  run.lastToolEvidence = summarizeNativeToolCall(toolCall);

  if (toolCall.isError) {
    return {
      actorResult,
      verification: blockedVerification(
        `Workspace command \`${commandLine}\` failed: ${extractToolFailureText(toolCall)}`,
        "tool_failure",
      ),
    };
  }

  return {
    actorResult,
    verification: successVerification(
      `Workspace command \`${commandLine}\` succeeded. Objective satisfied.`,
    ),
  };
}

function researchCompletionSatisfied(
  run: RunDomainRun,
  info: ParsedDomainSignal,
): boolean {
  if (!allowsDeterministicCompletion(run)) {
    return false;
  }
  const corpus = criteriaCorpus(run);
  return (
    /\b(report|summary|brief|document|analysis|artifact|save|write|export)\b/.test(
      corpus,
    ) &&
    (
      Boolean(info.artifactPath) ||
      Boolean(info.path) ||
      /\b(report|summary)\b/i.test(info.signal.content) ||
      FINITE_COMPLETION_RE.test(info.signal.content)
    )
  );
}

function pipelineCompletionSatisfied(
  run: RunDomainRun,
  info: ParsedDomainSignal,
): boolean {
  if (!allowsDeterministicCompletion(run)) {
    return false;
  }
  const corpus = criteriaCorpus(run);
  return (
    /\b(pipeline|workflow|job|stage|deploy|submit|confirm|health)\b/.test(
      corpus,
    ) &&
    (
      FINITE_COMPLETION_RE.test(info.signal.content) ||
      info.state === "completed" ||
      info.state === "healthy" ||
      info.status === 200
    )
  );
}

function remoteMcpCompletionSatisfied(
  run: RunDomainRun,
  info: ParsedDomainSignal,
): boolean {
  if (!allowsDeterministicCompletion(run)) {
    return false;
  }
  return (
    remoteMcpSignalMatches(info) &&
    (
      FINITE_COMPLETION_RE.test(info.signal.content) ||
      info.state === "completed" ||
      info.state === "succeeded" ||
      info.status === 200
    )
  );
}

export function verificationSupportsContinuation(
  verification: RunDomainVerification,
): boolean {
  return verification.state === "safe_to_continue";
}

export function createGenericRunDomain(): RunDomain {
  return {
    id: "generic",
    matches: () => true,
    plannerContract: (run) => [
      `Domain: ${run.contract.domain}`,
      "Plan against explicit success and completion criteria.",
      "Do not rely on prose claims of completion without verifiable evidence.",
    ],
    verifierContract: (run) => [
      `Domain: ${run.contract.domain}`,
      "Treat runtime evidence as authoritative over assistant narration.",
      "Prefer safe_to_continue unless deterministic success or a clear blocker exists.",
    ],
    eventSubscriptions: () => [
      "tool_result",
      "external_event",
      "webhook",
      "approval",
      "user_input",
    ],
    artifactContract: () => [
      "Persist large tool outputs and artifacts out-of-band from chat history.",
    ],
    recoveryStrategy: () =>
      "Recover from durable run state, replay pending wake events, and continue with the last verified evidence.",
    summarizeStatus: summarizeFromRun,
    detectBlocker: (run) =>
      run.blocker ? verificationFromBlocker(run.blocker) : undefined,
    detectDeterministicVerification: (run) =>
      run.blocker ? verificationFromBlocker(run.blocker) : undefined,
  };
}

export function createApprovalRunDomain(): RunDomain {
  return {
    id: "approval",
    matches: (run) =>
      run.contract.domain === "approval" ||
      run.approvalState.status === "waiting" ||
      run.blocker?.requiresApproval === true,
    plannerContract: () => [
      "This run is approval-gated.",
      "The actor may prepare work, but final state transitions depend on runtime approval evidence.",
    ],
    verifierContract: () => [
      "Approval wait state is deterministic runtime evidence.",
      "Do not claim success while approvalState.status is waiting.",
    ],
    eventSubscriptions: () => ["approval", "user_input", "tool_result"],
    artifactContract: () => [
      "Approval requests and decisions must be durable, auditable runtime artifacts.",
    ],
    recoveryStrategy: () =>
      "Recover approval wait state from durable storage and resume only after an approval wake or explicit operator instruction.",
    summarizeStatus: (run) =>
      run.approvalState.status === "waiting"
        ? run.approvalState.summary ?? "Waiting for approval."
        : run.lastUserUpdate,
    detectBlocker: (run) => {
      if (run.approvalState.status !== "waiting") {
        return undefined;
      }
      const summary = run.approvalState.summary ?? "Waiting for approval.";
      return blockedVerification(summary, "approval_required");
    },
    detectDeterministicVerification: (run) => {
      if (run.approvalState.status !== "waiting") {
        return undefined;
      }
      const summary = run.approvalState.summary ?? "Waiting for approval.";
      return blockedVerification(summary, "approval_required");
    },
  };
}

export function createBrowserRunDomain(): RunDomain {
  return {
    id: "browser",
    matches: (run) => run.contract.domain === "browser",
    plannerContract: () => [
      ...domainPlannerContract("browser"),
      "Preserve page/url/artifact handles across wakes.",
    ],
    verifierContract: () =>
      domainVerifierContract(
        "browser",
        "Browser navigation, downloads, uploads, and capture artifacts should drive progress and completion.",
      ),
    eventSubscriptions: () => [
      "tool_result",
      "external_event",
      "webhook",
      "user_input",
      "approval",
    ],
    artifactContract: () => [
      "Persist browser URLs, titles, downloads, uploads, screenshots, and exported artifacts as structured evidence.",
    ],
    recoveryStrategy: () =>
      "Recover browser/page context from durable artifacts and continue from the latest verified page state or artifact handle.",
    retryPolicy: () => SIGNAL_PREFERRED_RETRY_POLICY,
    summarizeStatus: (run) =>
      latestSignal(run, browserSignalMatches)?.signal.content ?? summarizeFromRun(run),
    detectBlocker: (run) => {
      if (run.blocker) {
        return verificationFromBlocker(run.blocker);
      }
      return detectSignalFailure(
        latestSignal(run, browserSignalMatches),
        "tool_failure",
      );
    },
    detectDeterministicVerification: (run) => {
      const info = latestSignal(run, browserSignalMatches);
      const failure = detectSignalFailure(info, "tool_failure");
      if (failure) {
        return failure;
      }
      if (!info) {
        return undefined;
      }
      if (browserCompletionSatisfied(run, info)) {
        return successVerification(`${info.signal.content} Objective satisfied.`);
      }
      return safeToContinueVerification(
        "Browser domain verified fresh page or artifact state.",
        info.signal.content,
        run.contract.nextCheckMs,
      );
    },
  };
}

export function createDesktopGuiRunDomain(): RunDomain {
  return {
    id: "desktop_gui",
    matches: (run) => run.contract.domain === "desktop_gui",
    plannerContract: () => [
      ...domainPlannerContract("desktop_gui"),
      "Keep GUI/window state, screenshots, and focused application context explicit.",
    ],
    verifierContract: () =>
      domainVerifierContract(
        "desktop_gui",
        "Window state and capture artifacts should determine whether the GUI task is active, blocked, or done.",
      ),
    eventSubscriptions: () => [
      "tool_result",
      "external_event",
      "user_input",
      "approval",
    ],
    artifactContract: () => [
      "Persist screenshots, focused window/application identifiers, and any exported GUI artifacts.",
    ],
    recoveryStrategy: () =>
      "Recover the last known GUI/window state and continue from structured capture evidence rather than freeform narration.",
    retryPolicy: () => DESKTOP_GUI_RETRY_POLICY,
    summarizeStatus: (run) =>
      latestSignal(run, desktopGuiSignalMatches)?.signal.content ?? summarizeFromRun(run),
    detectBlocker: (run) => {
      if (run.blocker) {
        return verificationFromBlocker(run.blocker);
      }
      return detectSignalFailure(
        latestSignal(run, desktopGuiSignalMatches),
        "tool_failure",
      );
    },
    detectDeterministicVerification: (run) => {
      const info = latestSignal(run, desktopGuiSignalMatches);
      const failure = detectSignalFailure(info, "tool_failure");
      if (failure) {
        return failure;
      }
      if (!info) {
        return undefined;
      }
      if (desktopGuiCompletionSatisfied(run, info)) {
        return successVerification(`${info.signal.content} Objective satisfied.`);
      }
      return safeToContinueVerification(
        "Desktop GUI domain observed a fresh window/application state.",
        info.signal.content,
        run.contract.nextCheckMs,
      );
    },
  };
}

export function createWorkspaceRunDomain(): RunDomain {
  return {
    id: "workspace",
    matches: (run) => run.contract.domain === "workspace",
    plannerContract: () => [
      ...domainPlannerContract("workspace"),
      "Prefer durable filesystem changes and command outcomes over narrative progress claims.",
    ],
    verifierContract: () =>
      domainVerifierContract(
        "workspace",
        "Workspace tasks should verify file mutations, build/test outcomes, and explicit artifacts deterministically.",
      ),
    eventSubscriptions: () => [
      "tool_result",
      "external_event",
      "webhook",
      "user_input",
      "approval",
    ],
    artifactContract: () => [
      "Persist changed file paths, command identifiers, and generated build/test artifacts as structured evidence.",
    ],
    recoveryStrategy: () =>
      "Recover from the durable workspace artifact ledger and continue from the last verified file or command state.",
    retryPolicy: () => WORKSPACE_RETRY_POLICY,
    summarizeStatus: (run) =>
      latestSignal(run, workspaceSignalMatches)?.signal.content ?? summarizeFromRun(run),
    detectBlocker: (run) => {
      if (run.blocker) {
        return verificationFromBlocker(run.blocker);
      }
      return detectSignalFailure(
        latestSignal(run, workspaceSignalMatches),
        "tool_failure",
      );
    },
    detectDeterministicVerification: (run) => {
      const info = latestSignal(run, workspaceSignalMatches);
      const failure = detectSignalFailure(info, "tool_failure");
      if (failure) {
        return failure;
      }
      if (!info) {
        return undefined;
      }
      if (workspaceCompletionSatisfied(run, info)) {
        return successVerification(`${info.signal.content} Objective satisfied.`);
      }
      return safeToContinueVerification(
        "Workspace domain verified a durable filesystem or command result.",
        info.signal.content,
        run.contract.nextCheckMs,
      );
    },
    executeNativeCycle: async (run, context) =>
      executeWorkspaceNativeCycle(run, context),
  };
}

export function createResearchRunDomain(): RunDomain {
  return {
    id: "research",
    matches: (run) => run.contract.domain === "research",
    plannerContract: () => [
      ...domainPlannerContract("research"),
      "Anchor progress in sources, artifacts, and report handles rather than conversational summaries.",
    ],
    verifierContract: () =>
      domainVerifierContract(
        "research",
        "Research runs should advance from fetched sources, persisted notes, and final report artifacts.",
      ),
    eventSubscriptions: () => [
      "tool_result",
      "external_event",
      "webhook",
      "approval",
      "user_input",
    ],
    artifactContract: () => [
      "Persist source references, intermediate notes, and final report artifacts as durable research evidence.",
    ],
    recoveryStrategy: () =>
      "Recover the latest verified research artifact, then continue fetching or synthesizing from that checkpoint.",
    retryPolicy: () => SIGNAL_PREFERRED_RETRY_POLICY,
    summarizeStatus: (run) =>
      latestSignal(run, researchSignalMatches)?.signal.content ?? summarizeFromRun(run),
    detectBlocker: (run) => {
      if (run.blocker) {
        return verificationFromBlocker(run.blocker);
      }
      return detectSignalFailure(
        latestSignal(run, researchSignalMatches),
        "tool_failure",
      );
    },
    detectDeterministicVerification: (run) => {
      const info = latestSignal(run, researchSignalMatches);
      const failure = detectSignalFailure(info, "tool_failure");
      if (failure) {
        return failure;
      }
      if (!info) {
        return undefined;
      }
      if (researchCompletionSatisfied(run, info)) {
        return successVerification(`${info.signal.content} Objective satisfied.`);
      }
      return safeToContinueVerification(
        "Research domain observed a durable source or artifact update.",
        info.signal.content,
        run.contract.nextCheckMs,
      );
    },
  };
}

export function createPipelineRunDomain(): RunDomain {
  return {
    id: "pipeline",
    matches: (run) => run.contract.domain === "pipeline",
    plannerContract: () => [
      ...domainPlannerContract("pipeline"),
      "Treat stage transitions, queue state, and health checks as first-class runtime evidence.",
    ],
    verifierContract: () =>
      domainVerifierContract(
        "pipeline",
        "Pipeline/workflow status should come from explicit stage, health, or confirmation events.",
      ),
    eventSubscriptions: () => [
      "tool_result",
      "external_event",
      "webhook",
      "approval",
      "user_input",
    ],
    artifactContract: () => [
      "Persist pipeline IDs, stage checkpoints, health probes, and final confirmation artifacts.",
    ],
    recoveryStrategy: () =>
      "Recover from stage checkpoints and health events, then continue from the next unresolved stage.",
    retryPolicy: () => SIGNAL_PREFERRED_RETRY_POLICY,
    summarizeStatus: (run) =>
      latestSignal(run, pipelineSignalMatches)?.signal.content ?? summarizeFromRun(run),
    detectBlocker: (run) => {
      if (run.blocker) {
        return verificationFromBlocker(run.blocker);
      }
      const info = latestSignal(run, pipelineSignalMatches);
      if (!info) {
        return undefined;
      }
      if (
        info.state === "down" ||
        info.state === "unhealthy" ||
        (info.status ?? 0) >= 500
      ) {
        return blockedVerification(info.signal.content, "missing_prerequisite");
      }
      const failure = detectSignalFailure(info, "tool_failure");
      if (failure) {
        return failure;
      }
      return undefined;
    },
    detectDeterministicVerification: (run) => {
      const info = latestSignal(run, pipelineSignalMatches);
      if (!info) {
        return undefined;
      }
      if (
        info.state === "down" ||
        info.state === "unhealthy" ||
        (info.status ?? 0) >= 500
      ) {
        return blockedVerification(info.signal.content, "missing_prerequisite");
      }
      const failure = detectSignalFailure(info, "tool_failure");
      if (failure) {
        return failure;
      }
      if (pipelineCompletionSatisfied(run, info)) {
        return successVerification(`${info.signal.content} Objective satisfied.`);
      }
      return safeToContinueVerification(
        "Pipeline domain observed a deterministic stage or health transition.",
        info.signal.content,
        run.contract.nextCheckMs,
      );
    },
  };
}

export function createRemoteMcpRunDomain(): RunDomain {
  return {
    id: "remote_mcp",
    matches: (run) => run.contract.domain === "remote_mcp",
    plannerContract: () => [
      ...domainPlannerContract("remote_mcp"),
      "Treat remote job handles, server names, and callback payloads as durable evidence.",
    ],
    verifierContract: () =>
      domainVerifierContract(
        "remote_mcp",
        "Remote MCP jobs should progress from explicit job IDs and callback events, not assistant narration.",
      ),
    eventSubscriptions: () => [
      "tool_result",
      "external_event",
      "webhook",
      "approval",
      "user_input",
    ],
    artifactContract: () => [
      "Persist MCP server name, remote job IDs, callback payloads, and returned artifacts.",
    ],
    recoveryStrategy: () =>
      "Recover the latest remote MCP job handle and continue from the next callback or explicit status probe.",
    retryPolicy: () => SIGNAL_PREFERRED_RETRY_POLICY,
    summarizeStatus: (run) =>
      latestSignal(run, remoteMcpSignalMatches)?.signal.content ?? summarizeFromRun(run),
    detectBlocker: (run) => {
      if (run.blocker) {
        return verificationFromBlocker(run.blocker);
      }
      const info = latestSignal(run, remoteMcpSignalMatches);
      const failure = detectSignalFailure(info, "tool_failure");
      if (failure) {
        return failure;
      }
      if (!info) {
        return undefined;
      }
      if (info.state === "failed" || info.state === "error" || (info.status ?? 0) >= 400) {
        return blockedVerification(info.signal.content, "tool_failure");
      }
      return undefined;
    },
    detectDeterministicVerification: (run) => {
      const info = latestSignal(run, remoteMcpSignalMatches);
      if (!info) {
        return undefined;
      }
      const failure = detectSignalFailure(info, "tool_failure");
      if (failure) {
        return failure;
      }
      if (remoteMcpCompletionSatisfied(run, info)) {
        return successVerification(`${info.signal.content} Objective satisfied.`);
      }
      return safeToContinueVerification(
        "Remote MCP domain observed an explicit remote job event.",
        info.signal.content,
        run.contract.nextCheckMs,
      );
    },
  };
}
