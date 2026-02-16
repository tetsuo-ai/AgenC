import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliRuntimeContext } from './types.js';
import type { DiscoveryPaths } from '../skills/markdown/discovery.js';
import { buildSkillTemplate, runSkillCommand, SKILL_ERROR_CODES, type SkillCommandOverrides } from './skills-cli.js';

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

const MOCK_SKILL_CONTENT = `---
name: test-skill
description: A test skill for testing
version: 1.0.0
metadata:
  agenc:
    tags:
      - test
      - mock
---

# Test Skill

This is a test skill.
`;

const MOCK_SKILL_NO_BINARIES = `---
name: simple-skill
description: A simple skill with no requirements
version: 1.0.0
metadata:
  agenc:
    tags:
      - simple
---

# Simple Skill

No requirements here.
`;

const MOCK_SKILL_MISSING_NAME = `---
description: A skill without a name
version: 1.0.0
metadata:
  agenc:
    tags:
      - broken
---

# Broken

Missing name field.
`;

describe('skills-cli', () => {
  let workspace: string;
  let skillsDir: string;
  let userSkillsDir: string;
  let discoveryPaths: DiscoveryPaths;
  let overrides: SkillCommandOverrides;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'agenc-skill-cli-'));
    skillsDir = join(workspace, 'builtin-skills');
    userSkillsDir = join(workspace, 'user-skills');

    // Create mock skill files (flat .md files in the directory)
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'test-skill.md'), MOCK_SKILL_CONTENT, 'utf-8');
    writeFileSync(join(skillsDir, 'simple-skill.md'), MOCK_SKILL_NO_BINARIES, 'utf-8');

    mkdirSync(userSkillsDir, { recursive: true });

    discoveryPaths = {
      builtinSkills: skillsDir,
      userSkills: userSkillsDir,
      projectSkills: join(workspace, 'project-skills'),
    };

    overrides = { discoveryPaths, userSkillsDir };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  describe('list', () => {
    it('returns all discovered skills', async () => {
      const { context, outputs } = createContextCapture();
      const code = await runSkillCommand(context, 'list', [], {}, overrides);

      expect(code).toBe(0);
      const result = outputs[0] as { status: string; command: string; skills: unknown[]; count: number };
      expect(result.status).toBe('ok');
      expect(result.command).toBe('skill.list');
      expect(result.count).toBe(2);
      expect(result.skills).toHaveLength(2);
    });

    it('filters by tier', async () => {
      const { context, outputs } = createContextCapture();
      const code = await runSkillCommand(context, 'list', [], { tier: 'builtin' }, overrides);

      expect(code).toBe(0);
      const result = outputs[0] as { skills: Array<{ tier: string }> };
      for (const skill of result.skills) {
        expect(skill.tier).toBe('builtin');
      }
    });

    it('returns empty when filtering by nonexistent tier', async () => {
      const { context, outputs } = createContextCapture();
      const code = await runSkillCommand(context, 'list', [], { tier: 'agent' }, overrides);

      expect(code).toBe(0);
      const result = outputs[0] as { skills: unknown[]; count: number };
      expect(result.count).toBe(0);
    });

    it('filters available only', async () => {
      const { context, outputs } = createContextCapture();
      const code = await runSkillCommand(context, 'list', [], { available: true }, overrides);

      expect(code).toBe(0);
      const result = outputs[0] as { skills: Array<{ available: boolean }> };
      for (const skill of result.skills) {
        expect(skill.available).toBe(true);
      }
    });
  });

  describe('info', () => {
    it('returns skill details', async () => {
      const { context, outputs } = createContextCapture();
      const code = await runSkillCommand(context, 'info', ['test-skill'], {}, overrides);

      expect(code).toBe(0);
      const result = outputs[0] as { status: string; command: string; skill: { name: string; tags: string[]; bodyLength: number } };
      expect(result.status).toBe('ok');
      expect(result.command).toBe('skill.info');
      expect(result.skill.name).toBe('test-skill');
      expect(result.skill.tags).toContain('test');
      expect(result.skill.bodyLength).toBeGreaterThan(0);
    });

    it('throws SKILL_NOT_FOUND for missing skill', async () => {
      const { context } = createContextCapture();
      await expect(
        runSkillCommand(context, 'info', ['nonexistent'], {}, overrides),
      ).rejects.toThrow('not found');
    });

    it('throws MISSING_SKILL_NAME when no name provided', async () => {
      const { context } = createContextCapture();
      await expect(
        runSkillCommand(context, 'info', [], {}, overrides),
      ).rejects.toThrow('requires a skill name');
    });
  });

  describe('validate', () => {
    it('validates all skills and returns 0 when all pass', async () => {
      const { context, outputs } = createContextCapture();
      const code = await runSkillCommand(context, 'validate', [], {}, overrides);

      expect(code).toBe(0);
      const result = outputs[0] as { results: Array<{ name: string; valid: boolean }>; allValid: boolean };
      expect(result.results).toHaveLength(2);
      expect(result.allValid).toBe(true);
    });

    it('validates a single skill by name', async () => {
      const { context, outputs } = createContextCapture();
      const code = await runSkillCommand(context, 'validate', ['simple-skill'], {}, overrides);

      expect(code).toBe(0);
      const result = outputs[0] as { results: Array<{ name: string; valid: boolean }> };
      expect(result.results).toHaveLength(1);
      expect(result.results[0].name).toBe('simple-skill');
      expect(result.results[0].valid).toBe(true);
    });

    it('returns 1 when a skill has parse errors', async () => {
      writeFileSync(join(skillsDir, 'broken.md'), MOCK_SKILL_MISSING_NAME, 'utf-8');

      const { context, outputs } = createContextCapture();
      const code = await runSkillCommand(context, 'validate', [], {}, overrides);

      expect(code).toBe(1);
      const result = outputs[0] as { results: Array<{ name: string; valid: boolean; parseErrors: unknown[] }>; allValid: boolean };
      expect(result.allValid).toBe(false);
      const broken = result.results.find((r) => r.name === '');
      expect(broken).toBeDefined();
      expect(broken!.valid).toBe(false);
      expect(broken!.parseErrors.length).toBeGreaterThan(0);
    });

    it('throws SKILL_NOT_FOUND for missing skill name', async () => {
      const { context } = createContextCapture();
      await expect(
        runSkillCommand(context, 'validate', ['nonexistent'], {}, overrides),
      ).rejects.toThrow('not found');
    });
  });

  describe('create', () => {
    it('scaffolds SKILL.md in user directory', async () => {
      const { context, outputs } = createContextCapture();
      const code = await runSkillCommand(context, 'create', ['my-skill'], {}, overrides);

      expect(code).toBe(0);
      const result = outputs[0] as { status: string; name: string; path: string; created: boolean };
      expect(result.status).toBe('ok');
      expect(result.command).toBe('skill.create');
      expect(result.name).toBe('my-skill');
      expect(result.created).toBe(true);
      expect(existsSync(result.path)).toBe(true);

      const content = readFileSync(result.path, 'utf-8');
      expect(content).toContain('name: my-skill');
      expect(content).toContain('version: 1.0.0');
    });

    it('uses custom description', async () => {
      const { context, outputs } = createContextCapture();
      const code = await runSkillCommand(context, 'create', ['my-skill'], { description: 'Custom desc' }, overrides);

      expect(code).toBe(0);
      const result = outputs[0] as { path: string };
      const content = readFileSync(result.path, 'utf-8');
      expect(content).toContain('description: Custom desc');
    });

    it('throws MISSING_SKILL_NAME when no name provided', async () => {
      const { context } = createContextCapture();
      await expect(
        runSkillCommand(context, 'create', [], {}, overrides),
      ).rejects.toThrow('requires a skill name');
    });
  });

  describe('install', () => {
    it('copies SKILL.md to user directory', async () => {
      const sourcePath = join(workspace, 'external-skill.md');
      writeFileSync(sourcePath, MOCK_SKILL_CONTENT, 'utf-8');

      const { context, outputs } = createContextCapture();
      const code = await runSkillCommand(context, 'install', [sourcePath], {}, overrides);

      expect(code).toBe(0);
      const result = outputs[0] as { status: string; name: string; installedPath: string };
      expect(result.status).toBe('ok');
      expect(result.command).toBe('skill.install');
      expect(result.name).toBe('test-skill');
      expect(existsSync(result.installedPath)).toBe(true);

      const installed = readFileSync(result.installedPath, 'utf-8');
      expect(installed).toContain('name: test-skill');
    });

    it('throws SOURCE_NOT_FOUND for missing source path', async () => {
      const { context } = createContextCapture();
      await expect(
        runSkillCommand(context, 'install', ['/nonexistent/path.md'], {}, overrides),
      ).rejects.toThrow('not found');
    });

    it('throws SKILL_PARSE_ERROR when SKILL.md has no name', async () => {
      const sourcePath = join(workspace, 'no-name.md');
      writeFileSync(sourcePath, MOCK_SKILL_MISSING_NAME, 'utf-8');

      const { context } = createContextCapture();
      await expect(
        runSkillCommand(context, 'install', [sourcePath], {}, overrides),
      ).rejects.toThrow('has no name field');
    });

    it('throws MISSING_SOURCE_PATH when no path provided', async () => {
      const { context } = createContextCapture();
      await expect(
        runSkillCommand(context, 'install', [], {}, overrides),
      ).rejects.toThrow('requires a source path');
    });
  });

  describe('routing errors', () => {
    it('throws MISSING_SKILL_COMMAND when no subcommand', async () => {
      const { context } = createContextCapture();
      await expect(
        runSkillCommand(context, undefined, [], {}, overrides),
      ).rejects.toThrow('missing skill subcommand');
    });

    it('throws UNKNOWN_SKILL_COMMAND for invalid subcommand', async () => {
      const { context } = createContextCapture();
      await expect(
        runSkillCommand(context, 'bogus', [], {}, overrides),
      ).rejects.toThrow('unknown skill command');
    });
  });

  describe('buildSkillTemplate', () => {
    it('generates valid SKILL.md content', () => {
      const content = buildSkillTemplate('my-skill', 'My custom skill');
      expect(content).toContain('name: my-skill');
      expect(content).toContain('description: My custom skill');
      expect(content).toContain('version: 1.0.0');
      expect(content).toContain('- my-skill');
      expect(content).toContain('# My-skill');
    });

    it('uses default description when omitted', () => {
      const content = buildSkillTemplate('test');
      expect(content).toContain('description: A custom skill');
    });
  });
});
