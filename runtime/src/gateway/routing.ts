/**
 * Message routing engine for multi-agent workspaces.
 *
 * Routes incoming {@link GatewayMessage}s to target workspace IDs based on
 * configurable, priority-ordered rules with glob/regex matching.
 *
 * Precedence (matching the spec): peer > guildId > accountId > channel > scope > contentPattern > default.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';
import { globMatch } from './approvals.js';
import { WORKSPACE_ID_PATTERN, MAX_WORKSPACE_ID_LENGTH } from './workspace.js';
import type { GatewayMessage } from './message.js';

// ============================================================================
// Constants
// ============================================================================

/**
 * Specificity weights per match field.
 * Used with MAX (not SUM) so that peer always beats guildId, etc.
 */
const SPECIFICITY_WEIGHTS: Readonly<Record<keyof RoutingMatch, number>> = {
  peer: 6,
  guildId: 5,
  accountId: 4,
  channel: 3,
  scope: 2,
  contentPattern: 1,
};

const VALID_SCOPES: ReadonlySet<string> = new Set(['dm', 'group', 'thread']);

// ============================================================================
// Types
// ============================================================================

/** Match conditions for a routing rule. All defined fields are ANDed. */
export interface RoutingMatch {
  /** Glob pattern matched against message senderId. */
  readonly peer?: string;
  /** Glob pattern matched against message metadata.guildId. */
  readonly guildId?: string;
  /** Glob pattern matched against message identityId. */
  readonly accountId?: string;
  /** Glob pattern matched against message channel name. */
  readonly channel?: string;
  /** Exact match against message scope. */
  readonly scope?: 'dm' | 'group' | 'thread';
  /** Regex pattern matched against message content. */
  readonly contentPattern?: string;
}

/** A routing rule that maps matching messages to a workspace. */
export interface RoutingRule {
  /** Unique rule name (used as key for removeRule). */
  readonly name: string;
  /** Match conditions. Empty object matches everything (catch-all). */
  readonly match: RoutingMatch;
  /** Target workspace ID. */
  readonly workspace: string;
  /** Priority — higher values are evaluated first. */
  readonly priority: number;
}

// ============================================================================
// Error class
// ============================================================================

/** Thrown when a routing rule fails validation. */
export class RoutingValidationError extends RuntimeError {
  public readonly field: string;
  public readonly reason: string;

