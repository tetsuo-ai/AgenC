import { existsSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import {
  asObject,
  asPositiveInt,
  asTrimmedString,
  handleErrorResult,
  handleOkResult,
  isToolResult,
  normalizeHandleIdentity,
  normalizeResourceEnvelope,
  type StructuredHandleResourceEnvelope,
} from "./handle-contract.js";
import { formatDomainBlockReason, isDomainAllowed } from "./http.js";
import { SystemProcessManager } from "./process.js";
import type { SystemServerToolConfig } from "./types.js";

const SYSTEM_SERVER_ROOT = "/tmp/agenc-system-servers";
const SYSTEM_SERVER_SCHEMA_VERSION = 1;
const DEFAULT_READINESS_TIMEOUT_MS = 20_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2_000;
const READY_POLL_INTERVAL_MS = 250;
const SYSTEM_SERVER_FAMILY = "system_server";
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "::1",
  "[::1]",
]);

type SystemServerState = "starting" | "running" | "exited" | "failed";

interface SystemServerRecord {
  readonly version: number;
  readonly serverId: string;
  readonly label?: string;
  readonly idempotencyKey?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly processId: string;
  readonly processLabel: string;
  readonly healthUrl: string;
  readonly host: string;
  readonly port?: number;
  readonly protocol: "http" | "https";
  readonly readinessTimeoutMs: number;
  readonly readyStatusCodes: readonly number[];
  readonly resourceEnvelope?: StructuredHandleResourceEnvelope;
  readonly createdAt: number;
  readonly startedAt: number;
  updatedAt: number;
  state: SystemServerState;
  ready: boolean;
  readyAt?: number;
  lastCheckedAt?: number;
  lastStatusCode?: number;
  lastError?: string;
}

interface PersistedSystemServerRegistry {
  readonly version: number;
  readonly servers: readonly SystemServerRecord[];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeReadyStatusCodes(
  value: unknown,
): readonly number[] | ToolResult {
  if (value === undefined) {
    return [200];
  }
  if (!Array.isArray(value) || value.length === 0) {
    return handleErrorResult(
      SYSTEM_SERVER_FAMILY,
      "system_server.invalid_ready_status_codes",
      "readyStatusCodes must be a non-empty array of HTTP status codes",
      false,
      undefined,
      "start",
    );
  }
  const codes: number[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "number" ||
      !Number.isInteger(entry) ||
      entry < 100 ||
      entry > 599
    ) {
      return handleErrorResult(
        SYSTEM_SERVER_FAMILY,
        "system_server.invalid_ready_status_codes",
        "readyStatusCodes entries must be integers between 100 and 599",
        false,
        undefined,
        "start",
      );
    }
    codes.push(entry);
  }
  return [...new Set(codes)];
}

function parseHealthSpec(
  args: Record<string, unknown>,
  config: SystemServerToolConfig,
): {
  healthUrl: string;
  host: string;
  port?: number;
  protocol: "http" | "https";
} | ToolResult {
  const explicitHealthUrl = asTrimmedString(args.healthUrl);
  if (explicitHealthUrl) {
    let parsed: URL;
    try {
      parsed = new URL(explicitHealthUrl);
    } catch {
      return handleErrorResult(
        SYSTEM_SERVER_FAMILY,
        "system_server.invalid_health_url",
        "healthUrl must be a valid absolute HTTP(S) URL",
        false,
        undefined,
        "start",
      );
    }
    const protocol = parsed.protocol.replace(":", "");
    if (protocol !== "http" && protocol !== "https") {
      return handleErrorResult(
        SYSTEM_SERVER_FAMILY,
        "system_server.invalid_health_url",
        "healthUrl must use http or https",
        false,
        undefined,
        "start",
      );
    }
    const host = parsed.hostname;
    if (!LOOPBACK_HOSTS.has(host)) {
      const check = isDomainAllowed(
        explicitHealthUrl,
        config.allowedDomains,
        config.blockedDomains,
      );
      if (!check.allowed) {
        return handleErrorResult(
          SYSTEM_SERVER_FAMILY,
          "system_server.health_url_blocked",
          formatDomainBlockReason(check.reason ?? "Blocked URL"),
          false,
          undefined,
          "start",
        );
      }
    }
    const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : undefined;
    return {
      healthUrl: explicitHealthUrl,
      host,
      port,
      protocol: protocol as "http" | "https",
    };
  }

  const host = asTrimmedString(args.host) ?? "127.0.0.1";
  const port = asPositiveInt(args.port);
  if (port === undefined) {
    return handleErrorResult(
      SYSTEM_SERVER_FAMILY,
      "system_server.invalid_port",
      "Provide port or healthUrl for a managed server handle",
      false,
      undefined,
      "start",
    );
  }
  if (port > 65_535) {
    return handleErrorResult(
      SYSTEM_SERVER_FAMILY,
      "system_server.invalid_port",
      "port must be between 1 and 65535",
      false,
      undefined,
      "start",
    );
  }
  const protocol = args.protocol === "https" ? "https" : "http";
  const healthPath = asTrimmedString(args.healthPath) ?? "/";
  const normalizedPath = healthPath.startsWith("/") ? healthPath : `/${healthPath}`;
  return {
    healthUrl: `${protocol}://${host}:${port}${normalizedPath}`,
    host,
    port,
    protocol,
  };
}

