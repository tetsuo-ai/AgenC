/**
 * Media processing pipeline for the AgenC Gateway.
 *
 * Intercepts inbound `MessageAttachment` objects and enriches them with text
 * representations — voice messages are transcribed, images are described.
 * Manages temp file lifecycle, size validation, and pluggable provider
 * interfaces. Ships with noop providers only (no Whisper/TTS integration).
 *
 * Scope limitations (deferred to future work):
 * - Document extraction (PDF, DOCX) — returns unsupported MIME type
 * - Per-channel quota enforcement
 *
 * @module
 */

import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { readdir, lstat, unlink } from "node:fs/promises";
import type { GatewayMessage, MessageAttachment } from "./message.js";
import { validateAttachment } from "./message.js";
import type { ValidationResult } from "../utils/validation.js";
import { withTimeout } from "../llm/timeout.js";

// ============================================================================
// Logger (inline to avoid transitive @agenc/sdk runtime dependency)
// ============================================================================

/**
 * Minimal logger interface matching the SDK Logger shape.
 *
 * Defined inline rather than importing from `../utils/logger.js` because that
 * module re-exports from `@agenc/sdk`, which is not resolvable in the test
 * environment (Vite cannot resolve the package entry). Once `@agenc/sdk` is
 * available as a proper workspace dependency, replace with:
 *
 *   import type { Logger } from '../utils/logger.js';
 *   import { silentLogger } from '../utils/logger.js';
 */
export interface MediaLogger {
  debug(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
}

const silentMediaLogger: MediaLogger = {
  debug() {},
  warn() {},
};

// ============================================================================
// Constants
// ============================================================================

/** Default maximum attachment size: 25 MB. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Default temp directory for media processing. */
export const DEFAULT_TEMP_DIR = join(tmpdir(), "agenc-media");

/** Default temp file TTL: 1 hour. */
export const DEFAULT_TEMP_FILE_TTL_MS = 60 * 60 * 1000;

/** Default processing timeout: 30 seconds. */
export const DEFAULT_PROCESSING_TIMEOUT_MS = 30 * 1000;

// ============================================================================
// Configuration
// ============================================================================

/** Configuration for the media processing pipeline. */
export interface MediaPipelineConfig {
  readonly maxAttachmentBytes: number;
  readonly tempDir: string;
  readonly tempFileTtlMs: number;
  readonly processingTimeoutMs: number;
  readonly autoTranscribeVoice: boolean;
  readonly logger?: MediaLogger;
}

// ============================================================================
// Result types
// ============================================================================

/** Result from processing a single attachment. */
export interface MediaProcessingResult {
  readonly success: boolean;
  readonly text?: string;
  readonly error?: string;
  readonly mimeType: string;
  readonly processingTimeMs: number;
}

// ============================================================================
// Provider interfaces
// ============================================================================

/** Provider that converts audio data to text. */
export interface TranscriptionProvider {
  transcribe(
    data: Uint8Array,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<string>;
}

/** Provider that converts image data to a text description. */
export interface ImageDescriptionProvider {
  describe(
    data: Uint8Array,
    mimeType: string,
    signal: AbortSignal,
  ): Promise<string>;
}

// ============================================================================
// Noop providers
// ============================================================================

/** Placeholder transcription provider that returns a stub string. */
export class NoopTranscriptionProvider implements TranscriptionProvider {
  async transcribe(
    _data: Uint8Array,
    mimeType: string,
    _signal: AbortSignal,
  ): Promise<string> {
    return `[Transcription placeholder for ${mimeType} audio]`;
  }
}

/** Placeholder image description provider that returns a stub string. */
export class NoopImageDescriptionProvider implements ImageDescriptionProvider {
  async describe(
    _data: Uint8Array,
    mimeType: string,
    _signal: AbortSignal,
  ): Promise<string> {
    return `[Description placeholder for ${mimeType} image]`;
  }
}

// ============================================================================
// MIME helpers
// ============================================================================

function baseMime(mimeType: string): string {
  const idx = mimeType.indexOf(";");
  return idx >= 0 ? mimeType.slice(0, idx).trim() : mimeType;
}

export function isAudioMime(mimeType: string): boolean {
  return baseMime(mimeType).startsWith("audio/");
}

export function isImageMime(mimeType: string): boolean {
  return baseMime(mimeType).startsWith("image/");
}

// ============================================================================
// Default config factory
// ============================================================================

/** Create a default media pipeline configuration. */
export function defaultMediaPipelineConfig(
  overrides?: Partial<MediaPipelineConfig>,
): MediaPipelineConfig {
  return {
    maxAttachmentBytes: DEFAULT_MAX_ATTACHMENT_BYTES,
    tempDir: DEFAULT_TEMP_DIR,
    tempFileTtlMs: DEFAULT_TEMP_FILE_TTL_MS,
    processingTimeoutMs: DEFAULT_PROCESSING_TIMEOUT_MS,
    autoTranscribeVoice: true,
    ...overrides,
  };
}

// ============================================================================
// MediaPipeline
// ============================================================================

/** Media processing pipeline that enriches inbound messages with text from attachments. */
export class MediaPipeline {
  private readonly config: MediaPipelineConfig;
  private readonly logger: MediaLogger;
  private transcriber: TranscriptionProvider;
  private imageDescriber: ImageDescriptionProvider;

