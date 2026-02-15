/**
 * Incident operator roles and permission enforcement.
 *
 * @module
 */

/** Operator role for incident investigation workflow. */
export type OperatorRole = 'read' | 'investigate' | 'execute' | 'admin';

/** Command categories for permission mapping. */
export type IncidentCommandCategory =
  | 'replay.backfill'
  | 'replay.compare'
  | 'replay.incident'
  | 'replay.export'
  | 'incident.annotate'
  | 'incident.resolve'
  | 'incident.archive'
  | 'config.update'
  | 'policy.update';

/** Permission entry: whether a role can invoke a command category. */
export interface RolePermission {
  role: OperatorRole;
  command: IncidentCommandCategory;
  allowed: boolean;
}

/** Static role-to-permission matrix. */
export const ROLE_PERMISSION_MATRIX: ReadonlyArray<RolePermission> = [
  // read: can view incidents, run compare, view backfill status
  { role: 'read', command: 'replay.incident', allowed: true },
  { role: 'read', command: 'replay.compare', allowed: true },
  { role: 'read', command: 'replay.backfill', allowed: false },
  { role: 'read', command: 'replay.export', allowed: true },
  { role: 'read', command: 'incident.annotate', allowed: false },
  { role: 'read', command: 'incident.resolve', allowed: false },
  { role: 'read', command: 'incident.archive', allowed: false },
  { role: 'read', command: 'config.update', allowed: false },
  { role: 'read', command: 'policy.update', allowed: false },

  // investigate: read + annotate + backfill
  { role: 'investigate', command: 'replay.incident', allowed: true },
  { role: 'investigate', command: 'replay.compare', allowed: true },
  { role: 'investigate', command: 'replay.backfill', allowed: true },
  { role: 'investigate', command: 'replay.export', allowed: true },
  { role: 'investigate', command: 'incident.annotate', allowed: true },
  { role: 'investigate', command: 'incident.resolve', allowed: false },
  { role: 'investigate', command: 'incident.archive', allowed: false },
  { role: 'investigate', command: 'config.update', allowed: false },
  { role: 'investigate', command: 'policy.update', allowed: false },

  // execute: investigate + resolve + archive
  { role: 'execute', command: 'replay.incident', allowed: true },
  { role: 'execute', command: 'replay.compare', allowed: true },
  { role: 'execute', command: 'replay.backfill', allowed: true },
  { role: 'execute', command: 'replay.export', allowed: true },
  { role: 'execute', command: 'incident.annotate', allowed: true },
  { role: 'execute', command: 'incident.resolve', allowed: true },
  { role: 'execute', command: 'incident.archive', allowed: true },
  { role: 'execute', command: 'config.update', allowed: false },
  { role: 'execute', command: 'policy.update', allowed: false },

  // admin: full access
  { role: 'admin', command: 'replay.incident', allowed: true },
  { role: 'admin', command: 'replay.compare', allowed: true },
  { role: 'admin', command: 'replay.backfill', allowed: true },
  { role: 'admin', command: 'replay.export', allowed: true },
  { role: 'admin', command: 'incident.annotate', allowed: true },
  { role: 'admin', command: 'incident.resolve', allowed: true },
  { role: 'admin', command: 'incident.archive', allowed: true },
  { role: 'admin', command: 'config.update', allowed: true },
  { role: 'admin', command: 'policy.update', allowed: true },
] as const;

export function isCommandAllowed(role: OperatorRole, command: IncidentCommandCategory): boolean {
  const entry = ROLE_PERMISSION_MATRIX.find((permission) => permission.role === role && permission.command === command);
  return entry?.allowed ?? false;
}

export class IncidentRoleViolationError extends Error {
  readonly role: OperatorRole;
  readonly command: IncidentCommandCategory;

  constructor(role: OperatorRole, command: IncidentCommandCategory) {
    super(`Role "${role}" is not permitted to run "${command}"`);
    this.name = 'IncidentRoleViolationError';
    this.role = role;
    this.command = command;
  }
}

export function enforceRole(role: OperatorRole, command: IncidentCommandCategory): void {
  if (!isCommandAllowed(role, command)) {
    throw new IncidentRoleViolationError(role, command);
  }
}

