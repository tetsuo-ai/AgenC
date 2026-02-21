/**
 * SKILL.md parser — extracts YAML frontmatter metadata and markdown body.
 *
 * Parses markdown files with YAML frontmatter delimited by `---` fences.
 * Supports the `metadata.agenc` and `metadata.openclaw` namespaces
 * (agenc takes precedence when both are present).
 *
 * @module
 */

import { readFile } from "node:fs/promises";
import type {
  MarkdownSkill,
  MarkdownSkillMetadata,
  SkillInstallStep,
  SkillParseError,
  SkillRequirements,
} from "./types.js";

const FRONTMATTER_DELIMITER = "---";
const VALID_INSTALL_TYPES = new Set([
  "brew",
  "apt",
  "npm",
  "cargo",
  "download",
]);

/**
 * Check whether content looks like a SKILL.md file (has YAML frontmatter).
 */
export function isSkillMarkdown(content: string): boolean {
  return (
    content.startsWith(`${FRONTMATTER_DELIMITER}\n`) ||
    content.startsWith(`${FRONTMATTER_DELIMITER}\r\n`)
  );
}

/**
 * Parse SKILL.md content (frontmatter + body) into a structured MarkdownSkill.
 *
 * This function is lenient — it extracts what it can and defaults missing
 * fields to empty values. Use {@link validateSkillMetadata} for strict checks.
 */
export function parseSkillContent(
  content: string,
  sourcePath?: string,
): MarkdownSkill {
  const { frontmatter, body } = splitFrontmatter(content);
  const data = parseFrontmatter(frontmatter);

  const name = getString(data, "name") ?? "";
  const description = getString(data, "description") ?? "";
  const version = getString(data, "version") ?? "";

  const metadata = extractMetadata(data);

  return {
    name,
    description,
    version,
    metadata,
    body,
    ...(sourcePath !== undefined ? { sourcePath } : {}),
  };
}

/**
 * Read a SKILL.md file from the filesystem and parse it.
 */
export async function parseSkillFile(filePath: string): Promise<MarkdownSkill> {
  const content = await readFile(filePath, "utf-8");
  return parseSkillContent(content, filePath);
}

/**
 * Validate a parsed MarkdownSkill's metadata for required fields.
 *
 * Returns an array of errors. An empty array means the skill is valid.
 */
