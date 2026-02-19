/**
 * Workspace file loading, validation, prompt assembly, and scaffolding.
 *
 * Reads markdown configuration files from `~/.agenc/workspace/` that control
 * agent personality (AGENT.md, SOUL.md), user preferences (USER.md), tool
 * guidelines (TOOLS.md), on-chain integration (CAPABILITIES.md, POLICY.md,
 * REPUTATION.md), memory (MEMORY.md), and runtime hooks (BOOT.md, HEARTBEAT.md).
 *
 * @module
 */

import { readFile, readdir, mkdir, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { constants } from 'node:fs';

// ============================================================================
// Constants
// ============================================================================

export const WORKSPACE_FILES = {
  AGENT: 'AGENT.md',
  SOUL: 'SOUL.md',
  USER: 'USER.md',
  TOOLS: 'TOOLS.md',
  HEARTBEAT: 'HEARTBEAT.md',
  BOOT: 'BOOT.md',
  IDENTITY: 'IDENTITY.md',
  MEMORY: 'MEMORY.md',
  CAPABILITIES: 'CAPABILITIES.md',
  POLICY: 'POLICY.md',
  REPUTATION: 'REPUTATION.md',
} as const;

export type WorkspaceFileName = (typeof WORKSPACE_FILES)[keyof typeof WORKSPACE_FILES];

// ============================================================================
// Interfaces
// ============================================================================

/** Loaded workspace file contents. Each field is undefined when the file is missing. */
export interface WorkspaceFiles {
  readonly agent?: string;
  readonly soul?: string;
  readonly user?: string;
  readonly tools?: string;
  readonly heartbeat?: string;
  readonly boot?: string;
  readonly identity?: string;
  readonly memory?: string;
  readonly capabilities?: string;
  readonly policy?: string;
  readonly reputation?: string;
}

/** Result of workspace directory validation. */
export interface WorkspaceValidation {
  readonly valid: boolean;
  readonly missing: string[];
  readonly warnings: string[];
}

// ============================================================================
// readSafe helper
// ============================================================================

async function readSafe(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    // Non-ENOENT errors (permission denied, etc.) — log warning and skip
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[workspace] Failed to read ${filePath}: ${msg}`);
    return undefined;
  }
}

// ============================================================================
// WorkspaceLoader
// ============================================================================

/** Loads and validates workspace configuration files from a directory. */
export class WorkspaceLoader {
  readonly path: string;

  constructor(workspacePath: string) {
    this.path = workspacePath;
  }

  /** Read all workspace files, returning undefined for missing ones. */
  async load(): Promise<WorkspaceFiles> {
    const [
      agent, soul, user, tools, heartbeat, boot,
      identity, memory, capabilities, policy, reputation,
    ] = await Promise.all([
      readSafe(join(this.path, WORKSPACE_FILES.AGENT)),
      readSafe(join(this.path, WORKSPACE_FILES.SOUL)),
      readSafe(join(this.path, WORKSPACE_FILES.USER)),
      readSafe(join(this.path, WORKSPACE_FILES.TOOLS)),
      readSafe(join(this.path, WORKSPACE_FILES.HEARTBEAT)),
      readSafe(join(this.path, WORKSPACE_FILES.BOOT)),
      readSafe(join(this.path, WORKSPACE_FILES.IDENTITY)),
      readSafe(join(this.path, WORKSPACE_FILES.MEMORY)),
      readSafe(join(this.path, WORKSPACE_FILES.CAPABILITIES)),
      readSafe(join(this.path, WORKSPACE_FILES.POLICY)),
      readSafe(join(this.path, WORKSPACE_FILES.REPUTATION)),
    ]);

    return {
      agent, soul, user, tools, heartbeat, boot,
      identity, memory, capabilities, policy, reputation,
    };
  }

  /** Read a single workspace file by key (e.g. 'AGENT'). */
  async loadFile(name: keyof typeof WORKSPACE_FILES): Promise<string | undefined> {
    return readSafe(join(this.path, WORKSPACE_FILES[name]));
  }

  /** Validate workspace directory existence and file presence. */
  async validate(): Promise<WorkspaceValidation> {
    const missing: string[] = [];
    const warnings: string[] = [];

    try {
      await access(this.path, constants.R_OK);
    } catch {
      return { valid: false, missing: [this.path], warnings: ['Workspace directory does not exist'] };
    }

    let entries: string[];
    try {
      entries = await readdir(this.path);
    } catch {
      return { valid: false, missing: [this.path], warnings: ['Cannot read workspace directory'] };
    }

    const entrySet = new Set(entries);
    for (const fileName of Object.values(WORKSPACE_FILES)) {
      if (!entrySet.has(fileName)) {
        missing.push(fileName);
      }
    }

    if (!entrySet.has(WORKSPACE_FILES.AGENT)) {
      warnings.push('AGENT.md is missing — agent has no personality configuration');
    }

    return { valid: true, missing, warnings };
  }
}

// ============================================================================
// Default path
// ============================================================================

/** Return the default workspace path: `~/.agenc/workspace/`. */
export function getDefaultWorkspacePath(): string {
  return join(homedir(), '.agenc', 'workspace');
}

// ============================================================================
// System prompt assembly
// ============================================================================

export interface AssembleSystemPromptOptions {
  /** Extra context appended after all workspace files. */
  readonly additionalContext?: string;
  /** Maximum total character length (truncated with trailing `…`). */
  readonly maxLength?: number;
}

/**
 * Concatenate workspace files into a system prompt string.
 *
 * Assembly order: AGENT → SOUL → IDENTITY → CAPABILITIES → POLICY →
 * REPUTATION → USER → TOOLS → MEMORY → additionalContext.
 *
 * BOOT and HEARTBEAT are excluded — they are runtime-only hooks.
 */
export function assembleSystemPrompt(
  files: WorkspaceFiles,
  options?: AssembleSystemPromptOptions,
): string {
  const sections: string[] = [];

  const ordered: (string | undefined)[] = [
    files.agent,
    files.soul,
    files.identity,
    files.capabilities,
    files.policy,
    files.reputation,
    files.user,
    files.tools,
    files.memory,
  ];

  for (const section of ordered) {
    if (section !== undefined) {
      sections.push(section.trim());
    }
  }

  if (options?.additionalContext) {
    sections.push(options.additionalContext.trim());
  }

  let result = sections.join('\n\n');

  if (options?.maxLength !== undefined && result.length > options.maxLength) {
    if (options.maxLength < 1) return '';
    result = result.slice(0, options.maxLength - 1) + '\u2026';
  }

  return result;
}

// ============================================================================
// Templates
// ============================================================================

const TEMPLATES: Record<WorkspaceFileName, string> = {
  [WORKSPACE_FILES.AGENT]: `# Agent Configuration

Define your agent's name, role, and core behavior.

## Name
AgenC

## Role
A privacy-preserving AI agent on the AgenC protocol.

## Instructions
- Respond helpfully and concisely
- Prioritize user privacy
- Use available tools when appropriate
`,
  [WORKSPACE_FILES.SOUL]: `# Soul

Define your agent's personality traits and communication style.

## Personality
- Helpful and direct
- Privacy-conscious
- Technically competent

## Tone
Professional but approachable.
`,
  [WORKSPACE_FILES.USER]: `# User Preferences

Configure user-specific preferences and context.

## Preferences
- Language: English
- Response length: Concise
`,
  [WORKSPACE_FILES.TOOLS]: `# Tool Guidelines

Configure which tools the agent should prefer and how to use them.

## Available Tools
- Task operations (list, get, create, claim, complete)
- Agent operations (register, update, query)
- Protocol queries (config, PDA derivation)
`,
  [WORKSPACE_FILES.HEARTBEAT]: `# Heartbeat

Scheduled actions the agent performs periodically.

## Schedule
- Check for new claimable tasks
- Update agent status
`,
  [WORKSPACE_FILES.BOOT]: `# Boot

One-time startup actions executed when the agent initializes.

## Actions
- Verify agent registration
- Check protocol config
- Load cached state
`,
  [WORKSPACE_FILES.IDENTITY]: `# Identity

Cross-platform identity mapping and verification.

## Addresses
- Solana: (your pubkey here)
`,
  [WORKSPACE_FILES.MEMORY]: `# Memory

Long-term memory and context the agent should retain across sessions.

## Key Facts
- (Add persistent context here)
`,
  [WORKSPACE_FILES.CAPABILITIES]: `# Capabilities

On-chain capability bitmask and descriptions.

## Registered Capabilities
- COMPUTE (1 << 0)
- INFERENCE (1 << 1)
`,
  [WORKSPACE_FILES.POLICY]: `# Policy

Budget limits, circuit breakers, and access control rules.

## Budget
- Max SOL per task: 1.0
- Max tasks per hour: 10
`,
  [WORKSPACE_FILES.REPUTATION]: `# Reputation

On-chain reputation context and thresholds.

## Current
- Reputation score: (fetched at runtime)
- Min reputation for tasks: 50
`,
};

/** Return a template markdown string for the given workspace file. */
export function generateTemplate(fileName: WorkspaceFileName): string {
  return TEMPLATES[fileName];
}

// ============================================================================
// Scaffold
// ============================================================================

/**
 * Create the workspace directory and write template files for any that don't exist.
 *
 * Returns the list of files that were created (skips existing files).
 */
export async function scaffoldWorkspace(workspacePath: string): Promise<string[]> {
  await mkdir(workspacePath, { recursive: true });

  const created: string[] = [];

  for (const fileName of Object.values(WORKSPACE_FILES)) {
    const filePath = join(workspacePath, fileName);
    try {
      await writeFile(filePath, TEMPLATES[fileName], { encoding: 'utf-8', flag: 'wx' });
      created.push(fileName);
    } catch (err: unknown) {
      // EEXIST = file already exists — skip. Re-throw anything else.
      if (!(err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'EEXIST')) {
        throw err;
      }
    }
  }

  return created;
}
