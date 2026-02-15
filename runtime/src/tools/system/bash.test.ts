import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  createBashTool,
  isCommandAllowed,
  DEFAULT_DENY_LIST,
} from './bash.js';

function parseResult(result: { content: string }) {
  return JSON.parse(result.content);
}

describe('isCommandAllowed', () => {
  it('allows all commands with empty lists', () => {
    const result = isCommandAllowed('echo hello', [], []);
    expect(result.allowed).toBe(true);
  });

  it('denies command matching deny list', () => {
    const result = isCommandAllowed('rm -rf / --no-preserve-root');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('rm -rf /');
  });

  it('allows command matching allow list prefix', () => {
    const result = isCommandAllowed('echo hello world', ['echo', 'ls'], []);
    expect(result.allowed).toBe(true);
  });

  it('denies command not matching any allow list prefix', () => {
    const result = isCommandAllowed('cat /etc/passwd', ['echo', 'ls'], []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('allow list');
  });

  it('deny list takes precedence over allow list', () => {
    const result = isCommandAllowed(
      'rm -rf /',
      ['rm'],
      ['rm -rf /'],
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('deny');
  });

  it('default deny list includes dangerous commands', () => {
    for (const dangerous of ['rm -rf /', 'mkfs', 'shutdown', 'reboot', 'dd if=']) {
      const result = isCommandAllowed(dangerous);
      expect(result.allowed).toBe(false);
    }
  });
});

describe('DEFAULT_DENY_LIST', () => {
  it('contains expected dangerous patterns', () => {
    expect(DEFAULT_DENY_LIST).toContain('rm -rf /');
    expect(DEFAULT_DENY_LIST).toContain('rm -rf ~');
    expect(DEFAULT_DENY_LIST).toContain('mkfs');
    expect(DEFAULT_DENY_LIST).toContain('shutdown');
    expect(DEFAULT_DENY_LIST).toContain('reboot');
    expect(DEFAULT_DENY_LIST).toContain('dd if=');
    expect(DEFAULT_DENY_LIST.length).toBeGreaterThanOrEqual(10);
  });
});

describe('createBashTool', () => {
  it('matches Tool interface shape', () => {
    const tool = createBashTool();
    expect(tool.name).toBe('system.bash');
    expect(typeof tool.description).toBe('string');
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.execute).toBe('function');
    expect(tool.inputSchema.type).toBe('object');
  });

  it('executes simple command and returns stdout', async () => {
    const tool = createBashTool({ denyList: [] });
    const result = await tool.execute({ command: 'echo hello' });
    const parsed = parseResult(result);

    expect(parsed.stdout.trim()).toBe('hello');
    expect(parsed.exitCode).toBe(0);
    expect(result.isError).toBeFalsy();
  });

  it('captures stderr in result', async () => {
    const tool = createBashTool({ useShell: true, denyList: [] });
    const result = await tool.execute({ command: 'echo error-output >&2' });
    const parsed = parseResult(result);

    expect(parsed.stderr.trim()).toBe('error-output');
  });

  it('returns isError for non-zero exit code', async () => {
    const tool = createBashTool({ useShell: true, denyList: [] });
    const result = await tool.execute({ command: 'exit 42' });
    const parsed = parseResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.exitCode).not.toBe(0);
  });

  it('rejects denied command before execution', async () => {
    const tool = createBashTool();
    const result = await tool.execute({ command: 'rm -rf / --no-preserve-root' });

    expect(result.isError).toBe(true);
    const parsed = parseResult(result);
    expect(parsed.error).toContain('denied');
  });

  it('rejects empty command', async () => {
    const tool = createBashTool();
    const result = await tool.execute({ command: '' });

    expect(result.isError).toBe(true);
    const parsed = parseResult(result);
    expect(parsed.error).toContain('non-empty');
  });

  it('rejects non-string command', async () => {
    const tool = createBashTool();
    const result = await tool.execute({ command: 123 as unknown as string });

    expect(result.isError).toBe(true);
  });

  it('truncates output at maxOutputBytes', async () => {
    const tool = createBashTool({
      maxOutputBytes: 20,
      useShell: true,
      denyList: [],
    });
    // Generate output larger than 20 bytes
    const result = await tool.execute({
      command: 'echo "This is a long output string that exceeds the limit"',
    });
    const parsed = parseResult(result);

    expect(parsed.truncated).toBe(true);
    expect(parsed.stdout).toContain('[truncated]');
  });

  it('enforces timeout on long-running commands', async () => {
    const tool = createBashTool({
      timeoutMs: 200,
      useShell: true,
      denyList: [],
    });
    const result = await tool.execute({ command: 'sleep 30' });
    const parsed = parseResult(result);

    expect(result.isError).toBe(true);
    expect(parsed.timedOut).toBe(true);
    expect(parsed.durationMs).toBeLessThan(5000);
  }, 10_000);

  it('overrides cwd per-call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bash-tool-test-'));
    try {
      await writeFile(join(dir, 'marker.txt'), 'found', 'utf-8');
      const tool = createBashTool({ denyList: [] });
      const result = await tool.execute({ command: 'ls marker.txt', cwd: dir });
      const parsed = parseResult(result);

      expect(parsed.stdout.trim()).toBe('marker.txt');
      expect(parsed.exitCode).toBe(0);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it('useShell: false prevents shell expansion', async () => {
    const tool = createBashTool({ useShell: false, denyList: [] });
    // Without shell, glob patterns are not expanded by the shell
    const result = await tool.execute({ command: 'echo *' });
    const parsed = parseResult(result);

    // execFile passes '*' as a literal arg to echo, so output is '*'
    expect(parsed.stdout.trim()).toBe('*');
  });

  it('useShell: true enables shell features', async () => {
    const tool = createBashTool({ useShell: true, denyList: [] });
    // Pipe works in shell mode
    const result = await tool.execute({ command: 'echo hello | tr a-z A-Z' });
    const parsed = parseResult(result);

    expect(parsed.stdout.trim()).toBe('HELLO');
    expect(parsed.exitCode).toBe(0);
  });
});
