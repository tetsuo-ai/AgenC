/**
 * Browser tools for web content extraction.
 *
 * Basic mode (fetch + cheerio): system.browse, system.extractLinks, system.htmlToMarkdown
 * Advanced mode (Playwright): + system.screenshot, system.browserAction, system.evaluateJs, system.exportPdf
 *
 * Domain allow/deny lists from HTTP tool config are respected via shared isDomainAllowed().
 *
 * @module
 */

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";
import { isDomainAllowed } from "./http.js";
import { ensureLazyModule } from "../../utils/lazy-import.js";

// ============================================================================
// Types
// ============================================================================

export interface BrowserToolConfig {
  readonly mode: "basic" | "advanced";
  readonly allowedDomains?: readonly string[];
  readonly blockedDomains?: readonly string[];
  /** Maximum response body size in bytes. Default: 1_048_576 (1 MB). */
  readonly maxResponseBytes?: number;
  /** Request timeout in milliseconds. Default: 30_000. */
  readonly timeoutMs?: number;
  /** Playwright launch options (advanced mode). */
  readonly launchOptions?: Record<string, unknown>;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576; // 1 MB
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const USER_AGENT = "AgenC-Runtime/0.1 (compatible)";

/** Schemes allowed in href attributes. Everything else is stripped. */
const SAFE_HREF_SCHEMES = new Set(["http:", "https:", "mailto:"]);

// ============================================================================
// Shared Helpers
// ============================================================================

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

/**
 * Validate a URL string against domain allow/deny lists.
 * Returns an error ToolResult if invalid, or null if OK.
 */
function validateUrl(
  url: unknown,
  config: BrowserToolConfig,
): ToolResult | null {
  if (typeof url !== "string" || url.length === 0) {
    return errorResult("Missing or invalid url");
  }
  const check = isDomainAllowed(
    url,
    config.allowedDomains,
    config.blockedDomains,
  );
  if (!check.allowed) {
    return errorResult(check.reason!);
  }
  return null;
}

/**
 * Sanitize an href value — only allow http/https/mailto and relative links.
 * Returns empty string for dangerous schemes (javascript:, data:, vbscript:, etc.).
 * Strips ASCII control characters and zero-width characters before checking.
 */
export function sanitizeHref(href: string): string {
  // Strip ASCII control chars (0x00-0x1F, 0x7F) that browsers may ignore in schemes
  // eslint-disable-next-line no-control-regex
  const trimmed = href.replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (trimmed.length === 0) return "";

  // Relative links (no colon before first slash) are safe
  const colonIdx = trimmed.indexOf(":");
  if (colonIdx === -1) return trimmed;

  // Check if anything before the colon looks like a scheme (letters only)
  const maybescheme = trimmed.slice(0, colonIdx);
  if (!/^[a-zA-Z][a-zA-Z0-9+\-.]*$/.test(maybescheme)) {
    // Not a valid scheme prefix — treat as relative
    return trimmed;
  }

  // It has a scheme — check if it's in the safe list
  const scheme = maybescheme.toLowerCase() + ":";
  if (SAFE_HREF_SCHEMES.has(scheme)) return trimmed;

  return "";
}

/**
 * Convert inline HTML elements to markdown via regex.
 * Handles: <a> → [text](href), <strong>/<b> → **text**, <em>/<i> → *text*, <code> → `text`.
 * Strips all remaining HTML tags.
 */
function inlineToMd(html: string): string {
  let md = html;
  // Links: <a href="url">text</a> or <a href='url'>text</a> → [text](sanitized_url)
  md = md.replace(
    /<a[^>]*href=(["'])([^"']*)\1[^>]*>(.*?)<\/a>/gi,
    (_match, _quote: string, href: string, text: string) => {
      const safe = sanitizeHref(href);
      return safe ? `[${text}](${safe})` : text;
    },
  );
  // Strong/bold: <strong>text</strong> or <b>text</b> → **text**
  md = md.replace(/<(?:strong|b)>(.*?)<\/(?:strong|b)>/gi, "**$1**");
  // Emphasis/italic: <em>text</em> or <i>text</i> → *text*
  md = md.replace(/<(?:em|i)>(.*?)<\/(?:em|i)>/gi, "*$1*");
  // Inline code: <code>text</code> → `text`
  md = md.replace(/<code>(.*?)<\/code>/gi, "`$1`");
  // Strip remaining tags
  md = md.replace(/<[^>]*>/g, "");
  return md.trim();
}

/**
 * Fetch HTML content from a URL with redirect following and size limits.
 * Mirrors the redirect-following pattern from http.ts.
 */
async function fetchHtml(
  url: string,
  config: BrowserToolConfig,
  logger: Logger,
  redirectCount = 0,
): Promise<
  { html: string; contentType: string; finalUrl: string } | ToolResult
> {
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });

    // Manual redirect handling with domain re-validation
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        return errorResult(
          `Redirect (${response.status}) without Location header`,
        );
      }
      if (redirectCount >= MAX_REDIRECTS) {
        return errorResult(`Too many redirects (max: ${MAX_REDIRECTS})`);
      }
      const redirectUrl = new URL(location, url).toString();
      const domainCheck = isDomainAllowed(
        redirectUrl,
        config.allowedDomains,
        config.blockedDomains,
      );
      if (!domainCheck.allowed) {
        return errorResult(domainCheck.reason!);
      }
      logger.debug(`Following redirect ${response.status} → ${redirectUrl}`);
      return fetchHtml(redirectUrl, config, logger, redirectCount + 1);
    }

    // Read body with streaming size limit
    const reader = response.body?.getReader();
    let body: string;
    if (!reader) {
      const text = await response.text();
      body = text.length > maxBytes ? text.slice(0, maxBytes) : text;
    } else {
      const decoder = new TextDecoder();
      const chunks: string[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            const excess = totalBytes - maxBytes;
            const keep = value.byteLength - excess;
            if (keep > 0) {
              chunks.push(
                decoder.decode(value.slice(0, keep), { stream: false }),
              );
            }
            await reader.cancel();
            break;
          }
          chunks.push(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }
      body = chunks.join("");
    }

    const contentType = response.headers.get("content-type") ?? "";
    return { html: body, contentType, finalUrl: response.url || url };
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

