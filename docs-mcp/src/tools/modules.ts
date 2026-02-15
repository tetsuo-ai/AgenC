import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DocEntry } from '../types.js';

const MODULE_TYPES = ['core', 'task', 'ai', 'protocol', 'infrastructure', 'collaboration'] as const;

const MODULE_TEMPLATE = `# {MODULE_NAME} Module

## Directory Structure

\`\`\`
runtime/src/{module_name}/
├── types.ts              # Interfaces, config types, enums
├── errors.ts             # Module-specific error classes
├── {primary}.ts          # Primary class implementation
├── {primary}.test.ts     # Unit tests (vitest)
└── index.ts              # Barrel exports
\`\`\`

## types.ts

\`\`\`typescript
export interface {PrimaryClass}Config {
  /** Connection instance */
  connection: Connection;
  /** Logger instance */
  logger?: Logger;
}
\`\`\`

## errors.ts

\`\`\`typescript
import { RuntimeError, RuntimeErrorCodes } from '../types/errors.js';

export class {PrimaryClass}Error extends RuntimeError {
  constructor(message: string) {
    super(RuntimeErrorCodes.{ERROR_CODE}, message);
  }
}
\`\`\`

## {primary}.ts

\`\`\`typescript
import type { {PrimaryClass}Config } from './types.js';
import type { Logger } from '../utils/logger.js';

export class {PrimaryClass} {
  private readonly logger: Logger;

  constructor(private readonly config: {PrimaryClass}Config) {
    this.logger = config.logger ?? console;
  }
}
\`\`\`

## index.ts

\`\`\`typescript
export * from './types.js';
export * from './errors.js';
export * from './{primary}.js';
\`\`\`

## Wiring

1. Add exports to \`runtime/src/index.ts\`
2. Add \`.with{PrimaryClass}()\` method to \`runtime/src/builder.ts\`
3. Register error codes in \`runtime/src/types/errors.ts\`
`;

const MODULE_INFO: Record<string, { description: string; layer: number; primaryClass: string; errorRange: string; testFile: string }> = {
  agent: { description: 'Agent registration, capabilities, event subscriptions, PDA derivation', layer: 2, primaryClass: 'AgentManager', errorRange: '1-5', testFile: 'agent/manager.test.ts' },
  task: { description: 'Task CRUD, discovery, speculative execution, proof pipeline, DLQ', layer: 3, primaryClass: 'TaskOperations', errorRange: '6-12', testFile: 'task/operations.test.ts' },
  autonomous: { description: 'Autonomous agent loop, task scanner, verifier lanes, risk scoring', layer: 4, primaryClass: 'AutonomousAgent', errorRange: '13-16', testFile: 'autonomous/agent.test.ts' },
  llm: { description: 'LLM provider adapters (Grok, Anthropic, Ollama), task executor', layer: 3, primaryClass: 'LLMTaskExecutor', errorRange: '17-21', testFile: 'llm/executor.test.ts' },
  memory: { description: 'Memory backends (InMemory, SQLite, Redis), thread + KV operations', layer: 3, primaryClass: 'MemoryBackend (interface)', errorRange: '22-24', testFile: 'memory/in-memory/backend.test.ts' },
  proof: { description: 'ZK proof generation, verification, caching (TTL + LRU)', layer: 2, primaryClass: 'ProofEngine', errorRange: '25-27', testFile: 'proof/engine.test.ts' },
  dispute: { description: 'Dispute instructions, PDA derivation, memcmp queries', layer: 2, primaryClass: 'DisputeOperations', errorRange: '28-31', testFile: 'dispute/operations.test.ts' },
  workflow: { description: 'DAG orchestration, goal compilation, optimization, canary rollout', layer: 5, primaryClass: 'DAGOrchestrator', errorRange: '32-35', testFile: 'workflow/orchestrator.test.ts' },
  connection: { description: 'Resilient RPC with retry, failover, request coalescing', layer: 2, primaryClass: 'ConnectionManager', errorRange: '36-37', testFile: 'connection/manager.test.ts' },
  tools: { description: 'MCP-compatible tool registry, built-in AgenC tools, skill adapter', layer: 3, primaryClass: 'ToolRegistry', errorRange: '—', testFile: 'tools/registry.test.ts' },
  skills: { description: 'Skill registry, Jupiter DEX integration', layer: 3, primaryClass: 'SkillRegistry', errorRange: '—', testFile: 'skills/registry.test.ts' },
  events: { description: 'Event subscription, parsing, IDL drift checks', layer: 2, primaryClass: 'EventMonitor', errorRange: '—', testFile: 'events/monitor.test.ts' },
  policy: { description: 'Budget enforcement, circuit breakers, access control', layer: 6, primaryClass: 'PolicyEngine', errorRange: '—', testFile: 'policy/engine.test.ts' },
  team: { description: 'Team contracts, payouts (Fixed/Weighted/Milestone), audit trail', layer: 6, primaryClass: 'TeamContractEngine', errorRange: '—', testFile: 'team/engine.test.ts' },
  marketplace: { description: 'Task bid marketplace, matching engine, bid strategies', layer: 6, primaryClass: 'TaskBidMarketplace', errorRange: '—', testFile: 'marketplace/marketplace.test.ts' },
  eval: { description: 'Benchmark runner, mutation testing, trajectory replay', layer: 6, primaryClass: 'BenchmarkRunner', errorRange: '—', testFile: 'eval/benchmark.test.ts' },
  replay: { description: 'Replay store, projector, incident reconstruction', layer: 6, primaryClass: 'ReplayStore', errorRange: '—', testFile: 'replay/store.test.ts' },
  telemetry: { description: 'Unified metrics collection, pluggable sinks', layer: 6, primaryClass: 'UnifiedTelemetryCollector', errorRange: '—', testFile: 'telemetry/collector.test.ts' },
};

