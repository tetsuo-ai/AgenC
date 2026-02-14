/**
 * Tests for Incident Role-Based Access Control
 *
 * @module
 */

import { describe, it, expect } from 'vitest';
import {
  ROLE_HIERARCHY,
  hasPermission,
  canExecuteCommand,
  canInvokeMcpTool,
  getPermissionsForRole,
  getCommandsForRole,
  getMcpToolsForRole,
  parseRole,
  isValidRole,
  enforcePermission,
  enforceCommand,
  enforceMcpTool,
  type OperatorRole,
} from './incident-roles.js';

describe('Incident Roles', () => {
  describe('Role Hierarchy', () => {
    it('defines correct hierarchy levels', () => {
      expect(ROLE_HIERARCHY.read).toBe(1);
      expect(ROLE_HIERARCHY.investigate).toBe(2);
      expect(ROLE_HIERARCHY.execute).toBe(3);
      expect(ROLE_HIERARCHY.admin).toBe(4);
    });

    it('admin has highest level', () => {
      const roles: OperatorRole[] = ['read', 'investigate', 'execute', 'admin'];
      const sorted = roles.sort((a, b) => ROLE_HIERARCHY[b] - ROLE_HIERARCHY[a]);
      expect(sorted[0]).toBe('admin');
    });
  });

  describe('hasPermission', () => {
    it('read role has view permissions', () => {
      expect(hasPermission('read', 'view_incidents')).toBe(true);
      expect(hasPermission('read', 'run_comparisons')).toBe(true);
      expect(hasPermission('read', 'export_data')).toBe(true);
    });

    it('read role lacks investigate permissions', () => {
      expect(hasPermission('read', 'annotate')).toBe(false);
      expect(hasPermission('read', 'backfill')).toBe(false);
    });

    it('investigate role has read + investigate permissions', () => {
      expect(hasPermission('investigate', 'view_incidents')).toBe(true);
      expect(hasPermission('investigate', 'annotate')).toBe(true);
      expect(hasPermission('investigate', 'backfill')).toBe(true);
    });

    it('investigate role lacks execute permissions', () => {
      expect(hasPermission('investigate', 'resolve')).toBe(false);
      expect(hasPermission('investigate', 'archive')).toBe(false);
    });

    it('execute role has all except admin permissions', () => {
      expect(hasPermission('execute', 'view_incidents')).toBe(true);
      expect(hasPermission('execute', 'annotate')).toBe(true);
      expect(hasPermission('execute', 'resolve')).toBe(true);
      expect(hasPermission('execute', 'archive')).toBe(true);
      expect(hasPermission('execute', 'configure')).toBe(false);
    });

    it('admin has all permissions', () => {
      expect(hasPermission('admin', 'view_incidents')).toBe(true);
      expect(hasPermission('admin', 'annotate')).toBe(true);
      expect(hasPermission('admin', 'resolve')).toBe(true);
      expect(hasPermission('admin', 'configure')).toBe(true);
      expect(hasPermission('admin', 'manage_roles')).toBe(true);
    });
  });

  describe('canExecuteCommand', () => {
    it('read role can list and view', () => {
      expect(canExecuteCommand('read', 'incident:list')).toBe(true);
      expect(canExecuteCommand('read', 'incident:view')).toBe(true);
      expect(canExecuteCommand('read', 'incident:export')).toBe(true);
    });

    it('read role cannot annotate', () => {
      expect(canExecuteCommand('read', 'incident:annotate')).toBe(false);
    });

    it('investigate role can annotate', () => {
      expect(canExecuteCommand('investigate', 'incident:annotate')).toBe(true);
      expect(canExecuteCommand('investigate', 'incident:backfill')).toBe(true);
    });

    it('execute role can resolve', () => {
      expect(canExecuteCommand('execute', 'incident:resolve')).toBe(true);
      expect(canExecuteCommand('execute', 'incident:archive')).toBe(true);
    });

    it('only admin can configure', () => {
      expect(canExecuteCommand('read', 'incident:configure')).toBe(false);
      expect(canExecuteCommand('investigate', 'incident:configure')).toBe(false);
      expect(canExecuteCommand('execute', 'incident:configure')).toBe(false);
      expect(canExecuteCommand('admin', 'incident:configure')).toBe(true);
    });
  });

  describe('canInvokeMcpTool', () => {
    it('read role can invoke view tools', () => {
      expect(canInvokeMcpTool('read', 'replay_list_incidents')).toBe(true);
      expect(canInvokeMcpTool('read', 'replay_view_incident')).toBe(true);
      expect(canInvokeMcpTool('read', 'replay_export')).toBe(true);
    });

    it('investigate role can invoke annotation tools', () => {
      expect(canInvokeMcpTool('investigate', 'replay_annotate')).toBe(true);
      expect(canInvokeMcpTool('investigate', 'replay_backfill')).toBe(true);
    });

    it('execute role can invoke resolve tools', () => {
      expect(canInvokeMcpTool('execute', 'replay_resolve')).toBe(true);
      expect(canInvokeMcpTool('execute', 'replay_archive')).toBe(true);
    });
  });

  describe('getPermissionsForRole', () => {
    it('returns all permissions for admin', () => {
      const permissions = getPermissionsForRole('admin');
      expect(permissions).toContain('view_incidents');
      expect(permissions).toContain('annotate');
      expect(permissions).toContain('resolve');
      expect(permissions).toContain('configure');
      expect(permissions).toContain('manage_roles');
    });

    it('returns subset for read role', () => {
      const permissions = getPermissionsForRole('read');
      expect(permissions).toContain('view_incidents');
      expect(permissions).not.toContain('annotate');
      expect(permissions).not.toContain('configure');
    });
  });

  describe('getCommandsForRole', () => {
    it('returns view commands for read role', () => {
      const commands = getCommandsForRole('read');
      expect(commands).toContain('incident:list');
      expect(commands).toContain('incident:view');
      expect(commands).not.toContain('incident:resolve');
    });
  });

  describe('getMcpToolsForRole', () => {
    it('returns view tools for read role', () => {
      const tools = getMcpToolsForRole('read');
      expect(tools).toContain('replay_list_incidents');
      expect(tools).not.toContain('replay_resolve');
    });
  });

  describe('parseRole', () => {
    it('parses valid roles', () => {
      expect(parseRole('read')).toBe('read');
      expect(parseRole('investigate')).toBe('investigate');
      expect(parseRole('execute')).toBe('execute');
      expect(parseRole('admin')).toBe('admin');
    });

    it('handles case insensitivity', () => {
      expect(parseRole('READ')).toBe('read');
      expect(parseRole('Admin')).toBe('admin');
    });

    it('returns null for invalid roles', () => {
      expect(parseRole('invalid')).toBeNull();
      expect(parseRole('')).toBeNull();
    });
  });

  describe('isValidRole', () => {
    it('validates role strings', () => {
      expect(isValidRole('read')).toBe(true);
      expect(isValidRole('admin')).toBe(true);
      expect(isValidRole('invalid')).toBe(false);
    });
  });

  describe('enforcePermission', () => {
    it('allows valid permission', () => {
      const result = enforcePermission('admin', 'configure');
      expect(result.allowed).toBe(true);
      expect(result.message).toContain('Access granted');
    });

    it('denies invalid permission', () => {
      const result = enforcePermission('read', 'configure');
      expect(result.allowed).toBe(false);
      expect(result.message).toContain('Access denied');
      expect(result.requiredRole).toBe('admin');
    });
  });

  describe('enforceCommand', () => {
    it('enforces command permissions', () => {
      const allowed = enforceCommand('execute', 'incident:resolve');
      expect(allowed.allowed).toBe(true);

      const denied = enforceCommand('read', 'incident:resolve');
      expect(denied.allowed).toBe(false);
    });
  });

  describe('enforceMcpTool', () => {
    it('enforces MCP tool permissions', () => {
      const allowed = enforceMcpTool('investigate', 'replay_annotate');
      expect(allowed.allowed).toBe(true);

      const denied = enforceMcpTool('read', 'replay_annotate');
      expect(denied.allowed).toBe(false);
    });
  });
});
