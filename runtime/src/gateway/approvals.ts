/**
 * Approval policy engine for tool call interception.
 *
 * Provides per-tool, per-amount approval policies that intercept dangerous
 * tool calls via the `tool:before` hook. The engine evaluates rules against
 * incoming tool invocations and blocks execution until explicit approval
 * is granted (or auto-denies after a configurable timeout).
 *
 * @module
 */

import type { HookHandler, HookContext, HookResult } from "./hooks.js";
import { createHmac } from "node:crypto";

// ============================================================================
// Types
// ============================================================================

/** Conditions that must be met for a rule to trigger. */
export interface ApprovalConditions {
  /** Minimum amount threshold (e.g., 0.1 SOL). */
  readonly minAmount?: number;
  /** Required arg key patterns (glob-matched against arg values). */
  readonly argPatterns?: Readonly<Record<string, string>>;
}

/** A single approval rule matching a tool pattern. */
export interface ApprovalRule {
  /** Glob pattern matched against tool names (e.g., `wallet.*`). */
  readonly tool: string;
  /** Optional conditions — if omitted, the rule always triggers on match. */
  readonly conditions?: ApprovalConditions;
  /** Human-readable description for approval prompts. */
  readonly description?: string;
  /** Target response SLA in ms before escalation is warranted. */
  readonly slaMs?: number;
  /** Escalation delay in ms (defaults to `slaMs` when set). */
  readonly escalationDelayMs?: number;
  /** Whether a parent/root session may resolve the request on behalf of a child. */
  readonly allowParentDelegation?: boolean;
  /** Optional enterprise approver group name for routing/escalation. */
  readonly approverGroup?: string;
  /** Optional resolver role set required to approve or deny the request. */
  readonly approverRoles?: readonly string[];
}

/** Per-session elevated mode configuration. */
export interface ElevatedModeConfig {
  /** Tool patterns that have been "always approved" for this session. */
  readonly patterns: ReadonlySet<string>;
}

/** Configuration for the overall approval policy. */
export interface ApprovalPolicyConfig {
  /** Approval rules to evaluate. */
  readonly rules: readonly ApprovalRule[];
  /** Default timeout for pending approvals in ms (default: 300_000 = 5 min). */
  readonly timeoutMs?: number;
  /** Optional default response SLA in ms. */
  readonly defaultSlaMs?: number;
  /** Optional default escalation delay in ms. */
  readonly defaultEscalationDelayMs?: number;
}

/** An approval request awaiting resolution. */
export interface ApprovalRequest {
  /** Unique request identifier. */
  readonly id: string;
  /** The tool being invoked. */
  readonly toolName: string;
  /** Arguments passed to the tool. */
  readonly args: Record<string, unknown>;
  /** Session that triggered the request. */
  readonly sessionId: string;
  /** Optional parent/root session for delegated child requests. */
  readonly parentSessionId?: string;
  /** Optional delegated child session identifier. */
  readonly subagentSessionId?: string;
  /** Human-readable message describing what needs approval. */
  readonly message: string;
  /** Timestamp when the request was created. */
  readonly createdAt: number;
  /** Hard deadline when the request auto-denies. */
  readonly deadlineAt: number;
  /** Optional target response SLA in ms. */
  readonly slaMs?: number;
  /** Optional escalation timestamp in epoch ms. */
  readonly escalateAt?: number;
  /** Whether a parent/root session may resolve this request. */
  readonly allowDelegatedResolution: boolean;
  /** Optional enterprise approver group name for escalation/routing. */
  readonly approverGroup?: string;
  /** Optional resolver roles required to resolve the request. */
  readonly requiredApproverRoles?: readonly string[];
  /** The rule that triggered this request. */
  readonly rule: ApprovalRule;
}

/** The disposition of an approval response. */
export type ApprovalDisposition = "yes" | "no" | "always";

