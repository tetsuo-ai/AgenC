import type { ToolResult } from "./types.js";
import { exec, ok, fail } from "./tools-shared.js";

const TYPE_CHUNK_SIZE = 50;
const TYPE_DELAY_MS = 12;

export async function mouseClick(args: Record<string, unknown>): Promise<ToolResult> {
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

export async function mouseMove(args: Record<string, unknown>): Promise<ToolResult> {
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

export async function mouseDrag(args: Record<string, unknown>): Promise<ToolResult> {
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

export async function mouseScroll(
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

export async function keyboardType(
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

export async function keyboardKey(
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
