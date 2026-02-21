import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  SkillDiscovery,
  type DiscoveredSkill,
  type DiscoveryPaths,
} from "../skills/markdown/discovery.js";
import {
  isSkillMarkdown,
  parseSkillContent,
  validateSkillMetadata,
} from "../skills/markdown/parser.js";
import type {
  CliRuntimeContext,
  CliStatusCode,
  SkillCommandOptions,
} from "./types.js";

const MAX_INSTALL_SIZE = 1_048_576; // 1 MB
const BODY_PREVIEW_LENGTH = 500;

export function getDefaultDiscoveryPaths(): DiscoveryPaths {
  return {
    userSkills: join(homedir(), ".agenc", "skills"),
    projectSkills: join(process.cwd(), "skills"),
  };
}

export function getUserSkillsDir(): string {
  return join(homedir(), ".agenc", "skills");
}

function suggestSimilarNames(
  input: string,
  skills: DiscoveredSkill[],
): string[] {
  const lower = input.toLowerCase();
  return skills
    .filter(
      (s) =>
        s.skill.name.toLowerCase().includes(lower) ||
        lower.includes(s.skill.name.toLowerCase()),
    )
    .map((s) => s.skill.name);
}

function buildSkillTemplate(name: string): string {
  return `---
name: ${name}
description: ${name} skill for AgenC runtime workflows
version: 0.1.0
metadata:
  agenc:
    tags: []
    requires:
      binaries: []
      env: []
      channels: []
      os: []
    install: []
---

# ${name}

## Purpose

Describe what this skill automates and when to use it.

## Inputs

- List required inputs and expected formats.

## Steps

1. Add the concrete workflow steps this skill should execute.
2. Note any safety checks or validation requirements.
3. Document expected output shape.
`;
}

async function resolveSkillByName(
  name: string,
  discovery: SkillDiscovery,
): Promise<{ skill: DiscoveredSkill; disabled: boolean } | null> {
  const all = await discovery.discoverAll();
  const match = all.find((s) => s.skill.name === name);
  if (!match) return null;
  const disabled = match.skill.sourcePath
    ? existsSync(`${match.skill.sourcePath}.disabled`)
    : false;
  return { skill: match, disabled };
}