export interface ApprovalResolverIdentity {
  /** Stable operator/user identity when available. */
  readonly actorId?: string;
  /** Session used to resolve the request. */
  readonly sessionId?: string;
  /** Channel where the resolution was recorded. */
  readonly channel?: string;
  /** Resolver roles asserted by the channel/runtime. */
  readonly roles?: readonly string[];
  /** Epoch ms when the response was recorded. */
  readonly resolvedAt: number;
  /** HMAC assertion binding request/disposition to resolver identity. */
  readonly assertion?: string;
}

/** Response to an approval request. */
export interface ApprovalResponse {
  /** The request being responded to. */
  readonly requestId: string;
  /** Approval disposition. */
  readonly disposition: ApprovalDisposition;
  /** Who approved/denied (optional). */
  readonly approvedBy?: string;
  /** Structured, signed resolver identity assertion. */
  readonly resolver?: ApprovalResolverIdentity;
}

export interface ApprovalEscalation {
  readonly requestId: string;
  readonly sessionId: string;
  readonly parentSessionId?: string;
  readonly subagentSessionId?: string;
  readonly toolName: string;
  readonly escalatedAt: number;
  readonly escalateToSessionId: string;
  readonly deadlineAt: number;
  readonly approverGroup?: string;
  readonly requiredApproverRoles?: readonly string[];
}

export interface ApprovalSimulationDecision {
  readonly required: boolean;
  readonly elevated: boolean;
  readonly denied: boolean;
  readonly rule?: ApprovalRule;
  readonly requestPreview?: ApprovalRequest;
}

/** Configuration for the ApprovalEngine (with injectable deps for testing). */
export interface ApprovalEngineConfig {
  /** Approval rules. */
  readonly rules?: readonly ApprovalRule[];
  /** Timeout for pending requests in ms (default: 300_000). */
  readonly timeoutMs?: number;
  /** Default target response SLA in ms. */
  readonly defaultSlaMs?: number;
  /** Default escalation delay in ms. */
  readonly defaultEscalationDelayMs?: number;
  /** Optional signing key for resolver identity assertions. */
  readonly resolverSigningKey?: string;
  /** Clock function (default: Date.now). */
  readonly now?: () => number;
  /** ID generator (default: crypto.randomUUID-like). */
  readonly generateId?: () => string;
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Simple glob matcher — supports `*` as a wildcard for any sequence of chars.
 */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return value === pattern;

  const parts = pattern.split("*");
  let cursor = 0;
  const [first, ...rest] = parts;

  if (!value.startsWith(first ?? "")) return false;
  cursor = (first ?? "").length;

  for (let i = 0; i < rest.length; i += 1) {
    const part = rest[i] ?? "";
    if (part.length === 0) continue;

    // Last segment must match the end.
    if (i === rest.length - 1) {
      return value.slice(cursor).endsWith(part);
    }

    const next = value.indexOf(part, cursor);
    if (next === -1) return false;
    cursor = next + part.length;
  }

  return true;
}

/**
 * Extract a numeric "amount" from tool arguments.
 * Checks `amount`, `reward`, and `lamports` keys. Handles string coercion.
 */
export function extractAmount(
  args: Record<string, unknown>,
): number | undefined {
  for (const key of ["amount", "reward", "lamports"]) {
    const val = args[key];
    if (val === undefined || val === null || val === "") continue;
    const num = typeof val === "number" ? val : Number(val);
    if (!Number.isNaN(num)) return num;
  }
  return undefined;
}

function normalizeResolverRoles(value: readonly string[] | undefined): string[] {
  if (!value) return [];
  return [...new Set(value.map((entry) => entry.trim()).filter((entry) => entry.length > 0))];
}

function signResolverAssertion(params: {
  signingKey: string;
  requestId: string;
  disposition: ApprovalDisposition;
  actorId?: string;
  sessionId?: string;
  channel?: string;
  roles?: readonly string[];
  resolvedAt: number;
}): string {
  const serialized = JSON.stringify({
    requestId: params.requestId,
    disposition: params.disposition,
    actorId: params.actorId ?? "",
    sessionId: params.sessionId ?? "",
    channel: params.channel ?? "",
    roles: normalizeResolverRoles(params.roles),
    resolvedAt: params.resolvedAt,
  });
  return createHmac("sha256", params.signingKey).update(serialized).digest("hex");
}

