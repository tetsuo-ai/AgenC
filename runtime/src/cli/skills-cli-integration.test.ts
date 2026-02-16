/**
 * Integration tests for skill CLI routing via runCli.
 *
 * These import index.ts which transitively pulls in @agenc/sdk via replay.ts.
 * They will fail at module resolution until @agenc/sdk is built/linked.
 *
 * To run: npx vitest run src/cli/skills-cli-integration.test.ts
 */
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runCli } from './index.js';

function createNullStream(): Writable {
  return new Writable({ write(_chunk, _encoding, cb) { cb(); } });
}

function captureStream(): { stream: Writable; data: string } {
  let data = '';
  const stream = new Writable({
    write(chunk, _encoding, cb) {
      data += chunk.toString();
      cb();
    },
  });
  return {
    stream,
    get data() { return data; },
  };
}

describe('skill cli integration', () => {
  it('skill list routes correctly', async () => {
    const out = captureStream();
    const err = createNullStream();

    const code = await runCli({
      argv: ['skill', 'list'],
      stdout: out.stream,
      stderr: err,
    });

    expect(code).toBe(0);
    const payload = JSON.parse(out.data.trim());
    expect(payload.status).toBe('ok');
    expect(payload.command).toBe('skill.list');
  });

  it('skill with missing subcommand returns exit 2', async () => {
    const out = createNullStream();
    const err = captureStream();

    const code = await runCli({
      argv: ['skill'],
      stdout: out,
      stderr: err.stream,
    });

    expect(code).toBe(2);
    const payload = JSON.parse(err.data.trim());
    expect(payload.code).toBe('MISSING_SKILL_COMMAND');
  });

  it('skill with unknown subcommand returns exit 2', async () => {
    const out = createNullStream();
    const err = captureStream();

    const code = await runCli({
      argv: ['skill', 'bogus'],
      stdout: out,
      stderr: err.stream,
    });

    expect(code).toBe(2);
    const payload = JSON.parse(err.data.trim());
    expect(payload.code).toBe('UNKNOWN_SKILL_COMMAND');
  });

  it('skill info without name returns exit 2', async () => {
    const out = createNullStream();
    const err = captureStream();

    const code = await runCli({
      argv: ['skill', 'info'],
      stdout: out,
      stderr: err.stream,
    });

    expect(code).toBe(2);
    const payload = JSON.parse(err.data.trim());
    expect(payload.code).toBe('MISSING_TARGET');
  });

  it('skill --help shows help text', async () => {
    const out = captureStream();
    const err = createNullStream();

    const code = await runCli({
      argv: ['skill', 'list', '--help'],
      stdout: out.stream,
      stderr: err,
    });

    expect(code).toBe(0);
    expect(out.data).toContain('Skill subcommands');
  });
});
