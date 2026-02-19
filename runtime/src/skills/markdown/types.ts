/**
 * Types for SKILL.md parsing — YAML frontmatter + markdown body.
 *
 * These types represent the parsed structure of a SKILL.md file,
 * which is used for LLM prompt injection of skill instructions.
 *
 * @module
 */

/** Parsed SKILL.md file. */
export interface MarkdownSkill {
  /** Skill name from frontmatter. */
  readonly name: string;
  /** Human-readable description from frontmatter. */
  readonly description: string;
  /** Semantic version string. */
  readonly version: string;
  /** Structured metadata block. */
  readonly metadata: MarkdownSkillMetadata;
  /** Raw markdown body (everything after closing `---`). */
  readonly body: string;
  /** Filesystem path the skill was loaded from, if available. */
  readonly sourcePath?: string;
}

/** Metadata block extracted from SKILL.md frontmatter. */
export interface MarkdownSkillMetadata {
  /** Optional emoji identifier for the skill. */
  readonly emoji?: string;
  /** Runtime requirements (binaries, env vars, channels, OS). */
  readonly requires: SkillRequirements;
  /** Primary environment hint (e.g. 'node', 'python', 'rust'). */
  readonly primaryEnv?: string;
  /** Installation steps. */
  readonly install: readonly SkillInstallStep[];
  /** Tags for categorization and discovery. */
  readonly tags: readonly string[];
  /** Required capability bitmask as bigint string. */
  readonly requiredCapabilities?: string;
  /** On-chain author public key. */
  readonly onChainAuthor?: string;
  /** Content hash for integrity verification. */
  readonly contentHash?: string;
}

/** Runtime requirements for a skill. */
export interface SkillRequirements {
  /** Required binary executables (e.g. 'risc0-prover', 'node'). */
  readonly binaries: readonly string[];
  /** Required environment variables. */
  readonly env: readonly string[];
  /** Required communication channels. */
  readonly channels: readonly string[];
  /** Supported operating systems. */
  readonly os: readonly string[];
}

/** A single installation step. */
export interface SkillInstallStep {
  /** Package manager or method. */
  readonly type: 'brew' | 'apt' | 'npm' | 'cargo' | 'download';
  /** Package name (for brew/apt/npm/cargo). */
  readonly package?: string;
  /** Download URL (for download type). */
  readonly url?: string;
  /** Installation path override. */
  readonly path?: string;
}

/** Validation error from SKILL.md parsing. */
export interface SkillParseError {
  /** Field path that failed validation. */
  readonly field: string;
  /** Human-readable error message. */
  readonly message: string;
  /** Optional line number in source file. */
  readonly line?: number;
}