export function validateSkillMetadata(skill: MarkdownSkill): SkillParseError[] {
  const errors: SkillParseError[] = [];

  if (!skill.name) {
    errors.push({ field: "name", message: "name is required" });
  }

  if (!skill.description) {
    errors.push({ field: "description", message: "description is required" });
  }

  if (!skill.version) {
    errors.push({ field: "version", message: "version is required" });
  }

  for (const [index, step] of skill.metadata.install.entries()) {
    if (!VALID_INSTALL_TYPES.has(step.type)) {
      errors.push({
        field: `metadata.install[${index}].type`,
        message: `Invalid install type "${step.type}". Must be one of: ${[...VALID_INSTALL_TYPES].join(", ")}`,
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface FrontmatterSplit {
  frontmatter: string;
  body: string;
}

/** Split content into frontmatter YAML and markdown body. */
function splitFrontmatter(content: string): FrontmatterSplit {
  if (!isSkillMarkdown(content)) {
    return { frontmatter: "", body: content };
  }

  // Find closing delimiter (skip opening line)
  const afterOpening = content.indexOf("\n") + 1;
  const closingIndex = content.indexOf(
    `\n${FRONTMATTER_DELIMITER}`,
    afterOpening,
  );

  if (closingIndex === -1) {
    // No closing delimiter — treat entire content after opening as frontmatter
    return { frontmatter: content.slice(afterOpening), body: "" };
  }

  const frontmatter = content.slice(afterOpening, closingIndex);
  // Body starts after closing `---\n`
  const bodyStart = closingIndex + 1 + FRONTMATTER_DELIMITER.length;
  const body = content.slice(bodyStart).replace(/^\r?\n/, "");

  return { frontmatter, body };
}

/** Extract metadata from the agenc or openclaw namespace. */
function extractMetadata(data: Record<string, unknown>): MarkdownSkillMetadata {
  const metadataObj = getObject(data, "metadata") ?? {};

  // agenc namespace takes precedence over openclaw
  const ns =
    getObject(metadataObj, "agenc") ?? getObject(metadataObj, "openclaw") ?? {};

  const requiresObj = getObject(ns, "requires") ?? {};
  const requires: SkillRequirements = {
    binaries: getStringArray(requiresObj, "binaries"),
    env: getStringArray(requiresObj, "env"),
    channels: getStringArray(requiresObj, "channels"),
    os: getStringArray(requiresObj, "os"),
  };

  const rawInstall = getArray(ns, "install");
  const install: SkillInstallStep[] = [];
  for (const item of rawInstall) {
    if (typeof item === "object" && item !== null && !Array.isArray(item)) {
      const stepObj = item as Record<string, unknown>;
      const type = getString(stepObj, "type") ?? "";
      install.push({
        // Cast is intentionally lenient — validateSkillMetadata() checks valid types
        type: type as SkillInstallStep["type"],
        ...(stepObj.package !== undefined
          ? { package: String(stepObj.package) }
          : {}),
        ...(stepObj.url !== undefined ? { url: String(stepObj.url) } : {}),
        ...(stepObj.path !== undefined ? { path: String(stepObj.path) } : {}),
      });
    }
  }

  return {
    ...(ns.emoji !== undefined ? { emoji: String(ns.emoji) } : {}),
    requires,
    ...(ns.primaryEnv !== undefined
      ? { primaryEnv: String(ns.primaryEnv) }
      : {}),
    install,
    tags: getStringArray(ns, "tags"),
    ...(ns.requiredCapabilities !== undefined
      ? { requiredCapabilities: String(ns.requiredCapabilities) }
      : {}),
    ...(ns.onChainAuthor !== undefined
      ? { onChainAuthor: String(ns.onChainAuthor) }
      : {}),
    ...(ns.contentHash !== undefined
      ? { contentHash: String(ns.contentHash) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Recursive-descent YAML frontmatter parser
// ---------------------------------------------------------------------------

/** Mutable parse state shared across recursive calls. */
interface ParseState {
  lines: string[];
  pos: number;
}

/**
 * Parse simple YAML into a nested Record.
 *
 * Uses recursive descent to correctly handle nested objects, arrays,
 * and arrays of objects. Supports: `key: value`, `key:` (object/array start),
 * `- item` (array), `- key: value` (array of objects), `[a, b]` (inline array),
 * `#` comments, quoted strings, booleans, numbers.
 */
function parseFrontmatter(yaml: string): Record<string, unknown> {
  if (!yaml.trim()) return {};

  const lines = yaml.split(/\r?\n/).map((line) => stripComment(line));

  const state: ParseState = { lines, pos: 0 };
  return parseMapping(state, -1);
}

/** Parse a YAML mapping (object) at the given parent indent level. */
function parseMapping(
  state: ParseState,
  parentIndent: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  while (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    if (!line.trim()) {
      state.pos++;
      continue;
    }

    const indent = leadingSpaces(line);
    const trimmed = line.trim();

    // Dedented past our scope — done
    if (indent <= parentIndent) break;

    // Array items belong to a different scope
    if (trimmed.startsWith("- ")) break;

    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      state.pos++;
      continue;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const rawValue = trimmed.slice(colonIndex + 1).trim();

    state.pos++;

    if (rawValue === "") {
      // Peek at the next non-blank line to decide array vs object
      const nextInfo = peekNextLine(state);
      if (
        nextInfo &&
        nextInfo.indent > indent &&
        nextInfo.trimmed.startsWith("- ")
      ) {
        result[key] = parseSequence(state, indent);
      } else if (nextInfo && nextInfo.indent > indent) {
        result[key] = parseMapping(state, indent);
      } else {
        result[key] = {};
      }
    } else {
      result[key] = parseYamlValue(rawValue);
    }
  }

  return result;
}

/** Parse a YAML sequence (array) at the given parent indent level. */
function parseSequence(state: ParseState, parentIndent: number): unknown[] {
  const result: unknown[] = [];

  while (state.pos < state.lines.length) {
    const line = state.lines[state.pos];
    if (!line.trim()) {
      state.pos++;
      continue;
    }

    const indent = leadingSpaces(line);
    const trimmed = line.trim();

    // Dedented past our scope — done
    if (indent <= parentIndent) break;
    if (!trimmed.startsWith("- ")) break;

    const afterDash = trimmed.slice(2).trim();
    const colonIndex = afterDash.indexOf(":");

    // Check if this is `- key: value` (object array item).
    // Guard against URL-like values (e.g. `- https://example.com:443`).
    const keyCandidate =
      colonIndex > 0 ? afterDash.slice(0, colonIndex).trim() : "";
    const isObjectItem =
      colonIndex > 0 &&
      /^[a-zA-Z_]\w*$/.test(keyCandidate) &&
      !afterDash.startsWith('"') &&
      !afterDash.startsWith("'") &&
      !afterDash.includes("://");

    if (isObjectItem) {
      // Array of objects: `- key: value` followed by continuation keys
      const itemKey = keyCandidate;
      const itemRawValue = afterDash.slice(colonIndex + 1).trim();
      const item: Record<string, unknown> = {};
      item[itemKey] = parseYamlValue(itemRawValue);

      state.pos++;

      // Read continuation key-value pairs at deeper indent
      while (state.pos < state.lines.length) {
        const contLine = state.lines[state.pos];
        if (!contLine.trim()) {
          state.pos++;
          continue;
        }

        const contIndent = leadingSpaces(contLine);
        const contTrimmed = contLine.trim();

        // Back at same indent or dedented, or new array item
        if (contIndent <= indent || contTrimmed.startsWith("- ")) break;

        const contColonIndex = contTrimmed.indexOf(":");
        if (contColonIndex === -1) {
          state.pos++;
          continue;
        }

        const contKey = contTrimmed.slice(0, contColonIndex).trim();
        const contRawValue = contTrimmed.slice(contColonIndex + 1).trim();
        item[contKey] = parseYamlValue(contRawValue);
        state.pos++;
      }

      result.push(item);
    } else {
      // Simple array item: `- value`
      result.push(parseYamlValue(afterDash));
      state.pos++;
    }
  }

  return result;
}

/** Peek at the next non-blank line without advancing position. */
function peekNextLine(
  state: ParseState,
): { indent: number; trimmed: string } | null {
  let i = state.pos;
  while (i < state.lines.length) {
    const trimmed = state.lines[i].trim();
    if (trimmed) {
      return { indent: leadingSpaces(state.lines[i]), trimmed };
    }
    i++;
  }
  return null;
}

/** Parse a single YAML value (inline). */
function parseYamlValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;

  // Inline array: [a, b, c]
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((item) => parseYamlValue(item.trim()));
  }

  // Quoted strings
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }

  // Numbers — only convert if roundtrip-safe (avoids precision loss on large integers)
  if (/^-?\d+(\.\d+)?$/.test(raw)) {
    const num = Number(raw);
    if (String(num) === raw) {
      return num;
    }
    return raw;
  }

  return raw;
}

/** Strip inline comments (outside of quotes). */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || line[i - 1] === " ") {
        return line.slice(0, i);
      }
    }
  }
  return line;
}

/** Count leading spaces. */
function leadingSpaces(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === " ") count++;
    else break;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Type-safe accessors for parsed YAML data
// ---------------------------------------------------------------------------

function getString(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const val = obj[key];
  return val !== undefined && val !== null ? String(val) : undefined;
}

function getObject(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const val = obj[key];
  if (typeof val === "object" && val !== null && !Array.isArray(val)) {
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
