import { rmSync } from "node:fs";
import { open as openFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Tool, ToolResult } from "../types.js";
import type { Logger } from "../../utils/logger.js";
import { silentLogger } from "../../utils/logger.js";
import { ensureLazyModule } from "../../utils/lazy-import.js";
import {
  formatDomainBlockReason,
  isDomainAllowed,
} from "./http.js";
import type { BrowserToolConfig } from "./browser.js";
import {
  asFiniteNumber,
  asObject,
  asTrimmedString,
  handleErrorResult,
  handleOkResult,
  isToolResult,
  normalizeHandleIdentity,
  normalizeResourceEnvelope,
  type StructuredHandleResourceEnvelope,
} from "./handle-contract.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const BROWSER_SESSION_ROOT = "/tmp/agenc-browser-sessions";
const MAX_BROWSER_SESSION_ARTIFACTS = 24;
const BROWSER_SESSION_SCHEMA_VERSION = 1;
const BROWSER_SESSION_BLOCKED_FLAGS = new Set([
  "--no-sandbox",
  "--disable-setuid-sandbox",
]);
const BROWSER_SESSION_DETERMINISTIC_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-sync",
];

type BrowserSessionState = "running" | "stopped" | "failed";
type BrowserSessionArtifactKind = "download" | "upload" | "screenshot" | "pdf";
type BrowserSessionTransferKind = "download" | "upload";
type BrowserSessionTransferState =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";
type BrowserSessionActionType =
  | "navigate"
  | "click"
  | "type"
  | "scroll"
  | "waitForSelector"
  | "upload"
  | "screenshot"
  | "exportPdf";

interface BrowserSessionArtifact {
  readonly kind: BrowserSessionArtifactKind;
  readonly path: string;
  readonly observedAt: number;
  readonly label?: string;
  readonly sizeBytes?: number;
}

interface BrowserSessionTransfer {
  readonly transferId: string;
  readonly sessionId: string;
  readonly kind: BrowserSessionTransferKind;
  readonly state: BrowserSessionTransferState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly label?: string;
  readonly idempotencyKey?: string;
  readonly selector?: string;
  readonly sourcePath?: string;
  readonly artifactPath?: string;
  readonly completedAt?: number;
  readonly cancelledAt?: number;
  readonly error?: string;
}

interface BrowserSessionRecord {
  readonly version: number;
  readonly sessionId: string;
  readonly label?: string;
  readonly idempotencyKey?: string;
  readonly startUrl: string;
  readonly downloadsDir: string;
  readonly artifactsDir: string;
  readonly userDataDir: string;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  state: BrowserSessionState;
  currentUrl?: string;
  title?: string;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
  lastActionAt?: number;
  artifacts: BrowserSessionArtifact[];
  transfers: BrowserSessionTransfer[];
  readonly resourceEnvelope?: StructuredHandleResourceEnvelope;
}

interface PersistedBrowserSessionRegistry {
  readonly version: number;
  readonly sessions: readonly BrowserSessionRecord[];
}

interface BrowserSessionRuntime {
  readonly context: PlaywrightBrowserContext;
  readonly page: PlaywrightPage;
  readonly record: BrowserSessionRecord;
  downloadListenerAttached: boolean;
}

