import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  detectNamespace,
  convertOpenClawSkill,
  mapOpenClawMetadata,
  importSkill,
} from './compat.js';
import { parseSkillContent } from './parser.js';
import { ValidationError } from '../../types/errors.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OPENCLAW_SKILL_MD = `---
name: openclaw-tool
description: An OpenClaw-compatible skill
version: 2.0.0
metadata:
  openclaw:
    emoji: "\u{1F4E6}"
    primaryEnv: node
    tags:
      - compat
      - defi
    requires:
      binaries:
        - node
      env:
        - API_KEY
      channels:
        - solana
      os:
        - linux
        - macos
    install:
      - type: npm
        package: openclaw-tool
      - type: download
        url: https://example.com/tool
        path: /usr/local/bin/tool
---
# OpenClaw Tool

Usage instructions here.
`;

const AGENC_SKILL_MD = `---
name: agenc-native
description: An AgenC-native skill
version: 1.0.0
metadata:
  agenc:
    emoji: "\u{1F680}"
    tags:
      - zk
    requires:
      binaries:
        - risc0-host-prover
---
# AgenC Native

Native skill body.
`;

const BOTH_NS_MD = `---
name: dual-ns
description: Both namespaces present
version: 1.0.0
metadata:
  agenc:
    emoji: "\u{1F680}"
    tags:
      - agenc-tag
  openclaw:
    emoji: "\u{1F4E6}"
    tags:
      - openclaw-tag
---
Body.
`;

const MINIMAL_MD = `---
name: minimal
description: Minimal skill
version: 0.1.0
---
Minimal body.
`;

const NOT_SKILL = `# Just a heading

Some plain markdown content.
`;

const FOUR_SPACE_OPENCLAW_MD = `---
name: indented-skill
description: Uses 4-space indentation
version: 1.0.0
metadata:
    openclaw:
        emoji: "\u{2728}"
        tags:
            - test