  constructor(config: MediaPipelineConfig) {
    this.config = config;
    this.logger = config.logger ?? silentMediaLogger;
    this.transcriber = new NoopTranscriptionProvider();
    this.imageDescriber = new NoopImageDescriptionProvider();
  }

  /** Replace the transcription provider. */
  setTranscriptionProvider(provider: TranscriptionProvider): void {
    this.transcriber = provider;
  }

  /** Replace the image description provider. */
  setImageProvider(provider: ImageDescriptionProvider): void {
    this.imageDescriber = provider;
  }

  /** Validate an attachment against pipeline size constraints. */
  validate(attachment: MessageAttachment): ValidationResult {
    const result = validateAttachment(
      attachment,
      this.config.maxAttachmentBytes,
    );
    if (!result.valid) return result;

    // Check actual data size when sizeBytes is absent
    if (attachment.data && attachment.sizeBytes === undefined) {
      if (attachment.data.byteLength > this.config.maxAttachmentBytes) {
        return {
          valid: false,
          errors: [
            `data byteLength (${attachment.data.byteLength}) exceeds maximum (${this.config.maxAttachmentBytes})`,
          ],
        };
      }
    }

    return result;
  }

  /** Process a single attachment, returning a text representation. */
  async process(attachment: MessageAttachment): Promise<MediaProcessingResult> {
    const start = Date.now();
    const { mimeType } = attachment;

    if (!attachment.data) {
      return {
        success: false,
        error: "Attachment has no inline data",
        mimeType,
        processingTimeMs: Date.now() - start,
      };
    }

    const validation = this.validate(attachment);
    if (!validation.valid) {
      return {
        success: false,
        error: validation.errors.join("; "),
        mimeType,
        processingTimeMs: Date.now() - start,
      };
    }

    if (!isAudioMime(mimeType) && !isImageMime(mimeType)) {
      return {
        success: false,
        error: `Unsupported MIME type: ${mimeType}`,
        mimeType,
        processingTimeMs: Date.now() - start,
      };
    }

    try {
      const text = await withTimeout(
        (signal) => {
          if (isAudioMime(mimeType)) {
            return this.transcriber.transcribe(
              attachment.data!,
              mimeType,
              signal,
            );
          }
          return this.imageDescriber.describe(
            attachment.data!,
            mimeType,
            signal,
          );
        },
        this.config.processingTimeoutMs,
        "MediaPipeline",
      );

      return {
        success: true,
        text,
        mimeType,
        processingTimeMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Media processing failed for ${mimeType}: ${error}`);
      return {
        success: false,
        error,
        mimeType,
        processingTimeMs: Date.now() - start,
      };
    }
  }

  /**
   * Enrich a message by processing its attachments and injecting text.
   *
   * Attachments are processed sequentially to keep ordering deterministic
   * and simplify error handling for the noop-provider scope. Switch to
   * `Promise.all` with a concurrency limiter when real providers are added.
   */
  async enrichMessage(message: GatewayMessage): Promise<GatewayMessage> {
    if (!message.attachments || message.attachments.length === 0) {
      return message;
    }

    const enrichments: string[] = [];

    for (const attachment of message.attachments) {
      if (!attachment.data) continue;

      if (
        isAudioMime(attachment.mimeType) &&
        !this.config.autoTranscribeVoice
      ) {
        continue;
      }

      const result = await this.process(attachment);
      if (!result.success || !result.text) continue;

      if (isAudioMime(attachment.mimeType)) {
        enrichments.push(`[Voice transcription: ${result.text}]`);
      } else if (isImageMime(attachment.mimeType)) {
        enrichments.push(`[Image description: ${result.text}]`);
      }
    }

    if (enrichments.length === 0) {
      return message;
    }

    const enrichmentBlock = enrichments.join("\n");
    const enrichedContent =
      message.content === ""
        ? enrichmentBlock
        : `${message.content}\n\n${enrichmentBlock}`;

    return { ...message, content: enrichedContent };
  }

  /**
   * Remove expired temp files from the configured temp directory.
   * Returns the number of files removed.
   *
   * Only processes regular files in the top-level directory — subdirectories
   * and their contents are not traversed.
   */
  async cleanup(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    const resolvedTempDir = resolve(this.config.tempDir);

    let entries: string[];
    try {
      entries = await readdir(this.config.tempDir);
    } catch {
      return 0;
    }

    for (const entry of entries) {
      try {
        const filePath = join(this.config.tempDir, entry);
        const resolvedPath = resolve(filePath);
        if (!resolvedPath.startsWith(resolvedTempDir + "/")) continue;

        const info = await lstat(filePath);
        if (!info.isFile()) continue;

        if (now - info.mtimeMs >= this.config.tempFileTtlMs) {
          await unlink(filePath);
          removed++;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`Cleanup skipped ${entry}: ${msg}`);
      }
    }

    return removed;
  }
}
