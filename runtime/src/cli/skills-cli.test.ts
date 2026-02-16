import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntimeContext, SkillCommandOptions } from './types.js';
import {
  runSkillListCommand,
  runSkillInfoCommand,
  runSkillValidateCommand,
  runSkillCreateCommand,
  runSkillInstallCommand,
  runSkillUninstallCommand,
  runSkillEnableCommand,
  runSkillDisableCommand,
} from './skills-cli.js';
import type { DiscoveryPaths } from '../skills/markdown/discovery.js';

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

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill
version: 1.0.0
metadata:
  agenc:
    tags:
      - testing
    requires:
      binaries: []
      env: []
      channels: []
      os: []
    install: []
---

# Test Skill

This is a test skill body.
`;

const INVALID_SKILL_MD = `---
description: Missing name field
version: 1.0.0
metadata:
  agenc:
    tags: []
    requires:
      binaries: []
      env: []
      channels: []
      os: []
    install: []
---

Body without name.
`;

function baseOpts(): SkillCommandOptions {
  return {
    help: false,
    outputFormat: 'json',
    strictMode: false,
    storeType: 'memory',
    idempotencyWindow: 900,
  };
}

describe('skills-cli', () => {
  let workspace: string;
  let userSkillsDir: string;
  let projectSkillsDir: string;
  let discoveryPaths: DiscoveryPaths;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'agenc-skill-cli-'));
    userSkillsDir = join(workspace, 'user-skills');
    projectSkillsDir = join(workspace, 'project-skills');
    mkdirSync(userSkillsDir, { recursive: true });
    mkdirSync(projectSkillsDir, { recursive: true });
    discoveryPaths = {
      userSkills: userSkillsDir,
      projectSkills: projectSkillsDir,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  // --- list ---

  it('list: returns discovered skills with correct fields', async () => {
    writeFileSync(join(userSkillsDir, 'test-skill.md'), VALID_SKILL_MD, 'utf-8');

    const { context, outputs } = createContextCapture();
    const code = await runSkillListCommand(context, baseOpts(), { discoveryPaths, userSkillsDir });

    expect(code).toBe(0);
    const payload = outputs[0] as any;
    expect(payload.status).toBe('ok');
    expect(payload.command).toBe('skill.list');
    expect(payload.count).toBe(1);
    expect(payload.skills[0].name).toBe('test-skill');
    expect(payload.skills[0].tier).toBe('user');
    expect(payload.skills[0].tags).toEqual(['testing']);
  });

  it('list: empty dir returns count 0', async () => {
    const { context, outputs } = createContextCapture();
    const code = await runSkillListCommand(context, baseOpts(), { discoveryPaths, userSkillsDir });

    expect(code).toBe(0);
    const payload = outputs[0] as any;
    expect(payload.count).toBe(0);
    expect(payload.skills).toEqual([]);
  });

  it('list: shows disabled status when marker exists', async () => {
    const filePath = join(userSkillsDir, 'test-skill.md');
    writeFileSync(filePath, VALID_SKILL_MD, 'utf-8');
    writeFileSync(`${filePath}.disabled`, '', 'utf-8');

    const { context, outputs } = createContextCapture();
    const code = await runSkillListCommand(context, baseOpts(), { discoveryPaths, userSkillsDir });

    expect(code).toBe(0);
    const payload = outputs[0] as any;
    expect(payload.skills[0].disabled).toBe(true);
  });

  // --- info ---

  it('info: returns full details for existing skill', async () => {
    writeFileSync(join(userSkillsDir, 'test-skill.md'), VALID_SKILL_MD, 'utf-8');

    const { context, outputs } = createContextCapture();
    const opts = { ...baseOpts(), skillName: 'test-skill' };
    const code = await runSkillInfoCommand(context, opts, { discoveryPaths });

    expect(code).toBe(0);
    const payload = outputs[0] as any;
    expect(payload.status).toBe('ok');
    expect(payload.command).toBe('skill.info');
    expect(payload.skill.name).toBe('test-skill');
    expect(payload.skill.version).toBe('1.0.0');
    expect(payload.skill.description).toBe('A test skill');
    expect(payload.skill.bodyPreview).toContain('Test Skill');
  });

  it('info: error with suggestions for unknown name', async () => {
    writeFileSync(join(userSkillsDir, 'test-skill.md'), VALID_SKILL_MD, 'utf-8');

    const { context, errors } = createContextCapture();
    const opts = { ...baseOpts(), skillName: 'test' };
    const code = await runSkillInfoCommand(context, opts, { discoveryPaths });

    expect(code).toBe(1);
    const payload = errors[0] as any;
    expect(payload.code).toBe('SKILL_NOT_FOUND');
    expect(payload.suggestions).toContain('test-skill');
  });

  // --- validate ---

  it('validate: exit 0 for all-valid skills', async () => {
    writeFileSync(join(userSkillsDir, 'test-skill.md'), VALID_SKILL_MD, 'utf-8');

    const { context, outputs } = createContextCapture();
    const code = await runSkillValidateCommand(context, baseOpts(), { discoveryPaths });

    expect(code).toBe(0);
    const payload = outputs[0] as any;
    expect(payload.valid).toBe(true);
    expect(payload.results[0].valid).toBe(true);
  });

  it('validate: exit 1 when validation errors', async () => {
    writeFileSync(join(userSkillsDir, 'bad-skill.md'), INVALID_SKILL_MD, 'utf-8');

    const { context, outputs } = createContextCapture();
    const code = await runSkillValidateCommand(context, baseOpts(), { discoveryPaths });

    expect(code).toBe(1);
    const payload = outputs[0] as any;
    expect(payload.valid).toBe(false);
    expect(payload.results[0].errors.length).toBeGreaterThan(0);
  });

  // --- create ---

  it('create: scaffolds SKILL.md with valid template', async () => {
    const destDir = join(workspace, 'create-dest');

    const { context, outputs } = createContextCapture();
    const opts = { ...baseOpts(), skillName: 'my-new-skill' };
    const code = await runSkillCreateCommand(context, opts, { userSkillsDir: destDir });

    expect(code).toBe(0);
    const payload = outputs[0] as any;
    expect(payload.status).toBe('ok');
    expect(payload.skillName).toBe('my-new-skill');

    const content = readFileSync(join(destDir, 'my-new-skill.md'), 'utf-8');
    expect(content).toContain('name: my-new-skill');
    expect(content).toContain('version: 0.1.0');
  });

  it('create: error if file already exists', async () => {
    writeFileSync(join(userSkillsDir, 'existing.md'), VALID_SKILL_MD, 'utf-8');

    const { context, errors } = createContextCapture();
    const opts = { ...baseOpts(), skillName: 'existing' };
    const code = await runSkillCreateCommand(context, opts, { userSkillsDir });

    expect(code).toBe(1);
    const payload = errors[0] as any;
    expect(payload.code).toBe('SKILL_ALREADY_EXISTS');
  });

  // --- install ---

  it('install: copies valid local SKILL.md using skill name as filename', async () => {
    const sourcePath = join(workspace, 'source-skill.md');
    writeFileSync(sourcePath, VALID_SKILL_MD, 'utf-8');
    const installDir = join(workspace, 'install-dest');

    const { context, outputs } = createContextCapture();
    const opts = { ...baseOpts(), source: sourcePath };
    const code = await runSkillInstallCommand(context, opts, { userSkillsDir: installDir });

    expect(code).toBe(0);
    const payload = outputs[0] as any;
    expect(payload.status).toBe('ok');
    expect(payload.skillName).toBe('test-skill');

    // Installed as {name}.md, not basename of source
    const installed = readFileSync(join(installDir, 'test-skill.md'), 'utf-8');
    expect(installed).toBe(VALID_SKILL_MD);
  });

  it('install: error for nonexistent source path', async () => {
    const { context, errors } = createContextCapture();
    const opts = { ...baseOpts(), source: '/nonexistent/path/skill.md' };
    const code = await runSkillInstallCommand(context, opts, { userSkillsDir });

    expect(code).toBe(1);
    const payload = errors[0] as any;
    expect(payload.code).toBe('SOURCE_NOT_FOUND');
  });

  it('install: error for non-SKILL.md file', async () => {
    const sourcePath = join(workspace, 'not-a-skill.md');
    writeFileSync(sourcePath, '# Just a regular markdown file\n\nNo frontmatter here.', 'utf-8');

    const { context, errors } = createContextCapture();
    const opts = { ...baseOpts(), source: sourcePath };
    const code = await runSkillInstallCommand(context, opts, { userSkillsDir });

    expect(code).toBe(1);
    const payload = errors[0] as any;
    expect(payload.code).toBe('INVALID_SKILL_FILE');
  });

  it('install: error if dest file already exists', async () => {
    const sourcePath = join(workspace, 'whatever-name.md');
    writeFileSync(sourcePath, VALID_SKILL_MD, 'utf-8');
    // Dest uses skill name from frontmatter, not source basename
    writeFileSync(join(userSkillsDir, 'test-skill.md'), VALID_SKILL_MD, 'utf-8');

    const { context, errors } = createContextCapture();
    const opts = { ...baseOpts(), source: sourcePath };
    const code = await runSkillInstallCommand(context, opts, { userSkillsDir });

    expect(code).toBe(1);
    const payload = errors[0] as any;
    expect(payload.code).toBe('SKILL_ALREADY_EXISTS');
  });

  it('install: error for file with valid frontmatter but failing validation', async () => {
    const sourcePath = join(workspace, 'bad-install.md');
    writeFileSync(sourcePath, INVALID_SKILL_MD, 'utf-8');

    const { context, errors } = createContextCapture();
    const opts = { ...baseOpts(), source: sourcePath };
    const code = await runSkillInstallCommand(context, opts, { userSkillsDir });

    expect(code).toBe(1);
    const payload = errors[0] as any;
    expect(payload.code).toBe('INVALID_SKILL_FILE');
    expect(payload.message).toContain('validation failed');
  });

  // --- uninstall ---

  it('uninstall: removes skill file', async () => {
    const filePath = join(userSkillsDir, 'test-skill.md');
    writeFileSync(filePath, VALID_SKILL_MD, 'utf-8');

    const { context, outputs } = createContextCapture();
    const opts = { ...baseOpts(), skillName: 'test-skill' };
    const code = await runSkillUninstallCommand(context, opts, { userSkillsDir });

    expect(code).toBe(0);
    expect(existsSync(filePath)).toBe(false);
    const payload = outputs[0] as any;
    expect(payload.command).toBe('skill.uninstall');
  });

  it('uninstall: also removes .disabled marker', async () => {
    const filePath = join(userSkillsDir, 'test-skill.md');
    const markerPath = `${filePath}.disabled`;
    writeFileSync(filePath, VALID_SKILL_MD, 'utf-8');
    writeFileSync(markerPath, '', 'utf-8');

    const { context } = createContextCapture();
    const opts = { ...baseOpts(), skillName: 'test-skill' };
    const code = await runSkillUninstallCommand(context, opts, { userSkillsDir });

    expect(code).toBe(0);
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('uninstall: error for nonexistent skill', async () => {
    const { context, errors } = createContextCapture();
    const opts = { ...baseOpts(), skillName: 'nonexistent' };
    const code = await runSkillUninstallCommand(context, opts, { userSkillsDir });

    expect(code).toBe(1);
    const payload = errors[0] as any;
    expect(payload.code).toBe('SKILL_NOT_FOUND');
  });

  // --- disable ---

  it('disable: creates .disabled marker', async () => {
    const filePath = join(userSkillsDir, 'test-skill.md');
    writeFileSync(filePath, VALID_SKILL_MD, 'utf-8');

    const { context, outputs } = createContextCapture();
    const opts = { ...baseOpts(), skillName: 'test-skill' };
    const code = await runSkillDisableCommand(context, opts, { discoveryPaths });

    expect(code).toBe(0);
    expect(existsSync(`${filePath}.disabled`)).toBe(true);
    const payload = outputs[0] as any;
    expect(payload.command).toBe('skill.disable');
  });

  it('disable: idempotent when already disabled', async () => {
    const filePath = join(userSkillsDir, 'test-skill.md');
    writeFileSync(filePath, VALID_SKILL_MD, 'utf-8');
    writeFileSync(`${filePath}.disabled`, '', 'utf-8');

    const { context, outputs } = createContextCapture();
    const opts = { ...baseOpts(), skillName: 'test-skill' };
    const code = await runSkillDisableCommand(context, opts, { discoveryPaths });

    expect(code).toBe(0);
    expect(existsSync(`${filePath}.disabled`)).toBe(true);
    const payload = outputs[0] as any;
    expect(payload.status).toBe('ok');
  });

  // --- enable ---

  it('enable: removes .disabled marker', async () => {
    const filePath = join(userSkillsDir, 'test-skill.md');
    writeFileSync(filePath, VALID_SKILL_MD, 'utf-8');
    writeFileSync(`${filePath}.disabled`, '', 'utf-8');

    const { context, outputs } = createContextCapture();
    const opts = { ...baseOpts(), skillName: 'test-skill' };
    const code = await runSkillEnableCommand(context, opts, { discoveryPaths });

    expect(code).toBe(0);
    expect(existsSync(`${filePath}.disabled`)).toBe(false);
    const payload = outputs[0] as any;
    expect(payload.command).toBe('skill.enable');
  });

  it('enable: idempotent when already enabled', async () => {
    const filePath = join(userSkillsDir, 'test-skill.md');
    writeFileSync(filePath, VALID_SKILL_MD, 'utf-8');

    const { context, outputs } = createContextCapture();
    const opts = { ...baseOpts(), skillName: 'test-skill' };
    const code = await runSkillEnableCommand(context, opts, { discoveryPaths });

    expect(code).toBe(0);
    expect(existsSync(`${filePath}.disabled`)).toBe(false);
    const payload = outputs[0] as any;
    expect(payload.status).toBe('ok');
  });

  // --- install from URL (mocked fetch) ---

  it('install: fetches from URL and installs', async () => {
    const installDir = join(workspace, 'url-install-dest');
    const mockResponse = new Response(VALID_SKILL_MD, { status: 200 });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    const { context, outputs } = createContextCapture();
    const opts = { ...baseOpts(), source: 'https://example.com/test-skill.md' };
    const code = await runSkillInstallCommand(context, opts, { userSkillsDir: installDir });

    expect(code).toBe(0);
    const payload = outputs[0] as any;
    expect(payload.status).toBe('ok');
    expect(payload.skillName).toBe('test-skill');
    expect(existsSync(join(installDir, 'test-skill.md'))).toBe(true);
  });
});

/**
 * Integration tests for skill CLI routing via runCli.
 *
 * These import index.ts which transitively pulls in @agenc/sdk via replay.ts.
 * They will only run when that dependency is available. The test uses
 * parseArgv (standalone export) and normalizeAndValidateSkillCommand
 * indirectly, so these are covered separately.
 *
 * To run: npx vitest run src/cli/skills-cli-integration.test.ts
 * (requires @agenc/sdk to be built/linked)
 */