// ============================================================================
// Default Rules
// ============================================================================

/**
 * Built-in approval rules for common dangerous operations.
 *
 * Note: `system.bash` and `desktop.bash` are intentionally NOT included by
 * default to avoid blocking normal terminal workflows. Teams that require
 * blanket shell approvals can add explicit rules via configuration.
 */
export const DEFAULT_APPROVAL_RULES: readonly ApprovalRule[] = [
  {
    tool: "system.delete",
    description: "File deletion",
  },
  {
    tool: "system.evaluateJs",
    description: "JavaScript evaluation",
  },
  {
    tool: "wallet.sign",
    description: "Wallet transaction signing",
  },
  {
    tool: "wallet.transfer",
    conditions: { minAmount: 0.1 },
    description: "SOL transfer exceeding 0.1",
  },
  {
    tool: "agenc.createTask",
    conditions: { minAmount: 1_000_000_000 },
    description: "Task creation with reward exceeding 1 SOL",
  },
  {
    tool: 'agenc.registerAgent',
    description: 'Agent registration with staked SOL',
  },
  // Desktop automation — require approval by default
  {
    tool: "mcp.peekaboo.click",
    description: "Desktop mouse click",
  },
  {
    tool: "mcp.peekaboo.type",
    description: "Desktop keyboard input",
  },
  {
    tool: "mcp.peekaboo.scroll",
    description: "Desktop scroll action",
  },
  {
    tool: "mcp.macos-automator.*",
    description: "macOS automation script",
  },
];

// ============================================================================
// ApprovalEngine
// ============================================================================

const DEFAULT_TIMEOUT_MS = 300_000; // 5 minutes

interface PendingRequest {
  readonly request: ApprovalRequest;
  resolve: (response: ApprovalResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  escalationTimer?: ReturnType<typeof setTimeout>;
  escalated: boolean;
}

export type ApprovalResponseHandler = (
  request: ApprovalRequest,
  response: ApprovalResponse,
) => void | Promise<void>;

export type ApprovalRequestHandler = (request: ApprovalRequest) => void | Promise<void>;

export type ApprovalEscalationHandler = (
  request: ApprovalRequest,
  escalation: ApprovalEscalation,
) => void | Promise<void>;

/**
 * Approval engine that evaluates tool invocations against configured rules,
 * manages pending approval requests, and supports per-session elevation.
 */
export class ApprovalEngine {
  private readonly rules: readonly ApprovalRule[];
  private readonly timeoutMs: number;
  private readonly defaultSlaMs?: number;
  private readonly defaultEscalationDelayMs?: number;
  private readonly resolverSigningKey?: string;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly requestHandlers: ApprovalRequestHandler[] = [];
  private readonly responseHandlers: ApprovalResponseHandler[] = [];
  private readonly escalationHandlers: ApprovalEscalationHandler[] = [];
  private readonly elevations = new Map<string, Set<string>>();
  private readonly denials = new Map<string, Set<string>>();
  private idCounter = 0;

  constructor(config?: ApprovalEngineConfig) {
    this.rules = config?.rules ?? DEFAULT_APPROVAL_RULES;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultSlaMs = config?.defaultSlaMs;
    this.defaultEscalationDelayMs = config?.defaultEscalationDelayMs;
    this.resolverSigningKey = config?.resolverSigningKey;
    this.now = config?.now ?? Date.now;
    this.generateId =
      config?.generateId ??
      (() => `approval-${Date.now()}-${++this.idCounter}`);
  }

