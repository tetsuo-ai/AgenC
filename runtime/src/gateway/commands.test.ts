import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseCommand, SlashCommandRegistry, createDefaultCommands } from './commands.js';
import type { ParsedCommand } from './commands.js';
import { silentLogger } from '../utils/logger.js';

describe('parseCommand', () => {
  it('parses a simple command', () => {
    const result = parseCommand('/help');
    expect(result.isCommand).toBe(true);
    expect(result.name).toBe('help');
    expect(result.args).toBe('');
    expect(result.argv).toEqual([]);
  });

  it('parses a command with arguments', () => {
    const result = parseCommand('/model grok-3');
    expect(result.isCommand).toBe(true);
    expect(result.name).toBe('model');
    expect(result.args).toBe('grok-3');
    expect(result.argv).toEqual(['grok-3']);
  });

  it('parses a command with multiple arguments', () => {
    const result = parseCommand('/task create a new agent');
    expect(result.isCommand).toBe(true);
    expect(result.name).toBe('task');
    expect(result.args).toBe('create a new agent');
    expect(result.argv).toEqual(['create', 'a', 'new', 'agent']);
  });

  it('normalizes command name to lowercase', () => {
    const result = parseCommand('/Status');
    expect(result.name).toBe('status');
  });

  it('trims whitespace', () => {
    const result = parseCommand('  /help  ');
    expect(result.isCommand).toBe(true);
    expect(result.name).toBe('help');
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
    expect(result.name).toBe('my-command_v2');
  });

  it('rejects messages that start with // (not a command)', () => {
    expect(parseCommand('//comment').isCommand).toBe(false);
  });

  it('rejects messages with slash in middle', () => {
    expect(parseCommand('not /a command').isCommand).toBe(false);
  });

  it('rejects command names longer than 32 characters', () => {
    const longName = 'a' + 'b'.repeat(32);
    expect(parseCommand(`/${longName}`).isCommand).toBe(false);
  });

  it('accepts command names exactly 32 characters', () => {
    const name = 'a' + 'b'.repeat(31);
    const result = parseCommand(`/${name}`);
    expect(result.isCommand).toBe(true);
    expect(result.name).toBe(name);
  });
});