export async function runSkillListCommand(
  context: CliRuntimeContext,
  _args: SkillCommandOptions,
  overrides?: { discoveryPaths?: DiscoveryPaths; userSkillsDir?: string },
): Promise<CliStatusCode> {
  const paths = overrides?.discoveryPaths ?? getDefaultDiscoveryPaths();
  const discovery = new SkillDiscovery(paths);

  try {
    const skills = await discovery.discoverAll();
    const items = skills.map((s) => {
      const disabled = s.skill.sourcePath
        ? existsSync(`${s.skill.sourcePath}.disabled`)
        : false;
      return {
        name: s.skill.name,
        version: s.skill.version,
        tier: s.tier,
        available: s.available,
        disabled,
        tags: [...s.skill.metadata.tags],
      };
    });

    context.output({
      status: "ok",
      command: "skill.list",
      schema: "skill.list.output.v1",
      count: items.length,
      skills: items,
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "IO_ERROR",
      message: `Failed to discover skills: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
}

export async function runSkillInfoCommand(
  context: CliRuntimeContext,
  args: SkillCommandOptions,
  overrides?: { discoveryPaths?: DiscoveryPaths },
): Promise<CliStatusCode> {
  const opts = args as { skillName: string };
  const paths = overrides?.discoveryPaths ?? getDefaultDiscoveryPaths();
  const discovery = new SkillDiscovery(paths);

  try {
    const result = await resolveSkillByName(opts.skillName, discovery);
    if (!result) {
      const all = await discovery.discoverAll();
      const suggestions = suggestSimilarNames(opts.skillName, all);
      context.error({
        status: "error",
        code: "SKILL_NOT_FOUND",
        message: `Skill "${opts.skillName}" not found`,
        ...(suggestions.length > 0 ? { suggestions } : {}),
      });
      return 1;
    }

    const { skill: discovered, disabled } = result;
    const bodyPreview =
      discovered.skill.body.length > BODY_PREVIEW_LENGTH
        ? `${discovered.skill.body.slice(0, BODY_PREVIEW_LENGTH)}...`
        : discovered.skill.body;

    context.output({
      status: "ok",
      command: "skill.info",
      schema: "skill.info.output.v1",
      skill: {
        name: discovered.skill.name,
        description: discovered.skill.description,
        version: discovered.skill.version,
        tier: discovered.tier,
        available: discovered.available,
        disabled,
        tags: [...discovered.skill.metadata.tags],
        metadata: discovered.skill.metadata,
        bodyPreview,
        sourcePath: discovered.skill.sourcePath,
        ...(discovered.unavailableReason
          ? { unavailableReason: discovered.unavailableReason }
          : {}),
        ...(discovered.missingRequirements
          ? { missingRequirements: discovered.missingRequirements }
          : {}),
      },
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "IO_ERROR",
      message: `Failed to get skill info: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
}

export async function runSkillValidateCommand(
  context: CliRuntimeContext,
  _args: SkillCommandOptions,
  overrides?: { discoveryPaths?: DiscoveryPaths },
): Promise<CliStatusCode> {
  const paths = overrides?.discoveryPaths ?? getDefaultDiscoveryPaths();
  const discovery = new SkillDiscovery(paths);

  try {
    const skills = await discovery.discoverAll();
    let hasErrors = false;
    const results = skills.map((s) => {
      const errors = validateSkillMetadata(s.skill);
      if (errors.length > 0) hasErrors = true;
      return {
        name: s.skill.name,
        tier: s.tier,
        valid: errors.length === 0,
        errors,
      };
    });

    context.output({
      status: "ok",
      command: "skill.validate",
      schema: "skill.validate.output.v1",
      count: results.length,
      valid: !hasErrors,
      results,
    });
    return hasErrors ? 1 : 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "IO_ERROR",
      message: `Failed to validate skills: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
}

export async function runSkillCreateCommand(
  context: CliRuntimeContext,
  args: SkillCommandOptions,
  overrides?: { userSkillsDir?: string },
): Promise<CliStatusCode> {
  const opts = args as { skillName: string };
  const dir = overrides?.userSkillsDir ?? getUserSkillsDir();
  const filePath = join(dir, `${opts.skillName}.md`);

  if (existsSync(filePath)) {
    context.error({
      status: "error",
      code: "SKILL_ALREADY_EXISTS",
      message: `Skill file already exists: ${filePath}`,
    });
    return 1;
  }

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, buildSkillTemplate(opts.skillName), "utf-8");
  } catch (error) {
    context.error({
      status: "error",
      code: "IO_ERROR",
      message: `Failed to create skill: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }

  context.output({
    status: "ok",
    command: "skill.create",
    schema: "skill.create.output.v1",
    skillName: opts.skillName,
    filePath,
  });
  return 0;
}

export async function runSkillInstallCommand(
  context: CliRuntimeContext,
  args: SkillCommandOptions,
  overrides?: { userSkillsDir?: string },
): Promise<CliStatusCode> {
  const opts = args as { source: string };
  const dir = overrides?.userSkillsDir ?? getUserSkillsDir();

  let content: string;
  const isUrl =
    opts.source.startsWith("http://") || opts.source.startsWith("https://");

  if (isUrl) {
    try {
      const response = await fetch(opts.source);
      if (!response.ok) {
        context.error({
          status: "error",
          code: "DOWNLOAD_FAILED",
          message: `Failed to download skill: HTTP ${response.status}`,
        });
        return 1;
      }
      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_INSTALL_SIZE) {
        context.error({
          status: "error",
          code: "INVALID_SKILL_FILE",
          message: `Skill file exceeds 1MB size limit`,
        });
        return 1;
      }
      content = await response.text();
    } catch (error) {
      context.error({
        status: "error",
        code: "DOWNLOAD_FAILED",
        message: `Failed to download skill: ${error instanceof Error ? error.message : String(error)}`,
      });
      return 1;
    }
  } else {
    if (!existsSync(opts.source)) {
      context.error({
        status: "error",
        code: "SOURCE_NOT_FOUND",
        message: `Source file not found: ${opts.source}`,
      });
      return 1;
    }
    try {
      content = await readFile(opts.source, "utf-8");
    } catch (error) {
      context.error({
        status: "error",
        code: "IO_ERROR",
        message: `Failed to read source file: ${error instanceof Error ? error.message : String(error)}`,
      });
      return 1;
    }
  }

  if (Buffer.byteLength(content, "utf-8") > MAX_INSTALL_SIZE) {
    context.error({
      status: "error",
      code: "INVALID_SKILL_FILE",
      message: `Skill file exceeds 1MB size limit`,
    });
    return 1;
  }

  if (!isSkillMarkdown(content)) {
    context.error({
      status: "error",
      code: "INVALID_SKILL_FILE",
      message: `Source is not a valid SKILL.md file (missing YAML frontmatter)`,
    });
    return 1;
  }

  const parsed = parseSkillContent(content);
  const validationErrors = validateSkillMetadata(parsed);
  if (validationErrors.length > 0) {
    context.error({
      status: "error",
      code: "INVALID_SKILL_FILE",
      message: `Skill validation failed: ${validationErrors.map((e) => e.message).join("; ")}`,
    });
    return 1;
  }

  const skillName = parsed.name || basename(opts.source, ".md");
  const destPath = join(dir, `${skillName}.md`);

  if (existsSync(destPath)) {
    context.error({
      status: "error",
      code: "SKILL_ALREADY_EXISTS",
      message: `Skill file already exists: ${destPath}`,
    });
    return 1;
  }

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(destPath, content, "utf-8");
  } catch (error) {
    context.error({
      status: "error",
      code: "IO_ERROR",
      message: `Failed to install skill: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }

  context.output({
    status: "ok",
    command: "skill.install",
    schema: "skill.install.output.v1",
    skillName: parsed.name,
    filePath: destPath,
    source: opts.source,
  });
  return 0;
}

export async function runSkillUninstallCommand(
  context: CliRuntimeContext,
  args: SkillCommandOptions,
  overrides?: { userSkillsDir?: string },
): Promise<CliStatusCode> {
  const opts = args as { skillName: string };
  const dir = overrides?.userSkillsDir ?? getUserSkillsDir();

  const filePath = join(dir, `${opts.skillName}.md`);
  if (!existsSync(filePath)) {
    context.error({
      status: "error",
      code: "SKILL_NOT_FOUND",
      message: `Skill "${opts.skillName}" not found in user skills directory`,
    });
    return 1;
  }

  try {
    await unlink(filePath);
    const disabledMarker = `${filePath}.disabled`;
    if (existsSync(disabledMarker)) {
      await unlink(disabledMarker);
    }
  } catch (error) {
    context.error({
      status: "error",
      code: "IO_ERROR",
      message: `Failed to uninstall skill: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }

  context.output({
    status: "ok",
    command: "skill.uninstall",
    schema: "skill.uninstall.output.v1",
    skillName: opts.skillName,
  });
  return 0;
}

export async function runSkillEnableCommand(
  context: CliRuntimeContext,
  args: SkillCommandOptions,
  overrides?: { discoveryPaths?: DiscoveryPaths },
): Promise<CliStatusCode> {
  const opts = args as { skillName: string };
  const paths = overrides?.discoveryPaths ?? getDefaultDiscoveryPaths();
  const discovery = new SkillDiscovery(paths);

  try {
    const result = await resolveSkillByName(opts.skillName, discovery);
    if (!result) {
      context.error({
        status: "error",
        code: "SKILL_NOT_FOUND",
        message: `Skill "${opts.skillName}" not found`,
      });
      return 1;
    }

    if (!result.skill.skill.sourcePath) {
      context.error({
        status: "error",
        code: "IO_ERROR",
        message: `Skill "${opts.skillName}" has no source path and cannot be toggled`,
      });
      return 1;
    }

    const markerPath = `${result.skill.skill.sourcePath}.disabled`;
    if (existsSync(markerPath)) {
      await unlink(markerPath);
    }

    context.output({
      status: "ok",
      command: "skill.enable",
      schema: "skill.enable.output.v1",
      skillName: opts.skillName,
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "IO_ERROR",
      message: `Failed to enable skill: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
}

export async function runSkillDisableCommand(
  context: CliRuntimeContext,
  args: SkillCommandOptions,
  overrides?: { discoveryPaths?: DiscoveryPaths },
): Promise<CliStatusCode> {
  const opts = args as { skillName: string };
  const paths = overrides?.discoveryPaths ?? getDefaultDiscoveryPaths();
  const discovery = new SkillDiscovery(paths);

  try {
    const result = await resolveSkillByName(opts.skillName, discovery);
    if (!result) {
      context.error({
        status: "error",
        code: "SKILL_NOT_FOUND",
        message: `Skill "${opts.skillName}" not found`,
      });
      return 1;
    }

    if (!result.skill.skill.sourcePath) {
      context.error({
        status: "error",
        code: "IO_ERROR",
        message: `Skill "${opts.skillName}" has no source path and cannot be toggled`,
      });
      return 1;
    }

    const markerPath = `${result.skill.skill.sourcePath}.disabled`;
    if (!existsSync(markerPath)) {
      await writeFile(markerPath, "", "utf-8");
    }

    context.output({
      status: "ok",
      command: "skill.disable",
      schema: "skill.disable.output.v1",
      skillName: opts.skillName,
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      code: "IO_ERROR",
      message: `Failed to disable skill: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
}
