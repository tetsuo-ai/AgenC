import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommand, CommandRegistry } from './commands.js';
import { silentLogger } from '../utils/logger.js';

describe('parseCommand', () => {
  it('parses a simple command', () => {
    const result = parseCommand('/help');
    expect(result.isCommand).toBe(true);
    expect(result.command).toBe('help');
    expect(result.args).toBe('');
    expect(result.argv).toEqual([]);
  });

  it('parses a command with arguments', () => {
    const result = parseCommand('/model grok-3');
    expect(result.isCommand).toBe(true);
    expect(result.command).toBe('model');
    expect(result.args).toBe('grok-3');
    expect(result.argv).toEqual(['grok-3']);
  });

  it('parses a command with multiple arguments', () => {
    const result = parseCommand('/task create a new agent');
    expect(result.isCommand).toBe(true);
    expect(result.command).toBe('task');
    expect(result.args).toBe('create a new agent');
    expect(result.argv).toEqual(['create', 'a', 'new', 'agent']);
  });

  it('normalizes command name to lowercase', () => {
    const result = parseCommand('/Status');
    expect(result.command).toBe('status');
  });

  it('trims whitespace', () => {
    const result = parseCommand('  /help  ');
    expect(result.isCommand).toBe(true);
    expect(result.command).toBe('help');
  });

  it('rejects non-command messages', () => {
    expect(parseCommand('hello world').isCommand).toBe(false);
    expect(parseCommand('').isCommand).toBe(false);
    expect(parseCommand('  ').isCommand).toBe(false);
  });

  it('rejects slash without valid command name', () => {
    expect(parseCommand('/').isCommand).toBe(false);
    expect(parseCommand('/ help').isCommand).toBe(false);
    expect(parseCommand('/123').isCommand).toBe(false);
  });

  it('accepts commands with dashes and underscores', () => {
    const result = parseCommand('/my-command_v2');
    expect(result.isCommand).toBe(true);
    expect(result.command).toBe('my-command_v2');
  });

  it('rejects messages that start with // (not a command)', () => {
    expect(parseCommand('//comment').isCommand).toBe(false);
  });

  it('rejects messages with slash in middle', () => {
    expect(parseCommand('not /a command').isCommand).toBe(false);
  });
});

describe('CommandRegistry', () => {
  let registry: CommandRegistry;
  let replies: string[];
  let reply: (content: string) => Promise<void>;

  beforeEach(() => {
    registry = new CommandRegistry({ logger: silentLogger });
    replies = [];
    reply = async (content: string) => {
      replies.push(content);
    };
  });

  describe('built-in commands', () => {
    it('ships with built-in commands', () => {
      const names = registry.listNames();
      expect(names).toContain('help');
      expect(names).toContain('status');
      expect(names).toContain('new');
      expect(names).toContain('reset');
      expect(names).toContain('stop');
      expect(names).toContain('start');
      expect(names).toContain('context');
      expect(names).toContain('compact');
      expect(names).toContain('model');
      expect(names).toContain('skills');
      expect(registry.size).toBe(10);
    });

    it('/help lists all commands', async () => {
      await registry.dispatch('/help', 'sess1', 'user1', 'telegram', reply);

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('Available commands');
      expect(replies[0]).toContain('/help');
      expect(replies[0]).toContain('/status');
    });

    it('/status shows agent info', async () => {
      await registry.dispatch('/status', 'sess1', 'user1', 'telegram', reply);

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('Agent is running');
      expect(replies[0]).toContain('sess1');
      expect(replies[0]).toContain('telegram');
    });

    it('/new replies with reset message', async () => {
      await registry.dispatch('/new', 'sess1', 'user1', 'telegram', reply);

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('Session reset');
    });

    it('/model without args shows current model', async () => {
      await registry.dispatch('/model', 'sess1', 'user1', 'telegram', reply);

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('model');
    });

    it('/model with args requests model switch', async () => {
      await registry.dispatch('/model grok-3', 'sess1', 'user1', 'telegram', reply);

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('grok-3');
    });
  });

  describe('dispatch', () => {
    it('returns true for known commands', async () => {
      const handled = await registry.dispatch('/help', 'sess1', 'user1', 'tg', reply);
      expect(handled).toBe(true);
    });

    it('returns false for unknown commands', async () => {
      const handled = await registry.dispatch('/unknown', 'sess1', 'user1', 'tg', reply);
      expect(handled).toBe(false);
      expect(replies).toHaveLength(0);
    });

    it('returns false for non-command messages', async () => {
      const handled = await registry.dispatch('hello', 'sess1', 'user1', 'tg', reply);
      expect(handled).toBe(false);
    });

    it('catches handler errors and replies with error', async () => {
      registry.register({
        name: 'broken',
        description: 'A broken command',
        handler: async () => {
          throw new Error('something went wrong');
        },
      });

      const handled = await registry.dispatch('/broken', 'sess1', 'user1', 'tg', reply);

      expect(handled).toBe(true);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('something went wrong');
    });
  });

  describe('register / unregister', () => {
    it('registers a custom command', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      registry.register({
        name: 'custom',
        description: 'A custom command',
        handler,
      });

      await registry.dispatch('/custom arg1 arg2', 'sess1', 'user1', 'tg', reply);

      expect(handler).toHaveBeenCalledTimes(1);
      const ctx = handler.mock.calls[0][0];
      expect(ctx.args).toBe('arg1 arg2');
      expect(ctx.argv).toEqual(['arg1', 'arg2']);
      expect(ctx.sessionId).toBe('sess1');
      expect(ctx.senderId).toBe('user1');
      expect(ctx.channel).toBe('tg');
    });

    it('overwrites existing command on re-register', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      registry.register({
        name: 'status',
        description: 'Custom status',
        handler,
      });

      await registry.dispatch('/status', 'sess1', 'user1', 'tg', reply);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('unregisters a command', () => {
      expect(registry.unregister('status')).toBe(true);
      expect(registry.get('status')).toBeUndefined();
    });

    it('unregister returns false for nonexistent command', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('get / list', () => {
    it('get returns command definition', () => {
      const cmd = registry.get('help');
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe('help');
      expect(cmd!.description).toContain('commands');
    });

    it('get returns undefined for unknown command', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });

    it('listAll returns all command definitions', () => {
      const all = registry.listAll();
      expect(all.length).toBe(registry.size);
      expect(all.every((c) => c.name && c.description && c.handler)).toBe(true);
    });
  });
});