interface PlaywrightBrowserContext {
  pages(): Promise<PlaywrightPage[]> | PlaywrightPage[];
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightDownload {
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
  cancel?(): Promise<void>;
}

interface PlaywrightPage {
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  goto(
    url: string,
    options?: { timeout?: number; waitUntil?: string },
  ): Promise<void>;
  screenshot(options?: { fullPage?: boolean; path?: string }): Promise<Buffer>;
  pdf(options?: Record<string, unknown>): Promise<Buffer>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  setInputFiles?(
    selector: string,
    files: string | readonly string[],
  ): Promise<void>;
  waitForSelector(
    selector: string,
    options?: { timeout?: number },
  ): Promise<void>;
  close(): Promise<void>;
  title(): Promise<string>;
  url(): string;
  on?(event: "download", handler: (download: PlaywrightDownload) => void): void;
  mouse: { wheel(deltaX: number, deltaY: number): Promise<void> };
}
const BROWSER_SESSION_FAMILY = "browser_session";

function sanitizeFilename(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}

function cloneRecord(record: BrowserSessionRecord): BrowserSessionRecord {
  return JSON.parse(JSON.stringify(record)) as BrowserSessionRecord;
}

function isTransferState(value: unknown): value is BrowserSessionTransferState {
  return (
    value === "pending" ||
    value === "in_progress" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function normalizePersistedTransfers(
  sessionId: string,
  value: unknown,
): BrowserSessionTransfer[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const transfers: BrowserSessionTransfer[] = [];
  for (const entry of value) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof (entry as BrowserSessionTransfer).transferId !== "string" ||
      ((entry as BrowserSessionTransfer).kind !== "download" &&
        (entry as BrowserSessionTransfer).kind !== "upload") ||
      !isTransferState((entry as BrowserSessionTransfer).state)
    ) {
      continue;
    }
    const transfer = entry as BrowserSessionTransfer;
    transfers.push({
      ...transfer,
      sessionId,
    });
  }
  return transfers;
}

function validateUrl(
  url: unknown,
  config: BrowserToolConfig,
): ToolResult | null {
  if (typeof url !== "string" || url.trim().length === 0) {
    return handleErrorResult(
      BROWSER_SESSION_FAMILY,
      "browser_session.invalid_url",
      "Missing or invalid url",
      false,
      undefined,
      "start",
    );
  }
  const check = isDomainAllowed(
    url,
    config.allowedDomains,
    config.blockedDomains,
  );
  if (!check.allowed) {
    return handleErrorResult(
      BROWSER_SESSION_FAMILY,
      "browser_session.domain_blocked",
      formatDomainBlockReason(check.reason!),
      false,
      undefined,
      "start",
    );
  }
  return null;
}

function normalizeViewport(args: Record<string, unknown>): {
  width: number;
  height: number;
} | ToolResult {
  const width = asFiniteNumber(args.width) ?? 1280;
  const height = asFiniteNumber(args.height) ?? 720;
  if (width <= 0 || height <= 0) {
    return handleErrorResult(
      BROWSER_SESSION_FAMILY,
      "browser_session.invalid_viewport",
      "width and height must be positive numbers",
      false,
      undefined,
      "start",
    );
  }
  return { width, height };
}

function buildPersistentLaunchOptions(
  config: BrowserToolConfig,
  downloadsDir: string,
): Record<string, unknown> {
  const opts = { ...(config.launchOptions ?? {}) };
  const existingArgs = Array.isArray(opts.args)
    ? (opts.args as string[])
    : [];
  const filteredArgs = existingArgs.filter(
    (arg) => !BROWSER_SESSION_BLOCKED_FLAGS.has(arg),
  );
  const missingDeterministicFlags = BROWSER_SESSION_DETERMINISTIC_FLAGS.filter(
    (flag) => !filteredArgs.includes(flag),
  );
  return {
    ...opts,
    args: [...filteredArgs, ...missingDeterministicFlags],
    acceptDownloads: true,
    downloadsPath: downloadsDir,
  };
}

async function loadPlaywright(): Promise<{
  chromium: {
    launchPersistentContext(
      userDataDir: string,
      options?: Record<string, unknown>,
    ): Promise<PlaywrightBrowserContext>;
  };
}> {
  return ensureLazyModule(
    "playwright",
    (message) => new Error(message),
    (mod) =>
      mod as {
        chromium: {
          launchPersistentContext(
            userDataDir: string,
            options?: Record<string, unknown>,
          ): Promise<PlaywrightBrowserContext>;
        };
      },
  );
}

function buildSessionResponse(
  record: BrowserSessionRecord,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    sessionId: record.sessionId,
    ...(record.label ? { label: record.label } : {}),
    ...(record.idempotencyKey ? { idempotencyKey: record.idempotencyKey } : {}),
    state: record.state,
    startUrl: record.startUrl,
    ...(record.currentUrl ? { currentUrl: record.currentUrl } : {}),
    ...(record.title ? { title: record.title } : {}),
    viewport: {
      width: record.viewportWidth,
      height: record.viewportHeight,
    },
    downloadsDir: record.downloadsDir,
    artifactsDir: record.artifactsDir,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.lastActionAt ? { lastActionAt: record.lastActionAt } : {}),
    ...(record.lastError ? { lastError: record.lastError } : {}),
    artifactCount: record.artifacts.length,
    artifacts: record.artifacts,
    transferCount: record.transfers.length,
    transfers: record.transfers,
    ...(record.resourceEnvelope ? { resourceEnvelope: record.resourceEnvelope } : {}),
    ...extra,
  };
}

function buildTransferResponse(
  transfer: BrowserSessionTransfer,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    transferId: transfer.transferId,
    sessionId: transfer.sessionId,
    kind: transfer.kind,
    state: transfer.state,
    createdAt: transfer.createdAt,
    updatedAt: transfer.updatedAt,
    ...(transfer.label ? { label: transfer.label } : {}),
    ...(transfer.idempotencyKey ? { idempotencyKey: transfer.idempotencyKey } : {}),
    ...(transfer.selector ? { selector: transfer.selector } : {}),
    ...(transfer.sourcePath ? { sourcePath: transfer.sourcePath } : {}),
    ...(transfer.artifactPath ? { artifactPath: transfer.artifactPath } : {}),
    ...(transfer.completedAt !== undefined ? { completedAt: transfer.completedAt } : {}),
    ...(transfer.cancelledAt !== undefined ? { cancelledAt: transfer.cancelledAt } : {}),
    ...(transfer.error ? { error: transfer.error } : {}),
    ...extra,
  };
}

export class BrowserSessionManager {
  private readonly registryPath: string;
  private readonly rootDir: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private loaded = false;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly records = new Map<string, BrowserSessionRecord>();
  private readonly runtimes = new Map<string, BrowserSessionRuntime>();
  private readonly activeTransferCancels = new Map<
    string,
    () => Promise<void> | void
  >();

  constructor(config?: {
    readonly registryPath?: string;
    readonly rootDir?: string;
    readonly logger?: Logger;
    readonly now?: () => number;
  }) {
    this.rootDir = config?.rootDir ?? BROWSER_SESSION_ROOT;
    this.registryPath =
      config?.registryPath ?? join(this.rootDir, "registry.json");
    this.logger = config?.logger ?? silentLogger;
    this.now = config?.now ?? (() => Date.now());
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(raw) as PersistedBrowserSessionRegistry;
      if (!Array.isArray(parsed.sessions)) {
        return;
      }
      for (const entry of parsed.sessions) {
        if (
          typeof entry?.sessionId === "string" &&
          typeof entry?.startUrl === "string" &&
          typeof entry?.downloadsDir === "string" &&
          typeof entry?.artifactsDir === "string" &&
          typeof entry?.userDataDir === "string"
        ) {
          this.records.set(
            entry.sessionId,
            cloneRecord({
              ...entry,
              transfers: normalizePersistedTransfers(
                entry.sessionId,
                (entry as { transfers?: unknown }).transfers,
              ),
            } as BrowserSessionRecord),
          );
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/ENOENT/i.test(message)) {
        this.logger.warn("Failed to load browser session registry", { message });
      }
    }
  }

