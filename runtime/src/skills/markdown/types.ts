/**
 * Types for SKILL.md markdown-based skill definitions.
 *
 * Skills are passive documentation injected into the LLM system prompt.
 * The SKILL.md format uses YAML frontmatter for structured metadata
 * and a markdown body for the skill documentation.
 *
 * @module
 */

// ============================================================================
// Parsed Skill
// ============================================================================

/** Parsed SKILL.md file. */
export interface MarkdownSkill {
  /** Skill name (from frontmatter). */
  readonly name: string;
  /** Description (from frontmatter). */
  readonly description: string;
  /** Semantic version. */
  readonly version: string;
  /** AgenC metadata extensions. */
  readonly metadata: SkillMetadataBlock;
  /** Raw markdown body (after frontmatter). */
  readonly body: string;
  /** Source file path. */
  readonly sourcePath: string;
}

// ============================================================================
// Metadata
// ============================================================================

/** Skill metadata from YAML frontmatter. */
export interface SkillMetadataBlock {
  /** Display emoji. */
  readonly emoji?: string;
  /** Requirement checks. */
  readonly requires: SkillRequirements;
  /** Primary environment variable for auth. */
  readonly primaryEnv?: string;
  /** Install instructions per platform. */
  readonly install: readonly SkillInstallStep[];
  /** Categorization tags. */
  readonly tags: readonly string[];
  /** Required on-chain capabilities bitmask (hex string). */
  readonly requiredCapabilities?: string;
  /** On-chain author pubkey. */
  readonly onChainAuthor?: string;
  /** Content hash (IPFS CID). */
  readonly contentHash?: string;
}

/** Skill requirements. */
export interface SkillRequirements {
  /** Required binaries on PATH. */
  readonly binaries: readonly string[];
  /** Required environment variables. */
  readonly env: readonly string[];
  /** Required channel plugins. */
  readonly channels: readonly string[];
  /** Supported operating systems. */
  readonly os: readonly string[];
}

/** Install instruction for a platform. */
export interface SkillInstallStep {
  /** Package manager type. */
  readonly type: 'brew' | 'apt' | 'npm' | 'cargo' | 'download';
  /** Package name. */
  readonly package?: string;
  /** Download URL. */
  readonly url?: string;
  /** Install path. */
  readonly path?: string;
}

// ============================================================================
// Parse Errors
// ============================================================================

/** Parse error for a specific field. */
export interface SkillParseError {
  readonly field: string;
  readonly message: string;
  readonly line?: number;
}
