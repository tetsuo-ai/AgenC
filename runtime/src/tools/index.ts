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
  // HTTP
  createHttpTools,
  isDomainAllowed,
  type HttpToolConfig,
  type HttpResponse,
  // Filesystem
  createFilesystemTools,
  isPathAllowed,
  safePath,
  type FilesystemToolConfig,
  // Browser
  createBrowserTools,
  closeBrowser,
  type BrowserToolConfig,
} from './system/index.js';
