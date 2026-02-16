import { Writable } from 'node:stream';
import { rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgv } from '../src/cli/index.js';
import { runCli } from '../src/cli/index.js';
import * as cliReplay from '../src/cli/replay.js';

interface CliCapture {
  stream: Writable;
  getText: () => string;
}

function withCwd<T>(next: string, callback: () => Promise<T>): Promise<T> {
  const previous = process.cwd();
  process.chdir(next);
  return callback().finally(() => {
    process.chdir(previous);
  });
}

function writeJsonConfig(directory: string, body: Record<string, unknown>) {
  const path = join(directory, '.agenc-runtime.json');
  writeFileSync(path, JSON.stringify(body), 'utf8');
  return path;
}

function createTempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agenc-cli-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupEnv(keys: string[]) {
  const values = new Map<string, string | undefined>();
  for (const key of keys) {
    values.set(key, process.env[key]);
    process.env[key] = '';
  }
  return () => {
    for (const key of keys) {
      if (values.get(key) === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = values.get(key) as string;
      }
    }
  };
}

function createCapture(): CliCapture {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });

  return {
    stream,
    getText() {
      return chunks.join('');
    },
  };
}

async function runCliCapture(argv: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const stdout = createCapture();
  const stderr = createCapture();

  const code = await runCli({
    argv,
    stdout: stdout.stream,
    stderr: stderr.stream,
  });

  return {
    code,
    stdout: stdout.getText(),
    stderr: stderr.getText(),
  };
}

