/**
 * Built-in AgenC protocol query tools.
 *
 * Four read-only tools for querying on-chain state:
 * - agenc.listTasks — list tasks with optional status filter
 * - agenc.getTask — fetch a single task by PDA
 * - agenc.getAgent — fetch agent registration by PDA
 * - agenc.getProtocolConfig — fetch protocol configuration
 *
 * @module
 */

import { PublicKey } from '@solana/web3.js';
import type { Program } from '@coral-xyz/anchor';
import type { AgencCoordination } from '../../types/agenc_coordination.js';
import type { Tool, ToolResult } from '../types.js';
import { safeStringify } from '../types.js';
import { TaskOperations } from '../../task/operations.js';
import {
  taskStatusToString,
  taskTypeToString,
  isPrivateTask,
  OnChainTaskStatus,
} from '../../task/types.js';
import { parseAgentState, agentStatusToString } from '../../agent/types.js';
import { getCapabilityNames } from '../../agent/capabilities.js';
import { parseProtocolConfig } from '../../types/protocol.js';
import { findProtocolPda } from '../../agent/pda.js';
import { lamportsToSol, bytesToHex } from '../../utils/encoding.js';
import type { Logger } from '../../utils/logger.js';
import type { OnChainTask } from '../../task/types.js';
import type { AgentState } from '../../agent/types.js';
import type { ProtocolConfig } from '../../types/protocol.js';
import type { SerializedTask, SerializedAgent, SerializedProtocolConfig } from './types.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Return a JSON error ToolResult without throwing.
 */
function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

/**
 * Safely parse a base58 string into a PublicKey.
 * Returns null and an error result if invalid.
 */
function parseBase58(input: unknown): [PublicKey | null, ToolResult | null] {
  if (typeof input !== 'string' || input.length === 0) {
    return [null, errorResult('Missing or invalid address')];
  }
  try {
    return [new PublicKey(input), null];
  } catch {
    return [null, errorResult(`Invalid base58 address: ${input}`)];
  }
}

// ============================================================================
// Serialization Helpers
// ============================================================================

function serializeTask(task: OnChainTask, taskPda: PublicKey): SerializedTask {
  return {
    taskPda: taskPda.toBase58(),
    taskId: bytesToHex(task.taskId),
    creator: task.creator.toBase58(),
    status: taskStatusToString(task.status),
    taskType: taskTypeToString(task.taskType),
    rewardAmount: task.rewardAmount.toString(),
    rewardSol: lamportsToSol(task.rewardAmount),
    requiredCapabilities: getCapabilityNames(task.requiredCapabilities),
    maxWorkers: task.maxWorkers,
    currentWorkers: task.currentWorkers,
    deadline: task.deadline,
    isPrivate: isPrivateTask(task),
    createdAt: task.createdAt,
    completions: task.completions,
    requiredCompletions: task.requiredCompletions,
    description: bytesToHex(task.description),
  };
}

function serializeAgent(agent: AgentState, agentPda: PublicKey): SerializedAgent {
  return {
    agentPda: agentPda.toBase58(),
    agentId: bytesToHex(agent.agentId),
    authority: agent.authority.toBase58(),
    status: agentStatusToString(agent.status),
    capabilities: getCapabilityNames(agent.capabilities),
    endpoint: agent.endpoint,
    stake: agent.stake.toString(),
    activeTasks: agent.activeTasks,
    reputation: agent.reputation,
    tasksCompleted: agent.tasksCompleted.toString(),
    totalEarned: agent.totalEarned.toString(),
  };
}

function serializeProtocolConfig(config: ProtocolConfig): SerializedProtocolConfig {
  return {
    authority: config.authority.toBase58(),
    treasury: config.treasury.toBase58(),
    protocolFeeBps: config.protocolFeeBps,
    disputeThreshold: config.disputeThreshold,
    minAgentStake: config.minAgentStake.toString(),
    minArbiterStake: config.minArbiterStake.toString(),
    maxClaimDuration: config.maxClaimDuration,
    maxDisputeDuration: config.maxDisputeDuration,
    totalAgents: config.totalAgents.toString(),
    totalTasks: config.totalTasks.toString(),
    completedTasks: config.completedTasks.toString(),
    totalValueDistributed: config.totalValueDistributed.toString(),
    taskCreationCooldown: config.taskCreationCooldown,
    maxTasksPer24h: config.maxTasksPer24h,
    disputeInitiationCooldown: config.disputeInitiationCooldown,
    maxDisputesPer24h: config.maxDisputesPer24h,
    minStakeForDispute: config.minStakeForDispute.toString(),
    slashPercentage: config.slashPercentage,
    protocolVersion: config.protocolVersion,
    minSupportedVersion: config.minSupportedVersion,
  };
}

