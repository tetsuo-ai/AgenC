/**
 * Typed office-document inspection/extraction tools for @agenc/runtime.
 *
 * Provides:
 * - system.officeDocumentInfo — inspect local DOCX/ODT metadata
 * - system.officeDocumentExtractText — extract text from local DOCX/ODT documents
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { silentLogger } from "../../utils/logger.js";
import { resolveToolAllowedPaths, safePath } from "./filesystem.js";
import type { SystemOfficeDocumentToolConfig } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_MAX_CHARS_CAP = 500_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

const PYTHON_OFFICE_DOCUMENT_HELPER = String.raw`
import json
import pathlib
import sys
import xml.etree.ElementTree as ET
import zipfile

DOCX_CORE_NS = "http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
DC_NS = "http://purl.org/dc/elements/1.1/"
DCTERMS_NS = "http://purl.org/dc/terms/"
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
ODF_TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
ODF_META_NS = "urn:oasis:names:tc:opendocument:xmlns:meta:1.0"
ODF_DC_NS = "http://purl.org/dc/elements/1.1/"

def fail(message):
    raise RuntimeError(message)

def infer_format(path):
    suffix = pathlib.Path(path).suffix.lower()
    if suffix == ".docx":
        return "docx"
    if suffix == ".odt":
        return "odt"
    fail(f"Unsupported office document format: {suffix or 'unknown'}")

def truncate_text(text, max_chars):
    if len(text) > max_chars:
        return text[:max_chars] + "…", True
    return text, False

def parse_docx(path):
    with zipfile.ZipFile(path) as zf:
        metadata = {}
        try:
            core = ET.fromstring(zf.read("docProps/core.xml"))
            for tag in ("title", "subject", "creator", "description", "language"):
                node = core.find(f"{{{DC_NS}}}{tag}")
                if node is not None and node.text:
                    metadata[tag] = node.text
            modified = core.find(f"{{{DCTERMS_NS}}}modified")
            if modified is not None and modified.text:
                metadata["modified"] = modified.text
        except KeyError:
            pass
        document = ET.fromstring(zf.read("word/document.xml"))
        parts = []
        paragraphs = 0
        for para in document.iterfind(f".//{{{W_NS}}}p"):
            texts = [node.text or "" for node in para.iterfind(f".//{{{W_NS}}}t")]
            if texts:
                parts.append("".join(texts))
            paragraphs += 1
        text = "\n".join(part for part in parts if part)
        return metadata, text, {"paragraphs": paragraphs}

def parse_odt(path):
    with zipfile.ZipFile(path) as zf:
        metadata = {}
        try:
            meta = ET.fromstring(zf.read("meta.xml"))
            title = meta.find(f".//{{{ODF_DC_NS}}}title")
            creator = meta.find(f".//{{{ODF_DC_NS}}}creator")
            description = meta.find(f".//{{{ODF_DC_NS}}}description")
            language = meta.find(f".//{{{ODF_DC_NS}}}language")
            keyword = meta.find(f".//{{{ODF_META_NS}}}keyword")
            for key, node in (
                ("title", title),
                ("creator", creator),
                ("description", description),
                ("language", language),
                ("keyword", keyword),
            ):
                if node is not None and node.text:
                    metadata[key] = node.text
        except KeyError:
            pass
        content = ET.fromstring(zf.read("content.xml"))
        parts = []
        paragraphs = 0
        for para in content.iterfind(f".//{{{ODF_TEXT_NS}}}p"):
            text = "".join(para.itertext()).strip()
            if text:
                parts.append(text)
            paragraphs += 1
        text = "\n".join(parts)
        return metadata, text, {"paragraphs": paragraphs}

def main():
    if len(sys.argv) < 4:
        fail("usage: office-document-helper <info|text> <path> <options_json>")
    operation = sys.argv[1]
    path = sys.argv[2]
    options = json.loads(sys.argv[3])
    fmt = infer_format(path)
    if fmt == "docx":
        metadata, text, stats = parse_docx(path)
    elif fmt == "odt":
        metadata, text, stats = parse_odt(path)
    else:
        fail(f"Unsupported office document format: {fmt}")
    max_chars = int(options.get("maxChars", 100000))
    if operation == "info":
        payload = {
            "path": path,
            "format": fmt,
            "metadata": metadata,
            **stats,
        }
    elif operation == "text":
        excerpt, truncated = truncate_text(text, max_chars)
        payload = {
            "path": path,
            "format": fmt,
            "text": excerpt,
            "truncated": truncated,
            "characters": len(text),
            **stats,
        }
    else:
        fail(f"unknown operation: {operation}")
    print(json.dumps(payload, ensure_ascii=False))

if __name__ == "__main__":
    main()
`;

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

async function resolveDocumentPath(
  rawPath: unknown,
  allowedPaths: readonly string[],
  args: Record<string, unknown>,
): Promise<string | ToolResult> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return errorResult("Missing or invalid path");
  }
  const safe = await safePath(rawPath, resolveToolAllowedPaths(allowedPaths, args));
  if (!safe.safe) {
    return errorResult(
      safe.reason ?? "Office document path is outside allowed directories",
    );
  }
  return safe.resolved;
}

async function runDocumentHelper<T>(
  operation: "info" | "text",
  path: string,
  options: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const { stdout } = await execFileAsync(
    "python3",
    ["-c", PYTHON_OFFICE_DOCUMENT_HELPER, operation, path, JSON.stringify(options)],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: DEFAULT_MAX_BUFFER,
    },
  );
  return JSON.parse(stdout) as T;
}

function createOfficeDocumentInfoTool(
  allowedPaths: readonly string[],
  timeoutMs: number,
  logger = silentLogger,
): Tool {
  return {
    name: "system.officeDocumentInfo",
    description:
      "Inspect a local DOCX or ODT office document and return parsed metadata such as title, creator, and paragraph count.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to a local DOCX or ODT file.",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolveDocumentPath(args.path, allowedPaths, args);
      if (typeof resolved !== "string") {
        return resolved;
      }
      try {
        const result = await runDocumentHelper<Record<string, unknown>>(
          "info",
          resolved,
          {},
          timeoutMs,
        );
        return { content: safeStringify(result) };
      } catch (error) {
        logger.warn?.("system.officeDocumentInfo failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to inspect office document",
        );
      }
    },
  };
}

function createOfficeDocumentExtractTool(
  allowedPaths: readonly string[],
  timeoutMs: number,
  defaultMaxChars: number,
  maxCharsCap: number,
  logger = silentLogger,
): Tool {
  return {
    name: "system.officeDocumentExtractText",
    description:
      "Extract text from a local DOCX or ODT office document.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to a local DOCX or ODT file.",
        },
        maxChars: {
          type: "number",
          description: `Maximum extracted characters to return (default ${defaultMaxChars}, capped at ${maxCharsCap}).`,
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolveDocumentPath(args.path, allowedPaths, args);
      if (typeof resolved !== "string") {
        return resolved;
      }
      try {
        const maxChars = normalizePositiveInteger(
          args.maxChars,
          defaultMaxChars,
          maxCharsCap,
        );
        const result = await runDocumentHelper<Record<string, unknown>>(
          "text",
          resolved,
          { maxChars },
          timeoutMs,
        );
        return { content: safeStringify(result) };
      } catch (error) {
        logger.warn?.("system.officeDocumentExtractText failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to extract office document text",
        );
      }
    },
  };
}

export function createOfficeDocumentTools(
  config: SystemOfficeDocumentToolConfig,
): Tool[] {
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
    DEFAULT_MAX_CHARS_CAP,
    Number.MAX_SAFE_INTEGER,
  );
  const logger = config.logger ?? silentLogger;

  return [
    createOfficeDocumentInfoTool(allowedPaths, timeoutMs, logger),
    createOfficeDocumentExtractTool(
      allowedPaths,
      timeoutMs,
      defaultMaxChars,
      maxCharsCap,
      logger,
    ),
  ];
}
