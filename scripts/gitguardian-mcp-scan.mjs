#!/usr/bin/env node

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { normalizeMcpContent } from "./lib/mcp-content-normalize.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PROFILE_PATH = path.resolve(__dirname, "../mcp/security-stack.mcp.json");
const DEFAULT_OUTPUT_PATH = path.resolve(process.cwd(), ".tmp/security-mcp-sweep/gitguardian-mcp.json");
const DEFAULT_MAX_FILE_BYTES = 200_000;
const DEFAULT_MAX_DOCUMENT_CHARS = 80_000;
const DEFAULT_MAX_DOCS_PER_BATCH = 12;
const DEFAULT_MAX_BATCH_CHARS = 120_000;
const DEFAULT_MAX_RETRIES = 6;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_CAP_MS = 30_000;

const DEFAULT_EXCLUDED_PREFIXES = [
  ".git/",
  ".next/",
  ".tmp/",
  ".turbo/",
  "node_modules/",
  "mobile/node_modules/",
  "web/node_modules/",
  "demo-app/node_modules/",
  "target/",
];

const DEFAULT_EXCLUDED_EXTENSIONS = new Set([
  ".7z",
  ".avi",
  ".bin",
  ".bmp",
  ".bz2",
  ".class",
  ".db",
  ".dylib",
  ".eot",
  ".flac",
  ".gif",
  ".gz",
  ".ico",
  ".jar",
  ".jpeg",
  ".jpg",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".otf",
  ".pdf",
  ".png",
  ".pyc",
  ".so",
  ".sqlite",
  ".tar",
  ".tgz",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
  ".xz",
  ".zip",
]);

class ToolCallError extends Error {
  constructor(message, kind = "unknown") {
    super(message);
    this.name = "ToolCallError";
    this.kind = kind;
  }
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/gitguardian-mcp-scan.mjs [options]",
      "",
      "Options:",
      "  --profile <path>            MCP config path (default: mcp/security-stack.mcp.json)",
      "  --scope <path>              Scope path (repeatable, default: .)",
      "  --output <path>             Output JSON file (default: .tmp/security-mcp-sweep/gitguardian-mcp.json)",
      "  --max-file-bytes <n>        Skip files larger than n bytes (default: 200000)",
      "  --max-document-chars <n>    Skip files with UTF-8 text > n chars (default: 80000)",
      "  --max-docs <n>              Max docs per MCP request batch (default: 12)",
      "  --max-chars <n>             Max aggregate chars per MCP batch (default: 120000)",
      "  --max-retries <n>           Retries for rate-limit/transient errors (default: 6)",
      "  --backoff-base-ms <n>       Backoff base for retries (default: 1000)",
      "  --backoff-cap-ms <n>        Backoff cap for retries (default: 30000)",
      "  --fail-on-error             Exit non-zero when unresolved batch errors exist",
      "  --verbose                   Print progress details",
      "  --help, -h                  Show help",
    ].join("\n"),
  );
}

