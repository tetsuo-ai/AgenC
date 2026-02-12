/**
 * Tool registry for managing tool instances and bridging to LLM system.
 *
 * @module
 */

import type { Tool, ToolRegistryConfig } from './types.js';
import { safeStringify } from './types.js';
import { ToolNotFoundError, ToolAlreadyRegisteredError } from './errors.js';
import type { LLMTool, ToolHandler } from '../llm/types.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import type { PolicyEngine } from '../policy/engine.js';
import type { PolicyAction } from '../policy/types.js';

/**
 * Registry for managing tool instances.
 *
 * Provides the key bridge between the tool system and the LLM system:
 * - {@link toLLMTools} generates `LLMTool[]` for provider configs
 * - {@link createToolHandler} generates a `ToolHandler` for LLMTaskExecutor
 *
 * @example
 * ```typescript
 * const registry = new ToolRegistry({ logger });
 * registry.registerAll(createAgencTools(context));
 * registry.registerAll(skillToTools(jupiterSkill, { schemas: JUPITER_ACTION_SCHEMAS }));
 *
 * const executor = new LLMTaskExecutor({
 *   provider,
 *   tools: registry.toLLMTools(),
 *   toolHandler: registry.createToolHandler(),
 * });
 * ```
 */
export class ToolRegistry {
  private readonly tools: Map<string, Tool> = new Map();
  private readonly logger: Logger;
  private readonly policyEngine?: PolicyEngine;

  constructor(config?: ToolRegistryConfig) {
    this.logger = config?.logger ?? silentLogger;
    this.policyEngine = config?.policyEngine;
  }

  /**
   * Register a single tool. Throws if a tool with the same name exists.
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new ToolAlreadyRegisteredError(tool.name);
    }
    this.tools.set(tool.name, tool);
    this.logger.info(`Tool registered: "${tool.name}"`);
  }

  /**
   * Register multiple tools at once.
   */
  registerAll(tools: ReadonlyArray<Tool>): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * Unregister a tool by name.
   * @returns true if the tool was found and removed, false otherwise
   */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) {
      this.logger.info(`Tool unregistered: "${name}"`);
    }
    return removed;
  }

  /**
   * Get a tool by name.
   * @returns The tool, or undefined if not found
   */
  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Get a tool by name, throwing if not found.
   */
  getOrThrow(name: string): Tool {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new ToolNotFoundError(name);
    }
    return tool;
  }

  /**
   * List all registered tool names.
   */
  listNames(): string[] {
    return Array.from(this.tools.keys());
  }

  /**
   * List all registered tools.
   */
  listAll(): ReadonlyArray<Tool> {
    return Array.from(this.tools.values());
  }

  /**
   * Number of registered tools.
   */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Generate LLMTool definitions for registered tools.
   *
   * When `allowedTools` is provided, only tools whose names are in the set
   * are included. This prevents the LLM from knowing about disallowed tools.
   *
   * Use the result as the `tools` config for an LLM provider.
   */
  toLLMTools(allowedTools?: ReadonlySet<string>): LLMTool[] {
    const result: LLMTool[] = [];
    for (const tool of this.tools.values()) {
      if (allowedTools && !allowedTools.has(tool.name)) continue;
      result.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      });
    }
    return result;
  }

  /**
   * Create a ToolHandler closure for the LLM executor.
   *
   * The returned handler:
   * 1. Looks up the tool by name
   * 2. Calls `tool.execute(args)`
   * 3. Returns `result.content` on success
   * 4. Returns JSON error string on failure (never throws — LLM needs errors as content)
   */
  createToolHandler(): ToolHandler {
    return async (name: string, args: Record<string, unknown>): Promise<string> => {
      const tool = this.tools.get(name);
      if (!tool) {
        this.logger.warn(`Tool not found: "${name}"`);
        return safeStringify({ error: `Tool not found: "${name}"` });
      }

      if (this.policyEngine) {
        const action: PolicyAction = {
          type: 'tool_call',
          name,
          access: inferToolAccess(name),
          metadata: { args },
        };
        const decision = this.policyEngine.evaluate(action);
        if (!decision.allowed) {
          const violation = decision.violations[0];
          this.logger.warn(
            `Tool "${name}" blocked by policy (${violation?.code ?? 'unknown'})`,
          );
          return safeStringify({
            error: violation?.message ?? 'Tool blocked by policy',
            violation,
          });
        }
      }

      try {
        const result = await tool.execute(args);
        if (result.isError) {
          this.logger.warn(`Tool "${name}" returned error: ${result.content}`);
        }
        return result.content;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(`Tool "${name}" threw: ${message}`);
        return safeStringify({ error: message });
      }
    };
  }
}

function inferToolAccess(toolName: string): 'read' | 'write' {
  const name = toolName.toLowerCase();
  if (
    name.includes('.get')
    || name.includes('.list')
    || name.includes('.query')
    || name.includes('.inspect')
    || name.includes('.status')
  ) {
    return 'read';
  }
  return 'write';
}