/** Check if a fetchHtml result is an error ToolResult. */
function isFetchError(result: unknown): result is ToolResult {
  return (
    typeof result === "object" &&
    result !== null &&
    "isError" in result &&
    (result as ToolResult).isError === true
  );
}

// ============================================================================
// Cheerio (lazy-loaded)
// ============================================================================

/** Minimal cheerio type surface used by this module. */
interface CheerioSelection {
  find(selector: string): CheerioSelection;
  each(fn: (index: number, el: unknown) => void): CheerioSelection;
  text(): string;
  html(): string | null;
  attr(name: string): string | undefined;
  length: number;
}

/** Cheerio's `$` — callable with string selectors or element wrappers. */
interface CheerioAPI {
  (selectorOrElement: string | unknown): CheerioSelection;
  root(): CheerioSelection;
  html(): string;
}

type CheerioLoad = (html: string) => CheerioAPI;

let cheerioLoad: CheerioLoad | null = null;

async function loadCheerio(): Promise<CheerioLoad> {
  if (cheerioLoad) return cheerioLoad;
  cheerioLoad = await ensureLazyModule<CheerioLoad>(
    "cheerio",
    (msg) => new Error(msg),
    (mod) => mod.load as CheerioLoad,
  );
  return cheerioLoad;
}

// ============================================================================
// HTML → Markdown conversion
// ============================================================================

/**
 * Convert HTML to markdown using cheerio.
 * Uses flat selectors for each block type — no recursive DOM traversal.
 * Handles: title, headings, paragraphs, links, emphasis/strong, code/pre, ul/ol lists, blockquotes.
 * Tables are skipped for v1.
 *
 * To avoid duplicating content for nested elements (e.g. `<blockquote><p>text</p></blockquote>`),
 * we collect all processed elements and skip any element whose content is a subset of an
 * already-processed parent block.
 */
