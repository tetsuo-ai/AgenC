import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, openSync, closeSync, rmSync } from "node:fs";
import { open as openFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";
import type { Tool, ToolResult } from "../types.js";
import {
  DEFAULT_DENY_LIST,
  type SystemProcessToolConfig,
  type SystemProcessLifecycleEvent,
} from "./types.js";
import { isCommandAllowed } from "./bash.js";
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

const SYSTEM_PROCESS_ROOT = "/tmp/agenc-system-processes";
const SYSTEM_PROCESS_SCHEMA_VERSION = 1;
const DEFAULT_LOG_TAIL_BYTES = 4096;
const DEFAULT_LOG_SETTLE_MS = 200;
const DEFAULT_LOG_SETTLE_POLL_MS = 25;
const DEFAULT_STOP_WAIT_MS = 5000;
const MAX_LOG_TAIL_BYTES = 64 * 1024;
const MAX_LOG_SETTLE_MS = 5_000;
const SINGLE_EXECUTABLE_RE = /^[A-Za-z0-9_./+-]+$/;

type SystemProcessState = "running" | "exited" | "failed";

interface SystemProcessRecord {
  readonly version: number;
  readonly processId: string;
  readonly label?: string;
  readonly idempotencyKey?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly logPath: string;
  readonly resourceEnvelope?: StructuredHandleResourceEnvelope;
  pid: number;
  pgid: number;
  state: SystemProcessState;
  readonly createdAt: number;
  updatedAt: number;
  startedAt: number;
  lastExitAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  lastError?: string;
}

interface PersistedSystemProcessRegistry {
  readonly version: number;
  readonly processes: readonly SystemProcessRecord[];
}

interface SystemProcessRuntime {
  readonly record: SystemProcessRecord;
  readonly child: ChildProcess;
  exited: boolean;
}

const SYSTEM_PROCESS_FAMILY = "system_process";

function cloneRecord(record: SystemProcessRecord): SystemProcessRecord {
  return JSON.parse(JSON.stringify(record)) as SystemProcessRecord;
}

function normalizePersistedState(value: unknown): SystemProcessState | undefined {
  if (value === "running" || value === "exited" || value === "failed") {
    return value;
  }
  if (value === "stopped") {
    return "exited";
  }
  return undefined;
}

function validateCommand(commandValue: unknown): string | ToolResult {
  const command = asTrimmedString(commandValue);
  if (!command) {
    return handleErrorResult(
      SYSTEM_PROCESS_FAMILY,
      "system_process.invalid_command",
      "command must be a non-empty executable path or name",
      false,
      undefined,
      "start",
    );
  }
  if (!SINGLE_EXECUTABLE_RE.test(command)) {
    return handleErrorResult(
      SYSTEM_PROCESS_FAMILY,
      "system_process.invalid_command",
      "command must be a single executable token; pass flags and operands via args",
      false,
      undefined,
      "start",
    );
  }
  return command;
}

function normalizeArgs(value: unknown): readonly string[] | ToolResult {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    return handleErrorResult(
      SYSTEM_PROCESS_FAMILY,
      "system_process.invalid_args",
      "args must be an array of strings",
      false,
      undefined,
      "start",
    );
  }
  const args: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return handleErrorResult(
        SYSTEM_PROCESS_FAMILY,
        "system_process.invalid_args",
        "args must be an array of strings",
        false,
        undefined,
        "start",
      );
    }
    args.push(entry);
  }
  return args;
}

function buildDenySet(
  configDenyList?: readonly string[],
  denyExclusions?: readonly string[],
): Set<string> {
  const set = new Set<string>(DEFAULT_DENY_LIST);
  if (configDenyList) {
    for (const cmd of configDenyList) {
      set.add(cmd);
    }
  }
  if (denyExclusions) {
    for (const cmd of denyExclusions) {
      set.delete(cmd);
    }
  }
  return set;
}

function buildEnv(configEnv?: Record<string, string>): Record<string, string> {
  if (configEnv) return configEnv;
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
  };
}

