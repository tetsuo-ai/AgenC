/**
 * Desktop sandbox tool definitions — parameter schemas for the 16 desktop
 * automation tools exposed by the container REST API.
 *
 * These are used by the daemon to tell the LLM what parameters each desktop
 * tool accepts. They mirror the definitions in
 * `containers/desktop/server/src/tools.ts` but live inside the runtime so
 * they can be imported without pulling in the container code.
 *
 * @module
 */

export interface DesktopToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: DesktopToolDefinition[] = [
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
          default: 600000,
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
  {
    name: "text_editor",
    description:
      "View, create, and edit files. Commands: view (read file with line numbers), create (write new file), str_replace (find and replace exact string — must be unique), insert (insert text after a line number), undo_edit (revert last edit).",
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
          description:
            "Absolute file path (must be under /home/agenc or /tmp)",
        },
        file_text: {
          type: "string",
          description: "File content (for create command)",
        },
        old_str: {
          type: "string",
          description:
            "String to find (for str_replace — must match exactly once)",
        },
        new_str: {
          type: "string",
          description: "Replacement string (for str_replace and insert)",
        },
        insert_line: {
          type: "number",
          description:
            "Line number to insert after (0 = beginning of file, for insert command)",
        },
        view_range: {
          type: "array",
          items: { type: "number" },
          description:
            "Optional [startLine, endLine] range for view command (1-indexed)",
        },
      },
      required: ["command", "path"],
    },
  },
  {
    name: "video_start",
    description:
      "Start recording the desktop screen to an MP4 file using ffmpeg. Only one recording at a time. Returns the file path.",
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
    description:
      "Stop the active screen recording. Returns the file path and duration.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];
