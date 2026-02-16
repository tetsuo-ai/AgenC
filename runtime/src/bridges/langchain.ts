/**
 * LangChain bridge adapter.
 *
 * Wraps ToolRegistry tools as LangChain-compatible tool objects
 * without requiring the langchain package as a dependency.
 *
 * @module
 */

import type { ToolRegistry } from '../tools/registry.js';
import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';
import type { LangChainTool, LangChainBridgeConfig } from './types.js';
import { BridgeError } from './errors.js';

/**
 * Bridge that converts AgenC ToolRegistry tools into LangChain-compatible
 * tool objects.
 *
 * The produced {@link LangChainTool} objects match the shape expected by
 * LangChain's `DynamicTool` constructor — they are plain objects with a
 * `call(input: string)` method, not LangChain class instances.
 *
 * @example
 * ```typescript
 * const bridge = new LangChainBridge(registry);
 * const tools = bridge.toLangChainTools();
 * // Pass tools to LangChain agent or chain
 * ```
 */
export class LangChainBridge {
  private readonly registry: ToolRegistry;
  private readonly logger: Logger;

  constructor(registry: ToolRegistry, config?: LangChainBridgeConfig) {
    this.registry = registry;
    this.logger = config?.logger ?? silentLogger;
  }

  /**
   * Convert all registered tools to LangChain-compatible tool objects.
   */
  toLangChainTools(): LangChainTool[] {
    const tools = this.registry.listAll();
    const result: LangChainTool[] = [];
    for (const tool of tools) {
      result.push(this.wrapTool(tool.name, tool.description));
    }
    this.logger.info(`Converted ${result.length} tool(s) to LangChain format`);
    return result;
  }

  /**
   * Convert a single tool by name.
   *
   * @returns The LangChain-compatible tool, or `null` if the tool is not registered.
   */
  convertTool(name: string): LangChainTool | null {
    const tool = this.registry.get(name);
    if (!tool) {
      this.logger.debug(`Tool not found for LangChain conversion: "${name}"`);
      return null;
    }
    return this.wrapTool(tool.name, tool.description);
  }

  private wrapTool(name: string, description: string): LangChainTool {
    const registry = this.registry;
    const logger = this.logger;

    return {
      name,
      description,
      async call(input: string): Promise<string> {
        const tool = registry.get(name);
        if (!tool) {
          throw new BridgeError('langchain', `Tool "${name}" no longer registered`);
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(input) as Record<string, unknown>;
        } catch {
          // LangChain may pass a plain string for single-argument tools
          args = { input };
        }

        logger.debug(`LangChain call: ${name}`);
        const result = await tool.execute(args);
        if (result.isError) {
          logger.warn(`LangChain tool "${name}" returned error: ${result.content}`);
        }
        return result.content;
      },
    };
  }
}
