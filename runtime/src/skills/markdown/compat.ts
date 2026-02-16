/**
 * OpenClaw ↔ AgenC SKILL.md compatibility bridge.
 *
 * Provides detection, mapping, conversion, and import of OpenClaw-format
 * SKILL.md files into the AgenC namespace. The SKILL.md parser already
 * reads both `metadata.openclaw` and `metadata.agenc` at parse time; this
 * module adds the ability to **permanently convert** a file for import.
 *
 * @module
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSkillMarkdown, parseSkillContent } from './parser.js';
import type {
  MarkdownSkillMetadata,
  SkillInstallStep,
  SkillRequirements,
} from './types.js';
import { ValidationError } from '../../types/errors.js';

/** Maximum file size accepted by {@link importSkill} (1 MB). */
const MAX_IMPORT_SIZE = 1_048_576;

/** Timeout for URL fetches in {@link importSkill}. */
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Type-safe YAML accessors (mirrors parser.ts helpers, inlined to avoid
// coupling to parser internals)
// ---------------------------------------------------------------------------

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  return val !== undefined && val !== null ? String(val) : undefined;
}

function getObject(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const val = obj[key];
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    return val as Record<string, unknown>;
  }
  return undefined;
}

function getArray(obj: Record<string, unknown>, key: string): unknown[] {
  const val = obj[key];
  return Array.isArray(val) ? val : [];
}

function getStringArray(obj: Record<string, unknown>, key: string): string[] {
  return getArray(obj, key)
    .filter((item) => item !== null && item !== undefined)
    .map(String);
}

// ---------------------------------------------------------------------------
// detectNamespace
// ---------------------------------------------------------------------------

/**
 * Detect whether a SKILL.md file uses the `openclaw` or `agenc` metadata
 * namespace.
 *
 * When both namespaces are present, returns `'agenc'` to match the parser
 * precedence at `parser.ts:136`. Returns `'unknown'` for non-SKILL.md
 * content or when neither namespace is found.
 */
