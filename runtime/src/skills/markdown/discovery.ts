/**
 * Skill discovery and requirement validation.
 *
 * Scans 4 directory tiers (agent, user, project, builtin) for SKILL.md files,
 * validates their runtime requirements (binaries, env, OS, channels), and
 * returns availability status. Higher-tier skills shadow lower-tier by name.
 *
 * @module
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isSkillMarkdown, parseSkillContent } from './parser.js';
import type { MarkdownSkill } from './types.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Paths for the 4 discovery tiers. All are optional — missing dirs are skipped. */
export interface DiscoveryPaths {
  /** Agent-specific skills directory (e.g. `~/.agenc/agents/<id>/skills/`). */
  readonly agentSkills?: string;
  /** User-level skills directory (e.g. `~/.agenc/skills/`). */
  readonly userSkills?: string;
  /** Project-level skills directory (e.g. `./skills/`). */
  readonly projectSkills?: string;
  /** Built-in skills bundled with runtime. */
  readonly builtinSkills?: string;
}

/** Discovery tier determines shadowing precedence (agent > user > project > builtin). */
export type DiscoveryTier = 'agent' | 'user' | 'project' | 'builtin';

/** A skill found during discovery, annotated with availability status. */
export interface DiscoveredSkill {
  readonly skill: MarkdownSkill;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly tier: DiscoveryTier;
  readonly missingRequirements?: MissingRequirement[];
}

/** A single unmet runtime requirement. */
export interface MissingRequirement {
  readonly type: 'binary' | 'env' | 'os' | 'channel';
  readonly name: string;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Tier ordering (highest precedence first)
// ---------------------------------------------------------------------------

const TIER_ORDER: readonly DiscoveryTier[] = ['agent', 'user', 'project', 'builtin'];

const TIER_PATH_KEY: Record<DiscoveryTier, keyof DiscoveryPaths> = {
  agent: 'agentSkills',
  user: 'userSkills',
  project: 'projectSkills',
  builtin: 'builtinSkills',
};

// ---------------------------------------------------------------------------
// SkillDiscovery
// ---------------------------------------------------------------------------

export class SkillDiscovery {
  private readonly paths: DiscoveryPaths;

  constructor(paths: DiscoveryPaths) {
    this.paths = paths;
  }

  /**
   * Scan all tiers in precedence order. Higher-tier skills shadow lower-tier
   * skills with the same name.
   */
  async discoverAll(): Promise<DiscoveredSkill[]> {
    const seen = new Set<string>();
    const results: DiscoveredSkill[] = [];

    for (const tier of TIER_ORDER) {
      const dirPath = this.paths[TIER_PATH_KEY[tier]];
      if (!dirPath) continue;

      const discovered = await this.discoverInDirectory(dirPath, tier);
      for (const entry of discovered) {
        if (seen.has(entry.skill.name)) continue;
        seen.add(entry.skill.name);
        results.push(entry);
      }
    }

    return results;
  }

  /**
   * Scan a single directory for SKILL.md files.
   *
   * Gracefully handles missing or unreadable directories (returns `[]`).
   */
  async discoverInDirectory(
    dirPath: string,
    tier: DiscoveryTier,
  ): Promise<DiscoveredSkill[]> {
    const entries = await readSafe(dirPath);
    if (entries.length === 0) return [];

    const mdFiles = entries.filter((name) => name.endsWith('.md'));
    const results: DiscoveredSkill[] = [];

    for (const fileName of mdFiles) {
      const filePath = join(dirPath, fileName);
      const content = await readFileSafe(filePath);
      if (content === null) continue;
      if (!isSkillMarkdown(content)) continue;

      const skill = parseSkillContent(content, filePath);
      const missing = await this.validateRequirements(skill);
      const available = missing.length === 0;

      results.push({
        skill,
        available,
        tier,
        ...(available
          ? {}
          : {
              unavailableReason: missing
                .map((m) => m.message)
                .join('; '),
              missingRequirements: missing,
            }),
      });
    }

    return results;
  }

  /**
   * Validate a skill's runtime requirements.
   * Returns an empty array when all requirements are met.
   */
  async validateRequirements(skill: MarkdownSkill): Promise<MissingRequirement[]> {
    const missing: MissingRequirement[] = [];
    const { requires } = skill.metadata;

    // Binary checks (async)
    for (const bin of requires.binaries) {
      const found = await this.checkBinary(bin);
      if (!found) {
        missing.push({
          type: 'binary',
          name: bin,
          message: `Required binary "${bin}" not found in PATH`,
        });
      }
    }

    // Environment variable checks
    for (const envVar of requires.env) {
      if (!this.checkEnv(envVar)) {
        missing.push({
          type: 'env',
          name: envVar,
          message: `Required environment variable "${envVar}" is not set`,
        });
      }
    }

    // OS checks
    if (requires.os.length > 0 && !this.checkOs(requires.os)) {
      missing.push({
        type: 'os',
        name: process.platform,
        message: `Current OS "${process.platform}" not in allowed list: ${requires.os.join(', ')}`,
      });
    }

    // Channel requirements — informational (deferred to future implementation)
    for (const channel of requires.channels) {
      missing.push({
        type: 'channel',
        name: channel,
        message: `Channel "${channel}" availability cannot be verified yet`,
      });
    }

    return missing;
  }

  /** Check if a binary is available via `which`. */
  async checkBinary(name: string): Promise<boolean> {
    try {
      await execFileAsync('which', [name]);
      return true;
    } catch {
      return false;
    }
  }

  /** Check if an environment variable is set. */
  checkEnv(name: string): boolean {
    return process.env[name] !== undefined;
  }

  /** Check if the current OS is in the allowed list. Empty list means any OS. */
  checkOs(allowed: readonly string[]): boolean {
    if (allowed.length === 0) return true;
    const platform = process.platform;
    return allowed.some((os) => {
      const normalized = os === 'macos' ? 'darwin' : os;
      return normalized === platform;
    });
  }

  /** Return only available (all requirements met) skills across all tiers. */
  async getAvailable(): Promise<DiscoveredSkill[]> {
    const all = await this.discoverAll();
    return all.filter((s) => s.available);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Read directory entries, returning `[]` on any error. */
async function readSafe(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
}

/** Read file content, returning `null` on any error. */
async function readFileSafe(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}
