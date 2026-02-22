/**
 * Agent workspace model and management.
 *
 * Each workspace holds isolated agent configuration: personality files,
 * skills, LLM config, memory namespace, capabilities, session config,
 * and tool permissions. The WorkspaceManager provides CRUD operations
 * over workspace directories on disk.
 *
 * @module
 */

import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  access,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { constants } from "node:fs";
import type { WorkspaceFiles } from "./workspace-files.js";
import {
  WORKSPACE_FILES,
  WorkspaceLoader,
  scaffoldWorkspace,
} from "./workspace-files.js";
import type { GatewayLLMConfig } from "./types.js";
import type { SessionConfig } from "./session.js";
import type { CapabilityName } from "../agent/capabilities.js";
import { parseCapabilities } from "../agent/capabilities.js";
import { isRecord } from "../utils/type-guards.js";
import { WorkspaceValidationError } from "./errors.js";

// ============================================================================
// Constants
// ============================================================================

export const WORKSPACE_CONFIG_FILE = "workspace.json";
export const DEFAULT_WORKSPACE_ID = "default";
export const WORKSPACE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
export const MAX_WORKSPACE_ID_LENGTH = 64;
export const MEMORY_NAMESPACE_PREFIX = "agenc:memory:";

// ============================================================================
// Types
// ============================================================================

export interface ToolPolicy {
  readonly tool: string;
  readonly allow: boolean;
  readonly reason?: string;
}

/** Workspace creation input. Uses PersonalityTemplate names from Phase 5.6 for file content. */
export interface WorkspaceTemplate {
  readonly name?: string;
  readonly files?: Partial<WorkspaceFiles>;
  readonly skills?: readonly string[];
  readonly llm?: Partial<GatewayLLMConfig>;
  readonly capabilities?: readonly CapabilityName[];
  readonly toolPermissions?: readonly ToolPolicy[];
}

export interface WorkspaceConfigJson {
  readonly name?: string;
  readonly skills?: readonly string[];
  readonly llm?: Partial<GatewayLLMConfig>;
  readonly memoryNamespace?: string;
  readonly capabilities?: string;
  readonly session?: Partial<SessionConfig>;
  readonly toolPermissions?: readonly ToolPolicy[];
}

export interface AgentWorkspace {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly files: WorkspaceFiles;
  readonly skills: readonly string[];
  readonly llm?: Partial<GatewayLLMConfig>;
  readonly memoryNamespace: string;
  readonly capabilities: bigint;
  readonly session?: Partial<SessionConfig>;
  readonly toolPermissions?: readonly ToolPolicy[];
}

// Re-export error class from canonical location
export { WorkspaceValidationError } from "./errors.js";

// ============================================================================
// Validation helpers (internal — not exported from barrel)
// ============================================================================

const VALID_LLM_PROVIDERS = new Set(["grok", "ollama"]);

function validateWorkspaceId(id: string): void {
  if (!WORKSPACE_ID_PATTERN.test(id)) {
    throw new WorkspaceValidationError(
      "id",
      `Invalid workspace ID "${id}": must match ${WORKSPACE_ID_PATTERN} (lowercase kebab-case, starts with letter)`,
    );
  }
  if (id.length > MAX_WORKSPACE_ID_LENGTH) {
    throw new WorkspaceValidationError(
      "id",
      `Workspace ID exceeds maximum length of ${MAX_WORKSPACE_ID_LENGTH} characters`,
    );
  }
}

function validateWorkspaceConfig(raw: unknown): string[] {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    errors.push("Config must be a JSON object");
    return errors;
  }

  if (raw.name !== undefined && typeof raw.name !== "string") {
    errors.push("name must be a string");
  }

  if (raw.skills !== undefined) {
    if (
      !Array.isArray(raw.skills) ||
      !raw.skills.every((s: unknown) => typeof s === "string")
    ) {
      errors.push("skills must be an array of strings");
    }
  }

  if (raw.llm !== undefined) {
    if (!isRecord(raw.llm)) {
      errors.push("llm must be an object");
    } else if (
      raw.llm.provider !== undefined &&
      !VALID_LLM_PROVIDERS.has(raw.llm.provider as string)
    ) {
      errors.push(
        `llm.provider must be one of: ${[...VALID_LLM_PROVIDERS].join(", ")}`,
      );
    }
  }

  if (raw.memoryNamespace !== undefined) {
    if (
      typeof raw.memoryNamespace !== "string" ||
      raw.memoryNamespace.length === 0
    ) {
      errors.push("memoryNamespace must be a non-empty string");
    }
  }

  if (raw.session !== undefined) {
    if (!isRecord(raw.session)) {
      errors.push("session must be an object");
    }
  }

  if (raw.capabilities !== undefined) {
    if (typeof raw.capabilities !== "string") {
      errors.push("capabilities must be a decimal bigint string");
    } else {
      try {
        BigInt(raw.capabilities);
      } catch {
        errors.push(
          `capabilities is not a valid decimal bigint string: "${raw.capabilities}"`,
        );
      }
    }
  }

  if (raw.toolPermissions !== undefined) {
    if (!Array.isArray(raw.toolPermissions)) {
      errors.push("toolPermissions must be an array");
    } else {
      for (let i = 0; i < raw.toolPermissions.length; i++) {
        const tp = raw.toolPermissions[i];
        if (
          !isRecord(tp) ||
          typeof tp.tool !== "string" ||
          typeof tp.allow !== "boolean"
        ) {
          errors.push(
            `toolPermissions[${i}] must have {tool: string, allow: boolean}`,
          );
        }
      }
    }
  }

  return errors;
}

