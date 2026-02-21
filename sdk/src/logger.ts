/**
 * Logger utility for @agenc/sdk
 *
 * Provides a lightweight, dependency-free logging system with configurable
 * log levels and formatted output.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

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
 * @param prefix - Prefix for log messages (default: '[AgenC SDK]')
 * @returns Logger instance
 */
export function createLogger(
  minLevel: LogLevel = "info",
  prefix = "[AgenC SDK]",
): Logger {
  let currentLevel = LOG_LEVELS[minLevel];

  const log = (level: LogLevel, message: string, ...args: unknown[]) => {
    if (LOG_LEVELS[level] >= currentLevel) {
      const timestamp = new Date().toISOString();
      const levelStr = level.toUpperCase().padEnd(5);
      const fullMessage = `${timestamp} ${levelStr} ${prefix} ${message}`;

      switch (level) {
        case "debug":
          console.debug(fullMessage, ...args);
          break;
        case "info":
          console.info(fullMessage, ...args);
          break;
        case "warn":
          console.warn(fullMessage, ...args);
          break;
        case "error":
          console.error(fullMessage, ...args);
          break;
      }
    }
  };

  return {
    debug: (message, ...args) => log("debug", message, ...args),
    info: (message, ...args) => log("info", message, ...args),
    warn: (message, ...args) => log("warn", message, ...args),
    error: (message, ...args) => log("error", message, ...args),
    setLevel: (level) => {
      currentLevel = LOG_LEVELS[level];
    },
  };
}

/**
 * No-op logger for silent operation
 */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  setLevel: () => {},
};

// Module-level SDK logger singleton
let sdkLogger: Logger = silentLogger;

/**
 * Set the global SDK log level. Creates a new logger with the specified level.
 * Affects all standalone SDK functions that use getSdkLogger().
 */
export function setSdkLogLevel(level: LogLevel): void {
  sdkLogger = createLogger(level);
}

/**
 * Get the global SDK logger instance.
 * Returns silentLogger by default until setSdkLogLevel() is called.
 */
export function getSdkLogger(): Logger {
  return sdkLogger;
}
