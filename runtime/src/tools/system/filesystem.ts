/**
 * Filesystem tools for @agenc/runtime
 *
 * Provides 8 tools for reading, writing, listing, and managing files
 * on the host system. All operations are gated by configurable path
 * allowlists with path traversal prevention and size limits.
 *
 * Tools:
 * - system.readFile — read file contents (text or base64)
 * - system.writeFile — write file (creates parent dirs)
 * - system.appendFile — append to file
 * - system.listDir — list directory entries
 * - system.stat — file/directory metadata
 * - system.mkdir — create directories
 * - system.delete — delete file/directory (requires opt-in)
 * - system.move — rename/move file or directory
 *
 * @module
 */

import {
  readFile,
  writeFile,
  appendFile,
  opendir,
  stat,
  lstat,
  mkdir,
  rm,
  rename,
  realpath,
} from "node:fs/promises";
import { resolve, dirname, relative, isAbsolute, basename } from "node:path";
import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";

const DEFAULT_MAX_READ_BYTES = 10_485_760; // 10 MB
const DEFAULT_MAX_WRITE_BYTES = 10_485_760; // 10 MB
const MAX_LIST_ENTRIES = 10_000;
const MAX_PATH_LENGTH = 4096;

/**
 * Filesystem tool configuration.
 *
 * **Security note:** This sandbox is path-based and does NOT protect against:
 * - TOCTOU races from concurrent filesystem access on the same host
 * - Hard-link escapes (in-sandbox hard link to out-of-sandbox inode)
 * For adversarial environments, use OS-level sandboxing (chroot, namespaces).
 *
 * **Memory note:** `readFile` loads the entire file into memory. With the
 * default 10 MB limit, peak memory per read can reach ~40 MB (buffer +
 * string encoding + JSON serialization). Adjust limits accordingly.
 */
export interface FilesystemToolConfig {
  /** Allowed path prefixes (required — no default to force explicit opt-in). */
  readonly allowedPaths: readonly string[];
  /** Max file size for reads in bytes (default: 10 MB). Peak memory ~4x this value. */
  readonly maxReadBytes?: number;
  /** Max file size for writes in bytes (default: 10 MB). */
  readonly maxWriteBytes?: number;
  /** Whether delete operations are allowed (default: false). */
  readonly allowDelete?: boolean;
}

/** Return a JSON error ToolResult without throwing. */
function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

/** Format error for fallback catch without leaking resolved internal paths. */
function safeError(err: unknown, operation: string): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code ? `${code}: ${operation} failed` : `${operation} failed`;
}

/** Check if any path segment is exactly `..` or contains URL-encoded separators/nulls. */
function hasTraversalSegment(rawPath: string): boolean {
  // Defence-in-depth: reject URL-encoded path separators and null bytes
  if (/%2f/i.test(rawPath) || /%5c/i.test(rawPath) || /%00/i.test(rawPath)) {
    return true;
  }
  return rawPath.split(/[/\\]+/).some((seg) => seg === "..");
}

/**
 * Resolve a path to its canonical form, following symlinks.
 * For non-existent targets (write/mkdir destinations), walks up ancestors
 * until it finds one that exists, canonicalizes it, then recomposes
 * the remaining segments.
 */
async function canonicalize(targetPath: string): Promise<string> {
  const abs = resolve(targetPath);
  try {
    return await realpath(abs);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOENT") throw e;
    // Walk up ancestors until we find one that exists
    const segments: string[] = [];
    let current = abs;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      segments.unshift(basename(current));
      const parent = dirname(current);
      if (parent === current) {
        // Reached filesystem root — nothing resolved, return as-is
        return abs;
      }
      current = parent;
      try {
        const parentReal = await realpath(current);
        return resolve(parentReal, ...segments);
      } catch (parentErr) {
        const pe = parentErr as NodeJS.ErrnoException;
        if (pe.code !== "ENOENT") throw pe;
        // Keep walking up
      }
    }
  }
}

