import { execFile } from "node:child_process";
import type { ToolResult, ScreenSizeResult, WindowInfo } from "./types.js";
import { DISPLAY, EXEC_TIMEOUT_MS, exec, ok, fail } from "./tools-shared.js";

export async function windowList(): Promise<ToolResult> {
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
  } catch (e) {
    return fail(`window_list failed: ${e instanceof Error ? e.message : e}`);
  }
}

export async function windowFocus(
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

export async function clipboardGet(): Promise<ToolResult> {
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

export async function clipboardSet(
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

export async function screenSize(): Promise<ToolResult> {
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