function parseToolResultObject(result: ToolResult): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(result.content) as unknown;
    return asObject(parsed);
  } catch {
    return undefined;
  }
}

function buildServerResponse(
  record: SystemServerRecord,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    serverId: record.serverId,
    ...(record.label ? { label: record.label } : {}),
    ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
    command: record.command,
    args: record.args,
    ...(record.cwd ? { cwd: record.cwd } : {}),
    processId: record.processId,
    healthUrl: record.healthUrl,
    host: record.host,
    ...(record.port !== undefined ? { port: record.port } : {}),
    protocol: record.protocol,
    state: record.state,
    ready: record.ready,
    readyStatusCodes: record.readyStatusCodes,
    readinessTimeoutMs: record.readinessTimeoutMs,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    ...(record.readyAt !== undefined ? { readyAt: record.readyAt } : {}),
    ...(record.lastCheckedAt !== undefined
      ? { lastCheckedAt: record.lastCheckedAt }
      : {}),
    ...(record.lastStatusCode !== undefined
      ? { lastStatusCode: record.lastStatusCode }
      : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...(record.resourceEnvelope ? { resourceEnvelope: record.resourceEnvelope } : {}),
    ...extra,
  };
}

export class SystemServerManager {
  private readonly rootDir: string;
  private readonly registryPath: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly defaultReadinessTimeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly allowedDomains?: readonly string[];
  private readonly blockedDomains?: readonly string[];
  private readonly processManager: SystemProcessManager;
  private readonly records = new Map<string, SystemServerRecord>();
  private loaded = false;
  private persistChain: Promise<void> = Promise.resolve();

