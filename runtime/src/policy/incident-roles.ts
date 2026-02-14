/**
 * Incident Role-Based Access Control - Operator role definitions and permission matrix.
 *
 * Implements #993 P2-504: Role-aware incident workflow + immutable audit trail
 *
 * @module
 */

/**
 * Four-level operator role hierarchy.
 */
export type OperatorRole = 'read' | 'investigate' | 'execute' | 'admin';

/**
 * Role hierarchy levels (higher number = more permissions).
 */
export const ROLE_HIERARCHY: Record<OperatorRole, number> = {
  read: 1,
  investigate: 2,
  execute: 3,
  admin: 4,
};

/**
 * Permission types for incident commands.
 */
export type IncidentPermission =
  | 'view_incidents'
  | 'run_comparisons'
  | 'export_data'
  | 'annotate'
  | 'backfill'
  | 'resolve'
  | 'archive'
  | 'configure'
  | 'manage_roles';

/**
 * CLI commands mapped to permissions.
 */
export type IncidentCommand =
  | 'incident:list'
  | 'incident:view'
  | 'incident:compare'
  | 'incident:export'
  | 'incident:annotate'
  | 'incident:backfill'
  | 'incident:resolve'
  | 'incident:archive'
  | 'incident:configure'
  | 'incident:roles';

/**
 * MCP tools mapped to permissions.
 */
export type McpTool =
  | 'replay_list_incidents'
  | 'replay_view_incident'
  | 'replay_compare'
  | 'replay_export'
  | 'replay_annotate'
  | 'replay_backfill'
  | 'replay_resolve'
  | 'replay_archive';

/**
 * Permission to required role mapping.
 */
export const PERMISSION_REQUIREMENTS: Record<IncidentPermission, OperatorRole> = {
  view_incidents: 'read',
  run_comparisons: 'read',
  export_data: 'read',
  annotate: 'investigate',
  backfill: 'investigate',
  resolve: 'execute',
  archive: 'execute',
  configure: 'admin',
  manage_roles: 'admin',
};

/**
 * CLI command to permission mapping.
 */
export const COMMAND_PERMISSIONS: Record<IncidentCommand, IncidentPermission> = {
  'incident:list': 'view_incidents',
  'incident:view': 'view_incidents',
  'incident:compare': 'run_comparisons',
  'incident:export': 'export_data',
  'incident:annotate': 'annotate',
  'incident:backfill': 'backfill',
  'incident:resolve': 'resolve',
  'incident:archive': 'archive',
  'incident:configure': 'configure',
  'incident:roles': 'manage_roles',
};

/**
 * MCP tool to permission mapping.
 */
export const MCP_TOOL_PERMISSIONS: Record<McpTool, IncidentPermission> = {
  replay_list_incidents: 'view_incidents',
  replay_view_incident: 'view_incidents',
  replay_compare: 'run_comparisons',
  replay_export: 'export_data',
  replay_annotate: 'annotate',
  replay_backfill: 'backfill',
  replay_resolve: 'resolve',
  replay_archive: 'archive',
};

/**
 * Check if a role has a specific permission.
 */
export function hasPermission(role: OperatorRole, permission: IncidentPermission): boolean {
  const requiredRole = PERMISSION_REQUIREMENTS[permission];
  return ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[requiredRole];
}

/**
 * Check if a role can execute a CLI command.
 */
export function canExecuteCommand(role: OperatorRole, command: IncidentCommand): boolean {
  const permission = COMMAND_PERMISSIONS[command];
  return hasPermission(role, permission);
}

/**
 * Check if a role can invoke an MCP tool.
 */
export function canInvokeMcpTool(role: OperatorRole, tool: McpTool): boolean {
  const permission = MCP_TOOL_PERMISSIONS[tool];
  return hasPermission(role, permission);
}

/**
 * Get all permissions for a role.
 */
export function getPermissionsForRole(role: OperatorRole): IncidentPermission[] {
  const permissions: IncidentPermission[] = [];
  for (const [permission, requiredRole] of Object.entries(PERMISSION_REQUIREMENTS)) {
    if (ROLE_HIERARCHY[role] >= ROLE_HIERARCHY[requiredRole]) {
      permissions.push(permission as IncidentPermission);
    }
  }
  return permissions;
}

/**
 * Get all commands a role can execute.
 */
export function getCommandsForRole(role: OperatorRole): IncidentCommand[] {
  const commands: IncidentCommand[] = [];
  for (const [command, permission] of Object.entries(COMMAND_PERMISSIONS)) {
    if (hasPermission(role, permission)) {
      commands.push(command as IncidentCommand);
    }
  }
  return commands;
}

/**
 * Get all MCP tools a role can invoke.
 */
export function getMcpToolsForRole(role: OperatorRole): McpTool[] {
  const tools: McpTool[] = [];
  for (const [tool, permission] of Object.entries(MCP_TOOL_PERMISSIONS)) {
    if (hasPermission(role, permission)) {
      tools.push(tool as McpTool);
    }
  }
  return tools;
}

/**
 * Parse role from string (for CLI --role flag).
 */
export function parseRole(value: string): OperatorRole | null {
  const normalized = value.toLowerCase().trim();
  if (normalized === 'read' || normalized === 'investigate' || normalized === 'execute' || normalized === 'admin') {
    return normalized;
  }
  return null;
}

/**
 * Validate role string.
 */
export function isValidRole(value: string): value is OperatorRole {
  return parseRole(value) !== null;
}

/**
 * Role enforcement result.
 */
export interface RoleEnforcementResult {
  allowed: boolean;
  role: OperatorRole;
  requiredRole: OperatorRole;
  permission: IncidentPermission;
  message: string;
}

/**
 * Enforce role for a permission check.
 */
export function enforcePermission(
  role: OperatorRole,
  permission: IncidentPermission,
): RoleEnforcementResult {
  const requiredRole = PERMISSION_REQUIREMENTS[permission];
  const allowed = hasPermission(role, permission);

  return {
    allowed,
    role,
    requiredRole,
    permission,
    message: allowed
      ? `Access granted: ${permission}`
      : `Access denied: ${permission} requires ${requiredRole} role (current: ${role})`,
  };
}

/**
 * Enforce role for a CLI command.
 */
export function enforceCommand(
  role: OperatorRole,
  command: IncidentCommand,
): RoleEnforcementResult {
  const permission = COMMAND_PERMISSIONS[command];
  return enforcePermission(role, permission);
}

/**
 * Enforce role for an MCP tool.
 */
export function enforceMcpTool(
  role: OperatorRole,
  tool: McpTool,
): RoleEnforcementResult {
  const permission = MCP_TOOL_PERMISSIONS[tool];
  return enforcePermission(role, permission);
}
