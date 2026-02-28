import { execFile, spawn } from "node:child_process";
import { readFile, writeFile, unlink, mkdir, stat, access, } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
const DISPLAY = process.env.DISPLAY ?? ":1";
const EXEC_TIMEOUT_MS = 30_000;
const BASH_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB
const MAX_EXEC_BUFFER_BYTES = 1024 * 1024; // 1MB capture headroom
const TYPE_CHUNK_SIZE = 50;
const TYPE_DELAY_MS = 12;
const GUI_LAUNCH_CMD_RE = /^\s*(?:sudo\s+)?(?:env\s+[^;]+\s+)?(?:nohup\s+|setsid\s+)?(?:xfce4-terminal|gnome-terminal|xterm|kitty|firefox|chromium|chromium-browser|google-chrome|thunar|nautilus|mousepad|gedit)\b/i;
const BACKGROUND_COMMAND_RE = /(.*?)(?:&\s*(?:disown\s*)?(?:(?:;|&&)?\s*echo\s+\$!\s*)?)$/;
const APT_PREFIX_RE = /^\s*(?:sudo\s+)?(?:(?:DEBIAN_FRONTEND|APT_LISTCHANGES_FRONTEND)=[^\s]+\s+)*(?:apt-get|apt)\b/i;
function exec(cmd, args, timeoutMs = EXEC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, {
            timeout: timeoutMs,
            maxBuffer: MAX_EXEC_BUFFER_BYTES,
            env: { ...process.env, DISPLAY },
        }, (err, stdout, stderr) => {
            if (err)
                reject(err);
            else
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
function truncateOutput(text) {
    if (text.length <= MAX_OUTPUT_BYTES)
        return text;
    return text.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated)";
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
// --- Tool implementations ---
async function screenshot() {
    const path = `/tmp/screenshot-${randomUUID()}.png`;
    try {
        try {
            await exec("scrot", ["-o", path]);
        }
        catch {
            // Fallback to ImageMagick
            await exec("import", ["-window", "root", path]);
        }
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
        unlink(path).catch(() => { });
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
function spawnDetachedCommand(command, logPath) {
    const stdoutFd = openSync(logPath, "a");
    const stderrFd = openSync(logPath, "a");
    try {
        const child = spawn("/bin/bash", ["-lc", command], {
            env: { ...process.env, DISPLAY },
            detached: true,
            stdio: ["ignore", stdoutFd, stderrFd],
        });
        child.unref();
        return { pid: child.pid };
    }
    finally {
        closeSync(stdoutFd);
        closeSync(stderrFd);
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
    const trimmed = command.trim();
    const backgroundMatch = trimmed.match(BACKGROUND_COMMAND_RE);
    const alreadyBackgrounded = Boolean(backgroundMatch);
    const autoDetachGui = GUI_LAUNCH_CMD_RE.test(trimmed) && !alreadyBackgrounded;
    try {
        // For explicit background commands, run via a detached wrapper so the tool
        // returns immediately instead of waiting on inherited pipes/job control.
        if (alreadyBackgrounded) {
            const commandBody = (backgroundMatch?.[1] ?? "").trim();
            if (!commandBody)
                return fail("background command is empty");
            await mkdir("/tmp/agenc-bg", { recursive: true });
            const { pid } = spawnDetachedCommand(commandBody, "/tmp/agenc-bg/last-background.log");
            return ok({
                stdout: "",
                stderr: "",
                exitCode: 0,
                backgrounded: true,
                ...(Number.isFinite(pid) ? { pid } : {}),
            });
        }
        if (autoDetachGui) {
            await mkdir("/tmp/agenc-gui", { recursive: true });
            const { pid } = spawnDetachedCommand(trimmed, "/tmp/agenc-gui/last-launch.log");
            return ok({
                stdout: "",
                stderr: "",
                exitCode: 0,
                backgrounded: true,
                ...(Number.isFinite(pid) ? { pid } : {}),
            });
        }
        const { stdout, stderr } = await exec("/bin/bash", ["-c", normalizedCommand], timeoutMs);
        return ok({
            stdout: truncateOutput(stdout),
            stderr: truncateOutput(stderr),
            exitCode: 0,
        });
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
const ALLOWED_PREFIXES = ["/home/agenc", "/tmp"];
const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_UNDO_FILES = 20;
/** LRU undo buffer — stores the single most recent version per file. */
const undoBuffer = new Map();
function isPathAllowed(p) {
    const resolved = p.startsWith("/") ? p : `/home/agenc/${p}`;
    return ALLOWED_PREFIXES.some((prefix) => resolved.startsWith(prefix));
}
function numberLines(text, startLine = 1) {
    return text
        .split("\n")
        .map((line, i) => `${String(i + startLine).padStart(6, " ")}\t${line}`)
        .join("\n");
}
async function textEditor(args) {
    const command = String(args.command ?? "");
    const path = String(args.path ?? "");
    if (!command)
        return fail("command is required");
    if (!path)
        return fail("path is required");
    if (!isPathAllowed(path)) {
        return fail(`Access denied: path must be under ${ALLOWED_PREFIXES.join(" or ")}`);
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
        await unlink(RECORDING_PID_FILE).catch(() => { });
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
                unlink(RECORDING_PID_FILE).catch(() => { });
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
        await unlink(RECORDING_PID_FILE).catch(() => { });
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
        await unlink(RECORDING_PID_FILE).catch(() => { });
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
