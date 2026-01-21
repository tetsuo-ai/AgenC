/**
 * Logger utility for @agenc/runtime
 *
 * Provides a lightweight, dependency-free logging system with configurable
 * log levels and formatted output.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Private - not exported from module
const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  setLevel(level: LogLevel): void;
}

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
export function createLogger(minLevel: LogLevel = 'info', prefix = '[AgenC Runtime]'): Logger {
  let currentLevel = LOG_LEVELS[minLevel];

  const log = (level: LogLevel, message: string, ...args: unknown[]) => {
    if (LOG_LEVELS[level] >= currentLevel) {
      const timestamp = new Date().toISOString();
      const levelStr = level.toUpperCase().padEnd(5);
      const fullMessage = `${timestamp} ${levelStr} ${prefix} ${message}`;

      switch (level) {
        case 'debug':
          console.debug(fullMessage, ...args);
          break;
        case 'info':
          console.info(fullMessage, ...args);
          break;
        case 'warn':
          console.warn(fullMessage, ...args);
          break;
        case 'error':
          console.error(fullMessage, ...args);
          break;
      }
    }
  };

  return {
    debug: (message, ...args) => log('debug', message, ...args),
    info: (message, ...args) => log('info', message, ...args),
    warn: (message, ...args) => log('warn', message, ...args),
    error: (message, ...args) => log('error', message, ...args),
    setLevel: (level) => {
      currentLevel = LOG_LEVELS[level];
    },
  };
}

/**
 * No-op logger for silent operation
 *
 * Use this when you want to disable logging entirely, such as in tests
 * or when creating components that accept an optional logger.
 *
 * @example
 * ```typescript
 * const manager = new AgentManager({
 *   connection,
 *   wallet,
 *   logger: silentLogger, // Disable all logging
 * });
 * ```
 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setLevel: () => {},
};
