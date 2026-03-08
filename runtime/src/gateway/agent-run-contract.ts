export const AGENT_RUN_SCHEMA_VERSION = 2 as const;

export const AGENT_RUN_KINDS = [
  "finite",
  "until_condition",
  "until_stopped",
] as const;

export type AgentRunKind = (typeof AGENT_RUN_KINDS)[number];

export const AGENT_RUN_DOMAINS = [
  "generic",
  "managed_process",
  "approval",
  "browser",
  "desktop_gui",
  "workspace",
  "research",
  "pipeline",
  "remote_mcp",
] as const;

export type AgentRunDomain = (typeof AGENT_RUN_DOMAINS)[number];

export const AGENT_RUN_STATES = [
  "pending",
  "running",
  "working",
  "paused",
  "blocked",
  "suspended",
  "completed",
  "failed",
  "cancelled",
] as const;

export type AgentRunState = (typeof AGENT_RUN_STATES)[number];

export const AGENT_RUN_WAKE_REASONS = [
  "start",
  "timer",
  "busy_retry",
  "recovery",
  "user_input",
  "approval",
  "external_event",
  "tool_result",
  "process_exit",
  "webhook",
  "daemon_shutdown",
] as const;

export type AgentRunWakeReason = (typeof AGENT_RUN_WAKE_REASONS)[number];

export const AGENT_MANAGED_PROCESS_POLICY_MODES = [
  "none",
  "until_exit",
  "keep_running",
  "restart_on_exit",
] as const;

export type AgentManagedProcessPolicyMode =
  (typeof AGENT_MANAGED_PROCESS_POLICY_MODES)[number];

export interface AgentRunManagedProcessPolicy {
  readonly mode: AgentManagedProcessPolicyMode;
  readonly maxRestarts?: number;
  readonly restartBackoffMs?: number;
}

export interface AgentRunContract {
  readonly domain: AgentRunDomain;
  readonly kind: AgentRunKind;
  readonly successCriteria: readonly string[];
  readonly completionCriteria: readonly string[];
  readonly blockedCriteria: readonly string[];
  readonly nextCheckMs: number;
  readonly heartbeatMs?: number;
  readonly requiresUserStop: boolean;
  readonly managedProcessPolicy?: AgentRunManagedProcessPolicy;
}

const TERMINAL_STATES = new Set<AgentRunState>([
  "completed",
  "failed",
  "cancelled",
]);

const RECOVERABLE_STATES = new Set<AgentRunState>([
  "pending",
  "working",
  "paused",
  "blocked",
  "suspended",
]);

