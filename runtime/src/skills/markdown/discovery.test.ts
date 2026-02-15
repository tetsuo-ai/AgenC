import { describe, expect, it } from 'vitest';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillDiscovery } from './discovery.js';
import type { DiscoveryPaths } from './discovery.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSkillMd(
  name: string,
  overrides?: {
    binaries?: string[];
    env?: string[];
    os?: string[];
    channels?: string[];
  },
): string {
  const binaries = overrides?.binaries ?? [];
  const env = overrides?.env ?? [];
  const os = overrides?.os ?? [];
  const channels = overrides?.channels ?? [];

  const requiresBlock = [
    '    requires:',
    binaries.length > 0
      ? `      binaries:\n${binaries.map((b) => `        - ${b}`).join('\n')}`
      : null,
    env.length > 0
      ? `      env:\n${env.map((e) => `        - ${e}`).join('\n')}`
      : null,
    os.length > 0
      ? `      os:\n${os.map((o) => `        - ${o}`).join('\n')}`
      : null,
    channels.length > 0
      ? `      channels:\n${channels.map((c) => `        - ${c}`).join('\n')}`
      : null,
  ]
    .filter(Boolean)
    .join('\n');

  return `---
name: ${name}
description: Test skill ${name}
version: 1.0.0
metadata:
  agenc:
${requiresBlock}
---
Body for ${name}.
`;
}

async function writeSkillMd(
  dir: string,
  name: string,
  overrides?: Parameters<typeof buildSkillMd>[1],
): Promise<string> {
  const filePath = join(dir, `${name}.md`);
  await writeFile(filePath, buildSkillMd(name, overrides), 'utf-8');
  return filePath;
}

