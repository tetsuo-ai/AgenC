/**
 * Voice-specific error types for STT and TTS operations.
 *
 * @module
 */

import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";

/**
 * Error thrown when speech-to-text transcription fails.
 */
export class VoiceTranscriptionError extends RuntimeError {
  public readonly providerName: string;
  public readonly statusCode?: number;

  constructor(providerName: string, message: string, statusCode?: number) {
    super(
      `${providerName} transcription failed: ${message}`,
      RuntimeErrorCodes.VOICE_TRANSCRIPTION_ERROR,
    );
    this.name = "VoiceTranscriptionError";
    this.providerName = providerName;
    this.statusCode = statusCode;
  }
}

/**
 * Error thrown when text-to-speech synthesis fails.
 */
export class VoiceSynthesisError extends RuntimeError {
  public readonly providerName: string;
  public readonly statusCode?: number;

  constructor(providerName: string, message: string, statusCode?: number) {
    super(
      `${providerName} synthesis failed: ${message}`,
      RuntimeErrorCodes.VOICE_SYNTHESIS_ERROR,
    );
    this.name = "VoiceSynthesisError";
    this.providerName = providerName;
    this.statusCode = statusCode;
  }
}
