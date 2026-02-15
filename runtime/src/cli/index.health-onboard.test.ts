import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runHealthChecksMock, runDoctorChecksMock, runOnboardMock } = vi.hoisted(() => ({
  runHealthChecksMock: vi.fn(),
  runDoctorChecksMock: vi.fn(),
  runOnboardMock: vi.fn(),
}));

vi.mock('./health.js', () => ({
  runHealthChecks: runHealthChecksMock,
  runDoctorChecks: runDoctorChecksMock,
}));

vi.mock('./onboard.js', () => ({
  runOnboard: runOnboardMock,
}));

import { runCli } from './index.js';

function createCapture() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += chunk.toString('utf8');
  });
  stderr.on('data', (chunk) => {
    err += chunk.toString('utf8');
  });
  return {
    stdout,
    stderr,
    getOut: () => out.trim(),
    getErr: () => err.trim(),
  };
}

describe('runCli health/onboard routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes health command and returns report exit code', async () => {
    runHealthChecksMock.mockResolvedValue({
      status: 'pass',
      timestamp: '2025-01-01T00:00:00.000Z',
      exitCode: 0,
      checks: [],
      summary: { total: 0, passed: 0, warnings: 0, failed: 0 },
    });

    const capture = createCapture();
    const exit = await runCli({
      argv: ['health', '--deep'],
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    expect(exit).toBe(0);
    expect(runHealthChecksMock).toHaveBeenCalledTimes(1);
    expect(runHealthChecksMock).toHaveBeenCalledWith(
      expect.objectContaining({ deep: true }),
    );

    const payload = JSON.parse(capture.getOut());
    expect(payload.command).toBe('health');
    expect(payload.report.exitCode).toBe(0);
    expect(capture.getErr()).toBe('');
  });

  it('routes doctor health command with fix flag', async () => {
    runDoctorChecksMock.mockResolvedValue({
      status: 'warn',
      timestamp: '2025-01-01T00:00:00.000Z',
      exitCode: 1,
      checks: [],
      summary: { total: 0, passed: 0, warnings: 1, failed: 0 },
    });

    const capture = createCapture();
    const exit = await runCli({
      argv: ['doctor', 'health', '--fix', '--deep'],
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    expect(exit).toBe(1);
    expect(runDoctorChecksMock).toHaveBeenCalledTimes(1);
    expect(runDoctorChecksMock).toHaveBeenCalledWith(
      expect.objectContaining({ fix: true, deep: true }),
    );

    const payload = JSON.parse(capture.getOut());
    expect(payload.command).toBe('doctor.health');
    expect(payload.report.exitCode).toBe(1);
  });

  it('routes onboard command and passes parsed options', async () => {
    runOnboardMock.mockResolvedValue({
      success: true,
      configPath: '.agenc.json',
      config: { configVersion: '1.0.0' },
      errors: [],
      warnings: [],
    });

    const capture = createCapture();
    const exit = await runCli({
      argv: ['onboard', '--skip-health-checks', '--force', '--store-type', 'sqlite'],
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    expect(exit).toBe(0);
    expect(runOnboardMock).toHaveBeenCalledTimes(1);
    expect(runOnboardMock).toHaveBeenCalledWith(
      expect.objectContaining({
        skipHealthChecks: true,
        force: true,
        storeType: 'sqlite',
      }),
    );

    const payload = JSON.parse(capture.getOut());
    expect(payload.command).toBe('onboard');
    expect(payload.status).toBe('ok');
  });

  it('returns non-zero exit when onboard fails', async () => {
    runOnboardMock.mockResolvedValue({
      success: false,
      configPath: '.agenc.json',
      config: { configVersion: '1.0.0' },
      errors: ['boom'],
      warnings: [],
    });

    const capture = createCapture();
    const exit = await runCli({
      argv: ['onboard'],
      stdout: capture.stdout,
      stderr: capture.stderr,
    });

    expect(exit).toBe(1);
    const payload = JSON.parse(capture.getOut());
    expect(payload.status).toBe('error');
  });
});