/** Check if `candidate` is contained within `base` using relative path analysis. */
function isWithin(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a path and check for traversal attacks.
 *
 * Defence-in-depth:
 * 1. Reject null bytes
 * 2. Reject raw `..` segments before resolution (segment-aware)
 * 3. Canonicalize via realpath to follow symlinks
 * 4. Verify canonical path is within an allowed prefix
 */
export async function safePath(
  targetPath: string,
  allowedPaths: readonly string[],
): Promise<{ safe: boolean; resolved: string; reason?: string }> {
  try {
    if (typeof targetPath !== "string" || targetPath.trim().length === 0) {
      return {
        safe: false,
        resolved: "",
        reason: "Path must be a non-empty string",
      };
    }

    // Reject null bytes (resolve() throws on these — catch proactively)
    if (targetPath.includes("\0")) {
      return { safe: false, resolved: "", reason: "Path contains null byte" };
    }

    // Defence-in-depth: reject explicit traversal segments before resolution
    if (hasTraversalSegment(targetPath)) {
      return { safe: false, resolved: "", reason: "Path traversal detected" };
    }

    // Reject excessively long paths (OS-level PATH_MAX)
    if (resolve(targetPath).length > MAX_PATH_LENGTH) {
      return {
        safe: false,
        resolved: "",
        reason: "Path exceeds maximum length",
      };
    }

    if (allowedPaths.length === 0) {
      return {
        safe: false,
        resolved: "",
        reason: "No allowed paths configured",
      };
    }

    // Canonicalize target (follows symlinks, normalize Unicode for macOS HFS+/APFS)
    const canonical = (await canonicalize(targetPath)).normalize("NFC");

    for (const allowed of allowedPaths) {
      // Canonicalize each allowed path too (follows symlinks in allowlist)
      let canonicalAllowed: string;
      try {
        canonicalAllowed = (await realpath(resolve(allowed))).normalize("NFC");
      } catch {
        canonicalAllowed = resolve(allowed).normalize("NFC");
      }

      if (isWithin(canonicalAllowed, canonical)) {
        return { safe: true, resolved: canonical };
      }
    }

    // Don't leak canonical host path on denial
    return {
      safe: false,
      resolved: "",
      reason: "Path is outside allowed directories",
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      safe: false,
      resolved: "",
      reason: code ? `Invalid path (${code})` : "Invalid path",
    };
  }
}

/**
 * Check if a path is within allowed directories.
 * Convenience wrapper around {@link safePath}.
 */
export async function isPathAllowed(
  targetPath: string,
  allowedPaths: readonly string[],
): Promise<boolean> {
  return (await safePath(targetPath, allowedPaths)).safe;
}

/** Validate and resolve a path argument from tool input. */
async function validatePath(
  input: unknown,
  allowedPaths: readonly string[],
  paramName = "path",
): Promise<[string | null, ToolResult | null]> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return [null, errorResult(`${paramName} must be a non-empty string`)];
  }
  const result = await safePath(input, allowedPaths);
  if (!result.safe) {
    return [null, errorResult(`Access denied: ${result.reason}`)];
  }
  return [result.resolved, null];
}

