/**
 * Configuration interface for the Matrix channel plugin.
 *
 * @module
 */

export interface MatrixChannelConfig {
  /** Matrix homeserver URL (e.g. 'https://matrix.org'). */
  readonly homeserverUrl: string;
  /** Access token for the bot account. */
  readonly accessToken: string;
  /** Matrix user ID of the bot (e.g. '@bot:matrix.org'). */
  readonly userId: string;
  /** Restrict to specific room IDs. Empty = all rooms. */
  readonly roomIds?: readonly string[];
  /** Whether to auto-join rooms on invite. @default false */
  readonly autoJoin?: boolean;
  /** Whether to enable E2EE support. @default false (flag reserved for future use). */
  readonly enableE2ee?: boolean;
  /** Maximum attachment size in bytes. @default 25 * 1024 * 1024 (25 MB) */
  readonly maxAttachmentBytes?: number;
}