  /**
   * Check whether a tool invocation requires approval.
   * Returns the first matching rule, or `null` if none match.
   */
  requiresApproval(
    toolName: string,
    args: Record<string, unknown>,
  ): ApprovalRule | null {
    for (const rule of this.rules) {
      if (!globMatch(rule.tool, toolName)) continue;

      if (rule.conditions) {
        // Check minAmount condition
        if (rule.conditions.minAmount !== undefined) {
          const amount = extractAmount(args);
          if (amount === undefined || amount <= rule.conditions.minAmount)
            continue;
        }

        // Check argPatterns condition
        if (rule.conditions.argPatterns) {
          let allMatch = true;
          for (const [key, pattern] of Object.entries(
            rule.conditions.argPatterns,
          )) {
            const val = args[key];
            if (val === undefined || !globMatch(pattern, String(val))) {
              allMatch = false;
              break;
            }
          }
          if (!allMatch) continue;
        }
      }

      return rule;
    }
    return null;
  }

  /**
   * Create an ApprovalRequest for a tool invocation.
   */
  createRequest(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string,
    message: string,
    rule: ApprovalRule,
    context?: {
      parentSessionId?: string;
      subagentSessionId?: string;
    },
  ): ApprovalRequest {
    return this.buildRequest(
      this.generateId(),
      toolName,
      args,
      sessionId,
      message,
      rule,
      context,
    );
  }

  private buildRequest(
    requestId: string,
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string,
    message: string,
    rule: ApprovalRule,
    context?: {
      parentSessionId?: string;
      subagentSessionId?: string;
    },
  ): ApprovalRequest {
    const createdAt = this.now();
    const parentSessionId =
      typeof context?.parentSessionId === "string" &&
      context.parentSessionId.trim().length > 0
        ? context.parentSessionId.trim()
        : undefined;
    const subagentSessionId =
      typeof context?.subagentSessionId === "string" &&
      context.subagentSessionId.trim().length > 0
        ? context.subagentSessionId.trim()
        : undefined;
    const deadlineAt = createdAt + this.timeoutMs;
    const slaMs =
      rule.slaMs !== undefined
        ? Math.min(rule.slaMs, this.timeoutMs)
        : this.defaultSlaMs !== undefined
          ? Math.min(this.defaultSlaMs, this.timeoutMs)
          : undefined;
    const escalationDelayMs =
      rule.escalationDelayMs !== undefined
        ? Math.min(rule.escalationDelayMs, this.timeoutMs)
        : slaMs !== undefined
          ? slaMs
          : this.defaultEscalationDelayMs !== undefined
            ? Math.min(this.defaultEscalationDelayMs, this.timeoutMs)
            : undefined;
    const escalateAt =
      escalationDelayMs !== undefined ? createdAt + escalationDelayMs : undefined;
    return {
      id: requestId,
      toolName,
      args,
      sessionId,
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(subagentSessionId ? { subagentSessionId } : {}),
      message,
      createdAt,
      deadlineAt,
      ...(slaMs !== undefined ? { slaMs } : {}),
      ...(escalateAt !== undefined ? { escalateAt } : {}),
      allowDelegatedResolution:
        parentSessionId !== undefined && rule.allowParentDelegation !== false,
      ...(rule.approverGroup ? { approverGroup: rule.approverGroup } : {}),
      ...(rule.approverRoles && rule.approverRoles.length > 0
        ? { requiredApproverRoles: normalizeResolverRoles(rule.approverRoles) }
        : {}),
      rule,
    };
  }

  simulate(
    toolName: string,
    args: Record<string, unknown>,
    sessionId: string,
    context?: {
      parentSessionId?: string;
      subagentSessionId?: string;
      message?: string;
    },
  ): ApprovalSimulationDecision {
    if (this.isToolDenied(sessionId, toolName, context?.parentSessionId)) {
      return {
        required: false,
        elevated: false,
        denied: true,
      };
    }
    if (this.isToolElevated(sessionId, toolName)) {
      return {
        required: false,
        elevated: true,
        denied: false,
      };
    }
    const rule = this.requiresApproval(toolName, args);
    if (!rule) {
      return {
        required: false,
        elevated: false,
        denied: false,
      };
    }
    return {
      required: true,
      elevated: false,
      denied: false,
      rule,
      requestPreview: this.buildRequest(
        `approval-preview:${sessionId}:${toolName}`,
        toolName,
        args,
        sessionId,
        context?.message ??
          (rule.description
            ? `Approval required: ${rule.description}`
            : `Approval required for ${toolName}`),
        rule,
        context,
      ),
    };
  }