describe('runtime cli foundation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const stubReplayBackfill = (): void => {
    const store = cliReplay.createReplayStore({ storeType: 'memory' });
    vi.spyOn(cliReplay, 'createReplayStore').mockReturnValue(store);
    vi.spyOn(cliReplay, 'createOnChainReplayBackfillFetcher').mockReturnValue({
      fetchPage: async () => ({
        events: [],
        nextCursor: null,
        done: true,
      }),
    });
  };

  it('parses short and long options in a deterministic record', () => {
    const parsed = parseArgv([
      'replay',
      'backfill',
      '--to-slot',
      '1024',
      '--page-size',
      '25',
      '-h',
      '--output',
      'table',
      '--strict-mode',
      'true',
      '--store-type',
      'memory',
    ]);

    expect(parsed.positional).toEqual(['replay', 'backfill']);
    expect(parsed.flags['to-slot']).toBe(1024);
    expect(parsed.flags['page-size']).toBe(25);
    expect(parsed.flags.h).toBe(true);
    expect(parsed.flags.output).toBe('table');
    expect(parsed.flags['strict-mode']).toBe(true);
    expect(parsed.flags['store-type']).toBe('memory');
  });

  it('renders command-line help with no arguments', async () => {
    const result = await runCliCapture([]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('agenc-runtime [--help] [--config <path>]');
    expect(result.stdout).toContain('Replay subcommands:');
    expect(result.stdout).toContain('backfill');
  });

  it('returns a machine-readable error payload for unknown root command', async () => {
    const result = await runCliCapture(['nonexistent-command']);

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr.trim()) as { status: string; code: string; message: string };

    expect(payload.status).toBe('error');
    expect(payload.code).toBe('UNKNOWN_COMMAND');
  });

  it('requires replay subcommand when root command is provided', async () => {
    const result = await runCliCapture(['replay']);

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr.trim()) as { status: string; code: string; message: string };

    expect(payload.code).toBe('MISSING_REPLAY_COMMAND');
    expect(payload.message).toContain('missing replay subcommand');
  });

  it('enforces backfill required arguments', async () => {
    const result = await runCliCapture(['replay', 'backfill']);

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr.trim()) as { status: string; code: string; message: string };

    expect(payload.code).toBe('MISSING_REQUIRED_OPTION');
    expect(payload.message).toContain('--to-slot');
  });

  it('enforces compare required local-trace-path', async () => {
    const result = await runCliCapture(['replay', 'compare']);

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr.trim()) as { status: string; code: string; message: string };

    expect(payload.code).toBe('MISSING_REQUIRED_OPTION');
    expect(payload.message).toContain('--local-trace-path');
  });

  it('requires incident target identifier', async () => {
    const result = await runCliCapture(['replay', 'incident']);

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr.trim()) as { status: string; code: string; message: string };

    expect(payload.code).toBe('MISSING_TARGET');
    expect(payload.message).toContain('--task-pda');
  });

  it('uses strict validation error for invalid backfill window values', async () => {
    const result = await runCliCapture(['replay', 'backfill', '--to-slot', '0']);

    expect(result.code).toBe(2);
    const payload = JSON.parse(result.stderr.trim()) as { status: string; code: string; message: string };

    expect(payload.code).toBe('MISSING_REQUIRED_OPTION');
  });

  it('loads cli defaults from config file', async () => {
    const workspace = createTempWorkspace();
    stubReplayBackfill();
    writeJsonConfig(workspace, {
      rpcUrl: 'https://config.rpc',
      storeType: 'memory',
      strictMode: true,
      idempotencyWindow: 123,
    });

    const result = await withCwd(workspace, () => runCliCapture([
      'replay',
      'backfill',
      '--to-slot',
      '123',
      '--rpc',
      'https://config.rpc',
    ]));

    const parsed = JSON.parse(result.stdout.trim()) as {
      status: string;
      command: string;
      strictMode: boolean;
      storeType: 'memory' | 'sqlite';
    };

    expect(result.code).toBe(0);
    expect(parsed.status).toBe('ok');
    expect(parsed.command).toBe('replay.backfill');
    expect(parsed.strictMode).toBe(true);
    expect(parsed.storeType).toBe('memory');

    rmSync(workspace, { recursive: true, force: true });
  });

  it('resolves env and CLI precedence for runtime options', async () => {
    const workspace = createTempWorkspace();
    writeJsonConfig(workspace, {
      storeType: 'memory',
    });

    const restore = cleanupEnv([
      'AGENC_RUNTIME_STORE_TYPE',
      'AGENC_RUNTIME_RPC_URL',
      'AGENC_RUNTIME_STRICT_MODE',
      'AGENC_RUNTIME_IDEMPOTENCY_WINDOW',
    ]);
    process.env.AGENC_RUNTIME_STORE_TYPE = 'sqlite';
    process.env.AGENC_RUNTIME_STRICT_MODE = 'false';
    process.env.AGENC_RUNTIME_IDEMPOTENCY_WINDOW = '321';
    delete process.env.AGENC_RUNTIME_RPC_URL;

    stubReplayBackfill();

    try {
      const result = await withCwd(workspace, () => runCliCapture([
        'replay',
        'backfill',
        '--to-slot',
        '321',
        '--store-type',
        'memory',
        '--rpc',
        'https://cli.rpc',
      ]));

      const parsed = JSON.parse(result.stdout.trim()) as {
        status: string;
        command: string;
        strictMode: boolean;
        storeType: 'memory' | 'sqlite';
      };

      expect(result.code).toBe(0);
      expect(parsed.strictMode).toBe(false);
      expect(parsed.storeType).toBe('memory');
    } finally {
      restore();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('returns a structured error when config file cannot be parsed', async () => {
    const workspace = createTempWorkspace();
    const path = join(workspace, '.agenc-runtime.json');
    writeFileSync(path, '{invalid-json', 'utf8');

    const result = await withCwd(workspace, () => runCliCapture(['replay', 'backfill', '--to-slot', '12']));

    const payload = JSON.parse(result.stderr.trim()) as { status: string; code: string; message: string };

    expect(result.code).toBe(2);
    expect(payload.status).toBe('error');
    expect(payload.code).toBe('CONFIG_PARSE_ERROR');

    rmSync(workspace, { recursive: true, force: true });
  });
});