const VALID_ENCODINGS = new Set(["utf-8", "base64"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Detect if file content is likely binary (contains null bytes). */
function isBinaryContent(buffer: Buffer): boolean {
  for (let i = 0; i < Math.min(buffer.length, 8192); i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// ============================================================================
// Tool Factories
// ============================================================================

function createReadFileTool(
  allowedPaths: readonly string[],
  maxReadBytes: number,
): Tool {
  return {
    name: "system.readFile",
    description:
      "Read a file from the filesystem. Returns text content (UTF-8) by default, or base64 for binary files. Gated by path allowlist and size limits.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path to read",
        },
        encoding: {
          type: "string",
          enum: ["utf-8", "base64"],
          description:
            "Output encoding (default: auto-detect — utf-8 for text, base64 for binary)",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [resolved, pathErr] = await validatePath(args.path, allowedPaths);
        if (pathErr) return pathErr;

        if (
          args.encoding !== undefined &&
          !VALID_ENCODINGS.has(args.encoding as string)
        ) {
          return errorResult(
            `Invalid encoding: ${args.encoding}. Must be utf-8 or base64.`,
          );
        }

        const fileStats = await stat(resolved!);
        if (!fileStats.isFile()) {
          return errorResult("Path is not a regular file");
        }
        if (fileStats.size > maxReadBytes) {
          return errorResult(
            `File size ${fileStats.size} bytes exceeds limit of ${maxReadBytes} bytes`,
          );
        }

        const buffer = await readFile(resolved!);
        // Post-read size guard (mitigates TOCTOU between stat and readFile)
        if (buffer.length > maxReadBytes) {
          return errorResult(
            `File size ${buffer.length} bytes exceeds limit of ${maxReadBytes} bytes`,
          );
        }
        const forceEncoding = args.encoding as string | undefined;
        const binary =
          forceEncoding === "base64" ||
          (!forceEncoding && isBinaryContent(buffer));

        return {
          content: safeStringify({
            path: args.path,
            size: buffer.length,
            encoding: binary ? "base64" : "utf-8",
            content: binary
              ? buffer.toString("base64")
              : buffer.toString("utf-8"),
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT"))
          return errorResult(`File not found: ${args.path}`);
        if (msg.includes("EACCES"))
          return errorResult(`Permission denied: ${args.path}`);
        return errorResult(safeError(err, "read"));
      }
    },
  };
}

function createWriteFileTool(
  allowedPaths: readonly string[],
  maxWriteBytes: number,
): Tool {
  return {
    name: "system.writeFile",
    description:
      "Write content to a file. Creates parent directories if needed. Gated by path allowlist and size limits.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path to write",
        },
        content: {
          type: "string",
          description: "Text content to write",
        },
        encoding: {
          type: "string",
          enum: ["utf-8", "base64"],
          description:
            "Input encoding (default: utf-8). Use base64 for binary data.",
        },
      },
      required: ["path", "content"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [resolved, pathErr] = await validatePath(args.path, allowedPaths);
        if (pathErr) return pathErr;

        if (typeof args.content !== "string") {
          return errorResult("content must be a string");
        }

        const encoding = (args.encoding as string) || "utf-8";
        if (!VALID_ENCODINGS.has(encoding)) {
          return errorResult(
            `Invalid encoding: ${encoding}. Must be utf-8 or base64.`,
          );
        }

        if (encoding === "base64") {
          // Pre-check encoded string length before regex/decode to prevent memory exhaustion
          const maxBase64Length = Math.ceil(maxWriteBytes / 3) * 4 + 4;
          if (args.content.length > maxBase64Length) {
            return errorResult(
              `Base64 content too large (decoded would exceed ${maxWriteBytes} bytes)`,
            );
          }
          if (args.content.length % 4 !== 0 || !BASE64_RE.test(args.content)) {
            return errorResult("Invalid base64 content");
          }
        }
        const data =
          encoding === "base64"
            ? Buffer.from(args.content, "base64")
            : Buffer.from(args.content, "utf-8");

        if (data.length > maxWriteBytes) {
          return errorResult(
            `Content size ${data.length} bytes exceeds limit of ${maxWriteBytes} bytes`,
          );
        }

        await mkdir(dirname(resolved!), { recursive: true });
        await writeFile(resolved!, data);
        return {
          content: safeStringify({
            path: args.path,
            bytesWritten: data.length,
          }),
        };
      } catch (err) {
        return errorResult(safeError(err, "write"));
      }
    },
  };
}

function createAppendFileTool(
  allowedPaths: readonly string[],
  maxWriteBytes: number,
): Tool {
  return {
    name: "system.appendFile",
    description:
      "Append content to an existing file. Creates the file if it does not exist. Gated by path allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path to append to",
        },
        content: {
          type: "string",
          description: "Text content to append",
        },
      },
      required: ["path", "content"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [resolved, pathErr] = await validatePath(args.path, allowedPaths);
        if (pathErr) return pathErr;

        if (typeof args.content !== "string") {
          return errorResult("content must be a string");
        }

        const data = Buffer.from(args.content, "utf-8");
        if (data.length > maxWriteBytes) {
          return errorResult(
            `Content size ${data.length} bytes exceeds limit of ${maxWriteBytes} bytes`,
          );
        }

        // Check total resulting file size to prevent disk exhaustion via repeated appends
        try {
          const existing = await stat(resolved!);
          if (existing.size + data.length > maxWriteBytes) {
            return errorResult(
              `Resulting file size ${existing.size + data.length} bytes exceeds limit of ${maxWriteBytes} bytes`,
            );
          }
        } catch {
          // File doesn't exist yet — just the append size matters (checked above)
        }

        // Create parent directories if needed (consistent with writeFile)
        await mkdir(dirname(resolved!), { recursive: true });
        await appendFile(resolved!, data);
        return {
          content: safeStringify({
            path: args.path,
            bytesAppended: data.length,
          }),
        };
      } catch (err) {
        return errorResult(safeError(err, "append"));
      }
    },
  };
}