---
Body.
`;

// ---------------------------------------------------------------------------
// detectNamespace
// ---------------------------------------------------------------------------

describe('detectNamespace', () => {
  it('detects openclaw namespace', () => {
    expect(detectNamespace(OPENCLAW_SKILL_MD)).toBe('openclaw');
  });

  it('detects agenc namespace', () => {
    expect(detectNamespace(AGENC_SKILL_MD)).toBe('agenc');
  });

  it('returns unknown for no metadata block', () => {
    expect(detectNamespace(MINIMAL_MD)).toBe('unknown');
  });

  it('returns agenc when both namespaces present (precedence)', () => {
    expect(detectNamespace(BOTH_NS_MD)).toBe('agenc');
  });

  it('returns unknown for non-SKILL.md content', () => {
    expect(detectNamespace(NOT_SKILL)).toBe('unknown');
    expect(detectNamespace('')).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// convertOpenClawSkill
// ---------------------------------------------------------------------------

describe('convertOpenClawSkill', () => {
  it('maps openclaw: to agenc: in YAML frontmatter', () => {
    const result = convertOpenClawSkill(OPENCLAW_SKILL_MD);

    expect(result).toContain('  agenc:');
    expect(result).not.toContain('  openclaw:');
  });

  it('preserves markdown body verbatim', () => {
    const result = convertOpenClawSkill(OPENCLAW_SKILL_MD);

    expect(result).toContain('# OpenClaw Tool');
    expect(result).toContain('Usage instructions here.');
  });

  it('returns unchanged content for already-agenc skills', () => {
    const result = convertOpenClawSkill(AGENC_SKILL_MD);
    expect(result).toBe(AGENC_SKILL_MD);
  });

  it('returns unchanged content for non-SKILL.md content', () => {
    const result = convertOpenClawSkill(NOT_SKILL);
    expect(result).toBe(NOT_SKILL);
  });

  it('handles 4-space indentation', () => {
    const result = convertOpenClawSkill(FOUR_SPACE_OPENCLAW_MD);

    expect(result).toContain('    agenc:');
    expect(result).not.toContain('    openclaw:');
  });

  it('preserves all frontmatter fields', () => {
    const result = convertOpenClawSkill(OPENCLAW_SKILL_MD);

    expect(result).toContain('emoji:');
    expect(result).toContain('primaryEnv: node');
    expect(result).toContain('- compat');
    expect(result).toContain('- defi');
    expect(result).toContain('- node');
    expect(result).toContain('- API_KEY');
    expect(result).toContain('type: npm');
    expect(result).toContain('package: openclaw-tool');
  });
});

// ---------------------------------------------------------------------------
// Round-trip test
// ---------------------------------------------------------------------------

describe('convertOpenClawSkill round-trip', () => {
  it('converted skill parses correctly via parseSkillContent', () => {
    const converted = convertOpenClawSkill(OPENCLAW_SKILL_MD);
    const skill = parseSkillContent(converted);

    expect(skill.name).toBe('openclaw-tool');
    expect(skill.description).toBe('An OpenClaw-compatible skill');
    expect(skill.version).toBe('2.0.0');
    expect(skill.metadata.emoji).toBe('\u{1F4E6}');
    expect(skill.metadata.primaryEnv).toBe('node');
    expect(skill.metadata.tags).toEqual(['compat', 'defi']);
    expect(skill.metadata.requires.binaries).toEqual(['node']);
    expect(skill.metadata.requires.env).toEqual(['API_KEY']);
    expect(skill.metadata.requires.channels).toEqual(['solana']);
    expect(skill.metadata.requires.os).toEqual(['linux', 'macos']);
    expect(skill.metadata.install).toHaveLength(2);
    expect(skill.metadata.install[0]).toEqual({
      type: 'npm',
      package: 'openclaw-tool',
    });
    expect(skill.metadata.install[1]).toEqual({
      type: 'download',
      url: 'https://example.com/tool',
      path: '/usr/local/bin/tool',
    });
    expect(skill.body).toContain('# OpenClaw Tool');
  });
});

// ---------------------------------------------------------------------------
// mapOpenClawMetadata
// ---------------------------------------------------------------------------

describe('mapOpenClawMetadata', () => {
  it('maps all known fields', () => {
    const meta = mapOpenClawMetadata({
      emoji: '\u{1F4E6}',
      primaryEnv: 'node',
      requires: {
        binaries: ['node', 'npm'],
        env: ['API_KEY'],
        channels: ['solana'],
        os: ['linux'],
      },
      install: [
        { type: 'npm', package: 'my-tool' },
        { type: 'download', url: 'https://example.com/bin', path: '/usr/local/bin/tool' },
      ],
      tags: ['defi', 'swap'],
    });

    expect(meta.emoji).toBe('\u{1F4E6}');
    expect(meta.primaryEnv).toBe('node');
    expect(meta.requires.binaries).toEqual(['node', 'npm']);
    expect(meta.requires.env).toEqual(['API_KEY']);
    expect(meta.requires.channels).toEqual(['solana']);
    expect(meta.requires.os).toEqual(['linux']);
    expect(meta.install).toHaveLength(2);
    expect(meta.install[0]).toEqual({ type: 'npm', package: 'my-tool' });
    expect(meta.install[1]).toEqual({
      type: 'download',
      url: 'https://example.com/bin',
      path: '/usr/local/bin/tool',
    });
    expect(meta.tags).toEqual(['defi', 'swap']);
  });

  it('leaves AgenC-only fields undefined when absent', () => {
    const meta = mapOpenClawMetadata({
      emoji: '\u{1F4E6}',
      tags: ['test'],
    });

    expect(meta.requiredCapabilities).toBeUndefined();
    expect(meta.onChainAuthor).toBeUndefined();
    expect(meta.contentHash).toBeUndefined();
  });

  it('handles empty/missing fields gracefully', () => {
    const meta = mapOpenClawMetadata({});

    expect(meta.emoji).toBeUndefined();
    expect(meta.primaryEnv).toBeUndefined();
    expect(meta.requires.binaries).toEqual([]);
    expect(meta.requires.env).toEqual([]);
    expect(meta.requires.channels).toEqual([]);
    expect(meta.requires.os).toEqual([]);
    expect(meta.install).toEqual([]);
    expect(meta.tags).toEqual([]);
  });

  it('maps install instructions correctly', () => {
    const meta = mapOpenClawMetadata({
      install: [
        { type: 'brew', package: 'my-brew-pkg' },
        { type: 'npm', package: '@scope/pkg' },
        { type: 'download', url: 'https://example.com/bin' },
      ],
    });

    expect(meta.install).toHaveLength(3);
    expect(meta.install[0]).toEqual({ type: 'brew', package: 'my-brew-pkg' });
    expect(meta.install[1]).toEqual({ type: 'npm', package: '@scope/pkg' });
    expect(meta.install[2]).toEqual({ type: 'download', url: 'https://example.com/bin' });
  });

  it('preserves requirements structure', () => {
    const meta = mapOpenClawMetadata({
      requires: {
        binaries: ['python3'],
        env: ['HOME', 'PATH'],
        channels: ['telegram'],
        os: ['macos', 'linux'],
      },
    });

    expect(meta.requires.binaries).toEqual(['python3']);
    expect(meta.requires.env).toEqual(['HOME', 'PATH']);
    expect(meta.requires.channels).toEqual(['telegram']);
    expect(meta.requires.os).toEqual(['macos', 'linux']);
  });
});

// ---------------------------------------------------------------------------
// importSkill
// ---------------------------------------------------------------------------

describe('importSkill', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'import-skill-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('imports and converts an openclaw skill from local path', async () => {
    const srcPath = join(tmpDir, 'source.md');
    await writeFile(srcPath, OPENCLAW_SKILL_MD, 'utf-8');

    const targetDir = join(tmpDir, 'imported');
    const result = await importSkill(srcPath, targetDir);

    expect(result.converted).toBe(true);
    expect(result.path).toBe(join(targetDir, 'openclaw-tool.md'));

    const written = await readFile(result.path, 'utf-8');
    expect(written).toContain('  agenc:');
    expect(written).not.toContain('  openclaw:');
  });

  it('imports an agenc skill without conversion', async () => {
    const srcPath = join(tmpDir, 'source.md');
    await writeFile(srcPath, AGENC_SKILL_MD, 'utf-8');

    const targetDir = join(tmpDir, 'imported');
    const result = await importSkill(srcPath, targetDir);

    expect(result.converted).toBe(false);
    expect(result.path).toBe(join(targetDir, 'agenc-native.md'));

    const written = await readFile(result.path, 'utf-8');
    expect(written).toBe(AGENC_SKILL_MD);
  });

  it('throws for non-existent file', async () => {
    await expect(
      importSkill(join(tmpDir, 'does-not-exist.md'), join(tmpDir, 'out')),
    ).rejects.toThrow();
  });

  it('sanitizes unsafe skill names', async () => {
    // Skill with spaces in name
    const md = `---
