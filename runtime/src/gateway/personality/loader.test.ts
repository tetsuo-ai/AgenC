import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonalityLoader, getDefaultPersonalityPath, validatePersonalityConfig } from './loader.js';
import { formatPersonality } from './formatter.js';
import { GatewayValidationError } from '../errors.js';
import type { PersonalityConfig } from './types.js';

// ============================================================================
// Helpers
// ============================================================================

const VALID_CONFIG: PersonalityConfig = {
  name: 'Test Agent',
  description: 'A test personality.',
  style: 'technical',
  tone: ['professional', 'direct'],
  traits: [
    { name: 'Precision', description: 'Values accuracy', intensity: 0.9 },
    { name: 'Brevity', description: 'Keeps it short', intensity: 0.5 },
  ],
  preferences: {
    length: 'concise',
    structure: 'bulleted',
    examples: true,
    codeBlocks: true,
  },
};

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agenc-personality-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true });
});

// ============================================================================
// getDefaultPersonalityPath
// ============================================================================

describe('getDefaultPersonalityPath', () => {
  it('returns a path under ~/.agenc/', () => {
    const path = getDefaultPersonalityPath();
    expect(path).toContain('.agenc');
    expect(path).toContain('personality.json');
  });
});

// ============================================================================
// PersonalityLoader
// ============================================================================

describe('PersonalityLoader', () => {
  it('returns undefined when file does not exist', async () => {
    const loader = new PersonalityLoader(join(tmpDir, 'nonexistent.json'));
    const result = await loader.load();
    expect(result).toBeUndefined();
  });

  it('loads valid personality config', async () => {
    const filePath = join(tmpDir, 'personality.json');
    await writeFile(filePath, JSON.stringify(VALID_CONFIG));

    const loader = new PersonalityLoader(filePath);
    const result = await loader.load();

    expect(result).toBeDefined();
    expect(result!.name).toBe('Test Agent');
    expect(result!.style).toBe('technical');
    expect(result!.tone).toEqual(['professional', 'direct']);
    expect(result!.traits).toHaveLength(2);
    expect(result!.preferences.length).toBe('concise');
  });

  it('throws GatewayValidationError for invalid JSON syntax', async () => {
    const filePath = join(tmpDir, 'bad.json');
    await writeFile(filePath, '{ not valid json');

    const loader = new PersonalityLoader(filePath);
    await expect(loader.load()).rejects.toThrow(GatewayValidationError);
    await expect(loader.load()).rejects.toThrow('invalid JSON');
  });

  it('uses default path when no argument given', () => {
    const loader = new PersonalityLoader();
    expect(loader.path).toBe(getDefaultPersonalityPath());
  });
});

// ============================================================================
// validatePersonalityConfig
// ============================================================================