function createListDirTool(allowedPaths: readonly string[]): Tool {
  return {
    name: "system.listDir",
    description:
      "List directory contents. Returns entry names, types (file/dir), and sizes. Gated by path allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative directory path",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [resolved, pathErr] = await validatePath(args.path, allowedPaths);
        if (pathErr) return pathErr;

        const dir = await opendir(resolved!);
        const entries: { name: string; type: string; size: number }[] = [];
        let truncated = false;
        try {
          for await (const d of dir) {
            if (entries.length >= MAX_LIST_ENTRIES) {
              truncated = true;
              break;
            }
            const entryPath = resolve(resolved!, d.name);
            let size = 0;
            if (d.isFile()) {
              try {
                const s = await lstat(entryPath);
                size = s.size;
              } catch {
                // lstat may fail for race conditions; skip size
              }
            }
            const type = d.isDirectory()
              ? "dir"
              : d.isFile()
                ? "file"
                : d.isSymbolicLink()
                  ? "symlink"
                  : "other";
            entries.push({ name: d.name, type, size });
          }
        } finally {
          await dir.close().catch(() => {});
        }
        return {
          content: safeStringify({
            path: args.path,
            entries,
            ...(truncated ? { truncated: true } : {}),
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT"))
          return errorResult(`Directory not found: ${args.path}`);
        if (msg.includes("ENOTDIR"))
          return errorResult(`Not a directory: ${args.path}`);
        return errorResult(safeError(err, "list"));
      }
    },
  };
}

function createStatTool(allowedPaths: readonly string[]): Tool {
  return {
    name: "system.stat",
    description:
      "Get file or directory metadata including size, timestamps, and type. Gated by path allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to stat",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [resolved, pathErr] = await validatePath(args.path, allowedPaths);
        if (pathErr) return pathErr;

        const s = await stat(resolved!);
        return {
          content: safeStringify({
            path: args.path,
            size: s.size,
            modified: s.mtime.toISOString(),
            created: s.birthtime.toISOString(),
            isDirectory: s.isDirectory(),
            isFile: s.isFile(),
            permissions: `0${(s.mode & 0o777).toString(8)}`,
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT"))
          return errorResult(`Path not found: ${args.path}`);
        return errorResult(safeError(err, "stat"));
      }
    },
  };
}

function createMkdirTool(allowedPaths: readonly string[]): Tool {
  return {
    name: "system.mkdir",
    description:
      "Create a directory. Creates parent directories as needed. Gated by path allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative directory path to create",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [resolved, pathErr] = await validatePath(args.path, allowedPaths);
        if (pathErr) return pathErr;

        await mkdir(resolved!, { recursive: true });
        return {
          content: safeStringify({ path: args.path, created: true }),
        };
      } catch (err) {
        return errorResult(safeError(err, "mkdir"));
      }
    },
  };
}

