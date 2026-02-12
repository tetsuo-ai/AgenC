/**
 * Tests for AgentBuilder and BuiltAgent
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';

// Mock all external modules BEFORE imports
vi.mock('./llm/grok/adapter.js', () => ({
  GrokProvider: vi.fn().mockImplementation((config: Record<string, unknown>) => ({
    name: 'grok',
    config,
    chat: vi.fn(),
    chatStream: vi.fn(),
    healthCheck: vi.fn(),
  })),
}));

vi.mock('./llm/anthropic/adapter.js', () => ({
  AnthropicProvider: vi.fn().mockImplementation((config: Record<string, unknown>) => ({
    name: 'anthropic',
    config,
    chat: vi.fn(),
    chatStream: vi.fn(),
    healthCheck: vi.fn(),
  })),
}));

vi.mock('./llm/ollama/adapter.js', () => ({
  OllamaProvider: vi.fn().mockImplementation((config: Record<string, unknown>) => ({
    name: 'ollama',
    config,
    chat: vi.fn(),
    chatStream: vi.fn(),
    healthCheck: vi.fn(),
  })),
}));

vi.mock('./llm/executor.js', () => ({
  LLMTaskExecutor: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue([1n, 2n, 3n, 4n]),
    canExecute: vi.fn().mockReturnValue(true),
  })),
}));

vi.mock('./memory/in-memory/backend.js', () => ({
  InMemoryBackend: vi.fn().mockImplementation(() => ({
    addEntry: vi.fn(),
    getThread: vi.fn(),
    query: vi.fn(),
    deleteThread: vi.fn(),
    listSessions: vi.fn(),
    set: vi.fn(),
    get: vi.fn(),
    delete: vi.fn(),
    has: vi.fn(),
    listKeys: vi.fn(),
    clear: vi.fn(),
    close: vi.fn(),
    healthCheck: vi.fn(),
  })),
}));

vi.mock('./memory/sqlite/backend.js', () => ({
  SqliteBackend: vi.fn().mockImplementation(() => ({
    close: vi.fn(),
    healthCheck: vi.fn(),
  })),
}));

vi.mock('./memory/redis/backend.js', () => ({
  RedisBackend: vi.fn().mockImplementation(() => ({
    close: vi.fn(),
    healthCheck: vi.fn(),
  })),
}));

vi.mock('./proof/engine.js', () => ({
  ProofEngine: vi.fn().mockImplementation(() => ({
    generate: vi.fn(),
    verify: vi.fn(),
    computeHashes: vi.fn(),
    generateSalt: vi.fn().mockReturnValue(42n),
    getStats: vi.fn(),
    checkTools: vi.fn(),
    clearCache: vi.fn(),
  })),
}));

vi.mock('./autonomous/agent.js', () => ({
  AutonomousAgent: vi.fn().mockImplementation((config: Record<string, unknown>) => ({
    _config: config,
    start: vi.fn().mockResolvedValue({ agentId: new Uint8Array(32), status: 1 }),
    stop: vi.fn().mockResolvedValue(undefined),
    getStats: vi.fn().mockReturnValue({
      tasksDiscovered: 0,
      tasksClaimed: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      totalEarnings: 0n,
      activeTasks: 0,
      avgCompletionTimeMs: 0,
      uptimeMs: 0,
    }),
    getProgram: vi.fn().mockReturnValue(null),
    getAgentPda: vi.fn().mockReturnValue(null),
    getAgentId: vi.fn().mockReturnValue(null),
    getAgentManager: vi.fn().mockReturnValue(null),
  })),
}));

vi.mock('./tools/agenc/index.js', () => ({
  createAgencTools: vi.fn().mockReturnValue([
    { name: 'agenc.listTasks', description: 'List tasks', inputSchema: {}, execute: vi.fn() },
    { name: 'agenc.getTask', description: 'Get task', inputSchema: {}, execute: vi.fn() },
    { name: 'agenc.getAgent', description: 'Get agent', inputSchema: {}, execute: vi.fn() },
    { name: 'agenc.getProtocolConfig', description: 'Get config', inputSchema: {}, execute: vi.fn() },
  ]),
}));

let skillToolCounter = 0;
vi.mock('./tools/skill-adapter.js', () => ({
  skillToTools: vi.fn().mockImplementation((skill: { metadata: { name: string } }) => {
    skillToolCounter++;
    return [
      { name: `${skill.metadata.name}.action${skillToolCounter}`, description: 'Action', inputSchema: {}, execute: vi.fn() },
    ];
  }),
}));

vi.mock('./dispute/operations.js', () => ({
  DisputeOperations: vi.fn().mockImplementation(() => ({
    fetchDispute: vi.fn(),
    fetchActiveDisputes: vi.fn(),
  })),
}));

import { AgentBuilder, BuiltAgent } from './builder.js';
import { GrokProvider } from './llm/grok/adapter.js';
import { AnthropicProvider } from './llm/anthropic/adapter.js';
import { OllamaProvider } from './llm/ollama/adapter.js';
import { LLMTaskExecutor } from './llm/executor.js';
import { InMemoryBackend } from './memory/in-memory/backend.js';
import { SqliteBackend } from './memory/sqlite/backend.js';
import { RedisBackend } from './memory/redis/backend.js';
import { ProofEngine } from './proof/engine.js';
import { AutonomousAgent } from './autonomous/agent.js';
import { createAgencTools } from './tools/agenc/index.js';
import { skillToTools } from './tools/skill-adapter.js';
import { DisputeOperations } from './dispute/operations.js';
import type { Skill } from './skills/types.js';
import { SkillState } from './skills/types.js';
import type { TaskExecutor } from './autonomous/types.js';

// Helpers
const mockConnection = { rpcEndpoint: 'http://localhost:8899' } as unknown as Connection;
const mockKeypair = Keypair.generate();
const COMPUTE = 1n << 0n;
const INFERENCE = 1n << 1n;

function createMockSkill(name = 'test-skill'): Skill {
  return {
    metadata: {
      name,
      description: 'Test skill',
      version: '1.0.0' as const,
      requiredCapabilities: 0n,
    },
    state: SkillState.Created,
    initialize: vi.fn().mockImplementation(function (this: { state: SkillState }) {
      (this as { state: SkillState }).state = SkillState.Ready;
      return Promise.resolve();
    }),
    shutdown: vi.fn().mockResolvedValue(undefined),
    getActions: vi.fn().mockReturnValue([]),
    getAction: vi.fn().mockReturnValue(undefined),
  };
}

function createMockExecutor(): TaskExecutor {
  return {
    execute: vi.fn().mockResolvedValue([1n, 2n, 3n, 4n]),
    canExecute: vi.fn().mockReturnValue(true),
  };
}

describe('AgentBuilder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    skillToolCounter = 0;
  });

  // ========================================================================
  // Validation
  // ========================================================================

  describe('validation', () => {
    it('throws without capabilities', async () => {
      const builder = new AgentBuilder(mockConnection, mockKeypair)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' });

      await expect(builder.build()).rejects.toThrow('capabilities required');
    });

    it('throws without executor or LLM', async () => {
      const builder = new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE);

      await expect(builder.build()).rejects.toThrow('executor or LLM required');
    });

    it('builds successfully with executor (no LLM)', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .build();

      expect(agent).toBeInstanceOf(BuiltAgent);
    });

    it('builds successfully with LLM (no executor)', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .build();

      expect(agent).toBeInstanceOf(BuiltAgent);
    });
  });

  // ========================================================================
  // Chaining
  // ========================================================================

  describe('chaining', () => {
    it('all with* methods return this', () => {
      const builder = new AgentBuilder(mockConnection, mockKeypair);

      expect(builder.withCapabilities(COMPUTE)).toBe(builder);
      expect(builder.withStake(1n)).toBe(builder);
      expect(builder.withEndpoint('http://localhost')).toBe(builder);
      expect(builder.withAgentId(new Uint8Array(32))).toBe(builder);
      expect(builder.withProgramId(PublicKey.default)).toBe(builder);
      expect(builder.withLogLevel('info')).toBe(builder);
      expect(builder.withLLM('grok', { apiKey: 'x', model: 'grok-3' })).toBe(builder);
      expect(builder.withExecutor(createMockExecutor())).toBe(builder);
      expect(builder.withMemory('memory')).toBe(builder);
      expect(builder.withProofs()).toBe(builder);
      expect(builder.withTool({ name: 't', description: 'd', inputSchema: {}, execute: vi.fn() })).toBe(builder);
      expect(builder.withSkill(createMockSkill(), {})).toBe(builder);
      expect(builder.withAgencTools()).toBe(builder);
      expect(builder.withTaskFilter({})).toBe(builder);
      expect(builder.withClaimStrategy({ shouldClaim: () => true, priority: () => 0 })).toBe(builder);
      expect(builder.withDiscoveryMode('hybrid')).toBe(builder);
      expect(builder.withScanInterval(3000)).toBe(builder);
      expect(builder.withMaxConcurrentTasks(2)).toBe(builder);
      expect(builder.withSystemPrompt('hello')).toBe(builder);
      expect(builder.withVerifier({ verifier: { verify: vi.fn() } } as any)).toBe(builder);
      expect(builder.withPolicy({ enabled: true })).toBe(builder);
      expect(builder.withCallbacks({})).toBe(builder);
    });
  });

  // ========================================================================
  // Custom executor
  // ========================================================================

  describe('custom executor', () => {
    it('uses provided executor directly, skips LLM creation', async () => {
      const executor = createMockExecutor();

      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(executor)
        .build();

      // AutonomousAgent created with the custom executor
      expect(AutonomousAgent).toHaveBeenCalledTimes(1);
      const config = (AutonomousAgent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(config.executor).toBe(executor);

      // No LLM provider created
      expect(GrokProvider).not.toHaveBeenCalled();
      expect(AnthropicProvider).not.toHaveBeenCalled();
      expect(OllamaProvider).not.toHaveBeenCalled();
      expect(LLMTaskExecutor).not.toHaveBeenCalled();
    });
  });

  // ========================================================================
  // LLM wiring
  // ========================================================================

  describe('LLM wiring', () => {
    it('creates GrokProvider with tools', async () => {
      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'xai-123', model: 'grok-3' })
        .withAgencTools()
        .build();

      expect(GrokProvider).toHaveBeenCalledTimes(1);
      const providerConfig = (GrokProvider as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(providerConfig.apiKey).toBe('xai-123');
      expect(providerConfig.model).toBe('grok-3');
      expect(providerConfig.tools).toBeDefined();
      expect(providerConfig.tools.length).toBe(4); // 4 agenc tools
    });

    it('creates AnthropicProvider', async () => {
      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('anthropic', { apiKey: 'sk-ant-123', model: 'claude-sonnet-4-5-20250929' })
        .build();

      expect(AnthropicProvider).toHaveBeenCalledTimes(1);
      const config = (AnthropicProvider as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(config.apiKey).toBe('sk-ant-123');
    });

    it('creates OllamaProvider', async () => {
      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('ollama', { model: 'llama3', host: 'http://gpu-host:11434' })
        .build();

      expect(OllamaProvider).toHaveBeenCalledTimes(1);
      const config = (OllamaProvider as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(config.host).toBe('http://gpu-host:11434');
    });

    it('wires LLMTaskExecutor with toolHandler from registry', async () => {
      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withAgencTools()
        .build();

      expect(LLMTaskExecutor).toHaveBeenCalledTimes(1);
      const executorConfig = (LLMTaskExecutor as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executorConfig.provider).toBeDefined();
      expect(executorConfig.toolHandler).toBeDefined();
      expect(typeof executorConfig.toolHandler).toBe('function');
    });

    it('passes systemPrompt to LLMTaskExecutor', async () => {
      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withSystemPrompt('You are a helpful agent')
        .build();

      const executorConfig = (LLMTaskExecutor as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executorConfig.systemPrompt).toBe('You are a helpful agent');
    });
  });

  // ========================================================================
  // Tool wiring
  // ========================================================================

  describe('tool wiring', () => {
    it('registers agenc tools', async () => {
      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withAgencTools()
        .build();

      expect(createAgencTools).toHaveBeenCalledTimes(1);
    });

    it('registers custom tools', async () => {
      const customTool = {
        name: 'custom.myTool',
        description: 'A custom tool',
        inputSchema: { type: 'object' },
        execute: vi.fn(),
      };

      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withTool(customTool)
        .build();

      expect(agent.toolRegistry).toBeDefined();
    });

    it('no tool registry when no tools configured', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .build();

      expect(agent.toolRegistry).toBeUndefined();
    });
  });

  // ========================================================================
  // Skills
  // ========================================================================

  describe('skills', () => {
    it('initializes skills during build', async () => {
      const skill = createMockSkill();
      const schemas = { action1: { type: 'object' } };

      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withSkill(skill, schemas)
        .build();

      expect(skill.initialize).toHaveBeenCalledTimes(1);
      expect(skillToTools).toHaveBeenCalledWith(skill, { schemas });
    });

    it('shuts down skills on stop()', async () => {
      const skill = createMockSkill();

      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withSkill(skill, {})
        .build();

      await agent.stop();

      expect(skill.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // Memory
  // ========================================================================

  describe('memory', () => {
    it('creates InMemoryBackend', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .withMemory('memory', { maxEntriesPerSession: 500 })
        .build();

      expect(InMemoryBackend).toHaveBeenCalledTimes(1);
      expect(agent.memory).toBeDefined();
    });

    it('creates SqliteBackend', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .withMemory('sqlite', { dbPath: ':memory:' })
        .build();

      expect(SqliteBackend).toHaveBeenCalledTimes(1);
      expect(agent.memory).toBeDefined();
    });

    it('creates RedisBackend', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .withMemory('redis', { host: 'localhost' })
        .build();

      expect(RedisBackend).toHaveBeenCalledTimes(1);
      expect(agent.memory).toBeDefined();
    });

    it('no memory when not configured', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .build();

      expect(agent.memory).toBeUndefined();
    });

    it('closes memory on stop()', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .withMemory('memory')
        .build();

      await agent.stop();
      expect(agent.memory!.close).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // Proofs
  // ========================================================================

  describe('proofs', () => {
    it('creates ProofEngine with config', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .withProofs({ cache: { ttlMs: 300_000, maxEntries: 100 } })
        .build();

      expect(ProofEngine).toHaveBeenCalledTimes(1);
      expect(agent.proofEngine).toBeDefined();
    });

    it('passes proofEngine to AutonomousAgent config', async () => {
      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .withProofs()
        .build();

      const config = (AutonomousAgent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(config.proofEngine).toBeDefined();
    });

    it('no proofEngine when not configured', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .build();

      expect(agent.proofEngine).toBeUndefined();
    });

    it('clears proof cache on stop()', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .withProofs()
        .build();

      await agent.stop();
      expect(agent.proofEngine!.clearCache).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // AutonomousAgent configuration
  // ========================================================================

  describe('autonomous agent config', () => {
    it('passes all configuration to AutonomousAgent', async () => {
      const filter: TaskFilter = { minReward: 10n };
      const strategy = { shouldClaim: () => true, priority: () => 1 };
      const verifier = { verify: vi.fn().mockResolvedValue({ verdict: 'pass', confidence: 0.9, reasons: [{ code: 'ok', message: 'ok' }] }) };
      const verifierConfig = {
        verifier,
        maxVerificationRetries: 2,
      };
      const callbacks = {
        onTaskCompleted: vi.fn(),
        onEarnings: vi.fn(),
        onVerifierVerdict: vi.fn(),
        onTaskEscalated: vi.fn(),
        onPolicyViolation: vi.fn(),
      };

      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE | INFERENCE)
        .withStake(1_000_000_000n)
        .withEndpoint('https://my-agent.example.com')
        .withProgramId(PublicKey.default)
        .withLogLevel('info')
        .withExecutor(createMockExecutor())
        .withTaskFilter(filter)
        .withClaimStrategy(strategy)
        .withDiscoveryMode('polling')
        .withScanInterval(3000)
        .withMaxConcurrentTasks(2)
        .withVerifier(verifierConfig as any)
        .withPolicy({ enabled: true })
        .withCallbacks(callbacks)
        .build();

      const config = (AutonomousAgent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(config.capabilities).toBe(COMPUTE | INFERENCE);
      expect(config.initialStake).toBe(1_000_000_000n);
      expect(config.endpoint).toBe('https://my-agent.example.com');
      expect(config.programId).toEqual(PublicKey.default);
      expect(config.logLevel).toBe('info');
      expect(config.taskFilter).toBe(filter);
      expect(config.claimStrategy).toBe(strategy);
      expect(config.discoveryMode).toBe('polling');
      expect(config.scanIntervalMs).toBe(3000);
      expect(config.maxConcurrentTasks).toBe(2);
      expect(config.verifier).toBe(verifierConfig);
      expect(config.policyEngine).toBeDefined();
      expect(config.onTaskCompleted).toBe(callbacks.onTaskCompleted);
      expect(config.onEarnings).toBe(callbacks.onEarnings);
      expect(config.onVerifierVerdict).toBe(callbacks.onVerifierVerdict);
      expect(config.onTaskEscalated).toBe(callbacks.onTaskEscalated);
      expect(config.onPolicyViolation).toBe(callbacks.onPolicyViolation);
    });

    it('passes agentId when configured', async () => {
      const agentId = new Uint8Array(32).fill(42);

      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withAgentId(agentId)
        .withExecutor(createMockExecutor())
        .build();

      const config = (AutonomousAgent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(config.agentId).toBe(agentId);
    });
  });

  // ========================================================================
  // BuiltAgent lifecycle
  // ========================================================================

  describe('BuiltAgent lifecycle', () => {
    it('start() delegates to autonomous.start()', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .build();

      await agent.start();

      expect(agent.autonomous.start).toHaveBeenCalledTimes(1);
    });

    it('stop() cleans up all resources', async () => {
      const skill = createMockSkill();
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withSkill(skill, {})
        .withMemory('memory')
        .withProofs()
        .build();

      await agent.stop();

      expect(agent.autonomous.stop).toHaveBeenCalledTimes(1);
      expect(skill.shutdown).toHaveBeenCalledTimes(1);
      expect(agent.memory!.close).toHaveBeenCalledTimes(1);
      expect(agent.proofEngine!.clearCache).toHaveBeenCalledTimes(1);
    });

    it('stop() continues cleanup even if autonomous.stop() throws', async () => {
      const skill = createMockSkill();
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withSkill(skill, {})
        .withMemory('memory')
        .withProofs()
        .build();

      // Make autonomous.stop() throw
      (agent.autonomous.stop as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('stop failed')
      );

      // Should not throw
      await agent.stop();

      // All other cleanup still happened
      expect(skill.shutdown).toHaveBeenCalledTimes(1);
      expect(agent.memory!.close).toHaveBeenCalledTimes(1);
      expect(agent.proofEngine!.clearCache).toHaveBeenCalledTimes(1);
    });

    it('stop() continues cleanup even if skill.shutdown() throws', async () => {
      const skill1 = createMockSkill('skill-1');
      const skill2 = createMockSkill('skill-2');
      (skill1.shutdown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('skill shutdown failed')
      );

      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withSkill(skill1, {})
        .withSkill(skill2, {})
        .build();

      await agent.stop();

      // Both skills attempted shutdown
      expect(skill1.shutdown).toHaveBeenCalledTimes(1);
      expect(skill2.shutdown).toHaveBeenCalledTimes(1);
    });

    it('getStats() delegates to autonomous.getStats()', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .build();

      const stats = agent.getStats();
      expect(stats.tasksDiscovered).toBe(0);
      expect(agent.autonomous.getStats).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // DisputeOperations lazy creation
  // ========================================================================

  describe('getDisputeOps()', () => {
    it('throws before start() when program is null', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .build();

      expect(() => agent.getDisputeOps()).toThrow('Agent not started');
    });

    it('creates DisputeOperations after start() with program and agentId', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .build();

      // Simulate post-start state
      const mockProgram = { programId: PublicKey.default };
      const mockAgentId = new Uint8Array(32).fill(1);
      (agent.autonomous.getProgram as ReturnType<typeof vi.fn>).mockReturnValue(mockProgram);
      (agent.autonomous.getAgentId as ReturnType<typeof vi.fn>).mockReturnValue(mockAgentId);

      const ops = agent.getDisputeOps();
      expect(DisputeOperations).toHaveBeenCalledWith({
        program: mockProgram,
        agentId: mockAgentId,
      });
      expect(ops).toBeDefined();
    });

    it('caches DisputeOperations on subsequent calls', async () => {
      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .build();

      (agent.autonomous.getProgram as ReturnType<typeof vi.fn>).mockReturnValue({ programId: PublicKey.default });
      (agent.autonomous.getAgentId as ReturnType<typeof vi.fn>).mockReturnValue(new Uint8Array(32));

      const ops1 = agent.getDisputeOps();
      const ops2 = agent.getDisputeOps();

      expect(ops1).toBe(ops2);
      expect(DisputeOperations).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // Memory wiring
  // ========================================================================

  describe('memory wiring', () => {
    it('passes memory to LLMTaskExecutor when configured', async () => {
      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withMemory('memory')
        .build();

      expect(LLMTaskExecutor).toHaveBeenCalledTimes(1);
      const executorConfig = (LLMTaskExecutor as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executorConfig.memory).toBeDefined();
    });

    it('passes memory to AutonomousAgent config', async () => {
      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withMemory('memory')
        .build();

      const config = (AutonomousAgent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(config.memory).toBeDefined();
    });

    it('same memory instance shared between executor and agent', async () => {
      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withLLM('grok', { apiKey: 'test', model: 'grok-3' })
        .withMemory('memory')
        .build();

      const executorConfig = (LLMTaskExecutor as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      const autonomousConfig = (AutonomousAgent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executorConfig.memory).toBe(autonomousConfig.memory);
    });

    it('does not pass memory to custom executor', async () => {
      await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE)
        .withExecutor(createMockExecutor())
        .withMemory('memory')
        .build();

      // Custom executor path skips LLMTaskExecutor, so no memory passing to executor
      expect(LLMTaskExecutor).not.toHaveBeenCalled();

      // But AutonomousAgent still gets memory for lifecycle journaling
      const config = (AutonomousAgent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(config.memory).toBeDefined();
    });
  });

  // ========================================================================
  // Full integration (all modules wired)
  // ========================================================================

  describe('full wiring', () => {
    it('wires all modules together', async () => {
      const skill = createMockSkill();
      const callbacks = { onTaskCompleted: vi.fn() };

      const agent = await new AgentBuilder(mockConnection, mockKeypair)
        .withCapabilities(COMPUTE | INFERENCE)
        .withStake(1_000_000_000n)
        .withLLM('grok', { apiKey: 'xai-123', model: 'grok-3' })
        .withMemory('memory')
        .withProofs({ cache: { ttlMs: 300_000, maxEntries: 100 } })
        .withSkill(skill, { action1: { type: 'object' } })
        .withAgencTools()
        .withTaskFilter({ minReward: 10n })
        .withSystemPrompt('You are an AgenC agent')
        .withCallbacks(callbacks)
        .build();

      // Verify all components created
      expect(agent).toBeInstanceOf(BuiltAgent);
      expect(agent.memory).toBeDefined();
      expect(agent.proofEngine).toBeDefined();
      expect(agent.toolRegistry).toBeDefined();

      // Verify LLM provider got tools
      expect(GrokProvider).toHaveBeenCalledTimes(1);
      const providerConfig = (GrokProvider as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(providerConfig.tools.length).toBeGreaterThan(0);

      // Verify skill initialized
      expect(skill.initialize).toHaveBeenCalledTimes(1);

      // Verify executor wired with tool handler
      expect(LLMTaskExecutor).toHaveBeenCalledTimes(1);
      const executorConfig = (LLMTaskExecutor as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(executorConfig.systemPrompt).toBe('You are an AgenC agent');
      expect(executorConfig.toolHandler).toBeDefined();

      // Verify autonomous agent config
      const autonomousConfig = (AutonomousAgent as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(autonomousConfig.capabilities).toBe(COMPUTE | INFERENCE);
      expect(autonomousConfig.initialStake).toBe(1_000_000_000n);
      expect(autonomousConfig.proofEngine).toBeDefined();
      expect(autonomousConfig.taskFilter).toEqual({ minReward: 10n });
      expect(autonomousConfig.onTaskCompleted).toBe(callbacks.onTaskCompleted);
    });
  });
});
