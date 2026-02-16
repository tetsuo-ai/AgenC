/**
 * Heartbeat scheduler for @agenc/runtime.
 *
 * Runs registered actions on a configurable interval with error isolation,
 * timeout enforcement, and a "quiet heartbeat" contract — nothing is posted
 * to channels unless an action has output worth reporting.
 *
 * @module
 */

import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

// ============================================================================
// Error classes
// ============================================================================

export class HeartbeatStateError extends RuntimeError {
  constructor(message: string) {
    super(message, RuntimeErrorCodes.HEARTBEAT_STATE_ERROR);
    this.name = 'HeartbeatStateError';
  }
}

export class HeartbeatActionError extends RuntimeError {
  public readonly actionName: string;
  public readonly cause: unknown;

  constructor(actionName: string, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Heartbeat action "${actionName}" failed: ${msg}`, RuntimeErrorCodes.HEARTBEAT_ACTION_FAILED);
    this.name = 'HeartbeatActionError';
    this.actionName = actionName;
    this.cause = cause;
  }
}

export class HeartbeatTimeoutError extends RuntimeError {
  public readonly actionName: string;
  public readonly timeoutMs: number;

  constructor(actionName: string, timeoutMs: number) {
    super(
      `Heartbeat action "${actionName}" timed out after ${timeoutMs}ms`,
      RuntimeErrorCodes.HEARTBEAT_TIMEOUT,
    );
    this.name = 'HeartbeatTimeoutError';
    this.actionName = actionName;
    this.timeoutMs = timeoutMs;
  }
}

// ============================================================================
// Types
// ============================================================================

export interface HeartbeatConfig {
  readonly enabled: boolean;
  /** Default interval between heartbeats in ms (default: 1_800_000 = 30min). */
  readonly intervalMs: number;
  /** Maximum execution time per action before timeout in ms (default: 60_000). */
  readonly timeoutMs: number;
  /** Active hours restriction — heartbeats only run within this window. */
  readonly activeHours?: {
    readonly start: number;
    readonly end: number;
    readonly timezone?: string;
  };
  /** Target channel names for heartbeat output. */
  readonly targetChannels?: readonly string[];
}

export interface HeartbeatAction {
  readonly name: string;
  readonly enabled: boolean;
  execute(context: HeartbeatContext): Promise<HeartbeatResult>;
}

export interface HeartbeatContext {
  readonly logger: Logger;
  sendToChannels(content: string): Promise<void>;
}

export interface HeartbeatResult {
  readonly hasOutput: boolean;
  readonly output?: string;
  readonly quiet: boolean;
}

export interface HeartbeatRunSummary {
  readonly ranAt: number;
  readonly actionsRun: number;
  readonly actionsFailed: number;
  readonly messagesPosted: number;
}

export interface HeartbeatSchedulerOptions {
  readonly logger?: Logger;
  readonly sendToChannels?: (content: string) => Promise<void>;
}

// ============================================================================
// Default config
// ============================================================================

const DEFAULT_INTERVAL_MS = 1_800_000; // 30 minutes
const DEFAULT_TIMEOUT_MS = 60_000;     // 1 minute

export const defaultHeartbeatConfig: HeartbeatConfig = {
  enabled: true,
  intervalMs: DEFAULT_INTERVAL_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

// ============================================================================
// HeartbeatScheduler
// ============================================================================

export class HeartbeatScheduler {
  private _state: 'stopped' | 'running' = 'stopped';
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly actions: HeartbeatAction[] = [];
  private _lastRunAt: number | null = null;
  private _nextRunAt: number | null = null;
  private readonly config: HeartbeatConfig;
  private readonly logger: Logger;
  private readonly _sendToChannels: (content: string) => Promise<void>;

  constructor(config: HeartbeatConfig, options?: HeartbeatSchedulerOptions) {
    this.config = config;
    this.logger = options?.logger ?? silentLogger;
    this._sendToChannels = options?.sendToChannels ?? (async () => {});
  }

  // --------------------------------------------------------------------------
  // Accessors
  // --------------------------------------------------------------------------

  get running(): boolean {
    return this._state === 'running';
  }

  get lastRunAt(): number | null {
    return this._lastRunAt;
  }

  get nextRunAt(): number | null {
    return this._nextRunAt;
  }

  // --------------------------------------------------------------------------
  // Action registration
  // --------------------------------------------------------------------------

  registerAction(action: HeartbeatAction): void {
    if (this._state === 'running') {
      throw new HeartbeatStateError('Cannot register actions while scheduler is running');
    }
    this.actions.push(action);
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  start(): void {
    if (this._state === 'running') return;
    if (!this.config.enabled) {
      this.logger.info('Heartbeat scheduler is disabled — not starting');
      return;
    }

    this._state = 'running';
    this._nextRunAt = Date.now() + this.config.intervalMs;

    this.intervalHandle = setInterval(() => {
      void this.tick();
    }, this.config.intervalMs);

    this.logger.info(
      `Heartbeat scheduler started (interval=${this.config.intervalMs}ms, actions=${this.actions.length})`,
    );
  }

  stop(): void {
    if (this._state === 'stopped') return;

    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    this._state = 'stopped';
    this._nextRunAt = null;
    this.logger.info('Heartbeat scheduler stopped');
  }

  // --------------------------------------------------------------------------
  // Execution
  // --------------------------------------------------------------------------

  async runOnce(): Promise<HeartbeatRunSummary> {
    const now = Date.now();

    if (!this.isWithinActiveHours()) {
      this.logger.debug('Heartbeat skipped — outside active hours');
      return { ranAt: now, actionsRun: 0, actionsFailed: 0, messagesPosted: 0 };
    }

    const enabledActions = this.actions.filter((a) => a.enabled);
    let actionsFailed = 0;
    let messagesPosted = 0;

    const context: HeartbeatContext = {
      logger: this.logger,
      sendToChannels: this._sendToChannels,
    };

    for (const action of enabledActions) {
      try {
        const result = await this.executeWithTimeout(action, context);

        if (!result.quiet && result.hasOutput && result.output) {
          await this._sendToChannels(result.output);
          messagesPosted++;
        }
      } catch (err) {
        actionsFailed++;
        this.logger.error(`Heartbeat action "${action.name}" failed:`, err);
      }
    }

    this._lastRunAt = now;
    if (this._state === 'running') {
      this._nextRunAt = now + this.config.intervalMs;
    }

    this.logger.debug(
      `Heartbeat cycle complete: ${enabledActions.length} run, ${actionsFailed} failed, ${messagesPosted} posted`,
    );

    return {
      ranAt: now,
      actionsRun: enabledActions.length,
      actionsFailed,
      messagesPosted,
    };
  }

  // --------------------------------------------------------------------------
  // Active hours
  // --------------------------------------------------------------------------

  isWithinActiveHours(now?: Date): boolean {
    if (!this.config.activeHours) return true;

    const { start, end } = this.config.activeHours;
    const date = now ?? new Date();
    const hour = date.getHours();

    if (start <= end) {
      // Normal range, e.g. 8-22
      return hour >= start && hour < end;
    }
    // Wrap-around range, e.g. 22-6
    return hour >= start || hour < end;
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error('Heartbeat tick failed:', err);
    }
  }

  private async executeWithTimeout(
    action: HeartbeatAction,
    context: HeartbeatContext,
  ): Promise<HeartbeatResult> {
    const timeoutMs = this.config.timeoutMs;

    const result = await Promise.race([
      action.execute(context),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => {
          reject(new HeartbeatTimeoutError(action.name, timeoutMs));
        }, timeoutMs);
      }),
    ]);

    return result;
  }
}
