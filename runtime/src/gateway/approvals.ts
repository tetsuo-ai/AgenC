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

import type { HookHandler, HookContext, HookResult } from './hooks.js';

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
  /** Human-readable message describing what needs approval. */
  readonly message: string;
  /** Timestamp when the request was created. */
  readonly createdAt: number;
  /** The rule that triggered this request. */
  readonly rule: ApprovalRule;
}

/** The disposition of an approval response. */
export type ApprovalDisposition = 'yes' | 'no' | 'always';

/** Response to an approval request. */
export interface ApprovalResponse {
  /** The request being responded to. */
  readonly requestId: string;
  /** Approval disposition. */
  readonly disposition: ApprovalDisposition;
  /** Who approved/denied (optional). */
  readonly approvedBy?: string;
}

/** Configuration for the ApprovalEngine (with injectable deps for testing). */
export interface ApprovalEngineConfig {
  /** Approval rules. */
  readonly rules?: readonly ApprovalRule[];
  /** Timeout for pending requests in ms (default: 300_000). */
  readonly timeoutMs?: number;
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
 * Escapes regex special chars, then replaces `*` with `.*`.
 */
export function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
  return regex.test(value);
}

/**
 * Extract a numeric "amount" from tool arguments.
 * Checks `amount`, `reward`, and `lamports` keys. Handles string coercion.
 */
export function extractAmount(args: Record<string, unknown>): number | undefined {
  for (const key of ['amount', 'reward', 'lamports']) {
    const val = args[key];
    if (val === undefined || val === null || val === '') continue;
    const num = typeof val === 'number' ? val : Number(val);
    if (!Number.isNaN(num)) return num;
  }
  return undefined;
}

// ============================================================================
// Default Rules
// ============================================================================

/** Built-in approval rules for common dangerous operations. */
export const DEFAULT_APPROVAL_RULES: readonly ApprovalRule[] = [
  {
    tool: 'system.bash',
    description: 'Shell command execution',
  },
  {
    tool: 'system.delete',
    description: 'File deletion',
  },
  {
    tool: 'system.evaluateJs',
    description: 'JavaScript evaluation',
  },
  {
    tool: 'wallet.sign',
    description: 'Wallet transaction signing',
  },
  {
    tool: 'wallet.transfer',
    conditions: { minAmount: 0.1 },
    description: 'SOL transfer exceeding 0.1',
  },
  {
    tool: 'agenc.createTask',
    conditions: { minAmount: 1_000_000_000 },
    description: 'Task creation with reward exceeding 1 SOL',
  },
  {
    tool: 'agenc.registerAgent',
    description: 'Agent registration with staked SOL',
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
}

export type ApprovalResponseHandler = (request: ApprovalRequest, response: ApprovalResponse) => void;

/**
 * Approval engine that evaluates tool invocations against configured rules,
 * manages pending approval requests, and supports per-session elevation.
 */
export class ApprovalEngine {
  private readonly rules: readonly ApprovalRule[];
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly responseHandlers: ApprovalResponseHandler[] = [];
  private readonly elevations = new Map<string, Set<string>>();
  private idCounter = 0;

  constructor(config?: ApprovalEngineConfig) {
    this.rules = config?.rules ?? DEFAULT_APPROVAL_RULES;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = config?.now ?? Date.now;
    this.generateId = config?.generateId ?? (() => `approval-${Date.now()}-${++this.idCounter}`);
  }

  /**
   * Check whether a tool invocation requires approval.
   * Returns the first matching rule, or `null` if none match.
   */
  requiresApproval(toolName: string, args: Record<string, unknown>): ApprovalRule | null {
    for (const rule of this.rules) {
      if (!globMatch(rule.tool, toolName)) continue;

      if (rule.conditions) {
        // Check minAmount condition
        if (rule.conditions.minAmount !== undefined) {
          const amount = extractAmount(args);
          if (amount === undefined || amount <= rule.conditions.minAmount) continue;
        }

        // Check argPatterns condition
        if (rule.conditions.argPatterns) {
          let allMatch = true;
          for (const [key, pattern] of Object.entries(rule.conditions.argPatterns)) {
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
  ): ApprovalRequest {
    return {
      id: this.generateId(),
      toolName,
      args,
      sessionId,
      message,
      createdAt: this.now(),
      rule,
    };
  }

  /**
   * Submit an approval request and wait for resolution.
   * Auto-denies after the configured timeout.
   */
  requestApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    return new Promise<ApprovalResponse>((resolve) => {
      const timer = setTimeout(() => {
        const response: ApprovalResponse = {
          requestId: request.id,
          disposition: 'no',
        };
        this.pending.delete(request.id);
        this.notifyHandlers(request, response);
        resolve(response);
      }, this.timeoutMs);

      this.pending.set(request.id, { request, resolve, timer });
    });
  }

  /**
   * Resolve a pending approval request.
   * If disposition is `'always'`, elevates the session for the tool's pattern.
   */
  resolve(requestId: string, response: ApprovalResponse): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(requestId);

    if (response.disposition === 'always') {
      this.elevate(entry.request.sessionId, entry.request.rule.tool);
    }

    this.notifyHandlers(entry.request, response);
    entry.resolve(response);
  }

  /**
   * Register a callback invoked whenever an approval response is resolved.
   */
  onResponse(handler: ApprovalResponseHandler): void {
    this.responseHandlers.push(handler);
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
   * Clear all pending requests, cancel their timers, and auto-deny them.
   * Any caller awaiting `requestApproval()` receives a `'no'` response.
   * Call during shutdown to prevent timer leaks and hanging promises.
   */
  dispose(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve({ requestId: entry.request.id, disposition: 'no' });
    }
    this.pending.clear();
  }

  /**
   * Get a snapshot of all pending approval requests.
   */
  getPending(): readonly ApprovalRequest[] {
    return [...this.pending.values()].map((e) => e.request);
  }

  private notifyHandlers(request: ApprovalRequest, response: ApprovalResponse): void {
    for (const handler of this.responseHandlers) {
      try {
        handler(request, response);
      } catch {
        // Notification failures must not block promise resolution
      }
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
    event: 'tool:before',
    name: 'approval-gate',
    priority: 5,
    handler: async (ctx: HookContext): Promise<HookResult> => {
      const toolName = ctx.payload.toolName as string | undefined;
      const args = (ctx.payload.args as Record<string, unknown>) ?? {};
      const sessionId = (ctx.payload.sessionId as string) ?? 'unknown';

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
      const request = engine.createRequest(toolName, args, sessionId, message, rule);
      const response = await engine.requestApproval(request);

      if (response.disposition === 'yes' || response.disposition === 'always') {
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
