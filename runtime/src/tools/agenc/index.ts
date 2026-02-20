/**
 * Built-in AgenC protocol query tools.
 *
 * @module
 */

import type { Tool, ToolContext } from '../types.js';
import { TaskOperations } from '../../task/operations.js';
import { createProgram, createReadOnlyProgram } from '../../idl.js';
import { AnchorProvider } from '@coral-xyz/anchor';
import {
  createListTasksTool,
  createGetTaskTool,
  createGetTokenBalanceTool,
  createRegisterAgentTool,
  createCreateTaskTool,
  createGetAgentTool,
  createGetProtocolConfigTool,
} from './tools.js';

// Re-export serialized types
export type { SerializedTask, SerializedAgent, SerializedProtocolConfig } from './types.js';

// Re-export individual tool factories for advanced usage
export {
  createListTasksTool,
  createGetTaskTool,
  createGetTokenBalanceTool,
  createRegisterAgentTool,
  createCreateTaskTool,
  createGetAgentTool,
  createGetProtocolConfigTool,
} from './tools.js';

/**
 * Create all built-in AgenC protocol tools.
 *
 * The factory creates a single `TaskOperations` instance shared by
 * all tools. If no program is provided in the context, a read-only
 * program is created from the connection.
 *
 * @param context - Tool context with connection and optional program
 * @returns Array of Tool instances
 *
 * @example
 * ```typescript
 * const tools = createAgencTools({ connection, logger });
 * registry.registerAll(tools);
 * ```
 */
export function createAgencTools(context: ToolContext): Tool[] {
  const program = context.program ?? (() => {
    if (context.wallet) {
      const provider = new AnchorProvider(context.connection, context.wallet, { commitment: 'confirmed' });
      return context.programId ? createProgram(provider, context.programId) : createProgram(provider);
    }
    return context.programId
      ? createReadOnlyProgram(context.connection, context.programId)
      : createReadOnlyProgram(context.connection);
  })();

  // Dummy agentId — built-in tools only use query methods that don't reference agentId
  const dummyAgentId = new Uint8Array(32);

  const ops = new TaskOperations({
    program,
    agentId: dummyAgentId,
    logger: context.logger,
  });

  return [
    createListTasksTool(ops, context.logger),
    createGetTaskTool(ops, context.logger),
    createGetTokenBalanceTool(program, context.logger),
    createRegisterAgentTool(program, context.logger),
    createCreateTaskTool(program, context.logger),
    createGetAgentTool(program, context.logger),
    createGetProtocolConfigTool(program, context.logger),
  ];
}
