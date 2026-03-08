import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";
import type { Tool, ToolResult } from "../types.js";
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
import type { SystemResearchToolConfig } from "./types.js";

const SYSTEM_RESEARCH_FAMILY = "system_research";
const SYSTEM_RESEARCH_SCHEMA_VERSION = 1;
const SYSTEM_RESEARCH_ROOT = "/tmp/agenc-system-research";
const MAX_RESEARCH_ARTIFACTS = 48;
const MAX_SOURCE_SET = 32;

type SystemResearchState =
  | "running"
  | "blocked"
  | "completed"
  | "failed"
  | "cancelled";
type SystemResearchVerifierState =
  | "pending"
  | "collecting"
  | "verifying"
  | "verified"
  | "blocked";
type SystemResearchArtifactKind = "source" | "note" | "report" | "citation" | "file";

interface SystemResearchArtifact {
  readonly kind: SystemResearchArtifactKind;
  readonly locator: string;
  readonly label?: string;
  readonly observedAt: number;
}

interface SystemResearchRecord {
  readonly version: number;
  readonly researchId: string;
  readonly label?: string;
  readonly idempotencyKey?: string;
  readonly objective: string;
  readonly sourceSet: readonly string[];
  readonly resourceEnvelope?: StructuredHandleResourceEnvelope;
  readonly createdAt: number;
  readonly startedAt: number;
  updatedAt: number;
  state: SystemResearchState;
  verifierState: SystemResearchVerifierState;
  progressSummary?: string;
  lastError?: string;
  blockedReason?: string;
  endedAt?: number;
  artifacts: readonly SystemResearchArtifact[];
}

interface PersistedSystemResearchRegistry {
  readonly version: number;
  readonly researchRuns: readonly SystemResearchRecord[];
}

const TERMINAL_RESEARCH_STATES = new Set<SystemResearchState>([
  "completed",
  "failed",
  "cancelled",
]);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeResearchState(value: unknown): SystemResearchState | undefined {
  if (
    value === "running" ||
    value === "blocked" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return undefined;
}

function normalizeVerifierState(
  value: unknown,
): SystemResearchVerifierState | undefined {
  if (
    value === "pending" ||
    value === "collecting" ||
    value === "verifying" ||
    value === "verified" ||
    value === "blocked"
  ) {
    return value;
  }
  return undefined;
}

function normalizeSourceSet(value: unknown): readonly string[] | ToolResult {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return handleErrorResult(
      SYSTEM_RESEARCH_FAMILY,
      "system_research.invalid_sources",
      "sources must be an array of strings when provided",
      false,
      undefined,
      "start",
      "validation",
    );
  }
  const sources: string[] = [];
  for (const entry of value) {
    const source = asTrimmedString(entry);
    if (!source) {
      return handleErrorResult(
        SYSTEM_RESEARCH_FAMILY,
        "system_research.invalid_sources",
        "sources must contain only non-empty strings",
        false,
        undefined,
        "start",
        "validation",
      );
    }
    if (!sources.includes(source)) {
      sources.push(source);
    }
  }
  return sources.slice(0, MAX_SOURCE_SET);
}

function normalizeArtifacts(
  value: unknown,
  observedAt: number,
  operation: string,
): readonly SystemResearchArtifact[] | ToolResult {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return handleErrorResult(
      SYSTEM_RESEARCH_FAMILY,
      "system_research.invalid_artifacts",
      "artifacts must be an array when provided",
      false,
      undefined,
      operation,
      "validation",
    );
  }
  const artifacts: SystemResearchArtifact[] = [];
  for (const entry of value) {
    const obj = asObject(entry);
    const locator =
      asTrimmedString(obj?.locator) ??
      asTrimmedString(obj?.path) ??
      asTrimmedString(obj?.url);
    if (!locator) {
      return handleErrorResult(
        SYSTEM_RESEARCH_FAMILY,
        "system_research.invalid_artifacts",
        "each artifact must include locator, path, or url",
        false,
        undefined,
        operation,
        "validation",
      );
    }
    const rawKind = asTrimmedString(obj?.kind)?.toLowerCase();
    const kind =
      rawKind === "source" ||
      rawKind === "note" ||
      rawKind === "report" ||
      rawKind === "citation" ||
      rawKind === "file"
        ? (rawKind as SystemResearchArtifactKind)
        : locator.startsWith("http://") || locator.startsWith("https://")
          ? "source"
          : "file";
    artifacts.push({
      kind,
      locator,
      ...(asTrimmedString(obj?.label) ? { label: asTrimmedString(obj?.label) } : {}),
      observedAt,
    });
  }
  return artifacts.slice(-MAX_RESEARCH_ARTIFACTS);
}