function parseInteger(value, flagName) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flagName}: ${String(value)}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const args = {
    backoffBaseMs: DEFAULT_BACKOFF_BASE_MS,
    backoffCapMs: DEFAULT_BACKOFF_CAP_MS,
    failOnError: false,
    maxBatchChars: DEFAULT_MAX_BATCH_CHARS,
    maxDocsPerBatch: DEFAULT_MAX_DOCS_PER_BATCH,
    maxDocumentChars: DEFAULT_MAX_DOCUMENT_CHARS,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxRetries: DEFAULT_MAX_RETRIES,
    outputPath: DEFAULT_OUTPUT_PATH,
    profilePath: DEFAULT_PROFILE_PATH,
    scopes: ["."],
    verbose: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--verbose") {
      args.verbose = true;
      continue;
    }
    if (arg === "--fail-on-error") {
      args.failOnError = true;
      continue;
    }
    if (
      arg === "--profile" ||
      arg === "--scope" ||
      arg === "--output" ||
      arg === "--max-file-bytes" ||
      arg === "--max-document-chars" ||
      arg === "--max-docs" ||
      arg === "--max-chars" ||
      arg === "--max-retries" ||
      arg === "--backoff-base-ms" ||
      arg === "--backoff-cap-ms"
    ) {
      const value = argv[i + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);

      if (arg === "--profile") args.profilePath = path.resolve(process.cwd(), value);
      else if (arg === "--scope") {
        if (args.scopes.length === 1 && args.scopes[0] === ".") args.scopes = [];
        args.scopes.push(value);
      } else if (arg === "--output") args.outputPath = path.resolve(process.cwd(), value);
      else if (arg === "--max-file-bytes") args.maxFileBytes = parseInteger(value, arg);
      else if (arg === "--max-document-chars") args.maxDocumentChars = parseInteger(value, arg);
      else if (arg === "--max-docs") args.maxDocsPerBatch = parseInteger(value, arg);
      else if (arg === "--max-chars") args.maxBatchChars = parseInteger(value, arg);
      else if (arg === "--max-retries") args.maxRetries = parseInteger(value, arg);
      else if (arg === "--backoff-base-ms") args.backoffBaseMs = parseInteger(value, arg);
      else if (arg === "--backoff-cap-ms") args.backoffCapMs = parseInteger(value, arg);

      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseToolPayload(content) {
  const text = normalizeMcpContent(content).trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function looksLikeGitGuardianConfig(serverConfig) {
  if (!serverConfig || typeof serverConfig !== "object") return false;
  if (!Array.isArray(serverConfig.args)) return false;
  const command = typeof serverConfig.command === "string" ? serverConfig.command : "";
  if (command !== "uvx") return false;

  return serverConfig.args.some(
    (arg) =>
      typeof arg === "string" &&
      (arg.includes("github.com/GitGuardian/ggmcp") || arg === "developer-mcp-server" || arg === "secops-mcp-server"),
  );
}

async function loadGitGuardianServer(profilePath) {
  const raw = await fsp.readFile(profilePath, "utf8");
  const parsed = JSON.parse(raw);
  const servers = parsed?.mcpServers;
  if (!servers || typeof servers !== "object") {
    throw new Error(`Invalid MCP profile at ${profilePath}: missing mcpServers object`);
  }

  for (const [name, config] of Object.entries(servers)) {
    if (looksLikeGitGuardianConfig(config)) {
      return { name, config };
    }
  }

  throw new Error(`GitGuardian MCP server entry not found in ${profilePath}`);
}

function assertScopeWithinRepo(repoRoot, scopeInput) {
  const resolved = path.resolve(repoRoot, scopeInput);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Scope path resolves outside repo: ${scopeInput}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Scope path does not exist: ${scopeInput}`);
  }
  if (relative === "") return ".";
  return relative.split(path.sep).join("/");
}

function listGitFiles(pathSpecs) {
  const args = [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "--",
    ...pathSpecs,
  ];
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit code ${String(result.status)}`).trim();
    throw new Error(`git ls-files failed: ${detail}`);
  }

  const unique = new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  );
  return Array.from(unique).sort((a, b) => a.localeCompare(b));
}

function isLikelyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  for (const byte of sample) {
    if (byte === 0) return false;
  }
  return true;
}

function matchesExcludedPrefix(relPath) {
  return DEFAULT_EXCLUDED_PREFIXES.some((prefix) => relPath === prefix.slice(0, -1) || relPath.startsWith(prefix));
}

function matchesExcludedExtension(relPath) {
  const extension = path.extname(relPath).toLowerCase();
  return DEFAULT_EXCLUDED_EXTENSIONS.has(extension);
}

function collectDocuments(files, settings) {
  const documents = [];
  const stats = {
    skipped_binary: 0,
    skipped_excluded_ext: 0,
    skipped_excluded_prefix: 0,
    skipped_large_bytes: 0,
    skipped_large_chars: 0,
  };

  for (const relPath of files) {
    if (matchesExcludedPrefix(relPath)) {
      stats.skipped_excluded_prefix += 1;
      continue;
    }
    if (matchesExcludedExtension(relPath)) {
      stats.skipped_excluded_ext += 1;
      continue;
    }

    const absolutePath = path.resolve(process.cwd(), relPath);
    let fileStat;
    try {
      fileStat = fs.statSync(absolutePath);
    } catch {
      continue;
    }
    if (!fileStat.isFile()) continue;
    if (fileStat.size > settings.maxFileBytes) {
      stats.skipped_large_bytes += 1;
      continue;
    }

    let buffer;
    try {
      buffer = fs.readFileSync(absolutePath);
    } catch {
      continue;
    }
    if (!isLikelyText(buffer)) {
      stats.skipped_binary += 1;
      continue;
    }

    const document = buffer.toString("utf8");
    if (document.length > settings.maxDocumentChars) {
      stats.skipped_large_chars += 1;
      continue;
    }

    documents.push({ document, filename: relPath });
  }

  return { documents, stats };
}