name: my cool skill
description: Spaces in name
version: 1.0.0
---
Body.
`;
    const srcPath = join(tmpDir, 'source.md');
    await writeFile(srcPath, md, 'utf-8');

    const targetDir = join(tmpDir, 'imported');
    const result = await importSkill(srcPath, targetDir);

    expect(result.path).toBe(join(targetDir, 'my-cool-skill.md'));
  });

  it('rejects skill names with path traversal', async () => {
    const md = `---
name: ../evil
description: Traversal attempt
version: 1.0.0
---
Body.
`;
    const srcPath = join(tmpDir, 'source.md');
    await writeFile(srcPath, md, 'utf-8');

    await expect(
      importSkill(srcPath, join(tmpDir, 'out')),
    ).rejects.toThrow(ValidationError);
    await expect(
      importSkill(srcPath, join(tmpDir, 'out')),
    ).rejects.toThrow('Invalid skill name');
  });

  it('rejects skill names with path separators', async () => {
    const md = `---
name: foo/bar
description: Slash in name
version: 1.0.0
---
Body.
`;
    const srcPath = join(tmpDir, 'source.md');
    await writeFile(srcPath, md, 'utf-8');

    await expect(
      importSkill(srcPath, join(tmpDir, 'out')),
    ).rejects.toThrow(ValidationError);
    await expect(
      importSkill(srcPath, join(tmpDir, 'out')),
    ).rejects.toThrow('Invalid skill name');
  });

  it('creates target directory if missing', async () => {
    const srcPath = join(tmpDir, 'source.md');
    await writeFile(srcPath, AGENC_SKILL_MD, 'utf-8');

    const nested = join(tmpDir, 'deep', 'nested', 'dir');
    const result = await importSkill(srcPath, nested);

    expect(result.path).toBe(join(nested, 'agenc-native.md'));
    const written = await readFile(result.path, 'utf-8');
    expect(written).toBe(AGENC_SKILL_MD);
  });

  describe('URL fetch', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('fetches and imports from URL', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-length': String(Buffer.byteLength(OPENCLAW_SKILL_MD)) }),
        text: () => Promise.resolve(OPENCLAW_SKILL_MD),
      });

      const targetDir = join(tmpDir, 'imported');
      const result = await importSkill('https://example.com/SKILL.md', targetDir);

      expect(result.converted).toBe(true);
      expect(result.path).toBe(join(targetDir, 'openclaw-tool.md'));

      const written = await readFile(result.path, 'utf-8');
      expect(written).toContain('  agenc:');
    });

    it('throws on fetch failure (404)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers(),
      });

      await expect(
        importSkill('https://example.com/missing.md', join(tmpDir, 'out')),
      ).rejects.toThrow(ValidationError);
      await expect(
        importSkill('https://example.com/missing.md', join(tmpDir, 'out')),
      ).rejects.toThrow('Failed to fetch skill: HTTP 404');
    });

    it('throws when content-length exceeds limit', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-length': '2000000' }),
        text: () => Promise.resolve(''),
      });

      await expect(
        importSkill('https://example.com/huge.md', join(tmpDir, 'out')),
      ).rejects.toThrow(ValidationError);
      await expect(
        importSkill('https://example.com/huge.md', join(tmpDir, 'out')),
      ).rejects.toThrow('1MB size limit');
    });
  });
});
