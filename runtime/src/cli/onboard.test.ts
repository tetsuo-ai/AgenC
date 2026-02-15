import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntimeContext, OnboardOptions } from './types.js';
import { runOnboardCommand } from './onboard.js';

function createContextCapture(): { context: CliRuntimeContext; outputs: unknown[]; errors: unknown[] } {
  const outputs: unknown[] = [];
  const errors: unknown[] = [];
  return {
    context: {
      logger: {
        error: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
      },
      outputFormat: 'json',
      output: (value) => outputs.push(value),
      error: (value) => errors.push(value),
    },
    outputs,
    errors,
  };
}

describe('onboard cli command', () => {
  let workspace = '';
  let configPath = '';
  let keypairPath = '';

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'agenc-onboard-'));
    configPath = join(workspace, 'runtime-config.json');
    keypairPath = join(workspace, 'id.json');
    writeFileSync(keypairPath, '[]', 'utf8');
    process.env.SOLANA_KEYPAIR_PATH = keypairPath;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
    delete process.env.SOLANA_KEYPAIR_PATH;
  });

  it('onboard generates config when no existing config is present', async () => {
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(123);

    const { context, outputs } = createContextCapture();
    const options: OnboardOptions = {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      rpcUrl: 'http://rpc.example',
      programId: undefined,
      storeType: 'sqlite',
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      nonInteractive: true,
      force: false,
    };

    const code = await runOnboardCommand(context, options);
    expect(code).toBe(0);
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf8')) as any;
    expect(written.rpcUrl).toBe('http://rpc.example');
    expect(written.storeType).toBe('sqlite');
    expect(typeof written.sqlitePath).toBe('string');
    expect(written.logLevel).toBe('info');
    expect(written.outputFormat).toBe('json');
    expect(written.strictMode).toBe(false);

    const payload = outputs[0] as any;
    expect(payload.command).toBe('onboard');
    expect(payload.result.configGenerated).toBe(true);
    expect(payload.result.exitCode).toBe(0);
  });

  it('onboard skips existing config when --force is not provided', async () => {
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(123);
    writeFileSync(configPath, JSON.stringify({ rpcUrl: 'http://old.example', sentinel: 'keep' }, null, 2), 'utf8');

    const { context, outputs } = createContextCapture();
    const options: OnboardOptions = {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      rpcUrl: 'http://rpc.example',
      programId: undefined,
      storeType: 'sqlite',
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      nonInteractive: true,
      force: false,
    };

    const code = await runOnboardCommand(context, options);
    expect(code).toBe(1);

    const written = JSON.parse(readFileSync(configPath, 'utf8')) as any;
    expect(written.sentinel).toBe('keep');

    const payload = outputs[0] as any;
    expect(payload.result.configGenerated).toBe(false);
    const existsCheck = payload.result.checks.find((c: any) => c.id === 'config.exists');
    expect(existsCheck.status).toBe('warn');
  });

  it('onboard overwrites existing config when --force is provided', async () => {
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(123);
    writeFileSync(configPath, JSON.stringify({ rpcUrl: 'http://old.example', sentinel: 'clobber' }, null, 2), 'utf8');

    const { context, outputs } = createContextCapture();
    const options: OnboardOptions = {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      rpcUrl: 'http://new.example',
      programId: undefined,
      storeType: 'sqlite',
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      nonInteractive: true,
      force: true,
    };

    const code = await runOnboardCommand(context, options);
    expect(code).toBe(0);

    const written = JSON.parse(readFileSync(configPath, 'utf8')) as any;
    expect(written.rpcUrl).toBe('http://new.example');
    expect(written.sentinel).toBeUndefined();

    const payload = outputs[0] as any;
    expect(payload.result.configGenerated).toBe(true);
    expect(payload.result.exitCode).toBe(0);
  });
});