  /**
   * Submit an approval request and wait for resolution.
   * Auto-denies after the configured timeout.
   */
  async requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    const responsePromise = new Promise<ApprovalResponse>((resolve) => {
      const timeoutDelayMs = Math.max(0, request.deadlineAt - this.now());
      const timer = setTimeout(() => {
        const response = this.normalizeResponse(request, {
          requestId: request.id,
          disposition: "no",
          resolver: {
            actorId: "system:auto-timeout",
            channel: "system",
            resolvedAt: this.now(),
          },
        });
        const pending = this.pending.get(request.id);
        if (pending?.escalationTimer) {
          clearTimeout(pending.escalationTimer);
        }
        this.pending.delete(request.id);
        void this.notifyHandlers(request, response);
        resolve(response);
      }, timeoutDelayMs);
      const pending: PendingRequest = {
        request,
        resolve,
        timer,
        escalated: false,
      };
      if (request.escalateAt !== undefined) {
        const delayMs = Math.max(0, request.escalateAt - this.now());
        pending.escalationTimer = setTimeout(() => {
          const active = this.pending.get(request.id);
          if (!active || active.escalated) {
            return;
          }
          active.escalated = true;
          const escalation: ApprovalEscalation = {
            requestId: request.id,
            sessionId: request.sessionId,
            ...(request.parentSessionId
              ? { parentSessionId: request.parentSessionId }
              : {}),
            ...(request.subagentSessionId
              ? { subagentSessionId: request.subagentSessionId }
              : {}),
            toolName: request.toolName,
            escalatedAt: this.now(),
            escalateToSessionId:
              request.allowDelegatedResolution && request.parentSessionId
                ? request.parentSessionId
                : request.sessionId,
            deadlineAt: request.deadlineAt,
            ...(request.approverGroup
              ? { approverGroup: request.approverGroup }
              : {}),
            ...(request.requiredApproverRoles &&
            request.requiredApproverRoles.length > 0
              ? { requiredApproverRoles: request.requiredApproverRoles }
              : {}),
          };
          void this.notifyEscalationHandlers(request, escalation);
        }, delayMs);
      }

      this.pending.set(request.id, pending);
    });
    await this.notifyRequestHandlers(request);
    return responsePromise;
  }

  /**
   * Resolve a pending approval request.
   * If disposition is `'always'`, elevates the session for the tool's pattern.
   */
  async resolve(requestId: string, response: ApprovalResponse): Promise<boolean> {
    const entry = this.pending.get(requestId);
    if (!entry) return false;

    const normalizedResponse = this.normalizeResponse(entry.request, response);
    if (!this.isResolutionAuthorized(entry.request, normalizedResponse)) {
      return false;
    }

    clearTimeout(entry.timer);
    if (entry.escalationTimer) {
      clearTimeout(entry.escalationTimer);
    }
    this.pending.delete(requestId);

    if (normalizedResponse.disposition === "always") {
      this.elevate(entry.request.sessionId, entry.request.rule.tool);
      this.clearDeniedPattern(entry.request.sessionId, entry.request.rule.tool);
      if (entry.request.parentSessionId) {
        this.clearDeniedPattern(
          entry.request.parentSessionId,
          entry.request.rule.tool,
        );
      }
    }

    if (normalizedResponse.disposition === "yes") {
      this.clearDeniedPattern(entry.request.sessionId, entry.request.rule.tool);
      if (entry.request.parentSessionId) {
        this.clearDeniedPattern(
          entry.request.parentSessionId,
          entry.request.rule.tool,
        );
      }
    }

    if (normalizedResponse.disposition === "no") {
      this.deny(entry.request.sessionId, entry.request.rule.tool);
      if (entry.request.parentSessionId) {
        this.deny(entry.request.parentSessionId, entry.request.rule.tool);
      }
    }

    await this.notifyHandlers(entry.request, normalizedResponse);
    entry.resolve(normalizedResponse);
    return true;
  }

