import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";
import type { Tool, ToolResult } from "../types.js";
import { SystemProcessManager } from "./process.js";
import type {
  SystemProcessToolConfig,
  SystemSandboxToolConfig,
  SystemSandboxWorkspaceAccessMode,
} from "./types.js";
import {
  asObject,
  asTrimmedString,
  handleErrorResult,
  handleOkResult,
  isToolResult,
  normalizeHandleIdentity,
  normalizeResourceEnvelope,
  type StructuredHandleResourceEnvelope,
} from "./handle-contract.js";

const execFileAsync = promisify(execFile);

const SYSTEM_SANDBOX_FAMILY = "system_sandbox";
const SYSTEM_SANDBOX_SCHEMA_VERSION = 1;
const SYSTEM_SANDBOX_ROOT = "/tmp/agenc-system-sandboxes";
const DEFAULT_SANDBOX_IMAGE = "node:20-slim";
const DEFAULT_DOCKER_TIMEOUT_MS = 30_000;
const DEFAULT_WORKSPACE_PATH = process.cwd();
const MAX_SANDBOX_JOBS = 64;
const SINGLE_EXECUTABLE_RE = /^[A-Za-z0-9_./:+-]+$/;

type SystemSandboxState = "running" | "stopped" | "failed";
type SystemSandboxJobState = "running" | "exited" | "failed";

interface SystemSandboxRecord {
  readonly version: number;
  readonly sandboxId: string;
  readonly label?: string;
  readonly idempotencyKey?: string;
  readonly image: string;
  readonly workspaceRoot: string;
  readonly workspaceAccess: SystemSandboxWorkspaceAccessMode;
  readonly networkAccess: boolean;
  readonly resourceEnvelope?: StructuredHandleResourceEnvelope;
  readonly containerId: string;
  readonly containerName: string;
  readonly createdAt: number;
  readonly startedAt: number;
  updatedAt: number;
  state: SystemSandboxState;
  endedAt?: number;
  lastError?: string;
}

interface SystemSandboxJobRecord {
  readonly version: number;
  readonly sandboxJobId: string;
  readonly sandboxId: string;
  readonly label?: string;
  readonly idempotencyKey?: string;
  readonly processId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly resourceEnvelope?: StructuredHandleResourceEnvelope;
  readonly createdAt: number;
  readonly startedAt: number;
  updatedAt: number;
  state: SystemSandboxJobState;
  endedAt?: number;
  lastError?: string;
}

interface PersistedSystemSandboxRegistry {
  readonly version: number;
  readonly sandboxes: readonly SystemSandboxRecord[];
  readonly jobs: readonly SystemSandboxJobRecord[];
}

interface SandboxInspectResult {
  readonly exists: boolean;
  readonly running: boolean;
  readonly exitCode?: number;
}

interface SandboxContainerCreateSpec {
  readonly sandboxId: string;
  readonly image: string;
  readonly workspaceRoot: string;
  readonly workspaceAccess: SystemSandboxWorkspaceAccessMode;
  readonly networkAccess: boolean;
  readonly resourceEnvelope?: StructuredHandleResourceEnvelope;
}

interface SystemSandboxContainerAdapter {
  createContainer(spec: SandboxContainerCreateSpec): Promise<{
    readonly containerId: string;
    readonly containerName: string;
  }>;
  inspectContainer(containerId: string): Promise<SandboxInspectResult>;
  stopContainer(containerId: string): Promise<void>;
}

interface SandboxJobRunner {
  start(args: Record<string, unknown>): Promise<ToolResult>;
  status(args: Record<string, unknown>): Promise<ToolResult>;
  resume(args: Record<string, unknown>): Promise<ToolResult>;
  stop(args: Record<string, unknown>): Promise<ToolResult>;
  logs(args: Record<string, unknown>): Promise<ToolResult>;
  stopAll?(): Promise<void>;
  resetForTesting?(): Promise<void>;
}

class DockerSandboxContainerAdapter implements SystemSandboxContainerAdapter {
  private readonly workspacePath: string;
  private readonly allowedImages: ReadonlySet<string> | null;
  private readonly dockerTimeoutMs: number;
  private readonly logger: Logger;

  constructor(config: SystemSandboxToolConfig) {
    this.workspacePath = resolve(config.workspacePath ?? DEFAULT_WORKSPACE_PATH);
    this.allowedImages =
      config.allowedImages && config.allowedImages.length > 0
        ? new Set(config.allowedImages)
        : null;
    this.dockerTimeoutMs = config.dockerTimeoutMs ?? DEFAULT_DOCKER_TIMEOUT_MS;
    this.logger = config.logger ?? silentLogger;
  }

