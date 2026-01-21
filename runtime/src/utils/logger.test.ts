import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger, silentLogger, LogLevel, Logger } from './logger';

describe('Logger', () => {
  let consoleSpy: {
    debug: ReturnType<typeof vi.spyOn>;
    info: ReturnType<typeof vi.spyOn>;
    warn: ReturnType<typeof vi.spyOn>;
    error: ReturnType<typeof vi.spyOn>;
  };

  beforeEach(() => {
    consoleSpy = {
      debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
      info: vi.spyOn(console, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createLogger', () => {
    it('should create a logger with default settings', () => {
      const logger = createLogger();
      expect(logger).toBeDefined();
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.setLevel).toBe('function');
    });

    it('should use default minLevel of info', () => {
      const logger = createLogger();

      logger.debug('debug message');
      logger.info('info message');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).toHaveBeenCalled();
    });

    it('should use default prefix of [AgenC Runtime]', () => {
      const logger = createLogger();
      logger.info('test message');

      expect(consoleSpy.info).toHaveBeenCalledWith(
        expect.stringContaining('[AgenC Runtime]'),
      );
    });

    it('should accept custom minLevel', () => {
      const logger = createLogger('debug');

      logger.debug('debug message');

      expect(consoleSpy.debug).toHaveBeenCalled();
    });

    it('should accept custom prefix', () => {
      const logger = createLogger('info', '[Custom]');
      logger.info('test message');

      expect(consoleSpy.info).toHaveBeenCalledWith(
        expect.stringContaining('[Custom]'),
      );
    });
  });

  describe('log level filtering', () => {
    it('should filter logs below minimum level', () => {
      const logger = createLogger('warn');

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should output all logs at minimum level and above', () => {
      const logger = createLogger('debug');

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(consoleSpy.debug).toHaveBeenCalled();
      expect(consoleSpy.info).toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });

    it('should only output error when minLevel is error', () => {
      const logger = createLogger('error');

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });

  describe('log message format', () => {
    it('should include ISO timestamp', () => {
      const logger = createLogger('info');
      logger.info('test');

      const call = consoleSpy.info.mock.calls[0][0] as string;
      // ISO timestamp format: 2026-01-21T12:00:00.000Z
      expect(call).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
    });

    it('should include padded level (5 chars)', () => {
      const logger = createLogger('debug');

      logger.debug('test');
      logger.info('test');
      logger.warn('test');
      logger.error('test');

      // DEBUG is 5 chars, INFO is 4 chars (padded to 5), WARN is 4 chars, ERROR is 5 chars
      expect(consoleSpy.debug.mock.calls[0][0]).toContain(' DEBUG ');
      expect(consoleSpy.info.mock.calls[0][0]).toContain(' INFO  ');
      expect(consoleSpy.warn.mock.calls[0][0]).toContain(' WARN  ');
      expect(consoleSpy.error.mock.calls[0][0]).toContain(' ERROR ');
    });

    it('should include prefix', () => {
      const logger = createLogger('info', '[TestPrefix]');
      logger.info('message');

      expect(consoleSpy.info.mock.calls[0][0]).toContain('[TestPrefix]');
    });

    it('should include the message', () => {
      const logger = createLogger('info');
      logger.info('my test message');

      expect(consoleSpy.info.mock.calls[0][0]).toContain('my test message');
    });

    it('should format message as: timestamp level prefix message', () => {
      const logger = createLogger('info', '[Test]');
      logger.info('hello');

      const call = consoleSpy.info.mock.calls[0][0] as string;
      // Format: 2026-01-21T12:00:00.000Z INFO  [Test] hello
      expect(call).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO  \[Test\] hello$/,
      );
    });
  });

  describe('console method mapping', () => {
    it('should use console.debug for debug level', () => {
      const logger = createLogger('debug');
      logger.debug('test');

      expect(consoleSpy.debug).toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
    });

    it('should use console.info for info level', () => {
      const logger = createLogger('info');
      logger.info('test');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
    });

    it('should use console.warn for warn level', () => {
      const logger = createLogger('warn');
      logger.warn('test');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).toHaveBeenCalled();
      expect(consoleSpy.error).not.toHaveBeenCalled();
    });

    it('should use console.error for error level', () => {
      const logger = createLogger('error');
      logger.error('test');

      expect(consoleSpy.debug).not.toHaveBeenCalled();
      expect(consoleSpy.info).not.toHaveBeenCalled();
      expect(consoleSpy.warn).not.toHaveBeenCalled();
      expect(consoleSpy.error).toHaveBeenCalled();
    });
  });

  describe('variadic arguments', () => {
    it('should pass additional arguments to console methods', () => {
      const logger = createLogger('debug');
      const obj = { key: 'value' };
      const arr = [1, 2, 3];

      logger.debug('message', obj, arr, 42);

      expect(consoleSpy.debug).toHaveBeenCalledWith(
        expect.any(String),
        obj,
        arr,
        42,
      );
    });

    it('should work with no additional arguments', () => {
      const logger = createLogger('info');
      logger.info('just a message');

      expect(consoleSpy.info).toHaveBeenCalledWith(expect.any(String));
    });

    it('should pass arguments for all log levels', () => {
      const logger = createLogger('debug');
      const extra = { data: true };

      logger.debug('msg', extra);
      logger.info('msg', extra);
      logger.warn('msg', extra);
      logger.error('msg', extra);

      expect(consoleSpy.debug).toHaveBeenCalledWith(expect.any(String), extra);
      expect(consoleSpy.info).toHaveBeenCalledWith(expect.any(String), extra);
      expect(consoleSpy.warn).toHaveBeenCalledWith(expect.any(String), extra);
      expect(consoleSpy.error).toHaveBeenCalledWith(expect.any(String), extra);
    });
  });

  describe('setLevel', () => {
    it('should change filtering behavior dynamically', () => {
      const logger = createLogger('error');

      // Initially only error should log
      logger.info('should not appear');
      expect(consoleSpy.info).not.toHaveBeenCalled();

      // Change to info level
      logger.setLevel('info');

      logger.info('should appear now');
      expect(consoleSpy.info).toHaveBeenCalled();
    });

    it('should allow increasing log level', () => {
      const logger = createLogger('debug');

      logger.debug('debug 1');
      expect(consoleSpy.debug).toHaveBeenCalledTimes(1);

      logger.setLevel('warn');

      logger.debug('debug 2');
      logger.info('info');
      expect(consoleSpy.debug).toHaveBeenCalledTimes(1); // Still 1
      expect(consoleSpy.info).not.toHaveBeenCalled();
    });

    it('should allow decreasing log level', () => {
      const logger = createLogger('error');

      logger.debug('debug');
      expect(consoleSpy.debug).not.toHaveBeenCalled();

      logger.setLevel('debug');

      logger.debug('debug now works');
      expect(consoleSpy.debug).toHaveBeenCalled();
    });
  });

  describe('silentLogger', () => {
    it('should have all required methods', () => {
      expect(typeof silentLogger.debug).toBe('function');
      expect(typeof silentLogger.info).toBe('function');
      expect(typeof silentLogger.warn).toBe('function');
      expect(typeof silentLogger.error).toBe('function');
      expect(typeof silentLogger.setLevel).toBe('function');
    });

    it('should not output anything for debug', () => {
      silentLogger.debug('test');
      expect(consoleSpy.debug).not.toHaveBeenCalled();
    });

    it('should not output anything for info', () => {
      silentLogger.info('test');
      expect(consoleSpy.info).not.toHaveBeenCalled();
    });

    it('should not output anything for warn', () => {
      silentLogger.warn('test');
      expect(consoleSpy.warn).not.toHaveBeenCalled();
    });

    it('should not output anything for error', () => {
      silentLogger.error('test');
      expect(consoleSpy.error).not.toHaveBeenCalled();
    });

    it('should accept setLevel without error', () => {
      expect(() => silentLogger.setLevel('debug')).not.toThrow();
      expect(() => silentLogger.setLevel('error')).not.toThrow();
    });

    it('should accept variadic arguments without error', () => {
      expect(() => silentLogger.debug('msg', 1, 2, 3)).not.toThrow();
      expect(() => silentLogger.info('msg', { a: 1 })).not.toThrow();
      expect(() => silentLogger.warn('msg', [1, 2])).not.toThrow();
      expect(() => silentLogger.error('msg', null, undefined)).not.toThrow();
    });

    it('should implement Logger interface', () => {
      const logger: Logger = silentLogger;
      expect(logger).toBe(silentLogger);
    });
  });

  describe('type exports', () => {
    it('should export LogLevel type', () => {
      const level: LogLevel = 'debug';
      expect(['debug', 'info', 'warn', 'error']).toContain(level);
    });

    it('should export Logger interface', () => {
      const logger: Logger = createLogger();
      expect(logger).toBeDefined();
    });
  });
});
