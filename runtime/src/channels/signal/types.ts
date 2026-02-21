/**
 * Configuration interface for the Signal channel plugin.
 *
 * Uses signal-cli in JSON-RPC mode via child_process (no npm dependency).
 * Requires signal-cli to be installed and configured on the host.
 *
 * @module
 */

export interface SignalChannelConfig {
  /** Path to the signal-cli binary. @default 'signal-cli' */
  readonly signalCliBin?: string;
  /** The phone number registered with Signal (e.g. '+15551234567'). */
  readonly phoneNumber: string;
  /** Trust mode for incoming messages. @default 'on-first-use' */
  readonly trustMode?: "always" | "on-first-use" | "tofu";
  /** Restrict to specific phone numbers. Empty = all numbers. */
  readonly allowedNumbers?: readonly string[];
  /** Poll interval for checking subprocess health in ms. @default 30000 */
  readonly pollIntervalMs?: number;
}
