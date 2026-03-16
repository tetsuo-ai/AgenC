import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveValidatedTextEditorPath } from "./textEditorPath.js";
import type { ToolResult } from "./types.js";
import { ok, fail } from "./tools-shared.js";

const MAX_FILE_SIZE = 1024 * 1024; // 1MB
const MAX_UNDO_FILES = 20;

/** LRU undo buffer — stores the single most recent version per file. */
const undoBuffer = new Map<string, string>();

function numberLines(text: string, startLine = 1): string {
  return text
    .split("\n")
    .map((line, i) => `${String(i + startLine).padStart(6, " ")}\t${line}`)
    .join("\n");
}

export async function textEditor(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const command = args.command;
  const inputPath = args.path;

  if (typeof command !== "string" || !command) {
    return fail("command is required");
  }
  if (typeof inputPath !== "string" || !inputPath) {
    return fail("path is required");
  }

  let path: string;
  try {
    path = await resolveValidatedTextEditorPath(inputPath);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }

  switch (command) {
    case "view":
      return textEditorView(path, args.view_range as unknown);
    case "create":
      return textEditorCreate(path, String(args.file_text ?? ""));
    case "str_replace":
      return textEditorStrReplace(
        path,
        String(args.old_str ?? ""),
        String(args.new_str ?? ""),
      );
    case "insert":
      return textEditorInsert(
        path,
        Number(args.insert_line ?? 0),
        String(args.new_str ?? ""),
      );
    case "undo_edit":
      return textEditorUndo(path);
    default:
      return fail(
        `Unknown command: ${command}. Must be one of: view, create, str_replace, insert, undo_edit`,
      );
  }
}

async function textEditorView(
  path: string,
  viewRange: unknown,
): Promise<ToolResult> {
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
      if (start > end) return fail(`Invalid range: [${start}, ${end}]`);
      const slice = lines.slice(start - 1, end);
      return ok({ output: numberLines(slice.join("\n"), start) });
    }

    return ok({ output: numberLines(content) });
  } catch (e) {
    return fail(`Failed to read ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

async function textEditorCreate(
  path: string,
  fileText: string,
): Promise<ToolResult> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, fileText, "utf-8");
    return ok({ output: `File created at ${path} (${fileText.split("\n").length} lines)` });
  } catch (e) {
    return fail(`Failed to create ${path}: ${e instanceof Error ? e.message : e}`);
  }
}

async function textEditorStrReplace(
  path: string,
  oldStr: string,
  newStr: string,
): Promise<ToolResult> {
  if (!oldStr) return fail("old_str is required for str_replace");

  try {
    const content = await readFile(path, "utf-8");
    const occurrences = content.split(oldStr).length - 1;

    if (occurrences === 0) {
      return fail(
        `old_str not found in ${path}. Make sure the string matches exactly, including whitespace.`,
      );
    }
    if (occurrences > 1) {
      return fail(
        `old_str found ${occurrences} times in ${path}. Provide more context to make it unique.`,
      );
    }

    // Save undo state (LRU eviction)
    if (undoBuffer.size >= MAX_UNDO_FILES && !undoBuffer.has(path)) {
      const oldest = undoBuffer.keys().next().value as string;
      undoBuffer.delete(oldest);
    }
    undoBuffer.delete(path); // Re-insert at end for LRU
    undoBuffer.set(path, content);

    const updated = content.replace(oldStr, newStr);
    await writeFile(path, updated, "utf-8");
    return ok({ output: `Replacement applied in ${path}` });
  } catch (e) {
    return fail(`str_replace failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function textEditorInsert(
  path: string,
  insertLine: number,
  newStr: string,
): Promise<ToolResult> {
  try {
    const content = await readFile(path, "utf-8");
    const lines = content.split("\n");

    if (insertLine < 0 || insertLine > lines.length) {
      return fail(
        `insert_line ${insertLine} out of range (0-${lines.length}). Use 0 to insert at the beginning.`,
      );
    }

    // Save undo state (LRU eviction)
    if (undoBuffer.size >= MAX_UNDO_FILES && !undoBuffer.has(path)) {
      const oldest = undoBuffer.keys().next().value as string;
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
  } catch (e) {
    return fail(`insert failed: ${e instanceof Error ? e.message : e}`);
  }
}

async function textEditorUndo(path: string): Promise<ToolResult> {
  const prev = undoBuffer.get(path);
  if (prev === undefined) {
    return fail(`No undo history for ${path}`);
  }
  try {
    await writeFile(path, prev, "utf-8");
    undoBuffer.delete(path);
    return ok({ output: `Reverted ${path} to previous version` });
  } catch (e) {
    return fail(`undo_edit failed: ${e instanceof Error ? e.message : e}`);
  }
}
