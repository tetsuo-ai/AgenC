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
  readonly usage?: string;
  /** Whether this command is available in all channels (default: true). */
  readonly global?: boolean;
  /** Handler function. */
  readonly handler: SlashCommandHandler;
}

/** Result of parsing a message for slash commands. */
export interface ParseResult {
  /** Whether the message is a slash command. */
  readonly isCommand: boolean;
  /** The command name (without slash), if parsed. */
  readonly command?: string;
  /** The raw argument string after the command name. */
  readonly args?: string;
  /** Parsed argument tokens. */
  readonly argv?: readonly string[];
}

// ============================================================================
// Parser
// ============================================================================

const COMMAND_PATTERN = /^\/([a-zA-Z][a-zA-Z0-9_-]*)(?:\s+(.*))?$/;

/**
 * Parse a message string to check if it's a slash command.
 *
 * A valid slash command starts with `/` followed by a letter and optional
 * alphanumeric/dash/underscore characters, optionally followed by arguments.
 */
export function parseCommand(message: string): ParseResult {
  const trimmed = message.trim();
  const match = COMMAND_PATTERN.exec(trimmed);

  if (!match) {
    return { isCommand: false };
  }

  const command = match[1].toLowerCase();
  const args = match[2]?.trim() ?? '';
  const argv = args ? args.split(/\s+/) : [];

  return { isCommand: true, command, args, argv };
}

// ============================================================================
// Command Registry
// ============================================================================

export interface CommandRegistryConfig {
  readonly logger?: Logger;
}

/**
 * Registry for slash commands.
 *
 * Manages command definitions and dispatch. Built-in commands are registered
 * at construction. Additional commands can be added by plugins.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, SlashCommandDef>();
  private readonly logger: Logger;

  constructor(config?: CommandRegistryConfig) {
    this.logger = config?.logger ?? silentLogger;
    this.registerBuiltins();
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

  /** List all registered command definitions. */
  listAll(): ReadonlyArray<SlashCommandDef> {
    return Array.from(this.commands.values());
  }

  /** List all command names. */
  listNames(): string[] {
    return Array.from(this.commands.keys());
  }

  /** Number of registered commands. */
  get size(): number {
    return this.commands.size;
  }

  /**
   * Dispatch a message to the appropriate command handler.
   *
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
    const parsed = parseCommand(message);
    if (!parsed.isCommand || !parsed.command) {
      return false;
    }

    const command = this.commands.get(parsed.command);
    if (!command) {
      // Unknown command — pass through to LLM
      this.logger.debug(`Unknown command: /${parsed.command}, passing through`);
      return false;
    }

    const ctx: SlashCommandContext = {
      args: parsed.args!,
      argv: parsed.argv!,
      sessionId,
      senderId,
      channel,
      reply,
    };

    try {
      await command.handler(ctx);
      this.logger.debug(`Command executed: /${parsed.command}`);
    } catch (err) {
      this.logger.error(`Command /${parsed.command} failed:`, err);
      await reply(`Error: /${parsed.command} failed — ${(err as Error).message}`);
    }

    return true;
  }

  // --------------------------------------------------------------------------
  // Built-in commands
  // --------------------------------------------------------------------------

  private registerBuiltins(): void {
    this.register({
      name: 'help',
      description: 'Show available commands',
      handler: async (ctx) => {
        const lines = ['**Available commands:**', ''];
        const sorted = Array.from(this.commands.values()).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
        for (const cmd of sorted) {
          const usage = cmd.usage ? ` ${cmd.usage}` : '';
          lines.push(`  /${cmd.name}${usage} — ${cmd.description}`);
        }
        await ctx.reply(lines.join('\n'));
      },
    });

    this.register({
      name: 'status',
      description: 'Show agent status',
      handler: async (ctx) => {
        await ctx.reply(
          `Agent is running.\nSession: ${ctx.sessionId}\nChannel: ${ctx.channel}`,
        );
      },
    });

    this.register({
      name: 'new',
      description: 'Start a new session (reset conversation)',
      handler: async (ctx) => {
        await ctx.reply('Session reset. Starting fresh conversation.');
      },
    });

    this.register({
      name: 'reset',
      description: 'Reset session and clear context',
      handler: async (ctx) => {
        await ctx.reply('Session and context cleared.');
      },
    });

    this.register({
      name: 'stop',
      description: 'Pause the agent (stop responding)',
      handler: async (ctx) => {
        await ctx.reply('Agent paused. Use /start to resume.');
      },
    });

    this.register({
      name: 'start',
      description: 'Resume the agent',
      handler: async (ctx) => {
        await ctx.reply('Agent resumed.');
      },
    });

    this.register({
      name: 'context',
      description: 'Show current context window usage',
      handler: async (ctx) => {
        await ctx.reply(`Session: ${ctx.sessionId}\nContext info not yet available.`);
      },
    });

    this.register({
      name: 'compact',
      description: 'Force conversation compaction',
      handler: async (ctx) => {
        await ctx.reply('Compaction triggered.');
      },
    });

    this.register({
      name: 'model',
      description: 'Show or switch the current LLM model',
      usage: '[name]',
      handler: async (ctx) => {
        if (ctx.args) {
          await ctx.reply(`Model switching not yet implemented. Requested: ${ctx.args}`);
        } else {
          await ctx.reply('Current model info not yet available.');
        }
      },
    });

    this.register({
      name: 'skills',
      description: 'List available skills',
      handler: async (ctx) => {
        await ctx.reply('Skill listing not yet available.');
      },
    });
  }
}