  constructor(field: string, reason: string) {
    super(
      `Routing rule validation failed: ${field} — ${reason}`,
      RuntimeErrorCodes.GATEWAY_VALIDATION_ERROR,
    );
    this.name = 'RoutingValidationError';
    this.field = field;
    this.reason = reason;
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

function computeSpecificity(match: RoutingMatch): number {
  let max = 0;
  for (const key of Object.keys(match) as Array<keyof RoutingMatch>) {
    if (match[key] !== undefined) {
      const w = SPECIFICITY_WEIGHTS[key];
      if (w > max) max = w;
    }
  }
  return max;
}

function compareRules(a: RoutingRule, b: RoutingRule): number {
  // Higher priority first
  if (a.priority !== b.priority) return b.priority - a.priority;
  // Higher specificity first
  const sa = computeSpecificity(a.match);
  const sb = computeSpecificity(b.match);
  if (sa !== sb) return sb - sa;
  // Alphabetical by name for determinism
  return a.name.localeCompare(b.name);
}

function matchesRule(
  rule: RoutingRule,
  message: GatewayMessage,
  regexCache: ReadonlyMap<string, RegExp>,
): boolean {
  const m = rule.match;

  if (m.peer !== undefined) {
    if (!globMatch(m.peer, message.senderId)) return false;
  }

  if (m.guildId !== undefined) {
    const guildId = message.metadata?.guildId;
    if (typeof guildId !== 'string') return false;
    if (!globMatch(m.guildId, guildId)) return false;
  }

  if (m.accountId !== undefined) {
    if (message.identityId === undefined) return false;
    if (!globMatch(m.accountId, message.identityId)) return false;
  }

  if (m.channel !== undefined) {
    if (!globMatch(m.channel, message.channel)) return false;
  }

  if (m.scope !== undefined) {
    if (m.scope !== message.scope) return false;
  }

  if (m.contentPattern !== undefined) {
    const regex = regexCache.get(rule.name);
    if (!regex || !regex.test(message.content)) return false;
  }

  return true;
}

function validateWorkspaceId(id: string, field: string): void {
  if (!WORKSPACE_ID_PATTERN.test(id)) {
    throw new RoutingValidationError(field, `Invalid workspace ID "${id}" — must match ${WORKSPACE_ID_PATTERN}`);
  }
  if (id.length > MAX_WORKSPACE_ID_LENGTH) {
    throw new RoutingValidationError(field, `Workspace ID exceeds maximum length of ${MAX_WORKSPACE_ID_LENGTH} characters`);
  }
}

function validateRule(rule: RoutingRule, existingNames: ReadonlySet<string>): void {
  if (typeof rule.name !== 'string' || rule.name.length === 0) {
    throw new RoutingValidationError('name', 'Rule name must be a non-empty string');
  }
  if (existingNames.has(rule.name)) {
    throw new RoutingValidationError('name', `Duplicate rule name "${rule.name}"`);
  }
  validateWorkspaceId(rule.workspace, 'workspace');
  if (typeof rule.priority !== 'number' || !Number.isFinite(rule.priority)) {
    throw new RoutingValidationError('priority', 'Priority must be a finite number');
  }
  if (rule.match.scope !== undefined && !VALID_SCOPES.has(rule.match.scope)) {
    throw new RoutingValidationError('match.scope', `Invalid scope "${rule.match.scope}" — must be one of: dm, group, thread`);
  }
  if (rule.match.contentPattern !== undefined) {
    try {
      new RegExp(rule.match.contentPattern);
    } catch {
      throw new RoutingValidationError('match.contentPattern', `Invalid regex: "${rule.match.contentPattern}"`);
    }
  }
}

// ============================================================================
// MessageRouter
// ============================================================================

/**
 * Routes incoming gateway messages to workspace IDs based on configurable rules.
 *
 * Rules are evaluated in priority order (highest first). Among equal-priority
 * rules, the most specific match dimension wins (peer > guildId > accountId >
 * channel > scope > contentPattern). A final alphabetical tiebreak ensures
 * deterministic ordering.
 */
export class MessageRouter {
  private readonly rules: RoutingRule[] = [];
  private sorted: readonly RoutingRule[] = [];
  private readonly defaultWorkspace: string;
  private readonly nameSet = new Set<string>();
  private regexCache = new Map<string, RegExp>();

  constructor(rules: readonly RoutingRule[], defaultWorkspace: string) {
    validateWorkspaceId(defaultWorkspace, 'defaultWorkspace');
    this.defaultWorkspace = defaultWorkspace;

    for (const rule of rules) {
      validateRule(rule, this.nameSet);
      this.rules.push(rule);
      this.nameSet.add(rule.name);
    }

    this.rebuild();
  }

  /** Route a message to a workspace ID. Returns the default workspace if no rule matches. */
  route(message: GatewayMessage): string {
    for (const rule of this.sorted) {
      if (matchesRule(rule, message, this.regexCache)) {
        return rule.workspace;
      }
    }
    return this.defaultWorkspace;
  }

  /** Add a rule. Throws {@link RoutingValidationError} on invalid input or duplicate name. */
  addRule(rule: RoutingRule): void {
    validateRule(rule, this.nameSet);
    this.rules.push(rule);
    this.nameSet.add(rule.name);
    this.rebuild();
  }

  /** Remove a rule by name. Returns true if the rule existed. */
  removeRule(name: string): boolean {
    const idx = this.rules.findIndex((r) => r.name === name);
    if (idx === -1) return false;
    this.rules.splice(idx, 1);
    this.nameSet.delete(name);
    this.rebuild();
    return true;
  }

  /** Return a frozen copy of the current rules (unsorted, insertion order). */
  getRules(): readonly RoutingRule[] {
    return Object.freeze([...this.rules]);
  }

  // --------------------------------------------------------------------------
  // Private
  // --------------------------------------------------------------------------

  private rebuild(): void {
    this.sorted = [...this.rules].sort(compareRules);

    const cache = new Map<string, RegExp>();
    for (const rule of this.rules) {
      if (rule.match.contentPattern !== undefined) {
        cache.set(rule.name, new RegExp(rule.match.contentPattern));
      }
    }
    this.regexCache = cache;
  }
}
