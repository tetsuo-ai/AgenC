import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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
import { formatDomainBlockReason, isDomainAllowed } from "./http.js";
import type { SystemRemoteJobToolConfig } from "./types.js";

const SYSTEM_REMOTE_JOB_FAMILY = "system_remote_job";
const SYSTEM_REMOTE_JOB_SCHEMA_VERSION = 1;
const SYSTEM_REMOTE_JOB_ROOT = "/tmp/agenc-system-remote-jobs";
const DEFAULT_POLL_TIMEOUT_MS = 5_000;
const MAX_RECENT_CALLBACK_IDS = 64;
const MAX_REMOTE_JOB_ARTIFACTS = 32;
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "[::1]",
  "localhost",
]);

type SystemRemoteJobMode = "callback" | "poll";
type SystemRemoteJobState =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";
type SystemRemoteJobRestartPolicy = "manual" | "resume";

interface SystemRemoteJobArtifact {
  readonly kind: "file" | "url" | "report" | "payload";
  readonly locator: string;
  readonly label?: string;
  readonly source: "callback" | "poll" | "manual";
  readonly observedAt: number;
}

interface SystemRemoteJobRecord {
  readonly version: number;
  readonly jobHandleId: string;
  readonly label?: string;
  readonly idempotencyKey?: string;
  readonly serverName: string;
  readonly remoteJobId: string;
  readonly mode: SystemRemoteJobMode;
  readonly retryable: boolean;
  readonly restartPolicy: SystemRemoteJobRestartPolicy;
  readonly callbackPath?: string;
  readonly callbackTokenHash?: string;
  readonly callbackTokenIssuedAt?: number;
  readonly statusUrl?: string;
  readonly cancelUrl?: string;
  readonly cancelMethod?: "POST" | "DELETE";
  readonly resourceEnvelope?: StructuredHandleResourceEnvelope;
  readonly createdAt: number;
  readonly startedAt: number;
  updatedAt: number;
  state: SystemRemoteJobState;
  lastEventAt?: number;
  endedAt?: number;
  progressSummary?: string;
  lastError?: string;
  lastStatusCode?: number;
  artifacts: SystemRemoteJobArtifact[];
  recentCallbackIds: readonly string[];
}

interface PersistedSystemRemoteJobRegistry {
  readonly version: number;
  readonly jobs: readonly SystemRemoteJobRecord[];
}

interface PollResult {
  readonly state?: SystemRemoteJobState;
  readonly progressSummary?: string;
  readonly error?: string;
  readonly statusCode?: number;
  readonly retryable?: boolean;
  readonly remoteJobId?: string;
  readonly serverName?: string;
  readonly artifacts: readonly SystemRemoteJobArtifact[];
}

