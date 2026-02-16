/**
 * Skill CLI subcommands — list, info, validate, create, install.
 *
 * @module
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { SkillDiscovery, type DiscoveryPaths, type DiscoveryTier } from '../skills/markdown/discovery.js';
import { parseSkillContent, validateSkillMetadata } from '../skills/markdown/parser.js';
import type { CliRuntimeContext, CliStatusCode, CliValidationError } from './types.js';

const SKILL_ERROR_CODES = {
  MISSING_SKILL_COMMAND: 'MISSING_SKILL_COMMAND',
  UNKNOWN_SKILL_COMMAND: 'UNKNOWN_SKILL_COMMAND',
  SKILL_NOT_FOUND: 'SKILL_NOT_FOUND',
  MISSING_SKILL_NAME: 'MISSING_SKILL_NAME',
  MISSING_SOURCE_PATH: 'MISSING_SOURCE_PATH',
  SOURCE_NOT_FOUND: 'SOURCE_NOT_FOUND',
  SKILL_PARSE_ERROR: 'SKILL_PARSE_ERROR',
} as const;

function createSkillError(message: string, code: string): CliValidationError {
  const error = new Error(message) as unknown as CliValidationError;
  error.code = code;
  return error;
}

export function getDefaultDiscoveryPaths(): DiscoveryPaths {
  const home = homedir();
  return {
    userSkills: join(home, '.agenc', 'skills'),
    projectSkills: join(process.cwd(), 'skills'),
    // __dirname is available at runtime (CJS output)
    builtinSkills: join(__dirname, '..', 'skills', 'bundled'),
  };
}

export function getDefaultUserSkillsDir(): string {
  return join(homedir(), '.agenc', 'skills');
}

const VALID_SKILL_SUBCOMMANDS = new Set(['list', 'info', 'validate', 'create', 'install']);

export interface SkillCommandOverrides {
  discoveryPaths?: DiscoveryPaths;
  userSkillsDir?: string;
}

export async function runSkillCommand(
  context: CliRuntimeContext,
  subcommand: string | undefined,
  positional: string[],
  flags: Record<string, string | number | boolean>,
  overrides?: SkillCommandOverrides,
): Promise<CliStatusCode> {
  if (!subcommand) {
    throw createSkillError('missing skill subcommand', SKILL_ERROR_CODES.MISSING_SKILL_COMMAND);
  }

  if (!VALID_SKILL_SUBCOMMANDS.has(subcommand)) {
    throw createSkillError(`unknown skill command: ${subcommand}`, SKILL_ERROR_CODES.UNKNOWN_SKILL_COMMAND);
  }

  const discoveryPaths = overrides?.discoveryPaths ?? getDefaultDiscoveryPaths();
  const userSkillsDir = overrides?.userSkillsDir ?? getDefaultUserSkillsDir();

  if (subcommand === 'list') {
    const tier = typeof flags.tier === 'string' ? flags.tier : undefined;
    const available = flags.available === true ? true : undefined;
    return runSkillListCommand(context, discoveryPaths, { tier, available });
  }

  if (subcommand === 'info') {
    const name = positional[0];
    if (!name) {
      throw createSkillError('skill info requires a skill name', SKILL_ERROR_CODES.MISSING_SKILL_NAME);
    }
    return runSkillInfoCommand(context, discoveryPaths, name);
  }

  if (subcommand === 'validate') {
    const name = positional[0];
    return runSkillValidateCommand(context, discoveryPaths, name);
  }

  if (subcommand === 'create') {
    const name = positional[0];
    if (!name) {
      throw createSkillError('skill create requires a skill name', SKILL_ERROR_CODES.MISSING_SKILL_NAME);
    }
    const description = typeof flags.description === 'string' ? flags.description : undefined;
    return runSkillCreateCommand(context, userSkillsDir, name, description);
  }

  // install
  const sourcePath = positional[0];
  if (!sourcePath) {
    throw createSkillError('skill install requires a source path', SKILL_ERROR_CODES.MISSING_SOURCE_PATH);
  }
  return runSkillInstallCommand(context, userSkillsDir, sourcePath);
}

async function runSkillListCommand(
  context: CliRuntimeContext,
  discoveryPaths: DiscoveryPaths,
  options: { tier?: string; available?: boolean },
): Promise<CliStatusCode> {
  const discovery = new SkillDiscovery(discoveryPaths);
  let skills = await discovery.discoverAll();

  if (options.tier) {
    const tier = options.tier as DiscoveryTier;
    skills = skills.filter((s) => s.tier === tier);
  }

  if (options.available === true) {
    skills = skills.filter((s) => s.available);
  }

  context.output({
    status: 'ok',
    command: 'skill.list',
    skills: skills.map((s) => ({
      name: s.skill.name,
      description: s.skill.description,
      version: s.skill.version,
      tier: s.tier,
      available: s.available,
      tags: s.skill.metadata.tags,
    })),
    count: skills.length,
  });

  return 0;
}

async function runSkillInfoCommand(
  context: CliRuntimeContext,
  discoveryPaths: DiscoveryPaths,
  name: string,
): Promise<CliStatusCode> {
  const discovery = new SkillDiscovery(discoveryPaths);
  const skills = await discovery.discoverAll();
  const found = skills.find((s) => s.skill.name === name);

  if (!found) {
    throw createSkillError(
      `skill "${name}" not found`,
      SKILL_ERROR_CODES.SKILL_NOT_FOUND,
    );
  }

  context.output({
    status: 'ok',
    command: 'skill.info',
    skill: {
      name: found.skill.name,
      description: found.skill.description,
      version: found.skill.version,
      tier: found.tier,
      available: found.available,
      tags: found.skill.metadata.tags,
      requires: found.skill.metadata.requires,
      install: found.skill.metadata.install,
      bodyLength: found.skill.body.length,
      sourcePath: found.skill.sourcePath,
      ...(found.missingRequirements
        ? { missingRequirements: found.missingRequirements }
        : {}),
    },
  });

  return 0;
}

async function runSkillValidateCommand(
  context: CliRuntimeContext,
  discoveryPaths: DiscoveryPaths,
  name?: string,
): Promise<CliStatusCode> {
  const discovery = new SkillDiscovery(discoveryPaths);
  const skills = await discovery.discoverAll();

  let targets = skills;
  if (name) {
    targets = skills.filter((s) => s.skill.name === name);
    if (targets.length === 0) {
      throw createSkillError(
        `skill "${name}" not found`,
        SKILL_ERROR_CODES.SKILL_NOT_FOUND,
      );
    }
  }

  const results = [];
  let hasErrors = false;

  for (const entry of targets) {
    const parseErrors = validateSkillMetadata(entry.skill);
    const missing = entry.missingRequirements ?? [];
    const valid = parseErrors.length === 0 && missing.length === 0;
    if (!valid) hasErrors = true;

    results.push({
      name: entry.skill.name,
      valid,
      parseErrors: parseErrors.map((e) => ({ field: e.field, message: e.message })),
      missingRequirements: missing.map((m) => ({ type: m.type, name: m.name, message: m.message })),
    });
  }

  context.output({
    status: 'ok',
    command: 'skill.validate',
    results,
    allValid: !hasErrors,
  });

  return hasErrors ? 1 : 0;
}

export function buildSkillTemplate(name: string, description?: string): string {
  const desc = description ?? 'A custom skill';
  const title = name.charAt(0).toUpperCase() + name.slice(1);

  return `---
name: ${name}
description: ${desc}
version: 1.0.0
metadata:
  agenc:
    tags:
      - ${name}
---

# ${title}

## Overview

Describe what this skill does.

## Usage

Add usage instructions and code examples here.
`;
}

async function runSkillCreateCommand(
  context: CliRuntimeContext,
  userSkillsDir: string,
  name: string,
  description?: string,
): Promise<CliStatusCode> {
  const skillDir = join(userSkillsDir, name);
  const skillPath = join(skillDir, 'SKILL.md');

  await mkdir(skillDir, { recursive: true });

  const content = buildSkillTemplate(name, description);
  await writeFile(skillPath, content, 'utf-8');

  context.output({
    status: 'ok',
    command: 'skill.create',
    name,
    path: skillPath,
    created: true,
  });

  return 0;
}

async function runSkillInstallCommand(
  context: CliRuntimeContext,
  userSkillsDir: string,
  sourcePath: string,
): Promise<CliStatusCode> {
  const source = resolve(sourcePath);

  if (!existsSync(source)) {
    throw createSkillError(
      `source path "${source}" not found`,
      SKILL_ERROR_CODES.SOURCE_NOT_FOUND,
    );
  }

  let content: string;
  try {
    content = readFileSync(source, 'utf-8');
  } catch (error) {
    throw createSkillError(
      `failed to read "${source}": ${error instanceof Error ? error.message : String(error)}`,
      SKILL_ERROR_CODES.SOURCE_NOT_FOUND,
    );
  }

  let skill;
  try {
    skill = parseSkillContent(content, source);
  } catch (error) {
    throw createSkillError(
      `failed to parse "${source}": ${error instanceof Error ? error.message : String(error)}`,
      SKILL_ERROR_CODES.SKILL_PARSE_ERROR,
    );
  }

  if (!skill.name) {
    throw createSkillError(
      `SKILL.md at "${source}" has no name field`,
      SKILL_ERROR_CODES.SKILL_PARSE_ERROR,
    );
  }

  const skillDir = join(userSkillsDir, skill.name);
  const destPath = join(skillDir, 'SKILL.md');

  await mkdir(skillDir, { recursive: true });
  await copyFile(source, destPath);

  context.output({
    status: 'ok',
    command: 'skill.install',
    name: skill.name,
    installedPath: destPath,
    source,
  });

  return 0;
}

export { SKILL_ERROR_CODES };