const CONVENTIONS: Record<string, string> = {
  types: `# Type Conventions

- **bigint**: All on-chain u64 values (capabilities, stake, amounts). Use literals: 1n, 0n
- **BN**: Only at Anchor instruction boundary. Convert: new BN(amount.toString())
- **number**: Small values only (status enums 0-5, counts, timestamps as seconds)
- **Uint8Array**: All binary data (agent IDs, task IDs, proofs, hashes)
- **PublicKey**: All Solana addresses. Never store as string except JSON serialization.
- **safeStringify()**: Always use for JSON with bigint values
- **Idl vs AgencCoordination**: Idl for raw JSON, AgencCoordination for Program<T>`,

  testing: `# Testing Conventions

- vitest with co-located .test.ts files
- Mock Program: \`{ methods: { name: vi.fn().mockReturnValue({ accountsPartial: vi.fn().mockReturnValue({ rpc: vi.fn() }) }) } }\`
- silentLogger: \`{ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }\`
- InMemoryBackend for memory tests (zero deps)
- NoopTelemetryCollector for telemetry in tests
- LiteSVM: advanceClock(svm, 61) before updateAgent, getClockTimestamp() not Date.now()`,

  errors: `# Error Handling Conventions

- RuntimeErrorCodes: 37 codes (core 1-16, LLM 17-21, memory 22-24, proof 25-27, dispute 28-31, workflow 32-35, connection 36-37)
- Extend RuntimeError with specific code and typed properties
- Anchor errors: 6000 + enum index. isAnchorError() to detect.
- Never throw raw strings. Always wrap in RuntimeError subclass.
- Use safeStringify() for error serialization (bigint-safe)`,
};

export function registerModuleTools(server: McpServer, docs: Map<string, DocEntry>): void {
  server.tool(
    'docs_get_module_template',
    'Get a boilerplate template for creating a new runtime module with standard file structure, error codes, and barrel exports.',
    {
      module_name: z.string().describe('Module name in lowercase (e.g. "gateway", "social")'),
      module_type: z.enum(MODULE_TYPES).describe('Module category for layer placement'),
    },
    async ({ module_name, module_type }) => {
      const primaryClass = module_name.charAt(0).toUpperCase() + module_name.slice(1) + 'Manager';
      const errorCode = module_name.toUpperCase() + '_ERROR';

      const template = MODULE_TEMPLATE
        .replace(/\{MODULE_NAME\}/g, module_name.charAt(0).toUpperCase() + module_name.slice(1))
        .replace(/\{module_name\}/g, module_name)
        .replace(/\{PrimaryClass\}/g, primaryClass)
        .replace(/\{primary\}/g, module_name)
        .replace(/\{ERROR_CODE\}/g, errorCode);

      return {
        content: [{ type: 'text' as const, text: template }],
      };
    },
  );

  server.tool(
    'docs_get_module_info',
    'Get architecture details about an existing runtime module: description, layer, primary class, error codes, test file.',
    { module: z.string().describe('Module name (e.g. "agent", "task", "llm", "memory", "dispute")') },
    async ({ module: moduleName }) => {
      const info = MODULE_INFO[moduleName];
      if (!info) {
        const available = Object.keys(MODULE_INFO).join(', ');
        return {
          content: [{
            type: 'text' as const,
            text: `Module "${moduleName}" not found. Available modules: ${available}`,
          }],
        };
      }

      const lines = [
        `# Module: ${moduleName}/`,
        '',
        `**Description:** ${info.description}`,
        `**Layer:** ${info.layer}`,
        `**Primary class:** \`${info.primaryClass}\``,
        `**Error code range:** ${info.errorRange}`,
        `**Test file:** \`runtime/src/${info.testFile}\``,
        `**Source:** \`runtime/src/${moduleName}/\``,
      ];

      // Try to find related architecture doc
      const relatedDoc = docs.get(`architecture/runtime-layers.md`);
      if (relatedDoc) {
        const moduleSection = relatedDoc.content.match(new RegExp(`\\|.*\`${moduleName}/\`.*\\|`, 'g'));
        if (moduleSection) {
          lines.push('', '## From Architecture Docs', '');
          for (const line of moduleSection) {
            lines.push(line);
          }
        }
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  server.tool(
    'docs_get_conventions',
    'Get type, testing, or error handling conventions for implementing AgenC code.',
    {
      topic: z.enum(['types', 'testing', 'errors']).optional()
        .describe('Specific topic. Omit to get all conventions.'),
    },
    async ({ topic }) => {
      if (topic) {
        const content = CONVENTIONS[topic];
        return {
          content: [{ type: 'text' as const, text: content ?? `Unknown topic: ${topic}` }],
        };
      }

      // Return all conventions
      const all = Object.values(CONVENTIONS).join('\n\n---\n\n');
      return {
        content: [{ type: 'text' as const, text: all }],
      };
    },
  );
}