function createDeleteTool(
  allowedPaths: readonly string[],
  allowDelete: boolean,
): Tool {
  return {
    name: "system.delete",
    description:
      "Delete a file or directory. Requires explicit opt-in via allowDelete config. Gated by path allowlist.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path to delete",
        },
        recursive: {
          type: "boolean",
          description: "Required to delete directories. Defaults to false.",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        // Validate path first — don't leak path validity via allowDelete check order
        const [resolved, pathErr] = await validatePath(args.path, allowedPaths);
        if (pathErr) return pathErr;

        if (!allowDelete) {
          return errorResult(
            "Delete operations are disabled. Set allowDelete: true in config.",
          );
        }

        // Prevent deletion of sandbox root directories
        for (const allowed of allowedPaths) {
          let canonicalAllowed: string;
          try {
            canonicalAllowed = (await realpath(allowed)).normalize("NFC");
          } catch {
            canonicalAllowed = allowed.normalize("NFC");
          }
          if (resolved === canonicalAllowed) {
            return errorResult("Cannot delete sandbox root directory");
          }
        }

        // Check if target is a directory — require explicit recursive opt-in
        const targetStat = await stat(resolved!);
        if (targetStat.isDirectory() && args.recursive !== true) {
          return errorResult("Cannot delete directory without recursive: true");
        }

        await rm(resolved!, { recursive: args.recursive === true });
        return {
          content: safeStringify({ path: args.path, deleted: true }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT"))
          return errorResult(`Path not found: ${args.path}`);
        return errorResult(safeError(err, "delete"));
      }
    },
  };
}

function createMoveTool(allowedPaths: readonly string[]): Tool {
  return {
    name: "system.move",
    description:
      "Move or rename a file or directory. Both source and destination must be within allowed paths.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "Source path",
        },
        destination: {
          type: "string",
          description: "Destination path",
        },
      },
      required: ["source", "destination"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const [src, srcErr] = await validatePath(
          args.source,
          allowedPaths,
          "source",
        );
        if (srcErr) return srcErr;

        const [dst, dstErr] = await validatePath(
          args.destination,
          allowedPaths,
          "destination",
        );
        if (dstErr) return dstErr;

        await mkdir(dirname(dst!), { recursive: true });
        await rename(src!, dst!);
        return {
          content: safeStringify({
            source: args.source,
            destination: args.destination,
            moved: true,
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("ENOENT"))
          return errorResult(`Source not found: ${args.source}`);
        return errorResult(safeError(err, "move"));
      }
    },
  };
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Create all filesystem tools (8 tools).
 *
 * @param config - Filesystem tool configuration with allowed paths and limits
 * @returns Array of Tool instances
 *
 * @example
 * ```typescript
 * const tools = createFilesystemTools({
 *   allowedPaths: ['~/.agenc/workspace/'],
 *   maxReadBytes: 5_000_000,
 *   allowDelete: false,
 * });
 * registry.registerAll(tools);
 * ```
 */
export function createFilesystemTools(config: FilesystemToolConfig): Tool[] {
  // ── Config validation (Finding 1 + 2) ──────────────────────────────────
  if (!Array.isArray(config.allowedPaths) || config.allowedPaths.length === 0) {
    throw new TypeError("allowedPaths must be a non-empty array of strings");
  }
  for (const p of config.allowedPaths) {
    if (typeof p !== "string" || p.trim().length === 0) {
      throw new TypeError(
        `Each allowedPaths entry must be a non-empty string, got: ${typeof p}`,
      );
    }
  }
  const allowedPaths = config.allowedPaths.map((p) =>
    resolve(p).normalize("NFC"),
  );

  const maxReadBytes = config.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  if (!Number.isFinite(maxReadBytes) || maxReadBytes <= 0) {
    throw new TypeError(
      `maxReadBytes must be a positive finite number, got: ${maxReadBytes}`,
    );
  }
  const maxWriteBytes = config.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES;
  if (!Number.isFinite(maxWriteBytes) || maxWriteBytes <= 0) {
    throw new TypeError(
      `maxWriteBytes must be a positive finite number, got: ${maxWriteBytes}`,
    );
  }
  const allowDelete = config.allowDelete ?? false;
  if (allowDelete !== true && allowDelete !== false) {
    throw new TypeError(
      `allowDelete must be a boolean, got: ${typeof allowDelete}`,
    );
  }

  return [
    createReadFileTool(allowedPaths, maxReadBytes),
    createWriteFileTool(allowedPaths, maxWriteBytes),
    createAppendFileTool(allowedPaths, maxWriteBytes),
    createListDirTool(allowedPaths),
    createStatTool(allowedPaths),
    createMkdirTool(allowedPaths),
    createDeleteTool(allowedPaths, allowDelete),
    createMoveTool(allowedPaths),
  ];
}
