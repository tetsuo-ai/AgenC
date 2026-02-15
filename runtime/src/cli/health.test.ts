import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Connection } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntimeContext, DoctorOptions, HealthOptions } from './types.js';
import { runDoctorCommand, runHealthCommand } from './health.js';

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

function writeConfig(path: string, body: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(body, null, 2), 'utf8');
}

describe('health cli commands', () => {
  let workspace = '';
  let keypairPath = '';
  let configPath = '';

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'agenc-health-'));
    keypairPath = join(workspace, 'id.json');
    configPath = join(workspace, '.agenc-runtime.json');
    writeFileSync(keypairPath, '[]', 'utf8');
    writeConfig(configPath, {
      rpcUrl: 'http://rpc.example',
      storeType: 'memory',
      outputFormat: 'json',
      strictMode: false,
      idempotencyWindow: 900,
    });
    process.env.SOLANA_KEYPAIR_PATH = keypairPath;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
    delete process.env.SOLANA_KEYPAIR_PATH;
  });

  it('health: RPC reachable (mocked) returns exit code 0 when all checks pass', async () => {
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(123);

    const { context, outputs } = createContextCapture();
    const options: HealthOptions = {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      rpcUrl: 'http://rpc.example',
      programId: undefined,
      storeType: 'memory',
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      nonInteractive: true,
      deep: false,
    };

    const code = await runHealthCommand(context, options);
    expect(code).toBe(0);

    const payload = outputs[0] as any;
    expect(payload.command).toBe('health');
    expect(payload.report.exitCode).toBe(0);
    expect(payload.report.status).toBe('healthy');
  });

  it('health: RPC unreachable (mocked) returns exit code 2', async () => {
    vi.spyOn(Connection.prototype, 'getSlot').mockRejectedValue(new Error('nope'));

    const { context, outputs } = createContextCapture();
    const options: HealthOptions = {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      rpcUrl: 'http://rpc.example',
      programId: undefined,
      storeType: 'memory',
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      nonInteractive: true,
      deep: false,
    };

    const code = await runHealthCommand(context, options);
    expect(code).toBe(2);

    const payload = outputs[0] as any;
    const rpc = payload.report.checks.find((c: any) => c.id === 'rpc.reachable');
    expect(rpc.status).toBe('fail');
  });

  it('health: sqlite store directory missing yields fail with mkdir remediation', async () => {
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(123);
    const missingDir = join(workspace, 'missing-store');
    const sqlitePath = join(missingDir, 'replay.sqlite');

    const { context, outputs } = createContextCapture();
    const options: HealthOptions = {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      rpcUrl: 'http://rpc.example',
      programId: undefined,
      storeType: 'sqlite',
      sqlitePath,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      nonInteractive: true,
      deep: false,
    };

    const code = await runHealthCommand(context, options);
    expect(code).toBe(2);

    const payload = outputs[0] as any;
    const store = payload.report.checks.find((c: any) => c.id === 'store.directory');
    expect(store.status).toBe('fail');
    expect(store.remediation).toContain('mkdir -p');
  });

  it('health: deep mode adds rpc latency and store integrity checks', async () => {
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(123);

    const { context, outputs } = createContextCapture();
    const options: HealthOptions = {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      rpcUrl: 'http://rpc.example',
      programId: undefined,
      storeType: 'memory',
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      nonInteractive: true,
      deep: true,
    };

    const code = await runHealthCommand(context, options);
    expect(code).toBe(0);

    const payload = outputs[0] as any;
    const ids = new Set(payload.report.checks.map((c: any) => c.id));
    expect(ids.has('rpc.latency')).toBe(true);
    expect(ids.has('store.integrity')).toBe(true);
  });

  it('doctor: warnings only returns exit code 1', async () => {
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(123);
    process.env.SOLANA_KEYPAIR_PATH = join(workspace, 'missing-id.json');

    const { context, outputs } = createContextCapture();
    const options: DoctorOptions = {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      rpcUrl: 'http://rpc.example',
      programId: undefined,
      storeType: 'memory',
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      nonInteractive: true,
      deep: false,
      fix: false,
    };

    const code = await runDoctorCommand(context, options);
    expect(code).toBe(1);

    const payload = outputs[0] as any;
    expect(payload.command).toBe('doctor');
    expect(payload.report.exitCode).toBe(1);
    expect(Array.isArray(payload.recommendations)).toBe(true);
  });

  it('doctor: failures return exit code 2', async () => {
    vi.spyOn(Connection.prototype, 'getSlot').mockRejectedValue(new Error('nope'));

    const { context, outputs } = createContextCapture();
    const options: DoctorOptions = {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      rpcUrl: 'http://rpc.example',
      programId: undefined,
      storeType: 'memory',
      sqlitePath: undefined,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      nonInteractive: true,
      deep: false,
      fix: false,
    };

    const code = await runDoctorCommand(context, options);
    expect(code).toBe(2);

    const payload = outputs[0] as any;
    expect(payload.report.status).toBe('unhealthy');
  });

  it('doctor: --fix attempts to create sqlite store directory when missing', async () => {
    vi.spyOn(Connection.prototype, 'getSlot').mockResolvedValue(123);
    const missingDir = join(workspace, 'missing-store-fix');
    const sqlitePath = join(missingDir, 'replay.sqlite');

    const { context, outputs } = createContextCapture();
    const options: DoctorOptions = {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      rpcUrl: 'http://rpc.example',
      programId: undefined,
      storeType: 'sqlite',
      sqlitePath,
      traceId: undefined,
      idempotencyWindow: 900,
      configPath,
      nonInteractive: true,
      deep: false,
      fix: true,
    };

    const code = await runDoctorCommand(context, options);
    expect(code).toBe(0);
    expect(existsSync(missingDir)).toBe(true);

    const payload = outputs[0] as any;
    const storeDir = payload.report.checks.find((c: any) => c.id === 'store.directory');
    expect(storeDir.status).toBe('pass');
    expect(storeDir.message).toContain('auto-fixed');
  });
});
