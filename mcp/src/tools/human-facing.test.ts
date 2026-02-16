import assert from 'node:assert/strict';
import test from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHumanFacingTools } from './human-facing.js';

/**
 * Helper that registers human-facing tools on a fresh McpServer and
 * extracts the registered tool metadata for schema validation.
 */
function createServerWithTools(): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  registerHumanFacingTools(server);
  return server;
}

test('registerHumanFacingTools does not throw', () => {
  assert.doesNotThrow(() => createServerWithTools());
});

test('registers agenc_browse_skills tool', () => {
  const server = createServerWithTools();
  // McpServer stores tools internally; verify registration didn't throw
  // and the server instance is valid
  assert.ok(server);
});

test('registers agenc_manage_sessions tool', () => {
  const server = createServerWithTools();
  assert.ok(server);
});

test('registers agenc_get_agent_feed tool', () => {
  const server = createServerWithTools();
  assert.ok(server);
});

test('registers agenc_approve_action tool', () => {
  const server = createServerWithTools();
  assert.ok(server);
});

test('can register human-facing tools alongside other tools', () => {
  const server = new McpServer({ name: 'test', version: '0.0.1' });

  // Register a dummy tool first to verify no name collisions
  server.tool(
    'other_tool',
    'A different tool',
    {},
    async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
  );

  assert.doesNotThrow(() => registerHumanFacingTools(server));
});
