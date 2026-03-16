import { spawn } from "node:child_process";
import {
  readFile,
  writeFile,
  unlink,
  mkdir,
  access,
  open as openFile,
  rename,
} from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  processIdentityMatches,
  readProcessIdentitySnapshot,
} from "@agenc/sdk";
import type { ToolResult } from "./types.js";
import {
  DISPLAY,
  exec,
  ok,
  fail,
  warnBestEffort,
  truncateOutput,
  shellQuote,
  sleep,
} from "./tools-shared.js";

const BASH_TIMEOUT_MS = 600_000;
const DETACHED_PID_CAPTURE_TIMEOUT_MS = 500;
const DETACHED_PID_CAPTURE_POLL_MS = 25;
const MANAGED_PROCESS_DIR = "/tmp/agenc-processes";
const MANAGED_PROCESS_REGISTRY_PATH = `${MANAGED_PROCESS_DIR}/registry.json`;
const MANAGED_PROCESS_STARTUP_CHECK_MS = 300;
const MANAGED_PROCESS_POLL_MS = 100;
const MANAGED_PROCESS_DEFAULT_STOP_GRACE_MS = 2_000;
const MANAGED_PROCESS_MAX_STOP_GRACE_MS = 30_000;
const MANAGED_PROCESS_TAIL_BYTES = 8 * 1024;
const DEFAULT_MANAGED_PROCESS_CWD = "/workspace";
const GUI_LAUNCH_CMD_RE =
  /^\s*(?:sudo\s+)?(?:env\s+[^;]+\s+)?(?:nohup\s+|setsid\s+)?(?:xfce4-terminal|gnome-terminal|xterm|kitty|firefox|chromium|chromium-browser|google-chrome|thunar|nautilus|mousepad|gedit)\b/i;
const BACKGROUND_COMMAND_RE =
  /&\s*(?:disown\s*)?(?:(?:;|&&)?\s*echo\s+\$!(?:\s*(?:1?>|1>>|>>)\s*(?:[^\s&]+|'[^']+'|"[^"]+"))?\s*)?$/;
const APT_PREFIX_RE =
  /^\s*(?:sudo\s+)?(?:(?:DEBIAN_FRONTEND|APT_LISTCHANGES_FRONTEND)=[^\s]+\s+)*(?:apt-get|apt)\b/i;
const PROCESS_SHELL_WRAPPER_COMMANDS = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "fish",
  "csh",
  "ksh",
  "tcsh",
]);
const PROCESS_SIGNAL_NAMES = new Set([
  "SIGTERM",
  "SIGINT",
  "SIGKILL",
  "SIGHUP",
]);
const CHROMIUM_PROCESS_COMMANDS = new Set([
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
]);
const CHROMIUM_DISALLOWED_FLAGS = new Set([
  "--no-sandbox",
  "--disable-setuid-sandbox",
]);
const CHROMIUM_DETERMINISTIC_FLAGS = [
  "--new-window",
  "--incognito",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-sync",
];

type ManagedProcessState = "running" | "exited";

interface ManagedProcessRecord {
  processId: string;
  label?: string;
  idempotencyKey?: string;
  command: string;
  args: string[];
  cwd: string;
  logPath: string;
  pid: number;
  pgid: number;
  processStartToken?: string;
  processBootId?: string;
  state: ManagedProcessState;
  startedAt: number;
  endedAt?: number;
  exitCode?: number | null;
  signal?: string | null;
  envKeys?: string[];
  launchFingerprint: string;
}

export interface DesktopToolEvent {
  readonly type: "managed_process.exited";
  readonly timestamp: number;
  readonly payload: {
    readonly processId: string;
    readonly label?: string;
    readonly idempotencyKey?: string;
    readonly pid: number;
    readonly pgid: number;
    readonly state: ManagedProcessState;
    readonly startedAt: number;
    readonly endedAt?: number;
    readonly exitCode?: number | null;
    readonly signal?: string | null;
    readonly logPath: string;
  };
}

type DesktopToolEventListener = (event: DesktopToolEvent) => void;

let managedProcessesLoaded = false;
const managedProcesses = new Map<string, ManagedProcessRecord>();
let managedProcessRegistryPersistChain: Promise<void> = Promise.resolve();
const desktopToolEventListeners = new Set<DesktopToolEventListener>();

export function subscribeDesktopToolEvents(
  listener: DesktopToolEventListener,
): () => void {
  desktopToolEventListeners.add(listener);
  return () => {
    desktopToolEventListeners.delete(listener);
  };
}