  async createContainer(spec: SandboxContainerCreateSpec): Promise<{
    readonly containerId: string;
    readonly containerName: string;
  }> {
    if (this.allowedImages && !this.allowedImages.has(spec.image)) {
      throw new Error(`Image "${spec.image}" is not allowed for sandbox handles`);
    }
    const containerName = `agenc-sandbox-handle-${spec.sandboxId}`;
    await execFileAsync(
      "docker",
      ["rm", "-f", containerName],
      { timeout: this.dockerTimeoutMs },
    ).catch(() => undefined);

    const args = ["run", "-d", "--name", containerName];
    if (spec.resourceEnvelope?.cpu !== undefined) {
      args.push("--cpus", String(spec.resourceEnvelope.cpu));
    }
    if (spec.resourceEnvelope?.memoryMb !== undefined) {
      args.push("--memory", `${spec.resourceEnvelope.memoryMb}m`);
    }
    if (!spec.networkAccess) {
      args.push("--network", "none");
    }
    if (spec.workspaceAccess !== "none") {
      const mountMode = spec.workspaceAccess === "readonly" ? "ro" : "rw";
      args.push("-v", `${this.workspacePath}:/workspace:${mountMode}`);
      args.push("-w", "/workspace");
    }
    args.push(spec.image, "tail", "-f", "/dev/null");

    this.logger.debug("Creating durable sandbox handle", {
      image: spec.image,
      containerName,
      workspaceAccess: spec.workspaceAccess,
    });
    const { stdout } = await execFileAsync("docker", args, {
      timeout: this.dockerTimeoutMs,
    });
    return {
      containerId: stdout.trim(),
      containerName,
    };
  }

  async inspectContainer(containerId: string): Promise<SandboxInspectResult> {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        [
          "inspect",
          "-f",
          "{{.State.Running}} {{.State.ExitCode}}",
          containerId,
        ],
        { timeout: this.dockerTimeoutMs },
      );
      const [runningText, exitCodeText] = stdout.trim().split(/\s+/, 2);
      return {
        exists: true,
        running: runningText === "true",
        ...(exitCodeText !== undefined && exitCodeText.length > 0
          ? { exitCode: Number.parseInt(exitCodeText, 10) }
          : {}),
      };
    } catch {
      return {
        exists: false,
        running: false,
      };
    }
  }

  async stopContainer(containerId: string): Promise<void> {
    await execFileAsync("docker", ["rm", "-f", containerId], {
      timeout: this.dockerTimeoutMs,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/No such container|cannot remove|not found/i.test(message)) {
        throw error;
      }
    });
  }
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeSandboxState(value: unknown): SystemSandboxState | undefined {
  if (value === "running" || value === "stopped" || value === "failed") {
    return value;
  }
  return undefined;
}

function normalizeSandboxJobState(
  value: unknown,
): SystemSandboxJobState | undefined {
  if (value === "running" || value === "exited" || value === "failed") {
    return value;
  }
  return value === "stopped" ? "exited" : undefined;
}

function normalizeWorkspaceAccess(
  value: unknown,
): SystemSandboxWorkspaceAccessMode | undefined {
  return value === "none" || value === "readonly" || value === "readwrite"
    ? value
    : undefined;
}

function validateExecutable(commandValue: unknown, operation: string): string | ToolResult {
  const command = asTrimmedString(commandValue);
  if (!command) {
    return handleErrorResult(
      SYSTEM_SANDBOX_FAMILY,
      "system_sandbox.invalid_command",
      "command must be a non-empty executable path or name",
      false,
      undefined,
      operation,
      "validation",
    );
  }
  if (!SINGLE_EXECUTABLE_RE.test(command)) {
    return handleErrorResult(
      SYSTEM_SANDBOX_FAMILY,
      "system_sandbox.invalid_command",
      "command must be a single executable token; pass flags and operands via args",
      false,
      undefined,
      operation,
      "validation",
    );
  }
  return command;
}

function normalizeArgs(value: unknown, operation: string): readonly string[] | ToolResult {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return handleErrorResult(
      SYSTEM_SANDBOX_FAMILY,
      "system_sandbox.invalid_args",
      "args must be an array of strings",
      false,
      undefined,
      operation,
      "validation",
    );
  }
  const args: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return handleErrorResult(
        SYSTEM_SANDBOX_FAMILY,
        "system_sandbox.invalid_args",
        "args must be an array of strings",
        false,
        undefined,
        operation,
        "validation",
      );
    }
    args.push(entry);
  }
  return args;
}

function parseToolResultObject(result: ToolResult): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(result.content) as unknown;
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function buildSandboxResponse(
  record: SystemSandboxRecord,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sandboxId: record.sandboxId,
    ...(record.label ? { label: record.label } : {}),
    ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
    image: record.image,
    workspaceRoot: record.workspaceRoot,
    workspaceAccess: record.workspaceAccess,
    networkAccess: record.networkAccess,
    containerId: record.containerId,
    containerName: record.containerName,
    state: record.state,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...(record.resourceEnvelope ? { resourceEnvelope: record.resourceEnvelope } : {}),
    ...extra,
  };
}

function buildSandboxJobResponse(
  job: SystemSandboxJobRecord,
  processPayload: Record<string, unknown>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sandboxJobId: job.sandboxJobId,
    sandboxId: job.sandboxId,
    ...(job.label ? { label: job.label } : {}),
    ...(job.idempotencyKey ? { idempotencyKey: job.idempotencyKey } : {}),
    processId: job.processId,
    command: job.command,
    args: job.args,
    ...(job.cwd ? { cwd: job.cwd } : {}),
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
    ...(job.lastError ? { lastError: job.lastError } : {}),
    ...(job.resourceEnvelope ? { resourceEnvelope: job.resourceEnvelope } : {}),
    process: processPayload,
    ...extra,
  };
}

