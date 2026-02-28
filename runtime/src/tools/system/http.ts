/**
 * HTTP request tools with domain control.
 *
 * Provides system.httpGet, system.httpPost, and system.httpFetch tools
 * for making HTTP requests within configurable security boundaries
 * (domain allow/deny lists, response size limits, timeouts, redirect control).
 *
 * Uses Node 18+ built-in fetch — zero external dependencies.
 *
 * @module
 */

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface HttpToolConfig {
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  /** Maximum response body size in bytes. Default: 1_048_576 (1 MB). */
  readonly maxResponseBytes?: number;
  /** Request timeout in milliseconds. Default: 30_000. */
  readonly timeoutMs?: number;
  /** Maximum number of redirects to follow. Default: 5. */
  readonly maxRedirects?: number;
  /** Allowed HTTP methods. Default: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS. */
  readonly allowedMethods?: readonly string[];
  /** Default headers merged into every request. */
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  /** Per-domain auth headers. Keys are domain patterns (same as allowedDomains). */
  readonly authHeaders?: Readonly<Record<string, Record<string, string>>>;
}

export interface HttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly truncated: boolean;
  readonly url: string;
}

// ============================================================================
// SSRF Protection
// ============================================================================

/** Hostnames always blocked to prevent SSRF attacks. */
const SSRF_BLOCKED_HOSTNAMES: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
  "[::ffff:127.0.0.1]",
  "169.254.169.254", // AWS IMDS
  "metadata.google.internal", // GCP metadata
  "metadata.internal", // Generic cloud metadata
];

/** Wildcard patterns always blocked. */
const SSRF_BLOCKED_WILDCARDS: readonly string[] = ["*.localhost", "*.internal"];

/**
 * Check if a hostname is a private/loopback IP address.
 * Covers: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16.
 * Also handles IPv4-mapped IPv6 in both dotted and hex-normalized forms.
 */
function isPrivateIP(hostname: string): boolean {
  // Strip IPv6 brackets
  const h = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;

  // IPv6 loopback and private
  if (
    h === "::1" ||
    h.startsWith("fe80:") ||
    h.startsWith("fc00:") ||
    h.startsWith("fd")
  ) {
    return true;
  }

  // IPv4-mapped IPv6 — dotted notation (::ffff:x.x.x.x)
  const v4mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) {
    return isPrivateIPv4(v4mapped[1]);
  }

  // IPv4-mapped IPv6 — hex notation (::ffff:XXYY:ZZWW), produced by URL parser
  const v4hex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (v4hex) {
    const hi = parseInt(v4hex[1], 16);
    const lo = parseInt(v4hex[2], 16);
    const a = (hi >> 8) & 0xff;
    const b = hi & 0xff;
    const c = (lo >> 8) & 0xff;
    const d = lo & 0xff;
    return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
  }

  return isPrivateIPv4(h);
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map(Number);
  if (octets.some((o) => isNaN(o) || o < 0 || o > 255)) return false;

  const [a, b] = octets;
  return (
    a === 127 || // 127.0.0.0/8 (loopback)
    a === 10 || // 10.0.0.0/8 (private class A)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 (private class B)
    (a === 192 && b === 168) || // 192.168.0.0/16 (private class C)
    (a === 169 && b === 254) || // 169.254.0.0/16 (link-local / APIPA)
    a === 0 // 0.0.0.0/8
  );
}

// ============================================================================
// Domain Matching
// ============================================================================

/**
 * Check if a hostname matches a domain pattern.
 *
 * - Exact: `github.com` matches only `github.com`
 * - Wildcard: `*.github.com` matches `api.github.com` but NOT `github.com`
 */
function matchDomain(hostname: string, pattern: string): boolean {
  const lower = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".github.com"
    return lower.endsWith(suffix) && lower.length > suffix.length;
  }
  return lower === p;
}

/**
 * Check if a URL is allowed by the domain allow/block lists.
 *
 * - Non-HTTP(S) schemes are always blocked.
 * - Private/loopback IPs are always blocked (SSRF protection).
 * - Known SSRF targets (cloud metadata endpoints) are always blocked.
 * - User-configured blocked list is checked next.
 * - If allowed list is set and non-empty, hostname must match at least one pattern.
 * - If neither list is set, all non-private HTTP(S) URLs are allowed.
 */
