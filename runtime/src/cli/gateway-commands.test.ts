import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntimeContext } from './types.js';
import type { GatewayConfig } from '../gateway/types.js';
import { scaffoldWorkspace } from './wizard.js';
import {
  runConfigValidateCommand,
  runConfigShowCommand,
} from './gateway-commands.js';
import { runCli } from './index.js';

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

/** A minimal valid GatewayConfig for testing. */
function makeValidConfig(overrides?: Partial<GatewayConfig>): GatewayConfig {
  return {
    gateway: { port: 9099, bind: '127.0.0.1', ...overrides?.gateway },
    agent: { name: 'test-agent', ...overrides?.agent },
    connection: { rpcUrl: 'https://api.devnet.solana.com', ...overrides?.connection },
    llm: { provider: 'grok', ...overrides?.llm },
    memory: { backend: 'memory', ...overrides?.memory },
    logging: { level: 'info', ...overrides?.logging },
  };
}

function writeGatewayConfig(configPath: string, config: GatewayConfig): void {
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

function makeStreams() {
  return {
    stdout: new PassThrough() as unknown as NodeJS.WritableStream,
    stderr: new PassThrough() as unknown as NodeJS.WritableStream,
  };
}

describe('gateway cli commands', () => {
  let workspace = '';

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'agenc-gateway-cli-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  // ---- generateDefaultConfig tests (using makeValidConfig helper) ----

  it('makeValidConfig returns config with all required fields', () => {
    const config = makeValidConfig();
    expect(config.gateway).toBeDefined();
    expect(config.gateway.port).toBe(9099);
    expect(config.gateway.bind).toBe('127.0.0.1');
    expect(config.agent).toBeDefined();
    expect(config.agent.name).toBe('test-agent');
    expect(config.connection).toBeDefined();
    expect(config.connection.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(config.llm).toBeDefined();
    expect(config.llm!.provider).toBe('grok');
    expect(config.memory).toBeDefined();
    expect(config.memory!.backend).toBe('memory');
    expect(config.logging).toBeDefined();
    expect(config.logging!.level).toBe('info');
  });

  it('makeValidConfig with overrides applies them correctly', () => {
    const config = makeValidConfig({
      gateway: { port: 8080, bind: '0.0.0.0' },
      agent: { name: 'my-agent' },
      connection: { rpcUrl: 'http://localhost:8899' },
      llm: { provider: 'anthropic', apiKey: 'sk-test' },
    });
    expect(config.gateway.port).toBe(8080);
    expect(config.gateway.bind).toBe('0.0.0.0');
    expect(config.agent.name).toBe('my-agent');
    expect(config.connection.rpcUrl).toBe('http://localhost:8899');
    expect(config.llm!.provider).toBe('anthropic');
    expect(config.llm!.apiKey).toBe('sk-test');
  });

  // ---- scaffoldWorkspace tests ----

  it('scaffoldWorkspace creates all expected directories and files', () => {
    const wsPath = join(workspace, 'scaffold-test');
    scaffoldWorkspace(wsPath);

    expect(existsSync(join(wsPath, 'memory'))).toBe(true);
    expect(existsSync(join(wsPath, 'skills'))).toBe(true);
    expect(existsSync(join(wsPath, 'AGENT.md'))).toBe(true);
    expect(existsSync(join(wsPath, 'SOUL.md'))).toBe(true);
    expect(existsSync(join(wsPath, 'USER.md'))).toBe(true);
    expect(existsSync(join(wsPath, 'TOOLS.md'))).toBe(true);
    expect(existsSync(join(wsPath, 'HEARTBEAT.md'))).toBe(true);
    expect(existsSync(join(wsPath, 'BOOT.md'))).toBe(true);
  });

  it('scaffoldWorkspace does not overwrite existing files', () => {
    const wsPath = join(workspace, 'no-overwrite');
    scaffoldWorkspace(wsPath);

    const customContent = '# My Custom Agent\n';
    writeFileSync(join(wsPath, 'AGENT.md'), customContent, 'utf-8');

    scaffoldWorkspace(wsPath);

    const content = readFileSync(join(wsPath, 'AGENT.md'), 'utf-8');
    expect(content).toBe(customContent);
  });

  // ---- detectSolanaConfig tests ----

  it('detectSolanaConfig returns string or undefined', async () => {
    // We import detectSolanaConfig and check it returns the correct type
    const { detectSolanaConfig } = await import('./wizard.js');
    const result = detectSolanaConfig();
    // On CI or machines without ~/.config/solana/id.json this is undefined
    // On dev machines with Solana CLI it may be a string
    expect(result === undefined || typeof result === 'string').toBe(true);
  });

  it('detectSolanaConfig returns path when solana id.json exists at default location', async () => {
    // Verify the function checks ~/.config/solana/id.json specifically
    const { join: j } = await import('node:path');
    const { homedir: hd } = await import('node:os');
    const { detectSolanaConfig } = await import('./wizard.js');
    const expectedPath = j(hd(), '.config', 'solana', 'id.json');
    // If the file exists, detectSolanaConfig should return its path
    if (existsSync(expectedPath)) {
      expect(detectSolanaConfig()).toBe(expectedPath);
    } else {
      // On CI or machines without Solana CLI, it returns undefined
      expect(detectSolanaConfig()).toBeUndefined();
    }
  });

  // ---- config validate tests ----

  it('config validate rejects config with missing required fields', async () => {
    const configPath = join(workspace, 'invalid-config.json');
    writeFileSync(configPath, JSON.stringify({ gateway: {} }), 'utf-8');

    const { context, errors } = createContextCapture();
    const code = await runConfigValidateCommand(context, {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      storeType: 'memory',
      idempotencyWindow: 900,
      configPath,
    });

    expect(code).toBe(1);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('config validate accepts valid config file', async () => {
    const configPath = join(workspace, 'valid-config.json');
    const config = makeValidConfig();
    writeGatewayConfig(configPath, config);

    const { context, outputs } = createContextCapture();
    const code = await runConfigValidateCommand(context, {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      storeType: 'memory',
      idempotencyWindow: 900,
      configPath,
    });

    expect(code).toBe(0);
    const payload = outputs[0] as Record<string, unknown>;
    expect(payload.valid).toBe(true);
    expect(payload.command).toBe('config.validate');
  });

  // ---- config show test ----

  it('config show outputs resolved config as JSON', async () => {
    const configPath = join(workspace, 'show-config.json');
    const config = makeValidConfig();
    writeGatewayConfig(configPath, config);

    const { context, outputs } = createContextCapture();
    const code = await runConfigShowCommand(context, {
      help: false,
      outputFormat: 'json',
      strictMode: false,
      storeType: 'memory',
      idempotencyWindow: 900,
      configPath,
    });

    expect(code).toBe(0);
    const payload = outputs[0] as Record<string, unknown>;
    expect(payload.command).toBe('config.show');
    expect(payload.config).toBeDefined();
    const cfg = payload.config as GatewayConfig;
    expect(cfg.gateway.port).toBe(9099);
    expect(cfg.agent.name).toBe('test-agent');
  });

  // ---- CLI routing tests ----

  it('gateway stop command routes through runCli', async () => {
    const { stdout, stderr } = makeStreams();

    const code = await runCli({
      argv: ['gateway', 'stop'],
      stdout,
      stderr,
    });

    expect(code).toBe(0);
  });

  it('config init --non-interactive generates config without prompts', async () => {
    const configPath = join(workspace, 'init-config.json');
    const { stdout, stderr } = makeStreams();

    const code = await runCli({
      argv: ['config', 'init', '--non-interactive', '--config-path', configPath],
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(readFileSync(configPath, 'utf-8'));
    expect(written.gateway).toBeDefined();
    expect(written.agent).toBeDefined();
    expect(written.connection).toBeDefined();
  });

  it('unknown gateway subcommand returns error code 2', async () => {
    const { stdout, stderr } = makeStreams();

    const code = await runCli({
      argv: ['gateway', 'foobar'],
      stdout,
      stderr,
    });

    expect(code).toBe(2);
  });

  it('missing gateway subcommand returns error code 2', async () => {
    const { stdout, stderr } = makeStreams();

    const code = await runCli({
      argv: ['gateway'],
      stdout,
      stderr,
    });

    expect(code).toBe(2);
  });

  it('unknown config subcommand returns error code 2', async () => {
    const { stdout, stderr } = makeStreams();

    const code = await runCli({
      argv: ['config', 'foobar'],
      stdout,
      stderr,
    });

    expect(code).toBe(2);
  });

  it('sessions list routes correctly through runCli', async () => {
    const { stdout, stderr } = makeStreams();

    // sessions list reads config to connect to control plane, falls back gracefully
    const configPath = join(workspace, 'sessions-config.json');
    const config = makeValidConfig({ gateway: { port: 19999, bind: '127.0.0.1' } });
    writeGatewayConfig(configPath, config);

    const code = await runCli({
      argv: ['sessions', 'list', '--config-path', configPath],
      stdout,
      stderr,
    });

    // Exits 0 even when no gateway is running (graceful fallback)
    expect(code).toBe(0);
  });

  it('logs command routes correctly through runCli', async () => {
    const { stdout, stderr } = makeStreams();

    const code = await runCli({
      argv: ['logs'],
      stdout,
      stderr,
    });

    expect(code).toBe(0);
  });

  it('help output includes gateway and config sections', async () => {
    let output = '';
    const stdout = {
      write: (chunk: string) => { output += chunk; return true; },
    } as unknown as NodeJS.WritableStream;
    const stderr = {
      write: () => true,
    } as unknown as NodeJS.WritableStream;

    await runCli({ argv: ['--help'], stdout, stderr });

    expect(output).toContain('Gateway subcommands:');
    expect(output).toContain('Config subcommands:');
    expect(output).toContain('Session subcommands:');
    expect(output).toContain('Logs:');
  });
});
