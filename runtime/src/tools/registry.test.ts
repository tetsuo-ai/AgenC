import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from './registry.js';
import { ToolNotFoundError, ToolAlreadyRegisteredError } from './errors.js';
import type { Tool, ToolResult } from './types.js';

function makeTool(name: string, overrides?: Partial<Tool>): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: overrides?.execute ?? (async () => ({ content: `result from ${name}` })),
    ...overrides,
  };
}

describe('ToolRegistry', () => {
  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  it('registers and retrieves a tool', () => {
    const registry = new ToolRegistry();
    const tool = makeTool('test.echo');
    registry.register(tool);

    expect(registry.get('test.echo')).toBe(tool);
    expect(registry.size).toBe(1);
  });

  it('throws on duplicate registration', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('test.echo'));

    expect(() => registry.register(makeTool('test.echo'))).toThrow(ToolAlreadyRegisteredError);
  });

  it('registerAll registers multiple tools', () => {
    const registry = new ToolRegistry();
    registry.registerAll([makeTool('a'), makeTool('b'), makeTool('c')]);
    expect(registry.size).toBe(3);
  });

  // --------------------------------------------------------------------------
  // Unregistration
  // --------------------------------------------------------------------------

  it('unregister removes a tool', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('test.echo'));

    expect(registry.unregister('test.echo')).toBe(true);
    expect(registry.get('test.echo')).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('unregister returns false for unknown tool', () => {
    const registry = new ToolRegistry();
    expect(registry.unregister('nope')).toBe(false);
  });

  // --------------------------------------------------------------------------
  // Lookup
  // --------------------------------------------------------------------------

  it('get returns undefined for unknown tool', () => {
    const registry = new ToolRegistry();
    expect(registry.get('nope')).toBeUndefined();
  });

  it('getOrThrow throws for unknown tool', () => {
    const registry = new ToolRegistry();
    expect(() => registry.getOrThrow('nope')).toThrow(ToolNotFoundError);
  });

  it('listNames returns all names', () => {
    const registry = new ToolRegistry();
    registry.registerAll([makeTool('b'), makeTool('a')]);
    expect(registry.listNames()).toEqual(['b', 'a']);
  });

  it('listAll returns all tools', () => {
    const registry = new ToolRegistry();
    const tools = [makeTool('x'), makeTool('y')];
    registry.registerAll(tools);
    expect(registry.listAll()).toEqual(tools);
  });

  // --------------------------------------------------------------------------
  // toLLMTools
  // --------------------------------------------------------------------------

  it('toLLMTools maps tools correctly', () => {
    const registry = new ToolRegistry();
    const schema = { type: 'object', properties: { q: { type: 'string' } } };
    registry.register(makeTool('test.search', {
      description: 'Search things',
      inputSchema: schema,
    }));

    const llmTools = registry.toLLMTools();
    expect(llmTools).toHaveLength(1);
    expect(llmTools[0]).toEqual({
      type: 'function',
      function: {
        name: 'test.search',
        description: 'Search things',
        parameters: schema,
      },
    });
  });

  it('toLLMTools returns empty array when no tools', () => {
    const registry = new ToolRegistry();
    expect(registry.toLLMTools()).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // createToolHandler
  // --------------------------------------------------------------------------

  it('createToolHandler dispatches to correct tool', async () => {
    const registry = new ToolRegistry();
    const executeFn = vi.fn(async (): Promise<ToolResult> => ({
      content: '{"status":"ok"}',
    }));
    registry.register(makeTool('test.run', { execute: executeFn }));

    const handler = registry.createToolHandler();
    const result = await handler('test.run', { foo: 'bar' });

    expect(executeFn).toHaveBeenCalledWith({ foo: 'bar' });
    expect(result).toBe('{"status":"ok"}');
  });

  it('createToolHandler returns error JSON for unknown tool', async () => {
    const registry = new ToolRegistry();
    const handler = registry.createToolHandler();
    const result = await handler('nope', {});

    expect(JSON.parse(result)).toEqual({ error: 'Tool not found: "nope"' });
  });

  it('createToolHandler catches thrown errors', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('test.fail', {
      execute: async () => { throw new Error('boom'); },
    }));

    const handler = registry.createToolHandler();
    const result = await handler('test.fail', {});

    expect(JSON.parse(result)).toEqual({ error: 'boom' });
  });

  it('createToolHandler returns error content from tool', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('test.soft-fail', {
      execute: async (): Promise<ToolResult> => ({
        content: '{"error":"invalid input"}',
        isError: true,
      }),
    }));

    const handler = registry.createToolHandler();
    const result = await handler('test.soft-fail', {});

    expect(result).toBe('{"error":"invalid input"}');
  });
});