describe('SlashCommandRegistry', () => {
  let registry: SlashCommandRegistry;
  let replies: string[];
  let reply: (content: string) => Promise<void>;

  beforeEach(() => {
    registry = new SlashCommandRegistry({ logger: silentLogger });
    replies = [];
    reply = async (content: string) => {
      replies.push(content);
    };
  });

  describe('register / unregister', () => {
    it('registers a custom command', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      registry.register({
        name: 'custom',
        description: 'A custom command',
        global: true,
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

    it('overwrites existing command on re-register', () => {
      const handler1 = vi.fn().mockResolvedValue(undefined);
      const handler2 = vi.fn().mockResolvedValue(undefined);
      registry.register({ name: 'cmd', description: 'v1', global: true, handler: handler1 });
      registry.register({ name: 'cmd', description: 'v2', global: true, handler: handler2 });

      expect(registry.get('cmd')!.description).toBe('v2');
    });

    it('unregisters a command', () => {
      registry.register({ name: 'temp', description: 'temp', global: true, handler: async () => {} });

      expect(registry.unregister('temp')).toBe(true);
      expect(registry.get('temp')).toBeUndefined();
    });

    it('unregister returns false for nonexistent command', () => {
      expect(registry.unregister('nonexistent')).toBe(false);
    });
  });

  describe('has', () => {
    it('returns true for registered commands', () => {
      registry.register({ name: 'ping', description: 'ping', global: true, handler: async () => {} });

      expect(registry.has('ping')).toBe(true);
    });

    it('returns false for unregistered commands', () => {
      expect(registry.has('nonexistent')).toBe(false);
    });
  });

  describe('get / getCommands / listNames', () => {
    it('get returns command definition', () => {
      registry.register({ name: 'info', description: 'show info', global: true, handler: async () => {} });

      const cmd = registry.get('info');
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe('info');
    });

    it('get returns undefined for unknown command', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });

    it('getCommands returns all commands sorted by name', () => {
      registry.register({ name: 'zebra', description: 'z', global: true, handler: async () => {} });
      registry.register({ name: 'alpha', description: 'a', global: true, handler: async () => {} });
      registry.register({ name: 'mango', description: 'm', global: true, handler: async () => {} });

      const commands = registry.getCommands();
      expect(commands.map((c) => c.name)).toEqual(['alpha', 'mango', 'zebra']);
    });

    it('listNames returns all command names', () => {
      registry.register({ name: 'a', description: 'a', global: true, handler: async () => {} });
      registry.register({ name: 'b', description: 'b', global: true, handler: async () => {} });

      expect(registry.listNames()).toContain('a');
      expect(registry.listNames()).toContain('b');
    });

    it('size reflects registered command count', () => {
      expect(registry.size).toBe(0);
      registry.register({ name: 'x', description: 'x', global: true, handler: async () => {} });
      expect(registry.size).toBe(1);
    });
  });

  describe('parse', () => {
    it('delegates to parseCommand', () => {
      const result = registry.parse('/status some args');
      expect(result.isCommand).toBe(true);
      expect(result.name).toBe('status');
      expect(result.args).toBe('some args');
    });
  });

  describe('execute', () => {
    it('executes a registered command from parsed input', async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      registry.register({ name: 'run', description: 'run', global: true, handler });

      const parsed: ParsedCommand = { isCommand: true, name: 'run', args: 'fast', argv: ['fast'] };
      const handled = await registry.execute(parsed, {
        sessionId: 'sess1', senderId: 'user1', channel: 'tg', reply,
      });

      expect(handled).toBe(true);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('returns false for non-command parsed input', async () => {
      const parsed: ParsedCommand = { isCommand: false };
      const handled = await registry.execute(parsed, {
        sessionId: 'sess1', senderId: 'user1', channel: 'tg', reply,
      });

      expect(handled).toBe(false);
    });

    it('returns false for unknown command', async () => {
      const parsed: ParsedCommand = { isCommand: true, name: 'unknown', args: '', argv: [] };
      const handled = await registry.execute(parsed, {
        sessionId: 'sess1', senderId: 'user1', channel: 'tg', reply,
      });

      expect(handled).toBe(false);
    });

    it('catches handler errors and replies with error', async () => {
      registry.register({
        name: 'broken',
        description: 'A broken command',
        global: true,
        handler: async () => {
          throw new Error('something went wrong');
        },
      });

      const parsed: ParsedCommand = { isCommand: true, name: 'broken', args: '', argv: [] };
      const handled = await registry.execute(parsed, {
        sessionId: 'sess1', senderId: 'user1', channel: 'tg', reply,
      });

      expect(handled).toBe(true);
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('something went wrong');
    });
  });

  describe('dispatch', () => {
    it('returns true for known commands', async () => {
      registry.register({ name: 'ping', description: 'pong', global: true, handler: async (ctx) => { await ctx.reply('pong'); } });

      const handled = await registry.dispatch('/ping', 'sess1', 'user1', 'tg', reply);
      expect(handled).toBe(true);
      expect(replies).toEqual(['pong']);
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
  });
});

describe('createDefaultCommands', () => {
  it('returns 14 default commands', () => {
    const commands = createDefaultCommands();
    expect(commands).toHaveLength(14);
  });

  it('includes all expected command names', () => {
    const commands = createDefaultCommands();
    const names = commands.map((c) => c.name);

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
    expect(names).toContain('task');
    expect(names).toContain('tasks');
    expect(names).toContain('balance');
    expect(names).toContain('reputation');
  });

  it('all commands have global: true', () => {
    const commands = createDefaultCommands();
    for (const cmd of commands) {
      expect(cmd.global).toBe(true);
    }
  });

  it('/model has args pattern [name]', () => {
    const commands = createDefaultCommands();
    const model = commands.find((c) => c.name === 'model');
    expect(model!.args).toBe('[name]');
  });

  it('can be registered on a registry', () => {
    const registry = new SlashCommandRegistry({ logger: silentLogger });
    const commands = createDefaultCommands();
    for (const cmd of commands) {
      registry.register(cmd);
    }
    expect(registry.size).toBe(14);
  });

  it('registry without defaults starts empty', () => {
    const registry = new SlashCommandRegistry({ logger: silentLogger });
    expect(registry.size).toBe(0);
  });

  it('/status replies with session and channel info', async () => {
    const replies: string[] = [];
    const commands = createDefaultCommands();
    const status = commands.find((c) => c.name === 'status')!;

    await status.handler({
      args: '', argv: [], sessionId: 'sess1', senderId: 'user1',
      channel: 'telegram', reply: async (c) => { replies.push(c); },
    });

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('sess1');
    expect(replies[0]).toContain('telegram');
  });

  it('getCommands returns sorted results with defaults loaded', () => {
    const registry = new SlashCommandRegistry({ logger: silentLogger });
    for (const cmd of createDefaultCommands()) {
      registry.register(cmd);
    }

    const commands = registry.getCommands();
    const names = commands.map((c) => c.name);

    for (let i = 1; i < names.length; i++) {
      expect(names[i - 1].localeCompare(names[i])).toBeLessThan(0);
    }
  });

  it('/model [name] appears in help-style listing', () => {
    const registry = new SlashCommandRegistry({ logger: silentLogger });
    for (const cmd of createDefaultCommands()) {
      registry.register(cmd);
    }

    const model = registry.get('model')!;
    const helpLine = `/${model.name}${model.args ? ` ${model.args}` : ''} — ${model.description}`;

    expect(helpLine).toContain('/model [name]');
  });
});