function buildProcessResponse(
  record: SystemProcessRecord,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    processId: record.processId,
    ...(record.label ? { label: record.label } : {}),
    ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
    command: record.command,
    args: record.args,
    cwd: record.cwd,
    logPath: record.logPath,
    ...(record.resourceEnvelope ? { resourceEnvelope: record.resourceEnvelope } : {}),
    pid: record.pid,
    pgid: record.pgid,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    ...(record.lastExitAt ? { lastExitAt: record.lastExitAt } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    ...extra,
  };
}

async function readTail(logPath: string, maxBytes: number): Promise<string> {
  if (!existsSync(logPath)) {
    return "";
  }
  const handle = await openFile(logPath, "r");
  try {
    const info = await handle.stat();
    const size = info.size;
    const length = Math.min(size, maxBytes);
    const offset = Math.max(0, size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    return buffer.toString("utf8").trim();
  } finally {
    await handle.close();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export class SystemProcessManager {
  private readonly rootDir: string;
  private readonly registryPath: string;
  private readonly defaultCwd: string;
  private readonly lockCwd: boolean;
  private readonly env: Record<string, string>;
  private readonly defaultLogTailBytes: number;
  private readonly maxLogTailBytes: number;
  private readonly defaultLogSettleMs: number;
  private readonly maxLogSettleMs: number;
  private readonly defaultStopWaitMs: number;
  private readonly unrestricted: boolean;
  private readonly denySet: ReadonlySet<string>;
  private readonly allowSet: ReadonlySet<string> | null;
  private readonly denyExclusions: ReadonlySet<string> | null;
  private readonly onLifecycleEvent?: (
    event: SystemProcessLifecycleEvent,
  ) => void | Promise<void>;
  private readonly logger: Logger;
  private readonly now: () => number;
  private loaded = false;
  private disposed = false;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly records = new Map<string, SystemProcessRecord>();
  private readonly runtimes = new Map<string, SystemProcessRuntime>();

  constructor(config?: SystemProcessToolConfig) {
    this.rootDir = config?.rootDir ?? SYSTEM_PROCESS_ROOT;
    this.registryPath = join(this.rootDir, "registry.json");
    this.defaultCwd = config?.cwd ?? process.cwd();
    this.lockCwd = config?.lockCwd ?? false;
    this.env = buildEnv(config?.env);
    this.defaultLogTailBytes = config?.defaultLogTailBytes ?? DEFAULT_LOG_TAIL_BYTES;
    this.maxLogTailBytes = config?.maxLogTailBytes ?? MAX_LOG_TAIL_BYTES;
    this.defaultLogSettleMs = config?.defaultLogSettleMs ?? DEFAULT_LOG_SETTLE_MS;
    this.maxLogSettleMs = config?.maxLogSettleMs ?? MAX_LOG_SETTLE_MS;
    this.defaultStopWaitMs = config?.defaultStopWaitMs ?? DEFAULT_STOP_WAIT_MS;
    this.unrestricted = config?.unrestricted ?? false;
    this.denySet = this.unrestricted
      ? new Set<string>()
      : buildDenySet(config?.denyList, config?.denyExclusions);
    this.allowSet =
      !this.unrestricted && config?.allowList && config.allowList.length > 0
        ? new Set<string>(config.allowList)
        : null;
    this.denyExclusions =
      !this.unrestricted && config?.denyExclusions && config.denyExclusions.length > 0
        ? new Set<string>(config.denyExclusions)
        : null;
    this.onLifecycleEvent = config?.onLifecycleEvent;
    this.logger = config?.logger ?? silentLogger;
    this.now = config?.now ?? (() => Date.now());
  }

  private emitLifecycleEvent(
    record: SystemProcessRecord,
    cause: SystemProcessLifecycleEvent["cause"],
  ): void {
    if (!this.onLifecycleEvent || record.state === "running") {
      return;
    }
    void Promise.resolve(
      this.onLifecycleEvent({
        processId: record.processId,
        label: record.label,
        idempotencyKey: record.idempotencyKey,
        state: record.state,
        exitCode: record.exitCode,
        signal: record.signal,
        occurredAt: record.lastExitAt ?? record.updatedAt,
        cause,
      }),
    ).catch((error) => {
      this.logger.debug("System process lifecycle callback failed", {
        processId: record.processId,
        cause,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private terminateTrackedProcesses(): void {
    for (const record of this.records.values()) {
      try {
        if (record.pgid > 0) {
          process.kill(-record.pgid, "SIGKILL");
        } else if (record.pid > 0) {
          process.kill(record.pid, "SIGKILL");
        }
      } catch {
        // Best effort cleanup for tests only.
      }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedSystemProcessRegistry;
      if (!Array.isArray(parsed.processes)) return;
      for (const entry of parsed.processes) {
        const state = normalizePersistedState(entry?.state);
        if (
          typeof entry?.processId === "string" &&
          typeof entry?.command === "string" &&
          Array.isArray(entry?.args) &&
          typeof entry?.cwd === "string" &&
          typeof entry?.logPath === "string" &&
          typeof entry?.pid === "number" &&
          typeof entry?.pgid === "number" &&
          state
        ) {
          this.records.set(
            entry.processId,
            cloneRecord({
              ...entry,
              state,
            } as SystemProcessRecord),
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ENOENT/i.test(message)) {
        this.logger.warn("Failed to load system process registry", { message });
      }
    }
  }

  private async persist(): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.ensureLoaded();
    const snapshot: PersistedSystemProcessRegistry = {
      version: SYSTEM_PROCESS_SCHEMA_VERSION,
      processes: [...this.records.values()].map((record) => cloneRecord(record)),
    };
    this.persistChain = this.persistChain.then(async () => {
      if (this.disposed) {
        return;
      }
      await mkdir(this.rootDir, { recursive: true });
      const tempPath = `${this.registryPath}.${randomUUID()}.tmp`;
      const handle = await openFile(tempPath, "w");
      try {
        await handle.writeFile(JSON.stringify(snapshot, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.registryPath);
    });
    await this.persistChain;
  }

  private findByLabel(label: string): SystemProcessRecord | undefined {
    let best: SystemProcessRecord | undefined;
    for (const record of this.records.values()) {
      if (record.label === label) {
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
    }
    return best;
  }

  private findByIdempotencyKey(idempotencyKey: string): SystemProcessRecord | undefined {
    let best: SystemProcessRecord | undefined;
    for (const record of this.records.values()) {
      if (record.idempotencyKey === idempotencyKey) {
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
    }
    return best;
  }

  private async resolveRecord(
    args: Record<string, unknown>,
  ): Promise<SystemProcessRecord | ToolResult> {
    await this.ensureLoaded();
    const processId = asTrimmedString(args.processId);
    const identity = normalizeHandleIdentity(
      SYSTEM_PROCESS_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const label = identity.label;
    const idempotencyKey = identity.idempotencyKey;
    const record = processId
      ? this.records.get(processId)
      : idempotencyKey
        ? this.findByIdempotencyKey(idempotencyKey)
      : label
        ? this.findByLabel(label)
        : undefined;
    if (!record) {
      return handleErrorResult(
        SYSTEM_PROCESS_FAMILY,
        "system_process.not_found",
        "Managed process not found. Provide processId or a previously used label/idempotencyKey.",
        false,
        undefined,
        "lookup",
      );
    }
    return record;
  }

  private validateAllowed(command: string): ToolResult | null {
    if (this.unrestricted) {
      return null;
    }
    const allowed = isCommandAllowed(
      command,
      this.denySet,
      this.allowSet,
      this.denyExclusions,
    );
    if (allowed.allowed) return null;
    return handleErrorResult(
      SYSTEM_PROCESS_FAMILY,
      "system_process.denied_command",
      allowed.reason,
      false,
      undefined,
      "start",
    );
  }

  private normalizeCwd(cwdValue: unknown): string | ToolResult {
    if (cwdValue === undefined) {
      return this.defaultCwd;
    }
    if (this.lockCwd) {
      return handleErrorResult(
        SYSTEM_PROCESS_FAMILY,
        "system_process.cwd_locked",
        "cwd override is not allowed for this runtime",
        false,
        undefined,
        "start",
      );
    }
    const cwd = asTrimmedString(cwdValue);
    if (!cwd) {
      return handleErrorResult(
        SYSTEM_PROCESS_FAMILY,
        "system_process.invalid_cwd",
        "cwd must be a non-empty string",
        false,
        undefined,
        "start",
      );
    }
    return resolve(cwd);
  }

  private async refreshRecordState(record: SystemProcessRecord): Promise<void> {
    if (record.state !== "running") return;
    const runtime = this.runtimes.get(record.processId);
    if (runtime) {
      const exitCode = runtime.child.exitCode;
      const signal = runtime.child.signalCode;
      if (runtime.exited || exitCode !== null || signal !== null) {
        record.state = exitCode === 0 || signal === "SIGTERM" || signal === "SIGKILL"
          ? "exited"
          : "failed";
        record.exitCode = exitCode;
        record.signal = signal;
        record.lastExitAt = this.now();
        record.updatedAt = record.lastExitAt;
        runtime.exited = true;
        this.runtimes.delete(record.processId);
        await this.persist();
        return;
      }
      return;
    }
    try {
      process.kill(record.pid, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/ESRCH/i.test(message)) {
        record.state = "exited";
        record.lastExitAt = this.now();
        record.updatedAt = record.lastExitAt;
        this.runtimes.delete(record.processId);
        await this.persist();
        return;
      }
      throw error;
    }
  }

  async start(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    await this.ensureLoaded();
    const command = validateCommand(args.command);
    if (isToolResult(command)) return command;
    const allowed = this.validateAllowed(command);
    if (allowed) return allowed;
    const normalizedArgs = normalizeArgs(args.args);
    if (isToolResult(normalizedArgs)) return normalizedArgs;
    const cwd = this.normalizeCwd(args.cwd);
    if (isToolResult(cwd)) return cwd;
    const identity = normalizeHandleIdentity(
      SYSTEM_PROCESS_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const label = identity.label;
    const idempotencyKey = identity.idempotencyKey;
    const resourceEnvelope = normalizeResourceEnvelope(
      SYSTEM_PROCESS_FAMILY,
      args.resourceEnvelope,
      "start",
    );
    if (isToolResult(resourceEnvelope)) return resourceEnvelope;

    const matchesLaunchSpec = (record: SystemProcessRecord): boolean =>
      record.command === command &&
      JSON.stringify(record.args) === JSON.stringify(normalizedArgs) &&
      record.cwd === cwd &&
      JSON.stringify(record.resourceEnvelope ?? null) ===
        JSON.stringify(resourceEnvelope ?? null);

    const idempotentMatch = idempotencyKey
      ? this.findByIdempotencyKey(idempotencyKey)
      : undefined;
    if (idempotentMatch) {
      await this.refreshRecordState(idempotentMatch);
      if (matchesLaunchSpec(idempotentMatch) && idempotentMatch.state === "running") {
        return handleOkResult(buildProcessResponse(idempotentMatch, { reused: true }));
      }
      return handleErrorResult(
        SYSTEM_PROCESS_FAMILY,
        "system_process.idempotency_conflict",
        "A managed process already exists for that idempotencyKey.",
        false,
        {
          processId: idempotentMatch.processId,
          state: idempotentMatch.state,
        },
        "start",
      );
    }

    const labelMatch = label ? this.findByLabel(label) : undefined;
    if (labelMatch) {
      await this.refreshRecordState(labelMatch);
      if (
        labelMatch.idempotencyKey === idempotencyKey &&
        matchesLaunchSpec(labelMatch) &&
        labelMatch.state === "running"
      ) {
        return handleOkResult(buildProcessResponse(labelMatch, { reused: true }));
      }
      if (labelMatch.state === "running") {
        return handleErrorResult(
          SYSTEM_PROCESS_FAMILY,
          "system_process.label_conflict",
          "A managed process already exists for that label.",
          false,
          {
            processId: labelMatch.processId,
            state: labelMatch.state,
          },
          "start",
        );
      }
      const reclaimedLabelRecord: SystemProcessRecord = {
        ...labelMatch,
        label: undefined,
        updatedAt: this.now(),
      };
      this.records.set(labelMatch.processId, reclaimedLabelRecord);
      await this.persist();
    }

    const processId = `proc_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    const processDir = join(this.rootDir, processId);
    const logPath = join(processDir, "process.log");
    await mkdir(processDir, { recursive: true });

    const startedAt = this.now();
    const record: SystemProcessRecord = {
      version: SYSTEM_PROCESS_SCHEMA_VERSION,
      processId,
      ...(label ? { label } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      command,
      args: [...normalizedArgs],
      cwd,
      logPath,
      ...(resourceEnvelope ? { resourceEnvelope } : {}),
      pid: -1,
      pgid: -1,
      state: "running",
      createdAt: startedAt,
      updatedAt: startedAt,
      startedAt,
    };

    const stdoutFd = openSync(logPath, "a");
    const stderrFd = openSync(logPath, "a");
    try {
      const child = spawn(command, [...normalizedArgs], {
        cwd,
        env: this.env,
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });

      await new Promise<void>((resolvePromise, rejectPromise) => {
        let settled = false;
        const settle = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };
        child.once("spawn", () => settle(resolvePromise));
        child.once("error", (error) => settle(() => rejectPromise(error)));
      });

      record.pid = child.pid ?? -1;
      record.pgid = child.pid ?? -1;
      child.once("exit", (exitCode, signal) => {
        if (this.disposed) return;
        const current = this.records.get(processId);
        if (!current) return;
        const runtime = this.runtimes.get(processId);
        if (runtime) {
          runtime.exited = true;
        }
        if (current.state !== "running") {
          this.runtimes.delete(processId);
          return;
        }
        current.state = exitCode === 0 || signal === "SIGTERM" || signal === "SIGKILL"
          ? "exited"
          : "failed";
        current.exitCode = exitCode;
        current.signal = signal;
        current.lastExitAt = this.now();
        current.updatedAt = current.lastExitAt;
        this.runtimes.delete(processId);
        void this.persist().then(() => {
          this.emitLifecycleEvent(current, "child_exit");
        });
      });
      child.once("error", (error) => {
        if (this.disposed) return;
        const current = this.records.get(processId);
        if (!current) return;
        const runtime = this.runtimes.get(processId);
        if (runtime) {
          runtime.exited = true;
        }
        if (current.state !== "running") {
          this.runtimes.delete(processId);
          return;
        }
        current.state = "failed";
        current.lastError = error.message;
        current.lastExitAt = this.now();
        current.updatedAt = current.lastExitAt;
        this.runtimes.delete(processId);
        void this.persist().then(() => {
          this.emitLifecycleEvent(current, "child_error");
        });
      });
      child.unref();

      this.records.set(processId, record);
      this.runtimes.set(processId, {
        record,
        child,
        exited: false,
      });
      await this.persist();
      return handleOkResult(buildProcessResponse(record, { started: true }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.state = "failed";
      record.lastError = message;
      record.lastExitAt = this.now();
      record.updatedAt = record.lastExitAt;
      this.records.set(processId, record);
      await this.persist();
      return handleErrorResult(
        SYSTEM_PROCESS_FAMILY,
        "system_process.start_failed",
        `Failed to start managed process: ${message}`,
        true,
        undefined,
        "start",
      );
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  }

  async status(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args);
    if (isToolResult(record)) return record;
    await this.refreshRecordState(record);
    const maxBytes = Math.min(
      asPositiveInt(args.maxLogBytes) ?? this.defaultLogTailBytes,
      this.maxLogTailBytes,
    );
    const recentOutput = await readTail(record.logPath, maxBytes);
    return handleOkResult(buildProcessResponse(record, {
      recentOutput,
    }));
  }

  async resume(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args);
    if (isToolResult(record)) return record;
    await this.refreshRecordState(record);
    const maxBytes = Math.min(
      asPositiveInt(args.maxLogBytes) ?? this.defaultLogTailBytes,
      this.maxLogTailBytes,
    );
    const recentOutput = await readTail(record.logPath, maxBytes);
    return handleOkResult(buildProcessResponse(record, {
      resumed: record.state === "running",
      recentOutput,
    }));
  }

  async logs(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args);
    if (isToolResult(record)) return record;
    await this.refreshRecordState(record);
    const maxBytes = Math.min(
      asPositiveInt(args.maxBytes) ?? this.defaultLogTailBytes,
      this.maxLogTailBytes,
    );
    const waitForOutputMs = Math.min(
      asPositiveInt(args.waitForOutputMs) ?? this.defaultLogSettleMs,
      this.maxLogSettleMs,
    );
    let output = await readTail(record.logPath, maxBytes);
    if (output.length === 0 && record.state === "running" && waitForOutputMs > 0) {
      const deadline = Date.now() + waitForOutputMs;
      while (Date.now() < deadline) {
        const remainingMs = deadline - Date.now();
        await sleep(Math.min(DEFAULT_LOG_SETTLE_POLL_MS, remainingMs));
        await this.refreshRecordState(record);
        output = await readTail(record.logPath, maxBytes);
        if (output.length > 0 || record.state !== "running") {
          break;
        }
      }
    }
    return handleOkResult({
      processId: record.processId,
      ...(record.label ? { label: record.label } : {}),
      ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
      state: record.state,
      logPath: record.logPath,
      output,
    });
  }

  async stop(args: Record<string, unknown>): Promise<ToolResult> {
    const record = await this.resolveRecord(args);
    if (isToolResult(record)) return record;
    await this.refreshRecordState(record);
    if (record.state !== "running") {
      return handleOkResult(buildProcessResponse(record, { stopped: false }));
    }

    const signal = asTrimmedString(args.signal) ?? "SIGTERM";
    if (!/^SIG[A-Z0-9]+$/.test(signal)) {
      return handleErrorResult(
        SYSTEM_PROCESS_FAMILY,
        "system_process.invalid_signal",
        "signal must look like SIGTERM, SIGINT, or SIGKILL",
        false,
        undefined,
        "stop",
      );
    }
    const waitMs = asPositiveInt(args.waitMs) ?? this.defaultStopWaitMs;

    const sendSignal = (target: number): void => {
      try {
        process.kill(target, signal as NodeJS.Signals);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/ESRCH/i.test(message)) {
          throw error;
        }
      }
    };

    try {
      sendSignal(record.pgid > 0 ? -record.pgid : record.pid);
    } catch (error) {
      return handleErrorResult(
        SYSTEM_PROCESS_FAMILY,
        "system_process.stop_failed",
        error instanceof Error ? error.message : String(error),
        true,
        undefined,
        "stop",
      );
    }

    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      try {
        process.kill(record.pid, 0);
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ESRCH/i.test(message)) {
          record.state = "exited";
          record.signal = signal;
          record.lastExitAt = this.now();
          record.updatedAt = record.lastExitAt;
          this.runtimes.delete(record.processId);
          await this.persist();
          this.emitLifecycleEvent(record, "stop");
          return handleOkResult(buildProcessResponse(record, { stopped: true }));
        }
        throw error;
      }
    }

    try {
      process.kill(record.pgid > 0 ? -record.pgid : record.pid, "SIGKILL");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ESRCH/i.test(message)) {
        return handleErrorResult(
          SYSTEM_PROCESS_FAMILY,
          "system_process.stop_failed",
          `Timed out waiting for process to stop: ${message}`,
          true,
          undefined,
          "stop",
        );
      }
    }

    record.state = "exited";
    record.signal = "SIGKILL";
    record.lastExitAt = this.now();
    record.updatedAt = record.lastExitAt;
    this.runtimes.delete(record.processId);
    await this.persist();
    this.emitLifecycleEvent(record, "stop");
    return handleOkResult(buildProcessResponse(record, { stopped: true, forced: true }));
  }

  async stopAll(): Promise<void> {
    await this.ensureLoaded();
    const records = [...this.records.values()];
    for (const record of records) {
      if (record.state === "running") {
        await this.stop({ processId: record.processId, signal: "SIGKILL", waitMs: 250 });
      }
    }
  }

  async resetForTesting(): Promise<void> {
    this.disposed = true;
    this.terminateTrackedProcesses();
    await Promise.allSettled([this.persistChain]);
    this.records.clear();
    this.runtimes.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    await rm(this.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  resetForTestingSync(): void {
    this.disposed = true;
    this.terminateTrackedProcesses();
    this.records.clear();
    this.runtimes.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    rmSync(this.rootDir, { recursive: true, force: true });
  }
}

export function createProcessTools(config?: SystemProcessToolConfig): Tool[] {
  const manager = new SystemProcessManager(config);

  return [
    {
      name: "system.processStart",
      description:
        "Start a long-running host process with a durable handle. Uses direct executable plus args only, returns processId/label/state/logPath, and supports idempotent start retries via idempotencyKey while the process is running.",
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
          label: {
            type: "string",
            description:
              "Stable human-readable handle label. Reclaimed automatically once the prior process exits.",
          },
          idempotencyKey: {
            type: "string",
            description: "Optional idempotency key for deduplicating repeated start requests.",
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
      name: "system.processStatus",
      description:
        "Inspect a durable host process handle and return state, pid/pgid, logPath, timestamps, and recent log output.",
      inputSchema: {
        type: "object",
        properties: {
          processId: { type: "string", description: "Process handle from system.processStart." },
          label: { type: "string", description: "Handle label from system.processStart." },
          idempotencyKey: {
            type: "string",
            description: "Idempotency key from system.processStart.",
          },
          maxLogBytes: { type: "number", description: "Optional recent log tail size in bytes." },
        },
      },
      execute: (args) => manager.status(asObject(args) ?? {}),
    },
    {
      name: "system.processResume",
      description:
        "Reattach to a durable host process handle and return current state plus recent log output. This does not relaunch exited or failed processes.",
      inputSchema: {
        type: "object",
        properties: {
          processId: { type: "string", description: "Process handle from system.processStart." },
          label: { type: "string", description: "Handle label from system.processStart." },
          idempotencyKey: {
            type: "string",
            description: "Idempotency key from system.processStart.",
          },
          maxLogBytes: { type: "number", description: "Optional recent log tail size in bytes." },
        },
      },
      execute: (args) => manager.resume(asObject(args) ?? {}),
    },
    {
      name: "system.processStop",
      description:
        "Stop a durable host process handle by processId or label. Sends SIGTERM first and escalates to SIGKILL after the wait window if needed.",
      inputSchema: {
        type: "object",
        properties: {
          processId: { type: "string", description: "Process handle from system.processStart." },
          label: { type: "string", description: "Handle label from system.processStart." },
          idempotencyKey: {
            type: "string",
            description: "Idempotency key from system.processStart.",
          },
          signal: { type: "string", description: "Optional initial signal, e.g. SIGTERM." },
          waitMs: { type: "number", description: "Optional graceful-stop wait window in milliseconds." },
        },
      },
      execute: (args) => manager.stop(asObject(args) ?? {}),
    },
    {
      name: "system.processLogs",
      description:
        "Read the recent persisted log tail for a durable host process handle.",
      inputSchema: {
        type: "object",
        properties: {
          processId: { type: "string", description: "Process handle from system.processStart." },
          label: { type: "string", description: "Handle label from system.processStart." },
          idempotencyKey: {
            type: "string",
            description: "Idempotency key from system.processStart.",
          },
          maxBytes: { type: "number", description: "Optional log tail size in bytes." },
          waitForOutputMs: {
            type: "number",
            description:
              "Optional bounded settle window in milliseconds to wait for fresh output from short-lived processes before returning logs.",
          },
        },
      },
      execute: (args) => manager.logs(asObject(args) ?? {}),
    },
  ];
}
