/**
 * Tool Registry with MCP compatibility
 *
 * Manages tool registration, discovery, and execution with sandboxing support.
 */

import type {
  Tool,
  ToolCall,
  ToolResult,
  MCPToolDefinition,
  SandboxConfig,
} from '../types/tools';

export interface ToolRegistryConfig {
  /** Enable sandboxed execution */
  sandbox?: SandboxConfig;
  /** Timeout for tool execution in ms */
  defaultTimeout?: number;
  /** Maximum concurrent tool executions */
  maxConcurrent?: number;
}

interface RegisteredTool extends Tool {
  /** When the tool was registered */
  registeredAt: number;
  /** Execution count */
  executionCount: number;
  /** Total execution time in ms */
  totalExecutionTime: number;
  /** Last error if any */
  lastError?: string;
}

/**
 * Tool Registry for managing and executing tools
 */
export class ToolRegistry {
  private tools: Map<string, RegisteredTool> = new Map();
  private config: Required<ToolRegistryConfig>;
  private activeExecutions: number = 0;

  constructor(config: ToolRegistryConfig = {}) {
    this.config = {
      sandbox: config.sandbox ?? { enabled: false },
      defaultTimeout: config.defaultTimeout ?? 30000,
      maxConcurrent: config.maxConcurrent ?? 10,
    };
  }

  /**
   * Register a tool
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool '${tool.name}' is already registered`);
    }

    this.validateTool(tool);

    this.tools.set(tool.name, {
      ...tool,
      registeredAt: Date.now(),
      executionCount: 0,
      totalExecutionTime: 0,
    });
  }

  /**
   * Register multiple tools at once
   */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Unregister a tool
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Get a tool by name
   */
  get(name: string): Tool | undefined {
    const registered = this.tools.get(name);
    if (!registered) return undefined;

    // Return without internal tracking fields
    const { registeredAt, executionCount, totalExecutionTime, lastError, ...tool } = registered;
    return tool;
  }

  /**
   * Check if a tool exists
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * List all registered tools
   */
  list(): Tool[] {
    return Array.from(this.tools.values()).map(
      ({ registeredAt, executionCount, totalExecutionTime, lastError, ...tool }) => tool
    );
  }

  /**
   * Get tools in MCP format
   */
  toMCPFormat(): MCPToolDefinition[] {
    return this.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        properties: tool.inputSchema.properties,
        required: tool.inputSchema.required,
      },
    }));
  }

  /**
   * Execute a tool call
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        toolCallId: call.id,
        success: false,
        error: `Tool '${call.name}' not found`,
      };
    }

    // Check concurrent execution limit
    if (this.activeExecutions >= this.config.maxConcurrent) {
      return {
        toolCallId: call.id,
        success: false,
        error: 'Too many concurrent tool executions',
      };
    }

    this.activeExecutions++;
    const startTime = Date.now();

    try {
      // Validate input against schema
      const validationError = this.validateInput(tool, call.input);
      if (validationError) {
        return {
          toolCallId: call.id,
          success: false,
          error: validationError,
        };
      }

      // Execute with timeout
      const result = await this.executeWithTimeout(
        tool,
        call.input,
        this.config.defaultTimeout
      );

      // Update stats
      tool.executionCount++;
      tool.totalExecutionTime += Date.now() - startTime;

      return {
        toolCallId: call.id,
        success: true,
        output: result,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      tool.lastError = errorMessage;

      return {
        toolCallId: call.id,
        success: false,
        error: errorMessage,
      };
    } finally {
      this.activeExecutions--;
    }
  }

  /**
   * Execute multiple tool calls
   */
  async executeAll(calls: ToolCall[]): Promise<ToolResult[]> {
    return Promise.all(calls.map((call) => this.execute(call)));
  }

  /**
   * Get tool statistics
   */
  getStats(name: string): { executionCount: number; avgExecutionTime: number; lastError?: string } | undefined {
    const tool = this.tools.get(name);
    if (!tool) return undefined;

    return {
      executionCount: tool.executionCount,
      avgExecutionTime: tool.executionCount > 0
        ? tool.totalExecutionTime / tool.executionCount
        : 0,
      lastError: tool.lastError,
    };
  }

  /**
   * Clear all registered tools
   */
  clear(): void {
    this.tools.clear();
  }

  /**
   * Validate a tool definition
   */
  private validateTool(tool: Tool): void {
    if (!tool.name || typeof tool.name !== 'string') {
      throw new Error('Tool must have a valid name');
    }

    if (!tool.description || typeof tool.description !== 'string') {
      throw new Error('Tool must have a valid description');
    }

    if (typeof tool.execute !== 'function') {
      throw new Error('Tool must have an execute function');
    }

    if (!tool.inputSchema || typeof tool.inputSchema !== 'object') {
      throw new Error('Tool must have a valid inputSchema');
    }
  }

  /**
   * Validate input against tool schema
   */
  private validateInput(tool: Tool, input: unknown): string | null {
    if (typeof input !== 'object' || input === null) {
      return 'Input must be an object';
    }

    const inputObj = input as Record<string, unknown>;
    const required = tool.inputSchema.required ?? [];

    for (const field of required) {
      if (!(field in inputObj)) {
        return `Missing required field: ${field}`;
      }
    }

    return null;
  }

  /**
   * Execute a tool with timeout
   */
  private async executeWithTimeout(
    tool: Tool,
    input: unknown,
    timeout: number
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Tool execution timed out after ${timeout}ms`));
      }, timeout);

      Promise.resolve(tool.execute(input))
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }
}
