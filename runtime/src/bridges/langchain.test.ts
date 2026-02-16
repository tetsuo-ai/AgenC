import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../tools/registry.js';
import type { Tool } from '../tools/types.js';
import { LangChainBridge } from './langchain.js';
import { BridgeError } from './errors.js';

function makeTool(name: string, overrides?: Partial<Tool>): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: {} },
    execute: overrides?.execute ?? (async () => ({ content: `result from ${name}` })),
  };
}

describe('LangChainBridge', () => {
  it('converts all registered tools', () => {
    const registry = new ToolRegistry();
    registry.registerAll([makeTool('a.one'), makeTool('b.two')]);
    const bridge = new LangChainBridge(registry);

    const tools = bridge.toLangChainTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('a.one');
    expect(tools[1].name).toBe('b.two');
  });

  it('converts a single tool by name', () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('test.echo'));
    const bridge = new LangChainBridge(registry);

    const tool = bridge.convertTool('test.echo');
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe('test.echo');
    expect(tool!.description).toBe('Test tool: test.echo');
  });

  it('returns null for unknown tool', () => {
    const registry = new ToolRegistry();
    const bridge = new LangChainBridge(registry);

    expect(bridge.convertTool('nope')).toBeNull();
  });

  it('call() delegates to underlying tool with JSON input', async () => {
    const executeFn = vi.fn(async () => ({ content: '{"answer":42}' }));
    const registry = new ToolRegistry();
    registry.register(makeTool('calc.add', { execute: executeFn }));
    const bridge = new LangChainBridge(registry);

    const tool = bridge.convertTool('calc.add')!;
    const result = await tool.call('{"a":1,"b":2}');

    expect(result).toBe('{"answer":42}');
    expect(executeFn).toHaveBeenCalledWith({ a: 1, b: 2 });
  });

  it('call() handles non-JSON input as raw string', async () => {
    const executeFn = vi.fn(async () => ({ content: 'hello' }));
    const registry = new ToolRegistry();
    registry.register(makeTool('echo', { execute: executeFn }));
    const bridge = new LangChainBridge(registry);

    const tool = bridge.convertTool('echo')!;
    const result = await tool.call('plain text');

    expect(result).toBe('hello');
    expect(executeFn).toHaveBeenCalledWith({ input: 'plain text' });
  });

  it('call() returns error content when tool reports isError', async () => {
    const executeFn = vi.fn(async () => ({ content: 'something broke', isError: true }));
    const registry = new ToolRegistry();
    registry.register(makeTool('failing', { execute: executeFn }));
    const bridge = new LangChainBridge(registry);

    const tool = bridge.convertTool('failing')!;
    const result = await tool.call('{}');

    expect(result).toBe('something broke');
  });

  it('call() throws BridgeError if tool is unregistered between convert and call', async () => {
    const registry = new ToolRegistry();
    registry.register(makeTool('temp'));
    const bridge = new LangChainBridge(registry);

    const tool = bridge.convertTool('temp')!;
    registry.unregister('temp');

    await expect(tool.call('{}')).rejects.toThrow(BridgeError);
  });

  it('returns empty array when registry is empty', () => {
    const registry = new ToolRegistry();
    const bridge = new LangChainBridge(registry);

    expect(bridge.toLangChainTools()).toEqual([]);
  });

  it('preserves tool description in converted tools', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'custom',
      description: 'A custom description',
      inputSchema: {},
      execute: async () => ({ content: '' }),
    });
    const bridge = new LangChainBridge(registry);

    const tools = bridge.toLangChainTools();
    expect(tools[0].description).toBe('A custom description');
  });
});