  constructor(config?: SystemServerToolConfig) {
    this.rootDir = config?.rootDir ?? SYSTEM_SERVER_ROOT;
    this.registryPath = join(this.rootDir, "registry.json");
    this.logger = config?.logger ?? silentLogger;
    this.now = config?.now ?? (() => Date.now());
    this.defaultReadinessTimeoutMs =
      config?.defaultReadinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
    this.healthTimeoutMs = config?.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.allowedDomains = config?.allowedDomains;
    this.blockedDomains = config?.blockedDomains;
    this.processManager = new SystemProcessManager({
      ...config,
      rootDir: join(this.rootDir, "processes"),
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }
    await mkdir(this.rootDir, { recursive: true });
    if (existsSync(this.registryPath)) {
      try {
        const raw = await readFile(this.registryPath, "utf8");
        const parsed = JSON.parse(raw) as PersistedSystemServerRegistry;
        for (const record of parsed.servers ?? []) {
          if (
            record &&
            typeof record.serverId === "string" &&
            typeof record.processId === "string" &&
            typeof record.processLabel === "string" &&
            typeof record.healthUrl === "string"
          ) {
            this.records.set(record.serverId, cloneJson(record));
          }
        }
      } catch (error) {
        this.logger.warn("Failed to load system server registry", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const snapshot: PersistedSystemServerRegistry = {
      version: SYSTEM_SERVER_SCHEMA_VERSION,
      servers: [...this.records.values()].map((record) => cloneJson(record)),
    };
    this.persistChain = this.persistChain.then(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const tempPath = `${this.registryPath}.tmp`;
      await writeFile(tempPath, safeStringify(snapshot), "utf8");
      await rename(tempPath, this.registryPath);
    });
    return this.persistChain;
  }

  private findByLabel(label: string): SystemServerRecord | undefined {
    for (const record of this.records.values()) {
      if (record.label === label) {
        return record;
      }
    }
    return undefined;
  }

  private findByIdempotencyKey(idempotencyKey: string): SystemServerRecord | undefined {
    for (const record of this.records.values()) {
      if (record.idempotencyKey === idempotencyKey) {
        return record;
      }
    }
    return undefined;
  }

  private async resolveRecord(
    args: Record<string, unknown>,
  ): Promise<SystemServerRecord | ToolResult> {
    await this.ensureLoaded();
    const serverId = asTrimmedString(args.serverId);
    const identity = normalizeHandleIdentity(
      SYSTEM_SERVER_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const record = serverId
      ? this.records.get(serverId)
      : identity.idempotencyKey
        ? this.findByIdempotencyKey(identity.idempotencyKey)
        : identity.label
          ? this.findByLabel(identity.label)
          : undefined;
    if (!record) {
      return handleErrorResult(
        SYSTEM_SERVER_FAMILY,
        "system_server.not_found",
        "Managed server not found. Provide serverId or a previously used label/idempotencyKey.",
        false,
        undefined,
        "lookup",
      );
    }
    return record;
  }

  private async fetchProcessStatus(
    processId: string,
    operation: "status" | "resume" = "status",
  ): Promise<Record<string, unknown> | ToolResult> {
    const result =
      operation === "resume"
        ? await this.processManager.resume({ processId })
        : await this.processManager.status({ processId });
    if (result.isError) {
      return result;
    }
    return parseToolResultObject(result) ?? {
      state: "failed",
      lastError: "Unparseable process status payload",
    };
  }

  private async refreshRecordState(
    record: SystemServerRecord,
    operation: "status" | "resume" = "status",
  ): Promise<Record<string, unknown> | ToolResult> {
    const status = await this.fetchProcessStatus(record.processId, operation);
    if (isToolResult(status)) {
      record.state = "failed";
      record.lastError = "Managed process status lookup failed";
      record.updatedAt = this.now();
      await this.persist();
      return status;
    }
    const state = asTrimmedString(status.state);
    record.updatedAt = this.now();
    if (state === "running") {
      if (record.state !== "running") {
        record.state = record.ready ? "running" : "starting";
      }
      record.lastError = undefined;
    } else if (state === "failed") {
      record.state = "failed";
      record.ready = false;
      record.lastError = asTrimmedString(status.lastError) ?? record.lastError;
    } else if (state === "exited") {
      record.state = "exited";
      record.ready = false;
      record.lastError = asTrimmedString(status.lastError) ?? record.lastError;
    }
    await this.persist();
    return status;
  }

  private async probeServer(record: SystemServerRecord): Promise<{
    readonly ready: boolean;
    readonly statusCode?: number;
    readonly error?: string;
  }> {
    try {
      const response = await fetch(record.healthUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(this.healthTimeoutMs),
      });
      return {
        ready: record.readyStatusCodes.includes(response.status),
        statusCode: response.status,
      };
    } catch (error) {
      return {
        ready: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private buildInternalProcessLabel(record: {
    readonly label?: string;
    readonly idempotencyKey?: string;
    readonly serverId: string;
  }): string {
    const suffix = record.label ?? record.idempotencyKey ?? record.serverId;
    return `server:${suffix}`;
  }

  async start(args: Record<string, unknown>): Promise<ToolResult> {
    await this.ensureLoaded();
    const command = asTrimmedString(args.command);
    if (!command) {
      return handleErrorResult(
        SYSTEM_SERVER_FAMILY,
        "system_server.invalid_command",
        "command must be a non-empty executable path or name",
        false,
        undefined,
        "start",
      );
    }
    const rawArgs = Array.isArray(args.args) ? args.args : args.args === undefined ? [] : null;
    if (!rawArgs || rawArgs.some((entry) => typeof entry !== "string")) {
      return handleErrorResult(
        SYSTEM_SERVER_FAMILY,
        "system_server.invalid_args",
        "args must be an array of strings when provided",
        false,
        undefined,
        "start",
      );
    }
    const identity = normalizeHandleIdentity(
      SYSTEM_SERVER_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const healthSpec = parseHealthSpec(args, {
      defaultReadinessTimeoutMs: this.defaultReadinessTimeoutMs,
      healthTimeoutMs: this.healthTimeoutMs,
      allowedDomains: this.allowedDomains,
      blockedDomains: this.blockedDomains,
    });
    if (isToolResult(healthSpec)) {
      return healthSpec;
    }
    const readyStatusCodes = normalizeReadyStatusCodes(args.readyStatusCodes);
    if (isToolResult(readyStatusCodes)) {
      return readyStatusCodes;
    }
    const readinessTimeoutMs =
      asPositiveInt(args.readinessTimeoutMs) ?? this.defaultReadinessTimeoutMs;
    const resourceEnvelope = normalizeResourceEnvelope(
      SYSTEM_SERVER_FAMILY,
      args.resourceEnvelope,
      "start",
    );
    if (isToolResult(resourceEnvelope)) {
      return resourceEnvelope;
    }

    const matchesStartSpec = (record: SystemServerRecord): boolean =>
      record.command === command &&
      JSON.stringify(record.args) === JSON.stringify(rawArgs) &&
      record.healthUrl === healthSpec.healthUrl &&
      record.readinessTimeoutMs === readinessTimeoutMs &&
      JSON.stringify(record.readyStatusCodes) === JSON.stringify(readyStatusCodes);

    const idempotentMatch = identity.idempotencyKey
      ? this.findByIdempotencyKey(identity.idempotencyKey)
      : undefined;
    if (idempotentMatch) {
      await this.refreshRecordState(idempotentMatch);
      if (
        matchesStartSpec(idempotentMatch) &&
        (idempotentMatch.state === "starting" || idempotentMatch.state === "running")
      ) {
        return handleOkResult(buildServerResponse(idempotentMatch, { reused: true }));
      }
      return handleErrorResult(
        SYSTEM_SERVER_FAMILY,
        "system_server.idempotency_conflict",
        "A managed server already exists for that idempotencyKey.",
        false,
        {
          serverId: idempotentMatch.serverId,
          state: idempotentMatch.state,
        },
        "start",
      );
    }

    const labelMatch = identity.label ? this.findByLabel(identity.label) : undefined;
    if (labelMatch) {
      await this.refreshRecordState(labelMatch);
      if (
        labelMatch.idempotencyKey === identity.idempotencyKey &&
        matchesStartSpec(labelMatch) &&
        (labelMatch.state === "starting" || labelMatch.state === "running")
      ) {
        return handleOkResult(buildServerResponse(labelMatch, { reused: true }));
      }
      if (labelMatch.state === "starting" || labelMatch.state === "running") {
        return handleErrorResult(
          SYSTEM_SERVER_FAMILY,
          "system_server.label_conflict",
          "A managed server already exists for that label.",
          false,
          {
            serverId: labelMatch.serverId,
            state: labelMatch.state,
          },
          "start",
        );
      }
    }

    const serverId = `server_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const processLabel = this.buildInternalProcessLabel({
      label: identity.label,
      idempotencyKey: identity.idempotencyKey,
      serverId,
    });
    const processStart = await this.processManager.start({
      command,
      args: rawArgs,
      cwd: args.cwd,
      label: processLabel,
      idempotencyKey: identity.idempotencyKey
        ? `server:${identity.idempotencyKey}`
        : undefined,
    });
    if (processStart.isError) {
      const parsed = parseToolResultObject(processStart);
      const errorMessage =
        asTrimmedString(parsed?.error && asObject(parsed.error)?.message) ??
        asTrimmedString(parsed?.message) ??
        "Failed to start managed server process";
      return handleErrorResult(
        SYSTEM_SERVER_FAMILY,
        "system_server.start_failed",
        errorMessage,
        true,
        parsed ? { process: parsed } : undefined,
        "start",
      );
    }
    const processPayload = parseToolResultObject(processStart);
    const processId = asTrimmedString(processPayload?.processId);
    if (!processId) {
      return handleErrorResult(
        SYSTEM_SERVER_FAMILY,
        "system_server.start_failed",
        "Managed server process start did not return a processId",
        true,
        processPayload ?? undefined,
        "start",
      );
    }

    const startedAt = this.now();
    const record: SystemServerRecord = {
      version: SYSTEM_SERVER_SCHEMA_VERSION,
      serverId,
      ...(identity.label ? { label: identity.label } : {}),
      ...(identity.idempotencyKey ? { idempotencyKey: identity.idempotencyKey } : {}),
      command,
      args: [...rawArgs],
      cwd: asTrimmedString(args.cwd),
      processId,
      processLabel,
      healthUrl: healthSpec.healthUrl,
      host: healthSpec.host,
      ...(healthSpec.port !== undefined ? { port: healthSpec.port } : {}),
      protocol: healthSpec.protocol,
      readinessTimeoutMs,
      readyStatusCodes,
      ...(resourceEnvelope ? { resourceEnvelope } : {}),
      createdAt: startedAt,
      startedAt,
      updatedAt: startedAt,
      state: "starting",
      ready: false,
    };
    this.records.set(serverId, record);
    await this.persist();

    const deadline = startedAt + readinessTimeoutMs;
    while (this.now() < deadline) {
      const processStatus = await this.refreshRecordState(record);
      if (isToolResult(processStatus)) {
        return processStatus;
      }
      if (record.state === "failed" || record.state === "exited") {
        return handleErrorResult(
          SYSTEM_SERVER_FAMILY,
          "system_server.start_failed",
          "Managed server process exited before becoming ready",
          true,
          {
            serverId: record.serverId,
            processId: record.processId,
            state: record.state,
          },
          "start",
        );
      }

      const probe = await this.probeServer(record);
      record.lastCheckedAt = this.now();
      record.lastStatusCode = probe.statusCode;
      record.lastError = probe.error;
      if (probe.ready) {
        record.ready = true;
        record.readyAt = record.lastCheckedAt;
        record.state = "running";
        record.lastError = undefined;
        record.updatedAt = record.lastCheckedAt;
        await this.persist();
        return handleOkResult(buildServerResponse(record, { started: true }));
      }
      record.updatedAt = record.lastCheckedAt;
      await this.persist();
      await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
    }

    return handleErrorResult(
      SYSTEM_SERVER_FAMILY,
      "system_server.timeout",
      "Managed server did not become ready before the readiness timeout expired",
      true,
      {
        serverId: record.serverId,
        processId: record.processId,
        healthUrl: record.healthUrl,
      },
      "start",
    );
  }

  async status(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args);
    if (isToolResult(record)) {
      return record;
    }
    const processStatus = await this.refreshRecordState(record, "status");
    if (isToolResult(processStatus)) {
      return processStatus;
    }
    if (record.state === "starting" || record.state === "running") {
      const probe = await this.probeServer(record);
      record.lastCheckedAt = this.now();
      record.lastStatusCode = probe.statusCode;
      record.lastError = probe.error;
      if (probe.ready) {
        record.ready = true;
        record.readyAt = record.readyAt ?? record.lastCheckedAt;
        record.state = "running";
        record.lastError = undefined;
      } else if (record.state === "running") {
        record.ready = false;
        record.state = "starting";
      }
      record.updatedAt = record.lastCheckedAt;
      await this.persist();
    }
    return handleOkResult(
      buildServerResponse(record, {
        recentOutput: asTrimmedString(processStatus.recentOutput) ?? "",
      }),
    );
  }

  async resume(args: Record<string, unknown>): Promise<ToolResult> {
    return this.status(args);
  }

  async logs(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args);
    if (isToolResult(record)) {
      return record;
    }
    const logs = await this.processManager.logs({
      processId: record.processId,
      maxBytes: args.maxBytes,
    });
    if (logs.isError) {
      return logs;
    }
    const parsed = parseToolResultObject(logs);
    return handleOkResult({
      serverId: record.serverId,
      ...(record.label ? { label: record.label } : {}),
      ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
      processId: record.processId,
      logPath: parsed?.logPath,
      output: parsed?.output ?? "",
      state: record.state,
    });
  }

  async stop(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args);
    if (isToolResult(record)) {
      return record;
    }
    const stopped = await this.processManager.stop({
      processId: record.processId,
      signal: args.signal,
      waitMs: args.waitMs,
    });
    if (stopped.isError) {
      return handleErrorResult(
        SYSTEM_SERVER_FAMILY,
        "system_server.stop_failed",
        "Failed to stop managed server process",
        true,
        parseToolResultObject(stopped) ?? undefined,
        "stop",
      );
    }
    record.state = "exited";
    record.ready = false;
    record.updatedAt = this.now();
    await this.persist();
    return handleOkResult(buildServerResponse(record, { stopped: true }));
  }

  async resetForTesting(): Promise<void> {
    await this.processManager.resetForTesting();
    this.records.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    await rm(this.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  resetForTestingSync(): void {
    this.processManager.resetForTestingSync();
    this.records.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    rmSync(this.rootDir, { recursive: true, force: true });
  }
}

export function createServerTools(config?: SystemServerToolConfig): Tool[] {
  const manager = new SystemServerManager(config);

  return [
    {
      name: "system.serverStart",
      description:
        "Start a long-running local or remote-checked server with a durable handle. " +
        "This wraps a managed host process plus structured readiness probing, and returns serverId/processId, bound address metadata, readiness state, and log access.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Executable path or name." },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Arguments passed directly to the executable.",
          },
          cwd: { type: "string", description: "Optional working directory override." },
          label: { type: "string", description: "Stable server handle label." },
          idempotencyKey: {
            type: "string",
            description: "Optional idempotency key for deduplicating repeated server starts.",
          },
          host: { type: "string", description: "Health probe host (default 127.0.0.1)." },
          port: { type: "number", description: "Health probe port when healthUrl is omitted." },
          protocol: { type: "string", enum: ["http", "https"] },
          healthPath: { type: "string", description: "Health probe path when host/port are used." },
          healthUrl: { type: "string", description: "Explicit absolute health probe URL." },
          readyStatusCodes: {
            type: "array",
            items: { type: "number" },
            description: "HTTP status codes treated as ready (default [200]).",
          },
          readinessTimeoutMs: {
            type: "number",
            description: "How long to wait for readiness before returning a timeout error.",
          },
          resourceEnvelope: {
            type: "object",
            description:
              "Optional resource budget contract: cpu, memoryMb, diskMb, network, wallClockMs, sandboxAffinity, environmentClass, enforcement.",
          },
        },
        required: ["command"],
      },
      execute: (args) => manager.start(asObject(args) ?? {}),
    },
    {
      name: "system.serverStatus",
      description:
        "Inspect a durable server handle and return process state, readiness, health metadata, timestamps, and recent logs.",
      inputSchema: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.status(asObject(args) ?? {}),
    },
    {
      name: "system.serverResume",
      description:
        "Reattach to a durable server handle after restart and return the current readiness and log state.",
      inputSchema: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
        },
      },
      execute: (args) => manager.resume(asObject(args) ?? {}),
    },
    {
      name: "system.serverStop",
      description:
        "Stop a durable server handle and its managed process group.",
      inputSchema: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          signal: { type: "string" },
          waitMs: { type: "number" },
        },
      },
      execute: (args) => manager.stop(asObject(args) ?? {}),
    },
    {
      name: "system.serverLogs",
      description:
        "Read the recent persisted logs for a durable server handle.",
      inputSchema: {
        type: "object",
        properties: {
          serverId: { type: "string" },
          label: { type: "string" },
          idempotencyKey: { type: "string" },
          maxBytes: { type: "number" },
        },
      },
      execute: (args) => manager.logs(asObject(args) ?? {}),
    },
  ];
}
