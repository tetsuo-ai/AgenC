import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { createBashTool } from './bash.js';
import type { BashToolOutput } from './types.js';

function parseOutput(content: string): BashToolOutput & { error?: string } {
  return JSON.parse(content);
}

describe('system.bash tool', () => {
  let workspace = '';

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'agenc-bash-tool-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('executes an allowed command and returns stdout', async () => {
    const tool = createBashTool({ cwd: workspace });
    const result = await tool.execute({ command: 'echo', args: ['hello world'] });

    expect(result.isError).toBeFalsy();
    const output = parseOutput(result.content);
    expect(output.exitCode).toBe(0);
    expect(output.stdout.trim()).toBe('hello world');
    expect(output.timedOut).toBe(false);
    expect(output.truncated).toBe(false);
  });

  it('returns exit code and stderr on command failure', async () => {
    const tool = createBashTool({ cwd: workspace });
    const result = await tool.execute({ command: 'ls', args: ['/nonexistent-path-xyz'] });

    expect(result.isError).toBe(true);
    const output = parseOutput(result.content);
    expect(output.exitCode).not.toBe(0);
    expect(output.stderr.length).toBeGreaterThan(0);
  });

  it('rejects commands on the deny list', async () => {
    const tool = createBashTool({
      denyList: ['rm -rf /', 'dd'],
    });
    const result = await tool.execute({ command: 'dd', args: ['if=/dev/zero'] });

    expect(result.isError).toBe(true);
    const output = parseOutput(result.content);
    expect(output.error).toContain('blocked by deny list');
  });

  it('rejects commands not on allow list when allow list is set', async () => {
    const tool = createBashTool({
      allowList: ['echo', 'ls'],
    });
    const result = await tool.execute({ command: 'cat', args: ['/etc/passwd'] });

    expect(result.isError).toBe(true);
    const output = parseOutput(result.content);
    expect(output.error).toContain('not on allow list');
  });

  it('allows commands on allow list', async () => {
    const tool = createBashTool({
      allowList: ['echo', 'ls'],
      cwd: workspace,
    });
    const result = await tool.execute({ command: 'echo', args: ['allowed'] });

    expect(result.isError).toBeFalsy();
    const output = parseOutput(result.content);
    expect(output.stdout.trim()).toBe('allowed');
  });

  it('enforces timeout', async () => {
    const tool = createBashTool({ timeoutMs: 100, cwd: workspace });
    const result = await tool.execute({ command: 'sleep', args: ['10'] });

    expect(result.isError).toBe(true);
    const output = parseOutput(result.content);
    expect(output.timedOut).toBe(true);
  });

  it('truncates output exceeding maxOutputBytes', async () => {
    const tool = createBashTool({ maxOutputBytes: 50, cwd: workspace });
    // Generate output larger than 50 bytes
    const result = await tool.execute({
      command: 'printf',
      args: ['%0.s-', ...Array.from({ length: 100 }, () => 'x')],
    });

    const output = parseOutput(result.content);
    if (output.stdout.length > 0) {
      expect(output.truncated).toBe(true);
      expect(output.stdout).toContain('[truncated]');
    }
  });

  it('rejects empty command', async () => {
    const tool = createBashTool();
    const result = await tool.execute({ command: '' });

    expect(result.isError).toBe(true);
    const output = parseOutput(result.content);
    expect(output.error).toContain('non-empty string');
  });

  it('rejects nonexistent working directory', async () => {
    const tool = createBashTool();
    const result = await tool.execute({
      command: 'echo',
      args: ['test'],
      cwd: '/nonexistent-directory-xyz',
    });

    expect(result.isError).toBe(true);
    const output = parseOutput(result.content);
    expect(output.error).toContain('does not exist');
  });

  it('uses cwd override from input', async () => {
    const tool = createBashTool({ cwd: '/' });
    const result = await tool.execute({
      command: 'pwd',
      cwd: workspace,
    });

    expect(result.isError).toBeFalsy();
    const output = parseOutput(result.content);
    expect(output.stdout.trim()).toBe(workspace);
  });

  it('prevents shell injection via args', async () => {
    const tool = createBashTool({ cwd: workspace });
    // execFile does not interpret shell metacharacters
    const result = await tool.execute({
      command: 'echo',
      args: ['hello; rm -rf /'],
    });

    expect(result.isError).toBeFalsy();
    const output = parseOutput(result.content);
    // The semicolon and rm are treated as literal text
    expect(output.stdout.trim()).toBe('hello; rm -rf /');
  });

  it('default deny list blocks rm -rf /', async () => {
    const tool = createBashTool();
    const result = await tool.execute({ command: 'rm', args: ['-rf', '/'] });

    expect(result.isError).toBe(true);
    const output = parseOutput(result.content);
    expect(output.error).toContain('blocked by deny list');
  });

  it('has correct tool name and schema', () => {
    const tool = createBashTool();
    expect(tool.name).toBe('system.bash');
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.required).toContain('command');
  });

  it('handles command not found gracefully', async () => {
    const tool = createBashTool({ cwd: workspace });
    const result = await tool.execute({ command: 'nonexistent_command_xyz_123' });

    expect(result.isError).toBe(true);
    const output = parseOutput(result.content);
    expect(output.exitCode).not.toBe(0);
  });
});