  /**
   * Register a callback invoked whenever an approval response is resolved.
   */
  onResponse(handler: ApprovalResponseHandler): void {
    this.responseHandlers.push(handler);
  }

  onRequest(handler: ApprovalRequestHandler): void {
    this.requestHandlers.push(handler);
  }

  onEscalation(handler: ApprovalEscalationHandler): void {
    this.escalationHandlers.push(handler);
  }

  /**
   * Check if a session has any elevated patterns.
   */
  isElevated(sessionId: string): boolean {
    const patterns = this.elevations.get(sessionId);
    return patterns !== undefined && patterns.size > 0;
  }

  /**
   * Check if a specific tool is covered by a session's elevated patterns.
   */
  isToolElevated(sessionId: string, toolName: string): boolean {
    const patterns = this.elevations.get(sessionId);
    if (!patterns) return false;
    for (const pattern of patterns) {
      if (globMatch(pattern, toolName)) return true;
    }
    return false;
  }

  /**
   * Elevate a session for a specific tool pattern.
   */
  elevate(sessionId: string, toolPattern: string): void {
    let patterns = this.elevations.get(sessionId);
    if (!patterns) {
      patterns = new Set();
      this.elevations.set(sessionId, patterns);
    }
    patterns.add(toolPattern);
  }

  /**
   * Revoke all elevated patterns for a session.
   */
  revokeElevation(sessionId: string): void {
    this.elevations.delete(sessionId);
  }

  /**
   * Check whether a tool was explicitly denied for this request tree.
   * When `parentSessionId` is provided, denials on the parent also apply.
   */
  isToolDenied(
    sessionId: string,
    toolName: string,
    parentSessionId?: string,
  ): boolean {
    const scopes = new Set<string>();
    const normalizedSession = sessionId.trim();
    if (normalizedSession.length > 0) scopes.add(normalizedSession);
    const normalizedParent = parentSessionId?.trim();
    if (normalizedParent && normalizedParent.length > 0) {
      scopes.add(normalizedParent);
    }
    for (const scope of scopes) {
      const deniedPatterns = this.denials.get(scope);
      if (!deniedPatterns) continue;
      for (const pattern of deniedPatterns) {
        if (globMatch(pattern, toolName)) return true;
      }
    }
    return false;
  }