// ============================================================================
// Tool Factory Functions
// ============================================================================

/**
 * Create the agenc.listTasks tool.
 */
export function createListTasksTool(
  ops: TaskOperations,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.listTasks',
    description:
      'List tasks on the AgenC protocol. Filter by status (open, in_progress, all). Returns task details including reward, capabilities, and deadline.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['open', 'in_progress', 'all'],
          description: 'Filter by task status (default: open)',
        },
        limit: {
          type: 'number',
          description: `Maximum tasks to return (default: ${DEFAULT_LIMIT}, max: ${MAX_LIMIT})`,
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      try {
        const status = (args.status as string) || 'open';
        const rawLimit = typeof args.limit === 'number' ? args.limit : DEFAULT_LIMIT;
        const limit = Math.min(Math.max(1, rawLimit), MAX_LIMIT);

        let tasks: Array<{ task: OnChainTask; taskPda: PublicKey }>;

        if (status === 'all') {
          tasks = await ops.fetchAllTasks();
        } else {
          // fetchClaimableTasks uses memcmp filters (scalable)
          const claimable = await ops.fetchClaimableTasks();
          if (status === 'open') {
            tasks = claimable.filter((t) => t.task.status === OnChainTaskStatus.Open);
          } else {
            // in_progress
            tasks = claimable.filter((t) => t.task.status === OnChainTaskStatus.InProgress);
          }
        }

        const limited = tasks.slice(0, limit);
        const serialized = limited.map((t) => serializeTask(t.task, t.taskPda));

        return {
          content: safeStringify({
            count: serialized.length,
            total: tasks.length,
            tasks: serialized,
          }),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`agenc.listTasks failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getTask tool.
 */
export function createGetTaskTool(
  ops: TaskOperations,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.getTask',
    description:
      'Get details for a specific AgenC task by its PDA address (base58).',
    inputSchema: {
      type: 'object',
      properties: {
        taskPda: {
          type: 'string',
          description: 'Task account PDA address (base58)',
        },
      },
      required: ['taskPda'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [pda, err] = parseBase58(args.taskPda);
      if (err) return err;

      try {
        const task = await ops.fetchTask(pda!);
        if (!task) {
          return errorResult(`Task not found: ${pda!.toBase58()}`);
        }
        return { content: safeStringify(serializeTask(task, pda!)) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.getTask failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getAgent tool.
 */
export function createGetAgentTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.getAgent',
    description:
      'Get details for an AgenC agent by its PDA address (base58). Returns status, capabilities, stake, and performance metrics.',
    inputSchema: {
      type: 'object',
      properties: {
        agentPda: {
          type: 'string',
          description: 'Agent registration PDA address (base58)',
        },
      },
      required: ['agentPda'],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const [pda, err] = parseBase58(args.agentPda);
      if (err) return err;

      try {
        const raw = await program.account.agentRegistration.fetch(pda!);
        const agent = parseAgentState(raw);
        return { content: safeStringify(serializeAgent(agent, pda!)) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('Account does not exist') || msg.includes('could not find')) {
          return errorResult(`Agent not found: ${pda!.toBase58()}`);
        }
        logger.error(`agenc.getAgent failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}

/**
 * Create the agenc.getProtocolConfig tool.
 */
export function createGetProtocolConfigTool(
  program: Program<AgencCoordination>,
  logger: Logger,
): Tool {
  return {
    name: 'agenc.getProtocolConfig',
    description:
      'Get the AgenC protocol configuration including fees, stake requirements, rate limits, and protocol version.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(): Promise<ToolResult> {
      try {
        const protocolPda = findProtocolPda(program.programId);
        const raw = await program.account.protocolConfig.fetch(protocolPda);
        const config = parseProtocolConfig(raw);
        return { content: safeStringify(serializeProtocolConfig(config)) };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`agenc.getProtocolConfig failed: ${msg}`);
        return errorResult(msg);
      }
    },
  };
}
