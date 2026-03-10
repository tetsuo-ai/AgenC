import { execFile, spawn } from "node:child_process";
import { readFile, writeFile, unlink, mkdir, stat, access, open as openFile, rename, } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { processIdentityMatches, readProcessIdentitySnapshot, } from "@agenc/sdk";
import { resolveValidatedTextEditorPath } from "./textEditorPath.js";
const DISPLAY = process.env.DISPLAY ?? ":1";
const EXEC_TIMEOUT_MS = 30_000;
const BASH_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB
const MAX_EXEC_BUFFER_BYTES = 1024 * 1024; // 1MB capture headroom
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
const TYPE_CHUNK_SIZE = 50;
const TYPE_DELAY_MS = 12;
const GUI_LAUNCH_CMD_RE = /^\s*(?:sudo\s+)?(?:env\s+[^;]+\s+)?(?:nohup\s+|setsid\s+)?(?:xfce4-terminal|gnome-terminal|xterm|kitty|firefox|chromium|chromium-browser|google-chrome|thunar|nautilus|mousepad|gedit)\b/i;
const BACKGROUND_COMMAND_RE = /&\s*(?:disown\s*)?(?:(?:;|&&)?\s*echo\s+\$!(?:\s*(?:1?>|1>>|>>)\s*(?:[^\s&]+|'[^']+'|"[^"]+"))?\s*)?$/;
const APT_PREFIX_RE = /^\s*(?:sudo\s+)?(?:(?:DEBIAN_FRONTEND|APT_LISTCHANGES_FRONTEND)=[^\s]+\s+)*(?:apt-get|apt)\b/i;
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
let managedProcessesLoaded = false;
const managedProcesses = new Map();
let managedProcessRegistryPersistChain = Promise.resolve();
const desktopToolEventListeners = new Set();
export function subscribeDesktopToolEvents(listener) {
    desktopToolEventListeners.add(listener);
    return () => {
        desktopToolEventListeners.delete(listener);
    };
}
function emitDesktopToolEvent(event) {
    for (const listener of [...desktopToolEventListeners]) {
        try {
            listener(event);
        }
        catch (error) {
            warnBestEffort("desktop tool event listener failed", error);
        }
    }
}
function exec(cmd, args, timeoutMs = EXEC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, {
            timeout: timeoutMs,
            maxBuffer: MAX_EXEC_BUFFER_BYTES,
            env: { ...process.env, DISPLAY },
        }, (err, stdout, stderr) => {
            if (err) {
                const enriched = err;
                // Preserve callback streams for non-zero exits. Some Node runtimes
                // do not reliably populate err.stdout/err.stderr on execFile errors.
                if (typeof enriched.stdout !== "string") {
                    enriched.stdout = stdout ?? "";
                }
                if (typeof enriched.stderr !== "string") {
                    enriched.stderr = stderr ?? "";
                }
                reject(enriched);
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}
function ok(content) {
    return { content: JSON.stringify(content) };
}
function fail(message) {
    return { content: JSON.stringify({ error: message }), isError: true };
}
function warnBestEffort(context, error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[desktop-tools] ${context}: ${message}`);
}
function truncateOutput(text) {
    if (text.length <= MAX_OUTPUT_BYTES)
        return text;
    return text.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated)";
}
function shellQuote(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function normalizeAptCommand(command) {
    const trimmed = command.trim();
    if (!APT_PREFIX_RE.test(trimmed)) {
        return command;
    }
    let normalized = trimmed;
    if (!/^sudo\b/i.test(normalized)) {
        normalized = `sudo ${normalized}`;
    }
    normalized = normalized.replace(/^sudo\s+((?:DEBIAN_FRONTEND|APT_LISTCHANGES_FRONTEND)=[^\s]+\s+)*apt\s+/i, (_full, envPrefix) => `sudo ${envPrefix ?? ""}apt-get `);
    const isInstall = /^sudo\s+.*apt-get\s+install\b/i.test(normalized);
    if (!isInstall) {
        return normalized;
    }
    const hasYesFlag = /\s(?:-y|--yes)\b/i.test(normalized);
    if (!hasYesFlag) {
        normalized = normalized.replace(/\binstall\b/i, "install -y");
    }
    const alreadyUpdates = /\bapt(?:-get)?\s+update\b/i.test(normalized) ||
        /\b&&\s*sudo\s+.*apt-get\s+install\b/i.test(normalized);
    if (alreadyUpdates) {
        return normalized;
    }
    return `sudo apt-get update && ${normalized}`;
}
async function ensureManagedProcessRegistryLoaded() {
    if (managedProcessesLoaded)
        return;
    managedProcessesLoaded = true;
    try {
        const raw = await readFile(MANAGED_PROCESS_REGISTRY_PATH, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            warnBestEffort("managed process registry load failed", "registry was not an array");
            return;
        }
        for (const entry of parsed) {
            if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
                continue;
            }
            const record = entry;
            if (typeof record.processId !== "string" ||
                typeof record.command !== "string" ||
                !Array.isArray(record.args) ||
                typeof record.cwd !== "string" ||
                typeof record.logPath !== "string" ||
                typeof record.pid !== "number" ||
                typeof record.pgid !== "number" ||
                typeof record.state !== "string" ||
                typeof record.startedAt !== "number") {
                continue;
            }
            managedProcesses.set(record.processId, {
                processId: record.processId,
                label: typeof record.label === "string" ? record.label : undefined,
                idempotencyKey: typeof record.idempotencyKey === "string"
                    ? record.idempotencyKey
                    : undefined,
                command: record.command,
                args: record.args.filter((arg) => typeof arg === "string"),
                cwd: record.cwd,
                logPath: record.logPath,
                pid: record.pid,
                pgid: record.pgid,
                processStartToken: typeof record.processStartToken === "string" &&
                    record.processStartToken.length > 0
                    ? record.processStartToken
                    : undefined,
                processBootId: typeof record.processBootId === "string" &&
                    record.processBootId.length > 0
                    ? record.processBootId
                    : undefined,
                state: record.state === "running" ? "running" : "exited",
                startedAt: record.startedAt,
                endedAt: typeof record.endedAt === "number" ? record.endedAt : undefined,
                exitCode: typeof record.exitCode === "number" || record.exitCode === null
                    ? record.exitCode
                    : undefined,
                signal: typeof record.signal === "string" || record.signal === null
                    ? record.signal
                    : undefined,
                envKeys: Array.isArray(record.envKeys)
                    ? record.envKeys.filter((key) => typeof key === "string")
                    : undefined,
                launchFingerprint: typeof record.launchFingerprint === "string" &&
                    record.launchFingerprint.length > 0
                    ? record.launchFingerprint
                    : buildManagedProcessLaunchFingerprint({
                        command: record.command,
                        args: record.args.filter((arg) => typeof arg === "string"),
                        cwd: record.cwd,
                        envKeys: Array.isArray(record.envKeys)
                            ? record.envKeys.filter((key) => typeof key === "string")
                            : undefined,
                    }),
            });
        }
    }
    catch (error) {
        if (typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT") {
            return;
        }
        warnBestEffort("managed process registry load failed", error);
    }
}
function cloneManagedProcessRecord(record) {
    return {
        ...record,
        args: [...record.args],
        ...(record.envKeys ? { envKeys: [...record.envKeys] } : {}),
    };
}
function snapshotManagedProcessRegistry() {
    return Array.from(managedProcesses.values())
        .map((record) => cloneManagedProcessRecord(record))
        .sort((a, b) => a.startedAt - b.startedAt);
}
async function syncManagedProcessDirectory() {
    try {
        const handle = await openFile(MANAGED_PROCESS_DIR, "r");
        try {
            await handle.sync();
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        warnBestEffort("managed process registry directory sync failed", error);
    }
}
async function writeManagedProcessRegistryAtomically(records) {
    const tempPath = `${MANAGED_PROCESS_REGISTRY_PATH}.${process.pid}.${randomUUID()}.tmp`;
    let handle = null;
    try {
        handle = await openFile(tempPath, "w");
        await handle.writeFile(JSON.stringify(records, null, 2), "utf8");
        await handle.sync();
        await handle.close();
        handle = null;
        await rename(tempPath, MANAGED_PROCESS_REGISTRY_PATH);
        await syncManagedProcessDirectory();
    }
    catch (error) {
        if (handle) {
            await handle.close().catch(() => undefined);
            handle = null;
        }
        await unlink(tempPath).catch(() => undefined);
        throw error;
    }
}
async function persistManagedProcessRegistry() {
    const persist = async () => {
        await mkdir(MANAGED_PROCESS_DIR, { recursive: true });
        const records = snapshotManagedProcessRegistry();
        await writeManagedProcessRegistryAtomically(records);
    };
    const nextPersist = managedProcessRegistryPersistChain.then(persist, persist);
    managedProcessRegistryPersistChain = nextPersist.catch(() => undefined);
    return nextPersist;
}
function commandBasename(command) {
    return basename(command.trim()).toLowerCase();
}
function normalizeManagedProcessSignal(value) {
    if (typeof value !== "string" || value.trim().length === 0) {
        return "SIGTERM";
    }
    const upper = value.trim().toUpperCase();
    const normalized = upper.startsWith("SIG") ? upper : `SIG${upper}`;
    if (!PROCESS_SIGNAL_NAMES.has(normalized)) {
        throw new Error(`signal must be one of: ${Array.from(PROCESS_SIGNAL_NAMES).join(", ")}`);
    }
    return normalized;
}
function normalizeManagedProcessGraceMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return MANAGED_PROCESS_DEFAULT_STOP_GRACE_MS;
    }
    return Math.min(MANAGED_PROCESS_MAX_STOP_GRACE_MS, Math.max(0, Math.floor(value)));
}
async function resolveManagedProcessCwd(input) {
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
    }
    catch {
        try {
            await access("/home/agenc");
            return "/home/agenc";
        }
        catch {
            return process.cwd();
        }
    }
}
function normalizeManagedProcessArgs(input) {
    if (input === undefined)
        return [];
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
function normalizeManagedProcessEnv(input) {
    if (input === undefined)
        return undefined;
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
        throw new Error("env must be an object of string values");
    }
    const envEntries = Object.entries(input);
    const normalized = {};
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
function normalizeManagedProcessCommand(command) {
    if (typeof command !== "string" || command.trim().length === 0) {
        throw new Error("command is required");
    }
    const trimmed = command.trim();
    if (/\s/.test(trimmed)) {
        throw new Error("command must be one executable token/path. Put flags and operands in args, or use desktop.bash for shell scripts.");
    }
    const base = commandBasename(trimmed);
    if (PROCESS_SHELL_WRAPPER_COMMANDS.has(base)) {
        throw new Error("Shell wrapper commands like bash/sh/zsh are not allowed in process_start. Use a real executable + args, or desktop.bash for shell logic.");
    }
    return trimmed;
}
function normalizeManagedProcessLabel(input) {
    if (typeof input !== "string")
        return undefined;
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function normalizeManagedProcessIdempotencyKey(input) {
    if (typeof input !== "string")
        return undefined;
    const trimmed = input.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
function normalizeManagedProcessLogPath(input, processId) {
    if (typeof input === "string" && input.trim().length > 0) {
        const logPath = input.trim();
        if (!isAbsolute(logPath)) {
            throw new Error("logPath must be an absolute path");
        }
        return logPath;
    }
    return `${MANAGED_PROCESS_DIR}/${processId}.log`;
}
function buildManagedProcessLaunchFingerprint(params) {
    const payload = JSON.stringify({
        command: params.command,
        args: [...params.args],
        cwd: params.cwd,
        envKeys: params.envKeys ? [...params.envKeys].sort() : [],
    });
    return createHash("sha256").update(payload).digest("hex");
}
function normalizeChromiumProcessArgs(command, args) {
    if (!CHROMIUM_PROCESS_COMMANDS.has(commandBasename(command))) {
        return [...args];
    }
    const nextArgs = [];
    let hasUserDataDir = false;
    for (const arg of args) {
        const normalized = arg.trim();
        if (CHROMIUM_DISALLOWED_FLAGS.has(normalized))
            continue;
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
        nextArgs.push(`--user-data-dir=/tmp/agenc-chrome-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`);
    }
    return nextArgs;
}
async function readFileTail(path, maxBytes = MANAGED_PROCESS_TAIL_BYTES) {
    try {
        const handle = await openFile(path, "r");
        try {
            const fileStat = await handle.stat();
            if (fileStat.size <= 0)
                return "";
            const bytes = Math.min(fileStat.size, maxBytes);
            const buffer = Buffer.alloc(bytes);
            await handle.read(buffer, 0, bytes, fileStat.size - bytes);
            return buffer.toString("utf8");
        }
        finally {
            await handle.close();
        }
    }
    catch {
        return "";
    }
}
async function inspectManagedProcessState(record) {
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
async function refreshManagedProcessRecord(record) {
    const runtimeState = await inspectManagedProcessState(record);
    if (runtimeState === record.state) {
        return record;
    }
    const nextRecord = {
        ...record,
        state: runtimeState,
        endedAt: runtimeState === "exited"
            ? record.endedAt ?? Date.now()
            : record.endedAt,
    };
    managedProcesses.set(record.processId, nextRecord);
    await persistManagedProcessRegistry();
    return nextRecord;
}
function compareManagedProcessRecency(left, right) {
    if (left.state === "running" && right.state !== "running")
        return -1;
    if (left.state !== "running" && right.state === "running")
        return 1;
    const leftUpdatedAt = left.endedAt ?? left.startedAt;
    const rightUpdatedAt = right.endedAt ?? right.startedAt;
    return rightUpdatedAt - leftUpdatedAt;
}
function findManagedProcessRecord(predicate) {
    return Array.from(managedProcesses.values())
        .filter(predicate)
        .sort(compareManagedProcessRecency)[0];
}
function findManagedProcessRecordByLabel(label) {
    return findManagedProcessRecord((record) => record.label === label);
}
function findManagedProcessRecordByIdempotencyKey(idempotencyKey) {
    return findManagedProcessRecord((record) => record.idempotencyKey === idempotencyKey);
}
function findManagedProcessRecordByPid(pid) {
    return findManagedProcessRecord((record) => record.pid === pid);
}
async function resolveManagedProcessRecord(args) {
    await ensureManagedProcessRegistryLoaded();
    const processId = typeof args.processId === "string" && args.processId.trim().length > 0
        ? args.processId.trim()
        : undefined;
    const label = typeof args.label === "string" && args.label.trim().length > 0
        ? args.label.trim()
        : undefined;
    const idempotencyKey = typeof args.idempotencyKey === "string" && args.idempotencyKey.trim().length > 0
        ? args.idempotencyKey.trim()
        : undefined;
    const pid = typeof args.pid === "number" && Number.isFinite(args.pid)
        ? Math.floor(args.pid)
        : undefined;
    let record;
    if (processId) {
        record = managedProcesses.get(processId);
    }
    else if (idempotencyKey) {
        record = findManagedProcessRecordByIdempotencyKey(idempotencyKey);
    }
    else if (label) {
        record = findManagedProcessRecordByLabel(label);
    }
    else if (pid && pid > 0) {
        record = findManagedProcessRecordByPid(pid);
    }
    else {
        throw new Error("processId, idempotencyKey, label, or pid is required");
    }
    if (!record) {
        throw new Error("Managed process not found");
    }
    return refreshManagedProcessRecord(record);
}
async function waitForManagedProcessExit(record, timeoutMs) {
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
async function finalizeManagedProcessExit(processId, exitCode, signal) {
    await ensureManagedProcessRegistryLoaded();
    const record = managedProcesses.get(processId);
    if (!record)
        return;
    if (record.state === "exited" && typeof record.endedAt === "number") {
        return;
    }
    const exitedRecord = {
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
function buildManagedProcessResponse(record, recentOutput, extra) {
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
async function screenshot() {
    const path = `/tmp/screenshot-${randomUUID()}.png`;
    try {
        await exec("scrot", ["-o", path]);
        const buf = await readFile(path);
        const size = await screenSize();
        const sizeData = JSON.parse(size.content);
        const result = {
            image: buf.toString("base64"),
            width: sizeData.width,
            height: sizeData.height,
        };
        return ok(result);
    }
    catch (e) {
        return fail(`Screenshot failed: ${e instanceof Error ? e.message : e}`);
    }
    finally {
        unlink(path).catch((error) => {
            warnBestEffort("screenshot cleanup failed", error);
        });
    }
}
async function mouseClick(args) {
    const x = Number(args.x);
    const y = Number(args.y);
    const button = Number(args.button ?? 1);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return fail("x and y must be finite numbers");
    }
    if (button < 1 || button > 3)
        return fail("button must be 1, 2, or 3");
    try {
        await exec("xdotool", [
            "mousemove",
            "--sync",
            String(Math.round(x)),
            String(Math.round(y)),
            "click",
            String(button),
        ]);
        return ok({ clicked: true, x, y, button });
    }
    catch (e) {
        return fail(`mouse_click failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function mouseMove(args) {
    const x = Number(args.x);
    const y = Number(args.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return fail("x and y must be finite numbers");
    }
    try {
        await exec("xdotool", [
            "mousemove",
            "--sync",
            String(Math.round(x)),
            String(Math.round(y)),
        ]);
        return ok({ moved: true, x, y });
    }
    catch (e) {
        return fail(`mouse_move failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function mouseDrag(args) {
    const startX = Number(args.startX);
    const startY = Number(args.startY);
    const endX = Number(args.endX);
    const endY = Number(args.endY);
    const button = Number(args.button ?? 1);
    if ([startX, startY, endX, endY].some((n) => !Number.isFinite(n))) {
        return fail("All coordinates must be finite numbers");
    }
    try {
        await exec("xdotool", [
            "mousemove",
            "--sync",
            String(Math.round(startX)),
            String(Math.round(startY)),
            "mousedown",
            String(button),
            "mousemove",
            "--sync",
            String(Math.round(endX)),
            String(Math.round(endY)),
            "mouseup",
            String(button),
        ]);
        return ok({ dragged: true, startX, startY, endX, endY, button });
    }
    catch (e) {
        return fail(`mouse_drag failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function mouseScroll(args) {
    const clicks = Number(args.clicks ?? 3);
    const direction = String(args.direction ?? "down");
    const buttonMap = {
        up: "4",
        down: "5",
        left: "6",
        right: "7",
    };
    const btn = buttonMap[direction];
    if (!btn)
        return fail("direction must be up, down, left, or right");
    if (!Number.isInteger(clicks) || clicks < 1 || clicks > 100) {
        return fail("clicks must be an integer 1-100");
    }
    try {
        await exec("xdotool", [
            "click",
            "--repeat",
            String(clicks),
            btn,
        ]);
        return ok({ scrolled: true, direction, clicks });
    }
    catch (e) {
        return fail(`mouse_scroll failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function keyboardType(args) {
    const text = String(args.text ?? "");
    if (!text)
        return fail("text is required");
    try {
        // Chunk into TYPE_CHUNK_SIZE segments to prevent X11 buffer overflow
        for (let i = 0; i < text.length; i += TYPE_CHUNK_SIZE) {
            const chunk = text.slice(i, i + TYPE_CHUNK_SIZE);
            await exec("xdotool", [
                "type",
                "--delay",
                String(TYPE_DELAY_MS),
                "--",
                chunk,
            ]);
        }
        return ok({ typed: true, length: text.length });
    }
    catch (e) {
        return fail(`keyboard_type failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function keyboardKey(args) {
    const key = String(args.key ?? "");
    if (!key)
        return fail("key is required");
    try {
        await exec("xdotool", ["key", "--", key]);
        return ok({ pressed: true, key });
    }
    catch (e) {
        return fail(`keyboard_key failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function readCapturedPid(capturePath, timeoutMs = DETACHED_PID_CAPTURE_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const raw = (await readFile(capturePath, "utf8")).trim();
            if (raw.length > 0) {
                const pid = Number.parseInt(raw.split(/\s+/, 1)[0] ?? "", 10);
                if (Number.isFinite(pid) && pid > 0) {
                    return pid;
                }
                return undefined;
            }
        }
        catch {
            // file may not exist yet
        }
        await sleep(DETACHED_PID_CAPTURE_POLL_MS);
    }
    return undefined;
}
async function spawnDetachedCommand(command, logPath, options) {
    const captureId = randomUUID().slice(0, 8);
    const scriptPath = `/tmp/agenc-detached-${captureId}.sh`;
    const capturePath = `/tmp/agenc-detached-${captureId}.pid`;
    const wrappedCommand = options?.wrapAsBackground ? `${command} &` : command;
    const scriptBody = `${wrappedCommand}\n` +
        `printf '%s\\n' \"$!\" > ${shellQuote(capturePath)}\n`;
    const stdoutFd = openSync(logPath, "a");
    const stderrFd = openSync(logPath, "a");
    try {
        await writeFile(scriptPath, scriptBody, { mode: 0o700 });
        const child = spawn("/bin/bash", [scriptPath], {
            env: { ...process.env, DISPLAY },
            detached: true,
            stdio: ["ignore", stdoutFd, stderrFd],
        });
        child.unref();
        const launcherPid = typeof child.pid === "number" && Number.isFinite(child.pid)
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
                        ? "background_process"
                        : "launcher_shell",
                }
                : {}),
        };
    }
    finally {
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
async function bash(args) {
    const command = String(args.command ?? "");
    if (!command)
        return fail("command is required");
    const normalizedCommand = normalizeAptCommand(command);
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
            const { pid, launcherPid, backgroundPid, pidSemantics } = await spawnDetachedCommand(trimmed, "/tmp/agenc-bg/last-background.log");
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
            const { pid, launcherPid, backgroundPid, pidSemantics } = await spawnDetachedCommand(trimmed, "/tmp/agenc-gui/last-launch.log", { wrapAsBackground: true });
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
            const { stdout, stderr } = await exec("/bin/bash", [scriptPath], timeoutMs);
            return ok({
                stdout: truncateOutput(stdout),
                stderr: truncateOutput(stderr),
                exitCode: 0,
            });
        }
        finally {
            unlink(scriptPath).catch((error) => {
                warnBestEffort("temporary script cleanup failed", error);
            });
        }
    }
    catch (e) {
        // Non-zero exit codes are reported, not thrown
        const err = e;
        if (err.code !== undefined && typeof err.code === "number") {
            return ok({
                stdout: truncateOutput(err.stdout ?? ""),
                stderr: truncateOutput(err.stderr ?? ""),
                exitCode: err.code,
            });
        }
        const message = String(err.message ?? e ?? "");
        if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
            message.includes("maxBuffer length exceeded")) {
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
async function processStart(args) {
    try {
        await ensureManagedProcessRegistryLoaded();
        const command = normalizeManagedProcessCommand(args.command);
        const normalizedArgs = normalizeChromiumProcessArgs(command, normalizeManagedProcessArgs(args.args));
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
        const matchesLaunchSpec = (record) => record.launchFingerprint === launchFingerprint;
        if (idempotencyKey) {
            const existing = findManagedProcessRecordByIdempotencyKey(idempotencyKey);
            if (existing) {
                const refreshed = await refreshManagedProcessRecord(existing);
                if (matchesLaunchSpec(refreshed) && refreshed.state === "running") {
                    const recentOutput = await readFileTail(refreshed.logPath);
                    return ok(buildManagedProcessResponse(refreshed, recentOutput, {
                        reused: true,
                    }));
                }
                return fail("A managed process already exists for that idempotencyKey.");
            }
        }
        if (label) {
            const existing = findManagedProcessRecordByLabel(label);
            if (existing) {
                const refreshed = await refreshManagedProcessRecord(existing);
                if (refreshed.idempotencyKey === idempotencyKey &&
                    matchesLaunchSpec(refreshed) &&
                    refreshed.state === "running") {
                    const recentOutput = await readFileTail(refreshed.logPath);
                    return ok(buildManagedProcessResponse(refreshed, recentOutput, {
                        reused: true,
                    }));
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
            const record = {
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
                    content: JSON.stringify(buildManagedProcessResponse(refreshed, recentOutput, {
                        error: "Managed process exited during startup. Use desktop.process_status to inspect logs or desktop.bash for short-lived shell commands.",
                    })),
                    isError: true,
                };
            }
            return ok(buildManagedProcessResponse(refreshed, recentOutput, {
                started: true,
            }));
        }
        finally {
            closeSync(stdoutFd);
            closeSync(stderrFd);
        }
    }
    catch (error) {
        return fail(`process_start failed: ${error instanceof Error ? error.message : error}`);
    }
}
async function processStatus(args) {
    try {
        const record = await resolveManagedProcessRecord(args);
        const recentOutput = await readFileTail(record.logPath);
        return ok(buildManagedProcessResponse(record, recentOutput, {
            running: record.state === "running",
        }));
    }
    catch (error) {
        return fail(`process_status failed: ${error instanceof Error ? error.message : error}`);
    }
}
async function processStop(args) {
    try {
        const signal = normalizeManagedProcessSignal(args.signal);
        const gracePeriodMs = normalizeManagedProcessGraceMs(args.gracePeriodMs);
        const record = await resolveManagedProcessRecord(args);
        const recentOutputBeforeStop = await readFileTail(record.logPath);
        if (record.state !== "running") {
            return ok(buildManagedProcessResponse(record, recentOutputBeforeStop, {
                stopped: false,
                alreadyExited: true,
            }));
        }
        let forced = false;
        try {
            process.kill(-Math.abs(record.pgid), signal);
        }
        catch (error) {
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
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!message.toLowerCase().includes("esrch")) {
                    throw error;
                }
            }
            refreshed = await waitForManagedProcessExit(refreshed, 2_000);
        }
        const recentOutput = await readFileTail(refreshed.logPath);
        return ok(buildManagedProcessResponse(refreshed, recentOutput, {
            stopped: refreshed.state !== "running",
            signalSent: signal,
            forced,
        }));
    }
    catch (error) {
        return fail(`process_stop failed: ${error instanceof Error ? error.message : error}`);
    }
}
async function windowList() {
    try {
        const { stdout } = await exec("xdotool", ["search", "--name", ""]);
        const windowIds = stdout.trim().split("\n").filter(Boolean);
        const windows = [];
        for (const id of windowIds.slice(0, 50)) {
            try {
                const { stdout: title } = await exec("xdotool", [
                    "getwindowname",
                    id,
                ]);
                windows.push({ id, title: title.trim() });
            }
            catch {
                windows.push({ id, title: "(unknown)" });
            }
        }
        // Most X11 windows in the desktop session are untitled internal wrappers.
        // Return only meaningful entries to keep tool output compact for the LLM.
        const meaningful = windows
            .filter((w) => {
            const title = w.title.trim();
            return title.length > 0 && title !== "(unknown)";
        })
            .slice(0, 25);
        return ok({
            windows: meaningful,
            totalWindows: windows.length,
            omittedUntitled: windows.length - meaningful.length,
        });
    }
    catch (e) {
        return fail(`window_list failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function windowFocus(args) {
    const title = String(args.title ?? "");
    if (!title)
        return fail("title is required");
    try {
        const { stdout } = await exec("xdotool", [
            "search",
            "--name",
            title,
        ]);
        const ids = stdout.trim().split("\n").filter(Boolean);
        if (ids.length === 0)
            return fail(`No window found matching "${title}"`);
        await exec("xdotool", ["windowactivate", ids[0]]);
        return ok({ focused: true, windowId: ids[0], title });
    }
    catch (e) {
        return fail(`window_focus failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function clipboardGet() {
    try {
        const { stdout } = await exec("xclip", [
            "-selection",
            "clipboard",
            "-o",
        ]);
        return ok({ text: stdout });
    }
    catch (e) {
        return fail(`clipboard_get failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function clipboardSet(args) {
    const text = String(args.text ?? "");
    try {
        await new Promise((resolve, reject) => {
            const proc = execFile("xclip", ["-selection", "clipboard"], { env: { ...process.env, DISPLAY }, timeout: EXEC_TIMEOUT_MS }, (err) => (err ? reject(err) : resolve()));
            proc.stdin?.write(text);
            proc.stdin?.end();
        });
        return ok({ set: true, length: text.length });
    }
    catch (e) {
        return fail(`clipboard_set failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function screenSize() {
    try {
        const { stdout } = await exec("xdpyinfo", ["-display", DISPLAY]);
        const match = stdout.match(/dimensions:\s+(\d+)x(\d+)/);
        if (!match)
            return fail("Could not parse display dimensions");
        const result = {
            width: parseInt(match[1], 10),
            height: parseInt(match[2], 10),
        };
        return ok(result);
    }
    catch (e) {
        return fail(`screen_size failed: ${e instanceof Error ? e.message : e}`);
    }
}
// --- text_editor tool (str_replace_based_edit_tool pattern) ---
const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_UNDO_FILES = 20;
/** LRU undo buffer — stores the single most recent version per file. */
const undoBuffer = new Map();
function numberLines(text, startLine = 1) {
    return text
        .split("\n")
        .map((line, i) => `${String(i + startLine).padStart(6, " ")}\t${line}`)
        .join("\n");
}
async function textEditor(args) {
    const command = args.command;
    const inputPath = args.path;
    if (typeof command !== "string" || !command) {
        return fail("command is required");
    }
    if (typeof inputPath !== "string" || !inputPath) {
        return fail("path is required");
    }
    let path;
    try {
        path = await resolveValidatedTextEditorPath(inputPath);
    }
    catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
    }
    switch (command) {
        case "view":
            return textEditorView(path, args.view_range);
        case "create":
            return textEditorCreate(path, String(args.file_text ?? ""));
        case "str_replace":
            return textEditorStrReplace(path, String(args.old_str ?? ""), String(args.new_str ?? ""));
        case "insert":
            return textEditorInsert(path, Number(args.insert_line ?? 0), String(args.new_str ?? ""));
        case "undo_edit":
            return textEditorUndo(path);
        default:
            return fail(`Unknown command: ${command}. Must be one of: view, create, str_replace, insert, undo_edit`);
    }
}
async function textEditorView(path, viewRange) {
    try {
        const s = await stat(path);
        if (s.size > MAX_FILE_SIZE) {
            return fail(`File too large (${s.size} bytes, max ${MAX_FILE_SIZE})`);
        }
        const content = await readFile(path, "utf-8");
        const lines = content.split("\n");
        if (viewRange && Array.isArray(viewRange) && viewRange.length === 2) {
            const start = Math.max(1, Number(viewRange[0]));
            const end = Math.min(lines.length, Number(viewRange[1]));
            if (start > end)
                return fail(`Invalid range: [${start}, ${end}]`);
            const slice = lines.slice(start - 1, end);
            return ok({ output: numberLines(slice.join("\n"), start) });
        }
        return ok({ output: numberLines(content) });
    }
    catch (e) {
        return fail(`Failed to read ${path}: ${e instanceof Error ? e.message : e}`);
    }
}
async function textEditorCreate(path, fileText) {
    try {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, fileText, "utf-8");
        return ok({ output: `File created at ${path} (${fileText.split("\n").length} lines)` });
    }
    catch (e) {
        return fail(`Failed to create ${path}: ${e instanceof Error ? e.message : e}`);
    }
}
async function textEditorStrReplace(path, oldStr, newStr) {
    if (!oldStr)
        return fail("old_str is required for str_replace");
    try {
        const content = await readFile(path, "utf-8");
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) {
            return fail(`old_str not found in ${path}. Make sure the string matches exactly, including whitespace.`);
        }
        if (occurrences > 1) {
            return fail(`old_str found ${occurrences} times in ${path}. Provide more context to make it unique.`);
        }
        // Save undo state (LRU eviction)
        if (undoBuffer.size >= MAX_UNDO_FILES && !undoBuffer.has(path)) {
            const oldest = undoBuffer.keys().next().value;
            undoBuffer.delete(oldest);
        }
        undoBuffer.delete(path); // Re-insert at end for LRU
        undoBuffer.set(path, content);
        const updated = content.replace(oldStr, newStr);
        await writeFile(path, updated, "utf-8");
        return ok({ output: `Replacement applied in ${path}` });
    }
    catch (e) {
        return fail(`str_replace failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function textEditorInsert(path, insertLine, newStr) {
    try {
        const content = await readFile(path, "utf-8");
        const lines = content.split("\n");
        if (insertLine < 0 || insertLine > lines.length) {
            return fail(`insert_line ${insertLine} out of range (0-${lines.length}). Use 0 to insert at the beginning.`);
        }
        // Save undo state (LRU eviction)
        if (undoBuffer.size >= MAX_UNDO_FILES && !undoBuffer.has(path)) {
            const oldest = undoBuffer.keys().next().value;
            undoBuffer.delete(oldest);
        }
        undoBuffer.delete(path);
        undoBuffer.set(path, content);
        const newLines = newStr.split("\n");
        lines.splice(insertLine, 0, ...newLines);
        await writeFile(path, lines.join("\n"), "utf-8");
        return ok({
            output: `Inserted ${newLines.length} line(s) after line ${insertLine} in ${path}`,
        });
    }
    catch (e) {
        return fail(`insert failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function textEditorUndo(path) {
    const prev = undoBuffer.get(path);
    if (prev === undefined) {
        return fail(`No undo history for ${path}`);
    }
    try {
        await writeFile(path, prev, "utf-8");
        undoBuffer.delete(path);
        return ok({ output: `Reverted ${path} to previous version` });
    }
    catch (e) {
        return fail(`undo_edit failed: ${e instanceof Error ? e.message : e}`);
    }
}
// --- Video recording tools ---
let activeRecording = null;
const RECORDING_PID_FILE = "/tmp/recording.pid";
/** Kill orphaned ffmpeg recording from a previous server crash. */
async function cleanupOrphanedRecording() {
    try {
        const pidStr = await readFile(RECORDING_PID_FILE, "utf-8");
        const pid = parseInt(pidStr.trim(), 10);
        if (Number.isFinite(pid)) {
            try {
                process.kill(pid, "SIGKILL");
            }
            catch {
                /* already dead */
            }
        }
        await unlink(RECORDING_PID_FILE).catch((error) => {
            warnBestEffort("orphaned recording PID cleanup failed", error);
        });
    }
    catch {
        /* no pid file */
    }
}
// Run cleanup on module load
void cleanupOrphanedRecording();
async function videoStart(args) {
    if (activeRecording) {
        return fail(`Already recording to ${activeRecording.path}. Stop the current recording first.`);
    }
    const framerate = Number(args.framerate ?? 15);
    if (!Number.isFinite(framerate) || framerate < 1 || framerate > 60) {
        return fail("framerate must be 1-60");
    }
    // Get current screen size for recording dimensions
    const sizeResult = await screenSize();
    const sizeData = JSON.parse(sizeResult.content);
    const path = `/tmp/recording-${randomUUID()}.mp4`;
    try {
        const ffmpeg = spawn("ffmpeg", [
            "-video_size",
            `${sizeData.width}x${sizeData.height}`,
            "-framerate",
            String(framerate),
            "-f",
            "x11grab",
            "-i",
            DISPLAY,
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "28",
            path,
        ], {
            stdio: ["pipe", "pipe", "pipe"],
            env: { ...process.env, DISPLAY },
            detached: false,
        });
        if (!ffmpeg.pid) {
            return fail("Failed to start ffmpeg process");
        }
        activeRecording = {
            pid: ffmpeg.pid,
            path,
            startedAt: Date.now(),
            process: ffmpeg,
        };
        // Write PID file for crash recovery
        await writeFile(RECORDING_PID_FILE, String(ffmpeg.pid), "utf-8");
        // Auto-cleanup if ffmpeg exits unexpectedly
        ffmpeg.on("exit", () => {
            if (activeRecording?.pid === ffmpeg.pid) {
                activeRecording = null;
                unlink(RECORDING_PID_FILE).catch((error) => {
                    warnBestEffort("recording PID cleanup after exit failed", error);
                });
            }
        });
        return ok({ recording: true, path, pid: ffmpeg.pid, framerate });
    }
    catch (e) {
        return fail(`video_start failed: ${e instanceof Error ? e.message : e}`);
    }
}
async function videoStop() {
    if (!activeRecording) {
        return fail("No active recording");
    }
    const { process: ffmpeg, path, startedAt } = activeRecording;
    try {
        // Send SIGINT for graceful ffmpeg shutdown (writes trailer)
        ffmpeg.kill("SIGINT");
        // Wait for exit with 2s timeout
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                try {
                    ffmpeg.kill("SIGKILL");
                }
                catch {
                    /* already dead */
                }
                resolve();
            }, 2000);
            ffmpeg.on("exit", () => {
                clearTimeout(timer);
                resolve();
            });
        });
        const durationMs = Date.now() - startedAt;
        activeRecording = null;
        await unlink(RECORDING_PID_FILE).catch((error) => {
            warnBestEffort("recording PID cleanup after stop failed", error);
        });
        // Verify the file exists
        try {
            await access(path);
        }
        catch {
            return fail(`Recording file not found at ${path}`);
        }
        return ok({ stopped: true, path, durationMs });
    }
    catch (e) {
        activeRecording = null;
        await unlink(RECORDING_PID_FILE).catch((error) => {
            warnBestEffort("recording PID cleanup after failure failed", error);
        });
        return fail(`video_stop failed: ${e instanceof Error ? e.message : e}`);
    }
}
const handlers = {
    screenshot: () => screenshot(),
    mouse_click: mouseClick,
    mouse_move: mouseMove,
    mouse_drag: mouseDrag,
    mouse_scroll: mouseScroll,
    keyboard_type: keyboardType,
    keyboard_key: keyboardKey,
    bash,
    process_start: processStart,
    process_status: processStatus,
    process_stop: processStop,
    window_list: () => windowList(),
    window_focus: windowFocus,
    clipboard_get: () => clipboardGet(),
    clipboard_set: clipboardSet,
    screen_size: () => screenSize(),
    text_editor: textEditor,
    video_start: videoStart,
    video_stop: () => videoStop(),
};
export const TOOL_DEFINITIONS = [
    {
        name: "screenshot",
        description: "Take a screenshot of the current desktop. Returns a base64-encoded PNG image with dimensions.",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "mouse_click",
        description: "Move the mouse to (x, y) and click. Button: 1=left, 2=middle, 3=right.",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "number", description: "X coordinate" },
                y: { type: "number", description: "Y coordinate" },
                button: {
                    type: "number",
                    description: "Mouse button (1=left, 2=middle, 3=right)",
                    default: 1,
                },
            },
            required: ["x", "y"],
        },
    },
    {
        name: "mouse_move",
        description: "Move the mouse cursor to (x, y) without clicking.",
        inputSchema: {
            type: "object",
            properties: {
                x: { type: "number", description: "X coordinate" },
                y: { type: "number", description: "Y coordinate" },
            },
            required: ["x", "y"],
        },
    },
    {
        name: "mouse_drag",
        description: "Click and drag from (startX, startY) to (endX, endY).",
        inputSchema: {
            type: "object",
            properties: {
                startX: { type: "number", description: "Start X coordinate" },
                startY: { type: "number", description: "Start Y coordinate" },
                endX: { type: "number", description: "End X coordinate" },
                endY: { type: "number", description: "End Y coordinate" },
                button: { type: "number", description: "Mouse button", default: 1 },
            },
            required: ["startX", "startY", "endX", "endY"],
        },
    },
    {
        name: "mouse_scroll",
        description: "Scroll the mouse wheel in a direction.",
        inputSchema: {
            type: "object",
            properties: {
                direction: {
                    type: "string",
                    enum: ["up", "down", "left", "right"],
                    description: "Scroll direction",
                    default: "down",
                },
                clicks: {
                    type: "number",
                    description: "Number of scroll clicks (1-100)",
                    default: 3,
                },
            },
        },
    },
    {
        name: "keyboard_type",
        description: "Type text using the keyboard. Text is chunked to prevent X11 buffer overflow.",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", description: "Text to type" },
            },
            required: ["text"],
        },
    },
    {
        name: "keyboard_key",
        description: "Press a key or key combination (e.g. 'Return', 'ctrl+c', 'alt+Tab').",
        inputSchema: {
            type: "object",
            properties: {
                key: {
                    type: "string",
                    description: "Key name or combination (e.g. 'Return', 'ctrl+c', 'alt+F4')",
                },
            },
            required: ["key"],
        },
    },
    {
        name: "bash",
        description: "Execute a bash command in the desktop environment. Returns stdout, stderr, and exit code.",
        inputSchema: {
            type: "object",
            properties: {
                command: { type: "string", description: "Bash command to execute" },
                timeoutMs: {
                    type: "number",
                    description: "Timeout in milliseconds",
                    default: 600000,
                },
            },
            required: ["command"],
        },
    },
    {
        name: "process_start",
        description: "Start a long-running background process with a real executable plus args. Use this instead of bash for servers, background workers, and GUI apps that you need to inspect or stop later. Returns a stable processId, pid/pgid, logPath, and current state, and supports idempotent retries via idempotencyKey. Shell wrappers like bash -lc are rejected.",
        inputSchema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    description: "Executable token or absolute path only. Put flags/operands in args.",
                },
                args: {
                    type: "array",
                    items: { type: "string" },
                    description: "Executable arguments as a flat string array.",
                },
                cwd: {
                    type: "string",
                    description: "Absolute working directory. Defaults to /workspace when available.",
                },
                env: {
                    type: "object",
                    description: "Optional environment variable overrides.",
                    additionalProperties: { type: "string" },
                },
                label: {
                    type: "string",
                    description: "Stable human-readable handle label. Reuse it to find or stop the same logical process later.",
                },
                idempotencyKey: {
                    type: "string",
                    description: "Optional idempotency key for deduplicating repeated process_start requests.",
                },
                logPath: {
                    type: "string",
                    description: "Optional absolute combined stdout/stderr log path. Defaults under /tmp/agenc-processes.",
                },
            },
            required: ["command"],
        },
    },
    {
        name: "process_status",
        description: "Get the status of a managed background process started with process_start. Prefer processId from the start result; idempotencyKey, label, or pid are fallbacks. Returns running/exited state, pid/pgid, logPath, and recent output tail.",
        inputSchema: {
            type: "object",
            properties: {
                processId: {
                    type: "string",
                    description: "Stable managed process ID returned by process_start.",
                },
                label: {
                    type: "string",
                    description: "Fallback lookup label when processId is unavailable.",
                },
                idempotencyKey: {
                    type: "string",
                    description: "Fallback idempotency key when processId is unavailable.",
                },
                pid: {
                    type: "number",
                    description: "Fallback OS pid when processId is unavailable.",
                },
            },
            required: [],
        },
    },
    {
        name: "process_stop",
        description: "Stop a managed background process started with process_start. Sends a signal to the process group, waits for exit, and escalates to SIGKILL if needed. Prefer processId from the start result; idempotencyKey, label, or pid are fallbacks.",
        inputSchema: {
            type: "object",
            properties: {
                processId: {
                    type: "string",
                    description: "Stable managed process ID returned by process_start.",
                },
                label: {
                    type: "string",
                    description: "Fallback lookup label when processId is unavailable.",
                },
                idempotencyKey: {
                    type: "string",
                    description: "Fallback idempotency key when processId is unavailable.",
                },
                pid: {
                    type: "number",
                    description: "Fallback OS pid when processId is unavailable.",
                },
                signal: {
                    type: "string",
                    description: "Optional signal: SIGTERM, SIGINT, SIGKILL, or SIGHUP. Defaults to SIGTERM.",
                },
                gracePeriodMs: {
                    type: "number",
                    description: "Milliseconds to wait before escalating to SIGKILL. Defaults to 2000.",
                },
            },
            required: [],
        },
    },
    {
        name: "window_list",
        description: "List all open windows with their IDs and titles (up to 50).",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "window_focus",
        description: "Focus a window by title (partial match).",
        inputSchema: {
            type: "object",
            properties: {
                title: {
                    type: "string",
                    description: "Window title or partial match",
                },
            },
            required: ["title"],
        },
    },
    {
        name: "clipboard_get",
        description: "Read the current clipboard contents.",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "clipboard_set",
        description: "Set the clipboard contents.",
        inputSchema: {
            type: "object",
            properties: {
                text: { type: "string", description: "Text to copy to clipboard" },
            },
            required: ["text"],
        },
    },
    {
        name: "screen_size",
        description: "Get the current screen resolution.",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
    {
        name: "text_editor",
        description: "View, create, and edit files. Commands: view (read file with line numbers), create (write new file), str_replace (find and replace exact string — must be unique), insert (insert text after a line number), undo_edit (revert last edit).",
        inputSchema: {
            type: "object",
            properties: {
                command: {
                    type: "string",
                    enum: ["view", "create", "str_replace", "insert", "undo_edit"],
                    description: "The editing command to execute",
                },
                path: {
                    type: "string",
                    description: "Absolute file path (must be under /home/agenc or /tmp)",
                },
                file_text: {
                    type: "string",
                    description: "File content (for create command)",
                },
                old_str: {
                    type: "string",
                    description: "String to find (for str_replace — must match exactly once)",
                },
                new_str: {
                    type: "string",
                    description: "Replacement string (for str_replace and insert)",
                },
                insert_line: {
                    type: "number",
                    description: "Line number to insert after (0 = beginning of file, for insert command)",
                },
                view_range: {
                    type: "array",
                    items: { type: "number" },
                    description: "Optional [startLine, endLine] range for view command (1-indexed)",
                },
            },
            required: ["command", "path"],
        },
    },
    {
        name: "video_start",
        description: "Start recording the desktop screen to an MP4 file using ffmpeg. Only one recording at a time. Returns the file path.",
        inputSchema: {
            type: "object",
            properties: {
                framerate: {
                    type: "number",
                    description: "Frames per second (1-60)",
                    default: 15,
                },
            },
        },
    },
    {
        name: "video_stop",
        description: "Stop the active screen recording. Returns the file path and duration.",
        inputSchema: { type: "object", properties: {}, required: [] },
    },
];
export async function executeTool(name, args) {
    const handler = handlers[name];
    if (!handler) {
        return { content: JSON.stringify({ error: `Unknown tool: ${name}` }), isError: true };
    }
    return handler(args);
}
/** @internal Exposed for testing only. */
export const __managedProcessTestHooks = {
    async reset() {
        managedProcesses.clear();
        managedProcessesLoaded = true;
        managedProcessRegistryPersistChain = Promise.resolve();
        await unlink(MANAGED_PROCESS_REGISTRY_PATH).catch(() => undefined);
    },
    seed(records) {
        managedProcesses.clear();
        managedProcessesLoaded = true;
        for (const record of records) {
            managedProcesses.set(record.processId, cloneManagedProcessRecord(record));
        }
    },
    persist() {
        return persistManagedProcessRegistry();
    },
    finalizeExit(processId, exitCode, signal) {
        return finalizeManagedProcessExit(processId, exitCode, signal);
    },
    getRegistryPath() {
        return MANAGED_PROCESS_REGISTRY_PATH;
    },
    snapshot() {
        return snapshotManagedProcessRegistry();
    },
};
