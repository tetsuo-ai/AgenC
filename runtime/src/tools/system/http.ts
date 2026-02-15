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

import type { Tool, ToolResult } from '../types.js';
import { safeStringify } from '../types.js';
import type { Logger } from '../../utils/logger.js';
import { silentLogger } from '../../utils/logger.js';

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
  if (p.startsWith('*.')) {
    const suffix = p.slice(1); // ".github.com"
    return lower.endsWith(suffix) && lower.length > suffix.length;
  }
  return lower === p;
}

/**
 * Check if a URL is allowed by the domain allow/block lists.
 *
 * - Non-HTTP(S) schemes are always blocked.
 * - Blocked list takes precedence over allowed list.
 * - If allowed list is set and non-empty, hostname must match at least one pattern.
 * - If neither list is set, all HTTP(S) URLs are allowed.
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
    return { allowed: false, reason: 'Invalid URL' };
  }

  const scheme = parsed.protocol.replace(':', '');
  if (scheme !== 'http' && scheme !== 'https') {
    return { allowed: false, reason: 'Only HTTP(S) URLs are allowed' };
  }

  const hostname = parsed.hostname;

  // Blocked list takes precedence
  if (blockedDomains && blockedDomains.length > 0) {
    for (const pattern of blockedDomains) {
      if (matchDomain(hostname, pattern)) {
        return { allowed: false, reason: `Domain blocked: ${hostname}` };
      }
    }
  }

  // Allowed list — if set, hostname must match at least one
  if (allowedDomains && allowedDomains.length > 0) {
    const match = allowedDomains.some((pattern) => matchDomain(hostname, pattern));
    if (!match) {
      return { allowed: false, reason: `Domain not in allowed list: ${hostname}` };
    }
  }

  return { allowed: true };
}

// ============================================================================
// Private Helpers
// ============================================================================

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576; // 1 MB
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;

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

/** Core fetch logic shared by all three tools. */
async function doFetch(
  url: string,
  init: RequestInit,
  config: HttpToolConfig,
  logger: Logger,
  redirectCount = 0,
): Promise<ToolResult> {
  // Validate scheme
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return errorResult('Invalid URL');
  }

  const scheme = parsed.protocol.replace(':', '');
  if (scheme !== 'http' && scheme !== 'https') {
    return errorResult('Only HTTP(S) URLs are allowed');
  }

  // Check domain
  const domainCheck = isDomainAllowed(url, config.allowedDomains, config.blockedDomains);
  if (!domainCheck.allowed) {
    return errorResult(domainCheck.reason!);
  }

  // Merge headers: defaults → auth → caller
  const mergedHeaders: Record<string, string> = {};
  if (config.defaultHeaders) {
    Object.assign(mergedHeaders, config.defaultHeaders);
  }
  Object.assign(mergedHeaders, getAuthHeaders(parsed.hostname, config.authHeaders));
  if (init.headers && typeof init.headers === 'object' && !Array.isArray(init.headers)) {
    Object.assign(mergedHeaders, init.headers);
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = config.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  try {
    const response = await fetch(url, {
      ...init,
      headers: mergedHeaders,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'manual',
    });

    // Manual redirect handling
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return errorResult(`Redirect (${response.status}) without Location header`);
      }

      if (redirectCount >= maxRedirects) {
        return errorResult(`Too many redirects (max: ${maxRedirects})`);
      }

      // Resolve relative redirects
      const redirectUrl = new URL(location, url).toString();
      logger.debug(`Following redirect ${response.status} → ${redirectUrl}`);
      return doFetch(redirectUrl, init, config, logger, redirectCount + 1);
    }

    // Read body with size limit
    const text = await response.text();
    let body = text;
    let truncated = false;
    if (text.length > maxResponseBytes) {
      body = text.slice(0, maxResponseBytes);
      truncated = true;
    }

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
      url: response.url || url,
    };

    return { content: safeStringify(result) };
  } catch (err) {
    if (err instanceof Error) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        return errorResult('Request timed out');
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
export function createHttpTools(config?: HttpToolConfig, logger?: Logger): Tool[] {
  const cfg = config ?? {};
  const log = logger ?? silentLogger;

  const httpGet: Tool = {
    name: 'system.httpGet',
    description: 'Make an HTTP GET request. Returns status, headers, and body.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to fetch' },
        headers: { type: 'object', description: 'Optional request headers' },
      },
      required: ['url'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const url = args.url;
      if (typeof url !== 'string' || url.length === 0) {
        return errorResult('Missing or invalid url');
      }
      const headers = (args.headers as Record<string, string> | undefined) ?? {};
      return doFetch(url, { method: 'GET', headers }, cfg, log);
    },
  };

  const httpPost: Tool = {
    name: 'system.httpPost',
    description:
      'Make an HTTP POST request with a body. Returns status, headers, and response body.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to post to' },
        body: { type: 'string', description: 'Request body string' },
        contentType: {
          type: 'string',
          description: 'Content-Type header (default: application/json)',
        },
        headers: { type: 'object', description: 'Optional request headers' },
      },
      required: ['url'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const url = args.url;
      if (typeof url !== 'string' || url.length === 0) {
        return errorResult('Missing or invalid url');
      }
      const body = typeof args.body === 'string' ? args.body : undefined;
      const contentType = typeof args.contentType === 'string' ? args.contentType : 'application/json';
      const callerHeaders = (args.headers as Record<string, string> | undefined) ?? {};
      const headers: Record<string, string> = {
        'content-type': contentType,
        ...callerHeaders,
      };
      return doFetch(url, { method: 'POST', headers, body }, cfg, log);
    },
  };

  const httpFetch: Tool = {
    name: 'system.httpFetch',
    description:
      'Make an HTTP request with any method. Returns status, headers, and body.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to request' },
        method: { type: 'string', description: 'HTTP method (default: GET)' },
        headers: { type: 'object', description: 'Optional request headers' },
        body: { type: 'string', description: 'Optional request body' },
      },
      required: ['url'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const url = args.url;
      if (typeof url !== 'string' || url.length === 0) {
        return errorResult('Missing or invalid url');
      }
      const method = typeof args.method === 'string' ? args.method.toUpperCase() : 'GET';
      const headers = (args.headers as Record<string, string> | undefined) ?? {};
      const body = typeof args.body === 'string' ? args.body : undefined;
      return doFetch(url, { method, headers, body }, cfg, log);
    },
  };

  return [httpGet, httpPost, httpFetch];
}
