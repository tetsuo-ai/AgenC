/**
 * Typed PDF inspection/extraction tools for @agenc/runtime.
 *
 * Provides:
 * - system.pdfInfo — inspect PDF metadata using pdfinfo
 * - system.pdfExtractText — extract text content using pdftotext
 *
 * @module
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { silentLogger } from "../../utils/logger.js";
import { resolveToolAllowedPaths, safePath } from "./filesystem.js";
import type { SystemPdfToolConfig } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_MAX_CHARS_CAP = 500_000;
const PDF_SIGNATURE = "%PDF-";

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function validateAllowedPaths(allowedPaths: readonly string[]): string[] {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    throw new TypeError("allowedPaths must be a non-empty array of strings");
  }
  return allowedPaths.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError("Each allowedPaths entry must be a non-empty string");
    }
    return entry;
  });
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("Expected a positive finite integer");
  }
  return Math.min(Math.floor(value), maximum);
}

async function resolvePdfPath(
  rawPath: unknown,
  allowedPaths: readonly string[],
  args: Record<string, unknown>,
): Promise<string | ToolResult> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return errorResult("Missing or invalid path");
  }
  const safe = await safePath(rawPath, resolveToolAllowedPaths(allowedPaths, args));
  if (!safe.safe) {
    return errorResult(safe.reason ?? "PDF path is outside allowed directories");
  }
  return safe.resolved;
}

async function assertPdfSignature(path: string): Promise<void> {
  const handle = await readFile(path);
  if (!handle.subarray(0, PDF_SIGNATURE.length).toString("utf8").startsWith(PDF_SIGNATURE)) {
    throw new Error("File does not look like a PDF");
  }
}

function truncateText(text: string, maxChars: number): {
  readonly text: string;
  readonly truncated: boolean;
} {
  return text.length > maxChars
    ? { text: `${text.slice(0, maxChars)}…`, truncated: true }
    : { text, truncated: false };
}

function parsePdfInfo(raw: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const line of raw.split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key) {
      continue;
    }
    metadata[key] = /^\d+$/u.test(value) ? Number(value) : value;
  }
  return metadata;
}

function parsePageRange(args: Record<string, unknown>): {
  readonly startPage?: number;
  readonly endPage?: number;
} {
  const page = args.page;
  if (page !== undefined) {
    const normalized = normalizePositiveInteger(page, 1, Number.MAX_SAFE_INTEGER);
    return { startPage: normalized, endPage: normalized };
  }
  const startPage =
    args.startPage === undefined
      ? undefined
      : normalizePositiveInteger(args.startPage, 1, Number.MAX_SAFE_INTEGER);
  const endPage =
    args.endPage === undefined
      ? undefined
      : normalizePositiveInteger(args.endPage, 1, Number.MAX_SAFE_INTEGER);
  if (
    startPage !== undefined &&
    endPage !== undefined &&
    startPage > endPage
  ) {
    throw new TypeError("startPage cannot be greater than endPage");
  }
  return { startPage, endPage };
}

function createPdfInfoTool(
  allowedPaths: readonly string[],
  timeoutMs: number,
  logger = silentLogger,
): Tool {
  return {
    name: "system.pdfInfo",
    description:
      "Inspect a local PDF file and return parsed metadata such as page count, title, author, and encryption state.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the PDF file.",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolvePdfPath(args.path, allowedPaths, args);
      if (typeof resolved !== "string") {
        return resolved;
      }
      try {
        await assertPdfSignature(resolved);
        const { stdout } = await execFileAsync("pdfinfo", [resolved], {
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: 512 * 1024,
        });
        const metadata = parsePdfInfo(stdout);
        return {
          content: safeStringify({
            path: resolved,
            metadata,
            pages: metadata.Pages,
            title: metadata.Title,
            author: metadata.Author,
            encrypted: metadata.Encrypted,
            pageSize: metadata["Page size"],
          }),
        };
      } catch (error) {
        logger.warn?.("system.pdfInfo failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error ? error.message : "Failed to inspect PDF",
        );
      }
    },
  };
}

function createPdfExtractTextTool(
  allowedPaths: readonly string[],
  timeoutMs: number,
  defaultMaxChars: number,
  maxCharsCap: number,
  logger = silentLogger,
): Tool {
  return {
    name: "system.pdfExtractText",
    description:
      "Extract UTF-8 text from a local PDF file, optionally constrained to a page or page range.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to the PDF file.",
        },
        page: {
          type: "number",
          description: "Extract a single 1-based page.",
        },
        startPage: {
          type: "number",
          description: "Start of a 1-based inclusive page range.",
        },
        endPage: {
          type: "number",
          description: "End of a 1-based inclusive page range.",
        },
        layout: {
          type: "boolean",
          description: "Preserve original layout spacing when true.",
          default: false,
        },
        maxChars: {
          type: "number",
          description: `Maximum extracted characters to return (default ${defaultMaxChars}, capped at ${maxCharsCap}).`,
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolvePdfPath(args.path, allowedPaths, args);
      if (typeof resolved !== "string") {
        return resolved;
      }
      try {
        await assertPdfSignature(resolved);
        const { startPage, endPage } = parsePageRange(args);
        const maxChars = normalizePositiveInteger(
          args.maxChars,
          defaultMaxChars,
          maxCharsCap,
        );
        const commandArgs = [
          "-enc",
          "UTF-8",
          ...(args.layout === true ? ["-layout"] : []),
          ...(startPage !== undefined ? ["-f", String(startPage)] : []),
          ...(endPage !== undefined ? ["-l", String(endPage)] : []),
          resolved,
          "-",
        ];
        const { stdout } = await execFileAsync("pdftotext", commandArgs, {
          encoding: "utf8",
          timeout: timeoutMs,
          maxBuffer: Math.max(maxChars * 4, 512 * 1024),
        });
        const trimmed = stdout.trim();
        const extracted = truncateText(trimmed, maxChars);
        return {
          content: safeStringify({
            path: resolved,
            pageRange:
              startPage !== undefined || endPage !== undefined
                ? {
                    startPage: startPage ?? endPage,
                    endPage: endPage ?? startPage,
                  }
                : undefined,
            text: extracted.text,
            truncated: extracted.truncated,
            characters: trimmed.length,
          }),
        };
      } catch (error) {
        logger.warn?.("system.pdfExtractText failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error ? error.message : "Failed to extract PDF text",
        );
      }
    },
  };
}

export function createPdfTools(config: SystemPdfToolConfig): Tool[] {
  const allowedPaths = validateAllowedPaths(config.allowedPaths);
  const timeoutMs = normalizePositiveInteger(
    config.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    Number.MAX_SAFE_INTEGER,
  );
  const defaultMaxChars = normalizePositiveInteger(
    config.defaultMaxChars,
    DEFAULT_MAX_CHARS,
    DEFAULT_MAX_CHARS_CAP,
  );
  const maxCharsCap = normalizePositiveInteger(
    config.maxCharsCap,
    Math.max(DEFAULT_MAX_CHARS_CAP, defaultMaxChars),
    Number.MAX_SAFE_INTEGER,
  );
  const logger = config.logger ?? silentLogger;

  return [
    createPdfInfoTool(allowedPaths, timeoutMs, logger),
    createPdfExtractTextTool(
      allowedPaths,
      timeoutMs,
      defaultMaxChars,
      maxCharsCap,
      logger,
    ),
  ];
}
