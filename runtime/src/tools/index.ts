/**
 * Tool system for @agenc/runtime
 *
 * MCP-compatible tool registry that bridges the Skills system and
 * LLM adapters. Provides built-in AgenC protocol query tools and
 * a skill-to-tool adapter.
 *
 * @module
 */

// Core types
export {
  type Tool,
  type ToolResult,
  type ToolContext,
  type ToolRegistryConfig,
  type JSONSchema,
  bigintReplacer,
  safeStringify,
} from './types.js';

// Error types
export {
  ToolNotFoundError,
  ToolAlreadyRegisteredError,
  ToolExecutionError,
} from './errors.js';

// Registry
export { ToolRegistry } from './registry.js';

// Skill-to-Tool adapter
export {
  skillToTools,
  type ActionSchemaMap,
  type SkillToToolsOptions,
  JUPITER_ACTION_SCHEMAS,
} from './skill-adapter.js';

// Built-in AgenC tools
export {
  createAgencTools,
  createListTasksTool,
  createGetTaskTool,
  createGetTokenBalanceTool,
  createCreateTaskTool,
  createGetAgentTool,
  createGetProtocolConfigTool,
  type SerializedTask,
  type SerializedAgent,
  type SerializedProtocolConfig,
} from './agenc/index.js';

// System tools
export {
  createBashTool,
  type BashToolConfig,
  type BashToolInput,
  type BashToolOutput,
} from './system/index.js';
