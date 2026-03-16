/**
 * Typed email-message inspection/extraction tools for @tetsuo-ai/runtime.
 *
 * Provides:
 * - system.emailMessageInfo — inspect local EML metadata
 * - system.emailMessageExtractText — extract text from local EML messages
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { silentLogger } from "../../utils/logger.js";
import { resolveToolAllowedPaths, safePath } from "./filesystem.js";
import type { SystemEmailMessageToolConfig } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_CHARS = 100_000;
const DEFAULT_MAX_CHARS_CAP = 500_000;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

const PYTHON_EMAIL_HELPER = String.raw`
import json
import pathlib
import sys
from email import policy
from email.parser import BytesParser
from html.parser import HTMLParser


class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        if data and data.strip():
            self.parts.append(data.strip())

    def get_text(self):
        return "\n".join(part for part in self.parts if part)


def fail(message):
    raise RuntimeError(message)


def infer_format(path):
    suffix = pathlib.Path(path).suffix.lower()
    if suffix == ".eml":
        return "eml"
    fail(f"Unsupported email message format: {suffix or 'unknown'}")


def truncate_text(text, max_chars):
    if len(text) > max_chars:
        return text[:max_chars] + "…", True
    return text, False


def parse_message(path):
    with open(path, "rb") as handle:
        message = BytesParser(policy=policy.default).parse(handle)

    attachments = []
    content_types = []
    text_parts = []
    html_parts = []

    for part in message.walk():
        content_type = part.get_content_type()
        if content_type not in content_types:
            content_types.append(content_type)

        filename = part.get_filename()
        disposition = part.get_content_disposition()
        if filename or disposition == "attachment":
            attachments.append(filename or content_type)
            continue

        if part.is_multipart():
            continue

        try:
            payload = part.get_content()
        except Exception:
            payload = ""

        if not isinstance(payload, str):
            continue

        payload = payload.strip()
        if not payload:
            continue

        if content_type == "text/plain":
            text_parts.append(payload)
        elif content_type == "text/html":
            parser = TextExtractor()
            parser.feed(payload)
            html_text = parser.get_text().strip()
            if html_text:
                html_parts.append(html_text)

    body_text = "\n\n".join(text_parts if text_parts else html_parts)

    metadata = {
        "subject": message.get("subject"),
        "from": message.get("from"),
        "to": message.get("to"),
        "cc": message.get("cc"),
        "date": message.get("date"),
        "messageId": message.get("message-id"),
        "attachmentCount": len(attachments),
        "attachmentNames": attachments,
        "contentTypes": content_types,
    }

    return metadata, body_text


def main():
    if len(sys.argv) < 4:
        fail("usage: email-helper <info|text> <path> <options_json>")

    operation = sys.argv[1]
    path = sys.argv[2]
    options = json.loads(sys.argv[3])
    fmt = infer_format(path)
    metadata, body_text = parse_message(path)

    if operation == "info":
        payload = {
            "path": path,
            "format": fmt,
            **metadata,
        }
    elif operation == "text":
        excerpt, truncated = truncate_text(body_text, int(options.get("maxChars", 100000)))
        payload = {
            "path": path,
            "format": fmt,
            "text": excerpt,
            "truncated": truncated,
            "characters": len(body_text),
            **metadata,
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

async function resolveEmailPath(
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
      safe.reason ?? "Email message path is outside allowed directories",
    );
  }
  return safe.resolved;
}

async function runEmailHelper<T>(
  operation: "info" | "text",
  path: string,
  options: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const { stdout } = await execFileAsync(
    "python3",
    ["-c", PYTHON_EMAIL_HELPER, operation, path, JSON.stringify(options)],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: DEFAULT_MAX_BUFFER,
    },
  );
  return JSON.parse(stdout) as T;
}

function createEmailMessageInfoTool(
  allowedPaths: readonly string[],
  timeoutMs: number,
  logger = silentLogger,
): Tool {
  return {
    name: "system.emailMessageInfo",
    description:
      "Inspect a local EML email message and return parsed headers, content types, and attachment summary.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to a local EML email message file.",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolveEmailPath(args.path, allowedPaths, args);
      if (typeof resolved !== "string") {
        return resolved;
      }
      try {
        const result = await runEmailHelper<Record<string, unknown>>(
          "info",
          resolved,
          {},
          timeoutMs,
        );
        return { content: safeStringify(result) };
      } catch (error) {
        logger.warn?.("system.emailMessageInfo failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to inspect email message",
        );
      }
    },
  };
}

function createEmailMessageExtractTextTool(
  allowedPaths: readonly string[],
  timeoutMs: number,
  defaultMaxChars: number,
  maxCharsCap: number,
  logger = silentLogger,
): Tool {
  return {
    name: "system.emailMessageExtractText",
    description:
      "Extract text from a local EML email message, preferring text/plain and falling back to stripped HTML.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to a local EML email message file.",
        },
        maxChars: {
          type: "number",
          description: "Maximum number of characters to return.",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolveEmailPath(args.path, allowedPaths, args);
      if (typeof resolved !== "string") {
        return resolved;
      }
      try {
        const maxChars = normalizePositiveInteger(
          args.maxChars,
          defaultMaxChars,
          maxCharsCap,
        );
        const result = await runEmailHelper<Record<string, unknown>>(
          "text",
          resolved,
          { maxChars },
          timeoutMs,
        );
        return { content: safeStringify(result) };
      } catch (error) {
        logger.warn?.("system.emailMessageExtractText failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to extract email message text",
        );
      }
    },
  };
}

export function createEmailMessageTools(
  config: SystemEmailMessageToolConfig,
): Tool[] {
  const allowedPaths = validateAllowedPaths(config.allowedPaths);
  const timeoutMs = normalizePositiveInteger(
    config.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    120_000,
  );
  const defaultMaxChars = normalizePositiveInteger(
    config.defaultMaxChars,
    DEFAULT_MAX_CHARS,
    DEFAULT_MAX_CHARS_CAP,
  );
  const maxCharsCap = normalizePositiveInteger(
    config.maxCharsCap,
    DEFAULT_MAX_CHARS_CAP,
    5_000_000,
  );
  const logger = config.logger ?? silentLogger;

  return [
    createEmailMessageInfoTool(allowedPaths, timeoutMs, logger),
    createEmailMessageExtractTextTool(
      allowedPaths,
      timeoutMs,
      defaultMaxChars,
      maxCharsCap,
      logger,
    ),
  ];
}
