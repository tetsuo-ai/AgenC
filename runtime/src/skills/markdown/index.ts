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
} from './types.js';

export {
  isSkillMarkdown,
  parseSkillContent,
  parseSkillFile,
  validateSkillMetadata,
} from './parser.js';
