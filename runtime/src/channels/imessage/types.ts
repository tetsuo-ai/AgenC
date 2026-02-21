/**
 * iMessage channel configuration types.
 *
 * @module
 */

export interface IMessageChannelConfig {
  /** Enable the iMessage channel. @default false */
  enabled?: boolean;
  /** Polling interval in ms for checking new messages. @default 5000 */
  pollIntervalMs?: number;
  /** Allow-list of contact identifiers (phone numbers or emails). Empty = all. */
  allowedContacts?: readonly string[];
  /** Max messages to process per poll cycle. @default 10 */
  maxMessagesPerPoll?: number;
}