export class SystemSandboxManager {
  private readonly rootDir: string;
  private readonly registryPath: string;
  private readonly defaultImage: string;
  private readonly workspacePath: string;
  private readonly defaultWorkspaceAccess: SystemSandboxWorkspaceAccessMode;
  private readonly defaultNetworkAccess: boolean;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly containerAdapter: SystemSandboxContainerAdapter;
  private readonly jobRunner: SandboxJobRunner;
  private readonly sandboxes = new Map<string, SystemSandboxRecord>();
  private readonly jobs = new Map<string, SystemSandboxJobRecord>();
  private loaded = false;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(
    config?: SystemSandboxToolConfig,
    overrides?: {
      readonly containerAdapter?: SystemSandboxContainerAdapter;
      readonly jobRunner?: SandboxJobRunner;
    },
  ) {
    this.rootDir = config?.rootDir ?? SYSTEM_SANDBOX_ROOT;
    this.registryPath = join(this.rootDir, "registry.json");
    this.defaultImage = config?.defaultImage ?? DEFAULT_SANDBOX_IMAGE;
    this.workspacePath = resolve(config?.workspacePath ?? DEFAULT_WORKSPACE_PATH);
    this.defaultWorkspaceAccess = config?.defaultWorkspaceAccess ?? "readwrite";
    this.defaultNetworkAccess = config?.defaultNetworkAccess ?? false;
    this.logger = config?.logger ?? silentLogger;
    this.now = config?.now ?? (() => Date.now());
    this.containerAdapter =
      overrides?.containerAdapter ?? new DockerSandboxContainerAdapter(config ?? {});
    this.jobRunner =
      overrides?.jobRunner ??
      new SystemProcessManager({
        rootDir: join(this.rootDir, "processes"),
        logger: this.logger,
        allowList: ["docker"],
        unrestricted: false,
        defaultStopWaitMs: config?.defaultStopWaitMs,
        defaultLogTailBytes: config?.defaultLogTailBytes,
        maxLogTailBytes: config?.maxLogTailBytes,
        defaultLogSettleMs: config?.defaultLogSettleMs,
        maxLogSettleMs: config?.maxLogSettleMs,
      } satisfies SystemProcessToolConfig);
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.rootDir, { recursive: true });
    if (existsSync(this.registryPath)) {
      try {
        const raw = await readFile(this.registryPath, "utf8");
        const parsed = JSON.parse(raw) as PersistedSystemSandboxRegistry;
        for (const sandbox of parsed.sandboxes ?? []) {
          if (
            sandbox &&
            typeof sandbox.sandboxId === "string" &&
            typeof sandbox.image === "string" &&
            typeof sandbox.containerId === "string"
          ) {
            const state = normalizeSandboxState(sandbox.state);
            if (state) {
              this.sandboxes.set(
                sandbox.sandboxId,
                cloneJson({ ...sandbox, state } as SystemSandboxRecord),
              );
            }
          }
        }
        for (const job of parsed.jobs ?? []) {
          if (
            job &&
            typeof job.sandboxJobId === "string" &&
            typeof job.sandboxId === "string" &&
            typeof job.processId === "string"
          ) {
            const state = normalizeSandboxJobState(job.state);
            if (state) {
              this.jobs.set(
                job.sandboxJobId,
                cloneJson({ ...job, state } as SystemSandboxJobRecord),
              );
            }
          }
        }
      } catch (error) {
        this.logger.warn("Failed to load system sandbox registry", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedSystemSandboxRegistry = {
      version: SYSTEM_SANDBOX_SCHEMA_VERSION,
      sandboxes: [...this.sandboxes.values()].map((record) => cloneJson(record)),
      jobs: [...this.jobs.values()].map((record) => cloneJson(record)),
    };
    this.persistChain = this.persistChain.then(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const tempPath = `${this.registryPath}.tmp`;
      await writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
      await rename(tempPath, this.registryPath);
    });
    await this.persistChain;
  }

  private findSandboxByLabel(label: string): SystemSandboxRecord | undefined {
    let best: SystemSandboxRecord | undefined;
    for (const record of this.sandboxes.values()) {
      if (record.label !== label) continue;
      if (!best) {
        best = record;
        continue;
      }
      if (best.state !== "running" && record.state === "running") {
        best = record;
        continue;
      }
      if (record.updatedAt > best.updatedAt) {
        best = record;
      }
    }
    return best;
  }

  private findSandboxByIdempotencyKey(
    idempotencyKey: string,
  ): SystemSandboxRecord | undefined {
    let best: SystemSandboxRecord | undefined;
    for (const record of this.sandboxes.values()) {
      if (record.idempotencyKey !== idempotencyKey) continue;
      if (!best) {
        best = record;
        continue;
      }
      if (best.state !== "running" && record.state === "running") {
        best = record;
        continue;
      }
      if (record.updatedAt > best.updatedAt) {
        best = record;
      }
    }
    return best;
  }

  private findJobByLabel(label: string): SystemSandboxJobRecord | undefined {
    let best: SystemSandboxJobRecord | undefined;
    for (const record of this.jobs.values()) {
      if (record.label !== label) continue;
      if (!best) {
        best = record;
        continue;
      }
      if (best.state !== "running" && record.state === "running") {
        best = record;
        continue;
      }
      if (record.updatedAt > best.updatedAt) {
        best = record;
      }
    }
    return best;
  }

  private findJobByIdempotencyKey(
    idempotencyKey: string,
  ): SystemSandboxJobRecord | undefined {
    let best: SystemSandboxJobRecord | undefined;
    for (const record of this.jobs.values()) {
      if (record.idempotencyKey !== idempotencyKey) continue;
      if (!best) {
        best = record;
        continue;
      }
      if (best.state !== "running" && record.state === "running") {
        best = record;
        continue;
      }
      if (record.updatedAt > best.updatedAt) {
        best = record;
      }
    }
    return best;
  }

  private async refreshSandbox(record: SystemSandboxRecord): Promise<SystemSandboxRecord> {
    const inspection = await this.containerAdapter.inspectContainer(record.containerId);
    if (!inspection.exists) {
      const nextRecord: SystemSandboxRecord = {
        ...record,
        state: "stopped",
        updatedAt: this.now(),
        endedAt: record.endedAt ?? this.now(),
      };
      this.sandboxes.set(record.sandboxId, nextRecord);
      await this.persist();
      return nextRecord;
    }
    const nextState: SystemSandboxState = inspection.running
      ? "running"
      : inspection.exitCode === 0
        ? "stopped"
        : "failed";
    if (nextState === record.state) {
      return record;
    }
    const nextRecord: SystemSandboxRecord = {
      ...record,
      state: nextState,
      updatedAt: this.now(),
      ...(nextState !== "running"
        ? { endedAt: record.endedAt ?? this.now() }
        : {}),
      ...(nextState === "failed" && inspection.exitCode !== undefined
        ? { lastError: `Sandbox container exited with code ${inspection.exitCode}` }
        : {}),
    };
    this.sandboxes.set(record.sandboxId, nextRecord);
    await this.persist();
    return nextRecord;
  }

  private async resolveSandbox(
    args: Record<string, unknown>,
    operation: string,
  ): Promise<SystemSandboxRecord | ToolResult> {
    await this.ensureLoaded();
    const sandboxId = asTrimmedString(args.sandboxId);
    const identity = normalizeHandleIdentity(
      SYSTEM_SANDBOX_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    let record = sandboxId ? this.sandboxes.get(sandboxId) : undefined;
    if (!record && sandboxId) {
      record =
        this.findSandboxByLabel(sandboxId) ??
        this.findSandboxByIdempotencyKey(sandboxId);
    }
    if (!record) {
      record = identity.idempotencyKey
        ? this.findSandboxByIdempotencyKey(identity.idempotencyKey)
        : identity.label
          ? this.findSandboxByLabel(identity.label)
          : undefined;
    }
    if (!record) {
      return handleErrorResult(
        SYSTEM_SANDBOX_FAMILY,
        "system_sandbox.not_found",
        "Sandbox handle not found. Provide sandboxId or a previously used label/idempotencyKey.",
        false,
        undefined,
        operation,
        "not_found",
      );
    }
    return this.refreshSandbox(record);
  }

  private async resolveJob(
    args: Record<string, unknown>,
    operation: string,
  ): Promise<SystemSandboxJobRecord | ToolResult> {
    await this.ensureLoaded();
    const sandboxJobId = asTrimmedString(args.sandboxJobId);
    const identity = normalizeHandleIdentity(
      SYSTEM_SANDBOX_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    let record = sandboxJobId ? this.jobs.get(sandboxJobId) : undefined;
    if (!record && sandboxJobId) {
      record =
        this.findJobByLabel(sandboxJobId) ??
        this.findJobByIdempotencyKey(sandboxJobId);
    }
    if (!record) {
      record = identity.idempotencyKey
        ? this.findJobByIdempotencyKey(identity.idempotencyKey)
        : identity.label
          ? this.findJobByLabel(identity.label)
          : undefined;
    }
    if (!record) {
      return handleErrorResult(
        SYSTEM_SANDBOX_FAMILY,
        "system_sandbox.not_found",
        "Sandbox job handle not found. Provide sandboxJobId or a previously used label/idempotencyKey.",
        false,
        undefined,
        operation,
        "not_found",
      );
    }
    return record;
  }

  private async refreshJob(record: SystemSandboxJobRecord): Promise<SystemSandboxJobRecord> {
    const processResult = parseToolResultObject(
      await this.jobRunner.status({ processId: record.processId }),
    );
    const state =
      processResult?.state === "running"
        ? "running"
        : processResult?.state === "failed"
          ? "failed"
          : processResult?.state === "exited"
            ? "exited"
            : record.state;
    if (state === record.state) {
      return record;
    }
    const nextRecord: SystemSandboxJobRecord = {
      ...record,
      state,
      updatedAt: this.now(),
      ...(state !== "running" ? { endedAt: this.now() } : {}),
      ...(typeof processResult?.lastError === "string"
        ? { lastError: processResult.lastError }
        : {}),
    };
    this.jobs.set(record.sandboxJobId, nextRecord);
    await this.persist();
    return nextRecord;
  }

  async startSandbox(args: Record<string, unknown>): Promise<ToolResult> {
    await this.ensureLoaded();
    const image = asTrimmedString(args.image) ?? this.defaultImage;
    const workspaceAccess =
      normalizeWorkspaceAccess(args.workspaceAccess) ?? this.defaultWorkspaceAccess;
    const networkAccess =
      typeof args.networkAccess === "boolean"
        ? args.networkAccess
        : this.defaultNetworkAccess;
    const resourceEnvelope = normalizeResourceEnvelope(
      SYSTEM_SANDBOX_FAMILY,
      args.resourceEnvelope,
      "start",
    );
    if (isToolResult(resourceEnvelope)) return resourceEnvelope;
    const requestedSandboxHandle = asTrimmedString(args.sandboxId);
    const identity = normalizeHandleIdentity(
      SYSTEM_SANDBOX_FAMILY,
      args.label,
      args.idempotencyKey ?? requestedSandboxHandle,
    );
    const workspaceRoot = this.workspacePath;

    const matchesSpec = (record: SystemSandboxRecord): boolean =>
      record.image === image &&
      record.workspaceRoot === workspaceRoot &&
      record.workspaceAccess === workspaceAccess &&
      record.networkAccess === networkAccess &&
      JSON.stringify(record.resourceEnvelope ?? null) ===
        JSON.stringify(resourceEnvelope ?? null);

    const idempotentMatch = identity.idempotencyKey
      ? this.findSandboxByIdempotencyKey(identity.idempotencyKey)
      : undefined;
    if (idempotentMatch) {
      const refreshed = await this.refreshSandbox(idempotentMatch);
      if (matchesSpec(refreshed) && refreshed.state === "running") {
        return handleOkResult(buildSandboxResponse(refreshed, { reused: true }));
      }
      return handleErrorResult(
        SYSTEM_SANDBOX_FAMILY,
        "system_sandbox.idempotency_conflict",
        "A sandbox handle already exists for that idempotencyKey.",
        false,
        { sandboxId: idempotentMatch.sandboxId, state: idempotentMatch.state },
        "start",
        "idempotency_conflict",
      );
    }

    const labelMatch = identity.label ? this.findSandboxByLabel(identity.label) : undefined;
    if (labelMatch) {
      const refreshed = await this.refreshSandbox(labelMatch);
      if (
        refreshed.idempotencyKey === identity.idempotencyKey &&
        matchesSpec(refreshed) &&
        refreshed.state === "running"
      ) {
        return handleOkResult(buildSandboxResponse(refreshed, { reused: true }));
      }
      if (refreshed.state === "running") {
        return handleErrorResult(
          SYSTEM_SANDBOX_FAMILY,
          "system_sandbox.label_conflict",
          "A sandbox handle already exists for that label.",
          false,
          { sandboxId: refreshed.sandboxId, state: refreshed.state },
          "start",
          "label_conflict",
        );
      }
      this.sandboxes.set(refreshed.sandboxId, {
        ...refreshed,
        label: undefined,
        updatedAt: this.now(),
      });
    }

    const sandboxId = `sandbox_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    try {
      const created = await this.containerAdapter.createContainer({
        sandboxId,
        image,
        workspaceRoot,
        workspaceAccess,
        networkAccess,
        resourceEnvelope: resourceEnvelope || undefined,
      });
      const now = this.now();
      const record: SystemSandboxRecord = {
        version: SYSTEM_SANDBOX_SCHEMA_VERSION,
        sandboxId,
        ...(identity.label ? { label: identity.label } : {}),
        ...(identity.idempotencyKey ? { idempotencyKey: identity.idempotencyKey } : {}),
        image,
        workspaceRoot,
        workspaceAccess,
        networkAccess,
        ...(resourceEnvelope ? { resourceEnvelope } : {}),
        containerId: created.containerId,
        containerName: created.containerName,
        createdAt: now,
        startedAt: now,
        updatedAt: now,
        state: "running",
      };
      this.sandboxes.set(sandboxId, record);
      await this.persist();
      return handleOkResult(buildSandboxResponse(record, { started: true }));
    } catch (error) {
      return handleErrorResult(
        SYSTEM_SANDBOX_FAMILY,
        "system_sandbox.start_failed",
        `Failed to start sandbox handle: ${error instanceof Error ? error.message : String(error)}`,
        true,
        undefined,
        "start",
        "start_failed",
      );
    }
  }

  async sandboxStatus(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveSandbox(args, "status");
    if (isToolResult(record)) return record;
    const runningJobs = [...this.jobs.values()].filter(
      (job) => job.sandboxId === record.sandboxId && job.state === "running",
    ).length;
    return handleOkResult(buildSandboxResponse(record, {
      jobCount: [...this.jobs.values()].filter((job) => job.sandboxId === record.sandboxId)
        .length,
      runningJobCount: runningJobs,
    }));
  }

  async sandboxResume(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveSandbox(args, "resume");
    if (isToolResult(record)) return record;
    return handleOkResult(buildSandboxResponse(record, {
      resumed: record.state === "running",
    }));
  }

  async sandboxStop(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveSandbox(args, "stop");
    if (isToolResult(record)) return record;
    if (record.state !== "running") {
      return handleOkResult(buildSandboxResponse(record, {
        stopped: false,
      }));
    }
    for (const job of this.jobs.values()) {
      if (job.sandboxId === record.sandboxId && job.state === "running") {
        await this.sandboxJobStop({ sandboxJobId: job.sandboxJobId }).catch(() => undefined);
      }
    }
    try {
      await this.containerAdapter.stopContainer(record.containerId);
    } catch (error) {
      return handleErrorResult(
        SYSTEM_SANDBOX_FAMILY,
        "system_sandbox.stop_failed",
        error instanceof Error ? error.message : String(error),
        true,
        undefined,
        "stop",
        "stop_failed",
      );
    }
    const nextRecord: SystemSandboxRecord = {
      ...record,
      state: "stopped",
      updatedAt: this.now(),
      endedAt: record.endedAt ?? this.now(),
    };
    this.sandboxes.set(record.sandboxId, nextRecord);
    await this.persist();
    return handleOkResult(buildSandboxResponse(nextRecord, {
      stopped: true,
    }));
  }

  async sandboxJobStart(args: Record<string, unknown>): Promise<ToolResult> {
    const sandbox = await this.resolveSandbox(args, "job_start");
    if (isToolResult(sandbox)) return sandbox;
    if (sandbox.state !== "running") {
      return handleErrorResult(
        SYSTEM_SANDBOX_FAMILY,
        "system_sandbox.environment_unavailable",
        "Sandbox is not running. Start or resume the sandbox handle before launching a sandbox job.",
        true,
        { sandboxId: sandbox.sandboxId, state: sandbox.state },
        "job_start",
        "environment_unavailable",
      );
    }
    const command = validateExecutable(args.command, "job_start");
    if (isToolResult(command)) return command;
    const normalizedArgs = normalizeArgs(args.args, "job_start");
    if (isToolResult(normalizedArgs)) return normalizedArgs;
    const cwd = asTrimmedString(args.cwd);
    const resourceEnvelope = normalizeResourceEnvelope(
      SYSTEM_SANDBOX_FAMILY,
      args.resourceEnvelope,
      "job_start",
    );
    if (isToolResult(resourceEnvelope)) return resourceEnvelope;
    const requestedSandboxJobHandle = asTrimmedString(args.sandboxJobId);
    const identity = normalizeHandleIdentity(
      SYSTEM_SANDBOX_FAMILY,
      args.label,
      args.idempotencyKey ?? requestedSandboxJobHandle,
    );
    const matchesSpec = (record: SystemSandboxJobRecord): boolean =>
      record.sandboxId === sandbox.sandboxId &&
      record.command === command &&
      JSON.stringify(record.args) === JSON.stringify(normalizedArgs) &&
      record.cwd === cwd &&
      JSON.stringify(record.resourceEnvelope ?? null) ===
        JSON.stringify(resourceEnvelope ?? null);

    const idempotentMatch = identity.idempotencyKey
      ? this.findJobByIdempotencyKey(identity.idempotencyKey)
      : undefined;
    if (idempotentMatch) {
      const refreshed = await this.refreshJob(idempotentMatch);
      if (matchesSpec(refreshed) && refreshed.state === "running") {
        const processPayload = parseToolResultObject(
          await this.jobRunner.status({ processId: refreshed.processId }),
        ) ?? {};
        return handleOkResult(buildSandboxJobResponse(refreshed, processPayload, {
          reused: true,
        }));
      }
      return handleErrorResult(
        SYSTEM_SANDBOX_FAMILY,
        "system_sandbox.idempotency_conflict",
        "A sandbox job handle already exists for that idempotencyKey.",
        false,
        {
          sandboxJobId: idempotentMatch.sandboxJobId,
          state: idempotentMatch.state,
        },
        "job_start",
        "idempotency_conflict",
      );
    }

    const labelMatch = identity.label ? this.findJobByLabel(identity.label) : undefined;
    if (labelMatch) {
      const refreshed = await this.refreshJob(labelMatch);
      if (
        refreshed.idempotencyKey === identity.idempotencyKey &&
        matchesSpec(refreshed) &&
        refreshed.state === "running"
      ) {
        const processPayload = parseToolResultObject(
          await this.jobRunner.status({ processId: refreshed.processId }),
        ) ?? {};
        return handleOkResult(buildSandboxJobResponse(refreshed, processPayload, {
          reused: true,
        }));
      }
      if (refreshed.state === "running") {
        return handleErrorResult(
          SYSTEM_SANDBOX_FAMILY,
          "system_sandbox.label_conflict",
          "A sandbox job handle already exists for that label.",
          false,
          { sandboxJobId: refreshed.sandboxJobId, state: refreshed.state },
          "job_start",
          "label_conflict",
        );
      }
      this.jobs.set(refreshed.sandboxJobId, {
        ...refreshed,
        label: undefined,
        updatedAt: this.now(),
      });
    }

    if (this.jobs.size >= MAX_SANDBOX_JOBS) {
      return handleErrorResult(
        SYSTEM_SANDBOX_FAMILY,
        "system_sandbox.blocked",
        "Too many sandbox jobs are already tracked. Stop or clean up an existing job before starting another one.",
        true,
        { maxJobs: MAX_SANDBOX_JOBS },
        "job_start",
        "blocked",
      );
    }

    const sandboxJobId = `sjob_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const processLabel = `sandbox-job-${sandboxJobId}`;
    const dockerArgs: string[] = ["exec"];
    if (cwd) {
      dockerArgs.push("-w", cwd);
    }
    dockerArgs.push(sandbox.containerId, command, ...normalizedArgs);

    const processResult = await this.jobRunner.start({
      command: "docker",
      args: dockerArgs,
      label: processLabel,
    });
    if (processResult.isError) {
      return processResult;
    }
    const processPayload = parseToolResultObject(processResult) ?? {};
    const processId = asTrimmedString(processPayload.processId);
    if (!processId) {
      return handleErrorResult(
        SYSTEM_SANDBOX_FAMILY,
        "system_sandbox.start_failed",
        "Sandbox job start did not return a durable processId.",
        true,
        { sandboxId: sandbox.sandboxId },
        "job_start",
        "start_failed",
      );
    }
    const now = this.now();
    const jobRecord: SystemSandboxJobRecord = {
      version: SYSTEM_SANDBOX_SCHEMA_VERSION,
      sandboxJobId,
      sandboxId: sandbox.sandboxId,
      ...(identity.label ? { label: identity.label } : {}),
      ...(identity.idempotencyKey ? { idempotencyKey: identity.idempotencyKey } : {}),
      processId,
      command,
      args: [...normalizedArgs],
      ...(cwd ? { cwd } : {}),
      ...(resourceEnvelope ? { resourceEnvelope } : {}),
      createdAt: now,
      startedAt: now,
      updatedAt: now,
      state:
        processPayload.state === "failed"
          ? "failed"
          : processPayload.state === "exited"
            ? "exited"
            : "running",
      ...(typeof processPayload.lastError === "string"
        ? { lastError: processPayload.lastError }
        : {}),
      ...((processPayload.state === "exited" || processPayload.state === "failed")
        ? { endedAt: now }
        : {}),
    };
    this.jobs.set(sandboxJobId, jobRecord);
    await this.persist();
    return handleOkResult(buildSandboxJobResponse(jobRecord, processPayload, {
      started: true,
    }));
  }

  async sandboxJobStatus(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveJob(args, "job_status");
    if (isToolResult(record)) return record;
    const refreshed = await this.refreshJob(record);
    const processPayload = parseToolResultObject(
      await this.jobRunner.status({ processId: refreshed.processId }),
    ) ?? {};
    return handleOkResult(buildSandboxJobResponse(refreshed, processPayload));
  }

  async sandboxJobResume(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveJob(args, "job_resume");
    if (isToolResult(record)) return record;
    const refreshed = await this.refreshJob(record);
    const processPayload = parseToolResultObject(
      await this.jobRunner.resume({ processId: refreshed.processId }),
    ) ?? {};
    return handleOkResult(buildSandboxJobResponse(refreshed, processPayload, {
      resumed: refreshed.state === "running",
    }));
  }

  async sandboxJobLogs(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveJob(args, "job_logs");
    if (isToolResult(record)) return record;
    const refreshed = await this.refreshJob(record);
    const processPayload = parseToolResultObject(
      await this.jobRunner.logs({
        processId: refreshed.processId,
        maxBytes: args.maxBytes,
        waitForOutputMs: args.waitForOutputMs,
      }),
    ) ?? {};
    const nextState: SystemSandboxJobState =
      processPayload.state === "failed"
        ? "failed"
        : processPayload.state === "exited"
          ? "exited"
          : refreshed.state;
    if (nextState !== refreshed.state) {
      const nextRecord: SystemSandboxJobRecord = {
        ...refreshed,
        state: nextState,
        updatedAt: this.now(),
        ...(nextState !== "running" ? { endedAt: refreshed.endedAt ?? this.now() } : {}),
        ...(typeof processPayload.lastError === "string"
          ? { lastError: processPayload.lastError }
          : {}),
      };
      this.jobs.set(refreshed.sandboxJobId, nextRecord);
      await this.persist();
      return handleOkResult({
        sandboxJobId: nextRecord.sandboxJobId,
        sandboxId: nextRecord.sandboxId,
        ...(nextRecord.label ? { label: nextRecord.label } : {}),
        ...(nextRecord.idempotencyKey ? { idempotencyKey: nextRecord.idempotencyKey } : {}),
        processId: nextRecord.processId,
        state: nextRecord.state,
        ...processPayload,
      });
    }
    return handleOkResult({
      sandboxJobId: refreshed.sandboxJobId,
      sandboxId: refreshed.sandboxId,
      ...(refreshed.label ? { label: refreshed.label } : {}),
      ...(refreshed.idempotencyKey ? { idempotencyKey: refreshed.idempotencyKey } : {}),
      processId: refreshed.processId,
      state: refreshed.state,
      ...processPayload,
    });
  }

  async sandboxJobStop(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveJob(args, "job_stop");
    if (isToolResult(record)) return record;
    const processResult = await this.jobRunner.stop({
      processId: record.processId,
      signal: args.signal,
      waitMs: args.waitMs,
    });
    if (processResult.isError) {
      return processResult;
    }
    const processPayload = parseToolResultObject(processResult) ?? {};
    const nextRecord: SystemSandboxJobRecord = {
      ...record,
      state:
        processPayload.state === "failed"
          ? "failed"
          : "exited",
      updatedAt: this.now(),
      endedAt: record.endedAt ?? this.now(),
      ...(typeof processPayload.lastError === "string"
        ? { lastError: processPayload.lastError }
        : {}),
    };
    this.jobs.set(record.sandboxJobId, nextRecord);
    await this.persist();
    return handleOkResult(buildSandboxJobResponse(nextRecord, processPayload, {
      stopped: true,
    }));
  }

  async resetForTesting(): Promise<void> {
    this.sandboxes.clear();
    this.jobs.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    if (this.jobRunner.stopAll) {
      await this.jobRunner.stopAll().catch(() => undefined);
    }
    if (this.jobRunner.resetForTesting) {
      await this.jobRunner.resetForTesting().catch(() => undefined);
    }
    await rm(this.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  resetForTestingSync(): void {
    this.sandboxes.clear();
    this.jobs.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    rmSync(this.rootDir, { recursive: true, force: true });
  }
}

export function createSandboxTools(
  config?: SystemSandboxToolConfig,
  manager = new SystemSandboxManager(config),
): Tool[] {
  return [
    {
      name: "system.sandboxStart",
      description:
        "Create a durable code-execution sandbox handle backed by a long-lived container environment with stable workspace identity and resource metadata.",
      inputSchema: {
        type: "object",
        properties: {
          image: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          workspaceAccess: {
            type: "string",
            enum: ["none", "readonly", "readwrite"],
          },
          networkAccess: { type: "boolean" },
          resourceEnvelope: {
            type: "object",
            description:
              "Optional resource budget contract: cpu, memoryMb, diskMb, network, wallClockMs, sandboxAffinity, environmentClass, enforcement.",
          },
        },
      },
      execute: (args) => manager.startSandbox(asObject(args) ?? {}),
    },
    {
      name: "system.sandboxStatus",
      description:
        "Inspect a durable sandbox handle and return container state, workspace metadata, and linked job counts.",
      inputSchema: {
        type: "object",
        properties: {
          sandboxId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.sandboxStatus(asObject(args) ?? {}),
    },
    {
      name: "system.sandboxResume",
      description:
        "Reattach to a durable sandbox handle after restart and return the current environment state.",
      inputSchema: {
        type: "object",
        properties: {
          sandboxId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.sandboxResume(asObject(args) ?? {}),
    },
    {
      name: "system.sandboxStop",
      description:
        "Stop a durable sandbox handle and terminate its linked sandbox jobs.",
      inputSchema: {
        type: "object",
        properties: {
          sandboxId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.sandboxStop(asObject(args) ?? {}),
    },
    {
      name: "system.sandboxJobStart",
      description:
        "Start a durable sandbox job inside an existing sandbox environment and return a stable job handle plus linked host process handle.",
      inputSchema: {
        type: "object",
        properties: {
          sandboxId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          command: { type: "string" },
          args: {
            type: "array",
            items: { type: "string" },
          },
          cwd: { type: "string" },
          resourceEnvelope: {
            type: "object",
            description:
              "Optional resource budget contract: cpu, memoryMb, diskMb, network, wallClockMs, sandboxAffinity, environmentClass, enforcement.",
          },
        },
        required: ["sandboxId", "command"],
      },
      execute: (args) => manager.sandboxJobStart(asObject(args) ?? {}),
    },
    {
      name: "system.sandboxJobStatus",
      description:
        "Inspect a durable sandbox job handle and return linked host-process status and recent output.",
      inputSchema: {
        type: "object",
        properties: {
          sandboxJobId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.sandboxJobStatus(asObject(args) ?? {}),
    },
    {
      name: "system.sandboxJobResume",
      description:
        "Reattach to a durable sandbox job handle after restart and fetch current output/state.",
      inputSchema: {
        type: "object",
        properties: {
          sandboxJobId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.sandboxJobResume(asObject(args) ?? {}),
    },
    {
      name: "system.sandboxJobStop",
      description:
        "Stop a durable sandbox job handle by stopping its linked host process wrapper.",
      inputSchema: {
        type: "object",
        properties: {
          sandboxJobId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          signal: { type: "string" },
          waitMs: { type: "number" },
        },
      },
      execute: (args) => manager.sandboxJobStop(asObject(args) ?? {}),
    },
    {
      name: "system.sandboxJobLogs",
      description:
        "Read the recent persisted log tail for a durable sandbox job handle.",
      inputSchema: {
        type: "object",
        properties: {
          sandboxJobId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          maxBytes: { type: "number" },
          waitForOutputMs: {
            type: "number",
            description:
              "Optional bounded settle window in milliseconds to wait for fresh output from a short-lived sandbox job before returning logs.",
          },
        },
      },
      execute: (args) => manager.sandboxJobLogs(asObject(args) ?? {}),
    },
  ];
}