export function isDomainAllowed(
  url: string,
  allowedDomains?: readonly string[],
  blockedDomains?: readonly string[],
): { allowed: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: "Invalid URL" };
  }

  const scheme = parsed.protocol.replace(":", "");
  if (scheme !== "http" && scheme !== "https") {
    return { allowed: false, reason: "Only HTTP(S) URLs are allowed" };
  }

  const hostname = parsed.hostname;

  // SSRF protection: always block private/loopback IPs
  if (isPrivateIP(hostname)) {
    return {
      allowed: false,
      reason: `Private/loopback address blocked: ${hostname}`,
    };
  }

  // SSRF protection: always block known dangerous hostnames
  for (const blocked of SSRF_BLOCKED_HOSTNAMES) {
    if (hostname.toLowerCase() === blocked.toLowerCase()) {
      return { allowed: false, reason: `SSRF target blocked: ${hostname}` };
    }
  }
  for (const pattern of SSRF_BLOCKED_WILDCARDS) {
    if (matchDomain(hostname, pattern)) {
      return { allowed: false, reason: `SSRF target blocked: ${hostname}` };
    }
  }

  // User-configured blocked list
  if (blockedDomains && blockedDomains.length > 0) {
    for (const pattern of blockedDomains) {
      if (matchDomain(hostname, pattern)) {
        return { allowed: false, reason: `Domain blocked: ${hostname}` };
      }
    }
  }

  // Allowed list — if set, hostname must match at least one
  if (allowedDomains && allowedDomains.length > 0) {
    const match = allowedDomains.some((pattern) =>
      matchDomain(hostname, pattern),
    );
    if (!match) {
      return {
        allowed: false,
        reason: `Domain not in allowed list: ${hostname}`,
      };
    }
  }

  return { allowed: true };
}

const LOCAL_ADDRESS_BLOCK_RE =
  /(Private\/loopback address blocked:|SSRF target blocked:)\s*(.+)$/i;

/**
 * Attach remediation guidance for blocked localhost/private/internal targets.
 * Keeps raw validation reason intact while steering the agent to the right tool path.
 */
export function formatDomainBlockReason(reason: string): string {
  const trimmed = reason.trim();
  if (!LOCAL_ADDRESS_BLOCK_RE.test(trimmed)) {
    return trimmed;
  }
  return (
    `${trimmed}. ` +
    "system.http*/system.browse intentionally block localhost/private/internal addresses. " +
    "For local checks, use desktop tools (`desktop.bash` with curl or Playwright tools)."
  );
}

// ============================================================================
// Private Helpers
// ============================================================================

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576; // 1 MB
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_ALLOWED_METHODS: readonly string[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

/** Find auth headers for a hostname by matching against authHeaders patterns. */
function getAuthHeaders(
  hostname: string,
  authHeaders?: Readonly<Record<string, Record<string, string>>>,
): Record<string, string> {
  if (!authHeaders) return {};
  for (const [pattern, headers] of Object.entries(authHeaders)) {
    if (matchDomain(hostname, pattern)) {
      return { ...headers };
    }
  }
  return {};
}

/** Read response body with streaming size limit. */
async function readBodyWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    // Fallback for environments without ReadableStream body
    const text = await response.text();
    if (text.length > maxBytes) {
      return { body: text.slice(0, maxBytes), truncated: true };
    }
    return { body: text, truncated: false };
  }

  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        // Keep only the portion within the limit
        const excess = totalBytes - maxBytes;
        const keep = value.byteLength - excess;
        if (keep > 0) {
          chunks.push(decoder.decode(value.slice(0, keep), { stream: false }));
        }
        truncated = true;
        await reader.cancel();
        break;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
  } finally {
    reader.releaseLock();
  }

  return { body: chunks.join(""), truncated };
}