function htmlToMd($: CheerioAPI): string {
  const lines: string[] = [];
  // Track raw inner HTML of processed block elements to avoid duplicate content
  const processedContent = new Set<string>();

  // Extract title
  const titleEl = $("title");
  if (titleEl.length > 0) {
    const title = titleEl.text().trim();
    if (title) {
      lines.push(`# ${title}`, "");
    }
  }

  // Headings — combined selector preserves document order
  $("h1, h2, h3, h4, h5, h6").each((_i, el) => {
    const node = el as { tagName?: string };
    const tag = (node.tagName ?? "").toLowerCase();
    const level = parseInt(tag.replace("h", ""), 10) || 1;
    const inner = $(el).html() ?? $(el).text();
    const text = inlineToMd(inner).trim();
    if (text) {
      lines.push("", `${"#".repeat(level)} ${text}`, "");
      processedContent.add(inner.trim());
    }
  });

  // Code blocks — process before paragraphs so <pre><code>x</code></pre> isn't duplicated
  $("pre").each((_i, el) => {
    const code = $(el).text().trim();
    if (code) {
      lines.push("", "```", code, "```", "");
      const inner = $(el).html() ?? code;
      processedContent.add(inner.trim());
    }
  });

  // Blockquotes — process before paragraphs so nested <p> inside <blockquote> is skipped
  $("blockquote").each((_i, el) => {
    const inner = $(el).html() ?? $(el).text();
    const text = inlineToMd(inner).trim();
    if (text) {
      lines.push("", `> ${text}`, "");
      processedContent.add(inner.trim());
    }
  });

  // Unordered list items — process before paragraphs so nested <p> inside <li> is skipped
  $("ul > li").each((_i, el) => {
    const inner = $(el).html() ?? $(el).text();
    const text = inlineToMd(inner).trim();
    if (text) {
      lines.push(`- ${text}`);
      processedContent.add(inner.trim());
    }
  });

  // Ordered list items — number within each <ol>
  $("ol").each((_i, olEl) => {
    let num = 1;
    $(olEl)
      .find("li")
      .each((_j, liEl) => {
        const inner = $(liEl).html() ?? $(liEl).text();
        const text = inlineToMd(inner).trim();
        if (text) {
          lines.push(`${num}. ${text}`);
          processedContent.add(inner.trim());
          num++;
        }
      });
  });

  // Tables — convert to markdown tables
  $("table").each((_i, tableEl) => {
    const rows: string[][] = [];
    $(tableEl)
      .find("tr")
      .each((_j, trEl) => {
        const cells: string[] = [];
        $(trEl)
          .find("th, td")
          .each((_k, cellEl) => {
            const inner = $(cellEl).html() ?? $(cellEl).text();
            cells.push(inlineToMd(inner).trim());
          });
        if (cells.length > 0) rows.push(cells);
      });

    if (rows.length === 0) return;

    // Determine max columns and pad rows
    const maxCols = Math.max(...rows.map((r) => r.length));
    const padded = rows.map((r) => [
      ...r,
      ...Array(maxCols - r.length).fill(""),
    ]);

    // First row is header
    const header = padded[0];
    lines.push("", "| " + header.join(" | ") + " |");
    lines.push("| " + header.map(() => "---").join(" | ") + " |");

    // Remaining rows
    for (let r = 1; r < padded.length; r++) {
      lines.push("| " + padded[r].join(" | ") + " |");
    }
    lines.push("");

    // Track processed content
    const inner = $(tableEl).html() ?? $(tableEl).text();
    processedContent.add(inner.trim());
  });

  // Paragraphs — skip if content was already captured by a parent block
  $("p").each((_i, el) => {
    const inner = $(el).html() ?? $(el).text();
    const trimmedInner = inner.trim();
    // Skip if this paragraph's HTML was already processed as part of a parent block
    if (processedContent.has(trimmedInner)) return;
    // Also check if any processed block contains this paragraph's content
    let alreadyCaptured = false;
    for (const processed of processedContent) {
      if (processed.includes(trimmedInner)) {
        alreadyCaptured = true;
        break;
      }
    }
    if (alreadyCaptured) return;

    const text = inlineToMd(trimmedInner).trim();
    if (text) {
      lines.push("", text, "");
    }
  });

  return lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ============================================================================
// Playwright (lazy-loaded, singleton)
// ============================================================================

interface PlaywrightBrowser {
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightPage {
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(
    url: string,
    options?: { timeout?: number; waitUntil?: string },
  ): Promise<void>;
  screenshot(options?: { fullPage?: boolean }): Promise<Buffer>;
  pdf(options?: Record<string, unknown>): Promise<Buffer>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  evaluate(code: string | (() => unknown)): Promise<unknown>;
  waitForSelector(
    selector: string,
    options?: { timeout?: number },
  ): Promise<void>;
  close(): Promise<void>;
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
}

let browserInstance: PlaywrightBrowser | null = null;
/** Guard against concurrent launches — stores the in-flight launch promise. */
let browserLaunchPromise: Promise<PlaywrightBrowser> | null = null;

async function getBrowser(
  config: BrowserToolConfig,
  logger: Logger,
): Promise<PlaywrightBrowser> {
  if (browserInstance) return browserInstance;
  // If a launch is already in-flight, wait for it instead of launching a second browser
  if (browserLaunchPromise) return browserLaunchPromise;

  browserLaunchPromise = (async () => {
    const pw = await ensureLazyModule<{
      chromium: {
        launch(opts?: Record<string, unknown>): Promise<PlaywrightBrowser>;
      };
    }>(
      "playwright",
      (msg) => new Error(msg),
      (mod) =>
        mod as {
          chromium: {
            launch(opts?: Record<string, unknown>): Promise<PlaywrightBrowser>;
          };
        },
    );

    // Sanitize launch options: always strip sandbox-disabling flags
    const opts = { ...(config.launchOptions ?? {}) };
    if (Array.isArray(opts.args)) {
      const blockedFlags = new Set([
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ]);
      opts.args = (opts.args as string[]).filter(
        (arg: string) => !blockedFlags.has(arg),
      );
    }

    logger.debug("Launching Playwright browser");
    return pw.chromium.launch(opts);
  })();

  try {
    browserInstance = await browserLaunchPromise;
    return browserInstance;
  } finally {
    browserLaunchPromise = null;
  }
}

/**
 * Close the Playwright browser instance.
 * Safe to call even if no browser is running.
 * Nulls the reference before awaiting close to prevent stale-reference issues on error.
 */
export async function closeBrowser(): Promise<void> {
  if (browserInstance) {
    const b = browserInstance;
    browserInstance = null;
    await b.close();
  }
}

/** Reset module-level caches. Exported only for test teardown. */
export function _resetForTesting(): void {
  cheerioLoad = null;
  browserInstance = null;
  browserLaunchPromise = null;
}

// ============================================================================
// Basic Mode Tools
// ============================================================================

function createBrowseTool(config: BrowserToolConfig, logger: Logger): Tool {
  return {
    name: "system.browse",
    description:
      "Fetch a web page and extract its readable text content. " +
      "Returns the page title and cleaned text in markdown format. " +
      "Optionally includes links found on the page.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        includeLinks: {
          type: "boolean",
          description: "Include links in the output (default: false)",
        },
      },
      required: ["url"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const urlErr = validateUrl(args.url, config);
      if (urlErr) return urlErr;
      const url = args.url as string;
      const includeLinks = args.includeLinks === true;

      const result = await fetchHtml(url, config, logger);
      if (isFetchError(result)) return result;

      const { html, contentType } = result;

      let load: CheerioLoad;
      try {
        load = await loadCheerio();
      } catch (err) {
        return errorResult((err as Error).message);
      }

      const $ = load(html);
      const text = htmlToMd($);

      // Build links section if requested
      let linksSection = "";
      if (includeLinks) {
        const links: Array<{ text: string; href: string }> = [];
        $("a").each((_i, el) => {
          const aEl = $(el);
          const linkText = aEl.text().trim();
          const href = sanitizeHref(aEl.attr("href") ?? "");
          if (href) {
            links.push({ text: linkText || href, href });
          }
        });
        if (links.length > 0) {
          linksSection =
            "\n\n---\n## Links\n" +
            links.map((l) => `- [${l.text}](${l.href})`).join("\n");
        }
      }

      const contentTypeNote =
        contentType && !contentType.includes("html")
          ? `\n\n_Note: Content-Type was ${contentType}_`
          : "";

      return {
        content: safeStringify({
          url,
          text: text + linksSection + contentTypeNote,
        }),
      };
    },
  };
}