async function makeTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'agenc-disc-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SkillDiscovery', () => {
  // ------ discoverAll ------

  describe('discoverAll', () => {
    it('finds skills across all tiers', async () => {
      const agentDir = await makeTmpDir();
      const userDir = await makeTmpDir();
      const projectDir = await makeTmpDir();
      const builtinDir = await makeTmpDir();

      try {
        await writeSkillMd(agentDir, 'agent-skill');
        await writeSkillMd(userDir, 'user-skill');
        await writeSkillMd(projectDir, 'project-skill');
        await writeSkillMd(builtinDir, 'builtin-skill');

        const discovery = new SkillDiscovery({
          agentSkills: agentDir,
          userSkills: userDir,
          projectSkills: projectDir,
          builtinSkills: builtinDir,
        });

        const results = await discovery.discoverAll();
        const names = results.map((r) => r.skill.name);

        expect(names).toContain('agent-skill');
        expect(names).toContain('user-skill');
        expect(names).toContain('project-skill');
        expect(names).toContain('builtin-skill');
        expect(results).toHaveLength(4);
      } finally {
        await Promise.all([
          rm(agentDir, { recursive: true }),
          rm(userDir, { recursive: true }),
          rm(projectDir, { recursive: true }),
          rm(builtinDir, { recursive: true }),
        ]);
      }
    });

    it('higher-tier skill shadows lower-tier with same name', async () => {
      const agentDir = await makeTmpDir();
      const builtinDir = await makeTmpDir();

      try {
        await writeSkillMd(agentDir, 'shared-name');
        await writeSkillMd(builtinDir, 'shared-name');

        const discovery = new SkillDiscovery({
          agentSkills: agentDir,
          builtinSkills: builtinDir,
        });

        const results = await discovery.discoverAll();
        const matching = results.filter((r) => r.skill.name === 'shared-name');

        expect(matching).toHaveLength(1);
        expect(matching[0].tier).toBe('agent');
      } finally {
        await Promise.all([
          rm(agentDir, { recursive: true }),
          rm(builtinDir, { recursive: true }),
        ]);
      }
    });
  });

  // ------ validateRequirements ------

  describe('validateRequirements', () => {
    it('passes when all requirements met', async () => {
      const dir = await makeTmpDir();

      try {
        await writeSkillMd(dir, 'all-met', {
          binaries: ['node'],
          env: ['PATH'],
        });

        const discovery = new SkillDiscovery({ projectSkills: dir });
        const results = await discovery.discoverInDirectory(dir, 'project');

        expect(results).toHaveLength(1);
        expect(results[0].available).toBe(true);
        expect(results[0].missingRequirements).toBeUndefined();
      } finally {
        await rm(dir, { recursive: true });
      }
    });

    it('reports missing binary', async () => {
      const dir = await makeTmpDir();

      try {
        await writeSkillMd(dir, 'missing-bin', {
          binaries: ['nonexistent_binary_xyz_12345'],
        });

        const discovery = new SkillDiscovery({ projectSkills: dir });
        const results = await discovery.discoverInDirectory(dir, 'project');

        expect(results).toHaveLength(1);
        expect(results[0].available).toBe(false);
        expect(results[0].missingRequirements).toBeDefined();
        expect(results[0].missingRequirements!.some(
          (m) => m.type === 'binary' && m.name === 'nonexistent_binary_xyz_12345',
        )).toBe(true);
      } finally {
        await rm(dir, { recursive: true });
      }
    });

    it('reports missing env var', async () => {
      const dir = await makeTmpDir();
      const envVar = 'AGENC_TEST_MISSING_VAR_XYZ_98765';

      try {
        await writeSkillMd(dir, 'missing-env', { env: [envVar] });

        const discovery = new SkillDiscovery({ projectSkills: dir });
        const results = await discovery.discoverInDirectory(dir, 'project');

        expect(results).toHaveLength(1);
        expect(results[0].available).toBe(false);
        expect(results[0].missingRequirements!.some(
          (m) => m.type === 'env' && m.name === envVar,
        )).toBe(true);
      } finally {
        await rm(dir, { recursive: true });
      }
    });

    it('reports OS mismatch', async () => {
      const dir = await makeTmpDir();
      const fakeOs = process.platform === 'linux' ? 'windows' : 'linux';

      try {
        await writeSkillMd(dir, 'os-mismatch', { os: [fakeOs] });

        const discovery = new SkillDiscovery({ projectSkills: dir });
        const results = await discovery.discoverInDirectory(dir, 'project');

        expect(results).toHaveLength(1);
        expect(results[0].available).toBe(false);
        expect(results[0].missingRequirements!.some(
          (m) => m.type === 'os',
        )).toBe(true);
      } finally {
        await rm(dir, { recursive: true });
      }
    });

    it('skill with no requirements is always available', async () => {
      const dir = await makeTmpDir();

      try {
        await writeSkillMd(dir, 'no-reqs');

        const discovery = new SkillDiscovery({ projectSkills: dir });
        const results = await discovery.discoverInDirectory(dir, 'project');

        expect(results).toHaveLength(1);
        expect(results[0].available).toBe(true);
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  });

  // ------ checkBinary ------

  describe('checkBinary', () => {
    it('returns true for existing binary (node)', async () => {
      const discovery = new SkillDiscovery({});
      expect(await discovery.checkBinary('node')).toBe(true);
    });

    it('returns false for non-existent binary', async () => {
      const discovery = new SkillDiscovery({});
      expect(await discovery.checkBinary('nonexistent_binary_xyz_12345')).toBe(false);
    });
  });

  // ------ checkEnv ------

  describe('checkEnv', () => {
    it('returns true for set variable', () => {
      const discovery = new SkillDiscovery({});
      expect(discovery.checkEnv('PATH')).toBe(true);
    });

    it('returns false for unset variable', () => {
      const discovery = new SkillDiscovery({});
      expect(discovery.checkEnv('AGENC_TEST_MISSING_VAR_XYZ_98765')).toBe(false);
    });
  });

  // ------ checkOs ------

  describe('checkOs', () => {
    it('matches current platform', () => {
      const discovery = new SkillDiscovery({});
      expect(discovery.checkOs([process.platform])).toBe(true);
    });

    it('maps macos to darwin', () => {
      const discovery = new SkillDiscovery({});
      if (process.platform === 'darwin') {
        expect(discovery.checkOs(['macos'])).toBe(true);
      } else {
        expect(discovery.checkOs(['macos'])).toBe(false);
      }
    });

    it('empty list allows any OS', () => {
      const discovery = new SkillDiscovery({});
      expect(discovery.checkOs([])).toBe(true);
    });
  });

  // ------ getAvailable ------

  describe('getAvailable', () => {
    it('filters out unavailable skills', async () => {
      const dir = await makeTmpDir();

      try {
        await writeSkillMd(dir, 'available-skill');
        await writeSkillMd(dir, 'unavailable-skill', {
          binaries: ['nonexistent_binary_xyz_12345'],
        });

        const discovery = new SkillDiscovery({ projectSkills: dir });
        const available = await discovery.getAvailable();

        expect(available).toHaveLength(1);
        expect(available[0].skill.name).toBe('available-skill');
        expect(available[0].available).toBe(true);
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  });

  // ------ discoverInDirectory ------

  describe('discoverInDirectory', () => {
    it('empty directory returns empty array', async () => {
      const dir = await makeTmpDir();

      try {
        const discovery = new SkillDiscovery({});
        const results = await discovery.discoverInDirectory(dir, 'project');
        expect(results).toEqual([]);
      } finally {
        await rm(dir, { recursive: true });
      }
    });

    it('missing directory returns empty array', async () => {
      const discovery = new SkillDiscovery({});
      const results = await discovery.discoverInDirectory(
        '/tmp/nonexistent-dir-agenc-test-xyz-98765',
        'project',
      );
      expect(results).toEqual([]);
    });

    it('non-SKILL.md files are skipped', async () => {
      const dir = await makeTmpDir();

      try {
        // Write a .md file that is NOT a SKILL.md (no frontmatter)
        await writeFile(join(dir, 'README.md'), '# Hello\n\nNot a skill.\n', 'utf-8');
        // Write a valid skill for comparison
        await writeSkillMd(dir, 'real-skill');

        const discovery = new SkillDiscovery({});
        const results = await discovery.discoverInDirectory(dir, 'project');

        expect(results).toHaveLength(1);
        expect(results[0].skill.name).toBe('real-skill');
      } finally {
        await rm(dir, { recursive: true });
      }
    });
  });
});
