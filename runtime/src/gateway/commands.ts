/**
 * Slash commands handler.
 *
 * Intercepts `/`-prefixed messages before they reach the LLM. Commands
 * provide users with direct control over the agent through messaging-native
 * interactions. Unknown commands are passed through to the LLM as regular
 * messages.
 *
 * @module
 */

import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

/** Context passed to slash command handlers. */
export interface SlashCommandContext {
  /** The raw argument string after the command name. */
  readonly args: string;
  /** Parsed argument tokens (split on whitespace). */
  readonly argv: readonly string[];
  /** The session ID. */
  readonly sessionId: string;
  /** The sender ID. */
  readonly senderId: string;
  /** The channel name. */
  readonly channel: string;
  /** Reply callback — sends a response in the same channel. */
  readonly reply: (content: string) => Promise<void>;
}

/** Handler function signature for a slash command. */
export type SlashCommandHandler = (ctx: SlashCommandContext) => Promise<void>;

/** Definition of a slash command. */
export interface SlashCommandDef {
  /** Command name without the slash (e.g. 'status', 'model'). */
  readonly name: string;
  /** Short description for /help output. */
  readonly description: string;
  /** Optional argument pattern description (e.g. '<name>'). */
  readonly args?: string;
  /** Whether this command is available in all channels. */
  readonly global: boolean;
  /** Handler function. */
  readonly handler: SlashCommandHandler;
}

/** Result of parsing a message for slash commands. */
export interface ParsedCommand {
  /** Whether the message is a slash command. */
  readonly isCommand: boolean;
  /** The command name (without slash), if parsed. */
  readonly name?: string;
  /** The raw argument string after the command name. */
  readonly args?: string;
  /** Parsed argument tokens. */
  readonly argv?: readonly string[];
}

// ============================================================================
// Parser
// ============================================================================

/** Max command name length (alphanumeric + hyphens, 1-32 chars). */
const MAX_COMMAND_LENGTH = 32;
const COMMAND_PATTERN = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/;

/**
 * Parse a message string to check if it's a slash command.
 *
 * A valid slash command starts with `/` followed by a letter and optional
 * alphanumeric/dash/underscore characters (max 32 chars), optionally
 * followed by arguments.
 */
export function parseCommand(message: string): ParsedCommand {
  const trimmed = message.trim();
  const match = COMMAND_PATTERN.exec(trimmed);

  if (!match) {
    return { isCommand: false };
  }

  const name = match[1].toLowerCase();
  if (name.length > MAX_COMMAND_LENGTH) {
    return { isCommand: false };
  }

  const args = match[2]?.trim() ?? '';
  const argv = args ? args.split(/\s+/) : [];

  return { isCommand: true, name, args, argv };
}

// ============================================================================
// SlashCommandRegistry
// ============================================================================

export interface SlashCommandRegistryConfig {
  readonly logger?: Logger;
}

/**
 * Registry for slash commands.
 *
 * Manages command definitions and dispatch. Built-in commands can be
 * registered via `createDefaultCommands()`. Additional commands can be
 * added by plugins.
 */
export class SlashCommandRegistry {
  private readonly commands = new Map<string, SlashCommandDef>();
  private readonly logger: Logger;

  constructor(config?: SlashCommandRegistryConfig) {
    this.logger = config?.logger ?? silentLogger;
  }

  /** Register a slash command. Overwrites if name already exists. */
  register(command: SlashCommandDef): void {
    this.commands.set(command.name, command);
    this.logger.debug(`Command registered: /${command.name}`);
  }

  /** Unregister a command by name. */
  unregister(name: string): boolean {
    const removed = this.commands.delete(name);
    if (removed) {
      this.logger.debug(`Command unregistered: /${name}`);
    }
    return removed;
  }

  /** Get a command definition by name. */
  get(name: string): SlashCommandDef | undefined {
    return this.commands.get(name);
  }

  /** Check if a command is registered. */
  has(name: string): boolean {
    return this.commands.has(name);
  }