function createExtractLinksTool(
  config: BrowserToolConfig,
  logger: Logger,
): Tool {
  return {
    name: "system.extractLinks",
    description:
      "Extract all links from a web page. Returns a JSON array of { text, href } objects. " +
      "Optionally filter links by text (case-insensitive substring match).",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
        filterText: {
          type: "string",
          description:
            "Filter links by text (case-insensitive substring match)",
        },
      },
      required: ["url"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const urlErr = validateUrl(args.url, config);
      if (urlErr) return urlErr;
      const url = args.url as string;
      const filterText =
        typeof args.filterText === "string"
          ? args.filterText.toLowerCase()
          : null;

      const result = await fetchHtml(url, config, logger);
      if (isFetchError(result)) return result;

      let load: CheerioLoad;
      try {
        load = await loadCheerio();
      } catch (err) {
        return errorResult((err as Error).message);
      }

      const $ = load(result.html);
      const links: Array<{ text: string; href: string }> = [];

      $("a").each((_i, el) => {
        const aEl = $(el);
        const text = aEl.text().trim();
        const href = sanitizeHref(aEl.attr("href") ?? "");
        if (!href) return;
        if (filterText && !text.toLowerCase().includes(filterText)) return;
        links.push({ text: text || href, href });
      });

      return { content: safeStringify({ url, links }) };
    },
  };
}

