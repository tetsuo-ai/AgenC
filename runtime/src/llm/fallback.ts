/**
 * Fallback LLM provider chain.
 *
 * @module
 */

import { LLMProviderError, LLMServerError, LLMTimeoutError } from "./errors.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "./types.js";

export interface FallbackChainConfig {
  providers: LLMProvider[];
  fallbackOnErrors?: Array<"timeout" | "server" | "provider">;
}

/**
 * Provider wrapper that retries against secondary providers when allowed.
 */
export class FallbackLLMProvider implements LLMProvider {
  readonly name: string;

  private readonly providers: LLMProvider[];
  private readonly fallbackErrors: Set<"timeout" | "server" | "provider">;

  constructor(config: FallbackChainConfig) {
    if (!config.providers || config.providers.length === 0) {
      throw new Error("FallbackLLMProvider requires at least one provider");
    }
    this.providers = [...config.providers];
    this.fallbackErrors = new Set(
      config.fallbackOnErrors ?? ["timeout", "server", "provider"],
    );
    this.name = `fallback(${this.providers.map((provider) => provider.name).join(",")})`;
  }

  async chat(
    messages: LLMMessage[],
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    let lastError: Error | undefined;

    for (const provider of this.providers) {
      try {
        const response = await provider.chat(messages, options);
        if (response.finishReason === "error" && response.error) {
          throw response.error;
        }
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!this.shouldFallback(lastError)) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new LLMProviderError(this.name, "All providers failed");
  }

  async chatStream(
    messages: LLMMessage[],
    onChunk: StreamProgressCallback,
    options?: LLMChatOptions,
  ): Promise<LLMResponse> {
    let lastError: Error | undefined;

    for (const provider of this.providers) {
      try {
        const response = await provider.chatStream(messages, onChunk, options);
        if (response.finishReason === "error" && response.error) {
          throw response.error;
        }
        return response;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (!this.shouldFallback(lastError)) {
          throw lastError;
        }
      }
    }

    throw lastError ?? new LLMProviderError(this.name, "All providers failed");
  }

  async healthCheck(): Promise<boolean> {
    for (const provider of this.providers) {
      try {
        if (await provider.healthCheck()) {
          return true;
        }
      } catch {
        // Ignore and continue to next provider.
      }
    }
    return false;
  }

  resetSessionState(sessionId: string): void {
    for (const provider of this.providers) {
      provider.resetSessionState?.(sessionId);
    }
  }

  clearSessionState(): void {
    for (const provider of this.providers) {
      provider.clearSessionState?.();
    }
  }

  private shouldFallback(err: Error): boolean {
    if (err instanceof LLMTimeoutError) {
      return this.fallbackErrors.has("timeout");
    }
    if (err instanceof LLMServerError) {
      return this.fallbackErrors.has("server");
    }
    if (err instanceof LLMProviderError) {
      return this.fallbackErrors.has("provider");
    }
    return false;
  }
}