  /** Get all registered command definitions sorted by name. */
  getCommands(): ReadonlyArray<SlashCommandDef> {
    return Array.from(this.commands.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  /** List all command names. */
  listNames(): string[] {
    return Array.from(this.commands.keys());
  }

  /** Number of registered commands. */
  get size(): number {
    return this.commands.size;
  }

  /** Parse a message string for a slash command. */
  parse(content: string): ParsedCommand {
    return parseCommand(content);
  }

  /**
   * Execute a previously parsed command.
   *
   * Returns true if the command was handled, false if unknown.
   */
  async execute(
    parsed: ParsedCommand,
    context: Omit<SlashCommandContext, 'args' | 'argv'>,
  ): Promise<boolean> {
    if (!parsed.isCommand || !parsed.name) {
      return false;
    }

    const command = this.commands.get(parsed.name);
    if (!command) {
      this.logger.debug(`Unknown command: /${parsed.name}, passing through`);
      return false;
    }

    const ctx: SlashCommandContext = {
      args: parsed.args ?? '',
      argv: parsed.argv ?? [],
      sessionId: context.sessionId,
      senderId: context.senderId,
      channel: context.channel,
      reply: context.reply,
    };

    try {
      await command.handler(ctx);
      this.logger.debug(`Command executed: /${parsed.name}`);
    } catch (err) {
      this.logger.error(`Command /${parsed.name} failed:`, err);
      await context.reply(`Error: /${parsed.name} failed — ${(err as Error).message}`);
    }

    return true;
  }

  /**
   * Dispatch a message to the appropriate command handler.
   *
   * Convenience method that combines parse + execute.
   * Returns true if the message was handled as a command, false if it should
   * be passed through to the LLM (not a command or unknown command).
   */
  async dispatch(
    message: string,
    sessionId: string,
    senderId: string,
    channel: string,
    reply: (content: string) => Promise<void>,
  ): Promise<boolean> {
    const parsed = this.parse(message);
    return this.execute(parsed, { sessionId, senderId, channel, reply });
  }
}

// ============================================================================
// Default commands factory
// ============================================================================

/**
 * Create the 14 built-in slash command definitions.
 *
 * Returns an array of SlashCommandDef that can be registered on a
 * SlashCommandRegistry. This factory enables constructing a registry
 * without defaults, or getting defaults without a registry.
 */
export function createDefaultCommands(): SlashCommandDef[] {
  return [
    {
      name: 'help',
      description: 'Show available commands',
      global: true,
      handler: async (ctx) => {
        // Help needs access to a registry, so this is a placeholder.
        // The gateway wires up the real help handler with registry access.
        await ctx.reply('Use /help to see available commands.');
      },
    },
    {
      name: 'status',
      description: 'Show agent status',
      global: true,
      handler: async (ctx) => {
        await ctx.reply(
          `Agent is running.\nSession: ${ctx.sessionId}\nChannel: ${ctx.channel}`,
        );
      },
    },
    {
      name: 'new',
      description: 'Start a new session (reset conversation)',
      global: true,
      handler: async (ctx) => {
        await ctx.reply('Session reset. Starting fresh conversation.');
      },
    },
    {
      name: 'reset',
      description: 'Reset session and clear context',
      global: true,
      handler: async (ctx) => {
        await ctx.reply('Session and context cleared.');
      },
    },
    {
      name: 'stop',
      description: 'Pause the agent (stop responding)',
      global: true,
      handler: async (ctx) => {
        await ctx.reply('Agent paused. Use /start to resume.');
      },
    },
    {
      name: 'start',
      description: 'Resume the agent',
      global: true,
      handler: async (ctx) => {
        await ctx.reply('Agent resumed.');
      },
    },
    {
      name: 'context',
      description: 'Show current context window usage',
      global: true,
      handler: async (ctx) => {
        await ctx.reply(`Session: ${ctx.sessionId}\nContext info not yet available.`);
      },
    },
    {
      name: 'compact',
      description: 'Force conversation compaction',
      global: true,
      handler: async (ctx) => {
        await ctx.reply('Compaction triggered.');
      },
    },
    {
      name: 'model',
      description: 'Show or switch the current LLM model',
      args: '[name]',
      global: true,
      handler: async (ctx) => {
        if (ctx.args) {
          await ctx.reply(`Model switching not yet implemented. Requested: ${ctx.args}`);
        } else {
          await ctx.reply('Current model info not yet available.');
        }
      },
    },
    {
      name: 'skills',
      description: 'List available skills',
      global: true,
      handler: async (ctx) => {
        await ctx.reply('Skill listing not yet available.');
      },
    },
    {
      name: 'task',
      description: 'Show current task status',
      global: true,
      handler: async (ctx) => {
        await ctx.reply('Task status not yet available.');
      },
    },
    {
      name: 'tasks',
      description: 'List all tasks',
      global: true,
      handler: async (ctx) => {
        await ctx.reply('Task listing not yet available.');
      },
    },
    {
      name: 'balance',
      description: 'Show token balance',
      global: true,
      handler: async (ctx) => {
        await ctx.reply('Balance info not yet available.');
      },
    },
    {
      name: 'reputation',
      description: 'Show agent reputation score',
      global: true,
      handler: async (ctx) => {
        await ctx.reply('Reputation info not yet available.');
      },
    },
  ];
}