  private async persist(): Promise<void> {
    await this.ensureLoaded();
    const snapshot: PersistedBrowserSessionRegistry = {
      version: BROWSER_SESSION_SCHEMA_VERSION,
      sessions: [...this.records.values()].map((record) => cloneRecord(record)),
    };
    this.persistChain = this.persistChain.then(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const tempPath = `${this.registryPath}.${randomUUID()}.tmp`;
      const handle = await openFile(tempPath, "w");
      try {
        await handle.writeFile(JSON.stringify(snapshot, null, 2), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.registryPath);
    });
    await this.persistChain;
  }

  private findByLabel(label: string): BrowserSessionRecord | undefined {
    for (const record of this.records.values()) {
      if (record.label === label) {
        return record;
      }
    }
    return undefined;
  }

  private findByIdempotencyKey(idempotencyKey: string): BrowserSessionRecord | undefined {
    for (const record of this.records.values()) {
      if (record.idempotencyKey === idempotencyKey) {
        return record;
      }
    }
    return undefined;
  }

  private async resolveRecord(
    args: Record<string, unknown>,
  ): Promise<BrowserSessionRecord | ToolResult> {
    await this.ensureLoaded();
    const sessionId = asTrimmedString(args.sessionId);
    const identity = normalizeHandleIdentity(
      BROWSER_SESSION_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const label = identity.label;
    const idempotencyKey = identity.idempotencyKey;
    const record = sessionId
      ? this.records.get(sessionId)
      : idempotencyKey
        ? this.findByIdempotencyKey(idempotencyKey)
      : label
        ? this.findByLabel(label)
        : undefined;
    if (!record) {
      return handleErrorResult(
        BROWSER_SESSION_FAMILY,
        "browser_session.not_found",
        "Browser session not found. Provide sessionId or a previously used label/idempotencyKey.",
        false,
        undefined,
        "lookup",
      );
    }
    return record;
  }

  private findTransferById(
    transferId: string,
  ): { record: BrowserSessionRecord; transfer: BrowserSessionTransfer } | undefined {
    for (const record of this.records.values()) {
      const transfer = record.transfers.find((entry) => entry.transferId === transferId);
      if (transfer) {
        return { record, transfer };
      }
    }
    return undefined;
  }

  private findTransferByIdempotencyKey(
    record: BrowserSessionRecord,
    idempotencyKey: string,
  ): BrowserSessionTransfer | undefined {
    return record.transfers.find((entry) => entry.idempotencyKey === idempotencyKey);
  }

  private async resolveTransfer(
    args: Record<string, unknown>,
  ): Promise<{ record: BrowserSessionRecord; transfer: BrowserSessionTransfer } | ToolResult> {
    await this.ensureLoaded();
    const transferId = asTrimmedString(args.transferId);
    if (transferId) {
      const resolved = this.findTransferById(transferId);
      if (resolved) {
        return resolved;
      }
    }

    const record = await this.resolveRecord(args);
    if (isToolResult(record)) {
      return record;
    }
    const identity = normalizeHandleIdentity(
      BROWSER_SESSION_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const label = identity.label;
    const idempotencyKey = identity.idempotencyKey;
    const transfer = idempotencyKey
      ? this.findTransferByIdempotencyKey(record, idempotencyKey)
      : label
        ? record.transfers.find((entry) => entry.label === label)
        : undefined;
    if (!transfer) {
      return handleErrorResult(
        BROWSER_SESSION_FAMILY,
        "browser_session.transfer_not_found",
        "Browser transfer not found. Provide transferId or a previously used session + label/idempotencyKey.",
        false,
        undefined,
        "lookup",
        "not_found",
      );
    }
    return { record, transfer };
  }

  private async updateRecordFromPage(record: BrowserSessionRecord, page: PlaywrightPage): Promise<void> {
    record.currentUrl = page.url();
    try {
      const title = await page.title();
      record.title = title.trim().length > 0 ? title.trim() : undefined;
    } catch {
      // Some pages fail title resolution; keep the last known title.
    }
    record.updatedAt = this.now();
  }

  private async recordArtifact(
    record: BrowserSessionRecord,
    artifact: Omit<BrowserSessionArtifact, "observedAt" | "sizeBytes"> & {
      readonly observedAt?: number;
      readonly sizeBytes?: number;
    },
  ): Promise<void> {
    let sizeBytes = artifact.sizeBytes;
    if (sizeBytes === undefined) {
      try {
        sizeBytes = (await stat(artifact.path)).size;
      } catch {
        sizeBytes = undefined;
      }
    }
    record.artifacts = [
      {
        kind: artifact.kind,
        path: artifact.path,
        observedAt: artifact.observedAt ?? this.now(),
        ...(artifact.label ? { label: artifact.label } : {}),
        ...(typeof sizeBytes === "number" ? { sizeBytes } : {}),
      },
      ...record.artifacts,
    ].slice(0, MAX_BROWSER_SESSION_ARTIFACTS);
    record.updatedAt = this.now();
    await this.persist();
  }

  private async upsertTransfer(
    record: BrowserSessionRecord,
    transfer: BrowserSessionTransfer,
  ): Promise<BrowserSessionTransfer> {
    const existingIndex = record.transfers.findIndex(
      (entry) => entry.transferId === transfer.transferId,
    );
    const nextTransfer = {
      ...transfer,
      sessionId: record.sessionId,
      updatedAt: this.now(),
    };
    if (existingIndex >= 0) {
      const nextTransfers = [...record.transfers];
      nextTransfers.splice(existingIndex, 1, nextTransfer);
      record.transfers = nextTransfers;
    } else {
      record.transfers = [nextTransfer, ...record.transfers];
    }
    record.updatedAt = nextTransfer.updatedAt;
    await this.persist();
    return nextTransfer;
  }

  private attachDownloadListener(runtime: BrowserSessionRuntime): void {
    if (runtime.downloadListenerAttached || typeof runtime.page.on !== "function") {
      return;
    }
    runtime.downloadListenerAttached = true;
    runtime.page.on("download", (download) => {
      void (async () => {
        const filename = sanitizeFilename(download.suggestedFilename());
        const downloadPath = join(runtime.record.downloadsDir, filename);
        const transferId = `transfer_${randomUUID().slice(0, 8)}`;
        await this.upsertTransfer(runtime.record, {
          transferId,
          sessionId: runtime.record.sessionId,
          kind: "download",
          state: "in_progress",
          createdAt: this.now(),
          updatedAt: this.now(),
          artifactPath: downloadPath,
          label: filename,
        });
        if (typeof download.cancel === "function") {
          this.activeTransferCancels.set(transferId, () => download.cancel!());
        }
        try {
          await mkdir(runtime.record.downloadsDir, { recursive: true });
          await download.saveAs(downloadPath);
          await this.recordArtifact(runtime.record, {
            kind: "download",
            path: downloadPath,
            label: filename,
          });
          await this.upsertTransfer(runtime.record, {
            transferId,
            sessionId: runtime.record.sessionId,
            kind: "download",
            state: "completed",
            createdAt: this.now(),
            updatedAt: this.now(),
            completedAt: this.now(),
            artifactPath: downloadPath,
            label: filename,
          });
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          const existing = this.findTransferById(transferId)?.transfer;
          const cancelledAt = existing?.state === "cancelled" ? this.now() : undefined;
          await this.upsertTransfer(runtime.record, {
            transferId,
            sessionId: runtime.record.sessionId,
            kind: "download",
            state: existing?.state === "cancelled" ? "cancelled" : "failed",
            createdAt: existing?.createdAt ?? this.now(),
            updatedAt: this.now(),
            ...(cancelledAt !== undefined ? { cancelledAt } : {}),
            artifactPath: downloadPath,
            label: filename,
            error: errorMessage,
          });
          this.logger.warn("Failed to persist browser download artifact", {
            sessionId: runtime.record.sessionId,
            error: errorMessage,
          });
        } finally {
          this.activeTransferCancels.delete(transferId);
        }
      })();
    });
  }

  private async ensureRuntime(
    record: BrowserSessionRecord,
    toolConfig: BrowserToolConfig,
  ): Promise<BrowserSessionRuntime | ToolResult> {
    const existing = this.runtimes.get(record.sessionId);
    if (existing) {
      await this.updateRecordFromPage(record, existing.page);
      await this.persist();
      return existing;
    }

    try {
      await mkdir(record.userDataDir, { recursive: true });
      await mkdir(record.downloadsDir, { recursive: true });
      await mkdir(record.artifactsDir, { recursive: true });
      const playwright = await loadPlaywright();
      const context = await playwright.chromium.launchPersistentContext(
        record.userDataDir,
        buildPersistentLaunchOptions(toolConfig, record.downloadsDir),
      );
      const pages = await Promise.resolve(context.pages());
      const page = pages[0] ?? await context.newPage();
      await page.setViewportSize({
        width: record.viewportWidth,
        height: record.viewportHeight,
      });
      const targetUrl = record.currentUrl ?? record.startUrl;
      if (targetUrl && page.url() !== targetUrl) {
        await page.goto(targetUrl, {
          timeout: toolConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          waitUntil: "networkidle",
        });
      }
      const runtime: BrowserSessionRuntime = {
        context,
        page,
        record,
        downloadListenerAttached: false,
      };
      this.attachDownloadListener(runtime);
      this.runtimes.set(record.sessionId, runtime);
      record.state = "running";
      record.lastError = undefined;
      await this.updateRecordFromPage(record, page);
      await this.persist();
      return runtime;
    } catch (error) {
      record.state = "failed";
      record.lastError = error instanceof Error ? error.message : String(error);
      record.updatedAt = this.now();
      await this.persist();
      return handleErrorResult(
        BROWSER_SESSION_FAMILY,
        "browser_session.launch_failed",
        `Browser session failed to start: ${record.lastError}`,
        true,
        undefined,
        "start",
      );
    }
  }

  async startSession(
    args: Record<string, unknown>,
    toolConfig: BrowserToolConfig,
  ): Promise<ToolResult> {
    await this.ensureLoaded();
    const urlError = validateUrl(args.url, toolConfig);
    if (urlError) return urlError;
    const identity = normalizeHandleIdentity(
      BROWSER_SESSION_FAMILY,
      args.label,
      args.idempotencyKey,
    );
    const viewport = normalizeViewport(args);
    if (isToolResult(viewport)) {
      return viewport;
    }
    const resourceEnvelope = normalizeResourceEnvelope(
      BROWSER_SESSION_FAMILY,
      args.resourceEnvelope,
      "start",
    );
    if (isToolResult(resourceEnvelope)) {
      return resourceEnvelope;
    }
    const label = identity.label;
    const idempotencyKey = identity.idempotencyKey;
    const matchesStartSpec = (record: BrowserSessionRecord): boolean =>
      record.startUrl === (args.url as string) &&
      record.viewportWidth === viewport.width &&
      record.viewportHeight === viewport.height;
    if (idempotencyKey) {
      const existing = this.findByIdempotencyKey(idempotencyKey);
      if (existing) {
        const runtime = await this.ensureRuntime(existing, toolConfig);
        if (isToolResult(runtime)) {
          return runtime;
        }
        if (matchesStartSpec(existing)) {
          return handleOkResult(buildSessionResponse(existing, { reused: true }));
        }
        return handleErrorResult(
          BROWSER_SESSION_FAMILY,
          "browser_session.idempotency_conflict",
          "A browser session already exists for that idempotencyKey.",
          false,
          { sessionId: existing.sessionId, state: existing.state },
          "start",
        );
      }
    }
    if (label) {
      const existing = this.findByLabel(label);
      if (existing) {
        const runtime = await this.ensureRuntime(existing, toolConfig);
        if (isToolResult(runtime)) {
          return runtime;
        }
        if (existing.idempotencyKey === idempotencyKey && matchesStartSpec(existing)) {
          return handleOkResult(buildSessionResponse(existing, { reused: true }));
        }
        return handleErrorResult(
          BROWSER_SESSION_FAMILY,
          "browser_session.label_conflict",
          "A browser session already exists for that label.",
          false,
          { sessionId: existing.sessionId, state: existing.state },
          "start",
        );
      }
    }

    const sessionId = `browser_${randomUUID().slice(0, 8)}`;
    const sessionRoot = join(this.rootDir, sessionId);
    const record: BrowserSessionRecord = {
      version: BROWSER_SESSION_SCHEMA_VERSION,
      sessionId,
      ...(label ? { label } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      startUrl: args.url as string,
      downloadsDir: join(sessionRoot, "downloads"),
      artifactsDir: join(sessionRoot, "artifacts"),
      userDataDir: join(sessionRoot, "profile"),
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      state: "running",
      createdAt: this.now(),
      updatedAt: this.now(),
      artifacts: [],
      transfers: [],
      ...(resourceEnvelope ? { resourceEnvelope } : {}),
    };
    this.records.set(sessionId, record);
    const runtime = await this.ensureRuntime(record, toolConfig);
    if (isToolResult(runtime)) {
      return runtime;
    }
    return handleOkResult(buildSessionResponse(record, { started: true }));
  }

  async getStatus(
    args: Record<string, unknown>,
    toolConfig: BrowserToolConfig,
  ): Promise<ToolResult> {
    const resolved = await this.resolveRecord(args);
    if (isToolResult(resolved)) {
      return resolved;
    }
    const runtime = resolved.state === "running"
      ? await this.ensureRuntime(resolved, toolConfig)
      : undefined;
    if (runtime && isToolResult(runtime)) {
      return runtime;
    }
    if (runtime && !isToolResult(runtime)) {
      await this.updateRecordFromPage(resolved, runtime.page);
      await this.persist();
    }
    return handleOkResult(buildSessionResponse(resolved, {
      running: resolved.state === "running",
    }));
  }

  async resumeSession(
    args: Record<string, unknown>,
    toolConfig: BrowserToolConfig,
  ): Promise<ToolResult> {
    const resolved = await this.resolveRecord(args);
    if (isToolResult(resolved)) {
      return resolved;
    }
    const runtime = await this.ensureRuntime(resolved, toolConfig);
    if (isToolResult(runtime)) {
      return runtime;
    }
    const actions = Array.isArray(args.actions) ? args.actions : [];
    const results: Record<string, unknown>[] = [];

    for (const rawAction of actions) {
      const action = asObject(rawAction);
      const type = asTrimmedString(action?.type);
      if (!action || !type) {
        return handleErrorResult(
          BROWSER_SESSION_FAMILY,
          "browser_session.invalid_action",
          "Each browser session action must be an object with a type.",
          false,
          undefined,
          "resume",
        );
      }
      switch (type as BrowserSessionActionType) {
        case "navigate": {
          const urlError = validateUrl(action.url, toolConfig);
          if (urlError) return urlError;
          await runtime.page.goto(action.url as string, {
            timeout: toolConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            waitUntil: "networkidle",
          });
          results.push({
            type,
            description: `Navigated to ${action.url as string}.`,
          });
          break;
        }
        case "click": {
          const selector = asTrimmedString(action.selector);
          if (!selector) {
            return handleErrorResult(
              BROWSER_SESSION_FAMILY,
              "browser_session.invalid_action",
              "click actions require selector",
              false,
              undefined,
              "resume",
            );
          }
          await runtime.page.click(selector);
          results.push({
            type,
            description: `Clicked ${selector}.`,
          });
          break;
        }
        case "type": {
          const selector = asTrimmedString(action.selector);
          const text = asTrimmedString(action.text);
          if (!selector || text === undefined) {
            return handleErrorResult(
              BROWSER_SESSION_FAMILY,
              "browser_session.invalid_action",
              "type actions require selector and text",
              false,
              undefined,
              "resume",
            );
          }
          await runtime.page.fill(selector, text);
          results.push({
            type,
            description: `Typed into ${selector}.`,
          });
          break;
        }
        case "scroll": {
          const x = asFiniteNumber(action.x) ?? 0;
          const y = asFiniteNumber(action.y) ?? 0;
          await runtime.page.mouse.wheel(x, y);
          results.push({
            type,
            description: `Scrolled by (${x}, ${y}).`,
          });
          break;
        }
        case "waitForSelector": {
          const selector = asTrimmedString(action.selector);
          if (!selector) {
            return handleErrorResult(
              BROWSER_SESSION_FAMILY,
              "browser_session.invalid_action",
              "waitForSelector actions require selector",
              false,
              undefined,
              "resume",
            );
          }
          const waitMs = asFiniteNumber(action.waitMs) ?? 5_000;
          await runtime.page.waitForSelector(selector, { timeout: waitMs });
          results.push({
            type,
            description: `Observed selector ${selector}.`,
          });
          break;
        }
        case "upload": {
          const selector = asTrimmedString(action.selector);
          const singlePath = asTrimmedString(action.path);
          const manyPaths = Array.isArray(action.paths)
            ? action.paths.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
            : [];
          const uploadPaths = singlePath ? [singlePath] : manyPaths;
          if (!selector || uploadPaths.length === 0) {
            return handleErrorResult(
              BROWSER_SESSION_FAMILY,
              "browser_session.invalid_action",
              "upload actions require selector and path/paths",
              false,
              undefined,
              "resume",
            );
          }
          if (typeof runtime.page.setInputFiles !== "function") {
            return handleErrorResult(
              BROWSER_SESSION_FAMILY,
              "browser_session.upload_unavailable",
              "Browser runtime does not support upload actions",
              false,
              undefined,
              "resume",
              "environment_unavailable",
            );
          }
          const uploadIdempotencyKey = asTrimmedString(action.idempotencyKey);
          const uploadLabel =
            asTrimmedString(action.label) ??
            `upload-${results.length + 1}`;
          const existingTransfer = uploadIdempotencyKey
            ? this.findTransferByIdempotencyKey(resolved, uploadIdempotencyKey)
            : undefined;
          const uploadSpecMatches = (transfer: BrowserSessionTransfer): boolean =>
            transfer.kind === "upload" &&
            transfer.selector === selector &&
            transfer.sourcePath === uploadPaths.join("\n");
          if (existingTransfer) {
            if (uploadSpecMatches(existingTransfer)) {
              results.push({
                type,
                description: `Reused upload handle ${existingTransfer.transferId}.`,
                transferId: existingTransfer.transferId,
                reused: true,
                state: existingTransfer.state,
              });
              break;
            }
            return handleErrorResult(
              BROWSER_SESSION_FAMILY,
              "browser_session.idempotency_conflict",
              "A browser transfer already exists for that idempotencyKey.",
              false,
              { transferId: existingTransfer.transferId, state: existingTransfer.state },
              "resume",
            );
          }
          const transferId = `transfer_${randomUUID().slice(0, 8)}`;
          const sourcePath = uploadPaths.join("\n");
          await this.upsertTransfer(resolved, {
            transferId,
            sessionId: resolved.sessionId,
            kind: "upload",
            state: "in_progress",
            createdAt: this.now(),
            updatedAt: this.now(),
            label: uploadLabel,
            ...(uploadIdempotencyKey ? { idempotencyKey: uploadIdempotencyKey } : {}),
            selector,
            sourcePath,
          });
          try {
            await runtime.page.setInputFiles(
              selector,
              uploadPaths.length === 1 ? uploadPaths[0] : uploadPaths,
            );
            await this.recordArtifact(resolved, {
              kind: "upload",
              path: uploadPaths[0],
              label: uploadLabel,
            });
            const completedTransfer = await this.upsertTransfer(resolved, {
              transferId,
              sessionId: resolved.sessionId,
              kind: "upload",
              state: "completed",
              createdAt: this.now(),
              updatedAt: this.now(),
              completedAt: this.now(),
              label: uploadLabel,
              ...(uploadIdempotencyKey ? { idempotencyKey: uploadIdempotencyKey } : {}),
              selector,
              sourcePath,
              artifactPath: uploadPaths[0],
            });
            results.push({
              type,
              description: `Uploaded ${uploadPaths.length} file(s) into ${selector}.`,
              transferId: completedTransfer.transferId,
              artifactPath: uploadPaths[0],
            });
          } catch (error) {
            await this.upsertTransfer(resolved, {
              transferId,
              sessionId: resolved.sessionId,
              kind: "upload",
              state: "failed",
              createdAt: this.now(),
              updatedAt: this.now(),
              label: uploadLabel,
              ...(uploadIdempotencyKey ? { idempotencyKey: uploadIdempotencyKey } : {}),
              selector,
              sourcePath,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
          break;
        }
        case "screenshot": {
          const artifactLabel = asTrimmedString(action.label) ?? `capture-${results.length + 1}`;
          const artifactPath = join(
            resolved.artifactsDir,
            `${sanitizeFilename(artifactLabel)}.png`,
          );
          const fullPage = action.fullPage === true;
          await mkdir(resolved.artifactsDir, { recursive: true });
          await runtime.page.screenshot({ path: artifactPath, fullPage });
          await this.recordArtifact(resolved, {
            kind: "screenshot",
            path: artifactPath,
            label: artifactLabel,
          });
          results.push({
            type,
            description: `Captured screenshot ${artifactLabel}.`,
            artifactPath,
          });
          break;
        }
        case "exportPdf": {
          const artifactLabel = asTrimmedString(action.label) ?? `pdf-${results.length + 1}`;
          const artifactPath = join(
            resolved.artifactsDir,
            `${sanitizeFilename(artifactLabel)}.pdf`,
          );
          const landscape = action.landscape === true;
          const margin = asTrimmedString(action.margin);
          const pdfOptions: Record<string, unknown> = {
            landscape,
            path: artifactPath,
          };
          if (margin) {
            pdfOptions.margin = {
              top: margin,
              right: margin,
              bottom: margin,
              left: margin,
            };
          }
          await mkdir(resolved.artifactsDir, { recursive: true });
          await runtime.page.pdf(pdfOptions);
          await this.recordArtifact(resolved, {
            kind: "pdf",
            path: artifactPath,
            label: artifactLabel,
          });
          results.push({
            type,
            description: `Exported PDF ${artifactLabel}.`,
            artifactPath,
          });
          break;
        }
        default:
          return handleErrorResult(
            BROWSER_SESSION_FAMILY,
            "browser_session.invalid_action",
            `Unsupported browser session action: ${type}`,
            false,
            undefined,
            "resume",
          );
      }
      resolved.lastActionAt = this.now();
      await this.updateRecordFromPage(resolved, runtime.page);
      await this.persist();
    }

    await this.updateRecordFromPage(resolved, runtime.page);
    await this.persist();
    return handleOkResult(buildSessionResponse(resolved, {
      resumed: true,
      actionResults: results,
    }));
  }

  async stopSession(args: Record<string, unknown>): Promise<ToolResult> {
    const resolved = await this.resolveRecord(args);
    if (isToolResult(resolved)) {
      return resolved;
    }
    const runtime = this.runtimes.get(resolved.sessionId);
    if (runtime) {
      await runtime.context.close();
      this.runtimes.delete(resolved.sessionId);
    }
    resolved.state = "stopped";
    resolved.updatedAt = this.now();
    await this.persist();
    return handleOkResult(buildSessionResponse(resolved, {
      stopped: true,
    }));
  }

  async listArtifacts(args: Record<string, unknown>): Promise<ToolResult> {
    const resolved = await this.resolveRecord(args);
    if (isToolResult(resolved)) {
      return resolved;
    }
    return handleOkResult({
      sessionId: resolved.sessionId,
      ...(resolved.label ? { label: resolved.label } : {}),
      artifacts: resolved.artifacts,
    });
  }

  async listTransfers(args: Record<string, unknown>): Promise<ToolResult> {
    const resolved = await this.resolveRecord(args);
    if (isToolResult(resolved)) {
      return resolved;
    }
    return handleOkResult({
      sessionId: resolved.sessionId,
      ...(resolved.label ? { label: resolved.label } : {}),
      transfers: resolved.transfers.map((transfer) => buildTransferResponse(transfer)),
    });
  }

  async getTransferStatus(args: Record<string, unknown>): Promise<ToolResult> {
    const resolved = await this.resolveTransfer(args);
    if (isToolResult(resolved)) {
      return resolved;
    }
    return handleOkResult(buildTransferResponse(resolved.transfer));
  }

  async cancelTransfer(args: Record<string, unknown>): Promise<ToolResult> {
    const resolved = await this.resolveTransfer(args);
    if (isToolResult(resolved)) {
      return resolved;
    }
    const { record, transfer } = resolved;
    if (
      transfer.state === "completed" ||
      transfer.state === "failed" ||
      transfer.state === "cancelled"
    ) {
      return handleOkResult(buildTransferResponse(transfer, { cancelled: false }));
    }
    const cancel = this.activeTransferCancels.get(transfer.transferId);
    if (cancel) {
      try {
        await cancel();
      } catch (error) {
        return handleErrorResult(
          BROWSER_SESSION_FAMILY,
          "browser_session.transfer_cancel_failed",
          error instanceof Error ? error.message : String(error),
          true,
          { transferId: transfer.transferId },
          "stop",
          "stop_failed",
        );
      } finally {
        this.activeTransferCancels.delete(transfer.transferId);
      }
    }
    const updated = await this.upsertTransfer(record, {
      ...transfer,
      state: "cancelled",
      cancelledAt: this.now(),
      error: undefined,
    });
    return handleOkResult(buildTransferResponse(updated, { cancelled: true }));
  }

  async closeAll(): Promise<void> {
    for (const runtime of this.runtimes.values()) {
      await runtime.context.close().catch(() => undefined);
    }
    this.runtimes.clear();
    this.activeTransferCancels.clear();
  }

  async resetForTesting(): Promise<void> {
    await this.closeAll();
    this.records.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    await rm(this.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  resetForTestingSync(): void {
    this.records.clear();
    this.runtimes.clear();
    this.activeTransferCancels.clear();
    this.loaded = false;
    this.persistChain = Promise.resolve();
    rmSync(this.rootDir, { recursive: true, force: true });
  }
}

const defaultBrowserSessionManager = new BrowserSessionManager();

function createBrowserSessionStartTool(
  config: BrowserToolConfig,
  logger: Logger,
  manager: BrowserSessionManager,
): Tool {
  return {
    name: "system.browserSessionStart",
    description:
      "Start or reattach to a durable browser session handle. " +
      "Returns a stable sessionId, current page state, and artifact directories. " +
      "Use label or idempotencyKey to avoid duplicate sessions.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Initial URL to open." },
        width: { type: "number", description: "Viewport width (default: 1280)." },
        height: { type: "number", description: "Viewport height (default: 720)." },
        label: {
          type: "string",
          description: "Optional reusable session handle label.",
        },
        idempotencyKey: {
          type: "string",
          description: "Optional idempotency key for deduplicating repeated start requests.",
        },
        resourceEnvelope: {
          type: "object",
          description:
            "Optional resource budget contract: cpu, memoryMb, diskMb, network, wallClockMs, sandboxAffinity, environmentClass, enforcement.",
        },
      },
      required: ["url"],
    },
    async execute(args): Promise<ToolResult> {
      logger.debug("system.browserSessionStart");
      return manager.startSession(args, config);
    },
  };
}

function createBrowserSessionStatusTool(
  config: BrowserToolConfig,
  logger: Logger,
  manager: BrowserSessionManager,
): Tool {
  return {
    name: "system.browserSessionStatus",
    description:
      "Inspect a durable browser session handle. " +
      "Returns current URL, title, state, and recent artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Browser sessionId from browserSessionStart." },
        label: { type: "string", description: "Session handle label from browserSessionStart." },
        idempotencyKey: {
          type: "string",
          description: "Idempotency key from browserSessionStart.",
        },
      },
      required: [],
    },
    async execute(args): Promise<ToolResult> {
      logger.debug("system.browserSessionStatus");
      return manager.getStatus(args, config);
    },
  };
}

function createBrowserSessionResumeTool(
  config: BrowserToolConfig,
  logger: Logger,
  manager: BrowserSessionManager,
): Tool {
  return {
    name: "system.browserSessionResume",
    description:
      "Resume a durable browser session with an ordered list of actions. " +
      "Supports navigate, click, type, scroll, waitForSelector, upload, screenshot, and exportPdf.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Browser sessionId from browserSessionStart." },
        label: { type: "string", description: "Session handle label from browserSessionStart." },
        idempotencyKey: {
          type: "string",
          description: "Idempotency key from browserSessionStart.",
        },
        actions: {
          type: "array",
          description: "Ordered action list to apply to the session.",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "navigate",
                  "click",
                  "type",
                  "scroll",
                  "waitForSelector",
                  "upload",
                  "screenshot",
                  "exportPdf",
                ],
              },
              url: { type: "string" },
              selector: { type: "string" },
              text: { type: "string" },
              path: { type: "string" },
              paths: {
                type: "array",
                items: { type: "string" },
              },
              x: { type: "number" },
              y: { type: "number" },
              waitMs: { type: "number" },
              fullPage: { type: "boolean" },
              landscape: { type: "boolean" },
              margin: { type: "string" },
              label: { type: "string" },
              idempotencyKey: { type: "string" },
            },
            required: ["type"],
          },
        },
      },
      required: [],
    },
    async execute(args): Promise<ToolResult> {
      logger.debug("system.browserSessionResume");
      return manager.resumeSession(args, config);
    },
  };
}