function emitDesktopToolEvent(event: DesktopToolEvent): void {
  for (const listener of [...desktopToolEventListeners]) {
    try {
      listener(event);
    } catch (error) {
      warnBestEffort("desktop tool event listener failed", error);
    }
  }
}

function normalizeAptCommand(command: string): string {
  const trimmed = command.trim();
  if (!APT_PREFIX_RE.test(trimmed)) {
    return command;
  }

  let normalized = trimmed;
  if (!/^sudo\b/i.test(normalized)) {
    normalized = `sudo ${normalized}`;
  }

  normalized = normalized.replace(
    /^sudo\s+((?:DEBIAN_FRONTEND|APT_LISTCHANGES_FRONTEND)=[^\s]+\s+)*apt\s+/i,
    (_full, envPrefix: string) => `sudo ${envPrefix ?? ""}apt-get `,
  );

  const isInstall = /^sudo\s+.*apt-get\s+install\b/i.test(normalized);
  if (!isInstall) {
    return normalized;
  }

  const hasYesFlag = /\s(?:-y|--yes)\b/i.test(normalized);
  if (!hasYesFlag) {
    normalized = normalized.replace(/\binstall\b/i, "install -y");
  }

  const alreadyUpdates =
    /\bapt(?:-get)?\s+update\b/i.test(normalized) ||
    /\b&&\s*sudo\s+.*apt-get\s+install\b/i.test(normalized);
  if (alreadyUpdates) {
    return normalized;
  }

  return `sudo apt-get update && ${normalized}`;
}

async function ensureManagedProcessRegistryLoaded(): Promise<void> {
  if (managedProcessesLoaded) return;
  managedProcessesLoaded = true;
  try {
    const raw = await readFile(MANAGED_PROCESS_REGISTRY_PATH, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      warnBestEffort("managed process registry load failed", "registry was not an array");
      return;
    }
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        continue;
      }
      const record = entry as Partial<ManagedProcessRecord>;
      if (
        typeof record.processId !== "string" ||
        typeof record.command !== "string" ||
        !Array.isArray(record.args) ||
        typeof record.cwd !== "string" ||
        typeof record.logPath !== "string" ||
        typeof record.pid !== "number" ||
        typeof record.pgid !== "number" ||
        typeof record.state !== "string" ||
        typeof record.startedAt !== "number"
      ) {
        continue;
      }
      managedProcesses.set(record.processId, {
        processId: record.processId,
        label: typeof record.label === "string" ? record.label : undefined,
        idempotencyKey:
          typeof record.idempotencyKey === "string"
            ? record.idempotencyKey
            : undefined,
        command: record.command,
        args: record.args.filter((arg): arg is string => typeof arg === "string"),
        cwd: record.cwd,
        logPath: record.logPath,
        pid: record.pid,
        pgid: record.pgid,
        processStartToken:
          typeof record.processStartToken === "string" &&
          record.processStartToken.length > 0
            ? record.processStartToken
            : undefined,
        processBootId:
          typeof record.processBootId === "string" &&
          record.processBootId.length > 0
            ? record.processBootId
            : undefined,
        state: record.state === "running" ? "running" : "exited",
        startedAt: record.startedAt,
        endedAt: typeof record.endedAt === "number" ? record.endedAt : undefined,
        exitCode:
          typeof record.exitCode === "number" || record.exitCode === null
            ? record.exitCode
            : undefined,
        signal:
          typeof record.signal === "string" || record.signal === null
            ? record.signal
            : undefined,
        envKeys: Array.isArray(record.envKeys)
          ? record.envKeys.filter((key): key is string => typeof key === "string")
          : undefined,
        launchFingerprint:
          typeof record.launchFingerprint === "string" &&
          record.launchFingerprint.length > 0
            ? record.launchFingerprint
            : buildManagedProcessLaunchFingerprint({
                command: record.command,
                args: record.args.filter(
                  (arg): arg is string => typeof arg === "string",
                ),
                cwd: record.cwd,
                envKeys: Array.isArray(record.envKeys)
                  ? record.envKeys.filter(
                      (key): key is string => typeof key === "string",
                    )
                  : undefined,
              }),
      });
    }
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    warnBestEffort("managed process registry load failed", error);
  }
}

function cloneManagedProcessRecord(
  record: ManagedProcessRecord,
): ManagedProcessRecord {
  return {
    ...record,
    args: [...record.args],
    ...(record.envKeys ? { envKeys: [...record.envKeys] } : {}),
  };
}

