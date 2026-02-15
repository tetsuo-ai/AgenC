/**
 * SKILL.md parser — extracts YAML frontmatter and markdown body.
 *
 * Skills are passive documentation injected into the LLM system prompt.
 * The format is compatible with OpenClaw's SKILL.md for ecosystem
 * portability, with AgenC-specific extensions in the `metadata.agenc`
 * namespace.
 *
 * @module
 */

import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import type {
  MarkdownSkill,
  SkillMetadataBlock,
  SkillRequirements,
  SkillInstallStep,
  SkillParseError,
} from './types.js';

// ============================================================================
// Frontmatter Extraction
// ============================================================================

const FRONTMATTER_OPEN = '---';

interface FrontmatterResult {
  frontmatter: string;
  body: string;
}

function extractFrontmatter(content: string): FrontmatterResult | null {
  const lines = content.split('\n');
  if (lines.length === 0 || lines[0].trim() !== FRONTMATTER_OPEN) {
    return null;
  }

  let closeIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === FRONTMATTER_OPEN) {
      closeIndex = i;
      break;
    }
  }

  if (closeIndex === -1) {
    return null;
  }

  const frontmatter = lines.slice(1, closeIndex).join('\n');
  const body = lines.slice(closeIndex + 1).join('\n');

  return { frontmatter, body };
}

// ============================================================================
// Metadata Normalization
// ============================================================================

function toStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function normalizeRequirements(raw: unknown): SkillRequirements {
  if (typeof raw !== 'object' || raw === null) {
    return { binaries: [], env: [], channels: [], os: [] };
  }
  const obj = raw as Record<string, unknown>;
  return {
    binaries: toStringArray(obj.binaries),
    env: toStringArray(obj.env),
    channels: toStringArray(obj.channels),
    os: toStringArray(obj.os),
  };
}

const VALID_INSTALL_TYPES = new Set(['brew', 'apt', 'npm', 'cargo', 'download']);

function normalizeInstallSteps(raw: unknown): readonly SkillInstallStep[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
    )
    .filter((item) => typeof item.type === 'string' && VALID_INSTALL_TYPES.has(item.type))
    .map((item): SkillInstallStep => ({
      type: item.type as SkillInstallStep['type'],
      ...(typeof item.package === 'string' ? { package: item.package } : {}),
      ...(typeof item.url === 'string' ? { url: item.url } : {}),
      ...(typeof item.path === 'string' ? { path: item.path } : {}),
    }));
}

function normalizeMetadata(raw: unknown): SkillMetadataBlock {
  if (typeof raw !== 'object' || raw === null) {
    return {
      requires: { binaries: [], env: [], channels: [], os: [] },
      install: [],
      tags: [],
    };
  }
  const obj = raw as Record<string, unknown>;
  return {
    emoji: typeof obj.emoji === 'string' ? obj.emoji : undefined,
    requires: normalizeRequirements(obj.requires),
    primaryEnv: typeof obj.primaryEnv === 'string' ? obj.primaryEnv : undefined,
    install: normalizeInstallSteps(obj.install),
    tags: toStringArray(obj.tags),
    requiredCapabilities:
      typeof obj.requiredCapabilities === 'string'
        ? obj.requiredCapabilities
        : undefined,
    onChainAuthor:
      typeof obj.onChainAuthor === 'string' ? obj.onChainAuthor : undefined,
    contentHash:
      typeof obj.contentHash === 'string' ? obj.contentHash : undefined,
  };
}

/**
 * Resolve the metadata block from parsed YAML, accepting both
 * `metadata.agenc` and `metadata.openclaw` namespaces. The `agenc`
 * namespace takes precedence; `openclaw` is normalized to `agenc`.
 */
function resolveMetadataNamespace(
  parsed: Record<string, unknown>,
): SkillMetadataBlock {
  const meta = parsed.metadata as Record<string, unknown> | undefined;
  if (typeof meta !== 'object' || meta === null) {
    return normalizeMetadata(undefined);
  }

  // agenc namespace takes precedence
  if (meta.agenc !== undefined) {
    return normalizeMetadata(meta.agenc);
  }
  // OpenClaw compatibility
  if (meta.openclaw !== undefined) {
    return normalizeMetadata(meta.openclaw);
  }

  return normalizeMetadata(undefined);
}

// ============================================================================
// Public API
// ============================================================================

/** Check if content looks like a SKILL.md file (has YAML frontmatter). */
export function isSkillMarkdown(content: string): boolean {
  return content.trimStart().startsWith(FRONTMATTER_OPEN + '\n') ||
    content.trimStart().startsWith(FRONTMATTER_OPEN + '\r\n');
}

/** Parse SKILL.md content from a string. */
export function parseSkillContent(
  content: string,
  sourcePath = '<string>',
): MarkdownSkill {
  const result = extractFrontmatter(content);
  if (!result) {
    return {
      name: '',
      description: '',
      version: '',
      metadata: normalizeMetadata(undefined),
      body: content,
      sourcePath,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYaml(result.frontmatter) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  if (typeof parsed !== 'object' || parsed === null) {
    parsed = {};
  }

  const name = typeof parsed.name === 'string' ? parsed.name : '';
  const description =
    typeof parsed.description === 'string' ? parsed.description : '';
  const version = typeof parsed.version === 'string'
    ? parsed.version
    : typeof parsed.version === 'number'
      ? String(parsed.version)
      : '';

  const metadata = resolveMetadataNamespace(parsed);

  // Trim leading newline from body but preserve the rest
  const body = result.body.startsWith('\n')
    ? result.body.slice(1)
    : result.body;

  return {
    name,
    description,
    version,
    metadata,
    body,
    sourcePath,
  };
}

/** Parse a SKILL.md file from a file path. */
export async function parseSkillFile(filePath: string): Promise<MarkdownSkill> {
  const content = await readFile(filePath, 'utf-8');
  return parseSkillContent(content, filePath);
}

/** Validate parsed skill metadata. Returns an array of errors (empty = valid). */
export function validateSkillMetadata(skill: MarkdownSkill): SkillParseError[] {
  const errors: SkillParseError[] = [];

  if (!skill.name || skill.name.trim().length === 0) {
    errors.push({ field: 'name', message: 'Skill name is required' });
  }

  if (!skill.description || skill.description.trim().length === 0) {
    errors.push({
      field: 'description',
      message: 'Skill description is required',
    });
  }

  if (!skill.version || skill.version.trim().length === 0) {
    errors.push({ field: 'version', message: 'Skill version is required' });
  }

  return errors;
}
