import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import type { HealthResponse } from "./types.js";
import { isAuthorizedRequest, resolveAllowedOrigin } from "./auth.js";

interface DesktopServerOptions {
  authToken: string;
  startTime?: number;
}

function json(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const maxSize = 1024 * 1024;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): string | undefined {
  const allowedOrigin = resolveAllowedOrigin(req.headers.origin);
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Vary", "Origin");
  }
  return allowedOrigin;
}

function handlePreflight(
  req: IncomingMessage,
  res: ServerResponse,
  allowedOrigin: string | undefined,
): boolean {
  if (req.method !== "OPTIONS") {
    return false;
  }
  if (req.headers.origin && !allowedOrigin) {
    json(res, 403, { error: "Origin not allowed" });
    return true;
  }
  res.writeHead(204);
  res.end();
  return true;
}

function ensureAuthorized(
  req: IncomingMessage,
  res: ServerResponse,
  authToken: string,
): boolean {
  if (isAuthorizedRequest(req.headers.authorization, authToken)) {
    return true;
  }
  res.setHeader("WWW-Authenticate", "Bearer");
  json(res, 401, { error: "Unauthorized" });
  return false;
}

function handleHealthRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  startTime: number,
): boolean {
  if (req.method !== "GET" || path !== "/health") {
    return false;
  }

  const health: HealthResponse = {
    status: "ok",
    display: process.env.DISPLAY ?? ":1",
    uptime: Math.floor((Date.now() - startTime) / 1000),
  };
  json(res, 200, health);
  return true;
}

function handleToolsListRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): boolean {
  if (req.method !== "GET" || path !== "/tools") {
    return false;
  }
  json(res, 200, TOOL_DEFINITIONS);
  return true;
}

function extractToolName(path: string): string | undefined {
  const match = /^\/tools\/([a-z_]+)$/.exec(path);
  return match?.[1];
}

async function parseToolArgs(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readBody(req);
  if (!body.trim()) {
    return {};
  }
  return JSON.parse(body) as Record<string, unknown>;
}

async function handleToolRequest(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): Promise<boolean> {
  if (req.method !== "POST") {
    return false;
  }

  const toolName = extractToolName(path);
  if (!toolName) {
    return false;
  }

  let args: Record<string, unknown>;
  try {
    args = await parseToolArgs(req);
  } catch (e) {
    json(res, 400, {
      error: `Invalid JSON body: ${e instanceof Error ? e.message : e}`,
    });
    return true;
  }

  const result = await executeTool(toolName, args);
  json(res, result.isError ? 400 : 200, result);
  return true;
}

export function createDesktopServer(options: DesktopServerOptions): Server {
  const startTime = options.startTime ?? Date.now();
  const authToken = options.authToken;

  return createServer((req, res) => {
    void handleRequest(req, res, authToken, startTime).catch((err) => {
      console.error("Request handler error:", err);
      if (!res.headersSent) {
        json(res, 500, { error: "Internal server error" });
      }
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authToken: string,
  startTime: number,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const allowedOrigin = applyCorsHeaders(req, res);

  if (handlePreflight(req, res, allowedOrigin)) {
    return;
  }

  if (!ensureAuthorized(req, res, authToken)) {
    return;
  }

  if (handleHealthRequest(req, res, path, startTime)) {
    return;
  }

  if (handleToolsListRequest(req, res, path)) {
    return;
  }

  if (await handleToolRequest(req, res, path)) {
    return;
  }

  json(res, 404, { error: "Not found" });
}