const AGENT_RUN_STATE_TRANSITIONS: Record<AgentRunState, readonly AgentRunState[]> = {
  pending: ["running", "paused", "blocked", "failed", "cancelled", "suspended"],
  running: ["working", "paused", "blocked", "completed", "failed", "cancelled", "suspended"],
  working: ["running", "paused", "blocked", "completed", "failed", "cancelled", "suspended"],
  paused: ["working", "cancelled", "failed", "blocked"],
  blocked: ["running", "working", "paused", "failed", "cancelled", "suspended"],
  suspended: ["working", "paused", "blocked", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function isAgentRunKind(value: unknown): value is AgentRunKind {
  return (
    typeof value === "string" &&
    (AGENT_RUN_KINDS as readonly string[]).includes(value)
  );
}

export function isAgentRunDomain(value: unknown): value is AgentRunDomain {
  return (
    typeof value === "string" &&
    (AGENT_RUN_DOMAINS as readonly string[]).includes(value)
  );
}

export function isAgentRunState(value: unknown): value is AgentRunState {
  return (
    typeof value === "string" &&
    (AGENT_RUN_STATES as readonly string[]).includes(value)
  );
}

export function isAgentRunWakeReason(
  value: unknown,
): value is AgentRunWakeReason {
  return (
    typeof value === "string" &&
    (AGENT_RUN_WAKE_REASONS as readonly string[]).includes(value)
  );
}

export function isAgentManagedProcessPolicyMode(
  value: unknown,
): value is AgentManagedProcessPolicyMode {
  return (
    typeof value === "string" &&
    (AGENT_MANAGED_PROCESS_POLICY_MODES as readonly string[]).includes(value)
  );
}

export function isTerminalAgentRunState(state: AgentRunState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isRecoverableAgentRunState(state: AgentRunState): boolean {
  return RECOVERABLE_STATES.has(state);
}

export function canTransitionAgentRunState(
  from: AgentRunState,
  to: AgentRunState,
): boolean {
  return from === to || AGENT_RUN_STATE_TRANSITIONS[from].includes(to);
}

export function assertAgentRunStateTransition(
  from: AgentRunState,
  to: AgentRunState,
  context?: string,
): void {
  if (canTransitionAgentRunState(from, to)) {
    return;
  }
  const detail = context ? ` (${context})` : "";
  throw new Error(`Invalid AgentRun state transition: ${from} -> ${to}${detail}`);
}

export function assertValidAgentRunContract(
  contract: AgentRunContract,
  context = "AgentRun contract",
): void {
  if (!isAgentRunDomain(contract.domain)) {
    throw new Error(`${context}: invalid domain`);
  }
  if (!isAgentRunKind(contract.kind)) {
    throw new Error(`${context}: invalid kind`);
  }
  if (!Array.isArray(contract.successCriteria) || contract.successCriteria.length === 0) {
    throw new Error(`${context}: successCriteria must be a non-empty array`);
  }
  if (
    !Array.isArray(contract.completionCriteria) ||
    contract.completionCriteria.length === 0
  ) {
    throw new Error(`${context}: completionCriteria must be a non-empty array`);
  }
  if (!Array.isArray(contract.blockedCriteria) || contract.blockedCriteria.length === 0) {
    throw new Error(`${context}: blockedCriteria must be a non-empty array`);
  }
  if (
    typeof contract.nextCheckMs !== "number" ||
    !Number.isFinite(contract.nextCheckMs) ||
    contract.nextCheckMs <= 0
  ) {
    throw new Error(`${context}: nextCheckMs must be a positive finite number`);
  }
  if (
    contract.heartbeatMs !== undefined &&
    (
      typeof contract.heartbeatMs !== "number" ||
      !Number.isFinite(contract.heartbeatMs) ||
      contract.heartbeatMs <= 0
    )
  ) {
    throw new Error(`${context}: heartbeatMs must be a positive finite number`);
  }
  if (typeof contract.requiresUserStop !== "boolean") {
    throw new Error(`${context}: requiresUserStop must be a boolean`);
  }
  if (contract.managedProcessPolicy) {
    if (!isAgentManagedProcessPolicyMode(contract.managedProcessPolicy.mode)) {
      throw new Error(`${context}: managedProcessPolicy.mode is invalid`);
    }
    if (
      contract.managedProcessPolicy.maxRestarts !== undefined &&
      (
        !Number.isInteger(contract.managedProcessPolicy.maxRestarts) ||
        contract.managedProcessPolicy.maxRestarts <= 0
      )
    ) {
      throw new Error(`${context}: managedProcessPolicy.maxRestarts must be a positive integer`);
    }
    if (
      contract.managedProcessPolicy.restartBackoffMs !== undefined &&
      (
        !Number.isInteger(contract.managedProcessPolicy.restartBackoffMs) ||
        contract.managedProcessPolicy.restartBackoffMs <= 0
      )
    ) {
      throw new Error(`${context}: managedProcessPolicy.restartBackoffMs must be a positive integer`);
    }
  }
}

export function inferAgentRunDomain(params: {
  readonly objective?: string;
  readonly successCriteria?: readonly string[];
  readonly completionCriteria?: readonly string[];
  readonly blockedCriteria?: readonly string[];
  readonly requiresUserStop?: boolean;
  readonly managedProcessPolicy?: AgentRunManagedProcessPolicy;
}): AgentRunDomain {
  if (params.managedProcessPolicy && params.managedProcessPolicy.mode !== "none") {
    return "managed_process";
  }

  const corpus = [
    params.objective,
    ...(params.successCriteria ?? []),
    ...(params.completionCriteria ?? []),
    ...(params.blockedCriteria ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();

  if (/\b(approval|approve|permission|authorize|authorization|review gate|manual review)\b/.test(corpus)) {
    return "approval";
  }
  if (
    /\b(process|server|service|daemon|watcher|worker)\b/.test(corpus) &&
    /\b(exit|restart|running|monitor|supervise|watch|keep running|stay running)\b/.test(corpus)
  ) {
    return "managed_process";
  }
  if (
    /\b(browser|page|url|website|tab|navigate|click|fill|download|upload|playwright)\b/.test(corpus)
  ) {
    return "browser";
  }
  if (
    /\b(gui|desktop|window|application|screen|screenshot)\b/.test(corpus)
  ) {
    return "desktop_gui";
  }
  if (
    /\b(code|repo|repository|workspace|project|branch|commit|file|test suite|build)\b/.test(corpus)
  ) {
    return "workspace";
  }
  if (
    /\b(research|report|investigate|analysis|analyze|summarize|summary|deep research)\b/.test(corpus)
  ) {
    return "research";
  }
  if (
    /\b(pipeline|workflow|job|stage|etl|deploy|deployment|orchestration)\b/.test(corpus)
  ) {
    return "pipeline";
  }
  if (/\bremote mcp|mcp job|mcp server|remote tool\b/.test(corpus)) {
    return "remote_mcp";
  }

  if (params.requiresUserStop) {
    return "generic";
  }

  return "generic";
}
