/**
 * SKILL.md parser — YAML frontmatter + markdown body.
 *
 * @module
 */

export type {
  MarkdownSkill,
  MarkdownSkillMetadata,
  SkillRequirements,
  SkillInstallStep,
  SkillParseError,
} from "./types.js";

export {
  isSkillMarkdown,
  parseSkillContent,
  parseSkillFile,
  validateSkillMetadata,
} from "./parser.js";

export type {
  DiscoveryPaths,
  DiscoveryTier,
  DiscoveredSkill,
  MissingRequirement,
} from "./discovery.js";

export { SkillDiscovery } from "./discovery.js";

// Skill injection engine (Phase 3.3)
export type { SkillInjectorConfig, InjectionResult } from "./injector.js";
export {
  MarkdownSkillInjector,
  estimateTokens,
  scoreRelevance,
} from "./injector.js";

// OpenClaw compatibility bridge
export {
  detectNamespace,
  convertOpenClawSkill,
  mapOpenClawMetadata,
  importSkill,
} from "./compat.js";
