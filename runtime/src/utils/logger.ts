/**
 * Logger utility for @agenc/runtime
 *
 * Re-exports the shared logger implementation from @agenc/sdk with a
 * runtime-specific default prefix.
 */

import {
  createLogger as sdkCreateLogger,
  type LogLevel,
  type Logger,
} from "@agenc/sdk";

// Re-export types and silentLogger directly — identical to SDK
export { silentLogger } from "@agenc/sdk";
export type { LogLevel, Logger } from "@agenc/sdk";

/**
 * Create a logger instance with the specified minimum level
 *
 * @param minLevel - Minimum log level to output (default: 'info')
 * @param prefix - Prefix for log messages (default: '[AgenC Runtime]')
 * @returns Logger instance
 *
 * @example
 * ```typescript
 * const logger = createLogger('debug', '[MyAgent]');
 * logger.info('Agent started'); // 2026-01-21T12:00:00.000Z INFO  [MyAgent] Agent started
 * logger.debug('Debug info');   // 2026-01-21T12:00:00.001Z DEBUG [MyAgent] Debug info
 * ```
 */
export function createLogger(
  minLevel: LogLevel = "info",
  prefix = "[AgenC Runtime]",
): Logger {
  return sdkCreateLogger(minLevel, prefix);
}