function createHtmlToMarkdownTool(): Tool {
  return {
    name: "system.htmlToMarkdown",
    description:
      "Convert a raw HTML string to markdown. Handles headings, paragraphs, links, " +
      "emphasis/strong, code/pre blocks, and simple lists (ul/ol). " +
      "Does not fetch any URL — operates on the provided HTML string directly.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "HTML content to convert" },
      },
      required: ["html"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      if (typeof args.html !== "string") {
        return errorResult("Missing or invalid html");
      }
      if (args.html.length === 0) {
        return { content: safeStringify({ markdown: "" }) };
      }

      let load: CheerioLoad;
      try {
        load = await loadCheerio();
      } catch (err) {
        return errorResult((err as Error).message);
      }

      const $ = load(args.html);
      const markdown = htmlToMd($);
      return { content: safeStringify({ markdown }) };
    },
  };
}

// ============================================================================
// Advanced Mode Tools (Playwright)
// ============================================================================

function createScreenshotTool(config: BrowserToolConfig, logger: Logger): Tool {
  return {
    name: "system.screenshot",
    description:
      "Capture a screenshot of a web page as a PNG image. " +
      "Returns a base64-encoded PNG with data URI prefix.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to capture" },
        width: {
          type: "number",
          description: "Viewport width (default: 1280)",
        },
        height: {
          type: "number",
          description: "Viewport height (default: 720)",
        },
        fullPage: {
          type: "boolean",
          description: "Capture full page (default: false)",
        },
      },
      required: ["url"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const urlErr = validateUrl(args.url, config);
      if (urlErr) return urlErr;
      const url = args.url as string;
      const width = typeof args.width === "number" ? args.width : 1280;
      const height = typeof args.height === "number" ? args.height : 720;
      const fullPage = args.fullPage === true;

      try {
        const browser = await getBrowser(config, logger);
        const page = await browser.newPage();
        try {
          await page.setViewportSize({ width, height });
          await page.goto(url, {
            timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            waitUntil: "networkidle",
          });
          const buffer = await page.screenshot({ fullPage });
          const base64 = buffer.toString("base64");
          return {
            content: safeStringify({
              url,
              image: `data:image/png;base64,${base64}`,
            }),
          };
        } finally {
          await page.close();
        }
      } catch (err) {
        return errorResult(`Screenshot failed: ${(err as Error).message}`);
      }
    },
  };
}