function snapshotManagedProcessRegistry(): ManagedProcessRecord[] {
  return Array.from(managedProcesses.values())
    .map((record) => cloneManagedProcessRecord(record))
    .sort((a, b) => a.startedAt - b.startedAt);
}

async function syncManagedProcessDirectory(): Promise<void> {
  try {
    const handle = await openFile(MANAGED_PROCESS_DIR, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    warnBestEffort("managed process registry directory sync failed", error);
  }
}

async function writeManagedProcessRegistryAtomically(
  records: readonly ManagedProcessRecord[],
): Promise<void> {
  const tempPath =
    `${MANAGED_PROCESS_REGISTRY_PATH}.${process.pid}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof openFile>> | null = null;
  try {
    handle = await openFile(tempPath, "w");
    await handle.writeFile(JSON.stringify(records, null, 2), "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(tempPath, MANAGED_PROCESS_REGISTRY_PATH);
    await syncManagedProcessDirectory();
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
      handle = null;
    }
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function persistManagedProcessRegistry(): Promise<void> {
  const persist = async (): Promise<void> => {
    await mkdir(MANAGED_PROCESS_DIR, { recursive: true });
    const records = snapshotManagedProcessRegistry();
    await writeManagedProcessRegistryAtomically(records);
  };

  const nextPersist = managedProcessRegistryPersistChain.then(persist, persist);
  managedProcessRegistryPersistChain = nextPersist.catch(() => undefined);
  return nextPersist;
}

function commandBasename(command: string): string {
  return basename(command.trim()).toLowerCase();
}

function normalizeManagedProcessSignal(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "SIGTERM";
  }
  const upper = value.trim().toUpperCase();
  const normalized = upper.startsWith("SIG") ? upper : `SIG${upper}`;
  if (!PROCESS_SIGNAL_NAMES.has(normalized)) {
    throw new Error(
      `signal must be one of: ${Array.from(PROCESS_SIGNAL_NAMES).join(", ")}`,
    );
  }
  return normalized;
}

function normalizeManagedProcessGraceMs(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return MANAGED_PROCESS_DEFAULT_STOP_GRACE_MS;
  }
  return Math.min(
    MANAGED_PROCESS_MAX_STOP_GRACE_MS,
    Math.max(0, Math.floor(value)),
  );
}

async function resolveManagedProcessCwd(input: unknown): Promise<string> {
  if (typeof input === "string" && input.trim().length > 0) {
    const cwd = input.trim();
    if (!isAbsolute(cwd)) {
      throw new Error("cwd must be an absolute path");
    }
    return cwd;
  }

  try {
    await access(DEFAULT_MANAGED_PROCESS_CWD);
    return DEFAULT_MANAGED_PROCESS_CWD;
  } catch {
    try {
      await access("/home/agenc");
      return "/home/agenc";
    } catch {
      return process.cwd();
    }
  }
}

function normalizeManagedProcessArgs(input: unknown): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) {
    throw new Error("args must be an array of strings");
  }
  return input.map((value) => {
    if (value === null || value === undefined) {
      throw new Error("args entries must be strings");
    }
    return String(value);
  });
}

function normalizeManagedProcessEnv(
  input: unknown,
): Record<string, string> | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("env must be an object of string values");
  }

  const envEntries = Object.entries(input as Record<string, unknown>);
  const normalized: Record<string, string> = {};
  for (const [key, value] of envEntries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`env key "${key}" is invalid`);
    }
    if (value === null || value === undefined) {
      throw new Error(`env value for "${key}" must be a string`);
    }
    normalized[key] = String(value);
  }
  return normalized;
}

function normalizeManagedProcessCommand(command: unknown): string {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new Error("command is required");
  }
  const trimmed = command.trim();
  if (/\s/.test(trimmed)) {
    throw new Error(
      "command must be one executable token/path. Put flags and operands in args, or use desktop.bash for shell scripts.",
    );
  }
  const base = commandBasename(trimmed);
  if (PROCESS_SHELL_WRAPPER_COMMANDS.has(base)) {
    throw new Error(
      "Shell wrapper commands like bash/sh/zsh are not allowed in process_start. Use a real executable + args, or desktop.bash for shell logic.",
    );
  }
  return trimmed;
}

function normalizeManagedProcessLabel(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeManagedProcessIdempotencyKey(
  input: unknown,
): string | undefined {
  if (typeof input !== "string") return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeManagedProcessLogPath(
  input: unknown,
  processId: string,
): string {
  if (typeof input === "string" && input.trim().length > 0) {
    const logPath = input.trim();
    if (!isAbsolute(logPath)) {
      throw new Error("logPath must be an absolute path");
    }
    return logPath;
  }
  return `${MANAGED_PROCESS_DIR}/${processId}.log`;
}

function buildManagedProcessLaunchFingerprint(params: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly envKeys?: readonly string[];
}): string {
  const payload = JSON.stringify({
    command: params.command,
    args: [...params.args],
    cwd: params.cwd,
    envKeys: params.envKeys ? [...params.envKeys].sort() : [],
  });
  return createHash("sha256").update(payload).digest("hex");
}

function normalizeChromiumProcessArgs(
  command: string,
  args: readonly string[],
): string[] {
  if (!CHROMIUM_PROCESS_COMMANDS.has(commandBasename(command))) {
    return [...args];
  }

  const nextArgs: string[] = [];
  let hasUserDataDir = false;
  for (const arg of args) {
    const normalized = arg.trim();
    if (CHROMIUM_DISALLOWED_FLAGS.has(normalized)) continue;
    if (normalized.startsWith("--user-data-dir=") || normalized === "--user-data-dir") {
      hasUserDataDir = true;
    }
    nextArgs.push(arg);
  }

  for (const flag of CHROMIUM_DETERMINISTIC_FLAGS) {
    if (!nextArgs.includes(flag)) {
      nextArgs.push(flag);
    }
  }

  if (!hasUserDataDir) {
    nextArgs.push(
      `--user-data-dir=/tmp/agenc-chrome-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`,
    );
  }

  return nextArgs;
}

async function readFileTail(
  path: string,
  maxBytes = MANAGED_PROCESS_TAIL_BYTES,
): Promise<string> {
  try {
    const handle = await openFile(path, "r");
    try {
      const fileStat = await handle.stat();
      if (fileStat.size <= 0) return "";
      const bytes = Math.min(fileStat.size, maxBytes);
      const buffer = Buffer.alloc(bytes);
      await handle.read(buffer, 0, bytes, fileStat.size - bytes);
      return buffer.toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

async function inspectManagedProcessState(
  record: ManagedProcessRecord,
): Promise<ManagedProcessState> {
  const snapshot = await readProcessIdentitySnapshot(record.pid, {
    env: { ...process.env, DISPLAY },
  });
  if (snapshot?.state !== "running") {
    return "exited";
  }
  if (!processIdentityMatches(record, snapshot)) {
    return "exited";
  }
  return "running";
}

async function refreshManagedProcessRecord(
  record: ManagedProcessRecord,
): Promise<ManagedProcessRecord> {
  const runtimeState = await inspectManagedProcessState(record);
  if (runtimeState === record.state) {
    return record;
  }

  const nextRecord: ManagedProcessRecord = {
    ...record,
    state: runtimeState,
    endedAt:
      runtimeState === "exited"
        ? record.endedAt ?? Date.now()
        : record.endedAt,
  };
  managedProcesses.set(record.processId, nextRecord);
  await persistManagedProcessRegistry();
  return nextRecord;
}

function compareManagedProcessRecency(
  left: ManagedProcessRecord,
  right: ManagedProcessRecord,
): number {
  if (left.state === "running" && right.state !== "running") return -1;
  if (left.state !== "running" && right.state === "running") return 1;
  const leftUpdatedAt = left.endedAt ?? left.startedAt;
  const rightUpdatedAt = right.endedAt ?? right.startedAt;
  return rightUpdatedAt - leftUpdatedAt;
}

function findManagedProcessRecord(
  predicate: (record: ManagedProcessRecord) => boolean,
): ManagedProcessRecord | undefined {
  return Array.from(managedProcesses.values())
    .filter(predicate)
    .sort(compareManagedProcessRecency)[0];
}

function findManagedProcessRecordByLabel(
  label: string,
): ManagedProcessRecord | undefined {
  return findManagedProcessRecord((record) => record.label === label);
}

function findManagedProcessRecordByIdempotencyKey(
  idempotencyKey: string,
): ManagedProcessRecord | undefined {
  return findManagedProcessRecord(
    (record) => record.idempotencyKey === idempotencyKey,
  );
}

function findManagedProcessRecordByPid(
  pid: number,
): ManagedProcessRecord | undefined {
  return findManagedProcessRecord((record) => record.pid === pid);
}

async function resolveManagedProcessRecord(
  args: Record<string, unknown>,
): Promise<ManagedProcessRecord> {
  await ensureManagedProcessRegistryLoaded();

  const processId =
    typeof args.processId === "string" && args.processId.trim().length > 0
      ? args.processId.trim()
      : undefined;
  const label =
    typeof args.label === "string" && args.label.trim().length > 0
      ? args.label.trim()
      : undefined;
  const idempotencyKey =
    typeof args.idempotencyKey === "string" && args.idempotencyKey.trim().length > 0
      ? args.idempotencyKey.trim()
      : undefined;
  const pid =
    typeof args.pid === "number" && Number.isFinite(args.pid)
      ? Math.floor(args.pid)
      : undefined;

  let record: ManagedProcessRecord | undefined;
  if (processId) {
    record = managedProcesses.get(processId);
  } else if (idempotencyKey) {
    record = findManagedProcessRecordByIdempotencyKey(idempotencyKey);
  } else if (label) {
    record = findManagedProcessRecordByLabel(label);
  } else if (pid && pid > 0) {
    record = findManagedProcessRecordByPid(pid);
  } else {
    throw new Error("processId, idempotencyKey, label, or pid is required");
  }

  if (!record) {
    throw new Error("Managed process not found");
  }
  return refreshManagedProcessRecord(record);
}

async function waitForManagedProcessExit(
  record: ManagedProcessRecord,
  timeoutMs: number,
): Promise<ManagedProcessRecord> {
  const deadline = Date.now() + timeoutMs;
  let current = record;
  while (Date.now() < deadline) {
    current = await refreshManagedProcessRecord(current);
    if (current.state !== "running") {
      return current;
    }
    await sleep(MANAGED_PROCESS_POLL_MS);
  }
  return refreshManagedProcessRecord(current);
}

async function finalizeManagedProcessExit(
  processId: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): Promise<void> {
  await ensureManagedProcessRegistryLoaded();
  const record = managedProcesses.get(processId);
  if (!record) return;
  if (record.state === "exited" && typeof record.endedAt === "number") {
    return;
  }
  const exitedRecord: ManagedProcessRecord = {
    ...record,
    state: "exited",
    endedAt: record.endedAt ?? Date.now(),
    exitCode,
    signal,
  };
  managedProcesses.set(processId, exitedRecord);
  await persistManagedProcessRegistry();
  emitDesktopToolEvent({
    type: "managed_process.exited",
    timestamp: exitedRecord.endedAt ?? Date.now(),
    payload: {
      processId: exitedRecord.processId,
      ...(exitedRecord.label ? { label: exitedRecord.label } : {}),
      ...(exitedRecord.idempotencyKey
        ? { idempotencyKey: exitedRecord.idempotencyKey }
        : {}),
      pid: exitedRecord.pid,
      pgid: exitedRecord.pgid,
      state: exitedRecord.state,
      startedAt: exitedRecord.startedAt,
      ...(typeof exitedRecord.endedAt === "number"
        ? { endedAt: exitedRecord.endedAt }
        : {}),
      ...(exitedRecord.exitCode !== undefined
        ? { exitCode: exitedRecord.exitCode }
        : {}),
      ...(exitedRecord.signal !== undefined
        ? { signal: exitedRecord.signal }
        : {}),
      logPath: exitedRecord.logPath,
    },
  });
}

function buildManagedProcessResponse(
  record: ManagedProcessRecord,
  recentOutput: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    processId: record.processId,
    ...(record.label ? { label: record.label } : {}),
    ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
    command: record.command,
    args: record.args,
    cwd: record.cwd,
    pid: record.pid,
    pgid: record.pgid,
    state: record.state,
    startedAt: record.startedAt,
    ...(typeof record.endedAt === "number" ? { endedAt: record.endedAt } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {}),
    ...(record.envKeys && record.envKeys.length > 0 ? { envKeys: record.envKeys } : {}),
    logPath: record.logPath,
    recentOutput: truncateOutput(recentOutput),
    ...extra,
  };
}

// --- Tool implementations ---

async function readCapturedPid(
  capturePath: string,
  timeoutMs = DETACHED_PID_CAPTURE_TIMEOUT_MS,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = (await readFile(capturePath, "utf8")).trim();
      if (raw.length > 0) {
        const pid = Number.parseInt(raw.split(/\s+/, 1)[0] ?? "", 10);
        if (Number.isFinite(pid) && pid > 0) {
          return pid;
        }
      }
    } catch {
      // file may not exist yet
    }
    await sleep(DETACHED_PID_CAPTURE_POLL_MS);
  }
  return undefined;
}

async function spawnDetachedCommand(
  command: string,
  logPath: string,
  options?: { wrapAsBackground?: boolean; cwd?: string },
): Promise<{
  pid?: number;
  launcherPid?: number;
  backgroundPid?: number;
  pidSemantics?: "background_process" | "launcher_shell";
}> {
  const captureId = randomUUID().slice(0, 8);
  const scriptPath = `/tmp/agenc-detached-${captureId}.sh`;
  const capturePath = `/tmp/agenc-detached-${captureId}.pid`;
  const wrappedCommand = options?.wrapAsBackground ? `${command} &` : command;
  const scriptBody =
    `${wrappedCommand}\n` +
    `printf '%s\\n' "$!" > ${shellQuote(capturePath)}\n`;

  const stdoutFd = openSync(logPath, "a");
  const stderrFd = openSync(logPath, "a");
  try {
    await writeFile(scriptPath, scriptBody, { mode: 0o700 });

    const child = spawn("/bin/bash", [scriptPath], {
      env: { ...process.env, DISPLAY },
      detached: true,
      stdio: ["ignore", stdoutFd, stderrFd],
      ...(options?.cwd ? { cwd: options.cwd } : {}),
    });
    child.unref();
    const launcherPid =
      typeof child.pid === "number" && Number.isFinite(child.pid)
        ? child.pid
        : undefined;
    const backgroundPid = await readCapturedPid(capturePath);
    const pid = backgroundPid ?? launcherPid;
    return {
      ...(Number.isFinite(pid) ? { pid } : {}),
      ...(Number.isFinite(launcherPid) ? { launcherPid } : {}),
      ...(Number.isFinite(backgroundPid) ? { backgroundPid } : {}),
      ...(pid !== undefined
        ? {
          pidSemantics: backgroundPid !== undefined
            ? "background_process" as const
            : "launcher_shell" as const,
        }
        : {}),
    };
  } finally {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    unlink(scriptPath).catch((error) => {
      warnBestEffort("detached script cleanup failed", error);
    });
    unlink(capturePath).catch(() => {
      // capture file is best-effort and may legitimately never exist
    });
  }
}

export async function bash(args: Record<string, unknown>): Promise<ToolResult> {
  const command = String(args.command ?? "");
  if (!command) return fail("command is required");
  const normalizedCommand = normalizeAptCommand(command);
  const cwd = await resolveManagedProcessCwd(args.cwd);
  const timeoutMs = Number(args.timeoutMs ?? BASH_TIMEOUT_MS);

  // GUI launch commands should be detached automatically so the tool call
  // doesn't block on an interactive app (e.g. `xfce4-terminal`).
  const trimmed = normalizedCommand.trim();
  const alreadyBackgrounded = BACKGROUND_COMMAND_RE.test(trimmed);
  const autoDetachGui = GUI_LAUNCH_CMD_RE.test(trimmed) && !alreadyBackgrounded;

  try {
    // For explicit background commands, run via a detached wrapper so the tool
    // returns immediately instead of waiting on inherited pipes/job control.
    if (alreadyBackgrounded) {
      await mkdir("/tmp/agenc-bg", { recursive: true });
      const { pid, launcherPid, backgroundPid, pidSemantics } = await spawnDetachedCommand(
        trimmed,
        "/tmp/agenc-bg/last-background.log",
        { cwd },
      );
      return ok({
        stdout: "",
        stderr: "",
        exitCode: 0,
        backgrounded: true,
        ...(Number.isFinite(pid) ? { pid } : {}),
        ...(Number.isFinite(launcherPid) ? { launcherPid } : {}),
        ...(Number.isFinite(backgroundPid) ? { backgroundPid } : {}),
        ...(pidSemantics ? { pidSemantics } : {}),
      });
    }

    if (autoDetachGui) {
      await mkdir("/tmp/agenc-gui", { recursive: true });
      const { pid, launcherPid, backgroundPid, pidSemantics } = await spawnDetachedCommand(
        trimmed,
        "/tmp/agenc-gui/last-launch.log",
        { wrapAsBackground: true, cwd },
      );
      return ok({
        stdout: "",
        stderr: "",
        exitCode: 0,
        backgrounded: true,
        ...(Number.isFinite(pid) ? { pid } : {}),
        ...(Number.isFinite(launcherPid) ? { launcherPid } : {}),
        ...(Number.isFinite(backgroundPid) ? { backgroundPid } : {}),
        ...(pidSemantics ? { pidSemantics } : {}),
      });
    }

    // Run foreground commands via a temp script file instead of `bash -c`
    // to prevent pkill/pgrep self-matching against /proc/self/cmdline.
    const scriptId = randomUUID().slice(0, 8);
    const scriptPath = `/tmp/agenc-cmd-${scriptId}.sh`;
    await writeFile(scriptPath, normalizedCommand, { mode: 0o700 });
    try {
      const { stdout, stderr } = await exec(
        "/bin/bash",
        [scriptPath],
        timeoutMs,
        cwd,
      );
      return ok({
        stdout: truncateOutput(stdout),
        stderr: truncateOutput(stderr),
        exitCode: 0,
      });
    } finally {
      unlink(scriptPath).catch((error) => {
        warnBestEffort("temporary script cleanup failed", error);
      });
    }
  } catch (e: unknown) {
    // Non-zero exit codes are reported, not thrown
    const err = e as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      message?: string;
    };
    if (err.code !== undefined && typeof err.code === "number") {
      return ok({
        stdout: truncateOutput(err.stdout ?? ""),
        stderr: truncateOutput(err.stderr ?? ""),
        exitCode: err.code,
      });
    }
    const message = String(err.message ?? e ?? "");
    if (
      err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
      message.includes("maxBuffer length exceeded")
    ) {
      return ok({
        stdout: truncateOutput(err.stdout ?? ""),
        stderr: truncateOutput(err.stderr ?? ""),
        exitCode: 0,
        truncated: true,
      });
    }
    return fail(`bash failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function processStart(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    await ensureManagedProcessRegistryLoaded();

    const command = normalizeManagedProcessCommand(args.command);
    const normalizedArgs = normalizeChromiumProcessArgs(
      command,
      normalizeManagedProcessArgs(args.args),
    );
    const cwd = await resolveManagedProcessCwd(args.cwd);
    const env = normalizeManagedProcessEnv(args.env);
    const label = normalizeManagedProcessLabel(args.label);
    const idempotencyKey = normalizeManagedProcessIdempotencyKey(args.idempotencyKey);
    const processId = `proc_${randomUUID().slice(0, 8)}`;
    const logPath = normalizeManagedProcessLogPath(args.logPath, processId);
    const envKeys = env ? Object.keys(env).sort() : undefined;
    const launchFingerprint = buildManagedProcessLaunchFingerprint({
      command,
      args: normalizedArgs,
      cwd,
      envKeys,
    });

    const matchesLaunchSpec = (record: ManagedProcessRecord): boolean =>
      record.launchFingerprint === launchFingerprint;

    if (idempotencyKey) {
      const existing = findManagedProcessRecordByIdempotencyKey(idempotencyKey);
      if (existing) {
        const refreshed = await refreshManagedProcessRecord(existing);
        if (matchesLaunchSpec(refreshed) && refreshed.state === "running") {
          const recentOutput = await readFileTail(refreshed.logPath);
          return ok(
            buildManagedProcessResponse(refreshed, recentOutput, {
              reused: true,
            }),
          );
        }
        return fail("A managed process already exists for that idempotencyKey.");
      }
    }

    if (label) {
      const existing = findManagedProcessRecordByLabel(label);
      if (existing) {
        const refreshed = await refreshManagedProcessRecord(existing);
        if (
          refreshed.idempotencyKey === idempotencyKey &&
          matchesLaunchSpec(refreshed) &&
          refreshed.state === "running"
        ) {
          const recentOutput = await readFileTail(refreshed.logPath);
          return ok(
            buildManagedProcessResponse(refreshed, recentOutput, {
              reused: true,
            }),
          );
        }
        if (refreshed.state === "running") {
          return fail("A managed process already exists for that label.");
        }
      }
    }

    await mkdir(dirname(logPath), { recursive: true });
    await mkdir(MANAGED_PROCESS_DIR, { recursive: true });

    const stdoutFd = openSync(logPath, "a");
    const stderrFd = openSync(logPath, "a");
    try {
      const child = spawn(command, normalizedArgs, {
        cwd,
        env: { ...process.env, DISPLAY, ...(env ?? {}) },
        detached: true,
        stdio: ["ignore", stdoutFd, stderrFd],
      });
      child.unref();

      if (!child.pid || !Number.isFinite(child.pid)) {
        return fail("Failed to start managed process");
      }

      const record: ManagedProcessRecord = {
        processId,
        ...(label ? { label } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        command,
        args: normalizedArgs,
        cwd,
        logPath,
        pid: child.pid,
        pgid: child.pid,
        state: "running",
        startedAt: Date.now(),
        ...(envKeys ? { envKeys } : {}),
        launchFingerprint,
      };
      const identitySnapshot = await readProcessIdentitySnapshot(child.pid, {
        env: { ...process.env, DISPLAY },
      });
      if (identitySnapshot) {
        record.pgid = identitySnapshot.pgid;
        record.processStartToken = identitySnapshot.startToken;
        if (identitySnapshot.bootId) {
          record.processBootId = identitySnapshot.bootId;
        }
      }

      managedProcesses.set(processId, record);
      await persistManagedProcessRegistry();

      child.on("exit", (exitCode, signal) => {
        void finalizeManagedProcessExit(processId, exitCode, signal);
      });
      child.on("error", (error) => {
        warnBestEffort(`managed process ${processId} error`, error);
        void finalizeManagedProcessExit(processId, null, null);
      });

      await sleep(MANAGED_PROCESS_STARTUP_CHECK_MS);
      const refreshed = await refreshManagedProcessRecord(record);
      const recentOutput = await readFileTail(refreshed.logPath);
      if (refreshed.state !== "running") {
        return {
          content: JSON.stringify(
            buildManagedProcessResponse(refreshed, recentOutput, {
              error:
                "Managed process exited during startup. Use desktop.process_status to inspect logs or desktop.bash for short-lived shell commands.",
            }),
          ),
          isError: true,
        };
      }

      return ok(
        buildManagedProcessResponse(refreshed, recentOutput, {
          started: true,
        }),
      );
    } finally {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
  } catch (error) {
    return fail(
      `process_start failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export async function processStatus(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const record = await resolveManagedProcessRecord(args);
    const recentOutput = await readFileTail(record.logPath);
    return ok(
      buildManagedProcessResponse(record, recentOutput, {
        running: record.state === "running",
      }),
    );
  } catch (error) {
    return fail(
      `process_status failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

export async function processStop(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  try {
    const signal = normalizeManagedProcessSignal(args.signal);
    const gracePeriodMs = normalizeManagedProcessGraceMs(args.gracePeriodMs);
    const record = await resolveManagedProcessRecord(args);
    const recentOutputBeforeStop = await readFileTail(record.logPath);

    if (record.state !== "running") {
      return ok(
        buildManagedProcessResponse(record, recentOutputBeforeStop, {
          stopped: false,
          alreadyExited: true,
        }),
      );
    }

    let forced = false;
    try {
      process.kill(-Math.abs(record.pgid), signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.toLowerCase().includes("esrch")) {
        throw error;
      }
    }

    let refreshed = await waitForManagedProcessExit(record, gracePeriodMs);
    if (refreshed.state === "running" && signal !== "SIGKILL") {
      forced = true;
      try {
        process.kill(-Math.abs(refreshed.pgid), "SIGKILL");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("esrch")) {
          throw error;
        }
      }
      refreshed = await waitForManagedProcessExit(refreshed, 2_000);
    }

    const recentOutput = await readFileTail(refreshed.logPath);
    return ok(
      buildManagedProcessResponse(refreshed, recentOutput, {
        stopped: refreshed.state !== "running",
        signalSent: signal,
        forced,
      }),
    );
  } catch (error) {
    return fail(
      `process_stop failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/** @internal Exposed for testing only. */
export const __managedProcessTestHooks = {
  async reset(): Promise<void> {
    managedProcesses.clear();
    managedProcessesLoaded = true;
    managedProcessRegistryPersistChain = Promise.resolve();
    await unlink(MANAGED_PROCESS_REGISTRY_PATH).catch(() => undefined);
  },
  seed(records: readonly ManagedProcessRecord[]): void {
    managedProcesses.clear();
    managedProcessesLoaded = true;
    for (const record of records) {
      managedProcesses.set(record.processId, cloneManagedProcessRecord(record));
    }
  },
  persist(): Promise<void> {
    return persistManagedProcessRegistry();
  },
  finalizeExit(
    processId: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    return finalizeManagedProcessExit(processId, exitCode, signal);
  },
  getRegistryPath(): string {
    return MANAGED_PROCESS_REGISTRY_PATH;
  },
  snapshot(): ManagedProcessRecord[] {
    return snapshotManagedProcessRegistry();
  },
};
