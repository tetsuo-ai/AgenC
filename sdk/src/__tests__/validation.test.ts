import { describe, it, expect } from 'vitest';
import { validateCircuitPath } from '../validation';

describe('validateCircuitPath (#963)', () => {
  it('rejects empty string', () => {
    expect(() => validateCircuitPath('')).toThrow('cannot be empty');
  });

  it('rejects whitespace-only string', () => {
    expect(() => validateCircuitPath('   ')).toThrow('cannot be empty');
  });

  it('rejects path exceeding 512 characters', () => {
    expect(() => validateCircuitPath('a'.repeat(513))).toThrow('maximum length');
  });

  it('rejects absolute path', () => {
    expect(() => validateCircuitPath('/etc/passwd')).toThrow('Absolute');
  });

  it('rejects path traversal', () => {
    expect(() => validateCircuitPath('../../../etc/passwd')).toThrow('traversal');
  });

  it('rejects shell metacharacters', () => {
    expect(() => validateCircuitPath('path; rm -rf /')).toThrow('disallowed characters');
    expect(() => validateCircuitPath('path$(cmd)')).toThrow('disallowed characters');
    expect(() => validateCircuitPath('path`cmd`')).toThrow('disallowed characters');
  });

  it('accepts valid relative path', () => {
    expect(() => validateCircuitPath('./circuits/task_completion')).not.toThrow();
  });

  it('accepts path with hyphens and underscores', () => {
    expect(() => validateCircuitPath('my-circuits/task_completion')).not.toThrow();
  });
});