function createBrowserSessionStopTool(
  logger: Logger,
  manager: BrowserSessionManager,
): Tool {
  return {
    name: "system.browserSessionStop",
    description:
      "Stop a durable browser session and release its runtime resources. " +
      "Artifacts remain available after the session stops.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Browser sessionId from browserSessionStart." },
        label: { type: "string", description: "Session handle label from browserSessionStart." },
        idempotencyKey: {
          type: "string",
          description: "Idempotency key from browserSessionStart.",
        },
      },
      required: [],
    },
    async execute(args): Promise<ToolResult> {
      logger.debug("system.browserSessionStop");
      return manager.stopSession(args);
    },
  };
}

function createBrowserSessionArtifactsTool(
  logger: Logger,
  manager: BrowserSessionManager,
): Tool {
  return {
    name: "system.browserSessionArtifacts",
    description:
      "List artifacts captured by a durable browser session, including downloads, screenshots, and PDFs.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Browser sessionId from browserSessionStart." },
        label: { type: "string", description: "Session handle label from browserSessionStart." },
        idempotencyKey: {
          type: "string",
          description: "Idempotency key from browserSessionStart.",
        },
      },
      required: [],
    },
    async execute(args): Promise<ToolResult> {
      logger.debug("system.browserSessionArtifacts");
      return manager.listArtifacts(args);
    },
  };
}