describe('validatePersonalityConfig', () => {
  it('accepts a valid config', () => {
    const result = validatePersonalityConfig(VALID_CONFIG);
    expect(result.name).toBe('Test Agent');
  });

  it('rejects non-object input', () => {
    expect(() => validatePersonalityConfig('string')).toThrow(GatewayValidationError);
    expect(() => validatePersonalityConfig(null)).toThrow(GatewayValidationError);
    expect(() => validatePersonalityConfig([1, 2])).toThrow(GatewayValidationError);
  });

  it('rejects missing name', () => {
    const { name: _, ...rest } = VALID_CONFIG;
    expect(() => validatePersonalityConfig(rest)).toThrow('name');
  });

  it('rejects empty name', () => {
    expect(() => validatePersonalityConfig({ ...VALID_CONFIG, name: '' })).toThrow('name');
  });

  it('rejects missing description', () => {
    const { description: _, ...rest } = VALID_CONFIG;
    expect(() => validatePersonalityConfig(rest)).toThrow('description');
  });

  it('rejects invalid style', () => {
    expect(() => validatePersonalityConfig({ ...VALID_CONFIG, style: 'aggressive' })).toThrow('style');
  });

  it('rejects empty tone array', () => {
    expect(() => validatePersonalityConfig({ ...VALID_CONFIG, tone: [] })).toThrow('tone');
  });

  it('rejects invalid tone value', () => {
    expect(() => validatePersonalityConfig({ ...VALID_CONFIG, tone: ['friendly', 'angry'] })).toThrow('tone');
  });

  it('rejects non-array tone', () => {
    expect(() => validatePersonalityConfig({ ...VALID_CONFIG, tone: 'friendly' })).toThrow('tone');
  });

  it('rejects non-array traits', () => {
    expect(() => validatePersonalityConfig({ ...VALID_CONFIG, traits: 'none' })).toThrow('traits');
  });

  it('accepts empty traits array', () => {
    const result = validatePersonalityConfig({ ...VALID_CONFIG, traits: [] });
    expect(result.traits).toHaveLength(0);
  });

  it('rejects trait with intensity out of range', () => {
    const bad = { ...VALID_CONFIG, traits: [{ name: 'X', description: 'Y', intensity: 1.5 }] };
    expect(() => validatePersonalityConfig(bad)).toThrow('intensity');
  });

  it('rejects trait with negative intensity', () => {
    const bad = { ...VALID_CONFIG, traits: [{ name: 'X', description: 'Y', intensity: -0.1 }] };
    expect(() => validatePersonalityConfig(bad)).toThrow('intensity');
  });

  it('rejects trait missing name', () => {
    const bad = { ...VALID_CONFIG, traits: [{ description: 'Y', intensity: 0.5 }] };
    expect(() => validatePersonalityConfig(bad)).toThrow('name');
  });

  it('rejects invalid preferences.length', () => {
    const bad = { ...VALID_CONFIG, preferences: { ...VALID_CONFIG.preferences, length: 'verbose' } };
    expect(() => validatePersonalityConfig(bad)).toThrow('preferences.length');
  });

  it('rejects invalid preferences.structure', () => {
    const bad = { ...VALID_CONFIG, preferences: { ...VALID_CONFIG.preferences, structure: 'table' } };
    expect(() => validatePersonalityConfig(bad)).toThrow('preferences.structure');
  });

  it('rejects non-boolean preferences.examples', () => {
    const bad = { ...VALID_CONFIG, preferences: { ...VALID_CONFIG.preferences, examples: 'yes' } };
    expect(() => validatePersonalityConfig(bad)).toThrow('preferences.examples');
  });

  it('rejects non-boolean preferences.codeBlocks', () => {
    const bad = { ...VALID_CONFIG, preferences: { ...VALID_CONFIG.preferences, codeBlocks: 1 } };
    expect(() => validatePersonalityConfig(bad)).toThrow('preferences.codeBlocks');
  });

  it('rejects missing preferences', () => {
    const { preferences: _, ...rest } = VALID_CONFIG;
    expect(() => validatePersonalityConfig(rest)).toThrow('preferences');
  });
});

// ============================================================================
// formatPersonality
// ============================================================================

describe('formatPersonality', () => {
  it('renders name and description', () => {
    const result = formatPersonality(VALID_CONFIG);
    expect(result).toContain('## Personality: Test Agent');
    expect(result).toContain('A test personality.');
  });

  it('renders communication style', () => {
    const result = formatPersonality(VALID_CONFIG);
    expect(result).toContain('Use a **technical** communication style.');
  });

  it('renders tone values joined with "and"', () => {
    const result = formatPersonality(VALID_CONFIG);
    expect(result).toContain('**professional** and **direct**');
  });

  it('renders traits with intensity labels', () => {
    const result = formatPersonality(VALID_CONFIG);
    expect(result).toContain('**Precision** (high): Values accuracy');
    expect(result).toContain('**Brevity** (medium): Keeps it short');
  });

  it('skips traits section when empty', () => {
    const config = { ...VALID_CONFIG, traits: [] };
    const result = formatPersonality(config);
    expect(result).not.toContain('### Traits');
  });

  it('renders response preferences', () => {
    const result = formatPersonality(VALID_CONFIG);
    expect(result).toContain('- Length: concise');
    expect(result).toContain('- Structure: bulleted');
    expect(result).toContain('- Examples: yes');
    expect(result).toContain('- Code blocks: yes');
  });

  it('maps low intensity correctly', () => {
    const config: PersonalityConfig = {
      ...VALID_CONFIG,
      traits: [{ name: 'Calm', description: 'Stays calm', intensity: 0.2 }],
    };
    const result = formatPersonality(config);
    expect(result).toContain('(low)');
  });

  it('maps boundary intensity 0.33 to low', () => {
    const config: PersonalityConfig = {
      ...VALID_CONFIG,
      traits: [{ name: 'X', description: 'Y', intensity: 0.33 }],
    };
    const result = formatPersonality(config);
    expect(result).toContain('(low)');
  });

  it('maps boundary intensity 0.66 to medium', () => {
    const config: PersonalityConfig = {
      ...VALID_CONFIG,
      traits: [{ name: 'X', description: 'Y', intensity: 0.66 }],
    };
    const result = formatPersonality(config);
    expect(result).toContain('(medium)');
  });
});
