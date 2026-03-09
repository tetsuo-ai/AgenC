import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export type ProcessIdentityState = "running" | "exited";

export interface ProcessIdentitySnapshot {
  readonly pgid: number;
  readonly state: ProcessIdentityState;
  readonly startToken: string;
  readonly bootId?: string;
}

export interface RecordedProcessIdentity {
  readonly pgid: number;
  readonly processStartToken?: string;
  readonly processBootId?: string;
}

export interface ReadProcessIdentityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
}

const DEFAULT_PS_TIMEOUT_MS = 1_000;
const PS_COMMAND_CANDIDATES = ["/bin/ps", "/usr/bin/ps"] as const;
const PS_COMMAND =
  PS_COMMAND_CANDIDATES.find((candidate) => existsSync(candidate)) ??
  PS_COMMAND_CANDIDATES[0];

function parseProcStatSnapshot(raw: string): ProcessIdentitySnapshot {
  const trimmed = raw.trim();
  const closeParen = trimmed.lastIndexOf(")");
  if (closeParen < 0) {
    throw new Error("Invalid /proc stat format");
  }
  const tail = trimmed.slice(closeParen + 1).trim();
  const fields = tail.split(/\s+/);
  if (fields.length < 20) {
    throw new Error("Incomplete /proc stat payload");
  }
  const pgid = Number.parseInt(fields[2] ?? "", 10);
  if (!Number.isFinite(pgid) || pgid <= 0) {
    throw new Error("Invalid process group in /proc stat payload");
  }
  const startToken = fields[19];
  if (typeof startToken !== "string" || startToken.length === 0) {
    throw new Error("Missing process start token in /proc stat payload");
  }
  return {
    pgid,
    state: fields[0] === "Z" ? "exited" : "running",
    startToken,
  };
}

function findFirstPsLine(raw: string): string | null {
  for (const entry of raw.split("\n")) {
    const trimmed = entry.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function parsePsSnapshot(raw: string): ProcessIdentitySnapshot | null {
  const line = findFirstPsLine(raw);
  if (!line) {
    return null;
  }
  const fields = line.split(/\s+/);
  if (fields.length < 8) {
    throw new Error(`Unexpected ps output: ${line}`);
  }
  const pgid = Number.parseInt(fields[1] ?? "", 10);
  const stateToken = fields[2] ?? "";
  const startToken = fields.slice(3).join(" ").trim();
  if (!Number.isFinite(pgid) || pgid <= 0 || startToken.length === 0) {
    throw new Error(`Invalid ps output: ${line}`);
  }
  return {
    pgid,
    state: stateToken.startsWith("Z") ? "exited" : "running",
    startToken,
  };
}

async function readBootId(): Promise<string | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  try {
    const raw = await readFile("/proc/sys/kernel/random/boot_id", "utf8");
    const bootId = raw.trim();
    return bootId.length > 0 ? bootId : undefined;
  } catch {
    return undefined;
  }
}

async function readProcIdentitySnapshot(
  pid: number,
): Promise<ProcessIdentitySnapshot | null> {
  if (process.platform !== "linux") {
    return null;
  }
  try {
    const raw = await readFile(`/proc/${pid}/stat`, "utf8");
    const snapshot = parseProcStatSnapshot(raw);
    return {
      ...snapshot,
      bootId: await readBootId(),
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    if (code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function readPsIdentitySnapshot(
  pid: number,
  options: ReadProcessIdentityOptions,
): Promise<ProcessIdentitySnapshot | null> {
  return await new Promise<ProcessIdentitySnapshot | null>((resolve, reject) => {
    execFile(
      PS_COMMAND,
      ["-o", "pid=,pgid=,stat=,lstart=", "-p", String(pid)],
      {
        timeout: options.timeoutMs ?? DEFAULT_PS_TIMEOUT_MS,
        ...(options.env ? { env: options.env } : {}),
      },
      (error, stdout) => {
        if (error) {
          const code =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "number"
              ? error.code
              : undefined;
          if (code === 1) {
            resolve(null);
            return;
          }
          reject(error);
          return;
        }
        resolve(parsePsSnapshot(stdout));
      },
    );
  }).catch(() => null);
}

export async function readProcessIdentitySnapshot(
  pid: number,
  options: ReadProcessIdentityOptions = {},
): Promise<ProcessIdentitySnapshot | null> {
  const procSnapshot = await readProcIdentitySnapshot(pid);
  if (procSnapshot) {
    return procSnapshot;
  }
  return readPsIdentitySnapshot(pid, options);
}

export function hasRecordedProcessIdentity(
  record: Pick<RecordedProcessIdentity, "processStartToken">,
): boolean {
  return (
    typeof record.processStartToken === "string" &&
    record.processStartToken.length > 0
  );
}

export function processIdentityMatches(
  record: RecordedProcessIdentity,
  snapshot: ProcessIdentitySnapshot,
): boolean {
  if (!hasRecordedProcessIdentity(record)) {
    return false;
  }
  if (record.processStartToken !== snapshot.startToken) {
    return false;
  }
  if (record.pgid > 0 && snapshot.pgid > 0 && record.pgid !== snapshot.pgid) {
    return false;
  }
  if (
    typeof record.processBootId === "string" &&
    record.processBootId.length > 0 &&
    typeof snapshot.bootId === "string" &&
    snapshot.bootId.length > 0 &&
    record.processBootId !== snapshot.bootId
  ) {
    return false;
  }
  return true;
}