/** Core fetch logic shared by all three tools. */
async function doFetch(
  url: string,
  init: RequestInit,
  config: HttpToolConfig,
  logger: Logger,
  redirectCount = 0,
  finalUrl?: string,
): Promise<ToolResult> {
  // Validate scheme
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return errorResult("Invalid URL");
  }

  const scheme = parsed.protocol.replace(":", "");
  if (scheme !== "http" && scheme !== "https") {
    return errorResult("Only HTTP(S) URLs are allowed");
  }

  // Validate method
  const method = (init.method ?? "GET").toUpperCase();
  const allowedMethods = config.allowedMethods ?? DEFAULT_ALLOWED_METHODS;
  if (!allowedMethods.map((m) => m.toUpperCase()).includes(method)) {
    return errorResult(`HTTP method not allowed: ${method}`);
  }

  // Check domain
  const domainCheck = isDomainAllowed(
    url,
    config.allowedDomains,
    config.blockedDomains,
  );
  if (!domainCheck.allowed) {
    return errorResult(formatDomainBlockReason(domainCheck.reason!));
  }

  // Merge headers: defaults → caller → auth (auth wins, cannot be overridden)
  const mergedHeaders: Record<string, string> = {};
  if (config.defaultHeaders) {
    Object.assign(mergedHeaders, config.defaultHeaders);
  }
  if (
    init.headers &&
    typeof init.headers === "object" &&
    !Array.isArray(init.headers)
  ) {
    Object.assign(mergedHeaders, init.headers);
  }
  // Auth headers applied last — cannot be overridden by caller
  Object.assign(
    mergedHeaders,
    getAuthHeaders(parsed.hostname, config.authHeaders),
  );

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes =
    config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  try {
    const response = await fetch(url, {
      ...init,
      method,
      headers: mergedHeaders,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });

    // Manual redirect handling
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return errorResult(
          `Redirect (${response.status}) without Location header`,
        );
      }

      if (redirectCount >= maxRedirects) {
        return errorResult(`Too many redirects (max: ${maxRedirects})`);
      }

      // Resolve relative redirects
      const redirectUrl = new URL(location, url).toString();
      logger.debug(`Following redirect ${response.status} → ${redirectUrl}`);

      // Per RFC 7231: 302/303 change method to GET and drop body.
      // 307/308 preserve the original method and body.
      const preserveMethod = response.status === 307 || response.status === 308;
      const redirectInit: RequestInit = preserveMethod
        ? init
        : { ...init, method: "GET", body: undefined };

      return doFetch(
        redirectUrl,
        redirectInit,
        config,
        logger,
        redirectCount + 1,
        url,
      );
    }

    // Read body with streaming size limit
    const { body, truncated } = await readBodyWithLimit(
      response,
      maxResponseBytes,
    );

    // Extract headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const result: HttpResponse = {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      body,
      truncated,
      url: response.url || finalUrl || url,
    };

    return { content: safeStringify(result) };
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === "TimeoutError" || err.name === "AbortError") {
        return errorResult("Request timed out");
      }
      return errorResult(`Connection failed: ${err.message}`);
    }
    return errorResult(`Connection failed: ${String(err)}`);
  }
}

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Create HTTP request tools with domain control.
 *
 * Returns 3 tools: system.httpGet, system.httpPost, system.httpFetch.
 *
 * @param config - Optional configuration for domain control, timeouts, etc.
 * @param logger - Optional logger instance (defaults to silent).
 *
 * @example
 * ```typescript
 * const tools = createHttpTools({
 *   allowedDomains: ['api.example.com', '*.github.com'],
 *   blockedDomains: ['evil.com'],
 *   timeoutMs: 10_000,
 * });
 * registry.registerAll(tools);
 * ```
 */
export function createHttpTools(
  config?: HttpToolConfig,
  logger?: Logger,
): Tool[] {
  const cfg = config ?? {};
  const log = logger ?? silentLogger;

  const httpGet: Tool = {
    name: "system.httpGet",
    description: "Make an HTTP GET request. Returns status, headers, and body.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        headers: { type: "object", description: "Optional request headers" },
      },
      required: ["url"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const url = args.url;
      if (typeof url !== "string" || url.length === 0) {
        return errorResult("Missing or invalid url");
      }
      const headers =
        (args.headers as Record<string, string> | undefined) ?? {};
      return doFetch(url, { method: "GET", headers }, cfg, log);
    },
  };

  const httpPost: Tool = {
    name: "system.httpPost",
    description:
      "Make an HTTP POST request with a body. Returns status, headers, and response body.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to post to" },
        body: { type: "string", description: "Request body string" },
        contentType: {
          type: "string",
          description: "Content-Type header (default: application/json)",
        },
        headers: { type: "object", description: "Optional request headers" },
      },
      required: ["url"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const url = args.url;
      if (typeof url !== "string" || url.length === 0) {
        return errorResult("Missing or invalid url");
      }
      const body = typeof args.body === "string" ? args.body : undefined;
      const contentType =
        typeof args.contentType === "string"
          ? args.contentType
          : "application/json";
      const callerHeaders =
        (args.headers as Record<string, string> | undefined) ?? {};
      const headers: Record<string, string> = {
        "content-type": contentType,
        ...callerHeaders,
      };
      return doFetch(url, { method: "POST", headers, body }, cfg, log);
    },
  };

  const httpFetch: Tool = {
    name: "system.httpFetch",
    description:
      "Make an HTTP request with any method. Returns status, headers, and body.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to request" },
        method: {
          type: "string",
          description:
            "HTTP method (default: GET). Allowed: GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS.",
        },
        headers: { type: "object", description: "Optional request headers" },
        body: { type: "string", description: "Optional request body" },
      },
      required: ["url"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const url = args.url;
      if (typeof url !== "string" || url.length === 0) {
        return errorResult("Missing or invalid url");
      }
      const method =
        typeof args.method === "string" ? args.method.toUpperCase() : "GET";
      const headers =
        (args.headers as Record<string, string> | undefined) ?? {};
      const body = typeof args.body === "string" ? args.body : undefined;
      return doFetch(url, { method, headers, body }, cfg, log);
    },
  };

  return [httpGet, httpPost, httpFetch];
}