const TERMINAL_REMOTE_JOB_STATES = new Set<SystemRemoteJobState>([
  "completed",
  "failed",
  "cancelled",
]);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeState(value: unknown): SystemRemoteJobState | undefined {
  if (
    value === "pending" ||
    value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  const normalized = asTrimmedString(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "queued" || normalized === "accepted") return "pending";
  if (normalized === "in_progress" || normalized === "processing") return "running";
  if (normalized === "complete" || normalized === "done" || normalized === "succeeded") {
    return "completed";
  }
  if (normalized === "error") return "failed";
  if (normalized === "canceled") return "cancelled";
  return undefined;
}

function normalizeMode(value: unknown): SystemRemoteJobMode | undefined {
  return value === "callback" || value === "poll" ? value : undefined;
}

function normalizeRestartPolicy(
  value: unknown,
): SystemRemoteJobRestartPolicy | undefined {
  return value === "manual" || value === "resume" ? value : undefined;
}

function parseArtifactArray(
  value: unknown,
  source: SystemRemoteJobArtifact["source"],
  observedAt: number,
): readonly SystemRemoteJobArtifact[] | ToolResult {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return handleErrorResult(
      SYSTEM_REMOTE_JOB_FAMILY,
      "system_remote_job.invalid_artifacts",
      "artifacts must be an array when provided",
      false,
      undefined,
      "start",
      "validation",
    );
  }
  const artifacts: SystemRemoteJobArtifact[] = [];
  for (const entry of value) {
    const obj = asObject(entry);
    const locator =
      asTrimmedString(obj?.locator) ??
      asTrimmedString(obj?.path) ??
      asTrimmedString(obj?.url);
    if (!locator) {
      return handleErrorResult(
        SYSTEM_REMOTE_JOB_FAMILY,
        "system_remote_job.invalid_artifacts",
        "each artifact must include locator, path, or url",
        false,
        undefined,
        "start",
        "validation",
      );
    }
    const kindValue = asTrimmedString(obj?.kind)?.toLowerCase();
    const kind =
      kindValue === "file" ||
      kindValue === "url" ||
      kindValue === "report" ||
      kindValue === "payload"
        ? (kindValue as SystemRemoteJobArtifact["kind"])
        : locator.startsWith("http://") || locator.startsWith("https://")
          ? "url"
          : "file";
    artifacts.push({
      kind,
      locator,
      ...(asTrimmedString(obj?.label) ? { label: asTrimmedString(obj?.label) } : {}),
      source,
      observedAt,
    });
  }
  return artifacts.slice(-MAX_REMOTE_JOB_ARTIFACTS);
}

function buildRemoteJobResponse(
  record: SystemRemoteJobRecord,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    jobHandleId: record.jobHandleId,
    ...(record.label ? { label: record.label } : {}),
    ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
    serverName: record.serverName,
    remoteJobId: record.remoteJobId,
    mode: record.mode,
    state: record.state,
    retryable: record.retryable,
    restartPolicy: record.restartPolicy,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.lastEventAt !== undefined ? { lastEventAt: record.lastEventAt } : {}),
    ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
    ...(record.progressSummary ? { progressSummary: record.progressSummary } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...(record.lastStatusCode !== undefined
      ? { lastStatusCode: record.lastStatusCode }
      : {}),
    ...(record.resourceEnvelope ? { resourceEnvelope: record.resourceEnvelope } : {}),
    artifactCount: record.artifacts.length,
    ...(record.statusUrl ? { statusUrl: record.statusUrl } : {}),
    ...(record.cancelUrl ? { cancelUrl: record.cancelUrl } : {}),
    ...(record.cancelMethod ? { cancelMethod: record.cancelMethod } : {}),
    ...(record.callbackPath
      ? {
        callback: {
          path: record.callbackPath,
        },
      }
      : {}),
    ...extra,
  };
}

function mergeArtifacts(
  existing: readonly SystemRemoteJobArtifact[],
  incoming: readonly SystemRemoteJobArtifact[],
): SystemRemoteJobArtifact[] {
  const merged = [...existing];
  for (const artifact of incoming) {
    const duplicate = merged.find(
      (entry) => entry.kind === artifact.kind && entry.locator === artifact.locator,
    );
    if (!duplicate) {
      merged.push(artifact);
    }
  }
  return merged.slice(-MAX_REMOTE_JOB_ARTIFACTS);
}

function constantTimeTokenMatches(
  expectedHash: string,
  providedToken: string | undefined,
): boolean {
  if (!providedToken) {
    return false;
  }
  const expected = Buffer.from(expectedHash, "hex");
  const actual = Buffer.from(hashToken(providedToken), "hex");
  if (expected.length !== actual.length) {
    return false;
  }
  return timingSafeEqual(expected, actual);
}

