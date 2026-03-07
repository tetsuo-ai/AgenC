import type { Logger } from "./logger.js";
import { silentLogger } from "./logger.js";
import { toErrorMessage } from "./async.js";

export interface KeyedAsyncQueueConfig {
  readonly logger?: Logger;
  readonly label?: string;
}

export class KeyedAsyncQueue {
  private readonly logger: Logger;
  private readonly label: string;
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(config: KeyedAsyncQueueConfig = {}) {
    this.logger = config.logger ?? silentLogger;
    this.label = config.label ?? "keyed async queue";
  }

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextChain = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          return await operation();
        } finally {
          release?.();
        }
      });
    this.chains.set(key, gate);
    try {
      return await nextChain;
    } catch (error) {
      this.logger.debug(`${this.label} operation failed`, {
        key,
        error: toErrorMessage(error),
      });
      throw error;
    } finally {
      if (this.chains.get(key) === gate) {
        this.chains.delete(key);
      }
    }
  }
}
