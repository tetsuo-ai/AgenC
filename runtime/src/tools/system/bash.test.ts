import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createBashTool } from './bash.js';
import { DEFAULT_DENY_LIST } from './types.js';

// Mock execFile from node:child_process
vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';

const mockExecFile = vi.mocked(execFile);

function parseContent(result: { content: string }): Record<string, unknown> {
  return JSON.parse(result.content) as Record<string, unknown>;
}

/** Simulate a successful execFile callback. */
function mockSuccess(stdout = '', stderr = '') {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as Function)(null, stdout, stderr);
    return {} as ReturnType<typeof execFile>;
  });
}

/** Simulate an error execFile callback. */
function mockError(error: Partial<Error & { killed?: boolean; code?: unknown }>, stdout = '', stderr = '') {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    const err = Object.assign(new Error(error.message ?? 'command failed'), error);
    (callback as Function)(err, stdout, stderr);
    return {} as ReturnType<typeof execFile>;
  });
}

describe('system.bash tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---- Basic execution ----

  it('executes allowed command and returns stdout/stderr/exitCode', async () => {
    const tool = createBashTool();
    mockSuccess('hello world\n', '');

    const result = await tool.execute({ command: 'echo', args: ['hello', 'world'] });
    const parsed = parseContent(result);

    expect(result.isError).toBeUndefined();
    expect(parsed.exitCode).toBe(0);
    expect(parsed.stdout).toBe('hello world\n');
    expect(parsed.stderr).toBe('');
  });

  it('passes command and args to execFile correctly', async () => {
    const tool = createBashTool({ cwd: '/tmp' });
    mockSuccess();

    await tool.execute({ command: 'git', args: ['status', '--short'] });

    expect(mockExecFile).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toEqual(['status', '--short']);
    expect((opts as Record<string, unknown>).cwd).toBe('/tmp');
    expect((opts as Record<string, unknown>).shell).toBe(false);
  });

  // ---- Deny list ----

  it('rejects command on default deny list', async () => {
    const tool = createBashTool();

    for (const cmd of DEFAULT_DENY_LIST) {
      const result = await tool.execute({ command: cmd });
      expect(result.isError).toBe(true);
      const parsed = parseContent(result);
      expect(parsed.error).toContain('denied');
    }

    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('rejects command on custom deny list', async () => {
    const tool = createBashTool({ denyList: ['curl', 'wget'] });

    const result = await tool.execute({ command: 'curl' });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain('denied');
  });

  it('merges custom deny list with default deny list', async () => {
    const tool = createBashTool({ denyList: ['custom-bad'] });

    // Default deny list still works
    const result1 = await tool.execute({ command: 'rm' });
    expect(result1.isError).toBe(true);

    // Custom deny list also works
    const result2 = await tool.execute({ command: 'custom-bad' });
    expect(result2.isError).toBe(true);
  });

  // ---- Allow list ----

  it('allows command on allow list', async () => {
    const tool = createBashTool({ allowList: ['ls', 'cat'] });
    mockSuccess('file.txt\n');

    const result = await tool.execute({ command: 'ls' });
    expect(result.isError).toBeUndefined();
    expect(parseContent(result).exitCode).toBe(0);
  });

  it('rejects command not on allow list when allow list is non-empty', async () => {
    const tool = createBashTool({ allowList: ['ls', 'cat'] });

    const result = await tool.execute({ command: 'git' });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain('not in the allow list');
  });

  // ---- Working directory ----

  it('uses config cwd when no per-call cwd', async () => {
    const tool = createBashTool({ cwd: '/home/test' });
    mockSuccess();

    await tool.execute({ command: 'ls' });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.cwd).toBe('/home/test');
  });

  it('uses per-call cwd override', async () => {
    const tool = createBashTool({ cwd: '/home/test' });
    mockSuccess();

    await tool.execute({ command: 'ls', cwd: '/var/log' });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.cwd).toBe('/var/log');
  });

  // ---- Timeout ----

  it('enforces timeout on execFile error with killed flag', async () => {
    const tool = createBashTool({ timeoutMs: 1000 });
    mockError({ message: 'Command timed out', killed: true });

    const result = await tool.execute({ command: 'sleep', args: ['60'] });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result);
    expect(parsed.timedOut).toBe(true);
  });

  it('uses default timeout when none specified', async () => {
    const tool = createBashTool();
    mockSuccess();

    await tool.execute({ command: 'ls' });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.timeout).toBe(30_000);
  });

  it('uses per-call timeout override', async () => {
    const tool = createBashTool({ timeoutMs: 5000 });
    mockSuccess();

    await tool.execute({ command: 'ls', timeoutMs: 10000 });

    const opts = mockExecFile.mock.calls[0][2] as Record<string, unknown>;
    expect(opts.timeout).toBe(10000);
  });

  // ---- Output truncation ----

  it('truncates stdout exceeding maxOutputBytes', async () => {
    const tool = createBashTool({ maxOutputBytes: 20 });
    const longOutput = 'a'.repeat(100);
    mockSuccess(longOutput);

    const result = await tool.execute({ command: 'cat' });
    const parsed = parseContent(result);
    const stdout = parsed.stdout as string;
    expect(stdout).toContain('[truncated]');
    expect(stdout.length).toBeLessThan(longOutput.length);
  });

  it('truncates stderr exceeding maxOutputBytes', async () => {
    const tool = createBashTool({ maxOutputBytes: 20 });
    const longStderr = 'e'.repeat(100);
    mockSuccess('', longStderr);

    const result = await tool.execute({ command: 'cat' });
    const parsed = parseContent(result);
    const stderr = parsed.stderr as string;
    expect(stderr).toContain('[truncated]');
    expect(stderr.length).toBeLessThan(longStderr.length);
  });

  // ---- Input validation ----

  it('returns error for empty command', async () => {
    const tool = createBashTool();

    const result = await tool.execute({ command: '' });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain('non-empty string');
  });

  it('returns error for non-string command', async () => {
    const tool = createBashTool();

    const result = await tool.execute({ command: 123 as unknown as string });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain('non-empty string');
  });

  it('returns error for non-array args', async () => {
    const tool = createBashTool();

    const result = await tool.execute({ command: 'ls', args: 'not-an-array' as unknown as string[] });
    expect(result.isError).toBe(true);
    expect(parseContent(result).error).toContain('array of strings');
  });

  // ---- Schema ----

  it('returns correct inputSchema', () => {
    const tool = createBashTool();

    expect(tool.name).toBe('system.bash');
    expect(tool.inputSchema).toBeDefined();
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['command']);
    const props = schema.properties as Record<string, unknown>;
    expect(props.command).toBeDefined();
    expect(props.args).toBeDefined();
    expect(props.cwd).toBeDefined();
    expect(props.timeoutMs).toBeDefined();
  });

  // ---- Error execution ----

  it('returns isError true with exit code on command failure', async () => {
    const tool = createBashTool();
    mockError({ message: 'command not found', code: 127 as unknown as string }, '', 'command not found');

    const result = await tool.execute({ command: 'nonexistent' });
    expect(result.isError).toBe(true);
    const parsed = parseContent(result);
    expect(parsed.exitCode).toBe(127);
    expect(parsed.timedOut).toBe(false);
  });
});
