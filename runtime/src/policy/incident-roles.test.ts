import { describe, expect, it } from 'vitest';
import {
  ROLE_PERMISSION_MATRIX,
  enforceRole,
  IncidentRoleViolationError,
  isCommandAllowed,
  type IncidentCommandCategory,
  type OperatorRole,
} from './incident-roles.js';

const ROLES: OperatorRole[] = ['read', 'investigate', 'execute', 'admin'];
const COMMANDS: IncidentCommandCategory[] = [
  'replay.backfill',
  'replay.compare',
  'replay.incident',
  'replay.export',
  'incident.annotate',
  'incident.resolve',
  'incident.archive',
  'config.update',
  'policy.update',
];

describe('incident-roles', () => {
  it('defines permissions for every role x command combination', () => {
    for (const role of ROLES) {
      for (const command of COMMANDS) {
        const matches = ROLE_PERMISSION_MATRIX.filter((entry) => entry.role === role && entry.command === command);
        expect(matches).toHaveLength(1);
      }
    }
  });

  it('read role cannot mutate', () => {
    expect(isCommandAllowed('read', 'incident.resolve')).toBe(false);
  });

  it('admin can do everything', () => {
    for (const command of COMMANDS) {
      expect(isCommandAllowed('admin', command)).toBe(true);
    }
  });

  it('role escalation is blocked', () => {
    expect(isCommandAllowed('investigate', 'config.update')).toBe(false);
  });

  it('enforceRole throws IncidentRoleViolationError', () => {
    expect(() => enforceRole('read', 'replay.backfill')).toThrow(IncidentRoleViolationError);
  });

  it('IncidentRoleViolationError exposes role and command', () => {
    try {
      enforceRole('read', 'replay.backfill');
    } catch (error) {
      const violation = error as IncidentRoleViolationError;
      expect(violation.role).toBe('read');
      expect(violation.command).toBe('replay.backfill');
    }
  });
});