// ============================================================================
// Internal helpers
// ============================================================================

async function loadWorkspaceConfig(
  workspacePath: string,
): Promise<WorkspaceConfigJson> {
  const configPath = join(workspacePath, WORKSPACE_CONFIG_FILE);
  let raw: string;

  try {
    raw = await readFile(configPath, "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      throw new WorkspaceValidationError(
        "config",
        `not found at ${configPath}`,
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkspaceValidationError(
      "config",
      `Invalid JSON in ${configPath}`,
    );
  }

  const errors = validateWorkspaceConfig(parsed);
  if (errors.length > 0) {
    throw new WorkspaceValidationError("config", errors.join("; "));
  }

  return parsed as WorkspaceConfigJson;
}

function resolveAgentWorkspace(
  id: string,
  path: string,
  config: WorkspaceConfigJson,
  files: WorkspaceFiles,
): AgentWorkspace {
  // Validation already guarantees config.capabilities is a valid BigInt string
  const capabilities =
    config.capabilities !== undefined ? BigInt(config.capabilities) : 0n;

  return {
    id,
    name: config.name ?? id,
    path,
    files,
    skills: config.skills ?? [],
    llm: config.llm,
    memoryNamespace:
      config.memoryNamespace ?? `${MEMORY_NAMESPACE_PREFIX}${id}:`,
    capabilities,
    session: config.session,
    toolPermissions: config.toolPermissions,
  };
}

// ============================================================================
// WorkspaceManager
// ============================================================================

export class WorkspaceManager {
  readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  async load(workspaceId: string): Promise<AgentWorkspace> {
    validateWorkspaceId(workspaceId);

    const workspacePath = join(this.basePath, workspaceId);

    try {
      await access(workspacePath, constants.R_OK);
    } catch {
      throw new WorkspaceValidationError(
        "path",
        `Workspace directory not found: ${workspacePath}`,
      );
    }

    const [config, files] = await Promise.all([
      loadWorkspaceConfig(workspacePath),
      new WorkspaceLoader(workspacePath).load(),
    ]);

    return resolveAgentWorkspace(workspaceId, workspacePath, config, files);
  }

  async listWorkspaces(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.basePath);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw err;
    }

    const results: string[] = [];
    for (const entry of entries) {
      if (
        !WORKSPACE_ID_PATTERN.test(entry) ||
        entry.length > MAX_WORKSPACE_ID_LENGTH
      )
        continue;

      try {
        await access(
          join(this.basePath, entry, WORKSPACE_CONFIG_FILE),
          constants.R_OK,
        );
        results.push(entry);
      } catch {
        // No workspace.json — skip
      }
    }

    return results.sort();
  }

  async createWorkspace(
    id: string,
    template?: WorkspaceTemplate,
  ): Promise<AgentWorkspace> {
    validateWorkspaceId(id);

    const workspacePath = join(this.basePath, id);

    // Guard against silently overwriting an existing workspace
    try {
      await access(workspacePath, constants.F_OK);
      throw new WorkspaceValidationError(
        "id",
        `Workspace already exists: ${id}`,
      );
    } catch (err) {
      if (err instanceof WorkspaceValidationError) throw err;
      // Only ENOENT means "doesn't exist yet" — re-throw anything else (e.g. EACCES)
      if (
        !(
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw err;
      }
    }

    await mkdir(workspacePath, { recursive: true });

    // Build config from template
    const config: Record<string, unknown> = {};
    if (template?.name !== undefined) config.name = template.name;
    if (template?.skills !== undefined) config.skills = [...template.skills];
    if (template?.llm !== undefined) config.llm = template.llm;
    if (template?.capabilities !== undefined) {
      config.capabilities = parseCapabilities([
        ...template.capabilities,
      ]).toString();
    }
    if (template?.toolPermissions !== undefined) {
      config.toolPermissions = [...template.toolPermissions];
    }

    // Write workspace.json
    await writeFile(
      join(workspacePath, WORKSPACE_CONFIG_FILE),
      JSON.stringify(config, null, 2) + "\n",
      "utf-8",
    );

    // Write file overrides FIRST (before scaffold, which uses wx flag)
    if (template?.files) {
      // Derive key→filename mapping from WORKSPACE_FILES to stay in sync
      const fileMap = Object.fromEntries(
        Object.entries(WORKSPACE_FILES).map(([key, fileName]) => [
          key.toLowerCase(),
          fileName,
        ]),
      );

      for (const [key, fileName] of Object.entries(fileMap)) {
        const content = (template.files as Record<string, string | undefined>)[
          key
        ];
        if (content !== undefined) {
          await writeFile(join(workspacePath, fileName), content, "utf-8");
        }
      }
    }

    // Scaffold creates template files only for those not already written (wx flag)
    await scaffoldWorkspace(workspacePath);

    return this.load(id);
  }

  async deleteWorkspace(id: string): Promise<boolean> {
    validateWorkspaceId(id);

    if (id === DEFAULT_WORKSPACE_ID) {
      throw new WorkspaceValidationError(
        "id",
        "Cannot delete the default workspace",
      );
    }

    const workspacePath = join(this.basePath, id);
    try {
      await access(join(workspacePath, WORKSPACE_CONFIG_FILE), constants.R_OK);
    } catch {
      return false;
    }

    await rm(workspacePath, { recursive: true });
    return true;
  }

  getDefault(): string {
    return DEFAULT_WORKSPACE_ID;
  }
}