function createBrowserActionTool(
  config: BrowserToolConfig,
  logger: Logger,
): Tool {
  return {
    name: "system.browserAction",
    description:
      "Perform a browser interaction on a web page. " +
      "Actions: click, type, scroll, waitForSelector. " +
      "Each call navigates fresh — multi-step interactions do not persist state between calls. " +
      "Optionally returns a screenshot of the result.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        action: {
          type: "string",
          description:
            "Action to perform: click, type, scroll, waitForSelector",
          enum: ["click", "type", "scroll", "waitForSelector"],
        },
        selector: {
          type: "string",
          description: "CSS selector for click/type/waitForSelector",
        },
        text: {
          type: "string",
          description: 'Text to type (for "type" action)',
        },
        x: {
          type: "number",
          description:
            'Horizontal scroll amount in pixels (for "scroll" action)',
        },
        y: {
          type: "number",
          description: 'Vertical scroll amount in pixels (for "scroll" action)',
        },
        waitMs: {
          type: "number",
          description: "Wait timeout in ms for waitForSelector (default: 5000)",
        },
        returnScreenshot: {
          type: "boolean",
          description: "Include a screenshot in the response (default: false)",
        },
      },
      required: ["url", "action"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const urlErr = validateUrl(args.url, config);
      if (urlErr) return urlErr;
      const url = args.url as string;
      const action = args.action as string;
      const selector =
        typeof args.selector === "string" ? args.selector : undefined;
      const text = typeof args.text === "string" ? args.text : undefined;
      const x = typeof args.x === "number" ? args.x : 0;
      const y = typeof args.y === "number" ? args.y : 0;
      const waitMs = typeof args.waitMs === "number" ? args.waitMs : 5000;
      const returnScreenshot = args.returnScreenshot === true;

      // Validate required args before opening a page
      switch (action) {
        case "click":
        case "waitForSelector":
          if (!selector)
            return errorResult(`selector is required for ${action} action`);
          break;
        case "type":
          if (!selector)
            return errorResult("selector is required for type action");
          if (!text) return errorResult("text is required for type action");
          break;
        case "scroll":
          break;
        default:
          return errorResult(`Unknown action: ${action}`);
      }

      try {
        const browser = await getBrowser(config, logger);
        const page = await browser.newPage();
        try {
          await page.goto(url, {
            timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            waitUntil: "networkidle",
          });

          let description: string;
          switch (action) {
            case "click":
              await page.click(selector!);
              description = `Clicked: ${selector}`;
              break;
            case "type":
              await page.fill(selector!, text!);
              description = `Typed "${text}" into ${selector}`;
              break;
            case "scroll":
              await page.mouse.wheel(x, y);
              description = `Scrolled by (${x}, ${y})`;
              break;
            case "waitForSelector":
              await page.waitForSelector(selector!, { timeout: waitMs });
              description = `Selector found: ${selector}`;
              break;
            default:
              // Unreachable — validated above
              description = "";
          }

          const resultObj: Record<string, unknown> = {
            url,
            action,
            description,
          };

          if (returnScreenshot) {
            const buffer = await page.screenshot();
            resultObj.image = `data:image/png;base64,${buffer.toString("base64")}`;
          }

          return { content: safeStringify(resultObj) };
        } finally {
          await page.close();
        }
      } catch (err) {
        return errorResult(`Browser action failed: ${(err as Error).message}`);
      }
    },
  };
}

function createEvaluateJsTool(config: BrowserToolConfig, logger: Logger): Tool {
  return {
    name: "system.evaluateJs",
    description:
      "Run JavaScript code in the context of a web page and return the result. " +
      "WARNING: This executes arbitrary JavaScript and requires explicit approval. " +
      "The code runs in the page context with access to the DOM.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        code: { type: "string", description: "JavaScript code to evaluate" },
      },
      required: ["url", "code"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const urlErr = validateUrl(args.url, config);
      if (urlErr) return urlErr;
      const url = args.url as string;

      if (typeof args.code !== "string" || args.code.length === 0) {
        return errorResult("Missing or invalid code");
      }

      try {
        const browser = await getBrowser(config, logger);
        const page = await browser.newPage();
        try {
          await page.goto(url, {
            timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            waitUntil: "networkidle",
          });
          const result = await page.evaluate(args.code);
          return {
            content: safeStringify({ url, result: result ?? null }),
          };
        } finally {
          await page.close();
        }
      } catch (err) {
        return errorResult(`JS evaluation failed: ${(err as Error).message}`);
      }
    },
  };
}

