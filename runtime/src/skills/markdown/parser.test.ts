import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  parseSkillContent,
  parseSkillFile,
  validateSkillMetadata,
  isSkillMarkdown,
} from './parser.js';

const FULL_SKILL_MD = `---
name: solana-tools
description: Solana blockchain tools for agent operations
version: 1.0.0
metadata:
  agenc:
    emoji: "🔧"
    primaryEnv: SOLANA_RPC_URL
    requires:
      binaries:
        - solana
        - anchor
      env:
        - SOLANA_RPC_URL
        - ANCHOR_WALLET
      channels:
        - telegram
      os:
        - linux
        - darwin
    install:
      - type: npm
        package: "@solana/web3.js"
      - type: cargo
        package: anchor-cli
    tags:
      - solana
      - defi
      - blockchain
    requiredCapabilities: "0x0f"
    onChainAuthor: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
    contentHash: "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco"
---

# Solana Tools

Use these tools to interact with the Solana blockchain.

## Available Commands

- \`solana balance\` — Check wallet balance
- \`anchor deploy\` — Deploy a program
`;

const MINIMAL_SKILL_MD = `---
name: minimal-skill
description: A minimal skill
version: 0.1.0
---

Minimal body.
`;

const OPENCLAW_SKILL_MD = `---
name: openclaw-skill
description: An OpenClaw compatible skill
version: 2.0.0
metadata:
  openclaw:
    emoji: "🐾"
    tags:
      - compat
      - openclaw
    requires:
      binaries:
        - git
---

OpenClaw compatible skill body.
`;

describe('parseSkillContent', () => {
  it('parses valid SKILL.md with all frontmatter fields', () => {
    const skill = parseSkillContent(FULL_SKILL_MD, '/skills/solana/SKILL.md');

    expect(skill.name).toBe('solana-tools');
    expect(skill.description).toBe('Solana blockchain tools for agent operations');
    expect(skill.version).toBe('1.0.0');
    expect(skill.sourcePath).toBe('/skills/solana/SKILL.md');

    // Metadata
    expect(skill.metadata.emoji).toBe('🔧');
    expect(skill.metadata.primaryEnv).toBe('SOLANA_RPC_URL');
    expect(skill.metadata.requiredCapabilities).toBe('0x0f');
    expect(skill.metadata.onChainAuthor).toBe(
      '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    );
    expect(skill.metadata.contentHash).toBe(
      'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
    );

    // Requirements
    expect(skill.metadata.requires.binaries).toEqual(['solana', 'anchor']);
    expect(skill.metadata.requires.env).toEqual([
      'SOLANA_RPC_URL',
      'ANCHOR_WALLET',
    ]);
    expect(skill.metadata.requires.channels).toEqual(['telegram']);
    expect(skill.metadata.requires.os).toEqual(['linux', 'darwin']);

    // Install steps
    expect(skill.metadata.install).toHaveLength(2);
    expect(skill.metadata.install[0]).toEqual({
      type: 'npm',
      package: '@solana/web3.js',
    });
    expect(skill.metadata.install[1]).toEqual({
      type: 'cargo',
      package: 'anchor-cli',
    });

    // Tags
    expect(skill.metadata.tags).toEqual(['solana', 'defi', 'blockchain']);
  });

  it('parses SKILL.md with minimal frontmatter', () => {
    const skill = parseSkillContent(MINIMAL_SKILL_MD);

    expect(skill.name).toBe('minimal-skill');
    expect(skill.description).toBe('A minimal skill');
    expect(skill.version).toBe('0.1.0');
    expect(skill.metadata.requires.binaries).toEqual([]);
    expect(skill.metadata.requires.env).toEqual([]);
    expect(skill.metadata.install).toEqual([]);
    expect(skill.metadata.tags).toEqual([]);
    expect(skill.body).toBe('Minimal body.\n');
  });

  it('parses SKILL.md with metadata.openclaw namespace (OpenClaw compat)', () => {
    const skill = parseSkillContent(OPENCLAW_SKILL_MD);

    expect(skill.name).toBe('openclaw-skill');
    expect(skill.version).toBe('2.0.0');
    expect(skill.metadata.emoji).toBe('🐾');
    expect(skill.metadata.tags).toEqual(['compat', 'openclaw']);
    expect(skill.metadata.requires.binaries).toEqual(['git']);
  });

  it('prefers metadata.agenc over metadata.openclaw', () => {
    const content = `---
name: dual-ns
description: Both namespaces
version: 1.0.0
metadata:
  agenc:
    tags:
      - agenc-tag
  openclaw:
    tags:
      - openclaw-tag
---

Body.
`;
    const skill = parseSkillContent(content);
    expect(skill.metadata.tags).toEqual(['agenc-tag']);
  });

  it('preserves markdown body formatting', () => {
    const skill = parseSkillContent(FULL_SKILL_MD);
    expect(skill.body).toContain('# Solana Tools');
    expect(skill.body).toContain('## Available Commands');
    expect(skill.body).toContain('`solana balance`');
  });

  it('returns empty string body for frontmatter-only content', () => {
    const content = `---
name: no-body
description: No body content
version: 1.0.0
---
`;
    const skill = parseSkillContent(content);
    expect(skill.body).toBe('');
  });

  it('ignores unknown frontmatter fields (lenient parsing)', () => {
    const content = `---
name: lenient
description: Lenient parsing test
version: 1.0.0
customField: should be ignored
anotherOne:
  nested: true
---

Body.
`;
    const skill = parseSkillContent(content);
    expect(skill.name).toBe('lenient');
    expect(skill.body).toBe('Body.\n');
  });

  it('handles content without frontmatter', () => {
    const content = '# Just Markdown\n\nNo frontmatter here.';
    const skill = parseSkillContent(content);
    expect(skill.name).toBe('');
    expect(skill.body).toBe(content);
  });

  it('handles numeric version in frontmatter', () => {
    const content = `---
name: numeric-ver
description: Numeric version
version: 2.0
---
`;
    const skill = parseSkillContent(content);
    // YAML parses 2.0 as float 2, which stringifies to "2"
    expect(skill.version).toBe('2');
  });

  it('parses SKILL.md with install instructions', () => {
    const content = `---
name: install-test
description: Install test
version: 1.0.0
metadata:
  agenc:
    install:
      - type: brew
        package: solana
      - type: download
        url: https://example.com/tool
        path: /usr/local/bin/tool
---
`;
    const skill = parseSkillContent(content);
    expect(skill.metadata.install).toHaveLength(2);
    expect(skill.metadata.install[0]).toEqual({ type: 'brew', package: 'solana' });
    expect(skill.metadata.install[1]).toEqual({
      type: 'download',
      url: 'https://example.com/tool',
      path: '/usr/local/bin/tool',
    });
  });
});

describe('parseSkillFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'skill-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  it('reads and parses a SKILL.md file from disk', async () => {
    const filePath = join(tmpDir, 'SKILL.md');
    await writeFile(filePath, MINIMAL_SKILL_MD, 'utf-8');

    const skill = await parseSkillFile(filePath);
    expect(skill.name).toBe('minimal-skill');
    expect(skill.sourcePath).toBe(filePath);
  });
});

