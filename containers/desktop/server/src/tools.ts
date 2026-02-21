import { execFile } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type {
  ToolDefinition,
  ToolResult,
  ScreenshotResult,
  ScreenSizeResult,
  WindowInfo,
} from "./types.js";

const DISPLAY = process.env.DISPLAY ?? ":1";
const EXEC_TIMEOUT_MS = 30_000;
const BASH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 100 * 1024; // 100KB
const TYPE_CHUNK_SIZE = 50;
const TYPE_DELAY_MS = 12;

function exec(
  cmd: string,
  args: string[],
  timeoutMs = EXEC_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
        env: { ...process.env, DISPLAY },
      },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout, stderr });
      },
    );
  });
}

function ok(content: unknown): ToolResult {
  return { content: JSON.stringify(content) };
}

function fail(message: string): ToolResult {
  return { content: JSON.stringify({ error: message }), isError: true };
}

// --- Tool implementations ---

async function screenshot(): Promise<ToolResult> {
  const path = `/tmp/screenshot-${randomUUID()}.png`;
  try {
    try {
      await exec("scrot", ["-o", path]);
    } catch {
      // Fallback to ImageMagick
      await exec("import", ["-window", "root", path]);
    }
    const buf = await readFile(path);
    const size = await screenSize();
    const sizeData = JSON.parse(size.content) as ScreenSizeResult;
    const result: ScreenshotResult = {
      image: buf.toString("base64"),
      width: sizeData.width,
      height: sizeData.height,
    };
    return ok(result);
  } catch (e) {
    return fail(`Screenshot failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    unlink(path).catch(() => {});
  }
}

async function mouseClick(args: Record<string, unknown>): Promise<ToolResult> {
  const x = Number(args.x);
  const y = Number(args.y);
  const button = Number(args.button ?? 1);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return fail("x and y must be finite numbers");
  }
  if (button < 1 || button > 3) return fail("button must be 1, 2, or 3");
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
  } catch (e) {
    return fail(`mouse_click failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function mouseMove(args: Record<string, unknown>): Promise<ToolResult> {
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
  } catch (e) {
    return fail(`mouse_move failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function mouseDrag(args: Record<string, unknown>): Promise<ToolResult> {
  const startX = Number(args.startX);
  const startY = Number(args.startY);
  const endX = Number(args.endX);
  const endY = Number(args.endY);
  const button = Number(args.button ?? 1);
  if (
    [startX, startY, endX, endY].some((n) => !Number.isFinite(n))
  ) {
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
  } catch (e) {
    return fail(`mouse_drag failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function mouseScroll(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const clicks = Number(args.clicks ?? 3);
  const direction = String(args.direction ?? "down");
  const buttonMap: Record<string, string> = {
    up: "4",
    down: "5",
    left: "6",
    right: "7",
  };
  const btn = buttonMap[direction];
  if (!btn) return fail("direction must be up, down, left, or right");
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
  } catch (e) {
    return fail(`mouse_scroll failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function keyboardType(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const text = String(args.text ?? "");
  if (!text) return fail("text is required");
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
  } catch (e) {
    return fail(`keyboard_type failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function keyboardKey(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const key = String(args.key ?? "");
  if (!key) return fail("key is required");
  try {
    await exec("xdotool", ["key", "--", key]);
    return ok({ pressed: true, key });
  } catch (e) {
    return fail(`keyboard_key failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function bash(args: Record<string, unknown>): Promise<ToolResult> {
  const command = String(args.command ?? "");
  if (!command) return fail("command is required");
  const timeoutMs = Number(args.timeoutMs ?? BASH_TIMEOUT_MS);
  try {
    const { stdout, stderr } = await exec(
      "/bin/bash",
      ["-c", command],
      timeoutMs,
    );
    const output = stdout.length > MAX_OUTPUT_BYTES
      ? stdout.slice(0, MAX_OUTPUT_BYTES) + "\n... (truncated)"
      : stdout;
    return ok({ stdout: output, stderr, exitCode: 0 });
  } catch (e: unknown) {
    // Non-zero exit codes are reported, not thrown
    const err = e as { stdout?: string; stderr?: string; code?: number };
    if (err.code !== undefined && typeof err.code === "number") {
      return ok({
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        exitCode: err.code,
      });
    }
    return fail(`bash failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function windowList(): Promise<ToolResult> {
  try {
    const { stdout } = await exec("xdotool", ["search", "--name", ""]);
    const windowIds = stdout.trim().split("\n").filter(Boolean);
    const windows: WindowInfo[] = [];
    for (const id of windowIds.slice(0, 50)) {
      try {
        const { stdout: title } = await exec("xdotool", [
          "getwindowname",
          id,
        ]);
        windows.push({ id, title: title.trim() });
      } catch {
        windows.push({ id, title: "(unknown)" });
      }
    }
    return ok({ windows });
  } catch (e) {
    return fail(`window_list failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function windowFocus(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const title = String(args.title ?? "");
  if (!title) return fail("title is required");
  try {
    const { stdout } = await exec("xdotool", [
      "search",
      "--name",
      title,
    ]);
    const ids = stdout.trim().split("\n").filter(Boolean);
    if (ids.length === 0) return fail(`No window found matching "${title}"`);
    await exec("xdotool", ["windowactivate", ids[0]]);
    return ok({ focused: true, windowId: ids[0], title });
  } catch (e) {
    return fail(`window_focus failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function clipboardGet(): Promise<ToolResult> {
  try {
    const { stdout } = await exec("xclip", [
      "-selection",
      "clipboard",
      "-o",
    ]);
    return ok({ text: stdout });
  } catch (e) {
    return fail(
      `clipboard_get failed: ${e instanceof Error ? e.message : e}`,
    );
  }
}

async function clipboardSet(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const text = String(args.text ?? "");
  try {
    await new Promise<void>((resolve, reject) => {
      const proc = execFile(
        "xclip",
        ["-selection", "clipboard"],
        { env: { ...process.env, DISPLAY }, timeout: EXEC_TIMEOUT_MS },
        (err) => (err ? reject(err) : resolve()),
      );
      proc.stdin?.write(text);
      proc.stdin?.end();
    });
    return ok({ set: true, length: text.length });
  } catch (e) {
    return fail(
      `clipboard_set failed: ${e instanceof Error ? e.message : e}`,
    );
  }
}

async function screenSize(): Promise<ToolResult> {
  try {
    const { stdout } = await exec("xdpyinfo", ["-display", DISPLAY]);
    const match = stdout.match(/dimensions:\s+(\d+)x(\d+)/);
    if (!match) return fail("Could not parse display dimensions");
    const result: ScreenSizeResult = {
      width: parseInt(match[1], 10),
      height: parseInt(match[2], 10),
    };
    return ok(result);
  } catch (e) {
    return fail(`screen_size failed: ${e instanceof Error ? e.message : e}`);
  }
}

// --- Tool registry ---

type ToolHandler = (
  args: Record<string, unknown>,
) => Promise<ToolResult>;

const handlers: Record<string, ToolHandler> = {
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
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "screenshot",
    description:
      "Take a screenshot of the current desktop. Returns a base64-encoded PNG image with dimensions.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "mouse_click",
    description:
      "Move the mouse to (x, y) and click. Button: 1=left, 2=middle, 3=right.",
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
    description:
      "Click and drag from (startX, startY) to (endX, endY).",
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
    description:
      "Type text using the keyboard. Text is chunked to prevent X11 buffer overflow.",
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
    description:
      "Press a key or key combination (e.g. 'Return', 'ctrl+c', 'alt+Tab').",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description:
            "Key name or combination (e.g. 'Return', 'ctrl+c', 'alt+F4')",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "bash",
    description:
      "Execute a bash command in the desktop environment. Returns stdout, stderr, and exit code.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bash command to execute" },
        timeoutMs: {
          type: "number",
          description: "Timeout in milliseconds",
          default: 120000,
        },
      },
      required: ["command"],
    },
  },
  {
    name: "window_list",
    description:
      "List all open windows with their IDs and titles (up to 50).",
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
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const handler = handlers[name];
  if (!handler) {
    return { content: JSON.stringify({ error: `Unknown tool: ${name}` }), isError: true };
  }
  return handler(args);
}
