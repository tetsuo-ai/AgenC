import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isSkillMarkdown,
  parseSkillContent,
  validateSkillMetadata,
} from '../markdown/parser.js';
import { SkillDiscovery } from '../markdown/discovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = __dirname;

const EXPECTED_SKILLS = [
  'solana',
  'agenc-protocol',
  'github',
  'jupiter',
  'spl-token',
  'system',
  'defi-monitor',
  'wallet',
];

/** Read and parse a bundled skill by name. */
async function loadSkill(name: string) {
  const filePath = join(BUNDLED_DIR, `${name}.md`);
  const content = await readFile(filePath, 'utf-8');
  return parseSkillContent(content, filePath);
}

describe('bundled skills', () => {
  it('all 8 SKILL.md files exist', async () => {
    const entries = await readdir(BUNDLED_DIR);
    const mdFiles = entries.filter((f) => f.endsWith('.md'));

    for (const name of EXPECTED_SKILLS) {
      expect(mdFiles, `missing ${name}.md`).toContain(`${name}.md`);
    }
    expect(mdFiles).toHaveLength(EXPECTED_SKILLS.length);
  });

  it('all files have valid YAML frontmatter', async () => {
    for (const name of EXPECTED_SKILLS) {
      const filePath = join(BUNDLED_DIR, `${name}.md`);
      const content = await readFile(filePath, 'utf-8');
      expect(isSkillMarkdown(content), `${name}.md missing frontmatter`).toBe(true);
    }
  });

  it('all files parse successfully via parseSkillContent()', async () => {
    for (const name of EXPECTED_SKILLS) {
      const skill = await loadSkill(name);
      expect(skill.name, `${name}: name mismatch`).toBe(name);
      expect(skill.description.length, `${name}: empty description`).toBeGreaterThan(0);
      expect(skill.version, `${name}: missing version`).toBe('1.0.0');
    }
  });

  it('all files validate without errors', async () => {
    for (const name of EXPECTED_SKILLS) {
      const skill = await loadSkill(name);
      const errors = validateSkillMetadata(skill);
      expect(errors, `${name} has validation errors: ${JSON.stringify(errors)}`).toEqual([]);
    }
  });

  it('no duplicate skill names', async () => {
    const names = new Set<string>();
    for (const name of EXPECTED_SKILLS) {
      const skill = await loadSkill(name);
      expect(names.has(skill.name), `duplicate skill name: ${skill.name}`).toBe(false);
      names.add(skill.name);
    }
  });

  it('each skill has at least 2 tags', async () => {
    for (const name of EXPECTED_SKILLS) {
      const skill = await loadSkill(name);
      expect(
        skill.metadata.tags.length,
        `${name}: needs at least 2 tags, has ${skill.metadata.tags.length}`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('each skill body contains at least 3 code block examples', async () => {
    for (const name of EXPECTED_SKILLS) {
      const skill = await loadSkill(name);
      const codeBlocks = (skill.body.match(/```/g) ?? []).length / 2;
      expect(
        codeBlocks,
        `${name}: needs at least 3 code blocks, has ${codeBlocks}`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  // --- Skill-specific requirement checks ---

  it('solana skill requires solana binary', async () => {
    const skill = await loadSkill('solana');
    expect(skill.metadata.requires.binaries).toContain('solana');
  });

  it('github skill requires gh, git binaries and GITHUB_TOKEN', async () => {
    const skill = await loadSkill('github');
    expect(skill.metadata.requires.binaries).toContain('gh');
    expect(skill.metadata.requires.binaries).toContain('git');
    expect(skill.metadata.requires.env).toContain('GITHUB_TOKEN');
  });

  it('system skill has no binary requirements', async () => {
    const skill = await loadSkill('system');
    expect(skill.metadata.requires.binaries).toEqual([]);
    expect(skill.metadata.requires.env).toEqual([]);
  });

  it('wallet skill requires solana binary', async () => {
    const skill = await loadSkill('wallet');
    expect(skill.metadata.requires.binaries).toContain('solana');
  });

  it('spl-token skill requires spl-token and solana binaries', async () => {
    const skill = await loadSkill('spl-token');
    expect(skill.metadata.requires.binaries).toContain('spl-token');
    expect(skill.metadata.requires.binaries).toContain('solana');
  });

  it('agenc-protocol skill has requiredCapabilities', async () => {
    const skill = await loadSkill('agenc-protocol');
    expect(skill.metadata.requiredCapabilities).toBeDefined();
  });

  it('agenc-protocol skill requires solana binary', async () => {
    const skill = await loadSkill('agenc-protocol');
    expect(skill.metadata.requires.binaries).toContain('solana');
  });

  it('jupiter skill has no binary requirements (API-based)', async () => {
    const skill = await loadSkill('jupiter');
    expect(skill.metadata.requires.binaries).toEqual([]);
  });

  it('defi-monitor skill has no binary requirements (API-based)', async () => {
    const skill = await loadSkill('defi-monitor');
    expect(skill.metadata.requires.binaries).toEqual([]);
  });

  // --- Discovery integration ---

  it('all 8 skills discoverable via SkillDiscovery in bundled tier', async () => {
    const discovery = new SkillDiscovery({ builtinSkills: BUNDLED_DIR });
    const results = await discovery.discoverAll();
    const names = results.map((r) => r.skill.name);

    for (const name of EXPECTED_SKILLS) {
      expect(names, `${name} not discovered`).toContain(name);
    }
    expect(results.every((r) => r.tier === 'builtin')).toBe(true);
  });
});
