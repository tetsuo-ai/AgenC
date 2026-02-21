/**
 * Proactive communicator for autonomous agent messaging.
 *
 * Enables the agent to initiate conversations across channels without
 * being prompted — e.g., alerting on portfolio changes, sharing research
 * findings, or surfacing task opportunities.
 *
 * @module
 */

import type { ChannelPlugin } from "./channel.js";
import { formatForChannel } from "./format.js";
import type { Logger } from "../utils/logger.js";
import { silentLogger } from "../utils/logger.js";

// ============================================================================
// Types
// ============================================================================

export interface ProactiveCommunicatorConfig {
  /** Map of channel name → plugin instance (only active channels). */
  channels: Map<string, ChannelPlugin>;
  /** Default target sessions per channel (channel name → session ID). */
  defaultTargets?: Record<string, string>;
  /** Quiet hours: don't send between these UTC hours. */
  quietHours?: { startHour: number; endHour: number };
  logger?: Logger;
}

// ============================================================================
// ProactiveCommunicator
// ============================================================================

export class ProactiveCommunicator {
  private readonly channels: Map<string, ChannelPlugin>;
  private readonly defaultTargets: Record<string, string>;
  private readonly quietHours?: { startHour: number; endHour: number };
  private readonly logger: Logger;

  constructor(config: ProactiveCommunicatorConfig) {
    this.channels = config.channels;
    this.defaultTargets = config.defaultTargets ?? {};
    this.quietHours = config.quietHours;
    this.logger = config.logger ?? silentLogger;
  }

  /**
   * Broadcast a message to multiple channels using their default targets.
   *
   * @param content - Raw message content (will be formatted per channel)
   * @param channelNames - Specific channels to target (default: all with default targets)
   */
  async broadcast(content: string, channelNames?: string[]): Promise<void> {
    if (this.isQuietTime()) {
      this.logger.info("ProactiveCommunicator: suppressed broadcast during quiet hours");
      return;
    }

    const targets = channelNames ?? Object.keys(this.defaultTargets);

    const results = await Promise.allSettled(
      targets.map(async (name) => {
        const sessionId = this.defaultTargets[name];
        if (!sessionId) {
          this.logger.warn(`ProactiveCommunicator: no default target for channel "${name}"`);
          return;
        }
        await this.sendTo(name, sessionId, content);
      }),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length > 0) {
      this.logger.warn(`ProactiveCommunicator: ${failures.length}/${targets.length} broadcast failures`);
    }
  }

  /**
   * Send a message to a specific channel and session.
   */
  async sendTo(channelName: string, sessionId: string, content: string): Promise<void> {
    if (this.isQuietTime()) return;

    const channel = this.channels.get(channelName);
    if (!channel) {
      this.logger.warn(`ProactiveCommunicator: channel "${channelName}" not found`);
      return;
    }

    if (!channel.isHealthy()) {
      this.logger.warn(`ProactiveCommunicator: channel "${channelName}" unhealthy, skipping`);
      return;
    }

    const formatted = formatForChannel(content, channelName);
    await channel.send({ sessionId, content: formatted });
  }

  /** Check if current UTC hour falls within quiet hours. */
  private isQuietTime(): boolean {
    if (!this.quietHours) return false;
    const hour = new Date().getUTCHours();
    const { startHour, endHour } = this.quietHours;

    if (startHour <= endHour) {
      return hour >= startHour && hour < endHour;
    }
    // Wraps midnight (e.g., 22:00 → 06:00)
    return hour >= startHour || hour < endHour;
  }

  /** Get list of active channel names. */
  getActiveChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  /** Update the channel map (e.g., after hot-adding a channel). */
  setChannel(name: string, plugin: ChannelPlugin): void {
    this.channels.set(name, plugin);
  }

  /** Remove a channel from the communicator. */
  removeChannel(name: string): void {
    this.channels.delete(name);
  }
}