function createBatches(documents, maxDocsPerBatch, maxBatchChars) {
  const batches = [];
  let current = [];
  let currentChars = 0;

  for (const doc of documents) {
    const docChars = doc.document.length;
    const wouldOverflowCount = current.length >= maxDocsPerBatch;
    const wouldOverflowChars = current.length > 0 && currentChars + docChars > maxBatchChars;

    if (wouldOverflowCount || wouldOverflowChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(doc);
    currentChars += docChars;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}

function classifyError(message) {
  const normalized = String(message).toLowerCase();
  if (normalized.includes("429") || normalized.includes("too many requests")) return "rate_limit";
  if (normalized.includes("400") || normalized.includes("bad request")) return "payload";
  if (
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("econnreset") ||
    normalized.includes("socket hang up") ||
    normalized.includes("network") ||
    normalized.includes("fetch failed")
  ) {
    return "transient";
  }
  return "unknown";
}

function backoffDelayMs(attempt, baseMs, capMs) {
  const exponential = Math.min(capMs, baseMs * (2 ** attempt));
  const jitter = Math.floor(Math.random() * 250);
  return exponential + jitter;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectGitGuardianClient(serverConfig) {
  const transport = new StdioClientTransport({
    command: serverConfig.command,
    args: Array.isArray(serverConfig.args) ? serverConfig.args : [],
    env: {
      ...process.env,
      ...(serverConfig.env && typeof serverConfig.env === "object" ? serverConfig.env : {}),
    },
  });

  const client = new Client(
    { name: "gitguardian-mcp-scan-wrapper", version: "0.1.0" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

async function callScanSecretsWithRetries(client, batch, options, state) {
  let attempt = 0;

  while (true) {
    try {
      const result = await client.callTool({
        name: "scan_secrets",
        arguments: { params: { documents: batch } },
      });
      if (result?.isError) {
        throw new ToolCallError(normalizeContent(result?.content), classifyError(normalizeContent(result?.content)));
      }

      const payload = parseToolPayload(result?.content);
      if (!payload || !Array.isArray(payload.scan_results)) {
        throw new ToolCallError("scan_secrets returned malformed payload (missing scan_results)", "unknown");
      }

      return payload.scan_results;
    } catch (error) {
      const message = toErrorMessage(error);
      const kind = error instanceof ToolCallError ? error.kind : classifyError(message);

      if ((kind === "rate_limit" || kind === "transient") && attempt < options.maxRetries) {
        const waitMs = backoffDelayMs(attempt, options.backoffBaseMs, options.backoffCapMs);
        state.retryCount += 1;
        if (kind === "rate_limit") state.rateLimitCount += 1;
        if (options.verbose) {
          console.log(
            `[gitguardian] ${kind} retry in ${waitMs}ms (attempt ${attempt + 1}/${options.maxRetries}, batch docs=${batch.length})`,
          );
        }
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

      throw new ToolCallError(message, kind);
    }
  }
}

async function scanDocuments(client, initialBatches, options) {
  const findings = [];
  const errors = [];
  const queue = initialBatches.map((docs) => ({ docs }));
  const state = {
    payloadSplitCount: 0,
    rateLimitSplitCount: 0,
    rateLimitCount: 0,
    retryCount: 0,
  };

  let processedBatches = 0;
  let maxQueueDepth = queue.length;

  while (queue.length > 0) {
    maxQueueDepth = Math.max(maxQueueDepth, queue.length);
    const item = queue.shift();
    if (!item || item.docs.length === 0) continue;

    let scanResults;
    try {
      scanResults = await callScanSecretsWithRetries(client, item.docs, options, state);
    } catch (error) {
      const toolError = error instanceof ToolCallError ? error : new ToolCallError(toErrorMessage(error));

      if ((toolError.kind === "payload" || toolError.kind === "rate_limit") && item.docs.length > 1) {
        const midpoint = Math.floor(item.docs.length / 2);
        const left = item.docs.slice(0, midpoint);
        const right = item.docs.slice(midpoint);
        queue.unshift({ docs: right }, { docs: left });
        if (toolError.kind === "payload") state.payloadSplitCount += 1;
        if (toolError.kind === "rate_limit") state.rateLimitSplitCount += 1;
        if (options.verbose) {
          console.log(
            `[gitguardian] ${toolError.kind} split triggered (docs=${item.docs.length} -> ${left.length}+${right.length})`,
          );
        }
        continue;
      }

      errors.push({
        batch_doc_count: item.docs.length,
        error: toolError.message,
        kind: toolError.kind,
        sample_files: item.docs.slice(0, 5).map((doc) => doc.filename),
      });
      continue;
    }

    processedBatches += 1;
    const limit = Math.min(item.docs.length, scanResults.length);

    for (let i = 0; i < limit; i += 1) {
      const file = item.docs[i]?.filename ?? `unknown-${String(i)}`;
      const result = scanResults[i] ?? {};
      const policyBreakCount = Number(result?.policy_break_count ?? 0);
      if (!Number.isFinite(policyBreakCount) || policyBreakCount <= 0) continue;

      findings.push({
        file,
        policies: Array.isArray(result?.policies) ? result.policies : [],
        policy_break_count: policyBreakCount,
        policy_breaks: Array.isArray(result?.policy_breaks) ? result.policy_breaks : [],
      });
    }

    if (scanResults.length !== item.docs.length) {
      errors.push({
        batch_doc_count: item.docs.length,
        error: `scan_results length mismatch: expected ${String(item.docs.length)} got ${String(scanResults.length)}`,
        kind: "malformed_response",
        sample_files: item.docs.slice(0, 5).map((doc) => doc.filename),
      });
    }
  }

  return {
    errors,
    findings,
    stats: {
      max_queue_depth: maxQueueDepth,
      payload_splits: state.payloadSplitCount,
      processed_batches: processedBatches,
      rate_limit_splits: state.rateLimitSplitCount,
      rate_limit_retries: state.rateLimitCount,
      retries_total: state.retryCount,
    },
  };
}

async function writeOutput(outputPath, payload) {
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  await fsp.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const scopePaths = options.scopes.map((scope) => assertScopeWithinRepo(repoRoot, scope));

  const { name: serverName, config: serverConfig } = await loadGitGuardianServer(options.profilePath);
  const candidateFiles = listGitFiles(scopePaths);
  const { documents, stats: collectionStats } = collectDocuments(candidateFiles, options);
  const batches = createBatches(documents, options.maxDocsPerBatch, options.maxBatchChars);

  if (options.verbose) {
    console.log(`[gitguardian] server=${serverName}`);
    console.log(`[gitguardian] scopes=${scopePaths.join(", ")}`);
    console.log(
      `[gitguardian] candidates=${candidateFiles.length}, documents=${documents.length}, batches=${batches.length}`,
    );
  }

  let scanResult = {
    errors: [],
    findings: [],
    stats: {
      max_queue_depth: 0,
      payload_splits: 0,
      processed_batches: 0,
      rate_limit_retries: 0,
      retries_total: 0,
    },
  };

  if (batches.length > 0) {
    const client = await connectGitGuardianClient(serverConfig);
    try {
      scanResult = await scanDocuments(client, batches, options);
    } finally {
      await client.close();
    }
  }

  const totalPolicyBreaks = scanResult.findings.reduce(
    (sum, finding) => sum + Number(finding.policy_break_count ?? 0),
    0,
  );

  const outputPayload = {
    generated_at: new Date().toISOString(),
    profile_path: options.profilePath,
    scope_paths: scopePaths,
    scanner: "gitguardian-mcp",
    server: {
      args: Array.isArray(serverConfig.args) ? serverConfig.args : [],
      command: serverConfig.command,
      name: serverName,
    },
    settings: {
      backoff_base_ms: options.backoffBaseMs,
      backoff_cap_ms: options.backoffCapMs,
      max_batch_chars: options.maxBatchChars,
      max_docs_per_batch: options.maxDocsPerBatch,
      max_document_chars: options.maxDocumentChars,
      max_file_bytes: options.maxFileBytes,
      max_retries: options.maxRetries,
    },
    stats: {
      candidate_files: candidateFiles.length,
      findings: scanResult.findings.length,
      policy_breaks_total: totalPolicyBreaks,
      queued_batches_initial: batches.length,
      scanned_documents: documents.length,
      skipped_binary: collectionStats.skipped_binary,
      skipped_excluded_ext: collectionStats.skipped_excluded_ext,
      skipped_excluded_prefix: collectionStats.skipped_excluded_prefix,
      skipped_large_bytes: collectionStats.skipped_large_bytes,
      skipped_large_chars: collectionStats.skipped_large_chars,
      unresolved_errors: scanResult.errors.length,
      ...scanResult.stats,
    },
    findings: scanResult.findings,
    errors: scanResult.errors,
  };

  await writeOutput(options.outputPath, outputPayload);

  console.log(
    [
      `gitguardian_mcp_scan: files=${String(outputPayload.stats.scanned_documents)}`,
      `batches=${String(outputPayload.stats.queued_batches_initial)}`,
      `findings=${String(outputPayload.stats.findings)}`,
      `policy_breaks=${String(outputPayload.stats.policy_breaks_total)}`,
      `errors=${String(outputPayload.stats.unresolved_errors)}`,
      `splits=${String(outputPayload.stats.payload_splits)}`,
      `rate_limit_splits=${String(outputPayload.stats.rate_limit_splits)}`,
      `retries=${String(outputPayload.stats.retries_total)}`,
    ].join(", "),
  );
  console.log(`output=${options.outputPath}`);

  if (options.failOnError && outputPayload.stats.unresolved_errors > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`gitguardian-mcp-scan failed: ${toErrorMessage(error)}`);
  process.exit(1);
});