export function detectNamespace(content: string): 'openclaw' | 'agenc' | 'unknown' {
  if (!isSkillMarkdown(content)) return 'unknown';

  // Extract frontmatter between the two --- delimiters
  const afterOpening = content.indexOf('\n') + 1;
  const closingIndex = content.indexOf('\n---', afterOpening);
  const frontmatter = closingIndex === -1
    ? content.slice(afterOpening)
    : content.slice(afterOpening, closingIndex);

  let hasAgenc = false;
  let hasOpenclaw = false;

  for (const line of frontmatter.split(/\r?\n/)) {
    if (/^\s+agenc:\s*$/.test(line)) hasAgenc = true;
    if (/^\s+openclaw:\s*$/.test(line)) hasOpenclaw = true;
  }

  if (hasAgenc) return 'agenc';
  if (hasOpenclaw) return 'openclaw';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// mapOpenClawMetadata
// ---------------------------------------------------------------------------

/**
 * Map an OpenClaw metadata record to the AgenC {@link MarkdownSkillMetadata}
 * structure.
 *
 * The OpenClaw and AgenC namespaces share the same field names; this function
 * applies type-safe extraction identical to the parser's `extractMetadata`.
 * AgenC-only fields (`requiredCapabilities`, `onChainAuthor`, `contentHash`)
 * are included when present in the input but will typically be `undefined`
 * for OpenClaw sources.
 */
export function mapOpenClawMetadata(
  openclawMeta: Record<string, unknown>,
): MarkdownSkillMetadata {
  const requiresObj = getObject(openclawMeta, 'requires') ?? {};
  const requires: SkillRequirements = {
    binaries: getStringArray(requiresObj, 'binaries'),
    env: getStringArray(requiresObj, 'env'),
    channels: getStringArray(requiresObj, 'channels'),
    os: getStringArray(requiresObj, 'os'),
  };

  const rawInstall = getArray(openclawMeta, 'install');
  const install: SkillInstallStep[] = [];
  for (const item of rawInstall) {
    if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const stepObj = item as Record<string, unknown>;
      const type = getString(stepObj, 'type') ?? '';
      install.push({
        type: type as SkillInstallStep['type'],
        ...(stepObj.package !== undefined ? { package: String(stepObj.package) } : {}),
        ...(stepObj.url !== undefined ? { url: String(stepObj.url) } : {}),
        ...(stepObj.path !== undefined ? { path: String(stepObj.path) } : {}),
      });
    }
  }

  return {
    ...(openclawMeta.emoji !== undefined ? { emoji: String(openclawMeta.emoji) } : {}),
    requires,
    ...(openclawMeta.primaryEnv !== undefined
      ? { primaryEnv: String(openclawMeta.primaryEnv) }
      : {}),
    install,
    tags: getStringArray(openclawMeta, 'tags'),
    ...(openclawMeta.requiredCapabilities !== undefined
      ? { requiredCapabilities: String(openclawMeta.requiredCapabilities) }
      : {}),
    ...(openclawMeta.onChainAuthor !== undefined
      ? { onChainAuthor: String(openclawMeta.onChainAuthor) }
      : {}),
    ...(openclawMeta.contentHash !== undefined
      ? { contentHash: String(openclawMeta.contentHash) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// convertOpenClawSkill
// ---------------------------------------------------------------------------

/**
 * Convert an OpenClaw SKILL.md file to AgenC format by replacing the
 * `openclaw:` namespace key with `agenc:` inside the YAML frontmatter.
 *
 * All other content (fields, comments, unknown keys, markdown body) is
 * preserved verbatim. Indentation is maintained by using a capture group
 * on the leading whitespace.
 *
 * Returns the content unchanged when it is not a valid SKILL.md or already
 * uses the `agenc` namespace.
 */
export function convertOpenClawSkill(content: string): string {
  if (!isSkillMarkdown(content)) return content;
  if (detectNamespace(content) !== 'openclaw') return content;

  // Find frontmatter boundaries
  const afterOpening = content.indexOf('\n') + 1;
  const closingIndex = content.indexOf('\n---', afterOpening);

  const frontmatter = closingIndex === -1
    ? content.slice(afterOpening)
    : content.slice(afterOpening, closingIndex);

  // Replace only within frontmatter, preserving indentation
  const converted = frontmatter.replace(
    /^(\s+)openclaw:(\s*)$/m,
    '$1agenc:$2',
  );

  if (closingIndex === -1) {
    return content.slice(0, afterOpening) + converted;
  }

  return content.slice(0, afterOpening) + converted + content.slice(closingIndex);
}

// ---------------------------------------------------------------------------
// importSkill
// ---------------------------------------------------------------------------

/**
 * Import a SKILL.md file from a local path or URL into a target directory,
 * converting from OpenClaw format if necessary.
 *
 * Safety checks mirror `skills-cli.ts`:
 * - 1 MB size limit (checked via `content-length` header and body size)
 * - 30 s fetch timeout
 * - Filename sanitization (no traversal, no path separators)
 *
 * @returns The written file path and whether a conversion was applied.
 */
export async function importSkill(
  source: string,
  targetDir: string,
): Promise<{ path: string; converted: boolean }> {
  let content: string;
  const isUrl = /^https?:\/\//i.test(source);

  if (isUrl) {
    const response = await fetch(source, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new ValidationError(`Failed to fetch skill: HTTP ${response.status}`);
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_IMPORT_SIZE) {
      throw new ValidationError('Skill file exceeds 1MB size limit');
    }
    content = await response.text();
  } else {
    content = await readFile(source, 'utf-8');
  }

  if (Buffer.byteLength(content, 'utf-8') > MAX_IMPORT_SIZE) {
    throw new ValidationError('Skill file exceeds 1MB size limit');
  }

  const ns = detectNamespace(content);
  let converted = false;

  if (ns === 'openclaw') {
    content = convertOpenClawSkill(content);
    converted = true;
  }

  // Parse to extract skill name for the output filename
  const skill = parseSkillContent(content);
  const rawName = skill.name || 'unnamed-skill';

  // Sanitize filename: reject path separators and traversal
  if (rawName.includes('/') || rawName.includes('\\') || rawName.includes('..')) {
    throw new ValidationError(`Invalid skill name: "${rawName}"`);
  }
  const safeName = rawName.replace(/[^a-zA-Z0-9._-]/g, '-');
  if (!safeName) {
    throw new ValidationError(`Invalid skill name: "${rawName}"`);
  }

  await mkdir(targetDir, { recursive: true });

  const outPath = join(targetDir, `${safeName}.md`);
  await writeFile(outPath, content, 'utf-8');

  return { path: outPath, converted };
}
