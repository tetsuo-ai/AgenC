/**
 * Tool type definitions for @agenc/runtime
 *
 * MCP-compatible tool system for agent actions.
 */

/**
 * JSON Schema property type
 */
export interface JSONSchemaProperty {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description?: string;
  enum?: (string | number)[];
  items?: JSONSchemaProperty;
  properties?: Record<string, JSONSchemaProperty>;
  required?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/**
 * JSON Schema for tool input
 */
export interface JSONSchema {
  type: 'object';
  properties: Record<string, JSONSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Internal tool execution result (returned by Tool.execute)
 */
export interface ToolExecutionResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Output data */
  output?: unknown;
  /** Error message if failed */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Tool execution result with call ID (returned by ToolRegistry)
 */
export interface ToolResult {
  /** Tool call ID (matches the ToolCall.id) */
  toolCallId: string;
  /** Whether execution succeeded */
  success: boolean;
  /** Output data */
  output?: unknown;
  /** Error message if failed */
  error?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Tool call from LLM
 */
export interface ToolCall {
  /** Unique ID for this call */
  id: string;
  /** Tool name */
  name: string;
  /** Input arguments */
  input: unknown;
}

/**
 * Tool definition (MCP-compatible)
 */
export interface Tool {
  /** Tool name (unique identifier) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Input schema */
  inputSchema: JSONSchema;
  /** Execute the tool - returns the output directly, or throws on error */
  execute(input: unknown): Promise<unknown>;
  /** Optional validation before execution */
  validate?(input: unknown): ValidationResult;
  /** Execution timeout in ms */
  timeout?: number;
  /** Requires human approval before execution */
  requiresApproval?: boolean;
  /** Tool category for organization */
  category?: string;
}

/**
 * MCP tool definition format (for LLM)
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, JSONSchemaProperty>;
    required?: string[];
  };
}

/**
 * Tool executor function type
 */
export type ToolExecutor = (input: unknown) => Promise<ToolResult>;

/**
 * Tool sandbox configuration
 */
export interface SandboxConfig {
  /** Enable sandboxing */
  enabled: boolean;
  /** Allowed file paths (for file operations) */
  allowedPaths?: string[];
  /** Allowed URLs (for network operations) */
  allowedUrls?: string[];
  /** Allowed shell commands */
  allowedCommands?: string[];
  /** Maximum execution time in ms */
  maxExecutionTime?: number;
  /** Maximum memory usage in bytes */
  maxMemory?: number;
  /** Disable network access */
  disableNetwork?: boolean;
  /** Disable file system access */
  disableFileSystem?: boolean;
}

/**
 * Tool registry configuration
 */
export interface ToolRegistryConfig {
  /** Sandbox configuration */
  sandbox?: SandboxConfig;
  /** Default timeout for all tools */
  defaultTimeout?: number;
  /** Whether to require approval for dangerous tools */
  requireApprovalForDangerous?: boolean;
}

/**
 * Built-in tool names
 */
export const BuiltinTools = {
  WEB_FETCH: 'web_fetch',
  WEB_SEARCH: 'web_search',
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  SHELL_EXEC: 'shell_exec',
  SOLANA_QUERY: 'solana_query',
  SOLANA_SEND_TX: 'solana_send_tx',
} as const;

/**
 * Tool categories
 */
export const ToolCategory = {
  EXTERNAL: 'external',
  FILESYSTEM: 'filesystem',
  SYSTEM: 'system',
  BLOCKCHAIN: 'blockchain',
  CUSTOM: 'custom',
} as const;

/**
 * Approval callback for tools requiring human approval
 */
export type ToolApprovalCallback = (
  tool: Tool,
  input: unknown,
  context: { taskId?: Buffer; reason: string }
) => Promise<boolean>;
