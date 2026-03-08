import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";
import { toErrorMessage } from "../utils/async.js";
import {
  BackgroundRunStore,
  type BackgroundRunWakeEvent,
  type DequeueBackgroundRunWakeEventsResult,
  type EnqueueBackgroundRunWakeEventParams,
} from "./background-run-store.js";

const DEFAULT_WAKE_BATCH_LIMIT = 32;

export interface BackgroundRunWakeBusConfig {
  readonly runStore: BackgroundRunStore;
  readonly onWakeReady: (sessionId: string) => void | Promise<void>;
  readonly logger?: Logger;
  readonly now?: () => number;
  readonly maxBatchSize?: number;
}

export class BackgroundRunWakeBus {
  private readonly runStore: BackgroundRunStore;
  private readonly onWakeReady: (sessionId: string) => void | Promise<void>;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly maxBatchSize: number;
  private readonly sessionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly queuedCounts = new Map<string, number>();
  private readonly nextAvailability = new Map<string, number | undefined>();
  private readonly readyDispatches = new Set<string>();

  constructor(config: BackgroundRunWakeBusConfig) {
    this.runStore = config.runStore;
    this.onWakeReady = config.onWakeReady;
    this.logger = config.logger ?? silentLogger;
    this.now = config.now ?? Date.now;
    this.maxBatchSize = config.maxBatchSize ?? DEFAULT_WAKE_BATCH_LIMIT;
  }

  getQueuedCount(sessionId: string): number {
    return this.queuedCounts.get(sessionId) ?? 0;
  }

  getNextAvailableAt(sessionId: string): number | undefined {
    return this.nextAvailability.get(sessionId);
  }

  async recoverSession(sessionId: string): Promise<void> {
    const queuedCount = await this.runStore.getQueuedWakeEventCount(sessionId);
    this.queuedCounts.set(sessionId, queuedCount);
    await this.armNextWake(sessionId);
  }

  async clearSession(sessionId: string): Promise<void> {
    const timer = this.sessionTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.sessionTimers.delete(sessionId);
    }
    this.readyDispatches.delete(sessionId);
    this.queuedCounts.delete(sessionId);
    this.nextAvailability.delete(sessionId);
  }

  async enqueue(
    params: EnqueueBackgroundRunWakeEventParams,
  ): Promise<BackgroundRunWakeEvent> {
    const event = await this.runStore.enqueueWakeEvent(params);
    const queuedCount = await this.runStore.getQueuedWakeEventCount(params.sessionId);
    this.queuedCounts.set(params.sessionId, queuedCount);
    await this.armNextWake(params.sessionId);
    if (params.dispatchReady !== false && event.availableAt <= this.now()) {
      this.dispatchReady(params.sessionId);
    }
    return event;
  }

  dispatchNow(sessionId: string): void {
    this.dispatchReady(sessionId);
  }

  async drainDueWakeEvents(
    sessionId: string,
  ): Promise<DequeueBackgroundRunWakeEventsResult> {
    const result = await this.runStore.deliverDueWakeEventsToRun({
      sessionId,
      now: this.now(),
      limit: this.maxBatchSize,
    });
    this.queuedCounts.set(sessionId, result.remainingQueuedEvents);
    await this.armNextWake(sessionId);
    return result;
  }

  dispose(): void {
    for (const timer of this.sessionTimers.values()) {
      clearTimeout(timer);
    }
    this.sessionTimers.clear();
    this.readyDispatches.clear();
    this.queuedCounts.clear();
    this.nextAvailability.clear();
  }

  private async armNextWake(sessionId: string): Promise<void> {
    const existing = this.sessionTimers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      this.sessionTimers.delete(sessionId);
    }
    const nextAvailableAt = await this.runStore.getNextWakeAvailability(sessionId);
    this.nextAvailability.set(sessionId, nextAvailableAt);
    if (nextAvailableAt === undefined) {
      return;
    }
    const delayMs = Math.max(0, nextAvailableAt - this.now());
    const timer = setTimeout(() => {
      this.sessionTimers.delete(sessionId);
      this.dispatchReady(sessionId);
    }, delayMs);
    this.sessionTimers.set(sessionId, timer);
  }

  private dispatchReady(sessionId: string): void {
    if (this.readyDispatches.has(sessionId)) {
      return;
    }
    this.readyDispatches.add(sessionId);
    queueMicrotask(() => {
      void Promise.resolve(this.onWakeReady(sessionId))
        .catch((error) => {
          this.logger.debug("Background wake dispatch failed", {
            sessionId,
            error: toErrorMessage(error),
          });
        })
        .finally(() => {
          this.readyDispatches.delete(sessionId);
        });
    });
  }
}