describe('validateSkillMetadata', () => {
  it('returns no errors for valid skill', () => {
    const skill = parseSkillContent(FULL_SKILL_MD);
    const errors = validateSkillMetadata(skill);
    expect(errors).toEqual([]);
  });

  it('returns error for missing name', () => {
    const content = `---
description: No name
version: 1.0.0
---
`;
    const skill = parseSkillContent(content);
    const errors = validateSkillMetadata(skill);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('name');
  });

  it('returns error for missing description', () => {
    const content = `---
name: no-desc
version: 1.0.0
---
`;
    const skill = parseSkillContent(content);
    const errors = validateSkillMetadata(skill);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('description');
  });

  it('returns error for missing version', () => {
    const content = `---
name: no-ver
description: No version
---
`;
    const skill = parseSkillContent(content);
    const errors = validateSkillMetadata(skill);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('version');
  });

  it('returns multiple errors when all required fields missing', () => {
    const content = `---
customField: true
---
`;
    const skill = parseSkillContent(content);
    const errors = validateSkillMetadata(skill);
    expect(errors).toHaveLength(3);
    const fields = errors.map((e) => e.field);
    expect(fields).toContain('name');
    expect(fields).toContain('description');
    expect(fields).toContain('version');
  });
});

describe('isSkillMarkdown', () => {
  it('returns true for content with frontmatter', () => {
    expect(isSkillMarkdown(FULL_SKILL_MD)).toBe(true);
    expect(isSkillMarkdown(MINIMAL_SKILL_MD)).toBe(true);
  });

  it('returns false for plain markdown without frontmatter', () => {
    expect(isSkillMarkdown('# Just a header\n\nSome text.')).toBe(false);
    expect(isSkillMarkdown('')).toBe(false);
  });

  it('returns true even with leading whitespace', () => {
    expect(isSkillMarkdown('  ---\nname: test\n---\n')).toBe(true);
  });
});