function createExportPdfTool(config: BrowserToolConfig, logger: Logger): Tool {
  return {
    name: "system.exportPdf",
    description:
      "Export a web page as a PDF document. " +
      "Returns a base64-encoded PDF with data URI prefix.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to export" },
        landscape: {
          type: "boolean",
          description: "Use landscape orientation (default: false)",
        },
        margin: {
          type: "string",
          description:
            'Page margin (e.g. "1cm", "0.5in"). Applied to all sides.',
        },
      },
      required: ["url"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const urlErr = validateUrl(args.url, config);
      if (urlErr) return urlErr;
      const url = args.url as string;
      const landscape = args.landscape === true;
      const margin = typeof args.margin === "string" ? args.margin : undefined;

      try {
        const browser = await getBrowser(config, logger);
        const page = await browser.newPage();
        try {
          await page.goto(url, {
            timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            waitUntil: "networkidle",
          });

          const pdfOptions: Record<string, unknown> = { landscape };
          if (margin) {
            pdfOptions.margin = {
              top: margin,
              right: margin,
              bottom: margin,
              left: margin,
            };
          }

          const buffer = await page.pdf(pdfOptions);
          const base64 = buffer.toString("base64");
          return {
            content: safeStringify({
              url,
              pdf: `data:application/pdf;base64,${base64}`,
            }),
          };
        } finally {
          await page.close();
        }
      } catch (err) {
        return errorResult(`PDF export failed: ${(err as Error).message}`);
      }
    },
  };
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create browser tools for web content extraction.
 *
 * - Basic mode (default): 3 tools using fetch + cheerio (system.browse, system.extractLinks, system.htmlToMarkdown)
 * - Advanced mode: 7 tools (3 basic + 4 Playwright tools: system.screenshot, system.browserAction, system.evaluateJs, system.exportPdf)
 *
 * @param config - Optional configuration for mode, domain control, timeouts, etc.
 * @param logger - Optional logger instance (defaults to silent).
 *
 * @example
 * ```typescript
 * const tools = createBrowserTools({
 *   mode: 'basic',
 *   allowedDomains: ['*.example.com'],
 *   blockedDomains: ['evil.com'],
 * });
 * registry.registerAll(tools);
 * ```
 */
export function createBrowserTools(
  config?: BrowserToolConfig,
  logger?: Logger,
): Tool[] {
  const cfg: BrowserToolConfig = config ?? { mode: "basic" };
  const log = logger ?? silentLogger;

  // Validate config
  if (cfg.mode !== "basic" && cfg.mode !== "advanced") {
    throw new Error(
      `Invalid browser tool mode: ${cfg.mode as string}. Must be 'basic' or 'advanced'.`,
    );
  }
  if (
    cfg.maxResponseBytes !== undefined &&
    (typeof cfg.maxResponseBytes !== "number" || cfg.maxResponseBytes <= 0)
  ) {
    throw new Error("maxResponseBytes must be a positive number");
  }
  if (
    cfg.timeoutMs !== undefined &&
    (typeof cfg.timeoutMs !== "number" || cfg.timeoutMs <= 0)
  ) {
    throw new Error("timeoutMs must be a positive number");
  }

  const basicTools: Tool[] = [
    createBrowseTool(cfg, log),
    createExtractLinksTool(cfg, log),
    createHtmlToMarkdownTool(),
  ];

  if (cfg.mode === "basic") {
    return basicTools;
  }

  const advancedTools: Tool[] = [
    createScreenshotTool(cfg, log),
    createBrowserActionTool(cfg, log),
    createEvaluateJsTool(cfg, log),
    createExportPdfTool(cfg, log),
  ];

  return [...basicTools, ...advancedTools];
}