  /**
   * Clear all pending requests, cancel their timers, and auto-deny them.
   * Any caller awaiting `requestApproval()` receives a `'no'` response.
   * Call during shutdown to prevent timer leaks and hanging promises.
   */
  dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      if (entry.escalationTimer) {
        clearTimeout(entry.escalationTimer);
      }
      entry.resolve(
        this.normalizeResponse(entry.request, {
          requestId: entry.request.id,
          disposition: "no",
          resolver: {
            actorId: "system:dispose",
            channel: "system",
            resolvedAt: this.now(),
          },
        }),
      );
    }
    this.pending.clear();
    this.denials.clear();
    this.elevations.clear();
  }

  /**
   * Get a snapshot of all pending approval requests.
   */
  getPending(): readonly ApprovalRequest[] {
    return [...this.pending.values()].map((e) => e.request);
  }

  private normalizeResponse(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): ApprovalResponse {
    const resolvedAt = response.resolver?.resolvedAt ?? this.now();
    const roles = normalizeResolverRoles(response.resolver?.roles);
    const actorId = response.resolver?.actorId ?? response.approvedBy;
    const sessionId = response.resolver?.sessionId;
    const channel = response.resolver?.channel;
    const assertion =
      this.resolverSigningKey !== undefined
        ? signResolverAssertion({
            signingKey: this.resolverSigningKey,
            requestId: request.id,
            disposition: response.disposition,
            actorId,
            sessionId,
            channel,
            roles,
            resolvedAt,
          })
        : response.resolver?.assertion;

    return {
      requestId: response.requestId,
      disposition: response.disposition,
      approvedBy: actorId,
      resolver: {
        ...(actorId ? { actorId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(channel ? { channel } : {}),
        ...(roles.length > 0 ? { roles } : {}),
        resolvedAt,
        ...(assertion ? { assertion } : {}),
      },
    };
  }

  private isResolutionAuthorized(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): boolean {
    const requiredRoles = request.requiredApproverRoles ?? [];
    if (requiredRoles.length === 0) {
      return true;
    }
    const resolverRoles = normalizeResolverRoles(response.resolver?.roles);
    if (resolverRoles.length === 0) {
      return false;
    }
    return requiredRoles.some((role) => resolverRoles.includes(role));
  }

  private async notifyHandlers(
    request: ApprovalRequest,
    response: ApprovalResponse,
  ): Promise<void> {
    for (const handler of this.responseHandlers) {
      try {
        await handler(request, response);
      } catch {
        // Notification failures must not block promise resolution
      }
    }
  }

  private async notifyRequestHandlers(request: ApprovalRequest): Promise<void> {
    for (const handler of this.requestHandlers) {
      try {
        await handler(request);
      } catch {
        // Request notifications must not block tool execution.
      }
    }
  }

  private async notifyEscalationHandlers(
    request: ApprovalRequest,
    escalation: ApprovalEscalation,
  ): Promise<void> {
    for (const handler of this.escalationHandlers) {
      try {
        await handler(request, escalation);
      } catch {
        // Escalation notifications must not block timer resolution.
      }
    }
  }

  private deny(sessionId: string, toolPattern: string): void {
    const normalizedSession = sessionId.trim();
    if (normalizedSession.length === 0) return;
    let patterns = this.denials.get(normalizedSession);
    if (!patterns) {
      patterns = new Set();
      this.denials.set(normalizedSession, patterns);
    }
    patterns.add(toolPattern);
  }

  private clearDeniedPattern(sessionId: string, toolPattern: string): void {
    const normalizedSession = sessionId.trim();
    if (normalizedSession.length === 0) return;
    const patterns = this.denials.get(normalizedSession);
    if (!patterns) return;
    patterns.delete(toolPattern);
    if (patterns.size === 0) {
      this.denials.delete(normalizedSession);
    }
  }
}

// ============================================================================
// Hook Factory
// ============================================================================

/**
 * Create the `approval-gate` HookHandler backed by an ApprovalEngine.
 *
 * The returned handler intercepts `tool:before` events at priority 5.
 * It checks session elevation first, then evaluates rules, and blocks
 * execution until approval is granted (or auto-denied on timeout).
 */
export function createApprovalGateHook(engine: ApprovalEngine): HookHandler {
  return {
    event: "tool:before",
    name: "approval-gate",
    priority: 5,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      const toolName = ctx.payload.toolName as string | undefined;
      const args = (ctx.payload.args as Record<string, unknown>) ?? {};
      const sessionId = (ctx.payload.sessionId as string) ?? "unknown";

      if (!toolName) {
        return { continue: true };
      }

      // Check if the tool is elevated for this session
      if (engine.isToolElevated(sessionId, toolName)) {
        return { continue: true };
      }

      // Check if the tool requires approval
      const rule = engine.requiresApproval(toolName, args);
      if (!rule) {
        return { continue: true };
      }

      // Create and submit approval request
      const message = rule.description
        ? `Approval required: ${rule.description}`
        : `Approval required for ${toolName}`;
      const request = engine.createRequest(
        toolName,
        args,
        sessionId,
        message,
        rule,
      );
      const response = await engine.requestApproval(request);

      if (response.disposition === "yes" || response.disposition === "always") {
        return { continue: true };
      }

      // Denied
      return {
        continue: false,
        payload: {
          ...ctx.payload,
          blocked: true,
          reason: `Tool "${toolName}" denied by approval policy`,
        },
      };
    },
  };
}
