import type {
  DesktopToolDefinition,
} from "@tetsuo-ai/desktop-tool-contracts";
import {
  TOOL_DEFINITIONS,
} from "@tetsuo-ai/desktop-tool-contracts";
import type { ToolResult } from "./types.js";

export { TOOL_DEFINITIONS } from "@tetsuo-ai/desktop-tool-contracts";

// Re-export public APIs from sub-modules
export {
  type DesktopToolEvent,
  subscribeDesktopToolEvents,
  __managedProcessTestHooks,
} from "./tools-process.js";

// --- Input tools ---
import {
  mouseClick,
  mouseMove,
  mouseDrag,
  mouseScroll,
  keyboardType,
  keyboardKey,
} from "./tools-input.js";

// --- Window management tools ---
import {
  windowList,
  windowFocus,
  clipboardGet,
  clipboardSet,
  screenSize,
} from "./tools-window.js";

// --- Process & bash tools ---
import {
  bash,
  processStart,
  processStatus,
  processStop,
} from "./tools-process.js";

// --- Media tools ---
import { screenshot, videoStart, videoStop } from "./tools-media.js";

// --- Text editor tool ---
import { textEditor } from "./tools-editor.js";

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

export function validateDesktopToolHandlers(
  definitions: readonly DesktopToolDefinition[] = TOOL_DEFINITIONS,
): void {
  const missingHandlers = definitions
    .map((definition) => definition.name)
    .filter((name) => !(name in handlers));
  if (missingHandlers.length > 0) {
    throw new Error(
      `Desktop tool contract is missing handlers for: ${missingHandlers.join(", ")}`,
    );
  }

  const definitionNames = new Set(definitions.map((definition) => definition.name));
  const orphanHandlers = Object.keys(handlers).filter((name) => !definitionNames.has(name));
  if (orphanHandlers.length > 0) {
    throw new Error(
      `Desktop tool handlers are missing contract definitions for: ${orphanHandlers.join(", ")}`,
    );
  }
}

validateDesktopToolHandlers();

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