function mergeArtifacts(
  existing: readonly SystemResearchArtifact[],
  incoming: readonly SystemResearchArtifact[],
): readonly SystemResearchArtifact[] {
  const merged = [...existing];
  for (const artifact of incoming) {
    if (
      !merged.some(
        (entry) =>
          entry.kind === artifact.kind && entry.locator === artifact.locator,
      )
    ) {
      merged.push(artifact);
    }
  }
  return merged.slice(-MAX_RESEARCH_ARTIFACTS);
}

function buildResearchResponse(
  record: SystemResearchRecord,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    researchId: record.researchId,
    ...(record.label ? { label: record.label } : {}),
    ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
    objective: record.objective,
    state: record.state,
    verifierState: record.verifierState,
    sourceSet: record.sourceSet,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.progressSummary ? { progressSummary: record.progressSummary } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...(record.blockedReason ? { blockedReason: record.blockedReason } : {}),
    ...(record.resourceEnvelope ? { resourceEnvelope: record.resourceEnvelope } : {}),
    artifactCount: record.artifacts.length,
    ...extra,
  };
}

export class SystemResearchManager {
  private readonly rootDir: string;
  private readonly registryPath: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly records = new Map<string, SystemResearchRecord>();
  private loaded = false;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(config?: SystemResearchToolConfig) {
    this.rootDir = config?.rootDir ?? SYSTEM_RESEARCH_ROOT;
    this.registryPath = join(this.rootDir, "registry.json");
    this.logger = config?.logger ?? silentLogger;
    this.now = config?.now ?? (() => Date.now());
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.rootDir, { recursive: true });
    if (existsSync(this.registryPath)) {
      try {
        const raw = await readFile(this.registryPath, "utf8");
        const parsed = JSON.parse(raw) as PersistedSystemResearchRegistry;
        for (const record of parsed.researchRuns ?? []) {
          if (
            record &&
            typeof record.researchId === "string" &&
            typeof record.objective === "string"
          ) {
            this.records.set(record.researchId, cloneJson(record));
          }
        }
      } catch (error) {
        this.logger.warn("Failed to load system research registry", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedSystemResearchRegistry = {
      version: SYSTEM_RESEARCH_SCHEMA_VERSION,
      researchRuns: [...this.records.values()].map((record) => cloneJson(record)),
    };
    this.persistChain = this.persistChain.then(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const tempPath = `${this.registryPath}.tmp`;
      await writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
      await rename(tempPath, this.registryPath);
    });
    await this.persistChain;
  }

  private findByLabel(label: string): SystemResearchRecord | undefined {
    let best: SystemResearchRecord | undefined;
    for (const record of this.records.values()) {
      if (record.label !== label) continue;
      if (!best) {
        best = record;
        continue;
      }
      if (!TERMINAL_RESEARCH_STATES.has(record.state) && TERMINAL_RESEARCH_STATES.has(best.state)) {
        best = record;
        continue;
      }
      if (record.updatedAt > best.updatedAt) {
        best = record;
      }
    }
    return best;
  }

  private findByIdempotencyKey(idempotencyKey: string): SystemResearchRecord | undefined {
    let best: SystemResearchRecord | undefined;
    for (const record of this.records.values()) {
      if (record.idempotencyKey !== idempotencyKey) continue;
      if (!best) {
        best = record;
        continue;
      }
      if (!TERMINAL_RESEARCH_STATES.has(record.state) && TERMINAL_RESEARCH_STATES.has(best.state)) {
        best = record;
        continue;
      }
      if (record.updatedAt > best.updatedAt) {
        best = record;
      }
    }
    return best;
  }

  private async resolveRecord(
    args: Record<string, unknown>,
    operation: string,
  ): Promise<SystemResearchRecord | ToolResult> {
    await this.ensureLoaded();
    const researchId = asTrimmedString(args.researchId);
    const identity = normalizeHandleIdentity(
      SYSTEM_RESEARCH_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const record = researchId
      ? this.records.get(researchId)
      : identity.idempotencyKey
        ? this.findByIdempotencyKey(identity.idempotencyKey)
        : identity.label
          ? this.findByLabel(identity.label)
          : undefined;
    if (!record) {
      return handleErrorResult(
        SYSTEM_RESEARCH_FAMILY,
        "system_research.not_found",
        "Research handle not found. Provide researchId or a previously used label/idempotencyKey.",
        false,
        undefined,
        operation,
        "not_found",
      );
    }
    return record;
  }

  async start(args: Record<string, unknown>): Promise<ToolResult> {
    await this.ensureLoaded();
    const objective = asTrimmedString(args.objective) ?? asTrimmedString(args.topic);
    if (!objective) {
      return handleErrorResult(
        SYSTEM_RESEARCH_FAMILY,
        "system_research.invalid_objective",
        "objective must be a non-empty string",
        false,
        undefined,
        "start",
        "validation",
      );
    }
    const sourceSet = normalizeSourceSet(args.sources);
    if (isToolResult(sourceSet)) return sourceSet;
    const resourceEnvelope = normalizeResourceEnvelope(
      SYSTEM_RESEARCH_FAMILY,
      args.resourceEnvelope,
      "start",
    );
    if (isToolResult(resourceEnvelope)) return resourceEnvelope;
    const identity = normalizeHandleIdentity(
      SYSTEM_RESEARCH_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const initialArtifacts = normalizeArtifacts(args.artifacts, this.now(), "start");
    if (isToolResult(initialArtifacts)) return initialArtifacts;

    const matchesSpec = (record: SystemResearchRecord): boolean =>
      record.objective === objective &&
      JSON.stringify(record.sourceSet) === JSON.stringify(sourceSet) &&
      JSON.stringify(record.resourceEnvelope ?? null) ===
        JSON.stringify(resourceEnvelope ?? null);

    const idempotentMatch = identity.idempotencyKey
      ? this.findByIdempotencyKey(identity.idempotencyKey)
      : undefined;
    if (idempotentMatch) {
      if (matchesSpec(idempotentMatch) && !TERMINAL_RESEARCH_STATES.has(idempotentMatch.state)) {
        return handleOkResult(buildResearchResponse(idempotentMatch, {
          reused: true,
        }));
      }
      return handleErrorResult(
        SYSTEM_RESEARCH_FAMILY,
        "system_research.idempotency_conflict",
        "A research handle already exists for that idempotencyKey.",
        false,
        {
          researchId: idempotentMatch.researchId,
          state: idempotentMatch.state,
        },
        "start",
        "idempotency_conflict",
      );
    }

    const labelMatch = identity.label ? this.findByLabel(identity.label) : undefined;
    if (labelMatch) {
      if (
        labelMatch.idempotencyKey === identity.idempotencyKey &&
        matchesSpec(labelMatch) &&
        !TERMINAL_RESEARCH_STATES.has(labelMatch.state)
      ) {
        return handleOkResult(buildResearchResponse(labelMatch, {
          reused: true,
        }));
      }
      if (!TERMINAL_RESEARCH_STATES.has(labelMatch.state)) {
        return handleErrorResult(
          SYSTEM_RESEARCH_FAMILY,
          "system_research.label_conflict",
          "A research handle already exists for that label.",
          false,
          {
            researchId: labelMatch.researchId,
            state: labelMatch.state,
          },
          "start",
          "label_conflict",
        );
      }
      this.records.set(labelMatch.researchId, {
        ...labelMatch,
        label: undefined,
        updatedAt: this.now(),
      });
    }

    const startedAt = this.now();
    const record: SystemResearchRecord = {
      version: SYSTEM_RESEARCH_SCHEMA_VERSION,
      researchId: `research_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      ...(identity.label ? { label: identity.label } : {}),
      ...(identity.idempotencyKey ? { idempotencyKey: identity.idempotencyKey } : {}),
      objective,
      sourceSet,
      ...(resourceEnvelope ? { resourceEnvelope } : {}),
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt,
      state: "running",
      verifierState: sourceSet.length > 0 ? "collecting" : "pending",
      progressSummary:
        sourceSet.length > 0
          ? "Research handle started with an initial source set."
          : "Research handle started.",
      artifacts: initialArtifacts,
    };
    this.records.set(record.researchId, record);
    await this.persist();
    return handleOkResult(buildResearchResponse(record, {
      started: true,
    }));
  }

  async status(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "status");
    if (isToolResult(record)) return record;
    return handleOkResult(buildResearchResponse(record));
  }

  async resume(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "resume");
    if (isToolResult(record)) return record;
    return handleOkResult(buildResearchResponse(record, {
      resumed: !TERMINAL_RESEARCH_STATES.has(record.state),
    }));
  }

  async update(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "update");
    if (isToolResult(record)) return record;
    if (TERMINAL_RESEARCH_STATES.has(record.state)) {
      return handleErrorResult(
        SYSTEM_RESEARCH_FAMILY,
        "system_research.blocked",
        "Cannot update a completed, failed, or cancelled research handle.",
        false,
        {
          researchId: record.researchId,
          state: record.state,
        },
        "update",
        "blocked",
      );
    }
    const now = this.now();
    const addedArtifacts = normalizeArtifacts(args.artifacts, now, "update");
    if (isToolResult(addedArtifacts)) return addedArtifacts;
    const nextState = normalizeResearchState(args.state) ?? record.state;
    const nextVerifierState =
      normalizeVerifierState(args.verifierState) ?? record.verifierState;
    const appendedSources = normalizeSourceSet(args.sources);
    if (isToolResult(appendedSources)) return appendedSources;
    const sourceSet = [...record.sourceSet];
    for (const source of appendedSources) {
      if (!sourceSet.includes(source)) {
        sourceSet.push(source);
      }
    }
    const nextRecord: SystemResearchRecord = {
      ...record,
      updatedAt: now,
      state: nextState,
      verifierState: nextVerifierState,
      sourceSet: sourceSet.slice(0, MAX_SOURCE_SET),
      progressSummary:
        asTrimmedString(args.progressSummary) ??
        asTrimmedString(args.summary) ??
        record.progressSummary,
      lastError: asTrimmedString(args.error) ?? record.lastError,
      blockedReason: asTrimmedString(args.blockedReason) ?? record.blockedReason,
      artifacts: mergeArtifacts(record.artifacts, addedArtifacts),
      ...(TERMINAL_RESEARCH_STATES.has(nextState) ? { endedAt: now } : {}),
    };
    this.records.set(record.researchId, nextRecord);
    await this.persist();
    return handleOkResult(buildResearchResponse(nextRecord, {
      updated: true,
    }));
  }

  async complete(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "complete");
    if (isToolResult(record)) return record;
    const now = this.now();
    const artifacts = normalizeArtifacts(args.artifacts, now, "complete");
    if (isToolResult(artifacts)) return artifacts;
    const nextRecord: SystemResearchRecord = {
      ...record,
      state: "completed",
      verifierState: "verified",
      updatedAt: now,
      endedAt: now,
      blockedReason: undefined,
      progressSummary:
        asTrimmedString(args.progressSummary) ??
        asTrimmedString(args.summary) ??
        record.progressSummary ??
        "Research completed.",
      artifacts: mergeArtifacts(record.artifacts, artifacts),
    };
    this.records.set(record.researchId, nextRecord);
    await this.persist();
    return handleOkResult(buildResearchResponse(nextRecord, {
      completed: true,
    }));
  }

  async block(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "block");
    if (isToolResult(record)) return record;
    const blockedReason =
      asTrimmedString(args.blockedReason) ??
      asTrimmedString(args.reason);
    if (!blockedReason) {
      return handleErrorResult(
        SYSTEM_RESEARCH_FAMILY,
        "system_research.invalid_block_reason",
        "blockedReason must be a non-empty string",
        false,
        undefined,
        "block",
        "validation",
      );
    }
    const now = this.now();
    const nextRecord: SystemResearchRecord = {
      ...record,
      state: "blocked",
      verifierState: "blocked",
      updatedAt: now,
      progressSummary:
        asTrimmedString(args.progressSummary) ?? record.progressSummary,
      blockedReason,
    };
    this.records.set(record.researchId, nextRecord);
    await this.persist();
    return handleOkResult(buildResearchResponse(nextRecord, {
      blocked: true,
    }));
  }

  async artifacts(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "artifacts");
    if (isToolResult(record)) return record;
    return handleOkResult({
      researchId: record.researchId,
      ...(record.label ? { label: record.label } : {}),
      ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
      state: record.state,
      artifacts: record.artifacts,
    });
  }

  async stop(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "stop");
    if (isToolResult(record)) return record;
    if (TERMINAL_RESEARCH_STATES.has(record.state)) {
      return handleOkResult(buildResearchResponse(record, {
        stopped: false,
      }));
    }
    const now = this.now();
    const nextRecord: SystemResearchRecord = {
      ...record,
      state: "cancelled",
      updatedAt: now,
      endedAt: now,
      progressSummary:
        asTrimmedString(args.progressSummary) ??
        record.progressSummary ??
        "Research cancelled.",
    };
    this.records.set(record.researchId, nextRecord);
    await this.persist();
    return handleOkResult(buildResearchResponse(nextRecord, {
      stopped: true,
    }));
  }

  async resetForTesting(): Promise<void> {
    this.records.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    await rm(this.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  resetForTestingSync(): void {
    this.records.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    rmSync(this.rootDir, { recursive: true, force: true });
  }
}

export function createResearchTools(
  config?: SystemResearchToolConfig,
  manager = new SystemResearchManager(config),
): Tool[] {
  return [
    {
      name: "system.researchStart",
      description:
        "Create a durable research handle with explicit source-set, verifier state, artifact references, and resumable identity.",
      inputSchema: {
        type: "object",
        properties: {
          objective: { type: "string" },
          sources: {
            type: "array",
            items: { type: "string" },
          },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          artifacts: {
            type: "array",
            items: { type: "object" },
          },
          resourceEnvelope: {
            type: "object",
            description:
              "Optional resource budget contract: cpu, memoryMb, diskMb, network, wallClockMs, sandboxAffinity, environmentClass, enforcement.",
          },
        },
        required: ["objective"],
      },
      execute: (args) => manager.start(asObject(args) ?? {}),
    },
    {
      name: "system.researchStatus",
      description:
        "Inspect a durable research handle and return state, verifier state, source set, and artifact count.",
      inputSchema: {
        type: "object",
        properties: {
          researchId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.status(asObject(args) ?? {}),
    },
    {
      name: "system.researchResume",
      description:
        "Reattach to a durable research handle after restart and return the latest progress state.",
      inputSchema: {
        type: "object",
        properties: {
          researchId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.resume(asObject(args) ?? {}),
    },
    {
      name: "system.researchUpdate",
      description:
        "Advance a durable research handle with progress summary, sources, verifier state, and artifact references.",
      inputSchema: {
        type: "object",
        properties: {
          researchId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          state: {
            type: "string",
            enum: ["running", "blocked", "completed", "failed", "cancelled"],
          },
          verifierState: {
            type: "string",
            enum: ["pending", "collecting", "verifying", "verified", "blocked"],
          },
          progressSummary: { type: "string" },
          blockedReason: { type: "string" },
          error: { type: "string" },
          sources: {
            type: "array",
            items: { type: "string" },
          },
          artifacts: {
            type: "array",
            items: { type: "object" },
          },
        },
      },
      execute: (args) => manager.update(asObject(args) ?? {}),
    },
    {
      name: "system.researchComplete",
      description:
        "Mark a durable research handle complete and persist its final report/note artifacts.",
      inputSchema: {
        type: "object",
        properties: {
          researchId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          progressSummary: { type: "string" },
          artifacts: {
            type: "array",
            items: { type: "object" },
          },
        },
      },
      execute: (args) => manager.complete(asObject(args) ?? {}),
    },
    {
      name: "system.researchBlock",
      description:
        "Mark a durable research handle blocked with an explicit operator-visible reason.",
      inputSchema: {
        type: "object",
        properties: {
          researchId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          blockedReason: { type: "string" },
          progressSummary: { type: "string" },
        },
      },
      execute: (args) => manager.block(asObject(args) ?? {}),
    },
    {
      name: "system.researchArtifacts",
      description:
        "List durable artifacts for a research handle, including notes, reports, source refs, and files.",
      inputSchema: {
        type: "object",
        properties: {
          researchId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.artifacts(asObject(args) ?? {}),
    },
    {
      name: "system.researchStop",
      description:
        "Cancel a running or blocked research handle without deleting its durable artifacts.",
      inputSchema: {
        type: "object",
        properties: {
          researchId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          progressSummary: { type: "string" },
        },
      },
      execute: (args) => manager.stop(asObject(args) ?? {}),
    },
  ];
}
