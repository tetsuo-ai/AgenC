/**
 * Built-in AgenC protocol query tools.
 *
 * @module
 */

import type { Tool, ToolContext } from '../types.js';
import { TaskOperations } from '../../task/operations.js';
import { createReadOnlyProgram } from '../../idl.js';
import {
  createListTasksTool,
  createGetTaskTool,
  createGetAgentTool,
  createGetProtocolConfigTool,
} from './tools.js';

// Re-export serialized types
export type { SerializedTask, SerializedAgent, SerializedProtocolConfig } from './types.js';

// Re-export individual tool factories for advanced usage
export {
  createListTasksTool,
  createGetTaskTool,
  createGetAgentTool,
  createGetProtocolConfigTool,
} from './tools.js';

/**
 * Create all 4 built-in AgenC protocol query tools.
 *
 * The factory creates a single `TaskOperations` instance shared by
 * all tools. If no program is provided in the context, a read-only
 * program is created from the connection.
 *
 * @param context - Tool context with connection and optional program
 * @returns Array of 4 Tool instances
 *
 * @example
 * ```typescript
 * const tools = createAgencTools({ connection, logger });
 * registry.registerAll(tools);
 * ```
 */
export function createAgencTools(context: ToolContext): Tool[] {
  const program = context.program ?? createReadOnlyProgram(context.connection);

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
    createGetAgentTool(program, context.logger),
    createGetProtocolConfigTool(program, context.logger),
  ];
}