async function parsePollResponse(
  response: Response,
): Promise<PollResult> {
  const text = await response.text();
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : undefined;
  } catch {
    parsed = undefined;
  }

  const observedAt = Date.now();
  const artifacts = parseArtifactArray(parsed?.artifacts, "poll", observedAt);
  const normalizedArtifacts = isToolResult(artifacts) ? [] : artifacts;
  const state =
    normalizeState(parsed?.state) ??
    (response.ok ? "running" : "failed");
  return {
    state,
    progressSummary:
      asTrimmedString(parsed?.summary) ??
      asTrimmedString(parsed?.message) ??
      (text.length > 0 && !parsed ? text.slice(0, 240) : undefined),
    error:
      !response.ok
        ? asTrimmedString(parsed?.error) ?? `Polling failed with HTTP ${response.status}`
        : asTrimmedString(parsed?.error),
    statusCode: response.status,
    retryable:
      typeof parsed?.retryable === "boolean"
        ? parsed.retryable
        : response.status >= 500,
    remoteJobId: asTrimmedString(parsed?.jobId) ?? asTrimmedString(parsed?.remoteJobId),
    serverName: asTrimmedString(parsed?.serverName),
    artifacts: normalizedArtifacts,
  };
}

export interface SystemRemoteJobWebhookInput {
  readonly jobHandleId: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export class SystemRemoteJobManager {
  private readonly rootDir: string;
  private readonly registryPath: string;
  private readonly callbackBaseUrl?: string;
  private readonly defaultPollTimeoutMs: number;
  private readonly allowedDomains?: readonly string[];
  private readonly blockedDomains?: readonly string[];
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly records = new Map<string, SystemRemoteJobRecord>();
  private loaded = false;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(config?: SystemRemoteJobToolConfig) {
    this.rootDir = config?.rootDir ?? SYSTEM_REMOTE_JOB_ROOT;
    this.registryPath = join(this.rootDir, "registry.json");
    this.callbackBaseUrl = asTrimmedString(config?.callbackBaseUrl);
    this.defaultPollTimeoutMs =
      config?.defaultPollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.allowedDomains = config?.allowedDomains;
    this.blockedDomains = config?.blockedDomains;
    this.logger = config?.logger ?? silentLogger;
    this.now = config?.now ?? (() => Date.now());
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await mkdir(this.rootDir, { recursive: true });
    if (existsSync(this.registryPath)) {
      try {
        const raw = await readFile(this.registryPath, "utf8");
        const parsed = JSON.parse(raw) as PersistedSystemRemoteJobRegistry;
        for (const record of parsed.jobs ?? []) {
          if (
            record &&
            typeof record.jobHandleId === "string" &&
            typeof record.serverName === "string" &&
            typeof record.remoteJobId === "string"
          ) {
            this.records.set(record.jobHandleId, cloneJson(record));
          }
        }
      } catch (error) {
        this.logger.warn("Failed to load system remote job registry", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedSystemRemoteJobRegistry = {
      version: SYSTEM_REMOTE_JOB_SCHEMA_VERSION,
      jobs: [...this.records.values()].map((record) => cloneJson(record)),
    };
    this.persistChain = this.persistChain.then(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const tempPath = `${this.registryPath}.tmp`;
      await writeFile(tempPath, JSON.stringify(snapshot, null, 2), "utf8");
      await rename(tempPath, this.registryPath);
    });
    await this.persistChain;
  }

  private findByLabel(label: string): SystemRemoteJobRecord | undefined {
    let best: SystemRemoteJobRecord | undefined;
    for (const record of this.records.values()) {
      if (record.label !== label) continue;
      if (!best) {
        best = record;
        continue;
      }
      if (!TERMINAL_REMOTE_JOB_STATES.has(record.state) && TERMINAL_REMOTE_JOB_STATES.has(best.state)) {
        best = record;
        continue;
      }
      if (record.updatedAt > best.updatedAt) {
        best = record;
      }
    }
    return best;
  }

  private findByIdempotencyKey(idempotencyKey: string): SystemRemoteJobRecord | undefined {
    let best: SystemRemoteJobRecord | undefined;
    for (const record of this.records.values()) {
      if (record.idempotencyKey !== idempotencyKey) continue;
      if (!best) {
        best = record;
        continue;
      }
      if (!TERMINAL_REMOTE_JOB_STATES.has(record.state) && TERMINAL_REMOTE_JOB_STATES.has(best.state)) {
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
  ): Promise<SystemRemoteJobRecord | ToolResult> {
    await this.ensureLoaded();
    const handleId = asTrimmedString(args.jobHandleId);
    const identity = normalizeHandleIdentity(
      SYSTEM_REMOTE_JOB_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const record = handleId
      ? this.records.get(handleId)
      : identity.idempotencyKey
        ? this.findByIdempotencyKey(identity.idempotencyKey)
        : identity.label
          ? this.findByLabel(identity.label)
          : undefined;
    if (!record) {
      return handleErrorResult(
        SYSTEM_REMOTE_JOB_FAMILY,
        "system_remote_job.not_found",
        "Remote job handle not found. Provide jobHandleId or a previously used label/idempotencyKey.",
        false,
        undefined,
        operation,
        "not_found",
      );
    }
    return record;
  }

  private validateRemoteUrl(
    urlValue: string,
    operation: string,
  ): ToolResult | null {
    let parsed: URL;
    try {
      parsed = new URL(urlValue);
    } catch {
      return handleErrorResult(
        SYSTEM_REMOTE_JOB_FAMILY,
        "system_remote_job.invalid_url",
        "Remote job URLs must be valid absolute HTTP(S) URLs",
        false,
        undefined,
        operation,
        "validation",
      );
    }
    const protocol = parsed.protocol.replace(":", "");
    if (protocol !== "http" && protocol !== "https") {
      return handleErrorResult(
        SYSTEM_REMOTE_JOB_FAMILY,
        "system_remote_job.invalid_url",
        "Remote job URLs must use http or https",
        false,
        undefined,
        operation,
        "validation",
      );
    }
    if (LOOPBACK_HOSTS.has(parsed.hostname)) {
      return null;
    }
    const decision = isDomainAllowed(
      urlValue,
      this.allowedDomains,
      this.blockedDomains,
    );
    if (decision.allowed) {
      return null;
    }
    return handleErrorResult(
      SYSTEM_REMOTE_JOB_FAMILY,
      "system_remote_job.url_blocked",
      formatDomainBlockReason(decision.reason ?? "Blocked remote job URL"),
      false,
      undefined,
      operation,
      "permission_denied",
    );
  }

  private async pollRecord(
    record: SystemRemoteJobRecord,
  ): Promise<SystemRemoteJobRecord | ToolResult> {
    if (record.mode !== "poll" || !record.statusUrl || TERMINAL_REMOTE_JOB_STATES.has(record.state)) {
      return record;
    }
    const urlValidation = this.validateRemoteUrl(record.statusUrl, "status");
    if (urlValidation) {
      return urlValidation;
    }
    try {
      const response = await fetch(record.statusUrl, {
        method: "GET",
        signal: AbortSignal.timeout(this.defaultPollTimeoutMs),
      });
      const pollResult = await parsePollResponse(response);
      const now = this.now();
      const nextRecord: SystemRemoteJobRecord = {
        ...record,
        state: pollResult.state ?? record.state,
        updatedAt: now,
        lastEventAt: now,
        ...(pollResult.progressSummary ? { progressSummary: pollResult.progressSummary } : {}),
        ...(pollResult.error ? { lastError: pollResult.error } : {}),
        ...(pollResult.statusCode !== undefined
          ? { lastStatusCode: pollResult.statusCode }
          : {}),
        ...(pollResult.remoteJobId ? { remoteJobId: pollResult.remoteJobId } : {}),
        ...(pollResult.serverName ? { serverName: pollResult.serverName } : {}),
        retryable:
          typeof pollResult.retryable === "boolean"
            ? pollResult.retryable
            : record.retryable,
        artifacts: mergeArtifacts(record.artifacts, pollResult.artifacts),
        ...(pollResult.state && TERMINAL_REMOTE_JOB_STATES.has(pollResult.state)
          ? { endedAt: now }
          : {}),
      };
      this.records.set(record.jobHandleId, nextRecord);
      await this.persist();
      return nextRecord;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const nextRecord: SystemRemoteJobRecord = {
        ...record,
        updatedAt: this.now(),
        lastError: `Polling failed: ${message}`,
      };
      this.records.set(record.jobHandleId, nextRecord);
      await this.persist();
      return nextRecord;
    }
  }

  async start(args: Record<string, unknown>): Promise<ToolResult> {
    await this.ensureLoaded();
    const serverName = asTrimmedString(args.serverName);
    const remoteJobId =
      asTrimmedString(args.remoteJobId) ?? asTrimmedString(args.jobId);
    if (!serverName) {
      return handleErrorResult(
        SYSTEM_REMOTE_JOB_FAMILY,
        "system_remote_job.invalid_server_name",
        "serverName must be a non-empty string",
        false,
        undefined,
        "start",
        "validation",
      );
    }
    if (!remoteJobId) {
      return handleErrorResult(
        SYSTEM_REMOTE_JOB_FAMILY,
        "system_remote_job.invalid_remote_job_id",
        "remoteJobId must be a non-empty string",
        false,
        undefined,
        "start",
        "validation",
      );
    }
    const mode = normalizeMode(args.mode) ?? (args.statusUrl ? "poll" : "callback");
    const restartPolicy = normalizeRestartPolicy(args.restartPolicy) ?? "resume";
    const retryable = typeof args.retryable === "boolean" ? args.retryable : true;
    const identity = normalizeHandleIdentity(
      SYSTEM_REMOTE_JOB_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const resourceEnvelope = normalizeResourceEnvelope(
      SYSTEM_REMOTE_JOB_FAMILY,
      args.resourceEnvelope,
      "start",
    );
    if (isToolResult(resourceEnvelope)) {
      return resourceEnvelope;
    }
    const statusUrl = asTrimmedString(args.statusUrl);
    if (statusUrl) {
      const validation = this.validateRemoteUrl(statusUrl, "start");
      if (validation) return validation;
    }
    const cancelUrl = asTrimmedString(args.cancelUrl);
    if (cancelUrl) {
      const validation = this.validateRemoteUrl(cancelUrl, "start");
      if (validation) return validation;
    }
    const cancelMethod =
      args.cancelMethod === "DELETE" || args.cancelMethod === "POST"
        ? args.cancelMethod
        : undefined;
    const initialArtifacts = parseArtifactArray(args.artifacts, "manual", this.now());
    if (isToolResult(initialArtifacts)) {
      return initialArtifacts;
    }

    const matchesSpec = (record: SystemRemoteJobRecord): boolean =>
      record.serverName === serverName &&
      record.remoteJobId === remoteJobId &&
      record.mode === mode &&
      record.statusUrl === statusUrl &&
      record.cancelUrl === cancelUrl &&
      record.restartPolicy === restartPolicy &&
      JSON.stringify(record.resourceEnvelope ?? null) ===
        JSON.stringify(resourceEnvelope ?? null);

    const idempotentMatch = identity.idempotencyKey
      ? this.findByIdempotencyKey(identity.idempotencyKey)
      : undefined;
    if (idempotentMatch) {
      if (matchesSpec(idempotentMatch) && !TERMINAL_REMOTE_JOB_STATES.has(idempotentMatch.state)) {
        return handleOkResult(buildRemoteJobResponse(idempotentMatch, {
          reused: true,
        }));
      }
      return handleErrorResult(
        SYSTEM_REMOTE_JOB_FAMILY,
        "system_remote_job.idempotency_conflict",
        "A remote job handle already exists for that idempotencyKey.",
        false,
        {
          jobHandleId: idempotentMatch.jobHandleId,
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
        !TERMINAL_REMOTE_JOB_STATES.has(labelMatch.state)
      ) {
        return handleOkResult(buildRemoteJobResponse(labelMatch, {
          reused: true,
        }));
      }
      if (!TERMINAL_REMOTE_JOB_STATES.has(labelMatch.state)) {
        return handleErrorResult(
          SYSTEM_REMOTE_JOB_FAMILY,
          "system_remote_job.label_conflict",
          "A remote job handle already exists for that label.",
          false,
          {
            jobHandleId: labelMatch.jobHandleId,
            state: labelMatch.state,
          },
          "start",
          "label_conflict",
        );
      }
      this.records.set(labelMatch.jobHandleId, {
        ...labelMatch,
        label: undefined,
        updatedAt: this.now(),
      });
    }

    const startedAt = this.now();
    const jobHandleId = `rjob_${randomUUID().replace(/-/g, "").slice(0, 10)}`;
    const callbackToken = mode === "callback"
      ? randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "")
      : undefined;
    const callbackPath =
      mode === "callback"
        ? `/webhooks/remote-job/${jobHandleId}`
        : undefined;

    const record: SystemRemoteJobRecord = {
      version: SYSTEM_REMOTE_JOB_SCHEMA_VERSION,
      jobHandleId,
      ...(identity.label ? { label: identity.label } : {}),
      ...(identity.idempotencyKey ? { idempotencyKey: identity.idempotencyKey } : {}),
      serverName,
      remoteJobId,
      mode,
      retryable,
      restartPolicy,
      ...(callbackPath ? { callbackPath } : {}),
      ...(callbackToken
        ? {
          callbackTokenHash: hashToken(callbackToken),
          callbackTokenIssuedAt: startedAt,
        }
        : {}),
      ...(statusUrl ? { statusUrl } : {}),
      ...(cancelUrl ? { cancelUrl } : {}),
      ...(cancelMethod ? { cancelMethod } : {}),
      ...(resourceEnvelope ? { resourceEnvelope } : {}),
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt,
      state: "running",
      artifacts: [...initialArtifacts],
      recentCallbackIds: [],
    };
    this.records.set(jobHandleId, record);
    await this.persist();
    return handleOkResult(
      buildRemoteJobResponse(record, {
        started: true,
        ...(callbackPath
          ? {
            callback: {
              path: callbackPath,
              ...(this.callbackBaseUrl
                ? { url: `${this.callbackBaseUrl}${callbackPath}` }
                : {}),
              ...(callbackToken
                ? {
                  authToken: callbackToken,
                  authHeader: "Authorization: Bearer <token>",
                }
                : {}),
            },
          }
          : {}),
      }),
    );
  }

  async status(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "status");
    if (isToolResult(record)) return record;
    const refreshed = await this.pollRecord(record);
    if (isToolResult(refreshed)) return refreshed;
    return handleOkResult(buildRemoteJobResponse(refreshed));
  }

  async resume(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "resume");
    if (isToolResult(record)) return record;
    const refreshed = await this.pollRecord(record);
    if (isToolResult(refreshed)) return refreshed;
    return handleOkResult(buildRemoteJobResponse(refreshed, {
      resumed: !TERMINAL_REMOTE_JOB_STATES.has(refreshed.state),
    }));
  }

  async artifacts(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "artifacts");
    if (isToolResult(record)) return record;
    return handleOkResult({
      jobHandleId: record.jobHandleId,
      ...(record.label ? { label: record.label } : {}),
      ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
      state: record.state,
      artifacts: record.artifacts,
    });
  }

  async cancel(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args, "cancel");
    if (isToolResult(record)) return record;
    if (TERMINAL_REMOTE_JOB_STATES.has(record.state)) {
      return handleOkResult(buildRemoteJobResponse(record, {
        cancelled: record.state === "cancelled",
        remoteCancelIssued: false,
      }));
    }

    let remoteCancelIssued = false;
    if (record.cancelUrl) {
      const validation = this.validateRemoteUrl(record.cancelUrl, "cancel");
      if (validation) return validation;
      try {
        const response = await fetch(record.cancelUrl, {
          method: record.cancelMethod ?? "POST",
          signal: AbortSignal.timeout(this.defaultPollTimeoutMs),
        });
        if (!response.ok) {
          return handleErrorResult(
            SYSTEM_REMOTE_JOB_FAMILY,
            "system_remote_job.stop_failed",
            `Remote cancel failed with HTTP ${response.status}`,
            true,
            {
              jobHandleId: record.jobHandleId,
              status: response.status,
            },
            "cancel",
            "stop_failed",
          );
        }
        remoteCancelIssued = true;
      } catch (error) {
        return handleErrorResult(
          SYSTEM_REMOTE_JOB_FAMILY,
          "system_remote_job.stop_failed",
          `Remote cancel failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
          {
            jobHandleId: record.jobHandleId,
          },
          "cancel",
          "stop_failed",
        );
      }
    }

    const now = this.now();
    const nextRecord: SystemRemoteJobRecord = {
      ...record,
      state: "cancelled",
      updatedAt: now,
      endedAt: now,
      ...(remoteCancelIssued
        ? { progressSummary: "Remote job cancellation requested." }
        : { progressSummary: "Remote job supervision cancelled locally." }),
    };
    this.records.set(record.jobHandleId, nextRecord);
    await this.persist();
    return handleOkResult(buildRemoteJobResponse(nextRecord, {
      cancelled: true,
      remoteCancelIssued,
    }));
  }

  async handleWebhook(input: SystemRemoteJobWebhookInput): Promise<{
    readonly status: number;
    readonly body: Record<string, unknown>;
  }> {
    await this.ensureLoaded();
    const record = this.records.get(input.jobHandleId);
    if (!record) {
      return {
        status: 404,
        body: {
          error: {
            family: SYSTEM_REMOTE_JOB_FAMILY,
            code: "system_remote_job.not_found",
            kind: "not_found",
            message: "Remote job handle not found.",
            retryable: false,
            operation: "webhook",
          },
        },
      };
    }
    if (!record.callbackTokenHash) {
      return {
        status: 409,
        body: {
          error: {
            family: SYSTEM_REMOTE_JOB_FAMILY,
            code: "system_remote_job.webhook_not_enabled",
            kind: "blocked",
            message: "This remote job handle is not configured for callbacks.",
            retryable: false,
            operation: "webhook",
          },
        },
      };
    }
    const authHeader = asTrimmedString(input.headers.authorization);
    const token =
      authHeader?.toLowerCase().startsWith("bearer ")
        ? authHeader.slice("bearer ".length).trim()
        : asTrimmedString(input.headers["x-agenc-webhook-token"]);
    if (!constantTimeTokenMatches(record.callbackTokenHash, token)) {
      return {
        status: 401,
        body: {
          error: {
            family: SYSTEM_REMOTE_JOB_FAMILY,
            code: "system_remote_job.permission_denied",
            kind: "permission_denied",
            message: "Invalid remote job webhook token.",
            retryable: false,
            operation: "webhook",
          },
        },
      };
    }

    const body = asObject(input.body);
    if (!body) {
      return {
        status: 400,
        body: {
          error: {
            family: SYSTEM_REMOTE_JOB_FAMILY,
            code: "system_remote_job.invalid_callback",
            kind: "validation",
            message: "Webhook body must be a JSON object.",
            retryable: false,
            operation: "webhook",
          },
        },
      };
    }

    const eventId =
      asTrimmedString(body.eventId) ??
      asTrimmedString(body.callbackId) ??
      asTrimmedString(input.headers["x-agenc-event-id"]);
    if (eventId && record.recentCallbackIds.includes(eventId)) {
      return {
        status: 202,
        body: {
          accepted: true,
          duplicate: true,
          jobHandleId: record.jobHandleId,
        },
      };
    }

    const observedAt = this.now();
    const state = normalizeState(body.state) ?? record.state;
    const artifacts = parseArtifactArray(body.artifacts, "callback", observedAt);
    if (isToolResult(artifacts)) {
      return {
        status: 400,
        body: JSON.parse(artifacts.content) as Record<string, unknown>,
      };
    }
    const inlineArtifactPath =
      asTrimmedString(body.artifactPath) ??
      asTrimmedString(body.path) ??
      asTrimmedString(body.url);
    const inlineArtifacts = inlineArtifactPath
      ? [{
        kind:
          inlineArtifactPath.startsWith("http://") ||
            inlineArtifactPath.startsWith("https://")
            ? ("url" as const)
            : ("file" as const),
        locator: inlineArtifactPath,
        source: "callback" as const,
        observedAt,
      }]
      : [];
    const recentCallbackIds = eventId
      ? [...record.recentCallbackIds, eventId].slice(-MAX_RECENT_CALLBACK_IDS)
      : record.recentCallbackIds;

    const nextRecord: SystemRemoteJobRecord = {
      ...record,
      state,
      updatedAt: observedAt,
      lastEventAt: observedAt,
      lastStatusCode:
        typeof body.status === "number"
          ? body.status
          : typeof body.statusCode === "number"
            ? body.statusCode
            : record.lastStatusCode,
      ...(asTrimmedString(body.summary) || asTrimmedString(body.message)
        ? {
          progressSummary:
            asTrimmedString(body.summary) ?? asTrimmedString(body.message),
        }
        : {}),
      ...(asTrimmedString(body.error) ? { lastError: asTrimmedString(body.error) } : {}),
      retryable:
        typeof body.retryable === "boolean" ? body.retryable : record.retryable,
      artifacts: mergeArtifacts(record.artifacts, [...artifacts, ...inlineArtifacts]),
      recentCallbackIds,
      ...(TERMINAL_REMOTE_JOB_STATES.has(state) ? { endedAt: observedAt } : {}),
    };
    this.records.set(record.jobHandleId, nextRecord);
    await this.persist();
    return {
      status: 202,
      body: {
        accepted: true,
        jobHandleId: nextRecord.jobHandleId,
        state: nextRecord.state,
      },
    };
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

export function createRemoteJobTools(
  config?: SystemRemoteJobToolConfig,
  manager = new SystemRemoteJobManager(config),
): Tool[] {
  return [
    {
      name: "system.remoteJobStart",
      description:
        "Register or create a durable handle for a long-running remote MCP job. " +
        "Persists serverName, remoteJobId, callback or polling mode, artifacts, restart policy, and resource envelope.",
      inputSchema: {
        type: "object",
        properties: {
          serverName: { type: "string" },
          remoteJobId: { type: "string" },
          mode: { type: "string", enum: ["callback", "poll"] },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          statusUrl: { type: "string" },
          cancelUrl: { type: "string" },
          cancelMethod: { type: "string", enum: ["POST", "DELETE"] },
          retryable: { type: "boolean" },
          restartPolicy: { type: "string", enum: ["manual", "resume"] },
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
        required: ["serverName", "remoteJobId"],
      },
      execute: (args) => manager.start(asObject(args) ?? {}),
    },
    {
      name: "system.remoteJobStatus",
      description:
        "Inspect a durable remote MCP job handle and optionally refresh it from the configured polling endpoint.",
      inputSchema: {
        type: "object",
        properties: {
          jobHandleId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.status(asObject(args) ?? {}),
    },
    {
      name: "system.remoteJobResume",
      description:
        "Reattach to a durable remote MCP job handle after restart and return the latest durable state.",
      inputSchema: {
        type: "object",
        properties: {
          jobHandleId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.resume(asObject(args) ?? {}),
    },
    {
      name: "system.remoteJobCancel",
      description:
        "Cancel supervision for a durable remote MCP job handle and optionally issue a configured remote cancel request.",
      inputSchema: {
        type: "object",
        properties: {
          jobHandleId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.cancel(asObject(args) ?? {}),
    },
    {
      name: "system.remoteJobArtifacts",
      description:
        "List durable artifacts recorded for a remote MCP job handle.",
      inputSchema: {
        type: "object",
        properties: {
          jobHandleId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.artifacts(asObject(args) ?? {}),
    },
  ];
}
