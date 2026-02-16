import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseSkillContent, validateSkillMetadata, isSkillMarkdown } from '../markdown/parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = __dirname;

const EXPECTED_SKILLS = [
  'agenc-protocol',
  'defi-monitor',
  'github',
  'jupiter',
  'solana',
  'spl-token',
  'system',
  'wallet',
];

async function loadAllSkills() {
  const files = await readdir(BUNDLED_DIR);
  const mdFiles = files.filter((f) => f.endsWith('.md'));
  const skills = [];
  for (const file of mdFiles) {
    const content = await readFile(join(BUNDLED_DIR, file), 'utf-8');
    skills.push({ file, content });
  }
  return skills;
}

describe('Bundled skills', () => {
  it('has exactly 8 skill files', async () => {
    const files = await readdir(BUNDLED_DIR);
    const mdFiles = files.filter((f) => f.endsWith('.md'));
    expect(mdFiles).toHaveLength(8);
  });

  it('all files are valid SKILL.md format', async () => {
    const skills = await loadAllSkills();
    for (const { file, content } of skills) {
      expect(isSkillMarkdown(content), `${file} should have frontmatter`).toBe(true);
    }
  });

  it('all files parse without errors', async () => {
    const skills = await loadAllSkills();
    for (const { file, content } of skills) {
      const parsed = parseSkillContent(content, file);
      expect(parsed.name, `${file} should have a name`).toBeTruthy();
      expect(parsed.description, `${file} should have a description`).toBeTruthy();
      expect(parsed.version, `${file} should have a version`).toBeTruthy();
    }
  });

  it('all files pass strict validation', async () => {
    const skills = await loadAllSkills();
    for (const { file, content } of skills) {
      const parsed = parseSkillContent(content, file);
      const errors = validateSkillMetadata(parsed);
      expect(errors, `${file} has validation errors: ${JSON.stringify(errors)}`).toHaveLength(0);
    }
  });

  it('contains all expected skill names', async () => {
    const skills = await loadAllSkills();
    const names = skills.map(({ content, file }) => parseSkillContent(content, file).name).sort();
    expect(names).toEqual(EXPECTED_SKILLS);
  });

  it('all skills have unique names', async () => {
    const skills = await loadAllSkills();
    const names = skills.map(({ content, file }) => parseSkillContent(content, file).name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('all skills have agenc metadata namespace', async () => {
    const skills = await loadAllSkills();
    for (const { file, content } of skills) {
      const parsed = parseSkillContent(content, file);
      expect(parsed.metadata.emoji || parsed.metadata.tags.length > 0, `${file} should have agenc metadata`).toBeTruthy();
    }
  });

  it('all skills have tags', async () => {
    const skills = await loadAllSkills();
    for (const { file, content } of skills) {
      const parsed = parseSkillContent(content, file);
      expect(parsed.metadata.tags.length, `${file} should have at least one tag`).toBeGreaterThan(0);
    }
  });

  it('no two skills share the exact same tag set', async () => {
    const skills = await loadAllSkills();
    const tagSets = new Set<string>();
    for (const { file, content } of skills) {
      const parsed = parseSkillContent(content, file);
      const key = parsed.metadata.tags.slice().sort().join(',');
      expect(tagSets.has(key), `${file} has duplicate tag set: ${key}`).toBe(false);
      tagSets.add(key);
    }
  });

  it('all skills have non-empty markdown body', async () => {
    const skills = await loadAllSkills();
    for (const { file, content } of skills) {
      const parsed = parseSkillContent(content, file);
      expect(parsed.body.trim().length, `${file} should have a non-empty body`).toBeGreaterThan(100);
    }
  });

  it('all skills use version 1.0.0', async () => {
    const skills = await loadAllSkills();
    for (const { file, content } of skills) {
      const parsed = parseSkillContent(content, file);
      expect(parsed.version, `${file} version`).toBe('1.0.0');
    }
  });
});