function createBrowserSessionTransfersTool(
  logger: Logger,
  manager: BrowserSessionManager,
): Tool {
  return {
    name: "system.browserSessionTransfers",
    description:
      "List durable browser transfer handles for a session, including download and upload progress, completion, failure, and cancellation state.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Browser sessionId from browserSessionStart." },
        label: { type: "string", description: "Session handle label from browserSessionStart." },
        idempotencyKey: {
          type: "string",
          description: "Idempotency key from browserSessionStart.",
        },
      },
      required: [],
    },
    async execute(args): Promise<ToolResult> {
      logger.debug("system.browserSessionTransfers");
      return manager.listTransfers(args);
    },
  };
}

function createBrowserTransferStatusTool(
  logger: Logger,
  manager: BrowserSessionManager,
): Tool {
  return {
    name: "system.browserTransferStatus",
    description:
      "Inspect a durable browser download/upload transfer handle by transferId or by session + label/idempotencyKey.",
    inputSchema: {
      type: "object",
      properties: {
        transferId: { type: "string" },
        sessionId: { type: "string" },
        label: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      required: [],
    },
    async execute(args): Promise<ToolResult> {
      logger.debug("system.browserTransferStatus");
      return manager.getTransferStatus(args);
    },
  };
}

function createBrowserTransferCancelTool(
  logger: Logger,
  manager: BrowserSessionManager,
): Tool {
  return {
    name: "system.browserTransferCancel",
    description:
      "Cancel a durable browser transfer handle when the underlying runtime still supports cancellation. Terminal transfers remain idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        transferId: { type: "string" },
        sessionId: { type: "string" },
        label: { type: "string" },
        idempotencyKey: { type: "string" },
      },
      required: [],
    },
    async execute(args): Promise<ToolResult> {
      logger.debug("system.browserTransferCancel");
      return manager.cancelTransfer(args);
    },
  };
}

export function createBrowserSessionTools(
  config: BrowserToolConfig,
  logger: Logger = silentLogger,
  manager: BrowserSessionManager = defaultBrowserSessionManager,
): Tool[] {
  return [
    createBrowserSessionStartTool(config, logger, manager),
    createBrowserSessionStatusTool(config, logger, manager),
    createBrowserSessionResumeTool(config, logger, manager),
    createBrowserSessionStopTool(logger, manager),
    createBrowserSessionArtifactsTool(logger, manager),
    createBrowserSessionTransfersTool(logger, manager),
    createBrowserTransferStatusTool(logger, manager),
    createBrowserTransferCancelTool(logger, manager),
  ];
}

export async function closeBrowserSessions(): Promise<void> {
  await defaultBrowserSessionManager.closeAll();
}

export async function resetBrowserSessionsForTesting(): Promise<void> {
  await defaultBrowserSessionManager.resetForTesting();
}

export function resetBrowserSessionsForTestingSync(): void {
  defaultBrowserSessionManager.resetForTestingSync();
}
